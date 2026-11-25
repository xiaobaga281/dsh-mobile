package ai.deepseek.harness.mobile.kernel.terminal

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM 启动抖动的判据验收。
 *
 * 这条判据决定「要不要重跑用户的命令」。**误判的代价是不对称的**：
 *   - 漏判 → 终端里跑 java 偶尔失败，用户重发一次即可（可恢复）；
 *   - 误判 → 一条有副作用的命令被执行两遍（`rm`、`mv`、`git commit`…），不可恢复。
 * 所以用例全部围绕「什么情况**不能**算抖动」写。
 */
class JvmStartupJitterTest {

    private val real = """
        Error occurred during initialization of VM
        Failed to mark memory page as executable - check if grsecurity/PaX is enabled
    """.trimIndent()

    @Test
    fun `真实的启动抖动要认出来`() {
        assertTrue(JvmStartupJitter.isTransient(real))
    }

    @Test
    fun `用户程序抛异常不算抖动`() {
        val out = real + "\nException in thread \"main\" java.lang.RuntimeException: boom"
        assertFalse("用户代码已经跑起来了，重试只会重复副作用", JvmStartupJitter.isTransient(out))
    }

    @Test
    fun `有栈帧就不算抖动`() {
        val out = real + "\n\tat com.dsh.Main.main(Main.java:12)"
        assertFalse(JvmStartupJitter.isTransient(out))
    }

    @Test
    fun `普通命令失败不算抖动`() {
        assertFalse(JvmStartupJitter.isTransient("cat: can't open '/nope': No such file or directory"))
        assertFalse(JvmStartupJitter.isTransient(""))
    }

    @Test
    fun `堆不够也不算抖动`() {
        // 同样有 VM 初始化抬头，但成因是参数/内存，重试没有意义，应当如实报给模型去改参数
        val out = "Error occurred during initialization of VM\nCould not reserve enough space for object heap"
        assertFalse(JvmStartupJitter.isTransient(out))
    }

    @Test
    fun `只有 mprotect 行没有抬头不算`() {
        // 用户可能只是在 cat 一段日志 —— 不能因此重跑命令
        assertFalse(JvmStartupJitter.isTransient("Failed to mark memory page as executable"))
    }

    @Test
    fun `说明文案要给可行动的下一步`() {
        val msg = JvmStartupJitter.advice(1)
        assertTrue("要说清不是用户的命令写错了", msg.contains("与你的命令无关"))
        // rc.117 起：不再断言 grsec 硬模式（标准内核真机推翻了 rc.115 的结论），
        // 文案要纠正 HotSpot 的 PaX 误导、并给「反馈给用户」的下一步
        assertTrue("要纠正 PaX 误导", msg.contains("通用提示"))
        assertTrue("要给出下一步", msg.contains("root 豁免") || msg.contains("探针"))
    }
}
