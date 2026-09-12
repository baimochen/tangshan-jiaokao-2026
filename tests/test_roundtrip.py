# -*- coding: utf-8 -*-
"""DB 导出的 JSON 必须与现有 题库.json 逐字段一致——不一致就是有 bug。"""
import json
import os
import unittest

from export_bank import export

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, 'bank.db')
ORIG = os.path.join(BASE, '题库.json')

# 刻意不含 type / section：这两个是这次新加的，老 题库.json 里没有，
# 加进来必然对不上。要比的是「原有字段在搬家过程中有没有被改坏」。
FIELDS = ['id', 'n', 'module', 'stem', 'options', 'answer', 'explanation']


class TestRoundtrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.got = export(DB)
        cls.orig = json.load(open(ORIG, encoding='utf-8'))

    def test_题数一致(self):
        self.assertEqual(self.got['total'], self.orig['total'])
        self.assertEqual(len(self.got['questions']), len(self.orig['questions']))

    def test_逐字段一致(self):
        a = {q['id']: q for q in self.got['questions']}
        b = {q['id']: q for q in self.orig['questions']}
        self.assertEqual(set(a), set(b), 'id 集合不同')
        bad = []
        for qid in b:
            for f in FIELDS:
                if a[qid].get(f) != b[qid].get(f):
                    bad.append(f'{qid}.{f}: DB={a[qid].get(f)!r} JSON={b[qid].get(f)!r}')
        self.assertEqual(bad, [], f'{len(bad)} 处不一致，前 5 条：\n' + '\n'.join(bad[:5]))

    def test_顺序按_n_排(self):
        ns = [q['n'] for q in self.got['questions']]
        self.assertEqual(ns, sorted(ns))


if __name__ == '__main__':
    unittest.main()
