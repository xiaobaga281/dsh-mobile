// 回归：Step 4 工作站底座。
// 守四件事：① 产出物落在工作区里且溢出缓存有**字节**上限（只有龄期等于能写满就写满）；
// ② 存储面板如实报告每一项，唯一能删的只有可再生的溢出缓存；
// ③ 后台任务把当时的命令留在账本里，「重新跑一次」才有依据 —— 没留就不给按钮；
// ④ 唤醒补的那一轮失败时能回滚重投（有上限），不被静默吃掉。
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
const html = read("app/src/main/assets/web/index.html");
const readme = read("README.md");
const kernel = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/ToolKernel.kt");
const pipeline = read("app/src/main/java/ai/deepseek/harness/mobile/agent/ToolPipeline.kt");
const spill = read("app/src/main/java/ai/deepseek/harness/mobile/agent/SpillPolicy.kt");
const audit = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/StorageAudit.kt");
const jobs = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/jobs/JobRegistry.kt");
const registry = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/MissionRegistry.kt");
const wake = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/WakeRouter.kt");
const shell = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/fs/ShellPlugin.kt");
const bridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/KernelBridge.kt");
const runsvc = read("app/src/main/java/ai/deepseek/harness/mobile/notify/RunService.kt");

// ---- 1) spill 落点在 work区 且按字节收 ----
if (kernel.includes("ToolPipeline.appSpillRoot = File(it.filesDir")) {
  throw new Error("FAIL: 又把 spill 注回应用私有目录 —— 产出物对 read 半隐藏，用户看不见自己东西");
}
if (!pipeline.includes('const val SPILL_DIR = ".dsh/spill"')) {
  throw new Error("FAIL: 工作区落点常量变了，README 的表格要同步");
}
const spillFor = cut(pipeline, "private fun spillFor(sessionId: String?): SpillPolicy {", "private fun cleanupSpillOnce");
if (!spillFor.includes("SpillPolicy.trimToBudget(root)")) {
  throw new Error("FAIL: 每批没有按字节收溢出 —— 只有 30 天龄期等于能写满就写满");
}
if (!spill.includes("const val MAX_BYTES") || !spill.includes("fun trimToBudget") || !spill.includes("fun dirBytes")) {
  throw new Error("FAIL: SpillPolicy 缺字节预算能力");
}
if (!spill.includes("sortedBy { it.lastModified() }")) {
  throw new Error("FAIL: 超预算不是「最旧的先走」，会删掉刚跑出来的结果");
}

// ---- 2) 存储面板：看得见 + 只碰可再生的 ----
for (const need of ["class StorageAudit(", "fun stat()", "fun clear(key: String)", "SPILL_SUB", "SESSIONS_WARN_BYTES"]) {
  if (!audit.includes(need)) throw new Error(`FAIL: StorageAudit 缺少 ${need}`);
}
if (!audit.includes('"spill" ->')) throw new Error("FAIL: 清理白名单丢了 —— 不能让它落到删用户文件的分支");
if (!audit.includes("不自动删")) throw new Error("FAIL: 会话日志要如实说明不自动删，而不是悄悄裁历史");
if (!bridge.includes("fun storageStat(") || !bridge.includes("fun storageClear(")) {
  throw new Error("FAIL: 桥没暴露存储清单/清理");
}
if (!html.includes('id="rowStorage"')) throw new Error("FAIL: 设置页没有「存储与落点」入口（不新增一级页面，挂在设置里）");
if (!js.includes("function sheetStorage()") || !js.includes("function refreshStorageRow()")) {
  throw new Error("FAIL: 存储面板没实现");
}
if (!js.includes('openSheet(sheetStorage())')) throw new Error("FAIL: 存储行没接面板");
if (!js.includes("refreshStorageRow();")) throw new Error("FAIL: 进设置页没刷新存储行（会停在旧数字）");
if (!js.includes('data-storage-clear')) throw new Error("FAIL: 面板里没有清理溢出缓存的入口");

