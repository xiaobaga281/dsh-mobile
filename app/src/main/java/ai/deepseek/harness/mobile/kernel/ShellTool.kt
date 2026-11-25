package ai.deepseek.harness.mobile.kernel

import ai.deepseek.harness.mobile.kernel.plugin.ToolExecContext
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 受限 shell（桌面 ctx.shell 的手机适配）：
 * - 没有 pty，不支持交互式命令
 * - 工作目录固定在工作区，超时强杀，输出截断
 */
class ShellTool(
    private val ws: Workspace,
    private val sandbox: ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox? = null,
    /** 追加到 PATH 末尾的目录：bin 链接目录 + nativeLibraryDir（busybox 等注入运行时） */
    private val extraPathDir: String? = null,
    /** 注入运行时的动态库查找路径（DT_NEEDED 精确名符号链接所在目录） */
    private val ldLibraryPath: String? = null,
) {

    companion object {
        const val TIMEOUT_MS = 20_000L
        const val MAX_OUTPUT = 64 * 1024
    }

    fun exec(
        command: String,
        cwd: String = ".",
        timeoutMs: Long = TIMEOUT_MS,
        /** 拿到 Process 句柄的钩子：后台任务据此注册「整树终止」能力 */
        onStart: ((Process) -> Unit)? = null,
    ): String {
        if (command.isBlank()) throw KernelError("command 不能为空")
        // 只读沙箱下不执行：手机端无法做系统调用级限制，不能假装被限制住了
        sandbox?.checkShell(command)
        val dir = if (cwd == "." || cwd.isEmpty()) ws.root else ws.resolve(cwd, mustExist = true)
        if (!dir.isDirectory) throw KernelError("cwd 不是目录：$cwd")

        val pb = ProcessBuilder("/system/bin/sh", "-c", command)
            .directory(dir)
            .redirectErrorStream(true)
        pb.environment().apply {
            // 环境收敛：清掉宿主进程继承的变量，只留最小集合
            clear()
            put("HOME", dir.absolutePath)
            put("TMPDIR", dir.absolutePath)
            put("PATH", listOfNotNull(
                "/system/bin", "/system/xbin", "/vendor/bin", extraPathDir,
            ).joinToString(":"))
            if (!ldLibraryPath.isNullOrBlank()) put("LD_LIBRARY_PATH", ldLibraryPath)
        }
        val proc = pb.start()
        runCatching { onStart?.invoke(proc) }
        val output = StringBuilder()
        val reader = proc.inputStream.bufferedReader()
        // 边读边等：原来「先 waitFor 再读管道」会在输出超过管道缓冲（约 64KB）时死锁 ——
        // 子进程阻塞在 write，我们阻塞在 waitFor，20s 后误报超时并强杀。
        // cat 大文件、ls -R、gradle 这类命令全部中招。
        val deadline = System.currentTimeMillis() + timeoutMs
        var timedOut = false
        val buf = CharArray(8192)
        // 边读边往外吐一块：几十秒的命令在界面上不再只有一个计时器在转。上下文没挂
        // 回调（后台任务 / 桥直调 / 单测）时 emitOutput 自己空转，不影响任何调用方。
        val live = ToolExecContext.currentOrNone()
        while (true) {
            if (System.currentTimeMillis() > deadline) { timedOut = true; break }
            if (reader.ready()) {
                val n = reader.read(buf)
                if (n <= 0) break // 流结束 = 进程退出
                if (output.length < MAX_OUTPUT) {
                    output.append(buf, 0, n)
                    live.emitOutput(String(buf, 0, n))
                }
            } else if (!proc.isAlive) {
                // 进程已退出，把管道里残留的输出抽干
                while (reader.ready()) {
                    val n = reader.read(buf)
                    if (n <= 0) break
                    if (output.length < MAX_OUTPUT) {
                        output.append(buf, 0, n)
                        live.emitOutput(String(buf, 0, n))
                    }
                }
                break
            } else {
                Thread.sleep(25)
            }
        }
        if (timedOut) {
            killTree(proc)
            val partial = output.toString().trim().take(1500)
            throw KernelError(
                "命令超时（${timeoutMs / 1000}s）：$command" +
                    (if (partial.isNotBlank()) "\n超时前已产生的输出：\n$partial" else "") +
                    "\n长任务请用 run_in_background=true 改为后台执行，或调大 timeoutMs（上限 120s）"
            )
        }
        proc.waitFor(2, TimeUnit.SECONDS)
        val code = runCatching { proc.exitValue() }.getOrElse { -1 }
        val text = if (output.length > MAX_OUTPUT) {
            output.substring(0, MAX_OUTPUT) + "\n[输出超过 ${MAX_OUTPUT / 1024}KB，已截断]"
        } else output.toString()
        return "exit=$code\n$text".trimEnd()
    }

    /**
     * 终止整棵进程树。
     *
     * 只 `destroyForcibly()` 等于只杀 `/system/bin/sh`：`sh -c 'gradle build'` 里的
     * gradle、curl、sleep 会被 init 收养继续跑，占 CPU/电量/文件锁，用户以为任务停了。
     * 这里按 /proc/<pid>/stat 的 PPID 建树，从叶子往根 kill -9（先杀父会让子进程被
     * 重新收养，反而漏杀）。
     */
    fun killTree(proc: Process) {
        // Android 的 Process 没把 pid() 写进编译期 API，用反射取；取不到就退回只杀 sh
        val pid = pidOf(proc)
        if (pid != null) runCatching { killDescendants(pid) }
        runCatching { proc.destroyForcibly() }
    }

    private fun pidOf(proc: Process): Long? {
        runCatching { proc.javaClass.getMethod("pid").invoke(proc) as? Long }.getOrNull()?.let { return it }
        // 退化路径：部分实现只把 pid 放在 toString 里（Process[pid=1234, ...]）
        return Regex("pid[=:]\\s*(\\d+)").find(proc.toString())
            ?.groupValues?.getOrNull(1)?.toLongOrNull()
    }

    private fun killDescendants(rootPid: Long) {
        val children = HashMap<Long, MutableList<Long>>()
        File("/proc").listFiles()?.forEach { d ->
            val pid = d.name.toLongOrNull() ?: return@forEach
            val stat = runCatching { File(d, "stat").readText() }.getOrNull() ?: return@forEach
            // stat 格式：pid (comm) state ppid ...；comm 可能含空格与括号，取最后一个 ')'
            val idx = stat.lastIndexOf(')')
            if (idx < 0 || idx + 2 > stat.length) return@forEach
            val rest = stat.substring(idx + 2).trim().split(' ')
            val ppid = rest.getOrNull(1)?.toLongOrNull() ?: return@forEach
            children.getOrPut(ppid) { ArrayList() }.add(pid)
        }
        val queue = ArrayDeque<Long>()
        children[rootPid]?.let { queue.addAll(it) }
        val victims = ArrayList<Long>()
        while (queue.isNotEmpty()) {
            val p = queue.removeFirst()
            victims.add(p)
            children[p]?.let { queue.addAll(it) }
        }
        victims.asReversed().forEach { pid ->
            runCatching {
                ProcessBuilder("/system/bin/kill", "-9", pid.toString())
                    .redirectErrorStream(true).start().waitFor(1, TimeUnit.SECONDS)
            }
        }
    }
}
