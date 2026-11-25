package ai.deepseek.harness.mobile.kernel.schedule

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 定时任务投递的 JVM 验收。
 *
 * 这些断言对应本次修掉的真实缺陷：
 *   - 一次性任务触发即删行 → prompt 永久丢失
 *   - 投递只发 UI 事件、不写会话 → 应用不在前台就等于没送达
 *   - 同一目标时刻可能被闹钟与定时器重复投递
 */
class ScheduleDeliveryTest {

    private fun record(
        id: String = "sch-1",
        sessionId: String = "sess-1",
        scheduledAt: Long = 1_000_000L,
        kind: ScheduleKind = ScheduleKind.after,
        prompt: String = "检查构建结果",
        title: String = "构建检查",
    ) = ScheduleRecord(
        id = id,
        kind = kind,
        title = title,
        prompt = prompt,
        sessionId = sessionId,
        createdAt = 0L,
        rule = JSONObject().put("after_seconds", 60),
        scheduledAt = scheduledAt,
        state = ScheduleRecord.STATE_ACTIVE,
        lastDelivery = null,
        deliveryHistory = emptyList(),
        earlierRecordsUnavailable = true,
        earlierRecordsPruned = false,
        missedRuns = 0,
    )

    private class Sink {
        val events = ArrayList<Triple<String, String, JSONObject>>()
        var throwOnAppend = false

        fun append(sessionId: String, type: String, payload: JSONObject) {
            if (throwOnAppend) throw java.io.IOException("磁盘满")
            events.add(Triple(sessionId, type, payload))
        }
    }

    private fun delivery(sink: Sink, now: Long = 5_000L) =
        ScheduleDelivery(appendEvent = sink::append, clock = ScheduleClock { now })

    /* ---------------- 投递内容 ---------------- */

    @Test
    fun `投递写入会话 user-message 且标注 producer=schedule`() {
        val sink = Sink()
        val rec = record()
        val r = delivery(sink).deliver(rec)

        assertTrue(r.ok)
        assertEquals(1, sink.events.size)
        val (sessionId, type, payload) = sink.events[0]
        assertEquals("sess-1", sessionId)
        assertEquals("user/message", type)
        assertEquals("schedule", payload.optString("producer"))
        assertEquals("sch-1", payload.optString("scheduleId"))
        assertEquals(rec.scheduledAt, payload.optLong("occurrenceAt"))
        // 必须是 user/message.text —— SessionStore.deriveMessages 只认这个字段，
        // 否则消息写进去了但模型看不到
        val text = payload.optString("text")
        assertTrue(text.contains("[SCHEDULE REMINDER]"))
        assertTrue(text.contains("检查构建结果"))
        // 如实告知精度，不吹"准时"
        assertEquals(ScheduleRecord.TIMING_INEXACT, payload.optString("timingGuarantee"))
    }

    @Test
    fun `messageId 与记录绑定且稳定`() {
        val sink = Sink()
        val d = delivery(sink)
        val rec = record()
        assertEquals("sched-sch-1-1000000", d.messageIdOf(rec))
        val r1 = d.deliver(rec)
        assertEquals(d.messageIdOf(rec), r1.messageId)
    }

    /* ---------------- 幂等 ---------------- */

    @Test
    fun `同一目标时刻重复投递被幂等拦截`() {
        val sink = Sink()
        val d = delivery(sink)
        val rec = record()

        assertTrue(d.deliver(rec).ok)
        val second = d.deliver(rec)

        assertFalse("第二次投递必须失败", second.ok)
        assertEquals("already_delivered", second.reason)
        assertEquals("只能写入一次", 1, sink.events.size)
    }

    @Test
    fun `已投递过的目标可被记录识别`() {
        val rec = record()
        val after = rec.afterDelivery(
            deliveredAt = 5_000L,
            messageId = "sched-sch-1-1000000",
            deliveredTarget = rec.scheduledAt,
            nextAt = null,
        )
        assertTrue("scheduledAt 未变、lastDelivery 已存在 → 视为已投递", after.isDeliveredForCurrentTarget())
        assertFalse(record().isDeliveredForCurrentTarget())
    }

    /* ---------------- 失败必须保命 ---------------- */

    @Test
    fun `写入失败时投递判失败且不推进`() {
        val sink = Sink().apply { throwOnAppend = true }
        val r = delivery(sink).deliver(record())

        assertFalse(r.ok)
        assertNotNull(r.reason)
        assertTrue(sink.events.isEmpty())
    }

