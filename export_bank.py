#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bank.db → 题库.json。

题库.json 是可读、可 diff 的镜像，真相源仍是 bank.db。
tests/test_roundtrip.py 保证两者一致。
"""
import argparse
import json
import os
import sqlite3
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, 'bank.db')


def export(db_path=DB):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id,n,module,type,stem,options,answer,explanation,source,tags,difficulty "
        "FROM questions ORDER BY n").fetchall()
    conn.close()

    questions = []
    for r in rows:
        q = {
            'id': r['id'], 'n': r['n'], 'module': r['module'], 'type': r['type'],
            'stem': r['stem'], 'options': json.loads(r['options']),
            'answer': r['answer'], 'explanation': r['explanation'],
        }
        # 可选字段：有值才写，保持和现有 JSON 一样的形状
        for k in ('source', 'tags', 'difficulty'):
            if r[k] is not None:
                q[k] = r[k]
        questions.append(q)

    return {
        # 顶层键必须和原 题库.json 一样（_note/_schema/version/total/questions）：
        # 去掉任何一个，这次导出就会变成一份无意义的噪声 diff。
        # _note 保留原文那句（「非历年真题」的声明是用户依赖的信息），后面追加生成警告。
        '_note': '唐山工业职业技术大学 2026 选聘 · 教育类岗位 笔试题库。'
                 '全客观题（四选一单选），题目按考点编写，非历年真题。'
                 '本文件由 export_bank.py 从 bank.db 生成，不要手改——改 bank.db。',
        # 原值不含 /type，但题目对象现在有 type 字段了：描述得跟着形状走。
        '_schema': 'id/n/module/type/stem/options[{key,text}]/answer/explanation',
        'version': '2026-09-12',
        'total': len(questions),
        'questions': questions,
    }


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DB)
    ap.add_argument('-o', '--out', default=os.path.join(BASE, '题库.json'))
    a = ap.parse_args()
    data = export(a.db)
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'✅ 导出 {data["total"]} 题 → {a.out}')
