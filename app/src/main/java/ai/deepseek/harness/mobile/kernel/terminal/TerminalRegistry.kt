package ai.deepseek.harness.mobile.kernel.terminal

import ai.deepseek.harness.mobile.kernel.KernelError
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * 持久终端会话 —— 桌面 `ctx.terminals`（PTY）的手机端等价物。
 *
 * 安卓没有可用的 PTY 后端（`/dev/ptmx` 需要 native `forkpty`，系统不给应用层开放），
 * 这里保留同一个抽象与同一组工具，实现用一条常驻 `sh` 子进程（stdin/stdout 管道）：
 *   - 状态跨命令保留（cd、环境变量、变量赋值都有效）
 *   - 输出进环形缓冲，read 支持 offset/count 分段
 *   - send 直接写 stdin，submit=true 自动补换行
 *
 * 与桌面的差异（如实声明，不假装完整）—— 本次修的重点就是"别再说谎"：
 *   - **没有 PTY 就没有控制终端**：SIGINT / SIGTSTP / SIGHUP 无法投递。
 *     旧实现里 SIGINT 返回 `null`（= 已投递），但什么都没做 —— 模型以为中断了，
 *     实际进程还在跑，于是它照着错误的前提继续往下编。现在 SIGINT 返回结构化说明，
 *     并明确写"本次没有中断任何进程"。
 *   - send 增加就绪判定（idle_silence / timeout / session_exit），
 *     但 `idle_silence` **不证明前台命令已退出**（与桌面 inferred_idle 同义）。
 *   - 同一个会话同时只允许一个活跃 send（桌面 SEND_ACTIVE 同义）。
 *   - 不支持 TUI 全屏程序与窗口尺寸调整（桌面 schema 同样不含 resize）。
 */
class TerminalRegistry(log: (String) -> Unit = {}) {

    class Session(
        val id: String,
        val name: String,
        /** 对模型展示的工作目录：guest 会话是 `/workspace/…`，宿主会话是设备绝对路径 */
        var cwd: String,
        val process: Process,
        /** `workspace` = rootfs（有 java/python3/gcc/node）｜`device` = 安卓宿主 sh */
        val backend: String = "device",
    ) {
        val buffer = StringBuilder()
        /** 已被环形缓冲裁掉的历史字符数：对外 offset 一律按「会话开始」的绝对偏移解释 */
        @Volatile var dropped: Long = 0
        @Volatile var closed = false

        /** 单活跃发送护栏（桌面 SEND_ACTIVE）：第二个并发 send 直接失败，不排队 */
        val sending = AtomicBoolean(false)

        /** 信号投递审计：让"没有 PTY 所以没投递"成为可观测事实，而不只是文案 */
        @Volatile var signalsDelivered: Int = 0
        @Volatile var signalsDropped: Int = 0
        @Volatile var lastSignal: String? = null
        @Volatile var lastSignalDelivered: Boolean? = null

        @Synchronized fun append(text: String) {
            buffer.append(text)
            if (buffer.length > MAX_BUFFER) {
                val cut = buffer.length - MAX_BUFFER
                buffer.delete(0, cut)
                dropped += cut
            }
        }

        @Synchronized fun slice(offset: Int, count: Int): String {
            val startLong = offset.toLong() - dropped
            if (startLong >= buffer.length) return ""
            // 起点已被裁掉时只能从现存最早处给，调用方要用 truncatedBefore 明确告知模型
            val start = if (startLong < 0) 0 else startLong.toInt()
            val end = if (count <= 0) buffer.length else (start + count).coerceAtMost(buffer.length)
            if (start >= end) return ""
            return buffer.substring(start, end)
        }

        /** 该 offset 对应的输出是否已被环形缓冲丢弃 */
        @Synchronized fun truncatedBefore(offset: Int): Boolean = offset.toLong() < dropped

        /** 绝对长度（含已丢弃部分），保证 offset 不会因为裁剪而整体前移 */
        @Synchronized fun length(): Int = (dropped + buffer.length).toInt()
    }

    private val sessions = ConcurrentHashMap<String, Session>()
    private val seq = AtomicInteger(0)
    private val log = log

    /** 起会话的结果：进程 + 对外展示的 cwd + 后端名 */
    class Launch(val process: Process, val cwdLabel: String, val backend: String)

