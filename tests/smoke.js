/* 刷题 + 模考冒烟测试：用 DOM 桩真实跑一遍页面脚本。
   验证：脚本不抛错 → 首屏只渲染 40 题 → 点选项能作答 → 答错进错题本 →
        点「再显示」逐页追加 → 筛选「只看错题」只出错的题 → 模考抽题/判分/解析。

   两套装配，各自 eval 自己那份脚本集，互不共用作用域，**各自一个 fetch 桩**：
     · bootQuiz()  web/quiz.html + assets/{nav,bank,quiz}.js
     · bootMock()  web/mock.html + assets/{nav,bank,mock}.js
   两个引擎都靠 fetch 桩顶替服务端（判分、抽题、交卷都在 server.py 那边，
   桩只是照着同一份契约答话）。**桩必须是各自的实例**：共用一个的话，
   一边记的请求会把另一边的断言带偏。 */

/* 别在文件顶部加 'use strict'：这里靠**直接 eval** 把拆出来的 js 里的
   var / function 声明带进 bootQuiz / bootMock 的作用域（见 web/assets/quiz.js 的文件头）。
   严格模式下直接 eval 有自己的变量环境，那些声明一个都拿不到，
   `await quizReady` / `await mockReady` 会直接 ReferenceError。 */

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');
const WEB = path.join(BASE, 'web');
const QUIZ_HTML = fs.readFileSync(path.join(WEB, 'quiz.html'), 'utf8');
const MOCK_HTML = fs.readFileSync(path.join(WEB, 'mock.html'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

/* ---------- 题库：测试自己那份 ----------
   引擎怎么取数由 fetch 桩决定（见 installFetchStub），这里这份只给断言用：
   题量、模块顺序、某题的答案。它与 bank.db 的一致性由 tests/test_roundtrip.py
   保证，所以冒烟测试不必连库，也就不依赖 Python 环境。
   名字保持 BANK（形状仍是 {total, questions}）——四十来处断言按 BANK.questions 写的。 */
const BANK = JSON.parse(fs.readFileSync(path.join(BASE, '题库.json'), 'utf8'));
const bankById = {};
BANK.questions.forEach(q => { bankById[q.id] = q; });

/* ---------- 模考的配比依据：测试自己的一份 ----------
   server.py 里的 MK_PARTS 只有一份，而且**刻意只有一份**：客户端不再存第二份，
   页面渲染的配比表、成绩单分组全来自 GET /api/mock。这里是**测试独立抄的一份**：
     ① 桩扮演服务端时按它造一场卷子（抽题是服务端的事，桩只是照着契约答话）；
     ② 断言页面把服务端那份配比照原样渲染出来。
   服务端的 MK_PARTS 改了，这份必须跟着改——不跟着改的话这几条断言会红，
   红得对：两边对不上了。
   抽题算法本身（模块配额、两部分不交错）由 tests/test_server.py 的 TestMock
   直接打真服务验，这里不重复测桩。 */
const MK_LOCAL = '地方特色 · 从公基匀出 · 不在大纲内';
const PARTS = [
  ['公共基础知识', [['公共基础 · 政治与时政', 16], ['公共基础 · 法律', 13],
    ['公共基础 · 经济、管理与常识', 11], ['公共基础 · 公文写作', 8],
    ['人文历史与科技常识', 6],
    ['唐山工业职业技术大学校情', 3, MK_LOCAL], ['唐山本地政策与时政', 3, MK_LOCAL]]],
  ['教育专业能力测验', [['教育学', 23], ['教育心理学', 17], ['教育法律法规', 7],
    ['教师职业理念与职业道德', 6], ['职业教育与高等教育', 7]]],
];
const PLAN = PARTS.flatMap(P => P[1]);

/* server.py 的 MK_TYPE_SPLIT：练兵版每 6 道配额出 1 道判断、1 道多选，余下单选。 */
const TYPE_SPLIT = [['judge', 6], ['multi', 6]];
function typeQuota(n) {
  const out = {};
  for (const [typ, per] of TYPE_SPLIT) out[typ] = Math.floor(n / per);
  out.single = n - out.judge - out.multi;
  return out;
}
/* 服务端 GET /api/mock 会回的那份配比表（形状 = server.py 的 mock_plan()）。
   withTypes 那份多三个题型题量——页面渲染练兵版配比表用的就是它，页面不自己算。 */
function planPayload(ratio, withTypes) {
  return ratio.map(([name, mods]) => ({
    name,
    n: mods.reduce((s, m) => s + m[1], 0),
    modules: mods.map(m => {
      const row = m[2] ? { module: m[0], n: m[1], group: m[2] } : { module: m[0], n: m[1] };
      if (withTypes) Object.assign(row, typeQuota(m[1]));
      return row;
    }),
  }));
}
/* 桩扮演服务端抽题（= server.py 的 mock_pick：模块内打乱 → 配额 → 部分内打乱 →
   按部分接起来）。 */
function pickRun(ratio) {
  const ids = [], parts = [];
  for (const [name, mods] of ratio) {
    const out = [];
    for (const [mod, quota] of mods) {
      const have = BANK.questions.filter(q => q.module === mod).map(q => q.id);
      for (let i = have.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1)); [have[i], have[j]] = [have[j], have[i]];
      }
      if (have.length < quota) throw new Error(`题库不足: ${mod} 需要 ${quota} 只有 ${have.length}`);
      out.push(...have.slice(0, quota));
    }
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]];
    }
    parts.push({ name, n: out.length });
    ids.push(...out);
  }
  return { ids, parts };
}
/* 桩扮演服务端判分（= server.py 的 mock_grade）。规则同 banklib.grade：
   去重、排序、转大写、比集合（多选少选算错）。 */
function gradeRun(run) {
  const per = {}, wrong = []; let right = 0;
  for (const id of run.ids) {
    const q = bankById[id];
    const r = per[q.module] = per[q.module] || { module: q.module, n: 0, right: 0 };
    r.n++;
    const a = run.answers[id];
    if (!a) continue;
    if (norm(a) === norm(q.answer)) { right++; r.right++; } else wrong.push(id);
  }
  const total = run.ids.length;
  return { score: Math.round(right / total * 1000) / 10, right, total,
           unanswered: total - Object.values(run.answers).filter(Boolean).length,
           wrong, used: 0, submittedAt: run.submittedAt || Date.now(),
           by_module: Object.values(per) };
}
/* 换一份配比：GET 回的配比表与抽题用的配比必须一起换（真实服务端里本来就是
   同一份数据，分开设就是造一个现实中不存在的状态）。 */
function useMockPlan(stub, ratio, seconds) {
  stub.mock.ratio = ratio;
  stub.mock.plan = { n: ratio.reduce((s, P) => s + P[1].reduce((t, m) => t + m[1], 0), 0),
                     seconds: seconds || 7200, parts: planPayload(ratio),
                     partsWithTypes: planPayload(ratio, true) };
}

/* 装配之间共享这一份 localStorage，每次装配开头清空重灌。 */
const store0 = {};

/* ---------- 极简 DOM 桩 ---------- */
function makeStub(html, nav, opts) {
  opts = opts || {};
  /* 上一段留下的记录不该漏进下一段（刷题的作答会改错题本，模考的判分也读它）。 */
  Object.keys(store0).forEach(k => delete store0[k]);
  Object.assign(store0, opts.seedStore || {});

  let listeners = [];
  const docListeners = [];
  function mkEl(tag, attrs = {}) {
    const el = {
      tagName: tag, children: [], _html: '', hidden: false, textContent: '', disabled: false,
      checked: false, style: {},
      _attrs: attrs, _cls: new Set((attrs.class || '').split(' ').filter(Boolean)),
      classList: {
        contains: c => el._cls.has(c),
        toggle: (c, on) => { on ? el._cls.add(c) : el._cls.delete(c); },
      },
      getAttribute: k => (k in el._attrs ? el._attrs[k] : null),
      setAttribute: (k, v) => { el._attrs[k] = v; },
      insertAdjacentHTML: (where, h) => { el._html += h; },
      appendChild: c => { el.children.push(c); return c; },
      addEventListener: (t, fn) => listeners.push({ el, t, fn }),
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      scrollTo: () => {},
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: v => { el._html = v; },
    });
    return el;
  }
  /* 真实 HTML 里带 hidden 属性的元素，桩里也要从 hidden=true 起——否则
     像「答题卡默认收起、点一下展开」这种断言会因为初始状态不对而假失败。 */
  const hiddenIds = new Set();
  for (const m of html.matchAll(/<[a-z][^>]*\bid="([\w-]+)"[^>]*>/g)) {
    if (/\bhidden\b/.test(m[0])) hiddenIds.add(m[1]);
  }

  const store = store0;
  const byId = {};
  /* 页面里静态存在的 id。拆出来的页面没有内嵌题库块，引擎要的元素全在 HTML 里，
     所以直接照着页面建，不在这里另抄一份 id 清单（页面改了，这里跟着走）。 */
  if (opts.idsFromHtml) {
    for (const m of html.matchAll(/<[a-z][^>]*\bid="([\w-]+)"[^>]*>/g)) byId[m[1]] = mkEl('div');
  }
  nav.forEach(n => { byId[n.id] = mkEl('section', { class: 'view' }); });
  (opts.extraIds || []).forEach(id => { byId[id] = mkEl('div'); });
  /* 单体文件里的题库块是 <script type="application/json" id="qbank">，引擎
     JSON.parse 它的 textContent。拆页后没有这块了（引擎改从服务端取数）。 */
  if (opts.qbankJson != null) { byId['qbank'] = mkEl('script'); byId['qbank'].textContent = opts.qbankJson; }
  /* hidden 是 DOM 属性不是属性节点，桩里得直接置位。 */
  (opts.hiddenIds || []).forEach(id => { if (byId[id]) byId[id].hidden = hiddenIds.has(id); });

  const fbtns = ['all', 'todo', 'wrong'].map(f => mkEl('button', { 'data-filter': f, class: f === 'all' ? 'fbtn active' : 'fbtn' }));

  global.document = {
    readyState: opts.readyState,
    getElementById: id => byId[id] || null,
    createElement: t => mkEl(t),
    addEventListener: (t, fn) => docListeners.push({ t, fn }),
    querySelectorAll: sel => {
      if (sel === '.nav-list a') return nav.map(n => mkEl('a', { href: '#' + n.id }));
      if (sel === '.fbtn') return fbtns;
      if (sel.includes('checkbox')) return [];
      return [];
    },
  };
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  /* window 就是 global：浏览器里 window.api 与裸 api 是同一个东西——bank.js 写的是
     window.api，而 quiz.js 读的是 api.get(...)——桩里必须也成立，否则引擎一取数就
     ReferenceError。顺带把源文件用到的 window.addEventListener / window.scrollTo
     补成空实现（拆页后视图切换不再跑，但单体那段还要）。 */
  global.window = global;
  global.addEventListener = () => {};
  global.scrollTo = () => {};
  global.location = { hash: '' };

  /* nav link 需要 textContent 才能生成上一类/下一类 */
  const origQSA = global.document.querySelectorAll;
  global.document.querySelectorAll = sel => {
    const r = origQSA(sel);
    if (sel === '.nav-list a') r.forEach((el, i) => { el.textContent = nav[i].label; });
    return r;
  };

  return { byId, store, listeners, docListeners, fbtns, mkEl };
}

/* ---------- fetch 桩：顶替 server.py 的端点 ----------
   冒烟测试测的是引擎逻辑，不是 HTTP——HTTP 由 tests/test_server.py 覆盖。
   只桩引擎真正用到的那几条路由（刷题的两条 + 模考的四条）：多桩一条就多一处
   会和真实服务脱节的地方。
   判分刻意走一遍和 banklib.grade 相同的规则（去重、排序、转大写、比集合），
   好让「多选题少选算错」这类规则在客户端也成立；模考的抽题与判分同理，
   照着 server.py 的 mock_pick / mock_grade 的样子答话。

   桩会把**每一次请求**记进 `calls`，并留几个 override 口子（见下）。
   这些都不是为了「更真实」，是为了让「判分/抽题/交卷确实发生在服务端」有断言可依：
   没有它们，把引擎改回本地按答案比、本地抽题，整套断言一条都不会红
   （任务 9 的 M4 突变，以及任务 10 的 C80）。 */
const norm = s => [...new Set((s || '').trim().toUpperCase())].sort().join('');

function installFetchStub(opts) {
  opts = opts || {};
  const wrongCount = new Map();   // qid → 累计错次（banklib.record_attempt 的语义）
  const tried = new Set();        // qid → 已经有过作答行（迁移「只补不盖」的依据）
  /* 错题本那三列（服务端是 wrong 表）：GET /api/wrong 与 POST /api/wrong/<qid>/resolve
     都读它。语义照 banklib.record_attempt：做对了 resolved=1（行还在，只是不再算
     「还没掌握」），又错了 wrong_count+1 且 resolved 翻回 0。 */
  const wrongRows = new Map();    // qid → {chosen, wrong_count, resolved}
  const calls = [];               // 每一次请求：{path, method, body}
  const okJSON = obj => ({ ok: true, status: 200, statusText: 'OK', json: async () => obj });
  const errJSON = (status, error) => ({ ok: false, status, statusText: 'error', json: async () => ({ error }) });

  /* override：让某一道题的 POST 直接回指定的响应体，不按本地规则算。
     用来断言「页面渲染的是响应体」——本地算法会判对的题，桩偏说错，
     页面若跟着判错，结论就只可能来自响应。用完置回 null。 */
  const stub = { calls, wrongCount, wrongRows, override: null,
                 /* 模考：配比表（GET 回的）、抽题用的配比、当前那一场、交卷的替身响应 */
                 mock: { plan: null, ratio: null, run: null, submitOverride: null },
                 /* 旧记录迁移：migrate 直接顶替响应体，migrateFail 让这一次失败 */
                 migrate: null, migrateFail: null };
  useMockPlan(stub, opts.ratio || PARTS);
  if (opts.run) stub.mock.run = opts.run;
  /* 错题本的开局：先摆上几行（刷题页的错题由此而来）。同时喂 wrongCount——
     迁移那段的「服务器上已经有这一题」看的是它，两份状态不能对不上。 */
  (opts.wrong || []).forEach(w => {
    wrongRows.set(w.qid, { chosen: w.chosen, wrong_count: w.wrong_count || 1,
                           resolved: !!w.resolved });
    wrongCount.set(w.qid, w.wrong_count || 1);
  });

  global.fetch = async function (url, opts2) {
    const u = new URL(url, 'http://stub');
    const q = u.searchParams;
    const method = (opts2 && opts2.method) || 'GET';
    calls.push({ path: u.pathname, method,
                 body: opts2 && opts2.body ? JSON.parse(opts2.body) : null });
    if (u.pathname === '/api/questions') {
      const mod = q.get('module'), sec = q.get('section'), typ = q.get('type');
      const list = BANK.questions.filter(x =>
        (!mod || x.module === mod) && (!sec || x.section === sec) && (!typ || x.type === typ));
      const off = +(q.get('offset') || 0);
      const lim = q.get('limit') === null ? 40 : +q.get('limit');   // server.py 的默认值就是 40
      return okJSON({ total: list.length, questions: list.slice(off, off + lim) });
    }
    if (u.pathname === '/api/attempts' && method === 'POST') {
      const b = JSON.parse(opts2.body);
      const item = BANK.questions.find(x => x.id === b.qid);
      // 库里没这道题：服务端是 404 + {'error':…}。桩里照同一个形状回，
      // 引擎才不会把「题不在库里」当成「记上了」。
      if (!item) return errJSON(404, '题库里没有这道题：' + b.qid);
      tried.add(b.qid);   // 这一题服务器上从此有作答行了，迁移那边要看得见
      if (stub.override && stub.override.qid === b.qid) {
        const o = stub.override;
        return okJSON({ correct: o.correct, answer: o.answer,
                        explanation: o.explanation, wrong_count: o.wrong_count });
      }
      const correct = norm(b.chosen) === norm(item.answer);
      if (correct) {
        /* 做对了：错题本那行留着，只翻 resolved（与 banklib.record_attempt 同） */
        const w = wrongRows.get(b.qid);
        if (w) w.resolved = true;
      } else {
        wrongCount.set(b.qid, (wrongCount.get(b.qid) || 0) + 1);
        const w = wrongRows.get(b.qid);
        if (w) { w.chosen = b.chosen; w.wrong_count += 1; w.resolved = false; }
        else wrongRows.set(b.qid, { chosen: b.chosen, wrong_count: 1, resolved: false });
      }
      return okJSON({ correct, answer: item.answer, explanation: item.explanation,
                      wrong_count: wrongCount.get(b.qid) || 0 });
    }

    /* ---- 错题本页（任务 15）：GET /api/wrong 与 POST /api/wrong/<qid>/resolve ----
       形状照 server.py：GET 回 {total, questions:[…题目字段 + chosen + wrong_count]}，
       JOIN 的是 questions（题不在库里就整行不出）。resolve 只认
       /api/wrong/<qid>/resolve 这一种形状，其余 404——和 server.py 那条路径解析
       一一对应，桩和真实服务不会在这里分家。 */
    if (u.pathname === '/api/wrong' && method === 'GET') {
      const out = [];
      for (const [qid, w] of wrongRows) {
        if (w.resolved) continue;                  // WHERE w.resolved=0
        const q = BANK.questions.find(x => x.id === qid);
        if (!q) continue;                          // JOIN 不上就不出
        out.push({ id: q.id, n: q.n, module: q.module, type: q.type, stem: q.stem,
                   options: q.options, answer: q.answer, explanation: q.explanation,
                   chosen: w.chosen, wrong_count: w.wrong_count });
      }
      return okJSON({ total: out.length, questions: out });
    }
    if (u.pathname.startsWith('/api/wrong/') && method === 'POST') {
      const segs = u.pathname.slice('/api/wrong/'.length).split('/');
      if (segs.length !== 2 || segs[1] !== 'resolve' || !segs[0]) {
        return errJSON(404, 'not found');
      }
      const qid = decodeURIComponent(segs[0]);
      if (!BANK.questions.some(x => x.id === qid)) {
        return errJSON(404, '题库里没有这道题：' + qid);
      }
      const w = wrongRows.get(qid);
      if (w) w.resolved = true;
      return okJSON({ ok: true, qid, resolved: !!w });
    }

    /* ---- 模考：四个端点照 server.py 的契约答话 ---- */
    if (u.pathname === '/api/mock') {
      const run = stub.mock.run;
      return okJSON({ n: stub.mock.plan.n, seconds: stub.mock.plan.seconds,
                      parts: stub.mock.plan.parts,
                      partsWithTypes: stub.mock.plan.partsWithTypes,
                      // 已交卷的那场：成绩一并带上（服务端是 GET 时现算的）
                      run: run ? (run.submitted
                        ? Object.assign({}, run, { result: gradeRun(run) }) : run) : null });
    }
    if (u.pathname === '/api/mock/start' && method === 'POST') {
      const pick = pickRun(stub.mock.ratio);
      const now = Date.now();
      let withTypes = false;
      try { withTypes = JSON.parse(opts2.body).withTypes === true; } catch (e) { withTypes = false; }
      stub.mock.run = { ids: pick.ids, parts: pick.parts, answers: {}, i: 0,
                        withTypes: withTypes,
                        startedAt: now, endsAt: now + stub.mock.plan.seconds * 1000,
                        submitted: false, submittedAt: 0 };
      return okJSON(Object.assign({}, stub.mock.run));
    }
    if (u.pathname === '/api/mock/answer' && method === 'POST') {
      const b = JSON.parse(opts2.body);
      const run = stub.mock.run;
      if (!run || run.submitted) return errJSON(404, '没有进行中的模考');
      if (b.qid) {
        if (!run.ids.includes(b.qid)) return errJSON(404, '这场模考里没有这道题：' + b.qid);
        run.answers[b.qid] = b.chosen;
      }
      if (b.i !== undefined && b.i !== null) run.i = b.i;
      return okJSON({ ok: true, answered: Object.values(run.answers).filter(Boolean).length });
    }
    if (u.pathname === '/api/mock/submit' && method === 'POST') {
      const run = stub.mock.run;
      if (!run) return errJSON(404, '没有进行中的模考');
      if (stub.mock.submitOverride) return okJSON(stub.mock.submitOverride);
      run.submitted = true;
      const res = gradeRun(run);
      run.submittedAt = res.submittedAt;
      return okJSON(res);
    }

    /* ---- 旧记录迁移：照 server.py / banklib.import_legacy 的语义答话 ----
       题库里查不到的题号跳过并计数（老数据可能来自上一代题库），其余按
       「一条记录一行」算导入。migrate / migrateFail 是 override 口子：让页面
       渲染一个和本机数出来的不一样的响应体（见下面「渲染的是响应体」那条）。 */
    if (u.pathname === '/api/migrate/legacy' && method === 'POST') {
      if (stub.migrateFail) return errJSON(400, stub.migrateFail);
      if (stub.migrate) return okJSON(stub.migrate);
      const b = JSON.parse(opts2.body);
      const known = new Set(BANK.questions.map(q => q.id));
      const skipped = new Set(), existing = new Set();
      let imported = 0;
      for (const qid of Object.keys(b.answers || {})) {
        if (!known.has(qid)) { skipped.add(qid); continue; }
        if (tried.has(qid)) { existing.add(qid); continue; }   // 服务器已有：只补不盖
        tried.add(qid);
        imported++;
      }
      for (const qid of Object.keys(b.wrong || {})) {
        if (!known.has(qid)) { skipped.add(qid); continue; }
        if (qid in (b.answers || {})) continue;   // answers 那一步已经处理过
        /* 「服务器已经知道这道题 → 整道跳过」在 wrong-only 这条路径上也成立：
           attempts 里有它（比如服务器上答对了）就不许再补一条错题。 */
        if (tried.has(qid)) { existing.add(qid); continue; }
        if (wrongCount.has(qid)) { existing.add(qid); continue; }
        wrongCount.set(qid, 1);
        imported++;
      }
      return okJSON({ imported, skipped: skipped.size, existing: existing.size });
    }
    return errJSON(404, 'not found');
  };
  return stub;   /* calls / override 交给 bootQuiz / bootMock 转出去，给断言用 */
}

