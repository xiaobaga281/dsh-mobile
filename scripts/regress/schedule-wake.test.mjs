// 回归：定时任务到点必须真的「发起一轮」，且提醒不能丢。
// Step 2 起走统一 WakeRouter：
//   · 投递成功后仍 emit schedule_due（提醒是否写进日志用 delivered 标明）；
//   · ToolKernel 同时把这条到点写进 wakes（delivered 用 nudge，否则用 prompt）；
//   · UI 不在 → 系统通知；前端空闲 → wakeMissions 认领一轮；忙碌/别的会话留在队列；
//   · 更新源 ghfast.top 已失效，必须换成实测可用的镜像。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const js = read("app/src/main/assets/web/app.js");
const registry = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/schedule/ScheduleRegistry.kt");
const kernel = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/ToolKernel.kt");
const wake = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/WakeRouter.kt");
const bridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/KernelBridge.kt");
const update = read("app/src/main/java/ai/deepseek/harness/mobile/update/UpdateCenter.kt");

function cut(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`FAIL: 找不到起点 ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error(`FAIL: 找不到终点 ${endMarker}`);
  return src.slice(start, end);
}

// ---- 1) 投递成功仍要通知 UI ----
const fire = cut(registry, "private fun fire(id: String)", "private fun advanceWithoutDelivery");
for (const need of ["d.deliver(rec)", 'put("delivered", true)', "d.buildText(rec)", "onDue("]) {
  if (!fire.includes(need)) throw new Error(`FAIL: 定时投递成功后缺少 ${need} —— 界面不会响应`);
}
if (fire.indexOf("d.deliver(rec)") > fire.indexOf('put("delivered", true)')) {
  throw new Error("FAIL: 通知必须发生在投递成功之后");
}

// ---- 2) 到点写统一队列；UI 不在时通知 ----
const onDue = cut(kernel, "onDue = { due ->", "onChanged =");
for (const need of ["wakes.enqueueSchedule(", 'due.optBoolean("delivered"', "RunService.remind"]) {
  if (!onDue.includes(need)) throw new Error(`FAIL: ToolKernel 到点没有接统一唤醒（缺少 ${need}）`);
}
if (kernel.includes("jobs.enqueueWake(")) {
  throw new Error("FAIL: ToolKernel 仍在往旧 notice 队列写入定时唤醒 —— 会双发");
}
for (const need of ["fun enqueueSchedule(", "if (delivered) nudge else body", 'put("display", body)', "fun drainForAgent("]) {
  if (!wake.includes(need)) throw new Error(`FAIL: WakeRouter 定时唤醒缺少 ${need}`);
}
for (const need of ["fun wakeList(sessionId: String)", "fun wakeConsume(idsCsv: String)"]) {
  if (!bridge.includes(need)) throw new Error(`FAIL: 缺少 ${need}，前端无法认领定时唤醒`);
}

// ---- 3) 前端：统一 wakeMissions；定时用 nudge，不重复 prompt ----
const dueHandler = cut(js, 'if (ev.t === "schedule_due") {', "/* 系统授权弹窗返回");
for (const need of ["wakeMissions(", "sameSession", "定时任务已到点"]) {
  if (!dueHandler.includes(need)) throw new Error(`FAIL: schedule_due 处理缺少 ${need} —— 到点仍无响应`);
}
for (const legacy of ["wakeScheduled(", "pendingScheduleWake", "scheduleDeferWake", "LocalDB.push"]) {
  if (dueHandler.includes(legacy)) throw new Error(`FAIL: schedule_due 仍走旧路径 ${legacy}`);
}
const turnFn = cut(js, "function startWakeTurn(w, display) {", "function wakeMissions(");
for (const need of ["w.kind === \"schedule\"", "NODES.user", "LocalDB.push", "localSend(text"]) {
  if (!turnFn.includes(need)) throw new Error(`FAIL: startWakeTurn 缺少 ${need}`);
}
if (turnFn.includes("localSend(prompt")) {
  throw new Error("FAIL: 提醒已在日志里，不能再把 prompt 当新用户消息重发（会重复两遍）");
}
const turnEnd = cut(js, 'if (ev.t === "turn_end") {', "/** 目标续跑");
if (!turnEnd.includes("wakeMissions()")) {
  throw new Error("FAIL: 忙碌期间到点的唤醒没有在本轮结束后补认领");
}

// ---- 4) 更新镜像：ghfast.top 已失效，必须换成实测可用的 ----
const mirrors = cut(update, "private val MIRRORS = listOf(", ")");
if (mirrors.includes("ghfast.top")) {
  throw new Error("FAIL: ghfast.top 已不可用，仍留在更新源列表");
}
for (const need of ["gh-proxy.org", "gh-proxy.com", "ghfile.geekertao.top"]) {
  if (!mirrors.includes(need)) throw new Error(`FAIL: 更新源缺少可用的 ${need}`);
}

console.log("✔ schedule-wake: 到点写统一队列 / nudge 不重复 / 忙碌排后 / 离线持久唤醒 / 更新镜像可用");
