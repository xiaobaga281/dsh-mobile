package ai.deepseek.harness.mobile.kernel.doc

import ai.deepseek.harness.mobile.kernel.KernelError
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.Inflater
import java.util.zip.ZipFile

/**
 * 文档正文抽取 —— 让 Agent 能读 PDF / Word / Excel / PowerPoint。
 *
 * 为什么必须自己实现而不引库：
 *   安卓端没有 Node 运行时，也不可能为读一个 Word 文件拉进几十 MB 的 Apache POI。
 *   而这些格式的正文其实都在可解析的位置：
 *     .docx / .xlsx / .pptx 本质是 ZIP + XML（OOXML），解压后按标签取文本即可；
 *     .pdf 的文本在 FlateDecode 压缩的 content stream 里，解压后按 Tj/TJ 操作符取串。
 *   只做「抽取正文」这一件事，纯 JDK 就能覆盖绝大多数真实文档。
 *
 * 已知边界（如实返回，不假装成功）：
 *   - 扫描件 PDF（纯图）没有文本层，抽不出字 —— 返回页数并建议按图片查看；
 *   - CID 字体编码的 PDF 需要 ToUnicode CMap 才能还原，这里做 UTF-16BE 兜底，
 *     中文文档可能仍有乱码 —— 结果里给出可读比例，低于阈值就明确提示。
 */
object DocReader {

    /** 抽取结果：正文 + 供模型判断的元信息 */
    data class Result(
        val kind: String,
        val text: String,
        val meta: MutableMap<String, Any> = mutableMapOf(),
    )

    private val SUPPORTED = setOf(
        "pdf", "docx", "docm", "xlsx", "xlsm", "pptx", "pptm",
        "txt", "md", "markdown", "csv", "tsv", "json", "log", "html", "htm", "xml", "yaml", "yml",
    )

    fun supports(ext: String): Boolean = ext.lowercase() in SUPPORTED

    fun extensions(): Set<String> = SUPPORTED

    fun read(f: File, maxChars: Int = 60_000): Result {
        if (!f.exists()) throw KernelError("文件不存在：${f.name}")
        if (!f.isFile) throw KernelError("这是目录，不是文件：${f.name}")
        val ext = f.extension.lowercase()
        if (!supports(ext)) {
            val legacy = ext == "doc" || ext == "xls" || ext == "ppt"
            throw KernelError(
                if (legacy) "旧版 Office 格式（.$ext）是二进制 OLE 容器，读不出来。" +
                    "请让用户用 Office/WPS 另存为 .${ext}x 再发一次；或者用 present 交给系统应用打开后截图。"
                else "不支持的文档类型 .$ext（支持：${SUPPORTED.sorted().joinToString(" / ")}）；" +
                    "二进制文件可用 present 交给系统应用打开"
            )
        }
        val res = when (ext) {
            "docx", "docm" -> readDocx(f)
            "xlsx", "xlsm" -> readXlsx(f)
            "pptx", "pptm" -> readPptx(f)
            "pdf" -> readPdf(f)
            else -> Result(ext, f.readText().let { if (it.length > maxChars) it.take(maxChars) + "\n[已截断]" else it })
        }
        res.meta["bytes"] = f.length()
        if (res.text.length > maxChars) {
            res.meta["truncated"] = true
            res.meta["chars"] = res.text.length
            return res.copy(text = res.text.take(maxChars))
        }
        return res
    }

    /* ---------------- OOXML ---------------- */

