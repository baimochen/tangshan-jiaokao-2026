#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把已验证的视频链接作为「视频课」分支插进 考点体系.html 各思维导图，并加对应 CSS。"""
import json, re, os, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(BASE, '考点体系.html')

V = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'verified.json'), encoding='utf-8'))

# bv -> (思维导图里显示的短名, 备注)
SHORT = {
 'BV1yA411376X': ('教综·思维导图梳理',        '皮卡丘jiujiujiu'),
 'BV1WyStYnEnp': ('山香·教综系统精讲课',      '山香招教学堂'),
 'BV1yK4y127ip': ('教育学基础（国家精品课）',  '醋酸哲'),
 'BV1WXCPYKEAd': ('粉笔·教育知识与能力',      '粉笔教师'),
 'BV1vc411G7C4': ('北师大·教育心理学 81讲',   '刘儒德'),
 'BV1Fy4y1i79C': ('北师大·普通心理学 123讲',  '陈宝国'),
 'BV1Lm4y1w7sf': ('超格·教育心理学带背',      '懒鬼柴柴'),
 'BV1t3411j7F7': ('教育心理学考点大全',       'hi叶叶'),
 'BV1bD4y1C7Y9': ('教资·法律法规梳理',        '想回城堡啦'),
 'BV1Su411X7Y1': ('教师考编·小三门考点大全',  'hi叶叶'),
 'BV11g41117d3': ('小三门·教育法律法规',      '师大中奕教育'),
 'BV1b4421A7ry': ('科目一·职业理念',          '刘大悟'),
 'BV1TA4m1L7tP': ('科目一·职业道德',          '刘大悟'),
 'BV1hc411v7Md': ('职业道德规范·带背',        '保护海尔兄弟'),
 'BV1hM4m1U7rA': ('马克·公基常识系统课（最新）', '马克Mark'),
 'BV17K411N7hU': ('马克·公基常识系统课（经典）', '刘文超Vin'),
 'BV1S54y1e77E': ('李铁·公基系统课',          '李铁106'),
 'BV1CE411o7x3': ('徐涛·马原串讲',            '研途考研'),
 'BV1Lf4y177iY': ('马原概论（北京大学）',      '造物者花'),
 'BV1ugrTYyE2U': ('马克·法律刷题课',          '马克Mark'),
 'BV1Xg41177Sq': ('公基法律·民法',            '白鲸学长'),
 'BV1oL411E7tu': ('公基法律·宪法',            '白鲸学长'),
 'BV1qb4y1S7Q7': ('公基法律·行政法',          '白鲸学长'),
 'BV1TASnYKEvM': ('法律基础·民法刑法宪法',     '公考余思君'),
 'BV1pB4y1Y7ou': ('公共基础·公文篇',          '金标尺'),
 'BV1yB4y1n7Yg': ('一节课搞定公文格式',        '易公公考'),
 'BV163wxzZEBu': ('马克·公文刷题726道',       '马克Mark'),
 'BV1d142117S5': ('马克·经济刷题1260道',      '马克Mark'),
 'BV1RU4y1q7Bh': ('公共基础·管理基础知识',    '金标尺'),
 'BV1Bz4y157ux': ('经济学原理·通俗讲',         '公考杰出青年'),
 'BV12h411J7at': ('辅导员笔试·全题型讲解',     '三水是朵花'),
 'BV1Ea4y1k7GN': ('辅导员笔试·模拟题解析',     '京图高校'),
 'BV1yV411J7vn': ('辅导员笔试·案例分析技巧',   '高校辅导员招聘德叔'),
 'BV1kG4y1X7eG': ('案例分析·答题模板',        '张咔咔-kk'),
 'BV1D14y1Q7fh': ('案例分析·校园危机事件',     '张咔咔-kk'),
 'BV13D4y1m7fo': ('辅导员大赛·主题班会决赛',   'XUTer'),
 'BV1oL411L7FG': ('高等教育学·第一章 导论',    '高校辅导员招聘德叔'),
 'BV1si4y1d72T': ('高等教育学·第二章 发展',    '高校辅导员招聘德叔'),
 'BV1Nu411q7yX': ('高等教育心理学·绪论',       '高校辅导员招聘德叔'),
 'BV1BiCYYzERN': ('高职院校招聘·职教知识',     'uffo349'),
 'BV1Q58BzHE5y': ('李梦娇·常识口诀88条',      '公考李梦娇'),
 'BV13b41157rn': ('常识判断·蒙题套路',        '行测喜哥'),
 'BV1RM4y1H7hM': ('必背常识300条·磨耳朵',     '公考杰出青年'),
 'BV18P4y1B7DM': ('秒懂历史概念（全套）',      '历史老师定哥'),
 'BV1xRA8ebExT': ('河北国土规划·唐山定位',     '全景历史地理'),
 'BV1KL4y1E7jX': ('京津冀协同发展',            '严帅地理'),
 'BV1XH4y1c7qT': ('《City唐山》·GDP破万亿',   '航拍网'),
 'BV1Ep4y1H7ky': ('【印象·唐山】城市协奏',     '烛灯夜馆'),
}

