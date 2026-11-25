package ai.deepseek.harness.mobile.kernel.preview

import ai.deepseek.harness.mobile.kernel.doc.PptxWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * DocPreview 编排层单测（rc.98）：preview() 是按扩展名分发的唯一入口，
 * 之前 466 行零覆盖 —— 「生成器与预览器不匹配」这类缺陷没有任何闸门能拦。
 *
 * 可测边界：pptx（PptxLayoutParser 是 javax.xml DOM）/ csv/tsv / json /
 * markdown / code / 未知扩展名 / 损坏文件。docx/xlsx/图片音频分支依赖
 * android.util.Xml / android.util.Base64（android.jar 桩），JVM 不可测，不在此覆盖。
 */
class DocPreviewTest {

    private fun dir(name: String): File {
        val d = File(System.getProperty("java.io.tmpdir"), "dsh-docpreview-test/$name")
        d.mkdirs()
        return d
    }

    private fun write(name: String, content: String): File {
        val f = File(dir("text"), name)
        f.writeText(content)
        return f
    }

    /* ---------------- pptx：版式还原 happy path ---------------- */

    private fun writePptx(slides: List<PptxWriter.Slide>): File {
        val f = File(dir("pptx"), "deck.pptx")
        f.parentFile?.mkdirs()
        f.delete()
        PptxWriter.write(f, slides, title = "测试", accent = "4C8DFF")
        return f
    }

    @Test
    fun pptx_preview_keeps_layout_shapes() {
        val f = writePptx(listOf(PptxWriter.Slide(title = "封面标题", subtitle = "副标题", by = "作者", layout = "cover")))
        val r = DocPreview.preview(f)
        assertEquals("pptx", r.optString("kind"))
        val html = r.optString("html")
        assertTrue("16:9 版式画布丢了：$html", html.contains("pv-slide is-layout"))
        assertTrue("绝对定位形状丢了：$html", html.contains("pv-shp") && html.contains("left:") && html.contains("top:"))
        assertTrue("标题文字丢了：$html", html.contains("封面标题"))
        // 字号双单位（px fallback + cqw）
        assertTrue("cqw 字号丢了：$html", html.contains("cqw"))
    }

    @Test
    fun pptx_preview_renders_table_cells() {
        val f = writePptx(listOf(PptxWriter.Slide(
            title = "数据", layout = "table",
            table = listOf(listOf("指标", "值"), listOf("营收", "128")),
        )))
        val r = DocPreview.preview(f)
        assertEquals("pptx", r.optString("kind"))
        val html = r.optString("html")
        assertTrue("表格丢了：$html", html.contains("pv-table"))
        assertTrue("单元格丢了：$html", html.contains("营收") && html.contains("128"))
    }

    @Test
    fun corrupted_pptx_degrades_to_error_kind() {
        val f = File(dir("broken"), "broken.pptx")
        f.parentFile?.mkdirs()
        f.writeBytes(byteArrayOf(0x00, 0x01, 0x02, 0x03, 0x04))
        val r = DocPreview.preview(f)
        // 垃圾字节 → ZipFile 抛异常 → runCatching 兜底，必须报 error 而不是崩溃或假数据
        assertEquals("error", r.optString("kind"))
        assertTrue(r.optString("error").isNotEmpty())
    }

    /* ---------------- csv / tsv：表格 ---------------- */

    @Test
    fun csv_with_quoted_fields_becomes_table() {
        val f = write("q.csv", "\"a,b\",c\n1,2\n")
        val r = DocPreview.preview(f)
        assertEquals("table", r.optString("kind"))
        val html = r.optString("html")
        assertTrue("表格丢了：$html", html.contains("<table"))
        assertTrue("引号字段丢了：$html", html.contains("a,b") && html.contains("c"))
        assertTrue("第二行丢了：$html", html.contains("1") && html.contains("2"))
    }

    @Test
    fun tsv_dispatches_to_table() {
        val f = write("t.tsv", "甲\t乙\n1\t2\n")
        val r = DocPreview.preview(f)
        assertEquals("table", r.optString("kind"))
        val html = r.optString("html")
        assertTrue("tsv 按逗号切了：$html", html.contains("甲") && html.contains("乙"))
    }

    /* ---------------- json / markdown / code / 未知扩展名 ---------------- */

    @Test
    fun json_is_pretty_printed() {
        val f = write("d.json", """{"b":1,"a":"中文"}""")
        val r = DocPreview.preview(f)
        assertEquals("json", r.optString("kind"))
        val html = r.optString("html")
        // esc() 会把引号转义成 &quot;，断言转义后的形态
        assertTrue("美化丢了：$html", html.contains("&quot;a&quot;: &quot;中文&quot;"))
    }

    @Test
    fun markdown_and_code_and_unknown_dispatch() {
        val md = DocPreview.preview(write("n.md", "# 标题\n正文"))
        assertEquals("markdown", md.optString("kind"))
        assertTrue(md.optString("html").contains("pv-pre"))

        val kt = DocPreview.preview(write("m.kt", "fun main() {}"))
        assertEquals("code", kt.optString("kind"))
        assertEquals("Kotlin", kt.optString("lang"))

        val xyz = DocPreview.preview(write("f.xyz", "随便什么"))
        assertEquals("text", xyz.optString("kind"))
    }

    @Test
    fun `zip 预览列出条目清单而不是乱码`() {
        val f = write("pack.zip", "")
        java.util.zip.ZipOutputStream(f.outputStream()).use { z ->
            z.putNextEntry(java.util.zip.ZipEntry("docs/a.txt")); z.write("hello".toByteArray())
            z.putNextEntry(java.util.zip.ZipEntry("data.bin")); z.write(byteArrayOf(1, 2, 3))
        }
        val pv = DocPreview.preview(f)
        assertEquals("zip", pv.optString("kind"))
        val html = pv.optString("html")
        assertTrue(html.contains("docs/a.txt"))
        assertTrue(html.contains("2 个文件"))
    }

    @Test
    fun `无扩展名二进制交系统查看器而不是输出乱码`() {
        val f = write("blob.dat", "")
        f.writeBytes(byteArrayOf(0x00, 0x01, 0x02, 0x03, -1, -2, -3, 0x7F, 0x00, 0x01))
        val pv = DocPreview.preview(f)
        assertEquals("error", pv.optString("kind"))
        assertTrue(pv.optString("error").contains("二进制"))
    }

}