// ---- 3) 重跑要有据 ----
if (!jobs.includes("spec: JSONObject? = null") || !jobs.includes("job.spec = spec")) {
  throw new Error("FAIL: JobRegistry 没留 spec —— 重启后无从重跑");
}
if (!registry.includes("spec: JSONObject? = null") || !registry.includes('put("origin", spec?.let')) {
  throw new Error("FAIL: MissionRegistry 没把参数写进 origin");
}
if (!registry.includes('if (optJSONObject("origin") == null) put("origin"')) {
  throw new Error("FAIL: 结算会把 origin 洗掉 —— 跑完就再也重跑不了了");
}
if (!kernel.includes("missions.onJobStarted(job.id, job.name, job.owner, job.startedAt, job.spec)")) {
  throw new Error("FAIL: ToolKernel 没把 spec 传进账本");
}
if (!shell.includes('ctx.provide("job.exec"') || !shell.includes("private fun startBackground(")) {
  throw new Error("FAIL: 重跑没有可复用的执行入口（不能在桥里再拼一份 exec）");
}
if (!bridge.includes("fun missionRerun(") || !bridge.includes('kernel.service("job.exec")')) {
  throw new Error("FAIL: 桥没有 missionRerun 或没走服务");
}
if (!bridge.includes('这条记录没留下当时的命令')) {
  throw new Error("FAIL: 没留参数的老记录必须拒绝重跑，不能凭标题猜命令");
}
const drawer = cut(js, "function sheetMission(ids, pickedId) {", "function openMissionSheet(");
if (!drawer.includes("const rerunnable = m.kind === \"job\" && !running")) {
  throw new Error("FAIL: 「重新跑一次」没按 origin 条件出现");
}
if (!js.includes("function missionOriginType(m)")) {
  throw new Error("FAIL: origin 从字符串变对象，前端必须兼容旧账本");
}

// ---- 4) job 保活 ----
if (!kernel.includes("RunService.begin(c, \"后台任务 · \" + job.name, job.owner)")) {
  throw new Error("FAIL: 后台任务在跑但没人保活 —— 回合一结束就被省电掐掉，长任务做不了");
}
if (!kernel.includes("RunService.end(c, job.owner)")) {
  throw new Error("FAIL: 任务结算后没撤保活");
}
if (!runsvc.includes("fun end(context: Context, sessionId: String = \"\")")) {
  throw new Error("FAIL: RunService 缺「只撤保活不发通知」的出口（否则同一件事弹两条）");
}

// ---- 5) 唤醒失败不丢 ----
if (!wake.includes("fun requeue(id: String, reason: String = \"\")") || !wake.includes("MAX_ATTEMPTS")) {
  throw new Error("FAIL: WakeRouter 没有回滚或没有重投上限");
}
if (!bridge.includes("fun wakeRequeue(") || !bridge.includes('"唤醒续轮失败："')) {
  throw new Error("FAIL: 桥没暴露回滚，或失败没落证据");
}
const wakeBlock = cut(js, "function requeueWakes(reason) {", "/**\n   * 认领并处理唤醒");
if (!wakeBlock.includes("Native.wakeRequeue")) throw new Error("FAIL: 前端没有回滚调用");
if (!js.includes("requeueWakes(msg);")) throw new Error("FAIL: failLive 没接回滚 —— 失败一次就把这件事永久吃掉");
if (!js.includes("lastWakeIds = ids.slice();")) throw new Error("FAIL: 认领时没记下是哪些唤醒跑的");
if (!js.includes("lastWakeIds = [];")) throw new Error("FAIL: 正常收尾没清空，下一轮失败会误回滚");
const turnEnd = cut(js, 'if (ev.t === "turn_end") {', "if (ev.cancelled) Live.cancelled = true;");
if (!turnEnd.includes("lastWakeIds = [];")) throw new Error("FAIL: 用户主动停止不该把唤醒补回来跟他对著干");

// ---- 6) 文档口径：不吹远程 ----
if (!readme.includes("本地数据与落点")) throw new Error("FAIL: README 缺「本地数据与落点」一节");
if (!readme.includes(".dsh/spill")) throw new Error("FAIL: README 要写清溢出落点在工作区");
for (const banned of ["跨网可自备公网中继", "桌面作为自有算力", "委托重/长任务"]) {
  if (readme.includes(banned) || js.includes(banned)) {
    throw new Error(`FAIL: 「${banned}」又回来了 —— 中继做不了，只剩同一局域网直连`);
  }
}

// ---- 7) 切屏收面板（否则抽屉会盖住新页面，还会一直挡住唤醒认领） ----
const goFn = cut(js, "function go(screen, opts) {", "const from = state.screen;");
if (!goFn.includes("if (sheetOpen && screen !== state.screen)")) {
  throw new Error("FAIL: go() 不关面板 —— 设置里打开的抽屉会留在对话上方，唤醒也因此不被认领");
}

console.log("✔ workstation: 溢出落工作区+字节上限 / 存储面板只清可再生 / 重跑有据 / job 保活 / 唤醒失败可回滚");
