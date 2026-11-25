package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.MainActivity
import ai.deepseek.harness.mobile.account.DeepSeekAuth
import ai.deepseek.harness.mobile.agent.MessagesApi
import ai.deepseek.harness.mobile.notify.RunService
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.random.Random

/**
 * 陪伴式畅聊的**生成侧**：不依赖 WebView 的「该不该说 → 问模型 → 落库/通知」。
 *
 * ## 为什么需要它
 *
 * 在此之前，心跳由 [CompanionPlugin] 发，但「判断 → 问模型 → 落地」整条链路在 JS 里。
 * 于是只要界面不在（退到后台被冻结、进程被划掉、甚至只是 Activity 被回收），
 * 消息就永远发不出来 —— 用户的原话是「不像微信，微信不在后台也能弹通知」。
 *
 * 现在这一层把生成搬到了原生前台服务里：
 *
 * ```
 *  CompanionKeepService（前台服务，进程活着就在跑）
 *        └─ 每 60s 一次 tick ──> CompanionEngine
 *                                   ├─ 读 companion.json（开关/档位/免打扰/上限/线索）
 *                                   ├─ 读 companion-model.json（端点、Key、system、nudge、最近对话）
 *                                   ├─ 调模型（非流式，一句话）
 *                                   ├─ 写 companion-outbox.json（前端下次可见时补进对话）
 *                                   └─ 发系统通知（应用可见时静默，交给前端直接渲染）
 * ```
 *
 * ## 分层（和插件一起看）
 *
 * | 谁 | 负责什么 |
 * |---|---|
 * | [CompanionPlugin] | 给模型的工具、设置面板的状态展示、promptSection |
 * | [CompanionKeepService] | 进程存活 + 定时驱动本引擎 |
 * | 本文件 | 到点判断、模型调用、通知、待投递队列 |
 * | `app.js` 的 `Companion` | **措辞**（system / nudge 模板）、把消息渲染进会话 |
 *
 * 纪律：规则与时机在 Kotlin，措辞在 JS。引擎只做占位符替换（`{hh}` `{since}` `{count}` …），
 * 不自己写话术 —— 唯一的例外是 JS 从未下发过配置时的兜底句（见 [FALLBACK_NUDGE]）。
 */
object CompanionEngine {