/* ---------- 装配一：拆页后的刷题页 ---------- */
function readAsset(rel) {
  const f = path.join(WEB, rel);
  try { return fs.readFileSync(f, 'utf8'); }
  catch (e) { console.error(`读不到 ${f}——先跑 python3 tools/split_pages.py`); process.exit(1); }
}

/* 页面自己声明的脚本集从 quiz.html 读出来，不在这里另抄一份：页面加了脚本而
   这里没加，会是一次响亮的失败，而不是静默只跑一半。
   （简报的 SCRIPTS 里还列了 assets/nav-data.js——那个文件不存在，
     tests/test_split.py 也明令不许再引它。） */
const WANT_SCRIPTS = ['assets/nav.js', 'assets/bank.js', 'assets/quiz.js'];
const PAGE_SCRIPTS = [...QUIZ_HTML.split('</main>')[1].matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(m => m[1]);
if (PAGE_SCRIPTS.join('|') !== WANT_SCRIPTS.join('|')) {
  console.error(`quiz.html 的脚本集变了：${PAGE_SCRIPTS.join(' / ')}`
    + `（引擎需要 ${WANT_SCRIPTS.join(' / ')}——bank.js 提供 api，必须在 quiz.js 之前）`);
  process.exit(1);
}

async function bootQuiz(opts) {
  opts = opts || {};
  const nav = [];
  /* readyState='loading'：nav.js 因此只把 window.NAV 放出来、不往 DOM 里挂导航。
     本页引擎压根不查导航（导航本身由 node tests/check_dom.js 验），这里要的只是
     那份导航表——建 section 与 .nav-list a 都用它，不再从 HTML 里正则抓 <a href="#x">。
     seedStore 用来模拟「页面重开」：本机 localStorage 里带着上次的作答记录再装配一次
     （见「多选题 · 重开页面」那段）。 */
  const S = makeStub(QUIZ_HTML, nav, { idsFromHtml: true, readyState: 'loading',
                                       hiddenIds: ['qempty'],
                                       seedStore: opts.seedStore || null });
  S.fetch = installFetchStub();   /* 断言要看请求记录与 override 口子 */

  /* 按页面里的实际顺序 eval。索引 0 是 nav.js，要单独接一下它的产物。 */
  eval(readAsset(PAGE_SCRIPTS[0]));
  window.NAV.forEach(n => { S.byId[n.id] = S.mkEl('section', { class: 'view' }); });
  nav.push(...window.NAV.map(n => ({ id: n.id, label: n.label })));
  for (const rel of PAGE_SCRIPTS.slice(1)) eval(readAsset(rel));

  /* 引擎首次取数是异步的，等它渲完再断言——不是赌时序。 */
  await quizReady;
  /* 引擎的两个内部量挂到表面上（和 fetch 一个路子）：BANK 是 loadBank 赋值的 var、
     shuffledOpts 是函数声明，两者都活在 bootQuiz 的作用域里，不在 DOM 上。
     必须**等取数回来再挂**——早一步 BANK 还是 null。 */
  S.bank = BANK;
  S.shuffledOpts = shuffledOpts;
  return S;
}

/* ---------- 装配二：拆页后的模考页 ----------
   与 bootQuiz 同一套路：读页面自己的脚本集、按页面顺序 eval、等引擎取数回来。
   **这里必须自己装一个 fetch 桩**（不能借刷题那一段的）：两段各自一个桩实例，
   请求记录才不会互相串。刷题段的桩是它自己的，模考段的也是。 */
const MOCK_WANT_SCRIPTS = ['assets/nav.js', 'assets/bank.js', 'assets/mock.js'];
const MOCK_PAGE_SCRIPTS = [...MOCK_HTML.split('</main>')[1].matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(m => m[1]);
if (MOCK_PAGE_SCRIPTS.join('|') !== MOCK_WANT_SCRIPTS.join('|')) {
  console.error(`mock.html 的脚本集变了：${MOCK_PAGE_SCRIPTS.join(' / ')}`
    + `（引擎需要 ${MOCK_WANT_SCRIPTS.join(' / ')}——bank.js 提供 api，必须在 mock.js 之前）`);
  process.exit(1);
}

async function bootMock(opts) {
  opts = opts || {};
  const nav = [];
  const S = makeStub(MOCK_HTML, nav, {
    idsFromHtml: true, readyState: 'loading',
    /* mkRev / mkReview / mkAgain / mkMore 是 innerHTML 里建出来的，页面静态部分
       没有它们，但真实 DOM 里那时已经存在（mk$ 找得到）。 */
    extraIds: ['mkRev', 'mkReview', 'mkAgain', 'mkMore'],
    seedStore: opts.seedStore || null,
    hiddenIds: ['mkSetup', 'mkExam', 'mkResult', 'mkCardPanel', 'mkResume'],
  });
  /* 模考段自己的桩：ratio 换成别的就造一份别的卷子（见「配比照服务端那份渲染」那段），
     run 喂一场指定的卷子（接着答 / 过期那两段）。 */
  S.fetch = installFetchStub({ ratio: opts.ratio, run: opts.run });

  eval(readAsset(MOCK_PAGE_SCRIPTS[0]));
  window.NAV.forEach(n => { S.byId[n.id] = S.mkEl('section', { class: 'view' }); });
  nav.push(...window.NAV.map(n => ({ id: n.id, label: n.label })));
  for (const rel of MOCK_PAGE_SCRIPTS.slice(1)) eval(readAsset(rel));

  /* 取数、以及「关着页面时过期」那条自动交卷都在里面，等它走完再断言。 */
  await mockReady;
  /* 引擎的内部量挂到表面上（与 bootQuiz 一个路子）：shuffledOpts 是 mock.js 里的
     函数声明，活在 bootMock 的作用域里，不在 DOM 上。练兵版那段的合成多选要靠它
     算出「显示顺序」，才能断言答案行的字母确实按乱序换过。 */
  S.shuffledOpts = shuffledOpts;
  return S;
}

/* ---------- 装配三：首页（入口卡片 + 导入旧版记录） ----------
   与上面两段同一套路：读页面自己的脚本集、按页面顺序 eval。
   首页和刷题/模考页一样引 bank.js——home.js 的导入按钮走 window.api，
   项目里写操作只有那一份 fetch 封装。 */
const HOME_WANT_SCRIPTS = ['assets/nav.js', 'assets/bank.js', 'assets/home.js'];
const HOME_PAGE_SCRIPTS = [...INDEX_HTML.split('</main>')[1]
  .matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
if (HOME_PAGE_SCRIPTS.join('|') !== HOME_WANT_SCRIPTS.join('|')) {
  console.error(`index.html 的脚本集变了：${HOME_PAGE_SCRIPTS.join(' / ')}`
    + `（首页需要 ${HOME_WANT_SCRIPTS.join(' / ')}——nav.js 提供 NAV，`
    + 'bank.js 提供 window.api，都必须在 home.js 之前）');
  process.exit(1);
}

async function bootHome(opts) {
  opts = opts || {};
  const S = makeStub(INDEX_HTML, [], { idsFromHtml: true, readyState: 'loading',
                                      seedStore: opts.seedStore || null });
  S.fetch = installFetchStub();
  HOME_PAGE_SCRIPTS.forEach(rel => eval(readAsset(rel)));
  return S;
}

/* ---------- 装配四：错题本页 ----------
   与前几段同一套路：读页面自己的脚本集、按页面顺序 eval、等引擎取数回来。
   本页**不引 bank.js**（脚本集由 test_split.py 钉死为 nav.js + wrong.js），
   所以 wrong.js 自带取数封装，不依赖 window.api。 */
const WRONG_HTML = fs.readFileSync(path.join(WEB, 'wrong.html'), 'utf8');
const WRONG_WANT_SCRIPTS = ['assets/nav.js', 'assets/wrong.js'];
const WRONG_PAGE_SCRIPTS = [...WRONG_HTML.split('</main>')[1]
  .matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
if (WRONG_PAGE_SCRIPTS.join('|') !== WRONG_WANT_SCRIPTS.join('|')) {
  console.error(`wrong.html 的脚本集变了：${WRONG_PAGE_SCRIPTS.join(' / ')}`
    + `（错题本需要 ${WRONG_WANT_SCRIPTS.join(' / ')}）`);
  process.exit(1);
}

async function bootWrong(opts) {
  opts = opts || {};
  const S = makeStub(WRONG_HTML, [], { idsFromHtml: true, readyState: 'loading',
                                       seedStore: opts.seedStore || null });
  S.fetch = installFetchStub({ wrong: opts.wrong || null });
  eval(readAsset(WRONG_PAGE_SCRIPTS[0]));
  window.NAV.forEach(n => { S.byId[n.id] = S.mkEl('section', { class: 'view' }); });
  for (const rel of WRONG_PAGE_SCRIPTS.slice(1)) eval(readAsset(rel));
  await wrongReady;
  return S;
}

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failed++; };

/* 等引擎把这次作答走完：点一下 → api.post → 服务端判分 → 落记录 → 重渲染，
   中间全是微任务。setImmediate 排在微任务队列之后，跑两轮足够把链走完。 */
const settle = async () => {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
};

async function quizSection() {
  const B = await bootQuiz();
  const byId = B.byId, store = B.store, listeners = B.listeners, fbtns = B.fbtns;
  const isWrongById = id => { const q = bankById[id]; const a = JSON.parse(store['jiaokao-answers-2026'] || '{}')[id];
    return !!(q && a && a !== q.answer); };
  const cards = () => (byId.qlist.innerHTML.match(/data-card="/g) || []).length;
  const fires = (el, ev) => listeners.filter(l => l.el === el && l.t === 'click').forEach(l => l.fn(ev));
  /* 真实 DOM 里 innerHTML 一重写，旧元素连同它的监听器就没了。桩里元素是同一个，
     监听器会越堆越多，所以「重新建出来的按钮」只点最后一次绑上的那个。 */
  const fireLast = (el, ev) => {
    const ls = listeners.filter(l => l.el === el && l.t === 'click');
    if (ls.length) ls[ls.length - 1].fn(ev);
  };

  console.log('题库总量:', BANK.total, '| 题库对象数:', BANK.questions.length);

  console.log('\n【首屏渲染】');
  ok(cards() === 40, `首屏渲染 ${cards()} 题（应为 40，不是 1000）`);
  ok(byId.qlist.innerHTML.includes('data-more'), '底部有「再显示」按钮');
  ok(byId.qTotal.textContent == BANK.total || byId.qTotal.textContent === '',
     `顶部题量显示为 ${byId.qTotal.textContent}`);

  console.log('\n【作答与错题本】');
  const first = BANK.questions[0];
  const wrongKey = ['A', 'B', 'C', 'D'].find(k => k !== first.answer);
  fires(byId.qlist, { target: { closest: sel => sel === '.opt'
    ? { disabled: false, getAttribute: k => (k === 'data-q' ? first.id : wrongKey) } : null } });
  await settle();   /* 判分改成问服务端了，落记录是异步的 */
  ok(JSON.parse(store['jiaokao-answers-2026'] || '{}')[first.id] === wrongKey, `答错被记录（${first.id} → ${wrongKey}）`);
  ok(JSON.parse(store['jiaokao-wrong-2026'] || '{}')[first.id] === 1, `答错自动进错题本（${first.id}）`);
  ok(byId.wrongN.textContent == 1, `错题计数 = ${byId.wrongN.textContent}`);
  ok(byId.qDone.textContent == 1, `已做计数 = ${byId.qDone.textContent}`);
  ok(byId.qRate.textContent === '0%', `正确率 = ${byId.qRate.textContent}`);

  const second = BANK.questions[1];
  fires(byId.qlist, { target: { closest: sel => sel === '.opt'
    ? { disabled: false, getAttribute: k => (k === 'data-q' ? second.id : second.answer) } : null } });
  await settle();
  ok(byId.qRate.textContent === '50%', `答对后正确率 = ${byId.qRate.textContent}`);
  ok(byId.wrongN.textContent == 1, '答对的题没进错题本');

  console.log('\n【选项乱序】');
  /* 全量重渲染（含已作答的题），才看得到 .ans */
  fires(fbtns.find(b => b.getAttribute('data-filter') === 'all'), {});
  {
    const h = byId.qlist.innerHTML;
    const cards = h.split('<div class="qz').slice(1);
    const disp = {}, orig = {};
    for (const m of h.matchAll(/data-q="([^"]+)" data-k="([^"]+)"[^>]*><span class="k">([A-D])<\/span>/g)) {
      (disp[m[1]] = disp[m[1]] || []).push(m[3]);
      (orig[m[1]] = orig[m[1]] || []).push(m[2]);
    }
    const ids = Object.keys(disp);
    ok(ids.length === 40, `解析到 ${ids.length} 道题的选项`);
    ok(ids.every(i => disp[i].join('') === 'ABCD'), '显示字母一律按 A/B/C/D 顺排（不跟原始 key 走）');
    ok(ids.every(i => orig[i].slice().sort().join('') === 'ABCD'), '每题四项原始 key 齐全、无重复无遗漏');
    const shufN = ids.filter(i => orig[i].join('') !== 'ABCD').length;
    ok(shufN > 0, `选项确实打乱了（${shufN}/${ids.length} 题的顺序已不是原始的 ABCD）`);

    /* 最关键的一条：标为 correct 的那一项，挂的 key 必须是该题的真答案，
       而且它显示出来的字母，必须和解析里给的字母一致
       —— 这两个要是脱节，用户会看到「答案是 C」可 C 却是错的。 */
    const bad = [];
    let checked = 0;
    for (const c of cards) {
      const cid = (c.match(/data-card="([^"]+)"/) || [])[1];
      const key = (c.match(/class="ans"><span class="key">([A-D])</) || [])[1];
      if (!key) continue;
      const q = bankById[cid];
      const corr = c.match(/class="opt correct"[^>]*data-k="([^"]+)"[^>]*><span class="k">([A-D])</);
      if (!corr) { bad.push(`${cid}: 没有 correct 项`); continue; }
      checked++;
      if (corr[1] !== q.answer) bad.push(`${cid}: correct 项挂的 key 是 ${corr[1]}，真答案是 ${q.answer}`);
      if (corr[2] !== key) bad.push(`${cid}: 选项显示 ${corr[2]}，解析却写 ${key}`);
    }
    ok(checked >= 2, `检查了 ${checked} 道已作答题`);
    ok(bad.length === 0, bad.length ? '不一致 → ' + bad.join('; ')
                                    : '正确项挂的 key 与解析字母都对得上（乱序没有弄错答案）');

    /* 错题本按原始 key 记账，乱序不该影响它 */
    const ans0 = JSON.parse(store['jiaokao-answers-2026']);
    const f0 = BANK.questions[0];
    ok(ans0[f0.id] === ['A', 'B', 'C', 'D'].find(k => k !== f0.answer),
       '已存记录仍是原始 key（乱序不需要迁移）');
  }

  console.log('\n【分页】');
  const before = cards();
  fires(byId.qlist, { target: { closest: sel => sel === '[data-more]' ? {} : null } });
  ok(cards() === before + 40, `点「再显示」后 ${before} → ${cards()} 题`);

  console.log('\n【筛选】');
  const fb = fbtns.find(b => b.getAttribute('data-filter') === 'wrong');
  fires(fb, {});
  ok(cards() === 1, `「只看错题」渲染 ${cards()} 题（应为 1）`);
  ok(byId.qlist.innerHTML.includes(first.id), '错题筛选结果正确');

  const fbTodo = fbtns.find(b => b.getAttribute('data-filter') === 'todo');
  fires(fbTodo, {});
  ok(cards() === 40, `「未做」筛选首屏 ${cards()} 题（应为 40，共 ${BANK.total - 2} 题未做）`);


  /* ---------- 模块下拉 ---------- */
  console.log('\n【模块筛选】');
  {
    /* 模块顺序 = 题库里首次出现的顺序，也就是大纲顺序；改了题库这个下拉要自动跟上 */
    const order = [];
    for (const q of BANK.questions) if (!order.includes(q.module)) order.push(q.module);
    const opts = [...byId.qMod.innerHTML.matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)];
    ok(opts.length === order.length + 1, `下拉有 ${opts.length} 项（全部 + ${order.length} 个模块）`);
    ok(opts[0][1] === '' && /全部模块/.test(opts[0][2]), '第一项是「全部模块」');
    ok(opts.slice(1).map(o => o[1]).join('|') === order.join('|'), '模块顺序与题库首现顺序（大纲顺序）一致');
    const cntBad = opts.slice(1).filter(o => {
      const n = BANK.questions.filter(q => q.module === o[1]).length;
      return !o[2].includes('（' + n + '）');
    });
    ok(cntBad.length === 0, cntBad.length ? '计数不符：' + cntBad.map(o => o[1]).join(',') : '每项都标了该模块题量');

    const sel = byId.qMod;
    const changes = () => listeners.filter(l => l.el === sel && l.t === 'change')
                                   .forEach(l => l.fn({ target: sel }));

    /* 先回到「全部」「不做筛选」，再单看模块 */
    fires(fbtns.find(b => b.getAttribute('data-filter') === 'all'), {});

    /* 逐个模块点一遍。只挑一个模块测是不够的——题库是按模块顺序排的，
       挑中第一个模块的话「筛了」和「没筛」渲染出来的第一页一模一样，突变测不出来。 */
    const bad = [];
    for (const m of order) {
      const want = BANK.questions.filter(q => q.module === m).map(q => q.id);
      sel.value = m; changes();
      const shown = [...byId.qlist.innerHTML.matchAll(/data-card="([^"]+)"/g)].map(x => x[1]);
      if (cards() !== Math.min(40, want.length)) bad.push(`${m}: 渲染 ${cards()} 题，应为 ${Math.min(40, want.length)}`);
      else if (shown.some(id => !want.includes(id))) bad.push(`${m}: 混进了别的模块`);
      sel.value = ''; changes();
    }
    ok(bad.length === 0, bad.length ? bad.slice(0, 3).join('; ')
                                    : `13 个模块逐个筛过，每次都只出该模块的题、页数也对`);

    /* 和「只看错题」叠加：两个条件是「且」不是「或」 */
    const modW = order.find(m => BANK.questions.filter(q => q.module === m && isWrongById(q.id)).length > 0);
    const wantW = BANK.questions.filter(q => q.module === modW).map(q => q.id);
    const wrongInMod = wantW.filter(isWrongById);
    sel.value = modW; changes();
    fires(fbtns.find(b => b.getAttribute('data-filter') === 'wrong'), {});
    ok(wrongInMod.length > 0, `「${modW}」里有 ${wrongInMod.length} 道错题可用来验叠加`);
    ok(cards() === wrongInMod.length,
       `「只看错题」+「${modW}」渲染 ${cards()} 题（该模块内错题 ${wrongInMod.length} 道）`);
    {
      const shown = [...byId.qlist.innerHTML.matchAll(/data-card="([^"]+)"/g)].map(x => x[1]);
      ok(shown.every(id => bankById[id].module === modW && isWrongById(id)),
         '叠加后剩下的题既属于该模块、又确实是错题（两个条件是「且」）');
    }

    /* 清空记录要连下拉一起复位，否则用户会以为题库空了 */
    fires(byId.wrongReset, {});
    ok(sel.value === '', '「清空记录」把下拉复位回「全部模块」');
    ok(cards() === 40, `清空后回到全部 ${BANK.total} 题的首页（${cards()} 题）`);
  }

  /* ---------- 解析里的字母 ---------- */
  console.log('\n【解析字母随选项重映射】');
  /* 解析里「A 项」「故选 B」这类字母是在指代选项，选项一乱序就必须跟着换，
     否则用户会看到「故选 C」而 C 是错的。
     反过来，有些字母根本不指代选项——p16/p228 的「ABC 理论——A 是诱发事件，
     B 是信念」，那是理性情绪疗法的三个变量——换了就把解析讲错了。 */
  {
    /* 挑一批解析里带「故选 X」的题答错，进错题本才好渲染出来查 */
    const withXuan = BANK.questions.filter(q => /故选\s*[A-D]/.test(q.explanation)).slice(0, 30);
    const ids = [...new Set(['p16', 'p228', ...withXuan.map(q => q.id)])].filter(id => bankById[id]);
    for (const id of ids) {
      const q = bankById[id];
      const wk = ['A', 'B', 'C', 'D'].find(k => k !== q.answer);
      fires(byId.qlist, { target: { closest: sel => sel === '.opt'
        ? { disabled: false, getAttribute: k => (k === 'data-q' ? id : wk) } : null } });
      await settle();   /* 每一题都要等服务端判完 */
    }
    fires(fbtns.find(b => b.getAttribute('data-filter') === 'wrong'), {});

    const parts = byId.qlist.innerHTML.split('<div class="qz').slice(1);
    ok(parts.length >= 20, `错题本渲染出 ${parts.length} 道题可供检查`);

    let chk = 0; const bad = [];
    for (const c of parts) {
      const cid = (c.match(/data-card="([^"]+)"/) || [])[1];
      const m = c.match(/class="ans"><span class="key">([A-D])<\/span>([\s\S]*?)<\/div>/);
      if (!m) continue;
      const key = m[1], exp = m[2];
      chk++;
      for (const re of [/故选\s*([A-D])/g, /故\s*([A-D])。/g]) {
        let r;
        while ((r = re.exec(exp))) {
          if (r[1] !== key) bad.push(`${cid}: 解析写「${r[0].trim()}」但正确答案显示为 ${key}`);
        }
      }
    }
    ok(chk >= 20, `检查了 ${chk} 道已作答题的解析`);
    ok(bad.length === 0, bad.length ? bad.slice(0, 3).join('; ')
                                    : '「故选 X」的 X 与该项显示的字母一致（乱序没把解析指错）');

    const abc = parts.find(c => /data-card="p16"/.test(c)) || '';
    const abcExp = (abc.match(/class="ans"><span class="key">[A-D]<\/span>([\s\S]*?)<\/div>/) || [])[1] || '';
    ok(/ABC\s*理论/.test(abcExp), 'p16（ABC 理论）已渲染出来');
    ok(/A\s*是诱发事件/.test(abcExp) && /B\s*是信念/.test(abcExp) && /C\s*是情绪/.test(abcExp),
       'ABC 理论的 A/B/C 没被当成选项指代改掉（换了就把解析讲反了）');
  }

  /* ---------- 判分这件事确实发生在服务端 ----------
     上面每一条都能被「本地按答案比」骗过去：把 POST /api/attempts 整个删掉、
     改成 res = { correct: k === q.answer }，99 条断言一条都不会红。而拆页的
     全部意义就在于判分归 banklib.grade 独一份——所以这里补两条专盯它的：
       · 作答有没有真的发出那个请求（桩记了每一次请求）
       · 渲染出来的结论取的是不是响应体（让桩返回一个和本地算法相反的结果）
     缺了它们，「谁把引擎改回本地判分」不会有任何人吭声。 */
  console.log('\n【判分由服务端定】');
  {
    const posts = () => B.fetch.calls.filter(c => c.path === '/api/attempts' && c.method === 'POST');
    const q9 = BANK.questions[9];
    const wk9 = ['A', 'B', 'C', 'D'].find(k => k !== q9.answer);
    const n0 = posts().length;
    fires(byId.qlist, { target: { closest: sel => sel === '.opt'
      ? { disabled: false, getAttribute: k => (k === 'data-q' ? q9.id : wk9) } : null } });
    await settle();
    const sent = posts();
    ok(sent.length === n0 + 1, `作答让 POST /api/attempts 恰好发出一次（${n0} → ${sent.length}）`);
    ok(!!sent.length && sent[sent.length - 1].body
       && sent[sent.length - 1].body.qid === q9.id && sent[sent.length - 1].body.chosen === wk9,
       `请求体带的是这道题与所选项（${q9.id} → ${wk9}）`);

    /* 更强的一条：本地的规则会判「对」，桩偏说「错」，页面信谁一目了然。
       q10 用户选的就是它的正确答案，本地比较必然 correct:true。 */
    const q10 = BANK.questions[10];
    B.fetch.override = { qid: q10.id, correct: false, answer: q10.answer,
                         explanation: q10.explanation, wrong_count: 7 };
    fires(byId.qlist, { target: { closest: sel => sel === '.opt'
      ? { disabled: false, getAttribute: k => (k === 'data-q' ? q10.id : q10.answer) } : null } });
    await settle();
    B.fetch.override = null;
    const a10 = JSON.parse(store['jiaokao-answers-2026'] || '{}')[q10.id];
    ok(a10 === q10.answer, `（前提）${q10.id} 选的是正确答案，本地算法会判对`);
    /* 重渲染一次看整页（引擎只替换单张卡，桩的 querySelector 回 null，重渲染最稳） */
    fires(fbtns.find(b => b.getAttribute('data-filter') === 'all'), {});
    ok(byId.qlist.innerHTML.includes('class="qz wrong" data-card="' + q10.id + '"'),
       '服务端回 correct:false，页面就按「答错」渲染（结论取自响应体，不是本地算的）');
    ok(JSON.parse(store['jiaokao-wrong-2026'] || '{}')[q10.id] === 1,
       '这一题因此进了错题本——错题本认的也是服务端判的分');
  }

  /* ---------- 多选题 · 勾选后确认（合成题） ----------
     真库 1000 题**全是单选**（type:'single'）：多选只在第四阶段才落库，所以本任务
     全部覆盖都来自下面这些合成题——别去真库里找多选题，找不到是对的。
     它们临时插在题库最前面（落在第一屏里看得见），断言完摘掉；新装配一次会清空
     共用的 localStorage，所以这段自己从头攒作答。 */
  console.log('\n【多选题 · 勾选后确认】');
  {
    /* 九道同答案的合成题（答案 ABD、选项 A/B/C/D）。要这么多是为了「答案行显示的
       字母」那条：选项乱序是**每题随机**洗一次的，只有一道题时恰好洗成原序
       （1/24 的机会）会让那条变成假绿；九道全洗成原序的概率 (1/24)^9，等于不会发生。 */
    const MANS = 'ABD';
    const mkQ = i => ({ id: 'test-m' + i, n: 9990 - i, module: '教育学', type: 'multi',
                        stem: '多选题干' + i,
                        options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' },
                                  { key: 'C', text: '丙' }, { key: 'D', text: '丁' }],
                        answer: MANS,
                        /* 解析刻意用**单字母**指代：这一段钉的是勾选/判分那条线，
                           「故选 A」顺带把单字母重映射当回归基线；连着的多字母串
                           （「故选 ABD」）由下面【解析字母 · 连着的多字母串】单开一段盖。 */
                        explanation: '故选 A。' });
    const mqs = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(mkQ);
    const n0 = BANK.questions.length;
    mqs.forEach(q => BANK.questions.unshift(q));
    try {
      const M = await bootQuiz();
      const byId = M.byId, store = M.store;
      const fireM = (el, ev) => M.listeners.filter(l => l.el === el && l.t === 'click')
                                             .forEach(l => l.fn(ev));
      const posts = () => M.fetch.calls.filter(c => c.path === '/api/attempts' && c.method === 'POST');
      const allBtn = M.fbtns.find(b => b.getAttribute('data-filter') === 'all');
      /* 桩里 querySelector 恒回 null，引擎「只替换单张卡」那条路走不到——
         整体重渲染一次才看得到新的勾选态（和上面几段同一个路子）。 */
      const redraw = () => fireM(allBtn, {});
      const html = () => byId.qlist.innerHTML;
      const cardOf = (h, id) => h.split('<div class="qz').slice(1)
                                  .find(c => c.includes('data-card="' + id + '"')) || '';
      /* 每个选项挂着什么 class，按 key 拼成 'A:correct,B:dim,…' 比。整串比而不是
         数「correct 有几个」：漏标、错标、多标（比如答完还留着 picked）都会露馅，
         也不依赖选项渲染的先后（乱序）。 */
      const clsPairs = (h, id) => [...cardOf(h, id).matchAll(/class="opt ([^"]+)"[^>]*data-k="([^"]+)"/g)]
                                   .map(m => m[2] + ':' + m[1]).sort().join(',');
      const pickedOf = (h, id) => [...cardOf(h, id).matchAll(/class="opt picked"[^>]*data-k="([^"]+)"/g)].map(m => m[1]);
      /* cardOf 的片段是从 `<div class="qz` **之后**切起的，`class="qz wrong"` 那个字面量
         在片段里被切掉了一半——判「这张卡是不是错题卡」必须看整页，不能看片段。 */
      const isWrongCard = (h, id) => h.includes('class="qz wrong" data-card="' + id + '"');
      const clickOpt = (id, k) => fireM(byId.qlist, { target: { closest: sel => sel === '.opt'
        ? { disabled: false, getAttribute: a => (a === 'data-q' ? id : k) } : null } });
      const clickConfirm = id => fireM(byId.qlist, { target: { closest: sel => sel === '[data-confirm]'
        ? { getAttribute: a => (a === 'data-confirm' ? id : null) } : null } });
      const m0 = mqs[0], m1 = mqs[1], m2 = mqs[2];

      /* ---- 1. 点选项只切换勾选，不判分 ---- */
      ok(cardOf(html(), m0.id).includes('data-confirm="' + m0.id + '"'),
         '多选题未确认时下方有「确认作答」按钮');
      ok(!/class="opt (correct|wrong|dim|picked)/.test(cardOf(html(), m0.id)),
         '（前提）未作答时四个选项一个标记都没有');

      const p0 = posts().length;
      clickOpt(m0.id, 'A'); await settle();
      ok(posts().length === p0, `点选项不提交（POST /api/attempts 仍是 ${posts().length} 次）`);
      ok(!(m0.id in JSON.parse(store['jiaokao-answers-2026'] || '{}')),
         '未确认前本机不记这一题（勾上只是勾上）');
      redraw();
      ok(pickedOf(html(), m0.id).join('') === 'A',
         `点一下把 A 标成已勾选（实际 ${pickedOf(html(), m0.id).join('') || '无'}）`);

      /* 多选是「切换」不是「选中」：再点一下要能取消 */
      clickOpt(m0.id, 'A'); await settle(); redraw();
      ok(pickedOf(html(), m0.id).length === 0, '再点一下取消勾选（切换而不是累积）');
      ok(posts().length === p0, '取消勾选也不提交');

      /* ---- 1b. 一项都没勾就点「确认作答」：不提交、不记 ---- */
      /* 空勾选要是提交出去，chosen 是空串：服务端 banklib.grade 判 false（悄悄给
         记一笔错），而本机 answers[qid] 那个空串又是 falsy——卡片看上去还是「没
         答过」。用户点了个没反应的按钮，账上却多了一笔错题。 */
      const m3 = mqs[3];
      clickConfirm(m3.id); await settle();
      ok(posts().length === p0, '一项都没勾就点「确认作答」不提交');
      ok(!(m3.id in JSON.parse(store['jiaokao-answers-2026'] || '{}')),
         '也不在本机记一笔空作答（记了会被判错、卡片却还显示成没答过）');
      redraw();
      ok(cardOf(html(), m3.id).includes('data-confirm="' + m3.id + '"')
         && !cardOf(html(), m3.id).includes('class="ans"'),
         '（前提）这一题仍是未作答的样子，还能继续勾');

      /* ---- 2. 点「确认作答」才把勾选的字母交上去 ---- */
      /* 故意按 D、A、B 的顺序点：钉的是「交上去的是勾选的那几个字母」，
         不是字母串的某种拼法——服务端 _norm 本来就排序，拼法在判分上看不出差别
         （ruling 4）。 */
      ['D', 'A', 'B'].forEach(k => clickOpt(m0.id, k));
      await settle(); redraw();
      ok(pickedOf(html(), m0.id).sort().join('') === MANS,
         `三个字母都勾上了（实际 ${pickedOf(html(), m0.id).join('')}）`);

      const p1 = posts().length;
      clickConfirm(m0.id); await settle();
      const sent = posts();
      ok(sent.length === p1 + 1, `点「确认作答」才发请求（${p1} → ${sent.length}）`);
      const chosen0 = sent.length ? sent[sent.length - 1].body.chosen : '';
      ok(sent.length && sent[sent.length - 1].body.qid === m0.id
         && chosen0.split('').sort().join('') === MANS,
         `请求体是这道题与勾选的字母串（${m0.id} → ${chosen0}）`);
      ok(JSON.parse(store['jiaokao-answers-2026'] || '{}')[m0.id] === chosen0,
         '确认后本机才记上这一题');

      /* ---- 2b. 连点两下「确认作答」只发一次请求 ---- */
      /* 两次点击之间隔着一次 await：第一次读 answers 时它还是空的，answers[cid]
         那道守卫拦不住第二次，submitAnswer 里的 delete picks 又要等到 await 之后
         才执行。banklib 每收到一次 POST 就给 wrong_count +1（banklib.py 的 upsert），
         答错时连点两下就把错次刷成 2。按钮必须在**同步**阶段就锁住。 */
      const m8 = mqs[8];
      ['A', 'B', 'D'].forEach(k => clickOpt(m8.id, k));
      await settle(); redraw();
      const pDbl = posts().length;
      /* 两次点击打在**同一个按钮对象**上，跟真实 DOM 一样（disabled 是元素上的状态） */
      const confEl = { disabled: false, getAttribute: a => (a === 'data-confirm' ? m8.id : null) };
      const hitConf = () => fireM(byId.qlist, { target: { closest: sel => sel === '[data-confirm]' ? confEl : null } });
      hitConf(); hitConf(); await settle();
      ok(posts().length === pDbl + 1,
         `连点两下「确认作答」只发一次请求（${pDbl} → ${posts().length}）`);
      const dblSent = posts()[posts().length - 1].body;
      ok(dblSent.chosen.split('').sort().join('') === MANS,
         `而且发出去的就是勾选的那几项（${dblSent.qid} → ${dblSent.chosen}）`);

      /* ---- 2c. 服务端没记上：本机也不记，按钮放开让人重试 ---- */
      /* 桩按 banklib 的形状答话：库里没这道题就 404。把那道题从 BANK 里摘掉（引擎
         自己那份列表是取数时拷出来的，题还在页面上），POST 就会失败。
         同步锁按钮是为了防连点，锁死不放又成了「点了没反应」——失败必须放开。 */
      const m4 = mqs[4];
      ['A', 'B', 'D'].forEach(k => clickOpt(m4.id, k));
      await settle(); redraw();
      const i4 = BANK.questions.indexOf(m4);
      BANK.questions.splice(i4, 1);
      const pFail = posts().length;
      const confEl4 = { disabled: false, getAttribute: a => (a === 'data-confirm' ? m4.id : null) };
      const hit4 = () => fireM(byId.qlist, { target: { closest: sel => sel === '[data-confirm]' ? confEl4 : null } });
      hit4(); await settle();
      BANK.questions.splice(i4, 0, m4);
      ok(posts().length === pFail + 1, `（前提）这一下确实发了请求、服务端也确实没记上（${pFail} → ${posts().length}）`);
      ok(!(m4.id in JSON.parse(store['jiaokao-answers-2026'] || '{}')),
         '服务端没记上就不在本机记（不留服务端不知道的记录）');
      ok(confEl4.disabled === false, '失败后按钮放开了，用户还能重试');
      redraw();
      ok(cardOf(html(), m4.id).includes('data-confirm="' + m4.id + '"')
         && !cardOf(html(), m4.id).includes('class="ans"'), '卡片也还是没作答的样子');
      /* 服务端恢复之后，同一张卡再点一次就该答上——「放开」不是摆设 */
      hit4(); await settle(); redraw();
      ok(JSON.parse(store['jiaokao-answers-2026'] || '{}')[m4.id] === MANS,
         '服务端好了再点一次就记上了（重试这条路是通的）');

      /* ---- 3. 提交后锁定，按响应体渲染对错 ---- */
      redraw();
      const c0 = cardOf(html(), m0.id);
      ok(!c0.includes('data-confirm'), '提交后「确认作答」按钮消失（卡片锁定）');
      /* 这一条正是 ruling 2 的病灶：o.key === q.answer 在多选下恒假（'A' === 'ABD'），
         修之前四个选项会一个不剩地掉进 dim，用户看不出哪几项是对的。
         全对时 A/B/D 标 correct、没勾的错项 C 标 dim（dim 在这里是**对**的：
         C 本来就不是答案，用户也没勾它）。 */
      ok(clsPairs(html(), m0.id) === 'A:correct,B:correct,C:dim,D:correct',
         `全对：三项 correct、一项 dim（实际 ${clsPairs(html(), m0.id) || '无'}）`);
      /* 解析也一起渲染出来。合成题的解析是「故选 A。」——那个 A 是**原始 key**，
         卡片上必须换成乱序后显示的那个字母，也就是标为 correct 的 A 项显示的字母。
         （本段的合成题刻意不用「故选 ABD」这种多字母指代：remapExplain 的逐字母
         邻接判断会把连着的整串挡掉，那是任务 14 的地盘，见 ruling 3。） */
      const dispOf = (h, id, key) => (cardOf(h, id).match(new RegExp('data-k="' + key + '"[^>]*><span class="k">([A-D])</span>')) || [])[1] || '';
      ok(c0.includes('故选 ' + dispOf(html(), m0.id, 'A') + '。'),
         `解析里的「故选 A」跟着选项重映射（渲染成「故选 ${dispOf(html(), m0.id, 'A')}。」）`);
      ok(!isWrongCard(html(), m0.id), '全对不标成错题卡');
      ok(byId.wrongN.textContent == 0 && byId.qRate.textContent === '100%',
         `全对：错题数 ${byId.wrongN.textContent}、正确率 ${byId.qRate.textContent}`);

      /* 对照组：单选点一下仍然直接判分，没有「确认作答」这一步。
         少了它，「多选改动把单选也改成两段式」不会有任何断言吭声。 */
      const sq = BANK.questions.find(q => q.type === 'single');
      ok(!cardOf(html(), sq.id).includes('data-confirm'), '（对照）单选题没有「确认作答」按钮');
      clickOpt(sq.id, sq.answer); await settle();
      ok(JSON.parse(store['jiaokao-answers-2026'] || '{}')[sq.id] === sq.answer,
         '（对照）单选题点一下就直接提交判分');

      /* ---- 4. 少选算错（判分与 banklib.grade 一致） ---- */
      clickOpt(m1.id, 'A'); clickOpt(m1.id, 'B');
      await settle(); clickConfirm(m1.id); await settle(); redraw();
      ok(isWrongCard(html(), m1.id),
         '少选（勾了 AB，答案是 ABD）判错——卡上标了 wrong');
      ok(byId.wrongN.textContent == 1, `这一题进了错题本（错题数 ${byId.wrongN.textContent}）`);
      ok(JSON.parse(store['jiaokao-wrong-2026'] || '{}')[m1.id] === 1, '错题本里记的是这一题');
      /* 勾错的标错、漏勾的照样标出正确答案：少选的人需要看到漏了 D。
         （这一串和「全对」那条一样，是对的——着色只反映**答案**，不反映用户勾了什么。） */
      ok(clsPairs(html(), m1.id) === 'A:correct,B:correct,C:dim,D:correct',
         `少选也把漏掉的那一项标出来（实际 ${clsPairs(html(), m1.id) || '无'}）`);

      /* ---- 5. 勾多了算错，多勾的那一项标 wrong ---- */
      ['A', 'B', 'C', 'D'].forEach(k => clickOpt(m2.id, k));
      await settle(); clickConfirm(m2.id); await settle(); redraw();
      /* 多勾的 C 标 wrong（勾了又不是答案）；A/B/D 仍是 correct。
         这条钉住 wrong 与 correct 的判据不同：correct 看答案，wrong 看「勾了但不对」。 */
      ok(clsPairs(html(), m2.id) === 'A:correct,B:correct,C:wrong,D:correct',
         `多勾的 C 标成 wrong（实际 ${clsPairs(html(), m2.id) || '无'}）`);

      /* ---- 6. 提交过的题点不动了 ---- */
      const p2 = posts().length;
      clickOpt(m0.id, 'C'); clickOpt(m1.id, 'C'); await settle();
      ok(posts().length === p2, '已提交的题再点选项不发请求（卡片锁住了）');
      redraw();
      ok(JSON.parse(store['jiaokao-answers-2026'])[m0.id] === chosen0, '已提交的作答不会被点乱');

      /* ---- 6b. 已经答过的题再点「确认作答」：不重复提交、不改记录 ---- */
      /* 列表里这张卡的确认按钮已经撤了（上一节刚断言过），但守卫本身也要立得住：
         卡片重渲染前后、脚本点到旧按钮、别的标签页改过本机记录，都可能让这个点击
         落到一道已经答过的题上。 */
      const pDone = posts().length;
      const storedM0 = JSON.parse(store['jiaokao-answers-2026'])[m0.id];
      clickConfirm(m0.id); await settle();
      ok(posts().length === pDone, '已答过的题再点「确认作答」不再发请求');
      ok(JSON.parse(store['jiaokao-answers-2026'])[m0.id] === storedM0,
         '已有的作答记录也没被改写');

      /* ---- 7. 答案行显示的字母，必须是那几项**显示出来**的字母 ---- */
      /* 其余的合成题也答对，凑够乱序样本 */
      for (const q of mqs.slice(3)) {
        ['A', 'B', 'D'].forEach(k => clickOpt(q.id, k));
        await settle(); clickConfirm(q.id); await settle();
      }
      redraw();
      {
        const bad = [];
        let checked = 0, shuf = 0;
        for (const q of mqs) {
          const c = cardOf(html(), q.id);
          const label = (c.match(/class="ans"><span class="key">([A-D]+)<\/span>/) || [])[1] || '';
          const corr = [...c.matchAll(/class="opt correct"[^>]*data-k="([^"]+)"[^>]*><span class="k">([A-D])</g)].map(x => x[2]);
          if (!label || corr.length !== 3) { bad.push(`${q.id}: 答案行=${label || '无'}、correct 项 ${corr.length} 个`); continue; }
          checked++;
          /* 两个来源互相印证：answerLabel（answer 逐字母过 shownKey）与
             optionHTML（按位置给显示字母）。哪边跟乱序脱了节都在这里露馅——
             答案行要是直接写 q.answer（'ABD'），乱序后就和 correct 项对不上。 */
          if (corr.slice().sort().join('') !== label)
            bad.push(`${q.id}: 答案行写 ${label}，标为正确的选项显示为 ${corr.join('')}`);
          if (M.shuffledOpts(q).map(o => o.key).join('') !== 'ABCD') shuf++;
        }
        ok(checked === mqs.length, `${mqs.length} 道多选题都渲染出了答案行（${checked}/${mqs.length}）`);
        ok(shuf > 0, `其中 ${shuf}/${mqs.length} 道的选项确实洗过牌——否则下面那条是假绿`);
        ok(bad.length === 0, bad.length ? bad.slice(0, 3).join('; ')
                                        : '答案行显示的字母与标为正确的选项一致（乱序没让答案行指错项）');
      }

      /* ---- 8. 重开页面：答对的多选题必须还算对 ---- */
      /* verdicts 只活在本次会话里，重开页面后 isRight 退回按答案比。多选下这条退回
         必须与 banklib.grade 等价（顺序不该影响对错），否则用户答对了、重开页面
         却看到「错」——这是用户看得见的失败，不是调用约定。 */
      const stored = store['jiaokao-answers-2026'];
      const wrongBefore = byId.wrongN.textContent;
      ok(JSON.parse(stored)[m0.id], '（前提）本机存着 m0 的作答记录，重开才有的比');
      const M2 = await bootQuiz({ seedStore: { 'jiaokao-answers-2026': stored } });
      const h2 = M2.byId.qlist.innerHTML;
      const c2 = h2.split('<div class="qz').slice(1)
                   .find(c => c.includes('data-card="' + m0.id + '"')) || '';
      ok(c2.includes('class="ans"'), '（前提）重开后这道题仍带着答案行（记录确实读回来了）');
      ok(!isWrongCard(h2, m0.id), '重开页面后答对的多选题仍算对（没有「答对了却判错」）');
      ok(M2.byId.wrongN.textContent === wrongBefore,
         `重开后错题数与关页前一致（${wrongBefore} → ${M2.byId.wrongN.textContent}）`);

      /* 本机存着的字母顺序未必规范：旧版本写下的、或别的标签页写的记录都可能是
         'DAB' 这种序。判分退回按答案比时必须和 banklib._norm 一样排序去重，
         否则同一批字母、只是顺序不同，就会被判成错。 */
      const M3 = await bootQuiz({ seedStore: {
        'jiaokao-answers-2026': JSON.stringify({ [m0.id]: 'DAB' }) } });
      const h3 = M3.byId.qlist.innerHTML;
      const c3 = h3.split('<div class="qz').slice(1)
                   .find(c => c.includes('data-card="' + m0.id + '"')) || '';
      ok(c3.includes('class="ans"'), '（前提）非规范序的记录也渲染出了答案行');
      ok(!isWrongCard(h3, m0.id), '记录里字母顺序不规范（DAB）时，答对的题仍算对');
      ok(M3.byId.wrongN.textContent == 0,
         `只有这一题作答、而且它是对的：错题数 ${M3.byId.wrongN.textContent}`);
    } finally {
      mqs.forEach(q => { const i = BANK.questions.indexOf(q); if (i >= 0) BANK.questions.splice(i, 1); });
    }
    /* 摘干净了：后面几段装配（模考的抽题按模块配额抽）吃的还得是原来那份题库。 */
    ok(BANK.questions.length === n0 && !BANK.questions.some(q => q.id === mqs[0].id),
       `合成题已从题库里摘掉（还是 ${BANK.questions.length} 题，后面几段装配不受影响）`);
  }

  /* ---------- 解析字母：连着的多字母串（任务 14） ----------
     真库 1000 题里**没有**连着的多字母指代：全库只有 2 处连着的串，都是「ABC 理论」
     （见 tools/remap_probe.js 的【故意不换】多字母串那一节）——恰恰是不能换的那种。
     所以「故选 ABD」这条道只能在合成题上盖；真库那边能证明的是「改前改后逐题没变」，
     证据在 tools/remap_probe.js 里（固定种子，改前改后 dump 逐字节 diff 为空）。
     这段走**真实渲染路径**：把合成题答对，从卡片答案行里读解析，跟「按显示顺序独立
     算出来的期望串」比——两边一个来自渲染、一个来自 shuffledOpts，互相印证。 */
  console.log('\n【解析字母 · 连着的多字母串】');
  {
    /* 一句里两种形状：串前面有「故选」、串后面跟「三项」。两个分支各自都会被钉到。 */
    const MEXP = '故选 ABD。ABD 三项都对。';
    const mkMul = i => ({ id: 'test-ml' + i, n: 9990 - i, module: '教育学', type: 'multi',
                          stem: '多字母解析题干' + i,
                          options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' },
                                    { key: 'C', text: '丙' }, { key: 'D', text: '丁' }],
                          answer: 'ABD', explanation: MEXP });
    /* 九道：乱序是每题随机洗一次的，只有一道题时恰好洗成原序（1/24）会让下面那条变假绿 */
    const mulqs = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(mkMul);
    const n0 = BANK.questions.length;
    mulqs.forEach(q => BANK.questions.unshift(q));
    try {
      const M = await bootQuiz();
      const byId = M.byId;
      const fireM = (el, ev) => M.listeners.filter(l => l.el === el && l.t === 'click')
                                             .forEach(l => l.fn(ev));
      const allBtn = M.fbtns.find(b => b.getAttribute('data-filter') === 'all');
      const redraw = () => fireM(allBtn, {});
      const clickOpt = (id, k) => fireM(byId.qlist, { target: { closest: sel => sel === '.opt'
        ? { disabled: false, getAttribute: a => (a === 'data-q' ? id : k) } : null } });
      const clickConfirm = id => fireM(byId.qlist, { target: { closest: sel => sel === '[data-confirm]'
        ? { getAttribute: a => (a === 'data-confirm' ? id : null) } : null } });
      for (const q of mulqs) {
        ['A', 'B', 'D'].forEach(k => clickOpt(q.id, k));
        await settle(); clickConfirm(q.id); await settle();
      }
      redraw();
      const h = byId.qlist.innerHTML;
      const cardOf = id => h.split('<div class="qz').slice(1)
                            .find(c => c.includes('data-card="' + id + '"')) || '';
      let checked = 0, movedN = 0; const bad = [];
      for (const q of mulqs) {
        const exp = (cardOf(q.id).match(/class="ans"><span class="key">[A-D]+<\/span>([\s\S]*?)<\/div>/) || [])[1];
        if (exp === undefined) { bad.push(`${q.id}: 答案行里没有解析`); continue; }
        checked++;
        /* 显示字母从乱序结果独立算一遍，不跟 remapExplain 内部那份比 */
        const order = M.shuffledOpts(q).map(o => o.key);
        const d = k => 'ABCD'.charAt(order.indexOf(k));
        const want = `故选 ${d('A')}${d('B')}${d('D')}。${d('A')}${d('B')}${d('D')} 三项都对。`;
        if (exp !== want) bad.push(`${q.id}: 解析渲染成「${exp}」，按显示字母该是「${want}」`);
        if (d('A') !== 'A' || d('B') !== 'B' || d('D') !== 'D') movedN++;
      }
      ok(checked === mulqs.length, `${mulqs.length} 道题的解析都渲染出来了（${checked}/${mulqs.length}）`);
      ok(movedN > 0, `其中 ${movedN} 道的选项确实洗过牌——一个都没有的话下面那条是假绿`);
      ok(bad.length === 0, bad.length ? bad.slice(0, 3).join('; ')
        : '「故选 ABD」「ABD 三项」整串跟着乱序重映射，串里每个字母都指对显示项');
    } finally {
      mulqs.forEach(q => { const i = BANK.questions.indexOf(q); if (i >= 0) BANK.questions.splice(i, 1); });
    }
  }

  /* ---------- 本机记录不是字符串也不能把页面带崩 ----------
     本机 localStorage 是用户随手能改的地方（改前那段 `a === q.answer` 对什么类型
     都只是「不相等」），同一条记录也不保证是字符串。渲染路径上每取一次作答都会
     过一遍规范化与选项比对，值不是字符串时一旦抛异常，丢的不是一张卡，是**整页**：
     loadBank 的 catch 会把页面换成「题库没取到…」，用户再也点不动。
     这一段只用真库里的题（e1），不动 BANK。 */
  console.log('\n【坏记录不炸页面】');
  {
    const bads = [['{"e1":true}', '布尔'], ['{"e1":["A"]}', '数组'], ['{"e1":7}', '数字']];
    for (const [seed, label] of bads) {
      const B = await bootQuiz({ seedStore: { 'jiaokao-answers-2026': seed } });
      const h = B.byId.qlist.innerHTML;
      const cards = (h.match(/data-card="/g) || []).length;
      ok(cards === 40 && !/题库没取到/.test(h),
         `记录是${label}时页面照常渲染首屏（${cards} 张卡，${h.length} 字节）`);
      ok(B.byId.wrongN.textContent == 1,
         `这条记录按「没答对」算（错题数 ${B.byId.wrongN.textContent}），与改前一致`);
    }
  }

  /* ---------- 判断题 · 禁止乱序（合成题） ----------
     真库 1000 题**全是单选**（type:'single'）：判断题只在大纲里，第四阶段才落库。
     所以本任务全部覆盖都来自下面这道合成题——别去真库里找判断题，找不到是对的。
     它临时插在题库最前面，好让它落在第一屏里看得见；引擎取数时把结果另存了一份
     （loadBank 里的 qs 是新数组），所以断言完摘掉即可，不影响后面几段装配。
     本段在 quizSection 的最后：新装配一次会清空共用的 localStorage。 */
  console.log('\n【判断题 · 禁止乱序】');
  {
    const jq = { id: 'test-j1', n: 9991, module: '教育学', type: 'judge',
                 stem: '判断题干', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }],
                 answer: 'A', explanation: '解析' };
    const n0 = BANK.questions.length;
    BANK.questions.unshift(jq);
    let J;
    try {
      J = await bootQuiz();
      const fireJ = (el, ev) => J.listeners.filter(l => l.el === el && l.t === 'click')
                                             .forEach(l => l.fn(ev));

      const order = J.shuffledOpts(jq);
      ok(order.length === 2, '判断题两个选项');
      /* 「不乱序」只调一次是**测不出来**的：两个选项洗一次牌，有整整一半的机会
         正好还是 A、B 原序——删掉判断题那行代码，也有一半的几率是绿的。
         拿 20 个新题号各调一次（同一题号会命中 SHUF 缓存，只洗一次），
         只要有一次乱了就红，漏掉的概率 1/2^20。 */
      const orders = [];
      for (let i = 0; i < 20; i++) {
        orders.push(J.shuffledOpts({ id: 'test-j-probe-' + i, type: 'judge', options: jq.options })
                      .map(o => o.key).join(''));
      }
      ok(orders.every(s => s === 'AB'),
         `判断题不乱序——20 次抽样全是 A/B（对/错的先后有语义，打乱会让解析指错）`);

      /* 对照组：单选题必须照常乱序。没有这一条，上面那句在「乱序被整个关掉」
         的情况下也会绿——那就成了假绿。 */
      const singles = J.bank.questions.filter(q => q.type === 'single').slice(0, 20);
      const someShuffled = singles.some(q => {
        const got = J.shuffledOpts(q).map(o => o.key).join('');
        return got !== q.options.map(o => o.key).join('');
      });
      ok(someShuffled, '单选题仍然乱序——否则「判断题不乱序」这条是假绿');

      /* 各答一题：.ans 只在已作答的卡上出现。单选题那份是对照组——
         判断题的界面改动要是波及到单选（把字母整个关掉、答案行也换成文字），
         没有对照组就看不出来。 */
      const sq = J.bank.questions.find(q => q.type === 'single');
      const pick = (id, k) => fireJ(J.byId.qlist, { target: { closest: sel => sel === '.opt'
        ? { disabled: false, getAttribute: a => (a === 'data-q' ? id : k) } : null } });
      pick(jq.id, 'B');
      await settle();
      pick(sq.id, sq.answer);
      await settle();
      /* 全量重渲染一次才看得到带 .ans 的整页（引擎只替换单张卡，
         桩的 querySelector 恒回 null）。 */
      fireJ(J.fbtns.find(b => b.getAttribute('data-filter') === 'all'), {});
      const jAns = JSON.parse(J.store['jiaokao-answers-2026'] || '{}');
      ok(jAns[jq.id] === 'B' && jAns[sq.id] === sq.answer,
         '（前提）判断题与单选题各答了一题，两张卡的答案行才会渲染出来');

      const parts = J.byId.qlist.innerHTML.split('<div class="qz').slice(1);
      const cardOf = id => parts.find(c => c.includes('data-card="' + id + '"')) || '';
      const judgeCard = cardOf(jq.id), singleCard = cardOf(sq.id);

      /* 「判断题没字母」得先有卡片可看：少了这条前提，渲染整个坏掉
         （judgeCard 是空串）时它照样绿。 */
      ok(judgeCard.includes('判断题干') && singleCard.includes(sq.stem),
         '判断题与对照组单选题都渲染成了卡片（前提）');
      /* 有卡片还不够：按钮要是压根没建出来，「没有字母」也是在空壳上绿。
         这里钉住两个按钮的文字确实渲染出来了。 */
      ok(/<span class="t">正确<\/span>/.test(judgeCard) && /<span class="t">错误<\/span>/.test(judgeCard),
         '（前提）判断题的两个按钮都渲染了出来（否则「没有字母」是空按钮上的假绿）');
      ok(!/<span class="k">/.test(judgeCard), '判断题的按钮上没有 A/B 字母');
      /* 对照组：单选题的字母还在。没有它，「字母被整个关掉」也是绿的。 */
      ok(/<span class="k">[A-D]<\/span>/.test(singleCard),
         '（对照）单选题的按钮仍有字母——上面那条不是「字母全没了」造成的假绿');
      /* data-k 是选项的身份，点击处理器靠它认所选项：删掉判断题就没法点了。
         （简报里那条「HTML 里没有 data-k="A"」会把判断题做废，这里反过来钉住它。） */
      ok(/data-k="A"/.test(judgeCard) && /data-k="B"/.test(judgeCard),
         '判断题的按钮仍挂着 data-k（去掉它题就点不动了）');
      /* 答案行也不能再是孤零零的字母：卡上没有叫 A 的按钮，写「答案 A」没人看得懂。 */
      ok(/<div class="ans"><span class="key">正确<\/span>/.test(judgeCard),
         '判断题的答案行写的是「正确」，不是裸字母 A');
      /* 对照：单选题的答案行照旧是字母（乱序后显示的那个）。 */
      ok(/<div class="ans"><span class="key">[A-D]<\/span>/.test(singleCard),
         '（对照）单选题的答案行照旧是字母');
    } finally {
      const i = BANK.questions.indexOf(jq);
      if (i >= 0) BANK.questions.splice(i, 1);
    }
    /* 摘干净了：后面几段装配（模考的抽题按模块配额抽）吃的还得是原来那份题库，
       合成题漏进去的话，抽题结果和这里的断言都会跟着漂。 */
    ok(BANK.questions.length === n0 && !BANK.questions.some(q => q.id === jq.id),
       `合成题已从题库里摘掉（还是 ${BANK.questions.length} 题，后面几段装配不受影响）`);
  }
}

async function mockSection() {
/* 先把 bankById 按**活**数组重挂一遍。bankById 是文件顶上照着 题库.json 建的静态表，
   而页面段里引擎吃的是 BANK.questions——那是个活数组，测试自己会往里插合成题
   （见「判断题」那段）。两边一旦对不上（合成题没摘干净），bankById[id] 就是
   undefined，下面取 .module / .answer 会**直接抛**：整段测试带崩，冒烟套件后一半
   一条断言都不跑，也就看不见本该报的那条红（MT1 实测 18 次里崩 3 次）。
   重挂一次就只是让断言红，不让异常红。干净运行时挂的每个键值都与原表逐个相同
   （同一批对象、同一个键），是空操作。 */
BANK.questions.forEach(q => { bankById[q.id] = q; });
const M = await bootMock();
const byId = M.byId, store = M.store, listeners = M.listeners, docListeners = M.docListeners;
const calls = M.fetch.calls;
const posts = p => calls.filter(c => c.path === p && c.method === 'POST');
/* 每段装配各有各的桩、各存各的监听器：firesOn 指定点的是哪一段，fires 是「这一场（M）」
   的简写。跨段点按钮若还按 M 的监听器找，一个都找不到。 */
const firesOn = (S, el, ev) => S.listeners.filter(l => l.el === el && l.t === 'click').forEach(l => l.fn(ev));
const fires = (el, ev) => firesOn(M, el, ev);
/* 真实 DOM 里 innerHTML 一重写，旧元素连同它的监听器就没了。桩里元素是同一个，
   监听器会越堆越多，所以「重新建出来的按钮」只点最后一次绑上的那个。 */
const fireLast = (el, ev) => {
  const ls = listeners.filter(l => l.el === el && l.t === 'click');
  if (ls.length) ls[ls.length - 1].fn(ev);
};
const pickOpt = k => fires(byId.mkQ, { target: { closest: sel => sel === '[data-mk]'
  ? { getAttribute: a => (a === 'data-mk' ? k : null) } : null } });
const runs = a => { let r = 0; for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1]) r++; return r; };
const wrongOf = q => ['A', 'B', 'C', 'D'].find(k => k !== q.answer);

