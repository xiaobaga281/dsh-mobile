#!/usr/bin/env node
/**
 * capture-tabdeform.mjs — 悬浮导航栏「纵向拖拽形变」取证
 * ============================================================
 * rc.107 之前 Motion.drag 锁成 axis:"x"，纵向 dy 被硬写成 0，
 * 所以导航条只能横向拖出滑块、完全不能被竖向拽动。本脚本验证放开后的行为。
 *
 * 六个用例：
 *   T1 居中完整性   静止时 bar 水平居中（之前靠 translateX(-50%)，现在靠布局，必须不偏）
 *   T2 上拔         向上拖 90px：scaleY>1（拔长）且 scaleX<1（收窄），y<0
 *   T3 下压         向下拖 90px：scaleY<1（压扁）且 scaleX>1（鼓出），y>0
 *   T4 不换页       纵向拖全程 is-on / 当前 screen 不变；
 *   T5 Q 弹回位     松手后 y 越过 0 反向一次（press ζ≈0.83 欠阻尼），最终归零
 *   T6 横向仍可用   横向拖到另一 tab，screen 真的切过去
 *   T7 收干净       结束后 bar 无内联 transform（否则 .is-hidden 的位移会被内联盖住）
 *
 * 用法：
 *   node .motion/verify/capture-tabdeform.mjs [--label rc107] [--noscreencast]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const LABEL = String(arg("label", "rc107"));
const PORT = Number(arg("port", 9223));
const ADB = String(arg("adb", "D:/1/tools/android-sdk/platform-tools/adb.exe"));
const OUT = path.resolve(arg("out", ".motion/verify/bug-tabdeform"));
const NOSCREEN = process.argv.includes("--noscreencast");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });

/* ---------------- CDP ---------------- */
async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2500) });
  return await r.json();
}
const adb = (a) => execFileSync(ADB, a, { encoding: "utf8", timeout: 25000 });
async function ensureForward() {
  try { const l = await listTargets(); if (l?.length) return l; } catch (_) {}
  for (let i = 0; i < 3; i++) {
    try {
      adb(["start-server"]);
      let serial = "emulator-5554";
      const devs = adb(["devices"]).split(/\r?\n/).filter((x) => /\tdevice$/.test(x.trim()));
      if (devs.length) serial = devs[0].split("\t")[0].trim();
      adb(["-s", serial, "wait-for-device"]);
      const sock = adb(["-s", serial, "shell", "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1"]).trim();
      if (sock) {
        try { adb(["-s", serial, "forward", "--remove", `tcp:${PORT}`]); } catch (_) {}
        adb(["-s", serial, "forward", `tcp:${PORT}`, `localabstract:${sock}`]);
      }
    } catch (_) {}
    await sleep(600);
    try { const l = await listTargets(); if (l?.length) return l; } catch (_) {}
  }
  throw new Error("CDP 不可达");
}

let ws, id = 0;
const pend = new Map();
const frames = [];
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 30000);
    pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