    /**
     * 起一个常驻 shell。由插件注入 —— registry 不该知道 proot 的存在。
     *
     * 为什么要有这个缝：会话后端有两种，能力差别很大。
     *   - `workspace`：rootfs 里的 sh（proot），`java/python3/gcc/node/keytool` 都在，
     *     路径语义是 `/workspace/…` —— 与桌面 terminal「在工作环境里执行」一致。
     *   - `device`：安卓宿主 `/system/bin/sh`，能碰 `/sdcard`、`pm`、`am`，但没有语言运行时。
     * 旧实现**只**有后者，却对模型宣称「持久 shell 会话」：模型于是照着 PATH 里
     * 什么都没有的环境写 `python3 x.py`，必然失败。这不是能力不足，是口径错。
     */
    fun interface ShellLauncher {
        fun start(cwd: File): Launch
    }

    /**
     * 默认后端：宿主 sh。
     *
     * **不带 `-i`**：交互模式会在每条命令前后打印 PS1 提示符，输出尾部于是混进
     * `… /workspace $ … /workspace $`（实测两次），模型会把它当成命令结果的一部分。
     * 我们不需要提示符 —— 结束判据已经由哨兵承担，非交互 stdin 同样逐行执行、
     * cd 与变量一样保留。PS1 再显式清空一次，兜住个别 ROM 强制装交互的情况。
     */
    private var hostLauncher: ShellLauncher = ShellLauncher { cwd ->
        val shell = if (File("/system/bin/sh").exists()) "/system/bin/sh" else "sh"
        val pb = ProcessBuilder(listOf(shell))
        pb.directory(cwd)
        pb.redirectErrorStream(true)
        pb.environment().apply {
            put("TERM", "dumb")
            put("PS1", "")
            put("PS2", "")
        }
        Launch(pb.start(), cwd.absolutePath, "device")
    }

    /** `workspace` 后端：rootfs 里的 sh。未注入时回退宿主 sh。 */
    @Volatile
    private var guestLauncher: ShellLauncher? = null

    fun setGuestLauncher(launcher: ShellLauncher?) {
        guestLauncher = launcher
    }

    fun setHostLauncher(launcher: ShellLauncher) {
        hostLauncher = launcher
    }

    /**
     * 执行面闸门：sandbox 只读档下必须拒绝开常驻 shell。
     *
     * 为什么由插件注入而不是构造参数：`TerminalRegistry` 由 ToolKernel 用
     * `TerminalRegistry { log }` 构造（尾随 lambda 绑到 log），再加构造参数会把
     * 那个调用点的 lambda 绑错位置。所以用 setter，且保持构造签名不变。
     */
    @Volatile
    private var executionGuard: ((String) -> Unit)? = null

    fun setExecutionGuard(guard: (String) -> Unit) {
        executionGuard = guard
    }

    fun open(cwd: File, name: String, type: String, backend: String = "workspace"): Session {
        require(type.isBlank() || type == "shell") { "不支持的终端类型：$type（手机端仅提供 shell）" }
        // 只读沙箱下开 shell 等于绕过整个沙箱：本机无法做系统调用级限制，
        // 所以在这里拒绝执行（桌面同一规矩：partial 不得当成 full 用）
        executionGuard?.invoke("常驻终端（terminal_open）")
        cwd.mkdirs()
        val wanted = backend.trim().lowercase().ifBlank { "workspace" }
        require(wanted == "workspace" || wanted == "device") {
            "不支持的终端后端：$backend（可用 workspace = rootfs 完整环境 / device = 安卓宿主 shell）"
        }
        // workspace 后端需要 rootfs；没就绪就明确失败，**不要**静默降级成宿主 sh ——
        // 那样模型会在一个没有 python/java 的环境里执行 python/java 命令，还以为是脚本写错了。
        val launcher = if (wanted == "workspace") {
            guestLauncher ?: throw KernelError(
                "当前没有可用的 workspace 后端（rootfs 未就绪）。" +
                    "先执行需要运行时的命令让其初始化，或用 backend=\u201Cdevice\u201D 开宿主 shell。",
            )
        } else hostLauncher
        val launch = launcher.start(cwd)
        val id = "term-${seq.incrementAndGet()}"
        val session = Session(id, name.ifBlank { "shell" }, launch.cwdLabel, launch.process, launch.backend)
        sessions[id] = session
        Thread({ pump(session) }, "dsh-term-${id}").apply { isDaemon = true }.start()
        log("terminal open $id in ${launch.cwdLabel} (backend=${launch.backend}, pty=false)")
        return session
    }

