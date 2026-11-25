// 流式观感实测：chunk 到达节奏 vs 上屏（DOM 变更）节奏 vs 帧率
//   node .motion/verify/perf-stream.mjs [端口]
//
// 为什么要这么量：用户主诉「有时不及时、不像流式」。这里有三种完全不同的病因：
//   (a) 合批层把字压在缓冲里   → delta 事件间隔大（p50/p95）
//   (b) 渲染层绘制太稀/太重     → DOM 变更间隔大，或每帧耗时高（掉帧）
//   (c) 模型/网络本身慢         → 首字延迟大，但 delta 间隔正常
// 只看「最终文本对不对」分不出。所以同时记录三串时间戳：
//   deltaAt（原生→JS 的合批节拍）、paintAt（MutationObserver 上屏）、frameAt（rAF 帧）
//
// 注意：必须走真实 UI（输入 + 发送）。直接拿自造 id 调桥不会渲染（app.js 只认 Live.id），
// 那样只能量到 delta、量不到上屏。
const PORT = Number(process.argv[2] || 9227);
const PROMPT = process.env.DSH_TEST_PROMPT || "用 400 字左右讲讲手机上做编译这件事为什么难，分三段。";

let ws = null, closed = false;
const pend = new Map();
let id = 0;
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
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  // 必须带超时：WS 断开时 evaluateJavascript 的 promise 永远不会 resolve，
  // 上层的轮询循环会原地卡死（实测踩过两次，日志停在 "send: sent"）
  const timer = setTimeout(() => { pend.delete(i); res(undefined); }, 4000);
  pend.set(i, (m) => { clearTimeout(timer); res(m.result); });
  try { ws.send(JSON.stringify({ id: i, method, params })); } catch (_) { clearTimeout(timer); res(undefined); }
});
const ev = async (expr) => {
  if (closed) return undefined;
  return (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))] : null);
const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

await connect();

// 1) 装记录器（包装而非替换回调：替换掉就等于让界面不渲染）
const installed = await ev(`(() => {
  const H = window.DSHHost;
  if (!H) return "no-host";
  if (window.__perf) return "already";
  const P = window.__perf = { deltaAt: [], paintAt: [], frameAt: [], sizes: [], text: "", t0: performance.now(), done: false, error: "" };
  const origDelta = H.onDelta, origThink = H.onReasoning, origDone = H.onDone, origErr = H.onError;
  P.restore = () => { H.onDelta = origDelta; H.onReasoning = origThink; H.onDone = origDone; H.onError = origErr; };
  H.onDelta = (rid, d) => {
    P.deltaAt.push(performance.now()); P.sizes.push((d || "").length); P.text += (d || "");
    try { origDelta && origDelta(rid, d); } catch (_) {}
  };
  H.onReasoning = (rid, d) => { try { origThink && origThink(rid, d); } catch (_) {} };
  H.onDone = (rid, p) => { P.done = true; try { origDone && origDone(rid, p); } catch (_) {} };
  H.onError = (rid, p) => { P.error = String(p).slice(0, 200); P.done = true; try { origErr && origErr(rid, p); } catch (_) {} };
  const target = document.querySelector("#messages") || document.body;
  P.obs = new MutationObserver(() => { if (P.t0) P.paintAt.push(performance.now()); });
  P.obs.observe(target, { childList: true, subtree: true, characterData: true });
  P.frame = () => { P.frameAt.push(performance.now()); P.raf = requestAnimationFrame(P.frame); };
  P.raf = requestAnimationFrame(P.frame);
  return "ok";
})()`);
console.log("install:", installed);
if (installed === "no-host") process.exit(1);

// 2) 走真实 UI 发一条
await sleep(300);
const sent = await ev(`(() => {
  const ta = document.querySelector("#input");
  if (!ta) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, ${JSON.stringify(PROMPT)});
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  const b = document.querySelector("#btnSend");
  if (!b) return "no-send";
  window.__perf.t0 = performance.now();
  b.click();
  return "sent";
})()`);
console.log("send:", sent);

