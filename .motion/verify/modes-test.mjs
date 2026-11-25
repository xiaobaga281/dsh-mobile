// 退化路径测试：node modes-test.mjs [legacy|reduce]
import { execFileSync } from "node:child_process";
const MODE = process.argv[2] || "legacy";
const ADB = "D:/1/tools/android-sdk/platform-tools/adb.exe";
const PORT = 9225;
const adb = (a) => execFileSync(ADB, a, { encoding: "utf8", timeout: 25000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2500) });
  return await r.json();
}
async function ensureForward() {
  try { const l = await listTargets(); if (l?.length) return l; } catch (_) {}
  for (let i = 0; i < 4; i++) {
    try {
      adb(["start-server"]);
      const devs = adb(["devices"]).split(/\r?\n/).filter((x) => /\tdevice$/.test(x.trim()));
      const serial = devs.length ? devs[0].split("\t")[0].trim() : "emulator-5554";
      adb(["-s", serial, "wait-for-device"]);
      const sock = adb(["-s", serial, "shell", "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1"]).trim();
      if (sock) {
        try { adb(["-s", serial, "forward", "--remove", `tcp:${PORT}`]); } catch (_) {}
        adb(["-s", serial, "forward", `tcp:${PORT}`, `localabstract:${sock}`]);
      }
    } catch (_) {}
    await sleep(700);
    try { const l = await listTargets(); if (l?.length) return l; } catch (_) {}
  }
  throw new Error("CDP 不可达");
}
const targets = await ensureForward();
const page = targets.find((p) => p.type === "page") || targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 15000);
  pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
await new Promise((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", rej); setTimeout(() => rej(new Error("ws timeout")), 8000); });
await send("Runtime.enable");
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

console.log(`[modes:${MODE}] 加载 ?motion=${MODE}`);
await send("Page.enable");
await ev(`location.href = 'https://appassets.androidplatform.net/assets/web/index.html?theme=dark&motion=${MODE}'`);
await sleep(2500);
const loaded = await ev(`(() => ({ url: location.href, modern: typeof MOTION_MODERN !== 'undefined' ? MOTION_MODERN : null, reduce: typeof MOTION_REDUCE === 'function' ? MOTION_REDUCE() : null }))()`);
console.log(`[modes:${MODE}] 加载结果:`, JSON.stringify(loaded));

/* 来回切 3 次 */
for (let i = 0; i < 3; i++) {
  await ev(`(() => { const b=document.getElementById('btnNewSession'); if(b) b.click(); return 1; })()`);
  await sleep(500);
  await ev(`(() => { const b=document.getElementById('btnBack'); if(b) b.click(); return 1; })()`);
  await sleep(500);
}
await sleep(800);
const st = await ev(`(() => {
  const out = {};
  for (const s of document.querySelectorAll('.screen')) {
    out[s.dataset.screen] = { leaving: s.classList.contains('is-leaving'), vis: getComputedStyle(s).visibility, o: getComputedStyle(s).opacity, t: s.style.transform || '' };
  }
  return out;
})()`);
console.log(`[modes:${MODE}] 终态:`, JSON.stringify(st));
const clean = Object.values(st).every((s) => !s.leaving && !s.t);
const ok = clean && st.sessions.vis === "visible" && st.chat.vis === "hidden";
console.log(`[modes:${MODE}] 判定:`, ok ? "PASS" : "FAIL");
ws.close();
process.exit(ok ? 0 : 2);
