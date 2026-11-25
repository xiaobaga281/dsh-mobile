package ai.deepseek.harness.mobile.kernel.device

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 合并前台/后台后的「不抢屏」闸门 —— 仲裁只看手，不看 DSH 是否在前台。
 *
 * 锁的行为：操控别的应用时（DSH 必然在后台）不再被排队闸门卡死，
 * 唯一让路条件是用户正在摸屏幕。这是「操控不可用、老是中途停下」的根治点。
 */
class PhoneGateTest {

    private companion object {
        const val NEVER = Long.MIN_VALUE
        const val NOW = 10_000_000L
    }

    @Test
    fun dsh_foreground_always_free_even_while_touching() {
        assertTrue(PhoneControlService.screenFreeForControl(appVisible = true, interactive = true, lastTouchAtMs = NOW - 100, now = NOW))
    }

    @Test
    fun screen_off_free() {
        assertTrue(PhoneControlService.screenFreeForControl(appVisible = false, interactive = false, lastTouchAtMs = NOW - 100, now = NOW))
    }

    @Test
    fun never_touched_free() {
        // 服务刚连上 / 机型不上报触摸事件：宁可少拦不卡死
        assertTrue(PhoneControlService.screenFreeForControl(appVisible = false, interactive = true, lastTouchAtMs = NEVER, now = NOW))
    }

    @Test
    fun user_touching_busy() {
        // 亮屏 + DSH 后台 + 1s 前刚摸过 → 让路
        assertFalse(PhoneControlService.screenFreeForControl(appVisible = false, interactive = true, lastTouchAtMs = NOW - 1000, now = NOW))
    }

    @Test
    fun hand_off_long_enough_free() {
        // 2.5s 没摸 → 让（TOUCH_QUIET_MS 边界）
        assertTrue(PhoneControlService.screenFreeForControl(appVisible = false, interactive = true, lastTouchAtMs = NOW - 2500, now = NOW))
        assertFalse(PhoneControlService.screenFreeForControl(appVisible = false, interactive = true, lastTouchAtMs = NOW - 2499, now = NOW))
    }
}
