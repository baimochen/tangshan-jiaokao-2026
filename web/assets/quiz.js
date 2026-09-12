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

/* 多选题勾上、还没点「确认作答」的选项：qid → 按点击顺序排的 key 数组。
   只活在本次页面会话里，刷新即丢（跟没做过的题一样）。全量重渲染时靠它把勾选态
   画回去，确认作答后立刻清掉——再不点确认就关页面，等于没答过。 */
var picks = {};

/* 服务端判的分：qid → true/false。只覆盖本次会话里答过的题——
   页面重开后它是空的，isRight() 对那种老记录才退回按答案比。 */
var verdicts = {};

function pad(n) { return n < 10 ? '0' + n : '' + n; }

/* 作答记录一律当字符串看。localStorage 是用户随手能改的地方，旧版本也可能写进去
   别的东西（{"e1":true}、["A"]、7）——非字符串按「什么都没勾」处理，页面照常打开。
   改前那条 `a === q.answer` 对任何类型都只是「不相等」，谁都没机会把整页带崩。 */
function ansStr(s) { return typeof s === 'string' ? s : ''; }

/* 与 banklib._norm 同一套规范化：去首尾空白、转大写、去重、排序。
   顺序和重复都不该影响对错——服务端就是这么判的（_norm 里 set() + sorted()），
   客户端重开页面后按答案比的那条也必须跟着，否则「多选题答对了、重开页面
   却变成答错」只在字母不是规范序时冒出来。 */
function normAns(s) {
  var seen = {}, out = [];
  s = ansStr(s).replace(/^\s+|\s+$/g, '').toUpperCase();
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (!seen[c]) { seen[c] = 1; out.push(c); }
  }
  return out.sort().join('');
}

/* 判分只信服务端。BANK 里当然也有 answer，但那是渲染用的原料，不是判分依据——
   「多选题少选算错」这类规则只在 banklib.grade 里有一份，客户端不再抄第二份。
   verdicts 里没有的（页面重开带来的、旧版本写下的记录）才按答案比一次，
   规范化之后与 banklib.grade 等价：单选、判断题是单个字母，多选是不会因
   字母顺序而翻案的一串。 */
