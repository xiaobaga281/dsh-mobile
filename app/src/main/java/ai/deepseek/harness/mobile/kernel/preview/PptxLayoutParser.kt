package ai.deepseek.harness.mobile.kernel.preview

import org.w3c.dom.Element
import java.io.ByteArrayInputStream
import javax.xml.parsers.DocumentBuilderFactory

/**
 * PPTX slide 版式解析器 —— 纯 JVM（javax.xml DOM），可单测。
 *
 * 此前 DocPreview.parseSlide 只按 <a:t> 抽纯文本、用「首段=标题」启发式，
 * PptxWriter 精心做的 6 种版式（封面整页主色 / 章节序号 / 双栏 / 表格 / 引文）
 * 在预览里 100% 丢失。这里按 shape 级还原：
 *   - 每个 p:sp 的几何（a:xfrm EMU）、填充（a:solidFill/a:srgbClr）、
 *     逐段文本（a:rPr 的 sz/b/颜色 + a:pPr 的 algn/buChar）
 *   - p:graphicFrame 里的 a:tbl 表格（含单元格填充）
 *   - 幻灯片尺寸读 ppt/presentation.xml 的 p:sldSz（缺省 16:9 标准值）
 *
 * shape 的语义 name（"主标题"/"章节名"…）只作参考不做渲染依据 —— 第三方 pptx
 * 的未知 name 一律按坐标通用渲染，保底正确。
 *
 * 用 DOM 而不是 XmlPullParser：后者在 JVM 单测里是 android.jar 桩，直接抛异常
 * —— 这正是 DocPreview 此前零测试的根因。
 */
object PptxLayoutParser {

    data class Para(
        val text: String,
        val sizePt: Double,   // sz="5400" → 54.0pt；0 = 未声明（继承）
        val bold: Boolean,
        val color: String?,   // srgbClr 字面色，无 = null
        val align: String?,   // l/ctr/r/just
        val bullet: Boolean,
    )

    data class Cell(val text: String, val fill: String?, val bold: Boolean)

    data class Shp(
        val name: String,
        val x: Long, val y: Long, val cx: Long, val cy: Long,   // EMU
        val fill: String?,
        val paras: List<Para>,
        val table: List<List<Cell>>?,
    )

    data class Slide(val shapes: List<Shp>, val width: Long, val height: Long)

    fun parseSlide(xml: String, slideW: Long = 12192000, slideH: Long = 6858000): Slide {
        val doc = factory().newDocumentBuilder()
            .parse(ByteArrayInputStream(xml.toByteArray(Charsets.UTF_8)))
        val shapes = mutableListOf<Shp>()

        val sps = doc.getElementsByTagNameNS("*", "sp")
        for (i in 0 until sps.length) {
            val sp = sps.item(i) as? Element ?: continue
            val name = firstDesc(sp, "cNvPr")?.getAttribute("name").orEmpty()
            val xfrm = firstDesc(sp, "spPr")?.let { firstDesc(it, "xfrm") }
            val off = xfrm?.let { firstDesc(it, "off") }
            val ext = xfrm?.let { firstDesc(it, "ext") }
            val fill = firstDesc(sp, "spPr")?.let { spPr ->
                firstDesc(spPr, "solidFill")?.let { firstDesc(it, "srgbClr")?.getAttribute("val") }
            }
            val paras = firstChild(sp, "txBody")?.let { parseParas(it) } ?: emptyList()
            shapes.add(Shp(
                name = name,
                x = off?.getAttribute("x")?.toLongOrNull() ?: 0L,
                y = off?.getAttribute("y")?.toLongOrNull() ?: 0L,
                cx = ext?.getAttribute("cx")?.toLongOrNull() ?: 0L,
                cy = ext?.getAttribute("cy")?.toLongOrNull() ?: 0L,
                fill = fill?.takeIf { it.matches(Regex("[0-9A-Fa-f]{6}")) },
                paras = paras,
                table = null,
            ))
        }

        val frames = doc.getElementsByTagNameNS("*", "graphicFrame")
        for (i in 0 until frames.length) {
            val gf = frames.item(i) as? Element ?: continue
            val xfrm = firstDesc(gf, "xfrm") ?: continue
            val off = firstDesc(xfrm, "off")
            val ext = firstDesc(xfrm, "ext")
            val tbl = firstDesc(gf, "tbl") ?: continue
            val rows = mutableListOf<List<Cell>>()
            val trs = tbl.getElementsByTagNameNS("*", "tr")
            for (r in 0 until trs.length) {
                val tr = trs.item(r) as? Element ?: continue
                val tcs = tr.getElementsByTagNameNS("*", "tc")
                val cells = (0 until tcs.length).mapNotNull { c ->
                    val tc = tcs.item(c) as? Element ?: return@mapNotNull null
                    Cell(
                        text = (tc.getElementsByTagNameNS("*", "t").let { t ->
                            (0 until t.length).joinToString("") { t.item(it).textContent.orEmpty() }
                        }).trim(),
                        fill = firstDesc(tc, "tcPr")?.let { tcPr ->
                            firstDesc(tcPr, "solidFill")?.let { firstDesc(it, "srgbClr")?.getAttribute("val") }
                        }?.takeIf { it.matches(Regex("[0-9A-Fa-f]{6}")) },
                        bold = tc.getElementsByTagNameNS("*", "rPr").let { rprs ->
                            (0 until rprs.length).any { rprs.item(it).attributes?.getNamedItem("b")?.nodeValue == "1" }
                        },
                    )
                }
                if (cells.isNotEmpty()) rows.add(cells)
            }
            shapes.add(Shp(
                name = firstDesc(gf, "cNvPr")?.getAttribute("name").orEmpty(),
                x = off?.getAttribute("x")?.toLongOrNull() ?: 0L,
                y = off?.getAttribute("y")?.toLongOrNull() ?: 0L,
                cx = ext?.getAttribute("cx")?.toLongOrNull() ?: 0L,
                cy = ext?.getAttribute("cy")?.toLongOrNull() ?: 0L,
                fill = null,
                paras = emptyList(),
                table = rows.takeIf { it.isNotEmpty() },
            ))
        }

        return Slide(shapes, slideW, slideH)
    }

