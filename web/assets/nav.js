// 导航注入 + 主题切换。每个页面只需 <script src="assets/nav.js"></script>。
// 放哪儿都行：<head> 里（不必加 defer）或 </body> 之前，两种都能挂上。
//
// 本文件由 tools/extract_assets.py 生成过一次，之后直接改这里。
//
// 自包含：NAV 就写在本文件里，不拆成 nav-data.js。
// 拆开的话页面要多一个 <script> 标签、还得保证加载顺序；
// 更要命的是 nav-data.js 一旦 404，NAV.map 直接抛异常，
// 整个导航会从页面上无声消失——只有控制台里留一行报错。
(function () {
  window.NAV = [
  {
    "id": "index",
    "label": "总览",
    "href": "index.html"
  },
  {
    "id": "direction",
    "label": "方向",
    "href": "direction.html"
  },
  {
    "id": "compare",
    "label": "比对",
    "href": "compare.html"
  },
  {
    "id": "edu",
    "label": "教育类",
    "href": "edu.html"
  },
  {
    "id": "pub",
    "label": "公基",
    "href": "pub.html"
  },
  {
    "id": "news",
    "label": "时政",
    "href": "news.html"
  },
  {
    "id": "local",
    "label": "唐山",
    "href": "local.html"
  },
  {
    "id": "school",
    "label": "校情",
    "href": "school.html"
  },
  {
    "id": "counselor",
    "label": "辅导员",
    "href": "counselor.html"
  },
  {
    "id": "quiz",
    "label": "刷题",
    "href": "quiz.html"
  },
  {
    "id": "wrong",
    "label": "错题本",
    "href": "wrong.html"
  },
  {
    "id": "mock",
    "label": "模考",
    "href": "mock.html"
  },
  {
    "id": "mnemonic",
    "label": "口诀",
    "href": "mnemonic.html"
  },
  {
    "id": "interview",
    "label": "面试",
    "href": "interview.html"
  },
  {
    "id": "sprint",
    "label": "冲刺",
    "href": "sprint.html"
  },
  {
    "id": "material",
    "label": "资料",
    "href": "material.html"
  }
];

  // 把导航插到 <body> 最前面，并按 body[data-page] 高亮当前页。
  function mountNav() {
    const here = document.body.dataset.page || '';
    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.setAttribute('aria-label', '分类导航');
    nav.innerHTML =
      '<div class="nav-inner">' +
      // 品牌文字沿用源页面的「教育类考点体系」；现在是个链接，指向新的总览页。
      '<a class="nav-brand" href="index.html">教育类考点体系</a>' +
      '<ul class="nav-list">' +
      window.NAV.map(function (n) {
        // 走 n.href，不走「id 拼 .html」——index 的 id 和文件名对不上，
        // 拼接式会在这一项上悄悄指错地方。
        return '<li><a href="' + n.href + '"' +
               (n.id === here ? ' class="active"' : '') + '>' + n.label + '</a></li>';
      }).join('') +
      '</ul>' +
      '<button class="theme-btn" id="themeBtn" type="button" aria-label="切换主题">◐</button>' +
      '</div>';
    document.body.insertBefore(nav, document.body.firstChild);
  }

  // 三态主题，实际循环是：跟随系统 → 暗 → 亮 → 跟随系统（跟随系统即删掉 data-theme）。
  // 注意：系统本来就是暗色偏好时，第一次点击把 data-theme 设成 "dark"，
  // 但页面此前渲染的就是暗色——所以那一下看起来没反应，要到第二次点才有变化。
  //
  // 只有碰到 localStorage 的两步裹 try：隐私模式/禁用存储的浏览器上它们会直接抛。
  // 不裹 → 异常冒出去整段挂掉；裹得太大（把挂监听也圈进去）→ 按钮成了死键。
  // 所以：读失败就当没存过，写失败就只改内存里的主题——两种情况下按钮都还能用，
  // 因为改 data-theme 本身是纯 DOM 操作，不依赖存储。
  function mountTheme() {
    const KEY = 'jiaokao-theme';
    const setTheme = function (v) {
      if (v) { document.documentElement.dataset.theme = v; }   // 先改 DOM，再谈落盘
      else { delete document.documentElement.dataset.theme; }
      try {
        if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY);
      } catch (e) { /* localStorage 不可用时静默降级：主题能切，只是记不住 */ }
    };
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) document.documentElement.dataset.theme = saved;
    } catch (e) { /* 读不到就当没存过 */ }
    document.getElementById('themeBtn').addEventListener('click', function () {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
      setTheme(next);
    });
  }

  // mountNav 碰 document.body，所以必须等 <body> 存在再跑。
  // 把 <script> 放进 <head>（这是最容易犯的错，而下一步要拿一个模板批量生成
  // 15 个页面——错一次就复制 15 份）时，此刻 document.body 还是 null，
  // mountNav 会抛，导航整个从页面上消失。与其在注释里写「别忘了放 </body> 前」，
  // 不如让这个失败模式压根不存在。
  function mount() {
    mountNav();
    mountTheme();
  }

  window.mountNav = mountNav;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();   // 已经在 </body> 前跑（readyState 已是 interactive/complete），直接挂
  }
})();
