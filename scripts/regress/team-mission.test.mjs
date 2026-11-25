// 回归：Step 5 —— 团队成员的任务成为 Mission（kind=team），与 job/schedule 同一账本、同一唤醒路由。
// 守三件事：① 任务板的每次变更都落到 Lead 会话的账上（不是成员会话，用户看不见那里）；
// ② 状态映射诚实（pending/in_progress/被依赖挡住/完成/删除），删除不留「已取消」的假痕迹；
// ③ 完成提醒走同一 Wake Router，策略是 queue（不抢当前回合），并按 revision 去重。
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
const registry = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/MissionRegistry.kt");
const wake = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/WakeRouter.kt");
const evidence = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/MissionEvidence.kt");
const plugin = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/agent/AgentTeamPlugin.kt");

// ---- 1) 账本 ----
const teamFn = cut(registry, "fun onTeamTask(", "@Synchronized\n    fun removeTeamTask");
for (const need of [
  'leadSession: String', 'put("kind", "team")', 'WAKE_QUEUE',
  '"in_progress" -> STATE_RUNNING', '"completed" -> STATE_SETTLED to OUTCOME_DONE',
  'if (ready) STATE_QUEUED else STATE_WAITING',
]) {
  if (!teamFn.includes(need)) throw new Error(`FAIL: onTeamTask 缺少 ${need}`);
}
if (!teamFn.includes('removeTeamTask(taskId)')) {
  throw new Error("FAIL: 任务被删掉后仍留一条 Mission —— 会显示成「做过的 cancelled 工作」");
}
if (!teamFn.includes("put(\"origin\", JSONObject().put(\"type\", \"team\")")) {
  throw new Error("FAIL: 团队 Mission 没记来路（成员名要能在抽屉里看到）");
}

// ---- 2) 唤醒 ----
const teamWake = cut(wake, "fun enqueueTeam(", "fun enqueueSchedule");
for (const need of ['"team:$taskId:completed:$revision"', 'MissionRegistry.WAKE_QUEUE', 'put("missionId", "team:$taskId")']) {
  if (!teamWake.includes(need)) throw new Error(`FAIL: enqueueTeam 缺少 ${need}`);
}

// ---- 3) 插件接线：两处变更都要同步 ----
const sync = cut(plugin, "private fun syncMission(", "private fun guard(block");
if (!sync.includes('ctx?.service("mission.registry")') || !sync.includes('ctx?.service("wake.router")')) {
  throw new Error("FAIL: syncMission 没从内核取账本/唤醒队列");
}
if (!plugin.includes("syncMission(b, t, \"create\")")) throw new Error("FAIL: team_task_create 没同步账本");
if (!plugin.includes("syncMission(b, t, action)")) throw new Error("FAIL: team_task_update 没同步账本（claim/complete 会看不见）");
if (!sync.includes('put("type", "team-report")')) throw new Error("FAIL: 完成没落「成员汇报」证据");
if (!sync.includes("wakes.enqueueTeam(t.id")) throw new Error("FAIL: 完成没走统一唤醒路由");
if (!sync.includes("rt().leadSession()")) throw new Error("FAIL: 归属会话不是 Lead 会话 —— 用户在自己的对话里看不到");

// ---- 4) 前端：kind 不能被压成 job ----
const ledger = cut(js, "function readMissionLedger(sid) {", "function missionRows(sid)");
if (!ledger.includes('m.kind === "team" ? "team" : "job"')) {
  throw new Error("FAIL: 团队任务被当成后台任务显示 —— 来源、状态文案、筛选全都会错");
}
for (const need of ["待认领", "被依赖挡住", "成员进行中", 'kind === "team" ? "团队"']) {
  if (!ledger.includes(need)) throw new Error(`FAIL: 团队状态/来源文案缺少 ${need}`);
}
if (!html.includes('data-job-source="team"')) throw new Error("FAIL: 任务页没有「团队」来源筛选");
const rows = cut(js, "const kernelRows = ledger", "const list = [");
if (!rows.includes("`团队任务 · ${m.member || \"任务板\"}`") || !rows.includes("replace(/^(job|schedule|team):/, \"\")")) {
  throw new Error("FAIL: 任务页的团队行 meta 或 data-job 前缀没处理");
}
if (!ledger.includes('member: String((m.origin && m.origin.member) || "")')) {
  throw new Error("FAIL: 账本行没带成员名 —— meta 只能重复状态文案，一行里出现两个「已完成」");
}
const drawer = cut(js, "function sheetMission(ids, pickedId) {", "function openMissionSheet(");
if (!drawer.includes('originType === "team"')) throw new Error("FAIL: 抽屉没显示「任务板 · 成员 X」的来路");
if (!evidence.includes('"team" -> "团队任务"') || !evidence.includes('"team-report" -> "成员汇报"')) {
  throw new Error("FAIL: 证据/来源标签缺团队条目");
}

