// 性能基线：app_build 的墙钟耗时（同一工程连打两次，第一枪冷、第二枪暖）
// 用法：node .motion/verify/perf-app-build.mjs [dir] [runs]
//
// 只量「工具从进入到返回」的墙钟时间 + 工具自报的分段耗时（timings）。
// 不看界面文字静止 —— app_build 跑几分钟期间界面本来就不动。
import { execFileSync } from "node:child_process";

const PORT = 9227;
const DIR = process.argv[2] || "hello";
const RUNS = Number(process.argv[3] || 2);

const sh = (cmd) => {
  try {
    return execFileSync("adb", ["shell", cmd], { encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
};

let ws = null;
let closed = false;
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((p) => p.type === "page") || list[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  closed = false;
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  ws.addEventListener("close", () => { closed = true; });
}
const pend = new Map();
let id = 0;
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pend.set(i, (m) => res(m.result));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  if (closed) return undefined;
  return (await send("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await connect();

const TAG = Date.now().toString(36);
await hook();

let seq = 0;
async function hook() {
  await ev(`window.__p = { r: {} }; window.DSHHost.onToolResult = (id, r) => { window.__p.r[id] = r; }; 1`);
}
async function call(name, args, timeoutMs = 600000) {
  if (closed || ws.readyState !== 1) { await connect(); await hook(); }
  const cid = `${name}-${TAG}-${++seq}`;   // id 必须唯一：内核按 id 去重，重复会被静默丢弃
  await ev(`window.DSHNativeKernel.toolCall(${JSON.stringify(cid)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}); 1`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(500);
    const r = await ev(`window.__p.r[${JSON.stringify(cid)}] || null`);
    if (r != null) {
      const outer = JSON.parse(r);
      if (outer && typeof outer.output === "string" && outer.output.startsWith("{")) {
        try { return { ...outer, ...JSON.parse(outer.output), wall: Date.now() - t0 }; } catch (_) {}
      }
      return { ...outer, wall: Date.now() - t0 };
    }
  }
  return { ok: false, error: "timeout", wall: Date.now() - t0 };
}

const results = [];
for (let i = 1; i <= RUNS; i++) {
  console.log(`\n--- 第 ${i} 次 app_build(${DIR}) ---`);
  const r = await call("app_build", { description: "性能测量", dir: DIR, out: `perf-${i}.apk` });
  const t = r.timings ? JSON.stringify(r.timings) : "(本次构建未上报 timings)";
  console.log(`${r.ok ? "OK  " : "FAIL"} wall=${(r.wall / 1000).toFixed(1)}s bytes=${r.bytes ?? "-"}`);
  console.log(`     timings=${t}`);
  if (!r.ok) console.log("     " + JSON.stringify(r).slice(0, 400));
  results.push({ run: i, ok: !!r.ok, wallMs: r.wall, timings: r.timings || null, bytes: r.bytes ?? null });
}

const okRun = results.filter((x) => x.ok);
if (okRun.length) {
  const avg = okRun.reduce((a, b) => a + b.wallMs, 0) / okRun.length;
  console.log(`\n汇总：${okRun.length}/${results.length} 成功，平均墙钟 ${(avg / 1000).toFixed(1)}s，` +
    `最快 ${(Math.min(...okRun.map((x) => x.wallMs)) / 1000).toFixed(1)}s`);
}
console.log("\nJSON " + JSON.stringify(results));
