package ai.deepseek.harness.mobile.kernel.doc

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.theme.Palette
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import java.io.File

/**
 * .pdf 的写侧（Canvas 排版）。
 *
 * 为什么不用 WebView 的打印管线：`PrintDocumentAdapter.LayoutResultCallback` 的构造函数
 * 在 SDK 里是包内可见（package-private），应用无法实例化，也就没法静默地把网页「打印」
 * 成文件。所以这里用系统 Canvas 直接排版到 [PdfDocument]。
 *
 * **已知边界**：Android 的中文字体是 CFF/TTC，Skia 无法内嵌时会把每个汉字画成 Type3
 * 字形过程 —— 页面显示、打印都正常，但文字不可选中、不可搜索，也就无法被 `read_doc`
 * 抽回正文。要「可搜索的 PDF」需要内嵌 TTF 子集 + ToUnicode（等于自带一个 PDF 排版库），
 * 手机上不划算；需要这种 PDF 时建议在电脑端导出。预览侧用 [android.graphics.pdf.PdfRenderer]
 * 把页面渲染成图片，所以用户在应用内依然能看。
 *
 * 版式与 [DocWriter.writeDocx] 共用同一套 Markdown 子集。
 */
object PdfWriter {

    data class Result(val bytes: Long, val pages: Int)

    private const val PAGE_W = 595
    private const val PAGE_H = 842
    private const val MARGIN = 54f

    /**
     * [accent]：主色（6 位 hex，不带 #），空则用品牌蓝（[Palette.ACCENT]）。
     * rc.98 起接入 Palette：H1 下划线 / 引用竖条用 accent 实色，表头背景用 accent 淡化
     * （约 12% alpha 叠白底，打印友好）；其余灰阶保持中性语义不动。
     */
    fun write(
        f: File,
        markdown: String,
        title: String = "",
        author: String = "DeepSeek Harness",
        accent: String = "",
    ): Result {
        if (markdown.isBlank() && title.isBlank()) throw KernelError("正文为空，没什么可写的")
        val ac = accent.trim().removePrefix("#")
            .takeIf { Regex("^[0-9A-Fa-f]{6}$").matches(it) } ?: Palette.ACCENT
        val rgb = Integer.parseInt(ac, 16)
        val doc = PdfDocument()
        val r = Renderer(doc, (rgb shr 16) and 0xFF, (rgb shr 8) and 0xFF, rgb and 0xFF)
        try {
            if (title.isNotBlank()) r.heading(title.trim(), 1)
            r.markdown(markdown)
            r.finish()
            f.parentFile?.mkdirs()
            f.outputStream().buffered().use { doc.writeTo(it) }
        } catch (t: Throwable) {
            throw if (t is KernelError) t else KernelError("PDF 生成失败：${t.javaClass.simpleName}")
        } finally {
            doc.close()
        }
        return Result(f.length(), r.pages)
    }

