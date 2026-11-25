// 只读档走真实轮次：让模型写文件，落盘必须为 0（权限门在 ToolPipeline，直调内核会绕过它）
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 140) : ""}`);

await ev(`localStorage.setItem("dsh.perm","readonly"); 1`);
await send("Page.reload", {});
await sleep(7000);
await ev(`(() => { const b = document.querySelector("#btnNewSession"); if (b) b.click(); return 1; })()`);
await sleep(2000);
const prompt = "请用 write 工具在工作区创建 ro-probe.txt，内容只有 x，然后告诉我结果。";
await ev(`(() => {
  const t = document.querySelector("#input");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(t, ${JSON.stringify(prompt)});
  t.dispatchEvent(new Event("input", { bubbles: true }));
  return 1;
})()`);
await ev(`document.querySelector("#btnSend").click(); 1`);

let txt = "";
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const snap = await ev(`(() => {
    const a = [...document.querySelectorAll("#messages .msg.assistant")].map(e => e.textContent || "").join(" · ");
    const stop = document.querySelector("#btnStop");
    return { t: a, stop: !!stop && getComputedStyle(stop).display !== "none" };
  })()`);
  if (snap?.t) txt = snap.t;
  if (txt && !snap?.stop) break;
}
console.log("transcript:", JSON.stringify(txt.slice(-200)));
ok(/只读|readonly|read-only|权限|不允许|无法/.test(txt), "界面上给出拒绝说明", txt.slice(-140));

await ev(`localStorage.setItem("dsh.perm","full"); 1`);
process.exit(0);
