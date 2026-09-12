// 刷题引擎。从 考点体系.html 的内联脚本里「刷题」那一段搬出来（任务 9）。
// 行为与源页面等价，只有两处真正改了：
//   · 取数改成异步——首次渲染前 await api.get('/api/questions?limit=1000000')
//   · 判分改成问服务端——点选项后 await api.post('/api/attempts', {qid, chosen})
// 其余一律照搬，没有「顺手清理」：分页 40、SHUF 缓存、选项乱序、显示字母、
// 解析字母随选项重映射、模块下拉、三个筛选、清空记录 / 重做错题。
//
// **顶层一律用 var / function，不要改成 const / let；也不要包 IIFE。**
// tests/smoke.js 把本文件连同 nav.js / bank.js 一起 eval 进一个函数作用域里跑。
// 直接 eval 时 var 与函数声明会落进外层作用域（冒烟测试靠这个拿到 quizReady），
// const / let 只会留在 eval 自己的作用域里——改掉的话引用引擎全局量的那一句
// 直接 ReferenceError。包成 IIFE 同理：什么都没露出来。
// 浏览器里两种写法等价：经典脚本顶层的 var 就是 window 上的属性（window.BANK）。
//
// 本文件自包含：pad / letterAt / shownKey / isOptRef / remapExplain 这些在源文件里
// 和视图切换、模考共用一个作用域，拆出来之后一律自己带一份，不依赖别的脚本
// （除了 bank.js 的 window.api）。

var AKEY = 'jiaokao-answers-2026', WKEY = 'jiaokao-wrong-2026';

var list = document.getElementById('qlist');
var emptyEl = document.getElementById('qempty');
var elDone = document.getElementById('qDone');
var elRate = document.getElementById('qRate');
var elWrong = document.getElementById('wrongN');
var elTotal = document.getElementById('qTotal');
var modSel = document.getElementById('qMod');
var filter = 'all';
var modFilter = '';          /* 模块下拉的当前值，空串 = 全部模块 */

/* 全库一次取回，分页只发生在渲染层（PAGE=40）。取数之前两者是空的。 */
var BANK = null;             /* {total, questions} */
var qs = [];                 /* BANK.questions 的别名——matched()/stats() 都吃全量 */
var byId = {};

var answers = {};
try { answers = JSON.parse(localStorage.getItem(AKEY) || '{}') || {}; } catch (e) { answers = {}; }

/* 服务端判的分：qid → true/false。只覆盖本次会话里答过的题——
   页面重开后它是空的，isRight() 对那种老记录才退回按答案比。 */
var verdicts = {};

function pad(n) { return n < 10 ? '0' + n : '' + n; }

/* 判分只信服务端。BANK 里当然也有 answer，但那是渲染用的原料，不是判分依据——
   「多选题少选算错」这类规则只在 banklib.grade 里有一份，客户端不再抄第二份。
   verdicts 里没有的（页面重开带来的、旧版本写下的记录）才按答案比一次，
   单选下那条与 banklib.grade 等价。 */
function isRight(q) {
  var v = verdicts[q.id];
  if (v !== undefined) return !!v;
  var a = answers[q.id];
  return !!a && a === q.answer;
}
function isWrong(q) { return !!answers[q.id] && !isRight(q); }

function persist() {
  var w = {};
  qs.forEach(function (q) { if (isWrong(q)) w[q.id] = 1; });
  try {
    localStorage.setItem(AKEY, JSON.stringify(answers));
    localStorage.setItem(WKEY, JSON.stringify(w));
  } catch (e) {}
}

/* ---- 选项乱序 ----
   题库里 answer 是按选项原始顺序写的。乱序只发生在显示层：
   · 显示字母永远按 A/B/C/D 顺着排，跟原始 key 无关
   · data-k / data-mk 上挂的仍是「原始 key」，答题记录、错题本一律用原始 key 记账
   所以已存的做题记录和错题本完全不受影响，也不需要迁移。
   顺序按题缓存在本页面会话里：同一题在本次打开期间顺序固定（答完不会跳），
   重新打开页面换一批新顺序。 */
