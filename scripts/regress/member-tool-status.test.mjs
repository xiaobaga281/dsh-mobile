/**
 * 成员/子代理工具调用的「成败与目录」接线回归。
 *
 * 用户报「团队里的成员调用工具老是失败」，实测（模拟器 + mock 两人团队）根因不在模型也不在插件：
 * TeamRuntime 拿**输出文本**再解析一次来决定成败 —— bash / write 的成功输出是纯文本
 * （`exit=0 Alarms DCIM…`、`已写入 notes/alpha.md（41 字节）`），`JSONObject(text).optBoolean("ok")`
 * 只能给 false，于是每条成功命令在成员视图里都显示「执行失败」。
 * 桌面端从来没有这一步：Outcome 就是成败的唯一来源（core/tools 派发口）。
 *
 * 顺带钉住同族的几条接线：小窗口下团队工具必须还在（Lead 和成员两头都要），
 * 「本轮没给的工具」必须在执行器里按同一份目录拒绝并说清原因，委派链路（成员 + 子代理）
 * 的权限闸门必须原样继承父轮不放宽，任务板必须认得出「是谁在改」。
 *
 * 运行：node scripts/regress/member-tool-status.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
const ok = (m) => console.log(`  PASS ${m}`);
const bad = (m) => { console.error(`  FAIL ${m}`); failed += 1; };

const team = src("app/src/main/java/ai/deepseek/harness/mobile/kernel/team/TeamRuntime.kt");
const loop = src("app/src/main/java/ai/deepseek/harness/mobile/agent/AgentLoop.kt");
const pipe = src("app/src/main/java/ai/deepseek/harness/mobile/agent/ToolPipeline.kt");
const driver = src("app/src/main/java/ai/deepseek/harness/mobile/agent/AgentDriver.kt");
const sub = src("app/src/main/java/ai/deepseek/harness/mobile/agent/SubagentRunner.kt");
const presets = src("app/src/main/java/ai/deepseek/harness/mobile/agent/Presets.kt");
const tbridge = src("app/src/main/java/ai/deepseek/harness/mobile/bridge/TeamBridge.kt");
const plugin = src("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/agent/AgentTeamPlugin.kt");
const board = src("app/src/main/java/ai/deepseek/harness/mobile/kernel/team/TeamBoard.kt");
const missions = src("app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/MissionRegistry.kt");
const ui = src("web/src/20-ui.js");

// ---- 1) 成败只有一个来源：Outcome，不再回读输出文本 ----
if (/JSONObject\(outText\)\.optBoolean/.test(team)) {
  bad("TeamRuntime 还在拿输出文本解析 ok —— 纯文本的成功输出会被记成「执行失败」");
} else {
  ok("TeamRuntime 不再回读输出文本判成败");
}
if (/journal\.toolExec\(memberSid, c\.id, c\.name, outcome\.ok/.test(team)) {
  ok("成员日志的 toolExec 用的是 outcome.ok");
} else {
  bad("成员日志的 toolExec 没有用 outcome.ok（改回文本解析就会复发）");
}
if (/fun execOutcome\([\s\S]{0,600}\): ToolPipeline\.Outcome/.test(loop)) {
  ok("AgentLoop 的单条出口返回完整 Outcome（成败只有一个来源）");
} else {
  bad("AgentLoop 的单条出口不再返回 Outcome —— 调用方只能自己猜成败");
}
if (/fun execTool\(/.test(loop)) {
  bad("AgentLoop 又长出 execTool 那层「只看文本」的薄壳 —— 它会邀请调用方回头解析输出");
} else {
  ok("没有「只看文本」的第二出口（委派循环统一走 execCalls 拿 Outcome）");
}

// ---- 2) 三条循环都把自己那份目录交给执行器 ----
for (const [label, text, want] of [
  ["Lead", driver, /catalog = namesOf\(turn\.toolDefs\)/],
  ["子代理", sub, /AgentLoop\.execCalls\([\s\S]{0,1800}tools\.toSet\(\)/],
  ["成员", team, /AgentLoop\.execCalls\([\s\S]{0,1800}tools\.toSet\(\)/],
]) {
  if (want.test(text)) ok(`${label}的工具执行带了本轮目录`);
  else bad(`${label}没有把本轮目录传给执行器 —— 「本轮没给」与「插件被禁用」又会混成一句`);
}
if (/private fun notInCatalog\([\s\S]{0,700}TOOL_NOT_IN_CATALOG/.test(pipe)
  && /val offCatalog = notInCatalog\(call, catalog\)/.test(pipe)) {
  ok("执行器按同一份谓词拒绝，并给 TOOL_NOT_IN_CATALOG + 可用清单");
} else {
  bad("ToolPipeline 没有目录拒绝分支（模型调到没给的工具时会拿到误导文案）");
}

// ---- 3) 团队工具不参与窗口裁剪 ----
if (/val TEAM_TOOLS = setOf\(\s*"spawn_teammate"/.test(presets)) {
  ok("Presets.TEAM_TOOLS 存在且含 spawn_teammate");
} else {
  bad("没有 TEAM_TOOLS 豁免表：窗口 ≤32k 时 Lead 的 schema 里没有建队工具（实测 168 秒建不出队友）");
}
if (/teamEnabled && it in Presets\.TEAM_TOOLS/.test(driver)) {
  ok("Lead 目录裁剪豁免团队工具（装配了团队就必须看得见，桌面 core/tools 同义）");
} else {
  bad("Lead 的裁剪没有豁免团队工具");
}

// ---- 4) 冷恢复要带得上端点：桥与页面两头都接上 ----
if (/fun teamUserMessage\(sid: String, name: String, message: String, cfgJson: String\)/.test(tbridge)
  && /AgentConfig\.parse\(JSONObject\(cfgJson\)\)/.test(tbridge)
  && /rt\.send\(name, message, leadCfg\)/.test(tbridge)) {
  ok("teamUserMessage 收页面带来的配置并用于冷恢复（密钥只在调用里过境）");
} else {
  bad("teamUserMessage 没有配置通道：重启后唤不起 inactive 队友（TEAM_NO_LEAD_CONTEXT）");
}
if (/Native\.teamUserMessage\(v\.parent, v\.name, text, cfg\)/.test(ui)
  && /NativeAgent\.payload\(text, \[\], m, ep, \[\], \{ sessionId: v\.parent \}\)/.test(ui)) {
  ok("成员视图发消息时把当前端点配置一起交给内核");
} else {
  bad("页面侧没有传配置 —— 桥的参数永远是空字符串，冷恢复照旧失败");
}

// ---- 5) 成员目录同样豁免团队工具 ----
// 上面那条豁免只做在 Lead 侧（AgentDriver），漏了 teammateTools：窗口 ≤32k（本地模型全在这档）
// 时成员手里只剩干活的本事，而身份提示词逐条让它「用 send_message 汇报」「用 team_task_* 协作」
// —— 每次汇报都撞 TOOL_NOT_IN_CATALOG，团队面板上就是「队友调用工具失败」。
if (/it in core \|\| it in dynamic \|\| it in ai\.deepseek\.harness\.mobile\.agent\.Presets\.TEAM_TOOLS/.test(team)) {
  ok("成员目录也豁免团队工具（与 Lead 同一个口径）");
} else {
  bad("teammateTools 仍按窗口裁剪团队工具 —— 小窗口下成员发不出 send_message / 认领不了任务");
}

// ---- 6) 委派链路的闸门不放宽（plan 模式 / Mission 收窄 / 危险确认口径）----
// 桌面 child-agent 的原则：子级权限范围派出时定死，不能从会话内部抬起来。
// 手机端两处都硬编码 (planMode=false, planApproved=true)，于是 Lead 还在计划模式、
// 计划没被批准时，队友/子代理已经在写盘；成员还固定 confirmDanger=true，
// Lead 是完全访问反而把队友的危险命令全打成「已拒绝」。
for (const [label, text, cfgName] of [["成员", team, "cfg"], ["子代理", sub, "childCfg"]]) {
  const gate = text.match(/ToolPipeline\.Gate\(([\s\S]{0,320})/);
  if (!gate) { bad(`${label}找不到 Gate 构造（改得没法解析了）`); continue; }
  const body = gate[1];
  const mission = /effectivePermissionFor\(/.test(body);
  const plan = new RegExp(`${cfgName}\\.planMode`).test(body) && new RegExp(`${cfgName}\\.planApproved`).test(body);
  const danger = new RegExp(`${cfgName}\\.needConfirm`).test(body);
  if (mission && plan && danger) ok(`${label}的 Gate 继承 plan 模式、合 Mission 收窄、按 cfg.needConfirm 判危险`);
  else bad(`${label}的 Gate 没有完整继承父轮：mission收窄=${mission} plan透传=${plan} 危险口径=${danger}`);
}
if (/ToolPipeline\.Gate\((cfg|childCfg)\.permission, false, true/.test(team + sub)) {
  bad("还有硬编码的 (permission, false, true) Gate —— 计划模式与 Mission 收窄又被绕过");
} else {
  ok("没有残留「Gate(x.permission, false, true)」这种放宽写法");
}
if (/fun effectivePermissionFor\(sessionMode: String, missionId: String\)/.test(missions)) {
  ok("MissionRegistry 提供委派链共用的合档入口");
} else {
  bad("MissionRegistry 没有 effectivePermissionFor：子级只能读裸 cfg.permission");
}

// ---- 7) 任务板认得出「是谁在改」----
// actor() 以前写死 Actor("lead", LEAD)：成员 claim 的任务 owner 记成 "lead"（Lead 面板看不见
// 是谁在干，写租约冲突报成「Lead 占着这个文件」），而 TeamBoard 里 owner 判定永远不触发。
if (/TeamBoard\.Actor\("lead", MemberRole\.LEAD\)/.test(plugin)) {
  bad("AgentTeamPlugin.actor() 还写死 lead —— 任务归属与 owner 鉴权又是假的");
} else if (/TeamCall\.callerName\(\)/.test(plugin) && /MemberRole\.LEAD else MemberRole\.TEAMMATE/.test(plugin)) {
  ok("actor() 用 TeamCall 的调用者身份（send_message 早就这么认人，任务板跟上）");
} else {
  bad("actor() 既没写死也没认身份 —— 检查这次改动");
}
// 身份为什么可靠：成员的工具是一条一条在自己线程里原地跑的（executeBatch 单条 + 无声明预算
// = runSingle 就地执行），不落到并发池，ThreadLocal 不会串。团队工具都不声明 timeoutMs。
if (/override val timeoutMs/.test(plugin)) {
  bad("团队工具声明了 timeoutMs —— 调用会进并发池，TeamCall 的线程局部身份就丢了");
} else {
  ok("团队工具没有声明预算：成员调用原地执行，身份不会掉在池线程上");
}
// claim 只能认领给自己（代领是 reassign 的活儿，只有 Lead 能做）
if (/t\.owner = if \(actor\.role == MemberRole\.LEAD && !owner\.isNullOrBlank\(\)\) owner else actor\.name/.test(board)) {
  ok("claim 的 owner 只认调用者；Lead 才能代领");
} else {
  bad("claim 还接受任意 owner —— 队友一句 claim(owner=\"别人\") 就绕过了「只有 Lead 能改派」");
}
// reassign 接收者：lead 伪行 + 名册里的 active 成员（桌面 resolveActiveMember）
if (/ownerArg != "lead"/.test(plugin) && /m\.phase != MemberPhase\.ACTIVE/.test(plugin)) {
  ok("reassign 认 lead 伪行，其余必须是名册里的 active 成员");
} else {
  bad("reassign 的接收者校验不完整：Lead 收回自己的活会被拒，或指派给创建失败的成员");
}

// 改派的判据是「前置有没有完成」（桌面 taskReady），不是「现在能不能领」：
// 两者混成一个 readyOf（要求 status==pending）时，改派进行中的任务永远失败，
// 还报一句「还被  挡着」（挡住它的依赖一个都没有）。
if (/fun readyOf\(t: TeamTask\): Boolean = t\.status == TaskStatus\.PENDING && unblockedOf\(t\)/.test(board)
  && /if \(!unblockedOf\(t\)\) \{/.test(board)) {
  ok("任务板分得清「没被挡住」与「现在能领」");
} else {
  bad("readyOf 又合成了一个判据 —— 「换人干到一半的活」会再次被 TEAM_TASK_BLOCKED 挡死");
}

process.exit(failed ? 1 : 0);
