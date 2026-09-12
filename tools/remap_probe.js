/* 在真实题库上试跑「解析字母重映射」。用固定种子乱序，结果可复现。
   关键：不能靠比对输出文本判断「换没换」——原始 A 恰好还排在 A 位时，
   换了跟没换长得一样。所以直接记录每个字母串的判定结果。

   **被测逻辑不是抄来的，是从 web/assets/quiz.js 里抠出来的真源码**（任务 14 改的）。
   以前这里手抄了一份 isOptRef / remapExplain，改线上那份、不改这份，
   探针照样一片绿——那正是这个任务要防的错。现在：
     · 两个函数按大括号配对从 quiz.js 里抠出来 eval，抠不到就报错退出；
     · **追踪版连常量都不自己存**：连续串的正则、往回看/往前看的窗口宽度，
       全从抠出来的 remapExplain 源码里读（读不到就抛）。漏一个常量就等于手抄没除净——
       评审量过：源码的窗口 6 改成 20，探针曾一片绿。
     · 追踪版的循环 vs 源码版的循环，1000 题**外加每条合成串**逐题比对输出，
       不一致就报错退出（合成串里有专门造出来区分窗口宽度的输入）。
     · 合成用例的期望值是写死的字符串，规则一拆/窗口一改就红。
   四条合起来：探针测的就是线上那份逻辑，测不到就红。
   usage: node tools/remap_probe.js */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUIZ = path.join(__dirname, '..', 'web', 'assets', 'quiz.js');
const QUIZ_SRC = fs.readFileSync(QUIZ, 'utf8');

/* —— 从真源码里抠函数（大括号配对；抠不到 / 不配对 = 大声失败）—— */
function extractFn(name) {
  const start = QUIZ_SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(`${QUIZ} 里找不到 function ${name}——探针没东西可测`);
  let i = QUIZ_SRC.indexOf('{', start), depth = 0;
  for (; i < QUIZ_SRC.length; i++) {
    if (QUIZ_SRC[i] === '{') depth++;
    else if (QUIZ_SRC[i] === '}') { depth--; if (depth === 0) return QUIZ_SRC.slice(start, i + 1); }
  }
  throw new Error(`${name} 的大括号不配对——抠源码失败`);
}
const isOptRefSrc = extractFn('isOptRef');
const remapExplainSrc = extractFn('remapExplain');

const BANK = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '题库.json'), 'utf8'));
const qs = BANK.questions;

/* —— 固定种子乱序（改前改后同一套，数字才可比）—— */
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
/* 合成用例走一个写死的置换：换完一定不等于原字母，用例不可能是「碰巧对」 */
const SYN_ID = 'SYN-多字母';
const PERM = { A: 'C', B: 'A', C: 'D', D: 'B' };   /* A→C→D→B→A，四个字母都换到别处 */
function shownKey(q, key) {
  if (q.id === SYN_ID) return PERM[key] || key;
  const a = shuffledOpts(q);
  for (let i = 0; i < a.length; i++) if (a[i].key === key) return letterAt(i);
  return key;
}

const SYN = { id: SYN_ID, type: 'multi', answer: 'ABD',
              options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' },
                        { key: 'C', text: '丙' }, { key: 'D', text: '丁' }] };
/* 合成用例。期望值是写死的字符串（置换 A→C B→A C→D D→B 也是写死的），
   每条都得能被突变打红——见 task-14-report.md 的突变表。
   前后两组「窗口」用例是修复轮 1 加的：真库上区分不出窗口 6 和更宽的窗口，
   所以单造两条只有「字母前面/后面隔了 ≥6 个空白」才分岔的输入。
   隔 8 个空格时 `故选` / 「两项」落在 6 字符窗口之外——按现状不换；
   谁把窗口放宽，这两条立刻红（改窗口是个要拿出来讨论的决定，不是顺手调）。 */
const CASES = [
  { name: '故选 ABD（串首一个字母指代 → 整串都要换）', s: '故选 ABD。', want: '故选 CAB。' },
  { name: '答案为 AC', s: '答案为 AC。', want: '答案为 CD。' },
  { name: '故 AB。（「故」后面是串）', s: '故 AB。', want: '故 CA。' },
  { name: 'AB 两项（串后面跟「两项」）', s: 'AB 两项正确', want: 'CA 两项正确' },
  { name: 'ACD 三项', s: 'ACD 三项都选', want: 'CDB 三项都选' },
  { name: 'A、C 两项（顿号分开，改前就对）', s: 'A、C 两项', want: 'C、D 两项' },
  { name: '故选 A。（单字母，改前就对）', s: '故选 A。', want: '故选 C。' },
  { name: 'SARS 与 AB 两项（英文词里的字母不碰，串照换）', s: 'SARS 与 AB 两项', want: 'SARS 与 CA 两项' },
  { name: 'DTT 中的 A 项（同上，单字母）', s: 'DTT 中的 A 项', want: 'DTT 中的 C 项' },
  { name: 'ABC 理论（后接术语词，整串不碰）', s: '核心是 ABC 理论——A 是诱发事件，B 是信念，C 是情绪与行为结果',
    want: '核心是 ABC 理论——A 是诱发事件，B 是信念，C 是情绪与行为结果' },
  { name: '故选 AB 理论（术语词排除优先于「故选」）', s: '故选 AB 理论', want: '故选 AB 理论' },
  { name: 'ABC 理论中A是诱发事件（p228 那个形状）', s: 'ABC理论中A是诱发事件、B是个体对事件的信念',
    want: 'ABC理论中A是诱发事件、B是个体对事件的信念' },
  /* --- 窗口宽度（修复轮 1）：只有窗口宽度不同才分岔的两条 --- */
  { name: '窗口·往回看：故选＋8 个空格＋A。（6 字符窗口外 → 按现状不换）',
    s: '故选        A。', want: '故选        A。' },
  { name: '窗口·往前看：A＋8 个空格＋两项都对（6 字符窗口外 → 按现状不换）',
    s: 'A        两项都对', want: 'A        两项都对' },
];

