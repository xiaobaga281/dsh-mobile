package ai.deepseek.harness.mobile.kernel.doc

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 中文 PDF（CID 编码 + /ToUnicode）的文本抽取回归。
 *
 * 样本 `cid-cn.pdf` 是应用自己用 [PdfWriter] 生成的最小文档（Android PdfDocument 输出
 * Type3/CID 字体）。这类 PDF 在旧实现下 chars=0 —— 因为内容流里只有字形编号。
 */
class PdfTextTest {

    private fun fixture(name: String): ByteArray =
        javaClass.classLoader!!.getResourceAsStream(name)?.readBytes()
            ?: error("缺少测试样本 $name")

    @Test
    fun cid_pdf_maps_back_to_chinese() {
        val text = PdfText.extract(fixture("cid-cn.pdf"))
        assertTrue("没抽到正文：[$text]", text.length > 20)
        listOf("季度复盘", "营收", "结论", "华东", "成本").forEach {
            assertTrue("缺少「$it」：\n$text", text.contains(it))
        }
        // 不能是乱码：中文字符占比应当过半
        val cjk = text.count { it.code in 0x4E00..0x9FFF }
        assertTrue("中文占比太低（$cjk/${text.length}）：\n$text", cjk * 2 > text.length / 2)
    }

    @Test
    fun empty_bytes_yield_empty_text() {
        assertTrue(PdfText.extract(ByteArray(0)).isEmpty())
        assertTrue(PdfText.extract("not a pdf".toByteArray()).isEmpty())
    }
}
