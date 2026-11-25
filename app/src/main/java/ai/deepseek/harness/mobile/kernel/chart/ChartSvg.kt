package ai.deepseek.harness.mobile.kernel.chart

import ai.deepseek.harness.mobile.kernel.theme.Palette

/**
 * 纯 Kotlin SVG 图表渲染器（chart_generate 的内核，零 Android 依赖，JVM 可单测）。
 *
 * 设计约束：
 *  - **确定性**：同样的输入永远得到同样的 SVG（固定边距、无随机、无时间依赖），
 *    两次生成的字节必须一致 —— 这是单测断言的前提。
 *  - **矢量**：输出 .svg，任意缩放清晰；中文交给系统字体（不内嵌）。
 *  - **配色**：系列色取共享 [Palette]；[ChartSpec.accent] 只覆写第一系列。
 *
 * 支持：bar（柱）/ hbar（条形）/ line（折线）/ pie（饼）/ scatter（散点）。
 */
data class ChartSpec(
    val type: String,                     // bar / hbar / line / pie / scatter
    val title: String,
    val categories: List<String>,
    val series: List<Serie>,
    val xLabel: String = "",
    val yLabel: String = "",
    val accent: String? = null,
) {
    data class Serie(val name: String, val values: List<Double>, val points: List<Pair<Double, Double>> = emptyList())

    /** 系列色：accent 覆写第一系列，其余循环取 Palette */
    fun color(i: Int): String =
        if (i == 0 && accent != null) accent.removePrefix("#") else Palette.seriesColor(i)
}

/** Y 轴「漂亮刻度」（1/2/5 步长），确定性输出 */
object NiceTicks {

    fun compute(min: Double, max: Double, targetCount: Int = 5): List<Double> {
        if (max <= min) {
            val v = max
            val pad = if (v == 0.0) 1.0 else Math.abs(v) * 0.1 + 0.5
            return listOf(round(v - pad, pad), v, round(v + pad, pad))
        }
        val range = niceNum(max - min, false)
        val step = niceNum(range / (targetCount - 1).coerceAtLeast(1), true)
        val start = Math.floor(min / step) * step
        val end = Math.ceil(max / step) * step
        val out = mutableListOf<Double>()
        var v = start
        var guard = 0
        while (v <= end + step * 0.5 && guard++ < 60) {
            out.add(round(v, step))
            v += step
        }
        return out
    }

    private fun niceNum(range: Double, round: Boolean): Double {
        if (range <= 0.0 || range.isNaN() || range.isInfinite()) return 1.0
        val exp = Math.floor(Math.log10(range))
        val f = range / Math.pow(10.0, exp)
        val nf = if (round) {
            when { f < 1.5 -> 1.0; f < 3.0 -> 2.0; f < 7.0 -> 5.0; else -> 10.0 }
        } else {
            when { f <= 1.0 -> 1.0; f <= 2.0 -> 2.0; f <= 5.0 -> 5.0; else -> 10.0 }
        }
        return nf * Math.pow(10.0, exp)
    }

    /** 按 step 的量级四舍五入，消掉 0.30000000000000004 这类浮点尾巴 */
    fun round(v: Double, step: Double): Double {
        val decimals = Math.max(0.0, -Math.floor(Math.log10(Math.max(step, 1e-12)))).toInt()
        val factor = Math.pow(10.0, decimals.toDouble())
        return Math.round(v * factor) / factor
    }
}

object ChartSvg {

    private const val W = 720
    private const val H = 460
    private const val ML = 68   // 左边距（Y 轴刻度）
    private const val MR = 26
    private const val MT = 64   // 顶（标题+图例）
    private const val MB = 66   // 底（X 刻度+轴标签）

    private val esc = { s: String ->
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
    }

    private fun num(v: Double): String {
        if (v == Math.rint(v) && Math.abs(v) < 1e15) return v.toLong().toString()
        return String.format(java.util.Locale.US, "%.6f", v).trimEnd('0').trimEnd('.')
    }