/* —— eval 真源码 ——
   quiz.js 顶层一律 var / function（文件头写死了这条），非严格模式下函数声明会落到
   本作用域，所以 remapExplain 里那句 shownKey(q, ch) 用的就是上面这个 shownKey。*/
eval(isOptRefSrc + '\n' + remapExplainSrc);
if (typeof remapExplain !== 'function' || typeof isOptRef !== 'function') {
  throw new Error('eval 之后没拿到两个函数——抠出来的源码不对');
}

/* —— 追踪版要用的常量也从真源码里取，探针不许自己另存一份 ——
   连续串的正则、往回看/往前看的窗口宽度都写在 remapExplain 里；
   抠不到就抛（不是悄悄退回一个默认值）。 */
function pick(re, what) {
  const m = remapExplainSrc.match(re);
  if (!m) throw new Error(`从 remapExplain 源码里读不到${what}——探针不该另存一份`);
  return m[1];
}
const RUN_RE_SRC = pick(/\bre\s*=\s*(\/.*\/[a-z]*)\s*;/, '连续串的正则');
const RUN_RE_BODY = RUN_RE_SRC.slice(1, RUN_RE_SRC.lastIndexOf('/'));
const RUN_RE_FLAGS = RUN_RE_SRC.slice(RUN_RE_SRC.lastIndexOf('/') + 1);
const BACK_CTX = Number(pick(/Math\.max\(0,\s*i\s*-\s*(\d+)\)/, '往回看的窗口'));
const FWD_CTX = Number(pick(/i\s*\+\s*n\s*\+\s*(\d+)/, '往前看的窗口'));
if (!(BACK_CTX > 0) || !(FWD_CTX > 0)) throw new Error('窗口宽度解析成了非正数——抠源码那步不对');

/* —— 追踪版：扫描/判定与 remapExplain 同一套，只多记每个字母串的判定 ——
   规则用真的 isOptRef，窗口用上面从源码读出来的数字，正则用源码里那个；
   循环本身靠下面的逐题比对盯着。marks 按「字母串」记，不按字母：
   串长 1 时与老探针逐字段一致。*/
function remapExplainTrace(q, s) {
  const marks = [];
  if (!s) return { out: s, marks };
  let out = '', last = 0, m;
  const re = new RegExp(RUN_RE_BODY, RUN_RE_FLAGS);
  while ((m = re.exec(s))) {
    const i = m.index, run = m[0], n = run.length;
    const pre = s.slice(Math.max(0, i - BACK_CTX), i), post = s.slice(i + n, i + n + FWD_CTX);
    const skip = /[A-Za-z]/.test(s.charAt(i - 1)) || /[A-Za-z]/.test(s.charAt(i + n));
    const isRef = !skip && isOptRef(pre, post, n);
    let newRun = run;
    if (isRef) {
      newRun = '';
      for (let j = 0; j < n; j++) newRun += shownKey(q, run.charAt(j));
      out += s.slice(last, i) + newRun; last = i + n;
    }
    marks.push({ i, run, n, isRef, skip, newRun, pre, post });
  }
  return { out: out + s.slice(last), marks };
}

/* —— 0. 追踪版与源码版必须逐题一致 ——
   语料 = 1000 题 + 每条合成串。合成串必须一起过：真库上区分不出窗口宽度，
   只比真库的话「追踪版自己另存一个窗口常量」这条缝永远不会响。 */
{
  let bad = 0;
  const corpus = qs.map(q => [q, q.explanation]).concat(CASES.map(c => [SYN, c.s]));
  for (const [q, s] of corpus) {
    const a = remapExplain(q, s);
    const b = remapExplainTrace(q, s).out;
    if (a !== b) { bad++; if (bad <= 3) console.log('   ✗', q.id, JSON.stringify(s.slice(0, 40)), '→', JSON.stringify(a.slice(0, 40)), '≠', JSON.stringify(b.slice(0, 40))); }
  }
  const qb = Buffer.byteLength(QUIZ_SRC, 'utf8');
  console.log('被测逻辑来自 %s（抠出 isOptRef %d 字符 / %d 字节、remapExplain %d 字符 / %d 字节；源文件 %d 字节，sha256 %s）',
    path.relative(path.join(__dirname, '..'), QUIZ),
    isOptRefSrc.length, Buffer.byteLength(isOptRefSrc, 'utf8'),
    remapExplainSrc.length, Buffer.byteLength(remapExplainSrc, 'utf8'),
    qb, crypto.createHash('sha256').update(QUIZ_SRC, 'utf8').digest('hex').slice(0, 12));
  console.log('追踪版跟着源码走：连续串 %s、往回看 %d、往前看 %d（都从源码里读的）',
    RUN_RE_SRC, BACK_CTX, FWD_CTX);
  console.log('追踪版 vs 源码版：%d 题 + %d 条合成串输出%s（%d 处不符）\n',
    qs.length, CASES.length, bad ? '❌ 不一致' : '逐题一致 ✅', bad);
  if (bad) process.exitCode = 1;
}