/* ---------- 配比表 ---------- */
console.log('\n【模考 · 配比表】');
{
  /* 配比表是服务端给的（GET /api/mock 的 parts）：页面里没有第二份配比。
     下面这些断言盯的就是「渲染的是服务端那份」——页面自己写死一份的话，
     「服务端说了算」那段会红。 */
  const plan = byId.mkPlan.innerHTML;
  ok(/教育学/.test(plan) && /唐山本地政策与时政/.test(plan), '配比表列出全部模块');
  ok(/第[一二]部分 · 公共基础知识/.test(plan) && /第[一二]部分 · 教育专业能力测验/.test(plan),
     '配比表按两部分分组');
  ok((plan.match(/60 题 · 50%/g) || []).length === 2, '每部分都标出「60 题 · 50%」');
  ok(plan.indexOf('公共基础知识') < plan.indexOf('教育专业能力测验'), '配比表里公基在前');
  ok(/合计/.test(plan) && /100%/.test(plan), '有合计行');
  /* 唐山本地政策 + 校情算在公基那 60 题里，但要单独标一组，不能混在公基四个模块里 */
  ok(/class="sub"><td colspan="3">地方特色/.test(plan), '唐山/校情在配比表里单独标组');
  ok(/class="sub"><td colspan="3">地方特色[\s\S]*?唐山工业职业技术大学校情[\s\S]*?唐山本地政策与时政/.test(plan),
     '标组标题紧挨着这两行');
  ok(/人文历史与科技常识[\s\S]*?class="sub"/.test(plan),
     '标组排在公基最后一个模块之后（没插在公基模块中间）');
  /* 逐模块对题量：少一个模块、题量写错都会红 */
  const rows = [...plan.matchAll(/<tr><td>([^<]+)<\/td><td class="r">(\d+)<\/td>/g)].map(m => [m[1], +m[2]]);
  const bad = PLAN.filter(([m, n]) => !rows.some(r => r[0] === m && r[1] === n));
  ok(rows.length === PLAN.length && bad.length === 0,
     bad.length ? `配比表里对不上：${bad.map(r => r[0]).join('; ')}`
                : `${PLAN.length} 个模块的题量都照服务端那份配比列出`);
  ok(calls.some(c => c.path === '/api/mock' && c.method === 'GET'),
     '配比表是开局问服务端要的（GET /api/mock），不是页面自己带的');
  if (process.env.DUMP) console.log(byId.mkPlan.innerHTML.replace(/<tr/g, '\n<tr'));
}

