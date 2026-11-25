package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * WS1「日志即上下文」的回归测试（纯 JVM，不碰 Android）。
 *
 * 盯的是三件会让模型「记错事」的事：
 *   · v2 日志里的 tool_call / tool/result 必须成对派生出来（否则下一轮模型不知道
 *     自己上一步做了什么）；
 *   · v1 旧日志（没有工具正文）只能降级成纯文本历史，且**绝不能**凭空补出一次
 *     工具调用或留下孤立 tool 消息（OpenAI 兼容端点会 400）；
 *   · v1→v2 迁移是只读 + 幂等：旧文件一字不改，重复启动不会多出第二份。
 */
class SessionStoreTest {

    private fun dir(): File = Files.createTempDirectory("dsh-session-test").toFile()

    private fun ev(type: String, vararg fields: Pair<String, Any?>): JSONObject = JSONObject().apply {
        put("type", type)
        fields.forEach { (k, v) -> put(k, v) }
    }

    private fun writeV1(dir: File, sid: String, vararg events: JSONObject) {
        File(dir, "$sid.jsonl").writeText(events.joinToString("\n") { it.toString() } + "\n")
    }

    private fun roles(messages: List<JSONObject>): List<String> = messages.map { it.optString("role") }

    @Test
    fun `deriveMessages keeps a tool call and its result paired`() {
        val store = SessionStore(dir())
        val sid = "s-tools"
        store.append(sid, "system/message", JSONObject().put("text", "SYS"))
        store.append(sid, "user/message", JSONObject().put("text", "看看这个文件"))
        store.append(sid, "assistant/message", JSONObject().apply {
            put("turn", 1); put("step", 1)
            put("message", JSONObject().put("content", JSONArray().apply {
                put(JSONObject().put("type", "text").put("text", "我读一下"))
                put(JSONObject().apply {
                    put("type", "tool_call")
                    put("id", "call_1")
                    put("name", "read")
                    put("arguments", """{"file_path":"a.kt"}""")
                })
            }))
        })
        store.append(sid, "tool/result", JSONObject().apply {
            put("turn", 1); put("step", 1)
            put("message", JSONObject().apply {
                put("toolCallId", "call_1")
                put("isError", false)
                put("content", JSONArray().put(JSONObject().put("type", "text").put("text", "FILE BODY")))
            })
        })

        val msgs = store.deriveMessages(sid)
        assertEquals(listOf("system", "user", "assistant", "tool"), roles(msgs))
        assertEquals("我读一下", msgs[2].optString("content"))
        val call = msgs[2].optJSONArray("tool_calls")!!.optJSONObject(0)!!
        assertEquals("call_1", call.optString("id"))
        assertEquals("read", call.optJSONObject("function")!!.optString("name"))
        assertEquals("""{"file_path":"a.kt"}""", call.optJSONObject("function")!!.optString("arguments"))
        assertEquals("call_1", msgs[3].optString("tool_call_id"))
        assertEquals("FILE BODY", msgs[3].optString("content"))
    }

    @Test
    fun `orphan tool result from a v1 log never becomes a tool message`() {
        val d = dir()
        writeV1(
            d, "old",
            ev("user/message", "text" to "hi"),
            ev("assistant/message", "text" to "hello"),
            ev("tool/result", "name" to "read", "ok" to true),
        )
        val store = SessionStore(d)
        val msgs = store.deriveMessages("old")
        assertEquals(listOf("user", "assistant"), roles(msgs))
        assertFalse(msgs.any { it.optString("role") == "tool" })
    }

    @Test
    fun `v1 migration is read only and idempotent`() {
        val d = dir()
        writeV1(
            d, "s",
            ev("user/message", "text" to "第一句"),
            ev("assistant/message", "text" to "第一答"),
        )
        val original = File(d, "s.jsonl").readText()
        val store = SessionStore(d)
        assertEquals(1, store.formatVersion("s"))

        store.append("s", "user/message", JSONObject().put("text", "第二句"))
        assertEquals(2, store.formatVersion("s"))
        // 旧文件必须一字未改（只读复制，不迁移原地）
        assertEquals(original, File(d, "s.jsonl").readText())
        assertEquals(listOf("user", "assistant", "user"), roles(store.deriveMessages("s")))
        assertEquals(1, File(d, "s.v2.jsonl").readLines().count {
            JSONObject(it).optString("type") == "history/degraded"
        })

        // 再启动一次：迁移不重复、降级标记只有一条
        store.append("s", "user/message", JSONObject().put("text", "第三句"))
        assertEquals(1, File(d, "s.v2.jsonl").readLines().count {
            JSONObject(it).optString("type") == "history/degraded"
        })
        assertEquals(listOf("user", "assistant", "user", "user"), roles(store.deriveMessages("s")))
    }

