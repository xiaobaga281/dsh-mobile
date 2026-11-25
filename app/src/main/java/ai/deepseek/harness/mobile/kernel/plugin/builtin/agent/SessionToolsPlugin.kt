package ai.deepseek.harness.mobile.kernel.plugin.builtin.agent

import ai.deepseek.harness.mobile.agent.SessionStore
import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 会话查询与工作目录 —— 对应桌面两个包：
 *
 *  - `@deepseek-ai/dsh-tool-session-query`：session_event_read / session_event_search /
 *    session_event_trace / session_search / session_trace（5 个只读工具，
 *    桌面按不可变调用会话授权；手机端同样只读、只在本机会话日志内检索）
 *  - `@deepseek-ai/dsh-tool-working-directory`：working_directory（读/改会话工作目录）
 *
 * 数据源是 [SessionStore] 的 jsonl 事件日志（ts + type + 载荷），
 * 以及 `listSessions()` 给出的会话清单。没有游标：`seq` 就是事件在日志里的序号（从 1 开始）。
 */
class SessionToolsPlugin : KernelPlugin {
    override val id = "session-tools"
    override val name = "会话查询"
    override val description = "会话事件读取/搜索/追踪与工作目录切换"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null

    override fun onLoad(ctx: PluginContext) { this.ctx = ctx }
    override fun onUnload() { ctx = null }

    private fun sessions(): SessionStore =
        ctx?.service("session.store") as? SessionStore ?: throw KernelError("会话日志服务未装配")

