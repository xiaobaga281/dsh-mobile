#!/usr/bin/env node
/**
 * stress-pushghost.mjs — 重入压测：快速来回切会话↔对话 20 次
 * 验收：结束后两个 screen 都不残留 is-leaving / visibility:visible / 非预期内联 transform；
 *       最终停在对话页且会话页彻底不可见。
 * 用法：node .motion/verify/stress-pushghost.mjs
 */
import { execFileSync } from "node:child_process";
console.log("[stress] script start");
const ADB = "D:/1/tools/android-sdk/platform-tools/adb.exe";
const PORT = 9224;
const adb = (a) => execFileSync(ADB, a, { encoding: "utf8", timeout: 25000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2500) });
  return await r.json();
}
async function ensureForward() {
  console.log("[stress] ensureForward: trying listTargets");
  try { const l = await listTargets(); if (l?.length) { console.log("[stress] targets ok:", l.length); return l; } } catch (e) { console.log("[stress] listTargets fail:", e.message); }
  for (let i = 0; i < 3; i++) {
    try {
      console.log("[stress] adb start-server");
      adb(["start-server"]);
      const devs = adb(["devices"]).split(/\r?\n/).filter((x) => /\tdevice$/.test(x.trim()));
      const serial = devs.length ? devs[0].split("\t")[0].trim() : "emulator-5554";
      adb(["-s", serial, "wait-for-device"]);
      const sock = adb(["-s", serial, "shell", "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1"]).trim();
      console.log("[stress] sock=", sock);
      if (sock) {
        try { adb(["-s", serial, "forward", "--remove", `tcp:${PORT}`]); } catch (_) {}
        adb(["-s", serial, "forward", `tcp:${PORT}`, `localabstract:${sock}`]);
      }
    } catch (e) { console.log("[stress] adb step fail:", e.message); }
    await sleep(600);
    try { const l = await listTargets(); if (l?.length) { console.log("[stress] targets ok after retry:", l.length); return l; } } catch (_) {}
  }
  throw new Error("CDP 不可达");
}
const targets = await ensureForward();
const page = targets.find((p) => p.type === "page") || targets[0];
console.log("[stress] page target:", page && page.url, page && page.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 15000);
    pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
await new Promise((res, rej) => { ws.addEventListener("open", () => { console.log("[stress] ws open"); res(); }); ws.addEventListener("error", (e) => { console.log("[stress] ws error", e.message || e); rej(e); }); setTimeout(() => { console.log("[stress] ws open timeout"); rej(new Error("ws open timeout")); }, 8000); });
await send("Runtime.enable");
console.log("[stress] runtime enabled");
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(expression.slice(0, 80) + " => " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

console.log("[stress] 页面:", page.url);
/* 确保从会话页起步 */
await ev(`(() => { const a=document.querySelector('.screen.is-active'); if(a&&a.dataset.screen==='chat'){document.getElementById('btnBack')?.click();} return 1; })()`);
await sleep(800);

/* 20 次快速来回：点 + 进对话 → 点返回回会话（不等动画完） */
for (let i = 0; i < 20; i++) {
  await ev(`(() => { const b=document.getElementById('btnNewSession'); if(b) b.click(); return 1; })()`);
  await sleep(90);
  await ev(`(() => { const b=document.getElementById('btnBack'); if(b) b.click(); return 1; })()`);
  await sleep(90);
}
await sleep(1200);   // 等所有收尾定时器（500ms 保险）跑完

const final = await ev(`(() => {
  const out = {};
  for (const s of document.querySelectorAll('.screen')) {
    const cs = getComputedStyle(s);
    out[s.dataset.screen] = {
      leaving: s.classList.contains('is-leaving'),
      active: s.classList.contains('is-active'),
      vis: cs.visibility,
      opacity: cs.opacity,
      inlineT: s.style.transform || '',
      inlineO: s.style.opacity || '',
      inlineV: s.style.visibility || '',
      inlineZ: s.style.zIndex || '',
    };
  }
  const tb = document.getElementById('tabbar');
  out.tabbarHidden = tb ? tb.classList.contains('is-hidden') : null;
  out.tabbarInline = tb ? { t: tb.style.transform || '', o: tb.style.opacity || '' } : null;
  return out;
})()`);
console.log("[stress] 最终状态:", JSON.stringify(final, null, 1));

/* 循环以「返回会话页」结束：终态应为 sessions active、其余全隐藏、全屏无 is-leaving / 无内联残留 */
const clean =
  final.sessions && !final.sessions.leaving && final.sessions.active === true && final.sessions.vis === "visible" && final.sessions.opacity === "1"
  && !final.sessions.inlineT && !final.sessions.inlineO && !final.sessions.inlineV && !final.sessions.inlineZ
  && final.chat && !final.chat.leaving && final.chat.vis === "hidden" && final.chat.opacity === "0"
  && !final.chat.inlineT && !final.chat.inlineO
  && final.jobs && !final.jobs.leaving && !final.jobs.inlineT
  && final.files && !final.files.leaving && !final.files.inlineT
  && final.settings && !final.settings.leaving && !final.settings.inlineT
  && final.tabbarHidden === false && !final.tabbarInline.t;
console.log("[stress] 判定:", clean ? "PASS(无残留)" : "FAIL(有残留)");
ws.close();
process.exit(clean ? 0 : 2);
