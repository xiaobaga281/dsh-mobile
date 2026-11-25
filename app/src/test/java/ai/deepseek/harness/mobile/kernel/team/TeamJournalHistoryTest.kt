package ai.deepseek.harness.mobile.kernel.team

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 队友历史结构化（TeamJournal.memberHistory）。
 *
 * 「文本级历史」的代价：冷恢复的队友不知道自己上轮调了什么工具、用了什么参数、
 * 看不到真实输出，甚至对话结构无效（工具结果伪装成 user 消息）。
 * 这里钉住：新日志重建出**与主会话 messages 同构**的结构化消息
 * （assistant 轮带 tool_calls、role=tool 配对 tool_call_id），旧格式日志保持文本近似兼容。
 */
class TeamJournalHistoryTest {

    private fun journal(dir: File): TeamJournal =
        TeamJournal(ai.deepseek.harness.mobile.agent.SessionStore(File(dir, "sessions")))

    private fun dir(): File = java.nio.file.Files.createTempDirectory("teamjournal").toFile()

    @Test
    fun `结构化重建 - assistant 带 tool_calls 与 role tool 配对`() {
        val d = dir()
        val j = journal(d)
        val sid = "lead#worker"
        j.userTurn(sid, "整理 /data 下的日志", from = "lead", strict = true)

        // 第一轮：assistant 带两个 tool_calls
        val wire = JSONArray()
        wire.put(JSONObject().put("id", "t1").put("type", "function")
            .put("function", JSONObject().put("name", "bash")
                .put("arguments", JSONObject().put("command", "ls /data").toString())))
        wire.put(JSONObject().put("id", "t2").put("type", "function")
            .put("function", JSONObject().put("name", "read")
                .put("arguments", JSONObject().put("path", "/data/a.log").toString())))
        j.assistantTurn(sid, "", wire = wire)
        j.toolExec(sid, "t1", "bash", true,
            JSONObject().put("command", "ls /data"), "total 3\na.log")
        j.toolExec(sid, "t2", "read", true,
            JSONObject().put("path", "/data/a.log"), "2026-10-31 INFO 启动完成")

        // 第二轮：assistant 纯文本收尾
        j.assistantTurn(sid, "整理完成，共 3 个文件。")

        val h = j.memberHistory(sid)
        assertEquals(5, h.size)
        assertEquals("user", h[0].optString("role"))
        // assistant 带 tool_calls
        val a1 = h[1]
        assertEquals("assistant", a1.optString("role"))
        val wire2 = a1.optJSONArray("tool_calls")
        assertTrue("assistant 轮必须带 tool_calls", wire2 != null && wire2.length() == 2)
        assertEquals("t1", wire2!!.optJSONObject(0)?.optString("id"))
        // role=tool 配对
        assertEquals("tool", h[2].optString("role"))
        assertEquals("t1", h[2].optString("tool_call_id"))
        assertTrue("工具输出应是真实全文", h[2].optString("content").contains("a.log"))
        assertEquals("tool", h[3].optString("role"))
        assertEquals("t2", h[3].optString("tool_call_id"))
        assertTrue("输出全文可读", h[3].optString("content").contains("启动完成"))
        assertEquals("assistant", h[4].optString("role"))
        assertNull("纯文本轮不带 tool_calls", h[4].optJSONArray("tool_calls"))
        d.deleteRecursively()
    }

    @Test
    fun `补充消息落日志 - 冷恢复后仍在历史里`() {
        val d = dir()
        val j = journal(d)
        val sid = "lead#w2"
        j.userTurn(sid, "初始任务", from = "lead", strict = true)
        // Lead 中途补充（runMember 认领 inbox 时落日志）
        j.userTurn(sid, "（lead 补充）优先处理 error 级别", from = "lead")

        val h = j.memberHistory(sid)
        assertEquals(2, h.size)
        assertTrue("补充消息在历史里", h[1].optString("content").contains("优先处理 error 级别"))
        d.deleteRecursively()
    }

    @Test
    fun `旧格式日志保持文本近似兼容`() {
        val d = dir()
        val store = ai.deepseek.harness.mobile.agent.SessionStore(File(d, "sessions"))
        val sid = "lead#old"
        // 手写旧格式：tool/result 无 id 只有 meta；assistant/message 无 wire
        store.appendOrThrow(sid, "user/message", JSONObject().put("text", "查一下"))
        store.appendOrThrow(sid, "tool/result", JSONObject()
            .put("name", "web_search").put("ok", true).put("text", "web_search 查询x"))
        store.appendOrThrow(sid, "assistant/message", JSONObject().put("text", "查到了"))

        val h = journal(d).memberHistory(sid)
        assertEquals(3, h.size)
        assertEquals("user", h[1].optString("role"))
        assertTrue("旧格式文本近似", h[1].optString("content").contains("web_search"))
        assertNull("旧 assistant 不带 tool_calls", h[2].optJSONArray("tool_calls"))
        d.deleteRecursively()
    }

    @Test
    fun `limit 截断保留最近的尾部`() {
        val d = dir()
        val j = journal(d)
        val sid = "lead#w3"
        repeat(5) { i -> j.userTurn(sid, "任务$i", from = "lead", strict = i == 0) }
        val h = j.memberHistory(sid, limit = 2)
        assertEquals(2, h.size)
        assertTrue("保留的是尾部", h[1].optString("content").contains("任务4"))
        d.deleteRecursively()
    }
}
