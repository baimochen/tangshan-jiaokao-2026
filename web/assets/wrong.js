// 错题本页（任务 15）。错题从刷题页里拆出来，独立成这一页。
//
// 三条设计决定，都记在这儿：
//
//   1. **不洗牌，因此也不调 remapExplain。** remapExplain 会读 SHUF[q.id]、
//      没有就现建一张乱序表，再按那张表把解析里的字母换掉——不洗牌却调它，
//      屏幕上选项的字母就和解析里的字母对不上了（只做一半的经典坏法）。
//      错题本要的是「照原样重看错在哪」，选项顺序稳定比随机重要：同一道错题
//      刷新两次顺序不一样，根本没法对照着看。不洗牌时解析里的字母本来就指
//      原始顺序、也就是屏幕上显示的顺序，不需要任何重映射——「正确 ABD」
//      直接取 q.answer 原文（GET /api/wrong 已经把它原样返回）。
//
//   2. **判分与写记录都交回服务端。** 「重做这道题」打 POST /api/attempts，
//      由 banklib.record_attempt 判分、写 attempts、维护错题本（做对则
//      resolved=1）；「标记已订正」打 POST /api/wrong/<qid>/resolve。
//      客户端一处判分规则都没有，也不自己写第二份「什么算对」。
//
//   3. 每次写成功都**重新取一遍** GET /api/wrong 再整页重渲染。错题本的正确
//      形态只有服务端知道（做对了那行会被翻成 resolved、又错了错次 +1），
//      本机跟着猜一份就是第二份真相。
//
// **顶层一律用 var / function，不要改成 const / let；也不要包 IIFE。**
// tests/smoke.js 用直接 eval 把本文件注入函数作用域（见 quiz.js 的文件头）。
//
// 本页**没有引 bank.js**（页面脚本集由 tests/test_split.py 钉死为
// nav.js + wrong.js），所以 window.api 不存在——取数与写入用下面那两个自带的
// 小封装。形状与 bank.js 的 api 一致（失败时抛可读的中文），只是不依赖别的脚本。

var wRoot = document.getElementById('wrongRoot');
var wAll = [];        /* 服务端那一份错题（GET /api/wrong 的 questions） */
var wOnly2 = false;   /* 「只显示错 2 次以上」 */
var wMsg = '';        /* 上一次操作失败的原因，渲染在最上面 */
var wPicks = {};      /* 多选题勾上、还没确认的 key：qid → 数组 */

function wPad(n) { return n < 10 ? '0' + n : '' + n; }

/* 作答/答案一律当字符串看。wrong 表里 chosen 可能是 NULL（旧记录只记了错、
   没记选的是什么，见 banklib._put_legacy_wrong），非字符串按「什么都没勾」。 */
function wStr(s) { return typeof s === 'string' ? s : ''; }
function wHas(s, key) { return wStr(s).indexOf(key) >= 0; }

/* 某个原始 key 对应的选项文字。判断题用它——判断题的选项是「正确 / 错误」，
   屏幕上没有 A/B 可指（和刷题页一样不标字母）。 */
function wText(q, key) {
  var opts = q.options || [];
  for (var i = 0; i < opts.length; i++) { if (opts[i].key === key) return opts[i].text; }
  return key;
}

/* 卡片上那一行「你选 X，正确 Y · 错了 N 次」。
   判断题的选项没有字母，所以那一行改用选项文字，且第二段写「应选」——
   照搬模板会渲染成「你选 错误，正确 正确」，没人看得懂。 */
function wMeta(q) {
  var tail = ' · 错了 ' + q.wrong_count + ' 次';
  if (q.type === 'judge') {
    return '你选 ' + wText(q, wStr(q.chosen)) + '，应选 ' + wText(q, q.answer) + tail;
  }
  return '你选 ' + (wStr(q.chosen) || '—') + '，正确 ' + q.answer + tail;
}

