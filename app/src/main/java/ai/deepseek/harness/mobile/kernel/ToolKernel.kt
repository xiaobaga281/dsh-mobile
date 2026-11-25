package ai.deepseek.harness.mobile.kernel

import ai.deepseek.harness.mobile.agent.AgentDriver
import ai.deepseek.harness.mobile.agent.HookBus
import ai.deepseek.harness.mobile.agent.PromptAssembler
import ai.deepseek.harness.mobile.agent.SkillStore
import ai.deepseek.harness.mobile.agent.SessionStore
import ai.deepseek.harness.mobile.agent.TodoStore
import ai.deepseek.harness.mobile.agent.ToolPipeline
import ai.deepseek.harness.mobile.kernel.plugin.ExternalPluginLoader
import ai.deepseek.harness.mobile.kernel.plugin.builtin.device.CompanionEngine
import ai.deepseek.harness.mobile.kernel.plugin.builtin.device.CompanionKeepService
import ai.deepseek.harness.mobile.kernel.plugin.builtin.device.CompanionPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.PluginDiscovery
import ai.deepseek.harness.mobile.kernel.plugin.PluginHooks
import ai.deepseek.harness.mobile.kernel.plugin.PluginRegistry
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 手机端内核门面。
 *
 * 桌面 Harness 用 Cordis 容器：插件各自注册工具与服务，容器负责装配。
 * 这里把同样的形状压到 Android 上——[registry] 是容器，内置插件随 APK 编译，
 * 外部清单插件从 `kernel/plugins/<id>.json` 热加载。
 *
 * 内核本体的构成（与桌面一一对应）：
 *   registry   插件与工具目录
 *   hooks      事件瀑布（system-prompt / tools/pre-execute / agent/pre-step …）
 *   sessions   会话事件日志（session/event）
 *   todos      会话待办（todo）
 *   driver     Agent 轮次驱动（agent + driver）
 * 门面只做装配，删掉任何一层都不影响其它层的编译契约。
 */
class ToolKernel(rootDir: File, private val appContext: android.content.Context? = null) {

    val workspace = Workspace(rootDir)

    /** 进程沙箱：文件效果策略（read-only / workspace-write），由每轮权限档位派生 */
    val sandbox = WorkspaceSandbox(workspace)

    /**
     * 工具执行池：**内核单例 daemon**，所有 driver（主 Agent / 子代理 / 团队运行时）共用一份。
     *
     * 以前每个 ToolPipeline 构造时各自 `newFixedThreadPool(4)` 且从不 shutdown：
     * 每轮新建一次驱动就多 4 个非 daemon 线程，长会话/多子代理下线程数只增不减，
     * 而且这些线程还会拖住进程退出。池上移到内核后，池的生命周期和进程一致。
     */
    val toolPool: java.util.concurrent.ExecutorService =
        ToolPipeline.newDaemonPool("dsh-tool", ToolPipeline.PARALLEL_WIDTH)

    /** 插件配置与启停状态存放在 files/kernel，不放进模型可见的工作区 */
    private val configDir = File(rootDir.parentFile ?: rootDir, "kernel")

    /**
     * 账号登录态（DeepSeek 平台额度）。等价桌面 `ctx.get('deepseekAccount')`：
     * 模型请求需要凭据时按目标来源现取，换号/退登立即生效，不写进任何配置文件。
     */
    var account: ai.deepseek.harness.mobile.account.DeepSeekAuth? = null
        private set

    /**
     * 委派限制（最大递归深度 / 并行上限）。
     *
     * 存在内核而不是团队插件里：`subagent` 工具不属于团队，团队插件被禁用时
     * 用户仍然应该能按同一份设置派子代理。值的**编辑器**目前挂在团队设置页
     * （那是唯一有设置面板的地方），运行时的读取方在内核。
     *
     * ⚠️ 必须声明在**插件注册之前**：Kotlin 按声明顺序执行属性初始化器与 init 块，
     * 而插件是在下面的 init 里加载的 —— 它 onLoad 时写进来的值会被后面才执行的
     * 属性初始化器 `= SubagentLimits()` 覆盖成默认值（表现为「设置里的深度重启后又变回 1」）。
     */
    @Volatile
    var subagentLimits: ai.deepseek.harness.mobile.kernel.agents.SubagentLimits =
        ai.deepseek.harness.mobile.kernel.agents.SubagentLimits()
        private set

    fun setSubagentLimits(limits: ai.deepseek.harness.mobile.kernel.agents.SubagentLimits) {
        subagentLimits = limits.normalized()
    }

    /** 跨插件服务表（对应桌面 ctx.services），必须在 registry 之前初始化 */
    private val services = mutableMapOf<String, Any>()

    /** 事件瀑布总线：内核所有可扩展点都挂在这里 */
    val hooks = HookBus { android.util.Log.d("DSHKernel", it) }

