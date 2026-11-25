// 回归：八个可靠性/安全洞的接线不能被后续重构悄悄拆掉。
// 这里只做结构断言（真实源码），行为级验证在 JVM 单测与设备实测里。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const main = read("app/src/main/java/ai/deepseek/harness/mobile/MainActivity.kt");
const agent = read("app/src/main/java/ai/deepseek/harness/mobile/agent/AgentDriver.kt");
const team = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/team/TeamRuntime.kt");
const backup = read("app/src/main/res/xml/backup_rules.xml") + read("app/src/main/res/xml/data_extraction_rules.xml");
const ci = read(".github/workflows/android-ci.yml");
const js = read("app/src/main/assets/web/app.js");
const video = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/doc/VideoPlugin.kt");
const memory = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/agent/MemoryPlugin.kt");
const facts = JSON.parse(read("docs/facts.json"));
const netcfg = read("app/src/main/res/xml/network_security_config.xml");
const llm = read("app/src/main/java/ai/deepseek/harness/mobile/agent/LlmClient.kt");
const probe = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/GenProbe.kt");
const rawHttp = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/HttpExchange.kt");

function need(source, marker, why) {
  if (!source.includes(marker)) throw new Error(`FAIL: ${why}（缺 ${marker}）`);
}

// 3) 子 frame 桥隔离：WebView 级 document-start 脚本
need(main, "addDocumentStartJavaScript", "预览嵌套 iframe 的 document-start 隔离没了");
need(main, "window.top === window.self", "document-start 脚本必须在子 frame 才抹桥");
need(main, "DSHNative", "document-start 脚本必须覆盖 DSHNative*");

// 4) 备份排除 SharedPreferences
need(backup, 'domain="sharedpref"', "凭据又会被云备份/换机迁移带走");

// 1) 取消长等待：主动释放计划/提问/确认闸门
need(agent, "planWaiter.getAndSet(null)", "停止键又无法释放计划评审");
need(agent, "askWaiters", "停止键又无法释放 ask_user_question");
need(agent, "approveWaiters", "停止键又无法释放危险确认");

// 2) 团队提交竞态：先登记 FutureTask 再派发
const reg = team.indexOf("scope.active[m.name] = f");
const dispatch = team.indexOf("pool.execute(f)");
if (reg < 0 || dispatch < 0 || reg > dispatch) {
  throw new Error("FAIL: 团队又回到「先 submit 后登记」的顺序，成员可能永久 running");
}
need(team, "FutureTask<Unit>", "团队 submit 应使用可先建后派发的 FutureTask");

// 5) 门禁：flavor 任务名 / regress / complete 构建 / facts 不含本机 APK
need(ci, "lintStandardDebug", "CI 又调用不存在的 lintDebug");
need(ci, "scripts/regress/run-all.mjs", "CI 不跑前端回归守卫");
need(ci, "assembleCompleteDebug", "CI 又不编译 complete flavor");
if ("apk" in facts) throw new Error("FAIL: facts.json 又记录本机 APK，干净检出无法复现");

// 6) 状态归属
// 切**会话**仍要先收尾（停掉正在跑的轮次，防止 A 的流写进 B）；
// 成员视图是例外：它只是「看队友」，不能把 Lead 停掉（走 suspend + 快照接回，见 team-mission）。
need(js, "if (state.busy) stopLive(true)", "切会话不再收尾正在跑的轮次（A 的流会写进 B）");
need(js, "state.bgRun", "成员视图不再把 Lead 的回合让到后台");
need(js, "wakeMissions", "重启后持久化唤醒的补认领没了（WakeRouter 队列）");
need(js, "ev.sessionId && ev.sessionId !== state.sessionId", "媒体/表情/交付事件又不校验会话归属");

// 7) 长任务后台化
need(video, "run_in_background", "video_generate 又不能后台化");
need(video, "job.registry", "video_generate 未接入后台任务注册表");

// 8) 内核记忆进 prompt
need(memory, "runtime-context/assemble", "memory_save 写入又不进入运行时上下文");
need(memory, "memory:kernel", "内核记忆桥的监听器 id 丢了");

// 9) 局域网 HTTP 模型：系统层放行、应用层拦公网
need(netcfg, 'cleartextTrafficPermitted="true"', "局域网模型 http 又被系统层拦住");
for (const [src, name] of [[llm, "LlmClient"], [probe, "GenProbe"], [rawHttp, "HttpExchange"]]) {
  need(src, "NetPolicy.requireAllowed", `${name} 没有应用层 NetPolicy，公网 http 会带密钥出网`);
}

// 「未知工具：null（对应插件可能被禁用）」这句误导过人：名字是调用方没取到值，
// 不是插件被禁用。三层都要说清是哪一种。
const ptc = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/ptc/PtcRuntime.kt");
const preg = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/PluginRegistry.kt");
need(ptc, "typeof name !== 'string'", "PTC 的 dsh.callTool 不再拦空工具名（String(null) 会变成 \"null\" 送去执行）");
need(ptc, "BAD_TOOL_NAME", "PTC 桥侧不再兜底拒绝空工具名");
need(preg, "工具名不合法", "PluginRegistry 不再把「名字没取到」和「插件被禁用」混成一句");

// ---- 工具名累积：后续 chunk 的 "name": null 不能覆盖已经拿到的名字 ----
// 设备上的 org.json 会把 JSON null 读成字符串 "null"；老逻辑直接赋值，于是
// team_status 变成 "null" 再去执行（用户实测：团队工具报「工具名不合法："null"」）。
const llmSrc = read("app/src/main/java/ai/deepseek/harness/mobile/agent/LlmClient.kt");
const agentBr = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/AgentBridge.kt");
need(llmSrc, "internal fun mergeToolCallName(", "LlmClient 缺工具名累积清洗");
need(llmSrc, 'slot.name = mergeToolCallName(slot.name, f.optString("name"))', "流式累积没有走清洗函数");
need(llmSrc, 'slot.name = toolNameOf(f.optString("name"))', "整包 JSON 兜底路径没有走清洗函数");
need(agentBr, "mergeToolCallName(", "AgentBridge 的流式累积没有走清洗函数");
if (/slot\.name = f\.optString\("name"\)/.test(llmSrc)) {
  throw new Error("FAIL: LlmClient 又把 null 直接当工具名（会被覆盖成字符串 \"null\"）");
}

console.log("✔ harness-hardening: 八个洞 + 局域网 HTTP 策略的关键接线都在");
