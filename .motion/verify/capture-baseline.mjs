#!/usr/bin/env node
/**
 * capture-baseline.mjs — 改前基线截图 + 环境/静态机制快照
 * =========================================================
 * 通过 CDP 截取 WebView 视口（412x915 CSS / 1080x2400 物理），
 * 每张截图前稳定 600ms。同时收集：WebView 版本、安装包 versionName、
 * Motion 运行时是否存在、各元素的 CSS 过渡时长。
 *
 * 用法：
 *   node .motion/verify/capture-baseline.mjs --label baseline
 *   node .motion/verify/capture-baseline.mjs --label after
 *
 * 输出（--out 默认 .motion/verify/<label>/）：
 *   01-sessions.png  02-chat.png  03-jobs.png  04-files.png
 *   05-settings.png  06-sheet-model.png  07-voice-popover.png  08-swipe-actions.png
 *   measurements.json
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const LABEL = String(arg("label", "baseline"));
const PORT = Number(arg("port", 9223));
const ADB = String(arg("adb", "D:/1/tools/android-sdk/platform-tools/adb.exe"));
const OUT = path.resolve(String(arg("out", path.join(".motion/verify", LABEL))));
const SETTLE = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

/* ---------------- CDP ---------------- */
async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2500) });
  return await r.json();
}

function adb(args) {
  return execFileSync(ADB, args, { encoding: "utf8", timeout: 25000 });
}

async function ensureForward() {
  try {
    const l = await listTargets();
    if (Array.isArray(l) && l.length) return l;
  } catch (_) {}
  for (let i = 0; i < 3; i++) {
    try {
      adb(["start-server"]);
      let serial = "emulator-5554";
      const devs = adb(["devices"]).split(/\r?\n/).filter((l) => /\tdevice$/.test(l.trim()));
      if (devs.length) serial = devs[0].split("\t")[0].trim();
      adb(["-s", serial, "wait-for-device"]);
      const sock = adb(["-s", serial, "shell", "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1"]).trim();
      if (sock) {
        try { adb(["-s", serial, "forward", "--remove", `tcp:${PORT}`]); } catch (_) {}
        adb(["-s", serial, "forward", `tcp:${PORT}`, `localabstract:${sock}`]);
      }
    } catch (_) {}
    await sleep(700);
    try {
      const l = await listTargets();
      if (Array.isArray(l) && l.length) return l;
    } catch (_) {}
  }
  throw new Error("CDP 不可达");
}

let ws, id = 0;
const pend = new Map();
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

/* ---------------- 手势 ---------------- */
const touch = (type, pts) => send("Input.dispatchTouchEvent", { type, touchPoints: pts });
const tap = async (x, y) => { await touch("touchStart", [{ x, y, id: 1 }]); await sleep(45); await touch("touchEnd", []); await sleep(80); };

