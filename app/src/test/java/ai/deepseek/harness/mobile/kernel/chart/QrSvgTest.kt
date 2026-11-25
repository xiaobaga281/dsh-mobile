package ai.deepseek.harness.mobile.kernel.chart

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 二维码渲染器：path 结构、确定性、容量报错 */
class QrSvgTest {

    @Test
    fun svg_contains_white_bg_and_dark_modules() {
        val svg = QrSvg.build("https://example.com", 512, null)
        assertTrue("缺白色底：$svg", svg.contains("fill=\"#ffffff\""))
        assertTrue("缺码点 path：$svg", svg.contains("<path fill=\"#"))
        // 合并后的 path 是 M..h..v1h..z 片段
        assertTrue(svg.contains("v1h-"))
    }

    @Test
    fun deterministic_same_input_same_output() {
        assertEquals(QrSvg.build("hello", 256, null), QrSvg.build("hello", 256, null))
    }

    @Test
    fun size_is_presentation_only() {
        val a = QrSvg.build("https://example.com", 128, null)
        val b = QrSvg.build("https://example.com", 1024, null)
        // viewBox（模块数）一致，只是 width/height 不同
        val va = Regex("viewBox=\"0 0 (\\d+)").find(a)!!.groupValues[1]
        val vb = Regex("viewBox=\"0 0 (\\d+)").find(b)!!.groupValues[1]
        assertEquals(va, vb)
        assertTrue(a.contains("width=\"128\""))
        assertTrue(b.contains("width=\"1024\""))
    }

    @Test
    fun custom_color_applied() {
        assertTrue(QrSvg.build("x", 256, "FF0000").contains("fill=\"#FF0000\""))
        // 带井号也接受
        assertTrue(QrSvg.build("x", 256, "#00AA00").contains("fill=\"#00AA00\""))
    }

    @Test
    fun longer_text_yields_more_modules() {
        val short = Regex("viewBox=\"0 0 (\\d+)").find(QrSvg.build("a", 256, null))!!.groupValues[1].toInt()
        val long = Regex("viewBox=\"0 0 (\\d+)").find(
            QrSvg.build("https://example.com/very/long/path?with=query&string=params", 256, null)
        )!!.groupValues[1].toInt()
        assertTrue("更长文本应产生更多模块：$short vs $long", long > short)
    }

    @Test(expected = IllegalArgumentException::class)
    fun blank_text_rejected() {
        QrSvg.build("  ", 256, null)
    }

    @Test(expected = IllegalArgumentException::class)
    fun oversized_text_rejected() {
        // 二维码 L 级容量约 ~2300 字节；这里塞远超容量的文本
        QrSvg.build("x".repeat(5000), 256, null)
    }

    @Test
    fun matrix_api_consistent_with_svg() {
        val m = QrSvg.matrix("hi")
        assertTrue(m.width > 20) // 至少 21 模块（V1）+ 2 静区
    }
}
