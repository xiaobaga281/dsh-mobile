package ai.deepseek.harness.mobile.kernel.doc

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.theme.Palette
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * .pptx 的写侧：一页幻灯片 = 一组绝对定位的形状。
 *
 * 和 [DocWriter] 一样不引 POI —— 一页幻灯片本质就是「一个固定母版 + 若干个文本框」，
 * 用纯 JDK 的 ZipOutputStream 拼出标准 OOXML PresentationML 就够，WPS / PowerPoint /
 * 手机自带查看器都能直接打开。
 *
 * 版式是「够用就好」的一小撮，但覆盖了真实演示文稿里 95% 的页型：
 * 封面、章节页、要点、双栏对比、引言、表格。图片与动画明确不做（手机上硬凑只会产出
 * 打不开的包），需要时如实告诉用户去电脑端加。
 */
object PptxWriter {

    /** 一页幻灯片。[layout] 决定正文怎么摆，其余字段按版式取用 */
    class Slide(
        val title: String,
        val bullets: List<String> = emptyList(),
        val note: String = "",
        /** cover / section / bullets / two-col / quote / table */
        val layout: String = "bullets",
        val subtitle: String = "",
        /** 引用页的出处、封面的作者行 */
        val by: String = "",
        val left: List<String> = emptyList(),
        val right: List<String> = emptyList(),
        val table: List<List<String>> = emptyList(),
        /**
         * 配图：工作区相对路径（png/jpg）。给了就嵌成真图片（media part + p:pic）。
         * [imageSide] 决定摆位：right（右半，默认）/ left（左半）/ full（整页铺满，封面常用）。
         */
        val image: String = "",
        val imageSide: String = "right",
        /**
         * 页切换效果（PowerPoint 的 transition，不是元素动画）：
         * fade / push / wipe / cover / none（默认 fade）。空串按 fade。
         */
        val transition: String = "fade",
    )

    data class Result(val bytes: Long, val slides: Int)

    /** 16:9（13.333in × 7.5in），PPT 2013 之后的默认尺寸 */
    private const val SLIDE_W = 12192000
    private const val SLIDE_H = 6858000
    private const val MARGIN = 838200

