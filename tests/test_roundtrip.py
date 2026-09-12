# -*- coding: utf-8 -*-
"""导出镜像的两条性质，各由一条测试守着。两者的比对范围**故意不同**：

- test_逐字段一致_对照改造前快照：export(bank.db) 与 tests/fixtures/题库.pre-refactor.json
  比对。快照是改造前的 1000 题，只有老 7 字段，所以：
    * id 用**包含**语义——快照的 id 必须一个不少地出现在导出里（丢原题才红）。
      后续往 bank.db 加题是这套设计的下一步，加新题按构造不该弄红这条。
    * 逐字段只遍历**快照自己的** id，比老 7 字段。结论是**迁移无损**：1000 题
      从 JSON 搬进 DB 再搬出来，老字段一个没丢、一个没改坏。
    * 不比题数。题数是快照**内部**的完整性检查（见 test_基线快照自身完整），
      它守的是基线别被截断，与迁移无关。
  快照是仓库里的历史 blob，每次 clone 都在，所以这个结论是永久可复验的。

  注意一个刻意的副作用：快照是**内容**冻结，不是题数冻结。将来若**修改**某道
  原题（哪怕只改 e1.stem 里的一个错别字），这条也会变红——那正是「老字段没被
  改坏」的语义。届时要有意识地更新基线，而不是删掉这条测试。

- test_逐字段一致_对照现行镜像：export(bank.db) 与工作区的 题库.json 比对。
  两边都是新形状的对象，没有兼容包袱，所以比**导出实际发出的全部字段**
  （MIRROR_FIELDS = 7 老字段 + type/section/batch），id 用**相等**语义——
  往 DB 加题而没重跑 export 也要被抓到。这条证明的是**镜像不过期**：
  bank.db 变了却没人重跑 export_bank.py，它就变红。
"""
import json
import os
import tempfile
import unittest

from export_bank import export

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, 'bank.db')
MIRROR = os.path.join(BASE, '题库.json')
FIXTURE = os.path.join(BASE, 'tests', 'fixtures', '题库.pre-refactor.json')

# 改造前就有的 7 个字段。快照里只有这些，故只能拿这些做「迁移无损」比对。
FIELDS = ['id', 'n', 'module', 'stem', 'options', 'answer', 'explanation']

# 现行导出实际发出的全部字段 = 老的 7 个 + 迁移后新增的 3 个。
# 镜像两边同形，没有理由像快照那样少比：只比 FIELDS 会让 section/batch/type
# 的偏差悄悄溜过去（那正是上一轮评审抓到的漏洞）。
MIRROR_FIELDS = FIELDS + ['type', 'section', 'batch']


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


class TestRoundtrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.got = export(DB)
        cls.snapshot = load_json(FIXTURE)
        cls.mirror = load_json(MIRROR)

    def check(self, other, fields, subset=False):
        """got 与另一份题库在 fields 上逐字段比，返回不一致清单。

        两处差异由 subset 显式区分，语义不同、不能混：

        - subset=False（镜像）：两边同形，id 集合必须**相等**——多一题少一题都算坏。
          遍历自然覆盖所有 id。
        - subset=True（快照）：快照是历史子集，只要求快照 id **被包含**在导出里
          （原题丢了才红，加新题按构造不可见）；逐字段也只遍历快照的 id，
          即只比「原来就有的那些题、原来就有的那些字段」。
        """
        a = {q['id']: q for q in self.got['questions']}
        b = {q['id']: q for q in other['questions']}
        if subset:
            self.assertLessEqual(set(b), set(a), '快照里的题在导出里找不到了（原题丢失）')
        else:
            self.assertEqual(set(a), set(b), 'id 集合不同')
        bad = []
        for qid in b:
            for f in fields:
                if a[qid].get(f) != b[qid].get(f):
                    bad.append(f'{qid}.{f}: DB={a[qid].get(f)!r} JSON={b[qid].get(f)!r}')
        return bad

    def test_基线快照自身完整(self):
        """快照内部自洽：total 与题目数对得上，且仍是那 1000 题。

        这条守的是**基线**（别被人手滑截断/清空），不是迁移。它是对老
        「got 题数 == 快照题数」的替代：那版会随第一次加题变红，
        「没丢题」已由上面的 id 包含断言完全覆盖。
        """
        self.assertEqual(self.snapshot['total'], len(self.snapshot['questions']))
        self.assertEqual(len(self.snapshot['questions']), 1000)

    def test_逐字段一致_对照改造前快照(self):
        """迁移无损：老 7 字段在 JSON→DB→JSON 全程没被丢、没被改坏。"""
        bad = self.check(self.snapshot, FIELDS, subset=True)
        self.assertEqual(bad, [], f'{len(bad)} 处不一致，前 5 条：\n' + '\n'.join(bad[:5]))

    def test_逐字段一致_对照现行镜像(self):
        """镜像不过期：bank.db 与仓库里的 题库.json 不准有任何一个发出字段的偏差。"""
        bad = self.check(self.mirror, MIRROR_FIELDS)
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

    def test_缺库时报错且不建库(self):
        """export() 对不存在的路径要报错，且不能顺手留下一个空库。

        裸 sqlite3.connect 会把路径静默建成 0 字节空库，再炸在「no such table」上。
        后半句（文件没被建出来）才是真正要挡的 bug，所以单独断言，不是顺带。
        """
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, '不存在.db')
            with self.assertRaises(FileNotFoundError):
                export(path)
            self.assertFalse(os.path.exists(path), 'export 不该把不存在的路径建成空库')


if __name__ == '__main__':
    unittest.main()
