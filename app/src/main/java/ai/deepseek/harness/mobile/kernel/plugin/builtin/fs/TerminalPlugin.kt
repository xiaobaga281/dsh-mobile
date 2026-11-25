package ai.deepseek.harness.mobile.kernel.plugin.builtin.fs

import ai.deepseek.harness.mobile.agent.PromptAssembler
import ai.deepseek.harness.mobile.agent.SessionStore
import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.KernelRuntime
import ai.deepseek.harness.mobile.kernel.jobs.JobRegistry
import ai.deepseek.harness.mobile.kernel.mission.WakeRouter
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.terminal.TerminalRegistry
import org.json.JSONArray
import org.json.JSONObject

/**
 * 终端与后台任务 —— 对应桌面 `@deepseek-ai/dsh-tool-terminal`（6 个终端工具）
 * 与 `@deepseek-ai/dsh-tool-jobs`（job_list / job_output / job_kill）。
 *
 * 桌面用 PTY 后端 + 通用 jobs 运行时；手机端分别是：
 *   - [TerminalRegistry]：常驻 `sh` 子进程（stdin/stdout 管道），保留会话状态
 *   - [JobRegistry]：线程池 + 有界输出缓冲
 * 两个服务都由 ToolKernel 注入，插件本身不持有进程与线程。
 *
 * 按桌面语义，`terminal_send(run_in_background: true)` 立即返回 job id，
 * 再由 job_output / job_kill 收集或终止。
 */
