# -*- coding: utf-8 -*-
"""拆页结果。这是「一个模板错误被复制 15 份」的场合——模板里多一个空格、
模板里漏一段 <head>，肉眼看一个页面是发现不了的，所以每条都逐页验一遍。

比对的基准是源文件 考点体系.html 本身（它是回归参照，不许改）。
section 内部的 HTML 必须**逐字节**搬过去，唯一允许的差异是指向 14 个
section id 的同文档锚点被改成了跨页链接（源文件里正好 3 条）。
所以比对方式：把页面里那 3 条改写倒回去，再和源文件里的原文做相等比较。
"""
import importlib.util
import os
import re
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, '考点体系.html')
WEB = os.path.join(BASE, 'web')

SECTION_RE = re.compile(
    r'<section class="view" id="([\w-]+)"[^>]*>([\s\S]*?)</section>')
DATA_PAGE_RE = re.compile(r'<body data-page="([\w-]+)">')
BODY_TAG_RE = re.compile(r'<body[^>]*>')
# head 里的主题脚本：内容不逐字比对（注释可改），只认它做了这件事——
# 在 app.css 之前、从 localStorage 里取 jiaokao-theme 落到 dataset.theme。
THEME_RE = re.compile(
    r'<script>(?=[^<]*localStorage\.getItem\([\'"]jiaokao-theme[\'"]\))'
    r'(?=[^<]*dataset\.theme)[^<]*</script>')
FONT_LINKS = [
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2'
    '?family=IBM+Plex+Mono:wght@500;600&family=Noto+Sans+SC:wght@400;500;700'
    '&family=Noto+Serif+SC:wght@600;700&display=swap">',
]

# 14 个有源 section 的内容页，外加两个壳。顺序与源文件一致。
CONTENT_IDS = ['direction', 'compare', 'edu', 'pub', 'news', 'local', 'school',
               'counselor', 'quiz', 'mock', 'mnemonic', 'interview', 'sprint',
               'material']
SHELL_IDS = ['index', 'wrong']
ALL_IDS = CONTENT_IDS + SHELL_IDS

# 源文件里每一处 `href="#X"` 都指向这 3 个 id，且都在 direction 的 .quick 里。
ANCHOR_REWRITES = {'quiz': 'quiz.html', 'sprint': 'sprint.html',
                   'mnemonic': 'mnemonic.html'}


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def page_path(sid):
    return os.path.join(WEB, sid + '.html')


def source_sections():
    """{sid: section 内部 HTML（未 strip）}，直接取自源文件。"""
    return {m.group(1): m.group(2)
            for m in SECTION_RE.finditer(read(SRC))}


def page_section(html):
    """页面里那个 <section class="view"> 的 (id, 内部 HTML)，没有则 None。"""
    m = SECTION_RE.search(html)
    return (m.group(1), m.group(2)) if m else None


def revert_rewrites(html):
    """把跨页链接倒回同文档锚点，好和源文件逐字节比。"""
    for sid, href in ANCHOR_REWRITES.items():
        html = html.replace(f'href="{href}"', f'href="#{sid}"')
    return html


class TestPagesExist(unittest.TestCase):
    def test_all_16_pages_exist(self):
        missing = [sid for sid in ALL_IDS if not os.path.isfile(page_path(sid))]
        self.assertEqual(missing, [], f'缺页面：{missing}')
        self.assertEqual(len(ALL_IDS), 16)   # 14 内容页 + index + wrong

    def test_template_exists(self):
        self.assertTrue(os.path.isfile(os.path.join(WEB, '_template.html')))

    def test_every_page_is_complete_html(self):
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                html = read(page_path(sid))
                self.assertTrue(html.startswith('<!doctype html>\n'),
                                f'{sid}: 缺 doctype')
                self.assertIn('</body>\n</html>\n', html)
                self.assertEqual(html.count('<body'), 1, f'{sid}: body 标签数不对')


class TestDataPage(unittest.TestCase):
    def test_data_page_matches_filename(self):
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                tag = BODY_TAG_RE.search(read(page_path(sid)))
                self.assertIsNotNone(
                    tag, f'{sid}.html 里没有 <body> —— '
                         f'nav.js 靠 body[data-page] 高亮当前页，缺了导航永不点亮')
                self.assertEqual(tag.group(0), f'<body data-page="{sid}">')

    def test_section_id_matches_page(self):
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                found = page_section(read(page_path(sid)))
                self.assertIsNotNone(found, f'{sid}.html 里没有 .view section')
                self.assertEqual(found[0], sid)


