// 回归：设置页「灵动岛」面板的每个滑块，值必须真的被推到原生。
// 曾经的 bug（用户 2026-11-06 反馈「垂直位置调整没反应」）：面板里加了 dy 滑块、
// 原生 IslandTune.parse 也认 "dy"，但前端 islandTuneValue() 只返回 {dx,w,pad} ——
// 推送的 JSON 里压根没有 dy，于是拖滑块只动了界面上的数字，胶囊纹丝不动。
// 修法关键点：**加字段时 islandTuneValue 必须同步**（它是唯一的推送来源），
// 恢复默认也要把它归零，否则「恢复默认」会留下一个改不掉的偏移。
// 顺带钉住：面板模板要有这四行、原生要认 dy、原生要把它画出来。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const js = readFileSync(join(root, "app/src/main/assets/web/app.js"), "utf8");
const kt = readFileSync(
  join(root, "app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/device/ControlIslandPlugin.kt"),
  "utf8",
);
const geom = readFileSync(
  join(root, "app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/device/IslandGeometry.kt"),
  "utf8",
);

function cut(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`FAIL: 找不到起点 ${startMarker}`);
  // 从起点之后开始找终点：endMarker 是 "private fun " 时，否则会命中起点自身
  // （"private fun applyTuneNow" 也以它开头），切出空串、所有断言假红。
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`FAIL: 找不到终点 ${endMarker}`);
  return src.slice(start, end);
}

// ---- 1) 唯一的推送来源必须把四个参数都带上 ----
const value = cut(js, "function islandTuneValue() {", "\n  }\n");
for (const key of ["dx", "dy", "w", "pad"]) {
  if (!new RegExp(`\\b${key}:\\s*Math\\.round`).test(value)) {
    throw new Error(
      `FAIL: islandTuneValue() 没有返回 ${key} —— 推给原生的 JSON 里就少了这个字段，` +
        `滑块拖了不会生效（dy 就这样哑过一次）`,
    );
  }
}

// ---- 2) 恢复默认必须把它归零，否则留下一个改不掉的偏移 ----
const reset = cut(js, 'if (e.target.closest("[data-island-reset]")) {', "toast(\"灵动岛已恢复默认\")");
if (!/state\.islandTune\s*=\s*\{[^}]*\bdy:\s*0/.test(reset)) {
  throw new Error("FAIL: 「恢复默认」没把 dy 归零 —— 点完仍是歪的，用户会以为按钮坏了");
}

// ---- 3) 面板模板四行齐全（少一行就没有入口）----
const sheet = cut(js, "function islandTuneSheet() {", "function fillIslandLabels()");
for (const key of ["dx", "dy", "w", "pad"]) {
  if (!sheet.includes(`row("${key}",`)) {
    throw new Error(`FAIL: 灵动岛面板缺少 ${key} 这一行 —— 用户没法调这一项`);
  }
}

// ---- 4) 原生侧：解析、几何、窗口三处都要认 dy ----
if (!/optInt\("dy"/.test(geom)) {
  throw new Error("FAIL: IslandTune.parse 没读 dy —— 前端推了也会被丢掉");
}
if (!/val dy: Int = 0/.test(geom)) {
  throw new Error("FAIL: IslandTune 没有 dy 字段");
}
if (!/DY_MIN\s*=\s*-100/.test(geom) || !/DY_MAX\s*=\s*100/.test(geom)) {
  throw new Error("FAIL: dy 的夹取范围丢了 —— 可能把胶囊推出屏幕");
}

// 就地更新路径（设置页拖动走这条）必须同时动「形状」和「热区」，
// 只动其中一个会变成「看得见但点不到」或「点得到但看不见」。
const applyNow = cut(kt, "private fun applyTuneNow() {", "private fun ");
if (!/pillDy\s*=\s*tune\.dy\.coerceIn/.test(applyNow)) {
  throw new Error("FAIL: applyTuneNow 没算 pillDy —— 设置页拖动时垂直偏移不生效");
}
if (!/dyOffset\s*=\s*pillDy/.test(applyNow)) {
  throw new Error("FAIL: applyTuneNow 没把 pillDy 交给绘制层 —— Canvas 画的形状不会动");
}
if (!/tp\.y\s*=\s*pillY \+ pillDy/.test(applyNow)) {
  throw new Error("FAIL: 热区窗口没跟着下移 —— 胶囊看起来在那儿，点击却打空");
}

// 形状随展开进度归中：展开时必须回到窗口顶，否则卡片会被顶下去一截。
const geo = cut(kt, "private fun geom() {", "\n        }");
if (!/gT\s*=\s*dyOffset \* \(1f - t\)/.test(geo)) {
  throw new Error("FAIL: 展开时没把垂直偏移收回去 —— 卡片会整体下移一截，顶边不贴状态栏");
}

console.log("PASS island-tune: 四个滑块的参数都推到了原生，dy 在解析/几何/热区/展开四条路上都走通");
