# -*- coding: utf-8 -*-
"""API 端点。起真实服务打真实请求——mock 掉 HTTP 就测不出路由和序列化的问题。"""
import hashlib
import http.client
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

    def del_(self, path):
        code, payload = self.raw(path, 'DELETE')
        self.assertEqual(code, 200, payload)
        return json.loads(payload)

    def count_in_db(self, sql, args=()):
        """拿真库当标尺。服务端报的 total 是 COUNT(*)，这里读同一份临时副本。"""
        conn = sqlite3.connect(self.db)
        try:
            return conn.execute(sql, args).fetchone()[0]
        finally:
            conn.close()


class ApiCase(_ApiHelpers, unittest.TestCase):
    """真起服务打真 HTTP。起服务、拷库、拍真源快照都在这里，子类别抄第二遍。

    **服务永远指着 bank.db 的临时副本。** bank.db 是入库产物、也是 git 里的真源，
    而本文件的每个写操作（record_attempt 会 commit、DELETE /api/wrong 会清表）
    都真的落盘——直接指着它跑，每跑一次测试就改一次真源，测试跑的还可能是要命的
    那几条（TestMock 的 setUp 一上来就清空错题本）。所以：拷副本、在副本上打。

    最后一道保险是 tearDownClass 里的真源快照比对：失败模式是「有人把 handler
    又指回 bank.db」——那时它是**静默**被改的，跑完谁也不知道。拍个快照，对不上
    就炸，让静默变出声。
    """

    @classmethod
    def prepare_db(cls, db_path):
        """起服务前动一下临时副本（加题、改模块…）。基类不关心返回值。"""
        return None

    @classmethod
    def make_web(cls, tmpdir):
        """静态文件的根。默认空目录——不请求静态文件的测试类不用管它。"""
        web = os.path.join(tmpdir, 'web')
        os.makedirs(web, exist_ok=True)
        return web

    @classmethod
    def setUpClass(cls):
        cls.real_db = os.path.join(BASE, 'bank.db')
        cls.real_db_digest = _digest(cls.real_db)

        cls.tmpdir = tempfile.mkdtemp(prefix='qbank-test-')
        cls.db = os.path.join(cls.tmpdir, 'bank.db')
        shutil.copy2(cls.real_db, cls.db)
        cls.prepared = cls.prepare_db(cls.db)

        cls.web = cls.make_web(cls.tmpdir)
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


class TestAPI(ApiCase):
    """取题 / 作答 / 统计 / 静态文件。

    本类**共用一台服务、一份临时库，逐条测试之间不做重置**。今天成立纯粹是因为
    每条断言都只依赖它自己 POST 进去的那点数据（或先自己清空再断言）——不是因为有
    隔离。后加测试时别假设自己是干净的库：要么自带前置数据，要么先 DELETE 再验。
    """

    @classmethod
    def make_web(cls, tmpdir):
        # 静态文件的根也放在临时目录：旁边故意放一个名字以 web 开头的兄弟目录，
        # 用来验证目录穿越守卫不是靠 startswith 前缀「看起来对」。
        web = super().make_web(tmpdir)
        os.makedirs(os.path.join(web, 'sub'))
        with open(os.path.join(web, 'index.html'), 'w', encoding='utf-8') as f:
            f.write('<h1>qbank-home</h1>')
        cls.sibling = os.path.join(tmpdir, 'web-old')
        os.makedirs(cls.sibling)
        with open(os.path.join(cls.sibling, 'secret.txt'), 'w', encoding='utf-8') as f:
            f.write('SECRET')
        return web

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

    # ---- 错题本：标记已订正 ----
    def test_标记订正后错题不再出现(self):
        """POST /api/wrong/<qid>/resolve 之后，这一题不再出现在 /api/wrong。

        这是把 resolve 端点测死的唯一一条：端点没了（404）、SQL 没写、
        或 UPDATE 少了 resolved=1，三种写法都在这里红。
        """
        q = self.get('/api/questions', limit=1)['questions'][0]
        wrong = 'A' if q['answer'] != 'A' else 'B'
        self.post('/api/attempts', {'qid': q['id'], 'chosen': wrong})
        self.assertIn(q['id'], [x['id'] for x in self.get('/api/wrong')['questions']],
                      '（前提）先做错一道，它得在错题本里')
        code, payload = self.raw(f'/api/wrong/{q["id"]}/resolve', method='POST', body={})
        self.assertEqual(code, 200, payload)
        self.assertNotIn(q['id'], [x['id'] for x in self.get('/api/wrong')['questions']],
                         '标记订正后这一题还在错题本里——UPDATE 没写进去？')
        # 库里那行是「留着历史、不再算还没掌握」：resolved=1，不是被删掉。
        # **只查这一题**——本类共用一份库，别的测试会往 wrong 里写行，
        # 拿全表条数当标尺就是假设自己是干净的库（这类的老毛病）。
        self.assertEqual(self.count_in_db(
            'SELECT COUNT(*) FROM wrong WHERE qid=? AND resolved=1', (q['id'],)), 1)

    def test_订正的怪路径返回404(self):
        """这是 server.py 里第一条参数化路径（其余路由都是整串相等比对），
        切错了就会 IndexError 冒出 Handler —— 那时客户端一个字节都收不到。

        这里不光要 404，还要**路径本身被拒**：形状不对必须由切路径那一步拦下来，
        写「not found」。只看状态码是测不动的——`/api/wrong//resolve` 切松了会漏到
        查库那一步、撞上「题号不在库里」那条，照样是 404，红不了。
        """
        for path in ('/api/wrong//resolve', '/api/wrong/q1/extra/resolve',
                     '/api/wrong/q1/resolve/', '/api/wrong/q1/foo',
                     '/api/wrong/q1', '/api/wrong/'):
            code, payload = self.raw(path, method='POST', body={})
            self.assertEqual(code, 404, f'{path} → {code} {payload!r}')
            self.assertEqual(json.loads(payload), {'error': 'not found'},
                             f'{path} 不是被切路径那一步拒的（漏到查库了）：{payload!r}')

    def test_订正题库里没有的题号返回404(self):
        # qid 走 urlencode：HTTP 请求行只吃 ASCII，中文直接拼进去 urlopen 会抛
        # UnicodeEncodeError（那是测试自己的错，不是服务端的）。服务端那边
        # 对这一段做了 unquote，百分号编码的题号同样解得出来。
        qid = urllib.parse.quote('这道题不存在')
        code, payload = self.raw(f'/api/wrong/{qid}/resolve', method='POST', body={})
        self.assertEqual(code, 404, payload)
        self.assertIn('题库里没有这道题', json.loads(payload)['error'])

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


