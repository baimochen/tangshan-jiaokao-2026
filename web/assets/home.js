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
  // 只在两个 key **都**在时才建这个按钮：只有一个就没有可导的东西（老页面永远
  // 是两个一起写、一起清），点了只会白跑一趟。
  var A_KEY = 'jiaokao-answers-2026', W_KEY = 'jiaokao-wrong-2026';
  var legacy = null;
  try {
    var a = localStorage.getItem(A_KEY), w = localStorage.getItem(W_KEY);
    // 存储被禁（隐私模式）、内容不是 JSON、或者解出来不是对象（旧页面存进去的
    // 是 {qid: …} 两个映射），都当「没有旧记录」：宁可不显示按钮，也别让首页
    // 脚本抛在这儿——上面的入口卡片已经渲完了，这里一抛，用户看到的就是一段
    // 没有来源的空白。
    if (a && w) {
      var pa = JSON.parse(a), pw = JSON.parse(w);
      if (pa && pw && typeof pa === 'object' && typeof pw === 'object') {
        legacy = { answers: pa, wrong: pw };
      }
    }
  } catch (e) { legacy = null; }

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
      post('/api/migrate/legacy', legacy).then(function (r) {
        // 跳过多少条必须报出来：题库换代时对不上的题号本来就导不进去，
        // 静默丢掉才会让人以为「怎么少了几十条」。
        btn.innerHTML = label('已导入 ' + r.imported + ' 条', r.skipped
          ? '跳过 ' + r.skipped + ' 条（这些题号现在的题库里没有）'
          : '旧记录已全部并进服务器');
      }, function (e) {
        // 失败还能再点：服务没起、网络断了都会走这里。
        btn.disabled = false;
        btn.innerHTML = label('导入旧版记录',
          '导入失败：' + e.message + '（点一下重试）');
      });
    });
  }

  // 首页没有 bank.js（index.html 的脚本集被 tests/test_split.py 钉死成 nav + home
  // 两个），所以 window.api 在这里通常不存在。有就用它；没有就照它那套语义发
  // 这一次 POST——错误一样翻成可读的中文，别把 "Failed to fetch" 甩给用户。
  function post(path, body) {
    if (window.api && window.api.post) return window.api.post(path, body);
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || (r.status + ' ' + r.statusText));
        return d || {};
      });
    });
  }
})();
