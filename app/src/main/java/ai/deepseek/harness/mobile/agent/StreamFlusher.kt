package ai.deepseek.harness.mobile.agent

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 「过一会儿再刷一次」由谁来做。
 *
 * 合批规则只有一份（见 [StreamFlusher]），但手机端两类调用方的线程模型不同：
 *  - 内核轮次 / 桥的 OpenAI 流 / Messages 流跑在自己的 agent 线程上 → 共用一条守护调度线程；
 *  - 桥出口与团队成员轮次本来就在往 WebView 投事件 → 挂主线程 Looper，**不为它们新起线程**
 *    （成员一轮起一个线程池、八个队友同时在跑就是八条常驻线程，纯浪费）。
 */
interface StreamTicker {

    /** 在 [delayMs] 之后跑一次 [task]；返回取消句柄（跑完之后再取消是无操作） */
    fun post(delayMs: Long, task: () -> Unit): () -> Unit

    /** 守护调度线程实现：整个进程共用一条，实例只占一个待发的 future */
    object Scheduled : StreamTicker {
        private val executor = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "dsh-stream-flush").apply { isDaemon = true }
        }

        override fun post(delayMs: Long, task: () -> Unit): () -> Unit {
            val future = executor.schedule({ runCatching { task() } }, delayMs, TimeUnit.MILLISECONDS)
            return { runCatching { future.cancel(false) } }
        }
    }

    /** 主线程 Looper 实现：不新起线程，到点就在主线程把这一段投出去 */
    object MainLooper : StreamTicker {
        override fun post(delayMs: Long, task: () -> Unit): () -> Unit {
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            val r = Runnable { runCatching { task() } }
            handler.postDelayed(r, delayMs)
            return { handler.removeCallbacks(r) }
        }
    }
}

/**
 * 流式增量合批器：把「逐 chunk 推出去」改成「按窗口推」。
 *
 * ## 为什么需要（实测缺陷，不是洁癖）
 *
 * 每条 chunk 直接 `evaluateJavascript` 会淹死 WebView 主线程（V8 编译 + 执行 ×
 * 每秒几十条）。但**只在「下一条 chunk 到达」时才检查是否该刷**同样有缺陷：
 * chunk 之间天然有间隔（模型切段、工具前停顿、网络抖动），几十个字攒在缓冲里、
 * 下一条 chunk 两秒后才来 —— 界面就干等两秒，观感上既「不及时」也「不像流式」。
 *
 * 所以两条规则同时生效：**窗口到点** 或 **攒够字符**，谁先到算谁；窗口到点的兜底
 * 由 [StreamTicker] 挂一次待发任务（有货才挂，空闲不醒）。
 *
 * ## 保序（关键，rc.129 修正）
 *
 * 思考(reasoning) 与正文(content) 在模型里是**交替**出现的。用两个独立
 * StringBuilder 分别攒、flush 时固定「先 think 后 text」，交替序列
 * `思考A → 正文B → 思考C` 会被重排成 `思考A+C → 正文B`，前端看到的就是
 * 「思考挤在一起、正文挤到后面」，读起来像截断/错位。
 *
 * 现在是单一**段队列**：同类型连续 chunk 合并为一段、类型切换新开一段，flush 时
 * **按段序回放** —— 与内核原始 chunk 流逐段同序，等价电脑端「传输层严格保序、
 * 合帧只在渲染侧」的纪律。
 *
 * ## 为什么全手机只这一份
 *
 * 以前有四条各自为政的合批：内核 agent 轮次、桥的 OpenAI 兼容流、桥的 Messages
 * 协议流（三者曾各写一份 flush 闭包，参数相近、缺陷相同，修一处漏两处），再加上
 * 团队成员正文那份手写 120ms 时间窗。现在都走这里，窗口 / 阈值 / 保序只有一份；
 * [ai.deepseek.harness.mobile.bridge.StreamCoalescer] 在它上面只加「已经发给页面」
 * 的回放日志，不再自己攒第二份段队列。
 *
 * 线程模型：任意线程 [feed]，待发任务在 [StreamTicker] 的线程上刷；都走同一把锁。
 * 调用方结束时要 [finish]（异常路径至少 [close]），否则会留一个还会往外投的任务。
 */
