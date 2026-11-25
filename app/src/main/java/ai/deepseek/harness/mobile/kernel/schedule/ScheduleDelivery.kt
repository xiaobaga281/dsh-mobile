package ai.deepseek.harness.mobile.kernel.schedule

import org.json.JSONObject

/**
 * 定时任务的投递。
 *
 * 为什么单独一个类：投递要「先写进原会话，再改任务行」，还要对 `(id, scheduledAt)`
 * 幂等。这三件事是**纯逻辑**，只要把「往会话追加一条事件」抽成一个函数就能在 JVM 上
 * 精确测试（不需要 Android、不需要真的 SessionStore）。
 *
 * 依赖注入的是 `appendEvent` 而不是 `SessionStore` 实例，是为了避免两个 SessionStore
 * 实例写同一个 .jsonl —— `SessionStore` 的按会话写锁是实例字段，两个实例等于两把锁，
 * 并发写会把一行 JSON 撕成两半。持有唯一实例的那一方（ToolKernel 里的 `sessions`）
 * 传 `sessions::appendOrThrow` 进来即可。
 *
 * 与桌面 `schedule` 投递语义的对照：
 *   - 桌面：`resolveAgent(sessionId)` → `followup()` → `session/flush` 确认 → 再 put 任务行。
 *     两次写不原子，中间崩溃会重复投递（桌面文档自己承认）。
 *   - 手机：顺序相同（先落会话、后改任务行），但用**确定性 messageId**
 *     `sched-<id>-<scheduledAt>` 让重复投递可被识别；收到同一 messageId 的第二条
 *     回执不会重复记入历史。
 */
class ScheduleDelivery(
    private val appendEvent: (sessionId: String, type: String, payload: JSONObject) -> Unit,
    private val clock: ScheduleClock = ScheduleClock.system(),
) {

    class Result(
        val ok: Boolean,
        val deliveredAt: Long,
        val messageId: String?,
        val reason: String? = null,
    ) {
        companion object {
            fun fail(reason: String) = Result(false, 0L, null, reason)
        }
    }

    /** 同进程内的幂等护栏：闹钟与定时器可能几乎同时触发同一条记录 */
    private val recentlyDelivered = java.util.concurrent.ConcurrentHashMap<String, Long>()

    fun deliver(record: ScheduleRecord): Result {
        val key = record.deliveryKey()
        if (recentlyDelivered.containsKey(key)) {
            return Result.fail("already_delivered")
        }
        if (record.sessionId.isBlank()) {
            // 没有会话可写：任务保持 active，由上层累计 missedRuns 并重试
            return Result.fail("no_session")
        }
        val messageId = messageIdOf(record)
        val payload = buildPayload(record, messageId)
        return try {
            appendEvent(record.sessionId, EVENT_TYPE, payload)
            recentlyDelivered[key] = record.scheduledAt
            // 只保留最近 200 个键，长期运行不涨内存
            if (recentlyDelivered.size > 200) {
                val oldest = recentlyDelivered.entries.minByOrNull { it.value }?.key
                if (oldest != null) recentlyDelivered.remove(oldest)
            }
            Result(true, clock.nowMillis(), messageId, null)
        } catch (t: Throwable) {
            // 写入失败 = 没投递成功，任务必须保留（prompt 不能丢）
            Result.fail(t.message ?: t.javaClass.simpleName)
        }
    }

    /** 供上层在校验历史时复用，保证与已存回执的 messageId 对得上 */
    fun messageIdOf(record: ScheduleRecord): String = "sched-${record.id}-${record.scheduledAt}"

    /**
     * 会话事件载荷。事件类型固定 `user/message`：
     * `SessionStore.deriveMessages` 只认 `user/message` 的 `text` 字段，
     * 所以这条消息会真正进入模型可见历史 —— 与桌面「到期提醒作为 follow-up
     * 消息进入原对话」等价。
     */
    fun buildPayload(record: ScheduleRecord, messageId: String): JSONObject = JSONObject().apply {
        put("text", buildText(record))
        put("producer", "schedule")
        put("messageId", messageId)
        put("scheduleId", record.id)
        put("scheduleTitle", record.title)
        put("occurrenceAt", record.scheduledAt)
        put("reminderPrompt", record.prompt)
        put("timingGuarantee", ScheduleRecord.TIMING_INEXACT)
    }

    /**
     * 固定文本沿用桌面的标记（`[SCHEDULE REMINDER]`），让模型一眼分得清
     * 「用户说的」和「到点自动送来的」。
     */
    fun buildText(record: ScheduleRecord): String = buildString {
        append("[SCHEDULE REMINDER]\n")
        append("这是一条到点投递的定时消息（由用户此前设定，不是用户此刻在说话）。\n")
        append("任务：").append(record.title).append('\n')
        append("原定时刻：").append(ScheduleRule.formatIso(record.scheduledAt, ScheduleRule.zoneOf(record.rule)))
            .append('\n')
        append("说明：手机端到点精度为近似（省电模式下可能延后），此条为本次实际送达。\n\n")
        append(record.prompt)
    }

    companion object {
        const val EVENT_TYPE = "user/message"
    }
}