BY_BV = {}
for mod, items in V.items():
    for it in items:
        BY_BV[it['bv']] = it

def fmt_play(n):
    if not n: return ''
    return ('%.1f万' % (n / 10000)) if n >= 10000 else str(n)

def link(bv):
    it, sh = BY_BV[bv], SHORT[bv]
    short, who = sh
    full = it['real_title']
    play = fmt_play(it['play'])
    return ('<li><a class="vl" href="https://www.bilibili.com/video/%s/" '
            'target="_blank" rel="noopener" title="%s —— %s（播放 %s）">%s'
            '<em>%s · %s</em></a></li>') % (bv, full.replace('"', '&quot;'), who, play,
                                            short, who, play)

def branch(groups, indent=8):
    """所有模块挂在同一个「配套视频课」根节点下，模块名走 .n 分支样式。"""
    pad = ' ' * indent
    out = ['%s<li><span class="v">配套视频课</span>' % pad, '%s  <ul>' % pad]
    for title, bvs in groups:
        out.append('%s    <li><span class="n">%s</span>' % (pad, title))
        out.append('%s      <ul>' % pad)
        for bv in bvs:
            out.append('%s        %s' % (pad, link(bv)))
        out += ['%s      </ul>' % pad, '%s    </li>' % pad]
    out += ['%s  </ul>' % pad, '%s</li>' % pad]
    return '\n'.join(out)

# 每张思维导图插什么
def groups_for(mind_key):
    if mind_key == 'edu1':
        return [
            ('教育学',            ['BV1yA411376X', 'BV1WyStYnEnp', 'BV1yK4y127ip', 'BV1WXCPYKEAd']),
            ('教育心理学',        ['BV1vc411G7C4', 'BV1Fy4y1i79C', 'BV1Lm4y1w7sf', 'BV1t3411j7F7']),
            ('教育法律法规',      ['BV1Su411X7Y1', 'BV1bD4y1C7Y9', 'BV11g41117d3']),
            ('教师职业理念与职业道德', ['BV1b4421A7ry', 'BV1TA4m1L7tP', 'BV1hc411v7Md']),
            ('职业教育与高等教育',  ['BV1oL411L7FG', 'BV1Nu411q7yX', 'BV1si4y1d72T', 'BV1BiCYYzERN']),
        ]
    if mind_key == 'edu2':
        return [
            ('教育心理学（人物 · 理论 · 实验）',
             ['BV1vc411G7C4', 'BV1Fy4y1i79C', 'BV1Lm4y1w7sf', 'BV1t3411j7F7']),
        ]
    if mind_key == 'pub':
        return [
            ('政治与时政',        ['BV1hM4m1U7rA', 'BV1S54y1e77E', 'BV1CE411o7x3', 'BV1Lf4y177iY']),
            ('法律',              ['BV1ugrTYyE2U', 'BV1Xg41177Sq', 'BV1oL411E7tu', 'BV1qb4y1S7Q7', 'BV1TASnYKEvM']),
            ('公文写作',          ['BV1pB4y1Y7ou', 'BV1yB4y1n7Yg', 'BV163wxzZEBu']),
            ('经济、管理与常识',   ['BV1d142117S5', 'BV1RU4y1q7Bh', 'BV1Bz4y157ux']),
            ('人文历史与科技常识',  ['BV1Q58BzHE5y', 'BV13b41157rn', 'BV1RM4y1H7hM', 'BV18P4y1B7DM']),
        ]
    if mind_key == 'news':
        return [('时政与政治理论', ['BV1hM4m1U7rA', 'BV17K411N7hU', 'BV1S54y1e77E'])]
    if mind_key == 'local':
        return [('唐山 · 京津冀 · 市情',
                 ['BV1xRA8ebExT', 'BV1KL4y1E7jX', 'BV1XH4y1c7qT', 'BV1Ep4y1H7ky'])]
    if mind_key == 'school':
        return [('唐山 · 京津冀 · 市情',
                 ['BV1xRA8ebExT', 'BV1KL4y1E7jX', 'BV1XH4y1c7qT', 'BV1Ep4y1H7ky'])]
    if mind_key == 'counselor':
        return [
            ('高校辅导员',        ['BV12h411J7at', 'BV1Ea4y1k7GN', 'BV1yV411J7vn', 'BV1kG4y1X7eG',
                                   'BV1D14y1Q7fh', 'BV13D4y1m7fo']),
            ('职业教育与高等教育',  ['BV1oL411L7FG', 'BV1si4y1d72T', 'BV1Nu411q7yX', 'BV1BiCYYzERN']),
        ]
    return []

