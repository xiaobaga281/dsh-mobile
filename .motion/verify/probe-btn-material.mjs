// 回到底部按钮 vs 输入框 材质一致性断言（同 glass-a/b 渐变 + 38px blur）
const list = await (await fetch("http://127.0.0.1:9227/json/list")).json();
const page = list.find(p => p.type === "page" && p.url.includes("appassets")) || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, m => (m.error ? r(Promise.reject(new Error(m.error.message))) : r(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => ws.addEventListener("open", r));
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return "EXC"; return r.result?.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

await ev('localStorage.setItem("dsh.perm","full"); localStorage.setItem("dsh.preset","standard"); 1');
await send("Page.reload", {});
await sleep(6500);
let screen = await ev('(function(){var a=document.querySelector(".screen.is-active");return a?a.dataset.screen:"none";})()');
if (screen !== "sessions") { await ev('(function(){var b=document.querySelector("#btnBack");if(b)b.click();return 1})()'); await sleep(1500); }
await ev('(function(){var b=document.querySelector("#btnNewSession");if(b)b.click();return 1})()'); await sleep(2500);
await ev('(function(){ var m=document.querySelector("#messages"); var h=""; for (var i=0;i<30;i++){ h += \'<div class="msg assistant" style="min-height:120px">占位 \'+i+\'</div>\'; } m.insertAdjacentHTML("afterbegin", h); return m.children.length; })()');
await sleep(1500);
await ev('(function(){var sc=document.querySelector("#chatScroll");sc.scrollTop=Math.max(0,sc.scrollHeight-sc.clientHeight-1500);return 1})()');
await sleep(700);
const mat = await ev(`(function(){
  var b=document.querySelector("#toBottom");
  if(!b||b.hidden) return JSON.stringify({err:"按钮未出现"});
  var cs=getComputedStyle(b);
  var c=document.querySelector(".composer");
  var cc=getComputedStyle(c);
  return JSON.stringify({
    btnBg:(cs.backgroundImage!=="none"?cs.backgroundImage.slice(0,50):cs.backgroundColor),
    composerBg:(cc.backgroundImage!=="none"?cc.backgroundImage.slice(0,50):cc.backgroundColor),
    btnBlur:cs.backdropFilter||cs.webkitBackdropFilter,
    composerBlur:cc.backdropFilter||cc.webkitBackdropFilter,
  });
})()`);
console.log("材质对比:", mat);
const m = JSON.parse(mat);
const ok = m.btnBg === m.composerBg && m.btnBlur === m.composerBlur;
console.log(ok ? "PASS 材质一致(渐变+blur 同配方)" : "FAIL 材质不一致");
ws.close(); process.exit(ok ? 0 : 1);