var SHUF = {};
function letterAt(i) { return 'ABCD'.charAt(i); }
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
/* 某个原始 key 被排到了第几位 */
function posOf(q, key) {
  var a = shuffledOpts(q);
  for (var i = 0; i < a.length; i++) { if (a[i].key === key) return i; }
  return -1;
}
/* 某个原始 key 显示出来时是第几个字母 */
function shownKey(q, key) {
  var p = posOf(q, key);
  return p < 0 ? key : letterAt(p);
}

/* ---- 解析里的字母 ----
   解析大量用字母指代选项（1000 题里 768 题有，共 2700 多处）：「A 项…故选 B」、
   「A、B、D 三项」。选项一乱序，这些字母就指错了，得跟着一起换。
   但字母不都指代选项，所以只换明确指代选项的写法：
     · 「x 项」「故选 x」「故x。」「答案为 x」「x 正确」
     · 「A、B、D」「A 与 B」这类并列枚举里的字母
   不换的例如「ABC 理论——A 是诱发事件，B 是信念」（那是情绪理论的三个变量）、
   「（B 档）」（双高计划的档次）；整段英文单词里的字母也一律不碰。 */
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

function optionHTML(q, a, o, di) {
  var cls = 'opt';
  if (a) {
    if (o.key === q.answer) cls += ' correct';
    else if (o.key === a) cls += ' wrong';
    else cls += ' dim';
  }
  return '<li><button class="' + cls + '" type="button" data-q="' + q.id + '" data-k="' + o.key + '"'
    + (a ? ' disabled' : '') + '><span class="k">' + letterAt(di) + '</span><span class="t">' + o.text + '</span></button></li>';
}
function cardHTML(q) {
  var a = answers[q.id] || null;
  var opts = shuffledOpts(q).map(function (o, i) { return optionHTML(q, a, o, i); }).join('');
  var ans = a ? '<div class="ans"><span class="key">' + shownKey(q, q.answer) + '</span>' + remapExplain(q, q.explanation) + '</div>' : '';
  return '<div class="qz' + (isWrong(q) ? ' wrong' : '') + '" data-card="' + q.id + '">'
    + '<p class="stem"><span class="no">' + pad(q.n) + '</span>' + q.stem + '</p>'
    + '<ul class="opts">' + opts + '</ul>' + ans + '</div>';
}

/* 题库有 1000 题，一次性渲染会卡住手机：按页渲染，首屏 40 题，「再显示」逐页追加。
   筛选条件变化时回到第一页。 */
var PAGE = 40, shown = PAGE;
function matched() {
  return qs.filter(function (q) {
    var a = answers[q.id];
    if (filter === 'todo' && a) return false;
    if (filter === 'wrong' && !isWrong(q)) return false;
    if (modFilter && q.module !== modFilter) return false;
    return true;
  });
}
function render(resetPaging) {
  if (resetPaging) shown = PAGE;
  var f = matched(), slice = f.slice(0, shown);
  var groups = [], cur = null;
  slice.forEach(function (q) {
    if (!cur || cur.mod !== q.module) { cur = { mod: q.module, items: [] }; groups.push(cur); }
    cur.items.push(q);
  });
  var html = groups.map(function (g) {
    return '<h3>' + g.mod + '</h3>' + g.items.map(cardHTML).join('');
  }).join('');
  var left = f.length - shown;
  if (left > 0) {
    html += '<div class="qmore"><button type="button" data-more="1">'
      + '再显示 ' + Math.min(left, PAGE) + ' 题<em>还有 ' + left + ' 题</em></button></div>';
  }
  list.innerHTML = html;
  if (emptyEl) emptyEl.hidden = f.length > 0;
}
function stats() {
  var done = 0, right = 0, bad = 0;
  qs.forEach(function (q) {
    if (!answers[q.id]) return;
    done++;
    if (isRight(q)) right++; else bad++;
  });
  if (elDone) elDone.textContent = done;
  if (elRate) elRate.textContent = done ? Math.round(right / done * 100) + '%' : '—';
  if (elWrong) elWrong.textContent = bad;
}

