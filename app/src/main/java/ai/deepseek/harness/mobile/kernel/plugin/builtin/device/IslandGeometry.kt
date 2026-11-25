package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

/**
 * 操控灵动岛的纯几何计算（不碰 Android API，JVM 可单测）。
 *
 * 为什么单独成文件：胶囊高度是「孔径 + 上下留白」，而留白的取值规则被用户质疑过两次
 * （先是固定 5px 太厚，后来是「换孔径为什么不跟着变」）。这段规则必须有可执行断言，
 * 而不是埋在 View 构建代码里靠肉眼核对。
 */
object IslandGeometry {

    /**
     * 上下留白 = 视觉孔径 × **7.5%**。
     *
     * 用户最初定的是「上下各 5px」，但那只是**这台机器 66px 孔径下的结果**；写死常量后
     * 换一台孔更大/更小的手机，留白比例会完全变样（大孔贴边、小孔厚边）。
     * 66 × 0.075 ≈ 4.95，四舍五入仍是 5px，所以本机观感不变。
     */
    const val EDGE_PAD_RATIO = 0.075f

    /** 比例结果的上下限（dp）：小孔不贴边，大孔不变成厚黑边 */
    const val EDGE_PAD_MIN_DP = 2f
    const val EDGE_PAD_MAX_DP = 6f

    /**
     * 上下留白（屏幕像素）：孔径 × 比例，再夹在 [EDGE_PAD_MIN_DP]–[EDGE_PAD_MAX_DP]。
     *
     * @param dVisual 摄像头视觉孔径（`DisplayCutout.boundingRectTop` 短边 × 0.56，见插件）
     * @param density `DisplayMetrics.density`
     */
    fun edgePadPx(dVisual: Int, density: Float): Int {
        val byRatio = (dVisual * EDGE_PAD_RATIO + 0.5f).toInt()
        val lo = (EDGE_PAD_MIN_DP * density).toInt()
        val hi = (EDGE_PAD_MAX_DP * density).toInt().coerceAtLeast(lo)
        return byRatio.coerceIn(lo, hi)
    }

    /** 胶囊高度 = 视觉孔径 + 上下留白（本机 66px 孔径 → 76px） */
    fun pillHeight(dVisual: Int, density: Float): Int = dVisual + 2 * edgePadPx(dVisual, density)
}

/**
 * 用户在设置页调的灵动岛几何（位置 / 长度 / 上下内边距）。
 *
 * 每个字段都有「跟随默认」的零值：`dx=0` 居中、`widthPx=0` 用对称公式算出的常量、
 * `padPx=-1` 按孔径比例自动。滑块越界一律夹住 —— 别让用户把岛拖出屏幕或缩成一条线。
 */
data class IslandTune(
    /** 水平偏移（px）：+ 往右。以摄像头孔心为 0 */
    val dx: Int = 0,
    /** 垂直偏移（px）：+ 往下。以「让胶囊垂直居中于摄像头孔」为 0 */
    val dy: Int = 0,
    /** 胶囊宽度（px）：0 = 默认常量（本机 378） */
    val widthPx: Int = 0,
    /** 上下留白（px）：-1 = 按孔径比例自动（[IslandGeometry.edgePadPx]） */
    val padPx: Int = -1,
) {
    /** 重建签名：任何一项变了都要重新量几何 */
    fun signature(): String = "$dx/$dy/$widthPx/$padPx"

    companion object {
        val DEFAULT = IslandTune()

        /** 滑块范围（px）。上限按 1080 宽屏幕留出安全边：胶囊不会顶到屏幕边 */
        const val DX_MIN = -200
        const val DX_MAX = 200
        const val DY_MIN = -100
        const val DY_MAX = 100
        const val W_MIN = 260
        const val W_MAX = 520
        const val PAD_MIN = 0
        const val PAD_MAX = 24

        /** 夹取到合法范围（纯函数，可 JVM 单测） */
        fun of(dx: Int, widthPx: Int, padPx: Int, dy: Int = 0): IslandTune = IslandTune(
            dx = dx.coerceIn(DX_MIN, DX_MAX),
            dy = dy.coerceIn(DY_MIN, DY_MAX),
            widthPx = if (widthPx <= 0) 0 else widthPx.coerceIn(W_MIN, W_MAX),
            padPx = if (padPx < 0) -1 else padPx.coerceIn(PAD_MIN, PAD_MAX),
        )

        /** 从设置页的 JSON 解析；坏值回退默认（写坏了也不至于让岛消失） */
        fun parse(json: String?): IslandTune {
            if (json.isNullOrBlank()) return DEFAULT
            return runCatching {
                val o = org.json.JSONObject(json)
                of(o.optInt("dx", 0), o.optInt("w", 0), o.optInt("pad", -1), o.optInt("dy", 0))
            }.getOrDefault(DEFAULT)
        }
    }
}
