package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 工具名清洗：JSON 的 `"name": null` 经 org.json 的 `optString` 会变成**字符串 "null"**，
 * 照单全收就会拿 "null" 去 `registry.exec`，报「工具名不合法：\"null\"」—— 把模型和人
 * 一起带偏（用户实测：团队工具中途冒出这句）。空 / "null" / "undefined" 一律当成
 * 「这一段没给名字」，由累加方决定沿用已有名字还是当作缺失。
 */
internal fun toolNameOf(raw: String?): String {
    val v = raw?.trim().orEmpty()
    val lower = v.lowercase()
    return if (lower == "null" || lower == "undefined") "" else v
}

/**
 * 工具名按 index 累积：名字通常只在第一个 chunk 到达，后续 chunk 的 `"name": null`
 * 不许把已经拿到的名字覆盖掉（实测：团队工具就是这么变成 "null" 再报「工具名不合法」的）。
 */
internal fun mergeToolCallName(current: String, raw: String?): String {
    val v = toolNameOf(raw)
    return if (v.isNotEmpty()) v else current
}

/**
 * 模型调用客户端（原生，无中间层）。
 *
 * 桌面 Harness 把这层叫 `llm` 适配器：只负责「一次请求 → 一段流 → 一个 settlement」，
 * 重试、压缩、工具循环都在外层。这里保持同一个边界：
 * - [stream] 增量回调给 Driver，Driver 再翻译成 agent 事件；
 * - 工具调用按 index 累积分片（OpenAI 兼容格式的坑：name/arguments 会拆开到达）；
 * - [cancel] 直接断开连接，不等模型自然结束。
 */
