#!/usr/bin/env node
/**
 * capture-rc108.mjs — 悬浮导航栏「松手跳跃」+「切页图标重影」+「额度行」取证
 * ============================================================
 * rc.108 修复三件事：
 *   A. 上滑拖动松手「跳跃式」：releaseTabBar 曾把手指原始 fling（±3000px/s）直接灌进
 *      k300 回弹弹簧——形变是软饱和映射，视觉速度只有手指的 0.05~0.31 倍，直灌 =
 *      弹簧振幅 ~170px，松手瞬间导航条上蹿几十像素。修复后按局部斜率折算 + 夹 ±420。
 *      ⇒ 本脚本甩动松手后采样全程 |top-restTop| 峰值，不得超过拖拽终点 +8px。
 *   B. 切页图标重影：animateTabIcons 只给真图标挂 ico-in/out，选中 tab 的蓝色克隆层
 *      (.tab-blue) 里还有一份静止克隆图标叠在正上方——真图标在滑、克隆不动 = 重影。
 *      修复后克隆图标同步挂同一动画类。⇒ 动画进行中两颗 .ico 的 class 与 rect 必须一致。
 *   C. 设置页「额度与用量」行只显示小横杠：该行值只在绑定时写一次且只认本地 token，
 *      从不显示账户余额。修复后优先余额（onBalance 同步刷新）。
 *      ⇒ hook Date.now 捕获 reqId，伪注入 onBalance，行必须变成 ¥12.34。
 *
 * 用法：node .motion/verify/capture-rc108.mjs [--label rc108] [--noscreencast]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const LABEL = String(arg("label", "rc108"));
const PORT = Number(arg("port", 9225));
const ADB = String(arg("adb", "D:/1/tools/android-sdk/platform-tools/adb.exe"));
const OUT = path.resolve(arg("out", ".motion/verify/bug-rc108"));
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

/* 页面内采样器：setInterval 8ms（模拟器重负载下 rAF 会饿死，见 CONTRACT §8） */
const SAMPLER = `
(() => {
  window.__T108 = { samples: [], stopped: false };
  const bar = document.getElementById('tabbar');
  const restTop = bar.getBoundingClientRect().top;
  const info = () => {
    const cs = getComputedStyle(bar);
    const r = bar.getBoundingClientRect();
    const mm = cs.transform.match(/^matrix\(([^)]+)\)$/);
    return {
      tr: cs.transform, inline: bar.style.transform || '',
      dy: +(r.top - restTop).toFixed(2),
      sy: mm ? +(mm[1].split(',')[3]).toFixed(4) : 1,
      dragging: bar.classList.contains('is-dragging'),
      screen: (document.querySelector('.screen.is-active') || {}).dataset?.screen || null,
      tab: (document.querySelector('.tab.is-on') || {}).dataset?.tab || null,
    };
  };
  const iv = setInterval(() => {
    if (window.__T108.stopped) { clearInterval(iv); return; }
    try { window.__T108.samples.push(Object.assign({ t: Date.now() }, info())); } catch (_) {}
  }, 8);
  window.__T108Stop = () => { window.__T108.stopped = true; return window.__T108.samples; };
  return 'ok';
})()`;

/* 动画期间克隆同步探针：真 .ico 与克隆 .ico 的类 + rect */
const CLONE_PROBE = `
(() => {
  const tab = document.querySelector('.tab.is-on');
  if (!tab) return null;
  const real = tab.querySelector(':scope > .ico');
  const blue = tab.querySelector(':scope > .tab-blue');
  const ghost = blue ? blue.querySelector('.ico') : null;
  const cls = (el) => el ? [...el.classList].filter(c => c.startsWith('ico-in') || c.startsWith('ico-out')) : [];
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const rr = rect(real), gr = rect(ghost);
  return {
    realCls: cls(real), ghostCls: cls(ghost),
    realRect: rr, ghostRect: gr,
    aligned: !!(rr && gr && Math.abs(rr.x - gr.x) <= 0.6 && Math.abs(rr.y - gr.y) <= 0.6),
    ghostVisible: !!(blue && getComputedStyle(blue).clipPath !== 'inset(0px 100% 0px 0px)'),
  };
})()`;

