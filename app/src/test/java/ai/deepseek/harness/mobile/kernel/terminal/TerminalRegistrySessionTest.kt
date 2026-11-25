package ai.deepseek.harness.mobile.kernel.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * TerminalRegistry.Session 的环形缓冲与 guardedSend 护栏。
 *
 * Session 不起真进程也能测：append/slice/truncatedBefore/length 是纯缓冲逻辑，
 * guardedSend 只写 stdout 流 —— 这些是「offset 漂移」「并发交叉写 stdin」
 * 两类最阴的缺陷所在，此前只测了 Signals 的纯函数判定。
 */
class TerminalRegistrySessionTest {

    /** 永不退出的哑进程：Session 的缓冲方法不碰 process，guardedSend 只写它的 stdout */
    private class StubProcess : Process() {
        val stdinBytes = ByteArrayOutputStream()
        override fun getOutputStream() = stdinBytes
        override fun getInputStream() = ByteArrayInputStream(ByteArray(0))
        override fun getErrorStream() = ByteArrayInputStream(ByteArray(0))
        override fun waitFor() = 0
        override fun waitFor(timeout: Long, unit: java.util.concurrent.TimeUnit) = true
        override fun exitValue() = 0
        override fun destroy() {}
        override fun destroyForcibly() = this
    }

    private fun session() = TerminalRegistry.Session("t", "shell", "/tmp", StubProcess())

    /* ---------------- 环形缓冲 ---------------- */

    @Test fun `未裁剪时 offset 与写入位置一致`() {
        val s = session()
        s.append("hello")
        s.append(" world")
        assertEquals(11, s.length())
        assertEquals("hello world", s.slice(0, 0))
        assertEquals("world", s.slice(6, 0))
        assertEquals("wor", s.slice(6, 3))
        assertFalse(s.truncatedBefore(0))
    }

    @Test fun `环形裁剪后绝对 offset 不漂移`() {
        val s = session()
        // MAX_BUFFER=128KB：先灌 120KB，再灌 16KB 触发裁剪
        s.append("x".repeat(120 * 1024))
        val lenBefore = s.length()
        s.append("y".repeat(16 * 1024))
        // dropped = lenBefore + 16K - MAX_BUFFER
        val dropped = lenBefore + 16 * 1024L - TerminalRegistry.MAX_BUFFER
        assertEquals(dropped, s.dropped)
        // 绝对长度只增不减
        assertEquals(lenBefore + 16 * 1024, s.length())
        // 被裁掉的部分 truncatedBefore 说真话（dropped 是首个存活 offset，dropped-1 是最后被裁的）
        assertTrue(s.truncatedBefore(dropped.toInt() - 1))
        assertFalse(s.truncatedBefore(dropped.toInt()))
        // 从被裁掉的 offset（0）读：从现存最早处（绝对 dropped=8192）给到末尾，不报错也不跳过
        val tail = s.slice(0, 0)
        assertEquals(TerminalRegistry.MAX_BUFFER, tail.length)
        // 现存最早处仍是 'x'（绝对 8192..122879），'y' 从绝对 122880 开始
        assertTrue(tail.take(10).all { it == 'x' })
        val ys = s.slice((lenBefore).toInt(), 0)
        assertEquals(16 * 1024, ys.length)
        assertTrue(ys.all { it == 'y' })
    }

    @Test fun `offset 超过末尾返回空串`() {
        val s = session()
        s.append("abc")
        assertEquals("", s.slice(3, 0))
        assertEquals("", s.slice(999, 0))
    }

    @Test fun `count 正数在末尾截断`() {
        val s = session()
        s.append("abcdef")
        assertEquals("def", s.slice(3, 99))
        assertEquals("", s.slice(6, 5))
    }

    /* ---------------- guardedSend 护栏 ---------------- */

    @Test fun `空闲会话写入成功且 submit 自动补换行`() {
        val reg = TerminalRegistry()
        val s = session()
        assertNull(reg.guardedSend(s, "echo hi", submit = true))
        assertEquals("echo hi\n", String((s.process.outputStream as ByteArrayOutputStream).toByteArray()))
    }

    @Test fun `submit=false 不补换行`() {
        val reg = TerminalRegistry()
        val s = session()
        reg.guardedSend(s, "raw", submit = false)
        assertEquals("raw", String((s.process.outputStream as ByteArrayOutputStream).toByteArray()))
    }

    @Test fun `占用中的会话返回 SEND_ACTIVE 而不写 stdin`() {
        val reg = TerminalRegistry()
        val s = session()
        // 模拟另一个发送正占用护栏（如后台收集 job）
        assertTrue(s.sending.compareAndSet(false, true))
        val r = reg.guardedSend(s, "second", submit = true)
        assertNotNull(r)
        assertEquals("SEND_ACTIVE", r!!.optString("code"))
        assertEquals(0, (s.process.outputStream as ByteArrayOutputStream).size())
        s.sending.set(false)
    }

    @Test fun `护栏释放后可再次写入`() {
        val reg = TerminalRegistry()
        val s = session()
        s.sending.set(true)
        assertNotNull(reg.guardedSend(s, "a", submit = false))
        s.sending.set(false)
        assertNull(reg.guardedSend(s, "b", submit = false))
        assertEquals("b", String((s.process.outputStream as ByteArrayOutputStream).toByteArray()))
    }

    @Test fun `已关闭会话返回 SESSION_EXIT`() {
        val reg = TerminalRegistry()
        val s = session()
        s.closed = true
        val r = reg.guardedSend(s, "x", submit = true)
        assertEquals("SESSION_EXIT", r!!.optString("code"))
    }
}