    private class Renderer(
        private val doc: PdfDocument,
        accentR: Int, accentG: Int, accentB: Int,
    ) {
        /** accent 实色（H1 下划线 / 引用竖条）与淡化版（表头背景，叠白底打印友好） */
        private val accentPaint = Paint().apply { color = Color.rgb(accentR, accentG, accentB) }
        private val accentSoft = Paint().apply { color = Color.argb(0x1F, accentR, accentG, accentB) }

        var pages = 0
            private set
        private var page: PdfDocument.Page? = null
        private var canvas: Canvas? = null
        private var y = MARGIN

        private val normal = paint(10.5f, false)
        private val bold = paint(10.5f, true)
        private val mono = paint(9.3f, false).apply { typeface = Typeface.MONOSPACE }
        private val faint = paint(9f, false).apply { color = Color.rgb(110, 110, 118) }
        private val footer = paint(8.5f, false).apply {
            color = Color.rgb(150, 150, 156)
            textAlign = Paint.Align.CENTER
        }

        private fun paint(size: Float, isBold: Boolean) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = size
            color = Color.rgb(28, 28, 30)
            typeface = if (isBold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        }

        private fun cv(): Canvas {
            if (page == null) {
                closePage()
                val info = PdfDocument.PageInfo.Builder(PAGE_W, PAGE_H, ++pages).create()
                page = doc.startPage(info)
                canvas = page!!.canvas.also {
                    it.drawColor(Color.WHITE)
                    // 页码：PdfDocument 是顺序写的，回填总页数做不到，
                    // 就只标当前页（在页脚留白区，不会和正文打架）
                    it.drawText("$pages", PAGE_W / 2f, PAGE_H - 30f, footer)
                }
                y = MARGIN
            }
            return canvas!!
        }

        private fun closePage() {
            val p = page ?: return
            doc.finishPage(p)
            page = null
            canvas = null
        }

        fun finish() {
            if (page == null) { cv(); }
            closePage()
        }

        private fun ensure(h: Float) {
            if (y + h > PAGE_H - MARGIN) closePage().also { y = MARGIN }
        }

        private fun lh(p: Paint, lead: Float = 1.62f) = p.textSize * lead

        private fun wrap(text: String, p: Paint, width: Float): List<String> {
            if (text.isEmpty()) return listOf("")
            val out = ArrayList<String>()
            val sb = StringBuilder()
            var w = 0f
            for (ch in text) {
                if (ch == '\n') { out.add(sb.toString()); sb.setLength(0); w = 0f; continue }
                val cw = p.measureText(ch.toString())
                if (w + cw > width && sb.isNotEmpty()) {
                    out.add(sb.toString()); sb.setLength(0); w = 0f
                    if (ch == ' ') continue
                }
                sb.append(ch); w += cw
            }
            out.add(sb.toString())
            return out
        }

        private fun drawLines(lines: List<String>, p: Paint, x: Float) {
            val h = lh(p)
            for (ln in lines) {
                ensure(h)
                cv().drawText(ln, x, y + p.textSize, p)
                y += h
            }
        }

        fun heading(text: String, level: Int) {
            val size = when (level) { 1 -> 20f; 2 -> 15f; 3 -> 12.5f; else -> 11.5f }
            val p = paint(size, true)
            y += if (level == 1) 2f else 8f
            ensure(lh(p) + 6f)
            drawLines(wrap(text, p, PAGE_W - MARGIN * 2), p, MARGIN)
            y += 5f
            if (level == 1) {
                ensure(10f)
                cv().drawRect(MARGIN, y, PAGE_W - MARGIN, y + 1.2f, accentPaint)
                y += 8f
            }
        }

        private fun bullet(text: String, ordered: Int?) {
            val x = MARGIN + 14f
            val width = PAGE_W - MARGIN * 2 - 14f
            val marker = if (ordered != null) "$ordered. " else "• "
            val mw = normal.measureText(marker)
            ensure(lh(normal))
            cv().drawText(marker, MARGIN, y + normal.textSize, faint)
            drawLines(wrap(text, normal, width - mw), normal, x)
        }

        private fun quote(text: String) {
            val lines = wrap(text, faint, PAGE_W - MARGIN * 2 - 16f)
            ensure(lh(faint) * lines.size + 4f)
            val top = y
            cv().drawRect(MARGIN, top - 2f, MARGIN + 2.5f, top + lh(faint) * lines.size - 2f, accentPaint)
            drawLines(lines, faint, MARGIN + 12f)
            y += 4f
        }

        private fun code(lines: List<String>) {
            val h = lh(mono, 1.45f)
            val pad = 7f
            var i = 0
            while (i < lines.size) {
                val chunk = ArrayList<String>()
                var boxH = pad * 2
                while (i < lines.size && (y + boxH + h <= PAGE_H - MARGIN || chunk.isEmpty())) {
                    chunk.add(lines[i]); boxH += h; i++
                }
                val top = y
                cv().drawRect(MARGIN, top, PAGE_W - MARGIN, top + boxH, Paint().apply { color = Color.rgb(244, 245, 247) })
                y += pad
                for (ln in chunk) {
                    cv().drawText(ln.take(180), MARGIN + pad, y + mono.textSize, mono)
                    y += h
                }
                y = top + boxH + 6f
            }
        }

        private fun hr() {
            ensure(16f)
            cv().drawRect(MARGIN, y + 6f, PAGE_W - MARGIN, y + 7f, Paint().apply { color = Color.rgb(224, 224, 228) })
            y += 16f
        }

        private fun table(rows: List<List<String>>) {
            if (rows.isEmpty()) return
            val cols = rows.maxOf { it.size }.coerceAtLeast(1)
            val avail = PAGE_W - MARGIN * 2
            val colW = avail / cols
            rows.forEachIndexed { ri, row ->
                val p = if (ri == 0) bold else normal
                val cells = (0 until cols).map { c -> wrap(row.getOrElse(c) { "" }, p, colW - 8f) }
                val h = lh(p) * cells.maxOf { it.size } + 6f
                ensure(h)
                if (ri == 0) cv().drawRect(MARGIN, y, MARGIN + avail, y + h, accentSoft)
                for (c in 0 until cols) {
                    var cy = y + 3f
                    for (ln in cells[c]) {
                        cv().drawText(ln, MARGIN + c * colW + 4f, cy + p.textSize, p)
                        cy += lh(p)
                    }
                }
                y += h
                cv().drawRect(MARGIN, y, MARGIN + avail, y + 0.7f, Paint().apply { color = Color.rgb(222, 222, 227) })
            }
            y += 8f
        }

        fun markdown(md: String) {
            val lines = md.replace("\r\n", "\n").split("\n")
            var i = 0
            while (i < lines.size) {
                val raw = lines[i]
                val t = raw.trim()
                when {
                    t.isEmpty() -> y += normal.textSize * 0.45f
                    t.startsWith("```") -> {
                        val buf = ArrayList<String>()
                        i++
                        while (i < lines.size && !lines[i].trim().startsWith("```")) { buf.add(lines[i]); i++ }
                        code(buf)
                    }
                    Regex("^#{1,4}\\s+").containsMatchIn(t) -> {
                        val level = t.takeWhile { it == '#' }.length
                        heading(t.drop(level).trim(), level)
                    }
                    t == "---" || t == "***" -> hr()
                    t.startsWith("> ") -> quote(t.removePrefix(">").trim())
                    Regex("^[-*+]\\s+").containsMatchIn(t) -> bullet(t.dropWhile { it == '-' || it == '*' || it == '+' }.trim(), null)
                    Regex("^\\d+[.)]\\s+").containsMatchIn(t) -> {
                        val n = t.takeWhile { it.isDigit() }.toIntOrNull() ?: 1
                        bullet(t.dropWhile { it.isDigit() || it == '.' || it == ')' }.trim(), n)
                    }
                    t.startsWith("|") && t.endsWith("|") -> {
                        val rows = ArrayList<List<String>>()
                        while (i < lines.size && lines[i].trim().let { it.startsWith("|") && it.endsWith("|") }) {
                            val cells = lines[i].trim().trim('|').split("|").map { it.trim() }
                            val sep = cells.all { c -> c.isNotEmpty() && c.all { ch -> ch == '-' || ch == ':' || ch == ' ' } }
                            if (!sep) rows.add(cells)
                            i++
                        }
                        table(rows)
                        continue
                    }
                    else -> drawLines(wrap(inline(t), normal, PAGE_W - MARGIN * 2), normal, MARGIN)
                }
                i++
            }
        }

        private fun inline(s: String): String =
            s.replace("**", "").replace("__", "").replace(Regex("`([^`]*)`"), "$1")
    }
}
