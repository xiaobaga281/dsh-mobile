package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 会话事件日志 —— 对应桌面 Harness 的 `session/event`，并且是**模型历史的唯一来源**。
 *
 * WS1（会话日志即上下文）的落点：
 *   · 信封带 `v`（当前 2）；v1 旧文件只读复制成 `<id>.v2.jsonl`，绝不原地改写。
 *   · 每个进入请求的东西都有对应事件：`system/message`、`user/message`、
 *     `assistant/message.message`（content blocks，含 tool_call）、`tool/call`
 *     （arguments 全文）、`tool/result.message`（模型可见正文）。
 *   · [deriveMessages] 从这些事件投影出 OpenAI 兼容消息；工具调用与结果成对出现，
 *     孤立的 tool 消息不会进入历史（老 v1 日志因此自然降级为纯文本历史）。
 *
 * 存储：`files/sessions/<sessionId>.jsonl`（v1，只读）/
 *       `files/sessions/<sessionId>.v2.jsonl`（v2，追加写）。
 */
class SessionStore(private val dir: File) {

    init { if (!dir.exists()) dir.mkdirs() }

    companion object {
        /** 当前事件信封版本。v1（无 `v` 字段）在首次写入时迁移。 */
        const val FORMAT_VERSION = 2

        /** 派生历史的默认上限（消息条数）。 */
        const val DERIVE_LIMIT = 200

        private fun safeName(sessionId: String): String =
            sessionId.replace(Regex("""[^\w.-]"""), "_").ifBlank { "draft" }

        /** 模型可见文本：优先 v2 的 content blocks，退回 v1 的 text。 */
        fun visibleText(event: JSONObject): String {
            val msg = event.optJSONObject("message")
            if (msg != null) {
                val content = msg.optJSONArray("content")
                if (content != null) {
                    val sb = StringBuilder()
                    for (i in 0 until content.length()) {
                        val b = content.optJSONObject(i) ?: continue
                        if (b.optString("type") == "text") sb.append(b.optString("text"))
                    }
                    if (sb.isNotBlank()) return sb.toString()
                }
                val single = msg.optString("content")
                if (single.isNotBlank()) return single
            }
            val content = event.opt("content")
            if (content is String && content.isNotBlank()) return content
            if (content is JSONArray) {
                val sb = StringBuilder()
                for (i in 0 until content.length()) {
                    val b = content.optJSONObject(i) ?: continue
                    if (b.optString("type") == "text") sb.append(b.optString("text"))
                }
                if (sb.isNotBlank()) return sb.toString()
            }
            return event.optString("text")
        }
    }

    private fun v1File(sessionId: String): File = File(dir, "${safeName(sessionId)}.jsonl")

    private fun v2File(sessionId: String): File = File(dir, "${safeName(sessionId)}.v2.jsonl")

    /**
     * 当前可写/可读的活动文件。
     *
     * 语义：v2 存在 → v2；只有 v1 → v1（下次写入前先迁移）；两者都不存在 → **v2**
     * （新会话直接写 v2，避免「先写 v1、再迁移、写句柄还停在 v1」的撕裂）。
     */
    private fun activeFile(sessionId: String): File {
        val v2 = v2File(sessionId)
        if (v2.exists()) return v2
        val v1 = v1File(sessionId)
        if (v1.exists()) return v1
        return v2
    }

    /**
     * 同一会话的写必须串行。
     *
     * `File.appendText` 是「打开 → 写 → 关闭」三步，两个线程同时写同一行会交错成半行 JSON，
     * 回放时那一条就静默丢了。桌面用 per-Lead 事务队列保证顺序；这里用 per-session 监视器，
     * 覆盖所有写者（AgentDriver、团队名册、任务板），而不只是团队内部的锁。
     */
    private val locks = java.util.concurrent.ConcurrentHashMap<String, Any>()

    private fun lockFor(sessionId: String): Any =
        locks.computeIfAbsent(safeName(sessionId)) { Any() }

    /** writer 缓存上限：超出按 LRU 淘汰并关闭（活跃会话撑不满，只是防句柄泄漏的兜底） */
    private val MAX_WRITERS = 16

