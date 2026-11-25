package ai.deepseek.harness.mobile.kernel.schedule

import org.json.JSONArray
import org.json.JSONObject

/**
 * 可注入时钟。
 *
 * 为什么需要它：DST（夏令时）跳过/重叠、错过补发、幂等键 (id, scheduledAt) 这三件事
 * 全部依赖「现在几点」。如果代码直接调 `System.currentTimeMillis()`，JVM 单测就没法
 * 把时钟拨到任意时刻，只能靠 sleep —— 那既慢又不可靠（还会在 CI 上偶发失败）。
 */
fun interface ScheduleClock {
    fun nowMillis(): Long

    companion object {
        fun system(): ScheduleClock = ScheduleClock { System.currentTimeMillis() }
    }
}

/** 六种时间规则之一。与桌面 `ScheduleRecord.kind` 同名同义。 */
enum class ScheduleKind {
    after, at, every, daily, weekly, cron;

    /** 周期性规则：触发后推进 scheduledAt；其余（after/at）触发后进入 inactive */
    val periodic: Boolean get() = this == every || this == daily || this == weekly || this == cron

    companion object {
        fun ofKey(key: String?): ScheduleKind? =
            key?.let { k -> entries.firstOrNull { it.name == k } }
    }
}

/**
 * 定时任务的稳定错误码 —— 与桌面 `tool-schedule` 的 `invalid_prompt` / `invalid_rule`
 * 同名。调用方按 code 路由，不要去解析 message 文本。
 */
class ScheduleException(
    val code: String,
    override val message: String,
) : Exception(message) {
    companion object {
        const val INVALID_PROMPT = "invalid_prompt"
        const val INVALID_RULE = "invalid_rule"
        const val NOT_FOUND = "schedule_not_found"
        const val ENDED = "schedule_ended"
        const val CONFLICT = "schedule_conflict"

        fun prompt(message: String) = ScheduleException(INVALID_PROMPT, message)
        fun rule(message: String) = ScheduleException(INVALID_RULE, message)
    }
}

/**
 * 一条定时任务记录 —— 手机端 `schedule.json` v2 的唯一数据模型。
 *
 * 字段与桌面 `packages/schedule/schedule/src/types.ts` 的 `ScheduleRecord` 对齐，
 * 差异只有两条，且都是手机端的平台现实决定的（在 [toJson] 里如实写入，不假装）：
 *   - `deliveryMode = "device"` 而不是 `"host"`：手机没有常驻宿主进程
 *   - `timingGuarantee` 显式声明到点精度（exact / inexact / best_effort）
 */
