# -*- coding: utf-8 -*-
"""三题型判分、作答记录、取数。都是纯函数，直接拿真库结构跑。"""
import os
import sqlite3
import tempfile
import unittest

from banklib import grade, list_questions, record_attempt

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(BASE, 'schema.sql')

# 真实 bank.db 里 options 是**对象**数组，不是裸字符串数组。
# 题面渲染（Task 9）从 key/text 取字，夹具必须照这个形状来，
# 否则后面照着夹具写渲染会静默对不上。
OPTIONS2 = '[{"key":"A","text":"甲"},{"key":"B","text":"乙"}]'
OPTIONS4 = ('[{"key":"A","text":"甲"},{"key":"B","text":"乙"},'
            '{"key":"C","text":"丙"},{"key":"D","text":"丁"}]')


def fresh_db():
    """建一个空库，返回 (连接, 文件路径)。调用方自己关连接、删文件。"""
    fd, path = tempfile.mkstemp(suffix='.db')
    os.close(fd)
    conn = sqlite3.connect(path)
    with open(SCHEMA, encoding='utf-8') as f:
        conn.executescript(f.read())
    return conn, path


def add_q(conn, qid, n, section, module, qtype='single', options=OPTIONS4, answer='B'):
    conn.execute(
        "INSERT INTO questions (id,n,section,module,type,stem,options,answer,explanation) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (qid, n, section, module, qtype, f'{qid} 的题干', options, answer, f'{qid} 的解析'))


class TestGrade(unittest.TestCase):
    def test_单选答对(self):
        self.assertTrue(grade('single', 'B', 'B'))

    def test_单选答错(self):
        self.assertFalse(grade('single', 'B', 'C'))

    def test_判断题走同一套(self):
        self.assertTrue(grade('judge', 'A', 'A'))
        self.assertFalse(grade('judge', 'A', 'B'))

    def test_多选全对才算对(self):
        self.assertTrue(grade('multi', 'ABD', 'ABD'))

    def test_多选少选算错(self):
        self.assertFalse(grade('multi', 'ABD', 'AB'))

    def test_多选多选算错(self):
        self.assertFalse(grade('multi', 'ABD', 'ABCD'))

    def test_多选错选算错(self):
        self.assertFalse(grade('multi', 'ABD', 'ABC'))

    def test_多选顺序不影响判分(self):
        self.assertTrue(grade('multi', 'ABD', 'DBA'))

    def test_作答小写字母也能判对(self):
        """规范化要转大写：_norm 里的 .upper() 就钉在这一条上。

        现有输入全是规范后的大写形式，删掉 .upper() 它们照样全绿——
        这条拿小写作答把「大小写不敏感」变成测得出的行为。
        """
        self.assertTrue(grade('single', 'B', 'b'))

    def test_作答带首尾空白也能判对(self):
        """规范化要去空白：_norm 里的 .strip() 就钉在这一条上。

        空白是集合里的一个字符，去不掉就会混进排序结果，' B ' 与 'B' 就不等了。
        """
        self.assertTrue(grade('single', 'B', ' B '))

    def test_空白大小写顺序一起上也能判对(self):
        """去空白、转大写、按字母排序三件事叠在一起，缺一不可。"""
        self.assertTrue(grade('multi', 'ABD', ' dba '))

    def test_没作答算错(self):
        for t in ('single', 'judge', 'multi'):
            self.assertFalse(grade(t, 'B', ''))


class TestRecordAttempt(unittest.TestCase):
    def setUp(self):
        self.conn, self.path = fresh_db()
        self.addCleanup(os.unlink, self.path)     # 后注册的先跑：先关连接再删文件
        self.addCleanup(self.conn.close)
        add_q(self.conn, 'e101', 1, 'edu', '教育学', 'single', OPTIONS2, 'B')
        self.conn.commit()

    def wrong(self, qid='e101'):
        return self.conn.execute(
            "SELECT chosen,wrong_count,resolved FROM wrong WHERE qid=?", (qid,)).fetchone()

    def test_答错进错题本(self):
        r = record_attempt(self.conn, 'e101', 'A')
        self.assertFalse(r['correct'])
        self.assertEqual(r['wrong_count'], 1)

    def test_再错一次计数累加(self):
        record_attempt(self.conn, 'e101', 'A')
        r = record_attempt(self.conn, 'e101', 'A')
        self.assertEqual(r['wrong_count'], 2)

    def test_做对了标记已订正(self):
        record_attempt(self.conn, 'e101', 'A')
        record_attempt(self.conn, 'e101', 'B')
        resolved = self.conn.execute(
            "SELECT resolved FROM wrong WHERE qid='e101'").fetchone()[0]
        self.assertEqual(resolved, 1)

    def test_attempts_每题一行(self):
        record_attempt(self.conn, 'e101', 'A')
        record_attempt(self.conn, 'e101', 'B')
        n = self.conn.execute("SELECT COUNT(*) FROM attempts").fetchone()[0]
        self.assertEqual(n, 1)

    def test_一次答对不进错题本(self):
        """从没做错的题，答对后 wrong 表里不该凭空多出一行。

        错题本靠 wrong_count 和 resolved 算「还没掌握」，凭空插一行会把
        没做错过的题算成错题。
        """
        r = record_attempt(self.conn, 'e101', 'B')
        self.assertTrue(r['correct'])
        self.assertEqual(r['wrong_count'], 0)
        self.assertIsNone(self.wrong())

    def test_做对后返回错题本里的累计错次(self):
        """错过的题这次做对了，wrong 行以 resolved=1 留着（不删），于是返回值
        仍是那条记录累计的错次，不是 0——Task 6 的作答接口要把它透给前端。

        这里对着库里那行实际的值断言，不写死数字：SQL 改了计数方式，
        断言跟着库走，不会同谋地一起变绿。
        """
        record_attempt(self.conn, 'e101', 'A')
        r = record_attempt(self.conn, 'e101', 'B')
        self.assertTrue(r['correct'])
        self.assertEqual(r['wrong_count'], self.wrong()[1])

    def test_返回值带答案与解析(self):
        """判分结果要能把答案和解析一并回给前端，省一次取题。"""
        r = record_attempt(self.conn, 'e101', 'A')
        self.assertEqual(r['answer'], 'B')
        self.assertEqual(r['explanation'], 'e101 的解析')

    def test_attempts_记下最后所选项与判分(self):
        record_attempt(self.conn, 'e101', 'A')
        row = self.conn.execute(
            "SELECT chosen,correct FROM attempts WHERE qid='e101'").fetchone()
        self.assertEqual(row, ('A', 0))
        record_attempt(self.conn, 'e101', 'B')
        row = self.conn.execute(
            "SELECT chosen,correct FROM attempts WHERE qid='e101'").fetchone()
        self.assertEqual(row, ('B', 1))

    def test_错题本记下最后错选的项(self):
        record_attempt(self.conn, 'e101', 'A')
        record_attempt(self.conn, 'e101', 'C')
        chosen, count, resolved = self.wrong()
        self.assertEqual((chosen, count, resolved), ('C', 2, 0))

    def test_订正后再错要重新计为没掌握(self):
        """resolved 不是一次性的：做对标记订正，之后再错必须落回 0。"""
        record_attempt(self.conn, 'e101', 'A')
        record_attempt(self.conn, 'e101', 'B')
        self.assertEqual(self.wrong()[2], 1)
        r = record_attempt(self.conn, 'e101', 'A')
        self.assertEqual(r['wrong_count'], 2)
        self.assertEqual(self.wrong()[2], 0)

    def test_题库里没有这道题会报错(self):
        """qid 不存在要报错，不能静默当没发生——前端的作答得能对上题。"""
        with self.assertRaises(KeyError):
            record_attempt(self.conn, '不存在', 'A')
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 0)


