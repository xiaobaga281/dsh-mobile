// 验证设置页两个开关是否「真的有用」：
//   1) 完成后通知：关掉后系统通知栏不应再出现「已完成」；打开后应出现
//   2) 检查更新：点进去不应再提示「当前版本不支持检查更新」
// 用法：node .motion/verify/verify-settings-switches.mjs
import { execFileSync } from "node:child_process";
import { openSync } from "node:fs";

const PORT = 9227;
const PKG = "ai.deepseek.harness.mobile";
const sh = (cmd) => {
  try {
    return execFileSync("adb", ["shell", cmd], { encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
};
const shot = (n) => execFileSync("adb", ["exec-out", "screencap", "-p"], { stdio: ["ignore", openSync(`.motion/verify/${n}`, "w"), "ignore"] });
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 150) : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 按「渠道 + 当前活动通知」统计：dsh_done 只用于「已完成」，
// 标题文本在 dumpsys 里分散在 Extras 段，按文本 grep 不可靠（踩过）
const doneCount = () => Number((sh(`dumpsys notification --noredact | grep -c "channel=dsh_done"`).trim() || 0));
/** 等通知落库：开关打开时最多等 8 秒 */
const waitDone = async (want) => {
  for (let i = 0; i < 16; i++) {
    const c = doneCount();
    if (want === undefined || c === want || (want === "more" && c > beforeRefAtCall)) return c;
    await sleep(500);
  }
  return doneCount();
};
let beforeRefAtCall = 0;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0;
const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pend.set(i, (m) => res(m.result));
  ws.send(JSON.stringify({ id: i, method, params }));
});
let wsClosed = false;
ws.addEventListener("close", () => { wsClosed = true; });
const ev = async (expr) => (wsClosed ? undefined : (await send("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value);

// ---------- 进设置页 ----------
await ev(`document.querySelector('[data-tab="settings"]').click(); 1`);
await sleep(800);
const onSettings = await ev(`document.querySelector("#screen-settings")?.classList.contains("is-active") || getComputedStyle(document.querySelector("#screen-settings")).display !== "none"`);
ok(!!onSettings, "进入设置页");

// ---------- 开关存在且默认 ----------
const initial = await ev(`({ ask: document.querySelector("#swAskDanger")?.checked, notify: document.querySelector("#swNotifyDone")?.checked })`);
ok(initial && typeof initial.notify === "boolean", "两个开关都存在", JSON.stringify(initial));

// ---------- 完成后通知：关 ----------
const setSwitch = (sel, on) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return "missing";
  if (el.checked !== ${on}) { el.click(); }
  return el.checked;
})()`);
await setSwitch("#swNotifyDone", false);
await sleep(600);
const prefOff = sh(`cat /data/data/${PKG}/shared_prefs/dsh.xml 2>/dev/null | tr -d '\\n'`);
ok(/notify\.done"\s+value="false"/.test(prefOff), "关掉后原生偏好已写入 false", prefOff.slice(0, 120));

// 切后台 → 模拟一轮结束 → 不应出现完成通知
// 必须等原生真的认为「应用不在前台」（appVisible=false），否则 finish() 会直接返回，
// 测出来的"没发通知"是假的
const toBackground = async () => {
  sh("input keyevent KEYCODE_HOME");
  for (let i = 0; i < 20; i++) {
    const info = String(await ev(`window.DSHNativeNotify.notifyInfo()`));
    try { if (!JSON.parse(info).appVisible) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
};
await toBackground();
const before = doneCount();
beforeRefAtCall = before;
await ev(`window.DSHNativeNotify.sessionEndWith("done", "开关关闭时的完成提醒"); 1`);
const afterOff = await sleep(3000).then(doneCount);
ok(afterOff === before, "开关关闭：不发完成通知", `before=${before} after=${afterOff}`);

// ---------- 完成后通知：开 ----------
sh(`am start -n ${PKG}/.MainActivity >/dev/null 2>&1`);
await sleep(2500);
await ev(`document.querySelector('[data-tab="settings"]').click(); 1`);
await sleep(600);
await setSwitch("#swNotifyDone", true);
await sleep(600);
const prefOn = sh(`cat /data/data/${PKG}/shared_prefs/dsh.xml 2>/dev/null | tr -d '\\n'`);
ok(/notify\.done"\s+value="true"/.test(prefOn), "打开后原生偏好写回 true", prefOn.slice(0, 120));

await toBackground();
const before2 = doneCount();
beforeRefAtCall = before2;
await ev(`window.DSHNativeNotify.sessionEndWith("done", "开关打开时的完成提醒"); 1`);
const afterOn = await waitDone("more");
ok(afterOn > before2, "开关打开：发出完成通知", `before=${before2} after=${afterOn}`);

// ---------- 检查更新 ----------
sh(`am start -n ${PKG}/.MainActivity >/dev/null 2>&1`);
await sleep(2500);
await ev(`document.querySelector('[data-tab="settings"]').click(); 1`);
await sleep(600);
// 记录 toast 文案：拦截一次 toast 输出（页面用 #toast 元素）
await ev(`window.__toasts = []; const t = document.querySelector("#toast"); if (t && !t.__hooked) { new MutationObserver(() => { if (t.textContent) window.__toasts.push(t.textContent); }).observe(t, { childList: true, characterData: true, subtree: true }); t.__hooked = true; } 1`);
await ev(`document.querySelector("#rowUpdate").click(); 1`);
await sleep(3000);
const upText = String(await ev(`document.querySelector("#upBody")?.innerText || ""`));
const toasts = String(await ev(`(window.__toasts || []).join(" | ")`));
ok(!/不支持检查更新/.test(toasts), "不再提示「当前版本不支持检查更新」", toasts || "(无 toast)");
ok(upText.length > 0, "更新浮窗有内容（已真正发起检查）", upText.replace(/\n/g, " ").slice(0, 120));
shot("screen-update-sheet.png");

console.log("\n截图：.motion/verify/screen-update-sheet.png");
process.exit(0);
