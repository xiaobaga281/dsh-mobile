package ai.deepseek.harness.mobile.kernel.plugin.builtin.app

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.KernelRuntime
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit

/**
 * 常驻的打包守护进程（guest 内一个 JVM，跑 [DshBuild] 的 `--daemon` 模式）。
 *
 * ## 为什么要有它（实测数据，不是猜的）
 *
 * emulator / hello 工程，逐阶段手动跑一遍（`.motion/verify/perf-build.sh`）：
 *
 * | 阶段 | 耗时 |
 * |---|---|
 * | proot 启动（guest `/bin/true`） | 57ms |
 * | aapt2 compile | 144ms |
 * | aapt2 link | 224ms |
 * | ecj | **5331ms** |
 * | d8 | **4826ms** |
 * | apksigner | **2820ms** |
 * | 合计（工具墙钟） | ≈13.1s |
 *
 * 而 `java -version` 只要 **49~155ms**（CDS 已开）。继续拆（`.motion/verify/perf-breakdown.sh`）：
 * ecj 编一个**纯 Java 类、不带 android.jar** 也要 4.7s；d8 不带 `--lib` 也要 3.3s；
 * apksigner `--version` 0.36s。
 *
 * 结论：**不是 JVM 启动慢，也不是 android.jar 太大，而是每个工具自己那一坨类的加载
 * 成本**——它在 proot 下被 ptrace 逐 syscall 拦截进一步放大。三个工具各付一次，
 * 每次构建重复付。
 *
 * ## 与桌面的对照依据
 *
 * - `packages/subprocess`：「The service keeps process lifetime across consumer reloads」
 *   —— 子进程寿命由服务持有，不随一次调用结束。
 * - `packages/terminal`：「keep interactive shell and REPL sessions alive across tool calls」
 *   —— 会话跨调用存活（含工作目录与环境变量）。
 *
 * 手机端原先每一步 `guestExec` 都是「起 proot → 起 JVM → 加载工具类 → 干活 → 退出」，
 * 与桌面「一个常驻会话反复用」正好相反。这个类就是把构建侧改成桌面的形状：
 * **一个常驻 JVM，把 ecj/d8/apksigner 的类加载一次留在内存里。**
 *
 * ## 生命周期与内存
 *
 * 常驻 JVM 是要吃内存的（本机实测首轮构建后 RSS 约百兆级），所以：
 * - 空闲 [IDLE_MS] 自动收掉（对齐桌面语言服务器的 idle shutdown 习惯）；
 * - 插件卸载立即收掉；
 * - `-Xmx512m` 显式封顶，不让它跟着机器内存无限浮动。
 */
