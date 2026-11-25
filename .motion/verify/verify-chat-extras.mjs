// 验证 rc.152 的阅读增强：代码复制 / 回到底部 / 长按动作 / 对话内搜索 / 用量面板
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || 9227;
const OUT = ".motion/verify/perf-out";
mkdirSync(OUT, { recursive: true });
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 20000); pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => writeFileSync(`${OUT}/${n}.png`, execFileSync("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 1 << 26 }));
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
await send("Runtime.enable");

const out = {};
// 打开第一个 stress 会话
await ev(`(()=>{const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen!=='sessions'){document.getElementById('btnBack')?.click();} return 1})()`);
await sleep(600);
const row = await ev(`(()=>{const r=[...document.querySelectorAll('#screen-sessions .sess-row')].find(x=>(x.textContent||"").includes("stress-会话 0")); if(!r) return null; const b=r.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
if (row) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: row.x, y: row.y, id: 1 }] });
  await sleep(40);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(1400);
}
out.codeCopy = await ev(`document.querySelectorAll('.code-copy').length`);
shot("x1-chat");

// 滚到顶 → 回到底部浮标应出现
await ev(`(()=>{const s=document.getElementById('chatScroll'); s.scrollTop=0; s.dispatchEvent(new Event('scroll')); return 1})()`);
await sleep(500);
out.toBottom = await ev(`(()=>{const b=document.getElementById('toBottom'); return b?{hidden:b.hidden}:null})()`);
shot("x2-tobottom");

// 回到底部按钮点一下
const tb = await ev(`(()=>{const b=document.getElementById('toBottom'); if(!b||b.hidden) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
if (tb) { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tb.x, y: tb.y, id: 1 }] }); await sleep(40); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(700); }
out.afterJump = await ev(`(()=>{const s=document.getElementById('chatScroll'); return {gap:Math.round(s.scrollHeight-s.scrollTop-s.clientHeight), btnHidden:document.getElementById('toBottom').hidden}})()`);

// 长按一条助手消息 → 动作面板
const m = await ev(`(()=>{const els=[...document.querySelectorAll('#messages .msg')]; const el=els[Math.max(0,els.length-2)]; if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+Math.min(40,r.height/2)};})()`);
if (m) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: m.x, y: m.y, id: 1 }] });
  await sleep(700);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(700);
}
out.msgSheet = await ev(`(()=>{const s=document.getElementById('sheet'); return {open: s?getComputedStyle(s).transform!=="none"&&s.classList.contains('is-on'):null, hasCopy: !!document.querySelector('[data-msg-copy]'), hasFork: !!document.querySelector('[data-msg-fork]')}})()`);
shot("x3-msgsheet");
await ev(`(()=>{const c=document.querySelector('#sheet [data-close]'); c&&c.click(); return 1})()`);
await sleep(500);

// 更多 → 在对话中搜索
await ev(`document.getElementById('btnChatMore').click()`);
await sleep(700);
await ev(`(()=>{const b=document.querySelector('[data-act="search"]'); b&&b.click(); return 1})()`);
await sleep(600);
out.searchOpen = await ev(`(()=>{const b=document.getElementById('chatSearch'); return b?{hidden:b.hidden}:null})()`);
await send("Input.insertText", { text: "第" });
await sleep(600);
out.searchHits = await ev(`document.getElementById('chatSearchCount').textContent`);
shot("x4-search");
await ev(`document.getElementById('chatSearchClose').click()`);
await sleep(300);

// 用量面板
const u = await ev(`(()=>{const b=document.querySelector('[data-turn-usage]'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
if (u) { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: u.x, y: u.y, id: 1 }] }); await sleep(40); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(800); }
out.usageSheet = await ev(`(()=>{const t=document.querySelector('#sheet .usage-grid'); return t?{rows:t.children.length/2, text:(t.textContent||"").replace(/\\s+/g," ").slice(0,60)}:null})()`);
shot("x5-usage");
await ev(`(()=>{const c=document.querySelector('#sheet [data-close]'); c&&c.click(); return 1})()`);

console.log(JSON.stringify(out, null, 1));
ws.close();
