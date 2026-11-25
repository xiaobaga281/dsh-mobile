package ai.deepseek.harness.mobile.kernel

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ExecFix shim 源码的完整性验收（rc.117）。
 *
 * 这份 C 源码是真机上用 LD_PRELOAD 钩子验证过能起 JVM 的那份（mprotect EPERM →
 * mmap-fixed 同地址重映射）。它以字符串内置、rootfs 就绪后 guest gcc 编译，
 * 源码一旦被无意改动就会静默失效 —— 用结构断言锁住关键行为。
 *
 * 特别注意「零 include」这条：rootfs 镜像只有 gcc 与 crt/libc.so，**没有 musl 的
 * C 头文件**，带 include 的版本在干净设备上编译必败、静默降级（真机踩过）。
 */
class ExecFixTest {

    @Test
    fun `回退路径必须是 mmap 固定映射而不是重试`() {
        // 核心机制：mprotect EPERM 时用 MAP_FIXED 在同一地址重映射（mmap 时带 X 放行）
        assertTrue(ExecFix.SOURCE.contains("MMAP_FIXED_ANON"))
        assertTrue(ExecFix.SOURCE.contains("mmap(addr, len, prot, MMAP_FIXED_ANON, -1, 0)"))
        // 0x02 PRIVATE | 0x10 FIXED | 0x20 ANONYMOUS | 0x4000 NORESERVE
        assertTrue(ExecFix.SOURCE.contains("0x02 | 0x10 | 0x20 | 0x4000"))
    }

    @Test
    fun `只对失败且含可执行的调用介入`() {
        // 普通设备 mprotect 从不失败，shim 必须零副作用：先判 r==0 与 PROT_EXEC
        assertTrue(ExecFix.SOURCE.contains("if (r == 0 || !(prot & PROT_EXEC)) return r;"))
    }

    @Test
    fun `判据不能按 errno 硬编码`() {
        // 真机踩过：这台内核拒绝时报 EACCES(13)，而早期版本写成 errno != EPERM 就 return，
        // 补救逻辑整段跳过（shim 编好、包装装好、一行日志不打，JVM 照旧失败）。
        // 不同内核/ROM 报 EPERM(1) 或 EACCES(13) 都可能，所以判据里不许出现 errno 比较。
        assertFalse(
            "不得用 errno 作为是否补救的条件",
            ExecFix.SOURCE.contains("errno != EPERM") || ExecFix.SOURCE.contains("== EPERM"),
        )
        assertFalse("兜底源码同样不许硬编码", ExecFix.SOURCE_INCLUDE.contains("errno != EPERM"))
        // errno 只用于日志与失败回填：恢复成功那行要带上内核原始的拒绝码
        assertTrue(ExecFix.SOURCE.contains("note(\"[dsh-execfix] recovered addr=0x\", addr, len, prot, saved)"))
    }

    @Test
    fun `pkey_mprotect 变体也要覆盖`() {
        // 部分 JVM 路径走保护键变体，proot 对新 syscall 的转译不完整
        assertTrue(ExecFix.SOURCE.contains("int pkey_mprotect(int pkey, void *addr, usize len, int prot)"))
        // 目标 libc 没有该符号时退回普通 mprotect，不能空指针调用
        assertTrue(ExecFix.SOURCE.contains("if (!real_pkey) return mprotect(addr, len, prot);"))
    }

    @Test
    fun `源码零 include —— 干净 rootfs 没有 musl 头文件`() {
        assertFalse("不能依赖任何头文件", ExecFix.SOURCE.contains("#include"))
        // 自声明的 ABI 符号（musl 稳定导出），少任何一个都编不过或跑不起来
        listOf(
            "extern void *dlsym(void *, const char *);",
            "extern void *mmap(void *, usize, int, int, int, long);",
            "extern int mprotect(void *, usize, int);",
            "extern int *__errno_location(void);",
            "extern long write(int, const void *, usize);",
        ).forEach { assertTrue("缺少声明：$it", ExecFix.SOURCE.contains(it)) }
        // 日志不能用 stdio（没有头文件，也不引入 FILE 语义），走 write(2)
        assertTrue(ExecFix.SOURCE.contains("write(2, b, (usize)(p - b));"))
    }

    @Test
    fun `落点路径与文档一致`() {
        assertTrue(ExecFix.SO_GUEST_PATH.startsWith("/usr/lib/"))
        assertTrue(ExecFix.SO_HOST_RELPATH == "usr/lib/libdshexecfix.so")
        assertTrue(ExecFix.SRC_HOST_RELPATH.startsWith(".dsh/"))
        // 版本戳必须与 .so 同目录：ensureExecFix 用它作缓存键，源码一改就要重编
        assertTrue(ExecFix.STAMP_HOST_RELPATH.startsWith("usr/lib/"))
        assertTrue(ExecFix.VERSION.toIntOrNull() != null)
    }

    @Test
    fun `包装脚本在 guest 侧注入且透传参数`() {
        val s = ExecFix.wrapScript(ExecFix.SO_GUEST_PATH)
        // 赋值 + exec "$@"：shim 只进被 exec 的 java 进程，proot 宿主进程看不到
        // （rc.117 首包把 LD_PRELOAD 放宿主环境，proot 的 bionic linker 找不到
        //  rootfs 内路径直接起不来 —— 真机实测的回归，此处锁死注入层）
        assertTrue(s.startsWith("export LD_PRELOAD=/usr/lib/libdshexecfix.so"))
        assertTrue(s.endsWith("exec \"\$@\""))
        // 脚本体里不能有会改变参数切分的构造（如换行、分号后的额外命令）
        assertTrue(!s.contains('\n'))
    }
}