if (list) {
  list.addEventListener('click', async function (e) {
    var more = e.target.closest ? e.target.closest('[data-more]') : null;
    if (more) { shown += PAGE; render(false); return; }
    var btn = e.target.closest ? e.target.closest('.opt') : null;
    if (!btn || btn.disabled) return;
    var id = btn.getAttribute('data-q'), k = btn.getAttribute('data-k');
    var q = byId[id];
    if (!q || answers[id]) return;
    /* 判分只问服务端：correct 由 banklib.grade 判出来，顺带把这次作答
       记进 bank.db——错题本从此是库里的数据，不再是这个浏览器独有的一份。 */
    var res;
    try { res = await api.post('/api/attempts', { qid: id, chosen: k }); }
    catch (err) {
      /* 没记上就当没答：留一份服务端不知道的记录（错题本、统计）只会更乱。 */
      console.error('作答没能记进题库：' + err.message);
      return;
    }
    answers[id] = k;              /* 错题自动进错题本：由 isWrong() 判定 */
    verdicts[id] = !!res.correct;
    persist();
    var old = list.querySelector('[data-card="' + id + '"]');
    if (old) old.outerHTML = cardHTML(q);
    stats();
  });
}

var fbtns = [].slice.call(document.querySelectorAll('.fbtn'));
fbtns.forEach(function (b) {
  b.addEventListener('click', function () {
    filter = b.getAttribute('data-filter');
    fbtns.forEach(function (x) { x.classList.toggle('active', x === b); });
    render(true);
  });
});

/* 模块下拉：选项直接从题库推导，顺序就是模块在题库里首次出现的顺序（即大纲顺序）。
   以后往题库里加模块，下拉会自动多一项，这里不用改。
   选项要等取数回来才填，所以监听在这里就挂上、innerHTML 交给 buildModSelect。 */
if (modSel) {
  modSel.addEventListener('change', function () {
    modFilter = modSel.value; render(true);
  });
}
function buildModSelect() {
  if (!modSel) return;
  var mods = [], cnt = {};
  qs.forEach(function (q) {
    if (mods.indexOf(q.module) < 0) mods.push(q.module);
    cnt[q.module] = (cnt[q.module] || 0) + 1;
  });
  modSel.innerHTML = '<option value="">全部模块（' + qs.length + '）</option>'
    + mods.map(function (m) {
      return '<option value="' + m + '">' + m + '（' + cnt[m] + '）</option>';
    }).join('');
}

var redo = document.getElementById('redoWrong');
if (redo) redo.addEventListener('click', function () {
  qs.forEach(function (q) { if (isWrong(q)) { delete answers[q.id]; delete verdicts[q.id]; } });
  persist(); render(true); stats();
});
var wReset = document.getElementById('wrongReset');
if (wReset) wReset.addEventListener('click', function () {
  answers = {}; verdicts = {}; persist();
  filter = 'all'; modFilter = '';
  if (modSel) modSel.value = '';
  fbtns.forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-filter') === 'all'); });
  render(true); stats();
});

/* ---- 取数 ----
   整库一次取回（limit 开到服务端上限 1000000），分页仍在客户端做。
   limit 写小（比如一页 40）会静默截断：matched()/stats()/模块下拉/未做数
   全都在取回来的那份上算，页面不报错，只是数字全错——所以这里必须开满。 */
async function loadBank() {
  var data = await api.get('/api/questions?limit=1000000');
  BANK = data;
  qs = data.questions || [];
  byId = {};
  qs.forEach(function (q) { byId[q.id] = q; });
  buildModSelect();
  if (elTotal) elTotal.textContent = qs.length;
  render(); stats();
}

/* 首次取数的 Promise。页面自己不等它（渲染在 then 里跑），
   冒烟测试靠它把「等取数回来」写成一个 await，而不是赌时序。 */
var quizReady = loadBank().catch(function (err) {
  if (list) list.innerHTML = '<p class="cap">题库没取到：' + err.message + '</p>';
});
