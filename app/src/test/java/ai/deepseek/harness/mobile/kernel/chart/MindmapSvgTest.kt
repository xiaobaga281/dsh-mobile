package ai.deepseek.harness.mobile.kernel.chart

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** MindmapSvg 的纯逻辑钉死：布局/截断/深度上限/确定性（零 Android 依赖） */
class MindmapSvgTest {

    @Test
    fun single_node_renders_root_only() {
        val svg = MindmapSvg.build(MindNode("主题"))
        assertTrue(svg.contains("<svg") && svg.contains("</svg>"))
        assertTrue(svg.contains("主题"))
        // 只有根：没有贝塞尔连线
        assertFalse(svg.contains("<path"))
    }

    @Test
    fun sibling_subtrees_do_not_overlap_vertically() {
        val svg = MindmapSvg.build(MindNode("根", children = listOf(
            MindNode("甲", children = listOf(MindNode("甲1"), MindNode("甲2"))),
            MindNode("乙"),
        )))
        // 全树 5 个节点（根/甲/甲1/甲2/乙）各有一个 rect；(x,y) 对必须唯一
        val rectPos = Regex("<rect[^>]* x=\"([0-9.]+)\"[^>]* y=\"([0-9.]+)\"").findAll(svg)
            .map { it.groupValues[1].toDouble() to it.groupValues[2].toDouble() }.toList()
        assertEquals("应有 5 个节点矩形", 5, rectPos.size)
        assertEquals("节点 (x,y) 不得完全重合", rectPos.size, rectPos.toSet().size)
        // 同一列（x 相同）内的节点纵向间距 ≥ 节点高，才真不叠
        val col2 = rectPos.filter { it.first == rectPos.map { p -> p.first }.max() }.map { it.second }.sorted()
        assertTrue("同列叶子要隔开：$col2", col2.size < 2 || col2[1] - col2[0] >= 34.0)
    }

    @Test
    fun deeper_nodes_are_further_right() {
        val svg = MindmapSvg.build(MindNode("根", children = listOf(
            MindNode("子", children = listOf(MindNode("孙"))),
        )))
        // 根 rect 的 x < 孙 rect 的 x（按列布局；「  x=」带前导空格，避免匹配到 rx=）
        val rectXs = Regex("<rect[^>]* x=\"([0-9.]+)\"").findAll(svg).map { it.groupValues[1].toDouble() }.toList()
        assertEquals(3, rectXs.size)
        assertTrue("根应在最左：$rectXs", rectXs[0] < rectXs[2])
    }

    @Test
    fun chinese_label_is_wider_than_same_length_ascii() {
        val cn = MindmapSvg.build(MindNode("根", children = listOf(MindNode("一二三四五六七八九十"))))
        val ascii = MindmapSvg.build(MindNode("root", children = listOf(MindNode("abcdefghij"))))
        val wCn = canvasWidth(cn)
        val wAscii = canvasWidth(ascii)
        assertTrue("中文画布应更宽：$wCn vs $wAscii", wCn > wAscii)
    }

    @Test
    fun overlong_label_is_truncated_with_ellipsis() {
        val svg = MindmapSvg.build(MindNode("根", children = listOf(
            MindNode("这是一个特别特别特别特别特别特别特别特别特别特别长的标签"),
        )))
        assertTrue("应有省略号：$svg", svg.contains("…"))
        assertFalse(svg.contains("特别长的标签"))
    }

    @Test
    fun depth_over_six_throws() {
        // 7 层：根 + 6 层子
        var n = MindNode("叶")
        repeat(6) { i -> n = MindNode("层$i", children = listOf(n)) }
        try {
            MindmapSvg.build(n)
            throw AssertionError("超过 6 层应该抛异常")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun six_levels_are_allowed() {
        var n = MindNode("叶")
        repeat(5) { i -> n = MindNode("层$i", children = listOf(n)) }
        val svg = MindmapSvg.build(n)
        assertTrue(svg.contains("叶"))
    }

    @Test
    fun deterministic_output() {
        val node = MindNode("根", children = listOf(MindNode("甲"), MindNode("乙", children = listOf(MindNode("丙")))))
        assertEquals(MindmapSvg.build(node, title = "T"), MindmapSvg.build(node, title = "T"))
    }

    @Test
    fun no_nan_or_infinity_in_output() {
        val svg = MindmapSvg.build(MindNode("根", children = listOf(
            MindNode("甲"), MindNode("乙"), MindNode("丙", children = listOf(MindNode("丁"))),
        )))
        assertFalse(svg.contains("NaN"))
        assertFalse(svg.contains("Infinity"))
        assertTrue(svg.contains("4C8DFF")) // 缺省品牌蓝
    }

    /** 提取画布宽（svg 根元素的 width 属性） */
    private fun canvasWidth(svg: String): Double =
        Regex("<svg[^>]*width=\"([0-9.]+)\"").find(svg)!!.groupValues[1].toDouble()
}
