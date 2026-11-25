// 浮窗上拖时底部是否露灰：抓住把手往上拖 12px 并保持，截图量最底部那条带子
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || 9227;
const OUT = process.argv[2] || "drag";
mkdirSync(".motion/verify/perf-out", { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 20000); pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => writeFileSync(`.motion/verify/perf-out/${OUT}-${n}.png`, execFileSync("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 1 << 26 }));
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
await send("Runtime.enable");

// 打开某个设置面板（默认语言；ROW=rowUpdate 可测「检查更新」）
await ev(`document.querySelector('.tab[data-tab="settings"]').click()`);
await sleep(500);
await ev(`document.getElementById(${JSON.stringify(process.env.ROW || "rowLanguage")}).click()`);
await sleep(900);
const g = await ev(`(()=>{const h=document.querySelector('#sheet .sheet-grab'); const b=h.getBoundingClientRect(); const s=document.getElementById('sheet').getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2, sheetTop:Math.round(s.top), sheetBottom:Math.round(s.bottom), vh:innerHeight};})()`);
console.log("grab", JSON.stringify(g));

// 按住往上拖 12px 不放
await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: g.x, y: g.y, id: 1 }] });
await sleep(60);
for (let i = 1; i <= 4; i++) {
  await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: g.x, y: g.y - i * 3, id: 1 }] });
  await sleep(24);
}
await sleep(260);
shot("hold");
const now = await ev(`(()=>{const s=document.getElementById('sheet').getBoundingClientRect(); return {top:Math.round(s.top), bottom:Math.round(s.bottom), h:Math.round(s.height), vh:innerHeight};})()`);
console.log("while dragging", JSON.stringify(now));
await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await sleep(600);
shot("released");
const after = await ev(`(()=>{const s=document.getElementById('sheet').getBoundingClientRect(); return {top:Math.round(s.top), bottom:Math.round(s.bottom), vh:innerHeight};})()`);
console.log("after release", JSON.stringify(after));
await ev(`(()=>{const c=document.querySelector('#sheet [data-close]'); c&&c.click(); const t=document.querySelector('.tab[data-tab="sessions"]'); t&&t.click(); return 1})()`);
ws.close();