// 新建会话必须把「上一场」的团队与成员视图一起清掉：
// 只清 sessionId 的话，顶栏团队角标还带着旧会话的成员数（用户实测），
// 从成员视图里点新建更糟 —— 输入框的消息会继续发给那个 teammate。
if (!/function startNewSession\(\) \{[\s\S]{0,700}state\.teamView = null;[\s\S]{0,240}stopTeamViewPoll\(\);[\s\S]{0,240}state\.team = null;\s*\n\s*syncTeamBadge\(\);/.test(js)) {
  throw new Error("FAIL: startNewSession 没清 teamView / state.team（团队角标会残留、消息会发错对象）");
}

// 进成员会话不能让 Lead 这一轮终止（用户实测：一进子会话 Lead 就停了）。
// 现在是「让到后台」：轮次交给内核继续跑、页面这只手松开，退出时按快照接回来。
const enter = cut(js, "function enterTeamView(name) {", "function exitTeamView(");
if (/stopLive\(/.test(enter)) throw new Error("FAIL: enterTeamView 又在停 Lead 的回合了");
for (const need of ["persistThread()", "state.bgRun = { id: Live.id", "Live.id = null;", "state.busy = false;"]) {
  if (!enter.includes(need)) throw new Error(`FAIL: 进成员视图「让到后台」缺一步：${need}`);
}
const exitView = cut(js, "function exitTeamView() {", "function syncTeamViewBar(");
if (!exitView.includes("openSession(parent)")) throw new Error("FAIL: 退出成员视图没走 openSession 这条唯一归路");
// 「把后台那一轮接回界面」必须挂在 openSession 上，而不是挂在退出按钮上：
// 从会话列表点回原会话、从别的视图切回来，走的都是 openSession。以前只有退出按钮
// 调 resumeBgRun，于是从列表点回来时 Lead 的流停在离开那一刻的半截、busy 变 false，
// 用户看到的就是「聊天记录和运行状态一起没了，杀后台重启才恢复」（已实测复现）。
const openFn = cut(js, "function openSession(id) {", "/* ---------------- sheet");
if ((openFn.match(/resumeBgRun\(s\.id\)/g) || []).length < 2) {
  throw new Error("FAIL: openSession 的两条分支里有一条没认领后台回合（sameRunning 与重建都算回来）");
}
// 库里查不到父会话时不能把界面清成空白：页面还握着那些节点，清空就是当着用户的面
// 「把记录弄没」（数据其实都在，只有杀后台重启才重新显示 —— 用户报的正是这个现象）
// openSession 要「要么整场换过去，要么什么都不动」：目标认不出来之前不许拆成员视图。
const openHead = openFn.slice(0, openFn.indexOf("if (state.teamView)"));
if (!/if \(!found\) return;/.test(openHead)) {
  throw new Error("FAIL: openSession 先清 teamView 再认目标 —— 认不到就留下「界面停在队友那一份、成员条已没」");
}
if (!exitView.includes("bucketHas(parent)")) {
  throw new Error("FAIL: 退出成员视图在库查不到时直接清空界面（应先把内存里那份认回来）");
}
// attachBlank 清空一份桶必须同时把 loaded 置回 false：留着 true，
// 下次打开这个 key 就是「有桶、一片空白、且不肯从库重灌」
const attachBlankFn = cut(js, "function attachBlank(key) {", "function adoptThread(");
if (!attachBlankFn.includes("b.loaded = false")) {
  throw new Error("FAIL: attachBlank 清空了节点却仍标着 loaded —— 这一份再也不会从库里重灌");
}
// 挂在后台的那一轮，它的桶不能被 LRU 挤掉：挤掉就只剩最后一次快照，
// 回来时节点、展开过的过程组、工具行全要重建（用户报的「记录像被抹掉」的一半）
const evictFn = cut(js, "function evictBuckets(keepKey) {", "function attachThread(key) {");
if (!evictFn.includes("state.bgRun && k === state.bgRun.sid")) {
  throw new Error("FAIL: evictBuckets 不保护后台那一轮的桶");
}
// 看队友时 Lead 那份桶的第三个身份：它既不是当前 thread，busy/Live 也让到后台了。
// 实测（成员视图里连点 10 个别会话）：这一份被挤出 LRU 后，回来只剩离开那一刻的快照，
// 19% 的正文对得上、81% 看不见 —— 用户报的「记录没了」就是这个形状。
if (!evictFn.includes("state.teamView && k === state.teamView.parent")) {
  throw new Error("FAIL: evictBuckets 不保护「正在看队友会话的那场 Lead」的桶");
}
// bgRun 只能在「回到它属于的那一场」时消费。以前第一行就把 state.bgRun 清空、
// 再判归属 —— 路过别的会话（哪怕点开一眼再走）就把后台那一轮的账丢了，
// 而这份账同时是上面那条桶保护的凭据。
const resumeFn = cut(js, "function resumeBgRun(sid) {", "function markInterruptedRound(");
const bgNullAt = resumeFn.indexOf("state.bgRun = null");
const ownAt = resumeFn.indexOf("bg.sid !== sid");
if (bgNullAt < 0 || ownAt < 0 || bgNullAt < ownAt) {
  throw new Error("FAIL: resumeBgRun 在归属判定之前就清空了 state.bgRun（路过别的会话会丢掉后台那一轮）");
}
// 回到本机会话必须和内核日志对一次账（桌面：重开走日志重放，页内快照只是缓存）。
// 只许补「严格前缀尾巴」：unseenTail 在两段文本不同源时整段返回，那会把上一轮的旧回复灌进这一场。
const tailFn = cut(js, "function appendMissedTail(sid) {", "function resumeBgRun(sid) {");
if (!tailFn.includes("startsWith(shown)") || tailFn.includes("unseenTail(")) {
  throw new Error("FAIL: appendMissedTail 不是只补前缀尾巴（可能整段灌进不属于这一轮的回复）");
}
// 补回来的那段要落进页内的库：只画在屏幕上，下次从库重灌又会少这一段
const commitFn = cut(js, "function commitReplayedRound(sid, finalText, stats) {", "按会话日志重放这一轮");
if (!commitFn.includes('LocalDB.push(sid, { role: "assistant"')) {
  throw new Error("FAIL: 补回来的那段没落进页内的库 —— 下次从库重灌又会少这一段");
}
if (commitFn.includes("renderThread()")) {
  throw new Error("FAIL: 收尾走了整表重绘 —— 已生成的内容不许整块重画（会闪）");
}
if (!openFn.includes("appendMissedTail(s.id)")) {
  throw new Error("FAIL: openSession 的重建分支没和内核日志对账（离开期间跑完的那一轮会少一段）");
}
// 回来不只补正文：按会话日志**重放这一轮**（思考 → 工具行 → 正文），形状才与桌面一致。
// 内核侧的段必须只取最后一轮，且两端名字一致（页面对不上名字就等于没有这条通道）。
const sessionStore = read("app/src/main/java/ai/deepseek/harness/mobile/agent/SessionStore.kt");
const agentBridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/AgentBridge.kt");
const traceFn = cut(sessionStore, "fun roundTrace(sessionId: String): JSONObject {", "/** 工具结果里给模型看的那段正文");
for (const need of ['== "turn/start"', '"tool/call"', '"tool/result"', '"step/start"', 'optString("reasoning")']) {
  if (!traceFn.includes(need)) {
    throw new Error(`FAIL: roundTrace 的段里缺 ${need} —— 重放出来的过程组会缺这一类行`);
  }
}
if (!/indexOfLast/.test(traceFn)) {
  throw new Error("FAIL: roundTrace 没限定「最后一轮」—— 把历史轮次也重放一遍就是重复画");
}
if (!agentBridge.includes("fun sessionRoundTrace(") || !js.includes("Native.sessionRoundTrace")) {
  throw new Error("FAIL: sessionRoundTrace 两端没接上（内核有接口、页面不调 = 回来仍然只补一段正文）");
}
// 重放必须「只画没画过的」：已显示的工具行按 id 跳、正文/思考按前缀跳；
// 而且它是增量 —— 不许在这里整表重绘（那条纪律见「对话流只做增量刷新」）。
const replayFn = cut(js, "function replayRound(sid, tr) {", "把「这一轮页面没渲染过的东西」");
for (const need of ["startsWith(shown.text)", "Flow.toolStart", "Flow.toolEnd", "Flow.think"]) {
  if (!replayFn.includes(need)) throw new Error(`FAIL: replayRound 缺 ${need} —— 重放会漏行或重复画`);
}
// 工具行必须「画过的不再画」：tool_start 分支第一行就按 id 跳过已显示的那批
if (!/tool_start"\)\s*\{\s*if \(has\[s\.id\]\) return;/.test(replayFn)) {
  throw new Error("FAIL: replayRound 不跳已显示的工具行 —— 重放会把已经画过的行再画一遍");
}
if (replayFn.includes("renderThread()")) {
  throw new Error("FAIL: replayRound 走整表重绘 —— 已生成的内容不许整块重画（会闪）");
}
// 「还在跑」与「已跑完」只有一个判据：内核里有活轮次就走实时认领，绝不能拿日志补出一行「已完成」
const tailFn2 = cut(js, "function appendMissedTail(sid) {", "从别的视图回来");
if (!tailFn2.includes("if (activeRun(sid)) return !!claimRun(sid);")) {
  throw new Error("FAIL: appendMissedTail 不先判「这一轮还在跑」—— 会把还在长的回复当已收尾结算");
}
const claimBody = cut(js, "function claimRun(sid) {", "这一轮的过程组/工具行按日志补回来");
if (claimBody.includes("agentActive")) {
  throw new Error("FAIL: claimRun 自己又解析了一遍 agentActive —— 在跑判据出现了第二份");
}
// 认领必须幂等：Live.id 已经在了还 beginLive，就是第二条流式气泡 + 同一批工具行画两遍
// + 上一个过程组永远收不到口（重载路径上被设备探针抓到过）。
if (!claimBody.includes("if (Live.id) return")) {
  throw new Error("FAIL: claimRun 不判「已经认领过」—— 重载 + 回来两条路会各认一次");
}
// 认领不能把别人的结算名单换掉（整组替换 = 名单外的过程组永远收不到口）
const adoptFn = cut(js, "function adoptShownTools() {", "把「这一轮页面没渲染过的东西」");
if (/Flow\.groups = \[open\]/.test(adoptFn) || !adoptFn.includes("Flow.groups.push(open)")) {
  throw new Error("FAIL: adoptShownTools 整组替换 Flow.groups —— 认领之外的过程组轮末收不了口");
}
// 轮末要按「本轮尾部」把所有过程组折齐，不能只信这份名单（closeGroup 只置 closed，折叠是 settle 做的）
if (!js.includes('if (g && g.kind === "pgroup" && !g.folded && groups.indexOf(g) < 0) groups.push(g);')) {
  throw new Error("FAIL: Flow.settle 不按本轮尾部补折叠 —— 快照重建/名单外的组会永远不折叠");
}
if (!js.includes("groups.sort((a, b) => thread.indexOf(a) - thread.indexOf(b));")) {
  throw new Error("FAIL: settle 的合并名单没按流里的位置排序 —— 「用时 N 秒」会落到错误的组上");
}
for (const need of ["function claimRun(sid)", "function resumeBgRun(sid)", "Native.sessionLastReply"]) {
  if (!js.includes(need)) throw new Error(`FAIL: 后台回合的接回链路缺 ${need}`);
}
// 成员视图要有进度：队友在跑时挂一行 lastAction（新内容来了先摘掉）
// 成员视图的进度走主对话的过程组头；那条自造的轮数提示行（「队友正在处理 · 第 N 轮推理」）
// 是用户点名要撤的 —— 轮数是内核的循环计数，不是「它在干什么」。
for (const need of ["function syncTeamViewPending(", "Flow.ensureGroup()", "Flow.paintGroupHead(g)"]) {
  if (!js.includes(need)) throw new Error(`FAIL: 成员视图没有进度反馈（${need}）`);
}
const teamRefresh = cut(js, "function refreshTeamViewMessages(force) {", "function syncTeamViewPending(v) {");
if (/\n\s*renderThread\(\);/.test(teamRefresh)) {   // 看的是真调用，不是注释里的说明
  throw new Error("FAIL: 成员视图每 2.2 秒整表重绘 —— 已生成内容被重写一遍（闪），主对话不是这样");
}
if (!teamRefresh.includes("Flow.toolStart(") || !teamRefresh.includes("Flow.toolEnd(")) {
  throw new Error("FAIL: 成员视图的工具行没走主对话同一套行渲染（toolStart/toolEnd → 过程组）");
}
if (js.includes("pendingNode")) {
  throw new Error("FAIL: 成员视图还留着自造的进度节点（应改为过程组头）");
}
// 成员日志的工具条目必须带 id/args/output：journal 存的字段叫 output，
// 读成 text 会让每一条工具行都是空行（「它到底看了什么」看不出来）
const teamBridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/TeamBridge.kt");
if (!/put\("out", ev\.optString\("output"\)\)/.test(teamBridge) || !/put\("args", ev\.optString\("args"\)\)/.test(teamBridge)) {
  throw new Error("FAIL: teamMemberLog 没把工具的 args/output 带给前端（成员视图的工具行会是空的）");
}

// 自己发的那句：气泡由发送处（push(NODES.user)）画，运行时也会把它写进成员日志 ——
// sendTeamViewMessage 要把游标推进一条再刷新，否则同一句话在成员视图里出现两行（实测）。
const sendTeam = cut(js, "function sendTeamViewMessage(text) {", "/* ---- 团队限额");
if (!sendTeam.includes("refreshTeamViewMessages(true)")) {
  throw new Error("FAIL: 成员会话里发出的消息要等 2.2 秒轮询才出现");
}
if (!sendTeam.includes("v.seenTotal = (v.seenTotal || 0) + 1;")) {
  throw new Error("FAIL: 发完没推进游标 —— 日志里那条会在刷新时再画一遍（一行变两行）");
}
if (sendTeam.includes("push(NODES.user(text)")) {
  throw new Error("FAIL: 成员会话里又本地回显了一条 —— 会和发送处那条重复");
}
// 离开期间跑完的回合：从内核会话日志取最后一条回复补尾巴
if (!read("app/src/main/java/ai/deepseek/harness/mobile/bridge/AgentBridge.kt")
  .includes("fun sessionLastReply(sid: String)")) {
  throw new Error("FAIL: 缺 sessionLastReply 桥（离开期间跑完就没法补最后一段）");
}

/* ---- 队友用哪个模型（rc.199：子代理档对成员曾是死代码） ----
   spawn 时把空的成员模型落成 lead.model，运行时那行 ifBlank 就永远进不去 ——
   设置里的 subagentModel 只对普通子代理生效，对团队成员形同虚设。
   成员模型必须存「显式那一份」（空 = 跟随），生效值留到跑这一轮时再算。 */
const teamRuntime = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/team/TeamRuntime.kt");
const teamTypes = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/team/TeamTypes.kt");
if (!/val useModel = model\.trim\(\)/.test(teamRuntime) || /model\.ifBlank \{ lead\.model \}/.test(teamRuntime)) {
  throw new Error("FAIL: spawn 又把空的成员模型落成 Lead 模型 —— 子代理档会再次变成死代码");
}
if (!teamRuntime.includes("MemberLlm.resolve(lead, m.model)")) {
  throw new Error("FAIL: 队友这一轮没走 MemberLlm.resolve（模型/端点又分两处各写一套）");
}
if (!/explicit\.ifBlank \{ lead\.subagentModel\.ifBlank \{ lead\.model \} \}/.test(teamTypes)) {
  throw new Error("FAIL: MemberLlm 的三档优先级被改动了（成员显式 > 子代理档 > Lead）");
}

/* ---- 子代理那一行（用户点名：不要轮数卡片） ---- */
const driver = read("app/src/main/java/ai/deepseek/harness/mobile/agent/AgentDriver.kt");
const subRun = read("app/src/main/java/ai/deepseek/harness/mobile/agent/SubagentRunner.kt");
if (!/ToolExecContext\.currentOrNone\(\)\.callId/.test(driver)) {
  throw new Error("FAIL: 子代理进度事件没用工具调用 id —— 与 tool_start 对不上会多出永远「启动中」的那一行");
}
if (/n\.rounds/.test(js)) {
  throw new Error("FAIL: 子代理/成员行又拿 rounds 渲染轮数（目标模式的轮数预算是另一处，不在此列）");
}

// 输出预算不许再另压一层：推理型模型先把预算花在「想」上，
// 子代理压到 4096 / 成员压到 8192 就等于让它永远没有结论（本地 llama.cpp 实测复现）。
if (/minOf\(childCfg\.maxOut, 4096\)/.test(subRun) || !/AgentRequest\.body\(childCfg\.model, messages, childCfg\.maxOut/.test(subRun)) {
  throw new Error("FAIL: 子代理的输出预算又被压回 4096");
}
if (/minOf\(lead\.maxOut, 8192\)/.test(teamRuntime) || !/AgentRequest\s*\.body\(cfg\.model, messages, lead\.maxOut/.test(teamRuntime)) {
  throw new Error("FAIL: 成员的输出预算又被压回 8192");
}
if (!/Number\(n\.completion\) > 0/.test(js)) {
  throw new Error("FAIL: 截断提示又开始报「0/N tokens」这种没信息量的数");
}

/* ---- 子代理与成员必须照设置里的「上下文窗口 / 最大输出」办 ---- */
for (const [name, src] of [["SubagentRunner", subRun], ["TeamRuntime", teamRuntime]]) {
  if (!src.includes("Presets.catalogFor")) {
    throw new Error(`FAIL: ${name} 没按上下文窗口裁工具目录（小窗口端点每一发都会 400）`);
  }
  if (!src.includes("compactInTurn")) {
    throw new Error(`FAIL: ${name} 不做轮内压缩（跑几十轮必然超窗）`);
  }
}
if (!teamRuntime.includes("teammateTools(lead.preset, lead.contextWindow)")) {
  throw new Error("FAIL: 成员的工具目录没读 Lead 的上下文窗口");
}

/* 成员正文要逐字流（与主对话同一观感）：内核攒 live、按节流推进快照；页面增量 patch */
if (!/var liveText: String = ""/.test(teamTypes)) {
  throw new Error("FAIL: 成员没有 liveText（界面只能等轮末日志，正文不是逐字长）");
}
if (!/m\.liveText = \(m\.liveText \+ chunk\)\.takeLast\(8_000\)/.test(teamRuntime)) {
  throw new Error("FAIL: 成员的流式 delta 没攒进 liveText");
}
if (!/m\.liveText = ""/.test(teamRuntime)) {
  throw new Error("FAIL: 权威全文落日志后没清 live（会和正式节点重复一段）");
}
if (!/\.put\("live", it\.liveText\)/.test(teamRuntime)) {
  throw new Error("FAIL: 团队快照没带 live（页面拿不到正在写的那半截）");
}
if (!/function syncTeamViewLive\(v\)/.test(js) || !/v\.liveNode\.text !== live/.test(js)) {
  throw new Error("FAIL: 成员视图没有 live 节点的增量 patch");
}
if (!/v\.liveNode\.text = m\.text \|\| ""/.test(js)) {
  throw new Error("FAIL: 日志里的权威全文没有收口到 live 节点（会出现两段一样的正文）");
}

// 三条请求循环的预算/请求体只许有一处实现（AgentRequest），别又在循环里内联
for (const [name, src] of [["SubagentRunner", subRun], ["TeamRuntime", teamRuntime]]) {
  if (!src.includes("AgentRequest.body(") || !src.includes("AgentRequest.effWindow(")) {
    throw new Error(`FAIL: ${name} 没走共用的请求体/窗口算法`);
  }
  if (/\* 110/.test(src) || /put\("max_tokens"/.test(src)) {
    throw new Error(`FAIL: ${name} 又内联了预算计算`);
  }
}

// 三条循环的 system 拼装与单次工具执行只许有一处实现（AgentLoop）
const agentDriver = read("app/src/main/java/ai/deepseek/harness/mobile/agent/AgentDriver.kt");
for (const [name, src] of [["AgentDriver", agentDriver], ["SubagentRunner", subRun], ["TeamRuntime", teamRuntime]]) {
  if (!src.includes("AgentLoop.system(")) {
    throw new Error(`FAIL: ${name} 没走共用的 system 拼装`);
  }
  if (/assembler\.assemble\(/.test(src)) {
    throw new Error(`FAIL: ${name} 又直接调 assembler.assemble（三份实现会漂）`);
  }
}
for (const [name, src] of [["SubagentRunner", subRun], ["TeamRuntime", teamRuntime]]) {
  // 委派链路那一口气的骨架只有一份（AgentLoop.execCalls）：assistant 消息、参数解析、
  // 逐条执行、tool 消息都在里面；成员必须拿到 Outcome —— 用输出文本回头解析 ok
  // 会把成功的纯文本输出记成失败。
  if (!/AgentLoop\.execCalls\(/.test(src)) {
    throw new Error(`FAIL: ${name} 没走共用的循环骨架（又自己拼一遍 assistant + 逐条执行，Gate 就会漏改）`);
  }
  if (/pipeline\.executeBatch\(/.test(src)) {
    throw new Error(`FAIL: ${name} 又内联了 executeBatch 包装`);
  }
}

// 团队快照的推送计数随快照下发：合批是否生效要用数字证明，而不是感觉
if (!/pushCount\+\+/.test(teamRuntime) || !/put\("stats", JSONObject\(\)\.put\("pushes"/.test(teamRuntime)) {
  throw new Error("FAIL: 团队快照没有推送计数（无法验证 120ms 合批）");
}

// 三条循环的工具 wire 与回灌消息只许有一处实现（AgentLoop）
if (!/val wire = AgentLoop\.wire\(result\.toolCalls\)/.test(agentDriver)
    || !/AgentLoop\.toolMessage\(/.test(agentDriver)
    || /put\("role", "tool"\)/.test(agentDriver)) {
  throw new Error("FAIL: Lead 循环里又内联了 tool_calls wire 或回灌消息");
}

/* 3b：成员正文只有一条通道 —— agentTeam 全量投影帧（桌面只有这一条） */
if (/put\("t", "team_delta"\)/.test(teamRuntime)) {
  throw new Error("FAIL: 成员正文又开了一条 team_delta 增量通道（同一份正文两条真相，各要一份兜底）");
}
if (!/put\("live", it\.liveText\)\.put\("liveSeq", it\.liveSeq\)/.test(teamRuntime)) {
  throw new Error("FAIL: 快照没带上在跑的那段正文与序号 —— 删掉增量通道后成员视图就没有实时观感了");
}
if (/"team_delta"|function appendMemberDelta/.test(js)) {
  throw new Error("FAIL: 页面还在接成员增量事件");
}
if (!/function syncTeamViewLive/.test(js) || !/seq === v\.liveSeq/.test(js)) {
  throw new Error("FAIL: 成员视图的进行中文本不再按快照的 liveSeq 判新内容（每来一帧就白 patch）");
}

console.log("✔ team-mission: 任务板进 Lead 账本 / 状态诚实 / 完成走统一唤醒 / 前端来源与抽屉认得团队 / 队友模型三档优先级");