/* 选项：**按原始顺序渲染，不洗牌**（见文件头第 1 条）。
   correct 看「这一项在不在正确答案里」，wrong 看「用户选过这一项但它是错的」
   ——两套判据和刷题页一致（不能写成 o.key === q.answer：多选下恒假）。 */
function wOptHTML(q, o, i) {
  var cls = 'opt';
  if (wHas(q.answer, o.key)) cls += ' correct';
  else if (wHas(q.chosen, o.key)) cls += ' wrong';
  if (q.type === 'multi' && (wPicks[q.id] || []).indexOf(o.key) >= 0) cls += ' picked';
  var letter = q.type === 'judge' ? '' : '<span class="k">' + 'ABCD'.charAt(i) + '</span>';
  return '<li><button class="' + cls + '" type="button" data-wq="' + q.id
    + '" data-wk="' + o.key + '">' + letter + '<span class="t">' + o.text + '</span></button></li>';
}

function wCard(q) {
  var opts = (q.options || []).map(function (o, i) { return wOptHTML(q, o, i); }).join('');
  /* 多选题：勾选只改 picked，点「确认作答」才交上去（和刷题页同一套交互）。
     一项都没勾时不建这个按钮——空勾选交出去会被判成一次错答。 */
  var sub = (q.type === 'multi' && (wPicks[q.id] || []).length)
    ? '<div class="qmore"><button type="button" data-wconfirm="' + q.id + '">确认作答</button></div>'
    : '';
  return '<div class="qz wrong" data-card="' + q.id + '">'
    + '<p class="stem"><span class="no">' + wPad(q.n) + '</span>' + q.stem + '</p>'
    + '<p class="wmeta">' + wMeta(q) + '</p>'
    + '<ul class="opts">' + opts + '</ul>' + sub
    + '<div class="ans">' + (q.explanation || '（暂无解析）') + '</div>'
    + '<p class="wact"><button type="button" class="wbtn" data-resolve="' + q.id
    + '">标记已订正</button></p>'
    + '</div>';
}

function wById(id) {
  for (var i = 0; i < wAll.length; i++) { if (wAll[i].id === id) return wAll[i]; }
  return null;
}

function wRender() {
  if (!wRoot) return;
  var rows = wOnly2 ? wAll.filter(function (q) { return q.wrong_count >= 2; }) : wAll;
  var html = wMsg ? '<p class="wmsg">' + wMsg + '</p>' : '';
  if (!rows.length) {
    html += '<p class="cap">' + (wAll.length
      ? '没有错 2 次以上的题——去掉筛选看全部 ' + wAll.length + ' 道。'
      : '错题本是空的。去「刷题」页做几道，做错的会自动进这里。') + '</p>';
    wRoot.innerHTML = html;
    return;
  }
  /* 按模块分组。模块顺序 = 服务端回来的顺序（last_at 倒序），不在这里另排。 */
  var groups = [], cur = null;
  rows.forEach(function (q) {
    if (!cur || cur.mod !== q.module) { cur = { mod: q.module, items: [] }; groups.push(cur); }
    cur.items.push(q);
  });
  html += '<p class="cap">错题本共 <b>' + rows.length + '</b> 题'
    + (wOnly2 ? '（只显示错 2 次以上，全部 ' + wAll.length + ' 题）' : '')
    + '。点选项就能重做这一题，做对了它就不再出现。</p>'
    + '<p class="wchk"><label><input type="checkbox" data-wonly2="1"'
    + (wOnly2 ? ' checked' : '') + '> 只显示错 2 次以上</label></p>'
    + groups.map(function (g) {
        return '<h3>' + g.mod + '</h3>' + g.items.map(wCard).join('');
      }).join('');
  wRoot.innerHTML = html;
}

/* ---- 取数 ----
   这两个是本页自带的（本页没引 bank.js，见文件头）。形状与 bank.js 的 api 一致：
   服务端回 {"error": "…"} 时优先用它当报错文字，不是 JSON 就退回状态码。 */
