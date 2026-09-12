# -*- coding: utf-8 -*-
"""API 端点。起真实服务打真实请求——mock 掉 HTTP 就测不出路由和序列化的问题。"""
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

from server import make_server

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _digest(path):
    """文件的 sha256。用来给真源 bank.db 拍快照。"""
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


class _ApiHelpers:
    """起好服务之后共用的那几条请求工具。子类负责在 setUpClass 里备好
    self.port / self.db / self.httpd。"""

    def url(self, path, **params):
        if params:
            path += ('&' if '?' in path else '?') + urllib.parse.urlencode(params)
        return f'http://127.0.0.1:{self.port}{path}'    # 参数统一 urlencode：中文模块名不能裸拼

    def get(self, path, **params):
        with urllib.request.urlopen(self.url(path, **params)) as r:
            return json.loads(r.read())

    def get_text(self, path):
        """静态文件用：4xx 时也把状态码和正文拿回来，不抛。"""
        try:
            with urllib.request.urlopen(self.url(path)) as r:
                return r.status, r.read().decode('utf-8')
        except urllib.error.HTTPError as e:
            try:
                return e.code, e.read().decode('utf-8')
            finally:
                e.close()      # 4xx 的响应体也是打开的流，不关会 ResourceWarning

    def raw(self, path, method='GET', body=None, raw_body=None):
        """要状态码时用这个：urlopen 对 4xx/5xx 抛 HTTPError，先接住再断言。"""
        data = raw_body if raw_body is not None else (
            None if body is None else json.dumps(body).encode())
        req = urllib.request.Request(self.url(path), data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            try:
                return e.code, e.read()
            finally:
                e.close()

    def post(self, path, body):
        code, payload = self.raw(path, 'POST', body)
        self.assertEqual(code, 200, payload)
        return json.loads(payload)

    def count_in_db(self, sql, args=()):
        """拿真库当标尺。服务端报的 total 是 COUNT(*)，这里读同一份临时副本。"""
        conn = sqlite3.connect(self.db)
        try:
            return conn.execute(sql, args).fetchone()[0]
        finally:
            conn.close()


class TestAPI(_ApiHelpers, unittest.TestCase):
    """真起服务打真 HTTP。

    本类**共用一台服务、一份临时库，逐条测试之间不做重置**。今天成立纯粹是因为
    每条断言都只依赖它自己 POST 进去的那点数据（或先自己清空再断言）——不是因为有
    隔离。后加测试时别假设自己是干净的库：要么自带前置数据，要么先 DELETE 再验。
    """

    @classmethod
    def setUpClass(cls):
        # 拷一份 bank.db 再起服务。bank.db 是入库产物、也是 git 里的真源，
        # 而本文件会 POST 作答（record_attempt 会 commit）——直接指着它跑，
        # 每跑一次测试就改一次真源。所以一律在临时副本上打。
        cls.tmpdir = tempfile.mkdtemp(prefix='qbank-test-')
        cls.db = os.path.join(cls.tmpdir, 'bank.db')

        # 真源快照。这一步的失败模式是「有人把 handler 又指回 bank.db」——
        # 那时它是**静默**被改的，跑完谁也不知道。拍个快照，在 tearDownClass 里
        # 对不上就炸，让静默变出声。
        cls.real_db = os.path.join(BASE, 'bank.db')
        cls.real_db_digest = _digest(cls.real_db)

        shutil.copy2(cls.real_db, cls.db)

        # 静态文件的根也放在临时目录：旁边故意放一个名字以 web 开头的兄弟目录，
        # 用来验证目录穿越守卫不是靠 startswith 前缀「看起来对」。
        cls.web = os.path.join(cls.tmpdir, 'web')
        os.makedirs(os.path.join(cls.web, 'sub'))
        with open(os.path.join(cls.web, 'index.html'), 'w', encoding='utf-8') as f:
            f.write('<h1>qbank-home</h1>')
        cls.sibling = os.path.join(cls.tmpdir, 'web-old')
        os.makedirs(cls.sibling)
        with open(os.path.join(cls.sibling, 'secret.txt'), 'w', encoding='utf-8') as f:
            f.write('SECRET')

        # host 显式写 127.0.0.1：make_server 默认 0.0.0.0，测试不该把端口
        # 摊到局域网上（生产默认保持 0.0.0.0，那是手机连 WiFi 的前提）。
        cls.httpd = make_server(port=0, db=cls.db, host='127.0.0.1', web=cls.web)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmpdir, ignore_errors=True)
        # 断言真源没被动过。放在最后（前面几步先清理干净），失败时是 error，
        # 会把整条测试记红——这正是想要的：静默改真源比测试红严重得多。
        if _digest(cls.real_db) != cls.real_db_digest:
            raise AssertionError(
                f'测试改动了真源 {cls.real_db}——服务必须指着临时副本，不能指回 bank.db')

    # ---- 取题 ----
    def test_取题默认一页40道(self):
        d = self.get('/api/questions')
        self.assertEqual(len(d['questions']), 40)
        # 别写死 1000——最后一步会往库里加题，写死了那天必红（前一个任务已经栽过一次）。
        # total 是 COUNT(*) 的产物，不受 limit 截断，所以两次请求的 total 必须一致。
        full = self.get('/api/questions', limit=1000)
        self.assertEqual(d['total'], full['total'])

    def test_取题带答案和解析(self):
        q = self.get('/api/questions', limit=1)['questions'][0]
        for f in ('id', 'n', 'module', 'type', 'stem', 'options', 'answer', 'explanation'):
            self.assertIn(f, q)

    def test_按模块筛(self):
        mod = self.get('/api/questions', limit=1)['questions'][0]['module']
        d = self.get('/api/questions', module=mod, limit=1000)
        # all() 在空列表上恒真是 True——筛出空集也会「通过」。先钉死筛出来有货。
        self.assertTrue(d['questions'], f'模块「{mod}」筛出 0 道，all() 就是假绿')
        self.assertTrue(all(q['module'] == mod for q in d['questions']))
        # total 是真计数，拿库里同模块的真实条数当标尺：WHERE 写错列会当场红。
        expect = self.count_in_db('SELECT COUNT(*) FROM questions WHERE module=?', (mod,))
        self.assertEqual(d['total'], expect)
        # 必须 == expect，不能写成 min(expect, 1000)：那等于把「截断」写进期望里，
        # 库涨过上限之后两条断言照样绿，而页面其实只拿到一部分题。
        self.assertEqual(len(d['questions']), expect)

    def test_按类型筛(self):
        # 别写死 1000——第 4 步会加判断题和多选题，写死了到时候必红。
        # 比的是「筛出来的都真是这个题型」+「数量和不带筛选时一致」。
        d = self.get('/api/questions', type='single', limit=1000)
        self.assertTrue(d['questions'], 'single 筛出 0 道，all() 在空表上恒真')
        self.assertTrue(all(q['type'] == 'single' for q in d['questions']))
        expect = self.count_in_db("SELECT COUNT(*) FROM questions WHERE type='single'")
        self.assertEqual(d['total'], expect)
        # 同上：== expect，别把截断写进期望。
        self.assertEqual(len(d['questions']), expect)

    def test_分页不重叠(self):
        a = {q['id'] for q in self.get('/api/questions', limit=40, offset=0)['questions']}
        b = {q['id'] for q in self.get('/api/questions', limit=40, offset=40)['questions']}
        self.assertEqual(len(a), 40)          # 两个空集也「不相交」，先钉死两页都有货
        self.assertEqual(len(b), 40)
        self.assertEqual(a & b, set())

    # ---- 作答 ----
    def test_作答返回判分与解析(self):
        q = self.get('/api/questions', limit=1)['questions'][0]
        wrong = 'A' if q['answer'] != 'A' else 'B'
        d = self.post('/api/attempts', {'qid': q['id'], 'chosen': wrong})
        self.assertFalse(d['correct'])
        self.assertEqual(d['answer'], q['answer'])
        self.assertTrue(d['explanation'])
        # 反向也要有一条：判分写死 False 的话，上面三条照样绿。
        right = self.post('/api/attempts', {'qid': q['id'], 'chosen': q['answer']})
        self.assertTrue(right['correct'])

    def test_作答记录可回读(self):
        qs = self.get('/api/questions', limit=2)['questions']
        right_q, wrong_q = qs[0], qs[1]
        wrong = 'A' if wrong_q['answer'] != 'A' else 'B'
        self.post('/api/attempts', {'qid': right_q['id'], 'chosen': right_q['answer']})
        self.post('/api/attempts', {'qid': wrong_q['id'], 'chosen': wrong})

        d = self.get('/api/attempts')
        # 顶层直接就是 qid → 作答 的映射，没有包装键：刷题页要拿它当 answers[qid] 用。
        # 一旦包一层（如 {'attempts': {...}}），前端整页渲染就取不到值。
        self.assertIn(right_q['id'], d)
        self.assertEqual(d[right_q['id']]['chosen'], right_q['answer'])
        self.assertIs(d[right_q['id']]['correct'], True)
        self.assertIs(d[wrong_q['id']]['correct'], False)
        # 全量而不是只回错题：键集合必须等于 attempts 表里的 qid 集合。
        conn = sqlite3.connect(self.db)
        try:
            ids = {r[0] for r in conn.execute('SELECT qid FROM attempts')}
        finally:
            conn.close()
        self.assertEqual(set(d), ids)

    def test_错题本连题一起返回(self):
        q = self.get('/api/questions', limit=1)['questions'][0]
        wrong = 'A' if q['answer'] != 'A' else 'B'
        self.post('/api/attempts', {'qid': q['id'], 'chosen': wrong})

        d = self.get('/api/wrong')
        # 只断言 'questions' in d 的话，{'questions': []}（JOIN 断了）也能过。
        self.assertIn(q['id'], [x['id'] for x in d['questions']],
                      '错题本里没有刚做错的题：JOIN 或落库断了')
        hit = next(x for x in d['questions'] if x['id'] == q['id'])
        for f in ('n', 'module', 'type', 'stem', 'answer', 'explanation'):
            self.assertTrue(hit.get(f), f'错题本少了题目字段 {f}')
        self.assertIsInstance(hit['options'], list)
        self.assertTrue(hit['options'], 'options 没解成 JSON 数组')
        self.assertEqual(hit['chosen'], wrong)

    # ---- 统计与清空（唯一会写库的两条路由 + 只被手工 curl 打过的 stats）----
    def test_统计与清空(self):
        # 本类共用一份库，别的测试也写作答记录——先清空把基线钉死。
        # 顺带这就是 DELETE 的第一遍：清空后统计必须归零。
        code, _ = self.raw('/api/attempts', method='DELETE')
        self.assertEqual(code, 200)
        d = self.get('/api/stats')
        self.assertEqual(d['total'], self.count_in_db('SELECT COUNT(*) FROM questions'))
        self.assertEqual((d['done'], d['right'], d['rate']), (0, 0, 0))
        self.assertEqual(d['by_module'], [])

        qs = self.get('/api/questions', limit=2)['questions']
        wrong = 'A' if qs[0]['answer'] != 'A' else 'B'
        self.post('/api/attempts', {'qid': qs[0]['id'], 'chosen': wrong})
        self.post('/api/attempts', {'qid': qs[1]['id'], 'chosen': qs[1]['answer']})

        d = self.get('/api/stats')
        self.assertEqual(d['done'], 2)
        self.assertEqual(d['right'], 1)
        self.assertEqual(d['rate'], 50)             # round(1/2*100)
        # by_module 逐字段对：题目分属哪个模块由库决定，不写死模块名。
        expect = {}
        for q, ok in ((qs[0], False), (qs[1], True)):
            e = expect.setdefault(q['module'], {'module': q['module'], 'total': 0, 'right': 0})
            e['total'] += 1
            e['right'] += 1 if ok else 0
        self.assertEqual({m['module']: m for m in d['by_module']}, expect)

        # DELETE /api/wrong 只清错题本，作答记录得留着——这是两条路由的分界。
        code, _ = self.raw('/api/wrong', method='DELETE')
        self.assertEqual(code, 200)
        self.assertEqual(self.get('/api/wrong')['total'], 0)
        self.assertEqual(self.get('/api/stats')['done'], 2)

        # 再错一次，把错题本重新填上——否则下面「一起清」那条断言是空的：
        # 错题本刚才已经被上一步清干净了，清不清都看不出差别。
        self.post('/api/attempts', {'qid': qs[0]['id'], 'chosen': wrong})
        self.assertEqual(self.get('/api/wrong')['total'], 1)

        # DELETE /api/attempts 两张表一起清。
        code, _ = self.raw('/api/attempts', method='DELETE')
        self.assertEqual(code, 200)
        self.assertEqual(self.get('/api/stats')['done'], 0)
        self.assertEqual(self.get('/api/stats')['right'], 0)
        self.assertEqual(self.get('/api/wrong')['total'], 0)

    # ---- 参数校验 ----
    def test_负数limit不会倒出整库(self):
        # SQLite 里 LIMIT -1 是「不限」——不夹住的话 ?limit=-1 整库下发。
        d = self.get('/api/questions', limit=-1)
        self.assertEqual(len(d['questions']), 1)

    def test_超大limit返回全库(self):
        # 比「和 ?limit=1000 一样」强：库正好 1000 条时那两个请求本来就一样，
        # 分辨不出「上限=1000」还是「上限很松」。这里直接拿库的真实题数当标尺——
        # 一旦有人把上限收紧到贴着题量，这条立刻红。
        expect = self.count_in_db('SELECT COUNT(*) FROM questions')
        d = self.get('/api/questions', limit=100000)
        self.assertEqual(len(d['questions']), expect)
        self.assertEqual(d['total'], expect)

    def test_负offset当0(self):
        d = self.get('/api/questions', limit=40, offset=-5)
        first = self.get('/api/questions', limit=40)
        self.assertEqual([q['id'] for q in d['questions']],
                         [q['id'] for q in first['questions']])

    def test_非法分页参数返回400(self):
        # 不是数字就是客户端错误，别让 int() 的 ValueError 冒成 500。
        for path in ('/api/questions?limit=abc', '/api/questions?offset=x',
                     '/api/questions?limit=1.5'):
            code, payload = self.raw(path)
            self.assertEqual(code, 400, f'{path} → {code} {payload!r}')
        # 参数缺省/空串是「没传」，不是「传错了」——照默认值走。
        self.assertEqual(self.raw('/api/questions?limit=')[0], 200)

    # ---- 坏请求 ----
    def test_坏JSON返回400(self):
        code, _ = self.raw('/api/attempts', method='POST',
                           raw_body='{不是 json'.encode('utf-8'))
        self.assertEqual(code, 400)

    def test_缺qid返回400(self):
        code, _ = self.raw('/api/attempts', method='POST', body={'chosen': 'A'})
        self.assertEqual(code, 400)
        code, _ = self.raw('/api/attempts', method='POST', body=[])
        self.assertEqual(code, 400)

    def test_题库里没有的qid返回404(self):
        code, _ = self.raw('/api/attempts', method='POST',
                           body={'qid': '这道题不存在', 'chosen': 'A'})
        self.assertEqual(code, 404)

    # ---- 静态文件 ----
    def test_静态目录索引正常(self):
        code, body = self.get_text('/')
        self.assertEqual(code, 200, body)
        self.assertIn('qbank-home', body)

    def test_目录穿越被挡住(self):
        # 兄弟目录 web-old 的名字以 WEB 开头：老守卫 startswith(WEB) 会放行它，
        # 必须比对 WEB + os.sep 才只认真正的子孙。
        code, body = self.get_text('/../web-old/secret.txt')
        self.assertEqual(code, 403, f'穿越到兄弟目录被放行了：{body}')
        self.assertNotIn('SECRET', body)


