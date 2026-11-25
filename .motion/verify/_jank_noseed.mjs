const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find(p=>p.type==="page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map();
ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(mm,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:mm,params:p}));});
await new Promise(r=>ws.addEventListener("open",r));
await send("Runtime.enable");
const ev=async(e)=>{const r=await send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true,userGesture:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.result?.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const tap=async(x,y)=>{await send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y,id:1}]}); await sleep(40); await send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});};

// 清空会话夹具
console.log("clear:", JSON.stringify(await ev(`(()=>{localStorage.setItem("dsh.local.sessions","[]");localStorage.removeItem("dsh.wsOpen");return 1})()`)));
await ev(`location.reload()`).catch(()=>{});
await sleep(4000);
console.log("rows now:", await ev(`document.querySelectorAll('#sessionsScroll .sess-row').length`));

await ev(`(() => {
  window.__J = { raf: [], long: [], last: 0, dead: false };
  const tick = (ts) => { if (window.__J.dead) return; if (window.__J.last) window.__J.raf.push(ts - window.__J.last); window.__J.last = ts; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__J.long.push({t:e.startTime,d:e.duration}); }); o.observe({entryTypes:["longtask"]}); } catch(e){}
  return 1;
})()`);
await sleep(1200);
const stat = (a) => { if(!a.length) return {n:0}; const s=[...a].sort((x,y)=>x-y); const sum=a.reduce((x,y)=>x+y,0);
  return {n:a.length, fps:+(1000/(sum/a.length)).toFixed(1), p95:+s[Math.floor(s.length*0.95)].toFixed(1), worst:+Math.max(...a).toFixed(1), long25:a.filter(d=>d>25).length}; };

let m0=await ev(`__J.raf.length`); await sleep(1500); let m1=await ev(`__J.raf.length`);
console.log("IDLE (无会话)  :", JSON.stringify(stat(await ev(`__J.raf.slice(${m0},${m1})`))));

for (const tab of ["jobs","files","settings","sessions"]) {
  const r = await ev(`(()=>{const e=document.querySelector('.tab[data-tab="${tab}"]'); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  const a = await ev(`__J.raf.length`);
  await tap(r.x, r.y);
  await sleep(1300);
  const b = await ev(`__J.raf.length`);
  console.log(("TAB →"+tab+" (无会话)").padEnd(20)+":", JSON.stringify(stat(await ev(`__J.raf.slice(${a},${b})`))));
}
const L=await ev(`__J.long`);
console.log("longtasks 数量:", L.length, " 最坏:", Math.round(Math.max(...L.map(x=>x.d)))+"ms");
ws.close();
