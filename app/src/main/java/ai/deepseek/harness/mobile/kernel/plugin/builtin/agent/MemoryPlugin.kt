package ai.deepseek.harness.mobile.kernel.plugin.builtin.agent

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.agent.AgentConfig
import ai.deepseek.harness.mobile.agent.PromptAssembler
import ai.deepseek.harness.mobile.agent.PromptOrder
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * 全局 / 会话记忆：写、查、改、删。
 *
 * 为什么需要工具而不仅是自动沉淀：自动摘要只能记住"发生了什么"，
 * 而用户真正希望被记住的是"以后请这样"——偏好、约束、决定、账号口径这类。
 * 模型能主动写入并检索，才谈得上长期可用。
 *
 * 存储：`files/kernel/memory.json`（应用私有目录，随卸载删除）。
 *   { "items": [ { id, scope: global|session, kind, topic, text, createdAt, updatedAt, hits } ] }
 * 检索：CJK 按二元字组 + 英文按词切分做重叠打分，命中次数做轻微加权，结果稳定可解释。
 */
class MemoryPlugin : KernelPlugin {
    override val id = "memory"
    override val name = "记忆"
    override val description = "跨会话的全局记忆与会话内记忆：写入、检索、修改、删除"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var store: File? = null
    private var writes = 0

