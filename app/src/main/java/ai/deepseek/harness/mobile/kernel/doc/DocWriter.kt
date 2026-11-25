package ai.deepseek.harness.mobile.kernel.doc

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.theme.Palette
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * 文档生成 —— .docx / .xlsx 的**写**侧，与 [DocReader] 对称。
 *
 * 为什么自己写 OOXML 而不引 Apache POI：POI 在 Android 上要拖进十几 MB 加一堆
 * java.awt / xml 依赖，而「把一段 Markdown 排成 Word」「把一张表写成 Excel」
 * 只需要十几个固定 XML 部件 —— 纯 JDK 的 ZipOutputStream 就够。生成的包是标准
 * OOXML，Word / WPS / Excel / 手机自带查看器都能直接打开（不是"改后缀的 HTML"）。
 *
 * 支持的 Markdown 子集（够 Agent 写报告用，且每一条都渲染成**真正的 Word 结构**）：
 *   `# 标题`（1–4 级）、`- 项目符号`、`1. 编号`、`> 引用`、``` 代码块 ```、
 *   `| 表格 |`（表头 + 分隔线）、`---` 分隔线、`**粗体**`、`` `行内代码` ``、普通段落。
 *
 * 明确不做：图片嵌入、页眉页脚、目录、脚注、合并单元格。需要这些的文档在手机上
 * 也不该由模型硬凑 —— 工具说明里写清了边界，模型不会假装做到了。
 */
object DocWriter {

    data class Result(
        val kind: String,
        val bytes: Long,
        val meta: MutableMap<String, Any> = mutableMapOf(),
    )

    /** 一张工作表：rows 的第一行是否作为表头（加粗 + 冻结 + 筛选） */
    class Sheet(
        val name: String,
        val rows: List<List<String>>,
        val header: Boolean = true,
    )

    /* ======================= docx ======================= */

