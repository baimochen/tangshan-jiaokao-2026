// 模考引擎。从 考点体系.html 的内联脚本里「模拟考试」那一段搬出来（任务 10）。
// 行为与源页面等价，真正改的只有「东西存在哪儿、谁说了算」：
//   · 配比表、抽题、判分全在服务端（/api/mock/*）。页面里不再有第二份 MK_PARTS
//     ——两份配比的下场是页面写一套、服务端抽另一套，两边都不报错却对不上。
//   · 这场卷子存在 mock_runs.state 里（服务端），页面关掉再打开能接着答。
//   · 交卷三条路径——**手动交卷、页内超时、关着页面时过期**——都打同一个
//     POST /api/mock/submit。所以「交卷要干的事」（判分、并入错题本）天然只有
//     一份实现：漏掉任何一条路径，那一场的错题就进不了错题本。源页面里这三条
//     各调一次 mkCommit()，是这份重复最容易出事的地方。
//   · 成绩单上的分数、模块正确率、逐题解析的对错标签，取的都是服务端回的结果，
//     页面不再自己按答案比一遍（判分规则只有 banklib.grade 一份）。
//
// **顶层一律用 var / function，不要改成 const / let；也不要包 IIFE。**
// tests/smoke.js 把本文件连同 nav.js / bank.js 一起 eval 进一个函数作用域里跑。
// 直接 eval 时 var 与函数声明会落进外层作用域（冒烟测试靠这个拿到 mockReady），
// const / let 只会留在 eval 自己的作用域里、包成 IIFE 同理：什么都没露出来。
//
// 本文件自包含：pad / letterAt / shuffledOpts / shownKey / isOptRef / remapExplain
// 这些在源文件里和刷题引擎共用一个作用域，拆出来之后自己带一份，不依赖别的脚本
// （除了 bank.js 的 window.api）。名字与 quiz.js 里那套一致，改的时候两边一起看。

var MK_AKEY = 'jiaokao-answers-2026', MK_WKEY = 'jiaokao-wrong-2026';
var MK_PAGE = 40;                 /* 逐题解析一页显示多少题 */

/* 服务端说了算的那几样。取回来之前是空的，别在取回来之前渲染。 */
var mkN = 0, mkSeconds = 0;
var mkPlan = [];                  /* GET /api/mock 的 parts：配比表 + 成绩单分组 */

var mkBank = null, mkById = {};
var mkState = null, mkTimer = null, mkShown = MK_PAGE;

/* 刷题记录与错题本的本机副本（刷题页读的就是这两个键）。交卷时按服务端判的分
   并进去——见 mkCommitLocal。 */
var mkAnswers = {}, mkWrong = {};
try { mkAnswers = JSON.parse(localStorage.getItem(MK_AKEY) || '{}') || {}; } catch (e) { mkAnswers = {}; }
try { mkWrong = JSON.parse(localStorage.getItem(MK_WKEY) || '{}') || {}; } catch (e) { mkWrong = {}; }

function mk$(id) { return document.getElementById(id); }
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function letterAt(i) { return 'ABCD'.charAt(i); }

/* ---- 选项乱序 ----
   题库里 answer 是按选项原始顺序写的。乱序只发生在显示层：
   · 显示字母永远按 A/B/C/D 顺着排，跟原始 key 无关
   · data-mk 上挂的仍是「原始 key」，作答记账一律用原始 key
   顺序按题缓存在本页面会话里：同一题在本次打开期间顺序固定（答完不会跳）。 */
var SHUF = {};
function shuffledOpts(q) {
  var idx = SHUF[q.id];
  if (!idx) {
    idx = [];
    for (var i = 0; i < q.options.length; i++) idx.push(i);
    for (var j = idx.length - 1; j > 0; j--) {
      var r = Math.floor(Math.random() * (j + 1)), t = idx[j]; idx[j] = idx[r]; idx[r] = t;
    }
    SHUF[q.id] = idx;
  }
  return idx.map(function (i) { return q.options[i]; });
}
function posOf(q, key) {
  var a = shuffledOpts(q);
  for (var i = 0; i < a.length; i++) { if (a[i].key === key) return i; }
  return -1;
}
/* 显示在第 pos 位的那一项，原始 key 是什么 */
function keyAt(q, pos) {
  var a = shuffledOpts(q);
  return a[pos] ? a[pos].key : null;
}
/* 某个原始 key 显示出来时是第几个字母 */
function shownKey(q, key) {
  var p = posOf(q, key);
  return p < 0 ? key : letterAt(p);
}