class TestBigBank(ApiCase):
    """库比「贴着题量」的旧上限（1000）大时的整库取数。

    这是上限那条修正的回归测试：上限一旦贴近题量，整库取数就会被静默截断，
    刷题页的未做数/模块筛/统计跟着错而不报任何错。夹具特意造成 bank.db + 5 行，
    稳稳越过旧上限。
    """

    EXTRA = 5

    @classmethod
    def prepare_db(cls, db_path):
        # 追加发生在临时副本上；真源只被读、被拍快照（快照在 ApiCase 里拍）。
        return _add_questions(db_path, cls.EXTRA)

    def setUp(self):
        # prepare_db 的返回值（追加前的题数）。放这儿是因为 prepare_db 是类方法，
        # 拿到它的返回值得等 setUpClass 跑完。
        self.base_count = self.prepared

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


def _lookup(db_path, qid, col):
    """从库里单查一个字段。测试要断言题目属性时用——不绕道 API，避免
    拿被测代码的输出当自己断言的依据。

    db_path 一律是 ApiCase 的临时副本（self.db），别指回真源 bank.db。
    col 是**测试自己写死的字面量**（'module' / 'answer'），不是外部输入，
    所以这里用 f-string 拼列名是安全的：没有注入面。调用点也只许传字面量。
    """
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(
            f'SELECT {col} FROM questions WHERE id=?', (qid,)).fetchone()[0]
    finally:
        conn.close()


