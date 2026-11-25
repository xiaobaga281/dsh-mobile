const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find(p=>p.type==="page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map();
ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(mm,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:mm,params:p}));});
await new Promise(r=>ws.addEventListener("open",r));
await send("Runtime.enable");
await send("Profiler.enable");
await send("Profiler.setSamplingInterval",{interval:200});
const ev=async(e)=>{const r=await send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true,userGesture:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.result?.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const tap=async(x,y)=>{await send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y,id:1}]}); await sleep(40); await send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});};

// 回到会话页
await ev(`(()=>{const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen!=='sessions'){const b=document.getElementById('btnBack'); if(b)b.click();} return 1})()`);
await sleep(1000);

const r = await ev(`(()=>{const e=document.querySelector('.tab[data-tab="settings"]'); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);

await send("Profiler.start");
await tap(r.x, r.y);
await sleep(1400);
const stopRes = await send("Profiler.stop");
console.log("stop result keys:", Object.keys(stopRes || {}));
const profile = stopRes && (stopRes.profile || stopRes.result && stopRes.result.profile);
if (!profile) { console.log("raw:", JSON.stringify(stopRes).slice(0,600)); ws.close(); process.exit(1); }

// 自耗时聚合
const nodes = new Map(profile.nodes.map(n => [n.id, n]));
const self = new Map();
for (let i=0;i<profile.samples.length;i++){
  const nid = profile.samples[i];
  const dt = (profile.timeDeltas[i] || 0) / 1000;  // us -> ms
  if (dt < 0) continue;
  self.set(nid, (self.get(nid)||0) + dt);
}
const rows = [...self.entries()].map(([nid, ms]) => {
  const n = nodes.get(nid); const cf = n.callFrame || {};
  return { fn: cf.functionName || "(anonymous)", url: (cf.url||"").split("/").pop().slice(0,42), line: cf.lineNumber, ms: +ms.toFixed(1) };
}).sort((a,b)=>b.ms-a.ms).slice(0, 22);

const total = [...self.values()].reduce((a,b)=>a+b,0);
console.log(`profile: samples=${profile.samples.length} totalSelf=${total.toFixed(0)}ms duration≈${(profile.endTime-profile.startTime)/1000|0}ms\n`);
console.log("self(ms) | function | file:line");
for (const r of rows) console.log(`${String(r.ms).padStart(8)} | ${r.fn.slice(0,44).padEnd(44)} | ${r.url}:${r.line}`);
ws.close();
