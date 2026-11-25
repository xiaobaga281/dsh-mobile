package ai.deepseek.harness.mobile.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 工具名清洗。
 *
 * 背景：模型流里 `"function": {"name": null}` 在 Android org.json 上经 `optString`
 * 会变成**字符串 "null"**；不清洗就会被当成工具名去执行，报「工具名不合法：\"null\"」
 * （用户实测：团队工具中途冒出这句）。JVM 版 org.json 对 NULL 返回 ""，与设备行为不同，
 * 所以这里只钉清洗函数本身的行为，不依赖那家实现的差异。
 */
class ToolNameSanitizeTest {

    @Test
    fun `字符串 null 与 undefined 一律当缺失`() {
        assertEquals("", toolNameOf("null"))
        assertEquals("", toolNameOf("NULL"))
        assertEquals("", toolNameOf(" undefined "))
        assertEquals("", toolNameOf(null))
        assertEquals("", toolNameOf(""))
        assertEquals("", toolNameOf("   "))
    }

    @Test
    fun `正常工具名原样保留`() {
        assertEquals("spawn_teammate", toolNameOf(" spawn_teammate "))
        assertEquals("team_status", toolNameOf("team_status"))
        assertEquals("run_code", toolNameOf("run_code"))
    }

    @Test
    fun `从 JSON 里读出来的字符串 null 也会被清洗`() {
        val fn = JSONObject().put("name", "null")
        assertEquals("", toolNameOf(fn.optString("name")))
    }

    @Test
    fun `后续 chunk 的 null 不会覆盖已经拿到的名字`() {
        // 实测故障：第一段给了 team_status，第二段带 "name": null，
        // 旧逻辑把名字覆盖成 "null" → 执行时报「工具名不合法："null"」
        assertEquals("team_status", mergeToolCallName("team_status", "null"))
        assertEquals("team_status", mergeToolCallName("team_status", null))
        assertEquals("team_status", mergeToolCallName("team_status", ""))
        assertEquals("spawn_teammate", mergeToolCallName("", "spawn_teammate"))
        assertEquals("spawn_teammate", mergeToolCallName("", " spawn_teammate "))
    }
}