    fun write(
        f: File,
        slides: List<Slide>,
        title: String = "",
        author: String = "DeepSeek Harness",
        /** 主色，十六进制不带 #；空则用主题 accent1 */
        accent: String = "",
        /** 页脚文字（默认放标题），空串则不显示 */
        footer: String = "",
        /**
         * 配图解析器：把 Slide.image 的工作区相对路径解析成文件。
         * 给了就嵌成真图片（ppt/media/imageN.ext + p:pic）；null 或解析不到的图忽略该页配图。
         */
        imageResolver: ((String) -> File?)? = null,
    ): Result {
        if (slides.isEmpty()) throw KernelError("没有任何幻灯片可写")
        if (slides.size > 200) throw KernelError("页数过多（${slides.size}），请拆成多份")
        f.parentFile?.mkdirs()
        val n = slides.size
        val ac = accent.trim().removePrefix("#").takeIf { Regex("^[0-9A-Fa-f]{6}$").matches(it) } ?: Palette.ACCENT

        // 先解析配图：每页最多一张，记下 relId 与包内路径
        data class Pic(val relId: String, val target: String, val bytes: ByteArray, val ext: String)
        val pics = arrayOfNulls<Pic>(n)
        var picCount = 0
        slides.forEachIndexed { i, s ->
            if (s.image.isBlank()) return@forEachIndexed
            val file = imageResolver?.invoke(s.image) ?: return@forEachIndexed
            if (!file.isFile) return@forEachIndexed
            val bytes = runCatching { file.readBytes() }.getOrNull() ?: return@forEachIndexed
            if (bytes.size > 8L * 1024 * 1024) return@forEachIndexed
            val extRaw = file.extension.lowercase()
            if (extRaw !in setOf("png", "jpg", "jpeg", "gif")) return@forEachIndexed
            val ext = if (extRaw == "jpeg") "jpg" else extRaw
            picCount++
            pics[i] = Pic("rIdImg${picCount}", "media/image${picCount}.$ext", bytes, ext)
        }

        java.util.zip.ZipOutputStream(f.outputStream().buffered()).use { zos ->
            fun put(name: String, content: String) {
                zos.putNextEntry(ZipEntry(name))
                zos.write(content.toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
            fun putBytes(name: String, bytes: ByteArray) {
                zos.putNextEntry(ZipEntry(name))
                zos.write(bytes)
                zos.closeEntry()
            }
            put("[Content_Types].xml", contentTypes(n, pics.filterNotNull().isNotEmpty()))
            put("_rels/.rels", RELS_ROOT)
            put("docProps/core.xml", coreProps(title, author))
            put("docProps/app.xml", appXml(n))
            put("ppt/presentation.xml", presentation(n))
            put("ppt/_rels/presentation.xml.rels", presentationRels(n))
            put("ppt/presProps.xml", PRES_PROPS)
            put("ppt/viewProps.xml", VIEW_PROPS)
            put("ppt/tableStyles.xml", TABLE_STYLES)
            put("ppt/theme/theme1.xml", THEME)
            put("ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER)
            put("ppt/slideMasters/_rels/slideMaster1.xml.rels", SLIDE_MASTER_RELS)
            put("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT)
            put("ppt/slideLayouts/_rels/slideLayout1.xml.rels", SLIDE_LAYOUT_RELS)
            slides.forEachIndexed { i, s ->
                val pic = pics[i]
                put("ppt/slides/slide${i + 1}.xml", slide(s, ac, i + 1, n, footer.ifBlank { title }, pic != null))
                put("ppt/slides/_rels/slide${i + 1}.xml.rels", slideRels(pic?.ext))
                if (pic != null) putBytes("ppt/${pic.target}", pic.bytes)
            }
        }
        return Result(f.length(), n)
    }

    /* ---------------- 幻灯片正文 ---------------- */

    private fun slide(s: Slide, accent: String, index: Int, total: Int, footer: String, hasPic: Boolean = false): String {
        val body = StringBuilder()
        when (s.layout.lowercase()) {
            "cover" -> {
                body.append(rect(2, 0, 0, SLIDE_W, SLIDE_H, accent, line = false))
                body.append(
                    shape(3, "主标题", MARGIN, 2_300_000, SLIDE_W - MARGIN * 2, 1_800_000,
                        listOf(para(s.title.ifBlank { " " }, size = 5400, bold = true, color = "FFFFFF"))),
                )
                if (s.subtitle.isNotBlank()) {
                    body.append(
                        shape(4, "副标题", MARGIN, 4_050_000, SLIDE_W - MARGIN * 2, 900_000,
                            listOf(para(s.subtitle, size = 2400, color = "E8EEF6"))),
                    )
                }
                if (s.by.isNotBlank()) {
                    body.append(
                        shape(5, "署名", MARGIN, 5_100_000, SLIDE_W - MARGIN * 2, 600_000,
                            listOf(para(s.by, size = 1600, color = "D3DEEE"))),
                    )
                }
            }
            "section" -> {
                body.append(rect(2, 0, 0, SLIDE_W, SLIDE_H, accent, line = false))
                // 大号序号放在左上，充当章节视觉锚点
                body.append(
                    shape(3, "序号", MARGIN, 1_550_000, 2_600_000, 2_000_000,
                        listOf(para(index.toString().padStart(2, '0'), size = 9600, bold = true, color = "FFFFFF"))),
                )
                body.append(
                    shape(4, "章节名", MARGIN, 3_600_000, SLIDE_W - MARGIN * 2, 1_500_000,
                        listOf(para(s.title.ifBlank { " " }, size = 4000, bold = true, color = "FFFFFF"))),
                )
                if (s.subtitle.isNotBlank()) {
                    body.append(
                        shape(5, "说明", MARGIN, 4_900_000, SLIDE_W - MARGIN * 2, 800_000,
                            listOf(para(s.subtitle, size = 1800, color = "E8EEF6"))),
                    )
                }
            }
            "quote" -> {
                body.append(rect(2, 0, 0, SLIDE_W, SLIDE_H, "F7F8FA", line = false))
                body.append(
                    shape(3, "引文", MARGIN + 400_000, 1_700_000, SLIDE_W - (MARGIN + 400_000) * 2, 2_900_000,
                        listOf(para("“" + s.title.trim() + "”", size = 3600, color = "1A1A1A"))),
                )
                if (s.by.isNotBlank()) {
                    body.append(
                        shape(4, "出处", MARGIN + 400_000, 4_700_000, SLIDE_W - (MARGIN + 400_000) * 2, 600_000,
                            listOf(para("— " + s.by, size = 1800, color = "6B7280"))),
                    )
                }
            }
            "two-col" -> {
                body.append(titleShape(s.title, accent))
                val w = (SLIDE_W - MARGIN * 2 - 400_000) / 2
                body.append(
                    shape(4, "左栏", MARGIN, 1_900_000, w, SLIDE_H - 1_900_000 - 900_000,
                        colParas(s.left, accent)),
                )
                body.append(
                    shape(5, "右栏", MARGIN + w + 400_000, 1_900_000, w, SLIDE_H - 1_900_000 - 900_000,
                        colParas(s.right, accent)),
                )
            }
            "table" -> {
                body.append(titleShape(s.title, accent))
                body.append(tableShape(s.table, accent, 1_850_000, SLIDE_H - 1_850_000 - 900_000))
            }
            else -> {
                body.append(titleShape(s.title, accent))
                val lines = if (s.bullets.isEmpty()) listOf(" ") else s.bullets
                body.append(
                    shape(3, "内容", MARGIN, 1_850_000, SLIDE_W - MARGIN * 2, SLIDE_H - 1_850_000 - 900_000,
                        lines.map { raw ->
                            val lvl = if (raw.startsWith("  ")) 2 else 1
                            val text = raw.trim().let { if (it.startsWith("- ") || it.startsWith("• ")) it.substring(2) else it }
                            para(text, size = if (lvl == 1) 2000 else 1800, bullet = true, level = lvl)
                        }),
                )
                if (s.note.isNotBlank()) {
                    body.append(
                        shape(9, "备注", MARGIN, SLIDE_H - 780_000, SLIDE_W - MARGIN * 2 - 1_200_000, 420_000,
                            listOf(para(s.note, size = 1200, color = "8A8F98"))),
                    )
                }
            }
        }
        // 页码：封面与章节页不编号，避免「封面 1/12」这种尴尬
        if (s.layout.lowercase() !in setOf("cover", "section")) {
            body.append(
                shape(90, "页脚", MARGIN, SLIDE_H - 560_000, SLIDE_W - MARGIN * 2, 340_000,
                    listOf(para("$footer    $index / $total", size = 1000, color = "9AA0A6", align = "r"))),
            )
        }
        // 配图放在正文之后（z 序在上），backdrop 用 full 时压在底色上、标题下
        val pic = if (hasPic) picShape(99, s.imageSide) else ""
        return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
$body
$pic
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
${transXml(s.transition)}
</p:sld>"""
    }

    /** 内页标题 + 标题下的一条主色细线（没有它整页像记事本） */
    private fun titleShape(title: String, accent: String): String =
        shape(2, "标题", MARGIN, 380_000, SLIDE_W - MARGIN * 2, 1_100_000,
            listOf(para(title.ifBlank { " " }, size = 3000, bold = true, color = "1A1A1A"))) +
            rect(20, MARGIN, 1_520_000, 900_000, 52_000, accent, line = false)

    private fun colParas(items: List<String>, accent: String): List<String> =
        if (items.isEmpty()) listOf(para(" ", size = 1800))
        else items.map { raw ->
            val text = raw.trim()
            if (text.startsWith("## ")) {
                para(text.removePrefix("## "), size = 2000, bold = true, color = accent)
            } else {
                para(text.removePrefix("- "), size = 1700, bullet = !text.startsWith("#"))
            }
        }

    /** 纯色/描边矩形：封面与章节页的整页底色、标题下划线都用它 */
    private fun rect(id: Int, x: Int, y: Int, cx: Int, cy: Int, fill: String, line: Boolean = true): String =
        """<p:sp><p:nvSpPr><p:cNvPr id="$id" name="矩形$id"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="$x" y="$y"/><a:ext cx="$cx" cy="$cy"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
<a:solidFill><a:srgbClr val="$fill"/></a:solidFill>
${if (line) """<a:ln w="9525"><a:solidFill><a:srgbClr val="$fill"/></a:solidFill></a:ln>""" else "<a:ln><a:noFill/></a:ln>"}
</p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>"""

    /** 表格页：首行主色底白字，其余行交替浅底 */
    private fun tableShape(rows: List<List<String>>, accent: String, y: Int, height: Int): String {
        if (rows.isEmpty()) return ""
        val cols = rows.maxOf { it.size }.coerceAtLeast(1)
        val w = SLIDE_W - MARGIN * 2
        val colW = w / cols
        val rowH = (height / rows.size.coerceAtLeast(1)).coerceIn(360_000, 640_000)
        val grid = (0 until cols).joinToString("") { """<a:gridCol w="$colW"/>""" }
        val trs = rows.mapIndexed { ri, r ->
            val cells = (0 until cols).joinToString("") { ci ->
                val text = r.getOrElse(ci) { "" }
                val header = ri == 0
                val fill = if (header) accent else if (ri % 2 == 0) "F7F8FA" else "FFFFFF"
                val color = if (header) "FFFFFF" else "333333"
                """<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="${if (header) 1600 else 1500}" b="${if (header) 1 else 0}"><a:solidFill><a:srgbClr val="$color"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p></a:txBody>
<a:tcPr><a:solidFill><a:srgbClr val="$fill"/></a:solidFill><a:lnB w="9525"><a:solidFill><a:srgbClr val="E2E5EA"/></a:solidFill></a:lnB></a:tcPr></a:tc>"""
            }
            """<a:tr h="$rowH">$cells</a:tr>"""
        }.joinToString("")
        return """<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="30" name="表格"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr></p:nvGraphicFramePr>
<p:xfrm><a:off x="$MARGIN" y="$y"/><a:ext cx="$w" cy="${rowH * rows.size}"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>$grid</a:tblGrid>$trs</a:tbl>
</a:graphicData></a:graphic></p:graphicFrame>"""
    }

    /** 一个文本框：位置用 EMU，段落见 [para] */
    private fun shape(id: Int, name: String, x: Int, y: Int, cx: Int, cy: Int, paras: List<String>): String =
        """<p:sp><p:nvSpPr><p:cNvPr id="$id" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="$x" y="$y"/><a:ext cx="$cx" cy="$cy"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>
${paras.joinToString("")}
</p:txBody></p:sp>"""

    /**
     * @param size 字号（1/100 pt）
     * @param level 1 = 一级要点，2 = 二级要点
     * @param bullet 是否带项目符号
     */
    private fun para(
        text: String,
        size: Int = 1800,
        bold: Boolean = false,
        color: String = "333333",
        align: String = if (bold) "l" else "l",
        bullet: Boolean = false,
        level: Int = 1,
    ): String {
        val marL = if (level == 1) 285750 else 742950
        val indent = if (bullet) -285750 else 0
        val ppr = StringBuilder("""<a:pPr algn="$align" marL="$marL" indent="$indent">""")
        if (bullet) {
            ppr.append("""<a:buFont typeface="Arial"/><a:buChar char="${if (level == 1) "•" else "–"}"/>""")
        } else {
            ppr.append("<a:buNone/>")
        }
        // 行距 120%，段后 8pt，避免多行挤在一起
        ppr.append("""<a:lnSpc><a:spcPct val="120000"/></a:lnSpc><a:spcAft><a:spcPts val="800"/></a:spcAft></a:pPr>""")
        return """<a:p>$ppr<a:r><a:rPr lang="zh-CN" sz="$size" b="${if (bold) 1 else 0}" dirty="0"><a:solidFill><a:srgbClr val="$color"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>"""
    }

    /* ---------------- 包结构 ---------------- */

    private fun contentTypes(n: Int, hasImages: Boolean = false): String = buildString {
        append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""")
        append("""<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">""")
        append("""<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>""")
        append("""<Default Extension="xml" ContentType="application/xml"/>""")
        // 配图 Media Part 的 content type：不声明的话 PowerPoint 会报「需要修复」
        if (hasImages) {
            append("""<Default Extension="png" ContentType="image/png"/>""")
            append("""<Default Extension="jpg" ContentType="image/jpeg"/>""")
            append("""<Default Extension="jpeg" ContentType="image/jpeg"/>""")
            append("""<Default Extension="gif" ContentType="image/gif"/>""")
        }
        append("""<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>""")
        append("""<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>""")
        append("""<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>""")
        for (i in 1..n) {
            append("""<Override PartName="/ppt/slides/slide$i.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>""")
        }
        append("""<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>""")
        append("""<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>""")
        append("""<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>""")
        append("""<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>""")
        append("""<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>""")
        append("""<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>""")
        append("</Types>")
    }

    private fun presentation(n: Int): String = buildString {
        append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""")
        append("""<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">""")
        append("""<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>""")
        append("<p:sldIdLst>")
        for (i in 1..n) append("""<p:sldId id="${255 + i}" r:id="rId${i + 1}"/>""")
        append("</p:sldIdLst>")
        append("""<p:sldSz cx="$SLIDE_W" cy="$SLIDE_H"/><p:notesSz cx="6858000" cy="9144000"/>""")
        append("""<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle>""")
        append("</p:presentation>")
    }

    private fun presentationRels(n: Int): String = buildString {
        append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""")
        append("""<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">""")
        append("""<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>""")
        for (i in 1..n) {
            append("""<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide$i.xml"/>""")
        }
        append("""<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>""")
        append("""<Relationship Id="rId${n + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>""")
        append("""<Relationship Id="rId${n + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>""")
        append("""<Relationship Id="rId${n + 5}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>""")
        append("</Relationships>")
    }

    private fun appXml(n: Int): String = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>DeepSeek Harness</Application><Slides>$n</Slides><PresentationFormat>宽屏</PresentationFormat>
</Properties>"""

    private fun coreProps(title: String, author: String): String = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><cp:lastModifiedBy>${esc(author)}</cp:lastModifiedBy>
</cp:coreProperties>"""

    private val RELS_ROOT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

    private val SLIDE_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>"""

    /** 带配图的页：在基础关系上追加 image 关系（rIdImg1） */
    private fun slideRels(ext: String?): String =
        if (ext == null) SLIDE_RELS
        else """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.$ext"/>
</Relationships>"""

    /**
     * 页切换（transition）——让交付物不像"静态文档"。只做整页过渡，不做元素动画：
     * 元素动画要写 timing 树（几百行），而 agent 产出的 PPT 主要被阅读/编辑，不是被演讲。
     */
    private fun transXml(kind: String): String = when (kind.lowercase()) {
        "none" -> ""
        "push" -> """<p:transition><p:push dir="u"/></p:transition>"""
        "wipe" -> """<p:transition><p:wipe dir="l"/></p:transition>"""
        "cover" -> """<p:transition><p:cover dir="l"/></p:transition>"""
        else -> """<p:transition><p:fade/></p:transition>"""
    }
    /** 配图形状：p:pic（blipFill 指向 rIdImg1），按 side 决定摆位 */
    private fun picShape(id: Int, side: String): String {
        val (x, y, cx, cy) = when (side.lowercase()) {
            "left" -> listOf(MARGIN, 1_700_000, SLIDE_W / 2 - MARGIN - 100_000, SLIDE_H - 1_700_000 - MARGIN)
            "full" -> listOf(0, 0, SLIDE_W, SLIDE_H)
            else -> listOf(SLIDE_W / 2 + 100_000, 1_700_000,
                SLIDE_W / 2 - MARGIN - 100_000, SLIDE_H - 1_700_000 - MARGIN)
        }
        return """<p:pic><p:nvPicPr><p:cNvPr id="$id" name="配图$id"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="$x" y="$y"/><a:ext cx="$cx" cy="$cy"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>"""
    }

    private val SLIDE_MASTER = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles>
<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr marL="285750" indent="-285750"><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:bodyStyle>
<p:otherStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:otherStyle>
</p:txStyles>
</p:sldMaster>"""

    private val SLIDE_MASTER_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"""

    private val SLIDE_LAYOUT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="obj" preserve="1">
<p:cSld name="标题和内容"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>"""

    private val SLIDE_LAYOUT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"""

    private val PRES_PROPS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>"""

    private val VIEW_PROPS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>
<p:gridSpacing cx="76200" cy="76200"/>
</p:viewPr>"""

    private val TABLE_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>"""

    /** 主题：只给齐 PowerPoint 必需的配色 / 字体 / 三组样式表，够画一张白底深字的页 */
    private val THEME = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="DeepSeek">
<a:themeElements>
<a:clrScheme name="DeepSeek">
<a:dk1><a:srgbClr val="1A1A1A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="2F3B4C"/></a:dk2><a:lt2><a:srgbClr val="F2F4F7"/></a:lt2>
<a:accent1><a:srgbClr val="2B6CB0"/></a:accent1><a:accent2><a:srgbClr val="2F855A"/></a:accent2>
<a:accent3><a:srgbClr val="C05621"/></a:accent3><a:accent4><a:srgbClr val="6B46C1"/></a:accent4>
<a:accent5><a:srgbClr val="B03030"/></a:accent5><a:accent6><a:srgbClr val="0F766E"/></a:accent6>
<a:hlink><a:srgbClr val="2B6CB0"/></a:hlink><a:folHlink><a:srgbClr val="6B46C1"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="DeepSeek">
<a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="DeepSeek">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="15875" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/></a:schemeClr></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
<a:objectDefaults/><a:extraClrSchemeLst/>
</a:theme>"""

    private fun zip(f: File, block: (put: (String, String) -> Unit) -> Unit) {
        ZipOutputStream(f.outputStream().buffered()).use { zos ->
            block { name, content ->
                zos.putNextEntry(ZipEntry(name))
                zos.write(content.toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
        }
    }

    private fun esc(s: String): String = buildString(s.length + 16) {
        for (ch in s) {
            when {
                ch == '&' -> append("&amp;")
                ch == '<' -> append("&lt;")
                ch == '>' -> append("&gt;")
                ch == '"' -> append("&quot;")
                ch == '\'' -> append("&apos;")
                ch.code < 0x20 && ch != '\t' && ch != '\n' -> Unit
                else -> append(ch)
            }
        }
    }
}
