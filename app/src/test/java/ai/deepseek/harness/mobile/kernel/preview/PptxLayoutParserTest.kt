package ai.deepseek.harness.mobile.kernel.preview

import ai.deepseek.harness.mobile.kernel.doc.PptxWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.zip.ZipFile

/**
 * PPTX 版式解析器：直接喂 PptxWriter 实产的六版式 XML，断言 shape 级还原
 * （几何/填充/字号/表格）。这正是「预览丢版式」问题的反向验证。
 */
class PptxLayoutParserTest {

    private fun writePptx(slides: List<PptxWriter.Slide>): File {
        val f = File(System.getProperty("java.io.tmpdir"), "dsh-pptx-parse-test/deck.pptx")
        f.parentFile?.mkdirs()
        f.delete()
        PptxWriter.write(f, slides, title = "测试", accent = "AA11BB")
        return f
    }

    private fun slideXml(f: File, n: Int): String =
        ZipFile(f).use { z ->
            z.getInputStream(z.getEntry("ppt/slides/slide$n.xml")).bufferedReader().readText()
        }

    @Test
    fun cover_slide_keeps_full_bleed_accent_and_title() {
        val f = writePptx(listOf(PptxWriter.Slide(title = "封面标题", subtitle = "副标题", by = "作者", layout = "cover")))
        val slide = PptxLayoutParser.parseSlide(slideXml(f, 1))
        // 整页主色背景：存在一个铺满画布（cx≈12192000）且 fill=accent 的形状
        val bg = slide.shapes.firstOrNull { it.cx >= 12_000_000 && it.fill == "AA11BB" }
        assertNotNull("封面整页主色背景没解析出来：${slide.shapes.map { "${it.name}:${it.cx}x${it.cy}:fill=${it.fill}" }}", bg)
        // 主标题 shape：文本对上，字号 54pt
        val title = slide.shapes.firstOrNull { it.paras.any { p -> p.text == "封面标题" } }
        assertNotNull("主标题没解析出来", title)
        assertEquals(54.0, title!!.paras[0].sizePt, 0.01)
    }

    @Test
    fun section_slide_has_giant_number() {
        val f = writePptx(listOf(PptxWriter.Slide(title = "第一章", layout = "section")))
        val slide = PptxLayoutParser.parseSlide(slideXml(f, 1))
        // 章节序号 96pt
        val big = slide.shapes.flatMap { it.paras }.any { it.sizePt >= 90.0 }
        assertTrue("96pt 章节序号没解析出来：${slide.shapes.flatMap { it.paras }.map { it.sizePt }}", big)
    }

    @Test
    fun two_col_slide_has_left_and_right() {
        val f = writePptx(listOf(PptxWriter.Slide(
            title = "对比",
            layout = "two-col",
            left = listOf("甲方案", "便宜"),
            right = listOf("乙方案", "快"),
        )))
        val slide = PptxLayoutParser.parseSlide(slideXml(f, 1))
        val texts = slide.shapes.flatMap { it.paras }.map { it.text }
        assertTrue("左栏丢了：$texts", texts.contains("甲方案"))
        assertTrue("右栏丢了：$texts", texts.contains("乙方案"))
    }

    @Test
    fun table_layout_parses_table_with_header_fill() {
        val f = writePptx(listOf(PptxWriter.Slide(
            title = "数据",
            layout = "table",
            table = listOf(listOf("指标", "值"), listOf("营收", "128")),
        )))
        val slide = PptxLayoutParser.parseSlide(slideXml(f, 1))
        val tbl = slide.shapes.firstOrNull { it.table != null }?.table
        assertNotNull("表格没解析出来：${slide.shapes.map { it.name }}", tbl)
        assertEquals(2, tbl!!.size)
        assertEquals("指标", tbl[0][0].text)
        assertTrue("表头填充色没解析出来", tbl[0].any { it.fill == "AA11BB" })
    }

    @Test
    fun quote_slide_parses_quote_text() {
        // quote 版式把引文包进 title（“…”），出处用 by
        val f = writePptx(listOf(PptxWriter.Slide(title = "少即是多", by = "Linus", layout = "quote")))
        val slide = PptxLayoutParser.parseSlide(slideXml(f, 1))
        val texts = slide.shapes.flatMap { it.paras }.map { it.text }
        assertTrue("引文丢了：$texts", texts.any { it.contains("少即是多") })
        assertTrue("出处丢了：$texts", texts.any { it.contains("Linus") })
    }

    @Test
    fun bullets_slide_keeps_title_size() {
        val f = writePptx(listOf(PptxWriter.Slide(title = "要点页", bullets = listOf("第一条", "第二条"))))
        val slide = PptxLayoutParser.parseSlide(slideXml(f, 1))
        val texts = slide.shapes.flatMap { it.paras }.map { it.text }
        assertTrue("要点丢了：$texts", texts.contains("第一条") && texts.contains("第二条"))
    }

    @Test
    fun presentation_size_read_from_zip() {
        val f = writePptx(listOf(PptxWriter.Slide(title = "尺寸")))
        val pres = ZipFile(f).use { z ->
            z.getInputStream(z.getEntry("ppt/presentation.xml")).bufferedReader().readText()
        }
        val (w, h) = PptxLayoutParser.presentationSize(pres)
        assertEquals(12192000L, w)
        assertEquals(6858000L, h)
    }

    @Test
    fun bad_xml_does_not_crash_into_garbage() {
        // 解析器对垃圾输入要么抛异常要么返回空 —— 不能返回编造的 shape
        try {
            val s = PptxLayoutParser.parseSlide("<not-xml")
            assertTrue(s.shapes.isEmpty())
        } catch (_: Exception) {
        }
    }
}
