/**
 * 委派链路与流式合批的「只有一份」回归。
 *
 * 病根不是某个函数写错，是同一套规则被写了两遍：
 *  · 合批曾有四处（内核轮次 / 桥的 OpenAI 流 / 桥的 Messages 流 / 团队成员正文），
 *    窗口与保序规则各写各的 —— rc.129 那次「思考挤一起、正文挤后面」就是其中一份重排了段序。
 *  · 循环骨架曾有两条（团队成员、子代理），assistant 消息 / 参数解析 / 逐条执行 /
 *    tool 消息 / Gate 各抄一份 —— 「委派链路不越权」那次必须改两处才算修完，正是这份重复的账。
 *
 * 所以这里不测行为（行为在 StreamFlusherTest / DelegatedLoopTest 里逐条断言），
 * 只钉结构：**规则只许有一份**。谁再抄第二份，这里先红。
 *
 * 运行：node scripts/regress/delegated-loop.test.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(ROOT, "app/src/main/java/ai/deepseek/harness/mobile");
const read = (p) => readFileSync(join(SRC, p), "utf8");

let failed = 0;
const ok = (m) => console.log(`  PASS ${m}`);
const bad = (m) => { console.error(`  FAIL ${m}`); failed += 1; };

const flusher = read("agent/StreamFlusher.kt");
const coalescer = read("bridge/StreamCoalescer.kt");
const loop = read("agent/AgentLoop.kt");
const team = read("kernel/team/TeamRuntime.kt");
const sub = read("agent/SubagentRunner.kt");

/** 主源码里出现「自己攒段队列」的类 —— 只允许 StreamFlusher 一份 */
const ktFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".kt")) ktFiles.push(p);
  }
})(SRC);
const queueOwners = ktFiles
  .map((p) => ({ rel: p.slice(SRC.length + 1).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }))
  .filter((f) => /ArrayDeque<Pair<String, StringBuilder>>/.test(f.text))
  .map((f) => f.rel);
if (queueOwners.length === 1 && queueOwners[0] === "agent/StreamFlusher.kt") {
  ok(`段队列只有一份：${queueOwners[0]}`);
} else {
  bad(`有 ${queueOwners.length} 份自攒的段队列（${queueOwners.join(", ")}）—— `
    + "窗口与保序规则又写了第二遍，改一处漏一处");
}

// ---- 1) 合批：四条流式链路都走 StreamFlusher ----
if (/private val flusher = StreamFlusher\(/.test(coalescer) && !/pending\.addLast/.test(coalescer)) {
  ok("StreamCoalescer 只留回放日志，队列与窗口交给 StreamFlusher");
} else {
  bad("StreamCoalescer 自己还攒着一份段队列 —— 与 StreamFlusher 两套窗口，改一处漏一处");
}
// 成员正文不再有第二条通道：桌面推给客户端只有 agentTeam 全量投影帧
// （projection.ts:389 stateVersion:4；agent-team README:201「全量广播、无增量无分页」）。
// 手机端以前另造了一条 team_delta（120ms 合批 + 页面按 seq 判连续/重复）—— 同一份正文
// 两条真相，断档、重复、快照与增量交替写入各要一份兜底，这类「多出来的实时」就是漂移的源头。
if (!/put\("t", "team_delta"\)/.test(team) && !/StreamFlusher\(/.test(team)) {
  ok("成员正文只走快照那一路（内核侧没有第二条增量通道，也没有本地合批窗口）");
} else {
  bad("成员那边又出现增量事件或合批器 —— 桌面只有一条 agentTeam 全量投影帧");
}
if (/ticker = StreamTicker\.MainLooper/.test(coalescer)) {
  ok("桥出口挂主线程 Looper：合批不为它新起常驻线程");
} else {
  bad("合批用了默认调度线程：八个队友同时在跑就是八条常驻线程");
}
const bundle = readFileSync(join(ROOT, "app/src/main/assets/web/app.js"), "utf8");
if (!/"team_delta"|appendMemberDelta/.test(bundle)) {
  ok("页面不消费成员增量事件");
} else {
  bad("页面还在接成员增量事件：同一份正文两条真相要各自兜底");
}
if (/function syncTeamViewLive/.test(bundle) && /liveSeq/.test(bundle)) {
  ok("成员视图的进行中文本只有快照这一份来源（live / liveSeq）");
} else {
  bad("成员视图的进行中文本没了落点 —— 删增量通道时把快照那一路也带坏了");
}

// ---- 2) 骨架：成员与子代理共用 AgentLoop.execCalls ----
for (const [label, text] of [["团队成员", team], ["子代理", sub]]) {
  if (/AgentLoop\.execCalls\(/.test(text)) ok(`${label}的循环骨架走 AgentLoop.execCalls`);
  else bad(`${label}还在自己拼 assistant 消息 + 逐条执行 —— 骨架又分叉了（Gate 曾因此漏改两处）`);
  // 单条执行出口只该留在 execCalls 里；调用方绕过它 = 第二套骨架
  if (!/AgentLoop\.exec(Tool|Outcome)\(/.test(text)) ok(`${label}不直接单条调流水线`);
  else bad(`${label}绕开 execCalls 直接单条调流水线，取消/否决/记账的口径会分叉`);
}

// ---- 3) execCalls 的契约（行为在 DelegatedLoopTest 里逐条跑，这里钉结构）----
if (/fun execCalls\([\s\S]{0,1800}?TOOL_NOT_STARTED/.test(loop)
  && /messages\.add\(toolMessage\(c\.id, outcome\.output\)\)/.test(loop)) {
  ok("execCalls 给每条调用都落一条 tool 消息（含被取消的 TOOL_NOT_STARTED）");
} else {
  bad("execCalls 不再保证「每个 tool_call 都有回答」—— 被中断的那几条会让下一发请求 400");
}
if (/AgentLoop\.execTool\(/.test(team + sub) || /fun execTool\(/.test(loop)) {
  bad("又长出「只看文本」的第二出口 execTool —— 它在邀请调用方回头解析输出判成败");
} else {
  ok("单条执行只有一个出口：execCalls → execOutcome（完整 Outcome）");
}

process.exit(failed ? 1 : 0);
