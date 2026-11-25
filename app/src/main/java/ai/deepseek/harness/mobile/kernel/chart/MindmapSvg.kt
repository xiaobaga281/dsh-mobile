package ai.deepseek.harness.mobile.kernel.chart

import ai.deepseek.harness.mobile.kernel.theme.Palette

/**
 * 思维导图 SVG 渲染器（mindmap_generate 的内核，零 Android 依赖，JVM 可单测）。
 *
 * 输入是一棵 JSON 树（label + children 递归），输出横向布局的确定性 SVG：
 * 根在左、子树向右展开。布局是 tidy tree 的简化版：
 *   pass1（后序）：每个节点的纵向空间 = 其所有叶子的行高之和，父节点对齐子块中线；
 *   pass2：每列宽度 = 该层最宽节点 + 水平间距，深度越深 x 越靠右。
 * 连线用三次贝塞尔（parent 右缘 → child 左缘），风格与 ChartSvg 一致：
 * 确定性输出（同样输入永远同样字节）、固定字号阶梯、Palette 主色。
 */
data class MindNode(val label: String, val children: List<MindNode> = emptyList())

object MindmapSvg {

    private const val MAX_DEPTH = 6          // 允许 depth 0..5，共 6 层
    private const val NODE_H = 34.0
    private const val V_GAP = 12.0
    private const val H_GAP = 44.0
    private const val PAD_X = 14.0
    private const val MARGIN = 28.0
    private const val TITLE_H = 40.0
    private const val MIN_COL_W = 64.0
    private const val MAX_LABEL_W = 220.0    // 超宽文本截断，不无限撑宽画布

    // 字号随深度递减：根 15 → 叶 11
    private fun fontOf(depth: Int): Double = (15.0 - depth).coerceAtLeast(11.0)

    /** 中文/全角按 1.0 字号宽、其余按 0.62 估宽 */
    private fun textW(label: String, font: Double): Double {
        var w = 0.0
        for (ch in label) w += if (ch.code > 0x2E7F) font else font * 0.62
        return w
    }

    private fun truncate(label: String, font: Double): String {
        if (textW(label, font) <= MAX_LABEL_W) return label
        var w = font * 1.2 // 省略号的预算
        val sb = StringBuilder()
        for (ch in label) {
            val cw = if (ch.code > 0x2E7F) font else font * 0.62
            if (w + cw > MAX_LABEL_W) break
            sb.append(ch); w += cw
        }
        return sb.append('…').toString()
    }

    fun build(root: MindNode, title: String = "", accent: String? = null): String {
        if (maxDepth(root) >= MAX_DEPTH) {
            throw IllegalArgumentException("思维导图最多 $MAX_DEPTH 层（当前 ${maxDepth(root) + 1} 层），请合并深层节点")
        }
        val acc = "#" + Palette.accent(accent)

        // pass1：后序分配纵向空间；返回 (blockTop, blockH, centerY, depth, boxW)
        data class Laid(
            val top: Double, val blockH: Double, val cy: Double,
            val depth: Int, val boxW: Double, val label: String,
            val children: List<Laid>,
        )

        fun lay(node: MindNode, depth: Int, top: Double): Laid {
            val font = fontOf(depth)
            // 截断要在存进 Laid 之前做 —— 盒宽和渲染文本必须同源，否则盒算窄了字还是全长
            val label = truncate(node.label.ifBlank { "（未命名）" }, font)
            val boxW = (textW(label, font) + PAD_X * 2).coerceAtLeast(MIN_COL_W)
            if (node.children.isEmpty()) {
                val h = NODE_H + V_GAP
                return Laid(top, h, top + h / 2, depth, boxW, label, emptyList())
            }
            var y = top
            val kids = node.children.map { child ->
                val l = lay(child, depth + 1, y)
                y += l.blockH
                l
            }
            val blockH = y - top
            return Laid(top, blockH, top + blockH / 2, depth, boxW, label, kids)
        }

        val rootLaid = lay(root, 0, MARGIN + (if (title.isNotBlank()) TITLE_H else 0.0))

        // pass2：列宽 = 该层最宽盒子；x = 前面各列宽 + 间距的累加
        val depthMax = mutableMapOf<Int, Double>()
        fun collect(n: Laid) {
            depthMax[n.depth] = maxOf(depthMax[n.depth] ?: 0.0, n.boxW)
            n.children.forEach { collect(it) }
        }
        collect(rootLaid)
        val cols = depthMax.keys.max() + 1
        val colX = DoubleArray(cols)
        var x = MARGIN
        for (d in 0 until cols) {
            colX[d] = x
            x += (depthMax[d] ?: MIN_COL_W) + H_GAP
        }
        val width = x - H_GAP + MARGIN
        val contentH = rootLaid.blockH
        val height = rootLaid.top - (if (title.isNotBlank()) TITLE_H else 0.0) - MARGIN + contentH + MARGIN * 2

        val sb = StringBuilder()
        sb.append(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"${fmt(width)}\" height=\"${fmt(height)}\" " +
                "viewBox=\"0 0 ${fmt(width)} ${fmt(height)}\">"
        )
        sb.append("<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>")
        if (title.isNotBlank()) {
            sb.append("<text x=\"${fmt(MARGIN)}\" y=\"30\" font-size=\"16\" font-weight=\"600\" " +
                "fill=\"#282830\" font-family=\"sans-serif\">${esc(title)}</text>")
        }

        fun nodeColor(depth: Int): Triple<String, String, String> = when (depth) {
            // (fill, fillOpacity, textFill / stroke)
            0 -> Triple(acc, "1", "#ffffff")
            1 -> Triple(acc, "0.12", acc)
            else -> Triple("#ffffff", "1", "#C9CCD3")
        }

        fun render(n: Laid) {
            val (fill, op, fgStroke) = nodeColor(n.depth)
            val font = fontOf(n.depth)
            val bx = colX[n.depth]
            val by = n.cy - NODE_H / 2
            // 连线先画（压在盒子下面）
            for (kid in n.children) {
                val x1 = bx + n.boxW
                val x2 = colX[kid.depth]
                val k = (x2 - x1) / 2
                sb.append("<path d=\"M ${fmt(x1)} ${fmt(n.cy)} C ${fmt(x1 + k)} ${fmt(n.cy)}, " +
                    "${fmt(x2 - k)} ${fmt(kid.cy)}, ${fmt(x2)} ${fmt(kid.cy)}\" " +
                    "fill=\"none\" stroke=\"#C9CCD3\" stroke-width=\"1.4\"/>")
            }
            val stroke = if (n.depth >= 2) " stroke=\"$fgStroke\"" else ""
            sb.append("<rect x=\"${fmt(bx)}\" y=\"${fmt(by)}\" width=\"${fmt(n.boxW)}\" height=\"${fmt(NODE_H)}\" " +
                "rx=\"8\" fill=\"$fill\" fill-opacity=\"$op\"$stroke/>")
            sb.append("<text x=\"${fmt(bx + PAD_X)}\" y=\"${fmt(n.cy + font * 0.35)}\" font-size=\"${fmt(font)}\" " +
                (if (n.depth == 0) "font-weight=\"600\" " else "") +
                "fill=\"$fgStroke\" font-family=\"sans-serif\">${esc(n.label)}</text>")
            n.children.forEach { render(it) }
        }
        render(rootLaid)
        sb.append("</svg>")
        return sb.toString()
    }

    private fun maxDepth(n: MindNode, d: Int = 0): Int =
        if (n.children.isEmpty()) d else n.children.maxOf { maxDepth(it, d + 1) }

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
