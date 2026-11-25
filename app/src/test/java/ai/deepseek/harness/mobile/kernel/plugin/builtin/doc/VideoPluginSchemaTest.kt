package ai.deepseek.harness.mobile.kernel.plugin.builtin.doc

import ai.deepseek.harness.mobile.kernel.GenProbe
import ai.deepseek.harness.mobile.kernel.plugin.FakePluginContext
import ai.deepseek.harness.mobile.kernel.plugin.tempDir
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * video_generate 的 mode 枚举必须来自探测契约，不能靠写死的方言清单。
 * 这里直接构造插件（无网络）检查真实生成的 schema。
 */
class VideoPluginSchemaTest {

    @Test
    fun `没有契约时 mode 不编造枚举`() {
        val plugin = VideoPlugin()
        plugin.onLoad(FakePluginContext(tempDir("video-schema")))
        val mode = plugin.tools.first { it.name == "video_generate" }
            .parameters.getJSONObject("properties").getJSONObject("mode")
        assertFalse("没有探测契约时不能给出 text2video/image2video 这种猜测枚举", mode.has("enum"))
        assertTrue(mode.getString("description").contains("probe_gen_endpoint"))
        plugin.onUnload()
    }

    @Test
    fun `枚举只来自探测习得的契约`() {
        val ws = tempDir("video-schema-contract")
        File(ws, "gen.json").writeText(
            """{"video":{"url":"https://api.example/v1","model":"m","capabilities":""" +
                """{"modes":["text","reference"],"modeRequired":true,"sizes":["720P"]}}}""",
            Charsets.UTF_8,
        )
        val plugin = VideoPlugin()
        plugin.onLoad(FakePluginContext(ws))
        val mode = plugin.tools.first { it.name == "video_generate" }
            .parameters.getJSONObject("properties").getJSONObject("mode")
        val enum = mode.getJSONArray("enum")
        val values = (0 until enum.length()).map { enum.optString(it) }
        assertEquals(listOf("text", "reference"), values)
        assertFalse("不能混入未被端点确认的 text2video", values.contains("text2video"))
        val props = plugin.tools.first { it.name == "video_generate" }.parameters.getJSONObject("properties")
        assertTrue("长任务必须能后台化", props.has("run_in_background"))
        plugin.onUnload()
    }

    @Test
    fun `auto 只为有参考图的请求挑契约里的图生模式`() {
        val cap = GenProbe.Contract(listOf("text", "reference"), modeRequired = true, sizes = emptyList(), traces = emptyList())
        assertEquals("reference", VideoPlugin.autoModeFor(imageProvided = true, cap = cap))
        assertEquals("auto", VideoPlugin.autoModeFor(imageProvided = false, cap = cap))
        assertEquals("auto", VideoPlugin.autoModeFor(imageProvided = true, cap = null))
        assertTrue(VideoPlugin.modeEnum(null).isEmpty())
    }
}
