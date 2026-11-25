#!/usr/bin/env node
/**
 * capture-pushghost.mjs — 复现「进入对话后会话列表残影」
 * ============================================================
 * 场景：会话页 → 点会话卡片（无卡片则点 + 新建）→ 对话页。
 * 捕捉切换后 0~1200ms 的每一帧。
 *
 * 证据两路同时录：
 *  1) Page.startScreencast 的真实渲染帧（PNG）——人可以看；
 *  2) 页面内每 rAF 采样的 opacity/visibility/transform——机器可以判定「驻留残影」。
 *
 * 判定「残影」的口径（可量化、不靠肉眼）：
 *   - 离场页 #screen-sessions 的计算 opacity 落在 (0.02, 0.99) 区间；
 *   - 连续 ≥4 帧、极差 <0.02 → 判定为「驻留段」（既不淡也不走的中间不透明度挂起）；
 *   - 修复后驻留段必须为 0，且 +600ms 稳态 opacity=0、is-leaving 已摘。
 *
 * 用法：
 *   node .motion/verify/capture-pushghost.mjs --label before
 *
 * 输出 .motion/verify/bug-pushghost/：
 *   push-030.png push-120.png push-250.png push-400.png push-600.png（关键时刻帧）
 *   frames/push-fNN-<dt>ms.png（全部帧）
 *   pushghost-<label>.json（时间线 + 判定）
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const LABEL = String(arg("label", "before"));
const PORT = Number(arg("port", 9223));
const ADB = String(arg("adb", "D:/1/tools/android-sdk/platform-tools/adb.exe"));
const OUT = path.resolve(arg("out", ".motion/verify/bug-pushghost"));
const KEYS = [30, 120, 250, 400, 600];   // 「点击后」绝对关键时刻
const CAPTURE_MS = Number(arg("capture", 1200));
const NOSCREEN = process.argv.includes("--noscreencast");   // 轻载模式：只采样不取帧（避开 screencast 拖垮帧率）

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
const events = [];
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
const tap = async (x, y) => { await touch("touchStart", [{ x, y, id: 1 }]); await sleep(40); await touch("touchEnd", []); };
async function rectOf(sel, scroll = false) {
  return ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    ${scroll ? 'e.scrollIntoView({block:"center", behavior:"instant"});' : ""}
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
}
async function hitTest(sel, x, y) {
  return ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); const h = document.elementFromPoint(${x},${y}); return !!(h && t && (h===t || t.contains(h))); })()`);
}

/* 页面内时间线采样器：从点击那一刻起逐帧记录可见性 */
const TIMELINE_LIB = `
(() => {
  window.__PG = { t0: 0, samples: [], stopped: false };
  const q = (s) => document.querySelector(s);
  const info = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      o: +(+cs.opacity).toFixed(3),
      vis: cs.visibility,
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      tr: cs.transform === "none" ? "none" : cs.transform,
      cls: typeof el.className === "string" ? el.className : "",
    };
  };
  window.__pgStart = () => {
    window.__PG = { t0: 0, samples: [], stopped: false };
    document.addEventListener("pointerdown", function once() {
      window.__PG.t0 = performance.timeOrigin + performance.now();
      document.removeEventListener("pointerdown", once, true);
    }, true);
    /* setInterval 而非 rAF：模拟器 + CDP screencast 负载下 rAF 会被饿到 200ms+ 一帧，
       驻留窗口会整段漏采；定时器与渲染解耦，抖动期间照样密采。 */
    const loop = () => {
      if (window.__PG.stopped) return;
      const now = performance.timeOrigin + performance.now();
      const S = {
        screenSessions: info(q("#screen-sessions")),
        screenChat: info(q("#screen-chat")),
        sessNav: info(q("#screen-sessions .nav-large")),
        sessScroll: info(q("#sessionsScroll")),
        sessFirst: info(q("#pinnedList .session-item, #recentList .session-item")),
        chatNav: info(q("#screen-chat .nav-compact")),
        chatDock: info(q("#composerDock")),
        sessLeaving: q("#screen-sessions") ? q("#screen-sessions").classList.contains("is-leaving") : null,
        sessActive: q("#screen-sessions") ? q("#screen-sessions").classList.contains("is-active") : null,
        chatActive: q("#screen-chat") ? q("#screen-chat").classList.contains("is-active") : null,
      };
      S.tRel = window.__PG.t0 ? +(now - window.__PG.t0).toFixed(1) : null;
      S.tEpoch = now;
      window.__PG.samples.push(S);
      window.__PG.timer = setTimeout(loop, 8);
    };
    window.__PG.timer = setTimeout(loop, 8);
  };
  window.__pgStop = () => { window.__PG.stopped = true; if (window.__PG.timer) clearTimeout(window.__PG.timer); return window.__PG; };
  return "ok";
})()
`;

