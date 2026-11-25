package ai.deepseek.harness.mobile.kernel

/**
 * 「W^X execmod 拒绝」的运行时补丁 —— Android 16 内核上的 JVM 启动根治项（rc.117）。
 *
 * ## 真机实证（kernel 6.12.58-android16，arm64，JDK 21.0.8）
 *
 * 用 LD_PRELOAD 钩子抓到的失败现场：
 * `mprotect(addr=0x7e643b0000 len=4096 prot=7)=-1 errno=13`，目标页在一段
 * **rw-p（已可写）匿名映射**内。结合判别实验定出这台内核的规则：
 * - mmap 时直接带 X：放行（PROT_NONE→RWX、固定地址都测过）；
 * - mprotect 给**从未写过的页**加 X：放行（RW→RX、PROT_NONE→RWX 都成功）；
 * - mprotect 给**已写过的页**加 X：**EPERM**（execmod 类 W^X 检查）。
 * HotSpot 的代码缓存提交恰好踩第三条：先拿到可写页再翻成 RWX，于是
 * "Failed to mark memory page as executable" 且 100% 确定性（paxctl / setarch
 * 自然都无效——内核根本没有 PaX，也与地址随机化无关）。
 *
 * ## 补法
 *
 * mprotect 被判 EPERM 且目标含 PROT_EXEC 时，改用
 * `mmap(addr, len, prot, MAP_FIXED|...|MAP_NORESERVE)` 在**同一地址**重新映射——
 * 这属于「mmap 时带 X」，策略放行。对 HotSpot 的提交路径无损：那是一页空的
 * 新代码缓存（写入发生在提交之后）。普通设备上 mprotect 从不失败，本补丁
 * 零副作用。
 *
 * **判据绝不能按 errno 卡**：同一条 W^X 拒绝，这台机器报 EACCES(13)，换内核/ROM
 * 可能报 EPERM(1)。rc.117 早期版本写成 `errno != EPERM 就 return`，于是本机
 * （13 ≠ 1）补救逻辑整段被跳过——shim 编好、包装装好、日志一行不打，JVM 照旧
 * 「Failed to mark memory page as executable」。现在只判「调用失败 + 目标含
 * PROT_EXEC」，errno 仅用于日志与失败时原样回填。
 *
 * ## 落地方式
 *
 * C 源码随包内置（[SOURCE]），rootfs 就绪后用 **guest gcc 一次性编译**成
 * `/usr/lib/libdshexecfix.so`（见 [KernelRuntime.ensureExecFix]），java 入口
 * （含 setarch 包装）经 **guest 侧** `/bin/sh -c 'export LD_PRELOAD=…; exec "$@"'`
 * 包装自动加载（[wrapScript]）。**注入必须走 guest 侧命令行，不能放宿主环境**：
 * 宿主环境是给 proot 本体（bionic）用的，LD_PRELOAD 指向 rootfs 内路径时宿主
 * linker 找不到文件，proot 直接起不来（rc.117 首包真机实测的回归）。失败自动
 * 降级：gcc 缺失 / 编译失败时不带 shim，行为与 rc.116 一致。
 *
 * ## 为什么源码里一个 `#include` 都没有
 *
 * 真机复核发现 rootfs 镜像只带 gcc 与 crt/`libc.so`，**musl 的 C 头文件不在**
 * （`usr/include` 下只有 bits 的一部分和 libstdc++ 头，没有 `stdio.h` /
 * `sys/mman.h` / `dlfcn.h`）。带 include 的版本在干净设备上必然编译失败、
 * 静默降级，JVM 照旧起不来。所以这里自声明所需的少量 ABI 符号（都是 musl
 * 稳定导出：`dlsym` / `mmap` / `mprotect` / `__errno_location` / `write`），
 * 连 errno 都用 `__errno_location()` 直接取，日志用 `write(2)` 手拼 —— 这样
 * 只要有 gcc 就能编，不依赖任何开发头文件。
 */
object ExecFix {

    const val SO_GUEST_PATH = "/usr/lib/libdshexecfix.so"
    const val SO_HOST_RELPATH = "usr/lib/libdshexecfix.so"
    const val SRC_HOST_RELPATH = ".dsh/execfix.c"
    const val STAMP_HOST_RELPATH = "usr/lib/.libdshexecfix.stamp"

    /**
     * 源码版本号 —— **改 [SOURCE] / [SOURCE_INCLUDE] 必须同时加一**。
     *
     * shim 是编在 rootfs 里的（跨升级保留），只判「文件存在」会让修正永远不生效：
     * 设备上已有旧 .so 时新包装原样复用。ensureExecFix 用这个号做缓存键，
     * 号变了就删掉旧 .so 重编。
     *
     * 1: 带 include 的初版（errno 硬编码 EPERM，真机上永远不触发）
     * 2: 自包含零 include；判据改为「失败 + PROT_EXEC」，不再看 errno
     */
    const val VERSION = "2"

    /**
     * guest 侧包装脚本体（`sh -c` 的脚本）。赋值 + `exec "$@"` 让 shim 只出现在
     * 被 exec 的 java 进程环境里；`"$@"` 透传参数（含空格）不重切分。
     */
    fun wrapScript(so: String): String = "export LD_PRELOAD=$so; exec \"\$@\""

