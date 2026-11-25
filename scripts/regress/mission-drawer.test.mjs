// 回归：Step 3 —— Mission 级信任与证据。
// 守三件事：① 卡片的「查看」在对话里就地开抽屉，任务页退为次要入口；
// ② 权限只能被 Mission 收窄（且 default/ask 两个档位名都要认）；
// ③ 证据只存引用、正文按引用现取，取不到就如实说取不到，审批与唤醒都落账。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const cut = (s, from, to) => {
  const i = s.indexOf(from);
  if (i < 0) throw new Error(`FAIL: 找不到片段起点 ${from}`);
  const j = s.indexOf(to, i);
  if (j < 0) throw new Error(`FAIL: 找不到片段终点 ${to}`);
  return s.slice(i, j);
};

const js = read("app/src/main/assets/web/app.js");
const css = read("app/src/main/assets/web/styles.css");
const registry = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/MissionRegistry.kt");
const evidence = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/MissionEvidence.kt");
const wake = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/WakeRouter.kt");
const driver = read("app/src/main/java/ai/deepseek/harness/mobile/agent/AgentDriver.kt");
const config = read("app/src/main/java/ai/deepseek/harness/mobile/agent/AgentConfig.kt");
const bridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/KernelBridge.kt");
const shell = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/fs/ShellPlugin.kt");
const terminal = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/fs/TerminalPlugin.kt");

// ---- 1) 查看 = 就地开抽屉，跳任务页只是次要出口 ----
const openHook = cut(js, 'messagesHost.addEventListener("click"', "// 文件页长按：删除 / 打开");
if (!openHook.includes("openMissionSheet(node)")) {
  throw new Error("FAIL: Mission 卡的「查看」没有打开详情抽屉 —— 又会把人赶出对话页");
}
if (/closest\("\[data-mission-open\]"\)\)\s*\{\s*go\("jobs"\)/.test(openHook)) {
  throw new Error("FAIL: 「查看」又退回成裸跳任务页");
}
if (!openHook.includes("thread.find((n) => n.kind === \"mission\"")) {
  throw new Error("FAIL: 抽屉没有按当前会话的 Mission 节点取事（会串会话）");
}
const drawer = cut(js, "function sheetMission(ids, pickedId) {", "function openMissionSheet(");
for (const need of ["时间线", "证据", "权限范围", "data-mission-locate", "data-mission-export", "唤醒策略"]) {
  if (!drawer.includes(need)) throw new Error(`FAIL: 抽屉缺少 ${need}`);
}
if (!drawer.includes("MISSION_PERMS.filter((o) => o.rank <= sessionRank)")) {
  throw new Error("FAIL: 抽屉列出了比会话更宽的权限档 —— 用户会点一个无效的选项");
}
if (!drawer.includes("data-mission-perm") || !drawer.includes("data-mission-cancel")) {
  throw new Error("FAIL: 抽屉缺权限/终止动作");
}
// 抽屉的底部动作必须绑在 #sheet 上：openSheet 会把 .sheet-footer 搬出 #sheetBody，
// 挂在 body 上的委托收不到任何按钮（真机实锤）。
const drawerHost = cut(js, "// Mission 详情抽屉：换看另一件事", "const pick = e.target.closest");
if (!drawerHost.includes('const missionSheetEl = $("#sheet");') || !drawerHost.includes("missionSheetEl.addEventListener")) {
  throw new Error("FAIL: 抽屉动作绑错容器 —— 底部的终止/重跑/定位/导出会全部失灵");
}
// 这个局部变量以前就叫 sheetHost，和外层的「连接电脑」面板构造函数同名，把它在同一作用域里
// 盖掉了：设置页点「连接电脑」抛 TypeError，什么都不弹（真机实锤）。别再复用这个名字。
if (/const sheetHost\s*=/.test(js)) {
  throw new Error("FAIL: 又出现名为 sheetHost 的局部绑定 —— 会盖掉连接电脑的面板构造函数");
}
if (!js.includes('if (!ids.length) { go("jobs"); return; }')) {
  throw new Error("FAIL: 账本不可用时抽屉没有回退（点查看会变成空面板）");
}
const locate = cut(js, "function locateMission(missionId) {", "function renderJobs() {");
for (const need of ["JobsFilter.state = \"all\"", "JobsFilter.source = \"all\"", '[data-job="${sel}"]', "is-flash"]) {
  if (!locate.includes(need)) throw new Error(`FAIL: 「在任务页定位」缺少 ${need} —— 会被筛选藏掉或不知道定位到哪`);
}
if (!css.includes(".job-row.is-flash")) throw new Error("FAIL: 任务页落点没有高亮样式");

