// 回归核查：走界面（Native 在 IIFE 内，外部取不到）
// 覆盖本次改动直接碰到的路径：左滑四键 / 置顶 / 语言往返 / 动态插入节点的翻译
const PORT = process.env.CDP_PORT || 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 20000); pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tap = async (x, y) => {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await sleep(45);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
await send("Runtime.enable");

const out = {};
const rectOf = (sel, needle) => ev(`(()=>{
  const rows=[...document.querySelectorAll(${JSON.stringify(sel)})];
  const r=rows.find(x=>(x.textContent||"").includes(${JSON.stringify(needle)}));
  if(!r) return null; const b=r.getBoundingClientRect();
  return {x:b.x+b.width/2,y:b.y+b.height/2,right:b.x+b.width-30};
})()`);

// 回到会话页
await ev(`(()=>{const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen!=='sessions'){document.getElementById('btnBack')?.click();} return 1})()`);
await sleep(600);

// 1) 左滑四键 + 置顶
const row = await rectOf("#screen-sessions .sess-row", "stress-会话 1");
if (row) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: row.right, y: row.y, id: 1 }] });
  for (let i = 1; i <= 6; i++) {
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: row.right - i * 30, y: row.y, id: 1 }] });
    await sleep(16);
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(600);
  out.swipe = await ev(`(()=>{
    const r=[...document.querySelectorAll('#screen-sessions .sess-row')].find(x=>(x.textContent||"").includes("stress-会话 1"));
    if(!r) return {found:false};
    return {found:true, acts:[...r.querySelectorAll('.sess-act')].map(b=>b.className.replace('sess-act ','')), swiped: r.classList.contains('is-swiped')};
  })()`);
  const pin = await ev(`(()=>{const r=[...document.querySelectorAll('#screen-sessions .sess-row')].find(x=>(x.textContent||"").includes("stress-会话 1")); const p=r&&r.querySelector('.sess-act.pin'); if(!p) return null; const b=p.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  if (pin) {
    await tap(pin.x, pin.y);
    await sleep(900);
    out.pin = await ev(`(()=>{
      const sec=document.getElementById('pinnedSection');
      const pl=document.getElementById('pinnedList');
      return {shown: sec? getComputedStyle(sec).display!=="none" : null, hasRow: pl? pl.textContent.includes("stress-会话 1") : null, toasted: document.body.textContent.includes("已置顶")};
    })()`);
  }
} else out.swipe = { found: false };

// 2) 语言往返
async function pickLang(want) {
  await ev(`document.querySelector('.tab[data-tab="settings"]').click()`);
  await sleep(450);
  await ev(`document.getElementById('rowLanguage').click()`);
  await sleep(450);
  const opts = await ev(`[...document.querySelectorAll('#sheetBody [data-lang]')].map(x=>x.dataset.lang)`);
  await ev(`(()=>{const b=document.querySelector('#sheetBody [data-lang="${want}"]'); b&&b.click(); return 1})()`);
  await sleep(700);
  await ev(`(()=>{const c=document.querySelector('#sheet [data-close]'); c&&c.click(); return 1})()`);
  await sleep(300);
  return { opts, probe: await ev(`(()=>{const q=s=>{const e=document.querySelector(s);return e?e.textContent.trim().slice(0,22):null};return {lang:document.documentElement.lang, tabOn:document.querySelector('.tab.is-on')?.textContent.trim().slice(0,12), settingsTitle:q('#settingsTitle'), firstRow:q('#screen-settings .row-title')||q('#screen-settings .row .t')}})()`) };
}
out.lang = [];
for (const want of ["en", "zh", "en", "zh"]) {
  const r = await pickLang(want);
  out.lang.push({ want, ...r });
}

// 3) 动态节点翻译：**英文模式**下新插入的面板也必须是英文
await pickLang("en");
await ev(`(()=>{const r=document.getElementById('rowModels'); r&&r.click(); return 1})()`);
await sleep(600);
out.dynamicEn = await ev(`(()=>{
  const t=document.querySelector('#sheetBody')?.textContent||"";
  return {sample: t.replace(/\\s+/g," ").slice(0,80), hasZh: /[\\u4e00-\\u9fa5]/.test(t)};
})()`);
await ev(`(()=>{const c=document.querySelector('#sheet [data-close]'); c&&c.click(); return 1})()`);
await sleep(300);

// 收尾：确保回到中文 + 会话页
await pickLang("zh");
await ev(`(()=>{const t=document.querySelector('.tab[data-tab="sessions"]'); t&&t.click(); return 1})()`);
await sleep(400);

console.log(JSON.stringify(out, null, 1));
ws.close();
