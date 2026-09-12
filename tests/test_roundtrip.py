# -*- coding: utf-8 -*-
"""导出镜像的两条性质，各由一条测试守着：

- test_逐字段一致_对照改造前快照：export(bank.db) 与 tests/fixtures/题库.pre-refactor.json
  逐字段比对，只比 FIELDS 这 7 个「改造前就有」的字段。这条证明的是**迁移无损**——
  1000 题从 JSON 搬进 DB 再搬出来，老字段一个没丢、一个没改坏。快照是仓库里的
  历史 blob，每次 clone 都在，所以这个结论是永久可复验的，不是一次性口头担保。
- test_逐字段一致_对照现行镜像：export(bank.db) 与工作区的 题库.json 逐字段比对。
  这条证明的是**镜像不过期**——bank.db 变了却没人重跑 export_bank.py，它就变红。

两条都用 7 字段的 FIELDS 比对。刻意不含 type/section/batch：快照里根本没有这三个
字段，加进来必然对不上，也就毁掉了「迁移无损」这条断言。镜像里的新字段由
test_导出形状_含新字段 覆盖（那是「形状对不对」，不是「老字段有没有坏」）。
"""
import json
import os
import unittest

from export_bank import export

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, 'bank.db')
MIRROR = os.path.join(BASE, '题库.json')
FIXTURE = os.path.join(BASE, 'tests', 'fixtures', '题库.pre-refactor.json')

# 改造前就有的 7 个字段。快照里只有这些，故只能拿这些做「迁移无损」比对。
FIELDS = ['id', 'n', 'module', 'stem', 'options', 'answer', 'explanation']


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


class TestRoundtrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.got = export(DB)
        cls.snapshot = load_json(FIXTURE)
        cls.mirror = load_json(MIRROR)

    def check(self, other):
        """got 与另一份题库在 FIELDS 上逐字段比，返回不一致清单。"""
        a = {q['id']: q for q in self.got['questions']}
        b = {q['id']: q for q in other['questions']}
        self.assertEqual(set(a), set(b), 'id 集合不同')
        bad = []
        for qid in b:
            for f in FIELDS:
                if a[qid].get(f) != b[qid].get(f):
                    bad.append(f'{qid}.{f}: DB={a[qid].get(f)!r} JSON={b[qid].get(f)!r}')
        return bad

    def test_题数一致(self):
        self.assertEqual(self.got['total'], self.snapshot['total'])
        self.assertEqual(len(self.got['questions']), len(self.snapshot['questions']))

    def test_逐字段一致_对照改造前快照(self):
        """迁移无损：老 7 字段在 JSON→DB→JSON 全程没被丢、没被改坏。"""
        bad = self.check(self.snapshot)
        self.assertEqual(bad, [], f'{len(bad)} 处不一致，前 5 条：\n' + '\n'.join(bad[:5]))

    def test_逐字段一致_对照现行镜像(self):
        """镜像不过期：bank.db 与仓库里的 题库.json 不准有 7 字段的偏差。"""
        bad = self.check(self.mirror)
        self.assertEqual(bad, [], f'{len(bad)} 处不一致，前 5 条：\n' + '\n'.join(bad[:5]))

    def test_导出形状_含新字段(self):
        """每题都带 section（拆页路由键）与 batch，且非空。"""
        for q in self.got['questions']:
            self.assertIn('section', q)
            self.assertIn('batch', q)
            self.assertIsNotNone(q['section'])
            self.assertIsNotNone(q['batch'])

    def test_顺序按_n_排(self):
        ns = [q['n'] for q in self.got['questions']]
        self.assertEqual(ns, sorted(ns))


if __name__ == '__main__':
    unittest.main()