    val registry = PluginRegistry(
        object : PluginContext {
            override val workspace: Workspace get() = this@ToolKernel.workspace
            override val sandbox: WorkspaceSandbox get() = this@ToolKernel.sandbox
            override val hooks: PluginHooks get() = PluginHooks(this@ToolKernel.hooks, "kernel")
            override fun config(): JSONObject = readConfig()
            override fun service(name: String): Any? = services[name]
            override fun provide(name: String, value: Any?) = provideService(name, value)
            // refreshTools 不在这里实现：这是 `val registry = PluginRegistry(object : PluginContext { … })`
            // 的自引用初始化器，在对象内部调 registry.refreshTools(...) 会让 registry 的类型推断成环
            // （Kotlin 报 unresolved reference 'refreshTools'）。插件拿到的派生上下文由
            // PluginRegistry.contextFor() 直接转发 this@PluginRegistry.refreshTools(pluginId)，
            // 所以 ctx.refreshTools(id) 在插件侧照常生效；这里保留接口默认空实现即可。
            override fun log(msg: String) {
                android.util.Log.d("DSHKernel", msg)
            }
        },
        configDir,
        hooks,
    )

    /** 会话事件日志与待办：不进工作区，模型看不到 */
    val sessions = SessionStore(File(configDir, "sessions"))
    val todos = TodoStore(File(configDir, "todo"))

    /** 技能目录：files/kernel/skills 与 workspace/skills（桌面 skill-filesystem 的手机端等价） */
    val skills = SkillStore(File(configDir, "skills"), File(workspace.root, "skills"))

    /**
     * Mission Ledger：jobs / schedules 的统一事实源。
     * 对话卡、进行中带、任务页都从这里读；Step 2 的 Wake Router 也只消费这里的迁移。
     * 必须声明在 jobs / schedule 之前：后两者的回调在运行期访问它。
     */
    val missions = ai.deepseek.harness.mobile.kernel.mission.MissionRegistry(
        File(configDir, "missions.json"),
        log = { android.util.Log.d("DSHKernel", it) },
    )

    /**
     * 统一唤醒队列：job 完成 / 定时到点都进这里。
     * 前端空闲时认领；agent pre-step 在忙碌轮次里认领；谁先拿到谁负责。
     */
    val wakes = ai.deepseek.harness.mobile.kernel.mission.WakeRouter(
        File(configDir, "wakes.json"),
        log = { android.util.Log.d("DSHKernel", it) },
    )

    /** 后台任务（桌面 ctx.jobs）：完成时 emit job_done，前端据此提示用户 */
    val jobs = ai.deepseek.harness.mobile.kernel.jobs.JobRegistry(
        log = { android.util.Log.d("DSHKernel", it) },
        onDone = { job ->
            // 先写账本再发事件：前端收到 job_done 时，Mission 状态必须已经是 settled
            runCatching {
                missions.onJobSettled(
                    job.id, job.name, job.owner, job.status,
                    job.startedAt, job.endedAt,
                    (job.retainedChars() + job.droppedChars()).toLong(),
                )
            }
            // 撤掉这个任务占的保活位（同会话还有别的任务/回合在跑时不会真的停服务）
            if (job.owner.isNotBlank()) {
                appContext?.let { c ->
                    runCatching { ai.deepseek.harness.mobile.notify.RunService.end(c, job.owner) }
                }
            }
            if (!job.awaited && !job.killRequested && job.owner.isNotBlank()) {
                val wake = runCatching {
                    wakes.enqueueJob(job.id, job.name, job.owner, job.completionNotice)
                }.getOrNull()
                // WebView 不在（或 App 在后台）：系统通知把用户叫回来；记录留在队列里，回 App 还能补
                if (wake != null && shouldNotify()) {
                    appContext?.let { c ->
                        ai.deepseek.harness.mobile.notify.RunService.remind(
                            c,
                            "后台任务完成 · " + job.name,
                            "点开继续：" + job.completionNotice.take(160),
                        )
                    }
                    runCatching { wakes.markNotified(wake.optString("id")) }
                }
            }
            eventSink?.invoke(JSONObject().apply {
                put("t", "job_done")
                put("job_id", job.id)
                put("name", job.name)
                put("status", job.status)
                put("exit_code", job.exitCode ?: JSONObject.NULL)
                put("tail", job.output().takeLast(400))
                put("ms", (job.endedAt - job.startedAt).coerceAtLeast(0))
                // owner + awaited/killRequested：前端据此判断这一次结算该不该唤醒空闲会话。
                // awaited / killRequested 的结算没有完成通知，不该唤醒。
                put("sessionId", job.owner)
                put("awaited", job.awaited)
                put("kill_requested", job.killRequested)
                put("notice", job.completionNotice)
            })
        },
        onStart = { job ->
            // 开始即写账本 + 通知：Mission 卡/进行中带要在任务跑起来的当下出现
            runCatching { missions.onJobStarted(job.id, job.name, job.owner, job.startedAt, job.spec) }
            // 长任务要活过省电：agent 回合结束不等于事情结束，job 在跑就继续占着前台服务
            if (job.owner.isNotBlank()) {
                appContext?.let { c ->
                    runCatching {
                        ai.deepseek.harness.mobile.notify.RunService.begin(c, "后台任务 · " + job.name, job.owner)
                    }
                }
            }
            eventSink?.invoke(JSONObject().apply {
                put("t", "job_start")
                put("job_id", job.id)
                put("name", job.name)
                put("sessionId", job.owner)
                put("started_at", job.startedAt)
            })
        },
    )