    @Test
    fun `interrupted assistant message without content is not model visible`() {
        val store = SessionStore(dir())
        val sid = "s-interrupted"
        store.append(sid, "user/message", JSONObject().put("text", "问"))
        store.append(sid, "assistant/message", JSONObject().apply {
            put("interrupted", true)
            put("message", JSONObject().put("content", JSONArray()))
        })
        assertEquals(listOf("user"), roles(store.deriveMessages(sid)))

        store.append(sid, "assistant/message", JSONObject().apply {
            put("interrupted", true)
            put("message", JSONObject().put("content", JSONArray().put(
                JSONObject().put("type", "text").put("text", "只说了半句"),
            )))
        })
        val msgs = store.deriveMessages(sid)
        assertEquals(listOf("user", "assistant"), roles(msgs))
        assertEquals("只说了半句", msgs[1].optString("content"))
    }

    @Test
    fun `listSessions reports one row when v1 and v2 coexist`() {
        val d = dir()
        writeV1(d, "a", ev("user/message", "text" to "x"))
        val store = SessionStore(d)
        store.append("a", "user/message", JSONObject().put("text", "y"))
        store.append("b", "user/message", JSONObject().put("text", "z"))
        val ids = (0 until store.listSessions().length()).map {
            store.listSessions().optJSONObject(it).optString("id")
        }.sorted()
        assertEquals(listOf("a", "b"), ids)
    }

    @Test
    fun `derive trims to limit without leaving an orphan tool message at the head`() {
        val store = SessionStore(dir())
        val sid = "s-limit"
        store.append(sid, "user/message", JSONObject().put("text", "旧"))
        store.append(sid, "assistant/message", JSONObject().apply {
            put("message", JSONObject().put("content", JSONArray().put(JSONObject().apply {
                put("type", "tool_call"); put("id", "c1"); put("name", "read"); put("arguments", "{}")
            })))
        })
        store.append(sid, "tool/result", JSONObject().put("message", JSONObject().apply {
            put("toolCallId", "c1"); put("isError", false)
            put("content", JSONArray().put(JSONObject().put("type", "text").put("text", "R")))
        }))
        store.append(sid, "user/message", JSONObject().put("text", "新"))
        val msgs = store.deriveMessages(sid, limit = 1)
        assertTrue(msgs.isNotEmpty())
        assertFalse(msgs.first().optString("role") == "tool")
    }

    // ---- roundTrace：回来时按日志重放这一轮（过程组与工具行都要在） ----