/* —— 跑 —— */
let changed = 0, checked = 0, changedLetters = 0, multiRef = 0;
const invariantBad = [], missed = [], notRef = new Map(), moved = new Map(), runNotRef = new Map();
for (const q of qs) {
  /* 被判定的对象是**源码版输出**：追踪版只提供每个字母串的判定，产物一律用
     remapExplain 的返回值算。老探针那条「判定为指代却没换」拿 newCh 跟 shownKey
     比，两边是同一个调用，恒等，永远报 0——其实证明不了任何事。 */
  const out = remapExplain(q, q.explanation);
  const { marks } = remapExplainTrace(q, q.explanation);
  if (out !== q.explanation) changed++;
  for (const mk of marks) {
    if (mk.skip) continue;
    /* 换了没换，直接看源码版输出在该位置上的那一段，而不是看追踪版的内部量 */
    const want = mk.run.split('').map(c => shownKey(q, c)).join('');
    const got = out.slice(mk.i, mk.i + mk.n);
    if (mk.isRef) {
      changedLetters += mk.n;
      if (mk.n > 1) multiRef++;
      if (got !== want) missed.push(`${q.id}: [${mk.run}] 判定是指代却没换（该是 ${want}，实际 ${got}）`);
    }
    if (mk.isRef && mk.newRun !== mk.run) {
      const k = mk.pre.slice(-3) + '[' + mk.run + '→' + mk.newRun + ']' + mk.post.slice(0, 3);
      moved.set(k, (moved.get(k) || 0) + 1);
    }
    if (!mk.isRef) {
      const k = mk.pre.slice(-4) + '[' + mk.run + ']' + mk.post.slice(0, 4);
      const bucket = mk.n > 1 ? runNotRef : notRef;
      if (!bucket.has(k)) bucket.set(k, { n: 0, id: q.id });
      bucket.get(k).n++;
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
console.log('改了字的题: %d / %d      被换掉的字母: %d 处（其中多字母串 %d 处）', changed, qs.length, changedLetters, multiRef);
console.log('「故选/故X。」不变式: %d 处，不符 %d 处', checked, invariantBad.length);
invariantBad.slice(0, 6).forEach(x => console.log('   ', x));
console.log('判定为指代却没换: %d 处', missed.length);
missed.slice(0, 6).forEach(x => console.log('   ', x));
console.log('\n换字母的样子（抽样 12 种）:');
[...moved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log('  ' + pad(n, 5) + '  ' + k));
console.log('\n【故意不换】的单字母上下文，共 %d 种 —— 要逐条确认确实不是选项指代:', notRef.size);
[...notRef.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => console.log('  ' + pad(v.n, 5) + '  ' + k + '   (如 ' + v.id + ')'));
console.log('\n【故意不换】的多字母串，共 %d 种 —— 连着的串被判成不是选项指代的都在这里:', runNotRef.size);
[...runNotRef.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => console.log('  ' + pad(v.n, 5) + '  ' + k + '   (如 ' + v.id + ')'));

/* —— 合成用例：真库里一个多字母指代都没有（全库只有 2 处连着的串，都是 ABC 理论），
   所以「扩了规则有没有用」在真库上看不出来。这里逐条钉死每条新规则与窗口宽度。 —— */
console.log('\n【合成用例】多字母指代（置换 A→C B→A C→D D→B，写死，逐条比字符串）:');
const permBad = Object.keys(PERM).filter(k => PERM[k] === k);
if (permBad.length) {
  console.log('   ❌ 置换把 %s 映射到了自己——用例会变成「不换也对」，先修置换', permBad.join('/'));
  process.exitCode = 1;
}
let caseBad = 0;
for (const c of CASES) {
  const got = remapExplain(SYN, c.s);
  const good = got === c.want;
  if (!good) caseBad++;
  console.log('  %s %s', good ? '✅' : '❌', c.name);
  if (!good) console.log('       期望 %s\n       实际 %s', JSON.stringify(c.want), JSON.stringify(got));
}
if (caseBad) {
  console.log('\n❌ 合成用例 %d 条不符——多字母规则/窗口没接上或被误伤', caseBad);
  process.exitCode = 1;
} else {
  console.log('  （%d 条全过）', CASES.length);
}
