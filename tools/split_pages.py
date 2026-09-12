#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性：把 考点体系.html 的每个 <section class="view" id="X"> 拆成 web/X.html。

section 内部的 HTML 原样搬，不重写——避免搬的过程中悄悄改了内容
（搬的时候顺手"清理"一下，正是最容易把内容改坏又没人发现的做法）。

唯一的例外是锚点改写。源页面是一份文档，靠 `href="#quiz"` 在同一页里切视图；
拆页之后 #quiz 不在 direction.html 上，留着那三个按钮就是点了没反应的死键。
所以**只有**指向 14 个已知 section id 的 `href="#X"` 改成 `href="X.html"`。
碰到任何别的不认识的 `#…` href 直接抛——那说明源文件的链接形态变了，
得人来判是不是也该改写，不能默默放过。

页数：14 个内容页 + index.html + wrong.html = 16。
"""
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, '考点体系.html')
OUT = os.path.join(BASE, 'web')

# <section class="view" id="X" …>…</section>。非贪婪，14 个 section 之间没有嵌套。
SECTION_RE = re.compile(
    r'<section class="view" id="([\w-]+)"[^>]*>([\s\S]*?)</section>')

# 页面体里唯一的 <a href="#…"> 形态。`href="#'` 这种拼接式（旧页面的 JS 里生成
# 上一类/下一类）不匹配——它压根不在 section 内部，也就搬不进任何一页。
ANCHOR_RE = re.compile(r'href="#([^"]*)"')

# 顺序 = 源文件里的出现顺序，也是导航顺序。
TITLES = {
    'direction': '备考方向', 'compare': '大纲比对', 'edu': '教育类专业能力',
    'pub': '公共基础知识', 'news': '时政要点', 'local': '唐山政策与市情',
    'school': '校情·唐山工业职业技术大学', 'counselor': '高校辅导员',
    'quiz': '刷题', 'mock': '模拟考试', 'mnemonic': '记忆口诀',
    'interview': '面试', 'sprint': '冲刺计划', 'material': '资料',
}
SECTION_IDS = set(TITLES)
# index / wrong 在源文件里没有对应的 <section>，但也走同一个模板。
EXTRA_TITLES = {'index': '总览', 'wrong': '错题本'}

# 哪些页面要额外脚本。nav.js 由模板统一加载，不在这里。
# 注意 wrong.js 由后续任务产出，此刻还不存在——页面先按计划引着，
# 缺文件的 404 是阶段性的，不是这里该补的。
# quiz 与 mock 都多引一个 bank.js：两个引擎取数用的都是它挂的 window.api，
# **必须排在各自引擎之前**，否则引擎一取数就 ReferenceError。
SCRIPTS = {
    'quiz': ('<script src="assets/bank.js"></script>\n'
             '<script src="assets/quiz.js"></script>\n'),
    'mock': ('<script src="assets/bank.js"></script>\n'
             '<script src="assets/mock.js"></script>\n'),
    'wrong': '<script src="assets/wrong.js"></script>\n',
}

# 首页入口卡片由 home.js 读 window.NAV 渲染（导航数据只在 nav.js 里有一份）。
# lead 里的「唐山教考 2026」原本是任务书给首页的 <h1> 文字；页面标题现在归 masthead
# 的 <h1>（总览）管，再留一个 h1 就是两个，所以把这行字折进 lead，别丢了。
INDEX_BODY = ('<p class="lead">唐山教考 2026 · 从导航栏进入各分类。</p>\n'
              '<div class="quick" id="quick"></div>')
WRONG_BODY = '<div id="wrongRoot"></div>'


class UnexpectedAnchor(SystemExit):
    """源文件里出现了计划外的 `href="#…"`。"""


def rewrite_anchors(html, page):
    """把同文档锚点改成跨页链接，返回 (新 HTML, 改写条数)。

    只认 14 个 section id；别的锚点抛，不放过。
    """
    n = 0

    def repl(m):
        nonlocal n
        tgt = m.group(1)
        if tgt not in SECTION_IDS:
            raise UnexpectedAnchor(
                f'{page}: 遇到不认识的锚点 href="#{tgt}"。'
                f'只改写指向 14 个 section id 的锚点，其余要人工判断——'
                f'直接放过会留下点了没反应的死键，所以这里中断。')
        n += 1
        return f'href="{tgt}.html"'

    return ANCHOR_RE.sub(repl, html), n


def render(tpl, sid, title, body, scripts):
    return (tpl.replace('__TITLE__', title)
               .replace('__ID__', sid)
               .replace('__BODY__', body)
               .replace('__SCRIPTS__', scripts))


def main():
    with open(SRC, encoding='utf-8') as f:
        h = f.read()
    with open(os.path.join(OUT, '_template.html'), encoding='utf-8') as f:
        tpl = f.read()

    sections = [(m.group(1), m.group(2)) for m in SECTION_RE.finditer(h)]
    if not sections:
        raise SystemExit('没找到任何 <section class="view">，源文件结构变了？')
    got = [sid for sid, _ in sections]
    if len(got) != len(SECTION_IDS) or set(got) != SECTION_IDS:
        raise SystemExit(f'section 与预期不符：拿到 {got}')

    written = []
    rewrites = 0
    for sid, inner in sections:
        body, n = rewrite_anchors(inner.strip(), sid)
        rewrites += n
        page = render(tpl, sid, TITLES[sid], body, SCRIPTS.get(sid, ''))
        written.append((sid + '.html', page))

    # 首页壳：入口卡片交给 home.js（读 nav.js 的 window.NAV），不在这里写死。
    # 也引 bank.js：home.js 的「导入旧版记录」是一次写操作，按项目规矩走
    # window.api（错误处理只有那一处），别再各写一份 fetch。顺序不能反。
    written.append(('index.html',
                    render(tpl, 'index', EXTRA_TITLES['index'], INDEX_BODY,
                           '<script src="assets/bank.js"></script>\n'
                           '<script src="assets/home.js"></script>\n')))
    # 错题本壳：Task 15 往里填内容，这里先给出容器，否则导航里那一项是死链。
    written.append(('wrong.html',
                    render(tpl, 'wrong', EXTRA_TITLES['wrong'], WRONG_BODY,
                           SCRIPTS['wrong'])))

    # 改写条数是硬数字：源文件里就 3 条（都在 direction 的 .quick 里）。
    # 数目变了说明源文件的链接形态动了，得重新看一遍再改这个数字。
    if rewrites != 3:
        raise UnexpectedAnchor(f'锚点改写了 {rewrites} 条，预期 3 条——'
                               f'源文件里的同文档链接变了，重新核对后再放行')

    for name, page in written:
        if ANCHOR_RE.search(page):
            raise UnexpectedAnchor(f'{name}: 输出里仍有未改写的 href="#…"')
        with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
            f.write(page)
        print(f'  {name:<16} {len(page):>7} 字符')
    print(f'共 {len(written)} 个页面，改写锚点 {rewrites} 条')
    return 0


if __name__ == '__main__':
    sys.exit(main())
