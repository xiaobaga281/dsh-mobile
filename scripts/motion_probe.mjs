#!/usr/bin/env node
/**
 * motion_probe.mjs — DSH Mobile WebView 动效测量探针（可反复运行）
 * ================================================================
 * 通过 Chrome DevTools Protocol（默认 127.0.0.1:9223，指向 Android WebView）
 * 用**可信**触摸事件（Input.dispatchTouchEvent）驱动真实手势，逐帧采样
 * getComputedStyle，输出可对比的动效指标。
 *
 * 测量项
 *   press        按压响应延迟（按下 → 首个视觉变化）
 *   tabIndicator Tab 指示器收敛时间 / 过冲（位移 & 宽度分别算）
 *   sheetOpen    底部面板打开收敛时间 / 过冲 / 背景遮罩淡入
 *   swipeRelease 会话行左滑松手后的落位时间、最终位移、是否吸附展开
 *   dragTracking 拖动跟手保真度（元素位移 vs 手指位移的偏差）
 *   frames       rAF 帧间隔统计（长任务 / 掉帧 / p95）
 *
 * 用法
 *   node scripts/motion_probe.mjs --label baseline
 *   node scripts/motion_probe.mjs --label after --reps 5
 *   node scripts/motion_probe.mjs --help
 *
 * 输出
 *   .motion/verify/probe-<label>.json   （--out 可改目录）
 *   并在 stdout 打印摘要。
 *
 * 依赖
 *   - Node >= 20（内置 fetch / WebSocket）
 *   - adb（--adb 指定，默认 D:/1/tools/android-sdk/platform-tools/adb.exe）
 *   - 目标 WebView 已加载 App 页面
 *   - adb forward 断了自己重建（这个环境 adb daemon 经常被回收）
 *
 * 不会修改 App 内任何 Web 资源；只在页面里临时挂测量用的全局 __MP。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
function argv(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function flag(name) {
  return process.argv.includes("--" + name);
}

if (flag("help")) {
  console.log(`motion_probe.mjs — 动效测量探针

  --label <name>   结果标签，输出 .motion/verify/probe-<label>.json（默认 baseline）
  --out <dir>      输出目录（默认 .motion/verify，相对项目根）
  --port <n>       CDP 端口（默认 9223）
  --reps <n>       按压延迟重复次数（默认 5）
  --adb <path>     adb 可执行文件
  --sheet-row <sel> 底部面板的入口行（默认 #rowModels；可换 #rowContext）
  --json-only      只写文件，不打印逐项细节
`);
  process.exit(0);
}

const LABEL = String(argv("label", "baseline"));
const PORT = Number(argv("port", 9223));
const OUT_DIR = path.resolve(String(argv("out", ".motion/verify")));
const REPS = Math.max(1, Number(argv("reps", 5)) || 5);
const ADB = String(argv("adb", "D:/1/tools/android-sdk/platform-tools/adb.exe"));
const QUIET = flag("json-only");
// 面板测量的入口行。设置页「默认模型」和「上下文窗口」都会开底部面板；
// 换一个入口只是为了让不同轮次能互相校验。
const SHEET_ROW = String(argv("sheet-row", "#rowModels"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* CDP 连接（含 adb forward 自愈）                                      */
/* ------------------------------------------------------------------ */
async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
    signal: AbortSignal.timeout(2500),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

function adb(args, opts = {}) {
  return execFileSync(ADB, args, { encoding: "utf8", timeout: 25000, ...opts });
}

/** 这个环境里 adb 守护进程会被回收、forward 随之丢失，所以连不上就重建一次。 */
async function ensureForward() {
  try {
    const l = await listTargets();
    if (Array.isArray(l) && l.length) return l;
  } catch (_) {}

  const pids = ["emulator-5554"];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      adb(["start-server"], { stdio: "ignore" });
      let serial = pids[0];
      try {
        const devs = adb(["devices"]).split(/\r?\n/).filter((l) => /\tdevice$/.test(l.trim()));
        if (devs.length) serial = devs[0].split("\t")[0].trim();
      } catch (_) {}
      adb(["-s", serial, "wait-for-device"], { stdio: "ignore" });
      const sock = adb([
        "-s", serial, "shell",
        "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1",
      ]).trim();
      if (sock) {
        try { adb(["-s", serial, "forward", "--remove", `tcp:${PORT}`], { stdio: "ignore" }); } catch (_) {}
        adb(["-s", serial, "forward", `tcp:${PORT}`, `localabstract:${sock}`], { stdio: "ignore" });
      }
    } catch (_) { /* 下一轮再试 */ }
    await sleep(700);
    try {
      const l = await listTargets();
      if (Array.isArray(l) && l.length) return l;
    } catch (_) {}
  }
  throw new Error(
    `CDP 127.0.0.1:${PORT} 不可达，且重建 adb forward 失败。` +
    `请确认：模拟器在跑、App 在前台、.test/adbw.sh 能拿到 webview_devtools_remote socket。`
  );
}

let ws, msgId = 0, pending = new Map();

async function connect() {
  const targets = await ensureForward();
  const page = targets.find((p) => p.type === "page") || targets[0];
  if (!page) throw new Error("没有可用的 page target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  await send("Runtime.enable");
  return page;
}

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`CDP 超时: ${method}`));
    }, 30000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) rej(new Error(`${method}: ${m.error.message}`));
      else res(m.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function ev(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error("页面异常: " + String(d).split("\n")[0]);
  }
  return r.result?.value;
}