/* ---- 解析里的字母：与刷题引擎同一套规则（见 quiz.js 里那段说明） ---- */
function isOptRef(pre, post) {
  if (/^\s*项/.test(post)) return true;
  if (/(故选|应选|答案为|答案是|答案|正确项是)\s*$/.test(pre)) return true;
  if (/故\s*$/.test(pre)) return true;
  if (/[ABCD]\s*[、与和及]\s*$/.test(pre)) return true;
  if (/^\s*[、与和及]\s*[ABCD]/.test(post)) return true;
  if (/^\s*(正确|错误|两项|三项|都|均|也|全对)/.test(post)) return true;
  return false;
}
function remapExplain(q, s) {
  if (!s) return s;
  var out = '', last = 0, m, re = /[ABCD]/g;
  while ((m = re.exec(s))) {
    var i = m.index, ch = m[0];
    if (/[A-Za-z]/.test(s.charAt(i - 1)) || /[A-Za-z]/.test(s.charAt(i + 1))) continue;
    if (!isOptRef(s.slice(Math.max(0, i - 6), i), s.slice(i + 1, i + 7))) continue;
    out += s.slice(last, i) + shownKey(q, ch); last = i + 1;
  }
  return out + s.slice(last);
}

/* 第 i 题落在哪一部分。名字取 mkPlan（服务端给的那份），边界取这一场的 parts。
   返回 null 说明这份卷子没有分块信息，那就照旧不分节显示，别硬套。 */
function mkPartName(i) {
  var P = mkPlan[i];
  return '第' + '一二三四'.charAt(i) + '部分 · ' + (P ? P.name : '');
}
function mkPartAt(i) {
  if (!mkState || !mkState.parts) return null;
  var at = 0;
  for (var j = 0; j < mkState.parts.length; j++) {
    var P = mkState.parts[j];
    if (i >= at && i < at + P.n) return { name: mkPartName(j), from: at, to: at + P.n };
    at += P.n;
  }
  return null;
}

function mkDoneCount() {
  var n = 0; mkState.ids.forEach(function (id) { if (mkState.answers[id]) n++; }); return n;
}
function mkFmtUsed(sec) {
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + ' 分 ' + pad(s) + ' 秒';
}

/* ---- 渲染 ---- */
function mkRenderQ() {
  var box = mk$('mkQ'); if (!box || !mkState) return;
  var q = mkById[mkState.ids[mkState.i]];
  if (!q) { box.innerHTML = ''; return; }
  var a = mkState.answers[q.id] || null;
  var opts = shuffledOpts(q).map(function (o, i) {
    var cls = 'opt' + (a === o.key ? ' picked' : '');
    return '<li><button class="' + cls + '" type="button" data-mk="' + o.key + '">'
      + '<span class="k">' + letterAt(i) + '</span><span class="t">' + o.text + '</span></button></li>';
  }).join('');
  var pt = mkPartAt(mkState.i);
  box.innerHTML = '<div class="mk-q">'
    + (pt ? '<span class="mk-part">' + pt.name + '</span>' : '')
    + '<span class="mk-mod">' + q.module + '</span>'
    + '<p class="stem"><span class="no">' + (mkState.i + 1) + '</span>' + q.stem + '</p>'
    + '<ul class="opts">' + opts + '</ul></div>';
}
function mkRenderCard() {
  var el = mk$('mkCardPanel'); if (!el || !mkState) return;
  var html = '';
  mkState.ids.forEach(function (id, i) {
    var pt = mkPartAt(i);
    if (pt && pt.from === i) html += '<div class="mk-sep">' + pt.name + '</div>';
    var cls = 'mk-cell' + (mkState.answers[id] ? ' done' : '') + (i === mkState.i ? ' cur' : '');
    html += '<button type="button" class="' + cls + '" data-jump="' + i + '">' + (i + 1) + '</button>';
  });
  el.innerHTML = '<p class="mk-cardhd">答题卡 · 已答 <b>' + mkDoneCount() + '</b>/' + mkN
    + '<span class="mk-legend"><i class="done"></i>已答<i class="cur"></i>当前</span></p>'
    + '<div class="mk-grid">' + html + '</div>';
}
function mkUpdateProg() {
  var d = mk$('mkDone'), p = mk$('mkPos');
  if (d) d.textContent = mkDoneCount();
  if (p) p.textContent = (mkState.i + 1) + ' / ' + mkN;
  var pv = mk$('mkPrev'), nx = mk$('mkNext');
  if (pv) pv.disabled = (mkState.i === 0);
  if (nx) nx.disabled = (mkState.i === mkN - 1);
}
/* 设置面板的配比表。数据来自服务端的 parts——**别在这里再写一份配比**，
   写死的话服务端改了配比、页面还在按老配比预告，考生拿到的是另一张卷子。 */