class TestMock(ApiCase):
    """模考端点：抽题配比、两部分不交错、答题期间不判分、交卷才并进错题本。

    每条测试自己 POST 一场新卷子；答题记录/错题本靠 setUp 清空，所以互不污染。
    """

    # ---- 测试自己的配比依据 ----
    # MK_PARTS 的模块表在 server.py 里只有一份，这里是**测试独立抄的一份**：
    # 断言要的是「服务端抽出来的题量对得上配比」，拿服务端自己的表当期望就成
    # 了同义反复。**server.py 的 MK_PARTS 改了，这两组模块名必须跟着改。**
    #
    # 分「公基段 / 教基段」按**模块名**，不按 section：唐山本地政策与校情那两组
    # 的 section 是 local / school，不是 pub，用 section=='pub' 分只会在今天这版
    # 数据上碰巧切一次，并没有真的验到「两部分不交错」。
    MK_PUB = ('公共基础 · 政治与时政', '公共基础 · 法律', '公共基础 · 经济、管理与常识',
              '公共基础 · 公文写作', '人文历史与科技常识',
              '唐山工业职业技术大学校情', '唐山本地政策与时政')
    MK_EDU = ('教育学', '教育心理学', '教育法律法规',
              '教师职业理念与职业道德', '职业教育与高等教育')
    QUOTA = {'公共基础 · 政治与时政': 16, '公共基础 · 法律': 13,
             '公共基础 · 经济、管理与常识': 11, '公共基础 · 公文写作': 8,
             '人文历史与科技常识': 6, '唐山工业职业技术大学校情': 3,
             '唐山本地政策与时政': 3,
             '教育学': 23, '教育心理学': 17, '教育法律法规': 7,
             '教师职业理念与职业道德': 6, '职业教育与高等教育': 7}

    def setUp(self):
        # 每个测试从空错题本开始，否则测试之间互相污染，红绿不可复现
        self.del_('/api/wrong')

    def seg_of(self, qid):
        """这道题属于哪一段：MK_PARTS 是 公基段 + 教基段，两段。"""
        mod = _lookup(self.db, qid, 'module')
        if mod in self.MK_PUB:
            return 'pub'
        if mod in self.MK_EDU:
            return 'edu'
        self.fail(f'{mod} 不在测试的 MK_PARTS 模块表里——'
                  f'server.py 的配比改了，TestMock.MK_PUB / MK_EDU 要跟着改')

    def test_抽题120道不重复(self):
        d = self.post('/api/mock/start', {})
        self.assertEqual(len(d['ids']), 120)
        self.assertEqual(len(set(d['ids'])), 120)
        # 抽出来的 id 必须真在库里：凭空的 id 到了判分那步才会炸，那时已经晚了。
        full = {q['id'] for q in self.get('/api/questions', limit=1000000)['questions']}
        self.assertTrue(set(d['ids']) <= full, '抽到了库里没有的题号')

    def test_题目配比符合配比表(self):
        """每个模块抽到的题量 = 配比表里的数。少抽一个模块、配额写错都会在这儿红。"""
        d = self.post('/api/mock/start', {})
        got = {}
        for qid in d['ids']:
            mod = _lookup(self.db, qid, 'module')
            got[mod] = got.get(mod, 0) + 1
        only_got = {m: n for m, n in got.items() if self.QUOTA.get(m) != n}
        want = {m: n for m, n in self.QUOTA.items() if got.get(m) != n}
        self.assertEqual((only_got, want), ({}, {}),
                         f'配比不符：多抽/少抽 {only_got}；应有而没有 {want}')
        self.assertEqual(sum(got.values()), 120)
        # 配比表本身：公基 60 + 教基 60，各半。
        self.assertEqual(sum(n for m, n in self.QUOTA.items() if m in self.MK_PUB), 60)
        self.assertEqual(sum(n for m, n in self.QUOTA.items() if m in self.MK_EDU), 60)

    def test_两部分不交错(self):
        d = self.post('/api/mock/start', {})
        segs = [self.seg_of(i) for i in d['ids']]
        # 两段的话序列只该切换 1 次。切了 2 次以上就是公基/教基交错——
        # 真实卷子是按部分连排的，交错会让考生来回跳。
        switches = sum(1 for a, b in zip(segs, segs[1:]) if a != b)
        self.assertEqual(switches, 1, f'模块段被打断，共 {switches + 1} 段')
        # 只数切换次数的话，教基在前、公基在后也是 1 次——那是另一张卷子。
        # 公基必须在第一部分，而且正好 60 题。
        self.assertEqual(segs[0], 'pub', '第一部分必须是公基')
        self.assertEqual(segs.count('pub'), 60)
        self.assertEqual(segs.count('edu'), 60)

    def test_答题期间不判分不进错题本(self):
        d = self.post('/api/mock/start', {})
        qid = d['ids'][0]
        # 挑一个必错的作答：选对了的话「没进错题本」是白绿。
        ans = _lookup(self.db, qid, 'answer')
        wrong = next(k for k in 'ABCD' if k != ans)
        b_wrong = self.get('/api/wrong')['total']
        b_done = self.get('/api/stats')['done']
        self.assertEqual(b_wrong, 0, '（前提）setUp 清空后错题本该是空的')
        self.post('/api/mock/answer', {'qid': qid, 'chosen': wrong})
        self.assertEqual(self.get('/api/wrong')['total'], b_wrong,
                         '答题期间就进了错题本——判分该等交卷')
        self.assertEqual(self.get('/api/stats')['done'], b_done,
                         '答题期间就写了作答记录——判分该等交卷')

    def test_交卷才并进错题本(self):
        d = self.post('/api/mock/start', {})
        ids = d['ids'][:5]
        right_id = ids[0]
        for qid in ids:
            ans = _lookup(self.db, qid, 'answer')
            chosen = ans if qid == right_id else next(k for k in 'ABCD' if k != ans)
            self.post('/api/mock/answer', {'qid': qid, 'chosen': chosen})
        self.assertEqual(self.get('/api/wrong')['total'], 0, '交卷前错题本该是空的')

        r = self.post('/api/mock/submit', {})
        self.assertIn('score', r)
        self.assertIn('by_module', r)
        # 5 题里 1 对 4 错。服务端要是把「合并 attempts」那一步去掉，错题本这条就红。
        self.assertEqual(r['right'], 1)
        self.assertEqual(r['score'], round(1 / 120 * 100, 1))
        self.assertEqual(r['total'], 120)
        self.assertEqual(r['unanswered'], 115)
        self.assertEqual({x['id'] for x in self.get('/api/wrong')['questions']}, set(ids[1:]),
                         '答错的没全进错题本')
        # 答对的那道不能误进错题本——「全都判错」也能让上面那行绿。
        self.assertNotIn(right_id, [x['id'] for x in self.get('/api/wrong')['questions']])
        self.assertEqual(set(r['wrong']), set(ids[1:]))
        # by_module 是给成绩单分模块用的：题量与答对数都要对得上。
        self.assertEqual(sum(m['n'] for m in r['by_module']), 120)
        self.assertEqual(sum(m['right'] for m in r['by_module']), 1)

    def test_重复交卷不重复计分(self):
        """三条交卷路径（手动 / 页内超时 / 关着页面过期）都打同一个端点，
        客户端重入一次就会交两回。第二次必须是幂等的：只回上次的成绩，
        不再把错次记一遍。"""
        d = self.post('/api/mock/start', {})
        qid = d['ids'][0]
        ans = _lookup(self.db, qid, 'answer')
        self.post('/api/mock/answer',
                  {'qid': qid, 'chosen': next(k for k in 'ABCD' if k != ans)})
        r1 = self.post('/api/mock/submit', {})
        r2 = self.post('/api/mock/submit', {})
        self.assertEqual(r1['score'], r2['score'])
        wc = {x['id']: x['wrong_count'] for x in self.get('/api/wrong')['questions']}
        self.assertEqual(wc[qid], 1, '交两次把错次记成了 2')

    def test_GET返回配比表与进行中的那场(self):
        d = self.get('/api/mock')
        self.assertEqual(d['n'], 120)
        self.assertEqual(d['seconds'], 120 * 60)
        parts = d['parts']
        self.assertEqual([p['name'] for p in parts], ['公共基础知识', '教育专业能力测验'])
        self.assertEqual([p['n'] for p in parts], [60, 60])
        # 配置表逐模块对：客户端不再存一份配比，它渲染的就是这里。
        mods = [m for p in parts for m in p['modules']]
        self.assertEqual({m['module']: m['n'] for m in mods}, self.QUOTA)
        self.assertEqual(sum(m['n'] for m in mods), 120)
        # 唐山/校情那两组要带上小组名，成绩单上的「地方特色」标组靠它。
        grp = {m['module']: m.get('group') for m in mods if m.get('group')}
        self.assertEqual(set(grp), {'唐山工业职业技术大学校情', '唐山本地政策与时政'})
        self.assertEqual(len(set(grp.values())), 1)

        # 开一场之后，GET 要把这一场带回来——页面刷新/关掉再打开靠它接上。
        started = self.post('/api/mock/start', {})
        run = self.get('/api/mock')['run']
        self.assertFalse(run['submitted'])
        self.assertEqual(run['ids'], started['ids'])
        self.assertEqual([p['name'] for p in run['parts']], ['公共基础知识', '教育专业能力测验'])
        self.assertEqual(run['endsAt'] - run['startedAt'], 120 * 60 * 1000)

    def test_交卷后GET带回成绩单(self):
        """已交卷的那场：GET 带回的成绩必须和 submit 当时一致，而且**不能**
        因为重算又把错次记一遍。"""
        d = self.post('/api/mock/start', {})
        qid = d['ids'][0]
        ans = _lookup(self.db, qid, 'answer')
        self.post('/api/mock/answer',
                  {'qid': qid, 'chosen': next(k for k in 'ABCD' if k != ans)})
        r = self.post('/api/mock/submit', {})

        run = self.get('/api/mock')['run']
        self.assertTrue(run['submitted'])
        self.assertEqual(run['result']['score'], r['score'])
        self.assertEqual(run['result']['right'], r['right'])
        self.assertEqual(set(run['result']['wrong']), set(r['wrong']))
        wc = {x['id']: x['wrong_count'] for x in self.get('/api/wrong')['questions']}
        self.assertEqual(wc[qid], 1, 'GET 重算成绩时又把错次记了一遍')


