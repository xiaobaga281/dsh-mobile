package ai.deepseek.harness.mobile.kernel.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 终端信号的诚实性验收。
 *
 * 这是本次最"便宜但最重要"的一条：旧实现里 `SIGINT` 返回 `null`（约定 = 已投递）
 * 却什么都没做。模型据此以为命令被中断，接着按错误前提继续推演 —— 比报错更坏，
 * 因为用户完全看不出哪里断了。
 *
 * 这些用例只测纯函数 [TerminalRegistry.Signals]，不需要起真 shell，所以能在 JVM 上跑。
 */
class TerminalSignalTest {

    private fun decision(s: String) = TerminalRegistry.Signals.decision(s)

    @Test
    fun `SIGINT 不得谎报已投递`() {
        val d = decision("SIGINT")
        assertFalse("无 PTY 时 SIGINT 不可投递", d.deliverable)
        assertNotNull("必须返回结构化说明，而不是 null（null 约定 = 已投递）", d.message)
        // 文案必须把「没做」说清楚，否则模型会继续按"已中断"推演
        assertTrue(d.message!!.contains("未投递"))
        assertTrue(d.message!!.contains("没有中断任何进程"))
    }

    @Test
    fun `SIGTERM 与 SIGKILL 是真正可投递的`() {
        listOf("SIGTERM", "SIGKILL").forEach { sig ->
            val d = decision(sig)
            assertTrue("$sig 应该可投递", d.deliverable)
            assertNull("已投递时返回 null", d.message)
            assertEquals(sig, d.name)
        }
    }

    @Test
    fun `SIGTSTP 与 SIGHUP 不可投递且给出替代方案`() {
        listOf("SIGTSTP", "SIGHUP").forEach { sig ->
            val d = decision(sig)
            assertFalse(d.deliverable)
            assertNotNull(d.message)
            assertTrue(d.message!!.contains("无法投递"))
            assertTrue("要给出替代路径", d.message!!.contains("terminal_close"))
        }
    }

    @Test
    fun `信号名大小写与空白被规范化`() {
        assertEquals("SIGINT", decision("  sigint ").name)
        assertTrue("小写 sigterm 也要判为可投递", decision("sigterm").deliverable)
        assertTrue(decision("SIGKILL").deliverable)
    }

    @Test
    fun `未知信号判为不可投递并列出可用信号`() {
        val d = decision("SIGUSR1")
        assertFalse(d.deliverable)
        assertNotNull(d.message)
        assertTrue(d.message!!.contains("未知信号"))
        assertTrue(d.message!!.contains("SIGTERM"))
    }

    @Test
    fun `未投递集合与可投递集合不重叠`() {
        val deliverable = listOf("SIGTERM", "SIGKILL").filter { decision(it).deliverable }.toSet()
        val dropped = listOf("SIGINT", "SIGTSTP", "SIGHUP").filterNot { decision(it).deliverable }.toSet()
        assertEquals(setOf("SIGTERM", "SIGKILL"), deliverable)
        assertEquals(setOf("SIGINT", "SIGTSTP", "SIGHUP"), dropped)
        assertTrue(deliverable.intersect(dropped).isEmpty())
    }
}