/* ------------------------------------------------------------------ */
/* 页面内测量库（只注入一次）                                           */
/* ------------------------------------------------------------------ */
const PAGE_LIB = `
(() => {
  // 上一轮的实例还在（页面不重载时 __MP 会保留）：先让它停表，再装新版本，
  // 否则旧 rAF 循环会一直空转，而且新方法不会被补上。
  if (window.__MP && window.__MP._stop) { try { window.__MP._stop(); } catch (_) {} }
  // 不提前 return：旧实例已被停表，必须装一个新的，否则 __MP 会是个死对象
  var MP = window.__MP = {
    version: "1.1",
    downT: 0, upT: 0, downX: 0, downY: 0, clickT: 0, moves: [], phases: [],
    raf: [], long: [], lastRaf: 0, obs: null
  };
  var CAP = 40000;

  window.addEventListener("pointerdown", function (e) {
    if (!MP.downT) { MP.downT = performance.now(); MP.downX = e.clientX; MP.downY = e.clientY; }
    MP.moves = [];
  }, true);
  window.addEventListener("pointermove", function (e) {
    if (MP.moves && MP.moves.length < 600) MP.moves.push({ t: performance.now(), x: e.clientX, y: e.clientY });
  }, true);
  window.addEventListener("pointerup", function () { MP.upT = performance.now(); }, true);
  // WebView 会把 touch「合成」成 click，这一步有 100~350ms 的延迟。
  // 单独记下来，才能把「input→首帧」拆成「input→click」+「click→首帧」。
  window.addEventListener("click", function () { if (!MP.clickT) MP.clickT = performance.now(); }, true);

  var tick = function (ts) {
    if (MP._dead) return;
    if (MP.lastRaf && MP.raf.length < CAP) MP.raf.push({ t: ts, d: ts - MP.lastRaf });
    MP.lastRaf = ts;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  try {
    MP.obs = new PerformanceObserver(function (list) {
      var es = list.getEntries();
      for (var i = 0; i < es.length; i++) {
        if (MP.long.length < 2000) MP.long.push({ t: es[i].startTime, d: es[i].duration });
      }
    });
    MP.obs.observe({ entryTypes: ["longtask"] });
  } catch (err) {}

  MP.parse = function (el) {
    if (!el) return null;
    var cs = getComputedStyle(el);
    var t = cs.transform;
    var x = 0, y = 0, sx = 1, sy = 1;
    if (t && t !== "none") {
      try {
        var m = new DOMMatrixReadOnly(t);
        x = m.m41; y = m.m42;
        sx = Math.hypot(m.m11, m.m12) || 1;
        sy = Math.hypot(m.m21, m.m22) || 1;
      } catch (err) {}
    }
    return {
      x: x, y: y, sx: sx, sy: sy,
      o: parseFloat(cs.opacity),
      w: parseFloat(cs.width),
      h: parseFloat(cs.height),
      bg: cs.backgroundColor,
      bgi: cs.backgroundImage,
      filt: cs.filter
    };
  };

  MP.reset = function () {
    MP.downT = 0; MP.upT = 0; MP.downX = 0; MP.downY = 0; MP.clickT = 0; MP.moves = [];
  };

  MP.sample = function (sels, dur, watchMut) {
    var els = [];
    for (var i = 0; i < sels.length; i++) els.push(document.querySelector(sels[i]));
    var out = [];
    var firstMut = 0;
    var mo = null;
    if (watchMut) {
      mo = new MutationObserver(function () { if (!firstMut) firstMut = performance.now(); });
      for (var k = 0; k < els.length; k++) {
        if (els[k]) mo.observe(els[k], { attributes: true, attributeFilter: ["style", "class"] });
      }
    }
    var t0 = performance.now();
    return new Promise(function (res) {
      var step = function (ts) {
        var row = { t: ts, v: [] };
        for (var j = 0; j < els.length; j++) row.v.push(MP.parse(els[j]));
        out.push(row);
        if (ts - t0 < dur) {
          requestAnimationFrame(step);
        } else {
          if (mo) mo.disconnect();
          res({
            series: out, t0: t0,
            mutT: firstMut, downT: MP.downT, upT: MP.upT, clickT: MP.clickT,
            downX: MP.downX, downY: MP.downY,
            moves: MP.moves ? MP.moves.slice() : []
          });
        }
      };
      requestAnimationFrame(step);
    });
  };

  MP.phase = function (name) { MP.phases.push({ name: name, t: performance.now() }); return MP.phases.length; };
  MP._stop = function () { MP._dead = true; try { if (MP.obs) MP.obs.disconnect(); } catch (_) {} };
  MP.mark = function () { return MP.raf.length; };
  MP.rafAll = function () { return MP.raf; };
  MP.longAll = function () { return MP.long; };
  MP.phasesAll = function () { return MP.phases; };
  return "ok";
})()
`;

/* ------------------------------------------------------------------ */
/* 输入：优先可信触摸，不可用则退化为 JS PointerEvent（并标注）           */
/* ------------------------------------------------------------------ */
const input = { trusted: null, method: null, warnings: [] };

