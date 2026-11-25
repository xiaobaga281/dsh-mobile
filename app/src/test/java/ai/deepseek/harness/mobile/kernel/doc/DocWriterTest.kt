package ai.deepseek.harness.mobile.kernel.doc

import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.util.zip.ZipFile
import javax.xml.parsers.DocumentBuilderFactory

/**
 * 文档生成的**回环**测试：写出来的包必须能被自家 [DocReader] 读回来，且每个 XML 部件
 * 都能被严格解析器接受。
 *
 * 为什么两件事都要测：
 *  - 只测"文件生成了"没意义 —— 打不开的 .docx 也是一堆字节；
 *  - 只测自家 Reader 也不够 —— 它容错宽松，可能掩盖少部件/属性乱序的问题。
 *    所以额外用 JDK 的 DocumentBuilder 把每个 *.xml 逐个解析一遍。
 */
class DocWriterTest {

    private fun tmp(name: String): File {
        val f = File(System.getProperty("java.io.tmpdir"), "dsh-doc-test/$name")
        f.parentFile?.mkdirs()
        f.delete()
        return f
    }

    /** 逐条检查 zip 内所有 xml 是否 well-formed，且必需部件齐全 */
    private fun assertZipXml(f: File, required: List<String>) {
        ZipFile(f).use { zip ->
            for (name in required) {
                assertTrue("缺少部件 $name", zip.getEntry(name) != null)
            }
            zip.entries().toList().filter { it.name.endsWith(".xml") || it.name.endsWith(".rels") }.forEach { e ->
                val bytes = zip.getInputStream(e).readBytes()
                try {
                    DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
                        .newDocumentBuilder().parse(bytes.inputStream())
                } catch (t: Throwable) {
                    fail("XML 不合格：${e.name} → ${t.message}")
                }
            }
        }
    }

    @Test
    fun docx_roundtrip_keeps_structure() {
        val md = """
            # 季度复盘

            这是一段正文，含 **粗体** 与 `行内代码`。

            ## 结论

            - 第一条结论
            - 第二条结论

            1. 先看数据
            2. 再看趋势

            > 一句引用

            | 指标 | 数值 | 变化 |
            | --- | --- | --- |
            | 营收 | 128 | +12% |
            | 成本 | 76 | -3% |

            ```
            val x = 1
            println(x)
            ```

            ---
        """.trimIndent()
        val f = tmp("report.docx")
        val r = DocWriter.writeDocx(f, md, title = "Q3 复盘")
        assertTrue("docx 没写出来", f.isFile && f.length() > 1000)
        assertTrue("docx 扩展名不对", f.extension == "docx")
        assertTrue("段落数异常：${r.meta["paragraphs"]}", (r.meta["paragraphs"] as Int) > 8)

        assertZipXml(f, listOf("[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"))

        val back = DocReader.read(f, 80_000)
        val text = back.text
        listOf("Q3 复盘", "季度复盘", "粗体", "行内代码", "第一条结论", "先看数据", "一句引用", "营收", "成本", "+12%", "println(x)").forEach {
            assertTrue("回读缺少「$it」：\n$text", text.contains(it))
        }
        // 表格必须还是表格（DocReader 用 | 还原列），不能被压成一行
        assertTrue("表格结构丢了：\n$text", text.contains("营收 | 128 | +12%"))
    }

