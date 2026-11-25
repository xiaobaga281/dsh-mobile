// 压力夹具 + 交互测量：node .motion/verify/perf-stress.mjs seed|open|scroll [label]
const PORT = process.env.CDP_PORT || 9227;
const ADB = "D:/1/tools/android-sdk/platform-tools/adb.exe";
const N_MSGS = Number(process.env.N_MSGS || 120);
const N_SESS = Number(process.env.N_SESS || 24);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 30000);
  pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
await send("Runtime.enable");
await send("Profiler.enable");

const mode = process.argv[2] || "open";
const label = process.argv[3] || "";

const BODY = `## 小节标题

这是一段用于压力测试的正文，包含中文与 English mixed text，用来让排版真的工作。

- 列表项 A：\`inline code\` 与普通文字混排
- 列表项 B：**加粗** 与 *斜体*
- 列表项 C：很长的句子，重复若干次以撑开行数。重复若干次以撑开行数。重复若干次以撑开行数。

\`\`\`kotlin
fun render(list: List<Msg>): Int {
    var n = 0
    for (m in list) { n += m.len }
    return n
}
\`\`\`

> 引用块一行，用来验证块级元素的间距处理。

结尾再补一句普通文本，保证段落收尾。`;

if (mode === "seed") {
  const r = await ev(`(() => {
    const KEY = "dsh.local.sessions";
    const N_MSGS = ${N_MSGS}, N_SESS = ${N_SESS};
    const BODY = ${JSON.stringify(BODY)};
    const now = Date.now();
    const mkMsgs = (n) => Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? ("第 " + (i + 1) + " 条提问：请解释一下这个问题。") : (BODY + "\\n\\n（第 " + (i + 1) + " 段）"),
      at: now - (n - i) * 20000,
      ...(i % 2 ? { tokens: 200 + i } : {}),
    }));
    const list = JSON.parse(localStorage.getItem(KEY) || "[]").filter(s => !String(s.title||"").startsWith("stress-"));
    for (let k = 0; k < N_SESS; k++) {
      list.push({
        id: "stress" + k + now.toString(36),
        title: "stress-会话 " + k + " 标题稍长一些用于换行",
        createdAt: now - k * 60000, updatedAt: now - k * 60000,
        ws: k % 3 === 0 ? "" : "harness",
        messages: k === 0 ? mkMsgs(N_MSGS) : mkMsgs(4),
        tokens: 1000 + k * 137,
      });
    }
    localStorage.setItem(KEY, JSON.stringify(list));
    return { sessions: list.length, msgsInStress: (list.find(s=>s.title.startsWith("stress-会话 0"))||{}).messages?.length || 0, bytes: localStorage.getItem(KEY).length };
  })()`);
  console.log("seeded:", JSON.stringify(r));
  await ev(`location.reload()`).catch(() => {});
  console.log("reloaded");
  ws.close();
  process.exit(0);
}

/** 采样 rAF 帧间隔，返回统计 */
async function frames(ms) {
  return ev(`(async ()=>{
    const f = []; let last = 0, stop = false;
    const tick = (ts) => { if (stop) return; if (last) f.push(ts - last); last = ts; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    await new Promise(r => setTimeout(r, ${ms}));
    stop = true; await new Promise(r=>setTimeout(r,50));
    const s = f.sort((a,b)=>a-b); const p = (q)=> s.length ? +s[Math.floor(s.length*q)].toFixed(1) : 0;
    return { n: s.length, p50: p(.5), p90: p(.9), p95: p(.95), worst: s.length ? +s[s.length-1].toFixed(1) : 0, over25: s.filter(d=>d>25).length, over50: s.filter(d=>d>50).length };
  })()`);
}

async function profile(label, ms, action) {
  const started = await send("Profiler.start");
  await action();
  await sleep(ms);
  const { profile: prof } = await send("Profiler.stop");
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < prof.samples.length; i++) {
    const dt = (prof.timeDeltas[i] || 0) / 1000;
    if (dt < 0) continue;
    self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + dt);
  }
  const rows = [...self.entries()].map(([nid, ms]) => {
    const cf = nodes.get(nid).callFrame || {};
    return { fn: cf.functionName || "(anon)", line: cf.lineNumber, ms: +ms.toFixed(1) };
  }).sort((a, b) => b.ms - a.ms).slice(0, 14);
  const total = rows.reduce((n, r) => n + r.ms, 0);
  return { label, totalMs: +total.toFixed(0), top: rows };
}

