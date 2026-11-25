package ai.deepseek.harness.mobile.kernel.plugin.builtin.fs

import ai.deepseek.harness.mobile.kernel.ShellTool
import ai.deepseek.harness.mobile.kernel.jobs.JobRegistry
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.exitCodeOfHeader
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickLong
import ai.deepseek.harness.mobile.kernel.plugin.stripExitHeader
import org.json.JSONObject

/**
 * 命令能力插件（桌面 ctx.shell 的适配）。
 *
 * 手机端没有 PTY，一次调用就是一条一次性命令：工作区为 cwd、20 秒超时、输出截断。
 * `run_in_background: true` 按桌面 `bash` 的语义注册到 job 运行时，立即返回 job id，
 * 之后用 job_output / job_kill 收集或终止——长任务因此不必卡住当前轮。
 */
class ShellPlugin : KernelPlugin {
    override val id = "shell"
    override val name = "命令"
    override val description = "在工作区执行一次性 shell 命令（无交互、20 秒超时、可后台）"
    override val version = "1.0.0"

    private var shell: ShellTool? = null
    private var calls = 0
    private var ctxRef: PluginContext? = null

    override fun onLoad(ctx: PluginContext) {
        ctxRef = ctx
        // busybox 装配（bin/lib 符号链接目录）→ bash 的 PATH/LD_LIBRARY_PATH 挂上：
        // bash 里直接 `busybox <applet>`，注入运行时随装随用
        val app = ctx.service("app.context") as? android.content.Context
        val bb = app?.let { ai.deepseek.harness.mobile.kernel.KernelRuntime.ensureBusyboxEnv(it) }
        val nativeDir = app?.applicationInfo?.nativeLibraryDir
        val extraPath = listOfNotNull(bb?.binPath, nativeDir).joinToString(":")
        shell = ShellTool(ctx.workspace, ctx.sandbox, extraPath.ifBlank { null }, bb?.libPath)
        // 重跑入口：桥按 Mission 账本里的 spec 调回来，owner 由调用方给（那时没有 agent 回合）
        ctx.provide("job.exec", { a: JSONObject ->
            startBackground(
                a.optString("command"),
                a.optString("workdir").ifBlank { "." },
                a.optString("description"),
                a.optString("sessionId"),
            )
        })
    }

    override fun onUnload() {
        shell = null
        ctxRef = null
    }

    override fun status(): Map<String, String> = mapOf(
        "调用次数" to calls.toString(),
        "超时" to "${ShellTool.TIMEOUT_MS / 1000}s",
    )

    private val impl: ShellTool get() = shell ?: error("命令插件未加载")

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "bash",
            description = "在手机本地执行一条 shell 命令（工作区为当前目录，20 秒超时，无交互）。" +
                "适合列目录、编译脚本、跑测试。run_in_background=true 时立即返回 job id，" +
                "再用 job_output 收集输出、job_kill 终止。",
            parameters = Schemas.params(
                mapOf(
                    "description" to Schemas.prop("string", "一句话说明这条命令做什么（5-10 个字，显示在界面上）"),
                    "command" to Schemas.prop("string", "要执行的命令"),
                    "workdir" to Schemas.prop("string", "工作目录，默认工作区根"),
                    "timeoutMs" to Schemas.prop("number", "超时毫秒数，默认 20000，最大 120000"),
                    "run_in_background" to Schemas.prop("boolean", "后台执行，立即返回 job id"),
                ),
                listOf("description", "command"),
            ),
            exitHeader = true,
        ) { a ->
            calls++
            val cmd = a.getString("command")
            val cwd = a.pick("workdir", "cwd").ifBlank { "." }
            val timeout = a.pickLong("timeoutMs", default = 20_000L).coerceIn(1_000L, 120_000L)
            if (a.optBoolean("run_in_background")) {
                startBackground(cmd, cwd, a.pick("description"), "").toString()
            } else {
                impl.exec(cmd, cwd, timeout)
            }
        },
    )

    /**
     * 起一个后台 job。命令/工作目录/说明都塞进 spec，随 [JobRegistry.Job.spec] 落到 Mission 账本 ——
     * 进程重启后闭包早没了，只有参数文本留得下来，「重新跑一次」才有依据。
     *
     * 同时作为 `job.exec` 服务暴露给桥：重跑复用这一份执行能力，不在别处再拼一遍 exec 调用。
     */
    private fun startBackground(cmd: String, cwd: String, label: String, owner: String): JSONObject {
        val reg = jobRegistry()
            ?: throw ai.deepseek.harness.mobile.kernel.KernelError("后台任务服务未装配，无法后台执行；请去掉 run_in_background")
        val name = label.ifBlank { cmd.take(40) }
        val spec = JSONObject().put("tool", "bash").put("command", cmd).put("workdir", cwd)
        val job = reg.start(name, owner, spec) { j ->
            // 后台不该套用前台的 20s 墙钟：按提示「长任务用 run_in_background」的用户
            // 会看到任务在 20 秒后被强杀。后台给足 6 小时，终止交给 job_kill。
            val out = impl.exec(cmd, cwd, 6 * 3_600_000L, onStart = { p ->
                // 让 job_kill 能杀整棵进程树，而不是只杀 sh 留一堆孙进程
                j.cancel = { impl.killTree(p) }
            })
            j.append(stripExitHeader(out))
            // 从 exec 的 "exit=N" 头解析真实退出码；原来靠匹配「超时」二字，
            // 命令输出里出现「超时」就会被误判成 124
            exitCodeOfHeader(out) ?: -1
        }
        return JSONObject().put("job_id", job.id).put("name", job.name)
            .put("note", "后台运行中；用 job_output 收集、job_kill 终止")
    }

    private fun jobRegistry(): JobRegistry? = ctxRef?.service("job.registry") as? JobRegistry
}
