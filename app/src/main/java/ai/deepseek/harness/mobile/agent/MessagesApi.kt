package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject

/**
 * Anthropic Messages 协议桥 —— 让「账号登录」能用平台额度。
 *
 * 为什么必须有这一层：桌面 Harness 的账号路由（`@deepseek-ai/dsh-llm-deepseek-account`）
 * 不是 OpenAI 兼容的 `/chat/completions`，而是
 *
 *   POST https://api.deepseek.com/anthropic/v1/messages
 *   x-dsh-auth-token: <登录 token>
 *
 * 两者请求体、流式事件、结束原因完全不同。手机端内核内部一律用 OpenAI 形态
 * （历史、工具循环、PTC 都是这个形状），所以只在「发出去」和「读回来」两处做转换，
 * 中间的 Driver / 会话 / UI 不受影响 —— 与桌面「共用一套 Messages 传输、路由只换鉴权与目录」
 * 是同一个分层思路。
 */
object MessagesApi {

    /** 端点根：base 已带 /v1 时不重复；与桌面 messagesApiRoot 同规则 */
    fun rootOf(baseUrl: String): String {
        val base = baseUrl.trim().trimEnd('/')
        return if (base.endsWith("/v1")) base else "$base/v1"
    }

    /** 该端点是否走 Messages 协议（桌面账号路由固定 /anthropic 前缀） */
    fun isMessagesEndpoint(baseUrl: String): Boolean =
        baseUrl.trim().trimEnd('/').contains("/anthropic", ignoreCase = true)

    /**
     * OpenAI Chat 请求体 → Messages 请求体。
     * 覆盖内核实际会发的形状：system 提为顶层、assistant.tool_calls→tool_use 块、
     * role=tool→user 的 tool_result 块、多模态图片两种来源。
     */
    fun toMessagesBody(openai: JSONObject): JSONObject {
        val out = JSONObject()
        out.put("model", openai.optString("model"))
        out.put("max_tokens", openai.optInt("max_tokens", 4096).coerceAtLeast(1))
        out.put("stream", true)

        val system = StringBuilder()
        val messages = JSONArray()
        val src = openai.optJSONArray("messages") ?: JSONArray()

        // 待合并的 tool_result（Anthropic 要求同一条 user 消息里连续给出）
        val pendingToolResults = JSONArray()

        fun flushToolResults() {
            if (pendingToolResults.length() == 0) return
            messages.put(JSONObject().put("role", "user").put("content", JSONArray(pendingToolResults.toString())))
            while (pendingToolResults.length() > 0) pendingToolResults.remove(0)
        }

        for (i in 0 until src.length()) {
            val m = src.optJSONObject(i) ?: continue
            when (m.optString("role")) {
                "system" -> {
                    val t = textOf(m.opt("content"))
                    if (t.isNotBlank()) {
                        if (system.isNotEmpty()) system.append("\n\n")
                        system.append(t)
                    }
                }

                "user" -> {
                    flushToolResults()
                    messages.put(JSONObject().put("role", "user").put("content", contentBlocks(m.opt("content"))))
                }

                "assistant" -> {
                    flushToolResults()
                    val blocks = JSONArray()
                    val text = m.optString("content")
                    if (text.isNotBlank()) blocks.put(JSONObject().put("type", "text").put("text", text))
                    val calls = m.optJSONArray("tool_calls")
                    if (calls != null) {
                        for (j in 0 until calls.length()) {
                            val tc = calls.optJSONObject(j) ?: continue
                            val fn = tc.optJSONObject("function") ?: continue
                            blocks.put(JSONObject().apply {
                                put("type", "tool_use")
                                put("id", tc.optString("id").ifBlank { "call_$j" })
                                put("name", fn.optString("name"))
                                put("input", runCatching { JSONObject(fn.optString("arguments").ifBlank { "{}" }) }
                                    .getOrElse { JSONObject() })
                            })
                        }
                    }
                    // 空 assistant（只有工具调用且 content 为空）也要保留，否则 tool_result 失去配对
                    if (blocks.length() > 0) {
                        messages.put(JSONObject().put("role", "assistant").put("content", blocks))
                    }
                }

                "tool" -> {
                    pendingToolResults.put(JSONObject().apply {
                        put("type", "tool_result")
                        put("tool_use_id", m.optString("tool_call_id"))
                        put("content", m.optString("content"))
                    })
                }
            }
        }
        flushToolResults()

        if (system.isNotEmpty()) out.put("system", system.toString())
        out.put("messages", messages)

        // 思考强度：OpenAI 侧的 reasoning_effort → Messages 线格式。
        // 对齐桌面 llm-deepseek/serialize.ts 与官方文档（api-docs.deepseek.com/guides/thinking_mode）：
        //   thinking: {type: enabled/disabled} 负责开思考；
        //   output_config: {effort: low|high|max} 负责强度；
        //   off = thinking disabled，不发 output_config。
        // 官方兼容映射：minimal→low，medium/xhigh→high，ultra→max（缺省按 high，思考默认开）。
        when (openai.optString("reasoning_effort").lowercase()) {
            "off", "none" -> out.put("thinking", JSONObject().put("type", "disabled"))
            "minimal", "low", "medium", "high", "xhigh", "max", "ultra" -> {
                val effort = when (openai.optString("reasoning_effort").lowercase()) {
                    "minimal" -> "low"
                    "medium", "xhigh" -> "high"
                    "ultra" -> "max"
                    else -> openai.optString("reasoning_effort").lowercase()
                }
                out.put("thinking", JSONObject().put("type", "enabled"))
                out.put("output_config", JSONObject().put("effort", effort))
            }
            // 不带 reasoning_effort = 走端点默认（思考开启，effort high），与桌面 defaultEffort=high 一致
            else -> {
                // JS 侧「关闭思考」以 thinking 开关形式随请求体下发，直接透传
                openai.optJSONObject("thinking")?.let { out.put("thinking", it) }
            }
        }

        // tools: {type:function, function:{name,description,parameters}} → {name,description,input_schema}
        val tools = openai.optJSONArray("tools")
        if (tools != null && tools.length() > 0) {
            val converted = JSONArray()
            for (i in 0 until tools.length()) {
                val fn = tools.optJSONObject(i)?.optJSONObject("function") ?: continue
                converted.put(JSONObject().apply {
                    put("name", fn.optString("name"))
                    put("description", fn.optString("description"))
                    put("input_schema", fn.optJSONObject("parameters")
                        ?: JSONObject().put("type", "object").put("properties", JSONObject()))
                })
            }
            out.put("tools", converted)
            // OpenAI 的 tool_choice:"auto" 在 Messages 里是默认行为，不传即可
        }
        return out
    }