class TestMockShort(ApiCase):
    """题库某个模块不够题时的抽题失败路径。

    「题库不足: X 需要 N 只有 M」这句是原页面 mkPick() 的行为，搬过来必须还在，
    而且是 400（客户端写错了？不，是题库真的不够——但它不是 500）。
    """

    @classmethod
    def prepare_db(cls, db_path):
        # 把教基的题目改名换姓：教育学模块就空了。用 UPDATE 不动行数，
        # 免得撞上 attempts/wrong 的外键。
        conn = sqlite3.connect(db_path)
        try:
            conn.execute("UPDATE questions SET module='改走了 · 测试用' WHERE module='教育学'")
            conn.commit()
        finally:
            conn.close()

    def test_题库不足返回400而不是半个场次(self):
        code, payload = self.raw('/api/mock/start', method='POST', body={})
        self.assertEqual(code, 400, payload)
        err = json.loads(payload)['error']
        self.assertIn('题库不足: 教育学 需要 23 只有 0', err)
        # 抽题半路失败不该留下一场空卷子：GET 得说没有进行中的那场。
        self.assertIsNone(self.get('/api/mock')['run'])


class TestMockStaleBank(ApiCase):
    """这一场的题号里有一道题从题库里没了（重新导入题库时就会这样：
    id 换了一批，而 mock_runs 里那几场还留着）。

    两处不能出错，各自对应一条测试：

    · **交卷**：`mock_grade` 是按题号去题库里查的，查不到原来会抛 KeyError，
      而 Handler 外面没有兜底——客户端**一个字节都收不到**（RemoteDisconnected），
      模考页永远卡在「模考数据没取到」上。而且旧写法是**先把 submitted 落盘再判分**，
      所以第一次失败就把这一场钉成「已交卷」，之后每次重试都走短路回同一个错，
      只能手工改库。现在：查不到回 404，且判不出来就当没交过（重试才有意义）。
    · **GET /api/mock**：已交卷的那场要在 GET 里现算成绩，同一条查表路径，
      同样不能把连接掐了。
    """

    def _drop_question(self, qid):
        """把一道题从临时副本里摘掉，返回整行与列名（用来原样放回去）。

        只动 self.db（临时副本）——真源 bank.db 一根汗毛都不碰。
        """
        conn = sqlite3.connect(self.db)
        try:
            cols = [d[1] for d in conn.execute('PRAGMA table_info(questions)')]
            row = conn.execute('SELECT * FROM questions WHERE id=?', (qid,)).fetchone()
            self.assertIsNotNone(row, f'{qid} 不在临时库里，测试前提不成立')
            conn.execute('DELETE FROM questions WHERE id=?', (qid,))
            conn.commit()
        finally:
            conn.close()
        return cols, row

    def _put_question_back(self, cols, row):
        conn = sqlite3.connect(self.db)
        try:
            conn.execute(
                f'INSERT INTO questions ({",".join(cols)}) '
                f'VALUES ({",".join("?" for _ in cols)})', row)
            conn.commit()
        finally:
            conn.close()

    def _raw_or_fail(self, method, path, body=None):
        """打一次请求，把「连接被掐」也接住——那正是这两条测试要防的形态：
        回 4xx 可以，一个字节都不回不行（说明异常冒出了 Handler）。"""
        try:
            return self.raw(path, method, body)
        except (http.client.RemoteDisconnected, ConnectionResetError) as e:
            self.fail(f'{method} {path} 的连接被服务端掐了（{type(e).__name__}: {e}）——'
                      f'异常冒出了 Handler，客户端一个字节都没收到')

    def test_题号里的题不见了交卷要回4xx且留下可重试的那场(self):
        d = self.post('/api/mock/start', {})
        ids = d['ids']
        ans0 = _lookup(self.db, ids[0], 'answer')
        self.post('/api/mock/answer',
                  {'qid': ids[0], 'chosen': next(k for k in 'ABCD' if k != ans0)})
        self.post('/api/mock/answer', {'qid': ids[1], 'chosen': _lookup(self.db, ids[1], 'answer')})

        cols, row = self._drop_question(ids[1])       # 摘掉「答对了的那道」
        try:
            code, payload = self._raw_or_fail('POST', '/api/mock/submit', {})
            self.assertEqual(code, 404, payload)
            self.assertIn('不在题库里', json.loads(payload)['error'])
            # 判不出来就不许落盘：那一场还得是「进行中」，GET 也不该带成绩单。
            # 旧写法把 submitted 先 commit 了，这两条都会红。
            # 用 raw 而不是 get：真落到「已交卷落盘」那一步时，GET 自己也会 404，
            # get 会直接抛 HTTPError，把这条断言的说明吞掉。
            gcode, gpayload = self._raw_or_fail('GET', '/api/mock')
            self.assertEqual(
                gcode, 200,
                f'交卷没交上，那一场却已经不是「进行中」了（GET 回 {gcode}：'
                f'{gpayload.decode("utf-8", "replace")}）——第一次失败就把 submitted '
                f'落了盘，之后每次重试都走短路，再也交不上')
            run = json.loads(gpayload)['run']
            self.assertIsNotNone(run)
            self.assertFalse(run['submitted'], '交卷失败了却把 submitted 落了盘')
            self.assertNotIn('result', run)
        finally:
            self._put_question_back(cols, row)

        # 题库修好了，重试**真能交上**：判分与错题本都要对（这才是「可重试」的意思）。
        r = self.post('/api/mock/submit', {})
        self.assertEqual(r['total'], 120)
        self.assertEqual(r['right'], 1)
        self.assertEqual(r['wrong'], [ids[0]])
        self.assertIn(ids[0], [x['id'] for x in self.get('/api/wrong')['questions']])

    def test_已交卷那场的题不见了GET要回4xx(self):
        d = self.post('/api/mock/start', {})
        qid = d['ids'][0]
        self.post('/api/mock/answer', {'qid': qid, 'chosen': _lookup(self.db, qid, 'answer')})
        self.post('/api/mock/submit', {})

        cols, row = self._drop_question(qid)
        try:
            code, payload = self._raw_or_fail('GET', '/api/mock')
            self.assertEqual(code, 404, payload)
            self.assertIn('不在题库里', json.loads(payload)['error'])
        finally:
            self._put_question_back(cols, row)

        # 放回去以后照样能看成绩（GET 里那一步只读，不改库）
        run = self.get('/api/mock')['run']
        self.assertTrue(run['submitted'])
        self.assertEqual(run['result']['total'], 120)
        self.assertEqual(run['result']['right'], 1)