// 3) Node 侧轮询（不在页面里挂长 Promise：页面重载/切屏会让它永远不 resolve）
let last = 0, quiet = 0;
const t0 = Date.now();
for (let i = 0; i < 240; i++) {
  await sleep(500);
  const s = await ev(`(() => { const P = window.__perf; return P ? { n: P.deltaAt.length, done: P.done, err: P.error } : null; })()`);
  if (!s) { await connect().catch(() => {}); continue; }
  if (s.n !== last) { last = s.n; quiet = 0; } else quiet++;
  if (s.done || (last > 0 && quiet >= 8)) break;
  if (Date.now() - t0 > 115000) break;
}

const P = await ev(`(() => { const p = window.__perf; if (!p) return null;
  try { p.restore && p.restore(); p.obs && p.obs.disconnect(); cancelAnimationFrame(p.raf); } catch (_) {}
  return { deltaAt: p.deltaAt, paintAt: p.paintAt, frameAt: p.frameAt, sizes: p.sizes,
           chars: p.text.length, error: p.error,
           firstDelta: (p.deltaAt[0] || 0) - p.t0, firstPaint: (p.paintAt[0] || 0) - p.t0 };
})()`);
if (!P || !P.deltaAt.length) {
  console.log("FAIL 没有收到任何 delta", JSON.stringify(P));
  process.exit(1);
}

const dg = gaps(P.deltaAt), pg = gaps(P.paintAt), fg = gaps(P.frameAt);
const stat = (name, n, g) =>
  console.log(`${name}: n=${n}  p50=${pct(g, 0.5)?.toFixed(0)}ms  p95=${pct(g, 0.95)?.toFixed(0)}ms  max=${g.length ? Math.max(...g).toFixed(0) : 0}ms`);

console.log(`\n首字 firstDelta=${P.firstDelta.toFixed(0)}ms  firstPaint=${P.firstPaint.toFixed(0)}ms  字符=${P.chars}`);
console.log(`平均批大小=${(P.sizes.reduce((a, b) => a + b, 0) / P.sizes.length).toFixed(1)} 字`);
stat("delta 间隔", P.deltaAt.length, dg);
stat("上屏间隔 ", P.paintAt.length, pg);
stat("帧间隔   ", P.frameAt.length, fg);
const fps = fg.length ? 1000 / (fg.reduce((a, b) => a + b, 0) / fg.length) : 0;
const janky = fg.filter((g) => g > 24).length;
console.log(`平均帧率=${fps.toFixed(1)}fps  掉帧(>24ms)=${janky}/${fg.length} (${((janky / Math.max(1, fg.length)) * 100).toFixed(1)}%)`);

const verdict = [];
if (P.firstDelta > 3000) verdict.push(`首字 ${P.firstDelta.toFixed(0)}ms 偏慢（多为模型/中继，不是渲染）`);
if (pct(dg, 0.95) > 400) verdict.push("delta 出现秒级空档（合批层压字）");
if (pct(pg, 0.95) > 200) verdict.push("上屏掉帧（渲染层太重）");
console.log("\n结论：" + (verdict.length ? verdict.join("；") : "节拍稳定（delta/上屏 p95 均在阈值内）"));
console.log("JSON " + JSON.stringify({
  chars: P.chars, firstDelta: Math.round(P.firstDelta), firstPaint: Math.round(P.firstPaint),
  deltaN: P.deltaAt.length, deltaP50: pct(dg, 0.5), deltaP95: pct(dg, 0.95),
  paintN: P.paintAt.length, paintP50: pct(pg, 0.5), paintP95: pct(pg, 0.95),
  fps: +fps.toFixed(1), jankPct: +((janky / Math.max(1, fg.length)) * 100).toFixed(1),
}));
process.exit(0);