data class ScheduleRecord(
    val id: String,
    val kind: ScheduleKind,
    val title: String,
    val prompt: String,
    val sessionId: String,
    val createdAt: Long,
    /** 规范化后的规则对象（选择器键 → 参数），不含计算出的时间 */
    val rule: JSONObject,
    /** 下一次目标时刻（UTC 毫秒）。重启/解码**绝不重算**已提交的值。 */
    val scheduledAt: Long,
    /** active | inactive。一次性任务触发后转 inactive —— 行保留，prompt 不丢。 */
    val state: String,
    val lastDelivery: JSONObject?,
    val deliveryHistory: List<JSONObject>,
    val earlierRecordsUnavailable: Boolean,
    val earlierRecordsPruned: Boolean,
    /** 因进程不在/投递失败而错过、但尚未补发的次数（如实计数，不假装没发生） */
    val missedRuns: Int,
) {

    val active: Boolean get() = state == STATE_ACTIVE

    /** 幂等键：同一条记录的同一个目标时刻只能投递一次 */
    fun deliveryKey(): String = "$id@$scheduledAt"

    fun isDeliveredForCurrentTarget(): Boolean =
        lastDelivery != null && lastDelivery.optLong("scheduledAt", -1L) == scheduledAt

    /**
     * 投递成功后的新记录。
     * - 周期任务：state=active，scheduledAt 推进到 nextAt
     * - 一次性任务：state=inactive，scheduledAt 保持不变（保留"它本该在何时发生"这一事实，
     *   这样 schedule_list 里还能看到它、还能看到 lastDelivery，而不是整行消失）
     */
    fun afterDelivery(
        deliveredAt: Long,
        messageId: String,
        deliveredTarget: Long,
        nextAt: Long?,
    ): ScheduleRecord {
        val receipt = JSONObject().apply {
            put("scheduledAt", deliveredTarget)
            put("deliveredAt", deliveredAt)
            put("messageId", messageId)
        }
        val records = ArrayList(deliveryHistory)
        // 桌面：拒绝重复 messageId，且最新回执必须与 lastDelivery 一致
        if (records.none { it.optString("messageId") == messageId }) records.add(receipt)
        var pruned = earlierRecordsPruned
        while (records.size > MAX_HISTORY) {
            records.removeAt(0)
            pruned = true
        }
        val advance = nextAt != null
        return copy(
            state = if (advance) STATE_ACTIVE else STATE_INACTIVE,
            scheduledAt = if (advance) nextAt else deliveredTarget,
            lastDelivery = receipt,
            deliveryHistory = records,
            earlierRecordsPruned = pruned,
            missedRuns = 0,
        )
    }

    /** 投递失败：保持 active、scheduledAt 不变，只累计错过次数。绝不丢任务。 */
    fun afterDeliveryFailure(): ScheduleRecord = copy(
        state = STATE_ACTIVE,
        missedRuns = missedRuns + 1,
    )

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("kind", kind.name)
        put("title", title)
        put("prompt", prompt)
        put("sessionId", sessionId)
        put("createdAt", createdAt)
        put("rule", rule)
        put("scheduledAt", scheduledAt)
        put("state", state)
        put("deliveryMode", DELIVERY_MODE_DEVICE)
        put("timingGuarantee", TIMING_INEXACT)
        put("lastDelivery", lastDelivery ?: JSONObject.NULL)
        put("deliveryHistory", JSONObject().apply {
            put("records", JSONArray(deliveryHistory))
            put("earlierRecordsUnavailable", earlierRecordsUnavailable)
            put("earlierRecordsPruned", earlierRecordsPruned)
        })
        put("missedRuns", missedRuns)
    }

    /** 给模型/界面看的视图（`schedule_list` 用），含下一次触发的可读时间 */
    fun toView(nowMillis: Long): JSONObject = JSONObject().apply {
        put("id", id)
        put("kind", kind.name)
        put("title", title)
        put("prompt", prompt)
        put("sessionId", sessionId)
        put("state", state)
        put("scheduledAt", scheduledAt)
        put("scheduledAtText", ScheduleRule.formatIso(scheduledAt, ScheduleRule.zoneOf(rule)))
        put("deliveryMode", DELIVERY_MODE_DEVICE)
        put("timingGuarantee", TIMING_INEXACT)
        put("missedRuns", missedRuns)
        put("rule", rule)
        lastDelivery?.let { put("lastDelivery", it) }
        put("overdue", active && scheduledAt <= nowMillis)
    }

    companion object {
        const val STATE_ACTIVE = "active"
        const val STATE_INACTIVE = "inactive"
        const val DELIVERY_MODE_DEVICE = "device"
        const val TIMING_INEXACT = "inexact"

        /** 保留最近 50 次回执；更早的裁剪掉并把 `earlierRecordsPruned` 置真 */
        const val MAX_HISTORY = 50

        /**
         * 解码。返回 null 表示这条记录坏了 —— 调用方负责隔离（见 ScheduleStore），
         * 不要静默丢弃，也不要因为一条坏记录打死整个文件。
         *
         * 同时兼容 v1（`nextAt`、`rule.time_zone` 下划线写法）：迁移集中在这里，
         * ScheduleStore 只负责版本判断与回写。
         */
        fun fromJson(o: JSONObject, log: (String) -> Unit = {}): ScheduleRecord? = try {
            val id = o.optString("id").trim()
            val title = o.optString("title").trim()
            val prompt = o.optString("prompt")
            if (id.isEmpty() || title.isEmpty() || prompt.isBlank()) {
                null
            } else {
                val rule = ScheduleRule.normalizeStoredRule(o.optJSONObject("rule") ?: JSONObject())
                val kind = ScheduleKind.ofKey(o.optString("kind").ifBlank { null })
                    ?: ScheduleRule.kindOf(rule)
                val scheduledAt = when {
                    o.has("scheduledAt") -> o.optLong("scheduledAt")
                    o.has("nextAt") -> o.optLong("nextAt")   // v1
                    else -> 0L
                }
                if (kind == null || scheduledAt <= 0L) {
                    null
                } else {
                    val histObj = o.optJSONObject("deliveryHistory")
                    val records = ArrayList<JSONObject>()
                    histObj?.optJSONArray("records")?.let { arr ->
                        for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { records.add(it) }
                    }
                    ScheduleRecord(
                        id = id,
                        kind = kind,
                        title = title,
                        prompt = prompt,
                        sessionId = o.optString("sessionId"),
                        createdAt = o.optLong("createdAt", 0L),
                        rule = rule,
                        scheduledAt = scheduledAt,
                        state = if (o.optString("state") == STATE_INACTIVE) STATE_INACTIVE
                        else STATE_ACTIVE,
                        lastDelivery = o.optJSONObject("lastDelivery"),
                        deliveryHistory = records,
                        earlierRecordsUnavailable = histObj
                            ?.optBoolean("earlierRecordsUnavailable", true) ?: true,
                        earlierRecordsPruned = histObj
                            ?.optBoolean("earlierRecordsPruned", false) ?: false,
                        missedRuns = o.optInt("missedRuns", 0),
                    )
                }
            }
        } catch (t: Throwable) {
            log("schedule 记录解码失败：${t.message}")
            null
        }
    }
}
