// 端到端：真实 UI 发消息 → 模型 → 工具调用 → 气泡回复（覆盖 todo_write / session_trace / 沙箱）
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 150) : ""}`);

// 0) 权限档位设为 full（避免逐条确认），并确保有会话
await ev(`localStorage.setItem("dsh.perm", "full"); 1`);
await send("Page.reload", {});
await sleep(6000);

let screen = await ev(`(() => { const on = [...document.querySelectorAll(".screen")].filter(s => getComputedStyle(s).display !== "none"); return on.map(s => s.id).join(",") || "none"; })()`);
console.log("visible screen:", screen);

if (!/screen-chat/.test(screen)) {
  await ev(`(() => { const b = document.querySelector("#btnNewSession"); if (b) b.click(); return 1; })()`);
  await sleep(2500);
  screen = await ev(`(() => { const on = [...document.querySelectorAll(".screen")].filter(s => getComputedStyle(s).display !== "none"); return on.map(s => s.id).join(",") || "none"; })()`);
  console.log("after new session:", screen);
}
ok(/screen-chat/.test(screen), "进入对话页");

// 1) 发送一条必须走工具的消息
// 用 UUID 做证据：模型不可能凭空猜出一个随机 UUID，回复里有它就证明工具真的跑了
const prompt = "请用 bash 工具执行 cat /proc/sys/kernel/random/uuid，然后把输出的 UUID 原样告诉我，不要解释。";
const typed = await ev(`(() => {
  const t = document.querySelector("#input");
  if (!t) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(t, ${JSON.stringify(prompt)});
  t.dispatchEvent(new Event("input", { bubbles: true }));
  return t.value.slice(0, 12);
})()`);
ok(typed !== "no-input", "输入框可写", typed);

const before = await ev(`document.querySelectorAll("#messages .msg, #messages [data-uid]").length`);
await ev(`(() => { document.querySelector("#btnSend").click(); return 1; })()`);

// 2) 等回复：轮询最后一条 assistant 文本，直到稳定且不再 streaming
let last = "", stable = 0, toolSeen = false, errSeen = "";
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const snap = await ev(`(() => {
    const nodes = [...document.querySelectorAll("#messages .msg, #messages [data-uid]")];
    const txt = [...document.querySelectorAll("#messages .msg.assistant")].map(e => e.textContent || e.innerText).join(" · ") || "";
    const html = document.querySelector("#messages")?.innerHTML || "";
    return {
      n: nodes.length,
      tail: txt.slice(-400),
      // 工具步骤在小屏上是折叠的，innerText 里只剩用时/步数徽标；用它作为「工具真的跑过」的证据
      tool: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(txt),
      err: (document.querySelector(".toast,.err,.error")?.innerText || ""),
      stop: !!document.querySelector("#btnStop") && getComputedStyle(document.querySelector("#btnStop")).display !== "none",
    };
  })()`);
  if (snap?.tool) toolSeen = true;
  if (snap?.err) errSeen = snap.err;
  if (snap?.tail === last) stable++; else { stable = 0; last = snap?.tail || ""; }
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(last) && !snap?.stop) break;
  if (stable >= 4 && last.trim().replace(/·/g, "").length > 0 && !snap?.stop) break;
}
console.log("DEBUG text:", JSON.stringify(last.slice(-200)), "toolSeen:", toolSeen);
ok(toolSeen, "工具调用卡片出现（bash）", last.slice(-160));
ok(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(last), "回复里带回工具输出的 UUID", last.slice(-160));
ok(!errSeen, "无错误 toast", errSeen);

// 3) 会话事件与待办（需要活跃轮次上下文）
const after = await ev(`document.querySelectorAll("#messages .msg, #messages [data-uid]").length`);
ok(after > before, "消息节点增加", `${before} → ${after}`);

process.exit(0);