    /**
     * per-session 常开写句柄：打开一次，每次 write+flush。
     *
     * 原来的 `appendText` 是「打开→写→关闭」，step 边界事件密集时（每个工具 3+ 次）
     * 反复开-关文件阻塞 agent 线程。flush 后数据即入内核页缓存 —— 与「关闭落盘」对
     * 进程被杀/断电的可靠性完全等价（close 本身也不 fsync），不降低任何崩溃场景的安全性。
     */
    private class SessionWriter(val file: File) {
        val fdOut = java.io.FileOutputStream(file, true)
        private val writer = java.io.BufferedWriter(
            java.io.OutputStreamWriter(fdOut, Charsets.UTF_8), 8 * 1024
        )

        /** line 不含换行；sync=true 时 fsync —— appendOrThrow 的「落盘成功才算提交」 */
        fun writeAndFlush(line: String, sync: Boolean) {
            writer.write(line)
            writer.write("\n")
            writer.flush()
            if (sync) fdOut.fd.sync()
        }

        /** 只 flush 不 fsync（read 前保证缓冲不压数据） */
        fun flushOnly() {
            runCatching { writer.flush() }
        }

        fun close() {
            runCatching { writer.flush() }
            runCatching { writer.close() }
        }
    }

    /**
     * writer 缓存（accessOrder LRU）。LinkedHashMap 非线程安全，而不同 session 的
     * 监视器锁互不相同 —— map 的所有访问（get 也改访问序）必须再套专用锁 [writersLock]。
     * 锁序固定：外层 lockFor(sid)，内层 writersLock，永不反转，防死锁。
     */
    private val writersLock = Any()
    private val writers = object : java.util.LinkedHashMap<String, SessionWriter>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, SessionWriter>): Boolean =
            if (size > MAX_WRITERS) {
                eldest.value.close()
                true
            } else false
    }

    /**
     * 取写句柄。缓存里那个句柄如果指向的不是当前活动文件（典型场景：旧会话 v1→v2
     * 迁移完成后，句柄还停在 v1），必须关掉重开 —— 否则后续事件写进 v1、而 read()
     * 只读 v2，整段历史在读者眼里凭空消失（团队测试就是这么红的）。
     */
    private fun writerFor(sessionId: String): SessionWriter = synchronized(writersLock) {
        val want = activeFile(sessionId)
        val cached = writers[sessionId]
        if (cached != null && cached.file == want) return cached
        cached?.close()
        val w = SessionWriter(want)
        writers[sessionId] = w
        w
    }

    private fun dropWriter(sessionId: String): SessionWriter? =
        synchronized(writersLock) { writers.remove(sessionId) }

    /* ---------------- v1 → v2 只读复制迁移 ---------------- */

    /**
     * v1 → v2 迁移：**只读**复制旧文件到 `<id>.v2.jsonl`，旧文件原样保留。
     *
     * 迁移只补齐信封版本与一次 `history/degraded` 标记，不伪造任何 v1 里没有的事实：
     * v1 的 `assistant/message` 没有工具调用、`tool/result` 没有正文，所以旧会话的
     * 派生历史就是「纯文本历史」——这正是诚实的降级，而不是编造一次工具调用。
     * 幂等：v2 已存在、临时文件残留、重复调用都不会产生第二份。
     */
    private fun ensureMigrated(sessionId: String) {
        val v1 = v1File(sessionId)
        val v2 = v2File(sessionId)
        if (v2.exists() || !v1.exists()) return
        synchronized(lockFor(sessionId)) {
            if (v2.exists() || !v1.exists()) return
            val events = v1.readLines().mapNotNull { line ->
                if (line.isBlank()) null else runCatching { JSONObject(line) }.getOrNull()
            }
            val tmp = File(v1.parentFile, v2.name + ".tmp")
            runCatching {
                tmp.bufferedWriter(Charsets.UTF_8).use { w ->
                    events.forEach { ev ->
                        // 已经带 version 的（理论上不会）保持原样，避免二次迁移改语义。
                        if (!ev.has("v")) ev.put("v", FORMAT_VERSION)
                        w.write(ev.toString()); w.newLine()
                    }
                    val marker = JSONObject().apply {
                        put("ts", System.currentTimeMillis())
                        put("type", "history/degraded")
                        put("v", FORMAT_VERSION)
                        put("reason", "v1_no_tool_events")
                        put("count", events.size)
                    }
                    w.write(marker.toString()); w.newLine()
                }
                if (!tmp.renameTo(v2)) {
                    tmp.copyTo(v2, overwrite = true)
                    tmp.delete()
                }
            }.onFailure {
                // 迁移失败就继续读 v1：功能降级，但不丢数据、不阻塞这一轮
                runCatching { tmp.delete() }
            }
        }
    }

    /** 该会话当前的日志格式版本（v2 文件存在即 2）。 */
    fun formatVersion(sessionId: String): Int = if (v2File(sessionId).exists()) 2 else 1

    /**
     * 删掉这一场的日志（页面侧「删除会话」在内核的那半边）。
     *
     * **必须先关句柄再删**：`writers` 里那个 BufferedWriter 还开着时，`delete()` 在部分
     * 文件系统上只是打个标记，下一次追加会让这个文件原地「复活」—— 用户看到的就是
     * 「删掉的会话又回来了」。 writers / locks 两张表也要一起摘掉，否则缓存里留着
     * 一个指向已删文件的条目。
     *
     * 返回**是否清干净**：没东西可删、或还有文件删不掉，都返回 false ——
     * 调用方（内核 purgeSession）据此把「清了几样」如实报给页面，不能虚报。
     */
    fun delete(sessionId: String): Boolean {
        if (sessionId.isBlank()) return false
        val targets = listOf(v1File(sessionId), v2File(sessionId),
            File(v2File(sessionId).parentFile, v2File(sessionId).name + ".tmp")).filter { it.exists() }
        if (targets.isEmpty()) return false
        synchronized(writersLock) {
            writers.remove(sessionId)?.let { w -> runCatching { w.close() } }
        }
        var left = 0
        synchronized(lockFor(sessionId)) {
            targets.forEach { f -> runCatching { if (!f.delete()) left++ }.onFailure { left++ } }
            locks.remove(sessionId)
        }
        return left == 0
    }

    /** 目录里现有的会话日志 id（v1/v2 都算，去掉扩展名）。清扫孤儿时用。 */
    fun fileIds(): List<String> {
        val files = runCatching { dir.listFiles()?.toList() ?: emptyList() }.getOrElse { emptyList() }
        return files.mapNotNull { f ->
            val n = f.name
            when {
                n.endsWith(".v2.jsonl.tmp") -> null            // 迁移中途的临时件，不算一场会话
                n.endsWith(".v2.jsonl") -> n.removeSuffix(".v2.jsonl")
                n.endsWith(".jsonl") -> n.removeSuffix(".jsonl")
                else -> null
            }
        }.distinct()
    }

    /* ---------------- 写 ---------------- */

    /** 尽力而为的追加：失败只丢这一条，不打断主流程（用于日志/活动流/进度快照） */
    fun append(sessionId: String, type: String, payload: JSONObject = JSONObject()): JSONObject {
        ensureMigrated(sessionId)
        val ev = build(type, payload)
        try {
            synchronized(lockFor(sessionId)) { writeTo(sessionId, ev.toString(), sync = false) }
        } catch (_: Throwable) {}
        return ev
    }

    /**
     * 必须成功的追加：磁盘满/目录不可写时抛 [java.io.IOException]。
     *
     * 团队状态（成员快照、任务快照、初始任务）走这条路 —— 桌面 `appendAndFlush`
     * 也是「落盘成功才算提交」。吞掉失败的后果很具体：工具回了 ok，重启后团队没了。
     * 写路径 flush 之外还 fsync，把提交语义从「页缓存写入」提升到「断电也不丢」。
     */
    fun appendOrThrow(sessionId: String, type: String, payload: JSONObject = JSONObject()): JSONObject {
        ensureMigrated(sessionId)
        val ev = build(type, payload)
        synchronized(lockFor(sessionId)) { writeTo(sessionId, ev.toString(), sync = true) }
        return ev
    }

    /**
     * 统一写路径：调用方已持有 lockFor 监视器锁。
     * 句柄失效（外部删文件/IO 错误）时关闭并丢弃缓存，降级为单次 appendText 自愈；
     * sync=true 的任何失败都原样上抛 —— 严格提交语义只加强不放松。
     */
    private fun writeTo(sessionId: String, line: String, sync: Boolean) {
        val w = try {
            writerFor(sessionId)
        } catch (t: Throwable) {
            if (sync) throw t
            return
        }
        try {
            w.writeAndFlush(line, sync)
        } catch (t: Throwable) {
            w.close()
            dropWriter(sessionId)
            if (sync) throw t
            // 尽力而为路径：降级单次打开-写-关闭再试一把，失败就丢这条
            runCatching { activeFile(sessionId).appendText(line + "\n") }
        }
    }

    private fun build(type: String, payload: JSONObject): JSONObject = JSONObject().apply {
        put("ts", System.currentTimeMillis())
        put("type", type)
        put("v", FORMAT_VERSION)
        payload.keys().forEach { k -> put(k, payload.get(k)) }
    }

    fun read(sessionId: String): List<JSONObject> {
        val f = activeFile(sessionId)
        if (!f.exists()) return emptyList()
        return try {
            // 与写共用一把锁：否则可能读到正在写的半行，那一条被当成坏 JSON 丢掉
            synchronized(lockFor(sessionId)) {
                // 常开 writer 的缓冲先刷掉：flush 每写都有，这里是双保险
                synchronized(writersLock) { writers[sessionId]?.flushOnly() }
                f.readLines().mapNotNull { line ->
                    if (line.isBlank()) null else runCatching { JSONObject(line) }.getOrNull()
                }
            }
        } catch (_: Throwable) { emptyList() }
    }

    /**
     * 最后一轮（最后一个 `turn/start` 之后）的有序回放段，形状与实时链路发给页面的事件一致：
     * `{t: "reasoning" | "delta" | "tool_start" | "tool_end", …}`。
     *
     * 为什么要有：页面切去看队友（或别的会话）时不渲染这一场 —— 事件被丢弃、轮末的
     * `onDone` 也收不到。回来只补正文（[lastAssistantText]）的话，这一轮的过程组与工具行
     * 在界面上整段不存在，屏幕比实际发生的「扁」一格。桌面端的做法是重开一场就走会话日志
     * 重放，这里给同一条渲染通道喂同一种段。
     *
     * 顺序就是日志顺序：一步 = `assistant/message`（思考 + 正文）→ `tool/call` → `tool/result`，
     * 与模型实际发生的先后一致。只取最后一轮。`text` 是该轮最后一段正文（收尾行与落库用），
     * `steps` / `tokens` 同实时链路口径。这一场没有 `turn/start`（空会话或旧日志）时 `ok=false`。
     */
    fun roundTrace(sessionId: String): JSONObject {
        val all = read(sessionId)
        val from = all.indexOfLast { it.optString("type") == "turn/start" }
        if (from < 0) return JSONObject().put("ok", false).put("segments", JSONArray())
        val segs = JSONArray()
        var finalText = ""
        var steps = 0
        var tokens = 0
        // 这一轮用了多久：过程组折叠那一行写着「用时 N 秒」，没有真实时长就只能报 0，
        // 等于在屏幕上撒谎。日志每条都带 ts，首尾一减就是这一轮的墙钟时间。
        val startedAt = all[from].optLong("ts")
        var lastTs = startedAt
        for (ev in all.drop(from)) {
            ev.optLong("ts").let { if (it > lastTs) lastTs = it }
            when (ev.optString("type")) {
                "step/start" -> steps++
                "assistant/message" -> {
                    val think = ev.optString("reasoning")
                    if (think.isNotBlank()) segs.put(JSONObject().put("t", "reasoning").put("text", think))
                    val body = ev.optString("text")
                    if (body.isNotBlank()) {
                        finalText = body
                        segs.put(JSONObject().put("t", "delta").put("text", body))
                    }
                    tokens += ev.optInt("promptTokens") + ev.optInt("completionTokens")
                }
                "tool/call" -> segs.put(
                    JSONObject()
                        .put("t", "tool_start")
                        .put("id", ev.optString("id"))
                        .put("name", ev.optString("name"))
                        // arguments 是原文，args 是旧的 500 字截断值：回放优先原文
                        .put("args", if (ev.has("arguments")) ev.optString("arguments") else ev.optString("args"))
                )
                "tool/result" -> segs.put(
                    JSONObject()
                        .put("t", "tool_end")
                        .put("id", ev.optString("id"))
                        .put("name", ev.optString("name"))
                        .put("ok", ev.optBoolean("ok", true))
                        .put("ms", ev.optLong("ms"))
                        .put("output", toolResultText(ev))
                )
            }
        }
        return JSONObject()
            .put("ok", segs.length() > 0)
            .put("segments", segs)
            .put("text", finalText)
            .put("steps", steps)
            .put("tokens", tokens)
            .put("ms", if (lastTs > startedAt) lastTs - startedAt else 0L)
    }

    /** 工具结果里给模型看的那段正文（`message.content[0].text`）；缺结构时给空串而不是 null。 */
    private fun toolResultText(ev: JSONObject): String {
        val block = ev.optJSONObject("message")?.optJSONArray("content")?.optJSONObject(0) ?: return ""
        return if (block.optString("type") == "text") block.optString("text") else ""
    }

    /**
     * 从日志派生模型历史（WS1 的核心）。
     *
     * 投影规则（与桌面 `Session.deriveMessages()` 同契约，手机端只支持 OpenAI 兼容消息）：
     *   · `system/message`     最新一条非空文本即有效系统提示（多条时只取最后一条）。
     *   · `user/message`       文本/多模态 parts 里的 text 部分按原顺序进入历史。
     *   · `assistant/message`  `message.content` 的 text 拼成正文，tool_call 还原成
     *                          OpenAI `tool_calls`；`interrupted` 且无正文 → 不进入历史
     *                          （桌面对应 `assistant/attempt`，模型看不到）。
     *   · `tool/result`        只接受**有配对 assistant tool_call** 的结果；v1 日志里
     *                          孤立的工具结果被跳过，因此不会出现「有 tool 无 call」的 400。
     *   · `history/degraded` 与 `compaction` 系列等日志专用事件不产生消息。
     *
     * @param limit 最多保留的消息条数；裁剪后开头的孤立 tool 消息会被丢弃（保持成对）。
     */
    fun deriveMessages(sessionId: String, limit: Int = DERIVE_LIMIT): MutableList<JSONObject> {
        val out = mutableListOf<JSONObject>()
        var systemText = ""
        var pendingCalls = LinkedHashSet<String>()

        read(sessionId).forEach { ev ->
            when (ev.optString("type")) {
                "system/message" -> {
                    val text = visibleText(ev)
                    if (text.isNotBlank()) systemText = text
                }

                "user/message" -> {
                    val text = visibleText(ev)
                    if (text.isNotBlank()) out.add(JSONObject().put("role", "user").put("content", text))
                }

                "assistant/message" -> {
                    val message = ev.optJSONObject("message")
                    if (message == null) {
                        // v1 兼容：只有 text 字段，没有工具调用（迁移后不做无中生有）
                        val text = ev.optString("text").trim()
                        if (text.isNotEmpty()) out.add(JSONObject().put("role", "assistant").put("content", text))
                        return@forEach
                    }
                    val content = message.optJSONArray("content")
                    val text = StringBuilder()
                    val wire = JSONArray()
                    if (content != null) {
                        for (i in 0 until content.length()) {
                            val block = content.optJSONObject(i) ?: continue
                            when (block.optString("type")) {
                                "text" -> text.append(block.optString("text"))
                                "tool_call" -> wire.put(JSONObject().apply {
                                    put("id", block.optString("id"))
                                    put("type", "function")
                                    put("function", JSONObject()
                                        .put("name", block.optString("name"))
                                        .put("arguments", block.optString("arguments")))
                                })
                            }
                        }
                    }
                    if (wire.length() > 0) {
                        out.add(JSONObject().apply {
                            put("role", "assistant")
                            put("content", if (text.isBlank()) JSONObject.NULL else text.toString())
                            put("tool_calls", wire)
                        })
                        pendingCalls = LinkedHashSet((0 until wire.length()).mapNotNull { i ->
                            wire.optJSONObject(i)?.optString("id")?.takeIf { it.isNotBlank() }
                        })
                    } else if (text.isNotBlank()) {
                        out.add(JSONObject().put("role", "assistant").put("content", text.toString()))
                        pendingCalls.clear()
                    }
                }

                "tool/result" -> {
                    val message = ev.optJSONObject("message")
                    val id = (message?.optString("toolCallId") ?: "").ifBlank { ev.optString("id") }
                    // 没有对应 assistant tool_call 的结果不能进入历史：OpenAI 兼容端点会 400
                    if (id.isBlank() || id !in pendingCalls) return@forEach
                    var text = visibleText(ev)
                    val isError = message?.optBoolean("isError") ?: ev.optBoolean("isError")
                    if (isError && !text.startsWith("Error:")) {
                        text = "Error: " + text.ifBlank { "工具执行失败（无错误信息）" }
                    }
                    out.add(JSONObject().apply {
                        put("role", "tool")
                        put("tool_call_id", id)
                        put("content", text)
                    })
                    pendingCalls.remove(id)
                }
            }
        }

        if (out.size > limit) {
            val kept = out.takeLast(limit).toMutableList()
            // 裁掉开头属于「被裁掉的 assistant 调用」的 tool 结果，保持配对
            while (kept.isNotEmpty() && kept.first().optString("role") == "tool") kept.removeAt(0)
            out.clear()
            out.addAll(kept)
        }
        if (systemText.isNotBlank()) {
            out.add(0, JSONObject().put("role", "system").put("content", systemText))
        }
        return out
    }

    /** 会话概览：轮数、步数、工具调用数、token */
    fun summary(sessionId: String): JSONObject {
        var turns = 0; var steps = 0; var tools = 0; var prompt = 0; var completion = 0
        read(sessionId).forEach { ev ->
            when (ev.optString("type")) {
                "turn/start" -> turns++
                "step/start" -> steps++
                "tool/call" -> tools++
                "assistant/message" -> {
                    prompt += ev.optInt("promptTokens")
                    completion += ev.optInt("completionTokens")
                }
            }
        }
        return JSONObject().apply {
            put("turns", turns); put("steps", steps); put("tools", tools)
            put("promptTokens", prompt); put("completionTokens", completion)
        }
    }

    fun listSessions(): JSONArray = JSONArray().apply {
        // v1 + v2 同时存在时只报一次（优先 v2 的字节数）；`.tmp` 迁移残留忽略
        val seen = HashSet<String>()
        val files = dir.listFiles { f -> f.extension == "jsonl" && !f.name.endsWith(".tmp") }
            ?.sortedByDescending { it.lastModified() } ?: emptyList()
        files.forEach { f ->
            val base = f.name
                .removeSuffix(".v2.jsonl")
                .removeSuffix(".jsonl")
            if (!seen.add(base)) return@forEach
            put(JSONObject().apply {
                put("id", base)
                put("bytes", f.length())
                put("mtime", f.lastModified())
            })
        }
    }

    fun clear(sessionId: String) {
        synchronized(lockFor(sessionId)) {
            // 先关句柄再删文件：不关的话 fd 会继续往孤儿 inode 里写
            dropWriter(sessionId)?.close()
            runCatching { v1File(sessionId).delete() }
            runCatching { v2File(sessionId).delete() }
            runCatching { File(dir, v2File(sessionId).name + ".tmp").delete() }
        }
    }
}

/**
 * 历史来源策略（从日志派生优先，前端历史只在日志为空时兜底）。
 *
 * 抽成纯函数是为了单测：这条策略决定「模型看到的是不是它上一次真的做过的事」，
 * 不应该只能靠启动整机来验证。
 */
object HistoryPolicy {

    data class Picked(val messages: MutableList<JSONObject>, val degraded: Boolean)

    /**
     * @param fromLog [SessionStore.deriveMessages] 的结果（日志即事实）
     * @param legacy 前端传入的 `config.history`（v1 迁移期/空日志兜底）
     * @return 选用哪一份，以及是否发生了降级（true 时调用方必须写 `history/degraded`）
     */
    fun pick(fromLog: List<JSONObject>, legacy: List<JSONObject>): Picked = when {
        fromLog.isNotEmpty() -> Picked(fromLog.toMutableList(), false)
        legacy.isNotEmpty() -> Picked(
            legacy.map { JSONObject(it.toString()) }.toMutableList(),
            true,
        )
        else -> Picked(mutableListOf(), false)
    }
}
