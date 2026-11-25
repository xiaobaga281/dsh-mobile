package ai.deepseek.harness.mobile.bridge

import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * 智能体域：内核驱动的会话生命周期、流式回复、会话摘要与待办。
 */
class AgentBridge(private val core: BridgeCore) {

    private val activity get() = core.activity
    private fun emitRaw(js: String) = core.raw(js)
    private fun emit(fn: String, id: String, payload: String) = core.emit(fn, id, payload)

    private val streams get() = core.streams
    private val auth get() = core.auth

    /* ---------------- 原生 Agent 内核 ----------------
     * 前端只负责「发一句话 + 渲染事件」，循环、工具、压缩、计划评审全在 Kotlin 侧。
     * 这样即使 WebView 被系统降频或页面重载，正在跑的这一轮也不会中断。
     */
    private val drivers = java.util.concurrent.ConcurrentHashMap<String, ai.deepseek.harness.mobile.agent.AgentDriver>()

    /** 轮次 id → 会话 id：页面重载后前端靠它找回正在跑的轮（见 agentActive） */
    private val roundSession = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** 每个 driver 一份流聚合器（见 [StreamCoalescer]），随 driver 生命周期增删 */
    private val coalescers = java.util.concurrent.ConcurrentHashMap<String, StreamCoalescer>()

    /** 内核侧兜底提醒：只在「需要用户动手」的三类事件上触发 */
    private fun notifyIfNeeded(sessionId: String, ev: JSONObject) {
        // requestKey 与下面几个 agentXxx 接口里算的必须一致 —— 用户处理完时靠它把通知收掉
        val pair = when (ev.optString("t")) {
            "approval_request" -> "需要你确认" to ev.optString("reason").ifBlank { ev.optString("name") }
            "ask_request" -> "助手在等你回答" to ev.optString("question")
            "plan_request" -> "计划待批准" to ev.optString("title")
            else -> return
        }
        val key = when (ev.optString("t")) {
            "approval_request" -> "approval|" + ev.optString("id")
            "ask_request" -> "ask|" + ev.optString("id")
            // 计划评审事件没有稳定 id，同一会话同时只有一个，用会话当键
            else -> "plan|" + sessionId
        }
        runCatching {
            ai.deepseek.harness.mobile.notify.RunService.attention(
                activity.applicationContext, pair.first, pair.second, sessionId, key
            )
        }
    }

    /**
     * 正在运行的轮次：`{runs:[{id, sessionId, text, reasoning, truncated}], id, sessionId}`。
     *
     * 为什么前端需要它：WebView 渲染进程在内存压力下可能被系统回收并自动重载
     * （模拟器实测两次，真机低内存更常见）。内核轮次在**原生侧**继续跑，
     * 但重载后的页面 Live.id 已丢，onAgent 事件全部被丢弃 —— 用户看到的就是
     * 「流式卡住不动」。页面就绪时查一次这个接口，能跑就重新认领轮次，
     * 之后的 delta/reasoning 事件继续渲染，回复不再凭空消失。
     *
     * 为什么要带 `text` / `reasoning`：只认领 id 的话，页面重载后气泡是**空的** ——
     * 已经流出去的那几百字在内存里，重载的页面拿不到，看起来仍像「回复被截断了」。
     * 快照来自合帧器（它才是「页面见过什么」的真值来源），灌回同一条摄入通道即可接上。
     *
     * 为什么列全部而不是只给第一条：团队/多会话并行时，用户正在看的那一场
     * 未必是 map 里第一个 key —— 挑错了就等于把用户从他的会话里拽走。
     */
    @JavascriptInterface
    fun agentActive(): String {
        val runs = JSONArray()
        for (id in drivers.keys) {
            val snap = runCatching { coalescers[id]?.snapshot() ?: JSONObject() }.getOrNull() ?: JSONObject()
            runs.put(JSONObject().put("id", id).put("sessionId", roundSession[id] ?: "")
                .put("text", snap.optString("delta"))
                .put("reasoning", snap.optString("reasoning"))
                // 带顺序的全量（含 tool_start/tool_end）：页面按它回放，过程组才不缺行
                .put("segments", snap.optJSONArray("segments") ?: JSONArray())
                .put("truncated", snap.optBoolean("truncated")))
        }
        val first = runs.optJSONObject(0) ?: JSONObject()
        return JSONObject()
            .put("id", first.optString("id"))
            .put("sessionId", first.optString("sessionId"))
            .put("runs", runs)
            .toString()
    }

