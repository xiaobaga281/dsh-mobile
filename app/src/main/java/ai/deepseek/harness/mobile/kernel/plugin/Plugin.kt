package ai.deepseek.harness.mobile.kernel.plugin

import ai.deepseek.harness.mobile.kernel.Workspace
import org.json.JSONObject

/**
 * 内核插件模型 —— 桌面 Harness「一切皆插件」的手机端等价物。
 *
 * 桌面版用 Cordis 容器把每个能力（工具、命令、提示词段落）都做成插件，
 * 由 ctx 注入依赖、按需 load/unload。安卓端没有 Node 运行时，这里保留同样的
 * 形状：插件 = 元信息 + 0..n 个工具 + 生命周期回调 + 可展示状态；
 * 依赖通过 [PluginContext] 注入，而不是在工具里直接 new。
 */
/** 有「按轮计数」状态的插件实现它：每轮开始时重置，避免上一轮的限额吃到这一轮 */
interface TurnScopedPlugin {
    fun beginTurn()

    /**
     * 本轮真正结束了（模型停下、工具都回填完、结果已推给界面）。
     * 适合放「不该和主对话抢模型槽位」的收尾活：表情包补画面描述、异步整理等。
     * 默认空实现，不影响已有插件。
     */
    fun endTurn() {}
}

interface KernelPlugin {
    /** 稳定 id，用于启用/禁用与状态持久化 */
    val id: String
    val name: String
    val description: String
    val version: String get() = "1.0.0"

    /** 内置插件（随 APK 编译）还是外部清单插件（运行时可增删） */
    val builtin: Boolean get() = true

    /** 本插件贡献的工具；空表示纯能力插件（只挂事件/服务） */
    val tools: List<ToolSpec> get() = emptyList()

    /** 挂载：拿到 ctx 之后可以初始化状态、预热资源 */
    fun onLoad(ctx: PluginContext) {}

    /** 卸载：禁用或退出时释放资源 */
    fun onUnload() {}

    /** 设置页展示的附加信息（命令、命中次数等） */
    fun status(): Map<String, String> = emptyMap()

    /**
     * 贡献给系统提示的一段文本（对应桌面插件往 system-prompt waterfall 里加段落）。
     * 返回 null 表示本插件不参与提示装配。
     */
    fun promptSection(): String? = null
}

/**
 * 一次工具调用的执行上下文（桌面 `ToolExecContext` 的手机端等价物）。
 *
 * 由 [ai.deepseek.harness.mobile.agent.ToolPipeline] 在派发时构造，描述**这一次调用**的边界：
 * - [deadlineAt]：绝对截止时刻（epoch ms）；null = 未声明超时，不限时（跨模型的慢工具自己负责结束）
 * - [cancelled]：派发那一刻轮次已经被取消
 * - [sessionId]/[callId]：归属（spill 落点、日志与审批挂载点）
 * - [source]/[depth]：触发路径与嵌套深度 —— 程序化调用（ptc/plugin/bridge）可以据此走更严的策略
 *
 * 老插件只实现 `execute(args)` 也拿得到这份上下文：流水线在调用线程上挂
 * [ToolExecContext.current]，工具内部直接读即可，不必改签名。
 */
