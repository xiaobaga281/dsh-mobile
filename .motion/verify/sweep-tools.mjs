// rc.110 取证：全工具扫描——用 release（R8 混淆）包扫出「AbstractMethodError: abstract method
// n.p.a(JSONObject, n.l) on receiver Class<o.M>」的肇事工具。
// 路径：window.DSHNativeKernel.toolCall(id, name, "{}") → PluginRegistry.exec → hit.second.execute(args, ctx)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "bug-rc110");
fs.mkdirSync(OUT, { recursive: true });
const PORT = +(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9227);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); setTimeout(() => rej(new Error("ws-timeout")), 8000); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 装一个结果收集器：无条件接管 DSHHost.onToolResult（emitRaw 有 && 守卫，handler 不存在结果就丢）
await ev(`(function(){
  window.__sweep = { resolvers: {} };
  const host = window.DSHHost;
  if (!host.__sweepWrapped) {
    const orig = host.onToolResult;
    host.onToolResult = function(id, json) {
      const r = window.__sweep.resolvers[id];
      if (r) { delete window.__sweep.resolvers[id]; r(json); }
      if (orig) try { orig.call(host, id, json); } catch (e) {}
    };
    host.__sweepWrapped = true;
  }
  return 'ready';
})()`);

const callTool = (name) => new Promise(async (resolve) => {
  const cid = 'sweep-' + name + '-' + Math.random().toString(36).slice(2, 7);
  await ev(`(function(){
    window.__sweep.resolvers[${JSON.stringify(cid)}] = function(json) {
      window.__sweep.done = json;
    };
    window.__sweep.done = null;
  })()`);
  await ev(`window.DSHNativeKernel.toolCall(${JSON.stringify(cid)}, ${JSON.stringify(name)}, '{}')`);
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const done = await ev(`window.__sweep.done`);
    if (done !== null && done !== undefined) return resolve(done);
  }
  resolve('TIMEOUT');
});

const schemas = await ev(`JSON.parse(window.DSHNativeKernel.toolSchemas())`);
const names = (Array.isArray(schemas) ? schemas : schemas.tools || []).map((t) => t.name || t.tool).filter(Boolean);
console.log("tools:", names.length);

const report = {};
let nDone = 0;
for (const name of names) {
  const raw = await callTool(name);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = { raw: String(raw) }; }
  report[name] = parsed;
  fs.writeFileSync(path.join(OUT, "sweep.json"), JSON.stringify(report, null, 2));
  const flag = parsed && parsed.ok === false && /AbstractMethod|abstract method/i.test(JSON.stringify(parsed));
  console.log((flag ? "!!! " : "    ") + name, "->", JSON.stringify(parsed).slice(0, 110));
  if (flag) { await sleep(200); }
}
const crashes = Object.entries(report).filter(([, v]) => /AbstractMethod|abstract method/i.test(JSON.stringify(v)));
fs.writeFileSync(path.join(OUT, "sweep.json"), JSON.stringify(report, null, 2));
console.log("\nAbstractMethodError tools:", crashes.map(([n]) => n).join(", ") || "(none)");
process.exit(0);
