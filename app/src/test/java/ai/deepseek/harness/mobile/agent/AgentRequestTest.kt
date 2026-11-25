package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 三条请求循环共用的两个纯函数：窗口算法与请求体。
 *
 * 回归的是实测撞到的坑：预算各写一遍时，子代理压 4096、成员压 8192，
 * 推理型模型把预算全花在「想」上、永远没结论。
 */
class AgentRequestTest {

    @Test
    fun effWindowSubtractsToolCatalogWithFloor() {
        // 128k 窗口 + 165 个工具 ≈ 18k 目录：剩下的才是历史可用量
        assertEquals(131072 - 165 * AgentRequest.TOKENS_PER_TOOL,
            AgentRequest.effWindow(131072, 165))
        // 小窗口装不下目录时保底 2048，不能算出负数
        assertEquals(AgentRequest.MIN_WINDOW, AgentRequest.effWindow(8192, 165))
    }

    @Test
    fun bodyCarriesModelBudgetAndTools() {
        val defs = JSONArray().put(JSONObject().put("type", "function"))
        val b = AgentRequest.body("m1", listOf(JSONObject().put("role", "user")), 65536, defs)
        assertEquals("m1", b.getString("model"))
        assertEquals(65536, b.getInt("max_tokens"))
        assertTrue(b.getBoolean("stream"))
        assertEquals(1, b.getJSONArray("messages").length())
        assertEquals("auto", b.getString("tool_choice"))
    }

    @Test
    fun bodyOmitsToolsWhenCatalogEmpty() {
        val b = AgentRequest.body("m1", emptyList(), 4096, null)
        assertFalse(b.has("tools"))
        assertFalse(b.has("tool_choice"))
    }
}