class TestListQuestions(unittest.TestCase):
    def setUp(self):
        self.conn, self.path = fresh_db()
        self.addCleanup(os.unlink, self.path)
        self.addCleanup(self.conn.close)
        add_q(self.conn, 'e101', 1, 'edu', '教育学', 'single', OPTIONS4, 'B')
        add_q(self.conn, 'e102', 2, 'edu', '教育心理学', 'judge', OPTIONS2, 'A')
        add_q(self.conn, 'p101', 3, 'pub', '公共基础 · 法律', 'multi', OPTIONS4, 'ABD')
        add_q(self.conn, 'p102', 4, 'pub', '公共基础 · 法律', 'single', OPTIONS4, 'C')
        add_q(self.conn, 'l101', 5, 'local', '唐山本地政策与时政', 'single', OPTIONS4, 'A')
        self.conn.commit()

    def ids(self, **kw):
        return [q['id'] for q in list_questions(self.conn, **kw)['questions']]

    def test_不给条件返回全部且total一致(self):
        r = list_questions(self.conn, limit=100)
        self.assertEqual(r['total'], 5)
        self.assertEqual(len(r['questions']), 5)

    def test_按section过滤(self):
        r = list_questions(self.conn, section='pub', limit=100)
        self.assertEqual(r['total'], 2)
        self.assertEqual({q['id'] for q in r['questions']}, {'p101', 'p102'})

    def test_按module过滤(self):
        r = list_questions(self.conn, module='教育心理学', limit=100)
        self.assertEqual([q['id'] for q in r['questions']], ['e102'])

    def test_按qtype过滤(self):
        r = list_questions(self.conn, qtype='single', limit=100)
        self.assertEqual(r['total'], 3)
        self.assertTrue(all(q['type'] == 'single' for q in r['questions']))

    def test_多个条件叠加(self):
        r = list_questions(self.conn, section='edu', qtype='single', limit=100)
        self.assertEqual([q['id'] for q in r['questions']], ['e101'])

    def test_total是结果集总数不是本页条数(self):
        """total 必须按过滤后的全集算，前端靠它算页数；写成 len(本页) 就废了。"""
        r = list_questions(self.conn, limit=2)
        self.assertEqual(r['total'], 5)
        self.assertEqual(len(r['questions']), 2)

    def test_过滤后的total也按同一条件算(self):
        r = list_questions(self.conn, section='pub', limit=1)
        self.assertEqual(r['total'], 2)
        self.assertEqual(len(r['questions']), 1)

    def test_offset翻页取到不同的题(self):
        first = self.ids(limit=2)
        second = self.ids(limit=2, offset=2)
        last = self.ids(limit=2, offset=4)
        self.assertEqual(first, ['e101', 'e102'])
        self.assertEqual(second, ['p101', 'p102'])
        self.assertEqual(last, ['l101'])
        self.assertEqual(len(set(first) & set(second)), 0)

    def test_按n排序(self):
        self.assertEqual(self.ids(limit=100), ['e101', 'e102', 'p101', 'p102', 'l101'])

    def test_超范围offset返回空页但total不变(self):
        r = list_questions(self.conn, limit=2, offset=99)
        self.assertEqual(r['questions'], [])
        self.assertEqual(r['total'], 5)

    def test_options解析成对象数组(self):
        """options 出库必须是对象数组——渲染靠 key/text，裸字符串会渲染成空。"""
        q = list_questions(self.conn, limit=100)['questions'][0]
        self.assertEqual(q['options'], [{'key': 'A', 'text': '甲'}, {'key': 'B', 'text': '乙'},
                                        {'key': 'C', 'text': '丙'}, {'key': 'D', 'text': '丁'}])

    def test_默认带答案和解析(self):
        q = list_questions(self.conn, limit=100)['questions'][0]
        self.assertEqual(q['answer'], 'B')
        self.assertEqual(q['explanation'], 'e101 的解析')

    def test_关掉答案就不吐答案和解析(self):
        """模考模式要在交卷前藏答案，藏不干净等于泄题。"""
        for q in list_questions(self.conn, limit=100, include_answer=False)['questions']:
            self.assertNotIn('answer', q)
            self.assertNotIn('explanation', q)
            self.assertIn('stem', q)
            self.assertIn('options', q)


if __name__ == '__main__':
    unittest.main()