function mkRenderPlan() {
  var tb = mk$('mkPlan'); if (!tb) return;
  var rows = '';
  mkPlan.forEach(function (P, pi) {
    rows += '<tr class="grp"><td colspan="3">' + mkPartName(pi)
      + '<span class="pn">' + P.n + ' 题 · ' + Math.round(P.n / mkN * 100) + '%</span></td></tr>';
    var g = null;
    (P.modules || []).forEach(function (m) {
      if (m.group !== g && m.group) rows += '<tr class="sub"><td colspan="3">' + m.group + '</td></tr>';
      g = m.group;
      rows += '<tr><td>' + m.module + '</td><td class="r">' + m.n + '</td><td class="r">'
        + Math.round(m.n / mkN * 100) + '%</td></tr>';
    });
  });
  rows += '<tr class="sum"><td>合计</td><td class="r">' + mkN + '</td><td class="r">100%</td></tr>';
  tb.innerHTML = rows;
}

/* 成绩单。**分数、模块题量/答对数、答错的题号全部来自服务端回的结果**——
   页面不拿题库的 answer 再算一遍，判分规则（多选少选算错）只在 banklib.grade 里。 */
function mkRenderResult(res) {
  var el = mk$('mkResult'); if (!el) return;
  mk$('mkExam').hidden = true; mk$('mkSetup').hidden = true; el.hidden = false;

  var total = res.total || mkN;
  var pts = res.score;                       /* 0..100，服务端算的 */
  var mkWrongN = (res.wrong || []).length;
  var v = pts >= 80 ? 'v-good' : (pts >= 60 ? 'v-mid' : 'v-bad');
  var word = pts >= 80 ? '稳了，保持住' : (pts >= 60 ? '过线了，但弱点模块要补' : '危险，回去看错题本');

  var per = {};
  (res.by_module || []).forEach(function (m) { per[m.module] = m; });

  var rows = '', sum = { n: 0, right: 0 };
  mkPlan.forEach(function (P, pi) {
    var sub = { n: 0, right: 0 };
    rows += '<tr class="grp"><td colspan="4">' + mkPartName(pi) + '</td></tr>';
    var g = null;
    (P.modules || []).forEach(function (p) {
      var r = per[p.module]; if (!r || !r.n) return;
      if (p.group !== g && p.group) rows += '<tr class="sub"><td colspan="4">' + p.group + '</td></tr>';
      g = p.group;
      sub.n += r.n; sub.right += r.right;
      var rate = Math.round(r.right / r.n * 100);
      rows += '<tr><td>' + p.module + '</td><td class="r">' + r.n + '</td><td class="r">' + r.right
        + '</td><td class="r rate ' + (rate < 60 ? 'low' : (rate >= 80 ? 'ok' : '')) + '">' + rate + '%</td></tr>';
    });
    sum.n += sub.n; sum.right += sub.right;
    rows += '<tr class="psub"><td>小计</td><td class="r">' + sub.n + '</td><td class="r">' + sub.right
      + '</td><td class="r rate">' + (sub.n ? Math.round(sub.right / sub.n * 100) : 0) + '%</td></tr>';
  });
  rows += '<tr class="sum"><td>合计</td><td class="r">' + sum.n + '</td><td class="r">'
    + sum.right + '</td><td class="r rate">' + Math.round(sum.right / sum.n * 100) + '%</td></tr>';

  el.innerHTML = '<div class="mk-score ' + v + '">'
    + '<p class="verdict">' + word + '</p>'
    + '<p class="big">' + (Math.round(pts * 10) / 10) + '<em>/ 100</em></p>'
    + '<p class="sub"><span>答对 <b>' + res.right + '</b> / ' + total + ' 题</span>'
    + '<span>用时 <b>' + mkFmtUsed(res.used || 0) + '</b></span>'
    + '<span>未答 <b>' + (res.unanswered || 0) + '</b> 题</span></p></div>'
    + '<table class="mk-break"><thead><tr><th>模块</th><th class="r">题量</th>'
    + '<th class="r">答对</th><th class="r">正确率</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + '<div class="mk-acts">'
    + '<button class="mk-btn" id="mkReview" type="button">查看逐题解析</button>'
    + '<button class="mk-start" id="mkAgain" type="button">再考一次</button>'
    + '</div><p class="mk-tonote">答错的 <b>' + mkWrongN + '</b> 题已自动进错题本——'
    + '去「刷题 → 只看错题」就能重做。</p>'
    + '<div class="mk-rev" id="mkRev"></div>';

  var rev = mk$('mkReview');
  if (rev) rev.addEventListener('click', function () { mkShown = MK_PAGE; mkRenderRev(true); });
  var ag = mk$('mkAgain');
  if (ag) ag.addEventListener('click', function () {
    mkTimerStop(); mkState = null;
    el.hidden = true; el.innerHTML = ''; mk$('mkSetup').hidden = false;
  });
}

