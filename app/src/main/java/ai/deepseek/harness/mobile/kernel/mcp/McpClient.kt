package ai.deepseek.harness.mobile.kernel.mcp

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * MCP 客户端（HTTP / Streamable-HTTP transport）—— 桌面 `packages/mcp/mcp-client` 的手机端等价物。
 *
 * 本次 WP5 修掉的缺口：
 *   - `initialize` **复用**：同一服务器只握手一次。旧实现每次 `tools()` 都重新 initialize，
 *     而 `callTool` 干脆不握手 —— 严格的服务器会在握手前拒绝。
 *   - **工具可被注册**：`toolDefs()` 带 `inputSchema` 暴露远端工具（由 [McpToolsPlugin]
 *     注册成模型工具，公开名 `mcp__<server>__<raw>`，见 [McpToolName]）。
 *   - **`isError` 显式失败**：`result.isError=true` 表示工具自己报错。旧实现只看顶层
 *     `error` 字段，会把"工具失败"当成功回给模型。
 *   - **重连退避**：500ms 起翻倍、上限 30s、连续 10 次后标记不可用（与桌面同参数）。
 *   - **JSON-RPC id 关联**：响应 id 必须匹配请求 id；SSE 不再"取最后一个 `{` 开头的帧"。
 *
 * 为什么只有 HTTP：安卓端没有外部进程运行时去跑 stdio server（桌面 `transport: stdio`
 * 要 spawn 子进程并做临时探测握手）。这是平台边界，不是欠账。
 */
class McpClient(private val configFile: File) {

    data class Server(val name: String, val url: String, val headers: Map<String, String>)

    /** 一个远端工具的规范化描述（公开名已算好） */
    data class McpTool(
        val server: String,
        val rawName: String,
        val publicName: String,
        val description: String,
        val inputSchema: JSONObject,
    )

    class McpError(val code: String, message: String) : Exception(message)

    private class Conn {
        @Volatile var initialized = false
        @Volatile var failures = 0
        @Volatile var nextRetryAt = 0L
        @Volatile var lastError: String? = null
        val id = AtomicLong(0)
    }

    private val conns = ConcurrentHashMap<String, Conn>()

    private fun conn(server: String): Conn = conns.computeIfAbsent(server) { Conn() }

    /* ---------------- 配置 ---------------- */

