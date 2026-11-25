#!/usr/bin/env node
/**
 * seed-local-sessions.mjs — 给动效测量准备「本地会话」测试夹具
 * =============================================================
 * 为什么需要：这个 App 的「会话列表」在 local 模式下来自
 *   localStorage["dsh.local.sessions"]（app.js 的 LocalDB）。
 * 装 debug 包必须先卸载正式包（签名不同），app 数据被清空 → 列表恒为空
 *   → 左滑(PressDismiss) 与按压反馈这两个指标没有可测目标。
 *
 * 本脚本只是按 app.js 里 LocalDB.create()/push() 的**同一份结构**写入夹具，
 * 不动任何 Web 资源；页面刷新后由 app 自己的 localSessionView() 渲染成真实的
 * .sess-row，不是伪造 DOM。
 *
 * ⚠️ 写入的会话标题统一带 "probe-fixture" 前缀，便于和真实数据区分。
 *
 * 用法：
 *   node .motion/verify/seed-local-sessions.mjs            # 写入夹具
 *   node .motion/verify/seed-local-sessions.mjs --clear    # 清掉夹具（保留其它会话）
 *   node .motion/verify/seed-local-sessions.mjs --list     # 只看当前有什么
 */

import { execFileSync } from "node:child_process";

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes("--" + n);
const PORT = Number(arg("port", 9223));
const ADB = String(arg("adb", "D:/1/tools/android-sdk/platform-tools/adb.exe"));
const PREFIX = "probe-fixture";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (a) => execFileSync(ADB, a, { encoding: "utf8", timeout: 25000 });

async function ensureForward() {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
    if (l?.length) return l;
  } catch (_) {}
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
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      if (l?.length) return l;
    } catch (_) {}
  }
  throw new Error("CDP 不可达");
}

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

/** 按 LocalDB 的结构生成夹具：id/title/createdAt/updatedAt/ws/messages/tokens */
function makeFixtures() {
  const now = Date.now();
  const mk = (minutesAgo, title, msgs) => ({
    id: "lprobe" + (now - minutesAgo * 60000).toString(36),
    title,
    createdAt: now - minutesAgo * 60000,
    updatedAt: now - minutesAgo * 60000 + 120000,
    ws: "harness",
    messages: msgs.map((m, i) => ({
      role: m.role,
      content: m.content,
      at: now - minutesAgo * 60000 + i * 30000,
      ...(m.role === "assistant" ? { tokens: 128 + i * 37 } : {}),
    })),
    tokens: 265,
  });
  return [
    mk(3, PREFIX + " · 会话 A", [
      { role: "user", content: "夹具：用于左滑与按压测量，请忽略这条内容。" },
      { role: "assistant", content: "收到。这是一条用于验证消息气泡布局的助手回复，长度中等，包含若干中文与 English words，用来让气泡换行。" },
      { role: "user", content: "再补一条短消息，让列表预览有两行不同长度。" },
      { role: "assistant", content: "好的，这是第二条回复。\n\n- 列表项一\n- 列表项二\n- 列表项三" },
    ]),
    mk(18, PREFIX + " · 会话 B", [
      { role: "user", content: "夹具：第二条会话，用于验证列表多项时的左滑互斥收起。" },
      { role: "assistant", content: "明白，这是第二条夹具会话的回复。" },
    ]),
    mk(47, PREFIX + " · 会话 C", []),
  ];
}

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

  const KEY = "dsh.local.sessions";

  if (flag("list")) {
    const cur = await ev(`(() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) || "[]"); } catch (e) { return { err: String(e) }; } })()`);
    console.log(JSON.stringify(cur, null, 2));
    ws.close();
    return;
  }

  if (flag("clear")) {
    const n = await ev(`(() => {
      const KEY = ${JSON.stringify(KEY)};
      let list = [];
      try { list = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { list = []; }
      const before = list.length;
      list = list.filter((s) => !String(s.title || "").startsWith(${JSON.stringify(PREFIX)}));
      localStorage.setItem(KEY, JSON.stringify(list));
      return { before, after: list.length, removed: before - list.length };
    })()`);
    console.log("clear:", JSON.stringify(n));
    await ev(`location.reload()`).catch(() => {});
    console.log("已刷新页面");
    ws.close();
    return;
  }

  // 幂等：先删同前缀旧夹具，再写新的
  const fixtures = makeFixtures();
  const res = await ev(`(() => {
    const KEY = ${JSON.stringify(KEY)};
    const fixtures = ${JSON.stringify(fixtures)};
    let list = [];
    try { list = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    list = list.filter((s) => !String(s.title || "").startsWith(${JSON.stringify(PREFIX)}));
    const merged = fixtures.concat(list);
    localStorage.setItem(KEY, JSON.stringify(merged));
    return { written: fixtures.length, total: merged.length };
  })()`);
  console.log("seed:", JSON.stringify(res));

  await ev(`location.reload()`).catch(() => {});
  await sleep(3500);

  const check = await ev(`(() => ({
    rows: document.querySelectorAll("#sessionsScroll .sess-row").length,
    titles: [...document.querySelectorAll("#sessionsScroll .sess-row .s-title")].map((e) => e.textContent.trim()),
    subs: [...document.querySelectorAll("#sessionsScroll .sess-row .s-sub")].map((e) => e.textContent.trim().slice(0, 30)),
  }))()`).catch((e) => ({ error: e.message }));
  console.log("页面里的会话行:", JSON.stringify(check, null, 1));
  ws.close();
}

main().catch((e) => {
  console.error("[seed] 失败:", e.message);
  try { ws && ws.close(); } catch (_) {}
  process.exit(1);
});