/* 逐题解析。对错标签取服务端结果里的 wrong 列表——不在这里按答案再比一遍。 */
function mkRenderRev(reset) {
  var el = mk$('mkRev'); if (!el || !mkState) return;
  if (reset) mkShown = MK_PAGE;
  var wrongSet = {};
  ((mkState.result && mkState.result.wrong) || []).forEach(function (id) { wrongSet[id] = 1; });
  var slice = mkState.ids.slice(0, mkShown);
  var html = '';
  slice.forEach(function (id, i) {
    var q = mkById[id]; if (!q) return;
    var pt = mkPartAt(i);
    if (pt && pt.from === i) html += '<h3>' + pt.name + '</h3>';
    var a = mkState.answers[id] || null;
    var bad = !!(a && wrongSet[id]);
    var cls = !a ? '' : (bad ? 'wrong' : 'right');
    var tag = !a ? '<span class="mk-tag skip">未答</span>'
      : (bad ? '<span class="mk-tag wrong">错，你选 ' + shownKey(q, a) + '</span>'
             : '<span class="mk-tag right">对</span>');
    var opts = shuffledOpts(q).map(function (o, oi) {
      var c = 'opt';
      if (o.key === q.answer) c += ' correct';
      else if (o.key === a) c += ' wrong';
      else if (a) c += ' dim';
      return '<li><button class="' + c + '" type="button" disabled>'
        + '<span class="k">' + letterAt(oi) + '</span><span class="t">' + o.text + '</span></button></li>';
    }).join('');
    html += '<div class="qz ' + cls + '"><p class="stem"><span class="no">' + (i + 1) + '</span>' + q.stem + tag + '</p>'
      + '<ul class="opts">' + opts + '</ul>'
      + '<div class="ans"><span class="key">' + shownKey(q, q.answer) + '</span>' + remapExplain(q, q.explanation) + '</div></div>';
  });
  var left = mkState.ids.length - mkShown;
  if (left > 0) {
    html += '<div class="qmore"><button type="button" id="mkMore">再显示 '
      + Math.min(left, MK_PAGE) + ' 题<em>还有 ' + left + ' 题</em></button></div>';
  }
  el.innerHTML = html;
  var more = mk$('mkMore');
  if (more) more.addEventListener('click', function () { mkShown += MK_PAGE; mkRenderRev(false); });
}