    @Test
    fun `投递失败后记录保持 active 且累计错过次数`() {
        val rec = record()
        val failed = rec.afterDeliveryFailure()
        assertEquals(ScheduleRecord.STATE_ACTIVE, failed.state)
        assertEquals("目标时刻不能被改动", rec.scheduledAt, failed.scheduledAt)
        assertEquals(1, failed.missedRuns)
    }

    @Test
    fun `无归属会话时拒绝投递而不是写进空会话`() {
        val sink = Sink()
        val r = delivery(sink).deliver(record(sessionId = ""))
        assertFalse(r.ok)
        assertEquals("no_session", r.reason)
        assertTrue(sink.events.isEmpty())
    }

    /* ---------------- 状态机 ---------------- */

    @Test
    fun `一次性任务投递后转 inactive 且保留原定时刻`() {
        val rec = record(scheduledAt = 1_000_000L)
        val after = rec.afterDelivery(
            deliveredAt = 1_100_000L,
            messageId = "m1",
            deliveredTarget = rec.scheduledAt,
            nextAt = null,   // after/at 不是周期性
        )
        assertEquals(ScheduleRecord.STATE_INACTIVE, after.state)
        assertFalse(after.active)
        assertEquals("原定时刻要保留，才看得出它本该何时发生", 1_000_000L, after.scheduledAt)
        assertNotNull(after.lastDelivery)
        assertEquals(1_100_000L, after.lastDelivery!!.optLong("deliveredAt"))
        assertEquals(0, after.missedRuns)
    }

    @Test
    fun `周期任务投递后推进到下一次并保持 active`() {
        val rec = record(kind = ScheduleKind.every, scheduledAt = 1_000_000L)
        val next = 1_060_000L
        val after = rec.afterDelivery(
            deliveredAt = 1_000_500L,
            messageId = "m2",
            deliveredTarget = 1_000_000L,
            nextAt = next,
        )
        assertEquals(ScheduleRecord.STATE_ACTIVE, after.state)
        assertEquals(next, after.scheduledAt)
    }

    @Test
    fun `历史超过上限时裁剪并留下裁剪标记`() {
        val history = (1..ScheduleRecord.MAX_HISTORY).map { i ->
            JSONObject().put("messageId", "old-$i").put("scheduledAt", i.toLong())
        }
        val rec = record().copy(deliveryHistory = history)
        val after = rec.afterDelivery(
            deliveredAt = 9_999L,
            messageId = "newest",
            deliveredTarget = 1_000_000L,
            nextAt = null,
        )
        assertEquals(ScheduleRecord.MAX_HISTORY, after.deliveryHistory.size)
        assertTrue("裁剪过就必须承认", after.earlierRecordsPruned)
        assertEquals("newest", after.deliveryHistory.last().optString("messageId"))
    }

    /* ---------------- v1 迁移 ---------------- */

    @Test
    fun `v1 记录迁移 nextAt 与下划线时区`() {
        val v1 = JSONObject().apply {
            put("id", "sch-9")
            put("title", "日报")
            put("prompt", "写日报")
            put("sessionId", "sess-9")
            put("createdAt", 100L)
            put(
                "rule",
                JSONObject().put(
                    "daily",
                    JSONObject().put("time", "09:00:00").put("time_zone", "Asia/Shanghai"),
                ),
            )
            put("nextAt", 1_700_000_000_000L)   // v1 的字段名
        }
        val rec = ScheduleRecord.fromJson(v1)
        assertNotNull(rec)
        assertEquals(ScheduleKind.daily, rec!!.kind)
        assertEquals("nextAt 必须迁移成 scheduledAt", 1_700_000_000_000L, rec.scheduledAt)
        assertEquals(
            "下划线时区必须迁移成 camelCase",
            "Asia/Shanghai",
            rec.rule.getJSONObject("daily").optString("timeZone"),
        )
        assertEquals("v1 没有 state → 默认 active", ScheduleRecord.STATE_ACTIVE, rec.state)
        assertTrue(rec.active)
    }

    @Test
    fun `不可解码的记录返回 null 由调用方隔离`() {
        assertNull(ScheduleRecord.fromJson(JSONObject().put("id", "x")))          // 缺 prompt/title
        assertNull(ScheduleRecord.fromJson(JSONObject().apply {                   // 缺时间
            put("id", "x"); put("title", "t"); put("prompt", "p")
            put("rule", JSONObject().put("after_seconds", 60))
        }))
    }
}
