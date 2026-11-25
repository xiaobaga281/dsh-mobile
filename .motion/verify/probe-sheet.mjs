#!/usr/bin/env node
/** probe-sheet.mjs — 半屏浮窗下拉把手取证：拖把手时面板到底动不动、事件到没到 */
import { execFileSync } from "node:child_process";

const PORT = 9226;
const ADB = "D:/1/tools/android-sdk/platform-tools/adb.exe";
const adb = (a) => execFileSync(ADB, a, { encoding: "utf8", timeout: 25000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0;
const pend = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 20000);
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

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((p) => p.type === "page") || list[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  await send("Runtime.enable");

  /* 打开额度与用量面板 */
  await ev(`(() => {
    const btn = document.getElementById('rowUsage');
    if (!btn) return 'no-rowUsage';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(700);
  const geo = await ev(`(() => {
    const sh = document.getElementById('sheet');
    const grab = sh && sh.querySelector('.sheet-grab');
    const bd = document.getElementById('sheetBackdrop');
    return {
      sheetOpen: !!(sh && sh.classList.contains('is-on')),
      sheet: sh ? { h: +sh.getBoundingClientRect().height.toFixed(0), top: +sh.getBoundingClientRect().top.toFixed(0) } : null,
      grab: grab ? (() => { const r = grab.getBoundingClientRect(); const i = grab.querySelector('i'); const ri = i ? i.getBoundingClientRect() : null; return { x: +(ri?ri.left:r.left).toFixed(0), y: +(ri?ri.top:r.top).toFixed(0), w: +(ri?ri.width:r.width).toFixed(0), h: +(ri?ri.height:r.height).toFixed(0), touchAction: grab.style.touchAction || getComputedStyle(grab).touchAction }; })() : null,
      title: !!sh.querySelector('.sheet-title'),
      backdrop: bd ? getComputedStyle(bd).opacity : null,
      motionLegacy: window.Motion ? window.Motion.legacy : 'no-motion',
    };
  })()`);
  console.log("GEO:", JSON.stringify(geo));

  /* 注入事件日志 */
  await ev(`(() => {
    window.__EV = [];
    const sh = document.getElementById('sheet');
    ['pointerdown','pointermove','pointerup','pointercancel'].forEach(t =>
      sh.addEventListener(t, (e) => window.__EV.push({ t, tgt: (e.target.className||'').toString().slice(0,30), y: e.clientY, id: e.pointerId })));
    return 'ok';
  })()`);

  /* 从把手中心往下拖 160px */
  const gx = geo.grab.x + geo.grab.w / 2, gy = geo.grab.y + geo.grab.h / 2;
  const samples = [];
  await touch("touchStart", [{ x: gx, y: gy, id: 7 }]);
  await sleep(80);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [{ x: gx, y: gy + 20 * i, id: 7 }]);
    await sleep(24);
    if (i % 2 === 0) {
      samples.push(await ev(`(() => {
        const sh = document.getElementById('sheet');
        const tr = getComputedStyle(sh).transform;
        return { tr: tr.slice(0, 60), top: +sh.getBoundingClientRect().top.toFixed(0) };
      })()`));
    }
  }
  await touch("touchEnd", []);
  await sleep(500);
  const evs = await ev(`(window.__EV || []).slice(0, 30)`);
  const endState = await ev(`(() => {
    const sh = document.getElementById('sheet');
    return { open: sh.classList.contains('is-on'), top: +sh.getBoundingClientRect().top.toFixed(0) };
  })()`);
  console.log("SAMPLES:", JSON.stringify(samples));
  console.log("EVENTS:", JSON.stringify(evs));
  console.log("END:", JSON.stringify(endState));
  process.exit(0);
}
main().catch((e) => { console.error("ERR", e.message); process.exit(2); });
