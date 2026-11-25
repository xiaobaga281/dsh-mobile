package ai.deepseek.harness.mobile.kernel.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** UiChangeTracker 的纯逻辑钉死（时间注入假时钟，与 TtsRouterTest 同套路） */
class UiChangeTrackerTest {

    private class Clock(var now: Long)

    @Test
    fun first_event_forms_an_epoch() {
        val t = UiChangeTracker()
        val c = Clock(1000)
        t.onEvent(c.now)
        assertEquals(1L, t.epoch())
    }

    @Test
    fun burst_events_within_debounce_count_as_one_change() {
        val t = UiChangeTracker()
        val c = Clock(1000)
        t.onEvent(c.now)
        assertEquals(1L, t.epoch())
        // 动画帧：50ms 连发不新增代数
        c.now += 50; t.onEvent(c.now)
        c.now += 50; t.onEvent(c.now)
        assertEquals(1L, t.epoch())
        // 超过 120ms 去抖窗口才算新变化
        c.now += 121; t.onEvent(c.now)
        assertEquals(2L, t.epoch())
    }

    @Test
    fun ms_since_last_event_tracks_quiet_time() {
        val t = UiChangeTracker()
        val c = Clock(10_000)
        assertEquals(Long.MAX_VALUE, t.msSinceLastEvent(c.now)) // 从未收到事件 = 视为静默
        t.onEvent(c.now)
        c.now += 300
        assertEquals(300, t.msSinceLastEvent(c.now))
    }

    @Test
    fun await_change_returns_true_when_epoch_moves() {
        val t = UiChangeTracker()
        val c = Clock(0)
        val since = 0L
        t.onEvent(1) // epoch → 1（点击后界面真的变了）
        c.now = 100
        val r = t.awaitChange(since, 600, sleep = { c.now += 40 }, now = { c.now })
        assertTrue(r.changed)
    }

    @Test
    fun await_change_times_out_when_nothing_changes() {
        val t = UiChangeTracker()
        val c = Clock(0)
        val r = t.awaitChange(0, 200, sleep = { c.now += 40 }, now = { c.now })
        assertFalse(r.changed)
        assertTrue(r.elapsedMs >= 200)
    }

    @Test
    fun await_change_notices_change_that_happens_during_wait() {
        val t = UiChangeTracker()
        val c = Clock(0)
        // 界面在第 3 次 sleep 后才变化（模拟点击后 120ms 才跳转）
        val r = t.awaitChange(0, 5000, sleep = { c.now += 40; if (c.now >= 120) t.onEvent(c.now) }, now = { c.now })
        assertTrue(r.changed)
    }

    /* ---------------- awaitChangeSteady（rc.98 两轮观察） ---------------- */

    @Test
    fun steady_returns_round1_when_change_comes_immediately() {
        val t = UiChangeTracker()
        val c = Clock(0)
        t.onEvent(1) // epoch → 1
        c.now = 100
        val r = t.awaitChangeSteady(0, 600, sleep = { c.now += 40 }, now = { c.now })
        assertTrue(r.changed)
        assertEquals(1, r.rounds)
        assertTrue(r.elapsedMs < 600) // 第一轮就返回，不会跑满
    }

    @Test
    fun steady_catches_late_change_in_round2() {
        val t = UiChangeTracker()
        val c = Clock(0)
        // 第一轮全程静默；第二轮跑到一半（慢动画）界面才变
        var round2Started = false
        val r = t.awaitChangeSteady(0, 200, sleep = {
            c.now += 40
            if (round2Started && c.now >= 240) t.onEvent(c.now)
        }, now = { if (!round2Started && c.now >= 200) round2Started = true; c.now })
        assertTrue(r.changed)
        assertEquals(2, r.rounds)
    }

    @Test
    fun steady_reports_false_after_two_silent_rounds() {
        val t = UiChangeTracker()
        val c = Clock(0)
        val r = t.awaitChangeSteady(0, 200, sleep = { c.now += 40 }, now = { c.now })
        assertFalse(r.changed)
        assertEquals(2, r.rounds)
        // 全程静默：第二轮只补 timeout/3（200 → 66，步进 40 实际 80），总 280 左右
        assertTrue("elapsed=${r.elapsedMs}", r.elapsedMs >= 240 && r.elapsedMs < 400)
    }

    @Test
    fun steady_change_in_round1_does_not_enter_round2() {
        val t = UiChangeTracker()
        val c = Clock(0)
        // 第一轮中途变化：rounds=1 且耗时不含第二轮
        val r = t.awaitChangeSteady(0, 600, sleep = { c.now += 40; if (c.now >= 120) t.onEvent(c.now) }, now = { c.now })
        assertTrue(r.changed)
        assertEquals(1, r.rounds)
        assertTrue("elapsed=${r.elapsedMs}", r.elapsedMs < 200)
    }
}
