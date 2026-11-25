// 回归：同一屏幕上「浮动表面」必须共用一套材质（rc.162，rc.163 修订）。
// 曾经的 bug（用户两次分别点名）：
//   ① 排队队列 .queue-item 各自铺不透明卡片（--card + --sep 边框 + 12px 圆角），
//      而下面的输入框是玻璃（glass 渐变 + backdrop-filter）—— 一屏两种材质；
//   ② 目标胶囊 .mode-chip 是灰填充无描边，和它贴着的输入框不是一套。
// 现在的规矩：
//   · 浮在内容上的表面（输入框 / 队列面板 / 模式签）= 玻璃（glass 渐变 + backdrop-filter + 0.5px glass-edge）；
//   · 消息流里的卡片保留各自的身份色（.todo-card 绿色径向渐变、.plan-card 靛蓝渐变）——
//     这是用户点名要的，rc.162 曾统一成中性，rc.163 按用户要求改回，别再抹掉。
// 对齐桌面端：QueueDock.panel、GoalBar、TodoPanel 用的都是同一个 --dsw-specific-menu 菜单玻璃。
// 断言全部抽 assets/web 真实源码，不复刻业务逻辑。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "app/src/main/assets/web/styles.css"), "utf8");
const js = readFileSync(join(root, "app/src/main/assets/web/app.js"), "utf8");

function block(header) {
  const i = css.indexOf(header);
  if (i < 0) throw new Error(`FAIL: 找不到 ${header}`);
  return css.slice(i, css.indexOf("}", i));
}

// ---- 1) 排队行不能再是不透明卡片（材质回归的主源头）----
const item = block(".queue-item {");
if (/--card/.test(item)) throw new Error("FAIL: .queue-item 又用了不透明 --card，会和输入框的玻璃对不上");
if (/border:\s*0?\.5px solid var\(--sep\)/.test(item)) throw new Error("FAIL: .queue-item 又画了自己的卡片边框");

// ---- 2) 队列面板是玻璃，且底边不画线（接缝交给输入框顶边，桌面端同做法）----
const bar = block(".queue-bar {");
for (const need of ["backdrop-filter", "var(--glass-a)", "border-bottom: none", "border-radius: 26px 26px 0 0"]) {
  if (!bar.includes(need)) throw new Error(`FAIL: .queue-bar 缺少 ${need} —— 队列面板不再是输入框同款玻璃`);
}

// ---- 3) 队列在场时输入框上沿改直（否则胶囊圆弧和面板方角之间留缺口）----
if (!css.includes(".composer-dock.has-queue:not(.has-attach) .composer { border-radius: 0 0 26px 26px; }")) {
  throw new Error("FAIL: 缺少 has-queue 时输入框上沿改直的规则，接缝处会出现两个圆角缺口");
}
if (!/classList\.toggle\("has-queue", q\.length > 0\)/.test(js)) {
  throw new Error("FAIL: renderQueue 没有维护 has-queue 类");
}
if (!/classList\.toggle\("has-attach", has\)/.test(js)) {
  throw new Error("FAIL: renderAttachments 没有维护 has-attach 类（托盘夹在中间时输入框要保留胶囊圆角）");
}

// ---- 4) 目标胶囊 = 和输入框同一套玻璃，状态色只落字/图标 ----
const chip = block(".mode-chip {");
for (const need of ["backdrop-filter", "var(--glass-a)", "var(--glass-edge)"]) {
  if (!chip.includes(need)) throw new Error(`FAIL: .mode-chip 缺少 ${need} —— 目标胶囊又变回灰填充无描边，和输入框不是一套`);
}
if (/background/.test(block(".mode-chip.plan {"))) {
  throw new Error("FAIL: 模式签又铺了彩色底块，状态色应该只落在图标和阶段文字上");
}

// ---- 5) 计划类卡片的身份色必须留着（用户点名要的：执行计划绿 / 评审卡片靛蓝）----
if (!/radial-gradient/.test(block(".todo-card {"))) {
  throw new Error("FAIL: .todo-card 的绿色径向渐变被抹掉了 —— 用户明确要保留这张卡的身份色");
}
const plan = block(".plan-card {");
if (!/linear-gradient\(180deg, rgba\(94, 92, 230/.test(plan)) {
  throw new Error("FAIL: .plan-card 的靛蓝渐变被抹掉了 —— 用户明确要保留这张卡的身份色");
}
if (!/html\[data-theme="dark"\] \.plan-card \{/.test(css)) {
  throw new Error("FAIL: .plan-card 缺深色主题的渐变档位");
}

// ---- 6) 没有背景模糊的机型要退成实色，否则玻璃下面会透出正文 ----
if (!/\.queue-bar,\.mode-chip/.test(css)) {
  throw new Error("FAIL: @supports not backdrop-filter 的退色名单里少了 queue-bar / mode-chip");
}

console.log("PASS: 浮动表面同一套玻璃（输入框 / 队列 / 目标胶囊），计划类卡片的身份色仍在");