class TerminalPlugin : KernelPlugin {
    override val id = "terminal"
    override val name = "终端与后台任务"
    override val description = "持久 shell 会话（terminal_*）与后台任务（job_*）"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        wireJobJournal(ctx)
        wireJobInbox(ctx)
        wireSandboxGuard(ctx)
        wireGuestBackend(ctx)
    }

    /**
     * 统一唤醒队列 → agent 上下文。
     *
     * job 完成 / 定时到点都进 [WakeRouter]；忙碌的 agent 在下一步收到注入，
     * 空闲的由前端认领（同一队列，谁先拿到谁负责，不会重复）。
     * `defer` 策略的唤醒不参与自动注入。
     */
    private fun wireJobInbox(ctx: PluginContext) {
        val wakes = ctx.service("wake.router") as? WakeRouter ?: return
        val sessions = ctx.service("session.store") as? SessionStore ?: return
        val missions = ctx.service("mission.registry") as? ai.deepseek.harness.mobile.kernel.mission.MissionRegistry
        ctx.hooks.onWaterfall<PromptAssembler.Section>("agent/pre-step", "job-inbox") { _, hc ->
            val sid = hc.str("session").orEmpty()
            if (sid.isNotBlank()) {
                val records = runCatching { wakes.drainForAgent(sid) }.getOrDefault(emptyList())
                if (records.isNotEmpty()) {
                    @Suppress("UNCHECKED_CAST")
                    val messages = hc.any("messages") as? MutableList<JSONObject>
                    for (rec in records) {
                        val text = rec.optString("text")
                        messages?.add(JSONObject().put("role", "user").put("content", text))
                        runCatching {
                            sessions.append(sid, "wake/notice", JSONObject().apply {
                                put("text", text)
                                put("wakeId", rec.optString("id"))
                                rec.optString("missionId").let { if (it.isNotBlank()) put("missionId", it) }
                            })
                        }
                        // 忙时注入的唤醒也要落在那件事的账上：回看时能看出「这一步是谁推进的」
                        val mid = rec.optString("missionId")
                        if (missions != null && mid.isNotBlank()) {
                            runCatching {
                                missions.appendEvidence(
                                    mid,
                                    JSONObject().put("type", "wake").put("ref", rec.optString("id"))
                                        .put("title", "忙碌时注入到本轮")
                                        .put("at", System.currentTimeMillis()),
                                )
                            }
                        }
                    }
                    ctx.log("wake inbox: 认领 ${records.size} 条唤醒（$sid）")
                }
            }
            null
        }
    }

    /**
     * 把 `workspace` 后端接上 rootfs 里的 `sh`。
     *
     * 这是终端域最关键的一次修正：旧实现的会话**只有**安卓宿主 `/system/bin/sh`，
     * 于是 `java/python3/gcc/node` 全部不可见（实测 `which java python3 git gcc` 四个全空），
     * 而工具描述却写着「持久 shell 会话」。模型照着「这是台能跑代码的机器」写命令，
     * 必然失败 —— 这不是能力不足，是**口径错**，也是覆盖/质量两维一直被压到 6.x 的根因。
     *
     * 对齐桌面：`packages/terminal` 的会话就在项目工作环境里跑（有 node/python 等），
     * 不是跑在宿主裸机上。这里用同一个 rootfs（`java/python3/gcc/node/keytool` 都在），
     * 路径语义 `/workspace/…` 与 `bash` 工具完全一致。
     */
    private fun wireGuestBackend(ctx: PluginContext) {
        val registry = ctx.service("terminal.registry") as? TerminalRegistry ?: return
        val rt = ctx.service("runtime.kernel") as? KernelRuntime ?: run {
            ctx.log("终端 workspace 后端不可用：RuntimePlugin 未加载（只剩 device 后端）")
            return
        }
        registry.setGuestLauncher { cwd ->
            // 宿主路径 → guest 路径：工作区之下映射成 /workspace/…，保持与 bash 工具同一套路径
            val rel = runCatching { cwd.relativeTo(ctx.workspace.root).invariantSeparatorsPath }
                .getOrDefault("")
            val guestCwd = if (rel.isBlank() || rel == ".") "/workspace" else "/workspace/$rel"
            val proc = rt.openGuest("/bin/sh", guestCwd = guestCwd)
            TerminalRegistry.Launch(proc, guestCwd, "workspace")
        }
    }

    override fun onUnload() { ctx = null }

    /**
     * 常驻终端也是「本层无法做系统调用级限制」的执行体，read-only 下必须拒绝
     * （桌面同一条规矩：partial 的执行完整性不得被当成 full 用）。
     * 闸门放在 TerminalRegistry.open() 里，注入的是当前上下文的 sandbox。
     */
    private fun wireSandboxGuard(ctx: PluginContext) {
        runCatching {
            val registry = ctx.service("terminal.registry") as? TerminalRegistry ?: return
            registry.setExecutionGuard { what -> ctx.sandbox.checkExecutionSurface(what) }
        }.onFailure {
            ctx.log("终端沙箱闸门未接上：${it.message}（read-only 下仍会由 bash 工具侧兜底）")
        }
    }

    /**
     * 后台任务的生命周期记账接上会话日志（桌面 `job/registered` + `job/settled`）。
     *
     * 用内核提供的唯一 `session.store` 实例，而不是自己 new 一个 SessionStore ——
     * 两个实例各持一把按会话写锁，并发写同一个 .jsonl 会把一行 JSON 撕成两半。
     *
     * owner 兜底取 `agent.session`：`bash run_in_background` 等调用点目前不传归属，
     * 在 start() 那一刻取当前会话即可正确归属（后台线程稍后再取就会串会话）。
     */
    private fun wireJobJournal(ctx: PluginContext) {
        val reg = ctx.service("job.registry") as? JobRegistry ?: return
        if (reg.hasJournal()) return
        val sessions = ctx.service("session.store")
            as? ai.deepseek.harness.mobile.agent.SessionStore ?: return
        reg.attachJournal(
            sink = { owner, type, payload -> sessions.appendOrThrow(owner, type, payload) },
            owner = { ctx.service("agent.session") as? String ?: "" },
        )
    }

    private fun terms(): TerminalRegistry =
        ctx?.service("terminal.registry") as? TerminalRegistry ?: throw KernelError("终端服务未装配")

    /**
     * 前台发送：等到命令**真正结束**再返回（结束标记由 shell 自己打印）。
     *
     * 与旧实现的差别不只是更快，而是**判据换了**：
     *   - 以前：输出静默 700ms → 猜「大概结束了」。`sleep 5 && echo done` 会被提前判成
     *     已结束（把空输出交给模型），慢速吐字的命令又会被判成还在跑。
     *   - 现在：看到 `__DSH_END_<token>_<code>__` → 命令确实退出，`exit_code` 由 shell 给出。
     * 于是「非 0 退出」第一次能被如实告诉模型 —— 以前失败和成功一样只回一段文本。
     */
    private fun sendForeground(
        s: ai.deepseek.harness.mobile.kernel.terminal.TerminalRegistry.Session,
        text: String,
        submit: Boolean,
    ): String {
        val r = terms().submitAndWait(s, text, submit, WAIT_MS)
        if (!r.optBoolean("ok")) return r.toString()
        val out = r.optString("output")
        val next = r.optInt("next_offset")
        return when (r.optString("reason")) {
            "exited" -> {
                val code = r.optInt("exit_code", 0)
                when {
                    out.isBlank() && code == 0 -> "已执行（无输出，退出码 0）"
                    out.isBlank() -> "命令以退出码 $code 结束（没有输出）"
                    code == 0 -> out
                    else -> "$out\n\n（退出码 $code，非 0 通常意味着失败：先看上面的报错，不要盲重试）"
                }
            }
            "sent" -> if (out.isBlank()) "已写入（未提交回车）" else out
            "session_exit" -> (if (out.isBlank()) "" else "$out\n\n") + "（会话已结束，需要重新 terminal_open）"
            else ->
                // 到这里是 timeout：**还没出现结束标记**，说明命令仍在跑（这是证据，不是猜测）
                if (out.isBlank())
                    "已发送（约 ${WAIT_MS / 1000}s 内未出现结束标记，命令仍在运行）。" +
                        "续读 terminal_read(sessionId=\"${s.id}\", offset=$next)"
                else
                    "$out\n\n（命令仍在运行，以上是增量输出；续读 terminal_read(offset=$next)，或用 terminal_signal 中断）"
        }
    }

    private fun jobs(): JobRegistry =
        ctx?.service("job.registry") as? JobRegistry ?: throw KernelError("后台任务服务未装配")

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    companion object {
        /**
         * 前台 send 的等待上限。
         *
         * 从 8s 放宽到 20s：判据换成结束标记后，命令一退出就立即返回，放宽上限**不会**
         * 让快命令变慢，只会减少「明明 9 秒就好、却被 8s 截断要求续读」的往返。
         * 真长跑的命令仍然 20s 截断并给出续读偏移，语义没变。
         */
        const val WAIT_MS = 20_000L
    }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "terminal_open"
            override val description = "打开一个持久终端会话（状态跨命令保留：cd、变量都有效）。返回 sessionId。" +
                "backend=workspace（默认）在完整 rootfs 里执行，java/python3/gcc/node 都可用，路径与 bash 工具一致；" +
                "backend=device 是安卓宿主 shell，能碰 /sdcard、pm、am，但没有语言运行时。"
            override val parameters = schema(
                JSONObject()
                    .put("type", JSONObject().put("type", "string").put("description", "终端类型，手机端固定为 shell"))
                    .put("backend", JSONObject().put("type", "string")
                        .put("description", "workspace（默认，rootfs 完整环境）｜device（安卓宿主 shell）"))
                    .put("name", JSONObject().put("type", "string").put("description", "可选显示名，如 main"))
                    .put("cwd", JSONObject().put("type", "string").put("description", "初始工作目录（相对工作区）")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String {
                val cwd = if (args.optString("cwd").isBlank()) ctx!!.workspace.root
                else ctx!!.sandbox.checkWrite(args.optString("cwd")).also { if (!it.exists()) it.mkdirs() }
                val backend = if (args.has("backend")) args.optString("backend") else "workspace"
                val s = terms().open(cwd, args.optString("name"), args.optString("type", "shell"), backend)
                return JSONObject().put("sessionId", s.id).put("name", s.name)
                    .put("backend", s.backend).put("cwd", s.cwd)
                    .put(
                        "runtimes",
                        if (s.backend == "workspace")
                            "java / python3 / gcc / node / keytool / git 可用；路径语义与 bash 工具一致（/workspace/…）。" +
                                "缺 make / javac（javac 用构建链里的 ecj 替代）"
                        else "安卓宿主 shell：可访问 /sdcard、pm、am、settings，但没有语言运行时",
                    )
                    .put("note", "无 PTY：全屏 TUI 与 SIGINT 不可用；每条命令以结束标记判定，返回 exit_code")
                    .toString()
            }
        },
        object : ToolSpec {
            override val name = "terminal_list"
            override val description = "列出当前所有终端会话及其最近输出尾部。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String = terms().list().toString()
        },
        object : ToolSpec {
            override val name = "terminal_send"
            override val description = "向终端写入文本。submit 默认 true（自动回车）。run_in_background 为 true 时立即返回 job id。" +
                "同一会话同时只允许一个未结算的发送（SEND_ACTIVE），并发第二发会返回结构化错误。"
            override val parameters = schema(
                JSONObject()
                    .put("sessionId", JSONObject().put("type", "string"))
                    .put("text", JSONObject().put("type", "string"))
                    .put("submit", JSONObject().put("type", "boolean").put("description", "默认 true，自动补回车"))
                    .put("run_in_background", JSONObject().put("type", "boolean").put("description", "后台执行，立即返回 job id"))
                    .put("bg_timeout_ms", JSONObject().put("type", "number")
                        .put("description", "后台收集输出的等待上限毫秒，默认 60000，上限 600000")),
                listOf("sessionId", "text"),
            )
            override fun execute(args: JSONObject): String {
                val s = terms().get(args.optString("sessionId")) ?: throw KernelError("没有这个终端会话：${args.optString("sessionId")}")
                val text = args.optString("text")
                val submit = if (args.has("submit")) args.optBoolean("submit") else true
                if (args.optBoolean("run_in_background")) {
                    val bgTimeout = args.optLong("bg_timeout_ms", 60_000L).coerceIn(5_000L, 600_000L)
                    val before = s.length()
                    val job = jobs().start("terminal ${s.id}") { j ->
                        // 整个收集期占住单活跃护栏：收集期间另一个 send 会得到 SEND_ACTIVE，
                        // 而不是和后台 job 交叉写 stdin
                        if (!s.sending.compareAndSet(false, true)) {
                            j.append("（SEND_ACTIVE：该会话有另一个未结算的发送，本次未写入 stdin）")
                            return@start 1
                        }
                        try {
                            // 后台任务同样用结束标记判定，而不是「静默 700ms」：
                            // 前者是证据（命令真退出了），后者在慢输出/静默等待的场景下必然判错。
                            val r = terms().submitAndWait(s, text, submit, bgTimeout)
                            val out = r.optString("output")
                            j.append(out)
                            if (r.optString("reason") == "exited") {
                                val code = r.optInt("exit_code", 0)
                                if (code != 0) j.append("\n（退出码 $code）")
                                code
                            } else {
                                j.append("\n（到 ${bgTimeout / 1000}s 仍未结束，进程可能还在跑）")
                                0
                            }
                        } finally {
                            s.sending.set(false)
                        }
                    }
                    return JSONObject().put("job_id", job.id).put("sessionId", s.id).toString()
                }
                return sendForeground(s, text, submit)
            }
        },
        object : ToolSpec {
            override val name = "terminal_read"
            override val description = "读取终端输出。offset 为字符偏移，count 为读取长度（0 表示到末尾）。"
            override val parameters = schema(
                JSONObject()
                    .put("sessionId", JSONObject().put("type", "string"))
                    .put("offset", JSONObject().put("type", "number").put("description", "起始字符偏移，默认 0"))
                    .put("count", JSONObject().put("type", "number").put("description", "读取长度，默认全部")),
                listOf("sessionId"),
            )
            override fun execute(args: JSONObject): String {
                val s = terms().get(args.optString("sessionId")) ?: throw KernelError("没有这个终端会话：${args.optString("sessionId")}")
                val off = args.optInt("offset", 0)
                val cnt = args.optInt("count", 0)
                val body = s.slice(off, cnt)
                // 环形缓冲会把最早的输出裁掉，此时 offset 已经对不上原始位置：
                // 不明说就会把「别处的文本」当成命令结果交给模型
                val warn = if (s.truncatedBefore(off))
                    "（注意：offset=$off 之前的历史输出已被缓冲区丢弃，以下从现存最早处开始）\n" else ""
                return warn + if (body.isBlank()) "（该位置之后没有输出）" else body
            }
        },
        object : ToolSpec {
            override val name = "terminal_signal"
            override val description = "向终端投递信号：SIGINT / SIGTERM / SIGKILL。安卓无 PTY，SIGTSTP/SIGHUP 不可投递，会返回说明。"
            override val parameters = schema(
                JSONObject()
                    .put("sessionId", JSONObject().put("type", "string"))
                    .put("signal", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGHUP")))),
                listOf("sessionId", "signal"),
            )
            override fun execute(args: JSONObject): String {
                val s = terms().get(args.optString("sessionId")) ?: throw KernelError("没有这个终端会话：${args.optString("sessionId")}")
                val sig = args.optString("signal")
                val note = terms().signal(s, sig)
                if (note != null) return note
                return when (sig) {
                    // Android 上没有 PTY，管道 shell 收到的 0x03 只会被当成普通输入 ——
                    // 假装「已投递」是假成功，模型会以为中断生效然后干等。
                    "SIGINT" -> "⚠️ SIGINT 在管道 shell 上无法真正投递（无 PTY）。要中断当前命令请用 SIGTERM 或 SIGKILL，"
                    "SIGTSTP", "SIGHUP" -> "⚠️ $sig 在安卓管道 shell 上不可投递"
                    else -> "已投递 $sig"
                }
            }
        },
        object : ToolSpec {
            override val name = "terminal_close"
            override val description = "关闭终端会话并释放进程。"
            override val parameters = schema(
                JSONObject().put("sessionId", JSONObject().put("type", "string")),
                listOf("sessionId"),
            )
            override fun execute(args: JSONObject): String {
                val s = terms().get(args.optString("sessionId")) ?: throw KernelError("没有这个终端会话：${args.optString("sessionId")}")
                terms().close(s)
                return "已关闭 ${s.id}"
            }
        },
        object : ToolSpec {
            override val name = "job_list"
            override val description = "列出后台任务（状态、退出码、已保留输出大小、下次读取偏移）。" +
                "status=orphaned 表示进程在它结算前被终止过（没有结束时间不是遗漏，是真没有结算记录）。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String = JSONObject().apply {
                put("ok", true)
                put("jobs", jobs().list())
                put("limit_per_owner", JobRegistry.MAX_JOBS_PER_OWNER)
                put("lifecycle_journal", jobs().hasJournal())
                if (!jobs().hasJournal()) {
                    put(
                        "note",
                        "生命周期记账未接线：进程被杀后无法追溯这些任务曾经存在过",
                    )
                }
            }.toString()
        },
        object : ToolSpec {
            override val name = "job_output"
            override val description = "读取后台任务输出。支持 offset 增量读取：" +
                "把上一次返回的 next_offset 传回来，只拿新增部分（桌面 readAt 语义）。" +
                "省略 offset 时从该任务未被消费的游标开始（桌面 read 语义）。" +
                "wait=true 时阻塞到结束或超时（超时任务继续运行，不会被杀）。"
            override val parameters = schema(
                JSONObject()
                    .put("job_id", JSONObject().put("type", "string"))
                    .put(
                        "offset",
                        JSONObject().put("type", "number")
                            .put("description", "从哪个字符偏移开始读；省略则从上次消耗位置继续"),
                    )
                    .put("wait", JSONObject().put("type", "boolean").put("description", "是否等待结束"))
                    .put("timeout_ms", JSONObject().put("type", "number").put("description", "等待上限，默认 30000，上限 600000")),
                listOf("job_id"),
            )
            override fun execute(args: JSONObject): String {
                val id = args.optString("job_id")
                val job = if (args.optBoolean("wait")) {
                    jobs().await(id, args.optLong("timeout_ms", 30_000))
                        ?: throw KernelError("没有这个后台任务：$id")
                } else {
                    jobs().get(id) ?: throw KernelError("没有这个后台任务：$id")
                }
                // 没给 offset 就从游标继续（消耗式读），给了就按绝对偏移读（非消耗）
                val from = if (args.has("offset")) args.optInt("offset", 0) else job.cursor
                val read = job.readAt(from)
                return JSONObject().apply {
                    put("job_id", job.id)
                    put("name", job.name)
                    put("status", job.status)
                    put("exit_code", job.exitCode ?: JSONObject.NULL)
                    put("output", read.text)
                    put("offset", read.from)
                    put("next_offset", read.next)
                    put("lossy", read.lossy)
                    put("chars", read.text.length)
                    put("retained_chars", job.retainedChars())
                    if (read.lossy) {
                        put(
                            "warning",
                            "offset 之前的输出已被环形缓冲丢弃，只能从现存最早处给出；" +
                                "长任务请及时用 next_offset 增量读取。",
                        )
                    }
                    if (job.status == "running") {
                        put(
                            "note",
                            "任务仍在运行；用 next_offset 继续读增量，或 wait=true 等它结束" +
                                "（超时不会杀任务）。",
                        )
                    }
                }.toString()
            }
        },
        object : ToolSpec {
            override val name = "job_kill"
            override val description = "终止后台任务。"
            override val parameters = schema(
                JSONObject()
                    .put("job_id", JSONObject().put("type", "string"))
                    .put("reason", JSONObject().put("type", "string").put("description", "可选原因")),
                listOf("job_id"),
            )
            override fun execute(args: JSONObject): String {
                val id = args.optString("job_id")
                // 模型自己发起的终止：不需要再收到「已完成」通知
                val ok = jobs().kill(id, byModel = true)
                return if (ok) "已终止 $id${args.optString("reason").let { if (it.isBlank()) "" else "（$it）" }}"
                else "任务 $id 不存在或已结束"
            }
        },
    )

    override fun status(): Map<String, String> = mapOf(
        "终端" to "${terms().list().length()} 个会话",
        "后台任务" to "${jobs().list().length()} 个",
    )
}