class TestMigrate(ApiCase):
    """POST /api/migrate/legacy：老页面 localStorage 里的记录并库。

    **本类必须继承 ApiCase、不许另写 setUpClass。** 这个端点真的往 attempts /
    wrong 里写行，正是 ApiCase 存在的理由（临时副本 + tearDownClass 的真源快照）。
    手抄一份 setUpClass 就是漏掉那行 shutil.copy2 / 快照比对的经典方式——
    那时写的是真源 bank.db，而且静默。

    每条测试自己先清空两张表（DELETE /api/attempts 一次清两表）。本类共用一台
    服务、一份临时库，不重置的话一条测试的导入会把下一条的计数带偏。
    """

    def setUp(self):
        self.del_('/api/attempts')

    def _pick(self, i):
        """题库里第 i 道题：返回 (qid, 正确答案, 一个错的选项 key)。

        正确答案走 _lookup 直读库（不拿被测 API 的输出当断言依据）；选项 key
        从 API 拿，只用来构造一份「必定答错」的输入。
        """
        q = self.get('/api/questions', limit=1, offset=i)['questions'][0]
        ans = _lookup(self.db, q['id'], 'answer')
        bad = next(o['key'] for o in q['options'] if o['key'] != ans)
        return q['id'], ans, bad

    def _row(self, sql, qid):
        """从临时副本里单查一行。断言一律拿真库当标尺，不看服务端回了什么。"""
        conn = sqlite3.connect(self.db)
        try:
            return conn.execute(sql, (qid,)).fetchone()
        finally:
            conn.close()

    def _exec(self, sql, args=()):
        """直接改临时副本。只为摆出「服务器上已经有一条旧记录」这种局面——
        走 API 摆不出「几年前的 at」「resolved 已经翻成 1」这些状态。"""
        conn = sqlite3.connect(self.db)
        try:
            conn.execute(sql, args)
            conn.commit()
        finally:
            conn.close()

    def _attempt(self, qid):
        return self._row('SELECT chosen, correct FROM attempts WHERE qid=?', qid)

    def _wrong(self, qid):
        """错题本里的行：(chosen, wrong_count, resolved)，没有就 None。"""
        return self._row('SELECT chosen, wrong_count, resolved FROM wrong WHERE qid=?', qid)

    # ---- 正常导入 ----
    def test_旧记录写进attempts与wrong(self):
        q1, a1, bad1 = self._pick(0)
        q2, a2, _bad2 = self._pick(1)
        d = self.post('/api/migrate/legacy',
                      {'answers': {q1: bad1, q2: a2}, 'wrong': {q1: 1}})
        self.assertEqual(d, {'imported': 2, 'skipped': 0, 'existing': 0})

        # 作答原样落库，correct 由服务端按现在的题库判
        self.assertEqual(self._attempt(q1), (bad1, 0))
        self.assertEqual(self._attempt(q2), (a2, 1))
        # 判错的进错题本，判对的不能进——「全都记成错」也能让上面那半条绿
        self.assertEqual(self._wrong(q1), (bad1, 1, 0))
        self.assertIsNone(self._wrong(q2))

    def test_导完已做数与统计对得上(self):
        """刷题页的「已做」就是 /api/stats 的 done，导入后必须和旧数据条数一致。"""
        n = 5
        answers, wrong = {}, {}
        for i in range(n):
            qid, ans, bad = self._pick(i)
            if i % 2:
                answers[qid], wrong[qid] = bad, 1
            else:
                answers[qid] = ans

        d = self.post('/api/migrate/legacy', {'answers': answers, 'wrong': wrong})
        self.assertEqual((d['imported'], d['skipped'], d['existing']), (n, 0, 0))
        st = self.get('/api/stats')
        self.assertEqual(st['done'], n)
        self.assertEqual(st['right'], n - len(wrong))
        self.assertEqual(self.get('/api/wrong')['total'], len(wrong))

    def test_只有wrong没有answers的题号也进错题本(self):
        """老数据两张表各存各的：只记了错、没记作答的题号不能丢。"""
        q, _ans, _bad = self._pick(0)
        d = self.post('/api/migrate/legacy', {'answers': {}, 'wrong': {q: 1}})
        self.assertEqual(d, {'imported': 1, 'skipped': 0, 'existing': 0})
        self.assertIsNone(self._attempt(q), '没作答就不该写 attempts 行')
        self.assertEqual(self._wrong(q), (None, 1, 0), '只记了错的那道没进错题本')

    # ---- 题库换代（C34）：跳过并计数，绝不整批失败 ----
    def test_题库里没有的题号跳过而不是整批失败(self):
        q1, _a1, bad1 = self._pick(0)
        q2, a2, _b2 = self._pick(1)
        d = self.post('/api/migrate/legacy', {
            'answers': {q1: bad1, 'zz-上一代题库-1': 'A', 'zz-上一代题库-2': 'B'},
            'wrong': {q2: 1, 'zz-上一代题库-1': 1}})
        # 死的题号在两张表里都出现过，去重后是 2 条——不是 3 条
        self.assertEqual(d, {'imported': 2, 'skipped': 2, 'existing': 0})
        # 好的一样进库：发现一个坏题号就整批放弃的写法在这里会红
        self.assertEqual(self._attempt(q1), (bad1, 0))
        self.assertEqual(self._wrong(q2), (None, 1, 0))

    def test_作答不是选项key的也跳过(self):
        """skipped 有**两种**原因：题号不在这一代题库里，和「记录本身不成样子」
        （值是数字、对象、null…）。界面把两种都写出来了（只写前者的话，记录写成
        {"e1":1} 的人会去查一个根本不存在的题库换代问题），服务端两种都得算进
        skipped，而不是把 1 当成选项 key 一路判下去。"""
        q1, _a1, _b1 = self._pick(0)
        q2, a2, _b2 = self._pick(1)
        d = self.post('/api/migrate/legacy',
                      {'answers': {q1: 1, q2: a2, 'zz-旧': 'A'}})
        self.assertEqual(d, {'imported': 1, 'skipped': 2, 'existing': 0})
        self.assertIsNone(self._attempt(q1), '不成样子的作答不该写进 attempts')
        self.assertEqual(self._attempt(q2), (a2, 1))

    def test_全是死题号也回200而不是500(self):
        """一个死题号都没有时最坏：外键错误（IntegrityError）会变成 500，
        客户端只看到「导入失败」，几百条记录一条都没进来。"""
        code, payload = self.raw('/api/migrate/legacy', method='POST', body={
            'answers': {'zz-旧-1': 'A'}, 'wrong': {'zz-旧-2': 1}})
        self.assertEqual(code, 200, payload)
        self.assertEqual(json.loads(payload), {'imported': 0, 'skipped': 2, 'existing': 0})
        self.assertEqual(self.count_in_db('SELECT COUNT(*) FROM attempts'), 0)
        self.assertEqual(self.count_in_db('SELECT COUNT(*) FROM wrong'), 0)

    # ---- 错次（C35）----
    def test_导入的错次一律是1(self):
        """老数据里没有错次这个概念（老代码写死 w[qid]=1），给多少都是 1。"""
        q1, _a1, bad1 = self._pick(0)
        q2, _a2, _b2 = self._pick(1)
        d = self.post('/api/migrate/legacy',
                      {'answers': {q1: bad1}, 'wrong': {q1: 7, q2: 3}})
        self.assertEqual(d['imported'], 2)
        self.assertEqual(self._wrong(q1), (bad1, 1, 0))   # 传的是 7
        self.assertEqual(self._wrong(q2), (None, 1, 0))   # 传的是 3

    def test_重导一遍不把错次累加(self):
        """重导是常态（用户点重试、或在别的标签页又点了一次），不能多出行、
        也不能把错次累加。第二次的那条记录必须报「服务器上已经有了」。"""
        q, _ans, bad = self._pick(0)
        body = {'answers': {q: bad}, 'wrong': {q: 1}}
        self.assertEqual(self.post('/api/migrate/legacy', body),
                         {'imported': 1, 'skipped': 0, 'existing': 0})
        self.assertEqual(self.post('/api/migrate/legacy', body),
                         {'imported': 0, 'skipped': 0, 'existing': 1},
                         '重导一遍该报「已经有了」，而不是又导一次')
        self.assertEqual(self._wrong(q), (bad, 1, 0), '重导一次把错次记成了 2')
        self.assertEqual(self.count_in_db('SELECT COUNT(*) FROM attempts'), 1)

    # ---- 只补不盖（评审 finding 1）----
    def test_服务器已有的作答不被旧记录改写(self):
        """旧记录可能比服务器上的**更旧**。拿它去 DO UPDATE 会把「答对了」翻成
        「答错了」、把正确率拉下来、还平白多出一条错题——一份缓存不该有这种权力。"""
        q, ans, bad = self._pick(0)
        self.post('/api/attempts', {'qid': q, 'chosen': ans})     # 服务器上先答对
        self.assertEqual(self.get('/api/stats')['right'], 1)

        self.assertEqual(self.post('/api/migrate/legacy', {'answers': {q: bad}}),
                         {'imported': 0, 'skipped': 0, 'existing': 1})

        st = self.get('/api/stats')
        self.assertEqual((st['done'], st['right']), (1, 1), '旧记录把答对改成了答错')
        self.assertEqual(self._attempt(q), (ans, 1), 'attempts 行被旧记录盖掉了')
        self.assertIsNone(self._wrong(q), '服务器说答对，旧记录却塞了一条错题进来')
        self.assertEqual(self.get('/api/wrong')['total'], 0)

    def test_已有的作答at不被导入时间改写(self):
        """旧 localStorage 里根本没有时间戳，导入写的只能是导入那一刻。服务器上
        已有的行必须留着自己的 at，否则老记录会排到最新（评审原话：migrated
        attempts currently sort as newly made）。"""
        q, ans, _bad = self._pick(0)
        old = '2019-05-05T00:00:00+08:00'
        self._exec('INSERT INTO attempts (qid,chosen,correct,at) VALUES (?,?,1,?)',
                   (q, ans, old))
        self.assertEqual(self.post('/api/migrate/legacy', {'answers': {q: ans}}),
                         {'imported': 0, 'skipped': 0, 'existing': 1})
        self.assertEqual(self._row('SELECT at FROM attempts WHERE qid=?', q), (old,),
                         '已有的作答时间被导入那一刻盖掉了')

    def test_服务器答对的题不许旧记录再补一条错题(self):
        """「服务器已经知道这道题 → 整道跳过」在 wrong-only 那条路径上也得成立。
        老数据是 wrong ⊆ answers，可这个端点**明确支持**超集形状（[wrong] 单给），
        而只看错题本的写法会漏掉「服务器上答对了」这种：它没有错题行，于是旧记录
        给它补出一条——错题本里冒出一道用户其实已经做对的题。"""
        q, ans, _bad = self._pick(0)
        self.post('/api/attempts', {'qid': q, 'chosen': ans})     # 服务器上答对
        self.assertEqual(self.get('/api/wrong')['total'], 0)

        d = self.post('/api/migrate/legacy', {'wrong': {q: 1}})
        self.assertEqual(d, {'imported': 0, 'skipped': 0, 'existing': 1})
        self.assertIsNone(self._wrong(q), '服务器说答对，旧记录却给它补了一条错题')
        self.assertEqual(self.get('/api/wrong')['total'], 0)
        self.assertEqual(self._attempt(q), (ans, 1), '已有的作答行也被动了')

    def test_已有错题行没有作答行的按导入算(self):
        """三个数互斥，判据是「这次导入为它写了至少一行吗」。服务器上只有错题行
        （迁移自己造得出来这种）、没有作答行时，导入补上了作答行——确实写进去了
        东西，所以算 imported，不算 existing。"""
        q, _ans, bad = self._pick(0)
        self._exec('INSERT INTO wrong (qid,chosen,wrong_count,first_at,last_at,resolved) '
                   'VALUES (?,?,1,?,?,0)', (q, bad, '2019-05-05T00:00:00+08:00',
                                           '2019-05-05T00:00:00+08:00'))
        d = self.post('/api/migrate/legacy', {'answers': {q: bad}})
        self.assertEqual(d, {'imported': 1, 'skipped': 0, 'existing': 0})
        self.assertEqual(self._attempt(q), (bad, 0), '作答行没写进去')
        self.assertEqual(self._wrong(q), (bad, 1, 0), '已有的错题行被改了')

    def test_已有的错题行不被旧记录改写(self):
        """错题本已有的行连 last_at 都不动：resolved=1 是「已经重做对了」，
        旧记录没有理由把它翻回「还没掌握」，错次也不能被压成 1。"""
        q1, _a1, bad1 = self._pick(0)
        q2, _a2, _bad2 = self._pick(1)
        old = '2019-05-05T00:00:00+08:00'
        self._exec('INSERT INTO wrong (qid,chosen,wrong_count,first_at,last_at,resolved) '
                   'VALUES (?,?,3,?,?,1)', (q1, bad1, old, old))

        d = self.post('/api/migrate/legacy', {'wrong': {q1: 1, q2: 1}})
        self.assertEqual(d, {'imported': 1, 'skipped': 0, 'existing': 1})
        self.assertEqual(self._wrong(q1), (bad1, 3, 1), '已有的错题行被旧记录改了')
        self.assertEqual(self._row('SELECT last_at FROM wrong WHERE qid=?', q1), (old,),
                         '已有的 last_at 被导入那一刻盖掉了')
        self.assertEqual(self._wrong(q2), (None, 1, 0), '新的那条没进错题本')

    # ---- 坏请求 ----
    def test_坏请求返回400(self):
        for body in ({'answers': '不是对象'}, {'wrong': [1, 2]}, [1, 2], '不是对象'):
            code, payload = self.raw('/api/migrate/legacy', method='POST', body=body)
            self.assertEqual(code, 400, f'{body!r} → {code} {payload!r}')
        # 两个键都缺 = 没什么可导的，不是写错了：照 200 回 0/0/0。
        self.assertEqual(self.post('/api/migrate/legacy', {}),
                         {'imported': 0, 'skipped': 0, 'existing': 0})


if __name__ == '__main__':
    unittest.main()
