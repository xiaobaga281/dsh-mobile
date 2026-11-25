package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Calendar

/**
 * 陪伴式畅聊 —— 让 Agent 从「有问必答」变成「会主动搭话的人」。
 *
 * 做法与桌面那套 heartbeat 一致（也是业界通行做法，见 OpenClaw / Claude 类产品的
 * 「定期自检 → 有话才说」）：插件自己走一个心跳，到点问一次「现在有没有值得开口的事」，
 * 有就发一条，没有就闭嘴。
 *
 * 三条纪律写进插件自身，而不是靠模型自觉：
 *   1. **到点不等于必须说话**：心跳只是一次机会，模型可以选择回 `SILENT` 保持安静；
 *   2. **有话才说**：靠 `companion_followup` 记下的线索（约定、情绪、待办）决定说什么，
 *      没有线索就不打扰 —— 这是「像朋友」与「像推送」的分界线；
 *   3. **不打扰**：免打扰时段、每日上限、用户正在对话/Agent 正在跑时一律不插话。
 *
 * 插件只负责「什么时候可以开口」和「记住要说的事」；具体说什么交给模型（[promptSection]）。
 *
 * ## 分层（改这块之前先看这张表）
 *
 * | 层 | 文件 | 只负责 |
 * |---|---|---|
 * | 时间与策略 | 本文件 | 心跳、窗口/上限（WINDOWS）、免打扰、状态文件读写 |
 * | 进程存活 | [CompanionKeepService] | 前台服务 + allow-idle 闹钟；不含任何业务判断 |
 * | 状态出口 | `ToolKernel.companionState()` | 状态文件 + `cadenceTable`（档位唯一数据源）一并给前端 |
 * | 措辞与落地 | `app.js` 的 `Companion` | 组织提示词、问模型、落进会话、发通知 |
 *
 * 纪律：**规则在 Kotlin，措辞在 JS**。JS 不再自带档位数字，只读 `cadenceTable`。
 */
class CompanionPlugin : KernelPlugin {
    override val id = "companion"
    override val name = "陪伴式畅聊"
    override val description = "到点主动搭话：有话说才开口，记住约定与情绪，免打扰时段静默；后台保活心跳不缺席"
    override val version = "1.1.0"

