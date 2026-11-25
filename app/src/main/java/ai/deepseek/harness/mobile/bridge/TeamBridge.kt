package ai.deepseek.harness.mobile.bridge

import ai.deepseek.harness.mobile.kernel.team.TeamError
import ai.deepseek.harness.mobile.kernel.team.TeamRuntime
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次最多回给前端多少条成员消息。
 *
 * 桌面的成员会话是完整 session（滚动到底就加载更早的）；手机端一次性渲染几千条会把
 * WebView 卡死，所以只取尾部这么多条 —— 但会通过 `total` / `hasMore` 如实告知被截断，
 * 不再像以前那样静默地只给 120 条（用户会以为成员「只做了最后几步」）。
 */
private const val MEMBER_LOG_LIMIT = 600

/**
 * 团队面板桥 —— 把 [TeamRuntime] 的只读视图与用户操作暴露给前端。
 *
 * 团队是**后台**在跑的东西：用户不点开面板也应该知道「谁在干活、干到哪」。
 * 判定仍全部落在运行时/任务板，这里只做入口：
 *   snapshot        取当前会话的团队全景（成员 + 任务 + 预算 + revision）
 *   memberLog       看某个成员自己的对话（它读了什么、结论是什么）
 *   interrupt       用户从面板上叫停某个人（等价 interrupt_agent 的用户入口）
 *   send            用户直接给某个成员补一句话（等价 send_message 的用户入口）
 *   open            打开某个成员的会话（返回它的会话身份与状态；桌面「点成员进它的会话」）
 *   userMessage     在成员会话里替用户发一句话 —— 与桌面 addressed-subagent 同一条路径：
 *                   消息进成员收件箱，inactive 会冷恢复一轮
 *
 * 会话隔离：每个会话一支团队（rc.97 起与桌面 TeamId=SessionId 同构），
 * 面板永远只显示当前会话自己的团队。
 */
class TeamBridge(private val core: BridgeCore) {

    private fun runtime(): TeamRuntime? =
        core.activity.kernel.service("team.runtime") as? TeamRuntime

    private fun err(code: String, message: String): String =
        JSONObject().put("ok", false).put("code", code).put("error", message).toString()

