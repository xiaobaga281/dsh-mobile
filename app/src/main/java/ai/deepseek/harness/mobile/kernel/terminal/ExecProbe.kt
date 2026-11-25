package ai.deepseek.harness.mobile.kernel.terminal

/**
 * 「可执行内存」能力探针 —— JVM 启动**确定性**失败时的判别实验。
 *
 * ## 为什么要它（rc.116 之后的真机实证，修正 rc.115 的结论）
 *
 * rc.115 曾把「连续 5 次同一拒绝（Failed to mark memory page as executable）」
 * 归因为 grsec 硬模式 PaX。真机复核推翻了这个结论：该机内核是标准 Android 6.12，
 * **没有 PaX/grsecurity**；而且报错里的 "check if grsecurity/PaX is enabled"
 * 本来就是 HotSpot 对「拿不到可执行内存」的通用提示，不代表真有 PaX。
 *
 * 排除法得到两个关键事实：
 * 1. **seccomp 不是拦路者**——`Seccomp: 2` 只说明有过滤器（所有 Android app 都有
 *    zygote seccomp 白名单），而 Android 的 app seccomp 策略不含 mprotect 限制；
 *    本 App 自己的 ART JIT 就在同一进程、同一 seccomp 下把代码页标成可执行。
 * 2. **标准 SELinux 也不是**——`untrusted_app_27` 域（targetSdk 28，Termux 同款
 *    选型）在 AOSP 政策里明文 allow execmem + execmod。
 *
 * 剩下的真凶候选需要实验区分（同一进程内 ART 活、proot 里 JVM 死，差异就在
 * 「拿可执行内存的方式」）：
 * - **OEM 内核加固（W^X）**：禁止 mprotect 把已写页「翻转出」可执行，但允许 mmap
 *   时直接带 X —— ART 用 mmap 带 X / memfd 双映射所以没事，HotSpot 初始化靠
 *   mprotect 翻转所以必死（确定性、与随机化无关，paxctl/setarch 自然都无效）。
 * - **等效 PaX MPROTECT 硬模式**：可执行内存整体禁掉。
 * - **地址布局 / proot 转译问题**：执行内存策略本身没问题，换个布局就能过。
 *
 * ## 探针形态
 *
 * 一段 python3 + ctypes 脚本，经与 JVM **同一条 proot 管线**执行（同一 seccomp /
 * SELinux / LSM 上下文），只做两件事：mmap(RW)→mprotect(RX) 的「翻转」测试，与
 * mmap(RWX) 的「直接带 X」测试，外加采集 /proc/self/status 的 Seccomp 行与
 * SELinux 上下文。CPython 不做 JIT，它自己不需要可执行内存，所以 JVM 起不来的
 * 环境里探针照样能跑。
 *
 * 本文件只做**纯解析与判词**（JVM 单测可跑）；真正的执行入口在
 * [ai.deepseek.harness.mobile.kernel.KernelRuntime.execProbeReport]，
 * 由 RuntimePlugin 装配进 [reporter]。
 */
object ExecProbe {

    /**
     * 探针脚本。输出行固定前缀 `EXEC_PROBE `，机器可读：
     * - `EXEC_PROBE seccomp=<n> selinux=<ctx> pagesize=<n>`
     * - `EXEC_PROBE flip=ok | EPERM errno=<n> | MMAP_FAIL errno=<n>`
     * - `EXEC_PROBE rwx=ok | EPERM errno=<n> | MMAP_FAIL errno=<n>`
     */
    val script: String = """
        import ctypes, os
        libc = ctypes.CDLL(None, use_errno=True)
        ps = os.sysconf("SC_PAGESIZE")
        PROT_READ, PROT_WRITE, PROT_EXEC = 1, 2, 4
        MAP_PRIVATE, MAP_ANON = 2, 0x20

        def status_line(key):
            try:
                with open("/proc/self/status") as f:
                    for line in f:
                        if line.startswith(key):
                            return line.split(":", 1)[1].strip()
            except Exception as e:
                return "ERR(%s)" % e
            return "unknown"

        try:
            selinux = open("/proc/self/attr/current").read().strip()
        except Exception as e:
            selinux = "none(%s)" % e
        print("EXEC_PROBE seccomp=%s selinux=%s pagesize=%d" % (
            status_line("Seccomp"), selinux, ps))

        libc.mmap.restype = ctypes.c_ssize_t
        libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int,
                              ctypes.c_int, ctypes.c_int, ctypes.c_long]
        libc.mprotect.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
        libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        MAP_FAILED = -1

        # 实验 1：翻转 —— 先拿 RW 匿名页，再 mprotect 成 R|X（HotSpot 的做法）
        p = libc.mmap(None, ps, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0)
        if p == MAP_FAILED:
            print("EXEC_PROBE flip=MMAP_FAIL errno=%d" % ctypes.get_errno())
        else:
            r = libc.mprotect(p, ps, PROT_READ | PROT_EXEC)
            if r != 0:
                print("EXEC_PROBE flip=EPERM errno=%d" % ctypes.get_errno())
            else:
                print("EXEC_PROBE flip=ok")
            libc.munmap(p, ps)

        # 实验 2：直接带 X —— mmap 时就给 R|W|X（ART / memfd 双映射的等价前提）
        q = libc.mmap(None, ps, PROT_READ | PROT_WRITE | PROT_EXEC,
                      MAP_PRIVATE | MAP_ANON, -1, 0)
        if q == MAP_FAILED:
            print("EXEC_PROBE rwx=EPERM errno=%d" % ctypes.get_errno())
        else:
            print("EXEC_PROBE rwx=ok")
            libc.munmap(q, ps)
    """.trimIndent()

