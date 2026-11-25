package ai.deepseek.harness.mobile.kernel.plugin.builtin.agent

import ai.deepseek.harness.mobile.agent.AgentConfig
import ai.deepseek.harness.mobile.agent.HookBus
import ai.deepseek.harness.mobile.agent.PromptAssembler
import ai.deepseek.harness.mobile.kernel.plugin.FakePluginContext
import ai.deepseek.harness.mobile.kernel.plugin.PluginHooks
import ai.deepseek.harness.mobile.kernel.plugin.tempDir
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * memory_save 写的是内核 memory.json，而 PromptAssembler 的记忆段来自前端 LocalDB。
 * 这里钉住两者的桥：内核写入必须在下一轮 runtime-context 里可见。
 */
class MemoryPromptBridgeTest {

    @Test
    fun `memory_save writes appear in runtime context`() {
        val bus = HookBus()
        val ctx = FakePluginContext(tempDir("memory-bridge"), PluginHooks(bus, "memory"))
        val plugin = MemoryPlugin()
        plugin.onLoad(ctx)
        val saved = plugin.tools.first { it.name == "memory_save" }.execute(
            JSONObject().put("text", "用户喜欢深色主题").put("scope", "global"),
        )
        assertTrue(saved, saved.contains("\"ok\":true"))

        val cfg = AgentConfig(sessionId = "s1", baseUrl = "", apiKey = "", model = "", userText = "")
        val hc = HookBus.HookContext("runtime-context/assemble").apply { put("cfg", cfg) }
        val out = bus.waterfall("runtime-context/assemble", PromptAssembler.Section(emptyList()), hc)
        val text = out.parts.joinToString("\n")
        assertTrue("内核记忆必须进入 runtime-context，实际=$text", text.contains("用户喜欢深色主题"))
        plugin.onUnload()
    }
}
