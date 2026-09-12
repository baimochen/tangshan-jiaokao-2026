# -*- coding: utf-8 -*-
"""导入校验：8 条规则，每条都要有一个「坏数据被拒」的测试。"""
import copy
import json
import os
import shutil
import sqlite3
import tempfile
import unittest

from import_bank import validate, SECTION_OF, open_db, import_bank

GOOD = {
    'id': 'e101', 'n': 1, 'module': '教育学', 'stem': '题干',
    'options': [{'key': 'A', 'text': '甲'}, {'key': 'B', 'text': '乙'},
                {'key': 'C', 'text': '丙'}, {'key': 'D', 'text': '丁'}],
    'answer': 'B', 'explanation': '解析',
}


def bad(**kw):
    q = copy.deepcopy(GOOD)
    for k, v in kw.items():
        if v is None:
            q.pop(k, None)
        else:
            q[k] = v
    return [q]


class TestValidate(unittest.TestCase):
    def test_好数据通过(self):
        self.assertEqual(validate([copy.deepcopy(GOOD)]), [])

    def test_拒绝重复id(self):
        errs = validate([copy.deepcopy(GOOD), copy.deepcopy(GOOD)])
        # 第二条 n 也得改，否则先撞 n 唯一——这里显式只关心 id
        self.assertTrue(any('重复' in e and 'id' in e for e in errs), errs)

    def test_拒绝重复n(self):
        # 两条 id 不同、n 相同：此时除了 n 重复，没有任何别的规则会被触发，
        # 所以这条断言确实单独钉住了规则 2。
        # （test_拒绝重复id 用两份相同 GOOD，第二条同时撞 id 和 n，且断言只看 id，
        #   n 规则因此从来没被单独测过。）
        a, b = copy.deepcopy(GOOD), copy.deepcopy(GOOD)
        b['id'] = 'e102'
        errs = validate([a, b])
        self.assertTrue(any('n' in e and '重复' in e for e in errs), errs)
        self.assertEqual(len(errs), 1, f'只该有 n 重复一条，实际 {errs}')

    def test_拒绝未知模块(self):
        errs = validate(bad(module='不存在的模块'))
        self.assertTrue(any('未知模块' in e for e in errs), errs)

    def test_拒绝答案字母不在选项里(self):
        errs = validate(bad(answer='E'))
        # GOOD 有 A-D 四个选项，E 不在其中
        self.assertTrue(any('不在选项' in e for e in errs), errs)

    def test_拒绝多选答案未升序(self):
        # 必须显式标 multi，否则会被当成单选撞上「只应有 1 个字母」，
        # 红了也不是因为升序这条规则
        errs = validate(bad(type='multi', answer='BA'))
        self.assertTrue(any('升序' in e for e in errs), errs)

    def test_拒绝多选答案有重复字母(self):
        # 'AA' 已按升序，唯一会红的就是重复字母这条
        errs = validate(bad(type='multi', answer='AA'))
        self.assertTrue(any('重复字母' in e for e in errs), errs)

    def test_拒绝判断题选项数不是二(self):
        # 4 个选项 + judge 类型，红的必须是选项数那条，不是答案长度那条
        errs = validate(bad(type='judge'))
        self.assertTrue(any('判断题' in e and '2 个选项' in e for e in errs), errs)

    def test_拒绝空解析(self):
        errs = validate(bad(explanation='   '))
        self.assertTrue(any('解析为空' in e for e in errs), errs)

    def test_本地题没有来源_新批次拒绝(self):
        q = copy.deepcopy(GOOD)
        q['module'] = '唐山本地政策与时政'
        errs = validate([q], batch=2)
        self.assertTrue(any('来源' in e for e in errs), errs)

    def test_本地题没有来源_第1批放行(self):
        # batch 1 是建库前的存量数据，当时还没有 source 字段，追溯补齐=重查重挂。
        # 这条和上一条必须都在：只留一边的话，规则被悄悄反转也测不出来。
        q = copy.deepcopy(GOOD)
        q['module'] = '唐山本地政策与时政'
        self.assertEqual(validate([q], batch=1), [])

    def test_拒绝解析与答案不自洽(self):
        # 解析写「故选 C」，答案却是 B
        errs = validate(bad(explanation='故选 C。'))
        self.assertTrue(any('解析写' in e for e in errs), errs)


class TestSectionMap(unittest.TestCase):
    def test_映射覆盖全部13个模块(self):
        mods = ['教育学', '教育心理学', '教育法律法规', '教师职业理念与职业道德',
                '公共基础 · 政治与时政', '公共基础 · 法律', '公共基础 · 公文写作',
                '公共基础 · 经济、管理与常识', '高校辅导员', '职业教育与高等教育',
                '人文历史与科技常识', '唐山工业职业技术大学校情', '唐山本地政策与时政']
        for m in mods:
            self.assertIn(m, SECTION_OF, f'模块「{m}」没有 section 映射')