    /** OpenAI content（字符串或 block 数组）→ Anthropic content blocks */
    private fun contentBlocks(content: Any?): JSONArray {
        val out = JSONArray()
        when (content) {
            is String -> if (content.isNotBlank()) {
                out.put(JSONObject().put("type", "text").put("text", content))
            }

            is JSONArray -> for (i in 0 until content.length()) {
                val b = content.optJSONObject(i) ?: continue
                when (b.optString("type")) {
                    "text" -> out.put(JSONObject().put("type", "text").put("text", b.optString("text")))
                    "image_url" -> {
                        val url = b.optJSONObject("image_url")?.optString("url").orEmpty()
                        imageBlock(url)?.let { out.put(it) }
                    }

                    "input_audio" -> Unit // Messages 不收音频，静默丢弃
                }
            }

            else -> content?.let { out.put(JSONObject().put("type", "text").put("text", it.toString())) }
        }
        if (out.length() == 0) out.put(JSONObject().put("type", "text").put("text", "（空）"))
        return out
    }

    /** data:image/xxx;base64,... 与 http(s) 两种来源 */
    private fun imageBlock(url: String): JSONObject? {
        if (url.isBlank()) return null
        if (url.startsWith("data:")) {
            val comma = url.indexOf(',')
            if (comma < 0) return null
            val meta = url.substring(5, comma)              // image/png;base64
            val mediaType = meta.substringBefore(';').ifBlank { "image/png" }
            return JSONObject().apply {
                put("type", "image")
                put("source", JSONObject().apply {
                    put("type", "base64")
                    put("media_type", mediaType)
                    put("data", url.substring(comma + 1))
                })
            }
        }
        return JSONObject().apply {
            put("type", "image")
            put("source", JSONObject().put("type", "url").put("url", url))
        }
    }

    private fun textOf(v: Any?): String = when (v) {
        null, JSONObject.NULL -> ""
        is String -> v
        is JSONArray -> buildString {
            for (i in 0 until v.length()) {
                val b = v.optJSONObject(i) ?: continue
                if (b.optString("type") == "text") {
                    if (isNotEmpty()) append('\n')
                    append(b.optString("text"))
                }
            }
        }

        else -> v.toString()
    }

