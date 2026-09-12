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

  // —— Task 11 的「导入旧版记录」按钮加在这里 ——
  // 位置：本 IIFE 末尾。样式可复用 .quick 那套卡片的观感；
  // 只在 localStorage 里同时存在 jiaokao-answers-2026 与 jiaokao-wrong-2026 时才显示。
})();