CSS = """
/* ---- 思维导图里的视频课分支 ---- */
.mm>li>.v{display:inline-block;font-family:var(--serif);font-weight:700;font-size:16px;
  color:var(--paper);background:var(--cinnabar);padding:5px 15px;border-radius:3px}
.mm>li>.v::before{content:"▶";font-size:9px;margin-right:7px;vertical-align:1px}
.mm a.vl{display:inline-block;color:var(--ink-2);text-decoration:none;font-size:13.5px;
  padding:1px 0;border-bottom:1px solid transparent}
.mm a.vl:hover,.mm a.vl:focus-visible{color:var(--indigo);border-bottom-color:var(--indigo)}
.mm a.vl::before{content:"↗";font-size:10px;color:var(--slate);margin-right:5px}
.mm a.vl:hover::before{color:var(--indigo)}
.mm a.vl em{font-family:var(--mono);font-size:10px;font-style:normal;font-weight:500;
  color:var(--slate);background:var(--surface-2);padding:1px 5px;border-radius:2px;margin-left:7px}
.video-note{font-size:12.5px;line-height:1.75;color:var(--slate);margin:12px 0 0}
.video-note b{color:var(--ink-2)}
.video-note a{color:var(--indigo)}
"""

if __name__ == '__main__':
    html = open(HTML, encoding='utf-8').read()
    lines = html.split('\n')

    # 1) 定位每个 mind 的 ul.mm 结束行（从后往前插，避免行号漂移）
    keys = ['edu1', 'edu2', 'pub', 'news', 'local', 'school', 'counselor']
    starts = [i for i, l in enumerate(lines) if '<div class="mind">' in l]
    if len(starts) != len(keys):
        print('!! 思维导图数量变了: %d，预期 %d' % (len(starts), len(keys)))
        sys.exit(1)

    ends = []
    for s in starts:
        j = s
        while 'ul class="mm"' not in lines[j]:
            j += 1
        depth, k = 0, j
        while k < len(lines):
            depth += lines[k].count('<ul') - lines[k].count('</ul>')
            if depth == 0:
                break
            k += 1
        ends.append(k)

    for key, end in sorted(zip(keys, ends), key=lambda t: -t[1]):
        groups = groups_for(key)
        if not groups:
            print('  %-10s 跳过' % key); continue
        indent = len(lines[end]) - len(lines[end].lstrip())
        lines.insert(end, branch(groups, indent))
        n = sum(len(b) for _, b in groups)
        print('  %-10s 插入 %d 组 / %d 条视频（第 %d 行前）' % (key, len(groups), n, end + 1))

    html = '\n'.join(lines)

    # 2) 注入 CSS（插在 --mono 变量定义那一行附近不行，放 </style> 前）
    if '.mm a.vl' not in html:
        html = html.replace('</style>', CSS + '</style>', 1)

    # 3) 每张思维导图的标题下加一句可点击说明
    html = html.replace(
        '<p class="mind-title">思维导图 · 教育类知识树总览</p>',
        '<p class="mind-title">思维导图 · 教育类知识树总览</p>\n'
        '    <p class="video-note">带 <b>▶</b> 的分支是配套视频课，点开即在 B 站播放（新标签页）。'
        '全部链接已逐条验真，播放量标注在作者后面。</p>', 1)

    open(HTML, 'w', encoding='utf-8').write(html)
    print('\n写入完成: %d 字符' % len(html))