async function touchStart(x, y) {
  await send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1, radiusX: 3, radiusY: 3, force: 1 }],
  });
}
async function touchMove(x, y) {
  await send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x, y, id: 1, radiusX: 3, radiusY: 3, force: 1 }],
  });
}
async function touchEnd() {
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
/** 取消手势：不产生 click，避免按压测量把页面导航走 */
async function touchCancel() {
  await send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
}

/** 可信点击：中心点 touchStart + touchEnd */
async function tap(x, y) {
  if (input.trusted === false) throw new Error("trusted input unavailable");
  await touchStart(x, y);
  await sleep(40);
  await touchEnd();
  await sleep(60);
}

/** 退化点击（非可信）：元素 .click() */
async function tapFallback(sel) {
  return ev(
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return "NOTFOUND"; e.click(); return "ok"; })()`
  );
}

/** 该坐标下最上层的元素是否命中目标（防「动画/滚动中途点错行」） */
async function hitTest(sel, x, y) {
  return ev(`(() => {
    const target = document.querySelector(${JSON.stringify(sel)});
    if (!target) return false;
    const hit = document.elementFromPoint(${x}, ${y});
    return !!(hit && (hit === target || target.contains(hit)));
  })()`);
}

/**
 * 定位一个可点的点：滚动到可见 → 等布局稳定 → 读中心 → elementFromPoint 校验。
 * 返回 {x,y} 或 null。供「先起采样再点击」的测量项使用。
 */
async function locate(sel, opts = {}) {
  const tries = opts.tries || 4;
  for (let i = 0; i < tries; i++) {
    const r = await rectOf(sel, { scroll: opts.scroll !== false });
    if (!r) { await sleep(250); continue; }
    await sleep(opts.settle ?? 320);
    const r2 = (await rectOf(sel)) || r;
    if (await hitTest(sel, r2.x, r2.y)) return { ...r2, attempts: i + 1 };
    await sleep(220);
  }
  return null;
}

/**
 * 可靠点击：定位 + 校验后点击。
 * 校验失败时退回 JS .click()（仍然作用于目标元素，只是不走几何命中）。
 */
async function tapElement(sel, opts = {}) {
  const pt = await locate(sel, opts);
  if (pt) {
    if (input.trusted !== false) await tap(pt.x, pt.y);
    else await tapFallback(sel);
    return { ...pt, verified: true };
  }
  input.warnings.push(`tapElement 几何校验失败，退回 .click(): ${sel}`);
  await tapFallback(sel);
  return { verified: false };
}

/** 探测可信触摸是否可用：在 body 上做一次 1px 的按下/抬起，看是否收到 pointerdown。 */
async function probeInput() {
  try {
    await ev(`(() => { window.__mpTrust = 0; document.body.addEventListener("pointerdown", function () { window.__mpTrust++; }, { once: true, capture: true }); return 1; })()`);
    await touchStart(6, 6);
    await touchEnd();
    await sleep(120);
    const n = await ev(`window.__mpTrust || 0`);
    if (n > 0) {
      input.trusted = true;
      input.method = "Input.dispatchTouchEvent";
      return;
    }
  } catch (e) {
    input.warnings.push("Input.dispatchTouchEvent 不可用: " + e.message);
  }
  input.trusted = false;
  input.method = "element.dispatchEvent(new PointerEvent(...)) 非可信事件";
  input.warnings.push("可信触摸事件不可用，已退化为 JS 侧 PointerEvent（非可信，非可信事件不符合浏览器手势语义，部分指标仅供参考）");
}

/* ------------------------------------------------------------------ */
/* DOM 辅助                                                             */
/* ------------------------------------------------------------------ */
async function rectOf(sel, opts = {}) {
  const res = await ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    ${opts.scroll ? 'e.scrollIntoView({ block: "center" });' : ""}
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left };
  })()`);
  return res;
}

async function closeOverlays() {
  await ev(`(() => {
    try { document.getElementById("sheet").classList.remove("is-on"); } catch (e) {}
    try { document.getElementById("sheetBackdrop").classList.remove("is-on"); } catch (e) {}
    try { const p = document.querySelector(".popover"); if (p) p.remove(); } catch (e) {}
    try { document.querySelectorAll("#sessionsScroll .sess-row.is-swiped").forEach(r => r.classList.remove("is-swiped")); } catch (e) {}
    try { document.querySelectorAll(".session-item").forEach(i => { i.style.transform = ""; }); } catch (e) {}
    return 1;
  })()`);
}

async function activeScreen() {
  return ev(`(() => { const a = document.querySelector(".screen.is-active"); return a ? a.dataset.screen : null; })()`);
}

async function goTab(tab) {
  await closeOverlays();
  let cur = await activeScreen();
  if (cur === "chat") {
    const b = await rectOf("#btnBack");
    if (b && input.trusted !== false) await tap(b.x, b.y);
    else await tapFallback("#btnBack");
    await sleep(650);
    cur = await activeScreen();
  }
  if (cur === tab) return;
  const r = await rectOf(`.tab[data-tab="${tab}"]`);
  if (!r) throw new Error("找不到 tab: " + tab);
  if (input.trusted !== false) await tap(r.x, r.y);
  else await tapFallback(`.tab[data-tab="${tab}"]`);
  await sleep(700);
}

/* ------------------------------------------------------------------ */
/* 分析                                                                 */
/* ------------------------------------------------------------------ */
/** null 安全的四舍五入（pct 在空数组时返回 null） */
function round1(v) {
  return v == null ? null : +Number(v).toFixed(1);
}

function pct(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
}

function seriesOf(res, idx, key) {
  return res.series.map((s) => ({
    t: s.t,
    v: s.v[idx] && typeof s.v[idx][key] === "number" ? s.v[idx][key] : null,
  })).filter((p) => p.v !== null && isFinite(p.v));
}

/**
 * 收敛分析：从首个样本到「最后一次离开终值超过 eps」的下一帧，用时即收敛时间。
 * 过冲 = 越过终值、朝运动方向的最大额外位移。
 */
function analyzeSettle(pts, eps = 0.5, originT = null) {
  if (!pts || pts.length < 6) return { ok: false, reason: "样本不足", n: pts ? pts.length : 0 };
  const origin = originT != null && originT > 0 && originT <= pts[0].t ? originT : pts[0].t;
  const final = pts[pts.length - 1].v;
  const tail = pts.slice(-5);
  const finalStable = tail.every((p) => Math.abs(p.v - final) <= eps);
  const start = pts[0].v;
  const dist = final - start;
  // 没有位移：这条属性根本没参与动画（例如指示器宽度在各项之间不变）
  if (Math.abs(dist) <= eps * 2) {
    const maxJitter = Math.max(...pts.map((p) => Math.abs(p.v - final)));
    return {
      ok: true,
      noTravel: true,
      settled: finalStable,
      samples: pts.length,
      start: +start.toFixed(2),
      final: +final.toFixed(2),
      travel: +dist.toFixed(2),
      settleMs: null,
      overshootPx: 0,
      overshootPct: 0,
      maxJitter: +maxJitter.toFixed(2),
      peakMs: null,
      peakValue: null,
    };
  }
  let lastOut = -1;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].v - final) > eps) lastOut = i;
  }
  const settleIdx = Math.min(lastOut + 1, pts.length - 1);
  const dir = Math.sign(dist) || 1;
  // 动画真正起步的那一帧：用来区分「点击到响应」的延迟与「动画本身」的时长
  const moveIdx = pts.findIndex((p) => Math.abs(p.v - start) > eps);
  const motionStartMs = moveIdx >= 0 ? +(pts[moveIdx].t - origin).toFixed(1) : null;
  const settleFromMotionMs = motionStartMs != null ? +(pts[settleIdx].t - pts[moveIdx].t).toFixed(1) : null;
  let overshoot = 0, peakT = null, peakV = null;
  for (const p of pts) {
    const over = (p.v - final) * dir;
    if (over > overshoot) { overshoot = over; peakV = p.v; peakT = p.t; }
  }
  return {
    ok: true,
    settled: finalStable,
    samples: pts.length,
    start: +start.toFixed(2),
    final: +final.toFixed(2),
    travel: +dist.toFixed(2),
    settleMs: +(pts[settleIdx].t - origin).toFixed(1),
    motionStartMs,
    settleFromMotionMs,
    overshootPx: +overshoot.toFixed(2),
    overshootPct: dist ? +((overshoot / Math.abs(dist)) * 100).toFixed(1) : 0,
    peakMs: peakT != null ? +(peakT - pts[0].t).toFixed(1) : null,
    peakValue: peakV != null ? +peakV.toFixed(2) : null,
  };
}

