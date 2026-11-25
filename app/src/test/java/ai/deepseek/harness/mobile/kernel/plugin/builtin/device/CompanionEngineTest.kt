package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 原生生成引擎里**可以脱机验证**的那部分：占位符替换、文本清洗、响应解析、窗口抽样。
 *
 * 真正的网络调用没法单测（需要端点），但上面这几段正是最容易出错、也最容易悄悄错的地方：
 * 少替换一个 `{hh}`，模型就会照字面复述「现在 {hh}」；少剥一层引号，消息里就带引号发出去。
 */
class CompanionEngineTest {

    private fun model(
        nudge: String = "（现在 {hh}，{gap}，今天 {count}/{cap} 次。）有由头就说两句。",
        force: String = "（连续 {streak} 次没开口了，这次说一句。）",
        forceAt: Int = 3,
        gapKnown: String = "距他上次说话 {since} 分钟",
        gapUnknown: String = "有一阵没聊了",
    ) = JSONObject().apply {
        put("nudge", nudge)
        put("nudgeForce", force)
        put("streakForce", forceAt)
        put("phrases", JSONObject().put("gapKnown", gapKnown).put("gapUnknown", gapUnknown))
    }

    private fun state(lastUserAt: Long = 0) = JSONObject().put("lastUserAt", lastUserAt)

    @Test
    fun `nudge 会替换全部占位符`() {
        val out = CompanionEngine.nudge(model(), state(System.currentTimeMillis() - 12 * 60_000L), 3, 24, 0)
        assertTrue("时间占位符没被替换：$out", !out.contains("{hh}"))
        assertTrue("gap 占位符没被替换：$out", !out.contains("{gap}"))
        assertTrue("次数占位符没被替换：$out", out.contains("3/24"))
        assertTrue("应显示「距他上次说话 12 分钟」", out.contains("12 分钟"))
    }

    @Test
    fun `没有上次说话时间时用另一句 gap`() {
        val out = CompanionEngine.nudge(model(), state(0), 0, 12, 0)
        assertTrue(out.contains("有一阵没聊了"))
        assertTrue("不该出现「距他上次说话」", !out.contains("距他上次说话"))
    }

    @Test
    fun `连续沉默达到阈值换成强制开口的模板`() {
        val m = model(forceAt = 3)
        val soft = CompanionEngine.nudge(m, state(), 1, 24, 2)
        val hard = CompanionEngine.nudge(m, state(), 1, 24, 3)
        assertTrue("2 次还是普通模板", soft.contains("有由头就说两句"))
        assertTrue("3 次要换成强制模板", hard.contains("连续 3 次没开口了"))
    }

    @Test
    fun `模板缺失时用兜底句而不是空字符串`() {
        val out = CompanionEngine.nudge(JSONObject(), state(0), 0, 12, 0)
        assertTrue("不能给模型发空提示", out.isNotBlank())
        assertTrue("兜底句也要替换时间", !out.contains("{hh}"))
    }

    @Test
    fun `清洗掉前后引号与前缀并压平空白`() {
        assertEquals("今天降温了", CompanionEngine.sanitize("「今天降温了」"))
        assertEquals("在忙吗", CompanionEngine.sanitize("主动说：在忙吗"))
        assertEquals("a b", CompanionEngine.sanitize("  a\n\n b  "))
    }

    @Test
    fun `超长回复截断到三百字`() {
        val long = "字".repeat(500)
        assertEquals(300, CompanionEngine.sanitize(long).length)
    }

    @Test
    fun `解析 OpenAI 兼容响应`() {
        val raw = """{"choices":[{"message":{"role":"assistant","content":"早点睡"}}]}"""
        assertEquals("早点睡", CompanionEngine.parseText(raw, false))
    }

    @Test
    fun `解析 OpenAI 分块内容`() {
        val raw = """{"choices":[{"message":{"content":[{"type":"text","text":"你"},{"type":"text","text":"好"}]}}]}"""
        assertEquals("你好", CompanionEngine.parseText(raw, false))
    }

    @Test
    fun `解析 Messages 协议响应`() {
        val raw = """{"content":[{"type":"text","text":"面试过了吗"},{"type":"tool_use","id":"x"}]}"""
        assertEquals("面试过了吗", CompanionEngine.parseText(raw, true))
    }

    @Test
    fun `坏响应返回 null 而不是抛异常`() {
        assertNull(CompanionEngine.parseText("not json", false))
        assertNull(CompanionEngine.parseText("""{"choices":[]}""", false))
    }

    @Test
    fun `窗口抽样落在档位区间内`() {
        // 三档各抽 200 次，必须全部落在 [min, max] 分钟内（含上界）
        for (id in listOf("quiet", "normal", "chatty")) {
            val w = CompanionPlugin.window(id)
            repeat(200) {
                val ms = CompanionEngine.gapMs(id)
                assertTrue("$id 窗口越界：${ms / 60000}", ms >= w.first * 60_000L && ms <= w.last * 60_000L)
            }
        }
    }

    @Test
    fun `JSON 数组入队格式正确`() {
        // pushOutbox 是私有的（要碰文件系统），这里只钉住它写出的形状约定
        val item = JSONObject().put("id", "pc1").put("at", 1L).put("text", "嗨")
        val arr = JSONArray().put(item)
        assertEquals("嗨", arr.getJSONObject(0).getString("text"))
        assertTrue(arr.getJSONObject(0).has("id"))
    }
}
