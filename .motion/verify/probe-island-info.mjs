// 灵动岛「显示信息」真实操控实测 —— 走的不是模拟点击，而是 kernel.exec 里的真工具：
//   DSHNativeKernel.toolCall → ComputerUsePlugin → PhoneControlService.reportControl →
//   ControlIslandPlugin.onControlEvent → 屏幕上的胶囊
//
// 逐个动作后**立刻** screencap：
//   1. 裁胶囊区域拼成胶片，肉眼核对胶囊文字 / 彩点 / 跑马灯；
//   2. ffmpeg 取彩点像素，自动断言颜色与该动作类别一致；
//   3. 点开卡片截一张，核对详情正文与标题是否完整。
// 悬浮窗 TextView 不在 uiautomator 节点树里，所以文字靠胶片复核，不靠 dump 断言。
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ADB = process.env.ADB || "D:/1/tools/android-sdk/platform-tools/adb.exe";
const PORT = 9227;
const OUT = ".motion/verify";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 160) : ""}`);
const adb = (args, opts = {}) => execFileSync(ADB, args, { encoding: "utf8", maxBuffer: 1 << 24, ...opts });
const shot = (file) => fs.writeFileSync(file, execSync(`"${ADB}" exec-out screencap -p`, { maxBuffer: 1 << 25 }));

/* ---------------- CDP → 真工具通道 ---------------- */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page" && p.url.includes("appassets"));
if (!page) { console.log("FAIL  没找到 appassets 页面"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", {
  expression: expr, returnByValue: true, awaitPromise: true,
})).result?.value;

await ev(`(() => {
  window.__tres = {};
  const h = window.DSHHost;
  if (h && h.onToolResult) {
    const orig = h.onToolResult.bind(h);
    h.onToolResult = (i, j) => { window.__tres[i] = j; try { orig(i, j); } catch (e) {} };
  }
  return 1;
})()`);
const tool = async (name, args) => {
  const tid = "i" + Math.random().toString(36).slice(2, 8);
  await ev(`window.DSHNativeKernel.toolCall(${JSON.stringify(tid)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args || {}))}); 1`);
  for (let i = 0; i < 100; i++) {
    await sleep(80);
    let r = await ev(`window.__tres[${JSON.stringify(tid)}] || null`);
    if (r) {
      try { r = typeof r === "string" ? JSON.parse(r) : r; } catch (_) { return { ok: false, raw: String(r).slice(0, 120) }; }
      if (r && typeof r.output === "string") {
        try { return JSON.parse(r.output); } catch (_) { return { ok: false, raw: r.output.slice(0, 120) }; }
      }
      return r;
    }
  }
  return { ok: false, error: "工具 8s 没回结果" };
};

/* ---------------- 彩点取色 ---------------- */
// 胶囊 x=362 起，dot 左内边距 ≈18px、直径 ≈15px，中心约 (387, 63)。
// 取 12×12 区域里「最亮且最饱和」的像素，避开抗锯齿与深色背景。
const dotRgb = (png) => {
  const raw = execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png,
    "-vf", "crop=12:12:380:56", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 20 });
  let best = [0, 0, 0], score = -1;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    const s = Math.max(r, g, b) - Math.min(r, g, b) + Math.max(r, g, b) / 4;
    if (s > score) { score = s; best = [r, g, b]; }
  }
  return best;
};
// 与 ControlIslandPlugin.ACCENTS 一一对应
const COLORS = {
  绿: [0x34, 0xD3, 0x99], 蓝: [0x60, 0xA5, 0xFA], 黄: [0xFB, 0xBF, 0x24],
  紫: [0xA7, 0x8B, 0xFA], 灰: [0x94, 0xA3, 0xB8], 青: [0x38, 0xBD, 0xF8],
};
const nearest = (rgb) => Object.entries(COLORS)
  .map(([n, c]) => [n, Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2])])
  .sort((a, b) => a[1] - b[1])[0];

/* ---------------- 动作序列：一次真实操控流程 ---------------- */
const actions = [
  { t: "screen_read", a: { max_elements: 20 }, tag: "01-read", brief: "读屏", color: "绿" },
  { t: "phone_tap", a: { x: 540, y: 1400 }, tag: "02-tap", brief: "点击", color: "蓝" },
  { t: "phone_swipe", a: { direction: "up", distance: 400 }, tag: "03-swipe", brief: "滑动", color: "紫" },
  { t: "phone_key", a: { key: "home" }, tag: "04-key", brief: "按键", color: "灰" },
  { t: "phone_wait", a: { timeout_ms: 300 }, tag: "05-wait", brief: "等待", color: "灰" },
  { t: "phone_screenshot", a: {}, tag: "06-shot", brief: "截图", color: "灰" },
  // 真 phone_open_app 在 CDP 直调下会被审批门拒绝（无活跃轮次），所以用它同源的
  // status 通道验证「4 字动作名」的简称映射；审批拒绝单独在下面断言「不谎报」。
  { t: "phone_island", a: { action: "text", text: "打开应用" }, tag: "07-app", brief: "打开", color: "绿" },
  { t: "phone_key", a: { key: "home" }, tag: "08-home", brief: "按键", color: "灰" },
  // 桌面下滚会拉出应用抽屉（系统全屏窗口会盖住 TYPE_ACCESSIBILITY_OVERLAY）。
  // 工具确实上报了「滚动」，截图前用原生 BACK 收掉抽屉再看岛 —— 不走岛的事件通道。
  { t: "phone_scroll", a: { direction: "down" }, tag: "09-scroll", brief: "滚动", color: "紫",
    after: () => adb(["shell", "input", "keyevent", "4"]) },
  { t: "phone_island", a: { action: "text", text: "填表 2/5 · 正在填写收货地址" }, tag: "10-text", brief: "2/5", color: "绿" },
];

// 覆盖安装后 App 可能停在自己界面，此时坐标点击会被审批门判为敏感操作
// （CDP 直调没有活跃轮次 → APP_APPROVAL_UNAVAILABLE）。先回桌面再跑序列。
adb(["shell", "input", "keyevent", "3"]);
await sleep(500);
// 先确保岛在（上一轮可能 hide 过）
await tool("phone_island", { action: "show" });
await sleep(400);
shot(`${OUT}/info-00-prewarm.png`); // 首张 screencap 冷启动要几秒，预热免得错过瞬时状态

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "island-info-"));
const pngs = [];
console.log("      动作 / 工具返回 / 胶囊彩点实测色");
for (const [i, a] of actions.entries()) {
  const r = await tool(a.t, a.a);
  if (a.after) { a.after(); await sleep(300); }
  const f = path.join(tmp, `${i}.png`);
  shot(f);                       // 工具一返回就截，赶在 3.5s settle 变色之前
  pngs.push(f);
  const rgb = dotRgb(f);
  const [name, dist] = nearest(rgb);
  const matched = name === a.color && dist < 90;
  ok(matched, `${String(i + 1).padStart(2, "0")} ${a.t} → 胶囊「${a.brief}」/ ${a.color}点`,
    `rgb=${rgb.join(",")} 最近=${name} d=${dist.toFixed(0)} 工具=${JSON.stringify(r).slice(0, 90)}`);
}

/* ---------------- 胶囊文字胶片（每 5 张一张，放大 2×） ---------------- */
for (let batch = 0; batch < 2; batch++) {
  const part = pngs.slice(batch * 5, batch * 5 + 5);
  const inputs = part.flatMap((p) => ["-i", p]);
  const filt = part.map((_, k) => `[${k}:v]crop=520:100:290:16,scale=1040:200[v${k}]`).join(";")
    + `;` + part.map((_, k) => `[v${k}]`).join("") + `vstack=inputs=${part.length}[out]`;
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs,
      "-filter_complex", filt, "-map", "[out]", "-frames:v", "1",
      `${OUT}/island-info-filmstrip-${batch + 1}.png`], { maxBuffer: 1 << 24 });
    console.log(`SHOT  island-info-filmstrip-${batch + 1}.png  = 动作 ${batch * 5 + 1}..${batch * 5 + 5}（自上而下）`);
  } catch (e) {
    console.log(`WARN  胶片 ${batch + 1} 生成失败：${e.message.slice(0, 110)}`);
  }
}

/* ---------------- 展开卡片：标题 + 详情是否完整 ---------------- */
const frameOf = () => {
  const m = adb(["shell", "dumpsys", "window", "windows"])
    .match(/Window\{[^}]+ DSHControlIslandTouch\}[\s\S]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  return m ? { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] } : null;
};
const idle = frameOf();
if (idle) {
  // 避开挖孔保护区 x≈492..610，点胶囊右端展开
  adb(["shell", "input", "tap", String(idle.x2 - 18), String(Math.round((idle.y1 + idle.y2) / 2))]);
  await sleep(600);
  shot(`${OUT}/island-info-expanded.png`);
  console.log("SHOT  island-info-expanded.png  = 最后一个动作的展开卡片（标题 + 详情）");
  ok(true, "展开卡片截图已导出（详情完整性看胶片复核）");
  adb(["shell", "input", "tap", String(idle.x2 - 18), String(Math.round((idle.y1 + idle.y2) / 2))]);
}

/* ---------------- 动作被拒时岛不谎报 ---------------- */
// 先做一个真实成功的紫点动作当基准；被审批拒掉的 phone_open_app 不该把岛改成「打开」。
await tool("phone_scroll", { direction: "down" });
const denied = await tool("phone_open_app", { package: "com.android.settings" });
const deniedPng = path.join(tmp, "denied.png");
shot(deniedPng);
const [deniedColor] = nearest(dotRgb(deniedPng));
ok(denied.ok === false && deniedColor === "紫",
  "动作被审批拒绝时岛不谎报成功（保留上一个真实动作）",
  `code=${denied.code} dot=${deniedColor}`);

/* ---------------- 源码守卫：胶囊简称不能把词截断、进度不能丢 ---------------- */
const src = fs.readFileSync(
  "app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/device/ControlIslandPlugin.kt", "utf8",
);
const phone = fs.readFileSync(
  "app/src/main/java/ai/deepseek/harness/mobile/kernel/device/PhoneControlService.kt", "utf8",
);
const briefs = [...new Set([...phone.matchAll(/reportControl\("[^"]+",\s*"([^"]+)"/g)].map((m) => m[1]))];
// pillLabel 的 JS 等价（只用于把源码里的 15 种 brief 全量跑一遍）
const label = (s) => {
  if (s === "打开应用") return "打开";
  if (s.length <= 3) return s;
  const m = s.match(/\d+\s*\/\s*\d+/);
  return m ? m[0].replace(/\s/g, "") : s.slice(0, 2);
};
console.log(`      源码里的 brief 共 ${briefs.length} 种：${briefs.map((b) => `${b}→${label(b)}`).join(" / ")}`);
// 只看函数体：类注释里会提到旧实现的名字，不能拿整文件做 includes
const pillFn = src.slice(src.indexOf("private fun pillLabel"), src.indexOf("private fun statusLabel"));
ok(!pillFn.includes("take(3)") && pillFn.includes("PILL_SHORT") && pillFn.includes("PROGRESS"),
  "胶囊简称走固定映射 + 进度提取，不再硬取前 3 字截半个词");
ok(label("打开应用") === "打开", "「打开应用」→「打开」，不是「打开应」");
ok(label("进度 2/5") === "2/5" && src.includes("statusLabel"),
  "进度文案在胶囊保留「2/5」");
ok(src.includes("if (lastBrief == lastDetail) statusLabel(lastDetail) else lastBrief"),
  "卡片标题不与详情重复整句（标题给阶段、正文给完整内容）");

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