    private var ctx: PluginContext? = null
    private var stateFile: File? = null
    private var appContext: android.content.Context? = null
    private var spoke = 0

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        stateFile = ctx.service("companion.state") as? File
        appContext = ctx.service("companion.appContext") as? android.content.Context
        spoke = load().optInt("spokeTotal", 0)
        // 心跳与生成都在原生侧（[CompanionEngine] + [CompanionKeepService]）：
        // 插件这里只留「工具 + 状态展示 + promptSection」。开启状态直接拉起保活服务，
        // 服务一起来就会自己驱动引擎 —— 这也是「应用不在前台也能主动说话」的前提。
        // 同时挂一条应用内兜底心跳：服务起不来时至少界面上还活着（详见 [CompanionEngine.startInAppBeat]）。
        val c = appContext
        if (c != null && load().optBoolean("enabled", false)) {
            CompanionKeepService.ensure(c)
            CompanionEngine.startInAppBeat(c)
        }
    }

    override fun onUnload() {
        // 陪伴还开着就不撤保活：内核重启（进程被 START_STICKY 拉起后重新建内核）
        // 期间服务继续驻留（引擎随之继续跑）；只有用户关了开关才真正撤
        val keepWanted = appContext != null && load().optBoolean("enabled", false)
        val c = appContext
        if (c != null && !keepWanted) {
            CompanionKeepService.stop(c)
            CompanionEngine.stopInAppBeat()
        }
        ctx = null; stateFile = null; appContext = null
    }

    override fun status(): Map<String, String> {
        val s = load()
        val next = s.optLong("nextDueAt", 0)
        return mapOf(
            "状态" to if (s.optBoolean("enabled", false)) "已开启（${cadenceLabel(s.optString("cadence", "normal"))}）" else "未开启",
            "主动说过" to spoke.toString(),
            "上次开口" to (s.optLong("lastSpokeAt", 0).takeIf { it > 0 }?.let { agoText(it) } ?: "还没"),
            // 窗口是随机的，这里只是「最早可能」—— 到点也不一定会说话
            "下次窗口" to (next.takeIf { it > System.currentTimeMillis() }?.let { inText(it) } ?: "随时"),
            "待跟进" to (s.optJSONArray("threads")?.length() ?: 0).toString(),
            // 通知权限被关时，主动消息会被系统直接丢弃：不写出来，用户只会觉得「它不理我」
            "通知" to if (appContext == null || ai.deepseek.harness.mobile.notify.RunService.notificationsOn(appContext!!)) {
                "正常"
            } else "未授权 · 只说进对话，收不到弹窗（设置 → 权限 → 通知）",
            "后台保活" to if (s.optBoolean("enabled", false)) {
                when {
                    CompanionKeepService.running() -> "驻留中 · 后台也到点开口"
                    // 起不来的真实原因要露出来：以前一律写「受系统限制」，把清单类名写错这种事藏了几个月
                    CompanionKeepService.lastError != null -> "未驻留：" + CompanionKeepService.lastError!!
                    else -> "未驻留（服务未启动）"
                }
            } else "—",
        )
    }

    override fun promptSection(): String? {
        val s = load()
        if (!s.optBoolean("enabled", false)) return null
        return """
【陪伴式畅聊 · 已开启】
你在这台手机上陪着一个具体的人，不只是一个等指令的工具。除了完成任务，你也可以**主动**说两句：
- 什么时候开口：想到他之前提过的事（面试、体检、赶工、失眠）、隔了一段时间没聊、或者刚才那件事有了后续。
  这些线索存在 `companion_followup` 里，心跳到点时会被带进上下文。
- 怎么开口：像朋友发消息 —— 一到两句，具体，接得上上次的话；给一个轻松的话头，不追问、不连环问、不总结陈词。
  例：「昨天那版方案过了没？」「今天降温，出门记得加件外套」。
- 什么时候闭嘴：对方在忙、刚说完「先不聊了」、免打扰时段、或者你其实没什么可说的。
  **没有真实由头就不要开口** —— 硬凑的寒暄比沉默更打扰。
- 不许假装：不要编造他的生活细节，不确定就轻一点问；不要用「根据我的记录」这类机器口吻。
- 主动说完后，把这条线索从 `companion_followup` 里结掉（clear），免得反复提同一件事。
- 这一轮如果是「心跳到点」而你没话可说，**只回四个字符 `SILENT`**（前端会吞掉，不显示）。
""".trimIndent()
    }

    /* ---------------- 状态 ---------------- */

    private fun load(): JSONObject {
        val f = stateFile ?: return JSONObject()
        return try {
            if (f.isFile) JSONObject(f.readText()) else JSONObject()
        } catch (_: Throwable) {
            JSONObject()
        }
    }

    private fun save(o: JSONObject) {
        val f = stateFile ?: return
        try {
            f.parentFile?.mkdirs()
            f.writeText(o.toString())
        } catch (t: Throwable) {
            ctx?.log("companion 状态写入失败：${t.message}")
        }
    }

    /**
     * 节奏档位 → 间隔区间（分钟）。
     *
     * 用**区间**而不是定值：真人不会每隔整 45 分钟准时来找你，固定周期正是「像推送」的根源。
     * 每次真正去问模型之前，前端从当前区间里抽一个随机数写进 `nextDueAt`，
     * 心跳只负责对表 —— 所以「说不说」不影响节奏，「问没问」才消耗窗口。
     *
     * 前端 `Companion.CADENCE` 里有一份同值副本（用于面板文案与兜底），改动请两边同步。
     */
    /**
     * 档位参数**唯一定义处**。
     *
     * 以前窗口/上限在 JS（Companion.CADENCE）和 Kotlin（cadenceWindow/cadenceCap）各写一份，
     * 改档位必须记得两边同步 —— 忘了就出现「面板说 6 分钟、心跳按 25 分钟算」这种漂移。
     * 现在只有这里是真的：前端通过 companionState().cadenceTable 读，本地表只作老版本兜底。
     */
    companion object {
        private val WINDOWS = mapOf(
            "quiet" to (60 to 120),
            // 「话多」：用户明确要求「多主动」。原来 10..30 分钟 + 提示词里严格的 SILENT
            // 纪律，实测开最强档一整天几乎收不到一句 —— 窗口与提示词必须一起放宽。
            "chatty" to (6 to 18),
            // 适中：25..55 → 20..45。窗口偏长 + 提示词保守时一天只有两三句，
            // 用户体感就是「开了没感觉」。三档都要真的会开口，不能只有最强档。
            "normal" to (20 to 45),
        )
        private val CAPS = mapOf("quiet" to 12, "normal" to 24, "chatty" to 48)
        private val LABELS = mapOf("quiet" to "安静", "normal" to "适中", "chatty" to "话多")

        fun window(c: String): IntRange = WINDOWS[c]?.let { it.first..it.second } ?: (20..45)
        fun cap(c: String): Int = CAPS[c] ?: 24
        fun label(c: String): String = LABELS[c] ?: LABELS.getValue("normal")

        /** 给前端的档位表（唯一数据源） */
        fun tableJson(): JSONObject = JSONObject().apply {
            for ((id, w) in WINDOWS) {
                put(id, JSONObject().apply {
                    put("min", w.first); put("max", w.second)
                    put("cap", cap(id)); put("name", label(id))
                })
            }
        }
    }

    private fun cadenceWindow(c: String): IntRange = window(c)
    private fun cadenceCap(c: String): Int = cap(c)
    private fun cadenceLabel(c: String): String = label(c)

    private fun agoText(ts: Long): String {
        val min = ((System.currentTimeMillis() - ts) / 60000).coerceAtLeast(0)
        return when {
            min < 60 -> "${min} 分钟前"
            min < 60 * 24 -> "${min / 60} 小时前"
            else -> "${min / 60 / 24} 天前"
        }
    }

    /** 距某个未来时间点多久（用于「下次窗口」） */
    private fun inText(ts: Long): String {
        val min = ((ts - System.currentTimeMillis()) / 60000).coerceAtLeast(0)
        return if (min < 60) "${min} 分钟后" else "${min / 60} 小时${if (min % 60 > 0) " ${min % 60} 分" else ""}后"
    }

    private fun hourNow(): Int = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)

    private fun inQuietHours(start: Int, end: Int): Boolean =
        if (start == end) false
        else if (start < end) hourNow() in start until end
        else hourNow() >= start || hourNow() < end

    /* ---------------- 心跳 ---------------- */
    // 已搬走：心跳由 CompanionKeepService 驱动 CompanionEngine，生成也在原生侧。
    // 这里不再持有定时器，也就不会出现「前台一套、后台一套」的双重开口。

    private fun dayKey(): String {
        val c = Calendar.getInstance()
        return "%04d-%02d-%02d".format(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
    }

    /* ---------------- 工具 ---------------- */

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object")
        put("properties", props)
        put("required", JSONArray(required))
        put("additionalProperties", false)
    }

    /* 备注：没有 companion_say —— 心跳那一轮模型直接回复，那句话就是「说出口」。
       多一个转述工具只会让它把话写两遍（工具里一份、回复里一份）。 */
    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "companion_followup",
            description =
                "记一条「之后值得问一句」的线索：他要面试、明天体检、正在赶某个 deadline、情绪不太好、答应了某事。" +
                    "心跳到点时会把这些线索带进上下文，作为主动开口的由头。事情聊完/已经问过就 clear 掉。",
            parameters = schema(
                JSONObject()
                    .put("text", JSONObject().put("type", "string").put("description", "线索内容（一句话，写清人和事）"))
                    .put("clear", JSONObject().put("type", "string").put("description", "要结掉的线索（按内容子串匹配），留空表示新增"))
                    .put("list", JSONObject().put("type", "boolean").put("description", "只列出当前线索，不新增")),
                emptyList(),
            ),
        ) { a ->
            val s = load()
            val arr = s.optJSONArray("threads") ?: JSONArray()
            if (a.optBoolean("list", false)) {
                return@SimpleTool JSONObject().put("ok", true).put("threads", arr).toString()
            }
            val clear = a.optString("clear").trim()
            if (clear.isNotEmpty()) {
                val kept = JSONArray()
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    if (!o.optString("text").contains(clear)) kept.put(o)
                }
                s.put("threads", kept)
                save(s)
                return@SimpleTool JSONObject().put("ok", true).put("removed", arr.length() - kept.length())
                    .put("threads", kept).toString()
            }
            val text = a.optString("text").trim()
            if (text.isBlank()) throw KernelError("text 与 clear 至少给一个")
            if (arr.length() >= 12) throw KernelError("线索太多了（>12），先清掉已经聊过的")
            arr.put(JSONObject().apply {
                put("text", text.take(160))
                put("at", System.currentTimeMillis())
            })
            s.put("threads", arr)
            save(s)
            JSONObject().put("ok", true).put("threads", arr).toString()
        },

        SimpleTool(
            name = "companion_control",
            description =
                "查看或修改陪伴式畅聊设置。用户说「别晚上打扰我」「少说两句」「多聊点」「关掉」时用它，" +
                    "不要只口头答应。字段：enabled(开关)、cadence(quiet/normal/chatty)、quietStart/quietEnd(免打扰小时 0-23)、" +
                    "style(warm 温柔 / teasing 损友 / calm 安静 / auto)、voiceReply(它说完自动接麦听用户回一句)。只查不改时传 action=list。",
            parameters = JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("action", JSONObject().put("type", "string").put("description", "list | set"))
                    put("enabled", JSONObject().put("type", "boolean"))
                    put("cadence", JSONObject().put("type", "string"))
                    put("quietStart", JSONObject().put("type", "integer"))
                    put("quietEnd", JSONObject().put("type", "integer"))
                    put("style", JSONObject().put("type", "string"))
                    put("voiceReply", JSONObject().put("type", "boolean"))
                })
                put("required", JSONArray(listOf("action")))
                put("additionalProperties", false)
            },
        ) { a ->
            val s = load()
            if (a.optString("action", "list") == "set") {
                val beforeCadence = s.optString("cadence", "normal")
                val beforeOn = s.optBoolean("enabled", false)
                if (a.has("enabled")) s.put("enabled", a.optBoolean("enabled"))
                if (a.has("cadence")) {
                    val c = a.optString("cadence")
                    if (c !in setOf("quiet", "normal", "chatty")) throw KernelError("cadence 只能是 quiet/normal/chatty")
                    s.put("cadence", c)
                }
                if (a.has("quietStart")) s.put("quietStart", a.optInt("quietStart", 23).coerceIn(0, 23))
                if (a.has("quietEnd")) s.put("quietEnd", a.optInt("quietEnd", 8).coerceIn(0, 23))
                if (a.has("style")) s.put("style", a.optString("style"))
                if (a.has("voiceReply")) s.put("voiceReply", a.optBoolean("voiceReply"))
                // 换档位 / 刚打开：旧窗口作废，否则「多聊点」还得等上一个长窗口走完
                if (beforeCadence != s.optString("cadence", "normal") || beforeOn != s.optBoolean("enabled", false)) {
                    s.put("nextDueAt", 0)
                }
                save(s)
                // 这条路径不经过 ToolKernel.saveCompanionState：保活在这里同步
                val c = appContext
                if (c != null) {
                    if (s.optBoolean("enabled", false)) CompanionKeepService.ensure(c)
                    else CompanionKeepService.stop(c)
                }
            }
            JSONObject().put("ok", true).put("settings", s).put("cadenceLabel", cadenceLabel(s.optString("cadence", "normal")))
                .put("note", "设置已保存；用户在设置页也能改，两边是同一份状态").toString()
        },
    )
}