    private fun readDocx(f: File): Result = unzip(f) { zip ->
        val body = entry(zip, "word/document.xml")
            ?: throw KernelError("不是有效的 .docx：缺少 word/document.xml")
        val out = StringBuilder()
        // 逐段落处理：<w:p> 是段落，<w:t> 是文本段，<w:tab/> 制表，<w:br/> 换行
        Regex("<w:p[ >][\\s\\S]*?</w:p>|<w:p/>").findAll(body).forEach { m ->
            val p = m.value
            val line = StringBuilder()
            Regex("<w:(t|tab|br|cr)(?:\\s[^>]*)?/?>(?:([\\s\\S]*?)</w:\\1>)?").findAll(p).forEach { t ->
                when (t.groupValues[1]) {
                    "t" -> line.append(xmlUnescape(t.groupValues[2]))
                    "tab" -> line.append('\t')
                    "br", "cr" -> line.append('\n')
                }
            }
            val s = line.toString().trimEnd()
            // 表格单元格之间补 tab：一段一段拼容易糊成一行，这里按 <w:tc> 粗分
            if (p.contains("<w:tc")) out.append(s.replace(Regex("(?<=[^\\t])\\n"), "\t")) else out.append(s)
            out.append('\n')
        }
        // 表格结构在段落流里会丢列边界，用 <w:tbl> 单独再抽一遍补上（放在正文前作为附录）
        val tables = extractDocxTables(body)
        val text = buildString {
            append(out.toString().trim())
            if (tables.isNotBlank()) append("\n\n【表格】\n").append(tables)
        }.trim()
        if (text.isBlank()) throw KernelError("这个 Word 文档里没有可抽取的文字（可能是图片版）")
        return@unzip Result("docx", text, mutableMapOf("paragraphs" to out.count { it == '\n' }))
    }

    private fun extractDocxTables(body: String): String {
        val sb = StringBuilder()
        Regex("<w:tbl>[\\s\\S]*?</w:tbl>").findAll(body).forEachIndexed { ti, tbl ->
            sb.append("表 ${ti + 1}：\n")
            Regex("<w:tr[ >][\\s\\S]*?</w:tr>").findAll(tbl.value).forEach { row ->
                val cells = Regex("<w:tc>[\\s\\S]*?</w:tc>").findAll(row.value).map { c ->
                    Regex("<w:t(?:\\s[^>]*)?>([\\s\\S]*?)</w:t>").findAll(c.value)
                        .joinToString("") { xmlUnescape(it.groupValues[1]) }.trim()
                }
                sb.append(cells.joinToString(" | ")).append('\n')
            }
            sb.append('\n')
        }
        return sb.toString().trim()
    }

    private fun readXlsx(f: File): Result = unzip(f) { zip ->
        // 共享字符串表：单元格 t="s" 时存的是这里的下标
        val shared = ArrayList<String>()
        entry(zip, "xl/sharedStrings.xml")?.let { xml ->
            Regex("<si>[\\s\\S]*?</si>").findAll(xml).forEach { si ->
                val s = Regex("<t(?:\\s[^>]*)?>([\\s\\S]*?)</t>").findAll(si.value)
                    .joinToString("") { xmlUnescape(it.groupValues[1]) }
                shared.add(s)
            }
        }
        val sheets = zip.entries().toList()
            .filter { it.name.startsWith("xl/worksheets/") && it.name.endsWith(".xml") }
            .sortedBy { it.name }
        if (sheets.isEmpty()) throw KernelError("不是有效的 .xlsx：没有工作表")
        val sb = StringBuilder()
        var rows = 0
        sheets.forEachIndexed { idx, sh ->
            val xml = zip.getInputStream(sh).bufferedReader().readText()
            sb.append("【工作表 ${idx + 1}】").append('\n')
            Regex("<row[^>]*>([\\s\\S]*?)</row>").findAll(xml).forEach { row ->
                rows++
                val cells = Regex("<c([^>]*)>([\\s\\S]*?)</c>|<c([^>]*)/>").findAll(row.value).map { c ->
                    val attrs = c.groupValues[1].ifBlank { c.groupValues[3] }
                    val inner = c.groupValues[2]
                    val type = Regex("t=\"([^\"]+)\"").find(attrs)?.groupValues?.get(1)
                    val v = Regex("<v>([\\s\\S]*?)</v>").find(inner)?.groupValues?.get(1)
                    val inline = Regex("<t(?:\\s[^>]*)?>([\\s\\S]*?)</t>").find(inner)?.groupValues?.get(1)
                    when {
                        type == "s" && v != null -> shared.getOrNull(v.toIntOrNull() ?: -1) ?: ""
                        type == "inlineStr" -> xmlUnescape(inline ?: "")
                        v != null -> xmlUnescape(v)
                        else -> ""
                    }
                }.toList()
                // 去掉整行空单元格占位，保持列顺序
                sb.append(cells.joinToString("\t").trimEnd()).append('\n')
            }
            sb.append('\n')
        }
        val text = sb.toString().trim()
        if (text.isBlank()) throw KernelError("这个表格里没有内容")
        return@unzip Result("xlsx", text, mutableMapOf("sheets" to sheets.size, "rows" to rows))
    }

