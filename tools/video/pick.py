#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""人工从候选里挑出的视频，逐条打 B 站 view API 验真，输出 verified.json。"""
import json, subprocess, time, os, sys

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120 Safari/537.36')
JAR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bili.jar')

PICKS = {
 '教育学': [
   ('BV1yA411376X', '教师招聘教育综合知识·教育学心理学【思维导图梳理】'),
   ('BV1WyStYnEnp', 'B站最全教综精讲课（2026教师招聘·教育学部分）'),
   ('BV1yK4y127ip', '教育学基础（国家精品课程·已完结）'),
   ('BV1WXCPYKEAd', '粉笔教资系统班·教育知识与能力考点精讲'),
 ],
 '教育心理学': [
   ('BV1vc411G7C4', '北京师范大学《教育心理学》全81讲·刘儒德'),
   ('BV1Fy4y1i79C', '北京师范大学《普通心理学》全123讲·陈宝国'),
   ('BV1Lm4y1w7sf', '超格·教育心理学带背'),
   ('BV1t3411j7F7', '教师考编《教育心理学》考点大全'),
 ],
 '教育法律法规': [
   ('BV1bD4y1C7Y9', '教资笔试·综合素质法律法规系统梳理'),
   ('BV1Su411X7Y1', '教师考编《小三门》考点大全（法规+课改+师德）'),
   ('BV11g41117d3', '教师招聘小三门·01 教育法律法规'),
 ],
 '教师职业理念与职业道德': [
   ('BV1b4421A7ry', '刘大悟·科目一职业理念'),
   ('BV1TA4m1L7tP', '刘大悟·科目一职业道德'),
   ('BV1hc411v7Md', '教师职业道德规范·无痛带背'),
 ],
 '公共基础 · 政治与时政': [
   ('BV1hM4m1U7rA', '马克Mark《公基》&《常识》系统理论课（带字幕·最新版）'),
   ('BV17K411N7hU', '马克《公基》&《常识》系统课（经典版）'),
   ('BV1S54y1e77E', '李铁《公基》系统课·重点梳理版'),
   ('BV1CE411o7x3', '徐涛·马克思主义基本原理串讲'),
   ('BV1Lf4y177iY', '马克思主义基本原理概论（北京大学）'),
 ],
 '公共基础 · 法律': [
   ('BV1ugrTYyE2U', '马克Mark·法律刷题课'),
   ('BV1Xg41177Sq', '公基法律·民法考点（白鲸学长）'),
   ('BV1oL411E7tu', '公基法律·宪法考点（白鲸学长）'),
   ('BV1qb4y1S7Q7', '公基法律·行政法考点（白鲸学长）'),
   ('BV1TASnYKEvM', '法律基础知识精讲（民法·诉讼法·刑法·宪法）'),
 ],
 '公共基础 · 公文写作': [
   ('BV1pB4y1Y7ou', '公共基础知识·公文篇'),
   ('BV1yB4y1n7Yg', '一节课搞定公文格式'),
   ('BV163wxzZEBu', '马克Mark·公文刷题726道'),
 ],
 '公共基础 · 经济、管理与常识': [
   ('BV1d142117S5', '马克Mark·经济刷题1260道'),
   ('BV1RU4y1q7Bh', '公共基础知识·管理基础知识'),
   ('BV1Bz4y157ux', '经济学原理·从经济学角度读懂钱和生活'),
 ],
 '高校辅导员': [
   ('BV12h411J7at', '辅导员笔试全题型讲解 + 高频考点'),
   ('BV1Ea4y1k7GN', '高校辅导员招聘考试·模拟题解析'),
   ('BV1yV411J7vn', '辅导员笔试高分技巧·案例分析'),
   ('BV1kG4y1X7eG', '辅导员案例分析答题模板'),
   ('BV1D14y1Q7fh', '辅导员案例分析·校园危机事件处理'),
   ('BV13D4y1m7fo', '全国高校辅导员职业能力大赛决赛·主题班会第一名'),
 ],
 '职业教育与高等教育': [
   ('BV1oL411L7FG', '高校教师招聘·高等教育学 第一章 导论'),
   ('BV1si4y1d72T', '高校教师招聘·高等教育学 第二章 高等教育发展'),
   ('BV1Nu411q7yX', '高等教育心理学 第一章 绪论'),
   ('BV1BiCYYzERN', '高职类院校招聘考试·职业教育知识笔试网课'),
 ],
 '人文历史与科技常识': [
   ('BV1Q58BzHE5y', '李梦娇·常识速记口诀88条'),
   ('BV13b41157rn', '行测常识判断·蒙题套路'),
   ('BV1RM4y1H7hM', '必背常识300条·睡前磨耳朵'),
   ('BV18P4y1B7DM', '秒懂历史概念（全套）'),
 ],
 '唐山本地': [
   ('BV1xRA8ebExT', '国家批复河北国土规划·唐山定为5座中心城市之一'),
   ('BV1KL4y1E7jX', '京津冀的协同发展'),
   ('BV1XH4y1c7qT', '《City唐山》·唐山GDP破万亿'),
   ('BV1Ep4y1H7ky', '【印象·唐山】后工业化时代的唐山协奏'),
 ],
}

def view(bv):
    u = 'https://api.bilibili.com/x/web-interface/view?bvid=' + bv
    r = subprocess.run(['curl', '-s', '-m', '20', '--compressed', '-A', UA,
                        '-b', JAR, '-c', JAR,
                        '-e', 'https://www.bilibili.com/', u],
                       capture_output=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {'code': -999, 'message': 'parse fail'}

if __name__ == '__main__':
    out, bad = {}, []
    for mod, items in PICKS.items():
        out[mod] = []
        for bv, label in items:
            d = view(bv)
            if d.get('code') == 0:
                v = d['data']
                out[mod].append({
                    'bv': bv, 'label': label,
                    'real_title': v.get('title'),
                    'author': v.get('owner', {}).get('name'),
                    'play': v.get('stat', {}).get('view'),
                    'duration': v.get('duration'),
                    'pubdate': v.get('pubdate'),
                })
                print('  ✅ %-13s %s' % (bv, v.get('title', '')[:50]))
            else:
                bad.append((bv, d.get('code'), d.get('message')))
                print('  ❌ %-13s code=%s %s' % (bv, d.get('code'), d.get('message')))
            time.sleep(0.7)
    json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'verified.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('\n通过 %d 条，失效 %d 条' % (sum(len(v) for v in out.values()), len(bad)))
    if bad:
        print('失效清单:', bad)