    /** 单条实验的规整结果：`ok` / `EPERM(errno)` / `MMAP_FAIL(errno)` */
    data class Report(
        val seccomp: String?,
        val selinux: String?,
        val pagesize: String?,
        val flip: String?,
        val rwx: String?,
        /** 原始 EXEC_PROBE 行（原样进报错，便于贴日志） */
        val lines: List<String>,
    )

    /** 从命令输出中解析探针结果；一行都没匹配到返回 null（脚本没跑成/环境不支持）。 */
    fun parse(output: String): Report? {
        val lines = output.lineSequence()
            .filter { it.contains("EXEC_PROBE ") }
            .map { it.substringAfter("EXEC_PROBE ").trim() }
            .filter { it.isNotEmpty() }
            .toList()
        if (lines.isEmpty()) return null
        var seccomp: String? = null
        var selinux: String? = null
        var pagesize: String? = null
        var flip: String? = null
        var rwx: String? = null
        for (line in lines) {
            val kv = line.split(' ').filter { it.contains('=') }.associate {
                val i = it.indexOf('=')
                it.substring(0, i) to it.substring(i + 1)
            }
            when {
                kv.containsKey("seccomp") -> {
                    seccomp = kv["seccomp"]
                    selinux = kv["selinux"]
                    pagesize = kv["pagesize"]
                }
                kv.containsKey("flip") -> flip = norm(kv, "flip")
                kv.containsKey("rwx") -> rwx = norm(kv, "rwx")
            }
        }
        return Report(seccomp, selinux, pagesize, flip, rwx, lines)
    }

    /** 把 `EPERM errno=13` 规整成 `EPERM(13)`；ok 原样。 */
    private fun norm(kv: Map<String, String>, key: String): String {
        val v = kv[key] ?: return "?"
        return if (v == "ok") v else "$v(${kv["errno"] ?: "?"})"
    }

    /**
     * 人类可读的判词（不重复数据行，调用方自行拼接）。
     * 判据与 [JvmStartupJitter] 的口径一致：只对「确定性失败」给结论。
     */
    fun verdict(r: Report): String = when {
        r.flip == "ok" ->
            "判决：翻转与直接 RWX 都可用——执行内存策略没有拒绝，JVM 失败另有原因" +
                "（地址布局 / proot 转译），请带 setarch -R 的 A/B 结果继续排查。"
        r.flip?.startsWith("EPERM") == true && r.rwx == "ok" ->
            "判决：内核只禁 mprotect「翻转出」可执行页、mmap 时直接带 X 允许——OEM W^X 加固的典型形状。" +
                "这正是同进程 ART 能跑（mmap 带 X / memfd 双映射）而 HotSpot 必死（初始化时 mprotect 翻转）的原因。" +
                "用户态（paxctl / setarch / proot 配置）无法解除，需要 root 豁免或换 ROM / 设备。"
        r.flip?.startsWith("EPERM") == true && r.rwx?.startsWith("EPERM") == true ->
            "判决：可执行内存被整体禁止（mmap 直接带 X 也被拒）——等效 PaX MPROTECT 硬模式。" +
                "这是内核/LSM 层策略，用户态无法解除；需要 root 豁免、关闭相应加固或换 ROM / 设备。"
        else ->
            "判决：结果组合未覆盖（flip=${r.flip} rwx=${r.rwx}），请把探针原始输出反馈给开发者。"
    }

    /**
     * 探针执行入口，由 RuntimePlugin 在装配 KernelRuntime 后注入
     * （KernelRuntime 才有 guest 执行管线与 workspace 落点）。
     * 未装配（纯 JVM 单测 / 插件未加载）时返回 null，[JvmStartupJitter.advice]
     * 就只回纯文案。
     */
    @Volatile
    var reporter: (() -> String?)? = null

    /** 取一次探针报告（实现方负责缓存与异常兜底）；取不到返回 null。 */
    fun report(): String? = runCatching { reporter?.invoke() }.getOrNull()
}
