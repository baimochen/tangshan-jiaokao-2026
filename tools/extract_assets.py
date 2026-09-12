#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 考点体系.html 抽出共享 CSS 与导航，生成 web/assets/ 下的文件。

只跑一次。之后直接改 web/assets/app.css 和 web/assets/nav.js，
不要重跑本脚本——重跑会把手改的内容冲掉。
（bank.js 不是从页面里抽的，是本步新写的，不归这里管。）

用法：
    python3 tools/extract_assets.py
    python3 tools/extract_assets.py --src 别的.html --out /tmp/x   # 只为验证护栏
"""
import argparse
import json
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, '考点体系.html')
OUT = os.path.join(BASE, 'web', 'assets')

# 源导航里有且只有 14 个页面锚点。写出常量而不是「有多少算多少」，
# 是为了让抽取失败时当场炸掉——导航少一项是静默的（页面照常打开，只是少个入口），
# 等发现时已经发版了。数字对不上就说明源文件变了，得人来看。
EXPECT_ITEMS = 14

# 新首页（总览）排在最前，错题本是新增页，插在「模考」之前。
INDEX_ITEM = {'id': 'index', 'label': '总览', 'href': 'index.html'}
WRONG_ITEM = {'id': 'wrong', 'label': '错题本', 'href': 'wrong.html'}

# 源页面里没有主题按钮，所以源 CSS 里也没有 .theme-btn。
# 但源 CSS 已经写好了完整的三态主题（裸 :root 亮 / prefers-color-scheme 暗 /
# :root[data-theme="dark"] 强制暗），只是没有东西能碰到它。这一步补上按钮，
# 顺手补上它最小的一份样式——这是本步唯一一处「改了行为」的地方。
THEME_BTN_CSS = """
/* 主题按钮：源页面没有这个控件，样式是本步新加的（见 task-7-report.md）。
   透明底 + 一条细边框，跟导航文字一个色调；padding 对齐 .nav-list a。
   flex/font-size/line-height/cursor 只是把 <button> 的 UA 默认外观拉平。 */
.theme-btn{
  flex:0 0 auto;padding:5px 10px;font-size:13.5px;line-height:1;cursor:pointer;
  color:var(--slate);background:transparent;
  border:1px solid var(--rule);border-radius:3px;
}
"""

NAV_JS = """// 导航注入 + 主题切换。每个页面只需 <script src="assets/nav.js"></script>。
// 本文件由 tools/extract_assets.py 生成过一次，之后直接改这里。
//
// 自包含：NAV 就写在本文件里，不拆成 nav-data.js。
// 拆开的话页面要多一个 <script> 标签、还得保证加载顺序；
// 更要命的是 nav-data.js 一旦 404，NAV.map 直接抛异常，
// 整个导航会从页面上无声消失——只有控制台里留一行报错。
window.NAV = {nav_items};

// 把导航插到 <body> 最前面，并按 body[data-page] 高亮当前页。
function mountNav() {{
  const here = document.body.dataset.page || '';
  const nav = document.createElement('nav');
  nav.className = 'nav';
  nav.setAttribute('aria-label', '分类导航');
  nav.innerHTML =
    '<div class="nav-inner">' +
    // 品牌文字沿用源页面的「教育类考点体系」；现在是个链接，指向新的总览页。
    '<a class="nav-brand" href="index.html">教育类考点体系</a>' +
    '<ul class="nav-list">' +
    window.NAV.map(function (n) {{
      // 走 n.href，不走「id 拼 .html」——index 的 id 和文件名对不上，
      // 拼接式会在这一项上悄悄指错地方。
      return '<li><a href="' + n.href + '"' +
             (n.id === here ? ' class="active"' : '') + '>' + n.label + '</a></li>';
    }}).join('') +
    '</ul>' +
    '<button class="theme-btn" id="themeBtn" type="button" aria-label="切换主题">◐</button>' +
    '</div>';
  document.body.insertBefore(nav, document.body.firstChild);
}}