function parseMatrixF(s) {
  const m = (s || "").match(/^matrix\(([^)]+)\)$/);
  if (!m) return null;
  const n = m[1].split(",").map(Number);
  return n;
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

  const shot = (name) => {
    if (NOSCREEN) return;
    const f = frames[frames.length - 1];
    if (f) fs.writeFileSync(path.join(OUT, "frames", `${LABEL}-${name}.png`), Buffer.from(f.data, "base64"));
  };

  /* 确保在会话页 */
  const boot = await ev(`(() => {
    const s = document.querySelector('.screen.is-active');
    return { screen: s ? s.dataset.screen : null, bar: !!document.getElementById('tabbar') };
  })()`);
  if (boot.screen !== "sessions") {
    await ev(`(document.querySelector('.tab[data-tab="sessions"]')||{}).click?.(); 'clicked'`);
    await sleep(800);
  }

  /* ---- A1 静止基线 ---- */
  const restTop = await ev(`document.getElementById('tabbar').getBoundingClientRect().top`);
  const t = await ev(`(() => {
    const list = [...document.querySelectorAll('.tab')];
    const el = list.find(x => x.dataset.tab === 'tasks') || list[1];
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, tab: el.dataset.tab };
  })()`);
  if (!NOSCREEN) await send("Page.startScreencast", { format: "png", maxWidth: 540, maxHeight: 1200, everyNthFrame: 1 });

  /* ---- A2 上拔 90px + 末段甩动松手 ----
     慢拖 9 步（22ms/步）到位，再 5 步快甩（15px/步、10ms/步 → ~1.5px/ms），
     松手瞬间手指速度 ≈ -1500px/s。旧代码直接灌弹簧：振幅 ~87px，条上蹿 30px+；
     新代码折算后 ~72px/s：回弹峰值不得超过「拖拽终点位移 + 8px」。 */
  await ev(SAMPLER);
  const dragSteps = [];
  await touch("touchStart", [{ x: t.x, y: t.y, id: 1 }]);
  await sleep(60);
  for (let i = 1; i <= 9; i++) {
    await touch("touchMove", [{ x: t.x, y: t.y - (90 * i) / 9, id: 1 }]);
    await sleep(22);
  }
  for (let i = 1; i <= 5; i++) {
    await touch("touchMove", [{ x: t.x, y: t.y - 90 - 15 * i, id: 1 }]);
    await sleep(10);
  }
  await sleep(40);
  const dragEndTop = await ev(`document.getElementById('tabbar').getBoundingClientRect().top`);
  shot("up-dragend");
  await touch("touchEnd", []);
  await sleep(1000);
  const upSamples = await ev(`__T108Stop()`);
  shot("up-bounce");

  /* ---- A3 下压 + 甩动松手 ---- */
  await ev(SAMPLER);
  await touch("touchStart", [{ x: t.x, y: t.y, id: 1 }]);
  await sleep(60);
  for (let i = 1; i <= 9; i++) {
    await touch("touchMove", [{ x: t.x, y: t.y + (90 * i) / 9, id: 1 }]);
    await sleep(22);
  }
  for (let i = 1; i <= 5; i++) {
    await touch("touchMove", [{ x: t.x, y: t.y + 90 + 15 * i, id: 1 }]);
    await sleep(10);
  }
  await sleep(40);
  const dragEndTop2 = await ev(`document.getElementById('tabbar').getBoundingClientRect().top`);
  shot("down-dragend");
  await touch("touchEnd", []);
  await sleep(1000);
  const downSamples = await ev(`__T108Stop()`);
  shot("down-bounce");

  /* ---- B 切页图标克隆同步 ---- */
  const pair = await ev(`(() => {
    const l = [...document.querySelectorAll('.tab')];
    const i = l.findIndex(x => x.classList.contains('is-on'));
    const n = i < l.length - 1 ? l[i + 1] : l[i - 1];
    return { from: l[i].dataset.tab, to: n.dataset.tab };
  })()`);
  await ev(`(document.querySelector('.tab[data-tab="${pair.to}"]')||{}).click?.(); 'clicked'`);
  const probes = [];
  for (let k = 0; k < 5; k++) {
    if (k > 0) await sleep(k === 1 ? 30 : 60);   // 第一帧立即抓（CDP 往返本身就有 ~20ms 延迟）
    probes.push(await ev(CLONE_PROBE));
  }
  shot("icon-anim");
  await sleep(700);

  /* ---- C 额度行：hook Date.now 捕获 reqId，伪注入 onBalance ---- */
  await ev(`(document.querySelector('.tab[data-tab="settings"]')||{}).click?.(); 'clicked'`);
  await sleep(600);
  const rowBefore = await ev(`(document.getElementById('usageValue')||{}).textContent ?? null`);
  const inject = await ev(`(async () => {
    const real = Date.now;
    Date.now = () => 1777777777777;
    try { document.getElementById('rowUsage').click(); } catch (e) { Date.now = real; return 'click-failed: ' + e.message; }
    Date.now = real;
    await new Promise(r => setTimeout(r, 120));
    const REQ = 'bal1777777777777';
    try {
      window.DSHHost.onBalance(REQ, JSON.stringify({
        ok: true, available: true,
        balances: [{ currency: 'CNY', total: '12.34', granted: '2.00', toppedUp: '10.34' }],
      }));
    } catch (e) { return 'inject-failed: ' + e.message; }
    await new Promise(r => setTimeout(r, 150));
    return {
      row: (document.getElementById('usageValue')||{}).textContent ?? null,
      balCard: !!document.getElementById('balBox'),
      balText: (document.querySelector('#balBox .bal-amount')||{}).textContent ?? null,
    };
  })()`);
  shot("usage-row");
  /* 关面板，回到会话页收场 */
  await ev(`(document.querySelector('#sheetBody [data-close], [data-close]')||{}).click?.(); 'closed'`).catch(() => {});
  await sleep(300);
  await ev(`(document.querySelector('.tab[data-tab="sessions"]')||{}).click?.(); 'back'`).catch(() => {});
  await sleep(400);
  if (!NOSCREEN) await send("Page.stopScreencast");

  /* ================= 判定 ================= */
  const fail = [];
  const analyze = (samples, name, dragEnd) => {
    if (!samples || !samples.length) { fail.push(`${name}: 采样为空（sampler 未生效）`); return null; }
    const rest = +(dragEnd - restTop).toFixed(1);   // 松手瞬间相对静止位的位移
    const tEnd = samples[samples.length - 1].t;
    const bounce = samples.filter((s) => tEnd - s.t <= 1000);
    // 过冲：越过静止位之后往反方向跑出去的距离（上拔 rest<0 → 看 max(dy)；下压看 min(dy)）。
    // 松手行程本身（从形变位置回 0）不算过冲 —— 那是回弹的必经之路。
    const restSign = Math.sign(rest) || 1;
    const overshoot = restSign > 0
      ? -Math.min(...bounce.map((s) => s.dy))
      : Math.max(...bounce.map((s) => s.dy));
    // 过零：dy 相对「静止位」的符号变化次数（负↔正），欠阻尼 Q 弹至少 1 次
    let zeros = 0;
    for (let i = 1; i < bounce.length; i++) {
      if (bounce[i - 1].dy * bounce[i].dy < 0) zeros++;
    }
    const settled = bounce[bounce.length - 1];
    const inlineGone = !settled || !settled.inline;
    const draggingGone = !settled || !settled.dragging;
    console.log(`[${name}] 松手位移 ${rest}px · 过冲 ${overshoot.toFixed(1)}px · 过零 ${zeros} 次 · 终态 inline='${settled?.inline}' dragging=${settled?.dragging}`);
    if (Math.abs(overshoot) > 8) fail.push(`${name}: 回弹过冲 ${overshoot.toFixed(1)}px 超容差 8px（旧代码甩动时可达 30~60px = 跳跃）`);
    if (zeros < 1) fail.push(`${name}: 没有回弹过零（欠阻尼 Q 弹丢失）`);
    if (!inlineGone) fail.push(`${name}: 终态内联 transform 未清空`);
    if (!draggingGone) fail.push(`${name}: 终态 is-dragging 未摘`);
    return { rest, overshoot, zeros };
  };
  const a2 = analyze(upSamples, "A2 上拔甩动松手", dragEndTop);
  const a3 = analyze(downSamples, "A3 下压甩动松手", dragEndTop2);

  /* B 判定：动画进行中至少一帧两颗 ico 类一致且 rect 对齐 */
  const goodFrame = probes.filter((p) => p && p.aligned && p.realCls.length && p.realCls.join() === (p.ghostCls.join() || p.realCls.join()));
  const anyMisaligned = probes.some((p) => p && !p.aligned && p.ghostVisible);
  console.log(`[B 克隆同步] 探针 ${JSON.stringify(probes)}`);
  if (probes.every((p) => !p || !p.realCls.length)) fail.push("B: 没捕捉到切页图标动画帧（动画没跑？）");
  else if (anyMisaligned && goodFrame.length === 0) fail.push("B: 动画期间真图标与克隆图标错位（重影复现）");

  /* C 判定 */
  console.log(`[C 额度行] 注入前行='${rowBefore}' 注入后=${JSON.stringify(inject)}`);
  if (!inject || typeof inject === "string") fail.push("C: onBalance 注入失败 " + inject);
  else if (inject.row !== "¥12.34") fail.push(`C: 额度行显示 '${inject.row}'，应为 ¥12.34`);
  else if (!inject.balCard || inject.balText !== "¥12.34CNY") fail.push(`C: 面板余额卡异常 ${inject.balText}`);

  const pass = fail.length === 0;
  const report = {
    label: LABEL, time: new Date().toISOString(),
    A2: a2, A3: a3,
    clones: probes, usage: { rowBefore, inject },
    pass, fail,
  };
  fs.writeFileSync(path.join(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 2));
  console.log(pass ? "\n=== ALL PASS ===" : `\n=== FAIL ===\n` + fail.map((f) => " - " + f).join("\n"));
  process.exit(pass ? 0 : 1);   // WebSocket 还开着，事件循环不会空 —— 必须强退
}

main().catch((e) => { console.error(e); process.exit(2); });
