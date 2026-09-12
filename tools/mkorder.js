const fs=require('fs');
const path=require('path');
const HTML=fs.readFileSync(path.join(__dirname,'..','考点体系.html'),'utf8');
const BANK=JSON.parse(HTML.match(/<script type="application\/json" id="qbank">([\s\S]*?)<\/script>/)[1]);
const qs=BANK.questions, byId={}; qs.forEach(q=>byId[q.id]=q);
const js=HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
// 原样截取真实页面里的 MK_PLAN / mkShuffle / mkPick
const plan=js.match(/var MK_PLAN=\[[\s\S]*?\];/)[0];
const shuf=js.match(/function mkShuffle\(a\)\{[\s\S]*?\n  \}/)[0];
const pick=js.match(/function mkPick\(\)\{[\s\S]*?\n  \}/)[0];
eval(plan+'\n'+shuf+'\n'+pick);
const ids=mkPick();
const mods=ids.map(id=>byId[id].module);
console.log('抽到', ids.length, '题');
console.log('\n前 30 题的模块:');
mods.slice(0,30).forEach((m,i)=>console.log('  '+String(i+1).padStart(3)+'  '+m));