    /**
     * @param markdown 正文（Markdown 子集，见类注释）
     * @param title    文档标题；非空时写在正文最前面（一级标题样式）
     */
    fun writeDocx(
        f: File,
        markdown: String,
        title: String = "",
        author: String = "DeepSeek Harness",
        /** 封面副标题；空则不显示 */
        subtitle: String = "",
        /** 是否生成封面页（需要 title 非空），默认生成 —— 报告类文档没有封面会显得很「草稿」 */
        cover: Boolean = true,
        /** 页眉文字，默认用标题；传 "-" 关闭页眉 */
        header: String = "",
        /** 封面上的日期行，空则自动用今天 */
        dateText: String = "",
        /**
         * 图片解析器：把正文里 `![](路径)` 的**工作区相对路径**解析成图片文件。
         * 给了就嵌入为 inline 图片（media part + 关系 + drawing）；
         * null 或解析不到的图降级为「图片缺失」说明段 —— 文档永远生成得出来。
         */
        imageResolver: ((String) -> File?)? = null,
    ): Result {
        if (markdown.isBlank() && title.isBlank()) throw KernelError("正文为空，没什么可写的")
        val body = StringBuilder()
        val useCover = cover && title.isNotBlank()
        if (useCover) {
            body.append(coverPage(title.trim(), subtitle, author, dateText))
        } else if (title.isNotBlank()) {
            body.append(heading(title.trim(), 1))
        }
        val imageRefs = mutableListOf<String>()
        val externalLinks = mutableListOf<Pair<String, String>>()   // (文字, URL)
        body.append(renderMarkdown(markdown, imageRefs, externalLinks))
        if (body.isEmpty()) throw KernelError("正文为空，没什么可写的")
        val headText = (if (header.isBlank()) title else header).trim().takeIf { it != "-" }.orEmpty()
        val hasHead = headText.isNotBlank()

        // ---- 图片嵌入：占位符 → inline drawing；图片字节作为 media part 进包 ----
        data class ImgPart(val relId: String, val target: String, val bytes: ByteArray, val ext: String)
        val media = mutableListOf<ImgPart>()
        var bodyStr = body.toString()
        imageRefs.forEachIndexed { idx, rel ->
            val token = "{{DSH_IMG:$idx}}"
            val file = imageResolver?.invoke(rel)
            if (file == null) {
                bodyStr = bodyStr.replace(token,
                    """<w:p><w:r><w:t>（图片缺失：${esc(rel)}）</w:t></w:r></w:p>""")
                return@forEachIndexed
            }
            val bytes = runCatching { file.readBytes() }.getOrNull()
            if (bytes == null || bytes.size > 8L * 1024 * 1024) {
                bodyStr = bodyStr.replace(token,
                    """<w:p><w:r><w:t>（图片过大或不可读：${esc(rel)}）</w:t></w:r></w:p>""")
                return@forEachIndexed
            }
            val extRaw = file.extension.lowercase().let { if (it == "jpg") "jpeg" else it }
            val ext = if (extRaw == "jpeg") "jpg" else extRaw   // 包内文件名统一用 jpg
            val dim = imageSize(bytes, extRaw)
            // 展示宽上限 5.5 英寸；按真实像素比缩放，1px = 9525 EMU
            val cx: Long
            val cy: Long
            if (dim != null && dim.first > 0) {
                val wEmu = minOf(dim.first * 9525L, 5_029_200L)
                cx = wEmu
                cy = (wEmu * dim.second.toLong() / dim.first.toLong())
            } else {
                cx = 5_029_200L; cy = 3_112_950L   // 解析不出尺寸按 5.5x3.4in 兜底
            }
            val relId = "rIdImg${idx + 1}"
            val target = "media/image${idx + 1}.$ext"
            media.add(ImgPart(relId, target, bytes, extRaw))
            bodyStr = bodyStr.replace(token, drawing(relId, idx + 1, cx, cy))
        }
        // 注意：`}` 必须转义 —— Android 的 java.util.regex 拒绝未转义的 `}`
        //（OpenJDK 容忍，设备上 PatternSyntaxException，实测踩过）
        if (media.isEmpty()) bodyStr = bodyStr.replace(Regex("\\{\\{DSH_IMG:\\d+\\}\\}"), "")
        // w:titlePg：首页（封面）不套页眉页脚，否则封面顶上会顶着一行小字
        val sect = """<w:sectPr>${if (hasHead) """<w:headerReference w:type="default" r:id="rIdHeader"/>""" else ""}<w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>${if (useCover) "<w:titlePg/>" else ""}</w:sectPr>"""
        val doc = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
$bodyStr
$sect
</w:body>
</w:document>"""
        f.parentFile?.mkdirs()
        // 内联 ZipOutputStream（不复用 String 版 zip 助手）：图片字节必须走
        // 二进制通道，String put 会按 UTF-8 编码把字节打碎。
        java.util.zip.ZipOutputStream(f.outputStream().buffered()).use { zos ->
            fun put(name: String, content: String) {
                zos.putNextEntry(java.util.zip.ZipEntry(name))
                zos.write(content.toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
            fun putBytes(name: String, bytes: ByteArray) {
                zos.putNextEntry(java.util.zip.ZipEntry(name))
                zos.write(bytes)
                zos.closeEntry()
            }
            put("[Content_Types].xml", contentTypesDocx(hasHead, media.isNotEmpty()))
            put("_rels/.rels", RELS_ROOT)
            put("docProps/core.xml", coreProps(title, author))
            put("docProps/app.xml", APP_XML_DOCX)
            put("word/document.xml", doc)
            put("word/styles.xml", STYLES_DOCX)
            put("word/_rels/document.xml.rels", docRels(hasHead, media.map { it.relId to it.target }, externalLinks))
            if (hasHead) put("word/header1.xml", headerXml(headText))
            put("word/footer1.xml", FOOTER_XML)
            media.forEach { m -> putBytes("word/${m.target}", m.bytes) }
        }
                val paragraphs = RE_PARA.findAll(doc).count()
        return Result("docx", f.length(), mutableMapOf("paragraphs" to paragraphs, "title" to title, "cover" to useCover, "images" to media.size))
    }

    /* ---------------- 封面 / 页眉页脚 ---------------- */

    /** 封面：大标题 + 副标题 + 分隔线 + 作者与日期，末尾硬分页 */
    private fun coverPage(title: String, subtitle: String, author: String, dateText: String): String {
        val sb = StringBuilder()
        repeat(4) { sb.append("""<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="480" w:lineRule="auto"/></w:pPr></w:p>""") }
        sb.append(
            """<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="2400" w:after="240"/></w:pPr>""" +
                """<w:r><w:rPr><w:b/><w:sz w:val="72"/><w:szCs w:val="72"/><w:color w:val="1A1A1A"/></w:rPr>""" +
                """<w:t xml:space="preserve">${esc(title)}</w:t></w:r></w:p>""",
        )
        if (subtitle.isNotBlank()) {
            sb.append(
                """<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="400"/></w:pPr>""" +
                    """<w:r><w:rPr><w:sz w:val="32"/><w:color w:val="55585E"/></w:rPr>""" +
                    """<w:t xml:space="preserve">${esc(subtitle)}</w:t></w:r></w:p>""",
            )
        }
        // 主色分隔线：比纯文字更像个封面（共享主题 Palette，见 kernel/theme）
        sb.append(
            """<w:p><w:pPr><w:jc w:val="center"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="${Palette.ACCENT}"/></w:pBdr>""" +
                """<w:spacing w:before="0" w:after="400"/><w:ind w:left="3200" w:right="3200"/></w:pPr></w:p>""",
        )
        val day = dateText.ifBlank {
            java.text.SimpleDateFormat("yyyy 年 M 月 d 日", java.util.Locale.CHINA).format(java.util.Date())
        }
        sb.append(
            """<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="80"/></w:pPr>""" +
                """<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="8E8E93"/></w:rPr><w:t>${esc(author)}</w:t></w:r></w:p>""",
        )
        sb.append(
            """<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>""" +
                """<w:r><w:rPr><w:sz w:val="20"/><w:color w:val="8E8E93"/></w:rPr><w:t>${esc(day)}</w:t></w:r></w:p>""",
        )
        sb.append("""<w:p><w:r><w:br w:type="page"/></w:r></w:p>""")
        return sb.toString()
    }

    private fun headerXml(text: String): String = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:jc w:val="right"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D1D1D6"/></w:pBdr>
<w:spacing w:before="0" w:after="0"/></w:pPr>
<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="8E8E93"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>
</w:hdr>"""

    /** 页脚：居中页码域（Word/WPS 会自动续页） */
    private val FOOTER_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>
<w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="8E8E93"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>
</w:p></w:ftr>"""

    private fun contentTypesDocx(withHeader: Boolean, hasImages: Boolean = false): String = buildString {
        append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""")
        append("""<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">""")
        append("""<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>""")
        append("""<Default Extension="xml" ContentType="application/xml"/>""")
        if (hasImages) {
            append("""<Default Extension="png" ContentType="image/png"/>""")
            append("""<Default Extension="jpg" ContentType="image/jpeg"/>""")
            append("""<Default Extension="jpeg" ContentType="image/jpeg"/>""")
            append("""<Default Extension="gif" ContentType="image/gif"/>""")
        }
        append("""<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>""")
        append("""<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>""")
        append("""<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>""")
        if (withHeader) {
            append("""<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>""")
        }
        append("""<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>""")
        append("""<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>""")
        append("</Types>")
    }

    private fun docRels(
        withHeader: Boolean,
        images: List<Pair<String, String>> = emptyList(),
        externalLinks: List<Pair<String, String>> = emptyList(),
    ): String = buildString {
        append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""")
        append("""<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">""")
        append("""<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>""")
        append("""<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>""")
        if (withHeader) {
            append("""<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>""")
        }
        for ((relId, target) in images) {
            append("""<Relationship Id="$relId" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="$target"/>""")
        }
        externalLinks.forEachIndexed { i, (_, url) ->
            append("""<Relationship Id="rIdH${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="$url" TargetMode="External"/>""")
        }
        append("</Relationships>")
    }

    /* ---------------- 图片嵌入助手 ---------------- */

    /** 图片像素尺寸：PNG(IHDR)/GIF(头)/JPEG(SOF 扫描)；认不出返回 null（调用方按 5.5x3.4in 兜底） */
    private fun imageSize(bytes: ByteArray, ext: String): Pair<Int, Int>? = runCatching {
        when (ext) {
            "png" -> {
                if (bytes.size < 24) return null
                val w = ((bytes[16].toInt() and 0xFF) shl 24) or ((bytes[17].toInt() and 0xFF) shl 16) or
                    ((bytes[18].toInt() and 0xFF) shl 8) or (bytes[19].toInt() and 0xFF)
                val h = ((bytes[20].toInt() and 0xFF) shl 24) or ((bytes[21].toInt() and 0xFF) shl 16) or
                    ((bytes[22].toInt() and 0xFF) shl 8) or (bytes[23].toInt() and 0xFF)
                w to h
            }
            "gif" -> {
                if (bytes.size < 10) return null
                val w = (bytes[6].toInt() and 0xFF) or ((bytes[7].toInt() and 0xFF) shl 8)
                val h = (bytes[8].toInt() and 0xFF) or ((bytes[9].toInt() and 0xFF) shl 8)
                w to h
            }
            "jpeg" -> {
                var i = 2
                while (i + 9 < bytes.size) {
                    if (bytes[i].toInt() and 0xFF != 0xFF) { i++; continue }
                    val marker = bytes[i + 1].toInt() and 0xFF
                    if (marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) {
                        val h = ((bytes[i + 5].toInt() and 0xFF) shl 8) or (bytes[i + 6].toInt() and 0xFF)
                        val w = ((bytes[i + 7].toInt() and 0xFF) shl 8) or (bytes[i + 8].toInt() and 0xFF)
                        return w to h
                    }
                    val len = ((bytes[i + 2].toInt() and 0xFF) shl 8) or (bytes[i + 3].toInt() and 0xFF)
                    i += 2 + len
                }
                null
            }
            else -> null
        }
    }.getOrNull()

    /** inline 图片的 WordprocessingML：wp:extent 用 EMU（1px = 9525 EMU） */
    private fun drawing(relId: String, idx: Int, cx: Long, cy: Long): String =
        """<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="$cx" cy="$cy"/><wp:docPr id="$idx" name="image$idx"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="$idx" name="image$idx"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="$relId"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="$cx" cy="$cy"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"""
    /* ---- Markdown → WordprocessingML ---- */

    /**
     * 预编译正则 —— **不要**回到 `Regex("…")` 内联写法。
     *
     * `Regex(pattern)` 在构造时就会执行 `Pattern.compile`，而 `renderMarkdown` 是**逐行**
     * 走 when 分支的：1600 段文档意味着上千次重复编译同一个模式。实测 1674 段要 3.2s，
     * 产物才 9KB —— 时间全花在编译正则上，不是在生成文档。
     * 提到这里之后每个模式全进程只编译一次（Kotlin 的 val 是懒初始化、线程安全）。
     */
    private val RE_SEP_CELL = Regex(":?-{2,}:?")
    // 行内四件套（顺序即优先级）：**粗体** / ~~删除线~~ / [文字](http 链接) / `代码`。
    // *斜体* 用单星：放在粗体之后才不会把 ** 的内容吞掉。
    private val RE_INLINE = Regex(
        "\\*\\*([^*]+)\\*\\*|~~([^~]+)~~|\\[([^\\]]+)\\]\\((https?://[^)]+)\\)|`([^`]+)`|\\*([^*\\s][^*]*)\\*"
    )
    private val RE_PARA = Regex("<w:p[ >]")
    private val RE_UNSAFE_NAME = Regex("[\\[\\]:*?/\\\\]")
    private val RE_NUMERIC = Regex("^-?(0|[1-9]\\d*)(\\.\\d+)?$")
    /** 图片行：![说明](工作区相对路径) —— 说明可空；独占一行才嵌入（行内图片降级为文字） */
    private val RE_IMAGE = Regex("^!\\[([^\\]]*)\\]\\(([^)]+)\\)\\s*$")

    /** 一行属于哪种块级语法。 */
    private enum class LineKind { BLANK, FENCE, TABLE, HEADING, HR, QUOTE, BULLET, ORDERED, IMAGE, PARAGRAPH }

    /**
     * 行分类 —— **用首字符分派，不要每行跑 6 个正则**。
     *
     * 实测（emulator x86_64，debug 包）：800 行纯标题要 804ms、800 段纯正文 643ms，
     * 与内容长短无关、只与**行数**成正比 ≈ 1ms/行。原因就是 `when` 里每个分支都要
     * `RE_*.matches(line)`，一行最多编译后的 Matcher 也要建 6 次；Android 的
     * `java.util.regex` 建 Matcher + 全串匹配比 OpenJDK 慢一个量级（同一份代码在
     * JVM 上 1200 行只要 15ms）。
     *
     * 而这些语法**全都由首字符唯一决定**（`#` 标题、`-` 分隔线/列表、`>` 引用、`|` 表格、
     * 数字 有序列表）。所以先看首字符，只有真正可能命中的分支才做字符级校验，
     * 一个字都不匹配的行直接归 PARAGRAPH。语义与原正则逐条对齐（见各类的注释）。
     */
    private fun classify(line: String): LineKind {
        if (line.isBlank()) return LineKind.BLANK
        val first = line[0]
        // 围栏与表格允许前导空格（原实现用 trimStart().startsWith）
        if (first == ' ' || first == '\t') {
            val t = line.trimStart()
            return when {
                t.startsWith("```") -> LineKind.FENCE
                t.startsWith("|") -> LineKind.TABLE
                // 缩进的列表 = 嵌套层级（renderMarkdown 按 raw 前导空格数算层级）
                (t.startsWith("- ") || t.startsWith("* ") || t.startsWith("+ ") || t.startsWith("• ")) -> LineKind.BULLET
                t.isNotEmpty() && t[0].isDigit() -> {
                    var n = 0
                    while (n < t.length && n < 3 && t[n] in '0'..'9') n++
                    if (n in 1..3 && n < t.length - 1 && (t[n] == '.' || t[n] == ')') && t[n + 1].isWhitespace()) LineKind.ORDERED
                    else LineKind.PARAGRAPH
                }
                else -> LineKind.PARAGRAPH
            }
        }
        return when (first) {
            '`' -> if (line.startsWith("```")) LineKind.FENCE else LineKind.PARAGRAPH
            '|' -> LineKind.TABLE
            '#' -> {
                // ^#{1,6}\s+.*  —— 1~6 个 #，之后必须是空白
                var n = 0
                while (n < line.length && line[n] == '#') n++
                if (n in 1..6 && n < line.length && line[n].isWhitespace()) LineKind.HEADING
                else LineKind.PARAGRAPH
            }
            '-' -> {
                // ^-{3,}$（整行只有 3 个以上 -）优先判为分隔线；否则看是不是列表项
                if (line.length >= 3 && line.all { it == '-' }) LineKind.HR
                else if (line.length > 1 && line[1].isWhitespace()) LineKind.BULLET
                else LineKind.PARAGRAPH
            }
            '*', '+', '•' -> if (line.length > 1 && line[1].isWhitespace()) LineKind.BULLET
                              else LineKind.PARAGRAPH
            '>' -> LineKind.QUOTE          // ^>\s?.* —— 只要以 > 开头即可
            '!' -> if (RE_IMAGE.matches(line)) LineKind.IMAGE else LineKind.PARAGRAPH
            in '0'..'9' -> {
                // ^\d{1,3}[.)]\s+.*
                var n = 0
                while (n < line.length && n < 3 && line[n] in '0'..'9') n++
                if (n in 1..3 && n < line.length - 1 &&
                    (line[n] == '.' || line[n] == ')') && line[n + 1].isWhitespace()
                ) LineKind.ORDERED else LineKind.PARAGRAPH
            }
            else -> LineKind.PARAGRAPH
        }
    }

    private fun renderMarkdown(
        md: String,
        images: MutableList<String>? = null,
        links: MutableList<Pair<String, String>>? = null,
    ): String {
        val out = StringBuilder()
        // 两步 replace 各自是全串扫描 + 可能重建；纯 \n 文本（绝大多数）没必要付这份钱
        val normalized = if (md.indexOf('\r') >= 0) md.replace("\r\n", "\n").replace('\r', '\n') else md
        val lines = normalized.split('\n')
        var i = 0
        while (i < lines.size) {
            val raw = lines[i]
            val line = raw.trimEnd()
            when (classify(line)) {
                LineKind.BLANK -> i++

                // 代码围栏：整块保留换行，等宽字体 + 浅底
                LineKind.FENCE -> {
                    val lang = line.trim().removePrefix("```").trim()
                    i++
                    val buf = StringBuilder()
                    while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                        buf.append(lines[i]).append('\n')
                        i++
                    }
                    if (i < lines.size) i++ // 跳过收尾围栏
                    out.append(codeBlock(buf.toString().trimEnd('\n'), lang))
                }

                // 表格：连续的 | 行；第二行是 |---|---|
                LineKind.TABLE -> {
                    val rows = mutableListOf<List<String>>()
                    while (i < lines.size && lines[i].trimStart().startsWith("|")) {
                        val cells = splitRow(lines[i])
                        if (!cells.all { RE_SEP_CELL.matches(it) }) rows.add(cells)
                        i++
                    }
                    if (rows.isEmpty()) continue
                    out.append(table(rows))
                }

                LineKind.HEADING -> {
                    val level = line.takeWhile { it == '#' }.length.coerceIn(1, 4)
                    out.append(heading(line.drop(level).trim(), level, links))
                    i++
                }

                LineKind.HR -> {
                    out.append(hr())
                    i++
                }

                // 图片行：记下工作区相对路径 + 落占位符行。
                // writeDocx 会把占位符替换成 drawing XML；解析不到的图降级为「图片缺失」说明段。
                LineKind.IMAGE -> {
                    val m = RE_IMAGE.matchEntire(line)!!
                    val idx = images?.size ?: 0
                    images?.add(m.groupValues[2].trim())
                    out.append("{{DSH_IMG:").append(idx).append("}}")
                    i++
                }

                LineKind.QUOTE -> {
                    out.append(quote(line.removePrefix(">").trim()))
                    i++
                }

                // 项目符号（- * + 与全角 ・）；前导空格每 2 个 = 一层嵌套（上限 3 层）
                LineKind.BULLET -> {
                    val level = (raw.length - raw.trimStart().length) / 2
                    val t = line.trimStart()
                    out.append(bullet(t.drop(1).trim(), ordered = false, index = 0, level = level.coerceIn(0, 3), links = links))
                    i++
                }

                LineKind.ORDERED -> {
                    val t = line.trimStart()
                    val level = (raw.length - raw.trimStart().length) / 2
                    val num = t.takeWhile { it.isDigit() }
                    out.append(bullet(t.drop(num.length).drop(1).trim(), ordered = true, index = num.toIntOrNull() ?: 1, level = level.coerceIn(0, 3), links = links))
                    i++
                }

                else -> {
                    // 普通段落：连续的普通行合并成一段（Markdown 软换行）
                    val buf = StringBuilder(line.trim())
                    i++
                    while (i < lines.size) {
                        val nxt = lines[i].trimEnd()
                        if (nxt.isBlank() || isBlockStart(nxt)) break
                        buf.append(if (buf.endsWith("  ")) "\n" else " ").append(nxt.trim())
                        i++
                    }
                    out.append(paragraph(buf.toString().trim(), links))
                }
            }
        }
        return out.toString()
    }

    /**
     * 这一段是否「块级起点」（段落合并到此为止）。
     *
     * 直接复用 [classify]，不再单独跑 4 个正则：语义与原实现逐条等价
     * （`s.trimStart()` 后判 heading/bullet/ordered/hr/quote/fence/table），
     * 但每段只做字符判断。800 段文档原先这里要 3200 次正则匹配。
     */
    private fun isBlockStart(s: String): Boolean {
        val k = classify(s.trimStart())
        return k != LineKind.PARAGRAPH && k != LineKind.BLANK
    }

    private fun splitRow(row: String): List<String> {
        val t = row.trim().removePrefix("|").removeSuffix("|")
        return t.split('|').map { it.trim() }
    }

    private fun run(
        text: String,
        bold: Boolean = false,
        italic: Boolean = false,
        mono: Boolean = false,
        size: Int = 0,
        color: String = "",
        strike: Boolean = false,
    ): String {
        val rpr = StringBuilder()
        if (mono) rpr.append("""<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>""")
        if (bold) rpr.append("<w:b/>")
        if (italic) rpr.append("<w:i/>")
        if (strike) rpr.append("<w:strike/>")
        if (color.isNotBlank()) rpr.append("""<w:color w:val="$color"/>""")
        if (size > 0) rpr.append("""<w:sz w:val="$size"/><w:szCs w:val="$size"/>""")
        val rp = if (rpr.isEmpty()) "" else "<w:rPr>$rpr</w:rPr>"
        return """<w:r>$rp<w:t xml:space="preserve">${esc(text)}</w:t></w:r>"""
    }

    /** 行内六件套（**粗体** / *斜体* / ~~删除线~~ / [文字](http 链接) / `代码`）拆成多个 run（不递归嵌套） */
    private fun inlineRuns(
        text: String,
        size: Int = 0,
        color: String = "",
        links: MutableList<Pair<String, String>>? = null,
    ): String {
        // 绝大多数段落没有任何行内标记。先做字符扫描（JDK/ART 的 indexOf 都是向量化实现），
        // 没有任何标记字符就整段走纯文本 —— 省掉每段一次 Matcher。
        if (text.indexOf('*') < 0 && text.indexOf('`') < 0 && text.indexOf('~') < 0 &&
            text.indexOf('[') < 0
        ) return run(text, size = size, color = color)
        val out = StringBuilder()
        var idx = 0
        val re = RE_INLINE
        re.findAll(text).forEach { m ->
            if (m.range.first > idx) out.append(run(text.substring(idx, m.range.first), size = size, color = color))
            val bold = m.groupValues[1]
            val strike = m.groupValues[2]
            val linkText = m.groupValues[3]
            val linkUrl = m.groupValues[4]
            val code = m.groupValues[5]
            val italic = m.groupValues[6]
            when {
                bold.isNotEmpty() -> out.append(run(bold, bold = true, size = size, color = color))
                strike.isNotEmpty() -> out.append(run(strike, strike = true, size = size, color = color))
                linkText.isNotEmpty() -> {
                    // 外部超链接：收集 URL，关系在 docRels 里以 TargetMode=External 落表
                    val relId = if (links != null) {
                        links.add(linkText to linkUrl)
                        "rIdH${links.size}"
                    } else ""
                    if (links != null) {
                        out.append(
                            """<w:hyperlink r:id="$relId"><w:r><w:rPr>${if (size > 0) """<w:sz w:val="$size"/><w:szCs w:val="$size"/>""" else ""}<w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${esc(linkText)}</w:t></w:r></w:hyperlink>""",
                        )
                    } else {
                        out.append(run(linkText, size = size, color = color))
                    }
                }
                code.isNotEmpty() -> out.append(run(code, mono = true, size = size, color = color.ifBlank { "C7254E" }))
                italic.isNotEmpty() -> out.append(run(italic, italic = true, size = size, color = color))
            }
            idx = m.range.last + 1
        }
        if (idx < text.length) out.append(run(text.substring(idx), size = size, color = color))
        return if (out.isEmpty()) run("") else out.toString()
    }

    private fun paragraph(text: String, links: MutableList<Pair<String, String>>? = null): String =
        // 中文正文惯例：首行缩进 2 字符（22pt → 440 twips）、1.5 倍行距。
        // 不缩进 + 单倍行距是「记事本导出的 txt」，不是文档。
        """<w:p><w:pPr><w:spacing w:before="0" w:after="120" w:line="360" w:lineRule="auto"/><w:ind w:firstLine="440"/></w:pPr>${inlineRuns(text, links = links)}</w:p>"""

    private fun heading(text: String, level: Int, links: MutableList<Pair<String, String>>? = null): String {
        val size = when (level) { 1 -> 44; 2 -> 36; 3 -> 30; else -> 26 } // half-points
        val before = when (level) { 1 -> 240; 2 -> 200; else -> 160 }
        // pStyle 是标题层级的权威表达：DocPreview 只认它（此前全靠内联 sz，
        // 预览里标题塌成普通段）；Word/WPS 的导航窗格也靠它。内联 sz/b 保留 ——
        // 老读取器与视觉不变
        val style = """<w:pStyle w:val="Heading${level.coerceIn(1, 4)}"/>"""
        return """<w:p><w:pPr>$style<w:spacing w:before="$before" w:after="100"/>${if (level == 1) """<w:jc w:val="center"/>""" else ""}</w:pPr>${inlineRuns(text, size = size, links = links)}</w:p>"""
            // 字面量替换必须用 String.replace(String, String)：原来写成 Regex.replace 是
            // 每个标题一次 replaceAll（建 Matcher + 正则引擎），而这里根本没有模式可匹配。
            .replace("<w:r><w:rPr>", "<w:r><w:rPr><w:b/>") // 标题整体加粗
    }

    private fun bullet(
        text: String,
        ordered: Boolean,
        index: Int,
        level: Int = 0,
        links: MutableList<Pair<String, String>>? = null,
    ): String {
        val mark = if (ordered) "$index. " else "• "
        val left = 420 + level * 360   // 嵌套层级缩进
        return """<w:p><w:pPr><w:ind w:left="$left" w:hanging="220"/><w:spacing w:before="0" w:after="60"/></w:pPr>${run(mark)}${inlineRuns(text, links = links)}</w:p>"""
    }

    private fun quote(text: String, links: MutableList<Pair<String, String>>? = null): String =
        """<w:p><w:pPr><w:ind w:left="420"/><w:spacing w:before="60" w:after="120"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C7C7CC"/></w:pBdr></w:pPr>${inlineRuns(text, color = "6C6C70", links = links)}</w:p>"""

    private fun codeBlock(code: String, lang: String): String {
        val sb = StringBuilder()
        val lines = code.split('\n')
        lines.forEach { l ->
            sb.append(
                """<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F7"/><w:ind w:left="200" w:right="200"/>""" +
                    """<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr>""" +
                    """<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:sz w:val="18"/></w:rPr>""" +
                    """<w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>"""
            )
        }
        val langNote = if (lang.isNotBlank()) """<w:p><w:pPr><w:spacing w:before="0" w:after="40"/></w:pPr>${run(lang, size = 16, color = "8E8E93")}</w:p>""" else ""
        return sb.toString() + langNote
    }

    private fun table(rows: List<List<String>>): String {
        if (rows.isEmpty()) return ""
        val cols = rows.maxOf { it.size }.coerceAtLeast(1)
        val width = 9000 / cols // 页面可用宽度约 9638 twips
        val sb = StringBuilder()
        sb.append("""<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>""")
        sb.append("""<w:tblBorders><w:top w:val="single" w:sz="4" w:color="D1D1D6"/><w:left w:val="single" w:sz="4" w:color="D1D1D6"/>""")
        sb.append("""<w:bottom w:val="single" w:sz="4" w:color="D1D1D6"/><w:right w:val="single" w:sz="4" w:color="D1D1D6"/>""")
        sb.append("""<w:insideH w:val="single" w:sz="4" w:color="D1D1D6"/><w:insideV w:val="single" w:sz="4" w:color="D1D1D6"/></w:tblBorders>""")
        sb.append("""<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>""")
        repeat(cols) { sb.append("""<w:gridCol w:w="$width"/>""") }
        sb.append("</w:tblGrid>")
        rows.forEachIndexed { ri, r ->
            val isHead = ri == 0
            sb.append("<w:tr>")
            if (isHead) sb.append("""<w:trPr><w:tblHeader/></w:trPr>""")
            for (c in 0 until cols) {
                val cellText = r.getOrElse(c) { "" }.replace("\n", " ")
                sb.append("""<w:tc><w:tcPr><w:tcW w:w="$width" w:type="dxa"/>""")
                sb.append("""<w:tcMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar>""")
                if (isHead) sb.append("""<w:shd w:val="clear" w:color="auto" w:fill="E8EEF7"/>""")
                sb.append("""</w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>""")
                sb.append(if (isHead) run(cellText, bold = true, size = 20) else run(cellText, size = 20))
                sb.append("</w:p></w:tc>")
            }
            sb.append("</w:tr>")
        }
        sb.append("</w:tbl>")
        // 表后留一点空隙，否则下一段会贴住表格
        sb.append("""<w:p><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr></w:p>""")
        return sb.toString()
    }

    private fun hr(): String =
        """<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D1D1D6"/></w:pBdr><w:spacing w:before="120" w:after="160"/></w:pPr></w:p>"""

    /* ======================= xlsx ======================= */

    /**
     * @param sheets 至少一张；名称会按 Excel 规则清洗（≤31 字、去掉 []:*?/\）
     */
    fun writeXlsx(f: File, sheets: List<Sheet>): Result {
        if (sheets.isEmpty()) throw KernelError("没有工作表可写")
        // 工作表重名会让 Excel 报「需要修复」甚至丢表：清洗后必须去重（追加 (2)/(3)）
        val used = HashSet<String>()
        val clean = sheets.mapIndexed { i, s ->
            var name = sanitizeSheetName(s.name, i)
            if (!used.add(name)) {
                var n = 2
                while (true) {
                    val cand = (name.take(31 - "($n)".length) + "($n)").take(31)
                    if (used.add(cand)) { name = cand; break }
                    n++
                }
            }
            Sheet(name, s.rows, s.header)
        }
        f.parentFile?.mkdirs()
        zip(f) { put ->
            put("[Content_Types].xml", contentTypesXlsx(clean.size))
            put("_rels/.rels", RELS_ROOT_XLSX)
            put("docProps/core.xml", coreProps("", "DeepSeek Harness"))
            put("docProps/app.xml", APP_XML_XLSX)
            put("xl/workbook.xml", workbook(clean))
            put("xl/_rels/workbook.xml.rels", workbookRels(clean.size))
            put("xl/styles.xml", STYLES_XLSX)
            clean.forEachIndexed { i, s -> put("xl/worksheets/sheet${i + 1}.xml", sheetXml(s)) }
        }
        val rows = clean.sumOf { it.rows.size }
        return Result("xlsx", f.length(), mutableMapOf("sheets" to clean.size, "rows" to rows))
    }

    /** CSV / TSV 文本 → 行（供 write_xlsx 的 content 简写用，带引号转义） */
    fun parseTable(text: String): List<List<String>> {
        val lines = text.replace("\r\n", "\n").replace('\r', '\n').split('\n').filter { it.isNotBlank() }
        if (lines.isEmpty()) return emptyList()
        val delim = if (lines[0].count { it == '\t' } > lines[0].count { it == ',' }) '\t' else ','
        return lines.map { line -> splitCsvLine(line, delim).map { it.trim() } }
    }

    private fun splitCsvLine(line: String, delim: Char): List<String> {
        val out = mutableListOf<String>()
        val sb = StringBuilder()
        var quoted = false
        var i = 0
        while (i < line.length) {
            val c = line[i]
            when {
                quoted && c == '"' && i + 1 < line.length && line[i + 1] == '"' -> { sb.append('"'); i++ }
                c == '"' -> quoted = !quoted
                c == delim && !quoted -> { out.add(sb.toString()); sb.clear() }
                else -> sb.append(c)
            }
            i++
        }
        out.add(sb.toString())
        return out
    }

    private fun sanitizeSheetName(name: String, index: Int): String {
        val base = name.trim().ifBlank { "Sheet${index + 1}" }
            .replace(RE_UNSAFE_NAME, " ")
            .trim()
        return base.take(31).ifBlank { "Sheet${index + 1}" }
    }

    private fun sheetXml(s: Sheet): String {
        val rows = s.rows.ifEmpty { listOf(emptyList()) }
        val cols = rows.maxOf { it.size }.coerceAtLeast(1)
        val sb = StringBuilder()
        val lastCol = colName(cols)
        sb.append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""")
        sb.append("""<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">""")
        sb.append("""<dimension ref="A1:$lastCol${rows.size}"/>""")
        sb.append("""<sheetViews><sheetView workbookViewId="0">""")
        if (s.header && rows.size > 1) {
            sb.append("""<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>""")
        }
        sb.append("</sheetView></sheetViews>")
        sb.append("""<sheetFormatPr defaultRowHeight="18"/>""")
        // 列宽：按该列最长内容估，中文按 2 个字符算，夹在 8–52 之间
        sb.append("<cols>")
        for (c in 0 until cols) {
            val maxLen = rows.map { cell -> displayLen(cell.getOrElse(c) { "" }) }.maxOrNull() ?: 0
            val w = (maxLen + 2).coerceIn(8, 52)
            sb.append("""<col min="${c + 1}" max="${c + 1}" width="$w" customWidth="1"/>""")
        }
        sb.append("</cols><sheetData>")
        rows.forEachIndexed { ri, row ->
            sb.append("""<row r="${ri + 1}"${if (s.header && ri == 0) """ ht="20" customHeight="1"""" else ""}>""")
            for (c in 0 until cols) {
                val raw = row.getOrElse(c) { "" }
                if (raw.isEmpty()) continue
                val ref = "${colName(c + 1)}${ri + 1}"
                val num = isNumber(raw)
                // 长文本套「自动换行 + 顶端对齐」：列宽有上限，不换行的话长句会被
                // 右边单元格盖住，看起来像数据丢了
                val style = when {
                    s.header && ri == 0 -> """ s="1""""
                    !num && displayLen(raw) > 24 -> """ s="2""""
                    else -> ""
                }
                if (num) {
                    sb.append("""<c r="$ref"$style><v>${raw}</v></c>""")
                } else {
                    sb.append("""<c r="$ref"$style t="inlineStr"><is><t xml:space="preserve">${esc(raw)}</t></is></c>""")
                }
            }
            sb.append("</row>")
        }
        sb.append("</sheetData>")
        if (s.header && rows.size > 1) {
            sb.append("""<autoFilter ref="A1:$lastCol${rows.size}"/>""")
        }
        sb.append("</worksheet>")
        return sb.toString()
    }

    private fun displayLen(s: String): Int = s.fold(0) { acc, c -> acc + if (c.code > 0x2E80) 2 else 1 }

    private fun isNumber(s: String): Boolean {
        if (s.length > 15) return false
        if (s.startsWith("0") && s.length > 1 && s[1] != '.') return false // 007、086 这类编号保持文本
        return RE_NUMERIC.matches(s)
    }

    private fun colName(n: Int): String {
        var x = n
        val sb = StringBuilder()
        while (x > 0) {
            val r = (x - 1) % 26
            sb.insert(0, ('A' + r))
            x = (x - 1) / 26
        }
        return sb.toString()
    }

    /* ======================= zip ======================= */

    /**
     * 把若干文件打成 .zip（条目名 = 归档内路径）。
     *
     * 手机上「这批文件发给同事」最自然的交付形态就是压缩包，而 Android 没有 zip
     * 命令行工具 —— 之前模型只能一个文件一个文件地交付。
     */
    fun writeZip(f: File, entries: List<Pair<String, File>>): Result {
        if (entries.isEmpty()) throw KernelError("没有要打包的文件")
        var bytes = 0L
        var count = 0
        f.parentFile?.mkdirs()
        ZipOutputStream(f.outputStream().buffered()).use { zos ->
            val seen = HashSet<String>()
            for ((name, src) in entries) {
                if (!src.isFile) continue
                var entry = name.replace('\\', '/').trimStart('/')
                if (entry.isBlank()) entry = src.name
                if (!seen.add(entry)) continue
                zos.putNextEntry(ZipEntry(entry).apply { time = src.lastModified() })
                src.inputStream().buffered().use { it.copyTo(zos, 64 * 1024) }
                zos.closeEntry()
                bytes += src.length()
                count++
            }
        }
        if (bytes == 0L) { f.delete(); throw KernelError("没有可打包的内容（源文件都不存在）") }
        return Result("zip", f.length(), mutableMapOf("entries" to count, "raw" to bytes))
    }

    /* ======================= 公共部件 ======================= */

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
                ch.code < 0x20 && ch != '\t' && ch != '\n' -> Unit // XML 1.0 不允许的控制字符
                else -> append(ch)
            }
        }
    }

    private fun coreProps(title: String, author: String): String = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><cp:lastModifiedBy>${esc(author)}</cp:lastModifiedBy>
