# -*- coding: utf-8 -*-
"""表结构约束：类型白名单、唯一性、级联删除。"""
import os
import sqlite3
import tempfile
import unittest

SCHEMA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'schema.sql')


def fresh_db():
    """建一个空库，返回连接。"""
    fd, path = tempfile.mkstemp(suffix='.db')
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.executescript(open(SCHEMA, encoding='utf-8').read())
    return conn


def add_q(conn, qid='e101', n=1, qtype='single', answer='B'):
    conn.execute(
        "INSERT INTO questions (id,n,section,module,type,stem,options,answer,explanation) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (qid, n, 'edu', '教育学', qtype, '题干', '["甲","乙","丙","丁"]', answer, '解析'))


class TestSchema(unittest.TestCase):
    def test_五张表都在(self):
        conn = fresh_db()
        names = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        for t in ('questions', 'attempts', 'wrong', 'mock_runs', 'sprint'):
            self.assertIn(t, names)

    def test_type_只认三种(self):
        conn = fresh_db()
        with self.assertRaises(sqlite3.IntegrityError):
            add_q(conn, qtype='essay')

    def test_id_唯一(self):
        conn = fresh_db()
        add_q(conn)
        with self.assertRaises(sqlite3.IntegrityError):
            add_q(conn, n=2)

    def test_n_唯一(self):
        conn = fresh_db()
        add_q(conn, qid='e101', n=1)
        with self.assertRaises(sqlite3.IntegrityError):
            add_q(conn, qid='e102', n=1)

    def test_删题会连带删掉作答和错题(self):
        conn = fresh_db()
        conn.execute('PRAGMA foreign_keys = ON')
        add_q(conn)
        conn.execute("INSERT INTO attempts VALUES ('e101','C',0,'2026-09-12')")
        conn.execute("INSERT INTO wrong VALUES ('e101','C',1,'2026-09-12','2026-09-12',0)")
        conn.execute("DELETE FROM questions WHERE id='e101'")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM wrong").fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