function signature(v) {
  if (!v) return "null";
  return [v.bg, v.bgi, v.filt, v.x.toFixed(2), v.y.toFixed(2), v.o.toFixed(3), v.sx.toFixed(3), v.sy.toFixed(3)].join("|");
}

function firstChange(series, idx, baseSig, afterT) {
  for (const row of series) {
    if (afterT != null && row.t < afterT) continue;
    const v = row.v[idx];
    if (signature(v) !== baseSig) return row;
  }
  return null;
}

/**
 * 把「input → 首帧」拆开（Lead 要求的单列口径）：
 *   input→首帧   从 pointerdown 到画面第一次变化（用户感知的总延迟）
 *   input→click  WebView 把 touch 合成为 click 的延迟（动效层管不到）
 *   click→首帧   app 收到 click 到首帧呈现（动效层的真实响应）
 *   switch→首帧  状态真正改变（class/style 突变）到首帧
 */
function timingBreakdown(res, idx, baseSig) {
  const pts = res.series || [];
  if (!pts.length) return { ok: false };
  const downT = res.downT || pts[0].t;
  const clickT = res.clickT || null;
  const mutT = res.mutT || null;
  const hit = firstChange(pts, idx, baseSig, downT);
  const firstT = hit ? hit.t : null;
  const r = (a, b) => (a != null && b != null ? +(a - b).toFixed(1) : null);
  // 有些交互由 pointerup 直接触发、合成 click 反而晚于首帧：这时 click→首帧 无意义，置 null
  const clickBeforeFirstFrame = clickT != null && firstT != null && clickT <= firstT;
  const switchBeforeFirstFrame = mutT != null && firstT != null && mutT <= firstT;
  return {
    ok: hit != null,
    responded: hit != null,
    firstFrameAtRel: firstT != null ? +(firstT - downT).toFixed(1) : null,
    // 用户感知总延迟
    inputToFirstFrameMs: r(firstT, downT),
    // WebView 把 touch 合成 click 的延迟（动效层管不到的那一段）
    inputToClickMs: r(clickT, downT),
    clickAfterFirstFrame: !!(clickT != null && firstT != null && clickT > firstT),
    // 动效层真实响应：从「真的收到 click / 状态真的变了」到首帧
    clickToFirstFrameMs: clickBeforeFirstFrame ? r(firstT, clickT) : null,
    switchToFirstFrameMs: switchBeforeFirstFrame ? r(firstT, mutT) : null,
    clickToSwitchMs: clickBeforeFirstFrame && switchBeforeFirstFrame ? r(mutT, clickT) : null,
    note: "input=pointerdown；click=WebView 合成 click；switch=class/style 首次突变。click/switch 晚于首帧时对应差值置 null",
  };
}

function frameStats(raf) {
  const ds = raf.map((r) => r.d).filter((d) => d > 0);
  if (!ds.length) return { frames: 0 };
  const sum = ds.reduce((a, b) => a + b, 0);
  return {
    frames: ds.length,
    fpsAvg: +(1000 / (sum / ds.length)).toFixed(1),
    long25: ds.filter((d) => d > 25).length,
    long50: ds.filter((d) => d > 50).length,
    worstMs: +Math.max(...ds).toFixed(1),
    p50: +pct(ds, 50).toFixed(1),
    p95: +pct(ds, 95).toFixed(1),
    p99: +pct(ds, 99).toFixed(1),
  };
}

/* ------------------------------------------------------------------ */
/* 测量项                                                               */
/* ------------------------------------------------------------------ */
const measurements = {};
const errors = [];
const phaseRanges = [];

async function mark() {
  return await ev(`__MP.mark()`);
}

