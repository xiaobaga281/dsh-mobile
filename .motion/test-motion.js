// motion.js 单元测试（Node，无 DOM）：验证弹簧收敛、过冲、打断接管、reduced 即时。
const fs = require("fs");
const vm = require("vm");
const path = require("path");

let T = 0;
const rafQ = [];
const g = {
  console,
  performance: { now: () => T },
  requestAnimationFrame: (fn) => { rafQ.push(fn); return rafQ.length; },
  cancelAnimationFrame: () => {},
  URLSearchParams,
  location: { search: "?motionDebug=0" },
  getComputedStyle: (el) => ({
    transform: el.style.transform && el.style.transform !== "" ? el.style.transform : "none",
    opacity: el.style.opacity === "" ? "1" : el.style.opacity,
  }),
  document: {
    createElement: () => ({ style: {}, remove() {}, textContent: "" }),
    body: { appendChild() {} },
  },
  matchMedia: () => ({ matches: false }),
};
g.window = g;
g.self = g;
vm.createContext(g);
const code = fs.readFileSync(path.join(__dirname, "../app/src/main/assets/web/motion.js"), "utf8");
vm.runInContext(code, g);
const M = g.Motion;
if (!M) throw new Error("Motion not defined");

function el() {
  return { style: { transform: "", opacity: "", width: "", height: "" }, offsetWidth: 300, offsetHeight: 600 };
}
function step(frames, ms = 16.7) {
  for (let i = 0; i < frames; i++) {
    T += ms;
    const q = rafQ.splice(0);
    for (const fn of q) fn(T);
  }
}
function scaleOf(e) {
  const t = e.style.transform || "";
  const m = t.match(/scale\(([^,]+),/);
  return m ? +m[1] : 1;
}
const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); }

// 1) bouncy 从 1 到 1.2：过冲应约 5-6%，并在 600ms 内收敛
{
  const e = el();
  M.springTo(e, { scale: 1.2 }, { preset: "bouncy" });
  let peak = 1, frames = 0, settledAt = null;
  for (let i = 0; i < 80; i++) {
    step(1); frames++;
    const s = scaleOf(e);
    if (s > peak) peak = s;
    if (settledAt === null && Math.abs(s - 1.2) < 0.002) settledAt = frames * 16.7;
  }
  const over = (peak - 1.2) / 0.2;
  check("bouncy overshoot ~2-8%", over > 0.02 && over < 0.08, { over: over.toFixed(3), peak: peak.toFixed(4) });
  check("bouncy settles < 600ms", settledAt !== null && settledAt < 600, { settledAt });
  check("bouncy final 1.2", Math.abs(scaleOf(e) - 1.2) < 0.002, { final: scaleOf(e) });
}

// 2) press 从 1 到 .965 再回 1：无残留
{
  const e = el();
  M.springTo(e, { scale: 0.965 }, { preset: "press" });
  step(30);
  const mid = scaleOf(e);
  M.springTo(e, { scale: 1 }, { preset: "press" });
  step(40);
  check("press down then up", Math.abs(mid - 0.965) < 0.004 && Math.abs(scaleOf(e) - 1) < 0.002, { mid, end: scaleOf(e) });
}

// 3) 打断接管：跑到一半改目标，应从当前值继续（不跳回起点）
{
  const e = el();
  M.springTo(e, { y: 300 }, { preset: "sheet" });
  step(8); // ~133ms
  const before = +((e.style.transform || "").match(/translate3d\([^,]+,\s*(-?[\d.]+)px/) || [0, 0])[1];
  M.springTo(e, { y: 0 }, { preset: "sheet" });
  const after = +((e.style.transform || "").match(/translate3d\([^,]+,\s*(-?[\d.]+)px/) || [0, 0])[1];
  const jump = Math.abs(after - before);
  step(60);
  const end = +((e.style.transform || "").match(/translate3d\([^,]+,\s*(-?[\d.]+)px/) || [0, 0])[1];
  check("interrupt continues from current", jump < 30 && before > 10, { before, after, jump });
  check("interrupt settles to 0", Math.abs(end) < 0.5, { end });
}

// 4) 超时强制落位（max 很小）
{
  const e = el();
  M.springTo(e, { opacity: 0 }, { preset: "gentle", max: 80 });
  step(12);
  check("max timeout forces final", Math.abs(+e.style.opacity) < 0.01, { opacity: e.style.opacity });
}

// 5) 首帧响应：按下当帧就开始变化（1 帧内至少走完 20%）
{
  const e = el();
  M.springTo(e, { scale: 0.9 }, { preset: "pressIn" });
  step(1);
  const first = scaleOf(e);
  const progress = (1 - first) / 0.1;
  check("first frame responds >=10%", progress >= 0.1, { first, progress: progress.toFixed(2) });
  step(30);
  check("pressIn settles to 0.9", Math.abs(scaleOf(e) - 0.9) < 0.002, { now: scaleOf(e) });
}

// 6) 多属性合并
{
  const e = el();
  M.springTo(e, { scale: 1.05 }, { preset: "press" });
  step(3);
  M.springTo(e, { opacity: 0.5 }, { preset: "press" });
  step(40);
  check("merged props both land", Math.abs(scaleOf(e) - 1.05) < 0.002 && Math.abs(+e.style.opacity - 0.5) < 0.01, {
    scale: scaleOf(e), opacity: e.style.opacity,
  });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.name + " " + JSON.stringify(r.detail || {}));
console.log("\n" + (failed.length ? failed.length + " FAILED" : "ALL PASS"));
process.exit(failed.length ? 1 : 0);
