#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""取题、判分、记录作答。纯函数，不碰 HTTP——方便单测，也保证判分只有一份实现。

HTTP 服务（server.py）和浏览器端引擎都从这里拿同一套判分结果，
不各写一份「多选算对」的规则。
"""
import datetime
import json


def _norm(s):
    """把作答/答案规范化成可比较的形式：去空白、转大写、按字母排序。

    多选题的顺序不该影响判分，所以排序；顺带 set() 去重——答案侧
    上游已校验无重复字母，作答侧的重复只可能来自出不了的 UI，去重是无害的防御。
    """
    return ''.join(sorted(set((s or '').strip().upper())))


def grade(qtype, answer, chosen):
    """三题型共用。多选全对才算对——少选、多选、错选一律算错。

    判断题其实和单选同构（答案就是单个字母 A/B），走同一条路。
    """
    if not chosen:
        return False
    return _norm(answer) == _norm(chosen)


def _now():
    """本地时区的 ISO 时间戳，精确到秒。"""
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def record_attempt(conn, qid, chosen):
    """写作答记录并维护错题本。返回本次判分结果。

    重做同一题会覆盖 attempts 那一行：
      做对了 → wrong.resolved = 1（保留历史，但不再算「还没掌握」）
      又错了 → wrong_count += 1
    """
    row = conn.execute(
        "SELECT type, answer, explanation FROM questions WHERE id=?", (qid,)).fetchone()
    if row is None:
        raise KeyError(f'题库里没有这道题：{qid}')
    qtype, answer, explanation = row

    ok = grade(qtype, answer, chosen)
    now = _now()
    conn.execute(
        "INSERT INTO attempts (qid,chosen,correct,at) VALUES (?,?,?,?) "
        "ON CONFLICT(qid) DO UPDATE SET chosen=excluded.chosen, "
        "correct=excluded.correct, at=excluded.at",
        (qid, chosen, 1 if ok else 0, now))

    if ok:
        conn.execute("UPDATE wrong SET resolved=1, last_at=? WHERE qid=?", (now, qid))
    else:
        conn.execute(
            "INSERT INTO wrong (qid,chosen,wrong_count,first_at,last_at,resolved) "
            "VALUES (?,?,1,?,?,0) "
            "ON CONFLICT(qid) DO UPDATE SET chosen=excluded.chosen, "
            "wrong_count=wrong.wrong_count+1, last_at=excluded.last_at, resolved=0",
            (qid, chosen, now, now))
    conn.commit()

    wc = conn.execute("SELECT wrong_count FROM wrong WHERE qid=?", (qid,)).fetchone()
    return {'correct': ok, 'answer': answer, 'explanation': explanation,
            'wrong_count': wc[0] if wc else 0}


def _put_legacy_wrong(conn, qid, chosen, now):
    """把「这一题错过」写进错题本（旧记录迁移专用，见 import_legacy）。

    与 record_attempt 里那条 upsert 是同一张表，但语义不同，刻意分开写：
      · wrong_count **固定 1、不累加**——旧数据里根本没有错次（老代码写死
        w[qid]=1），重导一次不该变成 2。
      · resolved 不动。那行要是已经被重做对了，这次导入没有理由把它翻回
        「还没掌握」——旧记录不比新记录更权威。
      · chosen 库里已经有就留着（COALESCE），别让一份更旧的记录把它盖掉。
    """
    conn.execute(
        "INSERT INTO wrong (qid,chosen,wrong_count,first_at,last_at,resolved) "
        "VALUES (?,?,1,?,?,0) "
        "ON CONFLICT(qid) DO UPDATE SET chosen=COALESCE(wrong.chosen, excluded.chosen), "
        "last_at=excluded.last_at",
        (qid, chosen, now, now))


def import_legacy(conn, answers, wrong):
    """把旧页面 localStorage 里的记录并进 attempts / wrong。返回 (imported, skipped)。

    老数据的两张表各存各的：answers[qid] 是选中的选项 key（'A' / 'ABD'），
    w[qid] 一律是 1（**旧代码写死的就是 1**）。所以导进来的 wrong_count 一律是 1
    ——错次这个概念在旧数据里不存在，是不可恢复的信息，不是这里的缺陷。

    查不到的题号一律**跳过并计数**，绝不整批失败：老记录可能来自上一代题库
    （id 换了一批），而 attempts.qid / wrong.qid 都是 REFERENCES questions(id)，
    一个外键错（IntegrityError）就会把几百条记录变成一次 500，用户只看到
    「导入失败」，还一条都没进来。skipped 要回给用户，让他知道漏了多少。

    幂等：同一份数据重导一遍不会多出行、也不会把错次累加成 2。这不是多余的
    讲究——新刷题页写的正是同一对 localStorage key，所以首页那个按钮会再出现，
    重导是常态。
    """
    bank = {qid: (typ, ans) for qid, typ, ans in
            conn.execute('SELECT id, type, answer FROM questions')}
    skipped = set()
    imported = 0
    now = _now()
    for qid, chosen in answers.items():
        row = bank.get(qid)
        if row is None or not isinstance(chosen, str):
            skipped.add(qid)          # 题库里没有 / 作答不是字符串：跳过这一条
            continue
        ok = grade(row[0], row[1], chosen)      # 判分只有这一份实现
        conn.execute(
            "INSERT INTO attempts (qid,chosen,correct,at) VALUES (?,?,?,?) "
            "ON CONFLICT(qid) DO UPDATE SET chosen=excluded.chosen, "
            "correct=excluded.correct, at=excluded.at",
            (qid, chosen, 1 if ok else 0, now))
        if not ok:
            _put_legacy_wrong(conn, qid, chosen, now)
        imported += 1
    for qid in wrong:
        if qid not in bank:
            skipped.add(qid)
            continue
        if qid in answers:
            # 上一步已经处理过：判错的已进错题本，判对的按**现在的**题库算对。
            # 不为「旧数据说它错」再补一行——对错由服务端那份答案说了算。
            continue
        _put_legacy_wrong(conn, qid, None, now)   # 只记了错、没记作答的题号
        imported += 1
    conn.commit()
    return imported, len(skipped)


def list_questions(conn, section=None, module=None, qtype=None,
                   limit=40, offset=0, include_answer=True):
    """取题。limit/offset 翻的是**结果集**，只是让调用方不必一次渲染完。

    想把整个题库交给前端做筛选（刷题页的模块/未做/错题 tab 都要全量）的调用方，
    把 limit 直接开大（如 1000）再自己筛；别指望这个函数替它筛。
    """
    where, args = [], []
    for col, val in (('section', section), ('module', module), ('type', qtype)):
        if val:
            where.append(f'{col}=?')
            args.append(val)
    clause = ('WHERE ' + ' AND '.join(where)) if where else ''

    total = conn.execute(f'SELECT COUNT(*) FROM questions {clause}', args).fetchone()[0]
    cols = ('id,n,section,module,type,stem,options,answer,explanation,source,tags,difficulty'
            if include_answer else
            'id,n,section,module,type,stem,options,source,tags,difficulty')
    rows = conn.execute(
        f'SELECT {cols} FROM questions {clause} ORDER BY n LIMIT ? OFFSET ?',
        args + [limit, offset]).fetchall()

    names = cols.split(',')
    out = []
    for r in rows:
        q = dict(zip(names, r))
        q['options'] = json.loads(q['options'])
        out.append(q)
    return {'total': total, 'questions': out}
