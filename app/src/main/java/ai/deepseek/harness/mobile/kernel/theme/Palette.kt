package ai.deepseek.harness.mobile.kernel.theme

/**
 * 共享设计主题 —— 四套产物渲染器（Image SVG / Pptx / Docx / Pdf）此前各自
 * 维护一套颜色定义，Agent 无法跨格式保持视觉一致。这里是唯一真值。
 *
 * 无状态纯 object，不碰 Android API，JVM 可单测。
 * 纪律：各渲染器的 accent 入参仍然优先 —— Palette 只提供缺省，不接管定制。
 */
object Palette {

    /** 品牌主色（缺省 accent） */
    const val ACCENT = "4C8DFF"

    /** 图表/多系列产物的系列色（循环取用） */
    val series = listOf(
        "4C8DFF", // 蓝
        "34C77B", // 绿
        "FF9F43", // 橙
        "FF6B6B", // 红
        "9B8AFB", // 紫
        "00B8D4", // 青
    )

    /** 校验并归一化 accent 入参：非法/空回缺省 */
    fun accent(override: String?): String =
        override?.takeIf { it.matches(Regex("#?[0-9A-Fa-f]{6}")) }?.removePrefix("#") ?: ACCENT

    /** 第 i 个系列色（循环） */
    fun seriesColor(i: Int): String = series[Math.floorMod(i, series.size)]
}