if (mode === "open") {
  // 回会话页 → 点第一条 stress 会话
  await ev(`(()=>{const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen!=='sessions'){const b=document.getElementById('btnBack'); if(b) b.click();} return 1})()`);
  await sleep(700);
  const hit = await ev(`(()=>{
    const rows = [...document.querySelectorAll('#screen-sessions .sess-row, #screen-sessions .session-item')];
    const r = rows.find(x => (x.textContent||"").includes("stress-会话 0"));
    if (!r) return null;
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width/2, y: b.y + b.height/2, text: (r.textContent||"").slice(0,24) };
  })()`);
  if (!hit) { console.log("找不到 stress 会话，先跑 seed"); process.exit(1); }
  const p = await profile("open", 1200, async () => {
    await ev(`(()=>{ window.__O={f:[],l:[],last:0,stop:false};
      const tick=(ts)=>{ if(window.__O.stop) return; if(window.__O.last) window.__O.f.push(ts-window.__O.last); window.__O.last=ts; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      try{ new PerformanceObserver((l)=>{for(const e of l.getEntries()) window.__O.l.push(Math.round(e.duration));}).observe({entryTypes:["longtask"]}); }catch(_){}
      return 1 })()`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: hit.x, y: hit.y, id: 1 }] });
    await sleep(40);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  });
  const frames = await ev(`(()=>{ window.__O.stop=true;
    const f=[...window.__O.f].sort((a,b)=>a-b); const q=(x)=> f.length? +f[Math.floor(f.length*x)].toFixed(1):0;
    return { n:f.length, p50:q(.5), p95:q(.95), worst: f.length?+f[f.length-1].toFixed(1):0, over33: f.filter(d=>d>33).length, long: window.__O.l }; })()`);
  const msgCount = await ev(`document.querySelectorAll('#messages .msg').length`);
  const domCount = await ev(`document.getElementsByTagName('*').length`);
  const scrollInfo = await ev(`(()=>{const s=document.getElementById('chatScroll'); return s?{h:s.scrollHeight,c:s.clientHeight,top:s.scrollTop}:null})()`);
  console.log(JSON.stringify({ label: label || "open", msgs: msgCount, nodes: domCount, frames, scroll: scrollInfo, profile: p }, null, 1));
}

if (mode === "scroll") {
  const f = await frames(300);
  const scroll = await ev(`(async ()=>{
    const s = document.getElementById('chatScroll'); if (!s) return null;
    const frames = []; let last = 0, stop = false;
    const tick = (ts) => { if (stop) return; if (last) frames.push(ts-last); last = ts; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const max = s.scrollHeight - s.clientHeight;
    const t0 = performance.now();
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i <= 30; i++) { s.scrollTop = max - (max*i)/30; await new Promise(x=>requestAnimationFrame(x)); }
      for (let i = 30; i >= 0; i--) { s.scrollTop = max - (max*i)/30; await new Promise(x=>requestAnimationFrame(x)); }
    }
    stop = true; await new Promise(x=>setTimeout(x,50));
    const q = [...frames].sort((a,b)=>a-b); const p=(x)=> q.length?+q[Math.floor(q.length*x)].toFixed(1):0;
    return { n:q.length, p50:p(.5), p90:p(.9), p95:p(.95), worst:q.length?+q[q.length-1].toFixed(1):0, over25:q.filter(d=>d>25).length, ms: Math.round(performance.now()-t0), max };
  })()`);
  console.log(JSON.stringify({ label: label || "scroll-idle", idle: f, scroll }, null, 1));
}

