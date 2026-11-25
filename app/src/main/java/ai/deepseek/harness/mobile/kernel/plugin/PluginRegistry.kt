package ai.deepseek.harness.mobile.kernel.plugin

import ai.deepseek.harness.mobile.kernel.KernelError
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 插件注册表：桌面 Harness 里由 Cordis 容器承担的职责，手机端收敛成这个类。
 *
 * - register/load：注册插件并把它的工具编进索引
 * - schemas()：把启用插件的工具汇总成模型可见的 tool 定义
 * - exec()：按工具名派发，统一包成 {ok, output|error}
 * - setEnabled()：运行时启停（禁用即卸载，工具随即从模型目录消失）
 *
 * 插件拿到的不是裸 [ctx]，而是 [contextFor] 派生的**子上下文**：
 * 事件总线带 `<插件id>/` 前缀（卸载按前缀摘除）、配置只给 `config.<id>` 段、日志带插件名。
 *
 * 状态写在 configDir/plugins.json，不放进工作区，避免模型直接改到自己的权限配置。
 */
class PluginRegistry(
    private val ctx: PluginContext,
    private val configDir: File,
    private val bus: ai.deepseek.harness.mobile.agent.HookBus? = null,
) {
    private class Entry(val plugin: KernelPlugin) {
        var enabled: Boolean = true
        var loaded: Boolean = false
        var hooks: PluginHooks? = null
    }

    /**
     * 插件声明「我要用哪些服务」的接口。
     *
     * 桌面 cordis-host-runner 交给动态插件的是**白名单 ctx** —— 只有 `inject` 声明过的
     * 服务可达（`extensions/cordis-host-runner/src/guard.ts:709-744`）。手机端没有 cordis，
     * 等价物就是这里：实现本接口的插件在 [contextFor] 里只能拿到 [declaredServices]
     * 列出的服务，其余一律 null。内置插件不实现，行为不变（随 APK 编译、经人工复核）。
     */
    interface DeclaresServices {
        fun declaredServices(): Set<String>
    }

    companion object {
        /**
         * 一次请求里工具定义的总预算（UTF-8 字节）。
         *
         * 取 48KB：网关/WAF 的**请求体**硬上限实测在 ~128KB（Cloudflare 直接回 403 HTML）。
         * 工具只是请求的一部分，还要装 system prompt（十几 KB）、对话历史与工具结果 ——
         * 159 个工具的原文约 95KB，光它就把预算吃光，第二轮必然超限（踩过）。
         * 超预算时 [schemas] 自动逐级瘦身：先截短描述，仍超就只留参数结构。
         */
        const val SCHEMA_BUDGET_BYTES = 64 * 1024

        /**
         * 动态插件（清单插件 / MCP 工具插件）允许声明的服务白名单。
         *
         * 危险服务故意不在表内：`kernel.facade`（内核门面）、`plugin.registry` / `plugin.dir`
         * （能自己装配插件）、`app.context`（Android 上下文）、`agent.runtime`（能发起审批）、
         * `team.runtime`。拿到任何一个都等于绕过 WP4a 的整条信任链，所以只出不进。
         */
        val MANIFEST_SAFE_SERVICES: Set<String> = setOf(
            "workspace.journal", "job.registry", "session.store", "kernel.lsp", "ptc.runtime",
        )
    }

    private val entries = LinkedHashMap<String, Entry>()

    /** 结构性变更（注册/卸载/刷新）与遍历快照共用的一把锁 */
    private val lock = Any()

    /**
     * 工具名 → (所属条目, 定义)。
     *
     * **必须并发安全**：只读工具以 4 路并发池执行（`ToolPipeline.PARALLEL_WIDTH`），
     * 动态插件又会在运行中刷新自己的工具。旧实现是裸 `LinkedHashMap`，
     * 并发 exec 与 refresh 会 ConcurrentModificationException。
     */
    private val toolIndex = java.util.concurrent.ConcurrentHashMap<String, Pair<Entry, ToolSpec>>()

    /** 运行日志：并发写（加载/卸载/刷可能同时发生），用写时复制列表避免 CME */
    private val log = java.util.concurrent.CopyOnWriteArrayList<String>()

    /**
     * schemas() 的缓存：(裁剪后数组, 预算)。AgentDriver 现在**每步**都调 schemas()
     * （自造插件同轮生效依赖它），而全量裁剪是 ~100KB JSON 的逐条扫描 —— 8 步轮次
     * 就要白扫 8 次。缓存按结构变更失效（register/unregister/refreshTools/setEnabled）。
     */
    @Volatile private var schemaCache: JSONArray? = null
    @Volatile private var schemaCacheBudget: Int = -1

    /** 新一轮开始：让按轮计数的插件清零（表情包「一轮最多一个」这类约束靠它） */
    fun beginTurn() {
        snapshot().forEach { e -> (e.plugin as? ai.deepseek.harness.mobile.kernel.plugin.TurnScopedPlugin)?.beginTurn() }
    }

    fun endTurn() {
        snapshot().forEach { e ->
            runCatching { (e.plugin as? ai.deepseek.harness.mobile.kernel.plugin.TurnScopedPlugin)?.endTurn() }
        }
    }

    /** 一致性快照：所有遍历都走它，避免注册/卸载与遍历并发时结构被改 */
    private fun snapshot(): List<Entry> = synchronized(lock) { entries.values.toList() }

    /** service 名 → 注册它的插件 id：卸载时据此注销，避免「插件禁用、服务还在」 */
    private val serviceOwner = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** 被拒绝的服务访问只记一次，避免每轮每次调用都刷日志 */
    private val deniedServiceNotes = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private val stateFile: File get() = File(configDir, "plugins.json")

    /* ---------------- 注册与生命周期 ---------------- */

    fun registerAll(plugins: List<KernelPlugin>) {
        val disabled = readDisabled()
        plugins.forEach { register(it, enabled = it.id !in disabled) }
    }

    fun register(plugin: KernelPlugin, enabled: Boolean = true) {
        synchronized(lock) {
            if (entries.containsKey(plugin.id)) return
            val entry = Entry(plugin).apply { this.enabled = enabled }
            entries[plugin.id] = entry
            if (enabled) load(entry)
        }
        schemaCache = null
        persist()
    }

    /**
     * 运行时卸载（Agent 自己造/装/卸插件用）：
     * 先摘工具与钩子，再移除条目并落盘；下次启动不会再加载它。
     */
    fun unregister(id: String): Boolean {
        val entry = synchronized(lock) { entries.remove(id) } ?: return false
        unload(entry)
        schemaCache = null
        persist()
        note("已卸载插件 $id")
        return true
    }

    /** 某插件贡献的工具名（注意：toolsOf 返回的是 ToolSpec，这里只要名字） */
    fun toolNamesOf(id: String): List<String> =
        synchronized(lock) { entries[id]?.plugin?.tools?.map { it.name } } ?: emptyList()

    /**
     * 用插件**当前**声明的工具重建它的索引条目 —— 动态插件（MCP 工具桥、自造插件热更新）
     * 在运行中改变工具集合后调它，否则 [executionModeOf] 会过时、`exec()` 只能走回落。
     *
     * 语义：
     *  - 先摘掉该插件名下所有旧名字（插件删掉的工具不会留下死索引）
     *  - 再装当前工具；与其它插件撞名仍按「先到先得」跳过并记日志
     *  - 未启用 / 未加载的插件 → 只摘不装，返回 0
     * @param pluginId 插件 id
     * @return 重建后该插件在索引里的工具数；`-1` 表示没有这个插件
     */
    fun refreshTools(pluginId: String): Int = synchronized(lock) {
        val entry = entries[pluginId] ?: return@synchronized -1
        schemaCache = null
        toolIndex.entries.removeAll { it.value.first === entry }
        if (!entry.enabled || !entry.loaded) return@synchronized 0
        indexLocked(entry)
    }

    /** 把 entry 当前声明的工具装进索引（调用方必须已持有 [lock]）；返回本次装入数。 */
    private fun indexLocked(entry: Entry): Int {
        var indexed = 0
        entry.plugin.tools.forEach { spec ->
            val clash = toolIndex[spec.name]
            if (clash != null) {
                note("工具名冲突：${spec.name} 已被 ${clash.first.plugin.id} 占用，跳过 ${entry.plugin.id}")
            } else {
                toolIndex[spec.name] = entry to spec
                indexed++
            }
        }
        return indexed
    }

    fun has(id: String): Boolean = synchronized(lock) { entries.containsKey(id) }

    fun installedIds(): List<String> = synchronized(lock) { entries.keys.toList() }

    private fun load(entry: Entry) {
        if (entry.loaded) return
        try {
            val scoped = contextFor(entry.plugin)
            entry.hooks = scoped.hooks
            entry.plugin.onLoad(scoped)
            entry.loaded = true
            // onLoad 之后才索引：插件可能在自己的 onLoad 里改变工具集合（动态工具桥）
            synchronized(lock) { indexLocked(entry) }
            val hooked = bus?.countPrefix("${entry.plugin.id}/") ?: 0
            note("已加载插件 ${entry.plugin.id}（${entry.plugin.tools.size} 个工具${if (hooked > 0) "、$hooked 个钩子" else ""}）")
        } catch (t: Throwable) {
            note("插件 ${entry.plugin.id} 加载失败：${t.message}")
            entry.enabled = false
            // 加载失败也要摘掉它可能已经挂上的半截钩子，避免半死状态影响主流程
            entry.hooks?.let { bus?.offPrefix("${it.owner}/") }
        }
    }

    private fun unload(entry: Entry) {
        if (!entry.loaded) return
        synchronized(lock) {
            // 按条目摘而不是按当前 tools 摘：插件在 onLoad 后增删过工具时，
            // 用当前 tools 摘会漏掉已经消失的名字，留下死索引
            toolIndex.entries.removeAll { it.value.first === entry }
        }
        try { entry.plugin.onUnload() } catch (_: Throwable) {}
        // 注销它注册过的服务：插件关掉后 team.runtime 这类名字不能还挂着旧实例
        serviceOwner.filterValues { it == entry.plugin.id }.keys.toList().forEach { name ->
            serviceOwner.remove(name)
            ctx.provide(name, null)
        }
        // 插件自己不需要 off：按 id 前缀把它的监听器一次摘干净
        val removed = bus?.offPrefix("${entry.plugin.id}/") ?: 0
        entry.hooks = null
        entry.loaded = false
        note("已卸载插件 ${entry.plugin.id}${if (removed > 0) "（摘除 $removed 个钩子）" else ""}")
    }

    /**
     * 派生插件专属上下文：
     * - hooks 带前缀，卸载可整体摘除
     * - config() 只返回 config.<id> 段，插件之间看不到彼此的配置
     * - log() 带插件名，内核日志里能直接看出是谁在说话
     * - 实现了 [DeclaresServices] 的插件（外部清单 / 动态工具插件）只拿得到它声明的服务，
     *   且**不能** provide 服务 —— 否则一个清单插件就能覆盖 `plugin.registry`，
     *   把「谁能装插件」这条链整个接管
     */
    private fun contextFor(plugin: KernelPlugin): PluginContext {
        val declared: Set<String>? = (plugin as? DeclaresServices)?.declaredServices()
        return object : PluginContext {
            override val workspace: ai.deepseek.harness.mobile.kernel.Workspace get() = ctx.workspace
            override val sandbox: ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox get() = ctx.sandbox
            override val hooks: PluginHooks = PluginHooks(bus, plugin.id)
            override fun config(): JSONObject =
                ctx.config().optJSONObject("config")?.optJSONObject(plugin.id) ?: JSONObject()
            override fun service(name: String): Any? {
                if (declared != null && name !in declared) {
                    val key = "${plugin.id}/service/$name"
                    if (deniedServiceNotes.add(key)) {
                        note("插件 ${plugin.id} 未声明服务「$name」，已拒绝（需在清单 services 里声明，且须在内核白名单内）")
                    }
                    return null
                }
                return ctx.service(name)
            }
            override fun provide(name: String, value: Any?) {
                if (name.isBlank()) return
                if (declared != null) {
                    note("插件 ${plugin.id} 是动态插件，不允许 provide 服务「$name」（会覆盖内核服务）")
                    return
                }
                if (value == null) {
                    if (serviceOwner.remove(name) != null) ctx.provide(name, null)
                } else {
                    serviceOwner[name] = plugin.id
                    ctx.provide(name, value)
                }
            }
            /**
             * 动态插件在自己的 onLoad 里刷新工具索引（MCP 工具桥的用法）。
             *
             * 直接调本注册表而不是外层 `ctx.refreshTools`：派生上下文的实现不该依赖
             * 外层实现是否转发，否则「插件自己刷新」会静默变成空操作。
             */
            override fun refreshTools(pluginId: String) {
                this@PluginRegistry.refreshTools(pluginId)
            }
            override fun log(msg: String) = ctx.log("[${plugin.id}] $msg")
        }
    }

    /** 运行时启停；返回当前是否处于启用状态 */
    fun setEnabled(id: String, on: Boolean): Boolean {
        synchronized(lock) {
            val entry = entries[id] ?: return false
            if (entry.enabled == on) return on
            entry.enabled = on
            if (on) load(entry) else unload(entry)
            schemaCache = null
            persist()
            return entry.enabled
        }
    }

    fun isEnabled(id: String): Boolean = synchronized(lock) { entries[id]?.enabled == true }

    /* ---------------- 工具目录 ---------------- */

    fun tools(): List<ToolSpec> = snapshot().filter { it.enabled && it.loaded }.flatMap { it.plugin.tools }

    /**
     * 运行时装配（非内置）插件贡献的工具名：清单插件、MCP 工具桥。
     *
     * 这些工具**不受预设白名单过滤**（见 AgentDriver.currentToolNames）——
     * 它们是用户逐次批准装配的能力，被预设静默藏掉等于「装了但永远调不到」；
     * 计划模式等硬闸门仍然照常生效（visibleTools 先行过滤）。
     */
    fun dynamicToolNames(): Set<String> = snapshot()
        .filter { !it.plugin.builtin && it.enabled && it.loaded }
        .flatMap { it.plugin.tools }
        .map { it.name }
        .toSet()

    fun toolsOf(id: String): List<ToolSpec> = synchronized(lock) { entries[id]?.plugin?.tools } ?: emptyList()

    /** 工具的并发语义（桌面 executionMode 的查询入口） */
    fun executionModeOf(name: String): ToolExecutionMode =
        toolIndex[name]?.second?.executionMode ?: ToolExecutionMode.EXCLUSIVE

    /** 所有启用插件贡献的提示词段落（顺序稳定，便于缓存命中） */
    fun promptSections(): List<String> = snapshot()
        .filter { it.enabled && it.loaded }
        .mapNotNull { runCatching { it.plugin.promptSection() }.getOrNull() }
        .filter { it.isNotBlank() }

    /**
     * 工具定义给模型的版本。
     *
     * **为什么要压体积**：手机端工具多（160+），schema 原文约 100KB；而网关/WAF 对请求体
     * 有硬上限（实测 Cloudflare 约 128KB 就回 403 HTML），一超就整轮对话失败。
     * 这里按预算逐级瘦身：先截短描述，仍超就只留参数结构（名字与类型不动，
     * 派发与校验完全不受影响）。
     */
    fun schemas(budgetBytes: Int = SCHEMA_BUDGET_BYTES): JSONArray {
        // 缓存命中：AgentDriver 每步都调这里（自造插件同轮生效依赖），全量裁剪
        // 是 ~100KB JSON 的逐条扫描，按结构变更失效（见各变更点 schemaCache = null）
        schemaCache?.let { cached -> if (schemaCacheBudget == budgetBytes) return cached }
        // 逐级降级：工具描述是模型选工具的唯一依据，尽量保；参数描述最先牺牲
        var result: JSONArray? = null
        for ((desc, param) in LEVELS) {
            val arr = buildSchemas(desc, param)
            if (utf8Size(arr) <= budgetBytes) { result = arr; break }
        }
        val arr = result ?: buildSchemas(1, 1)
        schemaCache = arr
        schemaCacheBudget = budgetBytes
        return arr
    }

    /** 降级梯度：(工具描述上限, 参数描述上限)；1 表示清空，0 表示不截断 */
    private val LEVELS = listOf(0 to 0, 72 to 1, 32 to 1)

    /** 逐级瘦身；descLimit=0 表示不截断，=1 表示清空描述 */
    private fun buildSchemas(descLimit: Int, paramLimit: Int): JSONArray = JSONArray().apply {
        tools().forEach { spec ->
            put(JSONObject().apply {
                put("name", spec.name)
                put("description", clip(spec.description, descLimit))
                put("parameters", trimParams(spec.parameters, paramLimit))
            })
        }
    }

    private fun clip(s: String, limit: Int): String {
        if (limit == 0) return s
        if (limit == 1) return ""
        val t = s.replace("\n", " ").trim()
        return if (t.length <= limit) t else t.take(limit) + "…"
    }

    /** 只瘦身描述字段，不动类型/必填（模型据此生成参数，改了就报错） */
    private fun trimParams(src: JSONObject?, limit: Int): JSONObject {
        if (src == null) return JSONObject()
        if (limit == 0) return src
        val out = JSONObject(src.toString())
        fun walk(o: JSONObject) {
            if (o.has("description")) o.put("description", clip(o.optString("description"), limit))
            o.optJSONObject("properties")?.let { props ->
                props.keys().forEach { k -> (props.opt(k) as? JSONObject)?.let { walk(it) } }
            }
            o.optJSONObject("items")?.let { walk(it) }
            o.optJSONArray("anyOf")?.let { arr ->
                for (i in 0 until arr.length()) (arr.opt(i) as? JSONObject)?.let { walk(it) }
            }
        }
        walk(out)
        return out
    }

    private fun utf8Size(arr: JSONArray): Int = arr.toString().toByteArray(Charsets.UTF_8).size

    /** 执行工具：契约与旧版 ToolKernel.exec 一致，前端无需改动 */
    fun exec(name: String, argsJson: String): String = exec(name, argsJson, ToolExecContext.NONE)

    /**
     * 带执行上下文的派发（native 之外的调用路径用：PTC 子调度、插件互调、桥接）。
     *
     * 上下文走 [ToolExecContext] 的线程内挂载，**不改变权限判定** —— 权限仍在
     * ToolPipeline 的 pre-execute 链上。它的价值是让被调插件知道「谁在调、从哪条路径来」，
     * 从而对程序化调用（source=ptc/plugin）走更严的策略。
     *
     * 继承规则：调用方给的是 [ToolExecContext.NONE]（2 参入口）且线程上已经有流水线挂好的
     * 上下文时，沿用那一份而不覆盖 —— 否则一次插件互调会把「这一轮的身份」洗掉。
     */
    fun exec(name: String, argsJson: String, context: ToolExecContext): String {
        val args = try {
            if (argsJson.isBlank()) JSONObject() else JSONObject(argsJson)
        } catch (e: Exception) {
            return error("参数不是合法 JSON：${e.message}", "BAD_ARGUMENTS")
        }
        // 「名字本身不合法」与「名字合法但目录里没有」是两回事：前者要说清调用方传的是什么，
        // 后者才是「插件可能被禁用」。混成一句会让人去翻插件清单，而问题在调用方。
        if (name.isBlank() || name == "null" || name == "undefined") {
            return error("工具名不合法：\"$name\"（调用方没取到工具名，不是插件被禁用）", "BAD_TOOL_NAME")
        }
        val hit = resolve(name) ?: return error("未知工具：$name（对应插件可能被禁用）", "UNKNOWN_TOOL")
        if (!hit.first.enabled) return error("插件 ${hit.first.plugin.id} 已禁用，工具 $name 不可用", "TOOL_UNAVAILABLE")
        validateArgs(hit.second.parameters, args)?.let { return it }
        val inherit = context === ToolExecContext.NONE && ToolExecContext.current() != null
        var previous: ToolExecContext? = null
        if (!inherit) previous = ToolExecContext.attach(context)
        return try {
            // ctx 挂在线程上（流水线挂的或这里显式挂的），工具自己读 ToolExecContext.current()。
            // 派发走 executeResult：正文仍是 output，退出码作为**同级字段**带出去
            // （前台命令的正文是纯文本，没有别的地方能承载退出码）。
            val res = hit.second.executeResult(args, ToolExecContext.currentOrNone())
            val warn = unknownArgsWarn(hit.second.parameters, args)
            val out = if (warn == null) res.text else "$warn\n${res.text}"
            JSONObject().put("ok", true).put("output", out).apply {
                res.exitCode?.let { put("exit_code", it) }
            }.toString()
        } catch (e: KernelError) {
            error(e.message ?: "执行失败", "TOOL_ERROR")
        } catch (t: Throwable) {
            // 必须接 Throwable 而不是 Exception：工具边界上连 Error 也是「结果」不是「崩溃」。
            // rc.110 实锤：R8 合并类破坏接口默认方法 → AbstractMethodError（Error 子类）
            // 直接穿透 catch(Exception) 把整条调用链炸掉。把它变成 TOOL_THREW JSON 回给模型。
            error("${t.javaClass.simpleName}: ${t.message}", "TOOL_THREW")
        } finally {
            if (!inherit) ToolExecContext.detach(previous)
        }
    }

    /**
     * 名字 → 索引条目。
     *
     * 两条不变量：
     *  1. **exec ⊆ schemas**：索引命中也要回读插件当前的 `tools` 复核，插件删掉的工具
     *     绝不会还能调用（陈旧条目就地摘掉）。
     *  2. **schemas ⊆ exec**：索引未命中时回落到与 `tools()` 同一份实时视图再补索引，
     *     动态插件换了工具却没调 [refreshTools] 时不会出现「模型看得见、调用 UNKNOWN_TOOL」。
     */
    private fun resolve(name: String): Pair<Entry, ToolSpec>? {
        val indexed = toolIndex[name]
        if (indexed != null && indexed.first.enabled && indexed.first.loaded) {
            val live = indexed.first.plugin.tools.firstOrNull { it.name == name }
            if (live != null) {
                if (live !== indexed.second) toolIndex[name] = indexed.first to live
                return indexed.first to live
            }
            toolIndex.remove(name, indexed)   // 只摘这一条陈旧映射，不误伤刚刷新的结果
        }
        val entry = snapshot().firstOrNull { e ->
            e.enabled && e.loaded && e.plugin.tools.any { it.name == name }
        } ?: return null
        val spec = entry.plugin.tools.first { it.name == name }
        toolIndex[name] = entry to spec
        return entry to spec
    }

    /**
     * 按 schema 预校验参数：必填缺失给「缺什么+该填什么」的可行动错误 ——
     * 否则插件里 getString 抛的是裸 JSONException（TOOL_THREW），
     * 模型看到 "No value for pattern" 根本不知道哪里错了。
     */
    private fun validateArgs(schema: JSONObject, args: JSONObject): String? {
        val required = schema.optJSONArray("required") ?: return null
        val props = schema.optJSONObject("properties")
        val missing = (0 until required.length())
            .map { required.optString(it) }
            .filter { !args.has(it) || args.isNull(it) }
        if (missing.isEmpty()) return null
        val desc = missing.joinToString("、") { p ->
            val pd = props?.optJSONObject(p)
            "$p（${pd?.optString("description", "")?.take(60) ?: ""}）"
        }
        return error("缺少必填参数：$desc", "BAD_ARGUMENTS")
    }

    /** 未知参数警告：拼错参数名会静默走默认值，比报错更难查。只警告不阻断。 */
    private fun unknownArgsWarn(schema: JSONObject, args: JSONObject): String? {
        val props = schema.optJSONObject("properties") ?: return null
        val unknown = args.keys().asSequence().filter { !props.has(it) }.toList()
        if (unknown.isEmpty()) return null
        return "⚠️ 以下参数未被工具识别，已忽略：${unknown.joinToString("、")}（请检查参数名拼写）"
    }

    /* ---------------- 给设置页看的视图 ---------------- */

    fun listJson(): JSONArray = JSONArray().apply {
        snapshot().forEach { entry ->
            put(JSONObject().apply {
                put("id", entry.plugin.id)
                put("name", entry.plugin.name)
                put("description", entry.plugin.description)
                put("version", entry.plugin.version)
                put("builtin", entry.plugin.builtin)
                put("enabled", entry.enabled)
                put("loaded", entry.loaded)
                put("tools", JSONArray(entry.plugin.tools.map { it.name }))
                put("status", JSONObject().apply {
                    entry.plugin.status().forEach { (k, v) -> put(k, v) }
                })
            })
        }
    }

    fun logs(): List<String> = log.toList()

    /* ---------------- 内部 ---------------- */

    private fun readDisabled(): Set<String> {
        if (!stateFile.exists()) return emptySet()
        return try {
            val obj = JSONObject(stateFile.readText())
            val arr = obj.optJSONArray("disabled") ?: JSONArray()
            (0 until arr.length()).map { arr.getString(it) }.toSet()
        } catch (_: Throwable) {
            emptySet()
        }
    }

    private fun persist() {
        try {
            if (!configDir.exists()) configDir.mkdirs()
            val disabled = synchronized(lock) {
                entries.values.filter { !it.enabled }.map { it.plugin.id }
            }
            stateFile.writeText(JSONObject().put("disabled", JSONArray(disabled)).toString(2))
        } catch (_: Throwable) {}
    }

    private fun note(msg: String) {
        log.add(msg)
        if (log.size > 200) log.removeAt(0)
        ctx.log(msg)
    }

    private fun error(msg: String, code: String): String =
        JSONObject().put("ok", false).put("code", code).put("error", msg).toString()
}