function isRight(q) {
  var v = verdicts[q.id];
  if (v !== undefined) return !!v;
  var a = answers[q.id];
  return !!a && normAns(a) === normAns(q.answer);
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
  /* 判断题不能乱序：「正确」在「错误」前面是有含义的（解析里说「正确」就是上面那个），
     打乱了顺序会让解析和按钮对不上。直接回原数组：返回后所有调用方都只读
     （cardHTML 用 .map 生成新数组、posOf 只比 key），没有谁改动它。 */
  if (q.type === 'judge') return q.options;
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
   「（B 档）」（双高计划的档次）；整段英文单词里的字母也一律不碰。

   指代不止单字母，还有**连着的字母串**：「故选 ABD」「AB 两项」「ACD 三项」。
   串必须整串一起判、整串一起换——只看单个字母的话 B 的前面是 A、后面是 D，
   两条邻接守卫都不认它，会把串里除头一个之外的全漏掉。
   所以 remapExplain 的扫描单位是「连续 [ABCD] 串」而不是单个字母；
   相邻字母守卫也跟着挪到整串的两头（串外紧挨拉丁字母才跳过），
   单字母（串长 1）的判定与从前逐字节一致。 */
function isOptRef(pre, post, runLen) {
  /* 连着字母串后面紧跟术语词的是术语缩写，不是选项：「ABC 理论」（理性情绪疗法
     的三个变量）、「ABC 模型」。只对多字母串生效——单字母的判定一条都不动。 */
  if (runLen > 1 && /^\s*(理论|模型|阶段|学说|假说|定律|公式|效应)/.test(post)) return false;
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
  var out = '', last = 0, m, re = /[ABCD]{1,4}/g;
  while ((m = re.exec(s))) {
    var i = m.index, run = m[0], n = run.length;
    if (/[A-Za-z]/.test(s.charAt(i - 1)) || /[A-Za-z]/.test(s.charAt(i + n))) continue;
    if (!isOptRef(s.slice(Math.max(0, i - 6), i), s.slice(i + n, i + n + 6), n)) continue;
    var repl = '';
    for (var j = 0; j < n; j++) repl += shownKey(q, run.charAt(j));
    out += s.slice(last, i) + repl; last = i + n;
  }
  return out + s.slice(last);
}

/* 某个选项 key 在不在这个字母串里。单选/判断题传进来的是单个字母，多选是 'ABD'
   这样一串——同一套判断在三种题型上都成立。（不能写成 o.key === q.answer：
   多选下 'A' === 'ABD' 恒为假，四个选项会一个不落地掉进 dim，用户看不出哪几项对。） */
function hasKey(s, key) { return ansStr(s).indexOf(key) >= 0; }

function optionHTML(q, a, o, di) {
  var cls = 'opt';
  if (a) {
    /* 判对错看的是「这一项在不在正确答案里」，不是「它是不是整串答案」。
       没勾却正确的项照样标 correct——少选的人正需要看到自己漏了哪一项。 */
    if (hasKey(q.answer, o.key)) cls += ' correct';
    else if (hasKey(a, o.key)) cls += ' wrong';
    else cls += ' dim';
  } else if (q.type === 'multi' && hasKey((picks[q.id] || []).join(''), o.key)) {
    /* 多选题还没确认：勾上的项先标出来，点一下切换勾选态（不判分）。 */
    cls += ' picked';
  }
  /* 判断题不显示 A/B：选项从来就是「正确 / 错误」两个，标上字母只会让人先在脑子里
     把字母和文字对一次，而它又不会乱序，字母一点信息都不带。
     data-k 照旧挂着——点击处理器靠它认所选项（见下面 list 的 click），删了题就点不动。 */
  var letter = q.type === 'judge' ? '' : '<span class="k">' + letterAt(di) + '</span>';
  return '<li><button class="' + cls + '" type="button" data-q="' + q.id + '" data-k="' + o.key + '"'
    + (a ? ' disabled' : '') + '>' + letter + '<span class="t">' + o.text + '</span></button></li>';
}
/* 答案行左侧那个「答案是啥」的标签。单选显示的是选项字母（乱序后它才是用户看到的那个
   字母），判断题没有字母可指，显示选项的文字——否则卡片上会写「答案 A」，
   而卡上根本没有叫 A 的按钮。 */
function answerLabel(q) {
  if (q.type === 'judge') {
    var opts = q.options || [];
    for (var i = 0; i < opts.length; i++) { if (opts[i].key === q.answer) return opts[i].text; }
    return q.answer;
  }
  /* 多选的答案是一串字母，每一个都得按乱序后的显示位置换一次——
     直接写 q.answer（'ABD'）的话，选项一乱序，卡上标的字母就和真正正确的
     那几个按钮对不上了（和单选显示 shownKey(q, q.answer) 是同一个道理）。 */
  if (q.type === 'multi') {
    var ls = [];
    for (var j = 0; j < q.answer.length; j++) ls.push(shownKey(q, q.answer.charAt(j)));
    return ls.sort().join('');
  }
  return shownKey(q, q.answer);
}
function cardHTML(q) {
  var a = answers[q.id] || null;
  var opts = shuffledOpts(q).map(function (o, i) { return optionHTML(q, a, o, i); }).join('');
  /* 多选题未确认时下方挂「确认作答」：勾选只改 picked，判分等这一步。
     提交后（a 真）按钮就没了——卡片锁定，只剩对错和解析。 */
  var sub = (!a && q.type === 'multi')
    ? '<div class="qmore"><button type="button" data-confirm="' + q.id + '">确认作答</button></div>'
    : '';
  var ans = a ? '<div class="ans"><span class="key">' + answerLabel(q) + '</span>' + remapExplain(q, q.explanation) + '</div>' : '';
  return '<div class="qz' + (isWrong(q) ? ' wrong' : '') + '" data-card="' + q.id + '">'
    + '<p class="stem"><span class="no">' + pad(q.n) + '</span>' + q.stem + '</p>'
    + '<ul class="opts">' + opts + '</ul>' + sub + ans + '</div>';
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

/* 作答落库。单选/判断题点一下就走这里；多选题先把勾选攒着，点「确认作答」才走。
   判分只问服务端：correct 由 banklib.grade 判出来，顺带把这次作答记进 bank.db——
   错题本从此是库里的数据，不再是这个浏览器独有的一份。 */
async function submitAnswer(q, chosen) {
  var res;
  try { res = await api.post('/api/attempts', { qid: q.id, chosen: chosen }); }
  catch (err) {
    /* 没记上就当没答：留一份服务端不知道的记录（错题本、统计）只会更乱。 */
    console.error('作答没能记进题库：' + err.message);
    return false;
  }
  answers[q.id] = chosen;         /* 错题自动进错题本：由 isWrong() 判定 */
  verdicts[q.id] = !!res.correct;
  delete picks[q.id];             /* 确认过了，勾选态清掉（重做时不该还留着） */
  persist();
  var old = list.querySelector('[data-card="' + q.id + '"]');
  if (old) old.outerHTML = cardHTML(q);
  stats();
  return true;
}

if (list) {
  list.addEventListener('click', async function (e) {
    var more = e.target.closest ? e.target.closest('[data-more]') : null;
    if (more) { shown += PAGE; render(false); return; }
    /* 多选题的「确认作答」。先于 .opt 判：它挂的是 data-confirm，不是 .opt。
       把勾选的字母排好序一次交上去——服务端 _norm 本来就排序，这里排一次是为了
       本机存下的作答也是规范序（重开页面按答案比的那条更不容易翻案）。 */
    var conf = e.target.closest ? e.target.closest('[data-confirm]') : null;
    if (conf) {
      var cid = conf.getAttribute('data-confirm');
      var cq = byId[cid];
      /* answers[cid]：已经答过的题不再提交（列表里确认按钮已经撤了，这道守卫挡的是
         直点旧按钮、以及重渲染前的连点）。disabled：同一次点击事件里同步锁住，
         两次点击之间隔着 await，光靠 answers[cid] 拦不住第二次。 */
      if (!cq || answers[cid] || conf.disabled) return;
      var sel = (picks[cid] || []).slice().sort().join('');
      if (!sel) return;           /* 一项都没勾：不提交，也不记一笔空作答 */
      conf.disabled = true;
      /* 没记上（服务端不通）就把按钮放开，让用户还能重试 */
      if (!(await submitAnswer(cq, sel))) conf.disabled = false;
      return;
    }
    var btn = e.target.closest ? e.target.closest('.opt') : null;
    if (!btn || btn.disabled) return;
    var id = btn.getAttribute('data-q'), k = btn.getAttribute('data-k');
    var q = byId[id];
    if (!q || answers[id]) return;
    /* 多选题：点一下只切换勾选态，不判分——判分留给「确认作答」。 */
    if (q.type === 'multi') {
      var cur = picks[id] || (picks[id] = []);
      var at = cur.indexOf(k);
      if (at >= 0) cur.splice(at, 1); else cur.push(k);
      var card = list.querySelector('[data-card="' + id + '"]');
      if (card) card.outerHTML = cardHTML(q);
      return;
    }
    await submitAnswer(q, k);
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
  qs.forEach(function (q) { if (isWrong(q)) { delete answers[q.id]; delete verdicts[q.id]; delete picks[q.id]; } });
  persist(); render(true); stats();
});
var wReset = document.getElementById('wrongReset');
if (wReset) wReset.addEventListener('click', function () {
  answers = {}; verdicts = {}; picks = {}; persist();
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