class BuildDaemon(
    private val rt: KernelRuntime,
    private val jarGuest: String,
) {
    companion object {
        /** 空闲多久收掉常驻 JVM（用户可能隔一会儿再改一次界面再打一次包） */
        private const val IDLE_MS = 120_000L

        /** 构建请求的默认上限（大工程 + 首轮类加载） */
        private const val TIMEOUT_MS = 300_000L

        /**
         * 起进程的尝试次数。proot 下 JVM 初始化有 ~40% 概率
         * "Failed to mark memory page as executable"（实测：连续失败会成簇出现，
         * 3 次全灭概率并不低），所以给 5 次 + 递增退避 —— 失败不花时间（~0.5s），
         * 但一次成功就能换来后续每次 2.6s 的构建。
         */
        private const val MAX_START_ATTEMPTS = 5
    }

    private var proc: Process? = null
    private var writer: BufferedWriter? = null

    /**
     * 输出缓冲：**不能用 LinkedBlockingQueue 塞 null 当 EOF 标记**——它不接受 null，
     * offer(null) 直接 NPE，而这在 Android 上是「未捕获异常 → 整个进程被杀」。
     * 实测踩过：构建第一次调用就把 App 干掉（FATAL EXCEPTION: dsh-build-daemon-out）。
     * 改成「显式 eof 标志 + wait/notify」，语义清楚也不会自伤。
     */
    private val outLock = Object()
    private val outBuf = ArrayDeque<String>()

    @Volatile
    private var eof = false

    @Volatile
    private var lastUsed = 0L

    @Volatile
    private var busy = false

    @Volatile
    private var watchdog: Thread? = null

    /** 是否已经在跑（status 展示用，别在 UI 路径上触发启动） */
    val alive: Boolean get() = proc?.isAlive == true

    /**
     * 跑一次构建：写一行 `BUILD <plan>`，把 `[done]` 之前的输出全收下来。
     * 失败（进程没了 / 超时）会丢掉守护进程并重试，重试耗尽才抛。
     */
    @Synchronized
    fun run(planGuest: String, timeoutMs: Long = TIMEOUT_MS): String {
        var last = ""
        for (attempt in 1..MAX_START_ATTEMPTS) {
            val out = attempt(planGuest, timeoutMs)
            if (out != null) return out
            last = lastFailure
            if (attempt < MAX_START_ATTEMPTS) Thread.sleep(300L * attempt)   // 300/600/900/1200
        }
        throw KernelError(
            "打包守护进程连续 $MAX_START_ATTEMPTS 次失败（proot 下 JVM 启动被拒）：\n" +
                last.takeLast(800).trim() +
                // 确定性失败时附执行内存探针判决（OEM W^X / 整体禁 / 另有原因），别让用户再猜
                (rt.execProbeReport()?.let { "\n\n[执行内存探针]\n$it" } ?: "") +
                // shim 没编出来时必须说出来：否则 JVM 仍会撞 W^X 拒绝，看起来像「修了没用」
                (rt.execFixHint()?.let { "\n\n[execfix]\n$it" } ?: ""),
        )
    }

    private var lastFailure = ""

    private fun attempt(planGuest: String, timeoutMs: Long): String? {
        val w = start() ?: return null
        busy = true
        try {
            w.write("BUILD $planGuest\n")
            w.flush()
        } catch (e: Exception) {
            // busy 必须在这里就复位：漏掉的话看门狗会永远把「有人在用」当真，
            // 常驻 JVM 再也不会被空闲回收（实测：漏了就是 176MB 一直挂着）
            busy = false
            lastFailure = "写入构建命令失败：${e.message}"
            close()
            return null
        }
        val sb = StringBuilder()
        val deadline = System.currentTimeMillis() + timeoutMs
        try {
            while (true) {
                val remain = deadline - System.currentTimeMillis()
                if (remain <= 0) {
                    lastFailure = "打包超时（${timeoutMs / 1000}s）：\n$sb"
                    close()
                    return null
                }
                val line = nextLine(deadline)
                if (line == null) {
                    // null 有两种来源：超时 or 进程没了（见 nextLine 的 eof 判定）
                    val died = eof
                    lastFailure = when {
                        sb.isNotEmpty() -> sb.toString()
                        died -> "构建进程启动即退出（proot 下 JVM 初始化抖动）"
                        else -> "等待构建输出超时（${timeoutMs / 1000}s）"
                    }
                    close()
                    return null
                }
                sb.appendLine(line)
                if (line.startsWith("[done]")) break
            }
            lastUsed = System.currentTimeMillis()
            val text = sb.toString()
            if (text.contains("[done] ok=false")) {
                lastFailure = text
                // 业务失败（编译错误等）：进程是好的，别杀，直接抛
                throw KernelError("打包失败：\n" + tailOf(text))
            }
            return text
        } finally {
            busy = false
        }
    }

    /**
     * 等下一行输出；超时返回 null，进程结束（EOF 且缓冲空）也返回 null ——
     * 调用方用 [eof] 区分两者。
     */
    private fun nextLine(deadline: Long): String? = synchronized(outLock) {
        while (outBuf.isEmpty() && !eof) {
            val remain = deadline - System.currentTimeMillis()
            if (remain <= 0) return null
            runCatching { outLock.wait(remain) }
        }
        if (outBuf.isNotEmpty()) outBuf.removeFirst() else null
    }

    /** 只看驱动与工具输出的尾部（把 [stage] 行留着，便于定位是哪一步） */
    private fun tailOf(text: String): String {
        val lines = text.lines().filter { it.isNotBlank() }
        val stage = lines.filter { it.startsWith("[stage]") || it.startsWith("[dshbuild]") }
        val rest = lines.filterNot { it.startsWith("[stage]") || it.startsWith("[done]") }
        return (stage.takeLast(6) + rest.takeLast(24)).joinToString("\n").trim()
    }

    private fun start(): BufferedWriter? {
        val p = proc
        if (p != null && p.isAlive && writer != null) return writer
        close()
        return try {
            val np = rt.openGuest(
                "/usr/bin/java",
                // 少占地址空间就少一分 mprotect(PROT_EXEC) 失败的机会：
                // 代码缓存默认预留 240MB，这里压到 48MB（本工程的编译负载远用不满）
                listOf(
                    "-Xmx384m", "-XX:ReservedCodeCacheSize=48m",
                    "-cp", jarGuest, "DshBuild", "--daemon",
                ),
            )
            synchronized(outLock) {
                outBuf.clear()
                eof = false
            }
            val reader = BufferedReader(InputStreamReader(np.inputStream, Charsets.UTF_8))
            Thread {
                try {
                    while (true) {
                        val l = reader.readLine() ?: break
                        synchronized(outLock) {
                            outBuf.addLast(l)
                            outLock.notifyAll()
                        }
                    }
                } catch (_: Throwable) {
                    // 进程被收掉时读线程会抛，属正常
                } finally {
                    // 读线程绝对不能把异常漏出去：Android 上未捕获异常会杀掉整个 App
                    synchronized(outLock) {
                        eof = true
                        outLock.notifyAll()
                    }
                }
            }.apply { isDaemon = true; name = "dsh-build-daemon-out" }.start()
            proc = np
            writer = BufferedWriter(OutputStreamWriter(np.outputStream, Charsets.UTF_8))
            startWatchdog()
            writer
        } catch (e: Exception) {
            lastFailure = "起构建进程失败：${e.message}"
            null
        }
    }

    /** 空闲回收：不要留一个吃内存的 guest JVM 在后台养老 */
    private fun startWatchdog() {
        if (watchdog?.isAlive == true) return
        val t = Thread {
            while (true) {
                Thread.sleep(15_000)
                if (proc?.isAlive != true) return@Thread
                if (busy) continue
                val idle = System.currentTimeMillis() - lastUsed
                if (lastUsed > 0 && idle > IDLE_MS) {
                    close()
                    return@Thread
                }
            }
        }
        t.isDaemon = true
        t.name = "dsh-build-daemon-idle"
        watchdog = t
        t.start()
    }

    /** 收尾：先礼后兵（QUIT → 等 0.7s → 杀整棵树） */
    @Synchronized
    fun close() {
        runCatching { writer?.write("QUIT\n") }
        runCatching { writer?.flush() }
        val p = proc
        proc = null
        writer = null
        synchronized(outLock) {
            outBuf.clear()
            eof = true
            outLock.notifyAll()
        }
        if (p != null) {
            runCatching { p.waitFor(700, TimeUnit.MILLISECONDS) }
            runCatching { rt.killTree(p) }
        }
    }
}
