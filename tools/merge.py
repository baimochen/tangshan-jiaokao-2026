#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 batches/*.json 的题目分片合并进 题库.json，并重新内嵌到 考点体系.html。"""
import json, re, sys, os, glob, unicodedata

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QB   = os.path.join(BASE, '题库.json')
HTML = os.path.join(BASE, '考点体系.html')

MODULE_ORDER = [
    '教育学', '教育心理学', '教育法律法规', '教师职业理念与职业道德',
    '公共基础 · 政治与时政', '公共基础 · 法律', '公共基础 · 公文写作',
    '公共基础 · 经济、管理与常识', '高校辅导员', '职业教育与高等教育',
    '人文历史与科技常识', '唐山工业职业技术大学校情', '唐山本地政策与时政',
]

PART_FILES = ['e1.json','e2.json','p1.json','p2.json','l.json','d.json','g.json',
              'f.json','w.json','j.json','c.json','v.json','r.json','s.json','t.json',
              'topup.json']

def norm(s):
    """题干归一化，用于查重：去 HTML、去空白、去标点、全角转半角。"""
    s = re.sub(r'<[^>]+>', '', s)
    s = unicodedata.normalize('NFKC', s)
    return re.sub(r'[\s，。、；：（）()"\'？！,.;:?!]', '', s)

def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)

def check(q, where):
    """单题结构校验，返回错误列表。"""
    errs = []
    if set(q) != {'id','module','stem','options','answer','explanation'}:
        errs.append('字段集合不对: %s' % sorted(q))
    if len(q.get('options', [])) != 4:
        errs.append('选项数 != 4')
    elif [o['key'] for o in q['options']] != list('ABCD'):
        errs.append('选项 key 不是 ABCD')
    if q.get('answer') not in 'ABCD':
        errs.append('answer 非法: %r' % q.get('answer'))
    if not q.get('explanation', '').strip():
        errs.append('缺解析')
    if not q.get('stem', '').strip():
        errs.append('缺题干')
    return ['%s @%s: %s' % (where, q.get('id','?'), e) for e in errs]

# ---------- 1. 载入现有题库 ----------
bank = load(QB)
quests = bank['questions']
have_ids = {q['id'] for q in quests}
have_stems = {norm(q['stem']) for q in quests}
print('现有题库: %d 题' % len(quests))

# ---------- 2. 载入并校验分片 ----------
new, errors, dup_ids, dup_stems, missing = [], [], [], [], []
for fn in PART_FILES:
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'batches', fn)
    if not os.path.exists(p):
        missing.append(fn); continue
    try:
        part = load(p)
    except Exception as e:
        errors.append('%s 解析失败: %s' % (fn, e)); continue
    if not isinstance(part, list):
        errors.append('%s 不是 JSON 数组' % fn); continue
    kept = 0
    for q in part:
        errors += check(q, fn)
        if q['id'] in have_ids:
            dup_ids.append(q['id']); continue
        ns = norm(q['stem'])
        if ns in have_stems:
            dup_stems.append('%s (%s)' % (q['id'], fn)); continue
        have_ids.add(q['id']); have_stems.add(ns)
        new.append(q); kept += 1
    print('  %-10s +%-4d (原 %d)' % (fn, kept, len(part)))

if missing:
    print('\n!! 缺分片: %s' % ', '.join(missing))
if dup_ids:
    print('!! 重复 id: %s' % ', '.join(dup_ids))
if dup_stems:
    print('!! 题干重复被丢弃 %d 条: %s' % (len(dup_stems), ', '.join(dup_stems[:20])))
if errors:
    print('!! 结构错误 %d 条:' % len(errors))
    for e in errors[:40]:
        print('   ', e)

if missing or errors:
    print('\n分片不完整或有错，未写入。修好后重跑。')
    sys.exit(1)

# ---------- 3. 合并、排序、重编号 ----------
merged = quests + new
order = {m: i for i, m in enumerate(MODULE_ORDER)}
unknown = sorted({q['module'] for q in merged} - set(MODULE_ORDER))
if unknown:
    print('!! 未知模块名: %s' % unknown); sys.exit(1)
merged.sort(key=lambda q: (order[q['module']], q['id']))
for i, q in enumerate(merged, 1):
    q['n'] = i

bank['questions'] = merged
bank['total'] = len(merged)
bank['version'] = '2026-09-12'
bank['_note'] = ('唐山工业职业技术大学 2026 选聘 · 教育类岗位 笔试题库。'
                 '全客观题（四选一单选），题目按考点编写，非历年真题。')
bank['_schema'] = 'id/n/module/stem/options[{key,text}]/answer/explanation'

# ---------- 4. 最终校验 ----------
ids = [q['id'] for q in merged]
assert len(set(ids)) == len(ids), '合并后仍有重复 id'
assert [q['n'] for q in merged] == list(range(1, len(merged) + 1)), 'n 不连续'
for q in merged:
    assert len(q['options']) == 4 and [o['key'] for o in q['options']] == list('ABCD'), q['id']
    assert q['answer'] in 'ABCD' and q['explanation'].strip(), q['id']

# ---------- 5. 写 题库.json ----------
payload = json.dumps(bank, ensure_ascii=False, indent=1)
with open(QB, 'w', encoding='utf-8') as f:
    f.write(payload)
print('\n题库.json 已写入: %d 题, %d 字节' % (len(merged), len(payload.encode('utf-8'))))

# ---------- 6. 内嵌回 HTML ----------
html = open(HTML, encoding='utf-8').read()
inline = json.dumps(bank, ensure_ascii=False, separators=(',', ':'))
new_html, n = re.subn(
    r'(<script type="application/json" id="qbank">).*?(</script>)',
    lambda m: m.group(1) + inline + m.group(2),
    html, count=1, flags=re.S)
if n != 1:
    print('!! 内嵌失败: 匹配到 %d 处 qbank 块' % n); sys.exit(1)

# 同步页面上的题量显示
new_html = re.sub(r'(共 <b id="qTotal">)\d+(</b> 道)', r'\g<1>%d\g<2>' % len(merged), new_html)
new_html = re.sub(r'(<em>)/\d+(</em>)', r'\g<1>/%d\g<2>' % len(merged), new_html)
open(HTML, 'w', encoding='utf-8').write(new_html)
print('考点体系.html 已更新: %d 字符' % len(new_html))

# ---------- 7. 分模块统计 ----------
from collections import Counter
c = Counter(q['module'] for q in merged)
print('\n--- 分模块题量 ---')
for m in MODULE_ORDER:
    print('  %-26s %4d' % (m, c[m]))
print('  %-26s %4d' % ('合计', len(merged)))
