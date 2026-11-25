#!/usr/bin/env node
/**
 * capture-navback.mjs — 复现「返回会话页时顶部标题栏残影」
 * ============================================================
 * 场景：对话页 → 点返回 → 会话页。捕捉返回后 0~700ms 的每一帧。
 *
 * 证据两路同时录：
 *  1) Page.startScreencast 的真实渲染帧（PNG）——人可以看；
 *  2) 页面内每 rAF 采样的几何/可见性——机器可以判定「两页同时存在」。
 *
 * 判定「残影」的口径（可量化、不靠肉眼）：
 *   - 离场页 #screen-chat 的计算 opacity > 0.02 且 visibility !== hidden；
 *   - 同时 #screen-sessions 的 .nav-large 也可见（opacity > 0.02）；
 *   - 且 chat 的 .nav-compact（或 composer-dock）与 sessions 的 .nav-large 矩形相交。
 *   三者同时成立 → 该帧存在残影。
 *
 * 用法：
 *   node .motion/verify/capture-navback.mjs --label before
 *
 * 输出 .motion/verify/bug-navback/：
 *   before-030.png before-080.png before-150.png before-250.png   （关键时刻帧）
 *   frames/before-fNN-<dt>ms.png                                  （全部帧）
 *   navback-<label>.json                                          （时间线 + 判定）
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
const OUT = path.resolve(arg("out", ".motion/verify/bug-navback"));
const KEYS = [30, 80, 150, 250];          // 需求要求的「点返回后」绝对时刻
const NAV_KEYS = [30, 80, 150, 250];      // 相对「切换真正开始」的时刻（幽灵窗口内）
const CAPTURE_MS = 1200;

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
    ${scroll ? 'e.scrollIntoView({block:"center"});' : ""}
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
}
async function hitTest(sel, x, y) {
  return ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); const h = document.elementFromPoint(${x},${y}); return !!(h && t && (h===t || t.contains(h))); })()`);
}
async function tapSel(sel, scroll = false) {
  for (let i = 0; i < 4; i++) {
    const r = await rectOf(sel, scroll);
    if (!r) { await sleep(250); continue; }
    await sleep(300);
    const r2 = (await rectOf(sel)) || r;
    if (await hitTest(sel, r2.x, r2.y)) { await tap(r2.x, r2.y); return true; }
    await sleep(200);
  }
  return false;
}

/* 页面内时间线采样器：从返回那一刻起逐帧记录几何与可见性 */
const TIMELINE_LIB = `
(() => {
  window.__NB = { t0: 0, samples: [], stopped: false };
  const q = (s) => document.querySelector(s);
  const info = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      o: +(+cs.opacity).toFixed(3),
      vis: cs.visibility,
      disp: cs.display,
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      tr: cs.transform === "none" ? "none" : cs.transform,
      cls: el.className,
    };
  };
  window.__nbStart = () => {
    window.__NB = { t0: 0, samples: [], stopped: false };
    document.addEventListener("pointerdown", function once() {
      window.__NB.t0 = performance.timeOrigin + performance.now();  // epoch ms
      document.removeEventListener("pointerdown", once, true);
    }, true);
    const loop = () => {
      if (window.__NB.stopped) return;
      const now = performance.timeOrigin + performance.now();
      const S = {
        screenChat: info(q("#screen-chat")),
        screenSessions: info(q("#screen-sessions")),
        chatNav: info(q("#screen-chat .nav-compact")),
        chatDock: info(q("#composerDock")),
        sessNav: info(q("#screen-sessions .nav-large")),
        sessTitle: info(q("#screen-sessions .nav-title")),
        tabbar: info(q("#tabbar")),
        chatLeaving: q("#screen-chat") ? q("#screen-chat").classList.contains("is-leaving") : null,
        sessActive: q("#screen-sessions") ? q("#screen-sessions").classList.contains("is-active") : null,
        chatActive: q("#screen-chat") ? q("#screen-chat").classList.contains("is-active") : null,
      };
      S.tRel = window.__NB.t0 ? +(now - window.__NB.t0).toFixed(1) : null;
      S.tEpoch = now;
      window.__NB.samples.push(S);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  };
  window.__nbStop = () => { window.__NB.stopped = true; return window.__NB; };
  return "ok";
})()
`;

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
      // 必须 ack，否则只发第一帧
      send("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
    }
  });
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  await send("Runtime.enable");
  await send("Page.enable");
  console.log(`[navback] ${page.url}`);

  /* 回到会话页，确保起点干净 */
  try {
    await ev(`(() => {
      const a = document.querySelector('.screen.is-active');
      if (a && a.dataset.screen === 'chat') { const b = document.getElementById('btnBack'); if (b) b.click(); }
      return 1;
    })()`);
  } catch (_) {}
  await sleep(900);

  /* 1) 新建对话 */
  const plus = await ev(`(() => {
    const b = document.getElementById('btnNewSession');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!plus) throw new Error("找不到 #btnNewSession");
  const plusHit = await hitTest("#btnNewSession", plus.x, plus.y);
  console.log(`[navback] 新建对话按钮 @(${plus.x.toFixed(0)},${plus.y.toFixed(0)}) 命中=${plusHit}`);
  await tap(plus.x, plus.y);
  await sleep(800);                                   // 需求：等 800ms

  const inChat = await ev(`(() => {
    const a = document.querySelector('.screen.is-active');
    return { screen: a ? a.dataset.screen : null,
             title: (document.getElementById('chatTitle') || {}).textContent,
             chatActive: document.getElementById('screen-chat').classList.contains('is-active') };
  })()`);
  console.log(`[navback] 800ms 后: ${JSON.stringify(inChat)}`);

  /* 2) 起时间线 + 起 screencast，然后点返回 */
  await ev(TIMELINE_LIB);
  await ev(`__nbStart()`);

  const frames = [];
  const onFrameStart = events.length;
  await send("Page.startScreencast", { format: "png", maxWidth: 540, maxHeight: 1200, everyNthFrame: 1 });
  await sleep(120);

  const back = await rectOf("#btnBack");
  if (!back) throw new Error("找不到 #btnBack");
  console.log(`[navback] 返回按钮 @(${back.x.toFixed(0)},${back.y.toFixed(0)})`);
  await tap(back.x, back.y);

  await sleep(CAPTURE_MS);
  await send("Page.stopScreencast");
  const tl = await ev(`__nbStop()`);
  await sleep(200);

  /* 3) 帧时间对齐：
        screencast metadata.timestamp 在 Chrome 里是「截帧时刻」的秒级 epoch。
        用它在页面里换算出与本轮返回动作的毫秒差。 */
  for (let i = onFrameStart; i < events.length; i++) {
    const e = events[i];
    const ts = e.meta && e.meta.timestamp;
    let epochMs = null;
    if (typeof ts === "number") {
      if (ts > 1e12) epochMs = ts;                 // 已经是 ms
      else if (ts > 1e9) epochMs = ts * 1000;      // 秒级 epoch
      else epochMs = null;                         // 单调时钟，无法直接对齐
    }
    frames.push({ idx: i - onFrameStart, data: e.data, ts, epochMs, recvAt: e.recvAt });
  }

  const t0 = tl.t0;   // 页面里 pointerdown 的 epoch ms
  // 若 metadata 不是 epoch，用「帧到达时间」近似（误差 ~接收延迟）
  for (const f of frames) {
    f.dtMs = t0 ? Math.round((f.epochMs != null ? f.epochMs : f.recvAt) - t0) : null;
  }
  frames.sort((a, b) => (a.dtMs ?? 0) - (b.dtMs ?? 0));

  const alignMode = frames.some((f) => f.epochMs != null) ? "metadata.timestamp(epoch)" : "recvAt(近似)";
  console.log(`[navback] 收到 ${frames.length} 帧，对齐方式=${alignMode}`);

  /* 4) 存全部帧 + 关键时刻帧 */
  const saved = [];
  frames.forEach((f, n) => {
    const name = `before-f${String(n).padStart(2, "0")}-${f.dtMs == null ? "x" : f.dtMs}ms.png`;
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
    fs.writeFileSync(path.join(OUT, `before-${String(key).padStart(3, "0")}.png`), Buffer.from(best.data, "base64"));
  }

  /* 5) 逐帧判定残影 */
  const overlaps = (a, b) => {
    if (!a || !b) return 0;
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return +(x * y).toFixed(0);
  };
  const vis = (n) => n && n.o > 0.02 && n.vis !== "hidden" && n.disp !== "none" && n.w > 0 && n.h > 0;

  // 元素的实际可见度 = 自身 opacity × 所有祖先的 opacity（父级 opacity 会整体乘下来）。
  // 只看子元素自己的 computed opacity 会永远是 1，这正是第一次分析会误判的原因。
  const effOf = (screen, node) => {
    if (!screen || !node) return 0;
    if (node.vis === "hidden" || screen.vis === "hidden") return 0;
    if (node.disp === "none" || node.w <= 0 || node.h <= 0) return 0;
    return +(screen.o * node.o).toFixed(3);
  };

  const timeline = (tl.samples || []).map((s) => {
    const chatNavEff = effOf(s.screenChat, s.chatNav);
    const chatDockEff = effOf(s.screenChat, s.chatDock);
    const sessNavEff = effOf(s.screenSessions, s.sessNav);
    const tabbarEff = s.tabbar ? (s.tabbar.o > 0.02 && s.tabbar.vis !== "hidden" ? s.tabbar.o : 0) : 0;
    const navOverlap = overlaps(s.chatNav, s.sessNav);
    const dockTabbar = overlaps(s.chatDock, s.tabbar);
    return {
      tRel: s.tRel,
      chatActive: s.chatActive, chatLeaving: s.chatLeaving, sessActive: s.sessActive,
      chatScreenOpacity: s.screenChat ? s.screenChat.o : null,
      sessScreenOpacity: s.screenSessions ? s.screenSessions.o : null,
      // 有效可见度（Lead 验收口径用这几个）
      chatNavEffectiveOpacity: chatNavEff,
      chatDockEffectiveOpacity: chatDockEff,
      sessNavEffectiveOpacity: sessNavEff,
      tabbarEffectiveOpacity: tabbarEff,
      tabbarClass: s.tabbar ? s.tabbar.cls : null,
      // 验收项 1：两个导航栏同时可见（>0.05）
      violationNavBoth: !!(chatNavEff > 0.05 && sessNavEff > 0.05),
      // 验收项 2：composerDock 与 tabbar 相交面积
      dockTabbarOverlapPx2: dockTabbar,
      violationDockTabbar: dockTabbar >= 2000,
      // 兼容旧字段（矩形全交叠，不论透明度）
      ghostNav: !!(s.screenChat && s.screenChat.o > 0.02 && s.screenSessions && s.screenSessions.o > 0.02 && navOverlap > 0),
      ghostAreaNavVsSessNav: navOverlap,
      ghostAreaDockVsSessNav: overlaps(s.chatDock, s.sessNav),
    };
  });

  // 切换「真正开始」的时刻：会话页开始可见（或 tabbar 摘掉 is-hidden）
  const navSample = timeline.find((t) => (t.sessScreenOpacity != null && t.sessScreenOpacity > 0.02) || !/is-hidden/.test(t.tabbarClass || ""));
  const navStartMs = navSample ? navSample.tRel : null;

  // 幽灵窗口内的关键时刻帧：更能说明问题的一组证据
  if (navStartMs != null && cands.length) {
    for (const k of NAV_KEYS) {
      const target = navStartMs + k;
      let best = cands[0];
      for (const f of cands) if (Math.abs(f.dtMs - target) < Math.abs(best.dtMs - target)) best = f;
      fs.writeFileSync(path.join(OUT, `before-nav+${String(k).padStart(3, "0")}.png`), Buffer.from(best.data, "base64"));
    }
  }

  // 离场页 opacity 是否「卡住」：取 0.5~0.95 之间连续出现 ≥4 帧且波动 <0.02 的平台
  const chatSeries = timeline.filter((t) => t.chatScreenOpacity != null && t.tRel != null).map((t) => [t.tRel, t.chatScreenOpacity]);
  let chatStall = null;
  for (let i = 0; i + 3 < chatSeries.length; i++) {
    const seg = chatSeries.slice(i, i + 3);
    const vals = seg.map(([, o]) => o);
    if (vals[0] > 0.5 && vals[0] < 0.99 && Math.max(...vals) - Math.min(...vals) < 0.02) {
      // 往后延伸
      let j = i + 3;
      while (j < chatSeries.length && Math.abs(chatSeries[j][1] - vals[0]) < 0.02) j++;
      chatStall = {
        fromMs: seg[0][0], toMs: chatSeries[j - 1][0],
        opacity: +vals[0].toFixed(3),
        durationMs: +(chatSeries[j - 1][0] - seg[0][0]).toFixed(0),
        note: "离场页透明度停在这个值不再下降，随后一次性跳到 0 = 残影停留的主因",
      };
      if (j - i >= 4) break;
      chatStall = null;
    }
  }

  const ghostFrames = timeline.filter((t) => t.ghostNav || t.ghostDock);
  const ghostWindow = ghostFrames.length
    ? { fromMs: Math.min(...ghostFrames.map((t) => t.tRel)), toMs: Math.max(...ghostFrames.map((t) => t.tRel)) }
    : null;

  // 大标题闪烁：会话页标题 opacity 是否经历过「低→高」的跳变
  const sessTitleSeries = timeline.filter((t) => t.sessTitleOpacity != null).map((t) => [t.tRel, t.sessTitleOpacity]);
  let titleFlash = null;
  if (sessTitleSeries.length > 2) {
    const firstStable = sessTitleSeries[sessTitleSeries.length - 1][1];
    const mins = sessTitleSeries.filter(([, o]) => o < firstStable - 0.05);
    if (mins.length) {
      titleFlash = {
        dippedBelow: +Math.min(...mins.map(([, o]) => o)).toFixed(3),
        atMs: mins.slice(0, 5).map(([t, o]) => ({ tRel: t, opacity: o })),
        note: "会话页大标题透明度在返回后先降后升 = 闪一下",
      };
    }
  }

  /* ---- Lead 给的验收口径（重建 after 后自动判定）---- */
  const lastSample = timeline.filter((x) => x.tRel != null).slice(-1)[0] || null;
  const navViolations = timeline.filter((x) => x.tRel != null && x.violationNavBoth);
  const dockViolations = timeline.filter((x) => x.tRel != null && x.violationDockTabbar);
  const maxDockTabbar = timeline.reduce((m, x) => Math.max(m, x.dockTabbarOverlapPx2 || 0), 0);
  const acceptance = {
    criteria: [
      "1) 任意一帧不得同时满足 chat .nav-compact 有效可见度>0.05 且 sessions .nav-large 有效可见度>0.05",
      "2) 任意一帧 composerDock 与 tabbar 相交面积 < 2000 px²",
      "3) 稳定态 chat 页 opacity 必须 = 0",
    ],
    navBothVisible: {
      pass: navViolations.length === 0,
      violatingFrames: navViolations.length,
      windowMs: navViolations.length
        ? { fromMs: Math.min(...navViolations.map((x) => x.tRel)), toMs: Math.max(...navViolations.map((x) => x.tRel)) }
        : null,
    },
    dockTabbarOverlap: {
      pass: maxDockTabbar < 2000,
      maxPx2: +maxDockTabbar.toFixed(0),
      violatingFrames: dockViolations.length,
    },
    finalChatOpacity: {
      pass: !!lastSample && lastSample.chatScreenOpacity === 0,
      value: lastSample ? lastSample.chatScreenOpacity : null,
      atMs: lastSample ? lastSample.tRel : null,
    },
  };
  acceptance.allPass = acceptance.navBothVisible.pass && acceptance.dockTabbarOverlap.pass && acceptance.finalChatOpacity.pass;

  const summary = {
    label: LABEL,
    generatedAt: new Date().toISOString(),
    scenario: "对话页 → 点返回 → 会话页",
    appVersion: await ev(`navigator.userAgent`).then(() => null).catch(() => null),
    framesCaptured: frames.length,
    frameAlignMode: alignMode,
    captureWindowMs: CAPTURE_MS,
    navKeyFrames: NAV_KEYS.map((k) => ({ offsetFromNavStartMs: k, file: `before-nav+${String(k).padStart(3, "0")}.png` })),
    keyFrames: KEYS.map((k) => {
      const cands = frames.filter((f) => f.dtMs != null && f.dtMs >= 0);
      if (!cands.length) return { keyMs: k, file: null };
      let best = cands[0];
      for (const f of cands) if (Math.abs(f.dtMs - k) < Math.abs(best.dtMs - k)) best = f;
      const n = frames.indexOf(best);
      return { keyMs: k, file: `before-${String(k).padStart(3, "0")}.png`, actualFrameDtMs: best.dtMs, frameIndex: n };
    }),
    navStartMs,
    navStartNote: "点返回(pointerdown) → 页面切换真正开始的延迟；这段时间画面完全没动",
    chatOpacityStall: chatStall,
    acceptance,
    ghost: {
      present: ghostFrames.length > 0,
      frameCount: ghostFrames.length,
      windowMs: ghostWindow,
      note: "chat 页与 sessions 页 nav 同时可见且矩形相交 = 残影",
    },
    sessionsTitleFlash: titleFlash,
    timeline,
    frames: saved,
  };
  fs.writeFileSync(path.join(OUT, `navback-${LABEL}.json`), JSON.stringify(summary, null, 2), "utf8");

  /* 6) 打印结论 */
  console.log(`\n=== navback ${LABEL} ===`);
  console.log(`帧数 ${frames.length}  对齐 ${alignMode}`);
  console.log(`关键时刻帧: ${summary.keyFrames.map((k) => `${k.keyMs}ms→${k.actualFrameDtMs}ms(${k.file})`).join("  ")}`);
  console.log(`残影: ${summary.ghost.present ? "有" : "无"}  窗口=${ghostWindow ? `${ghostWindow.fromMs}~${ghostWindow.toMs}ms` : "-"}  帧数=${ghostFrames.length}`);
  console.log(`切换起步延迟(navStart): ${navStartMs == null ? "?" : navStartMs + "ms"}`);
  console.log(`离场页 opacity 停滞: ${chatStall ? `${chatStall.opacity} @ ${chatStall.fromMs}~${chatStall.toMs}ms（${chatStall.durationMs}ms）` : "无"}`);
  console.log(`会话页大标题闪动: ${titleFlash ? `有（最低 ${titleFlash.dippedBelow}）` : "无（标题自身 opacity 不变，随整页淡入）"}`);
  console.log("\n逐帧（tRel | chat页o | chatNav有效o | chatDock有效o | sessNav有效o | tabbar有效o | 双nav违规 | dock∩tabbar px² | tabbarClass）");
  for (const t of timeline) {
    if (t.tRel == null) continue;
    console.log(
      `  ${String(t.tRel).padStart(7)}ms | ${String(t.chatScreenOpacity).padStart(6)} | ${String(t.chatNavEffectiveOpacity).padStart(7)} | ${String(t.chatDockEffectiveOpacity).padStart(8)} | ${String(t.sessNavEffectiveOpacity).padStart(7)} | ${String(t.tabbarEffectiveOpacity).padStart(7)} | ${t.violationNavBoth ? "VIOLATION" : "    .     "} | ${String(t.dockTabbarOverlapPx2).padStart(6)}${t.violationDockTabbar ? " !" : "  "} | ${t.tabbarClass}`
    );
  }
  console.log(`\n验收：${acceptance.allPass ? "PASS" : "FAIL"}`);
  console.log(`  1) nav 双可见: ${acceptance.navBothVisible.pass ? "PASS" : "FAIL"}  违规帧 ${acceptance.navBothVisible.violatingFrames}${acceptance.navBothVisible.windowMs ? ` @${acceptance.navBothVisible.windowMs.fromMs}~${acceptance.navBothVisible.windowMs.toMs}ms` : ""}`);
  console.log(`  2) dock∩tabbar <2000px²: ${acceptance.dockTabbarOverlap.pass ? "PASS" : "FAIL"}  最大 ${acceptance.dockTabbarOverlap.maxPx2}px²`);
  console.log(`  3) 稳定态 chat opacity=0: ${acceptance.finalChatOpacity.pass ? "PASS" : "FAIL"}  ${acceptance.finalChatOpacity.value}`);
  console.log(`\n写入 ${path.join(OUT, `navback-${LABEL}.json`)}`);
  ws.close();
}

main().catch((e) => {
  console.error("[navback] 失败:", e.stack || e.message);
  try { ws && ws.close(); } catch (_) {}
  process.exit(1);
});
