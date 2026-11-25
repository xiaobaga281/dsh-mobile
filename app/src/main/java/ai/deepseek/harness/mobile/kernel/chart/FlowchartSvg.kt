package ai.deepseek.harness.mobile.kernel.chart

import ai.deepseek.harness.mobile.kernel.theme.Palette

/**
 * 流程图 SVG 渲染器（flowchart_generate 的内核，零 Android 依赖，JVM 可单测）。
 *
 * 输入 nodes/edges 有向图，输出自上而下分层布局的确定性 SVG：
 *   - 分层 = 最长路径层（Kahn 拓扑序松弛），有环直接抛 IllegalArgumentException
 *   - y 按层均分；x 在层内按输入序均分
 *   - 形状：start/end 胶囊、process 矩形、decision 菱形、io 平行四边形
 *   - 边走正交折线（竖 → 层间中线横移 → 竖），decision 的出边按声明顺序
 *     自动标「是/否」（用户显式给了 label 则尊重原 label）
 */
data class FlowNode(val id: String, val label: String = "", val shape: String = "process")
data class FlowEdge(val from: String, val to: String, val label: String = "")

object FlowchartSvg {

    private const val MARGIN = 40.0
    private const val TITLE_H = 40.0
    private const val ROW_H = 130.0
    private const val H_GAP = 46.0
    private const val MIN_W = 680.0

    private val SHAPES = setOf("start", "end", "process", "decision", "io")

    private fun nodeW(shape: String): Double = when (shape) {
        "decision" -> 170.0
        "start", "end" -> 116.0
        else -> 150.0
    }

    private fun nodeH(shape: String): Double = when (shape) {
        "decision" -> 62.0
        "start", "end" -> 40.0
        else -> 46.0
    }

    /** 与 MindmapSvg 同一套估宽；返回截断后的 label */
    private fun fit(label: String, font: Double, boxW: Double): String {
        val maxW = boxW - 18.0
        fun w(s: String): Double {
            var t = 0.0
            for (ch in s) t += if (ch.code > 0x2E7F) font else font * 0.62
            return t
        }
        if (w(label) <= maxW) return label
        var t = font * 1.2
        val sb = StringBuilder()
        for (ch in label) {
            val cw = if (ch.code > 0x2E7F) font else font * 0.62
            if (t + cw > maxW) break
            sb.append(ch); t += cw
        }
        return sb.append('…').toString()
    }