class TestVerbatimContent(unittest.TestCase):
    def setUp(self):
        self.src = source_sections()

    def test_source_has_the_14_expected_sections(self):
        self.assertEqual(list(self.src), CONTENT_IDS)

    def test_source_anchors_are_exactly_the_3_known_ones(self):
        """源文件里 section 内部的 `href="#…"` 必须正好是那 3 条。

        拆页脚本把「3」写成了硬数字（数目变了就中断）。这条测试是那个
        数字的锚：源文件一改，这里先红，而不是脚本静默少改/多改。
        """
        anchors = []
        for sid, inner in self.src.items():
            anchors += [m.group(1) for m in
                        re.finditer(r'href="#([^"]*)"', inner)]
        self.assertEqual(sorted(anchors), sorted(ANCHOR_REWRITES))

    def test_section_inner_is_verbatim(self):
        """逐字节比对：倒回 3 条改写后，与源文件的 section 内部完全相等。"""
        for sid in CONTENT_IDS:
            with self.subTest(page=sid):
                found = page_section(read(page_path(sid)))
                self.assertIsNotNone(found)
                # 页面里是改写过的形态，倒回去再和源文件比。
                got = revert_rewrites(found[1].strip())
                want = self.src[sid].strip()
                self.assertEqual(got, want,
                                 f'{sid}.html 的正文与源文件不一致')

    def test_rewrites_appear_only_where_the_source_had_anchors(self):
        for sid in CONTENT_IDS:
            with self.subTest(page=sid):
                page = read(page_path(sid))
                want = sorted(k for k, v in ANCHOR_REWRITES.items()
                              if f'href="#{k}"' in self.src[sid])
                got = sorted(k for k, v in ANCHOR_REWRITES.items()
                             if f'href="{v}"' in page)
                self.assertEqual(got, want)

    def test_no_page_body_keeps_a_hash_href(self):
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                body = read(page_path(sid)).split('<main class="wrap">', 1)[1]
                self.assertNotRegex(
                    body, r'href="#',
                    f'{sid}.html 正文里还留着同文档锚点——拆页之后它就是死键')

    def test_hidden_children_survive(self):
        """4 个在 #mock、1 个在 #quiz 的默认折叠面板不能被「清理」掉。"""
        for sid in ('mock', 'quiz'):
            with self.subTest(page=sid):
                self.assertEqual(
                    read(page_path(sid)).count(' hidden'),
                    self.src[sid].count(' hidden'))


class TestNoNavData(unittest.TestCase):
    def test_no_page_references_nav_data(self):
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                self.assertNotIn('nav-data.js', read(page_path(sid)),
                                 f'{sid}.html 引了不存在的 nav-data.js')

    def test_no_file_in_web_mentions_nav_data(self):
        hits = [n for n in os.listdir(WEB) if n.endswith(('.html', '.js'))
                and 'nav-data.js' in read(os.path.join(WEB, n))]
        self.assertEqual(hits, [])

    def test_content_pages_load_nav_js(self):
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                self.assertIn('<script src="assets/nav.js"></script>',
                              read(page_path(sid)))


class TestHead(unittest.TestCase):
    def test_pages_are_split_from_the_same_template(self):
        """所有页面的 head 逐字节相同——模板错一次会错 16 份，这里一次抓住。

        head 里只有 <title> 随页面变，先把它归一掉（只留 <title> 标签本身）。
        """
        heads = set()
        for sid in ALL_IDS:
            html = read(page_path(sid))
            head = html[html.index('<head>'):html.index('</head>')]
            heads.add(re.sub(r'<title>.*?</title>', '<title></title>', head))
        self.assertEqual(len(heads), 1,
                         f'各页面的 head 不一致：{len(heads)} 种')

    def test_theme_script_present_and_before_app_css(self):
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                html = read(page_path(sid))
                head = html[:html.index('</head>')]
                m = THEME_RE.search(head)
                self.assertIsNotNone(
                    m, f'{sid}.html 的 head 里没有预置主题的脚本——'
                       f'暗色用户每页都会先闪一下白底')
                self.assertLess(
                    m.start(), head.index('assets/app.css'),
                    f'{sid}.html 的主题脚本排在 app.css 之后，白闪挡不住')

    def test_font_links_present_in_order_before_app_css(self):
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                head = read(page_path(sid))
                head = head[:head.index('</head>')]
                css_at = head.index('assets/app.css')
                prev = -1
                for link in FONT_LINKS:
                    at = head.find(link)
                    self.assertGreaterEqual(
                        at, 0, f'{sid}.html 少了字体链接：{link}')
                    self.assertLess(at, css_at,
                                    f'{sid}.html 的字体链接在 app.css 之后')
                    self.assertGreater(at, prev,
                                       f'{sid}.html 的字体链接顺序不对')
                    prev = at

    def test_title_is_per_page(self):
        titles = {}
        for sid in ALL_IDS:
            html = read(page_path(sid))
            titles[sid] = re.search(r'<title>(.*?)</title>', html).group(1)
        self.assertEqual(len(set(titles.values())), len(ALL_IDS),
                         f'标题有重复：{titles}')
        for sid, t in titles.items():
            self.assertTrue(t.endswith(' · 唐山教考 2026'), f'{sid}: {t!r}')

    def test_masthead_on_every_page(self):
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                html = read(page_path(sid))
                self.assertIn(
                    '<p class="eyebrow">唐山工业职业技术大学 · 2026 选聘 · 教育类</p>',
                    html, f'{sid}.html 缺 masthead 的 eyebrow 行')


