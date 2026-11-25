// Stage A 实测:自造插件全生命周期(规范→创建→装配→调用→卸载),走真实 Agent 轮。
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page" && p.url.includes("appassets")) || list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return "EXC:" + JSON.stringify(r.exceptionDetails).slice(0, 150); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[selfplugin]", ...a);

// 0) 权限全开(插件装配自动批准),确保模型与中继
await ev(`localStorage.setItem("dsh.perm", "full"); localStorage.setItem("dsh.preset", "standard"); 1`);
console.log("preset:", await ev(`localStorage.getItem("dsh.preset")`));
const model = await ev(`localStorage.getItem("dsh.model")`);
log("model:", model);
await send("Page.reload", {});
await sleep(6500);

// 1) 新会话
let screen = await ev('(function(){var a=document.querySelector(".screen.is-active");return a?a.dataset.screen:"none";})()');
if (screen !== "sessions") { await ev('(function(){var b=document.querySelector("#btnBack");if(b)b.click();return 1})()'); await sleep(1500); }
await ev('(function(){var b=document.querySelector("#btnNewSession");if(b)b.click();return 1})()');
await sleep(2500);

// 2) 发全生命周期任务
const prompt = "按这个顺序完成插件全生命周期演示：" +
  "1) 先调 plugin_spec 读规范；" +
  "2) 用 plugin_create 创建 handler=js 的插件：id=wc-demo，工具名 wc_demo（参数 path，统计工作区文件行数），" +
  "code 里用 dsh.fs.read 读 dsh.args.path、按行数 return；" +
  "3) 先用 write 写一个文件 demo.txt 内容为三行文字（第一行 alpha，第二行 beta，第三行 gamma）；" +
  "4) 调 wc_demo(path=demo.txt) 报告行数；" +
  "5) 用 plugin_uninstall 卸载 wc-demo（不保留清单）；" +
  "6) 每一步完成后简短报告做了什么、结果是什么。";
await ev(`(function(){
  var t=document.querySelector("#input");
  var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  s.call(t,${JSON.stringify(prompt)});
  t.dispatchEvent(new Event("input",{bubbles:true}));
  return 1;
})()`);
await ev('(function(){document.querySelector("#btnSend").click();return 1})()');
log("sent lifecycle prompt, waiting…");

// 3) 等轮次结束（最多 4 分钟）
let ended = -1;
for (let i = 0; i < 240; i++) {
  await sleep(1000);
  const busy = await ev('(function(){var s=document.querySelector("#btnSend");return (s&&s.classList.contains("is-stop"))?1:0;})()');
  if (!busy && i > 15) { ended = i; break; }
  if (i % 30 === 0 && i > 0) log(i + "s still running…");
}
log("turn ended at ~" + ended + "s");
const tail = await ev('(function(){var m=[...document.querySelectorAll("#messages .msg.assistant .assistant-text")].pop();return m?(m.textContent||"").slice(-700):"none";})()');
log("tail:", String(tail).replace(/\s+/g, " ").slice(0, 500));
ws.close(); process.exit(0);