    companion object {
        private const val MAX_ITEMS = 400
        private const val MAX_TEXT = 1200
    }

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        // 与内核配置同目录：files/kernel/memory.json
        val dir = (ctx.service("plugin.dir") as? File)?.parentFile ?: ctx.workspace.root
        store = File(dir, "memory.json")
        // memory_save 写的是内核文件，而 PromptAssembler 的 memory:entries 来自前端
        // LocalDB。以前两者不通：模型刚记下一条，下一轮 prompt 里根本看不到。
        // 这里把内核库接进运行时上下文，并按文本去重，避免与前端记忆重复。
        ctx.hooks.onWaterfall<PromptAssembler.Section>(
            "runtime-context/assemble", "memory:kernel",
            PromptOrder.priorityOf(PromptOrder.CTX_MEMORY + 1),
        ) { s, hc ->
            val cfg = hc.any("cfg") as? AgentConfig
            val sid = cfg?.sessionId?.takeIf { it.isNotBlank() } ?: sessionId()
            val known = buildSet {
                cfg?.globalMemories?.let { addAll(it) }
                cfg?.sessionMemories?.let { addAll(it) }
            }
            val globals = mutableListOf<String>()
            val session = mutableListOf<String>()
            val items = read()
            for (i in 0 until items.length()) {
                val it0 = items.optJSONObject(i) ?: continue
                val text = it0.optString("text").trim()
                if (text.isBlank() || text in known) continue
                if (it0.optString("scope") == "global") globals.add(text)
                else if (it0.optString("sessionId", "local") == sid) session.add(text)
            }
            if (globals.isEmpty() && session.isEmpty()) return@onWaterfall s
            var out = s
            if (globals.isNotEmpty()) {
                out = out.plus("内核长期记忆（memory_save 写入）：\n" +
                    globals.take(30).joinToString("\n") { "- $it" })
            }
            if (session.isNotEmpty() && !hc.bool("subagent")) {
                out = out.plus("本会话内核记忆：\n" + session.take(20).joinToString("\n") { "- $it" })
            }
            out
        }
    }

    override fun onUnload() { ctx = null; store = null }

    override fun status(): Map<String, String> = mapOf(
        "条目" to read().length().toString(),
        "写入次数" to writes.toString(),
    )

    private val ioLock = Any()

    /**
     * 读库。损坏时先试 .bak，再把坏文件另存 .corrupt —— 绝不把「解析失败」当成「没有记忆」，
     * 否则下一次写入会把整库覆盖成一条新记录。
     */
    private fun read(): JSONArray {
        val f = store ?: return JSONArray()
        if (!f.isFile) return JSONArray()
        jsonItems(f)?.let { return it }
        val bak = File(f.parentFile, f.name + ".bak")
        jsonItems(bak)?.let {
            android.util.Log.w("DSHMemory", "memory.json 解析失败，已从 .bak 恢复 ${it.length()} 条")
            runCatching { f.copyTo(File(f.parentFile, f.name + ".corrupt"), overwrite = true) }
            write(it)
            return it
        }
        android.util.Log.w("DSHMemory", "memory.json 无法解析且无可用备份，本次按空库处理（原文件已另存 .corrupt）")
        runCatching { f.copyTo(File(f.parentFile, f.name + ".corrupt"), overwrite = true) }
        return JSONArray()
    }

    private fun jsonItems(f: File): JSONArray? =
        if (!f.isFile) null
        else runCatching { JSONObject(f.readText()).optJSONArray("items") }.getOrNull()

    /** 原子写：先写 .tmp 再 rename，旧版本留 .bak。中途被杀不会留下半截 JSON */
    private fun write(items: JSONArray) {
        val f = store ?: return
        synchronized(ioLock) {
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, f.name + ".tmp")
            val body = JSONObject().put("items", items).toString(2)
            tmp.writeText(body, Charsets.UTF_8)
            if (f.isFile && f.length() > 0) {
                runCatching { f.copyTo(File(f.parentFile, f.name + ".bak"), overwrite = true) }
            }
            if (!tmp.renameTo(f)) {
                f.delete()
                if (!tmp.renameTo(f)) {
                    // rename 在少数文件系统上会失败：退回直写（此时 .bak 已在）
                    runCatching { f.writeText(body, Charsets.UTF_8) }
                    runCatching { tmp.delete() }
                }
            }
        }
    }

    private fun sessionId(): String =
        (ctx?.service("agent.session") as? String)?.takeIf { it.isNotBlank() } ?: "local"

    /* ---------------- 检索打分 ---------------- */

    private fun tokens(text: String): Set<String> {
        val out = HashSet<String>()
        val lower = text.lowercase()
        // 英文/数字：按词
        Regex("[a-z0-9_]{2,}").findAll(lower).forEach { out.add(it.value) }
        // 中文：二元字组（"语音消息" → 语音/音消/消息）
        val cjk = Regex("[\\u4e00-\\u9fa5]{2,}").findAll(lower).map { it.value }
        cjk.forEach { run ->
            for (i in 0 until run.length - 1) out.add(run.substring(i, i + 2))
        }
        return out
    }

    private fun score(item: JSONObject, q: Set<String>): Double {
        if (q.isEmpty()) return 0.0
        val text = item.optString("topic") + " " + item.optString("text")
        val t = tokens(text)
        var inter = 0
        for (k in q) if (k in t) inter++
        if (inter == 0) return 0.0
        val base = inter.toDouble() / Math.sqrt(q.size.toDouble() * maxOf(1, t.size).toDouble())
        return base + minOf(0.2, item.optInt("hits") * 0.01)
    }

    private fun scopeMatches(item: JSONObject, scope: String): Boolean = when (scope) {
        "global" -> item.optString("scope") == "global"
        "session" -> item.optString("scope") == "session" &&
            item.optString("sessionId", "local") == sessionId()
        else -> true
    }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "memory_save"
            override val description =
                "写入一条长期记忆。global 跨会话生效（用户偏好、身份、长期约束、固定口径）；" +
                    "session 只在当前会话生效（这轮任务的背景约定）。" +
                    "适合记：用户说“以后都这样”“记住…”“我不喜欢…”、重要决定与理由、账号/环境等固定事实。" +
                    "不要记：一次性的中间结果、可由文件重新读到的内容。"
            override val parameters = JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("text", JSONObject().put("type", "string").put("description", "要记住的内容，一句话写清"))
                    put("scope", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("global", "session")))
                        .put("description", "global 跨会话，session 仅当前会话，默认 global"))
                    put("kind", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("pref", "fact", "decision", "constraint", "task")))
                        .put("description", "类型：偏好/事实/决定/约束/任务"))
                    put("topic", JSONObject().put("type", "string").put("description", "主题标签，便于检索"))
                })
                put("required", JSONArray(listOf("text")))
                put("additionalProperties", false)
            }
            override fun execute(args: JSONObject): String {
                val text = args.optString("text").trim()
                if (text.isBlank()) throw KernelError("text 不能为空")
                if (text.length > MAX_TEXT) throw KernelError("太长（上限 $MAX_TEXT 字），请精简成一句")
                val scope = args.optString("scope", "global").lowercase().let {
                    if (it == "session") "session" else "global"
                }
                val items = read()
                // 去重：同 scope（会话记忆还要同一个 sessionId）下文本完全相同就更新而不是新增
                for (i in 0 until items.length()) {
                    val it0 = items.optJSONObject(i) ?: continue
                    if (it0.optString("scope") == scope &&
                        (scope != "session" || it0.optString("sessionId", "local") == sessionId()) &&
                        it0.optString("text").trim() == text
                    ) {
                        it0.put("updatedAt", System.currentTimeMillis())
                        it0.put("topic", args.optString("topic", it0.optString("topic")))
                        write(items)
                        return JSONObject().put("ok", true).put("id", it0.optString("id"))
                            .put("updated", true).toString()
                    }
                }
                val item = JSONObject().apply {
                    put("id", "m-" + UUID.randomUUID().toString().take(8))
                    put("scope", scope)
                    put("kind", args.optString("kind", "fact"))
                    put("topic", args.optString("topic", ""))
                    put("text", text)
                    put("createdAt", System.currentTimeMillis())
                    put("updatedAt", System.currentTimeMillis())
                    put("hits", 0)
                    if (scope == "session") put("sessionId", sessionId())
                }
                items.put(item)
                // 超量时丢最老的 global（session 记忆先清掉别的会话残留）
                var dropped = 0
                if (items.length() > MAX_ITEMS) {
                    dropped = items.length() - MAX_ITEMS
                    val keep = JSONArray()
                    for (i in maxOf(0, items.length() - MAX_ITEMS) until items.length()) {
                        keep.put(items.optJSONObject(i))
                    }
                    write(keep)
                } else {
                    write(items)
                }
                writes++
                return JSONObject().put("ok", true).put("id", item.optString("id"))
                    .put("scope", scope).apply {
                        // 静默丢数据比报错更坏：模型以为记住了，其实最老的几条已被挤掉
                        if (dropped > 0) put("dropped", dropped)
                            .put("warning", "记忆已满（$MAX_ITEMS 条），按写入顺序丢弃了最旧的 $dropped 条")
                    }.toString()
            }
        },

        object : ToolSpec {
            override val name = "memory_update"
            override val description =
                "按 id 修改一条已有记忆（改正措辞、更新内容）。比 forget+save 好：保留创建时间与命中统计，id 不变。" +
                    "用户说“把那条偏好改成…”“更正一下之前记的…”时用它。"
            override val parameters = JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("id", JSONObject().put("type", "string").put("description", "要修改的条目 id"))
                    put("text", JSONObject().put("type", "string").put("description", "新的内容（不传则不改）"))
                    put("kind", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("pref", "fact", "decision", "constraint", "task"))))
                    put("topic", JSONObject().put("type", "string").put("description", "新的主题标签"))
                })
                put("required", JSONArray(listOf("id")))
                put("additionalProperties", false)
            }
            override fun execute(args: JSONObject): String {
                val id = args.optString("id").trim()
                if (id.isBlank()) throw KernelError("id 不能为空")
                val items = read()
                for (i in 0 until items.length()) {
                    val it0 = items.optJSONObject(i) ?: continue
                    if (it0.optString("id") == id) {
                        val text = args.optString("text", "").trim()
                        if (text.isNotEmpty()) {
                            if (text.length > MAX_TEXT) throw KernelError("text 太长（上限 $MAX_TEXT 字）")
                            it0.put("text", text)
                        }
                        if (args.has("kind") && !args.isNull("kind")) it0.put("kind", args.optString("kind"))
                        if (args.has("topic") && !args.isNull("topic")) it0.put("topic", args.optString("topic"))
                        it0.put("updatedAt", System.currentTimeMillis())
                        write(items)
                        writes++
                        return JSONObject().put("ok", true).put("id", id).put("updated", true).toString()
                    }
                }
                throw KernelError("找不到这条记忆：$id（用 memory_list 确认 id）")
            }
        },

        object : ToolSpec {
            override val name = "memory_clear"
            override val description =
                "清空记忆（按 scope）。危险操作：必须显式传 confirm=true，且模型应先向用户确认过再调用。"
            override val parameters = JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("scope", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("all", "global", "session")))
                        .put("description", "清空范围，默认 all"))
                    put("confirm", JSONObject().put("type", "boolean")
                        .put("description", "必须为 true 才执行"))
                })
                put("required", JSONArray(listOf("confirm")))
                put("additionalProperties", false)
            }
            override fun execute(args: JSONObject): String {
                if (!args.optBoolean("confirm")) {
                    throw KernelError("清空记忆需要 confirm=true（先向用户确认再调用）")
                }
                val scope = args.optString("scope", "all")
                val items = read()
                val keep = JSONArray()
                var n = 0
                for (i in 0 until items.length()) {
                    val it0 = items.optJSONObject(i) ?: continue
                    if (scope == "all" || scopeMatches(it0, scope)) n++ else keep.put(it0)
                }
                write(keep)
                return JSONObject().put("ok", true).put("removed", n).put("scope", scope).toString()
            }
        },

        object : ToolSpec {
            override val name = "memory_search"
            override val description = "按关键词检索记忆（全局 + 当前会话）。做任何“用户以前提过什么要求”的判断前先查一次。"
            // 只读：允许进并发池（批量读取轮次与其他只读工具并行）
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("query", JSONObject().put("type", "string").put("description", "关键词或一句话"))
                    put("scope", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("all", "global", "session"))))
                    put("kind", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("pref", "fact", "decision", "constraint", "task")))
                        .put("description", "只返回该类型的记忆"))
                    put("topic", JSONObject().put("type", "string").put("description", "只返回该主题标签的记忆"))
                    put("limit", JSONObject().put("type", "number").put("description", "最多返回条数，默认 6"))
                })
                put("required", JSONArray(listOf("query")))
                put("additionalProperties", false)
            }
            override fun execute(args: JSONObject): String {
                val q = tokens(args.optString("query"))
                val scope = args.optString("scope", "all")
                val kindF = args.optString("kind", "")
                val topicF = args.optString("topic", "").trim()
                val limit = args.optInt("limit", 6).coerceIn(1, 30)
                val items = read()
                data class Hit(val score: Double, val obj: JSONObject)
                val hits = ArrayList<Hit>()
                for (i in 0 until items.length()) {
                    val it0 = items.optJSONObject(i) ?: continue
                    if (!scopeMatches(it0, scope)) continue
                    if (kindF.isNotBlank() && it0.optString("kind") != kindF) continue
                    if (topicF.isNotBlank() && !it0.optString("topic").contains(topicF, ignoreCase = true)) continue
                    val s = score(it0, q)
                    if (s > 0) hits.add(Hit(s, it0))
                }
                // 命中计数只用于排序加权，不再落盘：memory_search 在目录里是只读工具，
                // 会进并发池并行执行；一旦它回写整个库，就和并发的 memory_save 互相覆盖。
                val out = JSONArray()
                hits.sortedByDescending { it.score }.take(limit).forEach { h ->
                    out.put(JSONObject().apply {
                        put("id", h.obj.optString("id"))
                        put("scope", h.obj.optString("scope"))
                        put("kind", h.obj.optString("kind"))
                        put("topic", h.obj.optString("topic"))
                        put("text", h.obj.optString("text"))
                        put("score", Math.round(h.score * 100) / 100.0)
                    })
                }
                return JSONObject().put("ok", true).put("count", out.length())
                    .put("items", out).toString()
            }
        },

        object : ToolSpec {
            override val name = "memory_list"
            override val description = "列出记忆条目（按更新时间倒序），用于核对“现在到底记住了什么”。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("scope", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("all", "global", "session"))))
                    put("kind", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("pref", "fact", "decision", "constraint", "task")))
                        .put("description", "只列该类型"))
                    put("limit", JSONObject().put("type", "number").put("description", "默认 20"))
                })
                put("required", JSONArray())
                put("additionalProperties", false)
            }
            override fun execute(args: JSONObject): String {
                val scope = args.optString("scope", "all")
                val kindF = args.optString("kind", "")
                val limit = args.optInt("limit", 20).coerceIn(1, 200)
                val items = read()
                val list = ArrayList<JSONObject>()
                for (i in 0 until items.length()) {
                    val it0 = items.optJSONObject(i) ?: continue
                    if (!scopeMatches(it0, scope)) continue
                    if (kindF.isNotBlank() && it0.optString("kind") != kindF) continue
                    list.add(it0)
                }
                list.sortByDescending { it.optLong("updatedAt") }
                val out = JSONArray()
                list.take(limit).forEach { it0 ->
                    out.put(JSONObject().apply {
                        put("id", it0.optString("id"))
                        put("scope", it0.optString("scope"))
                        put("kind", it0.optString("kind"))
                        put("topic", it0.optString("topic"))
                        put("text", it0.optString("text"))
                        put("updatedAt", it0.optLong("updatedAt"))
                    })
                }
                return JSONObject().put("ok", true).put("total", list.size)
                    .put("items", out).toString()
            }
        },

        object : ToolSpec {
            override val name = "memory_forget"
            override val description = "删除记忆：按 id 精确删，或按关键词删掉匹配的几条（例如用户说“忘掉我刚才说的偏好”）。"
            override val parameters = JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("id", JSONObject().put("type", "string").put("description", "要删的条目 id"))
                    put("query", JSONObject().put("type", "string").put("description", "按关键词删（与 id 二选一）"))
                    put("scope", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("all", "global", "session"))))
                    put("limit", JSONObject().put("type", "number").put("description", "按关键词删时最多删几条，默认 3"))
                })
                put("required", JSONArray())
                put("additionalProperties", false)
            }
            override fun execute(args: JSONObject): String {
                val id = args.optString("id").trim()
                val query = args.optString("query").trim()
                if (id.isBlank() && query.isBlank()) throw KernelError("id 或 query 至少给一个")
                val scope = args.optString("scope", "all")
                val items = read()
                val keep = JSONArray()
                val removedIds = JSONArray()
                val q = tokens(query)
                var quota = args.optInt("limit", 3).coerceIn(1, 50)
                for (i in 0 until items.length()) {
                    val it0 = items.optJSONObject(i) ?: continue
                    val matchById = id.isNotBlank() && it0.optString("id") == id
                    val matchByQuery = id.isBlank() && query.isNotBlank() && quota > 0 &&
                        scopeMatches(it0, scope) && score(it0, q) > 0
                    if (matchById || matchByQuery) {
                        removedIds.put(it0.optString("id"))
                        if (matchByQuery) quota--
                    } else {
                        keep.put(it0)
                    }
                }
                if (removedIds.length() == 0) {
                    return JSONObject().put("ok", false).put("error", "没有匹配的记忆").toString()
                }
                write(keep)
                return JSONObject().put("ok", true).put("removed", removedIds).toString()
            }
        },
    )
}