/* ---- 考试流程 ---- */
function mkShowExam() {
  mk$('mkSetup').hidden = true;
  mk$('mkResult').hidden = true;
  mk$('mkExam').hidden = false;
  mk$('mkCardBtn').disabled = false;
  mk$('mkSubmitBtn').disabled = false;
  mkRenderQ(); mkRenderCard(); mkUpdateProg(); mkTick();
  mkTimerStop();
  mkTimer = setInterval(mkTick, 1000);
}
function mkTimerStop() { if (mkTimer) { clearInterval(mkTimer); mkTimer = null; } }
function mkTick() {
  if (!mkState || mkState.submitted) { mkTimerStop(); return; }
  var left = Math.max(0, Math.round((mkState.endsAt - Date.now()) / 1000));
  var el = mk$('mkClock');
  if (el) {
    el.textContent = Math.floor(left / 60) + ':' + pad(left % 60);
    el.className = 'mk-clock' + (left <= 300 ? ' urgent' : '');
  }
  /* 页内超时也是交卷：打的就是服务端那一个 submit（下面那个函数）。 */
  if (left <= 0) mkSubmit(true);
}

/* 翻页/跳题：只动 mkState.i 和界面。进度记进这场卷子（不带 qid 的那种写法），
   页面关掉再打开能回到原来那一题。记不上不影响答题，只丢个位置。 */
function mkGo(i) {
  if (!mkState || mkState.submitted) return;
  mkState.i = Math.max(0, Math.min(mkN - 1, i));
  mkRenderQ(); mkRenderCard(); mkUpdateProg();
  api.post('/api/mock/answer', { i: mkState.i }).catch(function (err) {
    console.error('答题进度没能记进这场模考：' + err.message);
  });
}

/* 选了一个选项。**先把这次作答记进服务端**，记上了才算答了——服务端不知道
   的记录留着只会更乱（判分读的是服务端那份卷子）。记不上就把这次选择撤回。 */
async function mkAnswer(key) {
  if (!mkState || mkState.submitted) return;
  var qid = mkState.ids[mkState.i];
  mkState.answers[qid] = key;
  mkRenderQ(); mkRenderCard(); mkUpdateProg();
  try {
    await api.post('/api/mock/answer', { qid: qid, chosen: key, i: mkState.i });
  } catch (err) {
    delete mkState.answers[qid];
    mkRenderQ(); mkRenderCard(); mkUpdateProg();
    console.error('作答没能记进这场模考：' + err.message);
  }
}

/* 开始考试：抽题在服务端，这里只管把回来的那一场摆出来。题库不足
   （「题库不足: X 需要 N 只有 M」）时 api.post 抛出来，照源页面那样把话显示在
   设置面板上。 */
async function mkBegin() {
  var run;
  try { run = await api.post('/api/mock/start', {}); }
  catch (e) {
    var box = mk$('mkSetup');
    if (box) box.insertAdjacentHTML('beforeend',
      '<p class="cap" style="color:var(--cinnabar)">抽题失败：' + e.message + '</p>');
    return;
  }
  mkState = run;            /* {ids, parts, answers, i, startedAt, endsAt, submitted, …} */
  mkShown = MK_PAGE;
  mkShowExam();
}

/* 交卷。**手动交卷、页内超时、关着页面时过期三条路都走这里**——判分和并入错题本
   在服务端只有一份实现，客户端这边也就不该有第二条写记录的路径。 */
async function mkSubmit(auto) {
  if (!mkState || mkState.submitted) return;
  if (!auto) {
    var un = mkN - mkDoneCount();
    var msg = '确定交卷？' + (un ? '还有 ' + un + ' 题没答，交了就判分了。' : '全部答完，交卷判分。');
    if (typeof confirm === 'function' && !confirm(msg)) return;
  }
  var res;
  try { res = await api.post('/api/mock/submit', {}); }
  catch (err) {
    /* 没交上就当没交：mkState.submitted 不动、计时不停，页内超时那条会每秒重试。 */
    console.error('交卷没能提交：' + err.message);
    return;
  }
  mkState.submitted = true;
  mkState.submittedAt = res.submittedAt || Date.now();
  mkState.result = res;             /* 逐题解析的对错标签要用它 */
  mkTimerStop();
  mkCommitLocal(res);
  mkRenderResult(res);
}

/* 成绩并入本机刷题记录。服务端已经把成绩并进 bank.db（attempts + 错题本），这里
   把同一份结果写进本机那两个键——刷题页读的是本机这份。
   **答错的按服务端回的 wrong 列表记**，不在这里按答案再比一遍。 */
