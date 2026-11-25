package ai.deepseek.harness.mobile.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * WS1 历史来源策略：日志优先，前端历史只在日志为空时兜底。
 *
 * 这条策略决定「模型看到的是不是它上一次真的做过的事」。抽成纯函数后，
 * 迁移期/首轮/空日志三种分支都能在 JVM 里断言，不必启动整机。
 */
class AgentDriverHistoryTest {

    private fun user(content: String): JSONObject =
        JSONObject().put("role", "user").put("content", content)

    @Test
    fun `log history wins over the client supplied history`() {
        val fromLog = listOf(user("来自日志"))
        val legacy = listOf(user("来自前端"))
        val picked = HistoryPolicy.pick(fromLog, legacy)
        assertFalse(picked.degraded)
        assertEquals(1, picked.messages.size)
        assertEquals("来自日志", picked.messages[0].optString("content"))
    }

    @Test
    fun `empty log falls back to client history and is marked degraded`() {
        val picked = HistoryPolicy.pick(emptyList(), listOf(user("来自前端")))
        assertTrue(picked.degraded)
        assertEquals("来自前端", picked.messages[0].optString("content"))
    }

    @Test
    fun `first turn with neither source is not degraded`() {
        val picked = HistoryPolicy.pick(emptyList(), emptyList())
        assertFalse(picked.degraded)
        assertTrue(picked.messages.isEmpty())
    }

    @Test
    fun `degraded log writes a history marker via the session store`() {
        // 端到端半步：日志为空 + 前端有历史时，调用方应写 history/degraded，
        // 让后续回放知道这一段历史不是从日志派生的。
        val dir = Files.createTempDirectory("dsh-history-test").toFile()
        val store = SessionStore(dir)
        val sid = "s-degraded"
        val picked = HistoryPolicy.pick(store.deriveMessages(sid), listOf(user("旧前端历史")))
        if (picked.degraded) {
            store.append(sid, "history/degraded", JSONObject().apply {
                put("reason", "log_empty_use_client_history")
                put("count", 1)
            })
        }
        val marker = store.read(sid).last { it.optString("type") == "history/degraded" }
        assertEquals("log_empty_use_client_history", marker.optString("reason"))
        assertFalse("降级标记本身不能变成模型消息", store.deriveMessages(sid).any { it.optString("role") == "history/degraded" })
    }

    @Test
    fun `derived history is stable across a fresh store instance`() {
        val dir: File = Files.createTempDirectory("dsh-history-reopen").toFile()
        val sid = "s-reopen"
        SessionStore(dir).apply {
            append(sid, "system/message", JSONObject().put("text", "SYS"))
            append(sid, "user/message", JSONObject().put("text", "同一句"))
            append(sid, "assistant/message", JSONObject().put("message", JSONObject()
                .put("content", org.json.JSONArray().put(
                    JSONObject().put("type", "text").put("text", "同一答"),
                ))))
        }
        val before = SessionStore(dir).deriveMessages(sid).map { it.toString() }
        val after = SessionStore(dir).deriveMessages(sid).map { it.toString() }
        assertEquals(before, after)
        assertEquals(3, after.size)
    }
}
