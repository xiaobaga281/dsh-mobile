package ai.deepseek.harness.mobile.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 轮次与 Mission 的三个新字段（missionId / wake / wakeId）。
 *
 * 不传时必须与旧包逐字节等价：不绑事、不算唤醒、日志仍写 source=human ——
 * 这是「唤醒续轮才带上下文」不破坏既有会话语义的前提。
 */
class MissionTurnConfigTest {

    @Test
    fun `不传 mission 字段时保持旧语义`() {
        val c = AgentConfig.parse(JSONObject())
        assertEquals("", c.missionId)
        assertFalse(c.wake)
        assertEquals("", c.wakeId)
    }

    @Test
    fun `唤醒轮带上事与唤醒记录`() {
        val c = AgentConfig.parse(JSONObject().apply {
            put("missionId", " job:job-1 ")
            put("wake", true)
            put("wakeId", "job:job-1:settled")
        })
        assertEquals("job:job-1", c.missionId)
        assertTrue(c.wake)
        assertEquals("job:job-1:settled", c.wakeId)
    }

    /** 唤醒注入的文本来自队列记录，正文与显示分开：这里只保证字段透传不丢。 */
    @Test
    fun `手动接着跑的一轮只带事不带唤醒`() {
        val c = AgentConfig.parse(JSONObject().apply { put("missionId", "schedule:sch-1") })
        assertEquals("schedule:sch-1", c.missionId)
        assertFalse(c.wake)
    }
}