// 三态主题：跟随系统 → 亮 → 暗。
// 只有碰到 localStorage 的两步裹 try：隐私模式/禁用存储的浏览器上它们会直接抛。
// 不裹 → 异常冒出去整段挂掉；裹得太大（把挂监听也圈进去）→ 按钮成了死键。
// 所以：读失败就当没存过，写失败就只改内存里的主题——两种情况下按钮都还能用，
// 因为改 data-theme 本身是纯 DOM 操作，不依赖存储。
function mountTheme() {{
  const KEY = 'jiaokao-theme';
  const setTheme = function (v) {{
    if (v) {{ document.documentElement.dataset.theme = v; }}   // 先改 DOM，再谈落盘
    else {{ delete document.documentElement.dataset.theme; }}
    try {{
      if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY);
    }} catch (e) {{ /* localStorage 不可用时静默降级：主题能切，只是记不住 */ }}
  }};
  try {{
    const saved = localStorage.getItem(KEY);
    if (saved) document.documentElement.dataset.theme = saved;
  }} catch (e) {{ /* 读不到就当没存过 */ }}
  document.getElementById('themeBtn').addEventListener('click', function () {{
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    setTheme(next);
  }});
}}

window.mountNav = mountNav;
mountNav();
mountTheme();
"""


def extract_css(html):
    """取 <style> 整块，补上 .nav-brand 的链接样式和 .theme-btn。"""
    m = re.search(r'<style>([\s\S]*?)</style>', html)
    if not m:
        raise SystemExit('❌ 源文件里没有 <style>…</style> 块')

    css = m.group(1).strip()

    # 品牌从 <span> 变成 <a> 之后会带下划线，得显式去掉。
    # 只在基础那条规则上加（媒体查询里那条是 display:none，不碰）。
    pat = re.compile(r'\.nav-brand\{([^}]*flex:0 0 auto)\}')
    hits = pat.findall(css)
    if len(hits) != 1:
        raise SystemExit(f'❌ 期望恰好 1 条带 flex:0 0 auto 的 .nav-brand 规则，实际 {len(hits)} 条')
    css = pat.sub(lambda m: '.nav-brand{' + m.group(1) + ';text-decoration:none}', css, count=1)

    return css + '\n' + THEME_BTN_CSS


def extract_nav(html):
    """只从 <nav>…</nav> 块里抓锚点。

    不对整篇文档扫：页面上别处也有 href="#x" 的链接（.quick 宫格），
    今天它们恰好因为子元素是 <span> 而没被 [^<]+ 匹配上——是撞对的，不是设计对的。
    限死在 <nav> 里，再对数量较真，护栏才算数。
    """
    block = re.search(r'<nav\b[\s\S]*?</nav>', html)
    if not block:
        raise SystemExit('❌ 源文件里没有 <nav>…</nav> 块')

    items = []
    seen = set()
    for m in re.finditer(r'<a href="#([\w-]+)"[^>]*>([^<]+)</a>', block.group(0)):
        if m.group(1) in seen:
            continue
        seen.add(m.group(1))
        items.append({'id': m.group(1), 'label': m.group(2), 'href': m.group(1) + '.html'})

    if len(items) != EXPECT_ITEMS:
        got = ', '.join(i['id'] for i in items) or '（一个都没有）'
        raise SystemExit(
            f'❌ <nav> 里应有 {EXPECT_ITEMS} 个锚点，实际 {len(items)} 个：{got}\n'
            f'   源文件结构变了，先人工确认再改 EXPECT_ITEMS。'
        )
    return items


def build_nav(items):
    """首页插到最前，错题本插在 mock 前。"""
    out = [dict(INDEX_ITEM)] + [dict(i) for i in items]
    if not any(i['id'] == 'wrong' for i in out):
        at = next((n for n, i in enumerate(out) if i['id'] == 'mock'), len(out))
        out.insert(at, dict(WRONG_ITEM))
    return out


def main():
    ap = argparse.ArgumentParser(description='从考点体系.html 抽共享资源')
    ap.add_argument('--src', default=SRC, help='源 HTML（默认 考点体系.html）')
    ap.add_argument('--out', default=OUT, help='输出目录（默认 web/assets）')
    a = ap.parse_args()

    with open(a.src, encoding='utf-8') as f:
        html = f.read()

    # 先把两边都抽完、校验过，再动磁盘：护栏在写盘前拦住的话，
    # 半新半旧的文件不会留在 web/assets/ 里。
    css = extract_css(html)
    items = extract_nav(html)
    nav = build_nav(items)
    js = NAV_JS.format(nav_items=json.dumps(nav, ensure_ascii=False, indent=2))

    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'app.css'), 'w', encoding='utf-8') as f:
        f.write(css)
    with open(os.path.join(a.out, 'nav.js'), 'w', encoding='utf-8') as f:
        f.write(js)

    print(f'✅ app.css  {len(css)} 字符')
    print(f'✅ nav.js   {len(nav)} 项（源 {len(items)} + 总览 + 错题本）')


if __name__ == '__main__':
    main()
