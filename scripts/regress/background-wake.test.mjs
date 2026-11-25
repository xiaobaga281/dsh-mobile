// 回归：后台任务完成后必须能进入 agent 上下文，而不是只弹一条 UI 提示。
// Step 2 起统一走 WakeRouter（jobs/schedules 同一条持久队列）：
//   JobRegistry 结算 → ToolKernel 写 wakes（活体 wait / 模型 kill 跳过）
//   → 忙碌：agent/pre-step 从 wakes 认领并注入；空闲：前端 wakeMissions 发起一轮。
// 断言真实源码片段，防止「只改 UI、不接 agent」或退回两套队列。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const js = read("app/src/main/assets/web/app.js");
const registry = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/jobs/JobRegistry.kt");
const wake = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/WakeRouter.kt");
const kernel = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/ToolKernel.kt");
const terminal = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/fs/TerminalPlugin.kt");
const bridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/KernelBridge.kt");

function cut(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`FAIL: 找不到起点 ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error(`FAIL: 找不到终点 ${endMarker}`);
  return src.slice(start, end);
}

// ---- 1) 内核：job 结算入统一队列；等待/模型 kill 不产生唤醒 ----
for (const need of ["fun enqueueJob(", "fun drainForAgent(", "fun pending(", "fun consume("]) {
  if (!wake.includes(need)) throw new Error(`FAIL: WakeRouter 缺少 ${need}`);
}
const onDone = cut(kernel, "onDone = { job ->", "onStart = { job ->");
for (const need of ["wakes.enqueueJob(", "!job.awaited", "!job.killRequested", "RunService.remind"]) {
  if (!onDone.includes(need)) throw new Error(`FAIL: job_done 没有接统一唤醒（缺少 ${need}）`);
}
for (const need of ["@Volatile var awaited", "@Volatile var killRequested", "job.completionNotice = completionText(job)"]) {
  if (!registry.includes(need)) throw new Error(`FAIL: JobRegistry 的结算语义被拆（缺少 ${need}）`);
}
// 旧 notices 收件箱已经整块删掉（rc.186 之后它是 inert 的）：留着一个没人写的队列，
// 下一个人只会「顺手接上」，于是同一件事又有两条唤醒路径
for (const gone of ["enqueueNotice", "drainNotices", "pendingNotices", "noticesFile", "MAX_NOTICES_PER_OWNER", "noticeQueued"]) {
  if (registry.includes(gone)) throw new Error(`FAIL: JobRegistry 里还留着旧 notices 基础设施 ${gone}`);
  if (kernel.includes(gone)) throw new Error(`FAIL: ToolKernel 里还留着旧 notices 基础设施 ${gone}`);
}
// 后台但进程活着时也要能把用户叫回来：只看 eventSink 会把这种情形吞掉
for (const need of ["fun shouldNotify(", "RunService.isAppVisible()"]) {
  if (!kernel.includes(need)) throw new Error(`FAIL: 通知条件没考虑「App 在后台但进程还活着」（缺少 ${need}）`);
}

// ---- 2) 忙碌会话：pre-step 从统一队列注入 ----
for (const need of ['"agent/pre-step", "job-inbox"', 'ctx.service("wake.router")', "wakes.drainForAgent(sid)"]) {
  if (!terminal.includes(need)) throw new Error(`FAIL: pre-step 没有从统一唤醒队列注入（缺少 ${need}）`);
}
if (terminal.includes("reg.drainNotices(sid)")) {
  throw new Error("FAIL: pre-step 仍从旧 job notices 取唤醒 —— 会漏掉定时任务");
}

// ---- 3) 桥：前端可列出/消费 ----
for (const need of ["fun wakeList(sessionId: String)", "fun wakeConsume(idsCsv: String)"]) {
  if (!bridge.includes(need)) throw new Error(`FAIL: 缺少 ${need}，前端无法认领唤醒`);
}

// ---- 4) 前端：统一 wakeMissions，job 走同一入口 ----
const handler = cut(js, 'if (ev.t === "job_done") {', 'if (ev.t === "schedule_due") {');
for (const need of ["wakeMissions(", "sameSession", "woke"]) {
  if (!handler.includes(need)) throw new Error(`FAIL: job_done 没有接统一唤醒（缺少 ${need}）`);
}
const wakeFn = cut(js, "function wakeMissions(sessionId) {", "function openSession(");
for (const need of ["wakeListFor(", "list.filter(wakeReady)", "Native.wakeConsume", "startWakeTurn(first)"]) {
  if (!wakeFn.includes(need)) throw new Error(`FAIL: wakeMissions 缺少 ${need}`);
}
const ready = cut(js, "function wakeReady(w) {", "function startWakeTurn(");
for (const need of ["state.busy", "state.screen !== \"chat\"", "input.value.trim()", "defer"]) {
  if (!ready.includes(need)) throw new Error(`FAIL: wakeReady 缺少 ${need} —— 会抢草稿/打断忙碌会话`);
}
if (!js.includes('if (ev.t === "turn_end") {') || !cut(js, 'if (ev.t === "turn_end") {', "/** 目标续跑").includes("wakeMissions()")) {
  throw new Error("FAIL: 本轮结束后没有补认领唤醒");
}
for (const legacy of ["takeWakeNotices", "wakeForJobNotices", "jobDrainNotices"]) {
  if (js.includes(legacy)) throw new Error(`FAIL: 前端仍有旧唤醒路径 ${legacy}`);
}

// ---- 页面被系统回收后重载：认领在跑的轮次，并把**已流出的字**补回来 ----
// 只认领 id 是不够的：重载后的气泡是空的，用户看到的仍然像「回复被终止了」
// （实测：退出应用再进来、息屏后再亮屏）。快照来自合帧器 —— 它才是「页面见过什么」的真值来源。
if (!/fun agentActive\(\)[\s\S]{0,900}coalescers\[id\]\?\.snapshot\(\)[\s\S]{0,700}"runs", runs/.test(
  read("app/src/main/java/ai/deepseek/harness/mobile/bridge/AgentBridge.kt"))) {
  throw new Error("FAIL: agentActive 没带全部在跑的轮次与快照（重载后无法接上已输出的字）");
}
const coalescer = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/StreamCoalescer.kt");
if (!/private val log = ArrayList<JSONObject>\(\)/.test(coalescer) || !/fun remember\(ev: JSONObject\)/.test(coalescer)) {
  throw new Error("FAIL: StreamCoalescer 不再按发出顺序记「已发给页面」的每一段");
}
if (!/"segments", JSONArray\(\)\.apply \{ log\.forEach \{ put\(it\) \} \}/.test(coalescer)) {
  throw new Error("FAIL: snapshot 没带有序 segments —— 重载后正文接得上、工具行整段消失");
}
// 工具实时输出走同一个合帧窗口（按调用 id 各排一条通道），但不进回放日志：
// 一条命令能刷出几 MB，而 tool_end 本来就带完整结果
if (!/fun feedOutput\(id: String, chunk: String\)/.test(coalescer) ||
    !/if \(t\.startsWith\(OUTPUT_PREFIX\)\) return/.test(coalescer)) {
  throw new Error("FAIL: 工具实时输出没接进合帧器，或把 stdout 灌进了回放日志");
}
const agentBridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/AgentBridge.kt");
for (const need of [/coalescer\.remember\(out\)/, /"tool_output" -> coalescer\.feedOutput/,
                    /StreamCoalescer\.OUTPUT_PREFIX/]) {
  if (!need.test(agentBridge)) throw new Error(`FAIL: AgentBridge 缺一步（${need.source.slice(0, 40)}…）`);
}
for (const need of [/const runs = \(\(Array\.isArray\(act\.runs\)/, /Live\.id = mine\.id;/,
                   /NativeAgent\.on\(\{ t: "reasoning", text: restThink/, /NativeAgent\.on\(\{ t: "delta", text: restText/,
                   /const shown = roundShown\(\)/, /function unseenTail\(shown, full\)/,
                   /if \(shown\.text\) Live\.parts = \[shown\.text\];/,
                   // 工具行按原序补回来：已存在的行不重复画，还在跑的行要挂回 _byId 才收得到 tool_end
                   /function adoptShownTools\(\)/, /const shownTools = adoptShownTools\(\);/,
                   /if \(s\.t === "tool_start" && shownTools\[s\.id\]\) return;/]) {
  if (!need.test(js)) throw new Error(`FAIL: 前端认领缺一步（${need.source.slice(0, 44)}…）`);
}

// ---- 进程被杀（不是重载）：这一轮真的没了 —— 落盘要赶在隐藏前，界面要说出「没跑完」 ----
// 实测：杀掉前页面已流出 892 字，库里只有 567 字（8 秒节流那一次走空闲回调，页面隐藏后
// 就再也不跑了）；重开会话只看到回复停在「第 27 段」，没有一行说明它被打断。
if (!/function persistThread\(sync\)/.test(js)) {
  throw new Error("FAIL: persistThread 不支持同步落盘 —— 隐藏前那次补不上");
}
if (!/if \(sync \|\| !window\.requestIdleCallback\) snap\(\)/.test(js)) {
  throw new Error("FAIL: sync=true 仍然被挪到空闲时段（隐藏页里空闲回调可能永不触发）");
}
if (!/if \(Live\.id \|\| state\.busy\) \{ try \{ persistThread\(true\)/.test(js)) {
  throw new Error("FAIL: 页面转 hidden 时没有同步落快照");
}
if (!/function markInterruptedRound\(s\)/.test(js)) {
  throw new Error("FAIL: 没有「这一轮没跑完」的判定");
}
if (!/markInterruptedRound\(s\);[\s\S]{0,120}followBottomOn = true/.test(js)) {
  throw new Error("FAIL: 重开会话重建流之后没补中断标记");
}
if (!/kind: "interrupted"/.test(js) || !/case "interrupted":/.test(js)) {
  throw new Error("FAIL: interrupted 节点没有工厂或没有渲染分支");
}
for (const need of ['"这一轮没跑完": "Turn interrupted"',
                    '"应用被退出或被系统回收，上面是已经产出的部分"']) {
  if (!js.includes(need)) throw new Error(`FAIL: 中断标记的文案缺英文词条：${need.slice(0, 24)}`);
}

// ---- 「没跑完」的判据：落盘时登记的 open，而不是「库里最后一条是不是用户那句」 ----
// 停止 / 切走会话都会就地收尾，且这两条路**不 commit assistant 消息** ——
// 用消息判据会把用户自己停掉的回合也标成「没跑完」（实测：切走再回来就多一行误报）。
for (const need of [/saveShot\(id, shot, open\)/, /p\.open = Number\(open\) \|\| 0/,
                    /const openAt = \(Live\.running && Live\.sessionId === sid\)/,
                    /open: Number\(p\.open\) \|\| 0/,   // get() 不带上它 = 判据永远读不到
                    /Live\.running = true;/, /if \(!s \|\| !\(Number\(s\.open\) > 0\)\) return false;/]) {
  if (!need.test(js)) throw new Error(`FAIL: open 登记缺一步（${need.source.slice(0, 46)}…）`);
}
{
  const clears = (js.match(/Live\.running = false;/g) || []).length;
  if (clears < 3) throw new Error(`FAIL: 只有 ${clears} 条收尾路径清 Live.running（需要 finish/stop/fail 三条）`);
}

console.log("✔ background-wake: job 完成进统一队列，忙碌 pre-step / 空闲 wakeMissions 二选一，重载后认领带快照");
