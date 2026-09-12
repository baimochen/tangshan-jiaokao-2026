#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地服务：读 bank.db，提供 JSON API + 静态文件。

零第三方依赖。每请求开一个连接，不共享连接对象。
    python3 server.py            # 0.0.0.0:8000，手机连同一 WiFi 可访问
"""
import argparse
import json
import os
import socket
import sqlite3
import sys
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

            return self._file(u.path)

        def do_POST(self):
            u = urllib.parse.urlparse(self.path)
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