    /** 持久终端会话（桌面 ctx.terminals） */
    val terminals = ai.deepseek.harness.mobile.kernel.terminal.TerminalRegistry { android.util.Log.d("DSHKernel", it) }

    /** 子代理注册表（桌面 ctx.subagents / ctx.agents） */
    val agents = ai.deepseek.harness.mobile.kernel.agents.AgentRegistry { android.util.Log.d("DSHKernel", it) }

    /**
     * 证据正文组装：账本存引用，这里按引用回会话日志 / job 环 / 唤醒队列取正文。
     * 声明在 missions / sessions / jobs / wakes 之后 —— 它构造时就把这四份拿在手里。
     */
    val missionEvidence = ai.deepseek.harness.mobile.kernel.mission.MissionEvidence(missions, sessions, jobs, wakes)

    /**
     * 存储与落点的清单（设置页只读它）。lazy：`configDir`/`appContext` 都在构造期才齐，
     * 磁盘余量按应用写入所在的那个分区算，不是外部存储卡。
     */
    val storage: StorageAudit by lazy {
        val files = appContext?.filesDir ?: rootDir.parentFile ?: rootDir
        StorageAudit(
            workspace, configDir, files,
            disk = {
                val c = appContext
                if (c == null) 0L to 0L else {
                    val stat = android.os.StatFs(c.filesDir.absolutePath)
                    stat.availableBlocksLong * stat.blockSizeLong to stat.blockCountLong * stat.blockSizeLong
                }
            },
        )
    }

    /** 全局事件出口：定时任务到期、交付物等「可能没有活跃轮次」的事件走这里到前端 */
    @Volatile var eventSink: ((JSONObject) -> Unit)? = null

    /**
     * 该不该用系统通知把人叫回来：没有出口，或有出口但 App 不在前台。
     *
     * 只看 `eventSink == null` 是不够的：进程活着、退到后台时 WebView 与它的 sink 都还在，
     * 事件发得出去只是没人看 —— 表现就是「任务明明结算了，用户在外面什么都不知道」（Step 2 残余）。
     * 前后台这件事 RunService 已经有一份（Activity onStart/onPause 维护），不在这里再造第二个事实源。
     */
    private fun shouldNotify(): Boolean =
        eventSink == null || !ai.deepseek.harness.mobile.notify.RunService.isAppVisible()

    /** 每轮开始时调用：清掉插件的按轮状态（表情包一轮最多一个） */
    fun beginTurn() = registry.beginTurn()

    /** 本轮收尾：插件在这里做「不抢模型槽位」的补活（如表情画面标注） */
    fun endTurn() = registry.endTurn()

    /** 表情包仓库（桥接层与 Agent 工具共用一份） */
    val stickerStore: StickerStore by lazy { StickerStore(stickerFile(rootDir)) }

    /** Agent 轮次进行中：此时 present 的产物先攒着，轮次结束一并交付 */
    @Volatile private var turnActive: Boolean = false
    private val turnDeliverables = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()

    /** present 只允许在打开的轮次里调用（桌面：present requires an open turn） */
    fun isTurnActive(): Boolean = turnActive

    fun beginTurnDeliverables() {
        turnActive = true
        turnDeliverables.clear()
    }

    /** 收走本轮缓冲的产物（present 的 + 自动扫描的由调用方合并） */
    fun drainTurnDeliverables(): List<JSONObject> {
        turnActive = false
        val out = ArrayList(turnDeliverables)
        turnDeliverables.clear()
        return out
    }

