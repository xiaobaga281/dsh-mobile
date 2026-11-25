// 真实输入法流程的弹跳探针:
//   adb input tap 打开键盘 → adb input text 输入 → CDP 挂采样器 → adb input tap 发送
//   → 采样 dock 几何 + 截屏。全部用系统级真实事件。
import { execFileSync } from "node:child_process";
const ADB = "D:/1/tools/android-sdk/platform-tools/adb.exe";
const adb = (a, opts = {}) => execFileSync(ADB, a, { encoding: "utf8", timeout: 15000, ...opts });

const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r && r.exceptionDetails) return "EXC:" + JSON.stringify(r.exceptionDetails).slice(0, 200); return r?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[bounce2]", ...a);

const dpr = Number(await ev(`window.devicePixelRatio`));
log("dpr:", dpr);

// 0) 确保 probe-long 会话已打开
let cur = await ev(`(function(){var a=document.querySelector(".screen.is-active");return a?a.dataset.screen:"none";})()`);
log("screen:", cur);
if (cur !== "chat") {
  const hitRect = await ev(`(function(){
    var rows=[...document.querySelectorAll(".sess-row")];
    var hit=rows.find(function(r){return (r.textContent||"").includes("probe-long")});
    if(!hit) return JSON.stringify(null);
    var b=hit.getBoundingClientRect();
    return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2});
  })()`);
  if (!hitRect || hitRect === "null") { log("row not found"); process.exit(1); }
  const p = JSON.parse(hitRect);
  adb(["shell", "input", "tap", Math.round(p.x * dpr), Math.round(p.y * dpr)]);
  await sleep(2500);
  log("screen now:", await ev(`(function(){var a=document.querySelector(".screen.is-active");return a?a.dataset.screen:"none";})()`));
}

// 1) 点输入框(真键盘),输 ASCII 文本
const inp = JSON.parse(await ev(`(function(){var b=document.querySelector("#input").getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2});})()`));
adb(["shell", "input", "tap", Math.round(inp.x * dpr), Math.round(inp.y * dpr)]);
await sleep(1600);
adb(["shell", "input", "text", "bounce%test"]);
await sleep(700);
log("kb:", await ev(`(function(){return getComputedStyle(document.documentElement).getPropertyValue("--kb")+" open:"+document.documentElement.classList.contains("kb-open")+" val:"+document.querySelector("#input").value;})()`));

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

// 3) adb 真 tap 发送按钮
const sb = JSON.parse(await ev(`(function(){var b=document.querySelector("#btnSend").getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2});})()`));
log("tap send at", Math.round(sb.x * dpr), Math.round(sb.y * dpr));
adb(["shell", "input", "tap", Math.round(sb.x * dpr), Math.round(sb.y * dpr)]);
log("sent");
await sleep(9500);

const arr = JSON.parse(await ev(`JSON.stringify(window.__samples||[])`));
log("samples(", arr.length, "):");
for (const s of arr) console.log(JSON.stringify(s));
log("last msg:", await ev(`(function(){var m=[...document.querySelectorAll("#messages .bubble-user")].pop();return m?(m.textContent||"").slice(0,40):"none";})()`));