async function ev(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
const touch = (type, pts) => send("Input.dispatchTouchEvent", { type, touchPoints: pts });

/* 页面内采样器：不依赖 rAF（模拟器重负载下 rAF 会被饿到 200ms+/帧），用 setInterval 8ms */
const SAMPLER = `
(() => {
  window.__TD = { samples: [], stopped: false };
  const bar = document.getElementById('tabbar');
  const info = () => {
    const cs = getComputedStyle(bar);
    const r = bar.getBoundingClientRect();
    return {
      tr: cs.transform,
      inline: bar.style.transform || '',
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      screen: (document.querySelector('.screen.is-active') || {}).dataset?.screen || null,
      tab: (document.querySelector('.tab.is-on') || {}).dataset?.tab || null,
    };
  };
  const iv = setInterval(() => {
    if (window.__TD.stopped) { clearInterval(iv); return; }
    try { window.__TD.samples.push(Object.assign({ t: Date.now() }, info())); } catch (_) {}
  }, 8);
  window.__TDStop = () => { window.__TD.stopped = true; return window.__TD.samples; };
  return 'ok';
})()`;

function parseMatrix(s) {
  if (!s || s === "none") return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const m = s.match(/^matrix\(([^)]+)\)$/);
  if (!m) return null;
  const n = m[1].split(",").map(Number);
  return { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
}

async function main() {
  const targets = await ensureForward();
  const page = targets.find((p) => p.type === "page") || targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Page.screencastFrame") {
      frames.push({ data: m.params.data, t: Date.now() });
      try { send("Page.screencastFrameAck", { sessionId: m.params.sessionId }); } catch (_) {}
    }
  });
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  await send("Runtime.enable");
  await send("Page.enable");

  /* 确保在会话页（导航栏可见） */
  const boot = await ev(`(() => {
    const s = document.querySelector('.screen.is-active');
    return { screen: s ? s.dataset.screen : null, bar: !!document.getElementById('tabbar') };
  })()`);
  if (boot.screen !== "sessions") {
    await ev(`(document.querySelector('.tab[data-tab="sessions"]')||{}).click?.(); 'clicked'`);
    await sleep(700);
  }

  await ev(SAMPLER);

  /* ---- T1 居中完整性 ---- */
  const rest = await ev(`(() => {
    const b = document.getElementById('tabbar').getBoundingClientRect();
    const vw = innerWidth;
    return { left: +b.left.toFixed(1), right: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
             top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), vw,
             centerOffset: +(((b.left + b.right) / 2) - vw / 2).toFixed(1) };
  })()`);

  /* 抓中间那个 tab（左右都有邻居，两个方向都能拖到） */
  const t = await ev(`(() => {
    const list = [...document.querySelectorAll('.tab')];
    const el = list.find(t => t.dataset.tab === 'tasks') || list[1];
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, tab: el.dataset.tab };
  })()`);

  const T0 = Date.now();
  if (!NOSCREEN) await send("Page.startScreencast", { format: "png", maxWidth: 540, maxHeight: 1200, everyNthFrame: 1 });

  /* ---- T2 上拔 ---- */
  await touch("touchStart", [{ x: t.x, y: t.y, id: 1 }]);
  await sleep(60);
  for (let i = 1; i <= 9; i++) {
    await touch("touchMove", [{ x: t.x, y: t.y - (90 * i) / 9, id: 1 }]);
    await sleep(22);
  }
  await sleep(260);
  const up = await ev(`(() => {
    const m = getComputedStyle(document.getElementById('tabbar')).transform;
    const b = document.getElementById('tabbar').getBoundingClientRect();
    const s = document.querySelector('.screen.is-active');
    return { tr: m, h: +b.height.toFixed(1), w: +b.width.toFixed(1), y: +b.y.toFixed(1),
             screen: s ? s.dataset.screen : null,
             tab: (document.querySelector('.tab.is-on')||{}).dataset?.tab || null };
  })()`);
  if (!NOSCREEN) {
    const f = frames[frames.length - 1];
    if (f) fs.writeFileSync(path.join(OUT, "frames", `${LABEL}-pullup.png`), Buffer.from(f.data, "base64"));
  }

  /* ---- T3 下压：回到起点再往下 ---- */
  for (let i = 9; i >= 0; i--) { await touch("touchMove", [{ x: t.x, y: t.y - (90 * i) / 9, id: 1 }]); await sleep(16); }
  await sleep(60);
  for (let i = 1; i <= 9; i++) { await touch("touchMove", [{ x: t.x, y: t.y + (90 * i) / 9, id: 1 }]); await sleep(22); }
  await sleep(260);
  const down = await ev(`(() => {
    const m = getComputedStyle(document.getElementById('tabbar')).transform;
    const b = document.getElementById('tabbar').getBoundingClientRect();
    const s = document.querySelector('.screen.is-active');
    return { tr: m, h: +b.height.toFixed(1), w: +b.width.toFixed(1), y: +b.y.toFixed(1),
             screen: s ? s.dataset.screen : null,
             tab: (document.querySelector('.tab.is-on')||{}).dataset?.tab || null };
  })()`);
  if (!NOSCREEN) {
    const f = frames[frames.length - 1];
    if (f) fs.writeFileSync(path.join(OUT, "frames", `${LABEL}-pressdown.png`), Buffer.from(f.data, "base64"));
  }

  /* ---- T5 松手 Q 弹：继续采样回放 ---- */
  await touch("touchEnd", []);
  // 时间基准必须取页面时钟：模拟器与宿主机的系统时间有偏差，拿两套时钟相减会错位
  const tEnd = await ev(`Date.now()`);
  await sleep(150);
  if (!NOSCREEN) {
    const f = frames[frames.length - 1];
    if (f) fs.writeFileSync(path.join(OUT, "frames", `${LABEL}-bounce.png`), Buffer.from(f.data, "base64"));
  }
  await sleep(900);
  await send("Page.stopScreencast");
  const samples = await ev(`__TDStop()`);

  /* ---- T7 收干净 ---- */
  const after = await ev(`(() => {
    const bar = document.getElementById('tabbar');
    const b = bar.getBoundingClientRect();
    return { inline: bar.style.transform || '', tr: getComputedStyle(bar).transform,
             dragging: bar.classList.contains('is-dragging'),
             left: +b.left.toFixed(1), right: +b.right.toFixed(1), h: +b.height.toFixed(1), top: +b.top.toFixed(1) };
  })()`);

  /* ---- T6 横向仍可用 ----
     注意：滑块的起点始终是「当前选中项」，与手指按在哪个 tab 无关（既有设计），
     所以这里必须从 is-on 那一项拖向它的邻居，而不是从被按的那一项拖。 */
  await ev(SAMPLER);
  const pair = await ev(`(() => {
    const l = [...document.querySelectorAll('.tab')];
    const i = l.findIndex(t => t.classList.contains('is-on'));
    const n = i < l.length - 1 ? l[i + 1] : l[i - 1];
    const ra = l[i].getBoundingClientRect(), rn = n.getBoundingClientRect();
    return { from: { tab: l[i].dataset.tab, x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 },
             to:   { tab: n.dataset.tab,   x: rn.left + rn.width / 2, y: rn.top + rn.height / 2 } };
  })()`);
  const steps = 10;
  const hSteps = [];
  await touch("touchStart", [{ x: pair.from.x, y: pair.from.y, id: 1 }]);
  await sleep(60);
  for (let i = 1; i <= steps; i++) {
    await touch("touchMove", [{ x: pair.from.x + ((pair.to.x - pair.from.x) * i) / steps, y: pair.from.y, id: 1 }]);
    await sleep(22);
    if (i % 3 === 0) {
      const st = await ev(`(() => { const ind=document.getElementById('tabIndicator'); const br=document.getElementById('tabbar').getBoundingClientRect(); const ir=ind.getBoundingClientRect(); return { x:+(ir.left-br.left).toFixed(1), w:+ir.width.toFixed(1) }; })()`);
      hSteps.push({ i, ...st });
    }
  }
  // 落位前先读一次几何：中控台支线抽屉ἐν troubleshooting（手指位置 / 滑块 / 各 tab 中心）
  const diag = await ev(`(() => {
    const bar = document.getElementById('tabbar'); const br = bar.getBoundingClientRect();
    const ind = document.getElementById('tabIndicator'); const ir = ind.getBoundingClientRect();
    return { indX: +(ir.left - br.left).toFixed(1), indW: +ir.width.toFixed(1),
      tabs: [...document.querySelectorAll('.tab')].map(t => { const r = t.getBoundingClientRect();
        return { tab: t.dataset.tab, left: +(r.left - br.left).toFixed(1), mid: +(r.left - br.left + r.width / 2).toFixed(1) }; }) };
  })()`);
  await touch("touchEnd", []);
  await sleep(900);
  const horiz = await ev(`(() => {
    const s = document.querySelector('.screen.is-active');
    return { screen: s ? s.dataset.screen : null, tab: (document.querySelector('.tab.is-on')||{}).dataset?.tab || null };
  })()`);
  await ev(`__TDStop()`);

  /* ---------------- 判定 ---------------- */
  const rel = (s) => ({ t: s.t - T0, m: parseMatrix(s.tr), h: s.h, y: s.y, inline: s.inline });
  const upM = parseMatrix(up.tr);
  const downM = parseMatrix(down.tr);

  // 回弹轨迹：从松手那一刻之后取样，统计 translateY(f) 是否越过 0 反向（欠阻尼回弹的特征）
  const tail = samples.map(rel).filter((s) => s.m && s.t > tEnd - T0);
  const ys = tail.map((s) => s.m.f);
  let overshoot = 0, crossings = 0;
  for (let i = 1; i < ys.length; i++) {
    if (ys[i - 1] !== 0 && ys[i] !== 0 && Math.sign(ys[i]) !== Math.sign(ys[i - 1])) crossings++;
  }
  overshoot = ys.length ? Math.max(...ys.map(Math.abs)) : 0;

  const T = {
    T1_center: {
      centerOffset: rest.centerOffset,
      pass: Math.abs(rest.centerOffset) < 1.5,
      detail: `静止时 bar 中心偏离视口中心 ${rest.centerOffset}px`,
    },
    T2_pullUp: {
      sy: upM ? +upM.d.toFixed(4) : null, sx: upM ? +upM.a.toFixed(4) : null, ty: upM ? +upM.f.toFixed(2) : null,
      height: up.h,
      pass: !!upM && upM.d > 1.02 && upM.a < 0.99 && upM.f < -2,
      detail: `上拔 90px → 纵向拉伸 ${upM ? upM.d.toFixed(3) : "?"}×、横向收窄 ${upM ? upM.a.toFixed(3) : "?"}×、跟手上移 ${upM ? upM.f.toFixed(1) : "?"}px`,
    },
    T3_pressDown: {
      sy: downM ? +downM.d.toFixed(4) : null, sx: downM ? +downM.a.toFixed(4) : null, ty: downM ? +downM.f.toFixed(2) : null,
      height: down.h,
      pass: !!downM && downM.d < 0.99 && downM.a > 1.005 && downM.f > 2,
      detail: `下压 90px → 纵向压扁 ${downM ? downM.d.toFixed(3) : "?"}×、横向鼓出 ${downM ? downM.a.toFixed(3) : "?"}×、跟手下移 ${downM ? downM.f.toFixed(1) : "?"}px`,
    },
    T4_noPageChange: {
      before: rest.screen ?? boot.screen, duringUp: up.screen, duringDown: down.screen,
      tabUp: up.tab, tabDown: down.tab,
      pass: up.tab === down.tab && down.tab === (rest.screen ? boot.screen : up.tab),
      detail: `纵向拖拽全程未换页：duringUp=${up.screen}/${up.tab}, duringDown=${down.screen}/${down.tab}`,
    },
    T5_bounce: {
      samples: tail.length, maxAbs: +overshoot.toFixed(2), zeroCrossings: crossings,
      pass: tail.length > 3 && crossings >= 1 && Math.abs(ys[ys.length - 1] || 0) < 1.5,
      detail: `松手回弹过零 ${crossings} 次，峰值 ${overshoot.toFixed(1)}px，终值 ${(ys[ys.length - 1] ?? 0).toFixed(2)}px`,
    },
    T6_horizontal: {
      from: pair.from.tab, target: pair.to.tab, screen: horiz.screen, tab: horiz.tab, steps: hSteps,
      pass: horiz.tab === pair.to.tab,
      detail: `横向 ${pair.from.tab} → ${pair.to.tab}：结果 ${horiz.screen}/${horiz.tab}`,
    },
    T7_clean: {
      inline: after.inline, dragging: after.dragging, h: after.h, top: after.top,
      centerOffset: +(((after.left + after.right) / 2) - rest.vw / 2).toFixed(1),
      pass: !after.inline && !after.dragging && Math.abs(after.h - rest.h) < 1.5 && Math.abs(after.top - rest.top) < 1.5,
      detail: `内联 transform=${JSON.stringify(after.inline)} is-dragging=${after.dragging}，几何回到静止值（h ${after.h} vs ${rest.h}）`,
    },
  };
  const failed = Object.entries(T).filter(([, v]) => !v.pass).map(([k]) => k);

  const report = { label: LABEL, rest, target: t, cases: T, failed, ok: failed.length === 0, tail: tail.map((s) => ({ t: s.t, f: +s.m.f.toFixed(2), sy: +s.m.d.toFixed(4) })) };
  fs.writeFileSync(path.join(OUT, `tabdeform-${LABEL}.json`), JSON.stringify(report, null, 2));
  for (const [k, v] of Object.entries(T)) console.log(`${v.pass ? "PASS" : "FAIL"} ${k}: ${v.detail}`);
  console.log(failed.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS");
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
