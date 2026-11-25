package ai.deepseek.harness.mobile.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WS3 压缩 / 溢出恢复的回归测试（纯 JVM）。
 *
 * 对齐桌面 compaction-basic 的三条契约：
 *   · 预算 = `min(W*0.8, W-maxOut-1024)`，下限 2048；
 *   · 溢出恢复**不看**普通阈值，但只有真的变小（shrunk）才允许调用方重发；
 *   · 本轮消息（keepFrom 之后）永远不被压缩带走 —— 否则模型会忘记自己刚做完的事。
 */
class CompactorOverflowTest {

    private fun msg(role: String, content: String): JSONObject =
        JSONObject().put("role", role).put("content", content)

    private fun longText(tag: String, cjk: Int): String = tag + "长".repeat(cjk)

    @Test
    fun `budget follows the desktop min rule`() {
        val c = Compactor()
        // 12000*0.8 = 9600；12000-2000-1024 = 8976 → 取小
        assertEquals(8976, c.budgetOf(12_000, 2_000, "auto"))
        // aggressive: 12000*0.7 = 8400 < 8976
        assertEquals(8400, c.budgetOf(12_000, 2_000, "aggressive"))
        // 预留比窗口还大时退回下限 2048
        assertEquals(2048, c.budgetOf(2_000, 10_000, "auto"))
    }

    @Test
    fun `overflow compacts the old prefix and keeps the pinned turn`() {
        val c = Compactor()
        val system = "你是助手"
        val prefix = (1..40).map { msg("user", longText("第${it}条", 1_200)) }
        val pinned = listOf(msg("user", "当前这句"), msg("assistant", "刚做完一步"))

        val r = c.compactForOverflow(
            llm = null,
            model = "m",
            system = system,
            messages = prefix + pinned,
            keepFrom = prefix.size,
            contextWindow = 4_096,
            maxOut = 1_024,
            mode = "auto",
        )

        assertTrue("溢出恢复必须产生真实缩减", r.shrunk)
        assertTrue(r.afterTokens < r.beforeTokens)
        assertTrue("必须丢掉了一些旧消息", r.dropped > 0)
        assertNotNull(r.note)
        assertEquals(
            listOf("当前这句", "刚做完一步"),
            r.messages.takeLast(2).map { it.optString("content") },
        )
    }

    @Test
    fun `compactInTurn keeps the pinned tail untouched`() {
        val c = Compactor()
        val history = (1..20).map { msg("user", longText("历史$it", 800)) }
        val pinned = listOf(msg("user", "本轮问题"), msg("assistant", "本轮回答"))

        val r = c.compactInTurn(
            llm = null,
            model = "m",
            system = "sys",
            messages = history + pinned,
            keepFrom = history.size,
            contextWindow = 4_096,
            maxOut = 1_024,
            mode = "auto",
        )

        assertTrue(r.shrunk)
        assertEquals(
            listOf("本轮问题", "本轮回答"),
            r.messages.takeLast(2).map { it.optString("content") },
        )
    }

    @Test
    fun `no removable prefix means no shrink so caller must not retry`() {
        val c = Compactor()
        val messages = listOf(msg("user", "当前这句"))
        val r = c.compactForOverflow(
            llm = null,
            model = "m",
            system = "s",
            messages = messages,
            keepFrom = 0,
            contextWindow = 4_096,
            maxOut = 1_024,
            mode = "auto",
        )
        assertFalse("没有可压缩的历史就不能重发（否则空烧额度）", r.shrunk)
    }

    @Test
    fun `off mode never compacts`() {
        val c = Compactor()
        val messages = listOf(msg("user", "x"))
        val r = c.compactForOverflow(
            llm = null,
            model = "m",
            system = "s",
            messages = messages,
            keepFrom = 0,
            contextWindow = 100_000,
            maxOut = 1_024,
            mode = "off",
        )
        assertFalse(r.shrunk)
    }

    @Test
    fun `within budget pressure compression is a no-op`() {
        val c = Compactor()
        val messages = listOf(msg("user", "短"), msg("assistant", "也短"))
        val r = c.compactInTurn(
            llm = null,
            model = "m",
            system = "s",
            messages = messages,
            keepFrom = 0,
            contextWindow = 128_000,
            maxOut = 4_096,
            mode = "auto",
        )
        assertFalse(r.shrunk)
        assertEquals(2, r.messages.size)
    }

    @Test
    fun `prune never folds the newest turn's tool results`() {
        val c = Compactor()
        // 每条 400 个 CJK 字 ≈ 401 tokens：> foldAbove(360) 可折，
        // 3 轮 × 6 条 ≈ 7238 tokens 超过预算(6064)，折掉 8 条早期输出后回落到预算内
        val big = longText("x", 400)
        fun toolTurn(tag: String) = listOf(msg("user", "问题$tag")) + (1..6).map { msg("tool", big) }
        val history = toolTurn("一") + toolTurn("二") + toolTurn("三")

        val r = c.applySmart(
            llm = null, model = "m", system = "sys",
            history = history, userText = "新问题",
            contextWindow = 8_192, maxOut = 1_024, mode = "auto",
        )

        // 只剪枝、不丢消息：dropped=0 且走的是折叠路径
        assertEquals(0, r.dropped)
        assertTrue("应折叠早期工具输出", r.folded > 0)
        assertEquals(8, r.folded)
        // 最后一轮（最后一条 user 之后）的工具输出一个字都不能折 —— 折掉模型下一步就失忆
        val lastTurnTools = r.messages
            .dropLast(1) // pinned 的 userText
            .takeLastWhile { it.optString("role") != "user" || it.optString("content") != "问题三" }
        assertTrue(
            "最后一轮的 6 条工具输出必须原文保留",
            lastTurnTools.filter { it.optString("role") == "tool" }.all { it.optString("content") == big },
        )
        // 更早的轮次确实有被折的
        assertTrue(
            r.messages.any { it.optString("role") == "tool" && it.optString("content").contains("已折叠") },
        )
    }
}