async function rectOf(sel, scroll = false) {
  return ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    ${scroll ? 'e.scrollIntoView({ block: "center" });' : ""}
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left };
  })()`);
}
async function hitTest(sel, x, y) {
  return ev(`(() => {
    const t = document.querySelector(${JSON.stringify(sel)});
    const h = document.elementFromPoint(${x}, ${y});
    return !!(h && t && (h === t || t.contains(h)));
  })()`);
}
async function tapSel(sel, scroll = true) {
  for (let i = 0; i < 4; i++) {
    const r = await rectOf(sel, scroll);
    if (!r) { await sleep(250); continue; }
    await sleep(320);
    const r2 = (await rectOf(sel)) || r;
    if (await hitTest(sel, r2.x, r2.y)) { await tap(r2.x, r2.y); return true; }
    await sleep(220);
  }
  return false;
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
    if (b) await tap(b.x, b.y);
    await sleep(650);
    cur = await activeScreen();
  }
  if (cur === tab) return;
  await tapSel(`.tab[data-tab="${tab}"]`, false);
  await sleep(700);
}

/* ---------------- 截图 ---------------- */
const shots = [];
async function shot(name) {
  await sleep(SETTLE);              // 每张截图前先稳定 600ms
  const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  const meta = await ev(`({ screen: (document.querySelector(".screen.is-active")||{dataset:{}}).dataset.screen, t: Math.round(performance.now()) })`);
  shots.push({ file: path.basename(file), bytes: fs.statSync(file).size, screen: meta.screen, atMs: meta.t });
  console.log(`  shot ${name}  (${(fs.statSync(file).size / 1024).toFixed(0)} KB, screen=${meta.screen})`);
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const targets = await ensureForward();
  const page = targets.find((p) => p.type === "page") || targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  await send("Runtime.enable");
  await send("Page.enable");
  console.log(`[capture] ${page.url}`);

  /* --- 环境与静态机制 --- */
  const env = await ev(`(() => {
    const cs = (sel, prop) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e); return prop === "transition" ? c.transition : c[prop]; };
    const ua = navigator.userAgent;
    return {
      url: location.href,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      ua,
      chromeVersion: (ua.match(/Chrome\\/([\\d.]+)/) || [])[1] || null,
      motionRuntime: {
        present: !!(window.Motion && typeof window.Motion.springTo === "function"),
        legacy: window.Motion ? !!window.Motion.legacy : null,
        reduced: window.Motion && typeof window.Motion.reduced === "function" ? window.Motion.reduced() : null,
        hasDragApi: !!(window.Motion && typeof window.Motion.drag === "function"),
        presets: window.Motion && window.Motion.presets ? window.Motion.presets : null,
      },
      cssMechanism: {
        tabIndicator: cs("#tabIndicator", "transition"),
        sheet: cs("#sheet", "transition"),
        sheetBackdrop: cs("#sheetBackdrop", "transition"),
        sessionItem: cs(".session-item", "transition"),
        tab: cs(".tab", "transition"),
      },
      counts: {
        sessions: document.querySelectorAll("#sessionsScroll .sess-row").length,
        messages: document.querySelectorAll("#messages > *").length,
        settingsRows: document.querySelectorAll("#screen-settings .row").length,
      },
    };
  })()`);

  /* --- 设备/安装包信息 --- */
  const device = {};
  try {
    const devs = adb(["devices"]).split(/\r?\n/).filter((l) => /\tdevice$/.test(l.trim()));
    device.serial = devs.length ? devs[0].split("\t")[0].trim() : null;
    device.bootCompleted = adb(["-s", device.serial, "shell", "getprop", "sys.boot_completed"]).trim();
    device.android = adb(["-s", device.serial, "shell", "getprop", "ro.build.version.release"]).trim();
    device.sdk = adb(["-s", device.serial, "shell", "getprop", "ro.build.version.sdk"]).trim();
    device.size = adb(["-s", device.serial, "shell", "wm", "size"]).trim();
    device.density = adb(["-s", device.serial, "shell", "wm", "density"]).trim();
    const dumpsys = adb(["-s", device.serial, "shell", "dumpsys", "package", "ai.deepseek.harness.mobile"]);
    device.app = {
      package: "ai.deepseek.harness.mobile",
      versionName: (dumpsys.match(/versionName=(\S+)/) || [])[1] || null,
      versionCode: (dumpsys.match(/versionCode=(\d+)/) || [])[1] || null,
      lastUpdateTime: (dumpsys.match(/lastUpdateTime=([^\n]+)/) || [])[1] || null,
    };
    const wv = adb(["-s", device.serial, "shell", "dumpsys", "webviewupdate"]);
    const m = wv.match(/Current WebView package[^:]*:\s*\(([^,]+),\s*([^)]+)\)/);
    device.webview = m ? { package: m[1].trim(), version: m[2].trim() } : { raw: (wv.split("\n")[0] || "").trim() };
  } catch (e) {
    device.error = e.message;
  }

  /* --- 截图 1: 会话列表 --- */
  await goTab("sessions");
  await shot("01-sessions.png");

  /* --- 截图 2: 对话页（有消息） --- */
  const opened = await tapSel("#recentList .session-item", false);
  if (opened) {
    await sleep(900);
    await shot("02-chat.png");
    const b = await rectOf("#btnBack");
    if (b) { await tap(b.x, b.y); await sleep(700); }
  } else {
    console.log("  !! 打不开会话（列表为空？），跳过对话页");
  }

  /* --- 截图 3/4/5: 任务页 / 文件页 / 设置页 --- */
  await goTab("jobs");
  await shot("03-jobs.png");
  await goTab("files");
  await shot("04-files.png");
  await goTab("settings");
  await ev(`(() => { const s = document.getElementById("screen-settings"); if (s) s.scrollTop = 0; return 1; })()`);
  await shot("05-settings.png");

  /* --- 截图 6: 底部面板（模型） --- */
  await tapSel("#rowModels");
  await sleep(900);
  await shot("06-sheet-model.png");
  const sheetInfo = await ev(`(() => {
    const s = document.getElementById("sheet"), b = document.getElementById("sheetBody");
    return { on: s.classList.contains("is-on"), title: ((b.querySelector(".sheet-title") || {}).textContent || "").trim(),
             items: b.querySelectorAll(".sheet-item").length,
             transform: getComputedStyle(s).transform };
  })()`);
  await closeOverlays();
  await sleep(400);

  /* --- 截图 7: 锚定浮窗（语音音色） --- */
  let popoverInfo = null;
  await goTab("settings");
  const pluginsOpened = await tapSel("#rowPlugins");
  if (pluginsOpened) {
    await sleep(800);
    const hasVoice = await rectOf("#voiceGender");
    if (hasVoice) {
      await tapSel("#voiceGender");
      await sleep(500);
      popoverInfo = await ev(`(() => {
        const p = document.querySelector(".popover");
        if (!p) return { exists: false };
        const r = p.getBoundingClientRect();
        return { exists: true, title: ((p.querySelector(".pop-title") || {}).textContent || "").trim(),
                 items: p.querySelectorAll(".pop-item").length,
                 rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                 transform: getComputedStyle(p).transform, opacity: getComputedStyle(p).opacity };
      })()`);
      await shot("07-voice-popover.png");
    } else {
      console.log("  !! 插件面板里没有 #voiceGender，跳过浮窗截图");
    }
  } else {
    console.log("  !! 打不开 #rowPlugins，跳过浮窗截图");
  }
  await closeOverlays();
  await sleep(400);

  /* --- 截图 8: 会话左滑展开 --- */
  await goTab("sessions");
  await sleep(500);
  const row = await rectOf("#sessionsScroll .sess-row");
  let swipeInfo = null;
  if (row) {
    const y = row.top + row.h / 2;
    const x0 = row.left + row.w * 0.72;
    await touch("touchStart", [{ x: x0, y, id: 1 }]);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", [{ x: x0 - i * 24, y, id: 1 }]); await sleep(16); }
    await touch("touchEnd", []);
    await sleep(900);
    swipeInfo = await ev(`(() => {
      const r = document.querySelector("#sessionsScroll .sess-row");
      const it = r.querySelector(".session-item");
      const acts = [...r.querySelectorAll(".sess-act")].map(a => (a.getAttribute("aria-label") || a.className).slice(0, 20));
      return { isSwiped: r.classList.contains("is-swiped"), transform: getComputedStyle(it).transform, acts };
    })()`);
    await shot("08-swipe-actions.png");
  } else {
    console.log("  !! 找不到会话行，跳过左滑截图");
  }
  await closeOverlays();

  /* --- 落盘 --- */
  const out = {
    label: LABEL,
    generatedAt: new Date().toISOString(),
    device,
    env,
    sheetInfo,
    popoverInfo,
    swipeInfo,
    screenshots: shots,
    note: "截图由 CDP Page.captureScreenshot 截取 WebView 视口，不含系统状态栏；每张前稳定 600ms",
  };
  fs.writeFileSync(path.join(OUT, "measurements.json"), JSON.stringify(out, null, 2), "utf8");
  console.log(`\n[capture] 写入 ${path.join(OUT, "measurements.json")}`);
  console.log(`[capture] ${shots.length} 张截图 → ${OUT}`);
  ws.close();
}

main().catch((e) => {
  console.error("[capture] 失败:", e.message);
  try { ws && ws.close(); } catch (_) {}
  process.exit(1);
});
