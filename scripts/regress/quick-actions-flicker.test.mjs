// 回归：快捷操作浮窗里切换权限 / 预设 / 计划模式时，整张面板不能闪一下。
// 曾经的 bug（用户 2026-10-31 反馈）：点「只读 / 默认 / 完全访问」后为了更新滑块，
// 代码调用 openSheet(sheetQuickActions()) 整块重画；openSheet 对已打开的面板会做一次
// 120ms 透明度淡入，肉眼就是「整个浮窗内容闪一下」。
// 现在的规矩：这三类切换只改受影响节点的类名/文案（syncQuickActionsUI），
// 滑块由 moveSegInd 在同一个 DOM 上过渡；只有「开启完全访问」的确认页才换面板。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const js = readFileSync(join(root, "app/src/main/assets/web/app.js"), "utf8");

function cut(startMarker, endMarker) {
  const start = js.indexOf(startMarker);
  if (start < 0) throw new Error(`FAIL: 找不到起点 ${startMarker}`);
  const end = js.indexOf(endMarker, start);
  if (end < 0) throw new Error(`FAIL: 找不到终点 ${endMarker}`);
  return js.slice(start, end);
}

// ---- 1) 就地刷新函数必须真的更新权限段与预设勾，而不是只存在个名字 ----
const sync = cut("function syncQuickActionsUI() {", "\n  }\n\n  /* 目标模式：设定");
for (const need of [
  '#qaSeg [data-quick-perm]',
  'classList.toggle("on"',
  "moveSegInd(seg",
  '[data-preset]',
  '#qaPlan',
  '#qaGoal',
]) {
  if (!sync.includes(need)) throw new Error(`FAIL: syncQuickActionsUI 缺少 ${need} —— 切换权限后滑块/高亮不会跟着走`);
}

// ---- 2) 三个切换入口都不能再整块重画（会触发 openSheet 的 120ms 淡入）----
const handlers = [
  ["权限", cut('const qaPerm = e.target.closest("[data-quick-perm]");', 'toast("Agent 权限："')],
  ["预设", cut('const presetPick = e.target.closest("[data-preset]");', 'if (e.target.closest("#qaPlan")) {')],
  ["计划模式", cut('if (e.target.closest("#qaPlan")) {', 'if (e.target.closest("#qaGoal")) {')],
];
for (const [name, body] of handlers) {
  if (/openSheet\(sheetQuickActions\(\)\)/.test(body)) {
    throw new Error(`FAIL: 切换${name}又走了 openSheet 整块重画 —— 整个浮窗会再闪一下`);
  }
  if (!/syncQuickActionsUI\(\)/.test(body)) {
    throw new Error(`FAIL: 切换${name}没有调用 syncQuickActionsUI —— 状态会显示成旧值`);
  }
}

console.log("✔ quick-actions-flicker: 权限 / 预设 / 计划切换都走就地刷新，不再整块重画");