    /** 生成 SVG 字符串。输入非法（空系列等）直接抛 IllegalArgumentException，由工具层转结构化错误 */
    fun build(spec: ChartSpec): String {
        if (spec.series.isEmpty()) throw IllegalArgumentException("series 不能为空")
        return when (spec.type) {
            "bar" -> bar(spec)
            "hbar" -> hbar(spec)
            "line" -> line(spec)
            "pie" -> pie(spec)
            "scatter" -> scatter(spec)
            else -> throw IllegalArgumentException("type 只支持 bar/hbar/line/pie/scatter，收到：${spec.type}")
        }
    }

    private fun header(spec: ChartSpec): String {
        val legend = if (spec.series.size > 1 || spec.type == "pie") {
            val items = StringBuilder()
            var lx = W - MR
            // 图例从右往左排；用圆点而不是 rect，避免与柱/条的 rect 计数混淆
            for (i in spec.series.indices.reversed()) {
                val label = spec.series[i].name.ifBlank { "系列${i + 1}" }
                val tw = label.length * 12 + 26
                lx -= tw
                items.append(
                    "<circle cx=\"${lx + 5}\" cy=\"32\" r=\"5\" fill=\"#${spec.color(i)}\"/>" +
                    "<text x=\"${lx + 16}\" y=\"36\" font-size=\"12\" fill=\"#555\">${esc(label)}</text>"
                )
            }
            items.toString()
        } else ""
        val title = if (spec.title.isBlank()) "" else
            "<text x=\"${ML}\" y=\"34\" font-size=\"17\" font-weight=\"600\" fill=\"#1c1c1e\">${esc(spec.title)}</text>"
        return """<svg xmlns="http://www.w3.org/2000/svg" width="$W" height="$H" viewBox="0 0 $W $H">""" +
            "<rect width=\"$W\" height=\"$H\" fill=\"#ffffff\"/>$title$legend"
    }

    private fun valueAxis(ticks: List<Double>, yOf: (Double) -> Int): String {
        val sb = StringBuilder()
        sb.append("<line x1=\"$ML\" y1=\"${yOf(ticks.last())}\" x2=\"$ML\" y2=\"${yOf(ticks.first())}\" stroke=\"#c7c7cc\"/>")
        for (t in ticks) {
            val y = yOf(t)
            sb.append("<line x1=\"$ML\" y1=\"$y\" x2=\"${W - MR}\" y2=\"$y\" stroke=\"#e8e8ec\"/>")
            sb.append("<text x=\"${ML - 8}\" y=\"${y + 4}\" font-size=\"11\" fill=\"#8a8a8e\" text-anchor=\"end\">${num(t)}</text>")
        }
        return sb.toString()
    }

    /* ---------------- 柱状图（多系列分组） ---------------- */

