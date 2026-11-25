package ai.deepseek.harness.mobile.kernel.plugin

import ai.deepseek.harness.mobile.kernel.plugin.builtin.doc.ImagePlugin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ToolCatalog ↔ 插件注册一致性自检（对应内核启动时的 validate/orphans 检查，
 * 在 JVM 侧用可以脱离 Android 实例化的插件先盯住最容易漏的横切属性）。
 *
 * rc.97 新增 chart_generate / qr_generate 时差点漏 ToolCatalog 登记 ——
 * 这两个测试保证「新工具必须登记、登记了必须真实存在」再也不会静默漂移。
 */
class ToolCatalogAuditTest {

    private val imageTools = ImagePlugin().tools.map { it.name }

    @Test
    fun `image plugin tools are all registered in catalog`() {
        val unregistered = ToolCatalog.validate(imageTools)
        assertTrue("未登记的工具：$unregistered", unregistered.isEmpty())
    }

    @Test
    fun `catalog has no dead image-plugin entries`() {
        val orphans = ToolCatalog.orphans(imageTools).filter {
            // orphans 是全表对插件名的差集，这里只校验 image 插件名下应存在的条目
            it in setOf("image_generate", "chart_generate", "qr_generate", "mindmap_generate", "flowchart_generate")
        }
        assertTrue("目录里有死条目：$orphans", orphans.isEmpty())
    }

    @Test
    fun `chart qr mindmap flowchart are registered exactly once under MEDIA`() {
        // 顺序敏感：新工具必须按此序追加在 image_generate 之后（probe 在最前，chart 系随后）
        assertEquals(listOf("probe_image_endpoint", "chart_generate", "qr_generate", "mindmap_generate", "flowchart_generate"), imageTools.drop(1))
        for (name in listOf("probe_image_endpoint", "chart_generate", "qr_generate", "mindmap_generate", "flowchart_generate")) {
            // of() 对未登记名字返回 PLUGIN 组兜底 —— 组不对即视为未登记
            val meta = ToolCatalog.of(name)
            assertEquals("$name 未按 MEDIA 组登记", ToolGroup.MEDIA, meta.group)
        }
        // probe_* 是纯只读探测（校验错误驱动，不写文件），chart 系会写 SVG 文件
        assertTrue("probe_image_endpoint 应标只读", ToolCatalog.of("probe_image_endpoint").readOnly)
        for (name in listOf("chart_generate", "qr_generate", "mindmap_generate", "flowchart_generate")) {
            assertTrue("$name 会写文件，不该标只读", !ToolCatalog.of(name).readOnly)
        }
    }
}