    private fun toolResult(callId: String, text: String, ok: Boolean, ms: Long = 12L) =
        JSONObject().apply {
            put("id", callId); put("name", "bash"); put("ok", ok); put("ms", ms)
            put("message", JSONObject().put("toolCallId", callId).put("isError", !ok)
                .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", text))))
        }

    @Test
    fun `roundTrace 只给最后一轮并按日志顺序出段`() {
        val store = SessionStore(dir())
        val sid = "s-trace"
        // 上一轮：不该出现在回放里
        store.append(sid, "turn/start", JSONObject().put("turn", 1).put("text", "第一轮"))
        store.append(sid, "assistant/message", JSONObject().put("turn", 1).put("text", "上一轮的答复"))
        // 这一轮
        store.append(sid, "turn/start", JSONObject().put("turn", 2).put("text", "看下目录再写文件"))
        store.append(sid, "step/start", JSONObject().put("round", 1))
        Thread.sleep(40)     // 让日志里首尾 ts 真的差出几十毫秒，ms 才不是恒 0
        store.append(sid, "assistant/message", JSONObject().apply {
            put("turn", 2); put("step", 1); put("text", "先看目录")
            put("reasoning", "要想两步"); put("promptTokens", 10); put("completionTokens", 4)
        })
        store.append(sid, "tool/call", JSONObject().put("turn", 2).put("step", 1)
            .put("id", "c1").put("name", "bash").put("arguments", """{"command":"ls -1"}"""))
        store.append(sid, "tool/result", toolResult("c1", "a.txt\nb.txt", ok = true))
        store.append(sid, "step/start", JSONObject().put("round", 2))
        store.append(sid, "assistant/message", JSONObject().put("turn", 2).put("step", 2).put("text", "两个文件"))

        val t = store.roundTrace(sid)
        assertTrue("有可回放段：$t", t.optBoolean("ok"))
        val segs = t.optJSONArray("segments")
        val kinds = (0 until segs.length()).map { segs.getJSONObject(it).optString("t") }
        assertEquals(listOf("reasoning", "delta", "tool_start", "tool_end", "delta"), kinds)
        assertEquals("两个文件", t.optString("text"))
        assertEquals(2, t.optInt("steps"))
        assertEquals(14, t.optInt("tokens"))
        // 折叠那一行会写「已完成，用时 N 秒」：时长必须真从日志 ts 算出来，不能恒 0
        assertTrue("重放段要带这一轮的时长：$t", t.optLong("ms") >= 30)
        val call = segs.getJSONObject(2)
        assertEquals("c1", call.optString("id"))
        assertEquals("""{"command":"ls -1"}""", call.optString("args"))
        assertEquals("a.txt\nb.txt", segs.getJSONObject(3).optString("output"))
    }

    @Test
    fun `roundTrace 空会话与旧日志给 ok=false 而不是空段骗页面重放`() {
        val store = SessionStore(dir())
        assertFalse(store.roundTrace("s-none").optBoolean("ok"))
        val sid = "s-no-turn"
        store.append(sid, "assistant/message", JSONObject().put("text", "没有 turn/start 的旧日志"))
        assertFalse(store.roundTrace(sid).optBoolean("ok"))
    }

    @Test
    fun `roundTrace 保住失败工具的结果与 ok 标记`() {
        val store = SessionStore(dir())
        val sid = "s-fail"
        store.append(sid, "turn/start", JSONObject().put("turn", 1).put("text", "跑一条会失败的命令"))
        store.append(sid, "tool/call", JSONObject().put("id", "c9").put("name", "bash")
            .put("arguments", """{"command":"false"}"""))
        store.append(sid, "tool/result", toolResult("c9", "Error: 命令退出码 1", ok = false, ms = 30L))
        val segs = store.roundTrace(sid).optJSONArray("segments")
        val end = segs.getJSONObject(1)
        assertEquals("tool_end", end.optString("t"))
        assertFalse(end.optBoolean("ok", true))
        assertEquals(30L, end.optLong("ms"))
        assertEquals("Error: 命令退出码 1", end.optString("output"))
    }

    @Test
    fun `删除会话把两种格式的日志一起清掉且不留活口`() {
        val store = SessionStore(dir())
        val sid = "s-gone"
        store.append(sid, "user/message", JSONObject().put("text", "要被删掉的一场"))
        store.append(sid, "assistant/message", JSONObject().put("text", "回复"))
        assertEquals("删之前该有 v2 日志", 2, store.formatVersion(sid))

        assertTrue(store.delete(sid))
        assertTrue("删完读不出任何东西", store.read(sid).isEmpty())
        assertFalse("fileIds 还留着已删的会话", store.fileIds().contains(sid))
        // 再删一次：没东西可删，老实返回 false（调用方据此不把这一样计入「清了几样」）
        assertFalse(store.delete(sid))
    }

    @Test
    fun `删掉的会话不会因为写句柄没关而复活`() {
        val store = SessionStore(dir())
        val sid = "s-revive"
        store.append(sid, "user/message", JSONObject().put("text", "旧的那半截"))   // 这一步会留下打开的 writer
        assertTrue(store.delete(sid))
        store.append(sid, "user/message", JSONObject().put("text", "新的一轮"))
        val texts = store.read(sid).map { it.optString("text") }
        assertEquals("删除后还留着旧内容 = 句柄没关，文件原地复活", listOf("新的一轮"), texts)
    }
}