/* ---------- 抽题 ---------- */
console.log('\n【模考 · 抽题】');
fires(byId.mkStart, {});
await settle();                       /* 抽题在服务端，是异步的 */
ok(byId.mkExam.hidden === false, '点「开始考试」进入答题界面');
ok(posts('/api/mock/start').length === 1,
   `抽题打的是服务端（POST /api/mock/start 发了 ${posts('/api/mock/start').length} 次）`);
const mock = M.fetch.mock.run;        /* 服务端那一场 */
ok(mock && mock.ids && mock.ids.length === 120, `服务端抽出 ${mock && mock.ids ? mock.ids.length : 0} 题（应为 120）`);
ok(new Set(mock.ids).size === 120, '120 题互不重复');
const MAIN_IDS = mock.ids;

/* 卷面分两部分：第一部分整块公基，第二部分整块教基，每块内部打乱。
   （抽题算法本身由 tests/test_server.py 的 TestMock 打真服务验；这里这几条是
     后面那些断言的**前提**——桩扮演服务端，造出来的得是一张真实形状的卷子。） */
const got = {};
mock.ids.forEach(id => { const m = bankById[id].module; got[m] = (got[m] || 0) + 1; });
const wrongMix = PLAN.filter(([m, n]) => got[m] !== n);
ok(wrongMix.length === 0,
   wrongMix.length ? `配比不符: ${wrongMix.map(([m, n]) => `${m} 要${n}得${got[m] || 0}`).join('; ')}`
                   : `${PLAN.length} 个模块的题量全部符合大纲配比（公基 60 + 教育类 60）`);
