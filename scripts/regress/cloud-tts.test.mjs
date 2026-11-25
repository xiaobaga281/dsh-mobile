// 回归：语音输出改成「系统 TTS 默认 + 用户可配云端模型」之后，
// 1) 内置神经模型与「经典男」必须在前端/原生/桥三处都不再被引用；
// 2) 主配置只要地址/密钥/模型名三项，音色等高级项可以留空但不能丢字段；
// 3) 表单里的每个字段都必须真的被推给原生 —— 灵动岛 dy 就是因为「加了滑块、
//    推送函数没带这个字段」整整哑了一版，这类 bug 不能再来一次。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const js = read("app/src/main/assets/web/app.js");
const center = read("app/src/main/java/ai/deepseek/harness/mobile/voice/VoiceCenter.kt");
const cloud = read("app/src/main/java/ai/deepseek/harness/mobile/voice/CloudTts.kt");
const bridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/VoiceBridge.kt");

function cut(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`FAIL: 找不到起点 ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`FAIL: 找不到终点 ${endMarker}`);
  return src.slice(start, end);
}

// ---- 1) 三项主配置：不多让用户填格式，也不能少 ----
const sheet = cut(js, "const sheetCloudTts = () => {", "const sheetVoiceGender = () => {");
for (const id of ["ctUrl", "ctKey", "ctModel"]) {
  if (!sheet.includes(`id="${id}"`)) {
    throw new Error(`FAIL: 云端语音面板缺少 ${id} —— 用户没法配置这一项`);
  }
}
if (/\bctFormat\b|response_format/.test(sheet)) {
  throw new Error("FAIL: 返回格式不该让用户填 —— 响应 MIME 由原生自动识别");
}
for (const id of ["ctVoice", "ctBody", "ctHeaders"]) {
  if (!sheet.includes(`id="${id}"`)) {
    throw new Error(`FAIL: 高级项 ${id} 不见了 —— 换厂商时无法适配接口差异`);
  }
}

// ---- 2) 推送函数必须把表单里的每个字段都带上 ----
const save = cut(js, "const saveCloudTts = (test) => {", '$("#btnChatMore")');
for (const key of ["enabled", "endpoint", "apiKey", "model", "voice", "bodyTemplate", "extraHeaders"]) {
  if (!new RegExp(`\\b${key}:`).test(save)) {
    throw new Error(`FAIL: saveCloudTts 没把 ${key} 推给原生 —— 表单填了也不生效`);
  }
}

// ---- 3) 配置真值只在原生，前端不再自己存一份 ----
const speechOut = cut(js, "cloud() {", "voiceLabel() {");
if (!speechOut.includes("Native.cloudTtsConfig") || !speechOut.includes("Native.cloudTtsSet")) {
  throw new Error("FAIL: 云端配置没有走唯一桥入口 —— 又会变成前端/原生两份状态互相覆盖");
}
if (/cloudSet[\s\S]{0,400}localStorage/.test(speechOut)) {
  throw new Error("FAIL: 云端配置不该写 localStorage —— 密钥与真值都在原生");
}

// ---- 4) 内置模型整条链路都不许再出现 ----
const stale = ["neuralStatus", "setNeuralPreferred", "neuralWarmUp", "classic_m", "tts-neural", "内置神经"];
for (const word of stale) {
  if (js.includes(word)) {
    throw new Error(`FAIL: 前端产物里还有 ${word} —— 内置模型已删除，残留调用会静默失败`);
  }
  if (center.includes(word) || bridge.includes(word)) {
    throw new Error(`FAIL: 原生里还有 ${word} —— 内置模型已删除，别留死分支`);
  }
}

// ---- 5) 路由：没配云端一律系统 TTS，云端失败由 VoiceCenter 当场兜底 ----
if (!center.includes("cloud.config.usable") || !center.includes("speakSystem(body, rate)")) {
  throw new Error("FAIL: VoiceCenter 没有云端/系统双路或没保留系统兜底 —— 云端不通会没声音");
}
if (!cloud.includes("fun setConfig(") || !cloud.includes("Authorization")) {
  throw new Error("FAIL: CloudTts 缺保存入口或鉴权头 —— 用户填的密钥不会生效");
}

console.log("PASS cloud-tts: 三项主配置 / 字段全推送 / 真值在原生 / 内置模型已绝迹 / 系统 TTS 兜底");