    @Test
    fun xlsx_roundtrip_keeps_types_and_sheets() {
        val f = tmp("data.xlsx")
        DocWriter.writeXlsx(
            f,
            listOf(
                DocWriter.Sheet(
                    "销售",
                    listOf(
                        listOf("地区", "金额", "编号"),
                        listOf("华东", "1280.5", "007"),
                        listOf("华南", "980", "012"),
                    ),
                ),
                DocWriter.Sheet("汇总", listOf(listOf("合计", "2260.5")), header = false),
            ),
        )
        assertTrue("xlsx 没写出来", f.isFile && f.length() > 1000)
        assertZipXml(
            f,
            listOf(
                "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
                "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
            ),
        )

        // 数字必须是数值型（<v>），以 0 开头的编号必须是文本（inlineStr）
        val sheet1 = ZipFile(f).use { z -> z.getInputStream(z.getEntry("xl/worksheets/sheet1.xml")).bufferedReader().readText() }
        assertTrue("金额没存成数值：$sheet1", Regex("<c r=\"B2\"[^>]*><v>1280.5</v>").containsMatchIn(sheet1))
        assertTrue("007 被当成数字了：$sheet1", Regex("<c r=\"C2\"[^>]*t=\"inlineStr\"").containsMatchIn(sheet1))
        assertTrue("表头没冻结", sheet1.contains("state=\"frozen\""))
        assertTrue("表头样式丢了", Regex("<c r=\"A1\" s=\"1\"").containsMatchIn(sheet1))

        val back = DocReader.read(f, 80_000)
        assertTrue("回读缺表 1：${back.text}", back.text.contains("华东\t1280.5\t007"))
        assertTrue("回读缺表 2：${back.text}", back.text.contains("合计\t2260.5"))
        assertTrue("工作表数量不对：${back.meta["sheets"]}", back.meta["sheets"] == 2)
    }

    @Test
    fun csv_like_text_becomes_rows() {
        val rows = DocWriter.parseTable("a,b\n1,\"x,y\"\n\n2,z")
        assertTrue("行数不对：$rows", rows.size == 3)
        assertTrue("引号内逗号没保住：$rows", rows[1][1] == "x,y")
    }

    @Test
    fun sheet_name_is_sanitized() {
        val f = tmp("name.xlsx")
        DocWriter.writeXlsx(f, listOf(DocWriter.Sheet("a/b:c*?[] 很长很长很长很长很长很长很长很长很长", listOf(listOf("x")))))
        val wb = ZipFile(f).use { z -> z.getInputStream(z.getEntry("xl/workbook.xml")).bufferedReader().readText() }
        assertTrue("非法字符没清理：$wb", !wb.contains("a/b:c"))
        val name = Regex("name=\"([^\"]+)\"").find(wb)?.groupValues?.get(1) ?: ""
        assertTrue("表名超长：$name", name.length <= 31)
    }

    /**
     * 标题必须同时有 pStyle（权威层级：DocPreview 预览与 Word/WPS 导航都靠它）
     * 和内联 sz（老读取器/视觉兜底）。rc.97 之前只写内联 sz，预览里标题塌成普通段。
     */
    @Test
    fun docx_headings_carry_pStyle_and_inline_size() {
        val f = tmp("headings.docx")
        DocWriter.writeDocx(f, "# 一级\n\n## 二级\n\n### 三级")
        val doc = ZipFile(f).use { z ->
            z.getInputStream(z.getEntry("word/document.xml")).bufferedReader().readText()
        }
        listOf(1, 2, 3).forEach { lvl ->
            assertTrue("Heading$lvl 的 pStyle 丢了：$doc",
                doc.contains("""<w:pStyle w:val="Heading$lvl"/>"""))
        }
        assertTrue("标题的内联字号丢了（老读取器会裸奔）：$doc", doc.contains("<w:sz w:val=\"44\"/>"))
        // styles.xml 里 Heading1-4 样式定义齐全（Word 导航窗格需要 outlineLvl）
        val styles = ZipFile(f).use { z ->
            z.getInputStream(z.getEntry("word/styles.xml")).bufferedReader().readText()
        }
        listOf(1, 2, 3, 4).forEach { lvl ->
            assertTrue("styles.xml 缺 Heading$lvl 定义：$styles", styles.contains("w:styleId=\"Heading$lvl\""))
        }
        assertTrue("outlineLvl 丢了（导航窗格不可用）：$styles", styles.contains("outlineLvl"))
    }

    /* ---------------- 图片嵌入（write_docx 的 ![](图片) 行） ---------------- */

    /** 最小合法 PNG：8 字节签名 + IHDR（13 字节数据）+ 结尾，1x1 像素 */
    private fun tinyPng(): ByteArray {
        val png = java.io.ByteArrayOutputStream()
        png.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        png.write(byteArrayOf(0, 0, 0, 13)); png.write("IHDR".toByteArray())
        png.write(byteArrayOf(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0))
        png.write(byteArrayOf(0x1F, 0x15, 0xC4.toByte()))
        png.write(byteArrayOf(0, 0, 0, 0)); png.write("IEND".toByteArray())
        return png.toByteArray()
    }

