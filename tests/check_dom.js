/* nav.js 的运行时产物检查：导航条 + 上一类/下一类。
 *
 * 为什么要有这个文件：nav.js 做的事全在运行时（往 body 插 nav、往 wrap 插
 * .view-nav）。tests/test_split.py 读的是**文件**，页面文件里根本没有这两段
 * 标记，所以一个「nav.js 什么都不渲染」的版本能让 Python 那 113 条全绿。
 * 这里用一个极简 DOM 桩真跑一遍，把「渲染不出来」变成红灯。
 *
 *     node tests/check_dom.js
 *
 * 零依赖，只用 node 自带的 fs / path。 */
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'assets', 'nav.js'), 'utf8');

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failed++; };

/* ---------- 极简 DOM 桩：只够跑 nav.js ---------- */
function mkEl(tag) {
  const el = {
    tagName: tag, _children: [], _attrs: {}, parentNode: null,
    dataset: {}, innerHTML: '', className: '',
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    addEventListener() {},
    insertBefore(node, ref) {
      const i = ref ? el._children.indexOf(ref) : -1;
      if (i < 0) el._children.push(node); else el._children.splice(i, 0, node);
      node.parentNode = el;
      return node;
    },
  };
  // nextSibling 动态算：insertBefore 之后它得跟着变，缓存一份就会读到旧的。
  Object.defineProperty(el, 'nextSibling', {
    get() {
      if (!el.parentNode) return null;
      const sibs = el.parentNode._children;
      return sibs[sibs.indexOf(el) + 1] || null;
    },
  });
  // nav.js 往 body 插导航时读的是 document.body.firstChild，桩里也得有，
  // 不然 insertBefore(nav, undefined) 会退化成「追加到末尾」。
  Object.defineProperty(el, 'firstChild', {
    get() { return el._children[0] || null; },
  });
  return el;
}

/* 按 data-page 搭一个小页面：body > main.wrap > (masthead, section#id, footer) */
function buildPage(pageId, sectionId) {
  const body = mkEl('body');
  body.dataset.page = pageId;
  const wrap = mkEl('main');
  const masthead = mkEl('header');
  const section = mkEl('section');
  section.className = 'view';
  section._attrs.id = sectionId;
  const footer = mkEl('footer');
  body.insertBefore(wrap, null);
  wrap.insertBefore(masthead, null);
  wrap.insertBefore(section, null);
  wrap.insertBefore(footer, null);

  // nav.js 会 getElementById('themeBtn') 去挂点击；桩里的 nav 是 innerHTML 出来的，
  // 没有真元素，给一个假的顶上。
  const themeBtn = mkEl('button');
  const byId = { themeBtn, [sectionId]: section };
  const doc = {
    readyState: 'complete',
    documentElement: { dataset: {} },
    body,
    createElement: t => mkEl(t),
    getElementById: id => byId[id] || null,
    addEventListener() {},
  };
  return { doc, body, wrap, section, footer, themeBtn };
}

/* 跑一遍 nav.js，返回挂完之后的页面零件。eval 前必须把桩放好：nav.js 立即执行。 */
function mount(pageId, sectionId) {
  const page = buildPage(pageId, sectionId);
  const store = {};
  global.window = { addEventListener() {} };
  global.document = page.doc;
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  eval(SRC);
  const nav = page.body._children.find(c => c.tagName === 'nav');
  const bar = page.wrap._children.find(c => c.className === 'view-nav');
  return Object.assign(page, { nav, bar, store });
}

/* ---------- 1. 导航条 ---------- */
console.log('nav 挂载:');
{
  const p = mount('edu', 'edu');
  ok(!!p.nav, 'nav 出现在 body 里');
  ok(p.nav === p.body._children[0], 'nav 是 body 的第一个子节点');
  const links = [...p.nav.innerHTML.matchAll(/<a href="([^"]+)"([^>]*)>([^<]+)<\/a>/g)]
    .filter(m => !/nav-brand/.test(m[2]));
  ok(links.length === 16, `导航 16 项（实际 ${links.length}）`);
  ok(links[0][1] === 'index.html' && links[0][3] === '总览', '第一项是 index.html/总览');
  const active = links.filter(m => /class="active"/.test(m[2]));
  ok(active.length === 1 && active[0][3] === '教育类',
     `高亮跟着 body[data-page] 走（实际高亮 ${active.length} 项）`);
}

/* ---------- 2. 上一类 / 下一类 ---------- */
console.log('上一类 / 下一类:');
const barOf = (pageId, sectionId) => {
  const p = mount(pageId, sectionId);
  return { bar: p.bar, p };
};
{
  const { bar, p } = barOf('edu', 'edu');
  ok(!!bar, 'edu.html 上出现了 .view-nav');
  ok(bar && bar.parentNode === p.wrap, '.view-nav 挂在 .wrap 里（不在 body 上）');
  ok(bar && p.wrap._children.indexOf(bar) === p.wrap._children.indexOf(p.section) + 1,
     '.view-nav 紧跟在本页 section 之后');
  ok(bar && p.wrap._children.indexOf(bar) < p.wrap._children.indexOf(p.footer),
     '.view-nav 排在 footer 之前');
  // NAV 顺序是 index, direction, compare, edu, pub…——edu 的上一类因此是 compare
  // （比对）而不是 direction。这里刻意写死 NAV 里的真实邻居，不按 section 顺序猜。
  ok(bar && bar.innerHTML ===
     '<a class="pv" href="compare.html">← 上一类 · 比对</a>' +
     '<a class="nx" href="pub.html">下一类 · 公基 →</a>',
     'edu 的上一类/下一类 href 与文案正确');
}
{
  const { bar } = barOf('index', 'index');
  ok(bar && /class="nx"/.test(bar.innerHTML) && !/class="pv"/.test(bar.innerHTML),
     'index 是 NAV 第一项：只有「下一类」，没有「上一类」');
}
{
  const { bar } = barOf('material', 'material');
  ok(bar && /class="pv"/.test(bar.innerHTML) && !/class="nx"/.test(bar.innerHTML),
     'material 是 NAV 最后一项：只有「上一类」，没有「下一类」');
}
{
  const { bar } = barOf('wrong', 'wrong');
  ok(bar && bar.innerHTML ===
     '<a class="pv" href="quiz.html">← 上一类 · 刷题</a>' +
     '<a class="nx" href="mock.html">下一类 · 模考 →</a>',
     'wrong 的上一类/下一类按 NAV 顺序（刷题 / 模考）');
}
{
  const { bar } = barOf('nope', 'nope');
  ok(!bar, 'data-page 不在 NAV 里时整条不挂（不猜位置）');
}

/* ---------- 3. 导航表只有一份 ---------- */
{
  const navLiterals = (SRC.match(/"id":\s*"/g) || []).length;
  ok(navLiterals === 16,
     `nav.js 里 id: 字面量 16 个（实际 ${navLiterals}）——view-nav 没有另抄一份导航表`);
  ok(/window\.NAV\.findIndex/.test(SRC), 'view-nav 从 window.NAV 找当前位置');
  ok(/document\.body\.dataset\.page/.test(SRC), 'view-nav 用 body[data-page] 定位当前页');
}

console.log(failed ? `\n❌ ${failed} 条失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