    /**
     * 带 include 的旧版源码：**仅在**自包含版编译失败时兜底（有些设备装过
     * musl-dev，头文件齐全；两份源码行为一致）。
     */
    const val SOURCE_INCLUDE = """#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <sys/mman.h>
static int (*real_mprotect)(void *, size_t, int);
int mprotect(void *addr, size_t len, int prot) {
    if (!real_mprotect) real_mprotect = (int (*)(void *, size_t, int))dlsym(RTLD_NEXT, "mprotect");
    int r = real_mprotect(addr, len, prot);
    /* 不按 errno 判：EACCES(13)/EPERM(1) 都可能，只看「失败 + 要可执行」 */
    if (r == 0 || !(prot & PROT_EXEC)) return r;
    void *p = mmap(addr, len, prot, MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED|MAP_NORESERVE, -1, 0);
    if (p == addr) {
        fprintf(stderr, "[dsh-execfix] mprotect recovered via mmap-fixed addr=%p len=%zu prot=%d\n", addr, len, prot);
        return 0;
    }
    fprintf(stderr, "[dsh-execfix] recovery failed addr=%p len=%zu prot=%d errno=%d\n", addr, len, prot, errno);
    return r;
}
static int (*real_pkey)(int, void *, size_t, int);
int pkey_mprotect(int pkey, void *addr, size_t len, int prot) {
    if (!real_pkey) real_pkey = (int (*)(int, void *, size_t, int))dlsym(RTLD_NEXT, "pkey_mprotect");
    if (!real_pkey) return mprotect(addr, len, prot);
    int r = real_pkey(pkey, addr, len, prot);
    if (r == 0 || !(prot & PROT_EXEC)) return r;
    void *p = mmap(addr, len, prot, MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED|MAP_NORESERVE, -1, 0);
    if (p == addr) return 0;
    return r;
}
"""

    /** 判决日志走 stderr（守护进程输出会被收集，便于现场定位） */
    const val SOURCE = """/* 自包含：不 include 任何头文件（rootfs 里有 gcc，没有 musl 的 C 头） */
typedef unsigned long usize;

extern void *dlsym(void *, const char *);
extern void *mmap(void *, usize, int, int, int, long);
extern int mprotect(void *, usize, int);
extern int *__errno_location(void);
extern long write(int, const void *, usize);

#define RTLD_NEXT ((void *)-1L)
#define PROT_EXEC 4
#define MMAP_FIXED_ANON (0x02 | 0x10 | 0x20 | 0x4000)

static char *put_hex(char *p, unsigned long v) {
    char t[18];
    int n = 0;
    if (!v) { *p++ = '0'; return p; }
    while (v) { int d = (int)(v & 15); t[n++] = (char)(d < 10 ? '0' + d : 'a' + d - 10); v >>= 4; }
    while (n) *p++ = t[--n];
    return p;
}

static char *put_dec(char *p, unsigned long v) {
    char t[24];
    int n = 0;
    if (!v) { *p++ = '0'; return p; }
    while (v) { t[n++] = (char)('0' + (int)(v % 10)); v /= 10; }
    while (n) *p++ = t[--n];
    return p;
}

static void note(const char *tag, void *addr, usize len, int prot, int err) {
    char b[192];
    char *p = b;
    while (*tag) *p++ = *tag++;
    p = put_hex(p, (unsigned long)addr);
    *p++ = ' '; *p++ = 'l'; *p++ = 'e'; *p++ = 'n'; *p++ = '=';
    p = put_dec(p, (unsigned long)len);
    *p++ = ' '; *p++ = 'p'; *p++ = 'r'; *p++ = 'o'; *p++ = 't'; *p++ = '=';
    p = put_dec(p, (unsigned long)prot);
    if (err) {
        *p++ = ' '; *p++ = 'e'; *p++ = 'r'; *p++ = 'r'; *p++ = 'n'; *p++ = 'o'; *p++ = '=';
        p = put_dec(p, (unsigned long)err);
    }
    *p++ = '\n';
    write(2, b, (usize)(p - b));
}

static int (*real_mprotect)(void *, usize, int);
int mprotect(void *addr, usize len, int prot) {
    if (!real_mprotect) real_mprotect = (int (*)(void *, usize, int))dlsym(RTLD_NEXT, "mprotect");
    if (!real_mprotect) { *__errno_location() = 38; return -1; }
    int r = real_mprotect(addr, len, prot);
    /* 不按 errno 判：同一条 W^X 拒绝，不同内核/ROM 报 EACCES(13) 或 EPERM(1)
       （本机实测 13；真机验证过的 mpfix 也从不判 errno）。只看「失败 + 要可执行」。 */
    if (r == 0 || !(prot & PROT_EXEC)) return r;
    int saved = *__errno_location();
    /* mmap 时直接带 X 走另一条放行路径；同地址重映射，页是空的新提交页，清零无损 */
    void *p = mmap(addr, len, prot, MMAP_FIXED_ANON, -1, 0);
    if (p == addr) { note("[dsh-execfix] recovered addr=0x", addr, len, prot, saved); return 0; }
    note("[dsh-execfix] failed addr=0x", addr, len, prot, *__errno_location());
    *__errno_location() = saved;
    return r;
}

static int (*real_pkey)(int, void *, usize, int);
int pkey_mprotect(int pkey, void *addr, usize len, int prot) {
    if (!real_pkey) real_pkey = (int (*)(int, void *, usize, int))dlsym(RTLD_NEXT, "pkey_mprotect");
    /* 目标 libc 没有该符号时退回普通 mprotect（保护键语义 JVM 用不到） */
    if (!real_pkey) return mprotect(addr, len, prot);
    int r = real_pkey(pkey, addr, len, prot);
    if (r == 0 || !(prot & PROT_EXEC)) return r;
    int saved = *__errno_location();
    void *p = mmap(addr, len, prot, MMAP_FIXED_ANON, -1, 0);
    if (p == addr) { note("[dsh-execfix] pkey recovered addr=0x", addr, len, prot, saved); return 0; }
    note("[dsh-execfix] pkey failed addr=0x", addr, len, prot, *__errno_location());
    *__errno_location() = saved;
    return r;
}
"""
}