    private fun readPptx(f: File): Result = unzip(f) { zip ->
        val slides = zip.entries().toList()
            .filter { it.name.matches(Regex("ppt/slides/slide\\d+\\.xml")) }
            .sortedBy { Regex("(\\d+)").find(it.name)?.groupValues?.get(1)?.toIntOrNull() ?: 0 }
        if (slides.isEmpty()) throw KernelError("不是有效的 .pptx：没有幻灯片")
        val sb = StringBuilder()
        slides.forEachIndexed { i, s ->
            val xml = zip.getInputStream(s).bufferedReader().readText()
            val line = Regex("<a:t(?:\\s[^>]*)?>([\\s\\S]*?)</a:t>").findAll(xml)
                .joinToString("\n") { xmlUnescape(it.groupValues[1]) }
            sb.append("【第 ${i + 1} 页】\n").append(line.trim()).append("\n\n")
        }
        return@unzip Result("pptx", sb.toString().trim(), mutableMapOf("slides" to slides.size))
    }

    private fun <T> unzip(f: File, block: (ZipFile) -> T): T = try {
        ZipFile(f).use(block)
    } catch (e: KernelError) {
        throw e
    } catch (t: Throwable) {
        throw KernelError("读取失败：文件可能不是有效的 Office 文档（${t.message ?: t.javaClass.simpleName}）")
    }

    private fun entry(zip: ZipFile, name: String): String? {
        val e = zip.getEntry(name) ?: return null
        return zip.getInputStream(e).bufferedReader().readText()
    }

    private fun xmlUnescape(s: String): String = s
        .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")

    /* ---------------- PDF ---------------- */

    private fun readPdf(f: File): Result {
        val bytes = f.readBytes()
        val raw = String(bytes, Charsets.ISO_8859_1)
        val pages = Regex("/Type\\s*/Page[^s]").findAll(raw).count().coerceAtLeast(1)
        val streams = Regex("/FlateDecode").findAll(raw).count()
        // 中文 PDF 全是 CID 编码，必须走 /ToUnicode 映射（见 PdfText）
        var text = PdfText.extract(bytes).trim()
        val readable = text.count { it == ' ' || it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it.code in 0x4E00..0x9FFF }
        val ratio = if (text.isEmpty()) 0.0 else readable.toDouble() / text.length
        if (text.length < 40 || ratio < 0.5) {
            return Result(
                "pdf",
                "",
                mutableMapOf(
                    "pages" to pages,
                    "streams" to streams,
                    "textLayer" to false,
                    "note" to "这个 PDF 没有可用的文本层（扫描件或加密）：抽不出正文。" +
                        "可以让用户用「打开文件」按图片方式查看，或用 read_image / phone_screenshot 看图。",
                ),
            )
        }
        text = text.replace(Regex("[ \\t]{2,}"), " ").replace(Regex("\\n{3,}"), "\n\n")
        return Result("pdf", text, mutableMapOf("pages" to pages, "streams" to streams, "textLayer" to true))
    }
}
