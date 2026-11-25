package ai.deepseek.harness.mobile.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 子代理模型分档（Lead 用强模型、工人用便宜模型）。
 *
 * 全是空串时必须与以前逐字节等价——跟随父级、不改端点，这是升级不回归的前提。
 */
class AgentConfigSubagentModelTest {

    @Test
    fun `未配置子代理档时完全跟随父级`() {
        val c = AgentConfig.parse(JSONObject())
        assertEquals("", c.subagentModel)
        assertEquals("", c.subagentUrl)
        assertEquals("", c.subagentKey)
        // 跟随语义：空串 → 用父级 model/baseUrl/apiKey
        assertEquals(c.model, c.subagentModel.ifBlank { c.model })
        assertEquals(c.baseUrl, c.subagentUrl.ifBlank { c.baseUrl })
        assertEquals(c.apiKey, c.subagentKey.ifBlank { c.apiKey })
    }

    @Test
    fun `配置后子代理档生效且不影响主 Agent`() {
        val c = AgentConfig.parse(JSONObject().apply {
            put("model", "strong-lead")
            put("subagentModel", "cheap-worker")
            put("subagentUrl", "https://cheap.example/v1")
            put("subagentKey", "sk-cheap")
        })
        assertEquals("strong-lead", c.model)
        assertEquals("cheap-worker", c.subagentModel.ifBlank { c.model })
        assertEquals("https://cheap.example/v1", c.subagentUrl.ifBlank { c.baseUrl })
        assertEquals("sk-cheap", c.subagentKey.ifBlank { c.apiKey })
    }
}