    /** 定时任务（桌面 ctx.schedule）：到期 emit schedule_due，由前端把 prompt 作为新一轮输入发出 */
    val schedule = ai.deepseek.harness.mobile.kernel.schedule.ScheduleRegistry(
        dir = configDir,
        onDue = { due ->
            // 先入队再发事件：前端收到 schedule_due 调 wakeMissions 时，记录必须已经可读
            val wake = runCatching {
                wakes.enqueueSchedule(
                    sourceId = due.optString("id"),
                    title = due.optString("title"),
                    sessionId = due.optString("sessionId"),
                    prompt = due.optString("prompt"),
                    delivered = due.optBoolean("delivered", false),
                    scheduledAt = due.optLong("scheduledAt", 0L),
                )
            }.getOrNull()
            // WebView 不在（或 App 在后台）就系统通知；记录留着，回 App 后仍然能补一轮。
            if (wake != null && shouldNotify()) {
                appContext?.let { c ->
                    ai.deepseek.harness.mobile.notify.RunService.remind(
                        c,
                        "定时任务到点 · " + due.optString("title").ifBlank { "提醒" },
                        "点开继续这一轮：" + due.optString("prompt").take(160),
                    )
                }
                runCatching { wakes.markNotified(wake.optString("id")) }
            }
            eventSink?.let { sink ->
                runCatching {
                    sink.invoke(JSONObject().apply {
                        put("t", "schedule_due")
                        put("id", due.optString("id"))
                        put("title", due.optString("title"))
                        put("prompt", due.optString("prompt"))
                        put("sessionId", due.optString("sessionId"))
                        // 提醒是否已经写进原会话日志（ScheduleDelivery 成功）
                        put("delivered", due.optBoolean("delivered", false))
                        put("text", due.optString("text"))
                    })
                }
            }
        },
        log = { android.util.Log.d("DSHKernel", it) },
        onChanged = { view -> runCatching { missions.onScheduleChanged(view) } },
        onRemoved = { id -> runCatching { missions.onScheduleRemoved(id) } },
    )

    /** 外部插件的装配错误（设置页可以显示，避免静默失败） */
    private val externalErrors = mutableListOf<String>()

    /** 内置插件发现的错误（清单损坏 / id 重复 / 一个都没找到） */
    private val discoveryErrors = mutableListOf<String>()

    val workspacePath: String get() = workspace.rootPath

