package ai.deepseek.harness.mobile.kernel.preview

import android.util.Base64
import android.util.Xml
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import java.io.ByteArrayOutputStream
import ai.deepseek.harness.mobile.kernel.doc.PdfText
import java.io.File
import java.util.zip.Inflater
import java.util.zip.ZipFile

/**
 * 文档预览 —— 让 PPT / Docs / 表格等格式在对话与文件页里直接渲染，而不是只能甩给系统应用。
 *
 * OOXML（docx / pptx / xlsx）本质是 zip + XML，这里按需取最少的信息：
 *   - docx  → word/document.xml：段落、标题层级（pStyle）、表格（w:tbl/w:tr/w:tc）
 *   - pptx  → ppt/slides/slide*.xml：每页标题 + 要点
 *   - xlsx  → xl/workbook.xml + sharedStrings.xml + worksheets/sheet*.xml：表格
 *   - pdf   → 内容流文本提取（解 FlateDecode，取 Tj/TJ 文本；非版式还原）
 *   - csv/tsv → 表格（引号转义、前 300 行）
 *   - json  → 格式化（缩进 + 前端语法着色）
 *   - 图片   → png/jpeg/webp/gif/svg 转 base64 直接渲染（桌面附件 v1 同款四图格式 + svg）
 *   - 代码   → 等宽 + 行号 + 语言标注
 *   - html  → 剥标签取正文文本
 *   - 其余   → 文本类按纯文本渲染
 *
 * 明确的取舍（不假装完整）：
 *   - 不解析样式、图片、批注、页眉页脚、公式结果（xlsx 公式读缓存值，读不到留空）
 *   - 深度嵌套的合并单元格按普通单元格处理
 *   - 只读第一个工作表（xlsx）与可见文本（docx），够「看懂这份文件」用
 *   - PDF 只提文本不排版；加密/扫描件会失败并建议外部应用打开
 */
object DocPreview {

    /** 对话流里直接渲染的位图格式（桌面 attachment v1 的 ImageMediaType + svg） */
    private val IMAGE_EXT = setOf("png", "jpg", "jpeg", "webp", "gif", "svg")

    /** 交付物里的音频（agent 合成/生成的 .wav 等）：应用内直接播，不再甩给系统应用 */
    private val AUDIO_EXT = mapOf(
        "wav" to "audio/wav", "wave" to "audio/wav",
        "mp3" to "audio/mpeg", "aac" to "audio/aac", "ogg" to "audio/ogg",
        "opus" to "audio/opus", "m4a" to "audio/mp4", "flac" to "audio/flac",
    )

    /**
     * 交付物里的视频：不在应用内解码（几十 MB 的 base64 过桥会卡死），
     * 只回 kind/mime 让界面画缩略方块，点开交系统播放器。
     */
    private val VIDEO_EXT = mapOf(
        "mp4" to "video/mp4", "m4v" to "video/mp4", "mov" to "video/quicktime",
        "webm" to "video/webm", "mkv" to "video/x-matroska", "3gp" to "video/3gpp",
    )

    private val CODE_EXT = mapOf(
        "kt" to "Kotlin", "java" to "Java", "ts" to "TypeScript", "tsx" to "TypeScript",
        "js" to "JavaScript", "jsx" to "JavaScript", "py" to "Python", "go" to "Go",
        "rs" to "Rust", "c" to "C", "cc" to "C++", "cpp" to "C++", "h" to "C/C++",
        "swift" to "Swift", "rb" to "Ruby", "php" to "PHP", "cs" to "C#",
        "sh" to "Shell", "sql" to "SQL", "yaml" to "YAML", "yml" to "YAML",
        "toml" to "TOML", "xml" to "XML", "css" to "CSS", "gradle" to "Gradle",
    )

