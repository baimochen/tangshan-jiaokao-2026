#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把题库 JSON 导入 bank.db。全部校验通过才写，不部分写入。

用法：
    python3 import_bank.py                     # 题库.json → bank.db，整批替换
    python3 import_bank.py --batch 2           # 标成第 2 批
"""
import argparse
import json
import os
import re
import sqlite3
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, 'bank.db')
SCHEMA = os.path.join(BASE, 'schema.sql')

# 模块 → 知识页。加模块时改这里，别改别处。
SECTION_OF = {
    '教育学': 'edu',
    '教育心理学': 'edu',
    '教育法律法规': 'edu',
    '教师职业理念与职业道德': 'edu',
    '职业教育与高等教育': 'edu',
    '公共基础 · 政治与时政': 'pub',
    '公共基础 · 法律': 'pub',
    '公共基础 · 公文写作': 'pub',
    '公共基础 · 经济、管理与常识': 'pub',
    '人文历史与科技常识': 'pub',
    '高校辅导员': 'counselor',
    '唐山工业职业技术大学校情': 'school',
    '唐山本地政策与时政': 'local',
}

# 必须附来源的模块：内容是联网核实来的
NEEDS_SOURCE = {'唐山工业职业技术大学校情', '唐山本地政策与时政'}

LETTERS = 'ABCDE'


def open_db(db_path):
    """开一条连接并把外键开关重新打开。

    PRAGMA foreign_keys 是**每连接**的设置，schema.sql 里那行只对执行它的
    那条连接生效。这里再执行一次，才能保证 ON DELETE CASCADE 真的会级联，
    否则删题时 attempts / wrong 会留下孤儿行且不报错。
    """
    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def infer_type(q):
    """老题库没有 type 字段。选项数 2 就是判断题，其余一律单选。"""
    return 'judge' if len(q.get('options') or []) == 2 else 'single'


def validate(questions, batch=1):
    """返回错误信息列表。空列表 = 全部通过。

    batch 决定「本地题/校情题必须附来源」这条规则要不要管：
    第 1 批是建库前就有的存量数据，写的时候还没有 source 这个字段，
    追溯补齐等于重查重挂——所以只对 batch >= 2 的新题强制。

    注意：batch 这里是个粗略的上下界判断，不是逐题精确到它属于哪一批。
    调用方传进来的整批共用一个 batch，够用。
    """
    errs = []
    seen_id, seen_n = set(), set()
    for q in questions:
        qid = q.get('id', '(缺 id)')
        where = f'[{qid}]'

        if qid in seen_id:
            errs.append(f'{where} id 重复')
        seen_id.add(qid)

        n = q.get('n')
        if n in seen_n:
            errs.append(f'{where} n={n} 重复')
        seen_n.add(n)

        mod = q.get('module')
        if mod not in SECTION_OF:
            errs.append(f'{where} 未知模块「{mod}」，需先在 SECTION_OF 里登记')

        opts = q.get('options') or []
        keys = [o.get('key') for o in opts]
        qtype = q.get('type') or infer_type(q)

        if qtype == 'judge':
            if len(opts) != 2:
                errs.append(f'{where} 判断题必须恰好 2 个选项，实际 {len(opts)}')
        elif len(opts) < 2:
            errs.append(f'{where} 选项少于 2 个')

        ans = (q.get('answer') or '').strip()
        if not ans:
            errs.append(f'{where} 缺 answer')
        else:
            if qtype == 'multi':
                if len(ans) < 2:
                    errs.append(f'{where} 多选题答案「{ans}」至少要有 2 个字母')
                if len(set(ans)) != len(ans):
                    errs.append(f'{where} 多选题答案「{ans}」有重复字母')
                if list(ans) != sorted(ans):
                    errs.append(f'{where} 多选题答案「{ans}」没有按字母升序')
            else:
                if len(ans) != 1:
                    errs.append(f'{where} {qtype} 答案「{ans}」应只有 1 个字母')
            for ch in ans:
                if ch not in keys:
                    errs.append(f'{where} 答案字母「{ch}」不在选项 {keys} 里')

        exp = (q.get('explanation') or '').strip()
        if not exp:
            errs.append(f'{where} 解析为空')
        else:
            # 解析里「故选 X」的 X 必须就是答案——多字母也认
            for m in re.finditer(r'故[选是]?\s*([A-E]{1,5})(?![A-Za-z])', exp):
                if m.group(1) != ans:
                    errs.append(
                        f'{where} 解析写「{m.group(0).strip()}」但答案是 {ans}')

        # 来源必填只对新批次生效：batch 1 是存量数据，没有 source 字段
        if (mod in NEEDS_SOURCE and batch >= 2
                and not (q.get('source') or '').strip()):
            errs.append(f'{where} 「{mod}」的题必须附来源 source')

    return errs


def import_bank(json_path, db_path=DB, batch=1, replace=True):
    with open(json_path, encoding='utf-8') as f:
        data = json.load(f)
    questions = data['questions'] if isinstance(data, dict) else data

    for q in questions:
        q.setdefault('type', infer_type(q))

    errs = validate(questions, batch=batch)
    if errs:
        print(f'校验未通过，共 {len(errs)} 条，未写入任何数据：', file=sys.stderr)
        for e in errs[:30]:
            print('  ' + e, file=sys.stderr)
        if len(errs) > 30:
            print(f'  …还有 {len(errs) - 30} 条', file=sys.stderr)
        return 0

    conn = open_db(db_path)
    with open(SCHEMA, encoding='utf-8') as f:
        conn.executescript(f.read())
    if replace:
        conn.execute('DELETE FROM questions')
    for q in questions:
        conn.execute(
            "INSERT INTO questions "
            "(id,n,section,module,type,stem,options,answer,explanation,"
            " source,tags,difficulty,batch) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (q['id'], q['n'], SECTION_OF[q['module']], q['module'], q['type'],
             q['stem'], json.dumps(q['options'], ensure_ascii=False), q['answer'],
             q['explanation'], q.get('source'), q.get('tags'),
             q.get('difficulty'), batch))
    conn.commit()
    conn.close()
    return len(questions)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('json_path', nargs='?', default=os.path.join(BASE, '题库.json'))
    ap.add_argument('--db', default=DB)
    ap.add_argument('--batch', type=int, default=1)
    a = ap.parse_args()
    n = import_bank(a.json_path, a.db, a.batch)
    if n:
        print(f'✅ 入库 {n} 题 → {a.db}')
    else:
        sys.exit(1)
