// 抓 UpdateLayoutTree 的规模分布：是大树重算，还是碎小重算
const PORT = process.env.CDP_PORT || 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 30000); pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
await send("Runtime.enable");

await ev(`(()=>{const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen!=='sessions'){document.getElementById('btnBack')?.click();} return 1})()`);
await sleep(700);

const buf = [];
const keep = (m) => { const e = JSON.parse(m.data); if (e.method === "Tracing.dataCollected") buf.push(...e.params.value); };
ws.addEventListener("message", keep);
await send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
const done = new Promise((res) => { const h = (m) => { const e = JSON.parse(m.data); if (e.method === "Tracing.tracingComplete") { ws.removeEventListener("message", h); res(); } }; ws.addEventListener("message", h); });

for (const t of ["settings", "jobs", "files", "sessions"]) {
  const p = await ev(`(()=>{const e=document.querySelector('.tab[data-tab="${t}"]'); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
  await sleep(40);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(520);
}
await send("Tracing.end");
await done;
ws.removeEventListener("message", keep);

const styles = buf.filter((e) => e.name === "UpdateLayoutTree" && e.ph === "X");
const layouts = buf.filter((e) => e.name === "Layout" && e.ph === "X");
const pains = buf.filter((e) => e.name === "Paint" && e.ph === "X");
const big = styles.map((e) => ({ ms: +(e.dur / 1000).toFixed(1), n: e.args?.beginData?.elementCount ?? -1, dirty: e.args?.beginData?.dirtyObjects ?? -1 }))
  .sort((a, b) => b.ms - a.ms).slice(0, 10);
const sum = (arr) => +(arr.reduce((n, e) => n + (e.dur || 0), 0) / 1000).toFixed(0);
console.log(JSON.stringify({
  restyle: { n: styles.length, ms: sum(styles), over5ms: styles.filter((e) => e.dur > 5000).length },
  layout: { n: layouts.length, ms: sum(layouts) },
  paint: { n: pains.length, ms: sum(pains) },
  topRestyle: big,
  totalNodes: await ev(`document.getElementsByTagName('*').length`),
}, null, 1));
ws.close();
process.exit(0);