    /** 读 ppt/presentation.xml 的 p:sldSz；缺省 12192000×6858000（16:9 标准） */
    fun presentationSize(presXml: String): Pair<Long, Long> {
        return try {
            val doc = factory().newDocumentBuilder()
                .parse(ByteArrayInputStream(presXml.toByteArray(Charsets.UTF_8)))
            val sldSz = doc.getElementsByTagNameNS("*", "sldSz").item(0) as? Element
                ?: return DEFAULT_SIZE
            (sldSz.getAttribute("cx").toLongOrNull() ?: 12192000L) to
                (sldSz.getAttribute("cy").toLongOrNull() ?: 6858000L)
        } catch (_: Exception) {
            DEFAULT_SIZE
        }
    }

    private val DEFAULT_SIZE = 12192000L to 6858000L

    private fun parseParas(txBody: Element): List<Para> {
        val out = mutableListOf<Para>()
        val ps = txBody.getElementsByTagNameNS("*", "p")
        for (i in 0 until ps.length) {
            val p = ps.item(i) as? Element ?: continue
            val pPr = firstChild(p, "pPr")
            val algn = pPr?.getAttribute("algn")?.ifBlank { null }
            val bullet = pPr != null && firstDesc(pPr, "buChar") != null
            val runs = p.getElementsByTagNameNS("*", "r")
            val sb = StringBuilder()
            var size = 0.0
            var bold = false
            var color: String? = null
            for (j in 0 until runs.length) {
                val r = runs.item(j) as? Element ?: continue
                val rPr = firstChild(r, "rPr")
                rPr?.getAttribute("sz")?.toIntOrNull()?.takeIf { it > 0 }?.let { size = it / 100.0 }
                if (rPr?.getAttribute("b") == "1") bold = true
                if (color == null) {
                    rPr?.let { firstDesc(it, "srgbClr") }?.getAttribute("val")
                        ?.takeIf { it.matches(Regex("[0-9A-Fa-f]{6}")) }?.let { color = it }
                }
                firstDesc(r, "t")?.textContent?.let { sb.append(it) }
            }
            val text = sb.toString().trim()
            if (text.isNotEmpty()) out.add(Para(text, size, bold, color, algn, bullet))
        }
        return out
    }

    private fun factory(): DocumentBuilderFactory = DocumentBuilderFactory.newInstance().apply {
        isNamespaceAware = true
        try {
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        } catch (_: Exception) {
        }
    }

    private fun firstChild(el: Element, local: String): Element? {
        var n = el.firstChild
        while (n != null) {
            if (n is Element && n.localName == local) return n
            n = n.nextSibling
        }
        return null
    }

    private fun firstDesc(el: Element, local: String): Element? =
        el.getElementsByTagNameNS("*", local).item(0) as? Element
}
