// document-start 追踪 --dock-h 与 dock.offsetHeight 的时序,定位 78px 旧值是何时写入的
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(method + ": " + m.error.message)) : res(m))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr, tries = 3) => {
  for (let k = 0; k < tries; k++) {
    try {
      const m = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (m.result?.exceptionDetails) { console.log("[EXC]", JSON.stringify(m.result.exceptionDetails).slice(0, 150)); return null; }
      if (m.result && m.result.result) return m.result.result.value;
      console.log("[odd]", JSON.stringify(m).slice(0, 150));
    } catch (e) { console.log("[retry]", e.message); await new Promise(r => setTimeout(r, 800)); }
  }
  return null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable", {});
await send("Page.enable", {});
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(function(){
  window.__log=[];
  const t0=performance.now();
  const snap=(why)=>{ try{
    const d=document.querySelector('.composer-dock');
    if(!d) { window.__log.push([Math.round(performance.now()-t0),why,'no-dock']); return; }
    window.__log.push([Math.round(performance.now()-t0),why,
      'dock='+d.offsetHeight,
      'var='+getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
      'pad='+getComputedStyle(d).paddingBottom,
      'font='+(document.fonts?document.fonts.status:'?')]);
  }catch(e){}};
  let n=0;
  const iv=setInterval(()=>{ snap('t'+(++n)); if(n>40) clearInterval(iv); },120);
})()` });

await send("Page.reload", {});
await sleep(9500);
const log = await ev("JSON.stringify(window.__log||[])");
if (log) for (const row of JSON.parse(log)) console.log(row.join("  "));
ws.close();