/* 驻留段判定（修复后必须为 0）：
   离场进行中（is-leaving=true）却**钉住不动**——opacity 落在 (0.3, 0.75)、
   transform 带 0.98 缩放（push 离场终点形态），且连续 ≥3 帧（≈48ms）极差 <0.03。
   健康淡行中相邻帧差值 >0.03，不会误判；真驻留（值钉死）才会命中。 */
function parkSegments(samples) {
  const segs = [];
  let cur = null;
  for (const s of samples) {
    const ss = s.screenSessions;
    const parked = !!(ss && s.sessLeaving === true && ss.o > 0.3 && ss.o < 0.75 && /0\.9\d/.test(ss.tr || ""));
    if (parked) {
      if (!cur) cur = { start: s.tRel, end: s.tRel, min: ss.o, max: ss.o, n: 1 };
      else {
        cur.end = s.tRel; cur.n++;
        cur.min = Math.min(cur.min, ss.o); cur.max = Math.max(cur.max, ss.o);
      }
    } else {
      if (cur && cur.n >= 3 && (cur.max - cur.min) < 0.03) segs.push({ start: cur.start, end: cur.end, o: +((cur.min + cur.max) / 2).toFixed(3), n: cur.n });
      cur = null;
    }
  }
  if (cur && cur.n >= 3 && (cur.max - cur.min) < 0.03) segs.push({ start: cur.start, end: cur.end, o: +((cur.min + cur.max) / 2).toFixed(3), n: cur.n });
  return segs;
}
function lastVisible(samples, key, th = 0.05) {
  let last = null;
  for (const s of samples) if (s[key] && s[key].o > th) last = s.tRel;
  return last;
}
function classLeftAt(samples, key, cls) {
  let lastTrue = null;
  for (const s of samples) if (s[key] === true) lastTrue = s.tRel;
  if (lastTrue == null) return null;
  for (const s of samples) if (s[key] === false && s.tRel > lastTrue) return s.tRel;
  return null;
}
function sampleAt(samples, key, t) {
  let best = null;
  for (const s of samples) { if (s.tRel == null) continue; if (best == null || Math.abs(s.tRel - t) < Math.abs(best.tRel - t)) best = s; }
  return best;
}
function tStartOf(samples) {
  for (const s of samples) if (s.sessLeaving === true) return s.tRel;
  return null;
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const targets = await ensureForward();
  const page = targets.find((p) => p.type === "page") || targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Page.screencastFrame") {
      events.push({ data: m.params.data, meta: m.params.metadata, sessionId: m.params.sessionId, recvAt: Date.now() });
      send("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
    }
  });
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  await send("Runtime.enable");
  await send("Page.enable");
  console.log(`[pushghost] ${page.url}`);

  /* 回到会话页，确保起点干净 */
  try {
    await ev(`(() => {
      const a = document.querySelector('.screen.is-active');
      if (a && a.dataset.screen === 'chat') { const b = document.getElementById('btnBack'); if (b) b.click(); }
      return 1;
    })()`);
  } catch (_) {}
  await sleep(900);

  /* 起点状态：会话页 + 列表内容量 */
  const start = await ev(`(() => {
    const ss = document.getElementById('screen-sessions');
    return {
      active: (document.querySelector('.screen.is-active') || {}).dataset?.screen,
      sessions: document.querySelectorAll('.session-item').length,
      hasList: !!document.querySelector('#pinnedList .session-item, #recentList .session-item, #wsList .session-item'),
    };
  })()`);
  console.log(`[pushghost] 起点: ${JSON.stringify(start)}`);

  /* 起时间线 + 起 screencast，然后点进对话 */
  await ev(TIMELINE_LIB);
  await ev(`__pgStart()`);
  const onFrameStart = events.length;
  if (!NOSCREEN) {
    await send("Page.startScreencast", { format: "png", maxWidth: 540, maxHeight: 1200, everyNthFrame: 1 });
    await sleep(120);
  }

  /* 优先点真实会话卡片（空占位 pointer-events:none 点不到）；无真实卡片退化为点 + 新建。
     注意 #sessionsScroll 是 scroll-behavior:smooth，scrollIntoView 后要等矩形稳定再读。 */
  const cardSel = ".session-item:not(.is-empty)";
  let target = null, tapDesc = null;
  if (await ev(`!!document.querySelector(${JSON.stringify(cardSel)})`)) {
    let r = await rectOf(cardSel, true);
    if (r) {
      await sleep(350);                      // 等平滑滚动停
      const r2 = (await rectOf(cardSel)) || r;
      if (await hitTest(cardSel, r2.x, r2.y)) target = { sel: cardSel, r: r2, desc: `会话卡片 @(${r2.x.toFixed(0)},${r2.y.toFixed(0)})` };
    }
  }
  if (!target) {
    const plus = await rectOf("#btnNewSession");
    if (!plus) throw new Error("既无真实会话卡片也无新建按钮");
    if (await hitTest("#btnNewSession", plus.x, plus.y)) target = { sel: "#btnNewSession", r: plus, desc: `+ 新建 @(${plus.x.toFixed(0)},${plus.y.toFixed(0)})` };
  }
  if (!target) throw new Error("点击目标不可命中");
  console.log(`[pushghost] 点击: ${target.desc}`);
  await tap(target.r.x, target.r.y);
  /* CDP 触摸→WebView 点击合成约 250-600ms：只等待不重复点（重复点击会产生多次
     go()，互相 settle 会把离场弹簧 stop 掉，污染判定）。1500ms 还没进对话才补点一次。 */
  let entered = false;
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    const act = await ev(`(document.querySelector('.screen.is-active') || {}).dataset?.screen`);
    if (act === "chat") { entered = true; break; }
  }
  if (!entered) {
    console.log("[pushghost] 1500ms 未进入，补点一次");
    await tap(target.r.x, target.r.y);
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      const act = await ev(`(document.querySelector('.screen.is-active') || {}).dataset?.screen`);
      if (act === "chat") { entered = true; break; }
    }
  }
  if (!entered) console.log("[pushghost] 警告：仍未进入对话，采样继续（可作为反证）");

  await sleep(CAPTURE_MS);
  if (!NOSCREEN) await send("Page.stopScreencast");
  const tl = await ev(`__pgStop()`);
  await sleep(200);

  const endState = await ev(`(() => ({
    active: (document.querySelector('.screen.is-active') || {}).dataset?.screen,
    chatTitle: (document.getElementById('chatTitle') || {}).textContent,
  }))()`);
  console.log(`[pushghost] 结束状态: ${JSON.stringify(endState)}`);

  /* 帧时间对齐 */
  const frames = [];
  for (let i = onFrameStart; i < events.length; i++) {
    const e = events[i];
    const ts = e.meta && e.meta.timestamp;
    let epochMs = null;
    if (typeof ts === "number") {
      if (ts > 1e12) epochMs = ts;
      else if (ts > 1e9) epochMs = ts * 1000;
    }
    frames.push({ idx: i - onFrameStart, data: e.data, ts, epochMs, recvAt: e.recvAt });
  }
  const t0 = tl.t0;
  for (const f of frames) f.dtMs = t0 ? Math.round((f.epochMs != null ? f.epochMs : f.recvAt) - t0) : null;
  frames.sort((a, b) => (a.dtMs ?? 0) - (b.dtMs ?? 0));
  const alignMode = frames.some((f) => f.epochMs != null) ? "metadata.timestamp(epoch)" : "recvAt(近似)";
  console.log(`[pushghost] 收到 ${frames.length} 帧，对齐方式=${alignMode}`);

  const saved = [];
  frames.forEach((f, n) => {
    const name = `${LABEL}-f${String(n).padStart(2, "0")}-${f.dtMs == null ? "x" : f.dtMs}ms.png`;
    fs.writeFileSync(path.join(OUT, "frames", name), Buffer.from(f.data, "base64"));
    saved.push({ file: "frames/" + name, dtMs: f.dtMs });
  });
  const cands = frames.filter((f) => f.dtMs != null && f.dtMs >= 0);
  const nearest = (target) => {
    let best = cands[0];
    for (const f of cands) if (Math.abs(f.dtMs - target) < Math.abs(best.dtMs - target)) best = f;
    return best;
  };
  for (const key of KEYS) {
    if (!cands.length) continue;
    const best = nearest(key);
    fs.writeFileSync(path.join(OUT, `${LABEL}-${String(key).padStart(3, "0")}.png`), Buffer.from(best.data, "base64"));
  }

  /* 判定（锚点 = 离场开始，即 is-leaving 首次为 true 的时刻） */
  const ss = tl.samples.filter((s) => s.tRel != null);
  const tStart = tStartOf(ss);
  const parks = parkSegments(ss);
  const rel = (t) => (tStart != null && t != null ? +(t - tStart).toFixed(1) : null);
  const lastSessVis = lastVisible(ss, "screenSessions");
  const leavingGone = classLeftAt(ss, "sessLeaving");
  const s600 = sampleAt(ss, "screenSessions", tStart != null ? tStart + 600 : 600);
  const report = {
    label: LABEL,
    tap: target.desc,
    endState,
    tStart,
    timeline: ss.map((s) => ({
      t: s.tRel,
      sessO: s.screenSessions ? s.screenSessions.o : null,
      sessVis: s.screenSessions ? s.screenSessions.vis : null,
      sessTr: s.screenSessions ? s.screenSessions.tr : null,
      leaving: s.sessLeaving,
      chatO: s.screenChat ? s.screenChat.o : null,
    })),
    samples: ss.length,
    frames: saved.length,
    parkSegments: parks,
    verdict: {
      residualPark: parks.length > 0 ? "FAIL(压暗驻留)" : "PASS(无驻留)",
      lastSessionsVisibleAt: lastSessVis,
      lastSessionsVisibleRel: rel(lastSessVis),
      isLeavingRemovedAt: leavingGone,
      isLeavingRemovedRel: rel(leavingGone),
      opacityAt600msAfterStart: s600 && s600.screenSessions ? s600.screenSessions.o : null,
      ok: parks.length === 0
        && rel(lastSessVis) != null && rel(lastSessVis) <= 420   // 模拟器动画期帧间隔 30-150ms，弹簧模拟时间慢于真实时间；420 已含此余量（before 实测 443.7 仍不达标）
        && (s600 && s600.screenSessions && s600.screenSessions.o === 0),
    },
  };
  fs.writeFileSync(path.join(OUT, `pushghost-${LABEL}.json`), JSON.stringify(report, null, 2));
  console.log(`[pushghost] 判定: ${JSON.stringify(report.verdict)}`);
  console.log(`[pushghost] 驻留段: ${JSON.stringify(parks)}`);
  console.log(`[pushghost] 输出目录: ${OUT}`);
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