</cp:coreProperties>"""

    private val RELS_ROOT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

    private val RELS_ROOT_XLSX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

    private fun contentTypesXlsx(n: Int): String = buildString {
        append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""")
        append("""<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">""")
        append("""<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>""")
        append("""<Default Extension="xml" ContentType="application/xml"/>""")
        append("""<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>""")
        append("""<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>""")
        for (i in 1..n) {
            append("""<Override PartName="/xl/worksheets/sheet$i.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>""")
        }
        append("""<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>""")
        append("""<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>""")
        append("</Types>")
    }

    private val STYLES_DOCX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>
<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="100"/><w:outlineLvl w:val="3"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="D1D1D6"/><w:left w:val="single" w:sz="4" w:color="D1D1D6"/>
<w:bottom w:val="single" w:sz="4" w:color="D1D1D6"/><w:right w:val="single" w:sz="4" w:color="D1D1D6"/>
<w:insideH w:val="single" w:sz="4" w:color="D1D1D6"/><w:insideV w:val="single" w:sz="4" w:color="D1D1D6"/>
</w:tblBorders></w:tblPr></w:style>
</w:styles>"""

    private val APP_XML_DOCX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DSH Mobile</Application></Properties>"""

    private val APP_XML_XLSX = APP_XML_DOCX

    private fun workbook(sheets: List<Sheet>): String = buildString {
        append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""")
        append("""<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" """)
        append("""xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>""")
        sheets.forEachIndexed { i, s ->
            append("""<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>""")
        }
        append("</sheets></workbook>")
    }

    private fun workbookRels(n: Int): String = buildString {
        append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""")
        append("""<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">""")
        for (i in 1..n) {
            append("""<Relationship Id="rId$i" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet$i.xml"/>""")
        }
        append("""<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>""")
        append("</Relationships>")
    }

    /** 0 = 普通，1 = 表头（加粗 + 灰底 + 边框），2 = 长文本自动换行 + 顶端对齐 */
    private val STYLES_XLSX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF${Palette.ACCENT}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD1D1D6"/></left><right style="thin"><color rgb="FFD1D1D6"/></right>
<top style="thin"><color rgb="FFD1D1D6"/></top><bottom style="thin"><color rgb="FFD1D1D6"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""
}
