// 回归：异步工作必须在对话里有一个可见实体（Mission 卡 / 进行中带），
// 且不改变现有设计：工具行仍是扁平行、对话页没有第二个导航、卡片沿用交付卡材质。
// 这是「任务触发了、对话界面没有任何响应」的界面侧守卫：
//   job_start/job_done + 定时任务 → 按 sessionId 投影 → 当前会话一张卡 + 输入框上沿一条带。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const js = read("app/src/main/assets/web/app.js");
const css = read("app/src/main/assets/web/styles.css");
const html = read("app/src/main/assets/web/index.html");
const jobs = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/jobs/JobRegistry.kt");
const kernel = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/ToolKernel.kt");

function cut(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`FAIL: 找不到起点 ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error(`FAIL: 找不到终点 ${endMarker}`);
  return src.slice(start, end);
}

// ---- 1) 任务开始/结束都要通知前端 ----
for (const need of ["private val onStart: (Job) -> Unit", "runCatching { onStart(job) }"]) {
  if (!jobs.includes(need)) throw new Error(`FAIL: JobRegistry 缺少开始回调（${need}）—— 卡片只能等完成后才出现`);
}
for (const need of ['put("t", "job_start")', "onStart = { job ->"]) {
  if (!kernel.includes(need)) throw new Error(`FAIL: 内核没有发出 job_start（缺少 ${need}）`);
}
for (const need of ['if (ev.t === "job_start")', 'if (ev.t === "job_done")', "syncMissions()"]) {
  if (!js.includes(need)) throw new Error(`FAIL: 前端没有把任务事件接到 Mission 投影（缺少 ${need}）`);
}

// ---- 2) 投影只按当前会话 ----
const projection = cut(js, "function missionRows(sid) {", "function missionActive(");
for (const need of ['String(j.owner || "") === String(sid)', 'String(s.sessionId || "") === String(sid)', 'state: j.status === "running" ? "running" : "done"', 'state: active ? "waiting" : "done"']) {
  if (!projection.includes(need)) throw new Error(`FAIL: Mission 投影缺少 ${need} —— 卡片会串会话/状态不准`);
}
if (!js.includes("const active = state.sessionId ? missionActive(state.sessionId) : [];")) {
  throw new Error("FAIL: 进行中带没有会话守卫 —— 没有会话时会显示别人的任务");
}

// ---- 3) 会话内卡片：新增节点，不是工具行/导航 ----
for (const need of ['mission: (o) => (', 'case "mission"', 'class="mission-card', "whalePlushHTML()", "data-mission-open", "whale-plush-light.png"]) {
  if (!js.includes(need)) throw new Error(`FAIL: 对话内 Mission 卡缺少 ${need}`);
}
const card = cut(js, 'case "mission": {', 'case "notice":');
if (!card.includes("mc-bar") || !card.includes("mc-state")) {
  throw new Error("FAIL: Mission 卡没有状态/进度渲染");
}
if (card.includes("mc-row")) {
  throw new Error("FAIL: B 版卡片不该再出现列表行 —— 换成毛绒 + 进度条 + 页脚");
}
const sync = cut(js, "function syncMissionCard() {", "function syncMissions()");
for (const need of ["NODES.mission(payload)", "patchNode(existing)", "persistThread()", "thread.__sid !== state.sessionId"]) {
  if (!sync.includes(need)) throw new Error(`FAIL: Mission 卡缺少 ${need} —— 不会随任务更新或会串会话`);
}
const goChat = cut(js, 'if (screen === "chat") setTimeout', "}, 0);");
if (!goChat.includes("syncMissions()")) {
  throw new Error("FAIL: 回到对话页没有对齐 Mission 状态");
}

// ---- 4) 进行中带 + 任务页筛选的 DOM ----
for (const need of ['id="missionStrip"', 'id="missionStripText"', 'id="jobStateSeg"', 'id="jobSourceRow"', 'data-job-state="waiting"', 'data-job-source="schedule"']) {
  if (!html.includes(need)) throw new Error(`FAIL: 缺少界面挂点 ${need}`);
}
if (!js.includes("function bindJobFilters()")) {
  throw new Error("FAIL: 任务页筛选没有绑定事件");
}
const render = cut(js, "function renderJobs() {", "function bindJobFilters()");
for (const need of ["JobsFilter.state", "JobsFilter.source", "没有符合条件的任务", "syncMissionStrip()"]) {
  if (!render.includes(need)) throw new Error(`FAIL: renderJobs 缺少 ${need}`);
}

// ---- 5) 设计不变量：材质复用、工具行不变、图标是抠图毛绒 ----
for (const need of [
  ".mission-card {",
  "border: 0.5px solid var(--glass-edge);",
  "background: linear-gradient(180deg, var(--glass-a) 0%, var(--glass-b) 100%);",
  ".mission-strip {",
  ".job-state-seg",
  ".mc-plush",
  'html[data-theme="dark"] .mc-plush .mc-plush-light',
  ".mc-bar i",
  "@keyframes plushIdle",
  "@keyframes plushIdleMini",
]) {
  if (!css.includes(need)) throw new Error(`FAIL: 样式缺少 ${need}`);
}
for (const need of ["whale-plush-light.png", "whale-plush-dark.png", 'class="mc-plush mc-plush-mini"']) {
  if (!html.includes(need) && !js.includes(need)) throw new Error(`FAIL: 图标不是抠图毛绒（缺少 ${need}）`);
}
if (js.includes("mk-ai-avatar") || js.includes("mission-avatar")) {
  throw new Error("FAIL: 对话消息不该出现头像列 —— 身份标记只属于 Mission 卡/进行中带");
}
if (!css.includes("@media (prefers-reduced-motion: reduce)") || !css.includes("mcSweep")) {
  throw new Error("FAIL: 进度条动效缺少 reduced-motion 兜底");
}

/* 点「进行中」带 → 定位到本轮 Mission 卡。
   真机症状：点完整个界面上移 ~20px 且回不来。根因是 scrollIntoView 会把 #device
   （overflow:hidden 的外壳）也当成滚动祖先一起滚，滚过之后没人把它归零。
   约束：① 只滚 #chatScroll；② #device 一旦被滚立刻拉回 0。 */
if (!/missionStrip\.addEventListener\("click"[\s\S]{0,900}scrollChatTo\(card\)/.test(js)) {
  throw new Error("FAIL: 进行中带的点击没有走 scrollChatTo —— 界面会整屏上移回不来");
}
if (/missionStrip\.addEventListener\("click"[\s\S]{0,400}\.scrollIntoView\(/.test(js)) {
  throw new Error("FAIL: 进行中带又用 scrollIntoView 了 —— 它会连 #device 一起滚");
}
if (!/function scrollChatTo\(el, dur = 320\) \{[\s\S]{0,300}\$\("#chatScroll"\)/.test(js)
  || !/function scrollChatTo\(el, dur = 320\) \{[\s\S]{0,500}easedScrollTo\(sc,/.test(js)) {
  throw new Error("FAIL: scrollChatTo 必须只动 #chatScroll（走 easedScrollTo）");
}
if (!/function bindDeviceScroll\(\) \{[\s\S]{0,400}if \(dev\.scrollTop\) dev\.scrollTop = 0;/.test(js)) {
  throw new Error("FAIL: 缺少 #device 偏移兜底 —— 任何 scrollIntoView 之后整屏都可能上移卡死");
}
if (!/bindFollowScroll\(\);\s*\n\s*bindDeviceScroll\(\);/.test(js)) {
  throw new Error("FAIL: bindDeviceScroll 没接线（定义了不调用等于没有）");
}

console.log("✔ mission-card: 任务开始即出现 / 按会话投影 / 卡片与进行中带可见 / 设计不变量保持");
