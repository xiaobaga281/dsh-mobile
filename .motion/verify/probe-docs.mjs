// Stage E 实测:文件制作(write_docx/xlsx/pdf/pptx)+ 前端渲染(DocPreview)一次走完
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
const log = (...a) => console.log("[docs]", ...a);

await send("Page.reload", {});
await sleep(6500);
let screen = await ev('(function(){var a=document.querySelector(".screen.is-active");return a?a.dataset.screen:"none";})()');
if (screen !== "sessions") { await ev('(function(){var b=document.querySelector("#btnBack");if(b)b.click();return 1})()'); await sleep(1500); }
await ev('(function(){var b=document.querySelector("#btnNewSession");if(b)b.click();return 1})()');
await sleep(2500);

const prompt = "依次完成并每步一句话报告：1) write_docx 生成 报告.docx，内容：一级标题「季度报告」、一段说明文字、一个 2x3 表格（列头 项目/数量）；2) write_xlsx 生成 数据.xlsx，两列（月份、金额）5 行数字；3) write_pdf 生成 说明.pdf；4) write_pptx 生成 演示.pptx，layout=cover 一页 + layout=bullets 一页；5) write 一个 备注.md。全部完成后用一行列出每个文件名和大小。";
await ev(`(function(){
  var t=document.querySelector("#input");
  var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  s.call(t,${JSON.stringify(prompt)});
  t.dispatchEvent(new Event("input",{bubbles:true}));
  return 1;
})()`);
await ev('(function(){document.querySelector("#btnSend").click();return 1})()');
log("sent, waiting…");
let ended = -1;
for (let i = 0; i < 200; i++) {
  await sleep(1000);
  const busy = await ev('(function(){var s=document.querySelector("#btnSend");return (s&&s.classList.contains("is-stop"))?1:0;})()');
  if (!busy && i > 15) { ended = i; break; }
}
log("turn ended ~" + ended + "s");

// 逐个文件验证前端渲染
const files = ["报告.docx", "数据.xlsx", "说明.pdf", "演示.pptx", "备注.md"];
for (const f of files) {
  const r = await ev(`(function(){ try { return DSHNativeHost.openWorkspaceFile(${JSON.stringify(f)}); } catch(e){ return JSON.stringify({err:String(e)}); } })()`);
  let j; try { j = JSON.parse(r); } catch { j = { parseErr: String(r).slice(0, 120) }; }
  const htmlLen = j.html ? j.html.length : 0;
  const sample = j.html ? String(j.html).replace(/<[^>]+>/g, "").slice(0, 80) : "";
  console.log(`[docs] ${f}: kind=${j.kind} preview=${j.preview} htmlLen=${htmlLen} err=${j.error || ""} sample="${sample}"`);
}
ws.close(); process.exit(0);
