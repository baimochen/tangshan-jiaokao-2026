/* 刷题 + 模考冒烟测试：用 DOM 桩真实跑一遍页面脚本。
   验证：脚本不抛错 → 首屏只渲染 40 题 → 点选项能作答 → 答错进错题本 →
        点「再显示」逐页追加 → 筛选「只看错题」只出错的题 → 模考抽题/判分/解析。

   两套装配，各自 eval 自己那份脚本集，互不共用作用域：
     · bootQuiz()       web/quiz.html + assets/{nav,bank,quiz}.js —— 刷题那 36 条
     · bootMockLegacy() 考点体系.html 的内联脚本（原样整块 eval）—— 模考那 62 条
   T10 把这一段整体换成 web/mock.html + assets/mock.js。

   为什么必须分成两次装配：模考引擎这一轮还没搬出单体文件（那是 T10），而两份
   脚本的 DOM 与 hidden 初值互相串不到一起（源页面里它们同页共存，靠的是同一个
   作用域里的 var 提升）。混在一次 eval 里，谁改了谁的状态都看不出来。 */

/* 别在文件顶部加 'use strict'：这里靠**直接 eval** 把拆出来的 js 里的
   var / function 声明带进 bootQuiz 的作用域（见 web/assets/quiz.js 的文件头）。
   严格模式下直接 eval 有自己的变量环境，那些声明一个都拿不到，
   `await quizReady` 会直接 ReferenceError。 */

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');
const WEB = path.join(BASE, 'web');
const QUIZ_HTML = fs.readFileSync(path.join(WEB, 'quiz.html'), 'utf8');
/* 单体文件只给模考装配读。 */
const MONO_HTML = fs.readFileSync(path.join(BASE, '考点体系.html'), 'utf8');

/* ---------- 题库：测试自己那份 ----------
   引擎怎么取数由 fetch 桩决定（见 installFetchStub），这里这份只给断言用：
   题量、模块顺序、某题的答案。它与 bank.db 的一致性由 tests/test_roundtrip.py
   保证，所以冒烟测试不必连库，也就不依赖 Python 环境。
   名字保持 BANK（形状仍是 {total, questions}）——四十来处断言按 BANK.questions 写的。 */
const BANK = JSON.parse(fs.readFileSync(path.join(BASE, '题库.json'), 'utf8'));
const bankById = {};
BANK.questions.forEach(q => { bankById[q.id] = q; });

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

/* ---------- fetch 桩：顶替 server.py 的两个端点 ----------
   冒烟测试测的是引擎逻辑，不是 HTTP——HTTP 由 tests/test_server.py 覆盖。
   只桩引擎真正用到的那两条路由（GET /api/questions、POST /api/attempts）：
   多桩一条就多一处会和真实服务脱节的地方。
   判分刻意走一遍和 banklib.grade 相同的规则（去重、排序、转大写、比集合），
   好让「多选题少选算错」这类规则在客户端也成立。

   桩会把**每一次请求**记进 `calls`，并留一个 `override` 口子（见下）。
   这两个都不是为了「更真实」，是为了让「判分确实发生在服务端」有断言可依：
   没有它们，把引擎改回本地按答案比，整套断言一条都不会红（任务 9 的 M4 突变）。 */
const norm = s => [...new Set((s || '').trim().toUpperCase())].sort().join('');