data class ToolExecContext(
    val cancelled: Boolean = false,
    val deadlineAt: Long? = null,
    val sessionId: String? = null,
    val callId: String? = null,
    /** 触发路径：native | ptc | plugin | bridge（同一份插件在不同路径上可以有不同策略） */
    val source: String = "native",
    /** 嵌套深度（PTC/插件互调会叠）：0 = 模型直接调用 */
    val depth: Int = 0,
    /**
     * 活体取消信号：工具在长等待里应周期性读取 [cancelledNow]，而不是只靠线程中断。
     * 流水线派发时传入；PTC/插件直调没有该信号时回落到 [cancelled] 快照。
     */
    val cancelSignal: (() -> Boolean)? = null,
    /**
     * 工具运行中的实时输出去处（长命令边跑边刷到界面）。没有 = 不流（后台任务、
     * 桥直调、单测里都是这条）。工具在读取循环里调 [emitOutput]，不必改签名。
     */
    val onOutput: ((String) -> Unit)? = null,
) {
    /** 剩余预算（ms）；未声明截止时刻返回 null（属性必须在类体里，不能写在主构造参数上） */
    val remainingMs: Long? get() = deadlineAt?.let { it - System.currentTimeMillis() }

    /** 吐一块实时输出：投递失败只当「没流出去」，绝不打断工具本体 */
    fun emitOutput(chunk: String) {
        if (chunk.isEmpty()) return
        runCatching { onOutput?.invoke(chunk) }
    }

    /** 预算已耗尽（工具可以据此提前收尾，而不是硬跑到被打断） */
    fun isExpired(now: Long = System.currentTimeMillis()): Boolean = deadlineAt != null && now >= deadlineAt

    /** 当前是否已被取消（优先读活体信号；长等待工具应在每轮等待片里检查） */
    fun cancelledNow(): Boolean = runCatching { cancelSignal?.invoke() ?: cancelled }.getOrDefault(cancelled)

    companion object {
        /** 「不在任何一次工具调用里」（插件自触发 / 定时任务 / 桥接直调） */
        val NONE = ToolExecContext()

        private val local = ThreadLocal<ToolExecContext?>()

        /** 当前线程正在执行的这次调用的上下文；不在工具调用中时为 null */
        fun current(): ToolExecContext? = local.get()

        /** 同上，但没有上下文时给一个「不限时、未取消」的默认值 */
        fun currentOrNone(): ToolExecContext = local.get() ?: ToolExecContext()

        /** 挂上上下文，返回上一个（供 finally 还原）—— 只为流水线内部使用 */
        fun attach(ctx: ToolExecContext): ToolExecContext? {
            val prev = local.get()
            local.set(ctx)
            return prev
        }

        /** 还原 [attach] 之前的上下文 */
        fun detach(prev: ToolExecContext?) {
            if (prev == null) local.remove() else local.set(prev)
        }
    }
}

/**
 * 一次工具调用的结果。
 *
 * [text] 是给模型看的正文（与旧 `execute` 的返回值一字不差）；
 * [exitCode] 是**旁路**元信息，只用于界面画徽标，绝不拼进正文 ——
 * 模型的输入是逐字读的，多一行 `exit=N` 就会改变它看到的东西。
 *
 * 目前只有前台命令类工具（bash / run / java / rustc / pkg / compile）会填，
 * 其余工具保持 null（界面就不画徽标）。
 */
data class ToolResult(val text: String, val exitCode: Int? = null)

/**
 * 从 `exit=N` 结果头取退出码 —— [ai.deepseek.harness.mobile.kernel.ShellTool] 与
 * [ai.deepseek.harness.mobile.kernel.KernelRuntime] 的前台输出统一是这个形状：
 * 首行 `exit=<code>`，其后是命令输出。不是这个形状（例如后台任务回的 JSON）就返回 null。
 */
fun exitCodeOfHeader(text: String): Int? {
    if (!text.startsWith("exit=")) return null
    return text.substring(5).lineSequence().first().trim().toIntOrNull()
}

/**
 * 去掉 exec 结果开头的 `exit=N` 头，只留命令自己的输出。
 * 后台任务把它存进输出环，会让 `job_output` 与通知卡出现两次 exit（一次来自头，
 * 一次来自任务状态），正文因此不再是「命令打印了什么」。退出码该由 [exitCodeOfHeader] 解析。
 */
fun stripExitHeader(text: String): String =
    if (!text.startsWith("exit=")) text else text.substringAfter('\n', "")

/**
 * 一个可被模型调用的工具。
 * [parameters] 是 JSON Schema 的 object 片段（type/properties/required），由插件自己给出。
 */
interface ToolSpec {
    val name: String
    val description: String
    val parameters: JSONObject

    /**
     * 并发语义 —— 与桌面 `ToolExecutionMode` 同名同义：
     * parallel 进滚动并发池，exclusive 单独成屏障（会等前面的全部结算完再开始）。
     * 只读工具声明 parallel，写类/有副作用的保持默认 exclusive。
     */
    val executionMode: ToolExecutionMode get() = ToolExecutionMode.EXCLUSIVE

