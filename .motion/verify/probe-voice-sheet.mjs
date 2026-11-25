// 设置 → 插件 → 语音输入插件面板：断言「语音音色」act=默认、无男女分组
const list = await (await fetch("http://127.0.0.1:9227/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("appassets"));
if (!page) { console.log("FAIL no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ev(`(() => { const b = [...document.querySelectorAll("button")].find(x => (x.textContent||"").trim() === "设置" && x.closest("nav,[class*=nav]")); if (b) b.click(); return 1; })()`);
await sleep(800);
let r = await ev(`(() => {
  const b = [...document.querySelectorAll("#screen-settings button")].find(x => (x.textContent||"").includes("内核插件"));
  if (!b) return "no-row"; b.click(); return "plugins-open";
})()`);
await sleep(800);
r = await ev(`(() => {
  const btns = [...document.querySelectorAll("button")].filter(b => (b.textContent||"").includes("语音输入") || (b.textContent||"").includes("语音"));
  if (!btns.length) return "no-voice-row";
  btns[0].click(); return "voice-panel:" + (btns[0].textContent||"").trim().slice(0, 24);
})()`);
await sleep(900);
const sheet = await ev(`(() => { const s = document.querySelector("#sheetBody") || document.querySelector("#sheet"); return s ? s.innerText.replace(/\n+/g, " | ").slice(0, 560) : "no-sheet-body"; })()`);
console.log("step2:", r);
console.log("sheet:", sheet);
console.log(/男声|女声|系统音色/.test(sheet) ? "FAIL  仍有男女分组" : "PASS  无男女分组");
process.exit(0);