    /**
     * 这个会话最近一条助手回复的正文（从内核会话日志派生）。
     *
     * 用在哪：看队友会话 / 别的视图时，Lead 这一轮跑完了 —— 页面当时没在渲染，
     * onDone 被丢弃，回到会话时只能看到最后一次快照（可能差几秒，也没有收尾行）。
     * 回到会话时用它把最后那段补上，而不是停在半截。没有日志/没有回复时 ok=false。
     */
    @JavascriptInterface
    fun sessionLastReply(sid: String): String = runCatching {
        val msgs = activity.kernel.sessions.deriveMessages(sid, 12)
        val last = msgs.lastOrNull { it.optString("role") == "assistant" }
        val text = last?.optString("content")?.takeIf { it.isNotBlank() } ?: ""
        JSONObject().put("ok", text.isNotEmpty()).put("text", text).toString()
    }.getOrElse {
        JSONObject().put("ok", false).put("text", "").toString()
    }

    /**
     * 这一场**最后一轮**的有序回放段（由会话日志派生），形状与 [agentActive] 的 `segments`
     * 一致：`{t: "reasoning" | "delta" | "tool_start" | "tool_end", …}`，另带 `text` /
     * `steps` / `tokens` 供收尾行用。
     *
     * 用在哪：用户切去看队友（或别的会话）时页面不渲染这一场，事件被丢弃、`onDone` 收不到，
     * 而内核这一轮照样跑完并落库。回到这一场时页面要的不是「一段正文尾巴」，而是**这一轮的
     * 原样** —— 过程组与工具行都得回来，否则屏幕上比实际发生的少一格（用户报的「形状变粗」）。
     * 与桌面端一致：会话日志是权威，重开一场就走日志重放。
     *
     * 这一场没有可重放的轮次（空会话 / 旧日志）时 `ok=false`，调用方回落到只补正文。
     */
    @JavascriptInterface
    fun sessionRoundTrace(sid: String): String = runCatching {
        activity.kernel.sessions.roundTrace(sid).toString()
    }.getOrElse {
        JSONObject().put("ok", false).put("segments", JSONArray())
            .put("error", it.message ?: "日志读取失败").toString()
    }

