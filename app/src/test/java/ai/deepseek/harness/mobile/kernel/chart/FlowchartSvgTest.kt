package ai.deepseek.harness.mobile.kernel.chart

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** FlowchartSvg 的纯逻辑钉死：分层/形状/环检测/分支标签/确定性（零 Android 依赖） */
class FlowchartSvgTest {

    private val classic = listOf(
        FlowNode("a", "提交申请", "start"),
        FlowNode("b", "主管审批", "process"),
        FlowNode("c", "金额达标？", "decision"),
        FlowNode("d", "财务复核", "process"),
        FlowNode("e", "驳回通知", "io"),
        FlowNode("f", "打款", "end"),
    )
    private val classicEdges = listOf(
        FlowEdge("a", "b"), FlowEdge("b", "c"),
        FlowEdge("c", "f"), FlowEdge("c", "e"),
        FlowEdge("e", "d"), FlowEdge("d", "f"),
    )

    @Test
    fun renders_all_shapes() {
        val svg = FlowchartSvg.build(classic, classicEdges, title = "报销流程")
        assertTrue("胶囊 rx 丢了", svg.contains("rx=\"20\""))      // start/end 胶囊（h=40 → rx=20）
        assertTrue("菱形丢了", svg.contains("<polygon") && svg.contains("FFF9EC"))
        assertTrue("平行四边形丢了", svg.contains("EEF3FC"))
        assertTrue("标题丢了", svg.contains("报销流程"))
    }

    @Test
    fun decision_branches_get_yes_no_labels() {
        val svg = FlowchartSvg.build(classic, classicEdges)
        assertTrue("「是」标签丢了", svg.contains("是"))
        assertTrue("「否」标签丢了", svg.contains("否"))
    }

    @Test
    fun explicit_edge_label_beats_auto_label() {
        val edges = listOf(
            FlowEdge("a", "b"), FlowEdge("b", "c"),
            FlowEdge("c", "f", label = "通过"), FlowEdge("c", "e"),
            FlowEdge("e", "d"), FlowEdge("d", "f"),
        )
        val svg = FlowchartSvg.build(classic, edges)
        assertTrue(svg.contains("通过"))
        // c 的第二条出边仍是自动「否」
        assertTrue(svg.contains("否"))
    }

    @Test
    fun layer_increases_top_down() {
        val svg = FlowchartSvg.build(classic, classicEdges)
        // 节点文字的 y 随层单调：start(第0层) 的 cy < decision(第2层) 的 cy
        val ys = Regex("y=\"([0-9.]+)\"").findAll(svg).map { it.groupValues[1].toDouble() }.toList()
        assertTrue(ys.max() > ys.min())
        // 行高 130：3 层至少 2×130 的纵向跨度
        assertTrue("纵向跨度过小：${ys.max() - ys.min()}", ys.max() - ys.min() > 2 * 130 - 40)
    }

    @Test
    fun cycle_throws() {
        val nodes = listOf(FlowNode("a"), FlowNode("b"))
        val edges = listOf(FlowEdge("a", "b"), FlowEdge("b", "a"))
        try {
            FlowchartSvg.build(nodes, edges)
            throw AssertionError("有环应该抛异常")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun missing_endpoint_throws() {
        val nodes = listOf(FlowNode("a"))
        try {
            FlowchartSvg.build(nodes, listOf(FlowEdge("a", "ghost")))
            throw AssertionError("终点不存在应该抛异常")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun duplicate_id_throws() {
        val nodes = listOf(FlowNode("a", "一"), FlowNode("a", "二"))
        try {
            FlowchartSvg.build(nodes, emptyList())
            throw AssertionError("id 重复应该抛异常")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun empty_edges_renders_isolated_row() {
        val svg = FlowchartSvg.build(listOf(FlowNode("a", "甲"), FlowNode("b", "乙")), emptyList())
        assertTrue(svg.contains("甲") && svg.contains("乙"))
        assertFalse(svg.contains("marker-end=\"url(#arr)\""))
    }

    @Test
    fun deterministic_output() {
        assertEquals(
            FlowchartSvg.build(classic, classicEdges, title = "T"),
            FlowchartSvg.build(classic, classicEdges, title = "T"),
        )
    }

    @Test
    fun overlong_node_label_truncated() {
        val svg = FlowchartSvg.build(
            listOf(FlowNode("a", "这是一个特别特别特别特别特别特别特别特别特别特别长的步骤名", "start")),
            emptyList(),
        )
        assertTrue(svg.contains("…"))
    }

    @Test
    fun unknown_shape_throws() {
        try {
            FlowchartSvg.build(listOf(FlowNode("a", "x", "hexagon")), emptyList())
            throw AssertionError("未知形状应该抛异常")
        } catch (_: IllegalArgumentException) {
        }
    }
}