class StreamFlusher(
    /** 一段合批结果：类型 + 文本。实现方按到达顺序把它投出去。 */
    private val onSegment: (type: String, text: String) -> Unit,
    /** 窗口；40ms ≈ 25 次/秒，肉眼连续又不至于打满主线程 */
    private val flushMs: Long = 40,
    /** 单批字符上限：达到即刷，不等窗口（快模型下减少 V8 调用次数） */
    private val batchChars: Int = 64,
    private val ticker: StreamTicker = StreamTicker.Scheduled,
    /** 时钟接缝：单测按脚本时间推进，不靠 sleep（CI 上并发跑时 sleep 就是随机失败） */
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {

    companion object {
        /** 正文通道名（两通道写法的默认） */
        const val TEXT = "text"
        /** 思考通道名 */
        const val THINK = "think"
    }

    /** 正文 / 思考两通道的写法：内核轮次与桥的两条协议流都只用这两路 */
    constructor(
        onText: (String) -> Unit,
        onThink: (String) -> Unit = {},
        flushMs: Long = 40,
        batchChars: Int = 64,
        ticker: StreamTicker = StreamTicker.Scheduled,
    ) : this(
        { type, text -> if (type == THINK) onThink(text) else onText(text) },
        flushMs, batchChars, ticker,
    )

    private val lock = Any()

    /** (类型, 累积文本) 段队列；交替时各成一段，回放严格按入队序 */
    private val pending = ArrayDeque<Pair<String, StringBuilder>>()

    /** -1 = 还没刷过；用真时间戳当「未设置」哨兵会把从 0 起步的测试时钟吞掉 */
    private var lastFlushAt = -1L

    /** 当前那个待发任务的取消句柄；同一时刻最多挂一个 */
    private var cancelPosted: (() -> Unit)? = null

    @Volatile
    private var closed = false

    /** 追加一段流式内容；到窗口或攒够字符就当场刷出去，否则挂一次待发任务 */
    fun feed(type: String, chunk: String) {
        if (chunk.isEmpty() || closed) return
        var flushNow = false
        synchronized(lock) {
            val tail = pending.lastOrNull()
            if (tail != null && tail.first == type) tail.second.append(chunk)
            else pending.addLast(type to StringBuilder(chunk))
            val now = nowMs()
            if (lastFlushAt < 0L) lastFlushAt = now
            if (dueLocked(now, force = false)) flushNow = true
            else scheduleLocked(flushMs - (now - lastFlushAt))
        }
        if (flushNow) flush(true)
    }

    fun pushText(chunk: String) = feed(TEXT, chunk)

    fun pushThink(chunk: String) = feed(THINK, chunk)

    /** 待发任务与收尾都走这里；force=true 无视阈值吐干净 */
    fun flush(force: Boolean) {
        synchronized(lock) {
            if (pending.isEmpty()) {
                cancelPostedLocked()
                return
            }
            val now = nowMs()
            if (lastFlushAt < 0L) lastFlushAt = now
            if (!dueLocked(now, force)) return
            cancelPostedLocked()
            // 按入队序逐段回放：think/text 交替顺序 = 内核原始顺序
            val drained = pending.map { it.first to it.second.toString() }
            pending.clear()
            lastFlushAt = now
            for ((type, s) in drained) onSegment(type, s)
        }
    }

    /** 流结束：吐干净并停掉一切待发 */
    fun finish() {
        flush(true)
        close()
    }

    /** 只停待发（异常路径用，避免留下还会往外投的任务） */
    fun close() {
        closed = true
        synchronized(lock) {
            pending.clear()
            cancelPostedLocked()
        }
    }

    /** 窗口到点 或 攒够字符；[force] 一律算到点。必须在 lock 内调用 */
    private fun dueLocked(now: Long, force: Boolean): Boolean {
        if (force) return true
        if (pending.sumOf { it.second.length } >= batchChars) return true
        return now - lastFlushAt >= flushMs
    }

    /** 空闲时不醒：只挂一个待发任务，到点刷完就不再续 */
    private fun scheduleLocked(waitMs: Long) {
        if (cancelPosted != null) return
        val delay = waitMs.coerceIn(1L, flushMs.coerceAtLeast(1L))
        val self = arrayOfNulls<(() -> Unit)>(1)
        self[0] = ticker.post(delay) {
            // 只清自己：被 flush 取消后另挂了新任务时，别把新句柄清掉
            synchronized(lock) { if (self[0] === cancelPosted) cancelPosted = null }
            flush(false)
        }
        cancelPosted = self[0]
    }

    private fun cancelPostedLocked() {
        val cancel = cancelPosted ?: return
        cancelPosted = null
        runCatching { cancel() }
    }
}