async function wFetch(path, opts) {
  var r = await fetch(path, opts);
  if (!r.ok) {
    var msg = r.status + ' ' + r.statusText;
    try { msg = (await r.json()).error || msg; } catch (e) { /* 不是 JSON 就用状态码 */ }
    throw new Error(msg);
  }
  return r.json();
}
function wGet(path) { return wFetch(path); }
function wPost(path, body) {
  return wFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body) });
}

async function wLoad() {
  var data = await wGet('/api/wrong');
  wAll = (data && data.questions) || [];
  wRender();
}

/* 操作失败：把服务端那句话摆到最上面，已经取回来的列表照旧留着。
   「重做」失败时勾选态也留着——用户还能再点一次「确认作答」。 */
function wFail(what, err) {
  wMsg = what + '：' + err.message + '（可以再试一次）';
  wRender();
}

/* 「重做这道题」：判分与记录都在服务端（POST /api/attempts →
   banklib.record_attempt），客户端不做任何判定。 */
async function wRedo(qid, chosen) {
  try { await wPost('/api/attempts', { qid: qid, chosen: chosen }); }
  catch (err) { wFail('这道题没能交上去', err); return; }
  delete wPicks[qid];
  wMsg = '';
  try { await wLoad(); }
  catch (err) { wFail('错题本没能刷新', err); }
}

/* 「标记已订正」：resolved=1，这一题不再出现在错题本里（库里的行留着）。 */
async function wResolve(qid) {
  try { await wPost('/api/wrong/' + encodeURIComponent(qid) + '/resolve', {}); }
  catch (err) { wFail('标记订正失败', err); return; }
  wMsg = '';
  try { await wLoad(); }
  catch (err) { wFail('错题本没能刷新', err); }
}

if (wRoot) {
  wRoot.addEventListener('click', async function (e) {
    var t = e.target;
    /* 「只显示错 2 次以上」。先判它：勾选框自己也带 data-wonly2，不能被
       下面的 .opt 分支抢走（它本来也不是 .opt）。 */
    var chk = t.closest ? t.closest('[data-wonly2]') : null;
    if (chk) { wOnly2 = !!chk.checked; wRender(); return; }
    /* 多选题的「确认作答」：把勾选的字母排好序一次交上去（服务端 _norm 本来就
       排序，排一次是为了提交出去的形状可预期）。 */
    var conf = t.closest ? t.closest('[data-wconfirm]') : null;
    if (conf) {
      var cid = conf.getAttribute('data-wconfirm');
      var sel = (wPicks[cid] || []).slice().sort().join('');
      if (!sel || conf.disabled) return;   /* 没勾 / 连点：不提交也不记空作答 */
      conf.disabled = true;                /* 同步锁住，两次点击之间隔着 await */
      await wRedo(cid, sel);
      return;
    }
    var btn = t.closest ? t.closest('[data-resolve]') : null;
    if (btn) { await wResolve(btn.getAttribute('data-resolve')); return; }
    var opt = t.closest ? t.closest('.opt') : null;
    if (!opt || opt.disabled) return;
    var qid = opt.getAttribute('data-wq'), key = opt.getAttribute('data-wk');
    var q = wById(qid);
    if (!q) return;
    /* 多选题：点一下只切换勾选态，判分留给「确认作答」（与刷题页一致）。 */
    if (q.type === 'multi') {
      var cur = wPicks[qid] || (wPicks[qid] = []);
      var at = cur.indexOf(key);
      if (at >= 0) cur.splice(at, 1); else cur.push(key);
      wRender();
      return;
    }
    await wRedo(qid, key);
  });
}

/* 首次取数的 Promise。页面自己不等它（渲染在 then 里跑），
   冒烟测试靠它把「等取数回来」写成一个 await，而不是赌时序。 */
var wrongReady = wLoad().catch(function (err) {
  wMsg = '错题本没取到：' + err.message;
  if (wRoot) wRoot.innerHTML = '<p class="cap">' + wMsg + '</p>';
});
