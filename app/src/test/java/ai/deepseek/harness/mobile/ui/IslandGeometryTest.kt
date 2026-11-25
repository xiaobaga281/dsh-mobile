package ai.deepseek.harness.mobile.ui

import ai.deepseek.harness.mobile.kernel.plugin.builtin.device.IslandGeometry
import ai.deepseek.harness.mobile.kernel.plugin.builtin.device.IslandTune
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 灵动岛几何规则的纯函数钉死。
 *
 * 用户两次提出同一件事：**上下留白要跟着摄像头孔径走**。
 * 第一版写死 5px（66px 孔径下看着对，换个孔就错），所以这里把规则变成可执行断言：
 *  - 本机 66px 孔径 @density 2.625 仍然是 5px（观感不能变）；
 *  - 孔径变大，留白必须跟着变大（不是常量）；
 *  - 极小/极大孔径被上下限夹住（不贴边、不变厚黑边）。
 */
class IslandGeometryTest {

    /** 模拟器 emulator-5554：density 2.625，孔径 66px */
    private val density = 2.625f

    @Test
    fun `本机孔径 66px 仍是上下各 5px`() {
        assertEquals(5, IslandGeometry.edgePadPx(66, density))
        assertEquals(76, IslandGeometry.pillHeight(66, density))
    }

    @Test
    fun `孔径变大时留白跟着变大`() {
        val small = IslandGeometry.edgePadPx(66, density)
        val medium = IslandGeometry.edgePadPx(120, density)
        val large = IslandGeometry.edgePadPx(180, density)
        assertTrue("120px 孔径的留白($medium)必须大于 66px($small)", medium > small)
        assertTrue("180px 孔径的留白($large)必须大于 120px($medium)", large > medium)
        assertEquals(9, medium)
    }

    @Test
    fun `留白随孔径单调不减`() {
        var prev = -1
        for (d in 0..200 step 4) {
            val pad = IslandGeometry.edgePadPx(d, density)
            assertTrue("孔径 $d 的留白($pad)不能小于前一个($prev)", pad >= prev)
            prev = pad
        }
    }

    @Test
    fun `极小孔径不贴边`() {
        val lo = (IslandGeometry.EDGE_PAD_MIN_DP * density).toInt()
        assertEquals(lo, IslandGeometry.edgePadPx(0, density))
        assertEquals(lo, IslandGeometry.edgePadPx(20, density))
    }

    @Test
    fun `极大孔径不变回厚黑边`() {
        val hi = (IslandGeometry.EDGE_PAD_MAX_DP * density).toInt()
        assertEquals(hi, IslandGeometry.edgePadPx(400, density))
        assertEquals(hi, IslandGeometry.edgePadPx(2000, density))
    }

    @Test
    fun `不同密度下比例仍然成立`() {
        // 同一块 120px 孔径的屏幕：低密度设备留白更大（dp 夹取上限不同），但不为 0
        assertTrue(IslandGeometry.edgePadPx(120, 1.5f) > 0)
        assertTrue(IslandGeometry.edgePadPx(120, 3.5f) > 0)
    }

    /* ---------------- 设置页滑块（位置 / 长度 / 上下留白） ---------------- */

    @Test
    fun `设置页参数越界一律夹住`() {
        val big = IslandTune.of(999, 999, 999)
        assertEquals(IslandTune.DX_MAX, big.dx)
        assertEquals(IslandTune.W_MAX, big.widthPx)
        assertEquals(IslandTune.PAD_MAX, big.padPx)

        val small = IslandTune.of(-999, -5, -2)
        assertEquals(IslandTune.DX_MIN, small.dx)
        assertEquals(0, small.widthPx)   // <=0 = 用默认常量宽度
        assertEquals(-1, small.padPx)    // <0 = 按孔径比例自动
    }

    @Test
    fun `设置页零值表示跟随默认`() {
        val d = IslandTune.of(0, 0, -1)
        assertEquals(IslandTune.DEFAULT, d)
        // 默认宽度是 0（不是 378），换机型时才不会被硬编码宽度绑死
        assertEquals(0, d.widthPx)
    }

    @Test
    fun `垂直偏移同样夹住`() {
        assertEquals(IslandTune.DY_MAX, IslandTune.of(0, 0, -1, 999).dy)
        assertEquals(IslandTune.DY_MIN, IslandTune.of(0, 0, -1, -999).dy)
        assertEquals(40, IslandTune.of(0, 0, -1, 40).dy)
    }

    @Test
    fun `合法值原样保留`() {
        val t = IslandTune.of(40, 400, 8)
        assertEquals(40, t.dx)
        assertEquals(400, t.widthPx)
        assertEquals(8, t.padPx)
    }
}