    fun preview(f: File): JSONObject {
        val name = f.name.lowercase()
        val base = JSONObject().apply {
            put("name", f.name)
            put("size", f.length())
            put("path", f.absolutePath)
        }
        return runCatching {
            when {
                name.endsWith(".docx") -> base.put("kind", "docx").put("title", f.name)
                    .put("html", gen(renderDocx(f)))
                name.endsWith(".pptx") -> base.put("kind", "pptx").put("title", f.name)
                    .put("html", gen(renderPptx(f)))
                name.endsWith(".xlsx") -> base.put("kind", "xlsx").put("title", f.name)
                    .put("html", gen(renderXlsx(f)))
                name.endsWith(".pdf") -> base.put("kind", "pdf").put("title", f.name)
                    .put("html", gen(renderPdf(f)))
                name.endsWith(".csv") || name.endsWith(".tsv") -> base.put("kind", "table")
                    .put("title", f.name).put("html", gen(renderDelimited(f, name.endsWith(".tsv"))))
                name.endsWith(".json") -> base.put("kind", "json").put("title", f.name)
                    .put("html", gen(renderJson(f)))
                name.endsWith(".html") || name.endsWith(".htm") -> base.put("kind", "html")
                    .put("title", f.name).put("text", sanitizeHtml(readText(f).take(500_000)))
                name.endsWith(".md") || name.endsWith(".markdown") -> base.put("kind", "markdown")
                    .put("title", f.name).put("text", readText(f).take(200_000))
                    .put("html", "<pre class=\"pv-pre\">" + esc(readText(f).take(200_000)) + "</pre>")
                name.endsWith(".svg") -> base.put("kind", "image").put("title", f.name)
                    .put("mime", "image/svg+xml").put("data_base64", Base64.encodeToString(f.readBytes(), Base64.NO_WRAP))
                f.extension.lowercase() in IMAGE_EXT -> base.put("kind", "image").put("title", f.name)
                    .put("mime", mimeOf(f.extension.lowercase()))
                    .put("data_base64", Base64.encodeToString(f.readBytes(), Base64.NO_WRAP))
                AUDIO_EXT.containsKey(f.extension.lowercase()) -> {
                    if (f.length() > 16L * 1024 * 1024) {
                        base.put("kind", "text").put("title", f.name)
                            .put("html", "<pre class=\"pv-pre\">音频文件超过 16MB，无法在应用内预览，请用「用其它应用打开」。</pre>")
                    } else {
                        base.put("kind", "audio").put("title", f.name)
                            .put("mime", AUDIO_EXT[f.extension.lowercase()])
                            .put("data_base64", Base64.encodeToString(f.readBytes(), Base64.NO_WRAP))
                    }
                }
                VIDEO_EXT.containsKey(f.extension.lowercase()) -> base.put("kind", "video")
                    .put("title", f.name).put("mime", VIDEO_EXT[f.extension.lowercase()])
                f.extension.lowercase() in CODE_EXT -> base.put("kind", "code")
                    .put("title", f.name).put("lang", CODE_EXT[f.extension.lowercase()])
                    .put("html", "<pre class=\"pv-pre\">" + esc(readText(f).take(200_000)) + "</pre>")
                name.endsWith(".zip") || name.endsWith(".jar") -> base.put("kind", "zip")
                    .put("title", f.name).put("html", gen(renderZip(f)))
                else -> {
                    // 二进制兜底：把字节当文本读会是一屏乱码（write_zip 的产物、apk、7z…）。
                    // 嗅探到二进制就交系统查看器（openWorkspaceFile 对 kind=error 的既定分流），
                    // 文本类才走纯文本渲染。
                    if (looksBinary(f)) {
                        base.put("kind", "error").put("title", f.name)
                            .put("error", "二进制文件（${f.length() / 1024} KB），应用内不预览，已交给系统查看器")
                    } else {
                        base.put("kind", "text").put("title", f.name)
                            .put("html", "<pre class=\"pv-pre\">" + esc(readText(f).take(200_000)) + "</pre>")
                    }
                }
            }
        }.getOrElse { e ->
            base.put("kind", "error").put("error", "预览失败：${e.message ?: e.javaClass.simpleName}")
        }
    }

    /** 生成类预览 HTML 的第二道闸：见 [HtmlSanitizer.sanitizeGenerated] */
    private fun gen(html: String): String = HtmlSanitizer.sanitizeGenerated(html)

    private fun readText(f: File): String = f.readText()