// ---- 2) 权限只能收窄，且档位名两个都要认 ----
for (const need of [
  "fun appendEvidence(", "fun setPermission(", "fun addGrant(", "fun hasGrant(",
  "fun effectivePermission(", "MAX_EVIDENCE", "PERM_DEFAULT to 1", "PERM_ASK to 1",
]) {
  if (!registry.includes(need)) throw new Error(`FAIL: MissionRegistry 缺少 ${need}`);
}
if (!registry.includes("mergeEvidence(existing?.optJSONArray(\"evidence\"), fresh)")) {
  throw new Error("FAIL: 状态迁移又整表覆盖了证据 —— 跑动期间的审批会被抹掉");
}
if (!registry.includes("追加**不动 updatedAt**")) {
  throw new Error("FAIL: 追加证据会顶掉 updatedAt —— 卡片的「最近更新」会说谎");
}
if (!config.includes("val missionId: String = \"\"") || !config.includes("val wake: Boolean = false")) {
  throw new Error("FAIL: AgentConfig 没有 missionId/wake 字段");
}
if (!driver.includes("kernel.sandbox.apply(effectivePermission())")) {
  throw new Error("FAIL: 沙箱仍按会话档应用 —— Mission 的只读会被绕过");
}
if (!driver.includes("permission = effectivePermission()")) {
  throw new Error("FAIL: 工具 Gate 没有吃合档结果");
}
if (!driver.includes("kernel.missions.hasGrant(missionId, name)")) {
  throw new Error("FAIL: 未查这件事内的授权 —— 批准过还会重复弹");
}
if (cut(driver, "fun decideApprovalScope(", "private fun sidOrNull()").includes("alwaysApprovedBySession") === false) {
  throw new Error("FAIL: 无 Mission 时的会话级「始终允许」被改坏了");
}
if (!driver.includes("if (allowed && always && mission.isBlank() && !name.isNullOrBlank())")) {
  throw new Error("FAIL: Mission 轮的「始终允许」会写进会话表 —— 批准泄漏到同会话的下一件事");
}
if (!driver.includes('put("source", if (config.wake) "wake" else "human")')) {
  throw new Error("FAIL: 唤醒续轮在日志里仍冒充用户说话 —— 审计分不清谁开的口");
}
if (!driver.includes('"approval/decided"') || !driver.includes('put("type", "approval")')) {
  throw new Error("FAIL: 审批没有落会话日志与 Mission 证据");
}
if (!driver.includes('"deliverable"') || !driver.includes("o.denied && config.missionId.isNotBlank()")) {
  throw new Error("FAIL: 交付物/被拦调用没有进证据 —— 回看看不出这件事做了什么、卡在哪");
}

// ---- 3) 证据只存引用，正文现取 ----
for (const need of ["class MissionEvidence(", "fun view(", "fun detail(", "fun markdown(", "取不到正文"]) {
  if (!evidence.includes(need)) throw new Error(`FAIL: MissionEvidence 缺少 ${need}`);
}
// 抽屉一次取全（detail = 本体 + 时间线 + 证据），所以桥面上是 detail 而不是单独的 view 入口
if (!bridge.includes("activity.kernel.missionEvidence.detail(id)") || !bridge.includes("fun missionDetail(")
  || !bridge.includes("fun missionSetPermission(") || !bridge.includes("fun missionExport(")) {
  throw new Error("FAIL: 桥没有暴露组装后的证据/详情/权限/导出");
}
if (!bridge.includes('"$safe.${if (asJson) "json" else "md"}"')) {
  throw new Error("FAIL: 导出文件名没有按格式取扩展名");
}
if (!bridge.includes("if (it.isLetterOrDigit() || it == '.' || it == '-' || it == '_')")) {
  throw new Error("FAIL: 导出路径没有清洗 id —— 能把路径分隔符带出工作区");
}
if (!wake.includes("fun drainForAgent(sessionId: String): List<JSONObject>")) {
  throw new Error("FAIL: pre-step 认领只回文本 —— 忙时注入的唤醒落不到那条事的账上");
}
if (!terminal.includes("missions.appendEvidence(") || !terminal.includes('put("wakeId", rec.optString("id"))')) {
  throw new Error("FAIL: 忙时注入没有记证据/日志引用");
}
if (!shell.includes("j.append(stripExitHeader(out))")) {
  throw new Error("FAIL: 后台任务把 exit= 头当输出了 —— 通知卡会显示两遍 exit");
}

// ---- 4) 唤醒续轮要把这件事带进内核 ----
const wakeTurn = cut(js, "function startWakeTurn(w, display) {", "function wakeMissions(");
if (!wakeTurn.includes("wake: true") || !wakeTurn.includes("wakeId: w.id")) {
  throw new Error("FAIL: 唤醒轮没有声明是哪条唤醒叫起来的");
}
if (!wakeTurn.includes("state.pendingMission = { missionId: w.missionId")) {
  throw new Error("FAIL: job 唤醒走普通发送口，没有把 mission 递进去");
}
if (!wakeTurn.includes("state.pendingMission = null; return false;")) {
  throw new Error("FAIL: 发送失败时没有收回 pendingMission —— 会污染用户下一条消息");
}
if (!js.includes("const bind = opts.mission || state.pendingMission || null;")) {
  throw new Error("FAIL: localSend 没有消费 pendingMission");
}
if (!js.includes("mission: ev.missionTitle")) {
  throw new Error("FAIL: 审批卡没有显示所属 Mission");
}
if (js.includes("这件事内始终允许</button>")) {
  throw new Error("FAIL: 审批按钮文案又变长 —— 三个按钮要同一量级");
}
if (!js.includes('bound ? "已允许并记住这件事 · 命令执行中…"')) {
  throw new Error("FAIL: 绑了 Mission 的「始终允许」回执仍写「记住本会话」—— 用户会以为整会话免问");
}

console.log("✔ mission-drawer: 查看就地开抽屉 / 权限只收窄 / 证据现取正文 / 审批与唤醒落账");