    @JavascriptInterface
    fun agentStart(id: String, cfgJson: String) {
        Thread {
            // delta/reasoning 先进聚合器（对齐桌面渲染侧合帧纪律，见 StreamCoalescer）；
            // 其余事件先冲刷再直发 —— 工具、审批、错误的顺序与延迟和内核完全一致。
            // 每个事件都带上 sessionId：前端据此丢弃「不属于当前正在看的会话」的到达事件，
            // 否则用户切走后 A 的正文/思考会继续写进 B（会话串号）。
            val coalescer = StreamCoalescer { type, text ->
                // 工具实时输出的通道名带调用 id（见 StreamCoalescer.OUTPUT_PREFIX）：
                // 合帧要按 id 各排一段，出桥时再拆回事件字段。两条都要带 sessionId，
                // 否则前端判不了归属，会把 A 的输出画进用户当时正在看的 B。
                val outId = type.startsWith(StreamCoalescer.OUTPUT_PREFIX)
                val payload = if (outId) JSONObject().put("t", "tool_output")
                    .put("id", type.substring(StreamCoalescer.OUTPUT_PREFIX.length)).put("text", text)
                else JSONObject().put("t", type).put("text", text)
                core.emitObject("onAgent", id,
                    payload.put("sessionId", roundSession[id] ?: ""))
            }
            coalescers[id] = coalescer
            val driver = activity.kernel.driver { ev ->
                // 权限/追问/计划请求不能只靠 WebView 里的 JS 提醒：页面在后台会被降频，
                // 拿不到回调就等于「对话卡在那里没人管」，最后 90 秒超时被自动拒绝。
                // 这里在内核事件出口直接兜一层系统通知，前端那条提醒只作为前台补充。
                notifyIfNeeded(id, ev)
                when (ev.optString("t")) {
                    "delta" -> coalescer.feed("delta", ev.optString("text"))
                    "reasoning" -> coalescer.feed("reasoning", ev.optString("text"))
                    // 工具实时输出也进合帧器：一次读 8KB，直发就是每秒几百次 evaluateJavascript
                    "tool_output" -> coalescer.feedOutput(ev.optString("id"), ev.optString("text"))
                    else -> {
                        coalescer.flushAll()
                        // 内核事件原样透传，但补上会话身份（拷贝一份，别污染内核的 JSON）
                        val out = JSONObject(ev.toString())
                        if (!out.has("sessionId")) out.put("sessionId", roundSession[id] ?: "")
                        // 直发的事件同样要记进回放日志：只攒文本的话，页面重载后
                        // 「已经跑过的工具行」就凭空消失（用户实测点名）
                        coalescer.remember(out)
                        core.emitObject("onAgent", id, out)
                    }
                }
            }
            drivers[id] = driver
            try {
                val cfg = ai.deepseek.harness.mobile.agent.AgentConfig.parse(JSONObject(cfgJson))
                roundSession[id] = cfg.sessionId
                driver.run(id, cfg)
            } catch (t: Throwable) {
                coalescer.flushAll()
                core.emitObject(
                    "onAgent", id,
                    JSONObject().put("t", "error").put("message", t.message ?: "内核异常")
                        .put("sessionId", roundSession[id] ?: "")
                )
            } finally {
                drivers.remove(id)
                // 这轮没了：等待中的审批/追问/计划评审都不会再有人答，提醒要一起撤
                clearRoundAttention(id)
                // 先冲刷残留再清会话映射：反过来的话最后一批 delta 的事件缺少
                // sessionId，前端判定不了归属，可能被画进用户当时正在看的另一个会话
                coalescers.remove(id)?.flushAll()
                roundSession.remove(id)
            }
        }.apply { name = "dsh-agent-$id" }.start()
    }

    @JavascriptInterface
    fun agentCancel(id: String) {
        clearRoundAttention(id)
        drivers[id]?.cancel()
        runCatching { streams.remove(id)?.disconnect() }
    }

    /**
     * 用户已经在应用内处理掉一个请求：把对应的「需要你确认」通知收掉。
     * 通知 id 是固定的，`setAutoCancel` 只在点通知时生效 —— 不主动收就会一直挂着
     * （用户实测：应用内点了同意/拒绝，通知栏那条还在）。key 与 [notifyIfNeeded] 一致。
     */
    private fun clearAttention(requestKey: String) {
        runCatching {
            ai.deepseek.harness.mobile.notify.RunService.resolveAttention(
                activity.applicationContext, requestKey
            )
        }
    }

    /** 一轮没了（结束/被取消）：该会话所有待处理请求都失效，通知一并收掉 */
    private fun clearRoundAttention(id: String) {
        val sid = roundSession[id] ?: return
        if (sid.isBlank()) return
        runCatching {
            ai.deepseek.harness.mobile.notify.RunService.clearSessionAttention(
                activity.applicationContext, sid
            )
        }
    }

    @JavascriptInterface
    fun agentPlanDecision(id: String, approved: Boolean, feedback: String) {
        clearAttention("plan|" + (roundSession[id] ?: ""))
        drivers[id]?.decidePlan(approved, feedback)
    }

    @JavascriptInterface
    fun agentApprove(id: String, approvalId: String, allowed: Boolean) {
        clearAttention("approval|$approvalId")
        drivers[id]?.decideApproval(approvalId, allowed)
    }

    /**
     * 带档位的确认回传：scope = once / always / deny。
     * 「始终允许」记会话级授权，同会话同名工具后续直接放行（见 AgentDriver）。
     */
    @JavascriptInterface
    fun agentApproveScope(id: String, approvalId: String, scope: String) {
        clearAttention("approval|$approvalId")
        val s = (scope ?: "").trim().lowercase()
        drivers[id]?.decideApprovalScope(approvalId, s != "deny", s == "always")
    }

