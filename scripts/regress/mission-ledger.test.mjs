// 回归：Mission Ledger v1 —— jobs/schedules 必须进内核账本，前端状态从账本读，
// 进程重启后未结算的 job 必须标 interrupted，而不是继续 running。
// 这是「单一事实源」的守卫：没有它，卡/带/任务页又会各自从旧注册表推导状态。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const js = read("app/src/main/assets/web/app.js");
const registry = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/MissionRegistry.kt");
const store = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/MissionStore.kt");
const kernel = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/ToolKernel.kt");
const bridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/KernelBridge.kt");
const schedule = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/schedule/ScheduleRegistry.kt");

// ---- 1) 账本本身：状态/来源/证据/唤醒策略 + 重启恢复 ----
for (const need of [
  "class MissionRegistry(", "fun onJobStarted(", "fun onJobSettled(",
  "fun onScheduleChanged(", "fun onScheduleRemoved(",
  "OUTCOME_INTERRUPTED", "WAKE_IDLE_AUTO", "MAX_SETTLED",
]) {
  if (!registry.includes(need)) throw new Error(`FAIL: MissionRegistry 缺少 ${need}`);
}
if (!registry.includes('m.optString("state") != STATE_SETTLED') || !registry.includes("m.put(\"outcome\", OUTCOME_INTERRUPTED)")) {
  throw new Error("FAIL: 重启后未结算的 job 没有被标成 interrupted —— 会假装还在跑");
}
for (const need of ["class MissionStore(", "fun load()", "fun save(", "VERSION = 1", ".tmp"]) {
  if (!store.includes(need)) throw new Error(`FAIL: MissionStore 缺少 ${need}（持久化/原子写）`);
}

// ---- 2) 内核接线：job 生命周期 + 定时任务变化都写账本 ----
for (const need of [
  "val missions = ai.deepseek.harness.mobile.kernel.mission.MissionRegistry(",
  "missions.onJobStarted(", "missions.onJobSettled(",
  "missions.onScheduleChanged(view)", "missions.onScheduleRemoved(id)",
]) {
  if (!kernel.includes(need)) throw new Error(`FAIL: ToolKernel 未把 ${need} 接进账本`);
}
for (const need of ["onChanged: (JSONObject) -> Unit", "onChanged(rec.toView(now))", "runCatching { onRemoved(id) }"]) {
  if (!schedule.includes(need)) throw new Error(`FAIL: 定时任务变化没有同步（缺少 ${need}）`);
}

// ---- 3) 桥：账本读取 / 详情 / 取消 ----
// missionGet 与 missionEvidence 曾经也挂在这里，但前端一次都没调过（详情走 missionDetail，
// 它把本体 + 时间线 + 证据一次取全）—— 没人调的桥面由 contract-alignment 守卫把关。
for (const need of ["fun missionList(", "fun missionDetail(", "fun missionCancel("]) {
  if (!bridge.includes(need)) throw new Error(`FAIL: KernelBridge 缺少 ${need}`);
}

// ---- 4) 前端：账本优先，旧投影只作回退 ----
if (!js.includes("function readMissionLedger(") || !js.includes("Native.missionList(sid || \"\")")) {
  throw new Error("FAIL: 前端没有读 Mission Ledger");
}
const rows = js.slice(js.indexOf("function missionRows(sid) {"), js.indexOf("function missionLive("));
if (!rows.includes("const ledger = readMissionLedger(sid);") || !rows.includes("if (ledger) return ledger;")) {
  throw new Error("FAIL: missionRows 没有账本优先（会退回各自推导状态）");
}
const render = js.slice(js.indexOf("function renderJobs() {"), js.indexOf("function bindJobFilters()"));
if (!render.includes('const ledger = readMissionLedger("");')) {
  throw new Error("FAIL: 任务页没有消费 Mission Ledger");
}
if (!render.includes('id: m.sourceId || String(m.id).replace(/^(job|schedule|team):/, "")')) {
  throw new Error("FAIL: 任务页的 data-job 不能用双前缀 —— 点开会找不到旧注册表");
}

console.log("✔ mission-ledger: jobs/schedules 进同一账本 / 重启标 interrupted / 前端账本优先");