ok(PLAN.reduce((s, p) => s + p[1], 0) === 120, '配比表本身合计 120');

/* 顺序：两部分不能交错。模块若按配比表顺序排，每块内部的「模块切换次数」会等于
   模块数-1（公基 6 次、教基 4 次）；打乱后应接近块内题量。用这个把两种情况分开。 */
const partOf = {};
PARTS.forEach((P, pi) => P[1].forEach(([m]) => { partOf[m] = pi; }));
const seq = mock.ids.map(id => partOf[bankById[id].module]);
const firstEdu = seq.indexOf(1);
ok(firstEdu === 60, `第一部分正好 60 题（实际 ${firstEdu}）`);
ok(seq.slice(0, firstEdu).every(p => p === 0) && seq.slice(firstEdu).every(p => p === 1),
   '公基整块在前、教基整块在后，两部分不交错');
const mods1 = mock.ids.slice(0, 60).map(id => bankById[id].module);
const mods2 = mock.ids.slice(60).map(id => bankById[id].module);
ok(runs(mods1) > 30, `第一部分内部打乱了（模块切换 ${runs(mods1)} 次；按模块排只有 6 次）`);
ok(runs(mods2) > 25, `第二部分内部打乱了（模块切换 ${runs(mods2)} 次；按模块排只有 4 次）`);

