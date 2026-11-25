// 生成模型新参数实测:视频(比例/参考图 multipart/模型覆盖) + 图像(quality/模型/图生图 edits)
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page" && p.url.includes("appassets")) || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return "EXC:" + JSON.stringify(r.exceptionDetails).slice(0, 120); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.reload", {});
await sleep(6500);
let screen = await ev('(function(){var a=document.querySelector(".screen.is-active");return a?a.dataset.screen:"none";})()');
if (screen !== "sessions") { await ev('(function(){var b=document.querySelector("#btnBack");if(b)b.click();return 1})()'); await sleep(1500); }
await ev('(function(){var b=document.querySelector("#btnNewSession");if(b)b.click();return 1})()');
await sleep(2500);

const prompt = "依次完成，每步一句话报告（含关键返回值）：1) 调用 video_generate：prompt=测试画面，aspect_ratio=9:16，duration=8；" +
  "2) 用 write 写文件 ref.png（内容随意几行文本）；3) 再调 video_generate：prompt=图生视频测试，image_path=ref.png；" +
  "4) 调用 image_generate：prompt=一张测试图，quality=high，model=gpt-image-1；" +
  "5) 用 write 写 ref2.png；6) 调用 image_generate：prompt=图生图测试，image_path=ref2.png。";
await ev(`(function(){
  var t=document.querySelector("#input");
  var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  s.call(t,${JSON.stringify(prompt)});
  t.dispatchEvent(new Event("input",{bubbles:true}));
  return 1;
})()`);
await ev('(function(){document.querySelector("#btnSend").click();return 1})()');
console.log("[media] sent, waiting…");
let ended = -1;
for (let i = 0; i < 240; i++) {
  await sleep(1000);
  const busy = await ev('(function(){var s=document.querySelector("#btnSend");return (s&&s.classList.contains("is-stop"))?1:0;})()');
  if (!busy && i > 15) { ended = i; break; }
}
console.log("[media] turn ended ~" + ended + "s");
const tail = await ev('(function(){var m=[...document.querySelectorAll("#messages .msg.assistant .assistant-text")].pop();return m?(m.textContent||"").slice(-600):"none";})()');
console.log("[media] tail:", String(tail).replace(/\s+/g, " ").slice(0, 500));
ws.close(); process.exit(0);
