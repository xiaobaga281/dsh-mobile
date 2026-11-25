package ai.deepseek.harness.mobile.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 合批引擎 [StreamFlusher] 的契约 —— 现在全手机四条流式链路（内核轮次、桥的 OpenAI 流、
 * 桥的 Messages 流、团队成员正文）都跑这一份，规则错了四处一起错。
 *
 * 假 [StreamTicker] + 脚本时钟：该不该挂节拍、挂了几个、什么时候吐、吐成几段，
 * 全都直接看清单 —— 不靠 sleep（CI 并发跑时 sleep 就是随机失败）。
 */
class StreamFlusherTest {

    private class FakeTicker : StreamTicker {
        val scheduled = mutableListOf<Long>()
        val tasks = mutableListOf<() -> Unit>()
        var cancels = 0

        override fun post(delayMs: Long, task: () -> Unit): () -> Unit {
            scheduled.add(delayMs); tasks.add(task)
            return { cancels += 1 }
        }

        /** 模拟最早那个节拍到点 */
        fun fire() = tasks.removeAt(0).invoke()
    }

    /** 脚本时钟：测试自己推进，别借真机的毫秒 */
    private class Clock {
        var at = 0L
        operator fun invoke(): Long = at
    }

    private fun flusher(
        out: MutableList<Pair<String, String>>,
        ticker: FakeTicker,
        clock: Clock,
        flushMs: Long = 1000,
        chars: Int = 1000,
    ) = StreamFlusher({ type, text -> out.add(type to text) }, flushMs, chars, ticker, clock::invoke)

    @Test
    fun `交替通道按到达顺序逐段回放`() {
        val out = mutableListOf<Pair<String, String>>()
        val f = flusher(out, FakeTicker(), Clock())
        f.feed("reasoning", "想A")
        f.feed("delta", "说B")
        f.feed("reasoning", "想C")
        f.flush(true)
        // 两条独立缓冲 + 固定「先 think 后 text」会把它重排成 想A+想C → 说B，
        // 前端看到的就是思考挤一起、正文挤后面（rc.129 实测过的病根）
        assertEquals(listOf("reasoning" to "想A", "delta" to "说B", "reasoning" to "想C"), out)
    }

    @Test
    fun `同类型连续块合并成一段`() {
        val out = mutableListOf<Pair<String, String>>()
        val f = flusher(out, FakeTicker(), Clock())
        listOf("春", "夏", "秋", "冬").forEach { f.feed("delta", it) }
        f.flush(true)
        assertEquals(1, out.size)
        assertEquals("春夏秋冬", out[0].second)
    }

    @Test
    fun `攒够字符当场出手不等窗口`() {
        val ticker = FakeTicker()
        val out = mutableListOf<Pair<String, String>>()
        val f = flusher(out, ticker, Clock(), flushMs = 1000, chars = 6)
        f.feed("delta", "123")
        assertEquals("没到阈值不该发", 0, out.size)
        assertEquals("该挂一次待发", 1, ticker.scheduled.size)
        f.feed("delta", "456")
        assertEquals("到阈值立刻发", listOf("delta" to "123456"), out)
        assertEquals("发了就撤掉待发任务，别让节拍再空跑一次", 1, ticker.cancels)
    }

    @Test
    fun `窗口到点由节拍兜底`() {
        val ticker = FakeTicker()
        val clock = Clock()
        val out = mutableListOf<Pair<String, String>>()
        val f = flusher(out, ticker, clock, flushMs = 120)
        f.feed("delta", "半句话")
        assertTrue("缓冲里有货才挂节拍", ticker.scheduled.isNotEmpty())
        clock.at = 30
        f.feed("delta", "没人刷")
        assertEquals("同一时刻只挂一个待发任务", 1, ticker.scheduled.size)
        clock.at = 120
        ticker.fire()
        assertEquals("到点把攒的一次吐出去", listOf("delta" to "半句话没人刷"), out)
    }

    @Test
    fun `收尾吐干净并且之后不再往外投`() {
        val ticker = FakeTicker()
        val out = mutableListOf<Pair<String, String>>()
        val f = flusher(out, ticker, Clock())
        f.feed("delta", "尾巴")
        f.finish()
        assertEquals(listOf("delta" to "尾巴"), out)
        assertEquals("收尾要撤掉待发任务", 1, ticker.cancels)
        f.feed("delta", "迟到的字")
        f.flush(true)
        assertEquals("关闭之后再喂不该冒出第二个事件（异常路径的缓冲按丢弃处理）", 1, out.size)
    }

    @Test
    fun `空块不进队列`() {
        val ticker = FakeTicker()
        val out = mutableListOf<Pair<String, String>>()
        val f = flusher(out, ticker, Clock())
        f.feed("delta", "")
        assertEquals(0, ticker.scheduled.size)
        f.feed("delta", "第一块")
        assertEquals("首块不该当场发（窗口刚从这一刻起算）", 0, out.size)
    }
}