def _add_questions(db_path, count):
    """往临时库追 count 道合法单选题，返回追加前的题数。

    形状必须过 schema 的约束：n 唯一、type 在枚举里、options 是 JSON 数组、
    answer 的字母得在选项里。n 从库里现有的 MAX(n) 往后接，不写死——库涨了也不撞。
    """
    conn = sqlite3.connect(db_path)
    try:
        base = conn.execute('SELECT COUNT(*) FROM questions').fetchone()[0]
        next_n = (conn.execute('SELECT MAX(n) FROM questions').fetchone()[0] or 0) + 1
        for i in range(count):
            opts = [{'key': k, 'text': f'选项{k}'} for k in 'ABCD']
            conn.execute(
                'INSERT INTO questions (id,n,section,module,type,stem,options,answer,'
                'explanation,batch) VALUES (?,?,?,?,?,?,?,?,?,?)',
                (f'zz-extra-{next_n + i}', next_n + i, 'edu', '教育学', 'single',
                 f'扩容题 {next_n + i}', json.dumps(opts, ensure_ascii=False), 'A',
                 f'扩容题 {next_n + i} 的解析', 2))
        conn.commit()
        return base
    finally:
        conn.close()


class TestBigBank(_ApiHelpers, unittest.TestCase):
    """库比「贴着题量」的旧上限（1000）大时的整库取数。

    这是上限那条修正的回归测试：上限一旦贴近题量，整库取数就会被静默截断，
    刷题页的未做数/模块筛/统计跟着错而不报任何错。夹具特意造成 bank.db + 5 行，
    稳稳越过旧上限。
    """

    EXTRA = 5

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix='qbank-big-')
        cls.db = os.path.join(cls.tmpdir, 'bank.db')
        cls.real_db = os.path.join(BASE, 'bank.db')
        cls.real_db_digest = _digest(cls.real_db)
        shutil.copy2(cls.real_db, cls.db)
        # 追加发生在临时副本上；真源只被读、被拍快照。
        cls.base_count = _add_questions(cls.db, cls.EXTRA)
        cls.httpd = make_server(port=0, db=cls.db, host='127.0.0.1')
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmpdir, ignore_errors=True)
        if _digest(cls.real_db) != cls.real_db_digest:
            raise AssertionError(
                f'测试改动了真源 {cls.real_db}——服务必须指着临时副本，不能指回 bank.db')

    def test_上限不截断整库(self):
        expect = self.count_in_db('SELECT COUNT(*) FROM questions')
        # 夹具形状自查：题数就是 bank.db + EXTRA，且必须**大于旧上限 1000**——
        # 只有比上限大，这条才咬得住「上限贴着题量」的截断。
        # （bank.db 现在是 1000 且只增不减，所以 expect = 1005 > 1000 恒成立；
        #   这里写死的是 1000 这个旧上限常量，不是当前题量，不会随库增长而烂掉。）
        self.assertEqual(expect, self.base_count + self.EXTRA)
        self.assertGreater(expect, 1000)
        d = self.get('/api/questions', limit=1000000)
        # 条数必须等于库里真实题数：上限贴着题量就会截断，这里立刻红。
        self.assertEqual(len(d['questions']), expect)
        self.assertEqual(d['total'], expect)


if __name__ == '__main__':
    unittest.main()