    /** 设置页切换权限档位时热更新运行中的轮次（完全访问立即生效） */
    @JavascriptInterface
    fun agentPermission(id: String, permission: String) {
        drivers[id]?.updatePermission(permission)
    }

    /** ask_user_question 的回答：回传选项 label */
    @JavascriptInterface
    fun agentAnswer(id: String, askId: String, label: String) {
        clearAttention("ask|$askId")
        drivers[id]?.answer(askId, label)
    }

    @JavascriptInterface
    fun abortChat(id: String) {
        runCatching { streams.remove(id)?.disconnect() }
    }

    /**
     * 独立的模型调用：OpenAI 兼容 /chat/completions，SSE 流式。
     * 增量通过 window.DSHHost.onDelta / onReasoning 回传，结束 onDone，异常 onError。
     */
    @JavascriptInterface
    fun chatStream(id: String, baseUrl: String, apiKey: String, bodyJson: String) {
        // 账号端点（api.deepseek.com/anthropic）走 Messages 协议 + 登录态鉴权，
        // 与内核路径同一套转换，避免「聊天能看不能用」的两套实现漂移
        if (ai.deepseek.harness.mobile.agent.MessagesApi.isMessagesEndpoint(baseUrl)) {
            chatStreamMessages(id, baseUrl, apiKey, bodyJson)
            return
        }
        Thread {
            var conn: java.net.HttpURLConnection? = null
            // 节拍器必须无条件收掉（异常/断流都会走到 finally），否则线程一直空转 emit
            var flushGuard: ai.deepseek.harness.mobile.agent.StreamFlusher? = null
            try {
                val base = baseUrl.trim().trimEnd('/')
                val endpoint = if (base.endsWith("/chat/completions")) base else "$base/chat/completions"
                val c = (java.net.URL(endpoint).openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 20000
                    readTimeout = 180000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("Accept", "text/event-stream")
                    if (apiKey.isNotBlank()) setRequestProperty("Authorization", "Bearer $apiKey")
                }
                conn = c
                streams[id] = c
                c.outputStream.use { it.write(bodyJson.toByteArray(Charsets.UTF_8)) }

                val code = c.responseCode
                if (code !in 200..299) {
                    val err = c.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                    emit(
                        "onError", id,
                        JSONObject().put("message", "HTTP $code " + err.take(400)).toString(),
                    )
                    return@Thread
                }

                val reader = c.inputStream.bufferedReader()
                val usage = JSONObject()
                val toolAcc = sortedMapOf<Int, ToolCallSlot>()
                val raw = StringBuilder()
                var produced = false
                // 合批统一走 StreamFlusher（40ms 节拍 + 64 字阈值）：原先的 flush 只在
                // 「下一条 chunk 到达」时被调用，chunk 一停顿字就压在缓冲里，观感是
                // 「在出字却不动」。它与内核轮次、Messages 流共用同一份规则。
                val flusher = ai.deepseek.harness.mobile.agent.StreamFlusher(
                    onText = { t ->
                        emitRaw(
                            "window.DSHHost&&window.DSHHost.onDelta&&window.DSHHost.onDelta(" +
                                JSONObject.quote(id) + "," + JSONObject.quote(t) + ")"
                        )
                    },
                    onThink = { t ->
                        emitRaw(
                            "window.DSHHost&&window.DSHHost.onReasoning&&window.DSHHost.onReasoning(" +
                                JSONObject.quote(id) + "," + JSONObject.quote(t) + ")"
                        )
                    },
                )
                flushGuard = flusher

                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    raw.append(line).append('\n')
                    if (!line.startsWith("data:")) continue
                    val data = line.removePrefix("data:").trim()
                    if (data == "[DONE]") break
                    val obj = runCatching { JSONObject(data) }.getOrNull() ?: continue
                    obj.optJSONObject("usage")?.let { u ->
                        usage.put("prompt", u.optInt("prompt_tokens"))
                        usage.put("completion", u.optInt("completion_tokens"))
                        usage.put("total", u.optInt("total_tokens"))
                        usage.put("cached", u.optJSONObject("prompt_tokens_details")?.optInt("cached_tokens")
                            ?: u.optInt("prompt_cache_hit_tokens"))
                    }
                    val choice = obj.optJSONArray("choices")?.optJSONObject(0) ?: continue
                    choice.optJSONObject("delta")?.let { d ->
                        // 注意：llama.cpp 等实现会对空 delta 发 "content":null，
                        // org.json 的 optString 会把 JSON null 变成字符串 "null"，必须先排掉
                        if (!d.isNull("reasoning_content")) {
                            d.optString("reasoning_content").takeIf { it.isNotEmpty() }?.let { flusher.pushThink(it) }
                        }
                        if (!d.isNull("content")) {
                            d.optString("content").takeIf { it.isNotEmpty() }?.let {
                                produced = true
                                flusher.pushText(it)
                            }
                        }
                        // 工具调用：按 index 累积分片的 name / arguments
                        d.optJSONArray("tool_calls")?.let { arr ->
                            for (i in 0 until arr.length()) {
                                val tc = arr.optJSONObject(i) ?: continue
                                val idx = tc.optInt("index", i)
                                val slot = toolAcc.getOrPut(idx) { ToolCallSlot() }
                                tc.optString("id").takeIf { it.isNotEmpty() }?.let { slot.id = it }
                                tc.optJSONObject("function")?.let { f ->
                                    // 同 LlmClient：后续 chunk 的 `"name": null` 不能覆盖已拿到的名字
                                    slot.name = ai.deepseek.harness.mobile.agent.mergeToolCallName(
                                        slot.name, f.optString("name"))
                                    f.optString("arguments").takeIf { it.isNotEmpty() }?.let { slot.args.append(it) }
                                }
                                produced = true
                            }
                        }
                    }
                }
                flusher.finish()

                if (toolAcc.isNotEmpty()) {
                    val arr = org.json.JSONArray()
                    toolAcc.toSortedMap().forEach { (_, s) ->
                        arr.put(JSONObject().apply {
                            put("id", s.id.ifEmpty { "call_${System.nanoTime()}" })
                            put("name", s.name)
                            put("arguments", s.args.toString())
                        })
                    }
                    emitRaw(
                        "window.DSHHost&&window.DSHHost.onToolCalls&&window.DSHHost.onToolCalls(" +
                            JSONObject.quote(id) + "," + JSONObject.quote(arr.toString()) + ")"
                    )
                }

                // 端点忽略 stream 返回整包 JSON 时兜底
                if (!produced) {
                    val root = runCatching { JSONObject(raw.toString()) }.getOrNull()
                    val msg = root?.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")
                    val content = if (msg == null || msg.isNull("content")) "" else msg.optString("content")
                    if (content.isNotEmpty()) {
                        emitRaw(
                            "window.DSHHost&&window.DSHHost.onDelta&&window.DSHHost.onDelta(" +
                                JSONObject.quote(id) + "," + JSONObject.quote(content) + ")"
                        )
                    }
                    root?.optJSONObject("usage")?.let { u ->
                        usage.put("prompt", u.optInt("prompt_tokens"))
                        usage.put("completion", u.optInt("completion_tokens"))
                        usage.put("total", u.optInt("total_tokens"))
                        usage.put("cached", u.optJSONObject("prompt_tokens_details")?.optInt("cached_tokens")
                            ?: u.optInt("prompt_cache_hit_tokens"))
                    }
                }
                emit("onDone", id, usage.toString())
            } catch (t: Throwable) {
                emit("onError", id, JSONObject().put("message", t.message ?: "连接中断").toString())
            } finally {
                flushGuard?.close()
                streams.remove(id)
                runCatching { conn?.disconnect() }
            }
        }.start()
    }

    /** Messages 协议的流式聊天（账号额度） */
    private fun chatStreamMessages(id: String, baseUrl: String, apiKey: String, bodyJson: String) {
        Thread {
            var conn: java.net.HttpURLConnection? = null
            var flushGuard: ai.deepseek.harness.mobile.agent.StreamFlusher? = null
            try {
                val token = auth.token()?.takeIf { it.isNotBlank() } ?: apiKey.takeIf { it.isNotBlank() }
                if (token == null) {
                    emit("onError", id, JSONObject().put("message",
                        "这个模型使用 DeepSeek 账号额度，当前未登录。请到设置 → 账号里登录，或改用带 API Key 的模型。").toString())
                    return@Thread
                }
                val payload = ai.deepseek.harness.mobile.agent.MessagesApi
                    .toMessagesBody(JSONObject(bodyJson))
                val endpoint = ai.deepseek.harness.mobile.agent.MessagesApi.rootOf(baseUrl) + "/messages"
                val c = (java.net.URL(endpoint).openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 20000
                    readTimeout = 180000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("Accept", "text/event-stream")
                    setRequestProperty("anthropic-version", "2023-06-01")
                    setRequestProperty("User-Agent", "deepseek-harness-mobile/0.2.1")
                    setRequestProperty("x-dsh-auth-token", token)
                }
                conn = c
                streams[id] = c
                c.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }

                val code = c.responseCode
                if (code !in 200..299) {
                    val err = c.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                    val msg = when (code) {
                        401 -> "登录已失效，请重新登录 DeepSeek 账号（HTTP 401）"
                        402 -> "账号额度不足，请充值或改用 API Key 模型（HTTP 402）"
                        429 -> "请求过于频繁，稍后重试（HTTP 429）"
                        else -> "HTTP $code ${err.take(300)}"
                    }
                    emit("onError", id, JSONObject().put("message", msg).toString())
                    return@Thread
                }

                // 同一份合批规则（见 StreamFlusher）：节拍兜底，不靠「下一块到达」触发
                val flusher = ai.deepseek.harness.mobile.agent.StreamFlusher(
                    onText = { t ->
                        emitRaw(
                            "window.DSHHost&&window.DSHHost.onDelta&&window.DSHHost.onDelta(" +
                                JSONObject.quote(id) + "," + JSONObject.quote(t) + ")"
                        )
                    },
                    onThink = { t ->
                        emitRaw(
                            "window.DSHHost&&window.DSHHost.onReasoning&&window.DSHHost.onReasoning(" +
                                JSONObject.quote(id) + "," + JSONObject.quote(t) + ")"
                        )
                    },
                )
                flushGuard = flusher
                val acc = run {
                    Pair(
                        ai.deepseek.harness.mobile.agent.MessagesApi.StreamAccumulator(
                            onDelta = { t -> flusher.pushText(t) },
                            onReasoning = { t -> flusher.pushThink(t) },
                        ),
                        { flusher.finish() },
                    )
                }
                c.inputStream.bufferedReader().use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isBlank() || line.startsWith("event:")) continue
                        if (!line.startsWith("data:")) continue
                        if (acc.first.accept(line.removePrefix("data:").trim())) break
                    }
                }
                acc.second.invoke()          // 余量强制冲出去（toResult 归档前必须已发给前端）

                val result = acc.first.toResult()
                if (result.toolCalls.isNotEmpty()) {
                    val arr = org.json.JSONArray()
                    result.toolCalls.forEach { tc ->
                        arr.put(JSONObject().apply {
                            put("id", tc.id); put("name", tc.name); put("arguments", tc.args)
                        })
                    }
                    emitRaw(
                        "window.DSHHost&&window.DSHHost.onToolCalls&&window.DSHHost.onToolCalls(" +
                            JSONObject.quote(id) + "," + JSONObject.quote(arr.toString()) + ")"
                    )
                }
                emit("onDone", id, JSONObject().apply {
                    put("prompt", result.usage.prompt)
                    put("completion", result.usage.completion)
                    put("total", result.usage.total)
                }.toString())
            } catch (t: Throwable) {
                emit("onError", id, JSONObject()
                    .put("message", t.message ?: "连接中断").toString())
            } finally {
                flushGuard?.close()
                streams.remove(id)
                runCatching { conn?.disconnect() }
            }
        }.start()
    }
}

/** 流式 tool_calls 的累积槽（同一 index 的多个分片拼到一起） */
private class ToolCallSlot {
    var id: String = ""
    var name: String = ""
    val args = StringBuilder()
}
