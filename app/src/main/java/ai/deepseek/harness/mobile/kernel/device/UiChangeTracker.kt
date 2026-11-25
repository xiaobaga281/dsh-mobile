package ai.deepseek.harness.mobile.kernel.device

/**
 * 界面变化代数（uiEpoch）跟踪 —— 纯 JVM 逻辑，时间由外部注入，可单测。
 *
 * onAccessibilityEvent 的回调在主线程高频触发（打字光标、动画帧每帧一发），
 * [debounceMs] 窗口内的连发只算一次「变化」：点击按钮后界面跳转通常伴随
 * 一串事件，但语义上只有一次界面切换。
 *
 * 服务层用法：
 *   - 事件回调里调 [onEvent]（只认 WINDOW_STATE_CHANGED / WINDOW_CONTENT_CHANGED / VIEW_FOCUSED）
 *   - 操作前 [epoch] 取基线，操作后 [awaitChangeSteady] 两轮短等待做「点了有没有反应」的便宜校验
 *   - 读屏 settle 用 [msSinceLastEvent]：界面已静默就直接跳过固定 sleep
 *
 * 纪律（rc.98 修订）：等待可以条件重试（[awaitChangeSteady]，总上界 1.5×timeout），
 * 绝不循环重试操作 —— 重试操作是模型的事，内核只负责如实回报「界面变了没有」。
 */
class UiChangeTracker(
    private val debounceMs: Long = 120,
) {
    private val epoch = java.util.concurrent.atomic.AtomicLong(0)

    @Volatile
    private var lastEventAtMs: Long = Long.MIN_VALUE // MIN 值让首个事件立刻形成一次变化

    /** 每次相关无障碍事件回调（任意线程；字段读写均 volatile/atomic） */
    fun onEvent(nowMs: Long) {
        val last = lastEventAtMs
        // MIN 哨兵要单独判：nowMs - Long.MIN_VALUE 会回绕成负数，首个事件永远不形成变化
        if (last == Long.MIN_VALUE || nowMs - last > debounceMs) epoch.incrementAndGet()
        lastEventAtMs = nowMs
    }

    /** 当前界面代数（每批变化 +1） */
    fun epoch(): Long = epoch.get()

    /** 最近一次事件距 nowMs 的毫秒数（从未收到过事件时返回 MAX_VALUE = 视为静默） */
    fun msSinceLastEvent(nowMs: Long): Long =
        if (lastEventAtMs == Long.MIN_VALUE) Long.MAX_VALUE else nowMs - lastEventAtMs

    data class Result(val changed: Boolean, val elapsedMs: Long)

    /** [awaitChangeSteady] 的结果：[rounds] 是观察轮数（1 = 第一轮就变，2 = 第二轮才变） */
    data class SteadyResult(val changed: Boolean, val elapsedMs: Long, val rounds: Int)

    /**
     * 等待界面在 since 之后发生变化。
     * [sleep] 与 [now] 由调用方注入：服务层传 Thread.sleep / System.currentTimeMillis，测试注入假时钟。
     */
    fun awaitChange(since: Long, timeoutMs: Long, sleep: (Long) -> Unit, now: () -> Long): Result {
        val start = now()
        while (now() - start < timeoutMs) {
            if (epoch.get() != since) return Result(changed = true, elapsedMs = now() - start)
            sleep(40)
        }
        return Result(changed = epoch.get() != since, elapsedMs = now() - start)
    }

    /**
     * 两轮观察（rc.98）：第一轮 [timeoutMs] 未变，再补一轮 [timeoutMs]/2 ——
     * 捕捉慢过渡动画、延迟渲染这类「操作生效了但事件来得晚」的情况。
     * 总上界 1.5×timeoutMs，有硬上界所以不会在自绘界面上死等。
     * 只重试「等待」，绝不重试操作本身。
     */
    fun awaitChangeSteady(since: Long, timeoutMs: Long, sleep: (Long) -> Unit, now: () -> Long): SteadyResult {
        val r1 = awaitChange(since, timeoutMs, sleep, now)
        if (r1.changed) return SteadyResult(changed = true, elapsedMs = r1.elapsedMs, rounds = 1)
        // 第一轮期间**一个无障碍事件都没来** = 界面压根没动（点空了 / 自绘界面）：
        // 第二轮只补一小段，不再白等满半程。有事件但代数没变（打字光标这类被
        // debounce 吃掉）才等满，给慢过渡留余量。
        val quiet = msSinceLastEvent(now()) > 250
        val second = if (quiet) timeoutMs / 3 else timeoutMs / 2
        val t0 = now()
        // since 不变：第二轮仍盯同一个基线代数
        val r2 = awaitChange(since, second, sleep, now)
        return SteadyResult(changed = r2.changed, elapsedMs = r1.elapsedMs + (now() - t0), rounds = 2)
    }
}