    /** 同一时刻只跑一轮：网络慢的时候心跳会叠上来，绝不能让两条「主动消息」并发 */
    private val worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "dsh-companion").apply { isDaemon = true }
    }

    @Volatile
    private var inFlight = false

    /** 开口失败后的退避：不消耗整窗口，也不每分钟砸一次 */
    private const val RETRY_MS = 3 * 60_000L

    /** 用户在说话后的静默期：他还在场，不用主动找 */
    private const val QUIET_AFTER_USER_MS = 5 * 60_000L

    private const val OUTBOX_MAX = 20
    private const val OUTBOX_TTL_MS = 24 * 60 * 60 * 1000L
    private const val TEXT_MAX = 300

    /** JS 没下发过 nudge 时的兜底（正常路径不会用到） */
    private const val FALLBACK_NUDGE = "（内部提示：现在 {hh}，距他上次说话 {since} 分钟。）有值得说的就说一两句；没有就回 SILENT。"

    /* ---------------- 应用内兜底心跳 ---------------- */

    /**
     * 应用内兜底心跳。
     *
     * 正常路径是 [CompanionKeepService] 每 60s 驱动一次；但前台服务可能根本起不来：
     * 清单类名写错（真实发生过，占位符版本哑了整整一版）、厂商把 FGS 掐掉、
     * 用户关了通知权限、Android 14+ 的 FGS 类型校验不过。这些情况下如果什么都不做，
     * 用户看到的就是「开了跟没开一样」—— 而且没有任何错误提示。
     *
     * 所以这里再挂一条应用内心跳：**只有当服务不在跑时才 tick**，不会双倍；
     * 引擎自身还有 inFlight 与 nextDueAt 两道闸，重复调用只是无害空转。
     * 进程活着界面上就能照常开口，后台仍以前台服务为准。
     */
    private const val INAPP_TICK_MS = 60_000L
    // by lazy 而不是直接初始化：这段在 `object` 的静态初始化里，JVM 单测（没有 Looper）
    // 只要碰到本类的任何成员就会 ExceptionInInitializerError，整份 CompanionEngineTest 全红
    // —— 门禁一红就没人看，等于没有。真正要用 Handler 的只有 startInAppBeat。
    private val beatHandler by lazy { android.os.Handler(android.os.Looper.getMainLooper()) }

    @Volatile
    private var beatOn = false

    @Synchronized
    fun startInAppBeat(ctx: Context) {
        if (beatOn) return
        beatOn = true
        val app = ctx.applicationContext
        val step = object : Runnable {
            override fun run() {
                if (!beatOn) return
                if (!CompanionKeepService.running()) tick(app, "inapp")
                beatHandler.postDelayed(this, INAPP_TICK_MS)
            }
        }
        beatHandler.post(step)
    }

    @Synchronized
    fun stopInAppBeat() {
        beatOn = false
        beatHandler.removeCallbacksAndMessages(null)
    }

    /* ---------------- 文件位置（与 ToolKernel.configDir 同一处） ---------------- */

    fun configDir(ctx: Context): File = File(ctx.filesDir, "kernel")
    fun stateFile(ctx: Context): File = File(configDir(ctx), "companion.json")
    fun modelFile(ctx: Context): File = File(configDir(ctx), "companion-model.json")
    fun outboxFile(ctx: Context): File = File(configDir(ctx), "companion-outbox.json")

    /**
     * 请求一轮。异步、可重入安全的空转（inFlight 时直接返回）。
     * @param reason 只用于诊断：`loop`（60s 心跳）/ `poke`（Doze 闹钟）/ `start`（服务起来时补一拍）
     */
    fun tick(ctx: Context, reason: String = "loop") {
        if (inFlight) return
        inFlight = true
        val app = ctx.applicationContext
        worker.execute {
            try {
                run(app, reason)
            } catch (t: Throwable) {
                // 引擎自身异常绝不能拖垮前台服务
                record(app, JSONObject(), "引擎异常：" + (t.message ?: t.javaClass.simpleName))
            } finally {
                inFlight = false
            }
        }
    }

    /* ---------------- 一轮的判定 ---------------- */

    private fun run(ctx: Context, reason: String) {
        val st = read(stateFile(ctx)) ?: return
        if (!st.optBoolean("enabled", false)) return
        // 用户正在跟 Agent 对话：这条链路会抢同一份注意力，且模型也忙
        if (MainActivity.sessionRunning) return

        val now = System.currentTimeMillis()
        val cadence = st.optString("cadence", "normal")
        val day = dayKey()
        val count = if (st.optString("day", "") == day) st.optInt("countToday", 0) else 0
        val cap = CompanionPlugin.cap(cadence)

        // 这两种「不说话」要写进状态：设置面板的「上次跳过」直接显示它，
        // 否则用户只会看到一条过期的原因（比如明明在免打扰，却显示「它选择沉默」）
        if (inQuietHours(st.optInt("quietStart", 23), st.optInt("quietEnd", 8))) {
            record(ctx, st, "免打扰时段")
            return
        }
        if (count >= cap) {
            record(ctx, st, "今天说得够多了（$count/$cap）")
            return
        }
        // 窗口是上一轮真正问模型之前抽的；换了档位就立刻重算一次机会
        if (st.optString("dueCadence", cadence) == cadence) {
            val due = st.optLong("nextDueAt", 0)
            if (due > 0 && now < due) return
        }
        val lastUser = st.optLong("lastUserAt", 0)
        if (lastUser > 0 && now - lastUser < QUIET_AFTER_USER_MS) return

        val m = read(modelFile(ctx))
        if (m == null || m.optString("url").isBlank()) {
            record(ctx, st, "模型未配置（先在设置里选一个模型）")
            return
        }

        val streak = st.optInt("silentStreak", 0)
        val out = ask(ctx, m, st, cadence, count, cap, streak)

        when {
            out.error != null -> {
                // 不算用掉机会：退避 3 分钟再试，并把原因写进状态（设置面板能直接看到）
                st.put("lastSkip", "开口失败：" + out.error.take(80))
                st.put("lastBeatAt", now)
                st.put("nextDueAt", now + RETRY_MS)
                st.put("dueCadence", cadence)
                write(ctx, st)
            }

            out.silent -> {
                st.put("silentStreak", streak + 1)
                st.put("lastSkip", "它选择这次不说话（连续 ${streak + 1} 次）")
                st.put("lastBeatAt", now)
                st.put("nextDueAt", now + gapMs(cadence))
                st.put("dueCadence", cadence)
                write(ctx, st)
            }

            else -> deliver(ctx, st, out.text!!, cadence, count)
        }
    }

    private fun deliver(ctx: Context, st: JSONObject, text: String, cadence: String, count: Int) {
        val now = System.currentTimeMillis()
        // 1) 先落盘：界面不在时这就是唯一凭据，下次打开会补进对话
        pushOutbox(ctx, text, now)
        // 2) 再通知：应用可见时它会自己静默（前端会把这条渲染进会话）
        val shown = RunService.companionSay(ctx, text)
        // 3) 记账
        st.put("lastSpokeAt", now)
        st.put("day", dayKey())
        st.put("countToday", count + 1)
        st.put("spokeTotal", st.optInt("spokeTotal", 0) + 1)
        // 通知发不出去 = 用户在后台根本看不见这句。别让它悄无声息：
        // 消息已经落进 outbox（下次打开会补进对话），但当下必须把原因摆到面板上。
        if (!shown) {
            st.put("lastWarn", "这句已经说出口，但通知没送到：系统通知权限被关（设置 → 权限 → 通知）")
        } else {
            st.remove("lastWarn")
        }
        st.put("silentStreak", 0)
        st.put("lastSkip", "")
        st.put("lastBeatAt", now)
        st.put("nextDueAt", now + gapMs(cadence))
        st.put("dueCadence", cadence)
        write(ctx, st)
    }

    /* ---------------- 模型调用 ---------------- */

    private class Outcome(val text: String? = null, val silent: Boolean = false, val error: String? = null)

    private fun ask(
        ctx: Context,
        m: JSONObject,
        st: JSONObject,
        cadence: String,
        count: Int,
        cap: Int,
        streak: Int,
    ): Outcome {
        val url = m.optString("url").trim()
        val key = m.optString("key").trim()
        val model = m.optString("model").trim().ifBlank { "deepseek-chat" }
        val messages = buildMessages(m, st, cadence, count, cap, streak)
        val maxTokens = m.optInt("maxTokens", 220).coerceIn(32, 1024)

        val messagesApi = MessagesApi.isMessagesEndpoint(url)
        val token = if (messagesApi) {
            // 账号额度：token 只在原生侧，JS 拿不到，所以这里自己取
            DeepSeekAuth(ctx).token()?.takeIf { it.isNotBlank() } ?: key.takeIf { it.isNotBlank() }
        } else {
            null
        }
        if (messagesApi && token == null) {
            return Outcome(error = "这个模型走 DeepSeek 账号额度，但当前未登录。请到设置 → 账号登录，或改用带 API Key 的模型")
        }

        val endpoint = if (messagesApi) {
            MessagesApi.rootOf(url) + "/messages"
        } else {
            val base = url.trimEnd('/')
            if (base.endsWith("/chat/completions")) base else "$base/chat/completions"
        }

        val body = if (messagesApi) {
            // Messages 协议：system 提为顶层，其余保持 user/assistant 纯文本（一句话场景足够）
            JSONObject().apply {
                put("model", model)
                put("max_tokens", maxTokens)
                put("stream", false)
                val sys = StringBuilder()
                val list = JSONArray()
                for (i in 0 until messages.length()) {
                    val o = messages.optJSONObject(i) ?: continue
                    val role = o.optString("role")
                    val content = o.optString("content")
                    if (role == "system") {
                        if (sys.isNotEmpty()) sys.append('\n')
                        sys.append(content)
                    } else {
                        list.put(JSONObject().put("role", role).put("content", content))
                    }
                }
                if (sys.isNotEmpty()) put("system", sys.toString())
                put("messages", list)
            }
        } else {
            JSONObject().apply {
                put("model", model)
                put("messages", messages)
                put("stream", false)
                put("max_tokens", maxTokens)
            }
        }

        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 20_000
                readTimeout = 90_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "deepseek-harness-mobile/0.2.1")
                if (messagesApi) {
                    setRequestProperty("anthropic-version", "2023-06-01")
                    setRequestProperty("x-dsh-auth-token", token!!)
                } else if (key.isNotBlank()) {
                    // 自定义模型（本地/第三方）常常不需要 Key：留空就不带这个头
                    setRequestProperty("Authorization", "Bearer $key")
                }
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                return Outcome(error = when (code) {
                    401 -> "登录/密钥无效（HTTP 401）"
                    402 -> "额度不足（HTTP 402）"
                    429 -> "请求过于频繁（HTTP 429）"
                    else -> "HTTP $code " + err.take(160)
                })
            }
            val raw = conn.inputStream.bufferedReader().use { it.readText() }
            val text = parseText(raw, messagesApi)
            when {
                text == null -> Outcome(error = "模型返回无法解析")
                text.isBlank() || text.trim().startsWith("SILENT", ignoreCase = true) -> Outcome(silent = true)
                else -> Outcome(text = sanitize(text))
            }
        } catch (t: Throwable) {
            Outcome(error = (t.message ?: t.javaClass.simpleName).take(80))
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    internal fun parseText(raw: String, messagesApi: Boolean): String? = runCatching {
        val o = JSONObject(raw)
        if (messagesApi) {
            val arr = o.optJSONArray("content") ?: return@runCatching null
            val sb = StringBuilder()
            for (i in 0 until arr.length()) {
                val blk = arr.optJSONObject(i) ?: continue
                if (blk.optString("type") == "text") sb.append(blk.optString("text"))
            }
            sb.toString()
        } else {
            val choices = o.optJSONArray("choices")
            val first = choices?.optJSONObject(0)
            val content = first?.optJSONObject("message")?.opt("content")
            when (content) {
                is String -> content
                is JSONArray -> {
                    val sb = StringBuilder()
                    for (i in 0 until content.length()) {
                        sb.append(content.optJSONObject(i)?.optString("text") ?: "")
                    }
                    sb.toString()
                }
                // 少数服务仍只给 legacy completions 的 text
                else -> first?.optString("text")?.takeIf { it.isNotBlank() }
            }
        }
    }.getOrNull()

    /** 模型偶尔仍带引号/前缀/换行，剥干净；再长的话也不是「一句主动话」了 */
    internal fun sanitize(t: String): String {
        var s = t.trim()
        s = s.replace(Regex("^(主动说[:：]|消息[:：])\\s*"), "")
        s = s.replace(Regex("^[\"「『]([\\s\\S]*)[\"」』]$"), "$1")
        s = s.replace(Regex("\\s+"), " ").trim()
        return if (s.length > TEXT_MAX) s.take(TEXT_MAX) else s
    }

    private fun buildMessages(
        m: JSONObject,
        st: JSONObject,
        cadence: String,
        count: Int,
        cap: Int,
        streak: Int,
    ): JSONArray {
        val arr = JSONArray()
        val sys = m.optString("system").trim()
        if (sys.isNotEmpty()) arr.put(JSONObject().put("role", "system").put("content", sys))
        // 最近几条对话由前端随配置一起下发（引擎不读 WebView 的 localStorage）
        m.optJSONArray("recent")?.let { r ->
            for (i in 0 until r.length()) {
                val o = r.optJSONObject(i) ?: continue
                val role = o.optString("role")
                val content = o.optString("content")
                if ((role == "user" || role == "assistant") && content.isNotBlank()) {
                    arr.put(JSONObject().put("role", role).put("content", content.take(1200)))
                }
            }
        }
        arr.put(JSONObject().put("role", "user").put("content", nudge(m, st, count, cap, streak)))
        return arr
    }

    /**
     * 只做占位符替换：话术在 JS（`Companion.nudges()`），这里不出文案。
     *
     * 占位符：`{hh}` 现在几点、`{gap}`「距他上次说话 N 分钟」整句（未知时是另一句）、
     * `{since}` 分钟数、`{count}/{cap}` 今日次数、`{streak}` 连续沉默次数。
     * `{gap}` 的两句措辞也由 JS 给（phrases.gapKnown / gapUnknown），
     * 因为「有没有上次说话」这件事只有拿到数据才知道，措辞不该在 Kotlin 里分叉。
     */
    internal fun nudge(m: JSONObject, st: JSONObject, count: Int, cap: Int, streak: Int): String {
        val forceAt = m.optInt("streakForce", 3).coerceAtLeast(1)
        val tpl = (if (streak >= forceAt) m.optString("nudgeForce") else m.optString("nudge"))
            .ifBlank { m.optString("nudge") }
            .ifBlank { FALLBACK_NUDGE }
        val lastUser = st.optLong("lastUserAt", 0)
        val since = if (lastUser > 0) ((System.currentTimeMillis() - lastUser) / 60_000L).toInt() else -1
        val phrases = m.optJSONObject("phrases") ?: JSONObject()
        val gap = if (since >= 0) {
            phrases.optString("gapKnown", "距他上次说话 {since} 分钟").replace("{since}", since.toString())
        } else {
            phrases.optString("gapUnknown", "有一阵没聊了")
        }
        val hh = "%02d:%02d".format(hourNow(), minuteNow())
        return tpl
            .replace("{hh}", hh)
            .replace("{gap}", gap)
            .replace("{since}", if (since >= 0) since.toString() else "—")
            .replace("{count}", count.toString())
            .replace("{cap}", cap.toString())
            .replace("{streak}", streak.toString())
    }

    /* ---------------- 待投递队列 ---------------- */

    private fun pushOutbox(ctx: Context, text: String, at: Long) {
        val f = outboxFile(ctx)
        val arr = readArray(f)
        val kept = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (at - o.optLong("at", 0) <= OUTBOX_TTL_MS) kept.put(o)
        }
        kept.put(
            JSONObject()
                .put("id", "pc" + at.toString(36) + Random.nextInt(1000, 9999))
                .put("at", at)
                .put("text", text),
        )
        val trimmed = JSONArray()
        val from = max(0, kept.length() - OUTBOX_MAX)
        for (i in from until kept.length()) trimmed.put(kept.opt(i))
        f.parentFile?.mkdirs()
        runCatching { f.writeText(trimmed.toString()) }
    }

    /** 给前端：还有哪些没投递 */
    fun outboxJson(ctx: Context): String = readArray(outboxFile(ctx)).toString()

    /** 前端领走（渲染进会话）后调用，按 id 清掉 */
    fun outboxAck(ctx: Context, ids: Set<String>) {
        if (ids.isEmpty()) return
        val f = outboxFile(ctx)
        val arr = readArray(f)
        val kept = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("id") !in ids) kept.put(o)
        }
        runCatching { f.writeText(kept.toString()) }
    }

    /* ---------------- 工具 ---------------- */

    internal fun gapMs(cadence: String): Long {
        val w = CompanionPlugin.window(cadence)
        // 真人不会每隔整 N 分钟准时来：在区间里抽一个随机点
        val minutes = w.first + Random.nextDouble() * ((w.last - w.first).coerceAtLeast(1))
        return (minutes * 60_000).toLong()
    }

    private fun inQuietHours(start: Int, end: Int): Boolean {
        if (start == end) return false
        val h = hourNow()
        return if (start < end) h in start until end else h >= start || h < end
    }

    private fun hourNow(): Int = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
    private fun minuteNow(): Int = Calendar.getInstance().get(Calendar.MINUTE)

    private fun dayKey(): String {
        val c = Calendar.getInstance()
        return "%04d-%02d-%02d".format(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
    }

    private fun read(f: File): JSONObject? = runCatching {
        if (f.isFile) JSONObject(f.readText()) else null
    }.getOrNull()

    private fun readArray(f: File): JSONArray = runCatching {
        if (f.isFile) JSONArray(f.readText()) else JSONArray()
    }.getOrDefault(JSONArray())

    private fun write(ctx: Context, o: JSONObject) {
        val f = stateFile(ctx)
        runCatching {
            f.parentFile?.mkdirs()
            f.writeText(o.toString())
        }
    }

    /** 记录「这次为什么没说」：设置面板直接显示，不用再靠猜 */
    private fun record(ctx: Context, st: JSONObject, why: String) {
        if (st.length() == 0) return
        val now = System.currentTimeMillis()
        if (st.optString("lastSkip") == why && now - st.optLong("lastBeatAt", 0) < 120_000) return
        st.put("lastSkip", why)
        st.put("lastBeatAt", now)
        write(ctx, st)
    }
}
