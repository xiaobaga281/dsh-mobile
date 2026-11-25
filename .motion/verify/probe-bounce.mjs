// 发送消息时连续记录 dock(输入框)几何,抓「弹跳」。用真实触摸事件(tap)驱动 UI。
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (!r || !r.result) { console.log("[bounce][raw]", JSON.stringify(r).slice(0, 300)); } if (r && r.exceptionDetails) return "EXC:" + JSON.stringify(r.exceptionDetails).slice(0, 200); return r?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[bounce]", ...a);
const tap = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, pointerType: "touch" });
  await sleep(60);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, pointerType: "touch" });
};
const centerOf = async (sel) => JSON.parse(await ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return JSON.stringify(null);var b=e.getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2});})()`));

// 0) 进 probe-long 会话(真实 tap)。若当前已在别的页,先回到会话列表
let cur = JSON.parse(await ev('JSON.stringify({screen:(document.querySelector(".screen.is-active")||{}).dataset?.screen||null, href:location.href.slice(0,60)})') || "{}").screen;
log("screen now:", cur);
if (cur !== "sessions") {
  const bk = await centerOf("#btnBack");
  if (bk) await tap(bk.x, bk.y);
  await sleep(1500);
}
const hitRect = await ev(`(function(){
  var rows=[...document.querySelectorAll(".sess-row")];
  var hit=rows.find(function(r){return (r.textContent||"").includes("probe-long")});
  if(!hit) return JSON.stringify({err:"rows:"+rows.length+" screen:"+(document.querySelector('.screen.is-active')||{}).dataset?.screen});
  var b=hit.getBoundingClientRect();
  return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2});
})()`);
if (!hitRect || hitRect === "null" || hitRect.indexOf("err") >= 0) { log("probe-long not found:", hitRect); process.exit(1); }
const p1 = JSON.parse(hitRect);
log("tap row", p1.x, p1.y);
await tap(p1.x, p1.y);
await sleep(2500);
log("screen:", await ev('(function(){var a=document.querySelector(".screen.is-active");return a&&a.dataset.screen;})()'));

// 1) tap 输入框(唤起键盘),用 insertText 输入
const inp = await centerOf("#input");
await tap(inp.x, inp.y);
await sleep(900);
await send("Input.insertText", { text: "再发一条看看输入框会不会跳" });
await sleep(600);
log("kb:", await ev('(function(){return getComputedStyle(document.documentElement).getPropertyValue("--kb")+" open:"+document.documentElement.classList.contains("kb-open");})()'));

// 2) 挂采样器
await ev(`(function(){
  const dock=document.querySelector(".composer-dock");
  const sc=document.querySelector("#chatScroll");
  const root=document.documentElement;
  window.__samples=[];
  const t0=performance.now();
  let lastKey="";
  function tick(){
    const r=dock.getBoundingClientRect();
    const s={ t:Math.round(performance.now()-t0), dockTop:Math.round(r.top*10)/10, dockH:Math.round(r.height*10)/10,
      kb:getComputedStyle(root).getPropertyValue("--kb").trim(), dockHVar:getComputedStyle(root).getPropertyValue("--dock-h").trim(),
      taH:Math.round(document.querySelector("#input").getBoundingClientRect().height*10)/10,
      st:Math.round(sc.scrollTop), sh:sc.scrollHeight, ch:sc.clientHeight };
    const key=[s.dockTop,s.dockH,s.kb,s.dockHVar,s.taH].join("|");
    if(key!==lastKey){ lastKey=key; window.__samples.push(s); }
    if(performance.now()-t0<9000) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return "sampler-on";
})()`);

// 3) tap 发送
const sb = await centerOf("#btnSend");
await tap(sb.x, sb.y);
log("sent");
await sleep(9500);

const arr = JSON.parse(await ev(`JSON.stringify(window.__samples||[])`));
log("samples(", arr.length, "):");
for (const s of arr) console.log(JSON.stringify(s));