    private fun zipEntryBytes(f: java.io.File, name: String): ByteArray? =
        java.util.zip.ZipFile(f).use { z ->
            val e = z.getEntry(name) ?: return null
            z.getInputStream(e).use { it.readBytes() }
        }

    @Test
    fun `docx 图片嵌入 - media 关系与 drawing 齐全`() {
        val dir = java.nio.file.Files.createTempDirectory("docximg").toFile()
        val img = java.io.File(dir, "shot.png")
        img.writeBytes(tinyPng())
        val out = java.io.File(dir, "带图.docx")
        val md = "# 报告\n\n看这张图：\n\n![](shot.png)\n\n完。"
        val r = DocWriter.writeDocx(
            out, md,
            title = "", cover = false,
            imageResolver = { rel -> java.io.File(dir, rel).takeIf { it.isFile } },
        )
        assertEquals("嵌入了 1 张图", 1, r.meta["images"])
        val bytes = zipEntryBytes(out, "word/media/image1.png")
        assertTrue("media part 缺失", bytes != null && bytes.size > 8)
        val doc = zipEntryBytes(out, "word/document.xml")!!.toString(Charsets.UTF_8)
        assertTrue("document.xml 缺 drawing", doc.contains("w:drawing"))
        assertTrue("document.xml 缺 blip 引用", doc.contains("r:embed=\"rIdImg1\""))
        assertTrue("占位符没被替换干净", !doc.contains("{{DSH_IMG"))
        val rels = zipEntryBytes(out, "word/_rels/document.xml.rels")!!.toString(Charsets.UTF_8)
        assertTrue("rels 缺图片关系", rels.contains("Target=\"media/image1.png\""))
        val ct = zipEntryBytes(out, "[Content_Types].xml")!!.toString(Charsets.UTF_8)
        assertTrue("content types 缺 png", ct.contains("Extension=\"png\""))
        dir.deleteRecursively()
    }

    @Test
    fun `docx 图片缺失时降级为说明段而不是坏文档`() {
        val dir = java.nio.file.Files.createTempDirectory("docximg2").toFile()
        val out = java.io.File(dir, "缺图.docx")
        val r = DocWriter.writeDocx(
            out, "开头\n\n![](不存在.png)\n\n结尾",
            title = "", cover = false,
            imageResolver = { rel -> java.io.File(dir, rel).takeIf { it.isFile } },
        )
        assertEquals("解析不到的图不计入 media", 0, r.meta["images"])
        val doc = zipEntryBytes(out, "word/document.xml")!!.toString(Charsets.UTF_8)
        assertTrue("缺图说明段在", doc.contains("图片缺失"))
        assertTrue("占位符没被替换干净", !doc.contains("{{DSH_IMG"))
        assertNull("不该有 media part", zipEntryBytes(out, "word/media/image1.png"))
        dir.deleteRecursively()
    }

    @Test
    fun `docx 富文本 - 超链接 斜体 删除线 嵌套列表`() {
        val out = java.io.File.createTempFile("rich", ".docx")
        val md = "# 富文檔\n\n看[官方文档](https://example.com/docs)与*重点*和~~过时~~内容。\n\n" +
            "- 顶层一\n  - 嵌套一点\n  - 嵌套二\n- 顶层二\n\n1. 第一\n  1. 嵌套"
        val r = DocWriter.writeDocx(out, md, title = "", cover = false)
        val doc = zipEntryBytes(out, "word/document.xml")!!.toString(Charsets.UTF_8)
        val rels = zipEntryBytes(out, "word/_rels/document.xml.rels")!!.toString(Charsets.UTF_8)
        assertTrue("超链接关系(外部)", rels.contains("TargetMode=\"External\"") && rels.contains("example.com"))
        assertTrue("w:hyperlink 在", doc.contains("w:hyperlink"))
        assertTrue("斜体", doc.contains("<w:i/>"))
        assertTrue("删除线", doc.contains("<w:strike/>"))
        assertTrue("嵌套列表缩进(1 层 780)", doc.contains("w:ind w:left=\"780\""))
        assertTrue("images 为 0(没有图片行)", (r.meta["images"] ?: 0) == 0)
        out.delete()
    }

}