async function measurePress(reps) {
  await ev(`__MP.phase("press")`);
  await goTab("sessions");
  await sleep(400);
  const SEL = "#sessionsScroll .sess-row .session-item";
  const runs = [];

  for (let i = 0; i < reps; i++) {
    const r = await rectOf(SEL);
    if (!r) { errors.push("press: 找不到会话行"); break; }
    await ev(`__MP.reset(); window.__mpP = __MP.sample([${JSON.stringify(SEL)}], 360, true); 1`);
    const f0 = await mark();

    if (input.trusted !== false) {
      await touchStart(r.x, r.y);
      await sleep(260);
      // 用 touchCancel 收尾：产生 pointercancel 而不是 click，
      // 否则每次按压都会点开会话，后续重复测量就落不到会话行上了
      await touchCancel();
    } else {
      await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(SEL)});
        const b = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, button: 0, buttons: 1 };
        el.dispatchEvent(new PointerEvent("pointerdown", o));
        return 1;
      })()`);
      await sleep(260);
      await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(SEL)});
        const b = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, button: 0, buttons: 0 };
        el.dispatchEvent(new PointerEvent("pointercancel", o));
        return 1;
      })()`);
    }
    const res = await ev(`window.__mpP`);
    const f1 = await mark();
    phaseRanges.push({ name: "press", from: f0, to: f1 });

    const pts = res.series;
    const baseSig = signature(pts[0].v[0]);
    const downT = res.downT || pts[0].t;
    const hit = firstChange(pts, 0, baseSig, downT);
    const v0 = pts[0].v[0], v1 = hit ? hit.v[0] : null;
    const changed = [];
    if (v0 && v1) {
      if (v0.bg !== v1.bg) changed.push("background-color");
      if (v0.bgi !== v1.bgi) changed.push("background-image");
      if (v0.filt !== v1.filt) changed.push("filter");
      if (Math.abs(v0.x - v1.x) > 0.05 || Math.abs(v0.y - v1.y) > 0.05) changed.push("transform");
      if (Math.abs(v0.o - v1.o) > 0.005) changed.push("opacity");
      if (Math.abs(v0.sx - v1.sx) > 0.002 || Math.abs(v0.sy - v1.sy) > 0.002) changed.push("scale");
    }
    runs.push({
      responded: hit != null,
      firstFrameMs: hit ? +(hit.t - downT).toFixed(1) : null,
      handlerMs: res.mutT && downT ? +(res.mutT - downT).toFixed(1) : null,
      changedProps: changed,
      delta: v0 && v1 ? { bgFrom: v0.bg, bgTo: v1.bg, x: +(v1.x - v0.x).toFixed(2), scale: +(v1.sx - v0.sx).toFixed(4) } : null,
    });
    await sleep(320);
    // 万一还是被导航走了，退回会话页再继续
    if ((await activeScreen()) === "chat") {
      await goTab("sessions");
      await sleep(300);
    }
  }

  const lat = runs.map((r) => r.firstFrameMs).filter((x) => x != null);
  const handler = runs.map((r) => r.handlerMs).filter((x) => x != null);
  const responded = runs.filter((r) => r.responded).length;
  measurements.press = {
    target: SEL,
    reps: runs.length,
    responded,
    respondedPct: runs.length ? +((responded / runs.length) * 100).toFixed(0) : 0,
    note: runs.length === 0
      ? "未执行：找不到可按压的会话行（本机没有会话数据时会出现）"
      : responded === 0
        ? "按压期间逐帧采样未观察到任何 transform/opacity/background 变化：此版本没有按压视觉反馈"
        : "按压有视觉反馈",
    latencyMs: {
      median: lat.length ? +pct(lat, 50).toFixed(1) : null,
      min: lat.length ? +Math.min(...lat).toFixed(1) : null,
      max: lat.length ? +Math.max(...lat).toFixed(1) : null,
      samples: lat,
      note: "从页面收到 pointerdown 到首帧出现视觉变化；受 rAF 采样分辨率(~16.7ms)限制",
    },
    inlineStyleMs: handler.length ? { median: +pct(handler, 50).toFixed(1), samples: handler, note: "首个 style/class 属性突变时间（仅 JS 驱动时可得）" } : null,
    runs,
  };
}

async function measureTabIndicator() {
  await ev(`__MP.phase("tabIndicator")`);
  await goTab("sessions");
  await sleep(500);
  const seq = ["jobs", "files", "settings", "sessions"];
  const runs = [];
  let from = await ev(`(() => { const t = document.querySelector(".tab.is-on"); return t ? t.dataset.tab : null; })()`);

  for (const tab of seq) {
    if (tab === from) { continue; }
    const r = await rectOf(`.tab[data-tab="${tab}"]`);
    if (!r) { errors.push("tab: 找不到 " + tab); continue; }
    const screenSel = '.screen[data-screen="' + tab + '"]';
    await ev(`__MP.reset(); window.__mpP = __MP.sample([${JSON.stringify("#tabIndicator")}, ${JSON.stringify(screenSel)}], 950, true); 1`);
    const f0 = await mark();
    if (input.trusted !== false) await tap(r.x, r.y);
    else await tapFallback(`.tab[data-tab="${tab}"]`);

    const res = await ev(`window.__mpP`);
    const f1 = await mark();
    phaseRanges.push({ name: "tabIndicator", from: f0, to: f1 });

    const xs = seriesOf(res, 0, "x");
    const ws = seriesOf(res, 0, "w");
    const ax = analyzeSettle(xs, 0.5, res.downT);
    const aw = analyzeSettle(ws, 0.5, res.downT);
    // 首帧响应（相对 input / click / switch 三个基准分开算）
    const timing = timingBreakdown(res, 0, signature(res.series[0].v[0]));
    runs.push({ from, to: tab, x: ax, width: aw, timing, clickT: res.clickT || null, downT: res.downT || null });
    from = tab;
    await sleep(200);
  }

  measurements.tabIndicator = {
    target: "#tabIndicator",
    transitions: runs,
    summary: {
      settleMsMedianX: round1(pct(runs.map((r) => r.x.settleMs).filter((v) => v != null), 50)),
      motionStartMsMedian: round1(pct(runs.map((r) => r.x.motionStartMs).filter((v) => v != null), 50)),
      overshootPxMax: runs.length ? +Math.max(...runs.map((r) => r.x.overshootPx || 0)).toFixed(2) : null,
      settleMsMedianW: round1(pct(runs.map((r) => r.width.settleMs).filter((v) => v != null), 50)),
    },
  };
}

async function measureSheetOpen() {
  await ev(`__MP.phase("sheetOpen")`);
  await goTab("settings");
  await sleep(700);
  await closeOverlays();
  await sleep(350);

  // 设置页会记住上次滚动位置，先滚回顶部再定位，避免 scrollIntoView 与
  // 页面切换动画叠加导致读到偏移中的矩形（会点错行）
  await ev(`(() => {
    const s = document.getElementById("screen-settings");
    if (s) s.scrollTop = 0;
    const sc = document.getElementById("settingsScroll") || s;
    if (sc) sc.scrollTop = 0;
    return 1;
  })()`);
  await sleep(350);

  const pt = await locate(SHEET_ROW);
  if (!pt) {
    errors.push("sheetOpen: 找不到 " + SHEET_ROW + " 或几何校验失败");
    return;
  }

  await ev(`__MP.reset(); window.__mpP = __MP.sample(["#sheet", "#sheetBackdrop"], 1100, true); 1`);
  const f0 = await mark();
  if (input.trusted !== false) await tap(pt.x, pt.y);
  else await tapFallback(SHEET_ROW);

  const res = await ev(`window.__mpP`);
  const f1 = await mark();
  phaseRanges.push({ name: "sheetOpen", from: f0, to: f1 });

  const ys = seriesOf(res, 0, "y");
  const os = seriesOf(res, 1, "o").map((p) => ({ t: p.t, v: p.v * 100 }));
  const ay = analyzeSettle(ys, 0.5, res.downT);
  const ao = analyzeSettle(os, 1.0, res.downT);
  const timing = timingBreakdown(res, 0, signature(res.series[0].v[0]));

  const openState = await ev(`(() => {
    const s = document.getElementById("sheet");
    const b = document.getElementById("sheetBody");
    const t = b ? (b.querySelector(".sheet-title") || {}).textContent || "" : "";
    return { on: s.classList.contains("is-on"), title: t.trim().slice(0, 40), items: b ? b.querySelectorAll(".sheet-item").length : 0 };
  })()`);

  measurements.sheetOpen = {
    target: SHEET_ROW + " → #sheet",
    opened: openState,
    timing,
    y: ay,
    backdropOpacityPct: ao,
  };

  await closeOverlays();
  await sleep(350);
}

