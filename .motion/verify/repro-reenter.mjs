// 复现「流式中退出对话页再进入 → 流式卡住」
// 用法：node repro-reenter.mjs [端口]
const PORT = Number(process.argv[2] || 9227);

let ws = null, closed = false;
const pend = new Map();
let id = 0;
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((p) => p.type === "page") || list[0];
  ws = new WebSocket(page.webSocketDebuggerUrl); closed = false;
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  ws.addEventListener("close", () => { closed = true; });
}
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { pend.delete(i); res(undefined); }, 6000);
  pend.set(i, (m) => { clearTimeout(t); res(m.result); });
  try { ws.send(JSON.stringify({ id: i, method, params })); } catch (_) { clearTimeout(t); res(undefined); }
});
const ev = async (expr) => closed ? undefined : (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await connect();

// 1) delta 计数器：内核轮次的 delta 走 onAgent（__evLog 里 t==="delta"），
//    不是 onDelta —— 前两轮复现都因此误判「没流式」
const cnt = `(window.__evLog||[]).filter(e=>e.t==="delta").length`;
console.log("count-channel: onAgent/__evLog");

// 2) 真实 UI 发送
console.log("send:", await ev(`(() => {
  const ta = document.querySelector("#input"); if (!ta) return "no-input";
  const st = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  st.call(ta, "用600字讲讲流式输出的原理，分四段，每段150字。");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#btnSend").click();
  return "sent";
})()`));

// 3) 等流式开始（收到第一批 delta）
let started = false;
for (let i = 0; i < 180; i++) {
  await sleep(500);
  const n = await ev(cnt);
  if (n >= 3) { started = true; break; }
}
console.log("streaming started:", started);
if (!started) { console.log("FAIL 没等到流式开始"); process.exit(1); }

// 4) 退出对话页（返回手势同款）
console.log("back:", await ev(`window.DSHHandleBack() === true ? "went-sessions" : "noop"`));
await sleep(1500);

// 5) 重进：openSession(当前会话)
// 重进方式对齐真实用户：点会话列表里第一项（刚聊完的那个）
console.log("reenter:", await ev(`(() => {
  const item = document.querySelector("#sessionList .session-item, #sessionList > *");
  if (!item) return "no-item";
  const main = item.querySelector(".sess-main") || item;
  main.click();
  return "clicked";
})()`));
await sleep(800);

// 6) 采样 10 秒：delta 是否还在增长、DOM 文本是否在变
const s0 = await ev(`JSON.stringify({ n: ${cnt} })`);
await sleep(10000);
const s1 = await ev(`JSON.stringify({ n: ${cnt},
  domLen: (document.querySelector("#messages")||{}).textContent?.length || 0,
  screen: (typeof state!=="undefined" && state.screen) || "?" })`);
console.log("10s 前:", s0);
console.log("10s 后:", s1);
const a = JSON.parse(s0), b = JSON.parse(s1);
console.log(b.n > a.n ? "✅ 重进后 delta 仍在到达" : "❌ 重进后 delta 停了（复现）");
process.exit(0);
