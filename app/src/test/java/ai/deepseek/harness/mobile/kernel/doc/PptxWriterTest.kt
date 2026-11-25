package ai.deepseek.harness.mobile.kernel.doc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.util.zip.ZipFile
import javax.xml.parsers.DocumentBuilderFactory

/**
 * .pptx 的回环测试：包结构齐全 + 每个 XML 部件都能被严格解析 + 文字真的进了对应 slide。
 *
 * 手机上最容易出的事故是「文件生成了，PowerPoint 打开提示需要修复」—— 那种包
 * 光看字节数是看不出来的，必须逐个部件校验。
 */
class PptxWriterTest {

    private fun tmp(name: String): File {
        val f = File(System.getProperty("java.io.tmpdir"), "dsh-pptx-test/$name")
        f.parentFile?.mkdirs()
        f.delete()
        return f
    }

    private fun assertZipXml(f: File, required: List<String>) {
        ZipFile(f).use { zip ->
            for (name in required) assertTrue("缺少部件 $name", zip.getEntry(name) != null)
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

    private fun entry(f: File, name: String): String =
        ZipFile(f).use { z -> z.getInputStream(z.getEntry(name)).bufferedReader().readText() }

    @Test
    fun pptx_writes_valid_package() {
        val f = tmp("deck.pptx")
        val slides = listOf(
            PptxWriter.Slide("季度复盘", listOf("营收 128 万，环比 +12%", "成本 76 万，环比 -3%", "  华东区贡献最大"), "数据来源：内部报表"),
            PptxWriter.Slide("下一步", listOf("扩两个城市", "上线自助开票")),
            PptxWriter.Slide("只读一页 <script>", emptyList()),
        )
        val r = PptxWriter.write(f, slides, title = "Q3 复盘")

        assertTrue("pptx 没写出来", f.isFile && f.length() > 2000)
        assertEquals(3, r.slides)
        assertZipXml(
            f,
            listOf(
                "[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml",
                "ppt/_rels/presentation.xml.rels", "ppt/theme/theme1.xml",
                "ppt/slideMasters/slideMaster1.xml", "ppt/slideLayouts/slideLayout1.xml",
                "ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml",
            ),
        )

        val s1 = entry(f, "ppt/slides/slide1.xml")
        assertTrue("标题没进 slide1：$s1", s1.contains("季度复盘"))
        assertTrue("二级要点缩进没生效", s1.contains("marL=\"742950\""))
        assertTrue("页脚没进 slide1", s1.contains("数据来源：内部报表"))

        // 特殊字符必须转义，否则 PowerPoint 直接判包损坏
        val s3 = entry(f, "ppt/slides/slide3.xml")
        assertTrue("尖括号没转义：$s3", s3.contains("&lt;script&gt;") && !s3.contains("<script>"))

        // 页数与文件里的 sldId 必须一致（少一个就是「打开后少几页」）
        val pres = entry(f, "ppt/presentation.xml")
        assertEquals(3, Regex("<p:sldId ").findAll(pres).count())
        val rels = entry(f, "ppt/_rels/presentation.xml.rels")
        assertEquals(3, Regex("/relationships/slide\"").findAll(rels).count())
        val types = entry(f, "[Content_Types].xml")
        assertEquals(3, Regex("/ppt/slides/slide\\d+\\.xml").findAll(types).count())
    }

    @Test
    fun pptx_rejects_empty_deck() {
        val f = tmp("empty.pptx")
        try {
            PptxWriter.write(f, emptyList())
            fail("空幻灯片应当报错")
        } catch (e: Exception) {
            assertTrue("错误信息不友好：${e.message}", (e.message ?: "").contains("幻灯片"))
        }
    }

    @Test
    fun zip_keeps_entries_and_skips_missing() {
        val dir = File(System.getProperty("java.io.tmpdir"), "dsh-zip-test").apply { mkdirs() }
        val a = File(dir, "a.md").apply { writeText("# hello") }
        val b = File(dir, "b.txt").apply { writeText("world") }
        val out = File(dir, "pack.zip").apply { delete() }
        val r = DocWriter.writeZip(out, listOf("docs/a.md" to a, "b.txt" to b, "gone.txt" to File(dir, "nope.txt")))
        assertTrue("zip 没写出来", out.isFile && out.length() > 0)
        assertEquals(2, r.meta["entries"])
        ZipFile(out).use { z ->
            assertTrue(z.getEntry("docs/a.md") != null)
            assertTrue(z.getEntry("b.txt") != null)
            assertEquals("# hello", z.getInputStream(z.getEntry("docs/a.md")).bufferedReader().readText())
        }
    }

    /* ---------------- 配图嵌入（PPT 不再是纯文字） ---------------- */

    /** 1x1 PNG（真实可解析的最小图） */
    private fun png1x1(): ByteArray = java.util.Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    )

    @Test
    fun `配图嵌入 - media part 与 p pic 关系齐全`() {
        val dir = java.nio.file.Files.createTempDirectory("pptxpic").toFile()
        val img = java.io.File(dir, "shot.png").apply { writeBytes(png1x1()) }
        val out = java.io.File(dir, "带图.pptx")
        val r = PptxWriter.write(
            out,
            listOf(
                PptxWriter.Slide("封面", layout = "cover", subtitle = "配图测试", image = "shot.png", imageSide = "full"),
                PptxWriter.Slide("要点页", bullets = listOf("一条要点"), image = "shot.png"),
            ),
            title = "配图演示",
            imageResolver = { rel -> java.io.File(dir, rel).takeIf { it.isFile } },
        )
        assertEquals(2, r.slides)
        java.util.zip.ZipFile(out).use { z ->
            val media = z.getEntry("ppt/media/image1.png")
            val media2 = z.getEntry("ppt/media/image2.png")
            assertTrue("两页配图应各有一份 media part", media != null && media2 != null)
            val s1 = z.getInputStream(z.getEntry("ppt/slides/slide1.xml")).bufferedReader().readText()
            assertTrue("slide1 缺 p:pic", s1.contains("<p:pic>"))
            assertTrue("slide1 缺 blip 引用", s1.contains("r:embed=\"rIdImg1\""))
            val rels1 = z.getInputStream(z.getEntry("ppt/slides/_rels/slide1.xml.rels")).bufferedReader().readText()
            assertTrue("slide1 rels 缺 image 关系", rels1.contains("../media/image1.png"))
            val ct = z.getInputStream(z.getEntry("[Content_Types].xml")).bufferedReader().readText()
            assertTrue("content types 缺 png", ct.contains("Extension=\"png\""))
        }
        dir.deleteRecursively()
    }

    @Test
    fun `配图缺失时整份 PPT 仍能生成`() {
        val dir = java.nio.file.Files.createTempDirectory("pptxnopic").toFile()
        val out = java.io.File(dir, "无图.pptx")
        val r = PptxWriter.write(
            out,
            listOf(PptxWriter.Slide("只有文字", bullets = listOf("要点"), image = "不存在.png")),
            title = "无图",
            imageResolver = { rel -> java.io.File(dir, rel).takeIf { it.isFile } },
        )
        assertEquals(1, r.slides)
        java.util.zip.ZipFile(out).use { z ->
            assertNull("不该有 media part", z.getEntry("ppt/media/image1.png"))
            val s1 = z.getInputStream(z.getEntry("ppt/slides/slide1.xml")).bufferedReader().readText()
            assertTrue("不该有 p:pic", !s1.contains("<p:pic>"))
        }
        dir.deleteRecursively()
    }

    @Test
    fun `页切换 - 默认 fade 且 none 时不写 transition`() {
        val dir = java.nio.file.Files.createTempDirectory("pptxtrans").toFile()
        val out = java.io.File(dir, "切换.pptx")
        PptxWriter.write(
            out,
            listOf(
                PptxWriter.Slide("第一页", bullets = listOf("a")),
                PptxWriter.Slide("第二页", bullets = listOf("b"), transition = "push"),
                PptxWriter.Slide("第三页", bullets = listOf("c"), transition = "none"),
            ),
            title = "切换",
        )
        java.util.zip.ZipFile(out).use { z ->
            fun slideText(i: Int) =
                z.getInputStream(z.getEntry("ppt/slides/slide$i.xml")).bufferedReader().readText()
            assertTrue("默认应为 fade", slideText(1).contains("<p:fade/>"))
            assertTrue("push 应生效", slideText(2).contains("<p:push"))
            assertTrue("none 不该有 transition", !slideText(3).contains("<p:transition"))
        }
        dir.deleteRecursively()
    }
}