async function measureSwipeRelease() {
  await ev(`__MP.phase("swipeRelease")`);
  await goTab("sessions");
  await sleep(500);
  await closeOverlays();
  await sleep(300);

  const row = await rectOf("#sessionsScroll .sess-row");
  if (!row) { errors.push("swipe: 找不到会话行"); return; }
  const itemSel = "#sessionsScroll .sess-row .session-item";
  const y = row.top != null ? row.top + row.h / 2 : row.y;
  const x0 = (row.left != null ? row.left : row.x - row.w / 2) + row.w * 0.72;

  // 起手点必须真的落在这一行上，否则拖的是别的行（跟手数据会整体错位）
  const onRow = await ev(`(() => {
    const hit = document.elementFromPoint(${x0}, ${y});
    const row = document.querySelector("#sessionsScroll .sess-row");
    return !!(hit && row && row.contains(hit));
  })()`);
  if (!onRow) {
    errors.push(`swipe: 起手点 (${x0.toFixed(0)},${y.toFixed(0)}) 未命中会话行`);
    return;
  }

  const STEPS = 10, STEP_PX = 26; // 总位移 260px，超过 214 以观察橡皮筋/硬夹

  await ev(`__MP.reset(); window.__mpP = __MP.sample([${JSON.stringify(itemSel)}], 1600, false); 1`);
  const f0 = await mark();

  if (input.trusted !== false) {
    await touchStart(x0, y);
    for (let i = 1; i <= STEPS; i++) {
      await touchMove(x0 - i * STEP_PX, y);
      await sleep(16);
    }
    await sleep(70);
    await touchEnd();
  } else {
    await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(itemSel)});
      const b = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: ${x0}, clientY: ${y}, button: 0, buttons: 1 };
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      return 1;
    })()`);
    for (let i = 1; i <= STEPS; i++) {
      await ev(`(() => {
        const sc = document.getElementById("sessionsScroll");
        const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: ${x0} - ${i * STEP_PX}, clientY: ${y}, button: 0, buttons: 1 };
        sc.dispatchEvent(new PointerEvent("pointermove", o));
        return 1;
      })()`);
      await sleep(16);
    }
    await ev(`(() => {
      const sc = document.getElementById("sessionsScroll");
      const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: ${x0} - ${STEPS * STEP_PX}, clientY: ${y}, button: 0, buttons: 0 };
      sc.dispatchEvent(new PointerEvent("pointerup", o));
      return 1;
    })()`);
  }

  const res = await ev(`window.__mpP`);
  const f1 = await mark();
  phaseRanges.push({ name: "swipeRelease", from: f0, to: f1 });

  const xs = seriesOf(res, 0, "x");
  const timing = timingBreakdown(res, 0, signature(res.series[0].v[0]));
  const upT = res.upT || (res.series.length ? res.series[res.series.length - 1].t : 0);
  const post = xs.filter((p) => p.t >= upT - 8);
  const preDrag = xs.filter((p) => p.t <= upT);
  const settle = analyzeSettle(post, 0.5, upT);

  const state = await ev(`(() => {
    const row = document.querySelector("#sessionsScroll .sess-row");
    const item = row.querySelector(".session-item");
    return { isSwiped: row.classList.contains("is-swiped"), inline: item.style.transform, computed: getComputedStyle(item).transform };
  })()`);

  // 跟手保真度：元素位移 vs 手指位移（只取按下→松手区间）
  const downT = res.downT || 0;
  const downX = res.downX || x0;
  const moves = res.moves || [];
  let trackErr = [], linearErr = [], overlayFrames = 0, dragFrames = 0;
  for (const row of res.series) {
    if (!(row.t >= downT && row.t <= upT + 1)) continue;
    const v = row.v[0];
    if (!v) continue;
    dragFrames++;
    // 按压/拖拽的 scale·skew 覆盖层会写同一个 style.transform，
    // 把 translateX 顶掉——单独计数，避免把它算成「跟手误差」
    if (Math.abs(v.sx - 1) > 0.005 || Math.abs(v.sy - 1) > 0.005) overlayFrames++;
    const mv = [...moves].reverse().find((m) => m.t <= row.t + 1);
    if (!mv) continue;
    const fingerDx = mv.x - downX;
    trackErr.push(Math.abs(v.x - fingerDx));
    if (fingerDx >= -214) linearErr.push(Math.abs(v.x - fingerDx));
  }
  const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
  const max = (a) => (a.length ? +Math.max(...a).toFixed(2) : null);
  const within = (a, thr) => (a.length ? +((a.filter((v) => v <= thr).length / a.length) * 100).toFixed(0) : null);

  measurements.swipeRelease = {
    target: itemSel,
    finalState: state,
    timing,
    release: {
      settleMs: settle.ok ? settle.settleMs : null,
      finalX: settle.ok ? settle.final : null,
      overshootPx: settle.ok ? settle.overshootPx : null,
      settled: settle.ok ? settle.settled : null,
      samples: settle.ok ? settle.samples : 0,
      note: "从 pointerup 到位移稳定在 ±0.5px 内",
    },
    drag: {
      expectedLinearity: "元素位移应等于手指位移（1:1）",
      frames: dragFrames,
      meanAbsErrorPx: mean(trackErr),
      maxAbsErrorPx: max(trackErr),
      linearRegionMeanErrPx: mean(linearErr),
      linearRegionMaxErrPx: max(linearErr),
      within8pxPct: within(linearErr, 8),
      minXReached: xs.length ? +Math.min(...xs.map((p) => p.v)).toFixed(1) : null,
      clampExpected: -228,
      pressOverlayFrames: overlayFrames,
      pressOverlayPct: dragFrames ? +((overlayFrames / dragFrames) * 100).toFixed(0) : null,
      note: "linearRegion 指手指位移未超过 -214 的跟手区间；pressOverlayFrames 是 transform 被按压 scale/skew 覆盖、translateX 丢失的帧数",
    },
  };

  await closeOverlays();
  await sleep(350);
}

/* ------------------------------------------------------------------ */
/* 静态机制 & 环境                                                      */
/* ------------------------------------------------------------------ */
async function collectEnv(page) {
  const env = await ev(`(() => {
    const cs = (sel, prop) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e); return prop === "transition" ? c.transition : c[prop]; };
    const ua = navigator.userAgent;
    const m = ua.match(/Chrome\\/([\\d.]+)/);
    return {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      ua,
      chromeVersion: m ? m[1] : null,
      motionRuntime: {
        present: typeof window.Motion === "object" && !!window.Motion && typeof window.Motion.springTo === "function",
        legacy: window.Motion ? !!window.Motion.legacy : null,
        reduced: window.Motion && typeof window.Motion.reduced === "function" ? window.Motion.reduced() : null,
        hasDragApi: !!(window.Motion && typeof window.Motion.drag === "function"),
        presets: window.Motion && window.Motion.presets ? window.Motion.presets : null,
      },
      reducedMotionPref: !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches),
      cssMechanism: {
        tabIndicator: { transition: cs("#tabIndicator", "transition"), willChange: cs("#tabIndicator", "willChange") },
        sheet: { transition: cs("#sheet", "transition") },
        sheetBackdrop: { transition: cs("#sheetBackdrop", "transition") },
        sessionItem: { transition: cs(".session-item", "transition") },
        tab: { transition: cs(".tab", "transition") },
      },
    };
  })()`);
  env.target = { id: page.id, title: page.title, url: page.url };
  return env;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  const t0 = Date.now();
  console.error("[probe] 连接 CDP ...");
  const page = await connect();
  console.error("[probe] connected:", page.url);

  const libState = await ev(PAGE_LIB);
  // 页面不重载时 __MP 会跨进程保留，先清掉上一轮的帧记录
  await ev(`(() => { __MP.raf.length = 0; __MP.long.length = 0; __MP.lastRaf = 0; return 1; })()`);
  if (libState !== "ok" && libState !== "exists") {
    input.warnings.push("页面探测库注入返回: " + libState);
  }
  await probeInput();

  const env = await collectEnv(page);

  // 环境控制组：不做任何交互，纯采样 1s 的 rAF，作为本次的帧率基准。
  // 宿主机被其它 agent 抢 CPU 时，交互期帧率要和这个基准比才有意义。
  const idleA = await ev(`__MP.mark()`);
  await sleep(1000);
  const idleB = await ev(`__MP.mark()`);
  const idleRaf = await ev(`__MP.rafAll()`);
  const idleControl = frameStats((idleRaf || []).slice(idleA, idleB));

  // 会话行是否来自 scripts/seed_sessions.js 写的夹具（id 前缀 t-）——报告里要标注 seeded
  const seedInfo = await ev(`(() => {
    try {
      const l = JSON.parse(localStorage.getItem("dsh.local.sessions") || "[]");
      const ids = (Array.isArray(l) ? l : []).map((s) => String(s.id));
      return { stored: ids.length, seeded: ids.some((i) => /^t-/.test(i)), ids: ids.slice(0, 10) };
    } catch (e) { return { error: String(e) }; }
  })()`).catch((e) => ({ error: e.message }));

  const phases = [
    ["press", () => measurePress(REPS)],
    ["tabIndicator", () => measureTabIndicator()],
    ["sheetOpen", () => measureSheetOpen()],
    ["swipeRelease", () => measureSwipeRelease()],
  ];
  for (const [name, fn] of phases) {
    try {
      console.error(`[probe] ${name} ...`);
      await fn();
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      console.error(`[probe] ${name} 失败: ${e.message}`);
    }
  }

  // 收尾：恢复界面
  try {
    await goTab("sessions");
    await closeOverlays();
  } catch (_) {}

  const raf = await ev(`__MP.rafAll()`);
  const longTasks = await ev(`__MP.longAll()`);
  const phaseMarks = (await ev(`__MP.phasesAll()`)) || [];
  const frames = frameStats(raf || []);

  // 分阶段帧率：哪个交互在掉帧一目了然
  const byPhase = {};
  for (const r of phaseRanges) {
    const slice = (raf || []).slice(r.from, r.to);
    (byPhase[r.name] = byPhase[r.name] || []).push(...slice);
  }
  const phaseFrames = {};
  for (const k of Object.keys(byPhase)) phaseFrames[k] = frameStats(byPhase[k]);

  // 长任务归到所属阶段
  const phaseAt = (t) => {
    let cur = "(启动/空闲)";
    for (const ph of phaseMarks) { if (t >= ph.t) cur = ph.name; else break; }
    return cur;
  };
  const longByPhase = {};
  for (const L of longTasks || []) {
    const k = phaseAt(L.t);
    if (!longByPhase[k]) longByPhase[k] = { count: 0, totalMs: 0, worstMs: 0 };
    longByPhase[k].count++;
    longByPhase[k].totalMs += L.d;
    longByPhase[k].worstMs = Math.max(longByPhase[k].worstMs, L.d);
  }
  for (const k of Object.keys(longByPhase)) {
    longByPhase[k].totalMs = +longByPhase[k].totalMs.toFixed(1);
    longByPhase[k].worstMs = +longByPhase[k].worstMs.toFixed(1);
  }

  const longArr = (longTasks || []).map((l) => l.d);
  const longStats = {
    count: longArr.length,
    totalMs: +longArr.reduce((a, b) => a + b, 0).toFixed(1),
    worstMs: longArr.length ? +Math.max(...longArr).toFixed(1) : 0,
    entries: (longTasks || []).slice(0, 40),
  };

  const result = {
    probe: "motion_probe.mjs",
    probeVersion: "1.0.0",
    label: LABEL,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    seeded: !!(seedInfo && seedInfo.seeded),
    seededNote: seedInfo && seedInfo.seeded
      ? "会话列表来自 scripts/seed_sessions.js 的测试夹具（id 前缀 t-），仅用于让按压/左滑有可测目标，不代表真实用户数据"
      : "会话列表为设备上原有数据（或为空）",
    seedInfo,
    env,
    input: {
      trusted: input.trusted,
      method: input.method,
      note: input.trusted
        ? "使用 CDP Input.dispatchTouchEvent 合成可信触摸，浏览器按真实手势处理"
        : "非可信事件：由 JS dispatchEvent 合成 PointerEvent，不满足浏览器 trusted 语义",
    },
    measurements,
    idleControl,
    frames,
    phaseFrames,
    longTasks: { ...longStats, byPhase: longByPhase },
    warnings: input.warnings,
    errors,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `probe-${LABEL}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), "utf8");

  /* ---------- 摘要 ---------- */
  if (!QUIET) {
    const L = [];
    L.push("");
    L.push(`=== motion probe: ${LABEL} ===`);
    L.push(`target   : ${env.target.url}`);
    L.push(`viewport : ${env.viewport.w}x${env.viewport.h} @${env.viewport.dpr}  Chrome/${env.chromeVersion}`);
    L.push(`input    : ${input.trusted ? "trusted touch (Input.dispatchTouchEvent)" : "NON-TRUSTED (JS PointerEvent)"}`);
    if (result.seeded) L.push(`SEEDED   : 会话为 scripts/seed_sessions.js 夹具（${seedInfo.ids.join(",")}）`);
    L.push(`Motion   : ${env.motionRuntime.present ? "present" : "ABSENT（旧版 CSS 过渡）"}` +
      (env.motionRuntime.present ? `  reduced=${env.motionRuntime.reduced} presets=${Object.keys(env.motionRuntime.presets || {}).join(",")}` : ""));
    L.push(`css      : indicator[${env.cssMechanism.tabIndicator.transition}] sheet[${env.cssMechanism.sheet.transition}] item[${env.cssMechanism.sessionItem.transition}]`);

    if (measurements.press) {
      const p = measurements.press;
      L.push(p.reps === 0
        ? `press    : 未执行（无会话行）`
        : p.responded === 0
        ? `press    : 无视觉反馈（${p.reps} 次按压全部未观察到变化）`
        : `press    : median ${p.latencyMs.median}ms (min ${p.latencyMs.min} / max ${p.latencyMs.max}, n=${p.reps}, 响应率 ${p.respondedPct}%)  changed=${[...new Set(p.runs.flatMap((r) => r.changedProps))].join(",")}`);
    }
    if (measurements.tabIndicator) {
      for (const t of measurements.tabIndicator.transitions) {
        const tm = t.timing || {};
        L.push(`tab ${String(t.from).padEnd(8)}→ ${String(t.to).padEnd(8)}  input→首帧 ${tm.inputToFirstFrameMs}ms (= input→click ${tm.inputToClickMs} + click→首帧 ${tm.clickToFirstFrameMs})  switch→首帧 ${tm.switchToFirstFrameMs}ms  |  x settle ${t.x.settleMs}ms (动画 ${t.x.settleFromMotionMs}ms) overshoot ${t.x.overshootPx}px (${t.x.overshootPct}%)`);
      }
    }
    if (measurements.sheetOpen) {
      const s = measurements.sheetOpen;
      const st = s.timing || {};
      L.push(`sheet    : ${s.opened.on ? "ok" : "FAIL"} "${s.opened.title}"  input→首帧 ${st.inputToFirstFrameMs}ms (= input→click ${st.inputToClickMs} + click→首帧 ${st.clickToFirstFrameMs})  switch→首帧 ${st.switchToFirstFrameMs}ms  |  y settle ${s.y.settleMs}ms (动画 ${s.y.settleFromMotionMs}ms) overshoot ${s.y.overshootPx}px (${s.y.overshootPct}%)  backdrop ${s.backdropOpacityPct.settleMs}ms`);
    }
    if (measurements.swipeRelease) {
      const s = measurements.swipeRelease;
      L.push(`swipe    : release settle ${s.release.settleMs}ms finalX ${s.release.finalX} overshoot ${s.release.overshootPx}px  latched=${s.finalState.isSwiped}`);
      L.push(`tracking : mean ${s.drag.meanAbsErrorPx}px / max ${s.drag.maxAbsErrorPx}px  1:1区 ${s.drag.linearRegionMeanErrPx}px  minX ${s.drag.minXReached}`);
      L.push(`swipe首帧 : input→首帧 ${s.timing?.inputToFirstFrameMs}ms  switch→首帧 ${s.timing?.switchToFirstFrameMs}ms`);
    }
    L.push(`idle基准 : ${idleControl.fpsAvg}fps, p95 ${idleControl.p95}ms, worst ${idleControl.worstMs}ms（无交互，供环境对照）`);
    L.push(`frames   : ${frames.frames} frames, avg ${frames.fpsAvg}fps, long>25ms ${frames.long25}, worst ${frames.worstMs}ms, p95 ${frames.p95}ms`);
    L.push(`longtask : ${longStats.count} 个, 共 ${longStats.totalMs}ms, 最坏 ${longStats.worstMs}ms`);
    for (const [k, v] of Object.entries(phaseFrames)) {
      const lb = longByPhase[k] || { count: 0, totalMs: 0, worstMs: 0 };
      L.push(`  phase ${k.padEnd(13)} ${String(v.fpsAvg).padStart(5)}fps  long>25ms ${String(v.long25).padStart(3)}  worst ${String(v.worstMs).padStart(6)}ms  | longtask ${lb.count} 个/${lb.totalMs}ms(worst ${lb.worstMs}ms)`);
    }
    if (result.warnings.length) L.push(`warn     : ${result.warnings.join(" | ")}`);
    if (result.errors.length) L.push(`ERROR    : ${result.errors.join(" | ")}`);
    L.push(`wrote    : ${path.relative(process.cwd(), outFile)}  (${result.durationMs}ms)`);
    console.log(L.join("\n"));
  } else {
    console.log(outFile);
  }

  ws.close();
  process.exit(result.errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error("[probe] 致命错误:", e.stack || e.message);
  try { ws && ws.close(); } catch (_) {}
  process.exit(2);
});
