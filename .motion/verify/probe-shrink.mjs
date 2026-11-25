// 复现「回合结束后对话流内容部分消失」：边流边采样 #messages 文本，记录长度突变
//   node .motion/verify/probe-shrink.mjs [端口]
const PORT = Number(process.argv[2] || 9227);
const PROMPT = process.env.DSH_TEST_PROMPT || "用 500 字左右分三段讲讲手机端跑编译的难点，每段 150 字以上。";
let ws = null, closed = false; const pend = new Map(); let id = 0;
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((p) => p.type === "page") || list[0];
  ws = new WebSocket(page.webSocketDebuggerUrl); closed = false;
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  ws.addEventListener("close", () => { closed = true; });
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => closed ? undefined : (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await connect();

const sent = await ev(`(() => {
  const ta = document.querySelector("#input"); if (!ta) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, ${JSON.stringify(PROMPT)});
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  const b = document.querySelector("#btnSend"); if (!b) return "no-send";
  b.click(); return "sent";
})()`);
console.log("send:", sent);

let prev = -1, prevText = "", drops = 0;
for (let i = 0; i < 200; i++) {
  await sleep(400);
  const t = await ev(`(document.querySelector("#messages")||{}).innerText||""`);
  if (typeof t !== "string") { await connect().catch(() => {}); continue; }
  const n = t.length;
  if (prev >= 0 && n !== prev) {
    const d = n - prev;
    if (d < -20) {
      drops++;
      console.log(`  ⚠ t=${(i * 0.4).toFixed(1)}s 文本骤减 ${d} 字：${prev} → ${n}`);
      // 找出消失的片段（简单的行级 diff）
      const a = prevText.split("\n"), b = t.split("\n");
      const gone = a.filter((x) => x.trim() && !b.includes(x));
      if (gone.length) console.log("     消失行示例:", gone.slice(0, 3).map((s) => s.slice(0, 60)).join(" | "));
    }
  }
  prev = n; prevText = t;
  const done = await ev(`!!(window.Live===undefined)`);  // Live 不在全局，忽略
  if (i > 20 && n === prev && i % 10 === 0) {
    // 连续几个周期没变化，认为停了
  }
}
console.log(`\n采样结束，文本骤减次数=${drops}，最终长度=${prev}`);
process.exit(0);
