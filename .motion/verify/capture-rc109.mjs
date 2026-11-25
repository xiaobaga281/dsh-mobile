// rc.109 取证：修「滑块回弹落位偏左」——几何量取改布局空间（offsetLeft/offsetWidth）。
// 关键用例 T3/T4：横向拖拽带斜向分量（dy≠0 → 导航条带 scaleX 形变 + 回弹弹簧），
// 松手后导航条 transform 被 Motion.clear 清掉，但旧代码写入的 translateX 是在
// sx≠1 时量出来的（= 真实偏移×sx），误差在终态依然存在 → 终态量偏差即有效判据。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "bug-rc109");
fs.mkdirSync(OUT, { recursive: true });
const PORT = +(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9227);
const LABEL = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "rc109";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); setTimeout(() => rej(new Error("ws-timeout")), 8000); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALIGN_PROBE = `(() => {
  const bar = document.getElementById('tabbar');
  const ind = document.getElementById('tabIndicator');
  const act = document.querySelector('.tab.is-on');
  if (!bar || !ind || !act) return null;
  const ir = ind.getBoundingClientRect(), ar = act.getBoundingClientRect();
  return {
    tab: act.dataset.tab,
    dCenter: +((ir.left + ir.width / 2) - (ar.left + ar.width / 2)).toFixed(2),
    dLeft: +(ir.left - ar.left).toFixed(2),
    barTransform: getComputedStyle(bar).transform,
    indTransform: ind.style.transform || '(none)',
  };
})()`;

const fail = [];
const results = {};

// 等滑块收敛：弹簧模拟时间每帧最多 32ms，页面首渲卡顿时墙钟要等更久；
// 连续两次采样 transform 一致即认为收敛（上限 2.5s）
async function waitSettle(maxMs = 2500) {
  let prev = null;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const cur = await ev(`document.getElementById('tabIndicator').style.transform || ''`);
    if (prev !== null && cur === prev && cur) return cur;
    prev = cur;
    await sleep(150);
  }
  return prev;
}

// ---- T1: 静息态逐 tab 点击落位对齐（回归：改动后基础量取不能错） ----
for (const tab of ["sessions", "jobs", "files", "settings"]) {
  await ev(`(document.querySelector('.tab[data-tab="${tab}"]')||{}).click?.(); 'ok'`);
  await waitSettle();
  const p = await ev(ALIGN_PROBE);
  results["click-" + tab] = p;
  if (!p || Math.abs(p.dCenter) > 1.5) fail.push(`T1[${tab}]: 点击落位中心偏差 ${p ? p.dCenter : "null"}px 超容差 1.5px`);
}

// ---- T2/T3: 从会话横向甩向右缘（带斜向分量）→ 应落设置且终态对齐 ----
const rect = await ev(`(() => { const r = document.getElementById('tabbar').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
const yMid = rect.y + Math.round(rect.h / 2);
const xStart = rect.x + 40, xEnd = rect.x + rect.w - 12;

async function flingRight(label, dy, steps = 14, stepMs = 16) {
  await ev(`(document.querySelector('.tab[data-tab="sessions"]')||{}).click?.(); 'ok'`);
  await waitSettle();
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: xStart, y: yMid + dy * 0.3, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 2);   // 加速甩出，松手瞬间有速度
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: xStart + (xEnd - xStart) * eased, y: yMid + dy * (0.3 + t * 0.7), id: 1 }] });
    await sleep(stepMs);
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await waitSettle();
  const p = await ev(ALIGN_PROBE);
  results[label] = p;
  if (!p || p.tab !== "settings") fail.push(`${label}: 未落到 settings（落在 ${p ? p.tab : "null"}）`);
  else if (Math.abs(p.dCenter) > 1.5) fail.push(`${label}: 甩动落位中心偏差 ${p.dCenter}px 超容差 1.5px（旧代码在 sx≠1 下偏 ~8-17px）`);
}

await flingRight("fling-diag-up", -36);    // 上斜甩：旧代码 scale 横收 → 偏左
await flingRight("fling-diag-down", 30);   // 下斜甩：反向形变
await flingRight("fling-straight", 0);     // 纯水平回归

// ---- T4: 纵向捏形变（axis 锁 y）→ 主方向一经判定不翻转，横向段必须被忽略 ----
// 断言：不换页（停在 sessions）+ 滑块归位（scale 回 1，rc.109 前残留 scale(1.03)）
await ev(`(document.querySelector('.tab[data-tab="sessions"]')||{}).click?.(); 'ok'`);
await waitSettle();
await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: xStart + 120, y: yMid, id: 1 }] });
for (let i = 1; i <= 10; i++) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: xStart + 120, y: yMid - i * 9, id: 1 }] }); await sleep(14); }
// 不松手直接转横向甩（轴已锁 y，必须忽略）
for (let i = 1; i <= 12; i++) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: xStart + 120 + (xEnd - xStart - 120) * (i / 12), y: yMid - 90 + i * 5, id: 1 }] }); await sleep(14); }
await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await waitSettle();
const p4 = await ev(ALIGN_PROBE);
results["pinch-then-fling"] = p4;
if (!p4 || p4.tab !== "sessions") fail.push(`T4: 纵向锁定失效——横向段被认了（落在 ${p4 ? p4.tab : "null"}）`);
else if (Math.abs(p4.dCenter) > 1.5) fail.push(`T4: 捏后滑块归位偏差 ${p4.dCenter}px 超容差 1.5px`);
else if (/scale\((?!1,\s*1)/.test(p4.indTransform)) fail.push(`T4: 滑块按下放大残留（${p4.indTransform}）——y 锁分支没有归位`);

const pass = fail.length === 0;
fs.writeFileSync(path.join(OUT, `report-${LABEL}.json`), JSON.stringify({ label: LABEL, time: new Date().toISOString(), results, pass, fail }, null, 2));
console.log(JSON.stringify(results, null, 1));
console.log(pass ? "\n=== ALL PASS ===" : "\n=== FAIL ===\n" + fail.map((f) => " - " + f).join("\n"));
process.exit(pass ? 0 : 1);
