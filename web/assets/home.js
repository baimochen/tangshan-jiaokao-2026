// 首页专用。把 window.NAV 渲染成入口卡片填进 #quick。
//
// 依赖 nav.js：NAV 在 nav.js 顶层**同步**赋值（挂载才等 DOMContentLoaded），
// 所以只要本文件排在 nav.js 之后，读 NAV 一定是现成的——不用等事件。
// 本文件放在 </body> 前，此时 #quick 已经在 DOM 里，也不等事件。
(function () {
  var box = document.getElementById('quick');
  if (!box || !window.NAV) return;   // 页面/导航任一缺失就安静退出，别把整页脚本带崩

  // 走 n.href 而不是「id 拼 .html」：index 的 id 和文件名对不上（NAV 里 href
  // 才是唯一权威）。每项一个 <a>，文案用 .t（app.css 里 .quick .t 是大号粗体）。
  box.innerHTML = window.NAV.map(function (n) {
    return '<a href="' + n.href + '"><span class="t">' + n.label + '</span></a>';
  }).join('');

  // —— 导入旧版记录 ——
  // 老页面把作答/错题存在 localStorage 的两个 key 里（answers[qid]='A'、
  // w[qid]=1）；拆页后这些记录归服务端管，这里给老用户一次性并进 bank.db。
  //
  // 显示条件（C89）：两个映射里**至少一个非空**，且本机还没做过这次迁移。
  // 不能拿「有旧记录」当条件——新刷题页与模考页写的**正是同一对 key**
  // （quiz.js / mock.js 的 persist），内容上分不出「旧页面留下的」和「刚答的」，
  // 于是每个刷过题的新用户都会永远看到这个按钮。所以用一个
  // jiaokao-migrated-2026 标记表示「本机这次迁移做过了」，导成功后记上，
  // 之后不再出现。代价：全新用户答完第一题回首页会看到一次按钮——端点只补不盖
  // （见 banklib.import_legacy），点一下无害，且此后再不会出现。
  var A_KEY = 'jiaokao-answers-2026', W_KEY = 'jiaokao-wrong-2026';
  var M_KEY = 'jiaokao-migrated-2026';

  // 缺的键当空表（新页面可能只写了其中一个），在的键必须是 {qid: 值} 那个形状。
  // 坏 JSON、不是对象、是数组一律返回 null：这份记录不可信，整个不显示按钮——
  // 半份数据导进去比不导更糟（Array.isArray 不能省：typeof [] 也是 'object'，
  // 少了它 JSON.parse('[1,2]') 会一路过到 POST 出去）。
  function readMap(raw) {
    if (raw == null) return {};
    var v;
    try { v = JSON.parse(raw); } catch (e) { return null; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  // 服务端回的三个数各说各的：写进去几条、几条服务器上已经有了（不是丢数据）、
  // 几条对不上现在的题库。跳过的原因有两种（题号不在这代题库里 / 记录不是选中的
  // 选项 key），这里分不出来，就都写出来——只写一个的话，记录写成 {"e1":1} 的人
  // 会跑去查一个根本不存在的题库换代问题。
  function detailOf(r) {
    var parts = [];
    if (r.existing) parts.push(r.existing + ' 条服务器上已经有了');
    if (r.skipped) parts.push(r.skipped + ' 条对不上现在的题库'
      + '（题号不在里面，或者记录不是选中的选项）');
    return parts.length ? parts.join('；') : '旧记录已全部并进服务器';
  }

  var legacy = null;
  try {
    var pa = readMap(localStorage.getItem(A_KEY));
    var pw = readMap(localStorage.getItem(W_KEY));
    if (pa && pw && (Object.keys(pa).length || Object.keys(pw).length)
        && !localStorage.getItem(M_KEY)) {
      legacy = { answers: pa, wrong: pw };
    }
  } catch (e) { legacy = null; }   // 存储被禁（隐私模式）等：当没有旧记录

  if (legacy) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'legacyImport';
    btn.className = 'legacy';
    var nA = Object.keys(legacy.answers).length;
    var nW = Object.keys(legacy.wrong).length;
    var label = function (t, d) {
      return '<span class="t">' + t + '</span><span class="d">' + d + '</span>';
    };
    btn.innerHTML = label('导入旧版记录',
      '把本机存的 ' + nA + ' 条作答、' + nW + ' 条错题导进服务器');
    box.appendChild(btn);

    btn.addEventListener('click', function () {
      // 导的过程中禁用：连点两下会让这一次导入发两遍。
      btn.disabled = true;
      btn.innerHTML = label('正在导入…', '别关页面');
      // 写操作走 bank.js 那一份 window.api（错误处理只有那一处：非 2xx 时
      // 抛出服务端回的 {"error": …} 那句话，e.message 直接就能给用户看）。
      window.api.post('/api/migrate/legacy', legacy).then(function (r) {
        // 本机这次迁移做完了：记上标记，按钮以后不再出现。存储写不进去
        // （隐私模式）就当没记——下次还会显示，而端点只补不盖，点了无害。
        try { localStorage.setItem(M_KEY, '1'); } catch (e) {}
        // 跳过多少条必须报出来：题库换代时对不上的题号本来就导不进去，
        // 静默丢掉才会让人以为「怎么少了几十条」。
        btn.innerHTML = label('已导入 ' + r.imported + ' 条', detailOf(r));
      }, function (e) {
        // 失败还能再点：服务没起、网络断了都会走这里。
        btn.disabled = false;
        btn.innerHTML = label('导入旧版记录',
          '导入失败：' + e.message + '（点一下重试）');
      });
    });
  }
})();
