// 配置模拟器内的模型：
//   1) agnes-3.0-flash        → 真实地址（真机/有网设备用）
//   2) agnes-3.0-flash-relay  → 经宿主中转（模拟器无外网时的联调用）
// 然后走 DSHNativeAgent.chatStream 做一次真实流式对话验证。
const PORT = 9227;
const BASE = "https://apihub.agnes-ai.com/v1";
const KEY = "sk-j0txJk1nuwCWOSQVc4PNFoiAUA5opl8bVNkLVM7vbzXMShkz";
const RELAY = "http://10.0.2.2:8791/v1";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const models = [
  { id: "agnes-3.0-flash", name: "Agnes 3.0 Flash", desc: "API Hub · 低延迟", url: BASE, key: KEY, upstream: "agnes-3.0-flash", efforts: [], builtin: false },
  { id: "agnes-2.5-pro-alpha", name: "Agnes 2.5 Pro", desc: "API Hub · 强推理", url: BASE, key: KEY, upstream: "agnes-2.5-pro-alpha", efforts: [], builtin: false },
  { id: "agnes-3.0-flash-relay", name: "Agnes 3.0 · 模拟器中转", desc: "宿主中转 · 仅调试用", url: RELAY, key: KEY, upstream: "agnes-3.0-flash", efforts: [], builtin: false },
];

await ev(`(() => {
  localStorage.setItem("dsh.models", ${JSON.stringify(JSON.stringify(models))});
  localStorage.setItem("dsh.model", "agnes-3.0-flash-relay");
  localStorage.removeItem("dsh.effortByModel");
  return 1;
})()`);
await send("Page.reload", {});
await sleep(6000);
console.log("model:", await ev(`localStorage.getItem("dsh.model")`));

// 真流式对话（走 DSHNativeAgent.chatStream —— Kernel.once 同一条链路）
const probe = await ev(`new Promise((resolve) => {
  const b = window.DSHNativeAgent;
  if (!b || !b.chatStream) { resolve({ ok: false, error: "no chatStream" }); return; }
  const id = "cm-" + Date.now();
  let text = "", reasoning = "";
  const t0 = Date.now();
  const fin = (r) => resolve(r);
  window.DSHHost.onDelta = (rid, d) => { if (rid === id) text += d; };
  window.DSHHost.onReasoning = (rid, d) => { if (rid === id) reasoning += d; };
  window.DSHHost.onDone = (rid) => { if (rid === id) fin({ ok: true, text, reasoning, ms: Date.now() - t0 }); };
  window.DSHHost.onError = (rid, p) => { if (rid === id) fin({ ok: false, error: String(p), ms: Date.now() - t0 }); };
  setTimeout(() => fin({ ok: false, error: "timeout 90s", text }), 90000);
  b.chatStream(id, ${JSON.stringify(RELAY)}, ${JSON.stringify(KEY)}, JSON.stringify({
    model: "agnes-3.0-flash",
    messages: [{ role: "user", content: "一句话介绍你自己，并给出 6*7 的结果" }],
    stream: true, max_tokens: 200,
  }));
})`);
console.log("chat:", JSON.stringify(probe).slice(0, 600));
process.exit(0);
