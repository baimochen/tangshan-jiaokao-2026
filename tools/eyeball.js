const fs=require('fs');
const path=require('path');
const HTML=fs.readFileSync(path.join(__dirname,'..','考点体系.html'),'utf8');
const BANK=JSON.parse(HTML.match(/<script type="application\/json" id="qbank">([\s\S]*?)<\/script>/)[1]);
// 用真实页面里的函数（截取出来跑）
const js=HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const mod=js.match(/var SHUF=\{\};[\s\S]*?\n  function remapExplain\(q,s\)\{[\s\S]*?\n  \}/)[0];
let seed=7; const rnd=()=>((seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff);
eval(mod.replace('Math.random()','rnd()'));
const strip=s=>s.replace(/<[^>]+>/g,'');
for(const id of ['e101','p16','p228','s123']){
  const q=BANK.questions.find(x=>x.id===id); if(!q) continue;
  const a=shuffledOpts(q);
  console.log('【'+id+'】'+strip(q.stem).slice(0,44));
  console.log('  原始选项: '+q.options.map(o=>o.key+'.'+o.text).join('  '));
  console.log('  显示选项: '+a.map((o,i)=>letterAt(i)+'.'+o.text).join('  '));
  console.log('  原始 key 答案 '+q.answer+' → 显示为 '+shownKey(q,q.answer));
  console.log('  解析(原): '+strip(q.explanation).slice(0,100));
  console.log('  解析(显): '+strip(remapExplain(q,q.explanation)).slice(0,100));
  console.log();
}
