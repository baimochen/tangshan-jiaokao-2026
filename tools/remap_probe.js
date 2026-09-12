/* 在真实题库上试跑「解析字母重映射」。用固定种子乱序，结果可复现。
   关键：不能靠比对输出文本判断「换没换」——原始 A 恰好还排在 A 位时，
   换了跟没换长得一样。所以直接记录每个字母的判定结果。 */
const fs = require('fs');
const path = require('path');
const BANK = JSON.parse(fs.readFileSync(path.join(__dirname,'..','题库.json'), 'utf8'));
const qs = BANK.questions;

/* —— 被测函数（准备原样搬进 HTML）—— */
function isOptRef(pre, post) {
  if (/^\s*项/.test(post)) return true;
  if (/(故选|应选|答案为|答案是|答案|正确项是)\s*$/.test(pre)) return true;
  if (/故\s*$/.test(pre)) return true;
  if (/[ABCD]\s*[、与和及]\s*$/.test(pre)) return true;
  if (/^\s*[、与和及]\s*[ABCD]/.test(post)) return true;
  if (/^\s*(正确|错误|两项|三项|都|均|也|全对)/.test(post)) return true;
  return false;
}
/* 返回 {out, marks:[{i,ch,isRef,skipped,newCh}]} */
function remapExplain(q, s, shownKey) {
  const marks = [];
  if (!s) return { out: s, marks };
  let out = '', last = 0, m;
  const re = /[ABCD]/g;
  while ((m = re.exec(s))) {
    const i = m.index, ch = m[0];
    const b = s.charAt(i - 1), a = s.charAt(i + 1);
    const skip = /[A-Za-z]/.test(b) || /[A-Za-z]/.test(a);
    const pre = s.slice(Math.max(0, i - 6), i), post = s.slice(i + 1, i + 7);
    const isRef = isOptRef(pre, post);
    let newCh = ch;
    if (!skip && isRef) { newCh = shownKey(q, ch); out += s.slice(last, i) + newCh; last = i + 1; }
    marks.push({ i, ch, isRef, skip, newCh, pre, post });
  }
  return { out: out + s.slice(last), marks };
}

/* —— 固定种子乱序 —— */
let seed = 20260912;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const SHUF = {};
function shuffledOpts(q) {
  if (!SHUF[q.id]) {
    const idx = q.options.map((_, i) => i);
    for (let j = idx.length - 1; j > 0; j--) { const r = Math.floor(rnd() * (j + 1)); [idx[j], idx[r]] = [idx[r], idx[j]]; }
    SHUF[q.id] = idx;
  }
  return SHUF[q.id].map(i => q.options[i]);
}
const letterAt = i => 'ABCD'.charAt(i);
const shownKey = (q, key) => { const a = shuffledOpts(q); for (let i = 0; i < a.length; i++) if (a[i].key === key) return letterAt(i); return key; };

/* —— 跑 —— */
let changed = 0, checked = 0, changedLetters = 0;
const invariantBad = [], missed = [], notRef = new Map(), moved = new Map();
for (const q of qs) {
  const { out, marks } = remapExplain(q, q.explanation, shownKey);
  if (out !== q.explanation) changed++;
  for (const mk of marks) {
    if (mk.skip) continue;
    if (mk.isRef) {
      changedLetters++;
      if (mk.newCh !== shownKey(q, mk.ch)) missed.push(`${q.id}: [${mk.ch}] 判定是指代却没换`);
    } else {
      const k = mk.pre.slice(-4) + '[' + mk.ch + ']' + mk.post.slice(0, 4);
      if (!notRef.has(k)) notRef.set(k, { n: 0, id: q.id });
      notRef.get(k).n++;
    }
    if (mk.isRef && mk.newCh !== mk.ch) {
      const k = mk.pre.slice(-3) + '[' + mk.ch + '→' + mk.newCh + ']' + mk.post.slice(0, 3);
      moved.set(k, (moved.get(k) || 0) + 1);
    }
  }
  // 不变式：「故选 X」「故X。」里的 X 就是答案，换完必须指向答案显示的位置
  for (const re of [/故选\s*([ABCD])/g, /故\s*([ABCD])。/g]) {
    let m;
    while ((m = re.exec(q.explanation))) {
      checked++;
      const pos = m.index + m[0].lastIndexOf(m[1]);
      const want = shownKey(q, q.answer);
      if (out.slice(pos, pos + 1) !== want) invariantBad.push(`${q.id}: ${m[0].trim()} → 期望 ${want}，实际 ${out.slice(pos, pos + 1)}`);
    }
  }
}
const pad = (n, w) => String(n).padStart(w);
console.log('改了字的题: %d / %d      被换掉的字母: %d 处', changed, qs.length, changedLetters);
console.log('「故选/故X。」不变式: %d 处，不符 %d 处', checked, invariantBad.length);
invariantBad.slice(0, 6).forEach(x => console.log('   ', x));
console.log('判定为指代却没换: %d 处', missed.length);
missed.slice(0, 6).forEach(x => console.log('   ', x));
console.log('\n换字母的样子（抽样 12 种）:');
[...moved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log('  ' + pad(n, 5) + '  ' + k));
console.log('\n【故意不换】的字母上下文，共 %d 种 —— 要逐条确认确实不是选项指代:', notRef.size);
[...notRef.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => console.log('  ' + pad(v.n, 5) + '  ' + k + '   (如 ' + v.id + ')'));
