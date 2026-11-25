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

// 极简记录器：不读 getComputedStyle，不碰 DOMMatrix，只有 rAF + longtask
await ev(`(() => {
  window.__J = { raf: [], long: [], last: 0, dead: false };
  if (window.__JOLD) window.__JOLD.dead = true;
  window.__JOLD = window.__J;
  const tick = (ts) => { if (window.__J.dead) return; if (window.__J.last) window.__J.raf.push(ts - window.__J.last); window.__J.last = ts; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__J.long.push({t:e.startTime,d:e.duration}); }); o.observe({entryTypes:["longtask"]}); } catch(e){}
  return 1;
})()`);

// 复位
await ev(`(()=>{const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen!=='sessions'){const b=document.getElementById('btnBack'); if(b)b.click();} return 1})()`);
await sleep(900);

const stat = (a) => { if(!a.length) return {n:0}; const s=[...a].sort((x,y)=>x-y); const sum=a.reduce((x,y)=>x+y,0);
  return {n:a.length, fps:+(1000/(sum/a.length)).toFixed(1), p50:+s[Math.floor(s.length*0.5)].toFixed(1), p95:+s[Math.floor(s.length*0.95)].toFixed(1), worst:+Math.max(...a).toFixed(1), long25:a.filter(d=>d>25).length}; };

// 1) 空闲对照
let m0 = await ev(`__J.raf.length`);
await sleep(1500);
let m1 = await ev(`__J.raf.length`);
const rafA = await ev(`__J.raf.slice(${m0},${m1})`);
console.log("IDLE          :", JSON.stringify(stat(rafA)));

// 2) 切 tab（4 次），完全不采样几何
for (const tab of ["jobs","files","settings","sessions"]) {
  const r = await ev(`(()=>{const e=document.querySelector('.tab[data-tab="${tab}"]'); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  const a = await ev(`__J.raf.length`);
  await tap(r.x, r.y);
  await sleep(1300);
  const b = await ev(`__J.raf.length`);
  const raf = await ev(`__J.raf.slice(${a},${b})`);
  console.log(("TAB →"+tab).padEnd(14)+":", JSON.stringify(stat(raf)));
}

// 3) 开面板（不采样）
await ev(`document.querySelector('.tab[data-tab="settings"]').click()`);
await sleep(900);
{ const r = await ev(`(()=>{const e=document.getElementById('rowContext'); e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  await sleep(400);
  const a = await ev(`__J.raf.length`);
  await tap(r.x, r.y);
  await sleep(1500);
  const b = await ev(`__J.raf.length`);
  const raf = await ev(`__J.raf.slice(${a},${b})`);
  console.log("SHEET open    :", JSON.stringify(stat(raf)));
  await ev(`(()=>{document.getElementById('sheet').classList.remove('is-on');document.getElementById('sheetBackdrop').classList.remove('is-on');return 1})()`);
}
const longAll = await ev(`__J.long`);
console.log("longtasks     :", JSON.stringify(longAll.map(x=>({t:Math.round(x.t),d:Math.round(x.d)}))));
ws.close();