function installFetchStub() {
  const wrongCount = new Map();   // qid → 累计错次（banklib.record_attempt 的语义）
  const calls = [];               // 每一次请求：{path, method, body}
  const okJSON = obj => ({ ok: true, status: 200, statusText: 'OK', json: async () => obj });
  const errJSON = (status, error) => ({ ok: false, status, statusText: 'error', json: async () => ({ error }) });

  /* override：让某一道题的 POST 直接回指定的响应体，不按本地规则算。
     用来断言「页面渲染的是响应体」——本地算法会判对的题，桩偏说错，
     页面若跟着判错，结论就只可能来自响应。用完置回 null。 */
  const stub = { calls, wrongCount, override: null };

  global.fetch = async function (url, opts) {
    const u = new URL(url, 'http://stub');
    const q = u.searchParams;
    calls.push({ path: u.pathname, method: (opts && opts.method) || 'GET',
                 body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (u.pathname === '/api/questions') {
      const mod = q.get('module'), sec = q.get('section'), typ = q.get('type');
      const list = BANK.questions.filter(x =>
        (!mod || x.module === mod) && (!sec || x.section === sec) && (!typ || x.type === typ));
      const off = +(q.get('offset') || 0);
      const lim = q.get('limit') === null ? 40 : +q.get('limit');   // server.py 的默认值就是 40
      return okJSON({ total: list.length, questions: list.slice(off, off + lim) });
    }
    if (u.pathname === '/api/attempts' && opts && opts.method === 'POST') {
      const b = JSON.parse(opts.body);
      const item = BANK.questions.find(x => x.id === b.qid);
      // 库里没这道题：服务端是 404 + {'error':…}。桩里照同一个形状回，
      // 引擎才不会把「题不在库里」当成「记上了」。
      if (!item) return errJSON(404, '题库里没有这道题：' + b.qid);
      if (stub.override && stub.override.qid === b.qid) {
        const o = stub.override;
        return okJSON({ correct: o.correct, answer: o.answer,
                        explanation: o.explanation, wrong_count: o.wrong_count });
      }
      const correct = norm(b.chosen) === norm(item.answer);
      if (!correct) wrongCount.set(b.qid, (wrongCount.get(b.qid) || 0) + 1);
      return okJSON({ correct, answer: item.answer, explanation: item.explanation,
                      wrong_count: wrongCount.get(b.qid) || 0 });
    }
    return errJSON(404, 'not found');
  };
  return stub;   /* calls / override 交给 bootQuiz 转出去，给断言用 */
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

async function bootQuiz() {
  const nav = [];
  /* readyState='loading'：nav.js 因此只把 window.NAV 放出来、不往 DOM 里挂导航。
     本页引擎压根不查导航（导航本身由 node tests/check_dom.js 验），这里要的只是
     那份导航表——建 section 与 .nav-list a 都用它，不再从 HTML 里正则抓 <a href="#x">。 */
  const S = makeStub(QUIZ_HTML, nav, { idsFromHtml: true, readyState: 'loading', hiddenIds: ['qempty'] });
  S.fetch = installFetchStub();   /* 断言要看请求记录与 override 口子 */

  /* 按页面里的实际顺序 eval。索引 0 是 nav.js，要单独接一下它的产物。 */
  eval(readAsset(PAGE_SCRIPTS[0]));
  window.NAV.forEach(n => { S.byId[n.id] = S.mkEl('section', { class: 'view' }); });
  nav.push(...window.NAV.map(n => ({ id: n.id, label: n.label })));
  for (const rel of PAGE_SCRIPTS.slice(1)) eval(readAsset(rel));

  /* 引擎首次取数是异步的，等它渲完再断言——不是赌时序。 */
  await quizReady;
  return S;
}

/* ---------- 装配二：模考段（T10 前的过渡） ----------
   这一段整体照旧跑 考点体系.html 的内联脚本：模考引擎还没搬出来，它和刷题引擎
   在源文件里共用一个作用域，只能整块 eval。断言一条没动，仍有真实的对象可打。 */
function bootMockLegacy(seedStore) {
  const navLinks = [...MONO_HTML.matchAll(/<a href="#([\w-]+)"[^>]*>([^<]+)<\/a>/g)]
    .filter(m => !['#qMore'].includes(m[1]));
  const seen = new Set();
  const nav = navLinks.filter(m => { if (seen.has(m[1])) return false; seen.add(m[1]); return true; })
    .map(m => ({ id: m[1], label: m[2] }));
  const bankJSON = MONO_HTML.match(/<script type="application\/json" id="qbank">([\s\S]*?)<\/script>/)[1];
  const S = makeStub(MONO_HTML, nav, {
    extraIds: ['qlist', 'qempty', 'qDone', 'qRate', 'wrongN', 'redoWrong', 'wrongReset', 'qTotal',
      'qMod', 'progDone', 'progFill', 'progReset',
      'mkSetup', 'mkExam', 'mkResult', 'mkClock', 'mkDone', 'mkPos', 'mkPrev', 'mkNext',
      'mkCardBtn', 'mkCardPanel', 'mkSubmitBtn', 'mkQ', 'mkPlan', 'mkStart', 'mkResume',
      'mkRev', 'mkReview', 'mkAgain', 'mkMore'],
    qbankJson: bankJSON,
    seedStore: seedStore,
    /* mkMore / mkReview 这类是 innerHTML 里建出来的，真实 DOM 里那时才存在。 */
    hiddenIds: ['mkSetup', 'mkExam', 'mkResult', 'mkCardPanel', 'mkResume', 'qempty'],
  });

  /* 单体文件里唯一一处 <script>…</script>（不带 src）就是引擎那块。 */
  const script = MONO_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  try {
    eval(script);
    if (!process.env.QUIET) console.log('脚本执行: ✅ 未抛错\n');
  } catch (e) {
    console.log('脚本执行: ❌ 抛出异常 →', e.message, '\n', e.stack.split('\n')[1]);
    process.exit(1);
  }
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
}

function mockSection() {
const M = bootMockLegacy(null);
const byId = M.byId, store = M.store, listeners = M.listeners, fbtns = M.fbtns, docListeners = M.docListeners;
const fires = (el, ev) => listeners.filter(l => l.el === el && l.t === 'click').forEach(l => l.fn(ev));
/* 真实 DOM 里 innerHTML 一重写，旧元素连同它的监听器就没了。桩里元素是同一个，
   监听器会越堆越多，所以「重新建出来的按钮」只点最后一次绑上的那个。 */
const fireLast = (el, ev) => {
  const ls = listeners.filter(l => l.el === el && l.t === 'click');
  if (ls.length) ls[ls.length - 1].fn(ev);
};

/* ---------- 模考 ---------- */
console.log('\n【模考 · 配比表】');
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
if (process.env.DUMP) console.log(byId.mkPlan.innerHTML.replace(/<tr/g, '\n<tr'));

console.log('\n【模考 · 抽题】');
fires(byId.mkStart, {});
ok(byId.mkExam.hidden === false, '点「开始考试」进入答题界面');
const mock = JSON.parse(store['jiaokao-mock-2026'] || 'null');
ok(mock && mock.ids && mock.ids.length === 120, `抽到 ${mock && mock.ids ? mock.ids.length : 0} 题（应为 120）`);
ok(new Set(mock.ids).size === 120, '120 题互不重复');

/* 卷面分两部分：第一部分整块公基，第二部分整块教基，每块内部打乱 */
const PARTS = [
  ['公共基础知识', [['公共基础 · 政治与时政', 16], ['公共基础 · 法律', 13],
    ['公共基础 · 经济、管理与常识', 11], ['公共基础 · 公文写作', 8],
    ['人文历史与科技常识', 6],
    ['唐山工业职业技术大学校情', 3], ['唐山本地政策与时政', 3]]],
  ['教育专业能力测验', [['教育学', 23], ['教育心理学', 17], ['教育法律法规', 7],
    ['教师职业理念与职业道德', 6], ['职业教育与高等教育', 7]]],
];
const PLAN = PARTS.flatMap(P => P[1]);
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
const runs = a => { let r = 0; for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1]) r++; return r; };
const mods1 = mock.ids.slice(0, 60).map(id => bankById[id].module);
const mods2 = mock.ids.slice(60).map(id => bankById[id].module);
ok(runs(mods1) > 30, `第一部分内部打乱了（模块切换 ${runs(mods1)} 次；按模块排只有 6 次）`);
ok(runs(mods2) > 25, `第二部分内部打乱了（模块切换 ${runs(mods2)} 次；按模块排只有 4 次）`);

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
}
const pickOpt = k => fires(byId.mkQ, { target: { closest: sel => sel === '[data-mk]'
  ? { getAttribute: a => (a === 'data-mk' ? k : null) } : null } });

const q0 = bankById[mock.ids[0]], q1 = bankById[mock.ids[1]], q2 = bankById[mock.ids[2]];
const wrongOf = q => ['A', 'B', 'C', 'D'].find(k => k !== q.answer);
pickOpt(wrongOf(q0));            // 第 1 题：故意答错
fires(byId.mkNext, {}); pickOpt(q1.answer);   // 第 2 题：答对
fires(byId.mkNext, {}); pickOpt(q2.answer);   // 第 3 题：答对
ok(byId.mkDone.textContent == 3, `已答计数 = ${byId.mkDone.textContent}`);
ok(byId.mkPos.textContent === '3 / 120', `题号 = ${byId.mkPos.textContent}`);
const qHtml = byId.mkQ.innerHTML;
ok(!/class="opt (correct|wrong|dim)/.test(qHtml), '考试中不显示对错（没有 correct/wrong 样式）');
ok(/opt picked/.test(qHtml), '选中的项有 picked 标记');
ok((byId.mkCardPanel.innerHTML.match(/mk-cell done/g) || []).length === 3, '答题卡标出 3 格已答');
fires(byId.mkCardBtn, {});
ok(byId.mkCardPanel.hidden === false, '点「答题卡」能展开');

/* 键盘选答：按的是「显示字母」，存进去必须是「原始 key」。
   这里正是我写错过的地方——原来直接把显示字母存了，乱序后会整整错一位。 */
fires(byId.mkNext, {});
const dispOrder = [...byId.mkQ.innerHTML.matchAll(/data-mk="([^"]+)"/g)].map(m => m[1]);
const curId = JSON.parse(store['jiaokao-mock-2026']).ids[3];
const kd = docListeners.find(l => l.t === 'keydown');
ok(!!kd, '键盘监听已注册');
kd.fn({ key: 'A' });
ok(JSON.parse(store['jiaokao-mock-2026']).answers[curId] === dispOrder[0],
   `按 A 存下的是显示在 A 位的原始 key（${dispOrder[0]}），不是字母 A`);
kd.fn({ key: 'D' });
ok(JSON.parse(store['jiaokao-mock-2026']).answers[curId] === dispOrder[3],
   `按 D 存下的是显示在 D 位的原始 key（${dispOrder[3]}）`);
pickOpt(bankById[curId].answer);   /* 第 4 题按显示位答对，后面的判分才可预期 */
ok(byId.mkDone.textContent == 4, `已答计数 = ${byId.mkDone.textContent}`);

console.log('\n【模考 · 交卷判分】');
fires(byId.mkSubmitBtn, {});
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


/* ---------- 关着页面错过交卷时间 ---------- */
console.log('\n【模考 · 页面关着时考卷过期】');
{
  /* 这条路最容易被漏掉：考试时间在用户没开页面的时候走完，回来时只能判过期。
     交卷和页内超时两条路都会并入成绩，这条如果忘了并入，那场的错题就永远进不了错题本。
     所以整页重启一次，只喂一份「已过期、未交卷」的存档。 */
  const prev = JSON.parse(store['jiaokao-mock-2026']);
  const ids = prev.ids;
  ok(ids.length === 120, `拿上一场的 ${ids.length} 道题号做存档`);

  const plantWrong = ids.slice(0, 6), plantRight = ids.slice(6, 9);
  const mkAns = {};
  plantWrong.forEach(id => { mkAns[id] = ['A','B','C','D'].find(k => k !== bankById[id].answer); });
  plantRight.forEach(id => { mkAns[id] = bankById[id].answer; });

  process.env.QUIET='1';
  const B2 = bootMockLegacy({
    'jiaokao-answers-2026': '{}',
    'jiaokao-mock-2026': JSON.stringify({
      ids: ids, parts: prev.parts, answers: mkAns, i: 0,
      startedAt: Date.now() - 7200e3,
      endsAt: Date.now() - 60e3,        /* 一分钟前就该交卷了 */
      submitted: false, submittedAt: 0,
    }),
  });

  delete process.env.QUIET;
  const merged = JSON.parse(B2.store['jiaokao-answers-2026'] || '{}');
  const wb = JSON.parse(B2.store['jiaokao-wrong-2026'] || '{}');
  ok(plantWrong.every(id => merged[id] === mkAns[id]),
     `过期存档里答错的 ${plantWrong.length} 题并入了成绩`);
  ok(plantWrong.every(id => wb[id] === 1),
     `并进了错题本（${plantWrong.filter(id => wb[id] === 1).length}/${plantWrong.length}）`);
  ok(!plantRight.some(id => wb[id]), '答对的题没有误进错题本');
  ok(B2.byId.mkResult.hidden === false, '回到页面直接显示成绩单');
  ok(B2.byId.mkExam.hidden === true, '不再停在答题界面');
  const note = B2.byId.mkResult.innerHTML;
  ok(/已自动进错题本/.test(note), '成绩单上写明了错题已进错题本');
  ok(new RegExp('答错的 <b>' + plantWrong.length + '</b>').test(note),
     `成绩单上的错题数 = ${plantWrong.length}`);
}
}

(async function () {
  await quizSection();
  mockSection();
  console.log(failed ? `\n❌ ${failed} 项未通过` : '\n✅ 全部通过');
  process.exit(failed ? 1 : 0);
})();