    fun servers(): List<Server> {
        if (!configFile.exists()) return emptyList()
        val root = runCatching { JSONObject(configFile.readText()) }.getOrNull() ?: return emptyList()
        val obj = root.optJSONObject("servers") ?: return emptyList()
        val out = mutableListOf<Server>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val v = obj.optJSONObject(k) ?: continue
            val headers = mutableMapOf<String, String>()
            v.optJSONObject("headers")?.let { h ->
                val hk = h.keys()
                while (hk.hasNext()) {
                    val name = hk.next()
                    headers[name] = h.optString(name)
                }
            }
            if (v.optString("url").isBlank()) continue
            out.add(Server(k, v.optString("url"), headers))
        }
        return out
    }

    fun find(name: String): Server? = servers().firstOrNull { it.name == name }

    /** 该服务器当前是否可用（重连预算耗尽后 false，但仍保留最后已知工具） */
    fun available(serverName: String): Boolean {
        val c = conns[serverName] ?: return true
        if (c.failures >= MAX_ATTEMPTS) return false
        return true
    }

    /* ---------------- JSON-RPC ---------------- */

    private fun rpc(
        server: Server,
        method: String,
        params: JSONObject?,
        timeoutMs: Int,
        idValue: Long?,
    ): JSONObject {
        val body = JSONObject().apply {
            put("jsonrpc", "2.0")
            if (idValue != null) put("id", idValue)
            put("method", method)
            if (params != null) put("params", params)
        }
        val conn = openConnection(server, timeoutMs)
        conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (code !in 200..299) {
            throw McpError(CODE_CONNECTION, "HTTP $code：${text.take(300)}")
        }
        if (idValue == null) return JSONObject()
        val msg = extractJsonRpc(text, idValue)
            ?: throw McpError(CODE_MALFORMED, "响应里没有与 id=$idValue 匹配的 JSON-RPC 消息")
        msg.optJSONObject("error")?.let {
            throw McpError(CODE_TOOL_ERROR, it.optString("message").ifBlank { it.toString() })
        }
        return msg
    }

    private fun openConnection(server: Server, timeoutMs: Int): HttpURLConnection =
        (URL(server.url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json, text/event-stream")
            server.headers.forEach { (k, v) -> setRequestProperty(k, v) }
        }

    /**
     * 从响应文本里取出与 id 匹配的 JSON-RPC 消息。
     * 兼容纯 JSON、SSE（多帧 `data:`，可能分片或夹心跳）。
     */
    private fun extractJsonRpc(text: String, id: Long): JSONObject? {
        val trimmed = text.trim()
        if (trimmed.startsWith("{")) {
            runCatching { JSONObject(trimmed) }.getOrNull()?.let { if (matchesId(it, id)) return it }
        }
        val frames = ArrayList<String>()
        var cur = StringBuilder()
        text.lineSequence().forEach { line ->
            val l = line.trim()
            when {
                l.startsWith("data:") -> {
                    if (cur.isNotEmpty()) cur.append('\n')
                    cur.append(l.removePrefix("data:").trim())
                }

                l.isEmpty() -> {
                    if (cur.isNotEmpty()) {
                        frames.add(cur.toString())
                        cur = StringBuilder()
                    }
                }

                else -> Unit
            }
        }
        if (cur.isNotEmpty()) frames.add(cur.toString())
        frames.asReversed().forEach { f ->
            runCatching { JSONObject(f) }.getOrNull()?.let { if (matchesId(it, id)) return it }
        }
        return null
    }

    private fun matchesId(o: JSONObject, id: Long): Boolean =
        o.has("id") && o.optLong("id", Long.MIN_VALUE) == id

    /** 惰性握手：同一服务器只 initialize 一次 */
    private fun ensureInitialized(server: Server) {
        val c = conn(server.name)
        if (c.initialized) return
        synchronized(c) {
            if (c.initialized) return
            rpc(
                server, "initialize",
                JSONObject().apply {
                    put("protocolVersion", PROTOCOL_VERSION)
                    put("capabilities", JSONObject())
                    put(
                        "clientInfo",
                        JSONObject().put("name", "dsh-mobile").put("version", "1.0.0"),
                    )
                },
                HANDSHAKE_TIMEOUT_MS, c.id.incrementAndGet(),
            )
            // 规范要求发这个通知；服务器不应答
            runCatching {
                rpc(server, "notifications/initialized", JSONObject(), HANDSHAKE_TIMEOUT_MS, null)
            }
            c.initialized = true
            c.failures = 0
            c.lastError = null
        }
    }

    /* ---------------- 工具 ---------------- */

    /** 拉取该服务器的工具定义（带分页）。同一工具名重复出现视为无效列表（桌面同语义）。 */
    fun toolDefs(serverName: String): List<McpTool> {
        val server = find(serverName)
            ?: throw McpError(CODE_NOT_CONFIGURED, "没有名为「$serverName」的 MCP 服务器配置")
        return try {
            withRetry(server) {
                ensureInitialized(server)
                val out = LinkedHashMap<String, McpTool>()
                var cursor: String? = null
                var page = 0
                do {
                    val params = JSONObject()
                    if (!cursor.isNullOrBlank()) params.put("cursor", cursor)
                    val c = conn(server.name)
                    val resp = rpc(
                        server, "tools/list", params, REQUEST_TIMEOUT_MS,
                        c.id.incrementAndGet(),
                    )
                    val result = resp.optJSONObject("result") ?: JSONObject()
                    val arr = result.optJSONArray("tools") ?: JSONArray()
                    for (i in 0 until arr.length()) {
                        val t = arr.optJSONObject(i) ?: continue
                        val raw = t.optString("name")
                        if (raw.isBlank()) continue
                        if (out.containsKey(raw)) {
                            throw McpError(
                                CODE_MALFORMED, "服务器把一个工具列了两次：$raw（无效工具列表）",
                            )
                        }
                        out[raw] = McpTool(
                            server = server.name,
                            rawName = raw,
                            publicName = McpToolName.publicName(server.name, raw),
                            description = t.optString("description"),
                            inputSchema = t.optJSONObject("inputSchema") ?: JSONObject().apply {
                                put("type", "object")
                                put("properties", JSONObject())
                            },
                        )
                    }
                    cursor = result.optString("nextCursor").ifBlank { null }
                    page++
                } while (cursor != null && page < MAX_PAGES)
                out.values.toList()
            }
        } catch (e: McpError) {
            throw e
        } catch (t: Throwable) {
            throw McpError(CODE_CONNECTION, "连接 ${server.url} 失败：${t.message}")
        }
    }

    /**
     * 调用远端工具。`rawName` 是服务器自己的名字（公开名绝不发给服务器）。
     * `result.isError=true` → 抛 [McpError]，让工具层明确失败。
     */
    fun callTool(serverName: String, rawName: String, args: JSONObject): JSONObject {
        val server = find(serverName)
            ?: throw McpError(CODE_NOT_CONFIGURED, "没有名为「$serverName」的 MCP 服务器配置")
        return try {
            withRetry(server) {
                ensureInitialized(server)
                val c = conn(server.name)
                val resp = rpc(
                    server, "tools/call",
                    JSONObject().put("name", rawName).put("arguments", args),
                    TOOL_TIMEOUT_MS, c.id.incrementAndGet(),
                )
                val result = resp.optJSONObject("result") ?: JSONObject()
                if (result.optBoolean("isError", false)) {
                    throw McpError(
                        CODE_TOOL_ERROR,
                        extractText(result).ifBlank { "远端工具报告失败（isError）" },
                    )
                }
                result
            }
        } catch (e: McpError) {
            throw e
        } catch (t: Throwable) {
            throw McpError(CODE_CONNECTION, "调用 $serverName/$rawName 失败：${t.message}")
        }
    }

    /** MCP content 数组 → 纯文本（图片等非文本块给出明确诊断，不静默丢） */
    fun extractText(result: JSONObject): String {
        val arr = result.optJSONArray("content") ?: return result.optString("output")
        val sb = StringBuilder()
        for (i in 0 until arr.length()) {
            val blk = arr.optJSONObject(i) ?: continue
            when (blk.optString("type")) {
                "text" -> sb.append(blk.optString("text"))
                "image" -> sb.append("[图片：").append(blk.optString("mimeType", "image"))
                    .append("，手机端 MCP 图片投影暂未实现]")

                "resource" -> sb.append("[资源：")
                    .append(blk.optJSONObject("resource")?.optString("uri").orEmpty()).append(']')

                else -> sb.append('[').append(blk.optString("type")).append(']')
            }
            if (i < arr.length() - 1) sb.append('\n')
        }
        return sb.toString()
    }

    /** 兼容旧调用点：返回 tools/list 的规范化 JSON */
    fun tools(serverName: String): String = runCatching {
        val defs = toolDefs(serverName)
        JSONObject().apply {
            put("ok", true)
            put("server", serverName)
            put("count", defs.size)
            put(
                "tools", JSONArray().apply {
                    defs.forEach { d ->
                        put(JSONObject().apply {
                            put("name", d.publicName)
                            put("raw_name", d.rawName)
                            put("description", d.description)
                            put("inputSchema", d.inputSchema)
                        })
                    }
                },
            )
        }.toString()
    }.getOrElse { e -> failJson(e) }

    /* ---------------- 资源 ---------------- */

    fun listResources(serverName: String, cursor: String? = null): String =
        resourceCall(serverName, "resources/list", cursor)

    fun listResourceTemplates(serverName: String, cursor: String? = null): String =
        resourceCall(serverName, "resources/templates/list", cursor)

    fun readResource(serverName: String, uri: String): String {
        val server = find(serverName) ?: return notConfigured(serverName)
        return try {
            withRetry(server) {
                ensureInitialized(server)
                val c = conn(server.name)
                rpc(
                    server, "resources/read", JSONObject().put("uri", uri),
                    REQUEST_TIMEOUT_MS, c.id.incrementAndGet(),
                ).getJSONObject("result").toString()
            }
        } catch (t: Throwable) {
            failJson(t)
        }
    }

    private fun resourceCall(serverName: String, method: String, cursor: String?): String {
        val server = find(serverName) ?: return notConfigured(serverName)
        return try {
            withRetry(server) {
                ensureInitialized(server)
                val params = JSONObject()
                if (!cursor.isNullOrBlank()) params.put("cursor", cursor)
                val c = conn(server.name)
                rpc(server, method, params, REQUEST_TIMEOUT_MS, c.id.incrementAndGet())
                    .getJSONObject("result").toString()
            }
        } catch (t: Throwable) {
            failJson(t)
        }
    }

    /* ---------------- 重连退避 ---------------- */

    private fun <T> withRetry(server: Server, block: () -> T): T {
        val c = conn(server.name)
        if (c.failures >= MAX_ATTEMPTS) {
            throw McpError(
                CODE_UNAVAILABLE,
                "「${server.name}」连续失败 ${c.failures} 次后已停止重连" +
                    "（最后错误：${c.lastError ?: "未知"}）。重载配置或重启应用后会重试。",
            )
        }
        return try {
            val r = block()
            c.failures = 0
            c.nextRetryAt = 0
            c.lastError = null
            r
        } catch (t: Throwable) {
            c.failures++
            c.lastError = t.message
            c.initialized = false
            c.nextRetryAt = System.currentTimeMillis() + backoffMs(c.failures)
            throw t
        }
    }

    /** 500ms 起翻倍，上限 30s（桌面 reconnect 同参数） */
    private fun backoffMs(failures: Int): Long {
        var v = INITIAL_BACKOFF_MS
        repeat((failures - 1).coerceIn(0, 10)) { v *= 2 }
        return v.coerceAtMost(MAX_BACKOFF_MS)
    }

    /* ---------------- 诊断 ---------------- */

    fun describe(): String {
        val arr = JSONArray()
        servers().forEach { s ->
            val c = conns[s.name]
            arr.put(JSONObject().apply {
                put("name", s.name)
                put("url", s.url)
                put("initialized", c?.initialized ?: false)
                put("failures", c?.failures ?: 0)
                put("available", available(s.name))
                c?.lastError?.let { put("lastError", it) }
            })
        }
        return JSONObject().apply {
            put("ok", true)
            put("count", arr.length())
            put("servers", arr)
            put("transport", "streamable-http")
            put(
                "note",
                "安卓端不支持 stdio transport（没有外部进程运行时）；" +
                    "远端工具以 mcp__<server>__<tool> 注册",
            )
            put("configFile", configFile.absolutePath)
        }.toString()
    }

    private fun notConfigured(name: String): String = JSONObject().apply {
        put("ok", false)
        put("code", CODE_NOT_CONFIGURED)
        put("error", "没有名为「$name」的 MCP 服务器配置")
        put(
            "hint",
            "在 files/kernel/mcp.json 里加 {\"servers\":{\"$name\":{\"url\":\"...\"}}}；" +
                "桌面同样需要显式配置 mcp-client 条目",
        )
        put("configured", describe())
    }.toString()

    private fun failJson(t: Throwable): String = JSONObject().apply {
        put("ok", false)
        put("code", (t as? McpError)?.code ?: CODE_CONNECTION)
        put("error", t.message ?: t.toString())
    }.toString()

    companion object {
        const val PROTOCOL_VERSION = "2024-11-05"
        const val CODE_NOT_CONFIGURED = "MCP_NOT_CONFIGURED"
        const val CODE_CONNECTION = "MCP_CONNECTION_FAILED"
        const val CODE_TOOL_ERROR = "MCP_TOOL_ERROR"
        const val CODE_MALFORMED = "MCP_MALFORMED_RESPONSE"
        const val CODE_UNAVAILABLE = "MCP_UNAVAILABLE"

        private const val HANDSHAKE_TIMEOUT_MS = 20_000
        private const val REQUEST_TIMEOUT_MS = 30_000
        private const val TOOL_TIMEOUT_MS = 60_000
        private const val MAX_PAGES = 50
        private const val MAX_ATTEMPTS = 10
        private const val INITIAL_BACKOFF_MS = 500L
        private const val MAX_BACKOFF_MS = 30_000L
    }
}
