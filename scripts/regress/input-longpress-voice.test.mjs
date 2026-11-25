// 回归：长按输入框的语义。
// 产品规则（2026-10-31 用户确认）：只有输入框为空时长按才是「按住说话」；
// 有字时长按保留系统的选词 / 复制 / 粘贴，绝不能弹语音。
// 空输入框路径仍需保留原生层保证：有字时系统选择会吞指针事件，历史修复不能删。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const js = readFileSync(join(root, "app/src/main/assets/web/app.js"), "utf8");
const css = readFileSync(join(root, "app/src/main/assets/web/styles.css"), "utf8");
const activity = readFileSync(join(root, "app/src/main/java/ai/deepseek/harness/mobile/MainActivity.kt"), "utf8");
const voiceBridge = readFileSync(join(root, "app/src/main/java/ai/deepseek/harness/mobile/bridge/VoiceBridge.kt"), "utf8");

function cut(startMarker, endMarker) {
  const start = js.indexOf(startMarker);
  if (start < 0) throw new Error(`FAIL: 找不到起点 ${startMarker}`);
  const end = js.indexOf(endMarker, start);
  if (end < 0) throw new Error(`FAIL: 找不到终点 ${endMarker}`);
  return js.slice(start, end);
}

const binder = cut("/* 长按输入框说话", '$("#voiceCancel").addEventListener("click", () => {');
for (const need of [
  "is-voice-arming",
  "const canHoldVoice = () => VoicePlugin.on() && !ta.value.trim();",
  "const holdVoice = canHoldVoice();",
  "Native.setVoicePress(pressType !== \"mouse\" && holdVoice)",
  'ta.addEventListener("contextmenu"',
  "if (ta.value.trim()) return;",
  'ta.addEventListener("pointerup", clearTimer)',
  "removeAllRanges",
  "startHold",
  "selectionchange",
  "setVoiceHold",
]) {
  if (!binder.includes(need)) throw new Error(`FAIL: 长按语义缺少 ${need}`);
}
if (binder.includes('"pointerup", "pointercancel"') || binder.includes("pointerleave")) {
  throw new Error("FAIL: pointercancel/pointerleave 又参与取消长按计时 —— 空输入框长按语音会复发");
}
if (!css.includes("#input.is-voice-arming") || !css.includes("user-select: none")) {
  throw new Error("FAIL: 缺少 is-voice-arming 的选择抑制样式（空输入框长按语音需要）");
}

// 有字的长按不能再进入 startHold：守卫必须在 startHold 的开头
const start = binder.slice(binder.indexOf("const startHold = (why) => {"));
const guardAt = start.indexOf("if (ta.value.trim()) return;");
const firstVoiceAt = start.indexOf("Native.startVoiceInput()");
if (guardAt < 0 || firstVoiceAt < 0 || guardAt > firstVoiceAt) {
  throw new Error("FAIL: 有字守卫不在 startHold 之前 —— 有字长按会再次唤出语音");
}

// 原生层保证仍然存在（只对空输入框生效，由 setVoicePress 控制）
for (const need of ["setOnLongClickListener", "EDIT_TEXT_TYPE", "setOnTouchListener", "voiceHoldReleased"]) {
  if (!activity.includes(need)) throw new Error(`FAIL: Activity 原生接管/补发松手缺失 ${need}`);
}
for (const need of ["fun setVoicePress", "fun setVoiceHold", "fun voiceHoldReleased"]) {
  if (!voiceBridge.includes(need)) throw new Error(`FAIL: VoiceBridge 缺少手势桥 ${need}`);
}

// 麦克风按钮仍可带草稿说话：识别结果追加逻辑不能被这次改动带走
const onVoice = cut("onVoice(text, clip, dur) {", "const ms = Number(dur)");
for (const need of ["draft.trim()", "已追加到输入框", "state.pendingVoice = null"]) {
  if (!onVoice.includes(need)) throw new Error(`FAIL: onVoice 缺少草稿追加（${need}）`);
}

console.log("✔ input-longpress-voice: 空输入长按语音 / 有字长按保留系统编辑 / 麦克风仍可带草稿");