function mkCommitLocal(res) {
  if (!mkState) return;
  mkState.ids.forEach(function (id) { if (mkState.answers[id]) mkAnswers[id] = mkState.answers[id]; });
  (res.wrong || []).forEach(function (id) { mkWrong[id] = 1; });
  try {
    localStorage.setItem(MK_AKEY, JSON.stringify(mkAnswers));
    localStorage.setItem(MK_WKEY, JSON.stringify(mkWrong));
  } catch (e) {}
}

/* ---- 打开页面时：接着答，或者看成绩 ----
   三种存档：还没考完（接着答）、关着的时候过期了（**交卷**——这是第三条交卷路径）、
   已经交过（看成绩单）。 */
async function mkRestore(s) {
  if (!s || !s.ids) return;
  if (!s.submitted) {
    if (s.endsAt > Date.now()) {
      mkState = s; mkShowExam();
      var rs = mk$('mkResume');
      if (rs) { rs.hidden = false; rs.textContent = '有一场没考完的卷子，已自动接着答。'; }
      return;
    }
    mkState = s;
    await mkSubmit(true);           /* 关着页面时考卷过期：走服务端那一条交卷路径 */
    return;
  }
  mkState = s;
  if (s.result) mkRenderResult(s.result);   /* 成绩是 GET 时服务端一并带回来的 */
}

/* ---- 取数 ----
   配比表和题库都要：配比表渲染设置面板与成绩单分组，题库渲染题目本体。
   取数之前 mkPlan / mkById 是空的，所以一切都挂在 mockReady 后面。 */
async function mockLoad() {
  var got = await Promise.all([
    api.get('/api/questions?limit=1000000'),
    api.get('/api/mock'),
  ]);
  var bank = got[0], data = got[1];
  mkBank = bank.questions || [];
  mkById = {};
  mkBank.forEach(function (q) { mkById[q.id] = q; });
  mkN = data.n; mkSeconds = data.seconds; mkPlan = data.parts || [];
  mkRenderPlan();
  await mkRestore(data.run);
}

/* ---- 交互 ---- */
(function mkWire() {
  var st = mk$('mkStart');
  if (st) st.addEventListener('click', function () { mkBegin(); });

  var qbox = mk$('mkQ');
  if (qbox) qbox.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-mk]') : null;
    if (!b || !mkState || mkState.submitted) return;
    mkAnswer(b.getAttribute('data-mk'));
  });

  var cp = mk$('mkCardPanel');
  if (cp) cp.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-jump]') : null;
    if (b) mkGo(parseInt(b.getAttribute('data-jump'), 10));
  });

  var cb = mk$('mkCardBtn');
  if (cb) cb.addEventListener('click', function () { mk$('mkCardPanel').hidden = !mk$('mkCardPanel').hidden; });
  var pv = mk$('mkPrev'); if (pv) pv.addEventListener('click', function () { if (mkState) mkGo(mkState.i - 1); });
  var nx = mk$('mkNext'); if (nx) nx.addEventListener('click', function () { if (mkState) mkGo(mkState.i + 1); });
  var sb = mk$('mkSubmitBtn'); if (sb) sb.addEventListener('click', function () { mkSubmit(false); });

  document.addEventListener('keydown', function (e) {
    if (!mkState || mkState.submitted) return;
    if (mk$('mkExam').hidden) return;
    var k = e.key.toUpperCase();
    if (k === 'ARROWRIGHT') { mkGo(mkState.i + 1); }
    else if (k === 'ARROWLEFT') { mkGo(mkState.i - 1); }
    else if (k.length === 1 && 'ABCD'.indexOf(k) >= 0) {
      /* 按的是「显示字母」，存进去的必须是「原始 key」——data-mk 上挂的也是它，
         两边不一致的话乱序之后整整错一位。 */
      var q = mkById[mkState.ids[mkState.i]];
      var raw = q ? keyAt(q, 'ABCD'.indexOf(k)) : null;
      if (raw) mkAnswer(raw);
    }
  });
})();

/* 首次取数的 Promise。页面自己不等它（渲染在 then 里跑），
   冒烟测试靠它把「等数据回来」写成一个 await，而不是赌时序。 */
var mockReady = mockLoad().catch(function (err) {
  var box = mk$('mkSetup');
  if (box) box.insertAdjacentHTML('beforeend',
    '<p class="cap" style="color:var(--cinnabar)">模考数据没取到：' + err.message + '</p>');
});