    private fun bar(spec: ChartSpec): String {
        val cats = spec.categories
        require(cats.isNotEmpty()) { "bar 需要 categories" }
        val m = spec.series.size
        require(spec.series.all { it.values.size == cats.size }) { "每个系列的 data 长度必须与 categories 一致" }
        val all = spec.series.flatMap { it.values }.filter { it.isFinite() }
        val ticks = NiceTicks.compute(minOf(0.0, all.minOrNull() ?: 0.0), all.maxOrNull() ?: 1.0)
        val yMin = ticks.first(); val yMax = ticks.last()
        val plotH = H - MT - MB
        val plotW = W - ML - MR
        fun yOf(v: Double) = (MT + plotH * (yMax - v) / (yMax - yMin)).toInt()
        val groupW = plotW.toDouble() / cats.size
        val barW = (groupW / m * 0.68).coerceAtMost(64.0)
        val sb = StringBuilder(header(spec))
        sb.append(valueAxis(ticks, ::yOf))
        cats.forEachIndexed { ci, cat ->
            val gx = ML + groupW * ci
            spec.series.forEachIndexed { si, s ->
                val v = s.values[ci]
                val h = Math.abs(yOf(v) - yOf(0.0)).coerceAtLeast(1)
                val top = if (v >= 0) yOf(v) else yOf(0.0)
                val x = gx + (groupW - barW * m) / 2 + si * barW
                sb.append("<rect x=\"${num(x + barW * 0.1)}\" y=\"$top\" width=\"${num(barW * 0.8)}\" height=\"$h\" fill=\"#${spec.color(si)}\" rx=\"2\"/>")
            }
            sb.append("<text x=\"${num(gx + groupW / 2)}\" y=\"${H - MB + 18}\" font-size=\"12\" fill=\"#555\" text-anchor=\"middle\">${esc(cat.take(10))}</text>")
        }
        sb.append("<line x1=\"$ML\" y1=\"${yOf(0.0)}\" x2=\"${W - MR}\" y2=\"${yOf(0.0)}\" stroke=\"#c7c7cc\"/>")
        if (spec.xLabel.isNotBlank()) sb.append("<text x=\"${W - MR}\" y=\"${H - 12}\" font-size=\"11\" fill=\"#8a8a8e\" text-anchor=\"end\">${esc(spec.xLabel)}</text>")
        if (spec.yLabel.isNotBlank()) sb.append("<text x=\"12\" y=\"${MT - 10}\" font-size=\"11\" fill=\"#8a8a8e\">${esc(spec.yLabel)}</text>")
        sb.append("</svg>")
        return sb.toString()
    }

    /* ---------------- 条形图（横向，单系列为主） ---------------- */

    private fun hbar(spec: ChartSpec): String {
        val cats = spec.categories
        require(cats.isNotEmpty()) { "hbar 需要 categories" }
        val s = spec.series.firstOrNull { it.values.size == cats.size }
            ?: spec.series.firstOrNull()
            ?: throw IllegalArgumentException("hbar 需要 series")
        val values = s.values.take(cats.size)
        val all = values.filter { it.isFinite() }
        val ticks = NiceTicks.compute(minOf(0.0, all.minOrNull() ?: 0.0), all.maxOrNull() ?: 1.0)
        val xMin = ticks.first(); val xMax = ticks.last()
        val plotH = H - MT - MB
        val plotW = W - ML - MR
        fun xOf(v: Double) = (ML + plotW * (v - xMin) / (xMax - xMin)).toInt()
        val rowH = plotH.toDouble() / cats.size
        val barH = (rowH * 0.62).coerceAtMost(42.0)
        val sb = StringBuilder(header(spec))
        // X 轴刻度（值轴现在是横向）
        for (t in ticks) {
            val x = xOf(t)
            sb.append("<line x1=\"$x\" y1=\"$MT\" x2=\"$x\" y2=\"${MT + plotH}\" stroke=\"#e8e8ec\"/>")
            sb.append("<text x=\"$x\" y=\"${MT + plotH + 18}\" font-size=\"11\" fill=\"#8a8a8e\" text-anchor=\"middle\">${num(t)}</text>")
        }
        sb.append("<line x1=\"$ML\" y1=\"$MT\" x2=\"$ML\" y2=\"${MT + plotH}\" stroke=\"#c7c7cc\"/>")
        cats.forEachIndexed { ci, cat ->
            val v = values.getOrNull(ci) ?: return@forEachIndexed
            val w = Math.abs(xOf(v) - xOf(xMin)).coerceAtLeast(1)
            val y = MT + rowH * ci + (rowH - barH) / 2
            sb.append("<rect x=\"$ML\" y=\"${num(y)}\" width=\"$w\" height=\"${num(barH)}\" fill=\"#${spec.color(0)}\" rx=\"2\"/>")
            sb.append("<text x=\"${ML - 8}\" y=\"${num(y + barH / 2 + 4)}\" font-size=\"12\" fill=\"#555\" text-anchor=\"end\">${esc(cat.take(12))}</text>")
        }
        if (spec.xLabel.isNotBlank()) sb.append("<text x=\"${W - MR}\" y=\"${H - 12}\" font-size=\"11\" fill=\"#8a8a8e\" text-anchor=\"end\">${esc(spec.xLabel)}</text>")
        sb.append("</svg>")
        return sb.toString()
    }