    private fun currentSession(): String {
        val fromService = ctx?.service("agent.session") as? String
        if (!fromService.isNullOrBlank()) return fromService
        // 没有活跃轮次时退回最近一次会话，便于模型翻自己的历史
        val list = sessions().listSessions()
        return (0 until list.length()).mapNotNull { list.optJSONObject(it)?.optString("id") }.firstOrNull().orEmpty()
    }

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    /**
     * 只匹配「值」，不匹配键名：原来用 ev.toString().contains(q)，
     * 搜 "type" 会把每条事件都命中（键名里就有 type），返回一堆无关结果还显得相关性很高。
     */
    private fun matchText(ev: JSONObject, q: String): Boolean {
        fun hit(v: Any?): Boolean = when (v) {
            is String -> v.contains(q, ignoreCase = true)
            is JSONObject -> v.keys().asSequence().any { hit(v.opt(it)) }
            is org.json.JSONArray -> (0 until v.length()).any { hit(v.opt(it)) }
            else -> false
        }
        return hit(ev)
    }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "session_event_read"
            override val description = "按序号读取当前（或指定）会话的事件：seq 附近 before/after 条。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = schema(
                JSONObject()
                    .put("session_id", JSONObject().put("type", "string").put("description", "省略表示当前会话"))
                    .put("seq", JSONObject().put("type", "number").put("description", "事件序号（从 1 开始）"))
                    .put("before", JSONObject().put("type", "number").put("description", "向前取多少条，默认 3"))
                    .put("after", JSONObject().put("type", "number").put("description", "向后取多少条，默认 3")),
                listOf("seq"),
            )
            override fun execute(args: JSONObject): String {
                val sid = args.optString("session_id").ifBlank { currentSession() }
                val all = sessions().read(sid)
                if (all.isEmpty()) throw KernelError("会话没有事件：$sid")
                val seq = args.optInt("seq", 1)
                val before = args.optInt("before", 3).coerceIn(0, 50)
                val after = args.optInt("after", 3).coerceIn(0, 50)
                val from = (seq - 1 - before).coerceAtLeast(0)
                val to = (seq - 1 + after + 1).coerceAtMost(all.size)
                return JSONObject().apply {
                    put("session_id", sid)
                    put("total", all.size)
                    put("events", JSONArray().apply {
                        for (i in from until to) put(JSONObject().put("seq", i + 1).put("event", all[i]))
                    })
                }.toString()
            }
        },
        object : ToolSpec {
            override val name = "session_event_search"
            override val description = "在指定会话的事件里做全文搜索，可限定序号/时间区间与事件类型。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = schema(
                JSONObject()
                    .put("session_id", JSONObject().put("type", "string").put("description", "省略表示当前会话"))
                    .put("query", JSONObject().put("type", "string").put("description", "字面全文检索"))
                    .put("seq_from", JSONObject().put("type", "number"))
                    .put("seq_to", JSONObject().put("type", "number"))
                    .put("time_from", JSONObject().put("type", "number").put("description", "起始毫秒时间戳"))
                    .put("time_to", JSONObject().put("type", "number").put("description", "结束毫秒时间戳"))
                    .put("event_types", JSONObject().apply {
                        put("type", "array"); put("items", JSONObject().put("type", "string"))
                        put("description", "只保留这些事件类型，如 tool/result")
                    })
                    .put("surfaces", JSONObject().apply {
                        put("type", "array"); put("items", JSONObject().put("type", "string"))
                        put("description", "产生事件的平面（手机端恒为 kernel）")
                    }),
                listOf("query"),
            )
            override fun execute(args: JSONObject): String {
                val sid = args.optString("session_id").ifBlank { currentSession() }
                val q = args.optString("query").trim()
                // 空 query 的 contains("") 恒真，会把前 50 条事件全当命中返回
                if (q.isBlank()) throw KernelError("query 不能为空：要全览请用 session_event_read")
                val types = args.optJSONArray("event_types")?.let { a ->
                    (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotBlank() } }.toSet()
                }.orEmpty()
                val hits = JSONArray()
                var totalHits = 0
                sessions().read(sid).forEachIndexed { idx, ev ->
                    val seq = idx + 1
                    if (args.has("seq_from") && seq < args.optInt("seq_from")) return@forEachIndexed
                    if (args.has("seq_to") && seq > args.optInt("seq_to")) return@forEachIndexed
                    if (args.has("time_from") && ev.optLong("ts") < args.optLong("time_from")) return@forEachIndexed
                    if (args.has("time_to") && ev.optLong("ts") > args.optLong("time_to")) return@forEachIndexed
                    if (types.isNotEmpty() && ev.optString("type") !in types) return@forEachIndexed
                    if (!matchText(ev, q)) return@forEachIndexed
                    totalHits++
                    if (hits.length() < 50) hits.put(JSONObject().put("seq", seq).put("event", ev))
                }
                return JSONObject().put("session_id", sid)
                    .put("count", hits.length())
                    .put("total_hits", totalHits)
                    .put("truncated", totalHits > hits.length())
                    .put("hits", hits).toString()
            }
        },
        object : ToolSpec {
            override val name = "session_event_trace"
            override val description = "围绕一个事件序号给出因果线索：所属轮次、同轮工具调用与相邻事件。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = schema(
                JSONObject()
                    .put("session_id", JSONObject().put("type", "string"))
                    .put("seq", JSONObject().put("type", "number")),
                listOf("seq"),
            )
            override fun execute(args: JSONObject): String {
                val sid = args.optString("session_id").ifBlank { currentSession() }
                val all = sessions().read(sid)
                val seq = args.optInt("seq", 1)
                if (seq !in 1..all.size) throw KernelError("序号越界：$seq（共 ${all.size} 条）")
                val target = all[seq - 1]
                // 同一轮次内的工具调用与助手消息
                var turnStart = seq - 1
                while (turnStart >= 0 && all[turnStart].optString("type") != "turn/start") turnStart--
                val related = JSONArray()
                var i = turnStart.coerceAtLeast(0)
                while (i < all.size) {
                    val t = all[i].optString("type")
                    if (i > turnStart && t == "turn/start") break
                    if (t == "tool/call" || t == "tool/result" || t == "assistant/message") {
                        related.put(JSONObject().put("seq", i + 1).put("type", t)
                            .put("name", all[i].optString("name"))
                            .put("text", all[i].optString("text").take(160)))
                    }
                    i++
                }
                return JSONObject().apply {
                    put("session_id", sid)
                    put("seq", seq)
                    put("event", target)
                    put("turn_start_seq", turnStart + 1)
                    put("related", related)
                }.toString()
            }
        },
        object : ToolSpec {
            override val name = "session_search"
            override val description = "跨会话检索历史全文（可限定会话 id、时间范围、事件类型）。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = schema(
                JSONObject()
                    .put("query", JSONObject().put("type", "string").put("description", "字面全文检索"))
                    .put("session_ids", JSONObject().apply {
                        put("type", "array"); put("items", JSONObject().put("type", "string"))
                        put("description", "只在这些会话里检索")
                    })
                    .put("event_time_from", JSONObject().put("type", "number").put("description", "事件毫秒时间戳下界"))
                    .put("event_time_to", JSONObject().put("type", "number").put("description", "事件毫秒时间戳上界"))
                    .put("event_types", JSONObject().apply {
                        put("type", "array"); put("items", JSONObject().put("type", "string"))
                    })
                    .put("limit", JSONObject().put("type", "number")
                        .put("description", "最多返回多少条命中，默认 50，上限 200")),
                listOf("query"),
            )
            override fun execute(args: JSONObject): String {
                val q = args.optString("query")
                val ids = args.optJSONArray("session_ids")?.let { a ->
                    (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotBlank() } }
                }.orEmpty()
                val types = args.optJSONArray("event_types")?.let { a ->
                    (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotBlank() } }.toSet()
                }.orEmpty()
                // 原实现每次迭代调两次 listSessions()（各读一遍磁盘目录），O(n²)；
                // 50 条硬上限且静默截断 —— 模型以为搜全了。改为一次取会话清单 + limit/total。
                val allSessions = sessions().listSessions()
                val candidates = if (ids.isNotEmpty()) ids else
                    (0 until allSessions.length()).mapNotNull { allSessions.optJSONObject(it)?.optString("id") }
                val limit = args.optInt("limit", 50).coerceIn(1, 200)
                val hits = JSONArray()
                var total = 0
                candidates.forEach { sid ->
                    sessions().read(sid).forEachIndexed { idx, ev ->
                        if (args.has("event_time_from") && ev.optLong("ts") < args.optLong("event_time_from")) return@forEachIndexed
                        if (args.has("event_time_to") && ev.optLong("ts") > args.optLong("event_time_to")) return@forEachIndexed
                        if (types.isNotEmpty() && ev.optString("type") !in types) return@forEachIndexed
                        if (!matchText(ev, q)) return@forEachIndexed
                        total++
                        if (hits.length() < limit) {
                            hits.put(JSONObject().put("session_id", sid).put("seq", idx + 1).put("event", ev))
                        }
                    }
                }
                return JSONObject().put("count", hits.length()).put("total_hits", total)
                    .apply { if (total > hits.length()) put("truncated", true).put("hint", "命中 $total 条，只返回前 ${hits.length()} 条；请收窄 query 或时间范围") }
                    .put("hits", hits).toString()
            }
        },
        object : ToolSpec {
            override val name = "session_trace"
            override val description = "给一个会话的轮次与工具体量做概览（轮数、步数、工具调用数、token）。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = schema(
                JSONObject().put("session_id", JSONObject().put("type", "string").put("description", "省略表示当前会话")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String {
                val sid = args.optString("session_id").ifBlank { currentSession() }
                val evs = sessions().read(sid)
                if (evs.isEmpty()) throw KernelError("会话没有事件：$sid")
                val tools = JSONArray()
                val counts = HashMap<String, Int>()
                evs.forEach { ev ->
                    if (ev.optString("type") == "tool/call") {
                        val name = ev.optString("name")
                        counts[name] = (counts[name] ?: 0) + 1
                    }
                }
                counts.entries.sortedByDescending { it.value }.take(12).forEach { (k, v) ->
                    tools.put(JSONObject().put("tool", k).put("count", v))
                }
                return JSONObject().apply {
                    put("session_id", sid)
                    put("events", evs.size)
                    put("summary", sessions().summary(sid))
                    put("top_tools", tools)
                    put("first_ts", evs.first().optLong("ts"))
                    put("last_ts", evs.last().optLong("ts"))
                }.toString()
            }
        },
        object : ToolSpec {
            override val name = "working_directory"
            override val description = "读取或切换当前会话的工作目录（相对工作区根）。已启动的 shell 保留自己的目录。"
            override val parameters = schema(
                JSONObject().put("cd", JSONObject().put("type", "string").put("description", "要进入的已有目录；省略则读取当前目录")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String {
                val ws = ctx?.workspace ?: throw KernelError("工作区未就绪")
                val cd = args.optString("cd")
                if (cd.isBlank()) {
                    return JSONObject().put("cwd", ws.cwd).put("root", ws.rootPath)
                        .put("base", ws.baseDir().absolutePath).toString()
                }
                val dir = ctx!!.sandbox.checkWrite(cd)
                if (!dir.exists()) throw KernelError("目录不存在：$cd")
                if (!dir.isDirectory) throw KernelError("不是目录：$cd")
                val rel = ws.relative(dir)
                ws.cwd = if (rel.isBlank()) "." else rel
                return JSONObject().put("cwd", ws.cwd).put("note", "已切换；已启动的 shell 会话保留各自目录").toString()
            }
        },
    )
}