    /**
     * zip / jar 清单：条目名 + 原始大小，目录条目折叠为计数。
     * write_zip 的交付物此前落到「文本」分支按字节读 —— 一屏乱码；
     * 现在给可读的打包清单（前 60 条 + 总计），判定「里面有什么、多大」足够。
     */
    private fun renderZip(f: File): String {
        val entries = ZipFile(f).use { z ->
            z.entries().asSequence().filterNot { it.isDirectory }
                .map { it.name to it.size }
                .toList()
        }
        if (entries.isEmpty()) return "<div class=\"pv-empty\">压缩包是空的</div>"
        val totalBytes = entries.sumOf { it.second }
        val shown = entries.take(60)
        val sb = StringBuilder()
        sb.append("<div class=\"pv-meta\">${entries.size} 个文件 · 共 $totalBytes 字节")
        if (entries.size > shown.size) sb.append(" · 仅显示前 ${shown.size} 条")
        sb.append("</div><table class=\"pv-table\">")
        for ((n, size) in shown) {
            sb.append("<tr><td class=\"pv-td\">").append(esc(n))
                .append("</td><td class=\"pv-td\">").append(size).append("</td></tr>")
        }
        sb.append("</table>")
        return sb.toString()
    }

    /**
     * 二进制嗅探：控制字符（除 \t \n \r \f \b）占比 >5% 视为二进制。
     * 只看前 8KB —— 足够分辨文本与字节流，也不至于为大文件付全量扫描的成本。
     * 注意字节要按**无符号**比：中文 UTF-8 的字节全部 ≥0x80，有符号比较会把正文全当控制字符。
     */
    private fun looksBinary(f: File): Boolean {
        // 不用 InputStream.readNBytes：它是 API 33 才有的（minSdk 26），
        // 在低版本设备上会直接 NoSuchMethodError。手动读满 8KB 即可。
        val head = f.inputStream().use { input ->
            val buf = ByteArray(8 * 1024)
            var total = 0
            while (total < buf.size) {
                val n = input.read(buf, total, buf.size - total)
                if (n <= 0) break
                total += n
            }
            buf.copyOf(total)
        }
        if (head.isEmpty()) return false
        if (head.size >= 4 && head[0] == 0x50.toByte() && head[1] == 0x4B.toByte()) return true  // zip 系魔数
        var ctrl = 0
        for (b in head) {
            val u = b.toInt() and 0xFF
            if (u == 0x09 || u == 0x0A || u == 0x0D || u == 0x0C || u == 0x08) continue
            if (u < 0x20 || u == 0x7F) ctrl++
        }
        return ctrl * 20 > head.size
    }