    /* ---------------- 折线图 ---------------- */

    private fun line(spec: ChartSpec): String {
        val cats = spec.categories
        require(cats.isNotEmpty()) { "line 需要 categories" }
        val all = spec.series.flatMap { it.values }.filter { it.isFinite() }
        require(all.isNotEmpty()) { "line 需要 series[].data" }
        val ticks = NiceTicks.compute(minOf(0.0, all.minOrNull() ?: 0.0), all.maxOrNull() ?: 1.0)
        val yMin = ticks.first(); val yMax = ticks.last()
        val plotH = H - MT - MB
        val plotW = W - ML - MR
        fun yOf(v: Double) = (MT + plotH * (yMax - v) / (yMax - yMin)).toInt()
        fun xOf(i: Int): Double =
            ML + if (cats.size == 1) plotW / 2.0 else plotW * i.toDouble() / (cats.size - 1)
        val sb = StringBuilder(header(spec))
        sb.append(valueAxis(ticks, ::yOf))
        sb.append("<line x1=\"$ML\" y1=\"${MT + plotH}\" x2=\"${W - MR}\" y2=\"${MT + plotH}\" stroke=\"#c7c7cc\"/>")
        // X 轴刻度最多 12 个，避免挤成一团
        val step = Math.max(1, Math.ceil(cats.size / 12.0).toInt())
        cats.forEachIndexed { i, cat ->
            if (i % step == 0) sb.append("<text x=\"${xOf(i)}\" y=\"${H - MB + 18}\" font-size=\"12\" fill=\"#555\" text-anchor=\"middle\">${esc(cat.take(10))}</text>")
        }
        spec.series.forEachIndexed { si, s ->
            val pts = s.values.mapIndexed { i, v -> "${xOf(i)},${yOf(v)}" }
            sb.append("<polyline points=\"${pts.joinToString(" ")}\" fill=\"none\" stroke=\"#${spec.color(si)}\" stroke-width=\"2.5\" stroke-linejoin=\"round\"/>")
            s.values.forEachIndexed { i, v ->
                sb.append("<circle cx=\"${xOf(i)}\" cy=\"${yOf(v)}\" r=\"3.5\" fill=\"#${spec.color(si)}\"/>")
            }
        }
        if (spec.yLabel.isNotBlank()) sb.append("<text x=\"12\" y=\"${MT - 10}\" font-size=\"11\" fill=\"#8a8a8e\">${esc(spec.yLabel)}</text>")
        sb.append("</svg>")
        return sb.toString()
    }

    /* ---------------- 饼图（单系列） ---------------- */

