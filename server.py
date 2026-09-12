#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地服务：读 bank.db，提供 JSON API + 静态文件。

零第三方依赖。每请求开一个连接，不共享连接对象。
    python3 server.py            # 0.0.0.0:8000，手机连同一 WiFi 可访问
"""
import argparse
import datetime
import json
import os
import random
import socket
import sqlite3
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import banklib

BASE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(BASE, 'web')
DB = os.path.join(BASE, 'bank.db')

# limit 的**下界**才是真保护：SQLite 里 LIMIT -1 表示「不限」，不夹住的话
# ?limit=-1 会把整库倒出去（这正是 E 修正要挡的东西）。上界只是防有人塞个
# 10**20 进来：正数的上限本来就由库的大小兜着——不可能返回比库里还多的行——
# 所以这里定得很松。**别把它收紧成「当前题量」**：刷题页要「一次取全库再在
# 浏览器里筛」（未做/错题/模块三个 tab 和 stats() 都吃全量），上限一旦贴着
# 题量，库涨过那个数就会静默截断，页面上的未做数、模块筛、统计全跟着错，
# 而且不报任何错。
LIMIT_MAX = 1000000
LIMIT_MIN = 1
# offset 没有「整库」这种上限，但也得有个界，免得有人塞个 10**30 进来。
OFFSET_MAX = 10 ** 9

MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
        '.svg': 'image/svg+xml', '.ico': 'image/x-icon'}


class BadRequest(Exception):
    """客户端把请求写错了——对应 400，不是 500。"""


class Insufficient(Exception):
    """题库里的题不够抽一份卷子——对应 400。不是服务坏了，是题不够，
    所以别让它冒到顶变成 500。"""


class MissingQuestion(Exception):
    """这一场的题号里有一道题在 questions 里找不到了——对应 404。

    题库重新导入过（id 换了一批、或者那几道被删了）就会这样，而「进行中/已交卷」
    的那一场还留在 mock_runs 里。mock_grade 是只读的，遇到就抛；两个调用点
    （交卷、GET 里给已交卷的那场现算成绩）都翻成 404——与 /api/attempts 遇到
    「题库里没这道题」时的做法一个形状。

    **这个异常绝不能冒到 Handler 外面**：冒出去就是一个字节都不回、连接被掐，
    客户端拿 RemoteDisconnected，模考页永远卡在「模考数据没取到」上。
    """


def _int_arg(raw, default, lo, hi):
    """把查询串里的整数参数收进 [lo, hi]。

    raw 为 None = 没传，走 default；不是整数 = 客户端写错了，抛 BadRequest（→400）。
    （不会收到空串：parse_qs 默认 keep_blank_values=False，`?limit=` 直接不产生
    这个键，one('limit') 拿到的就是 None——所以这里没有空串分支。）
    **夹范围不是可选的**：SQLite 里 LIMIT -1 表示「不限」，不夹住的话
    ?limit=-1 会把整库倒出去；offset 负数也别指望 SQLite 的行为。
    """
    if raw is None:
        return default
    try:
        v = int(raw)
    except (TypeError, ValueError):
        raise BadRequest(f'参数不是整数：{raw!r}')
    return max(lo, min(v, hi))


# ==================== 模考 ====================
# 配比表**只此一份**。客户端不再存第二份：页面渲染的「本卷配比」、成绩单的模块行与
# 分组、每一部分的题量，全来自 GET /api/mock 的 parts。在别处再抄一份的后果是
# ——页面写一套、服务端抽另一套，两边都不报错，考生拿到的是另一张卷子。
MK_N = 120
MK_SECONDS = 120 * 60
# 唐山本地政策 + 校情仍然算在公基那 60 题里，只是单独标一组，
# 免得在配比表里和公基四个模块混在一起看不出来。第三项就是小组名。
MK_LOCAL = '地方特色 · 从公基匀出 · 不在大纲内'
MK_PARTS = (
    ('公共基础知识', (
        ('公共基础 · 政治与时政', 16, None),
        ('公共基础 · 法律', 13, None),
        ('公共基础 · 经济、管理与常识', 11, None),
        ('公共基础 · 公文写作', 8, None),
        ('人文历史与科技常识', 6, None),
        ('唐山工业职业技术大学校情', 3, MK_LOCAL),
        ('唐山本地政策与时政', 3, MK_LOCAL),
    )),
    ('教育专业能力测验', (
        ('教育学', 23, None),
        ('教育心理学', 17, None),
        ('教育法律法规', 7, None),
        ('教师职业理念与职业道德', 6, None),
        ('职业教育与高等教育', 7, None),
    )),
)

# 练兵版（withTypes）里每个模块的配额怎么分给三种题型：每 6 道里出 1 道判断题、
# 1 道多选题，余下是单选。用**比例**而不是给 12 个模块各写一行——模块配额从 3 到
# 23 不等，逐模块写死必然出现「3 道的模块也要 2 道判断」这种怪数，而且配比表一改
# 就得改两份（配比只有一份这条规矩，见上面）。
MK_TYPE_SPLIT = (('judge', 6), ('multi', 6))


def quota_by_type(n, with_types=False):
    """一个模块的配额按题型怎么分：`{'judge': …, 'multi': …, 'single': …}`。

    默认版（with_types=False）整块给单选——**这是显式给的 `single`**，不是
    「库里碰巧没有别的题型」。真库今天确实 1000 题全单选，但那是数据、不是保证：
    哪天题库里进了判断题，默认那 120 题的 composition 就会自己变，而真库上
    没有任何现有测试能发现。
    """
    want = {}
    if with_types:
        for typ, per in MK_TYPE_SPLIT:
            want[typ] = n // per
    want['single'] = n - sum(want.values())
    return want


def _plan_row(mod, quota, group, counts=None):
    """配比表里的一行。counts 是这一行各题型的题量（练兵版才有）。"""
    row = {'module': mod, 'n': quota}
    if group:
        row['group'] = group
    if counts is not None:
        row.update(counts)
    return row


def mock_plan(with_types=False):
    """配比表：每部分的题量、每个模块的配额与小组名；练兵版再带上各题型题量。

    每部分的 n 由模块配额求和得出，不另写一份——两处各写一份迟早对不上。

    with_types 时每个模块多三个数：judge / multi / single。这是**目标**配比；
    实际抽到什么由 mock_pick 说了算（题库里某类题不够时它会退回单选），真数记在
    那一场的 parts 里（GET /api/mock 的 run.parts）。
    """
    out = []
    for name, mods in MK_PARTS:
        out.append({
            'name': name,
            'n': sum(n for _, n, _ in mods),
            'modules': [_plan_row(m, n, g, quota_by_type(n, True) if with_types else None)
                        for m, n, g in mods],
        })
    return out


def mock_pick(conn, with_types=False):
    """抽题。与 考点体系.html 的 mkPick() 等价：

    每部分先按模块配额凑齐（模块内部打乱），再把这一部分**整体打乱**，最后按
    部分的顺序接起来。所以结果是「公基 60 题打散 + 教基 60 题打散」——两部分
    之间不交错。少了「按部分接起来」这一步，考生就得在公基和教基之间来回跳。

    **题型维度**：默认版只抽 `type='single'`（显式筛，见 quota_by_type）。练兵版
    （with_types）按 quota_by_type 的配比掺判断题与多选题；某类题不够时**退回
    单选**——真库今天 0 判断 0 多选，勾一个「含多选/判断」不该让整场考试开不起来。
    单选不够则是硬错（那说明题库根本不完整，凑不出这一场）。
    """
    pool = {}
    for qid, mod, typ in conn.execute('SELECT id, module, type FROM questions'):
        pool.setdefault(mod, {}).setdefault(typ, []).append(qid)
    ids, parts = [], []
    for name, mods in MK_PARTS:
        out, rows = [], []
        for mod, quota, group in mods:
            by_mod = pool.get(mod, {})
            want = quota_by_type(quota, with_types)
            taken = {}
            for typ in ('judge', 'multi'):
                need = want.get(typ, 0)
                if not need:
                    continue
                have = list(by_mod.get(typ, []))     # 副本：打乱的是副本，不动 pool
                random.shuffle(have)
                taken[typ] = have[:need]             # 不够就有多少拿多少（见 docstring）
            n_single = quota - sum(len(v) for v in taken.values())
            have = list(by_mod.get('single', []))
            random.shuffle(have)
            if len(have) < n_single:
                raise Insufficient(f'题库不足: {mod} 需要 {n_single} 只有 {len(have)}')
            taken['single'] = have[:n_single]
            for lst in taken.values():
                out.extend(lst)
            counts = {typ: len(taken.get(typ, [])) for typ in ('judge', 'multi', 'single')}
            rows.append(_plan_row(mod, quota, group, counts if with_types else None))
        random.shuffle(out)
        parts.append({'name': name, 'n': len(out), 'modules': rows})
        ids.extend(out)
    return ids, parts


def mock_grade(conn, state, submitted_at=None):
    """给一份卷子判分。**只读，不改库。**

    交卷和「页面重新打开、那场已经交过」两条路都走这里，所以「怎么算分」只有
    一份实现。并进 attempts/错题本是交卷那一步单独做的事（见 do_POST 的 submit）。
    逐题判的是 banklib.grade 那条规则（多选少选算错），不在模考里另写一份。

    题号里的题不在题库里（重新导入过）就抛 MissingQuestion：调用点翻成 404，
    别让 KeyError 冒到 Handler 外面去。
    """
    answers = state.get('answers') or {}
    bank = {qid: (mod, typ, ans) for qid, mod, typ, ans in
            conn.execute('SELECT id, module, type, answer FROM questions')}
    per, wrong_ids, right = {}, [], 0
    for qid in state['ids']:
        row = bank.get(qid)
        if row is None:
            raise MissingQuestion(
                f'这场模考里的题 {qid} 已经不在题库里了（题库重新导入过？）')
        mod, typ, ans = row
        r = per.setdefault(mod, {'n': 0, 'right': 0})
        r['n'] += 1
        chosen = answers.get(qid)
        if not chosen:
            continue                              # 未答既不算对也不算错
        if banklib.grade(typ, ans, chosen):
            right += 1
            r['right'] += 1
        else:
            wrong_ids.append(qid)
    total = len(state['ids'])
    answered = sum(1 for v in answers.values() if v)
    started = state.get('startedAt') or 0
    # 用时只在交卷那一刻定下来：刷新成绩单不该把「用时」越算越长。
    used = max(0, round((submitted_at - started) / 1000)) if submitted_at else 0
    return {'score': round(right / total * 100, 1) if total else 0,
            'right': right, 'total': total, 'unanswered': total - answered,
            'wrong': wrong_ids, 'used': used, 'submittedAt': submitted_at or 0,
            'by_module': [dict({'module': m}, **v) for m, v in per.items()]}


def _iso(ms):
    """毫秒时间戳 → 本地时区的 ISO 串（mock_runs 里两个 TEXT 列用）。"""
    return datetime.datetime.fromtimestamp(ms / 1000).astimezone().isoformat(
        timespec='seconds')


def make_handler(db_path, web_dir=WEB):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            pass  # 别把每个静态请求都打到终端

        # ---- 工具 ----
        def _conn(self):
            c = sqlite3.connect(db_path)
            c.execute('PRAGMA foreign_keys = ON')
            return c

        def _send(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                raise BadRequest('Content-Length 不是整数')
            # 坏 JSON 是客户端错误。原先 ValueError 冒到顶会变成 500。
            try:
                return json.loads(self.rfile.read(n) or b'{}')
            except ValueError as e:
                raise BadRequest(f'请求体不是合法 JSON：{e}')

        def _mock_run(self, conn):
            """最近那一场模考：返回 (行号, state 字典)，没有就 (None, None)。

            永远取最新一行：新开的场次一定比旧的大，所以「进行中的那场」就是它。
            旧行留着当历史，不删。
            """
            row = conn.execute(
                'SELECT id, state FROM mock_runs ORDER BY id DESC LIMIT 1').fetchone()
            if row is None:
                return None, None
            return row[0], json.loads(row[1])

        def _file(self, rel):
            path = os.path.normpath(os.path.join(web_dir, rel.lstrip('/')))
            # 挡住 ../ 穿越。必须比对 WEB + os.sep：只 startswith(WEB) 的话，
            # 兄弟目录 web-old/ 的名字也以 WEB 开头，会被当成「在 web/ 里面」放行。
            # web_dir 本身（请求就是 "/"）是合法根，单独放行。
            # 注意这是**纯字面上的**路径比较，不做 realpath：web/ 里如果有人放一个
            # 指向外面的软链，下面的 isfile/open 照样会跟过去。本地单用户够用，
            # 但别把「挡住穿越」读成「挡住一切越界」。
            if path != web_dir and not path.startswith(web_dir + os.sep):
                return self._send({'error': 'forbidden'}, 403)
            if os.path.isdir(path):
                path = os.path.join(path, 'index.html')
            if not os.path.isfile(path):
                return self._send({'error': 'not found', 'path': rel}, 404)
            # with：这是服务，不关句柄就是每请求漏一个 fd。
            with open(path, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type',
                             MIME.get(os.path.splitext(path)[1], 'application/octet-stream'))
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')   # 改完刷新就见效
            self.end_headers()
            self.wfile.write(data)

        # ---- 路由 ----
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            one = lambda k: (q.get(k) or [None])[0]

            if u.path == '/api/questions':
                try:
                    limit = _int_arg(one('limit'), 40, LIMIT_MIN, LIMIT_MAX)
                    offset = _int_arg(one('offset'), 0, 0, OFFSET_MAX)
                except BadRequest as e:
                    return self._send({'error': str(e)}, 400)
                conn = self._conn()
                try:
                    return self._send(banklib.list_questions(
                        conn, section=one('section'), module=one('module'),
                        qtype=one('type'), limit=limit, offset=offset))
                finally:
                    conn.close()

            if u.path == '/api/attempts':
                # 刷题页的 cardHTML / matched() / isWrong() / stats() 全都吃
                # 全量 answers 映射，刷新后要靠它重建状态——所以返回的是
                # qid → {chosen, correct} 的**全量**映射，顶层没有包装键。
                conn = self._conn()
                try:
                    rows = conn.execute(
                        'SELECT qid, chosen, correct FROM attempts').fetchall()
                    return self._send({qid: {'chosen': chosen, 'correct': bool(ok)}
                                       for qid, chosen, ok in rows})
                finally:
                    conn.close()

            if u.path == '/api/wrong':
                conn = self._conn()
                try:
                    conn.row_factory = sqlite3.Row
                    rows = conn.execute(
                        "SELECT q.id,q.n,q.module,q.type,q.stem,q.options,q.answer,"
                        "q.explanation,w.chosen,w.wrong_count "
                        "FROM wrong w JOIN questions q ON q.id=w.qid "
                        "WHERE w.resolved=0 ORDER BY w.last_at DESC").fetchall()
                    out = []
                    for r in rows:
                        d = dict(r)
                        d['options'] = json.loads(d['options'])
                        out.append(d)
                    return self._send({'total': len(out), 'questions': out})
                finally:
                    conn.close()

            if u.path == '/api/stats':
                conn = self._conn()
                try:
                    total = conn.execute('SELECT COUNT(*) FROM questions').fetchone()[0]
                    done = conn.execute('SELECT COUNT(*) FROM attempts').fetchone()[0]
                    right = conn.execute(
                        'SELECT COUNT(*) FROM attempts WHERE correct=1').fetchone()[0]
                    by_mod = conn.execute(
                        "SELECT q.module, COUNT(*) t, SUM(a.correct) r "
                        "FROM attempts a JOIN questions q ON q.id=a.qid "
                        "GROUP BY q.module ORDER BY q.module").fetchall()
                    return self._send({
                        'total': total, 'done': done, 'right': right,
                        'rate': round(right / done * 100) if done else 0,
                        'by_module': [{'module': m, 'total': t, 'right': r or 0}
                                      for m, t, r in by_mod]})
                finally:
                    conn.close()

            if u.path == '/api/mock':
                # 模考页开局要的两样东西：一份配比表（渲染「本卷配比」与成绩单
                # 分组），和最近那一场模考（页面刷新/关掉再打开靠它接着答或看成绩）。
                conn = self._conn()
                try:
                    _rid, state = self._mock_run(conn)
                    run = None
                    if state is not None:
                        run = state
                        if state.get('submitted'):
                            # 已交卷的那场：把成绩一并带上。这里只算不改库——
                            # 重算一遍不能再把错次记一次。
                            # 题号里的题要是没了（题库重新导入过），mock_grade 抛
                            # MissingQuestion：翻成 404 回一个正经响应，
                            # 别让异常冒到 Handler 外面把连接掐了。
                            try:
                                run['result'] = mock_grade(
                                    conn, state, state.get('submittedAt'))
                            except MissingQuestion as e:
                                return self._send({'error': str(e)}, 404)
                    # 两份配比一起给：设置面板上的开关一勾就要立刻看到练兵版的
                    # 题型题量。让客户端自己算一份不可能的——配比只此一份，
                    # 页面再写一份就是「页面说一套、服务端抽另一套」那条老路。
                    return self._send({'n': MK_N, 'seconds': MK_SECONDS,
                                       'parts': mock_plan(),
                                       'partsWithTypes': mock_plan(True), 'run': run})
                finally:
                    conn.close()

            return self._file(u.path)

        def do_POST(self):
            u = urllib.parse.urlparse(self.path)

            if u.path == '/api/mock/start':
                try:
                    b = self._body()
                except BadRequest as e:
                    return self._send({'error': str(e)}, 400)
                if not isinstance(b, dict):
                    return self._send({'error': '请求体要是一个对象'}, 400)
                # withTypes：练兵版开关。**缺省就是不掺**（老客户端不带这个键、
                # 手滑传了字符串，都按默认版走）——默认版是显式只抽单选，
                # 所以「没带这个键」与「带了 False」是同一张卷子。
                with_types = b.get('withTypes') is True
                conn = self._conn()
                try:
                    try:
                        ids, parts = mock_pick(conn, with_types)
                    except Insufficient as e:
                        return self._send({'error': str(e)}, 400)
                    # 起止时间存毫秒：客户端要比 Date.now()，ISO 串还得再解一遍。
                    now = int(time.time() * 1000)
                    # withTypes 记进这一场：成绩单上要标明本场是哪种版本，
                    # 而「这场是什么版本」只有开考那一刻知道。
                    state = {'ids': ids, 'parts': parts, 'answers': {}, 'i': 0,
                             'withTypes': with_types,
                             'startedAt': now, 'endsAt': now + MK_SECONDS * 1000,
                             'submitted': False, 'submittedAt': 0}
                    conn.execute(
                        'INSERT INTO mock_runs (started_at, ends_at, state) VALUES (?,?,?)',
                        (_iso(now), _iso(now + MK_SECONDS * 1000),
                         json.dumps(state, ensure_ascii=False)))
                    conn.commit()
                    return self._send(state)
                finally:
                    conn.close()

            if u.path == '/api/mock/answer':
                try:
                    b = self._body()
                except BadRequest as e:
                    return self._send({'error': str(e)}, 400)
                # qid 是「答了哪道题」，i 是「翻到第几题」——翻页不带 qid，
                # 所以两者至少得有一个，不然这次请求什么也没说。
                if not isinstance(b, dict) or (not b.get('qid') and b.get('i') is None):
                    return self._send({'error': '请求体缺少 qid'}, 400)
                if b.get('qid') and not isinstance(b.get('chosen'), str):
                    return self._send({'error': 'chosen 要是字符串'}, 400)
                conn = self._conn()
                try:
                    rid, state = self._mock_run(conn)
                    if state is None or state.get('submitted'):
                        return self._send({'error': '没有进行中的模考'}, 404)
                    qid = b.get('qid')
                    if qid:
                        if qid not in state['ids']:
                            return self._send(
                                {'error': f'这场模考里没有这道题：{qid}'}, 404)
                        state['answers'][qid] = b['chosen']
                    if b.get('i') is not None:
                        try:
                            i = int(b['i'])
                        except (TypeError, ValueError):
                            return self._send({'error': 'i 不是整数'}, 400)
                        state['i'] = max(0, min(i, len(state['ids']) - 1))
                    conn.execute('UPDATE mock_runs SET state=? WHERE id=?',
                                 (json.dumps(state, ensure_ascii=False), rid))
                    conn.commit()
                    return self._send({'ok': True, 'answered': sum(
                        1 for v in state['answers'].values() if v)})
                finally:
                    conn.close()

            if u.path == '/api/mock/submit':
                try:
                    self._body()
                except BadRequest as e:
                    return self._send({'error': str(e)}, 400)
                conn = self._conn()
                try:
                    rid, state = self._mock_run(conn)
                    if state is None:
                        return self._send({'error': '没有进行中的模考'}, 404)
                    # 幂等：交过的就只回上次的成绩。三条交卷路径（手动 / 页内超时 /
                    # 关着页面过期）都打这个端点，客户端重入一次就会交两回——
                    # 再并一次 attempts 会把错次平白记成 2。
                    if state.get('submitted'):
                        try:
                            return self._send(
                                mock_grade(conn, state, state.get('submittedAt')))
                        except MissingQuestion as e:
                            return self._send({'error': str(e)}, 404)
                    now = int(time.time() * 1000)
                    # **先判分、判得出来才落库。** 顺序不能反：题号里的题要是没了，
                    # mock_grade 会抛 MissingQuestion（上面翻成 404）。要是先把
                    # submitted 落盘再判分，第一次失败就把这一场钉成「已交卷」，
                    # 之后每次重试都走上面那条短路，永远回同一个错——只能手工改库。
                    # 先算后写，失败就当没交过，题库修好了重试就能真交上。
                    try:
                        res = mock_grade(conn, state, now)
                    except MissingQuestion as e:
                        return self._send({'error': str(e)}, 404)
                    state['submitted'] = True
                    state['submittedAt'] = now
                    # 成绩并入作答记录：答错的自动进错题本。**三条交卷路径只有
                    # 这一份实现**——漏掉任何一条，那场的错题就进不了错题本。
                    for qid, chosen in state['answers'].items():
                        if chosen:
                            banklib.record_attempt(conn, qid, chosen)
                    conn.execute('UPDATE mock_runs SET state=?, submitted_at=? WHERE id=?',
                                 (json.dumps(state, ensure_ascii=False), _iso(now), rid))
                    conn.commit()
                    return self._send(res)
                finally:
                    conn.close()

            if u.path == '/api/attempts':
                try:
                    b = self._body()
                except BadRequest as e:
                    return self._send({'error': str(e)}, 400)
                # 缺字段是请求写错了（400），和「这道题不在库里」（404）不是一回事：
                # 前者是客户端的问题，后者是资源不存在。原先 b['qid'] 抛的 KeyError
                # 被下面的 except 一并当成 404 报，判错了类。
                if not isinstance(b, dict) or not b.get('qid'):
                    return self._send({'error': '请求体缺少 qid'}, 400)
                conn = self._conn()
                try:
                    return self._send(
                        banklib.record_attempt(conn, b['qid'], b.get('chosen', '')))
                except KeyError as e:
                    return self._send({'error': str(e)}, 404)
                finally:
                    conn.close()

            if u.path == '/api/migrate/legacy':
                # 旧版页面（localStorage）的记录并库：一次性的桥，给拆页前
                # 已经刷过题的用户用（首页那个按钮打的就是这里）。
                try:
                    b = self._body()
                except BadRequest as e:
                    return self._send({'error': str(e)}, 400)
                # 给的不是对象才是写错了（400）。两个键缺省当空——首页那个按钮
                # 永远两个都给，但手工 curl 只给一个也该跑得起来，那不是错误。
                if not isinstance(b, dict):
                    return self._send({'error': '请求体要是对象'}, 400)
                for k in ('answers', 'wrong'):
                    if b.get(k) is not None and not isinstance(b[k], dict):
                        return self._send({'error': f'{k} 要是 {{qid: 值}} 形状的对象'}, 400)
                conn = self._conn()
                try:
                    # 写库、「题库里没有的题号跳过」、「服务器已有的行不覆盖」都在
                    # banklib.import_legacy 里：作答/错题两张表的 SQL 只住在 banklib，
                    # 路由只管 HTTP 这一层。existing 单列一个数是给界面看的——
                    # 「已经在服务器上了」和「对不上题库」都不是丢数据，但要说清楚。
                    imported, skipped, existing = banklib.import_legacy(
                        conn, b.get('answers') or {}, b.get('wrong') or {})
                    return self._send({'imported': imported, 'skipped': skipped,
                                       'existing': existing})
                finally:
                    conn.close()

            # POST /api/wrong/<qid>/resolve —— 错题本上的「标记已订正」。
            # **这是本文件第一条参数化路由**：其余全是 u.path == '…' 的整串比对，
            # 所以路径要自己切，而且切错不能把 IndexError 冒到 Handler 外面
            # （冒出去客户端一个字节都收不到）。切法写死成「/api/wrong/ 之后正好
            # 一段 qid + 一段 resolve」：
            #     /api/wrong/q1/resolve      → 订正
            #     /api/wrong//resolve        → 404（qid 是空串）
            #     /api/wrong/q1/resolve/     → 404（末尾多一段空的）
            #     /api/wrong/q1/extra/resolve→ 404（段数不对）
            # 放在这里而不是更上面，是因为 /api/wrong 的精确比对与 DELETE /api/wrong
            # 都不以 '/api/wrong/' 开头，谁也不会遮住谁。
            if u.path.startswith('/api/wrong/'):
                segs = u.path[len('/api/wrong/'):].split('/')
                if len(segs) != 2 or segs[1] != 'resolve' or not segs[0]:
                    return self._send({'error': 'not found'}, 404)
                qid = urllib.parse.unquote(segs[0])
                conn = self._conn()
                try:
                    # 题号不在库里 → 404，形状同 :482 的 /api/attempts 那条
                    # （banklib.record_attempt 抛的 KeyError 也翻成这句）。
                    if conn.execute('SELECT 1 FROM questions WHERE id=?',
                                    (qid,)).fetchone() is None:
                        return self._send({'error': f'题库里没有这道题：{qid}'}, 404)
                    now = _iso(int(time.time() * 1000))
                    # 与 banklib.record_attempt 做对时那条 UPDATE 同一形状：
                    # 行留着当历史，只把 resolved 翻成 1。last_at 一并更新——
                    # 它记的是「这一题最后一次被处理的时间」。
                    cur = conn.execute(
                        'UPDATE wrong SET resolved=1, last_at=? WHERE qid=?', (now, qid))
                    conn.commit()
                    return self._send({'ok': True, 'qid': qid,
                                       'resolved': bool(cur.rowcount)})
                finally:
                    conn.close()

            return self._send({'error': 'not found'}, 404)

        def do_DELETE(self):
            u = urllib.parse.urlparse(self.path)
            # 连接开在分支里面，和 do_GET/do_POST 一致：路由没匹配上就不该碰库，
            # 否则每个 404 的 DELETE 都白开一次连接。
            if u.path == '/api/attempts':
                conn = self._conn()
                try:
                    conn.execute('DELETE FROM attempts')
                    conn.execute('DELETE FROM wrong')
                    conn.commit()
                    return self._send({'ok': True})
                finally:
                    conn.close()
            if u.path == '/api/wrong':
                conn = self._conn()
                try:
                    conn.execute('DELETE FROM wrong')
                    conn.commit()
                    return self._send({'ok': True})
                finally:
                    conn.close()
            return self._send({'error': 'not found'}, 404)

    return Handler


def make_server(port=8000, db=DB, host='0.0.0.0', web=WEB):
    return ThreadingHTTPServer((host, port), make_handler(db, web))


def lan_ip():
    """拿本机在局域网里的地址，方便手机访问。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('-p', '--port', type=int, default=8000)
    ap.add_argument('--db', default=DB)
    a = ap.parse_args()
    print(f'服务已起：http://127.0.0.1:{a.port}')
    print(f'手机访问：http://{lan_ip()}:{a.port}   （需同一 WiFi）')
    make_server(a.port, a.db).serve_forever()