    /** 流式累积器：把 Messages 事件翻译成内核期望的 Result */
    class StreamAccumulator(
        private val onDelta: (String) -> Unit,
        private val onReasoning: (String) -> Unit,
    ) {
        private val text = StringBuilder()
        private val think = StringBuilder()
        private val blocks = sortedMapOf<Int, ToolSlot>()
        var promptTokens = 0
            private set
        var completionTokens = 0
            private set
        var stopReason = ""
            private set

        private class ToolSlot {
            var id = ""
            var name = ""
            val json = StringBuilder()
        }

        /**
         * 处理一条 SSE data。
         * @return true 表示流结束（message_stop）
         */
        fun accept(data: String): Boolean {
            if (data == "[DONE]") return true
            val obj = runCatching { JSONObject(data) }.getOrNull() ?: return false
            when (obj.optString("type")) {
                "message_start" -> {
                    val usage = obj.optJSONObject("message")?.optJSONObject("usage")
                    if (usage != null) {
                        promptTokens = usage.optInt("input_tokens", 0)
                        completionTokens = usage.optInt("output_tokens", 0)
                    }
                }

                "content_block_start" -> {
                    val idx = obj.optInt("index", 0)
                    val b = obj.optJSONObject("content_block") ?: return false
                    when (b.optString("type")) {
                        "tool_use" -> blocks.getOrPut(idx) { ToolSlot() }.apply {
                            id = b.optString("id")
                            // 同 LlmClient：`"name": null` 不能变成字符串 "null" 去执行
                            name = toolNameOf(b.optString("name"))
                            // 少数实现会在这里带初始 input
                            b.optJSONObject("input")?.let { j ->
                                if (j.length() > 0) json.append(j.toString())
                            }
                        }
                    }
                }

                "content_block_delta" -> {
                    val idx = obj.optInt("index", 0)
                    val d = obj.optJSONObject("delta") ?: return false
                    when (d.optString("type")) {
                        "text_delta" -> d.optString("text").takeIf { it.isNotEmpty() && it != "null" }?.let {
                            text.append(it); onDelta(it)
                        }

                        "thinking_delta" -> d.optString("thinking").takeIf { it.isNotEmpty() && it != "null" }?.let {
                            think.append(it); onReasoning(it)
                        }

                        "input_json_delta" -> d.optString("partial_json").takeIf { it.isNotEmpty() }?.let {
                            blocks.getOrPut(idx) { ToolSlot() }.json.append(it)
                        }

                        "signature_delta" -> Unit
                    }
                }

                "content_block_stop" -> {
                    // 有些网关把工具参数一次给全，靠 stop 时兜底解析
                    blocks[obj.optInt("index", 0)]?.let { s ->
                        if (s.json.isNotEmpty() && !s.json.toString().trimStart().startsWith("{")) {
                            // 不是完整 JSON：忽略，交给上层报空参数
                        }
                    }
                }

                "message_delta" -> {
                    obj.optJSONObject("delta")?.optString("stop_reason")?.takeIf { it.isNotBlank() }?.let {
                        stopReason = it
                    }
                    obj.optJSONObject("usage")?.let { u ->
                        if (u.has("output_tokens")) completionTokens = u.optInt("output_tokens")
                        if (u.has("input_tokens")) promptTokens = u.optInt("input_tokens")
                    }
                }

                "message_stop" -> return true
                "error" -> {
                    val e = obj.optJSONObject("error")
                    throw LlmClient.LlmError(
                        e?.optString("message")?.ifBlank { "空响应" } ?: "流式错误",
                        if (e?.optString("type") == "rate_limit_error") "RATE_LIMIT" else "SERVER",
                        0,
                    )
                }
            }
            return false
        }

        fun toResult(): LlmClient.Result {
            val calls = blocks.values.filter { it.name.isNotBlank() }.map { s ->
                LlmClient.ToolCall(
                    s.id.ifBlank { "call_${System.nanoTime()}" },
                    s.name,
                    s.json.toString().ifBlank { "{}" },
                )
            }
            val finish = when (stopReason) {
                "tool_use" -> "tool_calls"
                "max_tokens" -> "length"
                else -> if (calls.isEmpty()) "stop" else "tool_calls"
            }
            return LlmClient.Result(
                text = text.toString(),
                reasoning = think.toString(),
                toolCalls = calls,
                usage = LlmClient.Usage(promptTokens, completionTokens, promptTokens + completionTokens),
                finishReason = finish,
            )
        }
    }
}