    fun build(
        nodes: List<FlowNode>,
        edges: List<FlowEdge>,
        title: String = "",
        accent: String? = null,
    ): String {
        if (nodes.isEmpty()) throw IllegalArgumentException("流程图至少需要一个节点")
        val ids = nodes.map { it.id }
        if (ids.size != ids.toSet().size) throw IllegalArgumentException("节点 id 重复：流程图的每个节点必须有唯一 id")
        val idSet = ids.toSet()
        for (e in edges) {
            if (e.from !in idSet) throw IllegalArgumentException("边的起点不存在：${e.from}")
            if (e.to !in idSet) throw IllegalArgumentException("边的终点不存在：${e.to}")
        }
        val acc = "#" + Palette.accent(accent)

        // Kahn 拓扑 + 最长路径分层
        val layer = java.util.HashMap<String, Int>()
        val indeg = java.util.HashMap<String, Int>()
        val out = java.util.HashMap<String, MutableList<String>>()
        nodes.forEach { indeg[it.id] = 0; layer[it.id] = 0; out[it.id] = mutableListOf() }
        edges.forEach { e ->
            indeg[e.to] = (indeg[e.to] ?: 0) + 1
            out[e.from]!!.add(e.to)
        }
        val queue = ArrayDeque(nodes.filter { indeg[it.id] == 0 }.map { it.id })
        var processed = 0
        while (queue.isNotEmpty()) {
            val cur = queue.removeFirst()
            processed++
            for (next in out[cur]!!) {
                layer[next] = maxOf(layer[next]!!, layer[cur]!! + 1)
                indeg[next] = indeg[next]!! - 1
                if (indeg[next] == 0) queue.add(next)
            }
        }
        if (processed < nodes.size) {
            val stuck = nodes.filter { indeg[it.id]!! > 0 }.map { it.id }
            throw IllegalArgumentException("流程图存在环：${stuck.joinToString("、")}（请检查回退分支是否闭环）")
        }

        // 布局：行 = 层，列 = 层内输入序
        val maxLayer = layer.values.max()
        val byLayer = (0..maxLayer).map { l -> nodes.filter { layer[it.id] == l } }
        val maxCount = byLayer.maxOf { it.size }
        val cellW = maxOf(nodeW("decision"), nodeW("process")) + H_GAP
        val width = maxOf(MIN_W, MARGIN * 2 + maxCount * cellW)
        val top = MARGIN + (if (title.isNotBlank()) TITLE_H else 0.0)
        val height = top + (maxLayer + 1) * ROW_H + MARGIN

        data class Box(val n: FlowNode, val cx: Double, val cy: Double, val w: Double, val h: Double)
        val boxes = LinkedHashMap<String, Box>()
        for ((l, list) in byLayer.withIndex()) {
            val cy = top + l * ROW_H + ROW_H / 2
            list.forEachIndexed { i, n ->
                if (n.shape !in SHAPES) throw IllegalArgumentException("未知形状：${n.shape}（可选 start/end/process/decision/io）")
                // 层内均分：第 i 个节点的中心在层带宽度的 (i+0.5)/count 处
                val cx = MARGIN + (width - MARGIN * 2) / list.size * (i + 0.5)
                boxes[n.id] = Box(n, cx, cy, nodeW(n.shape), nodeH(n.shape))
            }
        }

        val font = 13.0
        val sb = StringBuilder()
        sb.append(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"${fmt(width)}\" height=\"${fmt(height)}\" " +
                "viewBox=\"0 0 ${fmt(width)} ${fmt(height)}\">"
        )
        sb.append("<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>")
        sb.append("<defs><marker id=\"arr\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" " +
            "markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\">" +
            "<path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"#8A8A90\"/></marker></defs>")
        if (title.isNotBlank()) {
            sb.append("<text x=\"${fmt(MARGIN)}\" y=\"30\" font-size=\"16\" font-weight=\"600\" " +
                "fill=\"#282830\" font-family=\"sans-serif\">${esc(title)}</text>")
        }

        // 边：正交折线，压在节点下面
        val fromCount = java.util.HashMap<String, Int>()
        for (e in edges) {
            val a = boxes[e.from]!!
            val b = boxes[e.to]!!
            val x1 = a.cx
            val y1 = a.cy + a.h / 2
            val x2 = b.cx
            val y2 = b.cy - b.h / 2
            val midY = (y1 + y2) / 2
            sb.append("<path d=\"M ${fmt(x1)} ${fmt(y1)} L ${fmt(x1)} ${fmt(midY)} " +
                "L ${fmt(x2)} ${fmt(midY)} L ${fmt(x2)} ${fmt(y2)}\" fill=\"none\" " +
                "stroke=\"#8A8A90\" stroke-width=\"1.4\" marker-end=\"url(#arr)\"/>")
            // decision 的出边按声明顺序自动标是/否；用户给了 label 则尊重
            val idx = fromCount.merge(e.from, 1, Int::plus)!! - 1
            val isDecision = boxes[e.from]!!.n.shape == "decision"
            val label = when {
                e.label.isNotBlank() -> e.label
                isDecision && idx == 0 -> "是"
                isDecision && idx == 1 -> "否"
                else -> ""
            }
            if (label.isNotBlank()) {
                val lx = (x1 + x2) / 2
                val ly = midY - 6
                sb.append("<text x=\"${fmt(lx)}\" y=\"${fmt(ly)}\" font-size=\"12\" fill=\"#6B6B70\" " +
                    "text-anchor=\"middle\" font-family=\"sans-serif\" " +
                    "paint-order=\"stroke\" stroke=\"#ffffff\" stroke-width=\"4\">${esc(label)}</text>")
            }
        }

        // 节点
        for (b in boxes.values) {
            val n = b.n
            val x = b.cx - b.w / 2
            val y = b.cy - b.h / 2
            val label = n.label.ifBlank { n.id }
            val text = esc(fit(label, font, b.w))
            when (n.shape) {
                "start" -> {
                    sb.append("<rect x=\"${fmt(x)}\" y=\"${fmt(y)}\" width=\"${fmt(b.w)}\" height=\"${fmt(b.h)}\" " +
                        "rx=\"${fmt(b.h / 2)}\" fill=\"$acc\"/>")
                    sb.append(textEl(b.cx, b.cy, "#ffffff", text, bold = true))
                }
                "end" -> {
                    sb.append("<rect x=\"${fmt(x)}\" y=\"${fmt(y)}\" width=\"${fmt(b.w)}\" height=\"${fmt(b.h)}\" " +
                        "rx=\"${fmt(b.h / 2)}\" fill=\"#ffffff\" stroke=\"$acc\" stroke-width=\"1.6\"/>")
                    sb.append(textEl(b.cx, b.cy, acc, text, bold = true))
                }
                "decision" -> {
                    val pts = "${fmt(b.cx)},${fmt(y)} ${fmt(x + b.w)},${fmt(b.cy)} " +
                        "${fmt(b.cx)},${fmt(y + b.h)} ${fmt(x)},${fmt(b.cy)}"
                    sb.append("<polygon points=\"$pts\" fill=\"#FFF9EC\" stroke=\"#D9A441\" stroke-width=\"1.4\"/>")
                    sb.append(textEl(b.cx, b.cy, "#282830", text))
                }
                "io" -> {
                    val skew = 14.0
                    val pts = "${fmt(x + skew)},${fmt(y)} ${fmt(x + b.w)},${fmt(y)} " +
                        "${fmt(x + b.w - skew)},${fmt(y + b.h)} ${fmt(x)},${fmt(y + b.h)}"
                    sb.append("<polygon points=\"$pts\" fill=\"#EEF3FC\" stroke=\"#9AB2D8\" stroke-width=\"1.4\"/>")
                    sb.append(textEl(b.cx, b.cy, "#282830", text))
                }
                else -> {
                    sb.append("<rect x=\"${fmt(x)}\" y=\"${fmt(y)}\" width=\"${fmt(b.w)}\" height=\"${fmt(b.h)}\" " +
                        "rx=\"6\" fill=\"#ffffff\" stroke=\"#C9CCD3\" stroke-width=\"1.4\"/>")
                    sb.append(textEl(b.cx, b.cy, "#282830", text))
                }
            }
        }

        sb.append("</svg>")
        return sb.toString()
    }

    private fun textEl(cx: Double, cy: Double, fill: String, text: String, bold: Boolean = false): String =
        "<text x=\"${fmt(cx)}\" y=\"${fmt(cy + 4.5)}\" font-size=\"13\" ${if (bold) "font-weight=\"600\" " else ""}" +
            "fill=\"$fill\" text-anchor=\"middle\" font-family=\"sans-serif\">$text</text>"

    /** 统一小数格式，去掉浮点尾巴（确定性输出的另一半） */
    private fun fmt(v: Double): String {
        val r = kotlin.math.round(v * 100) / 100
        return if (r == r.toLong().toDouble()) r.toLong().toString() else r.toString()
    }

    private val esc = { s: String ->
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\"", "&quot;")
    }
}