class TestEntryPoints(unittest.TestCase):
    def test_index_loads_home_js_after_nav_js(self):
        html = read(page_path('index'))
        self.assertIn('<script src="assets/home.js"></script>', html)
        self.assertLess(html.index('assets/nav.js'), html.index('assets/home.js'),
                        'nav.js 必须在 home.js 之前：NAV 由 nav.js 提供')

    def test_page_scripts_match_the_plan(self):
        want = {'index': ['assets/home.js'],
                'quiz': ['assets/quiz.js'], 'mock': ['assets/mock.js'],
                'wrong': ['assets/wrong.js']}
        for sid in ALL_IDS:
            with self.subTest(page=sid):
                body = read(page_path(sid)).split('</main>', 1)[1]
                got = re.findall(r'<script src="([^"]+)"></script>', body)
                self.assertEqual(got, ['assets/nav.js'] + want.get(sid, []))


def load_splitter():
    """把 tools/split_pages.py 当模块加载。它顶层只算常量、不读文件，import 安全。"""
    path = os.path.join(BASE, 'tools', 'split_pages.py')
    spec = importlib.util.spec_from_file_location('split_pages', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestAnchorGuard(unittest.TestCase):
    """R7 的护栏本身。没这条测试，「不认识的锚点就中断」只是注释里的一句话：
    把 sub 换成不抛的分支，其它测试照样全绿。"""

    def setUp(self):
        self.mod = load_splitter()

    def test_section_ids_agree_with_this_file(self):
        """拆页脚本的 section 名单和测试文件里写死的名单不许漂移。"""
        self.assertEqual(sorted(self.mod.SECTION_IDS), sorted(CONTENT_IDS))
        self.assertEqual(sorted(self.mod.TITLES), sorted(CONTENT_IDS))

    def test_known_anchor_is_rewritten(self):
        out, n = self.mod.rewrite_anchors('<a href="#quiz">x</a>', 'demo')
        self.assertEqual((out, n), ('<a href="quiz.html">x</a>', 1))

    def test_unknown_anchor_raises_instead_of_passing_through(self):
        with self.assertRaises(self.mod.UnexpectedAnchor) as cm:
            self.mod.rewrite_anchors('<a href="#material">x</a>'
                                     '<a href="#typo">y</a>', 'demo')
        self.assertIn('typo', str(cm.exception))

    def test_empty_anchor_raises(self):
        with self.assertRaises(self.mod.UnexpectedAnchor):
            self.mod.rewrite_anchors('<a href="#">x</a>', 'demo')

    def test_js_concatenated_href_also_raises(self):
        """旧脚本里 `'<a href="#'+id+'"'` 这种拼接也匹配得上——正则是朴素的 `[^"]*`。

        这条不是缺陷：拆页只扫 section 内部，这段 JS 在 section 之外，实际碰不到。
        真要碰到了，要的是中断而不是悄悄放过（反正 `'+views[i-1].id+'` 也改写不出
        正确的跨页链接）。写成断言是为了记住「朴素是有意的」，别哪天顺手把它放宽。
        """
        with self.assertRaises(self.mod.UnexpectedAnchor):
            self.mod.rewrite_anchors(
                "html+='<a class=\"pv\" href=\"#'+views[i-1].id+'\">x</a>';", 'demo')


if __name__ == '__main__':
    unittest.main()