    /**
     * 单次调用的墙钟预算（ms）；null = 未声明 → 不限时。
     *
     * 只在流水线里生效：派发时算出截止时刻，超时落一条
     * `TOOL_TIMEOUT` 结果并打断执行线程，**不会**让整批/整轮失败。
     * 声明它之前先想清楚：这是「本工具正常情况下最多要多久」，不是「我希望它多快」。
     */
    val timeoutMs: Long? get() = null

    /** 执行并返回给模型的文本；可预期失败抛 [ai.deepseek.harness.mobile.kernel.KernelError] */
    fun execute(args: JSONObject): String

    /**
     * 执行并带回结果元信息 —— 注册表派发的**唯一**入口。
     *
     * 默认包一层 [ToolResult]，所以既有工具一个都不用改；要带退出码的工具
     * （前台命令类）覆盖它，正文仍然由 [execute] 决定。
     *
     * 只保留这一个重载：曾经还有个两参 `execute(args, ctx)`，实际上没有一个工具覆盖过它，
     * 却让「该覆盖哪一个」变成陷阱 —— 覆盖错的那个会被默认实现静默绕过。
     * 需要截止时刻/取消位的工具读 [ToolExecContext.current]（流水线已挂在线程上）。
     */
    fun executeResult(args: JSONObject, ctx: ToolExecContext): ToolResult = ToolResult(execute(args))
}

/** 桌面 `ToolExecutionMode` 的手机端等价物。 */
enum class ToolExecutionMode { PARALLEL, EXCLUSIVE }

/**
 * 注入给插件的上下文（对应桌面 ctx 的极小集合）：
 * 工作区、插件配置、事件总线、跨插件服务查找、日志。
 */
interface PluginContext {
    val workspace: Workspace

    /** 进程沙箱（文件效果策略）；插件执行写操作前必须经过它 */
    val sandbox: ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox

    /**
     * 事件总线（对应桌面 `ctx.on`）。监听器 id 自动加 `<插件id>/` 前缀，
     * 卸载时由 registry 按前缀整体摘除，插件不用自己 off。
     *
     * 典型用法（一个纯能力插件，不贡献任何工具）：
     * ```
     * override fun onLoad(ctx: PluginContext) {
     *     ctx.hooks.onWaterfall<String>("system-prompt", "audit") { prompt, _ ->
     *         prompt + "\n<audit>每次写文件前先说明意图</audit>"
     *     }
     * }
     * ```
     */
    val hooks: PluginHooks get() = PluginHooks.disabled()

    /** 本插件自己的配置段落，来自 kernel/config.json 的 config.<id> */
    fun config(): JSONObject

    /** 按名字取别的插件注册的服务（没有返回 null） */
    fun service(name: String): Any?

    /**
     * 让注册表重建某个插件的工具索引（MCP 等「工具目录运行时会变」的插件用）。
     *
     * 目的只有一个：`schemas()`（模型看得见）与 `exec()`（真正能派发）必须是同一份索引。
     * 动态注册新工具后不刷新，模型看到 `mcp__server__new_tool` 却调用即 UNKNOWN_TOOL ——
     * 这是最难自查的一类失败：调用参数全对，错误却说工具不存在。
     *
     * 默认空实现：不关心动态工具目录的插件/上下文什么都不用做。
     * 返回索引里该插件的工具数（-1 = 没有这个插件）由实现方记录日志，接口保持 Unit 以免调用方依赖。
     */
    fun refreshTools(pluginId: String) {}

    /**
     * 注册一个跨插件服务（对应桌面 Cordis 的 `ctx.provide`）。
     *
     * 这条是「一切皆插件」成立的前提：以前团队、任务板、日程这些服务全在
     * ToolKernel 里硬编码 provideService，插件只是工具的外壳 —— 服务本身
     * 既不能被插件替换，也不能随插件禁用而消失。
     *
     * 约定：
     *   · 值非空 = 注册/覆盖；null = 注销
     *   · 插件卸载时 registry 按 owner 自动注销它注册过的服务，
     *     不会留下「插件已禁用、服务还在」的半死状态
     */
    fun provide(name: String, value: Any?) {}

    fun log(msg: String)
}