    init {
        configDir.mkdirs()
        File(configDir, "plugins").mkdirs()

        // 会话档位的用户覆盖（files/kernel/presets.json，可编辑；写坏则内置档位兜底）
        runCatching {
            ai.deepseek.harness.mobile.agent.Presets.applyOverrides(File(configDir, "presets.json"))
        }

        // 跨插件服务：内核门面（创造模式的只读检查/插件管理从这里取状态）
        provideService("kernel.facade", this)
        // 事件总线本体：需要自己拼 ToolPipeline 的插件（团队运行时）从这里取；
        // PluginHooks 是带插件前缀的视图，构造不了 pipeline
        provideService("kernel.hooks", hooks)
        // 工具执行池：ToolPipeline 未显式注入执行器时取这一份（全进程一个池，daemon 线程）
        ToolPipeline.defaultPool = toolPool
        provideService("tool.pool", toolPool)
        // spill 落点不再注入：走 ToolPipeline 的默认路径 —— 工作区内的 .dsh/spill。
        // 以前注入 filesDir/spill，好处是「不污染工作区」，代价是产出物对用户和模型都半隐藏 ——
        // 工作站的前提是「跑出来的东西在同一块地面上」，所以统一到工作区，glob/grep 仍跳过 .dsh。
        // rc.186 之前的旧任务通知收件箱：事实源已经换成 wakes.json，这份文件没人读也没人写，
        // 留着只是让「本地数据」里躺着一个解释不清的孤儿
        runCatching { File(configDir, "job-notices.json").delete() }
        // Agent 自己造插件时要用：注册表 + 清单目录（写清单 → 现场注册/卸载）
        provideService("plugin.registry", registry)
        provideService("plugin.dir", File(configDir, "plugins"))
        // 生成模型配置（图片/视频，设置页填写，Agent 只读）
        provideService("gen.config", ai.deepseek.harness.mobile.kernel.GenConfig(File(configDir, "gen.json")))
        // 语音输出出口：Agent 调 speak 工具时把文本交给前端朗读
        provideService("speech.sink", { payload: JSONObject ->
            eventSink?.invoke(JSONObject().apply {
                put("t", "speak")
                put("text", payload.optString("text"))
                put("rate", payload.optDouble("rate", 1.0))
            })
        } as (JSONObject) -> Unit)
        // 媒体出口：视频/图片生成后即时插进对话（与表情包同时机）
        provideService("media.sink", { payload: JSONObject ->
            eventSink?.invoke(JSONObject().apply {
                put("t", "media")
                put("media", payload)
            })
        } as (JSONObject) -> Unit)
        // 表情包仓库 + 出口：像人聊天一样即时出现（不等轮次结束，也不插在别的气泡后面）
        // 陪伴式畅聊：状态文件 + 心跳出口。
        // 插件负责「什么时候可以开口」，出口把机会交给前端（前端才知道应用在前台还是后台、
        // 用户是不是正在打字），避免插件直接持有 UI 状态。
        provideService("companion.state", File(configDir, "companion.json"))
        // 保活服务需要的 android 环境：插件不持有 Context，从这里借
        provideService("companion.appContext", appContext)
        provideService("companion.touch", { at: Long ->
            runCatching {
                val f = File(configDir, "companion.json")
                val o = if (f.isFile) JSONObject(f.readText()) else JSONObject()
                o.put("lastUserAt", at)
                f.parentFile?.mkdirs()
                f.writeText(o.toString())
            }
        } as (Long) -> Unit)
        provideService("sticker.store", stickerStore)
        provideService("sticker.sink", { payload: JSONObject ->
            eventSink?.invoke(JSONObject().apply {
                put("t", "sticker")
                put("sticker", payload)
            })
        } as (JSONObject) -> Unit)
        provideService("job.registry", jobs)
        provideService("mission.registry", missions)
        provideService("wake.router", wakes)
        provideService("terminal.registry", terminals)
        provideService("agents.registry", agents)
        provideService("schedule.registry", schedule)
        provideService("session.store", sessions)
        // 应用上下文：需要 Android 系统能力的插件（系统提醒等）从这里取，插件不直接持有 Activity
        if (appContext != null) provideService("app.context", appContext)
        // 改动存档：write/edit/delete 前留原件，undo 工具据此撤回
        provideService("workspace.journal",
            ai.deepseek.harness.mobile.kernel.WorkspaceJournal(workspace, File(workspace.root, ".dsh/journal")))
        // 代码导航提供方（桌面 lsp 组的手机端内置提供方：正则符号索引）
        provideService("kernel.lsp", ai.deepseek.harness.mobile.kernel.lsp.SymbolIndex(workspace))
        // MCP 客户端（HTTP transport；配置在 files/kernel/mcp.json）
        provideService("mcp.client", ai.deepseek.harness.mobile.kernel.mcp.McpClient(File(configDir, "mcp.json")))
        // 交付物出口：present 推卡片。
        // 轮次进行中先缓冲（Agent 常在中途 present，此时弹卡片会插在过程中间），
        // 等这一轮结束由 AgentDriver 统一推送一次 —— 卡片永远落在这轮最后。
        provideService("deliverable.sink", { payload: JSONObject ->
            val files = payload.optJSONArray("files") ?: JSONArray()
            if (turnActive) {
                for (i in 0 until files.length()) {
                    files.optJSONObject(i)?.let { turnDeliverables.add(it) }
                }
            } else {
                eventSink?.invoke(JSONObject().apply {
                    put("t", "deliverable")
                    put("files", files)
                })
            }
        } as (JSONObject) -> Unit)
        // PTC 运行时：WebView V8，等价桌面 ptc-runtime-node；懒创建，首次 run_code 才建 WebView
        if (appContext != null) {
            // 账号登录态（等价桌面 deepseekAccount.resolveToken）：内核请求账号端点时现取
            account = ai.deepseek.harness.mobile.account.DeepSeekAuth(appContext)
            val fsForCode = FsTools(workspace, sandbox)
            provideService("ptc.runtime", ai.deepseek.harness.mobile.kernel.ptc.PtcRuntime(
                context = appContext,
                execTool = { name: String, args: org.json.JSONObject -> registry.exec(name, args.toString()) },
                sandbox = object : ai.deepseek.harness.mobile.kernel.ptc.PtcRuntime.Sandbox {
                    override fun workspacePath(): String = workspace.root.absolutePath

                    override fun read(path: String): String =
                        fsForCode.read(path).substringAfter('\n')   // 去掉「文件：…（共 N 行）」表头

                    override fun write(path: String, content: String, append: Boolean): String =
                        fsForCode.write(path, content, append)

                    override fun list(path: String): String = run {
                        val dir = sandbox.resolveRead(path.ifBlank { "." }) ?: workspace.resolve(path.ifBlank { "." }, mustExist = true)
                        val arr = org.json.JSONArray()
                        workspace.list(dir).forEach { f ->
                            arr.put(org.json.JSONObject().apply {
                                put("name", f.name)
                                put("path", workspace.relative(f))
                                put("isDir", f.isDirectory)
                                put("size", if (f.isFile) f.length() else 0)
                            })
                        }
                        arr.toString()
                    }

                    override fun exists(path: String): Boolean = runCatching {
                        (sandbox.resolveRead(path) ?: workspace.resolve(path, mustExist = true)).exists()
                    }.getOrDefault(false)

                    override fun remove(path: String): String = fsForCode.delete(path)

                    override fun stat(path: String): String = fsForCode.stat(path)

                    override fun writeBase64(path: String, base64: String, append: Boolean): String {
                        val f = sandbox.checkWrite(path) ?: workspace.resolve(path)
                        workspace.mkdirs(f)
                        val bytes = android.util.Base64.decode(base64, android.util.Base64.NO_WRAP)
                        if (bytes.size > 24 * 1024 * 1024) throw IllegalStateException("单次写入上限 24MB")
                        if (append) f.appendBytes(bytes) else f.writeBytes(bytes)
                        return workspace.relative(f) + "（${bytes.size} 字节）"
                    }

                    override fun readBase64(path: String): String {
                        val f = sandbox.resolveRead(path) ?: workspace.resolve(path, mustExist = true)
                        if (f.length() > 24L * 1024 * 1024) throw IllegalStateException("文件超过 24MB")
                        return android.util.Base64.encodeToString(f.readBytes(), android.util.Base64.NO_WRAP)
                    }

                    override fun exec(command: String): String {
                        // PTC 的 dsh.exec 走的是 WebView 里的 JS，以前完全绕过沙箱：
                        // 只读档下 run_code 仍能执行任意 shell。这里先过统一闸门
                        // （shell 能提供的是 partial 完整性，所以只读档直接拒绝，而不是假装受限）。
                        sandbox.checkExecutionSurface("PTC 的 dsh.exec")
                        if (command.isBlank()) throw IllegalStateException("命令为空")
                        val started = System.currentTimeMillis()
                        val pb = ProcessBuilder("/system/bin/sh", "-c", command)
                            .directory(workspace.root)
                            .redirectErrorStream(true)
                        pb.environment().apply {
                            put("HOME", workspace.rootPath)
                            put("DSH_WORKSPACE", workspace.rootPath)
                            put("PATH", "/system/bin:/system/xbin:/vendor/bin")
                            put("TMPDIR", workspace.rootPath + "/.tmp")
                        }
                        val proc = pb.start()
                        val done = proc.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)
                        if (!done) proc.destroyForcibly()
                        val out = proc.inputStream.bufferedReader().use { it.readText() }
                            .let { if (it.length > 60_000) it.substring(0, 60_000) + "\n[输出截断]" else it }
                        return org.json.JSONObject()
                            .put("code", if (done) proc.exitValue() else -1)
                            .put("out", out)
                            .put("ms", System.currentTimeMillis() - started)
                            .toString()
                    }

                    override fun http(requestJson: String): String {
                        val req = runCatching { org.json.JSONObject(requestJson) }
                            .getOrElse { return "{\"status\":0,\"body\":\"\",\"error\":\"请求参数不是合法 JSON\"}" }
                        val url = req.optString("url")
                        if (!url.startsWith("http://") && !url.startsWith("https://")) {
                            return "{\"status\":0,\"body\":\"\",\"error\":\"只支持 http/https\"}"
                        }
                        return runCatching {
                            val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                                requestMethod = req.optString("method", "GET").uppercase()
                                connectTimeout = 10_000
                                readTimeout = req.optLong("timeoutMs", 20_000L).coerceIn(1_000L, 120_000L).toInt()
                                val headers = req.optJSONObject("headers")
                                if (headers != null) {
                                    headers.keys().forEach { k -> setRequestProperty(k, headers.optString(k)) }
                                }
                                val body = req.optString("body")
                                if (body.isNotEmpty()) {
                                    doOutput = true
                                    if (getRequestProperty("Content-Type") == null) {
                                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                                    }
                                }
                            }
                            val body = req.optString("body")
                            if (body.isNotEmpty()) conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                            val code = conn.responseCode
                            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                                ?.bufferedReader()?.use { it.readText() }.orEmpty()
                            conn.disconnect()
                            org.json.JSONObject().put("status", code).put("body", text.take(2_000_000)).toString()
                        }.getOrElse { t ->
                            org.json.JSONObject().put("status", 0).put("body", "")
                                .put("error", t.message ?: "请求失败").toString()
                        }
                    }
                },
            ))
            // 浏览器自动化（桌面 browser-use 的手机端等价：WebView 池 + JS 注入）
            provideService("stagehand.service",
                ai.deepseek.harness.mobile.kernel.stagehand.StagehandService(appContext))
        }

        // 内置插件：走 ServiceLoader，内核不认识任何具体插件/工具名。
        // 新增内置插件 = 加一个类 + 在 META-INF/services 清单里加一行，这里零改动。
        val builtins = PluginDiscovery.discover(javaClass.classLoader, discoveryErrors)
        registry.registerAll(builtins)

        // 外部清单插件：放进 kernel/plugins/<id>.json 即可生效
        val result = ExternalPluginLoader(File(configDir, "plugins")).load()
        registry.registerAll(result.plugins)
        externalErrors.addAll(result.errors)

        // 内核侧的横切关注点：提示装配与工具守卫，同样是可摘的监听器
        PromptAssembler.installBuiltins(
            hooks,
            promptSections = { registry.promptSections() },
        ) { android.util.Log.d("DSHKernel", it) }
        ToolPipeline.installBuiltinGuards(hooks)

        // 工具元数据自检：ToolCatalog 是「只读 / 可放行 / 风险」的唯一来源。
        // 漏登记不会崩，但会让该工具被保守地当成写操作（只读权限下不可用）——
        // 这种退化必须在日志里可见，否则新增工具时永远发现不了。
        runCatching {
            val names = registry.tools().map { it.name }
            val missing = ai.deepseek.harness.mobile.kernel.plugin.ToolCatalog.validate(names)
            val orphans = ai.deepseek.harness.mobile.kernel.plugin.ToolCatalog.orphans(names)
            if (missing.isNotEmpty()) {
                android.util.Log.w("DSHKernel", "工具未在 ToolCatalog 登记（按写操作对待）：$missing")
            }
            if (orphans.isNotEmpty()) {
                android.util.Log.d("DSHKernel", "ToolCatalog 含当前未注册的条目（插件被禁用或改名）：$orphans")
            }
        }
    }

    /* ---------------- 内核对外接口（前端契约不变） ---------------- */

    fun schemas(): JSONArray = registry.schemas()

    fun exec(name: String, argsJson: String): String = registry.exec(name, argsJson)

    /** 建一个 Agent 驱动；事件回调由桥接层提供（写到 WebView 或日志） */
    fun driver(emit: (JSONObject) -> Unit): AgentDriver = AgentDriver(
        kernel = this,
        hooks = hooks,
        sessions = sessions,
        todos = todos,
        emit = emit,
        log = { android.util.Log.d("DSHDriver", it) },
        accountToken = { account?.token() },
    )

    /* ---------------- 插件管理 ---------------- */

    /* ---------------- 陪伴式畅聊（前端设置面板读写同一份状态） ---------------- */

    private fun companionFile() = File(configDir, "companion.json")

    fun companionState(): JSONObject = runCatching {
        val f = companionFile()
        val o = if (f.isFile) JSONObject(f.readText()) else JSONObject()
        // 档位参数只有 Kotlin 一份（CompanionPlugin.WINDOWS/CAPS）：前端要算「最早可能
        // 什么时候开口」「今天还剩几次」都读这里，不再自己维护同值副本。
        o.put("cadenceTable", CompanionPlugin.tableJson())
        o
    }.getOrDefault(JSONObject())

    fun saveCompanionState(patch: String): JSONObject {
        val cur = companionState()
        val incoming = runCatching { JSONObject(patch) }.getOrElse { JSONObject() }
        val keys = incoming.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            cur.put(k, incoming.get(k))
        }
        companionFile().parentFile?.mkdirs()
        companionFile().writeText(cur.toString())
        // 开关变化同步保活服务：开着 = 前台驻留（后台/深睡也到点开口）；关了 = 撤
        val ctx = appContext
        if (ctx != null) {
            if (cur.optBoolean("enabled", false)) {
                CompanionKeepService.ensure(ctx)
                // 服务起不来时至少界面上还活着：两条心跳互斥（服务在跑时兜底空转）
                CompanionEngine.startInAppBeat(ctx)
            } else {
                CompanionKeepService.stop(ctx)
                CompanionEngine.stopInAppBeat()
            }
        }
        return cur
    }

    fun pluginsJson(): JSONObject = JSONObject().apply {
        put("plugins", registry.listJson())
        put("errors", JSONArray(externalErrors))
        put("discovery", JSONArray(discoveryErrors))
        put("logs", JSONArray(registry.logs().takeLast(30)))
        put("configDir", configDir.absolutePath)
    }

    /** 配置目录（files/kernel）：生成模型配置、插件清单都在这里 */
    fun configDirPath(): String = configDir.absolutePath

    fun setPluginEnabled(id: String, on: Boolean): JSONObject {
        val enabled = registry.setEnabled(id, on)
        return JSONObject().apply {
            put("id", id)
            put("enabled", enabled)
            put("tools", JSONArray(registry.toolsOf(id).map { it.name }))
        }
    }

    /** 供插件之间共享能力时使用（Agent 运行时、搜索、后续的 web / mcp） */
    fun provideService(name: String, impl: Any?) {
        if (impl == null) services.remove(name) else services[name] = impl
    }

    /** 跨插件服务查找（桥接层与外部消费方用；插件内部请走 ctx.service） */
    fun service(name: String): Any? = services[name]

    /**
     * 删掉一场会话在内核留下的全部东西。
     *
     * 页面侧 `LocalDB.remove` 只管 localStorage 的索引与正文，而：任务页读的是 **Mission 账本**、
     * **唤醒队列** 到点会把这件事重新叫起来、**会话日志与成员日志** 一直躺在盘上 ——
     * 少清一样，用户看到的就不是「删掉了」（实测：会话索引 12 条、账本 8 行指向已不存在的会话、
     * 日志文件 1025 个）。
     *
     * 顺序：先拆团队（取消在跑的成员）→ 清唤醒 → 清账本 → 删日志（连成员会话一起）。
     * 在跑的活按「先终止再删」处理，不再多问一次：用户点的是删除，语义就是这件事到此为止。
     */
    fun purgeSession(sid: String): JSONObject {
        if (sid.isBlank()) return JSONObject().put("ok", false).put("error", "缺少会话 id")
        val team = runCatching { service("team.runtime") }
            .getOrNull() as? ai.deepseek.harness.mobile.kernel.team.TeamRuntime
        val memberSids = runCatching { team?.disposeLead(sid) ?: emptyList() }
            .getOrElse { emptyList() }
        val droppedWakes = runCatching { wakes.dropSession(sid) }.getOrDefault(0)
        val droppedMissions = runCatching { missions.dropSession(sid) }.getOrDefault(0)
        var files = 0
        (listOf(sid) + memberSids).forEach { id ->
            files += if (runCatching { sessions.delete(id) }.getOrDefault(false)) 1 else 0
        }
        return JSONObject().put("ok", true)
            .put("wakes", droppedWakes).put("missions", droppedMissions).put("files", files)
    }

    /**
     * 开机兜底清扫：把「指向已经不存在的会话」的账本行、唤醒和日志文件收掉。
     *
     * 权威是页面侧的会话索引（内核不知道哪场会话还活着），所以由页面把结论递进来，
     * 并且必须带 `loaded`：索引 0 场有两种意思 —— 第一次运行（干净的 0，孤儿该全清）
     * 和索引读坏了（这时候清扫等于把用户的东西删光）。`loaded=false` 一律不清。
     * 带 `#` 的是成员会话日志，它跟着 Lead 走：Lead 不在就一起清。
     * 这不是装饰：级联落地前攒下的孤儿（实测 8 条账本行 + 上千个日志文件）只能靠这一步收干净。
     */
    fun sweepOrphans(liveIds: List<String>, loaded: Boolean = true): JSONObject {
        if (!loaded) return JSONObject().put("ok", false).put("error", "会话索引没读成功，先不清扫")
        val live = liveIds.filter { it.isNotBlank() }.toSet()
        var droppedWakes = 0
        var droppedMissions = 0
        (wakes.orphanSessionIds(live) + missions.orphanSessionIds(live)).distinct()
            .filterNot { live.contains(it) }
            .forEach { sid ->
                droppedWakes += runCatching { wakes.dropSession(sid) }.getOrDefault(0)
                droppedMissions += runCatching { missions.dropSession(sid) }.getOrDefault(0)
            }
        var files = 0
        runCatching { sessions.fileIds() }.getOrElse { emptyList() }.forEach { name ->
            if (live.contains(name.substringBefore('#'))) return@forEach
            files += if (runCatching { sessions.delete(name) }.getOrDefault(false)) 1 else 0
        }
        return JSONObject().put("ok", true)
            .put("wakes", droppedWakes).put("missions", droppedMissions).put("files", files)
    }

    /** 调试视图：内核装了哪些钩子、哪些服务 */
    fun kernelJson(): JSONObject = JSONObject().apply {
        put("hooks", hooks.describe())
        put("services", JSONArray(services.keys.toList()))
        put("sessions", sessions.listSessions())
        put("sandbox", sandbox.describe())
        put("skills", skills.toJson())
        put("plugins", registry.listJson())
        put("discovery", JSONArray(discoveryErrors))
        put("jobs", jobs.list())
        put("terminals", terminals.describe())
        put("agents", agents.describe())
        put("schedule", schedule.list())
    }

    /**
     * 写某个插件的配置段（设置页用）。
     *
     * 只改 `config.<id>`，其它插件段与顶层键原样保留；写失败不影响内存里已生效的值，
     * 下次启动会回退到上次成功落盘的那份 —— 设置项宁可丢一次修改，不能把整份配置写坏。
     */
    fun savePluginConfig(pluginId: String, section: JSONObject) {
        runCatching {
            val f = File(configDir, "config.json")
            val root = readConfig()
            val config = root.optJSONObject("config") ?: JSONObject().also { root.put("config", it) }
            config.put(pluginId, section)
            f.parentFile?.mkdirs()
            f.writeText(root.toString(2))
        }
    }

    private fun readConfig(): JSONObject {
        val f = File(configDir, "config.json")
        if (!f.exists()) return JSONObject()
        return try { JSONObject(f.readText()) } catch (_: Throwable) { JSONObject() }
    }

    companion object {
        /**
         * 表情包库路径：`<rootDir 同级>/kernel/stickers.json`。
         *
         * 单独抽出来是为了让桥接层拿得到它而**不必构造内核**：`kernel.stickerStore` 是懒加载
         * 属性，但它挂在 ToolKernel 上 —— 读一次就等于把插件注册表、工具目录、会话日志、
         * 钩子链整套装配跑一遍。桥接层要的只是这个路径，所以路径本身单独给一个入口。
         */
        fun stickerFile(rootDir: File): File =
            File(File(rootDir.parentFile ?: rootDir, "kernel"), "stickers.json")
    }
}
