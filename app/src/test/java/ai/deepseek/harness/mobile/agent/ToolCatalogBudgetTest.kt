package ai.deepseek.harness.mobile.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工具目录按**设置里的上下文窗口**分档 —— 主对话、子代理、成员共用这一个口径。
 *
 * 为什么值得钉住：目录里上百个 schema 每个约 110 token，小窗口端点连目录都装不下，
 * 每一发请求都被直接 400 掉；只有一方裁剪而另两方不裁，用户看到的就是
 * 「子代理/成员老是处理失败」（本地 llama.cpp 8k 端点实测就是这个形状）。
 */
class ToolCatalogBudgetTest {

    @Test
    fun tiersByWindow() {
        assertEquals(Presets.CORE_TOOLS, Presets.catalogFor(8192))
        assertEquals(Presets.CORE_TOOLS, Presets.catalogFor(12_288))
        assertEquals(Presets.MID_TOOLS, Presets.catalogFor(12_289))
        assertEquals(Presets.MID_TOOLS, Presets.catalogFor(32_768))
        assertNull(Presets.catalogFor(32_769))
    }

    @Test
    fun coreKeepsWhatASmallModelActuallyNeeds() {
        // 小窗口下这几样必须在：没有 bash/read/write 就等于只能聊天，没有 subagent 就等于派不出去
        assertTrue(Presets.CORE_TOOLS.containsAll(listOf("bash", "read", "write", "edit", "subagent", "present")))
        // 中档必须是核心档的超集，否则调大窗口反而少工具
        assertTrue(Presets.MID_TOOLS.containsAll(Presets.CORE_TOOLS))
    }
}