class TestImportBank(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.db = os.path.join(self.dir, 'bank.db')
        self.json_path = os.path.join(self.dir, 'b.json')

    def write_json(self, questions):
        with open(self.json_path, 'w', encoding='utf-8') as f:
            json.dump({'questions': questions}, f, ensure_ascii=False)

    def test_好题库入库并返回题数(self):
        self.write_json([copy.deepcopy(GOOD)])
        self.assertEqual(import_bank(self.json_path, self.db), 1)
        conn = open_db(self.db)
        self.addCleanup(conn.close)
        row = conn.execute('SELECT id,section,type,batch FROM questions').fetchone()
        self.assertEqual(row, ('e101', 'edu', 'single', 1))

    def test_无type字段的两选项题存成judge(self):
        # 真实 题库.json 的 1000 道题全都没有 type 字段，每行的 type 都靠
        # infer_type 推断。若它静默返回 'single'，这条必须变红。
        q = {'id': 'j1', 'n': 9, 'module': '教育学', 'stem': '判断题干',
             'options': [{'key': 'A', 'text': '正确'}, {'key': 'B', 'text': '错误'}],
             'answer': 'A', 'explanation': '解析'}
        self.write_json([q])
        self.assertEqual(import_bank(self.json_path, self.db), 1)
        conn = open_db(self.db)
        self.addCleanup(conn.close)
        row = conn.execute("SELECT type FROM questions WHERE id='j1'").fetchone()
        self.assertEqual(row, ('judge',))

    def test_batch_透传给校验规则(self):
        # 同一道没来源的本地题：batch=2 被拒（返回 0），batch=1 放行（返回 1）。
        # 钉住 import_bank 确实把 batch 交给了 validate。
        q = copy.deepcopy(GOOD)
        q['module'] = '唐山本地政策与时政'
        self.write_json([copy.deepcopy(q)])
        self.assertEqual(import_bank(self.json_path, self.db, batch=2), 0)
        self.assertEqual(import_bank(self.json_path, self.db, batch=1), 1)

    def test_坏题库一题都不写(self):
        # 先入库一题好数据，再用坏数据覆盖导入：校验不过就该整批不写，
        # 旧数据原样保留（validate 在写之前跑）
        self.write_json([copy.deepcopy(GOOD)])
        self.assertEqual(import_bank(self.json_path, self.db), 1)
        self.write_json([copy.deepcopy(GOOD), copy.deepcopy(GOOD)])
        self.assertEqual(import_bank(self.json_path, self.db), 0)
        conn = open_db(self.db)
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM questions').fetchone()[0], 1)

    def test_同一库重复导入成功且只留一份(self):
        # 刻意复用同一个 db 文件：import_bank() 每次都会 executescript(schema.sql)，
        # schema.sql 若没有 IF NOT EXISTS，第二次导入会抛
        # OperationalError: table questions already exists——bank.db 就只能生成一次。
        # 第二次返回的题数必须和第一次一样，且表里恰好只剩这一份：
        # 说明 runs 的是覆盖（DELETE FROM questions），不是追加。
        self.write_json([copy.deepcopy(GOOD)])
        self.assertEqual(import_bank(self.json_path, self.db), 1)
        self.assertEqual(import_bank(self.json_path, self.db), 1)
        conn = open_db(self.db)
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM questions').fetchone()[0], 1)

    def _写一好一坏两题(self):
        # 好题先 INSERT 成功，坏题再撞 questions.stem 的 NOT NULL。
        # stem=None 过得了 validate（validate 不查 stem），挡它的只有 DB 约束。
        good = copy.deepcopy(GOOD)
        badq = copy.deepcopy(GOOD)
        badq['id'], badq['n'], badq['stem'] = 'e102', 2, None
        self.write_json([good, badq])

    def _spy抓获内部连接(self):
        # 把 import_bank 内部 open_db() 开的那条连接抓出来，返回 captured 列表。
        # import_bank() 里 open_db 是模块级名字查找，改模块属性即可生效。
        import import_bank as ib
        captured, real_open_db = [], ib.open_db

        def spy(path):
            c = real_open_db(path)
            captured.append(c)
            return c

        ib.open_db = spy
        self.addCleanup(setattr, ib, 'open_db', real_open_db)
        return captured

    def test_写入中途抛异常也关连接(self):
        # 异常路径必须关连接：关过的连接再 execute 会报「已关闭」。
        # 没有 try/finally 时这条会红（连接还开着，execute 成功）。
        self._写一好一坏两题()
        captured = self._spy抓获内部连接()
        with self.assertRaises(sqlite3.IntegrityError):
            import_bank(self.json_path, self.db)
        self.assertEqual(len(captured), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            captured[0].execute('SELECT 1')

    def test_写入中途抛异常不留未提交事务(self):
        # 连接一关，未提交的事务就回滚，磁盘上的回滚日志不该留下。
        # 没有 try/finally 时事务还挂着，bank.db-journal 还在，这条会红。
        self._写一好一坏两题()
        self._spy抓获内部连接()
        with self.assertRaises(sqlite3.IntegrityError):
            import_bank(self.json_path, self.db)
        self.assertFalse(os.path.exists(self.db + '-journal'),
                         '连接没关：未提交的事务还挂着，回滚日志还在')

    def test_新连接上删题连带删除作答与错题(self):
        # 真实使用路径：open_db() 是全新连接，从没跑过 schema.sql。
        # schema.sql 里的 PRAGMA 只对执行它的那条连接生效，
        # 若 open_db() 忘了重开外键，下面两条断言会红。
        self.write_json([copy.deepcopy(GOOD)])
        self.assertEqual(import_bank(self.json_path, self.db), 1)
        conn = open_db(self.db)
        self.addCleanup(conn.close)
        conn.execute("INSERT INTO attempts VALUES ('e101','C',0,'2026-09-12')")
        conn.execute("INSERT INTO wrong VALUES ('e101','C',1,'2026-09-12','2026-09-12',0)")
        conn.execute("DELETE FROM questions WHERE id='e101'")
        conn.commit()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM attempts').fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM wrong').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
