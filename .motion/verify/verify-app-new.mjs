// 端到端：app_new（脚手架）→ app_build（编译）→ app_install（安装）→ 启动 → 翻页
// 用法：node .motion/verify/verify-app-new.mjs [dir] [pkg] [label] [activities]
import { execFileSync } from "node:child_process";
import { openSync } from "node:fs";

const PORT = 9227;
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DIR = ARGS[0] || "hello";
const PKG = ARGS[1] || "com.dsh.hello";
const LABEL = ARGS[2] || "手机造的应用";
const ACTIVITIES = Number(ARGS[3] || 2);

const REUSE = process.argv.includes("--reuse");
const shot = (name) => execFileSync("adb", ["exec-out", "screencap", "-p"], { stdio: ["ignore", openSync(`.motion/verify/${name}`, "w"), "ignore"] });
// adb shell 的非零退出（pm uninstall 没装过、am force-stop 没进程…）不该让脚本崩，按输出继续判定
const sh = (cmd) => {
  try {
    return execFileSync("adb", ["shell", cmd], { encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
};
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 160) : ""}`);

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
// 页面被重载/进程重启时 socket 会关；不处理就会卡在 pending 的 Promise 上（顶层 await 悬空）
let wsClosed = false;
ws.addEventListener("close", () => { wsClosed = true; });
const ev = async (expr) => {
  if (wsClosed) return undefined;
  return (await send("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN = Date.now().toString(36);

/** 装一次结果收集钩子；页面被重载过就重装 */
async function hook() {
  await ev(`window.__n = { r: {} }; window.DSHHost.onToolResult = (id, r) => { window.__n.r[id] = r; }; 1`);
}

await hook();
let seq = 0;
async function call(name, args, timeoutMs = 300000, onTick = null) {
  // id 必须全局唯一：内核按 id 去重（重复 id 会被静默丢弃），复用会让调试看起来像"卡死"
  const cid = `${name}-${RUN}-${++seq}`;
  await ev(`window.DSHNativeKernel.toolCall(${JSON.stringify(cid)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}); 1`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(400);
    if (onTick) await onTick();
    const r = await ev(`window.__n.r[${JSON.stringify(cid)}] || null`);
    if (r != null) {
      const outer = JSON.parse(r);
      // 工具自身返回的 JSON 被注册表包在 output 里，这里解一层
      if (outer && typeof outer.output === "string" && outer.output.startsWith("{")) {
        try { return { ...outer, ...JSON.parse(outer.output) }; } catch (_) {}
      }
      return outer;
    }
  }
  return { ok: false, error: "timeout" };
}

// 预热：装机首启后页面可能整体重载一次，钩子会随之丢失；先探一次，必要时重挂
let ready = await call("read", { file_path: "diag1/AndroidManifest.xml" }, 20000);
if (ready.error === "timeout" || ready.ok === false) {
  console.log("  (首调无响应，重载页面并重挂钩子)");
  await send("Page.reload", {});
  await sleep(7000);
  await hook();
  ready = await call("read", { file_path: "diag1/AndroidManifest.xml" }, 20000);
}
ok(!!ready.ok, "内核就绪（预热读文件）", JSON.stringify(ready).slice(0, 80));

// ---------- 1) 脚手架 ----------
if (REUSE) {
  console.log("(--reuse：跳过 app_new / app_build，直接验证安装与启动)");
} else {
const t0 = Date.now();
const made = await call("app_new", {
  description: "生成演示工程",
  dir: DIR,
  package: PKG,
  label: LABEL,
  activities: ACTIVITIES,
  color: "#2E7D6F",
  force: true,
});
ok(made.ok, "app_new 生成工程", `文件 ${made.files} 个 / 包名 ${made.package} / 页面 ${made.activities} / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!made.ok) { console.log(JSON.stringify(made)); process.exit(1); }

const files = sh(`find /data/data/ai.deepseek.harness.mobile/files/workspace/${DIR} -type f | head -40`);
ok(/AndroidManifest\.xml/.test(files) && /MainActivity\.java/.test(files) && /ic_launcher\.png/.test(files),
  "目录结构齐全（清单/源码/图标）", files.replace(/\n/g, " ").slice(0, 140));