/* ---------- 答题 ---------- */
console.log('\n【模考 · 答题】');
ok(/^\d+:\d\d$/.test(byId.mkClock.textContent), `倒计时在走：${byId.mkClock.textContent}`);
ok((byId.mkCardPanel.innerHTML.match(/data-jump="/g) || []).length === 120, '答题卡有 120 格');
/* 卷面得能看出分部分：题面上标「第几部分 + 模块」，答题卡里插分节标题 */
ok(/class="mk-part">第[一二]部分 · (公共基础知识|教育专业能力测验)</.test(byId.mkQ.innerHTML)
   && /class="mk-mod">/.test(byId.mkQ.innerHTML), '题面同时标出第几部分和具体模块');
{
  const seps = [...byId.mkCardPanel.innerHTML.matchAll(/class="mk-sep">([^<]+)</g)].map(m => m[1]);
  ok(seps.length === 2, `答题卡里有两处分节标题（实际 ${seps.length}）`);
  ok(/^第一部分/.test(seps[0] || '') && /^第二部分/.test(seps[1] || ''),
     `答题卡分节标题：${seps.join(' / ')}`);
  /* 分段是照**服务端给的 parts** 分的：分节标题必须正好插在第 60 格前面。
     页面要是自己数了别的边界（或者干脆不分段），这里就红。 */
  const chunks = byId.mkCardPanel.innerHTML.split('class="mk-sep">');
  ok((chunks[1].match(/data-jump="/g) || []).length === 60,
     `第一部分的格子直到第 60 格（实际 ${(chunks[1].match(/data-jump="/g) || []).length} 格）`);
}

const q0 = bankById[mock.ids[0]], q1 = bankById[mock.ids[1]], q2 = bankById[mock.ids[2]];
pickOpt(wrongOf(q0)); await settle();                     // 第 1 题：故意答错
fires(byId.mkNext, {}); pickOpt(q1.answer); await settle();   // 第 2 题：答对
fires(byId.mkNext, {}); pickOpt(q2.answer); await settle();   // 第 3 题：答对
ok(byId.mkDone.textContent == 3, `已答计数 = ${byId.mkDone.textContent}`);
ok(byId.mkPos.textContent === '3 / 120', `题号 = ${byId.mkPos.textContent}`);
const qHtml = byId.mkQ.innerHTML;
ok(!/class="opt (correct|wrong|dim)/.test(qHtml), '考试中不显示对错（没有 correct/wrong 样式）');
ok(/opt picked/.test(qHtml), '选中的项有 picked 标记');
ok((byId.mkCardPanel.innerHTML.match(/mk-cell done/g) || []).length === 3, '答题卡标出 3 格已答');
fires(byId.mkCardBtn, {});
ok(byId.mkCardPanel.hidden === false, '点「答题卡」能展开');

/* 键盘选答：按的是「显示字母」，存进去必须是「原始 key」。
   这里正是我写错过的地方——原来直接把显示字母存了，乱序后会整整错一位。
   现在存哪儿由服务端说了算：断言看的是这一场（服务端那份）里的作答记录。 */
fires(byId.mkNext, {}); await settle();
const dispOrder = [...byId.mkQ.innerHTML.matchAll(/data-mk="([^"]+)"/g)].map(m => m[1]);
const curId = mock.ids[3];
const kd = docListeners.find(l => l.t === 'keydown');
ok(!!kd, '键盘监听已注册');
kd.fn({ key: 'A' }); await settle();
ok((byId.mkQ.innerHTML.match(/<button class="opt picked"[^>]*data-mk="([^"]+)"/) || [])[1] === dispOrder[0],
   `按 A 选中的是显示在 A 位的那一项（原始 key ${dispOrder[0]}）`);
ok(mock.answers[curId] === dispOrder[0],
   `按 A 记进这场模考的是原始 key（${dispOrder[0]}），不是字母 A`);
kd.fn({ key: 'D' }); await settle();
ok(mock.answers[curId] === dispOrder[3],
   `按 D 记进这场模考的是显示在 D 位的原始 key（${dispOrder[3]}）`);
pickOpt(bankById[curId].answer); await settle();   /* 第 4 题答对，后面的判分才可预期 */
ok(byId.mkDone.textContent == 4, `已答计数 = ${byId.mkDone.textContent}`);

/* ---------- 交卷判分 ---------- */
console.log('\n【模考 · 交卷判分】');
fires(byId.mkSubmitBtn, {});
await settle();                       /* 交卷在服务端，是异步的 */
ok(posts('/api/mock/submit').length === 1,
   `交卷打的是服务端（POST /api/mock/submit 发了 ${posts('/api/mock/submit').length} 次）`);
const res = byId.mkResult.innerHTML;
ok(byId.mkResult.hidden === false, '交卷后显示成绩单');
ok(byId.mkExam.hidden === true, '答题界面收起');
ok(/答对 <b>3<\/b> \/ 120/.test(res), '答对 3 题（1 错 3 对）');
ok(/2\.5<em>\/ 100<\/em>/.test(res), `得分 3/120×100 = 2.5（页面显示 ${(res.match(/>([\d.]+)<em>\/ 100/) || [])[1]}）`);
ok(/唐山本地政策与时政/.test(res), '成绩单分模块列全');
ok(/第[一二]部分 · 公共基础知识/.test(res) && /第[一二]部分 · 教育专业能力测验/.test(res),
   '成绩单按部分分组');
ok((res.match(/小计/g) || []).length === 2, '每部分各有一行小计');
ok(/第一部分 · 公共基础知识[\s\S]*?小计[\s\S]*?第二部分 · 教育专业能力测验/.test(res),
   '公基部分排在教基部分前面');
ok(/class="sub"><td colspan="4">地方特色/.test(res), '成绩单里唐山/校情也单独标组');
ok(/地方特色[\s\S]*?唐山本地政策与时政[\s\S]*?小计/.test(res),
   '标组在公基小计之前（仍算在公基那 60 题里）');
const wb = JSON.parse(store['jiaokao-wrong-2026'] || '{}');
ok(wb[q0.id] === 1, `答错的 ${q0.id} 自动进错题本`);
ok(!wb[q1.id] && !wb[q2.id] && !wb[curId], '答对的没进错题本');
ok(JSON.parse(store['jiaokao-answers-2026'])[q1.id] === q1.answer, '模考成绩并入刷题记录');

/* ---------- 逐题解析（含分部分小标题） ---------- */
console.log('\n【模考 · 逐题解析】');
fires(byId.mkReview, {});
{
  ok(byId.mkRev.innerHTML.length > 0, '点「查看逐题解析」渲染出解析列表');
  ok(/<h3>第一部分 · 公共基础知识<\/h3>/.test(byId.mkRev.innerHTML),
     '第一页顶部有「第一部分 · 公共基础知识」小标题');
  ok(!/<h3>第二部分/.test(byId.mkRev.innerHTML), '第一页（40 题）还没到第二部分');
  ok((byId.mkRev.innerHTML.match(/class="qz /g) || []).length === 40, '第一页 40 题');
  /* 对错标签取的是服务端回的结果（wrong 列表）：这一场答错的是 q0 */
  ok(byId.mkRev.innerHTML.includes('错，你选'),
     '答错的题在解析里标成「错，你选 X」');

  /* 翻两页到第二部分，小标题要跟着出现。mkMore 是重写 innerHTML 建出来的，
     旧监听器在真实 DOM 里已失效，所以只点最后绑的那个。 */
  fireLast(byId.mkMore, {});
  fireLast(byId.mkMore, {});
  const rev = byId.mkRev.innerHTML;
  ok((rev.match(/class="qz /g) || []).length === 120, `翻完页共 ${(rev.match(/class="qz /g) || []).length} 题`);
  ok(/<h3>第二部分 · 教育专业能力测验<\/h3>/.test(rev), '第二部分的小标题也出来了');
  const i1 = rev.indexOf('<h3>第一部分'), i2 = rev.indexOf('<h3>第二部分');
  ok(i1 >= 0 && i2 > i1, '两个小标题的顺序是公基在前、教基在后');
  ok(/<h3>第二部分/.test(rev.slice(0, rev.indexOf('第二部分 · 教育'))) === false, '第二部分标题只出现一次');
}

/* ---------- 判分/抽题/交卷确实发生在服务端 ----------
   上面每一条都能被「页面自己抽题、自己按答案判分」骗过去：把 /api/mock/* 全删掉、
   在浏览器里 mkPick + 比答案，断言一条都不会红（任务 9 的 M4 就是这么发现的）。
   而拆页的全部意义就在于抽题和判分都归服务端独一份。所以这里专盯两件事：
     · 该发的请求有没有真的发出去（桩记了每一次请求）
     · 渲染出来的是不是**响应体**（让桩回一个和本地算法相反的结果） */
console.log('\n【模考 · 服务端说了算】');
{
  fires(byId.mkStart, {}); await settle();      /* 重开一场，验作答与交卷 */
  const run = M.fetch.mock.run;
  ok(run && Object.keys(run.answers).length === 0, '新开的一场是空卷（答案存在服务端那一场里）');

  const qid = run.ids[0], ansQ = bankById[qid];
  const n0 = posts('/api/mock/answer').length;
  pickOpt(ansQ.answer); await settle();
  const sent = posts('/api/mock/answer');
  ok(sent.length === n0 + 1, `作答让 POST /api/mock/answer 恰好发出一次（${n0} → ${sent.length}）`);
  ok(!!sent.length && sent[sent.length - 1].body
     && sent[sent.length - 1].body.qid === qid && sent[sent.length - 1].body.chosen === ansQ.answer,
     `请求体带的是这道题与所选项（${qid} → ${ansQ.answer}）`);
  ok(run.answers[qid] === ansQ.answer, `作答记在了这一场里（${qid} → ${ansQ.answer}）`);

  /* 最强的一条：桩回一个和事实相反的响应体——分数 99、答对 119、错题是刚答对的
     那一题。页面若自己算，这些数字一个都对不上。 */
  M.fetch.mock.submitOverride = {
    score: 99, right: 119, total: 120, unanswered: 1, used: 42,
    submittedAt: Date.now(), wrong: [qid],
    by_module: [{ module: ansQ.module, n: 120, right: 119 }],
  };
  fires(byId.mkSubmitBtn, {}); await settle();
  M.fetch.mock.submitOverride = null;
  const inner = byId.mkResult.innerHTML;
  /* （前提）这一题答的确实是正确答案——**两个来源**：一个是页面提交时写回本机的
     那份作答，一个是测试这份题库。不能写成 `ansQ.answer === bankById[qid].answer`
     （ansQ 就是 bankById[qid]，两边同一个对象，永远为真、怎么突变都不会红）。
     本地判分的页面绝不会把它算成错题，所以下面那条「错题本认响应体」才说明得了问题。 */
  const pageSaid = JSON.parse(store['jiaokao-answers-2026'] || '{}')[qid];
  ok(pageSaid === bankById[qid].answer,
     `（前提）${qid} 上页面记的是正确答案 ${bankById[qid].answer}（本地判分绝不会算它错）`);
  ok(/99<em>\/ 100<\/em>/.test(inner),
     `分数取的是响应体（桩回 99，页面显示 ${(inner.match(/>([\d.]+)<em>\/ 100/) || [])[1]}）`);
  ok(/答对 <b>119<\/b> \/ 120/.test(inner), '答对数也取响应体，不是页面自己数的');
  const wb2 = JSON.parse(store['jiaokao-wrong-2026'] || '{}');
  ok(wb2[qid] === 1,
     `进错题本的题号认的也是响应体（${qid} 本地判分是答对的，只有响应体说它错）`);
}

/* ---------- 没考完的那场：接着答 ---------- */
console.log('\n【模考 · 没考完接着答】');
{
  const B3 = await bootMock({ run: {
    ids: MAIN_IDS, parts: PARTS.map(([name, mods]) => ({ name, n: mods.reduce((s, m) => s + m[1], 0) })),
    answers: { [MAIN_IDS[0]]: 'A' }, i: 2,
    startedAt: Date.now() - 600e3, endsAt: Date.now() + 3600e3,
    submitted: false, submittedAt: 0,
  } });
  ok(B3.byId.mkExam.hidden === false, '有一场没考完的，回到页面直接接着答');
  ok(B3.byId.mkResult.hidden === true, '没考完就不弹成绩单');
  ok(/接着答/.test(B3.byId.mkResume.textContent),
     `设置面板上写明接着答：${B3.byId.mkResume.textContent}`);
  ok(B3.byId.mkPos.textContent === '3 / 120', `回到上次停下的那一题（${B3.byId.mkPos.textContent}）`);
  ok(B3.byId.mkDone.textContent == 1, `已答计数按存档里的那份算（${B3.byId.mkDone.textContent}）`);
  ok(B3.fetch.calls.filter(c => c.path === '/api/mock/submit').length === 0,
     '接着答不该顺手把卷子交了');
}

/* ---------- 关着页面错过交卷时间 ---------- */
console.log('\n【模考 · 页面关着时考卷过期】');
{
  /* 这条路最容易被漏掉：考试时间在用户没开页面的时候走完，回来时只能判过期。
     手动交卷和页内超时两条路都会并入成绩，这条如果忘了并入，那场的错题就永远
     进不了错题本。这里整页重启一次，只喂一场「已过期、未交卷」的卷子。 */
  const plantWrong = MAIN_IDS.slice(0, 6), plantRight = MAIN_IDS.slice(6, 9);
  const mkAns = {};
  plantWrong.forEach(id => { mkAns[id] = wrongOf(bankById[id]); });
  plantRight.forEach(id => { mkAns[id] = bankById[id].answer; });
  ok(plantWrong.length === 6 && plantRight.length === 3,
     `拿上一场的题号做存档（${plantWrong.length} 错 + ${plantRight.length} 对）`);

  const B2 = await bootMock({
    seedStore: { 'jiaokao-answers-2026': '{}', 'jiaokao-wrong-2026': '{}' },
    run: {
      ids: MAIN_IDS, parts: PARTS.map(([name, mods]) => ({ name, n: mods.reduce((s, m) => s + m[1], 0) })),
      answers: mkAns, i: 0,
      startedAt: Date.now() - 7200e3,
      endsAt: Date.now() - 60e3,        /* 一分钟前就该交卷了 */
      submitted: false, submittedAt: 0,
    },
  });

  ok(B2.fetch.calls.filter(c => c.path === '/api/mock/submit' && c.method === 'POST').length === 1,
     '过期这条也走服务端交卷（POST /api/mock/submit 发了 1 次）');
  const merged = JSON.parse(B2.store['jiaokao-answers-2026'] || '{}');
  const wbB = JSON.parse(B2.store['jiaokao-wrong-2026'] || '{}');
  ok(plantWrong.every(id => merged[id] === mkAns[id]),
     `过期存档里答错的 ${plantWrong.length} 题并入了成绩`);
  ok(plantWrong.every(id => wbB[id] === 1),
     `并进了错题本（${plantWrong.filter(id => wbB[id] === 1).length}/${plantWrong.length}）`);
  ok(!plantRight.some(id => wbB[id]), '答对的题没有误进错题本');
  ok(B2.byId.mkResult.hidden === false, '回到页面直接显示成绩单');
  ok(B2.byId.mkExam.hidden === true, '不再停在答题界面');
  const note = B2.byId.mkResult.innerHTML;
  ok(/已自动进错题本/.test(note), '成绩单上写明了错题已进错题本');
  ok(new RegExp('答错的 <b>' + plantWrong.length + '</b>').test(note),
     `成绩单上的错题数 = ${plantWrong.length}`);
}

/* ---------- 配比表真来自服务端（换个配比，页面就得跟着变） ----------
   上面「配比表」那段里的数字（120 / 60 / 50%）与页面里若有一份写死的表**恰好**
   一样，所以那些断言分辨不出「照服务端渲染」和「页面写死」。这里喂一份现实中
   不存在的配比（两部分 6 + 2 题、名字带「合成」），页面要还是 120/60/50%，
   就说明它根本没读服务端那份。 */
console.log('\n【模考 · 配比照服务端那份渲染】');
{
  const SYNTH = [
    ['合成甲', [['教育学', 6]]],
    ['合成乙', [['人文历史与科技常识', 2]]],
  ];
  const S2 = await bootMock({ ratio: SYNTH });
  const plan = S2.byId.mkPlan.innerHTML;
  ok(/第[一二]部分 · 合成甲/.test(plan) && /第[一二]部分 · 合成乙/.test(plan),
     '配比表里的部分名照服务端给的那份写');
  ok(/6 题 · 75%/.test(plan) && /2 题 · 25%/.test(plan),
     `每部分的题量与占比按服务端那份算（8 题的 6/2）`);
  /* 认死了合计那一行：`<td class="r">8</td>` 这种写法在模块行里也出现（公文写作就是 8 题），
     不锚定 <tr class="sum"> 的话，写死 120 的页面照样能骗过这条。 */
  ok(/<tr class="sum"><td>合计<\/td><td class="r">8<\/td>/.test(plan),
     '合计 = 服务端的 8 题（不是页面写死的 120）');

  firesOn(S2, S2.byId.mkStart, {}); await settle();
  const grid = S2.byId.mkCardPanel.innerHTML;
  ok((grid.match(/data-jump="/g) || []).length === 8,
     `答题卡按服务端的 8 题排（实际 ${(grid.match(/data-jump="/g) || []).length} 格）`);
  ok((grid.match(/class="mk-sep">/g) || []).length === 2, '两部分各有一个分节标题');
  ok(/class="mk-part">第[一二]部分 · 合成甲</.test(S2.byId.mkQ.innerHTML)
     || /class="mk-part">第[一二]部分 · 合成乙</.test(S2.byId.mkQ.innerHTML),
     '题面上的部分名也来自服务端');
  firesOn(S2, S2.byId.mkSubmitBtn, {}); await settle();
  ok(/答对 <b>0<\/b> \/ 8/.test(S2.byId.mkResult.innerHTML),
     '成绩单的总题数也是服务端那份（8）');
}
}

/* ---------- 练兵版：含判断/多选的开关 ----------
   真库里 0 道判断、0 道多选（这是本项目的实情），所以这一段照「错题本」那段的
   办法造**合成题**插在 BANK 头上：抽题算法（谁被抽中、每个模块配比怎么算）由
   tests/test_server.py 打真服务验，这里只验页面能做到的——开关、配比表换成
   partsWithTypes 那份、withTypes 有没有带给服务端、判断题与多选题在题面与
   成绩单上怎么画。 */
async function mockTypesSection() {
  const jq = { id: 'test-mt-j', n: 9901, module: '教育学', section: '教育专业能力测验',
               type: 'judge', stem: '练兵版合成判断题干', answer: 'A', explanation: '故选 A。',
               options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }] };
  const mq = { id: 'test-mt-m', n: 9902, module: '教育学', section: '教育专业能力测验',
               type: 'multi', stem: '练兵版合成多选题干', answer: 'ABD', explanation: '故选 ABD。',
               options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' },
                         { key: 'C', text: '丙' }, { key: 'D', text: '丁' }] };
  const n0 = BANK.questions.length, rnd0 = Math.random;
  BANK.questions.unshift(jq, mq);
  bankById[jq.id] = jq; bankById[mq.id] = mq;

  const firesOn = (S, el, ev) => S.listeners.filter(l => l.el === el && l.t === 'click')
                                           .forEach(l => l.fn(ev));
  /* 开关挂的是 change（见 mock.js 里那段说明）。 */
  const fireCh = (S, on) => S.listeners.filter(l => l.el === S.byId.mkPlan && l.t === 'change')
    .forEach(l => l.fn({ target: { closest: sel =>
      sel === '[data-mktypes]' ? { checked: on } : null } }));
  const pick = (S, k) => firesOn(S, S.byId.mkQ, { target: { closest: sel => sel === '[data-mk]'
    ? { getAttribute: a => (a === 'data-mk' ? k : null) } : null } });
  /* 成绩单里第 i 张卡（0 是 preamble）。split 是按分隔符切开的，parts[1] 正好
     只有第一张卡的内容，不会把后面的卡也带进来。 */
  const card = (html, i) => html.split('<div class="qz ')[i] || '';
  /* 卡片里每个选项按钮：类名 / 显示字母（判断题为空）/ 选项文字。 */
  const optsOf = c => [...c.matchAll(
    /<button class="([^"]*)" type="button" disabled>(?:<span class="k">([A-D])<\/span>)?<span class="t">([^<]*)<\/span>/g)]
    .map(m => ({ cls: m[1], letter: m[2] || '', text: m[3] }));
  const texts = (c, word) => optsOf(c).filter(o => o.cls.split(' ').indexOf(word) >= 0)
    .map(o => o.text).sort().join('、');

  console.log('\n【练兵版 · 开关与配比表】');
  {
    const S = await bootMock();
    const plan = () => S.byId.mkPlan.innerHTML;
    const starts = () => S.fetch.calls.filter(c => c.path === '/api/mock/start' && c.method === 'POST');
    ok(/data-mktypes="1"/.test(plan()), '配比表里渲染出「含多选/判断（练兵）」开关');
    ok(!/checked/.test(plan()), '开关默认不勾（默认还是标准版）');
    ok(!/class="tn"/.test(plan()), '没勾时配比表不写各题型题量');
    /* 不勾就开考：withTypes 必须是 false（写死 true 的话这里红）。 */
    firesOn(S, S.byId.mkStart, {}); await settle();
    ok(starts().length === 1 && starts()[0].body.withTypes === false,
       `不勾时开考请求里 withTypes=false（实际 ${JSON.stringify(starts()[0] && starts()[0].body)}）`);

    fireCh(S, true);
    const p2 = plan();
    ok(/data-mktypes="1" checked/.test(p2), '勾上之后开关自己也是勾着的');
    /* 教育学的配额是 23：每 6 道出 1 判 1 多（server.py 的 MK_TYPE_SPLIT），
       所以是 判 3 · 多 3 · 单 17。**这个数只能来自服务端 partsWithTypes**——
       页面里没有任何一处 quota 或 //6 的算法。 */
    const tn = p2.match(/<td>教育学<span class="tn">([^<]*)<\/span>/);
    ok(!!tn && tn[1] === '判 3 · 多 3 · 单 17',
       `练兵版配比表带各题型题量、数是服务端那份（教育学那行实际：${tn ? tn[1] : '没写题型题量'}）`);
    firesOn(S, S.byId.mkStart, {}); await settle();
    ok(starts().length === 2 && starts()[1].body.withTypes === true,
       `勾上后开考请求里 withTypes=true（实际 ${JSON.stringify(starts()[1] && starts()[1].body)}）`);

    fireCh(S, false);
    ok(!/class="tn"/.test(plan()), '取消勾选又换回标准版那份配比表');
    ok(/data-mktypes="1"(?! checked)/.test(plan()), '取消后开关也不勾了');
  }

  console.log('\n【练兵版 · 判断题与多选题】');
  {
    /* 直接喂一场指定卷子（ids 里只有合成的那两道）：抽题本身不在这里验。 */
    const now = Date.now();
    const run = { ids: [jq.id, mq.id], parts: [{ name: '第X部分 · 合成', n: 2 }],
                  answers: {}, i: 0, withTypes: true,
                  startedAt: now, endsAt: now + 3600000, submitted: false, submittedAt: 0 };
    /* 固定乱序，下面「答案行的字母是换过的」才有牙（不乱序时它和原样一样，
       突变也测不出红）。shuffledOpts 是懒算并缓存的，这时这道多选还没算过。 */
    Math.random = () => 0;
    const S = await bootMock({ run });
    const answers = S.fetch.mock.run.answers;
    /* 键盘监听由 mock.js 自己在装载时挂上（mockSection 里已有断言钉着它），
       这里直接用；挂不上时这一节会抛，整轮跑不出 ✅（与断言红同一个后果）。 */
    const kd = S.docListeners.filter(l => l.t === 'keydown')[0];

    /* ---- 判断题：不打乱、不标字母，点一下就记一个字母 ---- */
    const jh = S.byId.mkQ.innerHTML;
    ok(!/<span class="k">/.test(jh), '判断题的按钮上没有 A/B 字母');
    ok(/<span class="t">正确<\/span>[\s\S]*<span class="t">错误<\/span>/.test(jh),
       '判断题的选项照原序（正确在前、错误在后），没被打乱');
    ok(!/picked/.test(jh), '刚进来判断题还没作答');
    pick(S, 'B'); await settle();
    ok(answers[jq.id] === 'B',
       `判断题点一下就记一个字母（实际 ${answers[jq.id] === undefined ? '没记' : answers[jq.id]}）`);

    /* ---- 多选题：点一下是勾选、再点是取消，攒成一串字母 ---- */
    firesOn(S, S.byId.mkNext, {}); await settle();
    const mh = () => S.byId.mkQ.innerHTML;
    const disp = S.shuffledOpts(mq).map(o => o.key);
    ok(disp.join('') !== 'ABCD', `（前提）这道多选确实被打乱了：显示顺序 ${disp.join('')}`);
    ok(!/picked/.test(mh()), '多选题刚进来一项都没勾');
    pick(S, 'A'); await settle();
    ok(answers[mq.id] === 'A',
       `多选点一下只勾选（记进这一场的是 ${answers[mq.id] === undefined ? '空' : "'" + answers[mq.id] + "'"}）`);
    ok(/class="opt picked"[^>]*data-mk="A"/.test(mh()), '勾上的那一项带 picked 标记');
    pick(S, 'C'); await settle();
    ok(answers[mq.id] === 'AC',
       `再勾一项是**累积**成 'AC'，不是顶掉前一个（实际 ${answers[mq.id]}）`);
    ok((mh().match(/picked/g) || []).length === 2, '两项都标着勾选');
    pick(S, 'C'); await settle();
    ok(answers[mq.id] === 'A', `再点一下取消勾选（只加不减的错法在这里红）（实际 ${answers[mq.id]}）`);
    /* 键盘走的也是累积那条路：按的是显示字母，存进去是原始 key。 */
    const pos = disp.findIndex(k => k !== 'A');
    kd.fn({ key: 'ABCD'.charAt(pos) }); await settle();
    ok(answers[mq.id] === ['A', disp[pos]].sort().join(''),
       `键盘也能勾多选（按 ${'ABCD'.charAt(pos)} → 原始 key ${disp[pos]}，实际 ${answers[mq.id]}）`);
    kd.fn({ key: 'ABCD'.charAt(pos) }); await settle();
    ok(answers[mq.id] === 'A', '键盘再按一下也能取消勾选');
    pick(S, 'C'); await settle();
    ok(answers[mq.id] === 'AC', `攒到 'AC'（实际 ${answers[mq.id]}）`);

    /* ---- 交卷：成绩单 ---- */
    firesOn(S, S.byId.mkSubmitBtn, {}); await settle();
    /* 逐题解析是点开来才渲染的（成绩单里那一格这时还空着）。 */
    firesOn(S, S.byId.mkReview, {});
    const res = S.byId.mkResult.innerHTML;
    ok(/练兵版 · 含判断\/多选/.test(res), '成绩单上标出这一场是练兵版');
    ok(!/标准版 · 全单选/.test(res), '练兵版不会同时标成标准版');

    /* 逐题解析渲染进 #mkRev（桩里就是它自己那格，不像真 DOM 能把子节点的
       innerHTML 带出来——所以卡片要从 mkRev 里取）。 */
    const rev = S.byId.mkRev.innerHTML;
    ok(rev.length > 0, '点「查看逐题解析」渲染出解析列表');
    const jo = card(rev, 1), mo = card(rev, 2);
    /* 判断题：不标字母，「你选/答案」都写选项文字 */
    ok(!/<span class="k">/.test(jo), '成绩单上判断题的按钮也没有字母');
    ok(/错，你选 错误/.test(jo), '判断题的「你选」写的是选项文字「错误」，不是字母');
    ok(/<span class="key">正确<\/span>/.test(jo), '判断题的答案行写的是「正确」那一项的文字');
    ok(texts(jo, 'correct') === '正确', `判断题标绿的是「正确」那一项（实际 ${texts(jo, 'correct') || '无'}）`);
    ok(texts(jo, 'wrong') === '错误', `判断题把选错的「错误」标红（实际 ${texts(jo, 'wrong') || '无'}）`);

    /* 多选题 —— 本任务最要紧的一条：**多选下必须有选项被标绿**。
       页面上那几个绿是从「这一项在不在答案串里」来的；写成 o.key === q.answer
       的话 'A' === 'ABD' 恒假，四个选项一个都不会绿（派工单 (C) 表 :262）。 */
    ok(texts(mo, 'correct') === ['甲', '乙', '丁'].sort().join('、'),
       `多选的正确项都标了绿（实际 ${texts(mo, 'correct') || '无'}）`);
    ok(texts(mo, 'wrong') === '丙', `选错的那一项标红（实际 ${texts(mo, 'wrong') || '无'}）`);
    ok(texts(mo, 'dim') === '', `漏选的项不额外标灰（这道错在选错，不在漏选）（实际 ${texts(mo, 'dim') || '无'}）`);
    /* 答案行 / 「你选」的字母都要按乱序后的**显示位置**换过，且三个字母都给全。 */
    const shown = keys => [...keys].map(k => 'ABCD'.charAt(disp.indexOf(k))).sort().join('');
    const wantAns = shown(mq.answer), wantChosen = shown('AC');
    ok(wantAns !== 'ABD', `（前提）乱序后答案行的字母不是原样 'ABD'（实际 '${wantAns}'）`);
    ok((mo.match(/<span class="key">([A-D]+)<\/span>/) || [])[1] === wantAns,
       `多选答案行给全三个字母、且按显示位置换过（应为 '${wantAns}'，实际 '${(mo.match(/<span class="key">([A-D]+)<\/span>/) || [])[1] || '无'}'）`);
    ok(new RegExp('错，你选 ' + wantChosen).test(mo),
       `多选的「你选」也是按显示位置换过的字母串（应为 '${wantChosen}'）`);
  }

  /* 摘干净：合成题是 unshift 进去的，从**头上**切；乱序也调回原样。 */
  Math.random = rnd0;
  BANK.questions.splice(0, 2);
  ok(BANK.questions.length === n0 && !BANK.questions.some(q => q.id === jq.id || q.id === mq.id),
     `合成题已从题库里摘掉（还是 ${BANK.questions.length} 题，后面几段装配不受影响）`);

  /* 摘掉之后题库又回到真库的样子：1000 题全单选。这时**界面不许承诺卷子里
     没有的题型**——练兵版开关根本不出现（配比表于是也不可能写「判 X · 多 Y」）。
     把 mock.js 的 mkHasTypes() 改成恒 true、或拆掉 mkRenderPlan 里的
     if (hasTypes) 守卫，下面这条立刻红。 */
  console.log('\n【练兵版 · 题库没有判断/多选时不承诺】');
  {
    const S = await bootMock();
    const plan = S.byId.mkPlan.innerHTML;
    ok(!/data-mktypes/.test(plan), '题库里没有判断/多选时，练兵版开关不出现（不承诺没有的题型）');
  }
  {
    /* 存档上写着 withTypes:true（题库换过、这一场是先前开的），题库里却一道
       判断/多选都没有——成绩单也不许印「练兵版 · 含判断/多选」。
       把 mkRenderResult 里那句的 && mkHasTypes() 拆掉，这条立刻红。 */
    const now = Date.now();
    const run = { ids: [BANK.questions[0].id], parts: [{ name: '第X部分 · 合成', n: 1 }],
                  answers: {}, i: 0, withTypes: true, startedAt: now,
                  endsAt: now + 3600000, submitted: false, submittedAt: 0 };
    const S = await bootMock({ run });
    firesOn(S, S.byId.mkSubmitBtn, {}); await settle();
    const res = S.byId.mkResult.innerHTML;
    ok(/标准版 · 全单选/.test(res) && !/练兵版/.test(res),
       '题库没有判断/多选时，成绩单不印「练兵版 · 含判断/多选」');
  }
}

/* ---------- 首页：入口卡片 + 导入旧版记录 ---------- */
async function homeSection() {
  const A = 'jiaokao-answers-2026', W = 'jiaokao-wrong-2026';
  const M = 'jiaokao-migrated-2026';
  /* 按钮由 home.js 建出来塞进 #quick，页面 HTML 里没有它——桩里按 id 找
     （真实 DOM 里就是 getElementById('legacyImport')）。 */
  const btnOf = S => (S.byId.quick.children || []).find(c => c.id === 'legacyImport') || null;
  const fires = (S, el, ev) => S.listeners.filter(l => l.el === el && l.t === 'click')
                                           .forEach(l => l.fn(ev));
  const text = el => el.innerHTML.replace(/<[^>]*>/g, '');
  /* 两个真题号 + 两个死题号：死的那两个正是「上一代题库」的形态。 */
  const SEED_A = { e1: 'A', e10: 'D', p16: 'A', 'zz-旧-1': 'A' };
  const SEED_W = { e1: 1, 'zz-旧-2': 1 };
  const seedBoth = () => ({ [A]: JSON.stringify(SEED_A), [W]: JSON.stringify(SEED_W) });

  console.log('\n【首页 · 入口卡片】');
  {
    const H = await bootHome({});
    const links = H.byId.quick.innerHTML.match(/<a href="[^"]+">/g) || [];
    ok(links.length === window.NAV.length,
       `入口卡片按 NAV 渲染（${links.length} / ${window.NAV.length} 张）`);
    ok(links.length > 0 && links[0] === '<a href="index.html">',
       `第一张卡片走的是 n.href（不是「id 拼 .html」）：${links[0]}`);
  }

  console.log('\n【首页 · 导入旧版记录】');
  {
    /* 显示条件是「两个映射里至少一个非空」+「本机还没迁过」。
       不能拿「key 在不在」当条件：新刷题页/模考页写的正是同一对 key，每个刷过题
       的新用户都会永远看到这个按钮（C89）。 */
    const none = await bootHome({});
    ok(!btnOf(none), '两个 key 都没有时不建按钮');
    const onlyA = await bootHome({ seedStore: { [A]: '{"e1":"A"}' } });
    ok(!!btnOf(onlyA), '只有作答 key、但里面有东西时也建按钮');
    const onlyW = await bootHome({ seedStore: { [W]: '{"e1":1}' } });
    ok(!!btnOf(onlyW), '只有错题 key、但里面有东西时也建按钮');

    /* 新页面自己写出来的「没有旧记录」就是这个样子（两个空表，见 quiz.js /
       mock.js 的 persist）：一个空表都没得导，按钮不该出现。 */
    const empties = await bootHome({ seedStore: { [A]: '{}', [W]: '{}' } });
    ok(!btnOf(empties), '两个 key 都在、但两张空表时不建按钮（新页面写的就是这个）');

    /* 迁过一次就不再打扰：标记在，旧记录还在也不建按钮。 */
    const marked = await bootHome({ seedStore: Object.assign(seedBoth(), { [M]: '1' }) });
    ok(!btnOf(marked), '本机迁过一次后（标记在）不再建按钮');

    /* 存的内容坏了：当没有旧记录，首页剩下的部分照样渲染完（不能整段抛在这儿）。
       「不是 JSON」「是 JSON 但不是对象」「是数组」三种都要挡——`typeof []` 也是
       'object'，少了数组这一条，JSON.parse('[1,2]') 会一路过到 POST 出去。 */
    const broken = await bootHome({ seedStore: { [A]: '不是 json', [W]: '{}' } });
    ok(!btnOf(broken), '旧记录不是 JSON 时不建按钮');
    const notObj = await bootHome({ seedStore: { [A]: '"一串字"', [W]: '{"e1":1}' } });
    ok(!btnOf(notObj), '旧记录解出来不是对象时也不建按钮');
    const arr = await bootHome({ seedStore: { [A]: '[1,2]', [W]: '{"e1":1}' } });
    ok(!btnOf(arr), '旧记录解出来是数组时也不建按钮（Array.isArray 那一条）');
    ok(broken.byId.quick.innerHTML.includes('href="quiz.html"'),
       '旧记录坏了，入口卡片照样渲染出来');

    /* 有旧记录：按钮上要写明本机有多少条（导之前先让用户知道导什么） */
    const S = await bootHome({ seedStore: seedBoth() });
    const btn = btnOf(S);
    ok(!!btn, '有旧记录时建出按钮');
    ok(!!btn && /4 条作答/.test(btn.innerHTML) && /2 条错题/.test(btn.innerHTML),
       `按钮上写明本机存了多少条（${btn ? text(btn) : '—'}）`);

    fires(S, btn, {});
    await settle();
    const sent = S.fetch.calls.filter(c => c.path === '/api/migrate/legacy' && c.method === 'POST');
    ok(sent.length === 1, `点一下发一次 POST /api/migrate/legacy（发了 ${sent.length} 次）`);
    ok(!!sent.length && !!sent[0].body
       && JSON.stringify(sent[0].body.answers) === JSON.stringify(SEED_A)
       && JSON.stringify(sent[0].body.wrong) === JSON.stringify(SEED_W),
       '请求体是解析开的两个映射，不是 localStorage 里的原始字符串');
    /* 结果照响应体报：桩按「题库里有没有这个题号」算，两个死题号被跳过。
       跳过的说明必须把两种原因都写出来（题号不在库里 / 记录不是选中的选项），
       只写前者的话，记录写成 {"e1":1} 的人会去查一个不存在的题库换代问题。 */
    ok(!!btn && /已导入 3 条/.test(btn.innerHTML)
       && /2 条对不上现在的题库/.test(btn.innerHTML)
       && /记录不是选中的选项/.test(btn.innerHTML),
       `导入结果照响应体报（${btn ? text(btn) : '没有按钮'}）`);
    ok(!!btn && btn.disabled === true, '导完按钮禁用，防连点发两遍');
    ok(global.localStorage.getItem(M) === '1',
       `导成功后本机记上迁移标记（标记=${global.localStorage.getItem(M)}）`);

    /* 服务器上已经有的题号：报「已经有了」，不是「跳过」，也不是「已导入」。
       先让服务器真的有一条 e1 的作答行（走同一个桩的 POST /api/attempts）。 */
    const S4 = await bootHome({ seedStore: seedBoth() });
    const e1 = BANK.questions.find(q => q.id === 'e1');
    await global.fetch('/api/attempts', { method: 'POST',
      body: JSON.stringify({ qid: 'e1', chosen: e1.answer }) });
    const b4 = btnOf(S4);
    if (b4) fires(S4, b4, {});
    await settle();
    /* e1 服务器已有 → existing 1；e10、p16 新的 → imported 2；两个死题号 → skipped 2 */
    ok(!!b4 && /已导入 2 条/.test(b4.innerHTML)
       && /1 条服务器上已经有了/.test(b4.innerHTML),
       `服务器已有的题号单算一档（${b4 ? text(b4) : '没有按钮'}）`);

    /* 更强的一条：桩回一个和本机对不上的 7/3/5，页面若自己数（4 条作答）就对不上 */
    const S2 = await bootHome({ seedStore: seedBoth() });
    S2.fetch.migrate = { imported: 7, skipped: 3, existing: 5 };
    const b2 = btnOf(S2);
    if (b2) fires(S2, b2, {});
    await settle();
    ok(!!b2 && /已导入 7 条/.test(b2.innerHTML) && /3 条对不上/.test(b2.innerHTML)
       && /5 条服务器上已经有了/.test(b2.innerHTML),
       `结果取的是响应体（桩回 7/3/5，页面显示 ${b2 ? text(b2) : '没有按钮'}）`);

    /* 失败：服务端那句原话要显示出来，而且还能再点 */
    const S3 = await bootHome({ seedStore: seedBoth() });
    S3.fetch.migrateFail = '服务端说这次不行';
    const b3 = btnOf(S3);
    if (b3) fires(S3, b3, {});
    await settle();
    ok(!!b3 && b3.disabled === false, '导入失败后按钮恢复可点（能重试）');
    ok(!!b3 && /导入失败：服务端说这次不行/.test(b3.innerHTML),
       `失败原因照服务端那句显示（${b3 ? text(b3) : '没有按钮'}）`);
    /* 没导成就不该记标记——记了的话这份旧记录以后永远导不进去了。 */
    ok(global.localStorage.getItem(M) === null,
       `导入失败不记迁移标记（标记=${global.localStorage.getItem(M)}）`);
  }
}

/* ---------- 错题本页（任务 15） ----------
   真库 1000 题全是单选、也没有多选和判断（那两类只在合成题里有），所以
   「你选 AC，正确 ABD」这条只能在合成题上盖——**别去真库里找多选题**，找不到是对的。
   合成题临时插在 BANK 最前面（GET /api/wrong 的桩按 BANK 拼题目字段），
   断言完 try/finally 摘掉，后面的装配吃的还得是原来那份题库。 */
async function wrongSection() {
  /* 事件是从 wrongRoot 上挂的那一个监听器派下去的；桩里没有真正的事件冒泡，
     所以用例自己造 target，让 closest 只对「要找的那个选择器」回话。 */
  const firesOn = (S, el, ev) => S.listeners.filter(l => l.el === el && l.t === 'click')
                                            .forEach(l => l.fn(ev));
  const listOf = S => S.byId.wrongRoot.innerHTML;
  const cards = h => (h.match(/data-card="/g) || []).length;
  const cardOf = (h, id) => h.split('<div class="qz').slice(1)
                              .find(c => c.includes('data-card="' + id + '"')) || '';
  /* 点了哪个选项 / 哪个按钮：桩里 closest 由用例自己给。 */
  const clickOpt = (S, id, k) => firesOn(S, S.byId.wrongRoot, { target: { closest: sel => sel === '.opt'
    ? { disabled: false, getAttribute: a => (a === 'data-wq' ? id : k) } : null } });
  const clickOn = (S, attr, id) => firesOn(S, S.byId.wrongRoot, { target: { closest: sel => sel === '[' + attr + ']'
    ? { disabled: false, getAttribute: a => (a === attr ? id : null) } : null } });

  /* 九道同答案的合成单选 + 一道多选 + 一道判断。九道是给「解析原样」那条用的：
     选项乱序是**每题随机**洗一次的，只有一道题时恰好洗成原序（1/24 的机会）会让
     那条变成假绿；九道全洗成原序的概率 (1/24)^9，等于不会发生。 */
  const mkS = i => ({ id: 'test-ws' + i, n: 9800 - i, module: '教育学', type: 'single',
                      stem: '错题题干' + i,
                      options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' },
                                { key: 'C', text: '丙' }, { key: 'D', text: '丁' }],
                      answer: 'B', explanation: '故选 B。' });
  const sqs = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(mkS);
  const mq = { id: 'test-wm0', n: 9900, module: '教育学', type: 'multi', stem: '错题本多选题干',
               options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' },
                         { key: 'C', text: '丙' }, { key: 'D', text: '丁' }],
               answer: 'ABD', explanation: '故选 A。' };
  /* 判断题给 2 次（不是 1）：筛选门槛那条要有一道「恰好错 2 次」的题才测得动——
     全是错 1 次和 3 次时，`>=2` 写成 `>=3` 结果一样，那条断言就成了摆设。 */
  const jq = { id: 'test-wj0', n: 9901, module: '公共基础 · 法律', type: 'judge', stem: '错题本判断题干',
               options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }],
               answer: 'A', explanation: '判断题解析' };
  /* 服务端那份错题的顺序（server.py 是 last_at 倒序）。判断先、多选后、再单选题：
     模块是连着的两块，好让「按模块分组」有一个确定的期望；顺序**就是**服务端
     回来的顺序，页面不另排（下面那条断言盯着这件事）。 */
  const SEED = [{ qid: jq.id, chosen: 'B', wrong_count: 2 },
                { qid: mq.id, chosen: 'AC', wrong_count: 2 }]
    .concat(sqs.map((q, i) => ({ qid: q.id, chosen: 'A', wrong_count: i % 2 ? 3 : 1 })));
  const n0 = BANK.questions.length;
  const ADDED = 2 + sqs.length;
  BANK.questions.unshift(mq, jq, ...sqs);
  const IN = { mq, jq, sqs };

  console.log('\n【错题本 · 渲染】');
  {
    const S = await bootWrong({ wrong: SEED });
    const h = listOf(S);
    const posts = p => S.fetch.calls.filter(c => c.path === p && c.method === 'POST');
    /* 服务端那份错题是取回来的：一条都没发请求 / 请求打错端点，这里立刻红。 */
    ok(S.fetch.calls.some(c => c.path === '/api/wrong' && c.method === 'GET'),
       '错题本是开局问服务端要的（GET /api/wrong），不是页面自己带的');
    ok(cards(h) === SEED.length,
       `服务端回的 ${SEED.length} 道错题都渲染出来了（实际 ${cards(h)}）`);

    /* **本任务的硬要求**：多选题要显示「你选 AC，正确 ABD」。 */
    const cm = cardOf(h, mq.id);
    ok(cm.includes('你选 AC，正确 ABD'),
       `多选题显示「你选 AC，正确 ABD」（实际那一行：${(cm.match(/<p class="wmeta">([^<]*)</) || [])[1] || '无'}）`);
    ok(cm.includes('错了 2 次'), '多选题标出错了几次');
    /* 选项按原始顺序排、correct/wrong 各标在哪一项：
       A 在答案里（correct）、C 选过但错了（wrong）、B/D 是答案（correct）。 */
    const pairs = [...cm.matchAll(/class="opt ([^"]+)"[^>]*data-wk="([^"]+)"/g)]
      .map(m => m[2] + ':' + m[1]).sort().join(',');
    ok(pairs === 'A:correct,B:correct,C:wrong,D:correct',
       `多选题的选项着色按答案与错选算（实际 ${pairs}）`);

    /* 判断题：不标 A/B（和刷题页同一套），那一行改用选项文字。 */
    const cj = cardOf(h, jq.id);
    ok(!/<span class="k">/.test(cj), '判断题的按钮上没有 A/B 字母');
    ok(cj.includes('你选 错误，应选 正确'),
       `判断题显示「你选 错误，应选 正确」（实际：${(cj.match(/<p class="wmeta">([^<]*)</) || [])[1] || '无'}）`);

    /* **不洗牌、不调 remapExplain**：选项顺序是原始的 A/B/C/D，解析逐字节原样。
       只调 remapExplain 不洗牌（只做一半）时，它会现建一张乱序表把「故选 B」
       里的字母换掉——这两条里至少有一条会红。 */
    const badOrder = IN.sqs.filter(q => {
      const c = cardOf(h, q.id);
      const keys = [...c.matchAll(/data-wk="([^"]+)"/g)].map(m => m[1]).join('');
      return keys !== 'ABCD';
    });
    ok(badOrder.length === 0,
       badOrder.length ? `选项没按原始顺序排：${badOrder.map(q => q.id).join(',')}`
                       : `${IN.sqs.length} 道单选题的选项都按原始顺序（A/B/C/D）排，没有洗牌`);
    const badExp = IN.sqs.filter(q => cardOf(h, q.id).indexOf('故选 B。') < 0);
    ok(badExp.length === 0,
       badExp.length ? `解析被改了（remapExplain 被调过一次？）：${badExp.map(q => q.id).join(',')}`
                     : `${IN.sqs.length} 道题的解析逐字节原样渲染（错题本不洗牌，也就没调 remapExplain）`);
    const expM = (cm.match(/<div class="ans">([\s\S]*?)<\/div>/) || [])[1];
    ok(expM === '故选 A。', `多选题的解析也原样渲染（实际「${expM}」）`);

    /* 按模块分组：连着的一段同一个模块给一个标题。标题顺序、以及卡片顺序，
       都跟着服务端回来的顺序走，页面不另排一遍（本地再排一次就是第二份真相，
       而且「最近错的在最前面」这个排序只有服务端知道）。 */
    const hs = [...h.matchAll(/<h3>([^<]+)<\/h3>/g)].map(m => m[1]);
    ok(hs.join('|') === '公共基础 · 法律|教育学',
       `按模块分组，标题跟着服务端的顺序（实际 ${hs.join(' / ')}）`);
    const order = [...h.matchAll(/data-card="([^"]+)"/g)].map(m => m[1]);
    ok(order.join(',') === SEED.map(w => w.qid).join(','),
       '卡片顺序就是服务端回来的顺序（页面没有本地再排一次）');

    /* 「标记已订正」：打的是 resolve 端点，打完之后这一题不再出现在列表里。
       这是能把 resolve 那条路测死的唯一一条断言。 */
    const p0 = posts('/api/wrong/test-wm0/resolve').length;
    clickOn(S, 'data-resolve', mq.id); await settle();
    ok(posts('/api/wrong/test-wm0/resolve').length === p0 + 1,
       '点「标记已订正」打的是 POST /api/wrong/<qid>/resolve');
    const h2 = listOf(S);
    ok(cardOf(h2, mq.id) === '' && cards(h2) === SEED.length - 1,
       `标记订正后这一题不再出现（${cards(h2)} 题，应为 ${SEED.length - 1}）`);
    ok(S.fetch.wrongRows.get(mq.id).resolved === true, '库里那行是 resolved=1（留着历史，不是删掉）');
    /* 别的题不受影响：把整个列表清空也满足上面那条，这条挡住它。 */
    ok(cardOf(h2, jq.id) !== '' && cardOf(h2, sqs[0].id) !== '', '别的错题还留着（没有整页清空）');

    /* 「重做这道题」：点选项 → POST /api/attempts（判分在服务端），做对了就消失。 */
    const right = sqs[0];                       /* 答案是 B */
    clickOpt(S, right.id, 'B'); await settle();
    ok(posts('/api/attempts').some(c => c.body && c.body.qid === right.id && c.body.chosen === 'B'),
       `点选项重做打的是 POST /api/attempts（${right.id} → B）`);
    const h3 = listOf(S);
    ok(cardOf(h3, right.id) === '', '做对了的题从错题本里消失（resolved=1）');
    ok(cards(h3) === SEED.length - 2, `错题本少了这一道（${cards(h3)} 题）`);

    /* 又答错：题留着，错次 +1，而且在那一行里读得出来。 */
    const still = sqs[1];                       /* 答案是 B，序号 1 → 错次 3 */
    clickOpt(S, still.id, 'A'); await settle();
    const h4 = listOf(S);
    ok(cardOf(h4, still.id) !== '', '又答错的题留在错题本里');
    ok(cardOf(h4, still.id).includes('错了 4 次'),
       `又错一次错次 +1（实际那一行：${(cardOf(h4, still.id).match(/<p class="wmeta">([^<]*)</) || [])[1] || '无'}）`);

    /* 「只显示错 2 次以上」：勾上只剩错次 >= 2 的题，取消就回来。
       期望值从**筛选题本身的定义**（还没订正、错次 >= 2）现算，不照着实现那行
       抄——门槛被改成 >=3 时两边才会分家（fixture 里因此特意留了一道恰好错 2 次的判断）。 */
    const want2 = S.fetch.wrongRows;
    const live2 = qid => want2.get(qid);
    const expect2 = SEED.filter(w => !live2(w.qid).resolved
                                     && live2(w.qid).wrong_count >= 2).length;
    firesOn(S, S.byId.wrongRoot, { target: { closest: sel => sel === '[data-wonly2]'
      ? { checked: true } : null } });
    const h5 = listOf(S);
    ok(cards(h5) === expect2, `「只显示错 2 次以上」只剩 ${cards(h5)} 题（应为 ${expect2}）`);
    ok(IN.sqs.every(q => !(want2.get(q.id).wrong_count < 2 && cardOf(h5, q.id) !== '')),
       '错 1 次的题都被筛掉了');
    firesOn(S, S.byId.wrongRoot, { target: { closest: sel => sel === '[data-wonly2]'
      ? { checked: false } : null } });
    ok(cards(listOf(S)) === cards(h4), '取消勾选后回到全部');
  }

  console.log('\n【错题本 · 多选题重做】');
  {
    /* 多选题的重做和刷题页同一套：点选项只切换勾选，「确认作答」才交。
       要按服务端的判分（少选算错）走——所以勾 AC（答案是 ABD）该判错。 */
    const S = await bootWrong({ wrong: [{ qid: mq.id, chosen: 'AC', wrong_count: 2 }] });
    const posts = () => S.fetch.calls.filter(c => c.path === '/api/attempts' && c.method === 'POST');
    const p0 = posts().length;
    clickOpt(S, mq.id, 'A'); await settle();
    ok(posts().length === p0, '多选题点选项只切换勾选，不提交');
    ok(listOf(S).includes('data-wconfirm="' + mq.id + '"'), '勾上之后才出现「确认作答」');
    clickOpt(S, mq.id, 'A'); await settle();
    ok(!listOf(S).includes('data-wconfirm="' + mq.id + '"'),
       '再点一下取消勾选；一项都没勾时不建「确认作答」（空勾选交出去会被判成一次错答）');
    ['A', 'C'].forEach(k => clickOpt(S, mq.id, k));
    await settle();
    const hint = listOf(S);
    ok([...cardOf(hint, mq.id).matchAll(/class="opt[^"]*picked"[^>]*data-wk="([^"]+)"/g)]
         .map(m => m[1]).sort().join('') === 'AC',
       '勾选态画在卡上（A、C 标成 picked）');
    clickOn(S, 'data-wconfirm', mq.id); await settle();
    const sent = posts();
    ok(sent.length === p0 + 1, '点「确认作答」才发请求');
    ok(sent.length && sent[sent.length - 1].body.chosen === 'AC',
       `交上去的是勾选的字母串（实际 ${sent.length ? sent[sent.length - 1].body.chosen : '—'}）`);
    const c = cardOf(listOf(S), mq.id);
    ok(c !== '' && c.includes('错了 3 次'),
       `少选算错：题留着、错次 +1（实际那一行：${(c.match(/<p class="wmeta">([^<]*)</) || [])[1] || '无'}）`);
  }

  console.log('\n【错题本 · 空本与取数失败】');
  {
    const E = await bootWrong({});
    ok(/错题本是空的/.test(listOf(E)) && cards(listOf(E)) === 0, '错题本为空时给一句提示，不渲染卡片');
    /* 坏记录（chosen 是 NULL：旧记录只记了错、没记选的是什么）不能把整页带崩。 */
    const B = await bootWrong({ wrong: [{ qid: sqs[0].id, chosen: null, wrong_count: 1 }] });
    ok(cards(listOf(B)) === 1 && /你选 —，正确 B/.test(listOf(B)),
       `chosen 是 NULL 的老记录照常渲染（实际那一行：${(cardOf(listOf(B), sqs[0].id).match(/<p class="wmeta">([^<]*)</) || [])[1] || '无'}）`);
  }

  /* 摘干净：合成题是 unshift 进去的，所以从**头上**切掉；后面的装配吃的还得是
     原来那份题库。切错了（比如设 length 去尾）这里立刻红。 */
  BANK.questions.splice(0, ADDED);
  ok(BANK.questions.length === n0 && !BANK.questions.some(q => q.id === mq.id),
     `合成题已从题库里摘掉（还是 ${BANK.questions.length} 题）`);
}

(async function () {
  await quizSection();
  await mockSection();
  await mockTypesSection();
  await homeSection();
  await wrongSection();
  console.log(failed ? `\n❌ ${failed} 项未通过` : '\n✅ 全部通过');
  process.exit(failed ? 1 : 0);
})();