    private fun mimeOf(ext: String): String = when (ext) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "svg" -> "image/svg+xml"
        else -> "application/octet-stream"
    }

    /* ---------------- pdf：内容流文本提取 ---------------- */

    /**
     * 轻量 PDF 文本提取：定位 stream…endstream，按 /Filter 处理 FlateDecode，
     * 再从内容流里取 `(...) Tj` / `[...] TJ` / `'` / `"` 的文本，按 Td/TD/T* 折行。
     * 只提文本不还原版式；扫描件/加密件会失败，调用方据此建议外部应用。
     */
    private fun renderPdf(f: File): String {
        val bytes = f.readBytes()
        val text = extractPdfText(bytes)
        if (text.isBlank()) {
            return "<div class=\"pv-empty\">没能从这份 PDF 提取到文本。" +
                "可能是扫描件（纯图像）或加密文件；建议点右上角用其它应用打开。</div>"
        }
        val head = "<div class=\"pv-meta\">文本提取（非版式还原）· ${text.length} 字符</div>"
        return head + "<pre class=\"pv-pre\">" + esc(mergePdfParagraphs(text).take(100_000)) + "</pre>"
    }

    /**
     * PDF 文本提取按视觉行断行（提取器见 [PdfText]，逐 Td/T* 折行），
     * 中文一句会被切成好几个短行，直接贴出来满屏断句。
     * 这里做**最保守**的重排：仅当上一行末尾是 CJK 字符（含扩展 A/兼容表意）且下一行
     * 不是列表/符号开头时折行合并 —— 行尾的 ASCII 标点/符号（文件名的「.」、提取器的
     * 「*」「•」碎片）一律不碰，宁可多断一行也不把不该接的接上。
     */
    private fun mergePdfParagraphs(text: String): String {
        val lines = text.lines()
        val out = StringBuilder()
        var para = StringBuilder()
        val startsList = Regex("^\\s*([-*•·]|\\d{1,3}[.、）)]|[一二三四五六七八九十]+[、.．）]|[（(]\\d{1,3}[）)])")
        for (line in lines) {
            val l = line.trimEnd()
            if (l.isBlank()) {
                if (para.isNotEmpty()) { out.append(para).append('\n'); para.clear() }
                out.append('\n')
                continue
            }
            val last = para.toString().trimEnd().lastOrNull()
            val cjkTail = last != null && (last.code in 0x3400..0x9FFF || last.code in 0xF900..0xFAFF)
            if (para.isNotEmpty() && cjkTail && !startsList.containsMatchIn(l)) {
                para.append(l)
            } else {
                if (para.isNotEmpty()) out.append(para).append('\n')
                para.clear()
                para.append(l)
            }
        }
        if (para.isNotEmpty()) out.append(para)
        return out.toString()
    }

    /** 中文 PDF 是 CID 编码，必须顺着 /ToUnicode 映射回来（实现见 [PdfText]） */
    private fun extractPdfText(bytes: ByteArray): String = PdfText.extract(bytes)

    /* ---------------- csv / tsv：表格 ---------------- */

    private fun renderDelimited(f: File, tab: Boolean): String {
        val sep = if (tab) '\t' else ','
        val rows = mutableListOf<List<String>>()
        var field = StringBuilder()
        var row = mutableListOf<String>()
        var inQuotes = false
        val text = readText(f).take(2_000_000)
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                inQuotes && c == '"' && i + 1 < text.length && text[i + 1] == '"' -> { field.append('"'); i += 2 }
                c == '"' -> { inQuotes = !inQuotes; i++ }
                !inQuotes && c == sep -> { row.add(field.toString()); field = StringBuilder(); i++ }
                !inQuotes && (c == '\n' || c == '\r') -> {
                    if (c == '\r' && i + 1 < text.length && text[i + 1] == '\n') i++
                    row.add(field.toString()); field = StringBuilder()
                    if (row.any { it.isNotBlank() }) rows.add(row)
                    row = mutableListOf()
                    i++
                }
                else -> { field.append(c); i++ }
            }
        }
        if (field.isNotEmpty() || row.isNotEmpty()) {
            row.add(field.toString())
            if (row.any { it.isNotBlank() }) rows.add(row)
        }
        if (rows.isEmpty()) return "<div class=\"pv-empty\">空表格</div>"
        val truncated = rows.size > 300
        val shown = rows.take(300)
        val sb = StringBuilder()
        sb.append("<div class=\"pv-meta\">${shown.size} 行 × ${shown.maxOf { it.size }} 列")
        if (truncated) sb.append(" · 仅显示前 300 行")
        sb.append("</div><table class=\"pv-table\">")
        shown.forEachIndexed { r, cells ->
            sb.append("<tr>")
            for (c in 0 until shown.maxOf { it.size }) {
                val cell = cells.getOrElse(c) { "" }
                if (r == 0) sb.append("<th class=\"pv-th\">${esc(cell)}</th>")
                else sb.append("<td class=\"pv-td\">${esc(cell)}</td>")
            }
            sb.append("</tr>")
        }
        sb.append("</table>")
        return sb.toString()
    }

    /* ---------------- json：格式化 ---------------- */

    private fun renderJson(f: File): String {
        val text = readText(f).take(500_000)
        val pretty = runCatching { JSONObject(text).toString(2) }.getOrNull()
            ?: runCatching { org.json.JSONArray(text).toString(2) }.getOrNull()
            ?: return "<div class=\"pv-empty\">不是合法 JSON：${esc(text.take(80))}</div>"
        return "<pre class=\"pv-pre\">" + esc(pretty) + "</pre>"
    }

    /* ---------------- html：净化后交 WebView 渲染 ---------------- */

    /**
     * HTML 净化：逻辑在 [HtmlSanitizer]（纯 JVM 可单测）。
     * rc.97 起内联脚本保留（前端 sandbox="allow-scripts" 兜底、无同源），
     * 外链资源一律不发请求 —— 详见 HtmlSanitizer 的安全模型注释。
     */
    private fun sanitizeHtml(raw: String): String = HtmlSanitizer.sanitize(raw)

    private fun esc(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&#39;")

    private fun zipText(f: File, entry: String): String? {
        ZipFile(f).use { z ->
            val e = z.getEntry(entry) ?: return null
            return z.getInputStream(e).bufferedReader().use { it.readText() }
        }
    }

    /* ---------------- docx ---------------- */

    private fun renderDocx(f: File): String {
        val xml = zipText(f, "word/document.xml") ?: return "<p>（没有找到 word/document.xml）</p>"
        val p = Xml.newPullParser().apply {
            // 必须处理命名空间，否则 name 返回 "w:p" 这种全名而不是本地名 "p"
            setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            setInput(xml.reader())
        }
        val sb = StringBuilder()
        var event = p.eventType
        var inPara = false
        var paraClass = ""
        val para = StringBuilder()
        var inTable = false
        var inCell = false
        var tableCount = 0

        fun flushPara() {
            if (!inPara) return
            val text = para.toString().trim()
            if (text.isNotEmpty()) {
                val tag = when {
                    paraClass.contains("Title") -> "h1"
                    paraClass.contains("Heading1") -> "h1"
                    paraClass.contains("Heading2") -> "h2"
                    paraClass.contains("Heading3") -> "h3"
                    else -> "p"
                }
                sb.append("<$tag class=\"pv-$tag\">${esc(text)}</$tag>")
            }
            para.clear(); inPara = false; paraClass = ""
        }

        while (event != XmlPullParser.END_DOCUMENT) {
            when (event) {
                XmlPullParser.START_TAG -> when (p.name) {
                    "p" -> { flushPara(); inPara = true }
                    "pStyle" -> paraClass = p.nextText().orEmpty()
                    "tbl" -> { flushPara(); inTable = true; sb.append("<table class=\"pv-table\">") }
                    "tr" -> if (inTable) sb.append("<tr>")
                    "tc" -> { inCell = true; if (inTable) sb.append("<td class=\"pv-td\">") }
                    "t" -> if (inPara) para.append(p.nextText())
                    else -> if (inCell && inTable) sb.append(" ")
                }
                XmlPullParser.END_TAG -> when (p.name) {
                    "p" -> flushPara()
                    "tc" -> { inCell = false; if (inTable) sb.append("</td>") }
                    "tr" -> if (inTable) sb.append("</tr>")
                    "tbl" -> if (inTable) { sb.append("</table>"); inTable = false; tableCount++ }
                }
            }
            event = p.next()
        }
        if (sb.isBlank()) sb.append("<p>（文档没有可提取的正文）</p>")
        val head = if (tableCount > 0) "<p class=\"pv-meta\">含 $tableCount 个表格</p>" else ""
        return head + sb
    }

    /* ---------------- pptx ---------------- */

    /**
     * pptx 预览：shape 级版式还原（解析器见 [PptxLayoutParser]）。
     * 每页渲染为 16:9 画布（.pv-slide）+ 绝对定位形状（.pv-shp），位置/尺寸
     * 按 EMU→百分比换算，字号用 cqw 随容器等比缩放（px fallback 在前）。
     * 解析失败退回纯文本大纲（旧启发式），保证任何 pptx 至少内容可读。
     */
    private fun renderPptx(f: File): String {
        val sb = StringBuilder()
        val slides = sortedSlides(f)
        if (slides.isEmpty()) return "<p>（没有找到幻灯片）</p>"
        val (slideW, slideH) = zipText(f, "ppt/presentation.xml")
            ?.let { PptxLayoutParser.presentationSize(it) } ?: (12192000L to 6858000L)
        slides.forEachIndexed { idx, xml ->
            val slide = runCatching { PptxLayoutParser.parseSlide(xml, slideW, slideH) }.getOrNull()
            if (slide == null || slide.shapes.isEmpty()) {
                renderPptxPlain(sb, idx, slides.size, xml)
                return@forEachIndexed
            }
            sb.append("<section class=\"pv-slide is-layout\">")
            sb.append("<div class=\"pv-slide-no\">" + esc("第 " + (idx + 1) + " / " + slides.size + " 页") + "</div>")
            for (shp in slide.shapes) {
                if (shp.cx <= 0L || shp.cy <= 0L) continue
                val left = shp.x * 100.0 / slideW
                val top = shp.y * 100.0 / slideH
                val w = shp.cx * 100.0 / slideW
                val h = shp.cy * 100.0 / slideH
                val bg = shp.fill?.let { "background:#$it;" } ?: ""
                sb.append("<div class=\"pv-shp\" style=\"left:${num2(left)}%;top:${num2(top)}%;" +
                    "width:${num2(w)}%;height:${num2(h)}%;$bg\">")
                val tbl = shp.table
                if (tbl != null) {
                    sb.append("<table class=\"pv-table\">")
                    tbl.forEachIndexed { r, row ->
                        sb.append("<tr>")
                        row.forEach { c ->
                            val style = c.fill?.let { "background:#$it;" + if (r == 0 || c.bold) "color:#fff;" else "" } ?: ""
                            val tag = if (r == 0) "th class=\"pv-th\"" else "td class=\"pv-td\""
                            sb.append("<$tag style=\"$style\">").append(esc(c.text)).append("</").append(if (r == 0) "th>" else "td>")
                        }
                        sb.append("</tr>")
                    }
                    sb.append("</table>")
                } else {
                    for (para in shp.paras) {
                        val css = StringBuilder()
                        if (para.sizePt > 0) {
                            // 960pt 宽画布：sizePt/9.6 = cqw；px 行在前做旧内核 fallback
                            css.append("font-size:${num2(para.sizePt * 1.35)}px;")
                            css.append("font-size:${num2(para.sizePt / 9.6)}cqw;")
                        }
                        if (para.bold) css.append("font-weight:600;")
                        para.color?.let { css.append("color:#$it;") }
                        when (para.align) {
                            "ctr" -> css.append("text-align:center;")
                            "r" -> css.append("text-align:right;")
                            else -> {}
                        }
                        sb.append("<p class=\"pv-t\" style=\"$css\">").append(esc(para.text)).append("</p>")
                    }
                }
                sb.append("</div>")
            }
            sb.append("</section>")
        }
        return sb.toString()
    }

    /** 解析失败时的兜底：旧「首段=标题」纯文本大纲（内容至少可读） */
    private fun renderPptxPlain(sb: StringBuilder, idx: Int, total: Int, xml: String) {
        val (title, points) = runCatching { parseSlide(xml) }.getOrDefault("" to emptyList())
        sb.append("<section class=\"pv-slide is-plain\">")
        sb.append("<div class=\"pv-slide-no\">" + esc("第 " + (idx + 1) + " / " + total + " 页") + "</div>")
        sb.append("<h2 class=\"pv-slide-title\">" + esc(title.ifBlank { "（无标题）" }) + "</h2>")
        if (points.isNotEmpty()) {
            sb.append("<ul class=\"pv-points\">")
            points.forEach { sb.append("<li>${esc(it)}</li>") }
            sb.append("</ul>")
        }
        sb.append("</section>")
    }

    private fun num2(v: Double): String {
        val r = Math.round(v * 100.0) / 100.0
        return if (r == Math.rint(r)) r.toLong().toString() else
            String.format(java.util.Locale.US, "%.2f", r).trimEnd('0').trimEnd('.')
    }

    private fun sortedSlides(f: File): List<String> {
        ZipFile(f).use { z ->
            return z.entries().asSequence()
                .map { it.name }
                .filter { Regex("""ppt/slides/slide\d+\.xml$""").matches(it) }
                .sortedBy { name ->
                    Regex("""slide(\d+)\.xml""").find(name)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                }
                .mapNotNull { name -> runCatching { z.getInputStream(z.getEntry(name)).bufferedReader().use { it.readText() } }.getOrNull() }
                .toList()
        }
    }

    private fun parseSlide(xml: String): Pair<String, List<String>> {
        // 简化而稳健的启发式：幻灯片里第一个非空段落当标题，其余当要点。
        val p = Xml.newPullParser().apply {
            // 必须处理命名空间，否则 name 返回 "w:p" 这种全名而不是本地名 "p"
            setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            setInput(xml.reader())
        }
        var event = p.eventType
        val paragraphs = mutableListOf<String>()
        val para = StringBuilder()
        while (event != XmlPullParser.END_DOCUMENT) {
            when (event) {
                XmlPullParser.START_TAG -> if (p.name == "t") para.append(p.nextText())
                XmlPullParser.END_TAG -> if (p.name == "p") {
                    val t = para.toString().trim()
                    if (t.isNotEmpty()) paragraphs.add(t)
                    para.clear()
                }
            }
            event = p.next()
        }
        val tail = para.toString().trim()
        if (tail.isNotEmpty()) paragraphs.add(tail)
        if (paragraphs.isEmpty()) return "" to emptyList()
        return paragraphs.first() to paragraphs.drop(1)
    }

    /* ---------------- xlsx ---------------- */

    private fun renderXlsx(f: File): String {
        val shared = sharedStrings(f)
        val sheetNames = workbookSheets(f)
        val sb = StringBuilder()
        val firstSheet = sheetNames.firstOrNull()?.second
            ?: "xl/worksheets/sheet1.xml"
        val xml = zipText(f, firstSheet) ?: return "<p>（没有找到工作表）</p>"
        val p = Xml.newPullParser().apply {
            // 必须处理命名空间，否则 name 返回 "w:p" 这种全名而不是本地名 "p"
            setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            setInput(xml.reader())
        }
        var event = p.eventType
        val rows = mutableListOf<List<String>>()
        var row = mutableListOf<String>()
        var cell = StringBuilder()
        var cellType = ""
        while (event != XmlPullParser.END_DOCUMENT) {
            when (event) {
                XmlPullParser.START_TAG -> when (p.name) {
                    "row" -> row = mutableListOf()
                    "c" -> { cell = StringBuilder(); cellType = p.getAttributeValue(null, "t").orEmpty() }
                    "v" -> cell.append(p.nextText())
                    "t" -> cell.append(p.nextText())
                }
                XmlPullParser.END_TAG -> when (p.name) {
                    "c" -> {
                        val raw = cell.toString()
                        val value = if (cellType == "s") {
                            raw.toIntOrNull()?.let { shared.getOrNull(it) } ?: raw
                        } else raw
                        row.add(value)
                    }
                    "row" -> if (row.isNotEmpty()) rows.add(row.toList())
                }
            }
            event = p.next()
        }
        if (rows.isEmpty()) return "<p>（工作表是空的）</p>"
        val cols = rows.maxOf { it.size }
        // 表名来自 xlsx 内部 XML，必须转义：这份 HTML 会进应用 origin 的 innerHTML，
        // 未转义的表名 = 脚本注入 → KernelBridge 的完整工具权限
        sb.append("<p class=\"pv-meta\">${esc(sheetNames.firstOrNull()?.first ?: "Sheet1")} · ${rows.size} 行 × $cols 列</p>")
        sb.append("<table class=\"pv-table\">")
        rows.forEachIndexed { i, r ->
            val head = i == 0
            sb.append("<tr>")
            for (c in 0 until cols) {
                val v = r.getOrNull(c).orEmpty()
                if (head) sb.append("<th class=\"pv-th\">${esc(v)}</th>") else sb.append("<td class=\"pv-td\">${esc(v)}</td>")
            }
            sb.append("</tr>")
        }
        sb.append("</table>")
        return sb.toString()
    }

    private fun sharedStrings(f: File): List<String> {
        val xml = zipText(f, "xl/sharedStrings.xml") ?: return emptyList()
        val p = Xml.newPullParser().apply {
            // 必须处理命名空间，否则 name 返回 "w:p" 这种全名而不是本地名 "p"
            setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            setInput(xml.reader())
        }
        var event = p.eventType
        val out = mutableListOf<String>()
        val si = StringBuilder()
        while (event != XmlPullParser.END_DOCUMENT) {
            when (event) {
                XmlPullParser.START_TAG -> if (p.name == "t") si.append(p.nextText())
                XmlPullParser.END_TAG -> if (p.name == "si") { out.add(si.toString()); si.clear() }
            }
            event = p.next()
        }
        return out
    }

    private fun workbookSheets(f: File): List<Pair<String, String>> {
        val xml = zipText(f, "xl/workbook.xml") ?: return listOf("Sheet1" to "xl/worksheets/sheet1.xml")
        val rels = zipText(f, "xl/_rels/workbook.xml.rels") ?: ""
        val idToTarget = Regex("""<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)\"""").findAll(rels)
            .associate { it.groupValues[1] to it.groupValues[2] }
        val sheets = Regex("""<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"""").findAll(xml)
            .map { it.groupValues[1] to idToTarget[it.groupValues[2]].orEmpty() }
            .filter { it.second.isNotBlank() }
            .toList()
        val fixed = sheets.map { (name, target) ->
            val t = if (target.startsWith("xl/")) target else "xl/" + target.trimStart('/')
            name to t
        }
        return fixed.ifEmpty { listOf("Sheet1" to "xl/worksheets/sheet1.xml") }
    }
}