// 图标 PNG 头校验（89 50 4E 47）+ 体积
const pngs = sh(`cd /data/data/ai.deepseek.harness.mobile/files/workspace/${DIR}/res && for f in mipmap-*/ic_launcher.png; do echo -n "$f "; stat -c %s $f; done`);
const pngOk = /\d+/.test(pngs) && sh(`head -c 4 /data/data/ai.deepseek.harness.mobile/files/workspace/${DIR}/res/mipmap-xxhdpi/ic_launcher.png | od -An -tx1`).includes("89 50 4e 47");
ok(pngOk, "五档 PNG 图标已生成且魔数正确", pngs.replace(/\n/g, " | "));

}

// ---------- 2) 打包 ----------
const tb = Date.now();
const built = REUSE ? { ok: true, bytes: -1 } : await call("app_build", { description: "编译演示工程", dir: DIR, out: `${DIR}.apk` });
ok(built.ok, "app_build 打包成功", built.ok ? `${built.bytes} bytes / ${((Date.now() - tb) / 1000).toFixed(0)}s` : JSON.stringify(built).slice(0, 300));
if (!built.ok) process.exit(1);

// ---------- 3) 安装（自动确认系统弹窗） ----------
const confirmed = async () => {
  const focus = sh("dumpsys window | grep mCurrentFocus | head -1");
  if (/packageinstaller/i.test(focus)) {
    sh("uiautomator dump /sdcard/u.xml >/dev/null 2>&1");
    const xml = sh("cat /sdcard/u.xml");
    const m = [...xml.matchAll(/text="(安装|Install|INSTALL|更新|Update)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)][0];
    if (m) {
      const x = Math.round((+m[2] + +m[4]) / 2);
      const y = Math.round((+m[3] + +m[5]) / 2);
      sh(`input tap ${x} ${y}`);
      console.log(`  (已点系统安装按钮 @${x},${y})`);
    }
  }
};
sh(`pm uninstall ${PKG} >/dev/null 2>&1; appops set ai.deepseek.harness.mobile REQUEST_INSTALL_PACKAGES allow`);
const inst = await call("app_install", { description: "安装演示应用", file: `${DIR}.apk`, timeoutMs: 180000 }, 240000, confirmed);
ok(inst.ok, "app_install 安装成功", inst.output || JSON.stringify(inst).slice(0, 200));
const listed = sh(`pm list packages ${PKG}`).trim();
ok(listed.includes(PKG), "系统里出现该包", listed);

// ---------- 4) 启动 + 翻页 ----------
sh(`am force-stop ${PKG}; am start -n ${PKG}/.MainActivity >/dev/null 2>&1`);
let focus1 = "";
for (let i = 0; i < 15; i++) {
  await sleep(1500);
  focus1 = sh("dumpsys window | grep mCurrentFocus | head -1");
  if (focus1.includes(PKG)) break;
}
ok(focus1.includes(PKG), "应用已在前台", focus1.trim());
shot("screen-app-new-1.png");

if (ACTIVITIES > 1) {
  // 点中间那颗按钮（页面只有一个按钮时它位于竖直方向 60% 左右，这里用无障碍文本定位更稳）
  sh("uiautomator dump /sdcard/u2.xml >/dev/null 2>&1");
  const xml2 = sh("cat /sdcard/u2.xml");
  const btn = [...xml2.matchAll(/text="([^"]*)"[^>]*class="android\.widget\.Button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)][0]
    || [...xml2.matchAll(/class="android\.widget\.Button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)].map((m) => [m[0], "", m[1], m[2], m[3], m[4]])[0];
  if (btn) {
    const x = Math.round((+btn[btn.length - 4] + +btn[btn.length - 2]) / 2);
    const y = Math.round((+btn[btn.length - 3] + +btn[btn.length - 1]) / 2);
    sh(`input tap ${x} ${y}`);
    await sleep(2500);
    const top = sh("dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | head -2");
    ok(top.includes("SecondActivity"), "翻页到 SecondActivity", top.trim());
    shot("screen-app-new-2.png");
  } else {
    ok(false, "找不到页面按钮", xml2.slice(0, 160));
  }
}

console.log("\n截图：.motion/verify/screen-app-new-1.png / -2.png");
process.exit(0);
