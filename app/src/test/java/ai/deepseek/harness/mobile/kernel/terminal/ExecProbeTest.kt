package ai.deepseek.harness.mobile.kernel.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 执行内存探针的解析与判词验收（rc.117）。
 *
 * 背景：rc.115 曾把真机的确定性 JVM 启动失败归因为 grsec 硬模式，随后被
 * 「标准 Android 6.12 内核（无 PaX）」的实测推翻。这三类机制的区分只能靠
 * 实验（翻转 vs 直接带 X），判词就是这组实验的自动读表器。
 */
class ExecProbeTest {

    /** 真机预期形态：untrusted_app_27 域（targetSdk 28 选型的证据）+ 翻转被拒 + 直接带 X 被拒 */
    private val denyAll = """
        EXEC_PROBE seccomp=2 selinux=u:r:untrusted_app_27:s0:c136,c257,c512,c768 pagesize=4096
        EXEC_PROBE flip=EPERM errno=13
        EXEC_PROBE rwx=EPERM errno=13
    """.trimIndent()

    /** OEM W^X 的典型形状：只禁翻转、允许 mmap 直接带 X（ART 因此活、HotSpot 因此死） */
    private val denyFlip = """
        EXEC_PROBE seccomp=2 selinux=u:r:untrusted_app_27:s0 pagesize=4096
        EXEC_PROBE flip=EPERM errno=13
        EXEC_PROBE rwx=ok
    """.trimIndent()

    /** 执行内存没问题：JVM 失败另有原因（布局 / proot 转译） */
    private val execOk = """
        EXEC_PROBE seccomp=2 selinux=u:r:untrusted_app_27:s0 pagesize=16384
        EXEC_PROBE flip=ok
        EXEC_PROBE rwx=ok
    """.trimIndent()

    @Test
    fun `解析出头信息与两条实验`() {
        val r = ExecProbe.parse(denyAll)
        assertNotNull(r)
        assertEquals("2", r!!.seccomp)
        assertEquals("u:r:untrusted_app_27:s0:c136,c257,c512,c768", r.selinux)
        assertEquals("4096", r.pagesize)
        assertEquals("EPERM(13)", r.flip)
        assertEquals("EPERM(13)", r.rwx)
        assertEquals(3, r.lines.size)
    }

    @Test
    fun `输出里混着别的行也能解析`() {
        // exec() 的输出带 exit= 头与 guest 回显，探针行夹在中间
        val noisy = "exit=0\nsh -c 'echo hi'\n" + denyFlip + "\nexit=0"
        val r = ExecProbe.parse(noisy)
        assertNotNull(r)
        assertEquals("EPERM(13)", r!!.flip)
        assertEquals("ok", r.rwx)
    }

    @Test
    fun `没有探针行返回 null`() {
        assertNull(ExecProbe.parse("exit=1\ncat: not found"))
        assertNull(ExecProbe.parse(""))
    }

    @Test
    fun `整体禁止给硬模式判词`() {
        val v = ExecProbe.verdict(ExecProbe.parse(denyAll)!!)
        assertTrue(v.contains("整体禁止"))
        assertTrue("要点名用户态改不了", v.contains("用户态无法解除"))
    }

    @Test
    fun `只禁翻转给 W^X 判词并解释 ART 与 HotSpot 的分野`() {
        val v = ExecProbe.verdict(ExecProbe.parse(denyFlip)!!)
        assertTrue(v.contains("OEM W^X"))
        assertTrue("要说清为什么 ART 活着", v.contains("ART"))
        assertTrue("要说清为什么 HotSpot 必死", v.contains("HotSpot"))
    }

    @Test
    fun `翻转可用说明执行内存没被禁`() {
        val v = ExecProbe.verdict(ExecProbe.parse(execOk)!!)
        assertTrue(v.contains("另有原因"))
    }

    @Test
    fun `mmap 基线失败也规整成带 errno 的结果`() {
        val out = """
            EXEC_PROBE seccomp=2 selinux=none(Permission denied) pagesize=4096
            EXEC_PROBE flip=MMAP_FAIL errno=12
            EXEC_PROBE rwx=EPERM errno=13
        """.trimIndent()
        val r = ExecProbe.parse(out)!!
        assertEquals("MMAP_FAIL(12)", r.flip)
        assertEquals("EPERM(13)", r.rwx)
        // 基线都拿不到内存时落入未覆盖分支，判词要求贴原始输出而不是硬编结论
        assertTrue(ExecProbe.verdict(r).contains("未覆盖"))
    }

    @Test
    fun `未装配 reporter 时 advice 不带探针段`() {
        val saved = ExecProbe.reporter
        try {
            ExecProbe.reporter = null
            val msg = JvmStartupJitter.advice(5)
            assertTrue(msg.contains("与你的命令无关"))
            assertTrue("报错文案要纠正 PaX 误导", msg.contains("通用提示"))
            assertTrue(!msg.contains("[执行内存探针]"))
        } finally {
            ExecProbe.reporter = saved
        }
    }

    @Test
    fun `装配 reporter 后 advice 附探针报告`() {
        val saved = ExecProbe.reporter
        try {
            ExecProbe.reporter = { "判决：可执行内存被整体禁止\n  flip=EPERM(13)\n  rwx=EPERM(13)" }
            val msg = JvmStartupJitter.advice(5)
            assertTrue(msg.contains("[执行内存探针]"))
            assertTrue(msg.contains("整体禁止"))
        } finally {
            ExecProbe.reporter = saved
        }
    }

    @Test
    fun `reporter 抛异常不能炸报错文案`() {
        val saved = ExecProbe.reporter
        try {
            ExecProbe.reporter = { error("probe crashed") }
            val msg = JvmStartupJitter.advice(1)
            assertTrue(!msg.contains("[执行内存探针]"))
        } finally {
            ExecProbe.reporter = saved
        }
    }
}
