// 截取固定几屏，用于「视觉零变化」逐像素比对：node perf-shots.mjs <prefix>
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || 9227;
const PREFIX = process.argv[2] || "base";
const OUT = `.motion/verify/perf-out/shots-${PREFIX}`;
mkdirSync(OUT, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 20000); pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
await send("Runtime.enable");

const shot = (name) => {
  const png = execFileSync("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 1 << 26 });
  writeFileSync(`${OUT}/${name}.png`, png);
  return name;
};

// 1) 会话页
await ev(`(()=>{const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen!=='sessions'){document.getElementById('btnBack')?.click();} return 1})()`);
await sleep(800);
await ev(`(()=>{const s=document.getElementById('sessionsScroll'); if(s) s.scrollTop=0; return 1})()`);
await sleep(300);
shot("01-sessions");

// 2) 对话页（固定滚到中间某处）
const row = await ev(`(()=>{const r=[...document.querySelectorAll('#screen-sessions .sess-row')].find(x=>(x.textContent||"").includes("stress-会话 0")); if(!r) return null; const b=r.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
if (row) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: row.x, y: row.y, id: 1 }] });
  await sleep(45);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(1200);
  await ev(`(()=>{const s=document.getElementById('chatScroll'); if(s) s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * 0.5); return 1})()`);
  await sleep(500);
  shot("02-chat-mid");
}

// 3) 设置页
await ev(`(()=>{const b=document.getElementById('btnBack'); b&&b.click(); return 1})()`);
await sleep(700);
await ev(`document.querySelector('.tab[data-tab="settings"]').click()`);
await sleep(900);
await ev(`(()=>{const s=document.querySelector('#screen-settings .scroll, #screen-settings'); if(s) s.scrollTop=0; return 1})()`);
await sleep(300);
shot("03-settings");

// 4) 语言浮层（同一张 sheet，位置固定）
await ev(`document.getElementById('rowLanguage').click()`);
await sleep(900);
shot("04-sheet-lang");
await ev(`(()=>{const c=document.querySelector('#sheet [data-close]'); c&&c.click(); return 1})()`);
await sleep(400);
await ev(`document.querySelector('.tab[data-tab="sessions"]').click()`);
await sleep(500);

console.log(JSON.stringify({ ok: true, dir: OUT }, null, 1));
ws.close();