    @JavascriptInterface
    fun teamSnapshot(sid: String): String {
        val rt = runtime() ?: return err("TEAM_UNAVAILABLE", "团队插件未启用")
        return try {
            JSONObject().put("ok", true).put("team", rt.snapshotFor(sid.ifBlank { "draft" })).toString()
        } catch (e: Throwable) {
            err("TEAM_SNAPSHOT_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }

    /* ---------------- 限额（设置页） ---------------- */

    @JavascriptInterface
    fun teamLimits(sid: String): String {
        val rt = runtime() ?: return err("TEAM_UNAVAILABLE", "团队插件未启用")
        return try {
            // 限额是插件级配置，不跟会话走：这里不能 attach，
            // 否则「另一个会话的团队在跑」时连设置页都打不开
            val l = rt.limits()
            val sub = core.activity.kernel.subagentLimits
            JSONObject().apply {
                put("ok", true)
                put("limits", JSONObject().apply {
                    put("maxConcurrent", l.maxConcurrent)
                    put("maxMembers", rt.maxMembers())
                    put("maxTasks", rt.maxTasks())
                    // 子智能体的递归深度（并行上限与 maxConcurrent 是同一个数）
                    put("maxDepth", sub.maxDepth)
                    // 这两个以前写死在代码里（桌面是 Config 的四个数）：回显出来，
                    // 设置页与排障才知道当前生效的是哪一份
                    put("maxMessageBytes", l.maxMessageBytes)
                    put("disposalTimeoutMs", l.disposalTimeoutMs)
                })
            }.toString()
        } catch (e: Throwable) {
            err("TEAM_LIMITS_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * 改限额：立刻热更新运行时，并写回 `files/kernel/config.json` 的 `config.agent-team`。
     *
     * 为什么两处都写：热更新让当前会话马上生效；落盘让下次启动/插件重载保持。
     * 写盘失败只影响持久化，不影响本次生效 —— 设置页会拿到 ok=true 和一条 warn。
     */
    @JavascriptInterface
    fun teamSetLimits(sid: String, json: String): String {
        val rt = runtime() ?: return err("TEAM_UNAVAILABLE", "团队插件未启用")
        return try {
            val o = JSONObject(json)
            val cur = rt.limits()
            val next = ai.deepseek.harness.mobile.kernel.team.TeamRuntime.Config(
                maxConcurrent = o.optInt("maxConcurrent", cur.maxConcurrent).coerceIn(1, 8),
                // 设置页只改并行上限：另外两个数必须从当前值带过去，
                // 否则一次「改并发」就把消息上限与收尾超时静默重置回默认
                maxMessageBytes = cur.maxMessageBytes,
                disposalTimeoutMs = cur.disposalTimeoutMs,
            )
            rt.updateLimits(next)
            // 子智能体：递归深度单独一个值；并行上限与团队池是同一个数（桌面只有一个并行上限）
            val maxDepth = o.optInt("maxDepth", core.activity.kernel.subagentLimits.maxDepth)
            core.activity.kernel.setSubagentLimits(
                ai.deepseek.harness.mobile.kernel.agents.SubagentLimits(
                    maxDepth = maxDepth,
                    maxParallel = next.maxConcurrent,
                ),
            )
            val maxMembers = o.optInt("maxMembers", rt.maxMembers())
            val maxTasks = o.optInt("maxTasks", rt.maxTasks())
            rt.updateCapacity(maxMembers, maxTasks)

            val saved = runCatching {
                core.activity.kernel.savePluginConfig("agent-team", JSONObject().apply {
                    put("maxConcurrent", next.maxConcurrent)
                    put("maxMembers", maxMembers)
                    put("maxTasks", maxTasks)
                    put("maxDepth", core.activity.kernel.subagentLimits.maxDepth)
                })
            }.isSuccess

            JSONObject().apply {
                put("ok", true)
                put("limits", teamLimits(sid).let { runCatching { JSONObject(it).optJSONObject("limits") }.getOrNull() ?: JSONObject() })
                if (!saved) put("warn", "已生效，但写入配置文件失败；重启后会回到上次保存的值")
            }.toString()
        } catch (e: Throwable) {
            err("TEAM_LIMITS_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * 某个成员自己的对话（完整历史，见 [MEMBER_LOG_LIMIT]）。
     * 用户想知道「reviewer 到底看了什么」—— 桌面是完整 session 历史，
     * 这里不再只给最近 120 条：那会把成员的早期工作整个藏起来，
     * 用户看到的是「它只做了最后几步」。
     */
    @JavascriptInterface
    fun teamMemberLog(sid: String, name: String): String {
        val rt = runtime() ?: return err("TEAM_UNAVAILABLE", "团队插件未启用")
        return try {
            rt.attach(sid.ifBlank { "draft" })
            val m = rt.currentRoster().get(name) ?: return err("TEAM_MEMBER_NOT_FOUND", "没有成员：$name")
            val sessions = core.activity.kernel.sessions
            // 三类都收（桌面成员会话里工具过程是可见的，只是折叠成行）：
            // 只看对话不看工具，用户就答不上「reviewer 到底看了什么」。
            val all = sessions.read(m.sessionId).mapNotNull { ev ->
                when (ev.optString("type")) {
                    "user/message", "assistant/message" -> JSONObject().apply {
                        put("kind", if (ev.optString("type") == "user/message") "user" else "assistant")
                        put("text", ev.optString("text").take(4000))
                        put("ts", ev.optLong("ts"))
                    }
                    "tool/result" -> {
                        val n = ev.optString("name")
                        if (n.isBlank()) null else JSONObject().apply {
                            put("kind", "tool")
                            // 字段名对齐 journal.toolExec：它存的是 output / args / id。
                            // 原来这里读 ev.optString("text") —— 日志里没有这个字段，
                            // 于是成员视图的每条工具行都是空行（「它到底看了什么」看不出来）。
                            put("id", ev.optString("id"))
                            put("name", n)
                            put("ok", ev.optBoolean("ok", true))
                            put("args", ev.optString("args"))
                            put("out", ev.optString("output"))
                            put("ts", ev.optLong("ts"))
                        }
                    }
                    else -> null
                }
            }
            // 超长会话只取尾部（手机一次渲染几千条会卡），但要如实告诉前端被截了多少
            val shown = if (all.size > MEMBER_LOG_LIMIT) all.takeLast(MEMBER_LOG_LIMIT) else all
            JSONObject().put("ok", true).put("name", name)
                .put("status", m.status.wire)
                .put("phase", m.phase.wire)
                .put("session", m.sessionId)
                .put("total", all.size)
                .put("hasMore", all.size > shown.size)
                .put("messages", JSONArray().apply { shown.forEach { put(it) } }).toString()
        } catch (e: Throwable) {
            err("TEAM_LOG_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * 打开成员的会话（桌面 client-ui-agent-team「点 teammate 打开它的会话」）。
     * 返回成员会话身份与当前状态；前端据此把聊天视图切到成员会话。
     * 打开时校验成员存在且不是 failed —— 桌面 addressed-subagent 路径同样先验 parent/child。
     */
    @JavascriptInterface
    fun teamOpen(sid: String, name: String): String {
        val rt = runtime() ?: return err("TEAM_UNAVAILABLE", "团队插件未启用")
        return try {
            rt.attach(sid.ifBlank { "draft" })
            val m = rt.currentRoster().get(name) ?: return err("TEAM_MEMBER_NOT_FOUND", "没有成员：$name")
            if (m.phase == ai.deepseek.harness.mobile.kernel.team.MemberPhase.FAILED) {
                return err("TEAM_MEMBER_FAILED", "${m.name} 创建失败（${m.lastError}），没有可进入的会话")
            }
            JSONObject().put("ok", true)
                .put("name", m.name)
                .put("session", m.sessionId)
                .put("status", m.status.wire)
                .put("description", m.description)
                .toString()
        } catch (e: Throwable) {
            err("TEAM_OPEN_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }

    /** 旧签名（页面缓存的上一版 JS 只会传三个参数）：等价于不带配置，冷恢复只能靠内存里那份 Lead 配置。 */
    @JavascriptInterface
    fun teamUserMessage(sid: String, name: String, message: String): String =
        teamUserMessage(sid, name, message, "")

    /**
     * 用户在成员会话里发的消息。
     *
     * `cfgJson` 是页面这一次发送用的同一份配置（端点、密钥、预设、权限、窗口）。
     * 带上它是因为冷恢复：队友已经 inactive，要重新起一轮就得有端点信息。
     * 以前这里硬传 null，只靠运行时内存里「最后一次 Lead 配置」——
     * 那份配置不落盘也不回放，于是**进程重启后在成员会话里发消息必然
     * TEAM_NO_LEAD_CONTEXT**：用户看着一个配好模型的 App，却唤不醒队友。
     * 密钥不落进会话日志，只在这一次调用里过境。
     */
    @JavascriptInterface
    fun teamUserMessage(sid: String, name: String, message: String, cfgJson: String): String {
        val rt = runtime() ?: return err("TEAM_UNAVAILABLE", "团队插件未启用")
        return try {
            rt.attach(sid.ifBlank { "draft" })
            val leadCfg = if (cfgJson.isBlank()) null else runCatching {
                ai.deepseek.harness.mobile.agent.AgentConfig.parse(JSONObject(cfgJson))
            }.getOrNull()
            val r = rt.send(name, message, leadCfg)
            JSONObject().put("ok", true).put("result", r).put("team", rt.snapshot()).toString()
        } catch (e: Throwable) {
            err("TEAM_SEND_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }

    @JavascriptInterface
    fun teamInterrupt(sid: String, name: String): String {
        val rt = runtime() ?: return err("TEAM_UNAVAILABLE", "团队插件未启用")
        return try {
            rt.attach(sid.ifBlank { "draft" })
            val r = rt.interrupt(name)
            JSONObject().put("ok", true).put("result", r).put("team", rt.snapshot()).toString()
        } catch (e: TeamError) {
            // 服务层的判据（TEAM_LEAD_REQUIRED / TEAM_INVALID_TARGET / TEAM_MEMBER_NOT_FOUND）
            // 原样透传：包成 TEAM_INTERRUPT_FAILED 后，界面只剩一句「中断失败」，
            // 用户和模型都看不出是不该由这里发起、还是根本没这个人
            err(e.code, e.message ?: e.code)
        } catch (e: Throwable) {
            err("TEAM_INTERRUPT_FAILED", e.message ?: e.javaClass.simpleName)
        }
    }
}
