// rc.168 综合实测:富文档(链接/斜体/删除线/嵌套列表/图片) + video mode 透传 + 光标移除
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
const log = (...a) => console.log("[rc168]", ...a);
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 140) : ""}`);

await ev('localStorage.setItem("dsh.perm","full"); localStorage.setItem("dsh.preset","standard"); 1');
await send("Page.reload", {});
await sleep(6500);
let screen = await ev('(function(){var a=document.querySelector(".screen.is-active");return a?a.dataset.screen:"none";})()');
if (screen !== "sessions") { await ev('(function(){var b=document.querySelector("#btnBack");if(b)b.click();return 1})()'); await sleep(1500); }
await ev('(function(){var b=document.querySelector("#btnNewSession");if(b)b.click();return 1})()'); await sleep(2500);

// ---- 实测 1:光标移除(流式期间轮询 .caret 计数) ----
let caretSeen = 0;
const poll = (async () => {
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const n = await ev('document.querySelectorAll("#messages .caret").length');
    if (n > 0) caretSeen += n;
  }
})();
const prompt1 = "调用 image_generate：prompt=一朵蓝色的花，quality=high。只调用一次，简短汇报。";
await ev(`(function(){
  var t=document.querySelector("#input");
  var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  s.call(t,${JSON.stringify(prompt1)});
  t.dispatchEvent(new Event("input",{bubbles:true}));
  return 1;
})()`);
await ev('(function(){document.querySelector("#btnSend").click();return 1})()');
log("流式光标轮询中…");
for (let i = 0; i < 90; i++) { await sleep(1000); const b = await ev('(function(){var s=document.querySelector("#btnSend");return (s&&s.classList.contains("is-stop"))?1:0;})()'); if (!b && i > 10) break; }
await poll;
ok(caretSeen === 0, "流式期间无 .caret 光标元素", "caret 出现次数:" + caretSeen);

// ---- 实测 2:富文档(链接/斜体/删除线/嵌套列表/图片) ----
const prompt2 = "依次完成：1) 用 write 写 zhushi.md（内容随意两行）；2) 用 bash 把它重命名为 ref3.png（mv 命令，伪装成图片供嵌入测试）；" +
  "3) 调用 write_docx 生成 富文档.docx，content 必须包含：一个二级标题、一句带 [官方文档](https://example.com) 链接的话、" +
  "一句含 *斜体词* 与 ~~删除线词~~ 的话、一个两级嵌套列表（顶层一项 + 缩进两项）、一行 ![](ref3.png) 图片引用；" +
  "4) 报告返回值里的 images 计数。";
await ev(`(function(){
  var t=document.querySelector("#input");
  var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  s.call(t,${JSON.stringify(prompt2)});
  t.dispatchEvent(new Event("input",{bubbles:true}));
  return 1;
})()`);
await ev('(function(){document.querySelector("#btnSend").click();return 1})()');
log("富文档轮…");
for (let i = 0; i < 150; i++) { await sleep(1000); const b = await ev('(function(){var s=document.querySelector("#btnSend");return (s&&s.classList.contains("is-stop"))?1:0;})()'); if (!b && i > 10) break; }

// ---- 实测 3:video mode 透传 ----
const prompt3 = "调用 video_generate：prompt=模式透传测试, mode=text2video, duration=4。报告返回的 ok 值。";
await ev(`(function(){
  var t=document.querySelector("#input");
  var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  s.call(t,${JSON.stringify(prompt3)});
  t.dispatchEvent(new Event("input",{bubbles:true}));
  return 1;
})()`);
await ev('(function(){document.querySelector("#btnSend").click();return 1})()');
log("video mode 轮…");
for (let i = 0; i < 150; i++) { await sleep(1000); const b = await ev('(function(){var s=document.querySelector("#btnSend");return (s&&s.classList.contains("is-stop"))?1:0;})()'); if (!b && i > 10) break; }
ws.close(); process.exit(0);