    private fun pump(session: Session) {
        val input: InputStream = session.process.inputStream
        val buf = ByteArray(4096)
        try {
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                session.append(String(buf, 0, n, Charsets.UTF_8))
            }
        } catch (_: Throwable) {
        } finally {
            session.closed = true
            session.append("\n[会话已结束]")
        }
    }

    fun get(id: String): Session? = sessions[id]

    fun list(): JSONArray = JSONArray().apply {
        sessions.values.sortedBy { it.id }.forEach { s ->
            put(JSONObject().apply {
                put("sessionId", s.id)
                put("name", s.name)
                put("cwd", s.cwd)
                put("tail", s.slice(maxOf(0, s.length() - 200), 200))
                put("closed", s.closed)
                put("backend", s.backend)
                put("pty", false)
                put("signals_delivered", s.signalsDelivered)
                put("signals_dropped", s.signalsDropped)
            })
        }
    }

    /** 裸写 stdin（不等待）。需要「写完等就绪」请用 [submitAndWait]。 */
    fun send(session: Session, text: String, submit: Boolean) {
        val out: OutputStream = session.process.outputStream
        out.write((if (submit) text + "\n" else text).toByteArray(Charsets.UTF_8))
        out.flush()
    }

    /**
     * 带单活跃护栏的一次裸写（terminal_send 的入口）。
     *
     * 旧实现直接调 [send]：两个并发 terminal_send 会交叉写同一个 stdin，
     * 前台命令读到 interleaved 的两行输入。SEND_ACTIVE 约束（桌面同款）
     * 不该只覆盖 [submitAndWait]，这里补齐：
     *
     * @return null = 已写入；非 null = 结构化失败（SESSION_EXIT / SEND_ACTIVE），
     *         调用方原样返回给模型。
     */
    fun guardedSend(session: Session, text: String, submit: Boolean): JSONObject? {
        if (session.closed) {
            return JSONObject()
                .put("ok", false)
                .put("code", "SESSION_EXIT")
                .put("error", "会话已经结束，请重新 terminal_open")
        }
        if (!session.sending.compareAndSet(false, true)) {
            return JSONObject()
                .put("ok", false)
                .put("code", "SEND_ACTIVE")
                .put("error", "该会话上一次 send 还没有结算（桌面同款单活跃发送约束）；" +
                    "请先 terminal_read 取走输出，或等它返回")
        }
        try {
            send(session, text, submit)
            return null
        } finally {
            session.sending.set(false)
        }
    }

    /**
     * 写入并等待命令**真正结束**。
     *
     * 判定顺序（这是本类最重要的一处语义变更）：
     *   1. `exited`：输出里出现本轮哨兵 `__DSH_END_<token>_<code>__` —— 命令确实退出了，
     *      `exit_code` 是 shell 给的，不是猜的。
     *   2. `session_exit`：顶层 shell 已退出。
     *   3. `timeout`：到点还没等到标记 —— 命令可能仍在跑，返回已收到的增量，
     *      调用方要用 `terminal_read(offset=next_offset)` 续读。
     *
     * 旧实现只有「静默 400ms 猜一次」。它有两个方向都错的失败模式：`sleep 5` 前 5 秒
     * 无输出会被判成已结束（空输出交给模型），而慢速吐字的命令会被判成还在跑。
     * 有了哨兵，两条都不成立，而且**不必再等那个静默窗口**（每条命令省 400~700ms）。
     */
    fun submitAndWait(
        session: Session,
        text: String,
        submit: Boolean,
        timeoutMs: Long = DEFAULT_SEND_TIMEOUT_MS,
    ): JSONObject {
        if (session.closed) {
            return JSONObject()
                .put("ok", false)
                .put("reason", "session_exit")
                .put("code", "SESSION_EXIT")
                .put("error", "会话已经结束，请重新 terminal_open")
        }
        if (!session.sending.compareAndSet(false, true)) {
            return JSONObject()
                .put("ok", false)
                .put("reason", "send_active")
                .put("code", "SEND_ACTIVE")
                .put("error", "该会话上一次 send 还没有结算（桌面同款单活跃发送约束）；" +
                    "请先 terminal_read 取走输出，或等它返回")
        }
        var start = session.length()
        try {
            // submit=false 是「只按键不回车」的原始写入（如给交互程序喂输入）：
            // 没有命令边界，也就没有哨兵可言，按原语义立即返回。
            if (!submit) {
                send(session, text, false)
                return readResult(session, start, "sent")
            }
            var attempt = 0
            while (true) {
                val token = TerminalSentinel.token()
                val payload = text.trimEnd('\n') + "\n" + TerminalSentinel.command(token) + "\n"
                send(session, payload, false)
                val outcome = awaitExit(session, start, token, timeoutMs)
                val hit = outcome.hit
                // proot 下 JVM 启动抖动：**只在「VM 根本没起来」时**重试一次。
                // 判据由 JvmStartupJitter 收口（用户代码已经跑过就不算），
                // 所以不会把有副作用的命令执行两遍。
                if (hit != null && hit.exitCode != 0 && attempt < MAX_JVM_RETRY &&
                    JvmStartupJitter.isTransient(hit.text)
                ) {
                    attempt++
                    start = session.length()     // 重试段落重新起算，别把上次的失败输出带上
                    continue
                }
                return outcome.toResult(attempt)
            }
        } finally {
            session.sending.set(false)
        }
    }

    /** 一次写入后的等待结果：命中标记、或退出/超时。 */
    private inner class Outcome(
        val hit: TerminalSentinel.Hit?,
        val session: Session,
        val start: Int,
        val reason: String,
    ) {
        fun toResult(retried: Int): JSONObject {
            val r = if (hit != null) {
                JSONObject().apply {
                    put("ok", true)
                    put("reason", "exited")
                    put("exit_code", hit.exitCode)
                    put("output", hit.text)
                    put("start", start)
                    put("next_offset", session.length())
                    put("truncated", session.truncatedBefore(start))
                    put("closed", session.closed)
                    if (hit.exitCode != 0) {
                        val transient = JvmStartupJitter.isTransient(hit.text)
                        put(
                            "note",
                            if (transient) JvmStartupJitter.advice(retried)
                            else "命令以退出码 ${hit.exitCode} 结束（非 0 通常意味着失败，请先看输出里的报错再决定下一步）",
                        )
                        if (transient) put("transient", true)
                    }
                }
            } else {
                readResultOf(session, start, reason)
            }
            if (retried > 0 && r.optBoolean("transient", false).not()) {
                r.put("retried", retried)
            }
            return r
        }
    }

    private fun readResultOf(session: Session, start: Int, reason: String): JSONObject =
        readResult(session, start, reason)

    /** 等哨兵出现；超时则返回已有增量。 */
    private fun awaitExit(session: Session, start: Int, token: String, timeoutMs: Long): Outcome {
        val deadline = System.currentTimeMillis() + timeoutMs.coerceIn(1_000L, MAX_SEND_TIMEOUT_MS)
        while (true) {
            if (session.closed) return Outcome(null, session, start, "session_exit")
            val hit = TerminalSentinel.find(token, session.slice(start, 0))
            if (hit != null) return Outcome(hit, session, start, "exited")
            if (System.currentTimeMillis() >= deadline) return Outcome(null, session, start, "timeout")
            Thread.sleep(POLL_MS)
        }
    }

    private fun readResult(session: Session, start: Int, reason: String): JSONObject {
        val delta = session.slice(start, 0)
        val truncated = session.truncatedBefore(start)
        return JSONObject().apply {
            put("ok", true)
            put("reason", reason)
            put("output", delta)
            put("start", start)
            put("next_offset", session.length())
            put("truncated", truncated)
            put("closed", session.closed)
            if (reason == "idle_silence") {
                put(
                    "note",
                    "输出已静默，只表示「暂时没新输出」，不证明前台命令已经结束；" +
                        "需要确认请再用 terminal_send 发 echo 探针，或 terminal_read 继续取。",
                )
            }
            if (truncated) {
                put("warning", "本次输出开头有部分内容已被环形缓冲裁掉，只能从现存最早处给出")
            }
        }
    }

    /**
     * 投递信号。
     *
     * @return `null` = **已真正投递**；返回字符串 = 该信号在安卓上不可投递的结构化说明。
     *
     * 关键的诚实性约定：`SIGINT` 在无 PTY 环境下**不会**返回 null。旧实现在这里
     * 返回 null 却什么都没做，等于对模型撒谎（模型会以为命令被中断）。
     */
    fun signal(session: Session, signal: String): String? {
        val decision = Signals.decision(signal)
        session.lastSignal = decision.name
        if (decision.deliverable) {
            when (decision.name) {
                "SIGTERM" -> runCatching { session.process.destroy() }
                "SIGKILL" -> runCatching { session.process.destroyForcibly() }
            }
        }
        if (decision.deliverable) {
            session.signalsDelivered++
            session.lastSignalDelivered = true
        } else {
            session.signalsDropped++
            session.lastSignalDelivered = false
        }
        return decision.message
    }

    /**
     * 关闭会话。两段式：先关 stdin + destroy，给 [CLOSE_GRACE_MS] 优雅退出，
     * 仍在跑再 destroyForcibly —— 不会留下孤儿 `sh` 或它派生的孙进程。
     */
    fun close(session: Session) {
        sessions.remove(session.id)
        session.closed = true
        runCatching { session.process.outputStream.close() }
        val p = session.process
        runCatching { p.destroy() }
        val exited = runCatching { p.waitFor(CLOSE_GRACE_MS, TimeUnit.MILLISECONDS) }
            .getOrDefault(false)
        if (!exited) runCatching { p.destroyForcibly() }
    }

    fun describe(): JSONObject = JSONObject().apply {
        put("backend", "pipe-sh")
        put("backends_available", JSONArray(listOfNotNull("device", if (guestLauncher != null) "workspace" else null)))
        put("pty", false)
        put("sessions", sessions.size)
        put("signals_delivered_supported", JSONArray(listOf("SIGTERM", "SIGKILL")))
        put("signals_unsupported", JSONArray(listOf("SIGINT", "SIGTSTP", "SIGHUP")))
        put(
            "note",
            "管道 shell 不是终端：SIGINT 无法投递到前台进程组，全屏 TUI 程序不可用。" +
                "需要真终端语义请用桌面 Harness。",
        )
    }

    /**
     * 信号语义的**纯函数**判定（不碰进程、不做 IO）。
     *
     * 抽这一层的原因：`signal()` 需要进程才能调用，而"无 PTY 时 SIGINT 不能谎报已投递"
     * 这条最关键的行为必须能在 JVM 单测里直接断言 —— 否则它只能靠真机手工验证，
     * 而这类"说了但没做"的缺陷恰恰最容易在回归中被重新引入。
     */
    object Signals {

        class Decision(
            /** 规范化后的大写信号名 */
            val name: String,
            /** 是否真的能投递到进程 */
            val deliverable: Boolean,
            /** null = 已投递；非 null = 结构化说明（含"本次没有中断任何进程"这类事实） */
            val message: String?,
        )

        fun decision(signal: String): Decision {
            val sig = signal.trim().uppercase()
            return when (sig) {
                "SIGTERM", "SIGKILL" -> Decision(sig, deliverable = true, message = null)
                "SIGINT" -> Decision(
                    sig, deliverable = false,
                    message = "SIGINT 未投递：安卓侧没有 PTY 控制终端，无法向 shell 的前台进程组发送中断信号。" +
                        "本次没有中断任何进程。要继续：a) 用 terminal_send 输入该程序自己的退出方式" +
                        "（如 q、:q!、exit），或 b) 用 SIGTERM 结束整个 shell 会话后重新 terminal_open。" +
                        "（桌面端有 PTY，SIGINT 会真实投递到前台进程组；这是平台差异，不是参数写错。）",
                )

                "SIGTSTP", "SIGHUP" -> Decision(
                    sig, deliverable = false,
                    message = "安卓没有 PTY 控制终端，$sig 无法投递；" +
                        "请用 terminal_close 结束会话，或 terminal_send 发送应用自身的中断命令。",
                )

                else -> Decision(
                    sig, deliverable = false,
                    message = "未知信号：$signal（可用 SIGINT / SIGTERM / SIGKILL；" +
                        "SIGTSTP、SIGHUP 在手机端不可用）",
                )
            }
        }
    }

    companion object {
        const val MAX_BUFFER = 128 * 1024
        /** 输出静默多久算「暂时空闲」 */
        const val IDLE_SILENCE_MS = 400L
        const val POLL_MS = 60L
        const val DEFAULT_SEND_TIMEOUT_MS = 30_000L
        const val MAX_SEND_TIMEOUT_MS = 600_000L
        /** JVM 启动抖动的自动重试次数（1 次足够：失败率约 1/5，重试后残余 ≈ 4%） */
        const val MAX_JVM_RETRY = 1
        /** 关闭时的优雅退出宽限（桌面 disposeGraceMs=3000） */
        const val CLOSE_GRACE_MS = 3_000L
    }
}
