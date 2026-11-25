package ai.deepseek.harness.mobile.kernel.chart

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 图表渲染器：确定性（同输入同字节）+ 各图型冒烟 + 刻度单调 */
class ChartSvgTest {

    private fun barSpec() = ChartSpec(
        type = "bar", title = "季度营收",
        categories = listOf("Q1", "Q2", "Q3", "Q4"),
        series = listOf(
            ChartSpec.Serie("营收", listOf(120.0, 150.0, 180.0, 210.0)),
            ChartSpec.Serie("成本", listOf(80.0, 95.0, 110.0, 130.0)),
        ),
        yLabel = "万元",
    )

    @Test
    fun deterministic_same_input_same_output() {
        val a = ChartSvg.build(barSpec())
        val b = ChartSvg.build(barSpec())
        assertEquals("两次生成字节不同（渲染器引入了非确定性）", a, b)
    }

    @Test
    fun bar_has_rects_per_series_and_category() {
        val svg = ChartSvg.build(barSpec())
        // 4 类目 × 2 系列 = 8 根柱（排除白色背景 rect；图例已用圆点）
        assertEquals(8, Regex("<rect[^>]*fill=\"#(?!ffffff)").findAll(svg).count())
        assertTrue(svg.contains("季度营收"))
        assertTrue(svg.contains("Q1") && svg.contains("Q4"))
    }

    @Test
    fun line_draws_polylines_and_points() {
        val svg = ChartSvg.build(barSpec().copy(type = "line"))
        assertEquals(2, Regex("<polyline").findAll(svg).count())
        assertTrue(Regex("<circle").findAll(svg).count() >= 8)
    }

    @Test
    fun hbar_renders_horizontal_bars_with_category_labels() {
        val svg = ChartSvg.build(ChartSpec(
            type = "hbar", title = "排行榜",
            categories = listOf("甲", "乙", "丙"),
            series = listOf(ChartSpec.Serie("分", listOf(30.0, 60.0, 90.0))),
        ))
        assertTrue(Regex("<rect[^>]*fill=\"#(?!ffffff)").findAll(svg).count() == 3)
        assertTrue(svg.contains("甲") && svg.contains("丙"))
    }

    @Test
    fun pie_shows_percentages_and_handles_single_slice() {
        val svg = ChartSvg.build(ChartSpec(
            type = "pie", title = "占比",
            categories = listOf("A", "B", "C"),
            series = listOf(ChartSpec.Serie("s", listOf(50.0, 30.0, 20.0))),
        ))
        assertTrue("饼图缺百分比标注", svg.contains("%"))
        assertEquals(3, Regex("<path").findAll(svg).count())
        // 100% 单扇区走整圆分支
        val single = ChartSvg.build(ChartSpec(
            type = "pie", title = "独占",
            categories = listOf("全部"),
            series = listOf(ChartSpec.Serie("s", listOf(10.0))),
        ))
        assertTrue(single.contains("<circle"))
    }

    @Test
    fun scatter_plots_numeric_pairs() {
        val svg = ChartSvg.build(ChartSpec(
            type = "scatter", title = "相关性",
            categories = emptyList(),
            series = listOf(ChartSpec.Serie("样本",
                emptyList(), points = listOf(1.0 to 2.0, 3.0 to 4.0, 5.0 to 1.0))),
        ))
        assertTrue(Regex("<circle[^>]*fill-opacity").findAll(svg).count() == 3)
    }

    @Test
    fun accent_overrides_first_series_only() {
        val svg = ChartSvg.build(barSpec().copy(accent = "FF0000"))
        assertTrue("accent 没生效", svg.contains("fill=\"#FF0000\""))
        assertTrue("第二系列仍应是系列色", svg.contains("#34C77B"))
    }

    @Test
    fun negative_values_render_below_zero_line() {
        val svg = ChartSvg.build(ChartSpec(
            type = "bar", title = "盈亏",
            categories = listOf("甲", "乙"),
            series = listOf(ChartSpec.Serie("盈亏", listOf(100.0, -50.0))),
        ))
        assertFalse("Y 轴刻度缺 0：$svg", !svg.contains(">0<"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun empty_series_rejected() {
        ChartSvg.build(ChartSpec("bar", "t", listOf("x"), emptyList()))
    }

    @Test(expected = IllegalArgumentException::class)
    fun bad_type_rejected() {
        ChartSvg.build(ChartSpec("mindmap", "t", listOf("x"), listOf(ChartSpec.Serie("s", listOf(1.0)))))
    }

    @Test
    fun nice_ticks_are_monotonic_and_cover_range() {
        val ticks = NiceTicks.compute(0.0, 210.0, 5)
        assertTrue(ticks.size >= 4)
        assertEquals(ticks, ticks.sorted())
        assertTrue(ticks.first() <= 0.0 && ticks.last() >= 210.0)
        // 步长统一
        val steps = ticks.zipWithNext { a, b -> b - a }.map { Math.round(it * 1000.0) / 1000.0 }.distinct()
        assertTrue("步长不统一：$ticks", steps.size == 1)
        // 浮点尾巴被清掉
        assertTrue(ticks.all { it == Math.round(it * 1e6) / 1e6 })
    }

    @Test
    fun nice_ticks_handle_degenerate_range() {
        val flat = NiceTicks.compute(5.0, 5.0, 5)
        assertTrue(flat.contains(5.0))
        val inverted = NiceTicks.compute(10.0, 0.0, 5) // 非法区间不炸
        assertTrue(inverted.isNotEmpty())
    }
}