class LlmClient(
    private val baseUrl: String,
    private val apiKey: String,
    private val log: (String) -> Unit = {},
    /**
     * 账号登录态 token 的读取器。桌面按目标 origin 解析凭据
     * （`deepseekAccount.resolveToken(baseURL)`）：只有被允许的源才拿得到账号 token。
     * 手机端同样只在 Messages 端点（api.deepseek.com/anthropic）上用它，
     * 第三方端点永远走 [apiKey]，不会把平台 token 发给别人。
     */
    private val accountToken: (() -> String?)? = null,
) {
    data class ToolCall(val id: String, val name: String, val args: String)
    data class Usage(val prompt: Int, val completion: Int, val total: Int, val cached: Int = 0) {
        companion object {
            /** 缓存命中：OpenAI 风格在 prompt_tokens_details.cached_tokens，DeepSeek 直接给 prompt_cache_hit_tokens */
            fun of(u: org.json.JSONObject) = Usage(
                u.optInt("prompt_tokens"), u.optInt("completion_tokens"), u.optInt("total_tokens"),
                u.optJSONObject("prompt_tokens_details")?.optInt("cached_tokens")
                    ?: u.optInt("prompt_cache_hit_tokens"),
            )
        }
    }
    data class Result(
        val text: String,
        val reasoning: String,
        val toolCalls: List<ToolCall>,
        val usage: Usage,
        val finishReason: String,
    )

    /**
     * 一次请求的终止失败。带 [code]（与桌面 `LlmFailure.code` 同名同义）与 [status]，
     * 让外层能按码决定重试还是直接报错 —— 只有 message 的旧形态无法区分
     * 「密钥错了」和「网络抖了一下」，前者重试五次也没用，后者不重试就是白失败。
     */
    class LlmError(
        message: String,
        val code: String = "UNKNOWN",
        val status: Int = 0,
    ) : Exception(message) {
        /** 是否值得自动重试（桌面 retryPolicy 的 retryableCodes 判定） */
        val retryable: Boolean get() = LlmRetry.retryable(code)

        /** 面向用户的诊断（不重试时直接展示这句） */
        fun human(): String = LlmRetry.human(code, message)
    }

    /** HTTP 状态 → 失败码（对齐桌面适配器的规范化，含上下文超限特判） */
    private fun codeForHttp(status: Int, body: String): String {
        val lower = body.lowercase()
        if (status == 400 && (
                lower.contains("context length") || lower.contains("context_length") ||
                    lower.contains("maximum context") || lower.contains("too many tokens") ||
                    lower.contains("context window")
                )
        ) return "CONTEXT_OVERFLOW"
        return when {
            status == 429 -> "RATE_LIMIT"
            status == 408 || status == 504 -> "TIMEOUT"
            status == 401 -> "AUTH"
            status == 402 -> "QUOTA"
            // 403 有两种：JSON（真的是没权限）与网关层 HTML（Cloudflare 突发限流）。
            // 后者几秒后就恢复，按 PERMISSION 处理等于把可恢复的抖动报成永久错误（实测踩过）。
            status == 403 && isGatewayHtml(body) -> "RATE_LIMIT"
            status == 403 -> "PERMISSION"
            status == 404 -> "NOT_FOUND"
            status >= 500 -> "SERVER"
            status in 400..499 -> "BAD_REQUEST"
            else -> "UNKNOWN"
        }
    }

    /** 网关/WAF 的 HTML 拦截页（不是模型服务的 JSON 错误体） */
    private fun isGatewayHtml(body: String): Boolean {
        val b = body.trimStart().lowercase()
        return b.startsWith("<html") || b.startsWith("<!doctype") ||
            b.contains("cloudflare") || b.contains("<center>403")
    }

    /**
     * 把传输层异常翻译成带码的失败。
     * 之前 IOException 会直接越过 `catch (LlmError)` 逃到 turn 级兜底，
     * 用户看到的是一句英文 `Failed to connect to /127.0.0.1:8793`，且永远不会重试。
     */
    private fun transportError(e: Throwable): LlmError {
        val code = when (e) {
            is java.net.SocketTimeoutException -> "TIMEOUT"
            is java.net.UnknownHostException -> "TRANSPORT"
            else -> "TRANSPORT"
        }
        val raw = when (e) {
            is java.net.UnknownHostException -> "域名解析失败：${e.message ?: ""}"
            is java.net.SocketTimeoutException -> "连接或读取超时"
            is java.net.ConnectException -> "连接被拒绝：${e.message ?: ""}"
            is java.net.SocketException -> "连接中断：${e.message ?: ""}"
            is javax.net.ssl.SSLException -> "TLS 握手失败：${e.message ?: ""}"
            else -> e.message ?: e.javaClass.simpleName
        }
        return LlmError(raw.trim(), code, 0)
    }

    private val cancelled = AtomicBoolean(false)
    @Volatile private var conn: HttpURLConnection? = null

    fun cancel() {
        cancelled.set(true)
        runCatching { conn?.disconnect() }
    }

    fun isCancelled(): Boolean = cancelled.get()

    private class Slot {
        var id: String = ""
        var name: String = ""
        val args = StringBuilder()
    }

    fun stream(
        body: JSONObject,
        onDelta: (String) -> Unit,
        onReasoning: (String) -> Unit,
    ): Result {
        if (MessagesApi.isMessagesEndpoint(baseUrl)) return streamMessages(body, onDelta, onReasoning)
        val base = baseUrl.trim().trimEnd('/')
        val endpoint = if (base.endsWith("/chat/completions")) base else "$base/chat/completions"
        ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed(endpoint)
        val c = try {
            (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 20_000
                readTimeout = 180_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "text/event-stream")
                if (apiKey.isNotBlank()) setRequestProperty("Authorization", "Bearer $apiKey")
            }
        } catch (e: Throwable) {
            throw transportError(e)
        }
        conn = c
        try {
            val payloadBytes = body.toString().toByteArray(Charsets.UTF_8)
            // 网关（Cloudflare）对请求体有硬上限，超了只回 403 HTML；把体积打进日志，
            // 排查「为什么这一轮突然 403」时不用猜
            log("POST ${endpoint.substringAfter("//").take(48)} ${payloadBytes.size} bytes · tools=${body.optJSONArray("tools")?.length() ?: 0}")
            c.outputStream.use { it.write(payloadBytes) }
            val code = c.responseCode
            if (code !in 200..299) {
                val err = c.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                // 有些端点不接受 reasoning_effort：去掉该字段重发一次，而不是整轮失败
                if ((code == 400 || code == 422) && body.has("reasoning_effort") &&
                    err.lowercase().contains("reasoning_effort")
                ) {
                    body.remove("reasoning_effort")
                    log("端点不接受 reasoning_effort（HTTP $code），已去掉该字段重发")
                    runCatching { c.disconnect() }
                    conn = null
                    return stream(body, onDelta, onReasoning)
                }
                throw LlmError("HTTP $code " + err.take(400), codeForHttp(code, err), code)
            }
            val text = StringBuilder()
            val think = StringBuilder()
            val calls = sortedMapOf<Int, Slot>()
            var usage = Usage(0, 0, 0)
            var finish = ""
            var rawAll = StringBuilder()
            var gotAnySse = false

            c.inputStream.bufferedReader().use { reader ->
                while (true) {
                    if (cancelled.get()) break
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    rawAll.append(line).append('\n')
                    if (!line.startsWith("data:")) continue
                    gotAnySse = true
                    val data = line.removePrefix("data:").trim()
                    if (data == "[DONE]") break
                    val obj = runCatching { JSONObject(data) }.getOrNull() ?: continue
                    obj.optJSONObject("usage")?.let { u ->
                        usage = Usage.of(u)
                    }
                    val choice = obj.optJSONArray("choices")?.optJSONObject(0) ?: continue
                    choice.optString("finish_reason").takeIf { it.isNotEmpty() }?.let { finish = it }
                    choice.optJSONObject("delta")?.let { d ->
                        // llama.cpp 等对空 delta 发 "content":null，optString 会得到字符串 "null"
                        // 有些端点把 null 序列化成字符串 "null"：isNull 检查放不过它，会原样
                        // 输出字面量 null。这里一并挡掉。
                        if (!d.isNull("reasoning_content")) {
                            d.optString("reasoning_content").takeIf { it.isNotEmpty() && it != "null" }?.let {
                                think.append(it); onReasoning(it)
                            }
                        }
                        if (!d.isNull("content")) {
                            d.optString("content").takeIf { it.isNotEmpty() && it != "null" }?.let {
                                text.append(it); onDelta(it)
                            }
                        }
                        d.optJSONArray("tool_calls")?.let { arr ->
                            for (i in 0 until arr.length()) {
                                val tc = arr.optJSONObject(i) ?: continue
                                val idx = tc.optInt("index", i)
                                val slot = calls.getOrPut(idx) { Slot() }
                                tc.optString("id").takeIf { it.isNotEmpty() }?.let { slot.id = it }
                                tc.optJSONObject("function")?.let { f ->
                                    // 名字只在第一次到达；后面 chunks 常带 `"name": null`，
                                    // 不清洗会把已经拿到的名字覆盖成 "null"（团队工具报错过）
                                    slot.name = mergeToolCallName(slot.name, f.optString("name"))
                                    f.optString("arguments").takeIf { it.isNotEmpty() }?.let { slot.args.append(it) }
                                }
                            }
                        }
                    }
                }
            }

            if (cancelled.get()) {
                throw LlmError("已停止", "ABORTED")
            }

            // 端点忽略 stream 返回整包 JSON 时兜底
            if (!gotAnySse && text.isEmpty() && calls.isEmpty()) {
                val root = runCatching { JSONObject(rawAll.toString()) }.getOrNull()
                val msg = root?.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")
                msg?.optString("content")?.takeIf { it.isNotEmpty() && it != "null" }?.let { text.append(it); onDelta(it) }
                msg?.optString("reasoning_content")?.takeIf { it.isNotEmpty() && it != "null" }?.let { think.append(it) }
                msg?.optJSONArray("tool_calls")?.let { arr ->
                    for (i in 0 until arr.length()) {
                        val tc = arr.optJSONObject(i) ?: continue
                        val slot = Slot()
                        slot.id = tc.optString("id")
                        tc.optJSONObject("function")?.let { f ->
                            slot.name = toolNameOf(f.optString("name"))
                            slot.args.append(f.optString("arguments"))
                        }
                        calls[i] = slot
                    }
                }
                root?.optJSONObject("usage")?.let { u ->
                    usage = Usage.of(u)
                }
            }

            val toolCalls = calls.map { (_, s) ->
                ToolCall(s.id.ifBlank { "call_${System.nanoTime()}" }, s.name, s.args.toString())
            }
            // 空响应（既没正文也没推理也没工具调用）是偶发传输问题，桌面把它归为可重试
            if (text.isBlank() && think.isBlank() && toolCalls.isEmpty()) {
                throw LlmError("模型返回空内容（finish=${finish.ifBlank { "none" }}）", "EMPTY_RESPONSE")
            }
            log("llm ok: text=${text.length} think=${think.length} tools=${toolCalls.size} usage=$usage")
            return Result(text.toString(), think.toString(), toolCalls, usage, finish.ifBlank { if (toolCalls.isEmpty()) "stop" else "tool_calls" })
        } catch (e: LlmError) {
            throw e
        } catch (e: Throwable) {
            // 读流中途断开、TLS 中断等：不能让原样 IOException 逃出去
            throw transportError(e)
        } finally {
            conn = null
            runCatching { c.disconnect() }
        }
    }

    /**
     * Messages 协议的一次流式请求（账号额度专用）。
     * 鉴权用 `x-dsh-auth-token`（桌面账号路由的同一个头），token 每次请求现取，
     * 换号/退登后下一次请求立刻改变，不会把旧 token 固化在配置里。
     */
    private fun streamMessages(
        openaiBody: JSONObject,
        onDelta: (String) -> Unit,
        onReasoning: (String) -> Unit,
    ): Result {
        val endpoint = MessagesApi.rootOf(baseUrl) + "/messages"
        ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed(endpoint)
        val token = accountToken?.invoke()?.takeIf { it.isNotBlank() } ?: apiKey.takeIf { it.isNotBlank() }
        if (token == null) {
            throw LlmError("这个模型走 DeepSeek 账号额度，但当前未登录", "ACCOUNT_SIGN_IN_REQUIRED")
        }
        val payload = MessagesApi.toMessagesBody(openaiBody)
        val c = try {
            (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 20_000
                readTimeout = 180_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "text/event-stream")
                setRequestProperty("anthropic-version", "2023-06-01")
                setRequestProperty("User-Agent", "deepseek-harness-mobile/0.2.1")
                setRequestProperty("x-dsh-auth-token", token)
            }
        } catch (e: Throwable) {
            throw transportError(e)
        }
        conn = c
        try {
            c.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            if (code !in 200..299) {
                val err = c.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                // 账号路由的 401 表示登录态失效（桌面：ACCOUNT_TOKEN_INVALID）
                val mapped = if (code == 401) "ACCOUNT_TOKEN_INVALID" else codeForHttp(code, err)
                throw LlmError("HTTP $code " + err.take(400), mapped, code)
            }
            val acc = MessagesApi.StreamAccumulator(onDelta, onReasoning)
            c.inputStream.bufferedReader().use { reader ->
                while (true) {
                    if (cancelled.get()) break
                    val line = reader.readLine() ?: break
                    if (line.isBlank() || line.startsWith("event:")) continue
                    if (!line.startsWith("data:")) continue
                    if (acc.accept(line.removePrefix("data:").trim())) break
                }
            }
            if (cancelled.get()) throw LlmError("已停止", "ABORTED")
            val result = acc.toResult()
            if (result.text.isBlank() && result.reasoning.isBlank() && result.toolCalls.isEmpty()) {
                throw LlmError("模型返回空内容", "EMPTY_RESPONSE")
            }
            log("llm(messages) ok: text=${result.text.length} tools=${result.toolCalls.size} usage=${result.usage}")
            return result
        } catch (e: LlmError) {
            throw e
        } catch (e: Throwable) {
            throw transportError(e)
        } finally {
            conn = null
            runCatching { c.disconnect() }
        }
    }

    /** 非流式小请求（意图复核、会话标题、记忆总结用） */
    fun complete(body: JSONObject): String {
        if (MessagesApi.isMessagesEndpoint(baseUrl)) return completeMessages(body)
        val copy = JSONObject(body.toString())
        copy.put("stream", false)
        val base = baseUrl.trim().trimEnd('/')
        val endpoint = if (base.endsWith("/chat/completions")) base else "$base/chat/completions"
        ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed(endpoint)
        val c = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 45_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            if (apiKey.isNotBlank()) setRequestProperty("Authorization", "Bearer $apiKey")
        }
        conn = c
        try {
            c.outputStream.use { it.write(copy.toString().toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            if (code !in 200..299) {
                val err = c.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                throw LlmError("HTTP $code " + err.take(300))
            }
            val raw = c.inputStream.bufferedReader().use { it.readText() }
            val root = JSONObject(raw)
            return root.optJSONArray("choices")?.optJSONObject(0)
                ?.optJSONObject("message")?.optString("content").orEmpty()
        } finally {
            conn = null
            runCatching { c.disconnect() }
        }
    }

    /** Messages 协议的非流式小请求 */
    private fun completeMessages(body: JSONObject): String {
        val endpoint = MessagesApi.rootOf(baseUrl) + "/messages"
        ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed(endpoint)
        val token = accountToken?.invoke()?.takeIf { it.isNotBlank() } ?: apiKey.takeIf { it.isNotBlank() }
        if (token == null) throw LlmError("未登录 DeepSeek 账号", "ACCOUNT_SIGN_IN_REQUIRED")
        val payload = MessagesApi.toMessagesBody(body).put("stream", false)
        val c = try {
            (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 60_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("anthropic-version", "2023-06-01")
                setRequestProperty("x-dsh-auth-token", token)
            }
        } catch (e: Throwable) {
            throw transportError(e)
        }
        conn = c
        try {
            c.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                val mapped = if (code == 401) "ACCOUNT_TOKEN_INVALID" else codeForHttp(code, raw)
                throw LlmError("HTTP $code " + raw.take(300), mapped, code)
            }
            val blocks = runCatching { JSONObject(raw).optJSONArray("content") }.getOrNull() ?: return ""
            val sb = StringBuilder()
            for (i in 0 until blocks.length()) {
                val b = blocks.optJSONObject(i) ?: continue
                if (b.optString("type") == "text") sb.append(b.optString("text"))
            }
            return sb.toString()
        } catch (e: LlmError) {
            throw e
        } catch (e: Throwable) {
            throw transportError(e)
        } finally {
            conn = null
            runCatching { c.disconnect() }
        }
    }

    companion object {
        /** 把工具定义转成 OpenAI tools 数组 */
        fun toolDefs(schemas: JSONArray, extra: List<JSONObject> = emptyList()): JSONArray = JSONArray().apply {
            for (i in 0 until schemas.length()) {
                val s = schemas.optJSONObject(i) ?: continue
                put(JSONObject().apply {
                    put("type", "function")
                    put("function", JSONObject().apply {
                        put("name", s.optString("name"))
                        put("description", s.optString("description"))
                        put("parameters", s.optJSONObject("parameters") ?: JSONObject().put("type", "object"))
                    })
                })
            }
            extra.forEach { put(it) }
        }
    }
}