    private fun pie(spec: ChartSpec): String {
        val s = spec.series.firstOrNull { it.values.isNotEmpty() }
            ?: throw IllegalArgumentException("pie 需要 series[].data")
        require(s.values.size == spec.categories.size || spec.categories.isEmpty()) {
            "categories 与 data 长度需一致"
        }
        val total = s.values.filter { it > 0 }.sum()
        require(total > 0) { "pie 的数据需要至少一个正值" }
        val cx = W / 2.0; val cy = (H + MT) / 2.0; val r = Math.min(W, H) / 2.0 - 84
        val sb = StringBuilder(header(spec))
        var angle = -90.0
        s.values.forEachIndexed { i, v ->
            if (v <= 0) return@forEachIndexed
            val frac = v / total
            val sweep = frac * 360.0
            val a0 = Math.toRadians(angle)
            val a1 = Math.toRadians(angle + sweep)
            val x0 = cx + r * Math.cos(a0); val y0 = cy + r * Math.sin(a0)
            val x1 = cx + r * Math.cos(a1); val y1 = cy + r * Math.sin(a1)
            val large = if (sweep > 180) 1 else 0
            if (sweep >= 359.99) {
                sb.append("<circle cx=\"${num(cx)}\" cy=\"${num(cy)}\" r=\"${num(r)}\" fill=\"#${spec.color(i)}\"/>")
            } else {
                sb.append("<path d=\"M${num(cx)},${num(cy)} L${num(x0)},${num(y0)} A${num(r)},${num(r)} 0 $large 1 ${num(x1)},${num(y1)} Z\" fill=\"#${spec.color(i)}\" stroke=\"#ffffff\" stroke-width=\"1.5\"/>")
            }
            // 扇区外标百分比
            val am = Math.toRadians(angle + sweep / 2)
            val lx = cx + (r + 26) * Math.cos(am); val ly = cy + (r + 26) * Math.sin(am)
            val label = spec.categories.getOrNull(i) ?: "项${i + 1}"
            sb.append("<text x=\"${num(lx)}\" y=\"${num(ly + 4)}\" font-size=\"12\" fill=\"#444\" text-anchor=\"middle\">${esc(label.take(8))} ${num(Math.round(frac * 1000.0) / 10.0)}%</text>")
            angle += sweep
        }
        sb.append("</svg>")
        return sb.toString()
    }

    /* ---------------- 散点图 ---------------- */

    private fun scatter(spec: ChartSpec): String {
        val pts = spec.series.flatMap { it.points }
        require(pts.isNotEmpty()) { "scatter 需要 series[].data 为 [x,y] 数值对" }
        val xs = pts.map { it.first }; val ys = pts.map { it.second }
        val xTicks = NiceTicks.compute(xs.minOrNull() ?: 0.0, xs.maxOrNull() ?: 1.0)
        val yTicks = NiceTicks.compute(minOf(0.0, ys.minOrNull() ?: 0.0), ys.maxOrNull() ?: 1.0)
        val xMin = xTicks.first(); val xMax = xTicks.last()
        val yMin = yTicks.first(); val yMax = yTicks.last()
        val plotH = H - MT - MB
        val plotW = W - ML - MR
        fun xOf(v: Double) = (ML + plotW * (v - xMin) / (xMax - xMin)).toInt()
        fun yOf(v: Double) = (MT + plotH * (yMax - v) / (yMax - yMin)).toInt()
        val sb = StringBuilder(header(spec))
        sb.append(valueAxis(yTicks, ::yOf))
        sb.append("<line x1=\"$ML\" y1=\"${MT + plotH}\" x2=\"${W - MR}\" y2=\"${MT + plotH}\" stroke=\"#c7c7cc\"/>")
        for (t in xTicks) {
            sb.append("<text x=\"${xOf(t)}\" y=\"${MT + plotH + 18}\" font-size=\"11\" fill=\"#8a8a8e\" text-anchor=\"middle\">${num(t)}</text>")
        }
        spec.series.forEachIndexed { si, s ->
            s.points.forEach { (x, y) ->
                sb.append("<circle cx=\"${xOf(x)}\" cy=\"${yOf(y)}\" r=\"4\" fill=\"#${spec.color(si)}\" fill-opacity=\"0.75\"/>")
            }
        }
        if (spec.xLabel.isNotBlank()) sb.append("<text x=\"${W - MR}\" y=\"${H - 12}\" font-size=\"11\" fill=\"#8a8a8e\" text-anchor=\"end\">${esc(spec.xLabel)}</text>")
        if (spec.yLabel.isNotBlank()) sb.append("<text x=\"12\" y=\"${MT - 10}\" font-size=\"11\" fill=\"#8a8a8e\">${esc(spec.yLabel)}</text>")
        sb.append("</svg>")
        return sb.toString()
    }
}
