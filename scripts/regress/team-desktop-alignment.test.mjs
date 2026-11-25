/**
 * 团队「对齐电脑端」守卫。
 *
 * 每一条都是逐行读过桌面 experimental/agent-team + tool-agent-team + client-ui-agent-team
 * 源码后决定的口径，不是凭印象：
 *   · 运行期报错不进终态 —— 桌面 projection.ts:264 只承认 provisioning → active/failed，
 *     roster.ts:301-305 明确写了「不要为了记一个失败而发明 active → failed」
 *   · 写范围是提示不是锁 —— task-view.ts:44-49 只塞一句 warning，validation.ts:22-26 写明不当锁
 *   · 输入长度有上限 —— task-board.ts:60-61 / 150-153（subject 200、description 16384）、
 *     roster.ts:241（成员 description 200）
 *   · 进度是小事件 + 一个并行预算 —— 桌面只在事务边界写 team/member；
 *     maxActiveSubagents 一份额度，队友本身就是 subagent 的孩子
 *   · Lead 专属操作判在服务层 —— roster.ts:189/234 的 TEAM_LEAD_REQUIRED、:192 的
 *     TEAM_INVALID_TARGET（team.spec.ts:440/444 就是这两条断言）
 *   · 错误码用桌面的名字、上限走同一份配置、冷恢复逐条对账、提示词分身份
 *
 * 这里钉结构（口径有没有被改回去），行为逐条在 TeamRosterTest / TeamBoardTest /
 * TeamJournalTest / TeamCallTest 里跑，端到端在 scripts/emulator/anchor_local.py team 里跑。
 *
 * 运行：node scripts/regress/team-desktop-alignment.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = "app/src/main/java/ai/deepseek/harness/mobile";
const read = (p) => readFileSync(join(ROOT, SRC, p), "utf8");

let failed = 0;
const ok = (m) => console.log(`  PASS ${m}`);
const bad = (m) => { console.error(`  FAIL ${m}`); failed += 1; };

const team = read("kernel/team/TeamRuntime.kt");
const roster = read("kernel/team/TeamRoster.kt");
const board = read("kernel/team/TeamBoard.kt");
const types = read("kernel/team/TeamTypes.kt");
const journal = read("kernel/team/TeamJournal.kt");
const plugin = read("kernel/plugin/builtin/agent/AgentTeamPlugin.kt");

// ---- 1) 运行期报错：active 成员只记错误，不进终态 ----
if (/if \(m\.phase == MemberPhase\.ACTIVE\) scope\.roster\.error\(m, reason\)/.test(team)
  && /fun error\(m: TeamMember, error: String\)/.test(roster)
  && !/m\.phase = MemberPhase\.FAILED/.test(roster.split("fun error(")[1].split("\n    }")[0])) {
  ok("成员跑挂一轮 → 仍是 active（Lead 重发一条就能叫醒）");
} else {
  bad("运行期报错又把成员打成 FAILED：一次端点抖动就永久少一个队友（桌面禁止 active→failed）");
}
if (/if \(lastError\.isNotBlank\(\)\) put\("error", lastError\)/.test(types)) {
  ok("active 成员的快照也带 error，界面才说得清「这一轮没跑完」和「没建起来」的区别");
} else {
  bad("error 只在 FAILED 时输出：重跑失败后界面只剩一个灰点");
}

// ---- 2) 写范围：提示，不是锁 ----
if (!/TEAM_WRITE_CONFLICT|findLeaseConflict|leasedScopes|leaseViolation/.test(team + board)) {
  ok("运行时不再拦写入（写租约那套硬锁已撤，与桌面 advisory 一致）");
} else {
  bad("写租约硬拦又回来了：两条任务都声明 src/ 时，后动手的成员每次写都被挡");
}
if (/write_scopes 是写范围声明，\n?\s*\|  与别人 in-progress 的范围重叠时，任务板会提示/.test(plugin)
  && !/是真锁/.test(plugin)) {
  ok("提示词说的是「任务板提示」，没有再骗模型「运行时真拦」");
} else {
  bad("提示词与实现不一致：模型会以为重叠写入会被系统挡掉");
}

// ---- 3) 输入长度上限（三个数与桌面同）----
for (const [name, value] of [["TASK_SUBJECT_MAX", 200], ["TASK_DESC_MAX", 16_384], ["MEMBER_DESC_MAX", 200]]) {
  const m = new RegExp(`const val ${name} = ([\\d_]+)`).exec(types);
  if (!m) bad(`TeamTypes 里找不到 ${name}（桌面 validation.ts 的三个上限）`);
  else if (Number(m[1].replace(/_/g, "")) !== value) bad(`${name} = ${m[1]}，桌面是 ${value}`);
  else ok(`${name} = ${value}（与桌面同数）`);
}
if (/requiredText\(subject, "subject", TASK_SUBJECT_MAX\)/.test(board)
  && /requiredText\(description, "description", TASK_DESC_MAX\)/.test(board)
  && /requiredText\(description, "description", MEMBER_DESC_MAX\)/.test(team)) {
  ok("create / edit / spawn 三处都过 requiredText");
} else {
  bad("三个上限有一处没接上：模型写一条五万字的 subject 会整份进日志与每次快照");
}

// ---- 4) 进度是小事件；状态迁移才写整份快照 ----
if (/appendOrThrow\(\s*leadSid, "team\/progress"/.test(journal) && !/fun memberProgress[\s\S]{0,200}"team\/member"/.test(journal)) {
  ok("成员进度写 team/progress（只带 turns/工具数/tokens/lastAction）");
} else {
  bad("每步又写整份 team/member 快照：几十步 = 几十份 500B 近似副本，回放与面板跟着变慢");
}
if (/"team\/progress" ->/.test(journal)) {
  ok("回放认得 team/progress（并进成员，但不参与状态迁移校验）");
} else {
  bad("回放不读 team/progress：重启后进度统计归零");
}

// ---- 5) 一个并行预算 ----
if (/SubagentCapacity\s*\n?\s*\.tryAcquire\(scope\.sid, limit\.maxConcurrent\)/.test(team)
  || /SubagentCapacity\.tryAcquire\(scope\.sid, limit\.maxConcurrent\)/.test(team)) {
  ok("成员与子代理抢同一份额度（桌面只有一个 maxActiveSubagents）");
} else {
  bad("成员不再占子代理额度：两套计数又是 8×8=64 个并发 LLM 循环");
}
if (/SubagentCapacity\.release\(scope\.sid\)/.test(team)) {
  ok("额度在 finally 里归还（异常、中断、卸载都还得清）");
} else {
  bad("成员没归还并行额度：跑几次之后整支团队永远抢不到槽");
}

// ---- 6) 内核是进程级的：界面重建不许连带杀掉在跑的回合与团队 ----
// 桌面对照：harness 是常驻进程，渲染层怎么崩都不影响内核。手机端 onRenderProcessGone
// 走 recreate()，内核若是 Activity 的 lazy 字段，等于每次救界面就把团队杀掉（实测过）。
const activity = readFileSync(join(ROOT, "app/src/main/java/ai/deepseek/harness/mobile/MainActivity.kt"), "utf8");
const host = readFileSync(join(ROOT, "app/src/main/java/ai/deepseek/harness/mobile/KernelHost.kt"), "utf8");
if (/val kernel:[\s\S]{0,200}KernelHost\.of\(applicationContext/.test(activity)
  && !/val kernel:[\s\S]{0,80}by lazy/.test(activity)
  && /@Volatile\s+private var instance: ToolKernel\?/.test(host)) {
  ok("内核走 KernelHost 进程单例，Activity 只按应用上下文取用");
} else {
  bad("内核又挂回 Activity 了：WebView 渲染进程被回收 = 正在跑的回合与整支团队一起没");
}
if (/appContext\?\.applicationContext/.test(host)) {
  ok("内核只拿 applicationContext（不持有 Activity，跨实例活着不漏）");
} else {
  bad("KernelHost 没兜 applicationContext：一旦把 Activity 传进内核，重建后就握着死界面");
}

// ---- 7) 给模型的团队纪律：桌面 tool-agent-team/src/index.ts:41 的两句必须在 ----
// 「Shared-task workflow is list, get, claim with the current revision, perform the work,
//  then complete」+「Task readiness never starts an owner」。少后一句的后果是用户看到的：
// Lead 建了任务、队友明明在干活，任务板上却从始至终是「可认领」—— 没人 claim，而 ready
// 本来就不产生 owner（桌面 task-view.ts:59 的 ready 对 in_progress 恒 false）。
if (/ready 只代表「没被前置挡住」，不代表有人在做/.test(plugin) && /先 claim 再开工/.test(plugin)) {
  ok("Lead 段：说清 ready≠有人在做，spawn 时要交 task id 并要求先 claim");
} else {
  bad("Lead 段缺「ready 不会给你 owner」这条纪律：派下去的活会一直显示可认领");
}
if (/team_task_list 找到属于你的活/.test(team) && /不会自动给你 owner/.test(team)) {
  ok("成员段：开工前 list → get → claim，做完 complete");
} else {
  bad("成员段没要求先 claim：队友干活、任务板不动（用户报的「从始至终可认领」）");
}

// ---- 8) Lead 专属操作判在服务层，不只判在 schema ----
// 桌面对照：roster.ts:189/234 的 membership.role !== 'lead' → TEAM_LEAD_REQUIRED，
// roster.ts:192 的 target === root.id → TEAM_INVALID_TARGET（team.spec.ts:440/444 就是这两条断言）。
// 手机端只靠「队友目录里没有这个 schema」是不够的：目录由档位、上下文窗口、插件启停共同决定。
const call = read("kernel/team/TeamCall.kt");
if (!/fun requireLead\(op: String\): String/.test(call)) {
  bad("TeamCall 没有 requireLead：服务层失去唯一兜底的那一刀");
} else {
  ok("TeamCall.requireLead 存在（身份不认识就抛 TEAM_LEAD_REQUIRED）");
}
const spawnBody = team.split("fun spawn(")[1];
const interruptBody = team.split("fun interrupt(target: String): JSONObject")[1].split(/\n    \}\n/)[0];
// 「第一刀」要真的是第一刀：认人必须排在准入闸门和 attach 之前，
// 否则队友已经改过 current scope 才被拒，等于把前台团队挪走了。
const leadCut = spawnBody.indexOf("TeamCall.requireLead");
if (leadCut >= 0 && leadCut < spawnBody.indexOf("checkAdmission(") && leadCut < spawnBody.indexOf("attach(")) {
  ok("spawn 入口第一刀认人（在 attach / 校验名字之前）");
} else {
  bad("spawn 不再在服务层认 Lead：队友只要目录放行就能建队");
}
if (/TeamCall\.requireLead/.test(interruptBody.slice(0, 400)) && /"TEAM_INVALID_TARGET"/.test(interruptBody.slice(0, 600))) {
  ok("interrupt 先认人、再拦「中断 lead」");
} else {
  bad("interrupt 缺服务层校验：roster 里 lead 是真实一行，队友一句 interrupt_agent 就能把 Lead 写成 inactive");
}
const selfCut = interruptBody.indexOf('"lead"');
if (selfCut >= 0 && selfCut < interruptBody.indexOf("TEAM_MEMBER_NOT_FOUND")) {
  ok("「lead」不会被当成「查无此人」—— 自中断在查表之前就被拒");
} else {
  bad("自中断排在查表之后或缺失：模型收到「活跃成员 lead 不存在」，只会换个名字再试一次");
}
// 手机端比桌面宽一格，而且必须是这一格：provisioning 可中断（建队请求唯一能撤的入口）
if (/m\.phase == MemberPhase\.FAILED/.test(interruptBody) && !/resolveActive\(scope, target\)/.test(interruptBody)) {
  ok("中断允许 provisioning 成员（端点挂住时建队还能撤），failed 仍按「查无此人」");
} else {
  bad("中断又只认 active 成员：建队卡在端点上时，这个成员既跑不完也叫不醒");
}

// ---- 9) 错误码目录：桌面已有的语义就用桌面的码名（对齐③）----
// 手机端以前自造同义码（TEAM_FORBIDDEN / TEAM_TASK_BAD_ACTION / TEAM_TASK_DEP_UNKNOWN /
// TEAM_TASK_CYCLE / TEAM_TARGET_SELF / TEAM_MEMBER_NAME_INVALID / TEAM_NO_SESSION …）。
// 后果不是「名字不优雅」：同一件事在两端给出两种码，模型学到的纠正经验跨端全废，
// 日志与将来的跨端导入还要再翻译一遍。桥层信封码（TEAM_UNAVAILABLE / TEAM_INTERRUPT_FAILED
// 这类只给前端看的）不在此列 —— 它们不是域操作返回的错。
const allDomain = [team, roster, board, types, journal, plugin, call].join("\n");
const retired = [
  "TEAM_FORBIDDEN", "TEAM_TASK_BAD_ACTION", "TEAM_TASK_DEP_UNKNOWN", "TEAM_TASK_CYCLE",
  "TEAM_TARGET_SELF", "TEAM_TARGET_REQUIRED", "TEAM_MEMBER_NAME_INVALID", "TEAM_NO_SESSION",
  "TEAM_MESSAGE_EMPTY", "TEAM_PROMPT_EMPTY", "TEAM_MEMBER_NOT_ACTIVE", "TEAM_MEMBER_PROVISIONING",
  "WAIT_CANCELLED",
];
// 注释里提旧码是历史说明，不算复活：只看真正抛出的字符串字面量
const thrown = (s) => (s.match(/"(TEAM_[A-Z_]+|WAIT_[A-Z_]+)"/g) || []).map((x) => x.slice(1, -1));
const thrownCodes = new Set(thrown(allDomain));
const revived = retired.filter((c) => thrownCodes.has(c));
if (revived.length === 0) {
  ok(`自造同义码没有复活（域层抛出码 ${thrownCodes.size} 种）`);
} else {
  bad(`这些自造码又出现在 throw 里：${revived.join(" / ")} —— 桌面同语义的码见 task-board.ts / roster.ts / validation.ts`);
}
for (const code of [
  "TEAM_TASK_ALREADY_CLAIMED", "TEAM_TASK_UNAUTHORIZED", "TEAM_TASK_DEPENDENCY_CYCLE",
  "TEAM_INVALID_TARGET", "TEAM_SELF_MESSAGE", "TEAM_LEAD_REQUIRED", "TEAM_INVALID_CONFIG",
  "TEAM_WAIT_ABORTED", "TEAM_INVALID_MEMBER_NAME",
]) {
  if (!thrownCodes.has(code) && !(code === "TEAM_WAIT_ABORTED" && /TEAM_WAIT_ABORTED/.test(plugin))) {
    bad(`桌面码 ${code} 在手机端不存在：那一类失败会给出一个模型认不出的答案`);
  }
}
if (/cancel\(false\)/.test(team) && /TEAM_DISPOSAL_TIMEOUT/.test(team)) {
  ok("卸载先温和取消（成员在边界自己收尾），超时才升级成硬中断并报 TEAM_DISPOSAL_TIMEOUT");
} else {
  bad("卸载又回到一上来就 cancel(true)/没有超时留痕：正在写的工具被中断，日志留半截");
}

// ---- 10) 提示词分身份（桌面 team:identity 是 membership 现算的）----
const psBody = plugin.split("override fun promptSection()")[1].split("\n    }")[0];
if (/TeamCall\.callerName\(\) == "lead"/.test(psBody) && /teammateSection\(/.test(psBody)) {
  ok("插件提示段按调用者分支：Lead 一份、teammate 一份");
} else {
  bad("提示段又是单一一份：队友那一轮也读得到「Lead = 你，只有你能创建/中断」");
}
const mateSec = plugin.split("private fun teammateSection(")[1] ?? "";
if (mateSec.length > 0 && !/Lead = 你/.test(mateSec.split("\n    }")[0])) {
  ok("teammate 段里没有「Lead = 你」这种把它当建队者的说法");
} else {
  bad("teammate 段又把读的人当成建队者：两段自相矛盾的身份说明同时进模型");
}
// 数值必须来自生效的配置，不是一句「在设置页里」
if (/limits\.maxConcurrent/.test(plugin) && /limits\.maxMessageBytes/.test(plugin) && /subagentLimits\?\.maxDepth/.test(plugin)) {
  ok("并行 / 消息上限 / 递归深度按当前生效值写进提示词");
} else {
  bad("提示词又把上限写成了固定话术：设置一改，模型照旧按旧数安排分工");
}
// 成员身份段的 enter 必须排在提示词装配之前
const enterAt = team.indexOf("TeamCall.enter(m.name, scope.sid)");
const assemblyAt = team.indexOf("AgentLoop.system(assembler, cfg");
if (enterAt >= 0 && assemblyAt >= 0 && enterAt < assemblyAt) {
  ok("成员线程从装配提示词那一刻起就带着自己的身份");
} else {
  bad("runMember 又在装配完之后才 enter：插件那段读到的身份还是 lead");
}
if (/spawn_teammate", "interrupt_agent"/.test(team) || /"spawn_teammate",\n?\s*"interrupt_agent"/.test(team)) {
  bad("成员目录又把 spawn/interrupt 摘掉了：服务层那一刀永远不会被走到，规则只剩提示词");
} else {
  ok("队友手里保留 spawn_teammate / interrupt_agent，由服务层拒绝（与桌面一致）");
}

// ---- 11) 团队面板与任务卡：桌面 client-ui-agent-team/TeamAction.tsx 的形状 ----
const ui = readFileSync(join(ROOT, "web/src/20-ui.js"), "utf8");
const css = readFileSync(join(ROOT, "app/src/main/assets/web/styles.css"), "utf8");
const card = ui.split("function teamTaskHtml(t)")[1].split("\n  }")[0];
for (const [needle, label] of [
  ["t.description", "描述（含展开）"],
  ["data-task-x", "展开/收起入口"],
  ["未分配", "无 owner 的「未分配」"],
  ["可开始", "pending 的「可开始 / 被依赖阻塞」"],
  ["t.blockedBy", "依赖列表"],
  ["t.writeScopes", "写入范围列表"],
  ["writeScopeWarnings", "写范围重叠提示"],
]) {
  if (card.includes(needle)) ok(`任务卡渲染${label}（与桌面 TaskCard 同一组字段）`);
  else bad(`任务卡不渲染${label}：这一条正是用户看不出「谁在干、干什么、跟谁撞车」的原因`);
}
if (/暂无共享任务，可以通过对话创建/.test(ui)) {
  ok("空任务板给的是桌面那句空态，不是一句「任务板是空的」");
} else {
  bad("空态文案与桌面不一致（用户看不出「这里本来就能通过对话创建」）");
}
if (/\.tm-task-desc\.clamp/.test(css) && /-webkit-line-clamp: 2/.test(css)) {
  ok("描述默认两行夹（桌面 clampedDescription 同一形状）");
} else {
  bad("描述夹行的样式没了：长说明会把整块面板撑到不可读");
}
// 事件 version：写侧带上、读侧闸门（桌面 types.ts 的 version: 2 + projection.ts:231）
if (/const val TEAM_EVENT_VERSION = 2/.test(journal)
  && /startsWith\("team\/"\)/.test(journal)
  && /withTeamVersion/.test(journal)) {
  ok("team/* 事件带 version，回放对不认识的版本终态拒绝");
} else {
  bad("团队事件又没有版本号：字段一改，旧日志只能靠「读不到就给默认值」硬猜");
}
if (/ev\.has\("version"\)/.test(journal)) {
  ok("没有 version 的旧行照旧可读（升级不会把现役团队判成记录无效）");
} else {
  bad("版本闸门没放过旧日志：真机上的团队文件全是没带 version 的");
}

process.exit(failed ? 1 : 0);
