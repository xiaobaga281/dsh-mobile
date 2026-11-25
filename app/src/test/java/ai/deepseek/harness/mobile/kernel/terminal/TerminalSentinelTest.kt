package ai.deepseek.harness.mobile.kernel.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 命令结束哨兵的解析验收。
 *
 * 抽成纯函数就是为了这些断言能在 JVM 上跑：真机验证只能证明「这一次是对的」，
 * 而哨兵解析一旦回归，后果是全链路静默出错 ——
 *   - 找不到标记 → 每条命令都退化成「等满 20s」再报仍在运行（慢，且错）；
 *   - 标记没剥干净 → 模型在输出里看到内部标记，会把它当命令结果的一部分；
 *   - 退出码解析错 → 「失败」被报成「成功」，比不报还坏。
 * 这三类都不需要起 shell 就能锁住。
 */
class TerminalSentinelTest {

    @Test
    fun `token 是 8 位小写 hex`() {
        repeat(50) {
            val t = TerminalSentinel.token()
            assertEquals("token 长度必须是 8", 8, t.length)
            assertTrue("token 只能是小写 hex：$t", t.all { c -> c in '0'..'9' || c in 'a'..'f' })
        }
    }

    @Test
    fun `command 行为 shell 可执行且带退出码`() {
        val line = TerminalSentinel.command("0a1b2c3d")
        // 格式串用单引号包住：这样 $? 只在一步内展开，不经过额外转义层
        assertTrue("必须是一条 printf 命令：$line", line.startsWith("printf '"))
        assertTrue("必须打印标记前缀", line.contains("__DSH_END_0a1b2c3d_"))
        assertTrue("必须取上一命令退出码", line.contains("\"\$?\""))
        assertTrue("必须换行，否则标记会和后续输出粘在一起", line.contains("\\n"))
    }

    @Test
    fun `命中后解析退出码`() {
        val out = "hello\nworld\n__DSH_END_0a1b2c3d_0__\n"
        val hit = TerminalSentinel.find("0a1b2c3d", out)
        assertNotNull(hit)
        assertEquals(0, hit!!.exitCode)
        // 标记是内部机制，绝不能出现在模型看到的输出里
        assertFalse("标记必须被剥掉", hit.text.contains("__DSH_END_"))
        assertEquals("hello\nworld", hit.text)
    }

    @Test
    fun `非零退出码原样带回`() {
        val out = "ls: /nope: No such file\n__DSH_END_0a1b2c3d_2__\n"
        val hit = TerminalSentinel.find("0a1b2c3d", out)!!
        assertEquals(2, hit.exitCode)
        assertEquals("ls: /nope: No such file", hit.text)
    }

    @Test
    fun `无输出的命令剥出空正文而不是空行`() {
        val out = "__DSH_END_0a1b2c3d_0__\n"
        val hit = TerminalSentinel.find("0a1b2c3d", out)!!
        assertEquals(0, hit.exitCode)
        assertEquals("", hit.text)
    }

    @Test
    fun `还没结束时不误判`() {
        assertNull(TerminalSentinel.find("0a1b2c3d", "still running...\n"))
        assertFalse(TerminalSentinel.seen("0a1b2c3d", "still running...\n"))
    }

    @Test
    fun `残缺标记不算命中`() {
        // 标记被环形缓冲截断、或命令正打到一半 —— 都不能当成"已结束"
        assertNull(TerminalSentinel.find("0a1b2c3d", "__DSH_END_0a1b2c3d_"))
        assertNull(TerminalSentinel.find("0a1b2c3d", "__DSH_END_0a1b2c3d"))
    }

    @Test
    fun `别的 token 的标记不认`() {
        val out = "__DSH_END_ffffffff_0__\n"
        assertNull("必须只认本轮 token，否则上一轮残留会伪造成本轮结束", TerminalSentinel.find("0a1b2c3d", out))
    }

    @Test
    fun `非法 token 直接拒绝`() {
        // 防注入：token 是拼进 shell 命令的，非法字符不能进解析路径
        assertNull(TerminalSentinel.find("", "__DSH_END__0__"))
        assertNull(TerminalSentinel.find("../../x", "__DSH_END_../../x_0__"))
        assertNull(TerminalSentinel.find("0A1B2C3D", "__DSH_END_0A1B2C3D_0__"))
    }

    @Test
    fun `多次写入残留时取最后一个`() {
        val out = "first\n__DSH_END_0a1b2c3d_0__\nsecond\n__DSH_END_0a1b2c3d_1__\n"
        val hit = TerminalSentinel.find("0a1b2c3d", out)!!
        assertEquals("同一 token 重复出现时必须取最后一次", 1, hit.exitCode)
        assertTrue(hit.text.contains("second"))
    }

    @Test
    fun `正文里出现相似字符串不破坏解析`() {
        // 用户输出里恰好提到标记格式（例如在讨论这段实现）—— 必须以真实标记为准
        val out = "文档里写着 __DSH_END_ 后面跟退出码\ntail\n__DSH_END_0a1b2c3d_0__\n"
        val hit = TerminalSentinel.find("0a1b2c3d", out)!!
        assertEquals(0, hit.exitCode)
        assertTrue(hit.text.contains("文档里写着"))
        assertTrue(hit.text.contains("tail"))
    }
}