if (mode === "interact") {
  // 回到会话页
  await ev(`(()=>{const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen!=='sessions'){const b=document.getElementById('btnBack'); if(b) b.click();} return 1})()`);
  await sleep(700);
  const busy = async (fn, ms) => {
    await send("Profiler.start");
    await fn();
    await sleep(ms);
    const { profile: prof } = await send("Profiler.stop");
    const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
    const self = new Map();
    for (let i = 0; i < prof.samples.length; i++) {
      const dt = (prof.timeDeltas[i] || 0) / 1000; if (dt < 0) continue;
      self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + dt);
    }
    let total = 0, idle = 0; const rows = [];
    for (const [nid, ms] of self) {
      const cf = nodes.get(nid).callFrame || {};
      const fnm = cf.functionName || "(anon)";
      if (fnm === "(idle)") { idle += ms; continue; }
      total += ms;
      rows.push({ fn: fnm, line: cf.lineNumber, ms: +ms.toFixed(1) });
    }
    rows.sort((a, b) => b.ms - a.ms);
    return { busyMs: +total.toFixed(0), idleMs: +idle.toFixed(0), top: rows.slice(0, 8) };
  };

  const searchAt = await ev(`(()=>{const i=document.getElementById('searchSessions'); if(!i) return null; const b=i.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  const typing = await busy(async () => {
    if (searchAt) {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: searchAt.x, y: searchAt.y, id: 1 }] });
      await sleep(40);
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(400);
      for (const t of ["会", "话", "0", "x"]) { await send("Input.insertText", { text: t }); await sleep(160); }
      await ev(`(()=>{const i=document.getElementById('searchSessions'); if(i){i.value=""; i.blur(); i.dispatchEvent(new Event('input',{bubbles:true}));} return 1})()`);
      await sleep(200);
    }
  }, 200);

  const tabSwitch = await busy(async () => {
    for (const t of ["settings", "jobs", "files", "sessions"]) {
      const p = await ev(`(()=>{const e=document.querySelector('.tab[data-tab="${t}"]'); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
      if (!p) continue;
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
      await sleep(40);
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(520);
    }
  }, 300);

  console.log(JSON.stringify({ label: label || "interact", typing, tabSwitch }, null, 1));
}

if (mode === "trace") {
  await ev(`(()=>{const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen!=='sessions'){const b=document.getElementById('btnBack'); if(b) b.click();} return 1})()`);
  await sleep(700);
  await send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
  const done = new Promise((res) => { const h = (m) => { const e = JSON.parse(m.data); if (e.method === "Tracing.tracingComplete") { ws.removeEventListener("message", h); res(); } }; ws.addEventListener("message", h); });
  const buf = []; const keep = (m) => { const e = JSON.parse(m.data); if (e.method === "Tracing.dataCollected") buf.push(...e.params.value); };
  ws.addEventListener("message", keep);

  const searchAt = await ev(`(()=>{const i=document.getElementById('searchSessions'); if(!i) return null; const b=i.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  if (searchAt) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: searchAt.x, y: searchAt.y, id: 1 }] });
    await sleep(40);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(400);
    for (const t of ["会", "话", "0", "x"]) { await send("Input.insertText", { text: t }); await sleep(160); }
    await ev(`(()=>{const i=document.getElementById('searchSessions'); if(i){i.value=""; i.blur(); i.dispatchEvent(new Event('input',{bubbles:true}));} return 1})()`);
    await sleep(300);
  }
  for (const t of ["settings", "jobs", "sessions"]) {
    const p = await ev(`(()=>{const e=document.querySelector('.tab[data-tab="${t}"]'); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    if (!p) continue;
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
    await sleep(40);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(520);
  }
  await send("Tracing.end");
  await done;
  ws.removeEventListener("message", keep);
  const agg = new Map();
  const count = new Map();
  for (const e of buf) {
    if (e.ph !== "X" || !e.dur) continue;
    const k = e.name;
    agg.set(k, (agg.get(k) || 0) + e.dur / 1000);
    count.set(k, (count.get(k) || 0) + 1);
  }
  const rows = [...agg.entries()].map(([k, ms]) => ({ name: k, ms: +ms.toFixed(0), n: count.get(k) }))
    .filter((r) => r.ms >= 3).sort((a, b) => b.ms - a.ms).slice(0, 18);
  console.log(JSON.stringify({ label: label || "trace", rows }, null, 1));
  ws.close();
  process.exit(0);
}

if (mode === "boot") {  console.log(JSON.stringify(await ev(`(()=>{
    const n = performance.getEntriesByType('navigation')[0]||{};
    const paints={}; for(const p of performance.getEntriesByType('paint')) paints[p.name]=Math.round(p.startTime);
    return { domInteractive: Math.round(n.domInteractive||0), dcl: Math.round(n.domContentLoadedEventEnd||0), load: Math.round(n.loadEventEnd||0), paints, nodes: document.getElementsByTagName('*').length, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize/1048576).toFixed(1) : null };
  })()`), null, 1));
}

ws.close();
