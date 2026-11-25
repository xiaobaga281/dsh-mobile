package ai.deepseek.harness.mobile.kernel.plugin

/**
 * 工具元数据总表 —— 全内核关于「工具是什么性质」的唯一事实来源。
 *
 * 为什么要有这张表（而不是让每个工具自己声明）：
 *   1. 同一个判断（这个工具能不能在只读权限/计划模式下跑）散落在
 *      ToolPipeline 的守卫、PromptAssembler 的目录、前端的分组里，
 *      一旦各写一份硬编码集合，就必然漂移 —— 之前就漂了：
 *      守卫只认 5 个文件工具是只读，于是只读权限下 web_search、memory_search、
 *      ask_user_question、read_image 全被判成"改写操作"直接拒掉。
 *   2. 新增工具时最容易漏的就是这类横切属性。这里提供 [validate]：
 *      内核启动时对所有已注册工具做一次核对，未登记的直接记日志，
 *      让"忘了登记"变成可见事件而不是线上静默行为异常。
 *
 * 三个正交维度：
 *   - [ToolGroup]   面向模型与界面的能力域（提示词按域归纳，界面按域分组）
 *   - [readOnly]    只读且无副作用：可并发、可在只读权限/计划模式下执行
 *   - [alwaysAllowed] 非只读，但不改动用户资产（提问、待办、交付、语音、表情）：
 *                   即使在只读或计划模式下也必须放行，否则 Agent 连"问一句"都做不到
 *
 * 风险等级 [Risk] 只用于危险操作确认，与上面两个标志独立。
 */
enum class ToolGroup(val label: String) {
    FS("文件读写"),
    SEARCH("检索"),
    EDIT("编辑与交付"),
    SHELL("命令与终端"),
    WEB("网络"),
    MEDIA("媒体生成"),
    MEMORY("记忆"),
    SESSION("会话与目标"),
    DELEGATE("委派与协作"),
    DEVICE("手机操控"),
    PLUGIN("插件与内核"),
    SCHEDULE("定时任务"),
    COMM("通信"),
    ;

    companion object {
        fun of(name: String): ToolGroup = runCatching { valueOf(name) }.getOrDefault(PLUGIN)
    }
}

enum class Risk {
    /** 只读 */
    NONE,

    /** 会改文件/外部状态，但范围可预期 */
    MUTATE,

    /** 可能造成不可逆影响：删除、任意命令、任意代码执行 */
    DESTRUCTIVE,
}

class ToolMeta(
    val group: ToolGroup,
    val readOnly: Boolean = false,
    val alwaysAllowed: Boolean = false,
    val risk: Risk = if (readOnly) Risk.NONE else Risk.MUTATE,
) {
    /** 只读权限与计划模式下是否可执行 */
    val allowedWithoutWrite: Boolean get() = readOnly || alwaysAllowed
}

object ToolCatalog {

    private const val R = true   // 只读
    private const val A = true   // 只读模式下也放行（非只读）

    private fun ro(group: ToolGroup) = ToolMeta(group, readOnly = true)
    private fun safe(group: ToolGroup) = ToolMeta(group, alwaysAllowed = true)
    private fun rw(group: ToolGroup, risk: Risk = Risk.MUTATE) = ToolMeta(group, risk = risk)

    /**
     * 登记表。顺序与内置插件清单一致，便于人工核对。
     * 这里**不做前缀猜测**：猜"read_ 开头就是只读"迟早会把 read_mcp_resource 之外的
     * 东西误判，规范的意义就在于每条都是人确认过的。
     */
    private val table: Map<String, ToolMeta> = buildMap {
        /* ---------------- fs：文件 ---------------- */
        put("read", ro(ToolGroup.FS))
        put("write", rw(ToolGroup.FS))
        put("edit", rw(ToolGroup.FS))
        put("list_dir", ro(ToolGroup.FS))
        put("glob", ro(ToolGroup.SEARCH))
        put("grep", ro(ToolGroup.SEARCH))
        put("stat", ro(ToolGroup.FS))
        put("read_doc", ro(ToolGroup.FS))
        // 生成文档 = 写文件，风险与 write 同级
        put("write_docx", rw(ToolGroup.FS))
        put("write_xlsx", rw(ToolGroup.FS))
        put("write_pptx", rw(ToolGroup.FS))
        put("write_pdf", rw(ToolGroup.FS))
        put("write_zip", rw(ToolGroup.FS))
        put("mkdir", rw(ToolGroup.FS))
        put("delete_path", rw(ToolGroup.FS, Risk.DESTRUCTIVE))
        put("undo", rw(ToolGroup.FS))
        put("move", rw(ToolGroup.FS))
        put("copy", rw(ToolGroup.FS))

        /* ---------------- shell：任意命令 ---------------- */
        put("bash", rw(ToolGroup.SHELL, Risk.DESTRUCTIVE))
        put("pwsh", rw(ToolGroup.SHELL, Risk.DESTRUCTIVE))

        /* ---------------- runtime：语言运行时（python/node 双底座） ----------------
           这组此前一直没登记，内核启动告警「按写操作对待」——语义恰好就是写操作
           （跑任意代码），现在显式落表：与 bash 同级（任意代码执行 = DESTRUCTIVE）。 */
        put("python", rw(ToolGroup.SHELL, Risk.DESTRUCTIVE))
        put("node", rw(ToolGroup.SHELL, Risk.DESTRUCTIVE))
        put("run", rw(ToolGroup.SHELL, Risk.DESTRUCTIVE))
        put("compile", rw(ToolGroup.SHELL))
        put("java", rw(ToolGroup.SHELL))
        put("rustc", rw(ToolGroup.SHELL))
        put("pkg", rw(ToolGroup.SHELL))

        /* ---------------- mcp：外部工具桥 ---------------- */
        // mcp_tools 是动态 MCP 工具的子调度入口（CompatPlugin，网络往返、外部 server 不可控）
        put("mcp_tools", rw(ToolGroup.WEB))

        /* ---------------- editor：编辑与交付 ---------------- */
        put("str_replace_editor", rw(ToolGroup.EDIT))
        put("apply_patch", rw(ToolGroup.EDIT))
        // 交付只是把文件推给界面，不动文件本身 —— 只读模式下也必须能交付
        put("present", safe(ToolGroup.EDIT))

        /* ---------------- terminal / jobs ---------------- */
        put("terminal_open", rw(ToolGroup.SHELL))
        put("terminal_list", ro(ToolGroup.SHELL))
        put("terminal_send", rw(ToolGroup.SHELL, Risk.DESTRUCTIVE))
        put("terminal_read", ro(ToolGroup.SHELL))
        put("terminal_signal", rw(ToolGroup.SHELL))
        put("terminal_close", rw(ToolGroup.SHELL))
        put("job_list", ro(ToolGroup.SHELL))
        put("job_output", ro(ToolGroup.SHELL))
        put("job_kill", rw(ToolGroup.SHELL))

        /* ---------------- schedule ---------------- */
        put("schedule_create", rw(ToolGroup.SCHEDULE))
        put("schedule_update", rw(ToolGroup.SCHEDULE))
        put("schedule_delete", rw(ToolGroup.SCHEDULE))
        put("schedule_list", ro(ToolGroup.SCHEDULE))

        /* ---------------- session-query ---------------- */
        put("session_event_read", ro(ToolGroup.SESSION))
        put("session_event_search", ro(ToolGroup.SESSION))
        put("session_event_trace", ro(ToolGroup.SESSION))
        put("session_search", ro(ToolGroup.SESSION))
        put("session_trace", ro(ToolGroup.SESSION))
        put("working_directory", ro(ToolGroup.SESSION))

        /* ---------------- harness：行为工具 ---------------- */
        put("exit_plan_mode", safe(ToolGroup.SESSION))
        put("update_goal", safe(ToolGroup.SESSION))
        put("create_goal", safe(ToolGroup.SESSION))
        put("get_goal", ro(ToolGroup.SESSION))
        put("todo_write", safe(ToolGroup.SESSION))
        put("web_search", ro(ToolGroup.WEB))
        put("web_fetch", ro(ToolGroup.WEB))
        // 裸调接口：方法/头/体可控，POST 等会改外部状态 —— 按写操作对待
        put("http_request", rw(ToolGroup.WEB))
        put("read_image", ro(ToolGroup.MEDIA))
        put("subagent", safe(ToolGroup.DELEGATE))
        put("skill", safe(ToolGroup.SESSION))
        // 陪伴式畅聊：say/followup 只是状态与文案，不改文件；control 改的是插件设置
        put("companion_followup", safe(ToolGroup.SESSION))
        put("companion_control", safe(ToolGroup.SESSION))
        put("ask_user_question", safe(ToolGroup.COMM))

        /* ---------------- agent-control：子代理 ---------------- */
        put("list_agents", ro(ToolGroup.DELEGATE))
        put("list_subagent_models", ro(ToolGroup.DELEGATE))
        put("send_message", safe(ToolGroup.DELEGATE))
        put("interrupt_agent", rw(ToolGroup.DELEGATE))
        put("ralph", safe(ToolGroup.DELEGATE))
        put("subagent_fork", safe(ToolGroup.DELEGATE))
        put("workflow", safe(ToolGroup.DELEGATE))

        /* ---------------- compat：lsp / mcp / 浏览器 / 团队 ---------------- */
        put("lsp", ro(ToolGroup.SEARCH))
        put("list_mcp_resources", ro(ToolGroup.PLUGIN))
        put("list_mcp_resource_templates", ro(ToolGroup.PLUGIN))
        put("read_mcp_resource", ro(ToolGroup.PLUGIN))
        put("stagehand_navigate", rw(ToolGroup.WEB))
        put("stagehand_observe", ro(ToolGroup.WEB))
        put("stagehand_extract", ro(ToolGroup.WEB))
        put("stagehand_act", rw(ToolGroup.WEB))
        put("stagehand_screenshot", ro(ToolGroup.WEB))
        put("stagehand_tabs", ro(ToolGroup.WEB))
        put("spawn_teammate", safe(ToolGroup.DELEGATE))
        put("team_task_create", safe(ToolGroup.DELEGATE))
        put("team_task_get", ro(ToolGroup.DELEGATE))
        put("team_task_list", ro(ToolGroup.DELEGATE))
        put("team_task_update", safe(ToolGroup.DELEGATE))
        put("wait_agent", safe(ToolGroup.DELEGATE))
        // 团队全景：成员 + 任务板 + 预算。只读，可进并发池
        put("team_status", ro(ToolGroup.DELEGATE))
        put("create_worktree", rw(ToolGroup.SHELL))
        put("load_workspace_dependencies", ro(ToolGroup.PLUGIN))

        /* ---------------- computer-use：手机操控 ---------------- */
        put("screen_read", ro(ToolGroup.DEVICE))
        put("phone_screenshot", ro(ToolGroup.DEVICE))
        put("phone_wait", ro(ToolGroup.DEVICE))
        put("phone_foreground", ro(ToolGroup.DEVICE))
        put("phone_list_apps", ro(ToolGroup.DEVICE))
        put("phone_app_info", ro(ToolGroup.DEVICE))
        put("phone_notifications", ro(ToolGroup.DEVICE))
        // 只改自家悬浮窗的可见性/文案，不碰设备与应用状态 → 只读档
        put("phone_island", ro(ToolGroup.DEVICE))
        put("phone_tap", rw(ToolGroup.DEVICE))
        // 批量动作本质是多次写操作，必须 rw：只读档要直接拒绝，不能靠「名字看起来像读」
        put("phone_batch", rw(ToolGroup.DEVICE))
        put("phone_long_press", rw(ToolGroup.DEVICE))
        put("phone_swipe", rw(ToolGroup.DEVICE))
        put("phone_scroll", rw(ToolGroup.DEVICE))
        put("phone_scroll_until", rw(ToolGroup.DEVICE))
        put("phone_gesture", rw(ToolGroup.DEVICE))
        put("phone_drag", rw(ToolGroup.DEVICE))
        put("phone_pinch", rw(ToolGroup.DEVICE))
        put("phone_type", rw(ToolGroup.DEVICE))
        put("phone_set_text", rw(ToolGroup.DEVICE))
        put("phone_clear_text", rw(ToolGroup.DEVICE))
        put("phone_ime_enter", rw(ToolGroup.DEVICE))
        put("phone_form_fill", rw(ToolGroup.DEVICE))
        put("phone_toggle", rw(ToolGroup.DEVICE))
        put("phone_clipboard", rw(ToolGroup.DEVICE, Risk.DESTRUCTIVE))
        put("phone_key", rw(ToolGroup.DEVICE))
        put("phone_volume", rw(ToolGroup.DEVICE))
        put("phone_media", rw(ToolGroup.DEVICE))
        put("phone_open_app", rw(ToolGroup.DEVICE))
        put("phone_launch", rw(ToolGroup.DEVICE))

        /* ---------------- preset-tools：代码运行时与内核检查 ---------------- */
        // run_code 能读写文件、能发请求，等价于 bash 的风险等级
        put("run_code", rw(ToolGroup.SHELL, Risk.DESTRUCTIVE))
        put("cordis_inspect_list", ro(ToolGroup.PLUGIN))
        put("cordis_inspect_query", ro(ToolGroup.PLUGIN))
        put("plugin_manager", rw(ToolGroup.PLUGIN))
        put("plugin_market", rw(ToolGroup.PLUGIN))

        /* ---------------- plugin-builder：自造插件 ---------------- */
        put("plugin_spec", ro(ToolGroup.PLUGIN))
        put("plugin_create", rw(ToolGroup.PLUGIN))
        put("plugin_install", rw(ToolGroup.PLUGIN))
        put("plugin_uninstall", rw(ToolGroup.PLUGIN, Risk.DESTRUCTIVE))
        put("plugin_list", ro(ToolGroup.PLUGIN))

        /* ---------------- memory ---------------- */
        put("memory_save", safe(ToolGroup.MEMORY))
        put("memory_search", ro(ToolGroup.MEMORY))
        put("memory_list", ro(ToolGroup.MEMORY))
        put("memory_forget", safe(ToolGroup.MEMORY))
        put("memory_update", safe(ToolGroup.MEMORY))
        // 清空整库是不可逆的：可执行，但不在只读模式下放行
        put("memory_clear", rw(ToolGroup.MEMORY, Risk.DESTRUCTIVE))

        /* ---------------- 表达：表情 / 语音 ---------------- */
        put("sticker_list", ro(ToolGroup.COMM))
        // sticker_look 内部会调视觉模型并写库（补描述），不是只读：让它走串行屏障，
        // 否则会被当只读工具扔进并发池，30s 超时抛异常会毁掉整批工具结果
        put("sticker_look", rw(ToolGroup.COMM))
        put("sticker_use", safe(ToolGroup.COMM))
        put("sticker_save", safe(ToolGroup.COMM))
        put("sticker_remove", safe(ToolGroup.COMM))
        put("speak", safe(ToolGroup.COMM))

        /* ---------------- 媒体生成 ---------------- */
        put("image_generate", rw(ToolGroup.MEDIA))
        put("video_generate", rw(ToolGroup.MEDIA))
        put("chart_generate", rw(ToolGroup.MEDIA))   // 数据图表（SVG，纯本地渲染）
        put("qr_generate", rw(ToolGroup.MEDIA))      // 二维码（SVG/PNG）
        put("mindmap_generate", rw(ToolGroup.MEDIA)) // 思维导图（SVG，纯本地渲染）
        put("flowchart_generate", rw(ToolGroup.MEDIA)) // 流程图（SVG，纯本地渲染）
        // 生成端点探测：只读（校验错误驱动的契约学习，不改用户资产）
        put("probe_gen_endpoint", ro(ToolGroup.MEDIA))
        put("probe_image_endpoint", ro(ToolGroup.MEDIA))

        /* ---------------- 系统提醒 ---------------- */
        put("notify", safe(ToolGroup.COMM))

        /* ---------------- 手机媒体：系统相册 / 下载 / 采集 / 分享 ---------------- */
        put("gallery_read", ro(ToolGroup.DEVICE))
        put("gallery_save", rw(ToolGroup.DEVICE))
        put("file_import", rw(ToolGroup.FS))
        put("file_export", rw(ToolGroup.FS))
        put("photo_capture", rw(ToolGroup.DEVICE))
        put("transcribe", rw(ToolGroup.DEVICE))
        // 分享不改动用户资产（和 present 同级）：只读权限/计划模式下也要能交出去
        put("share_file", safe(ToolGroup.COMM))

        /* ---------------- 闹钟/定时：落系统时钟（schedule_* 只管应用内） ---------------- */
        put("alarm_set", rw(ToolGroup.SCHEDULE))
        put("timer_set", rw(ToolGroup.SCHEDULE))

        /* ---------------- 手机状态：电量/存储/网络/定位 ---------------- */
        put("device_info", ro(ToolGroup.DEVICE))
        put("location_get", ro(ToolGroup.DEVICE))

        /* ---------------- 个人数据：日历/联系人（敏感，默认不进档位，overrides 手动加白） ---------------- */
        put("calendar_read", ro(ToolGroup.SCHEDULE))
        put("calendar_create", rw(ToolGroup.SCHEDULE))
        put("contacts_search", ro(ToolGroup.COMM))

        /* ---------------- 造 App：脚手架 / 手机内打包 / 安装 ----------------
           这一组曾经漏登记（M6/M8/M9 只加了插件、忘了加目录），后果是它们落进
           `fallback`：按写操作对待 —— 安全上没错，但分组/风险/工具计数全都不认识它们，
           六维评分里也就看不到这三个工具。v4 复评核对时补上。 */
        put("app_new", rw(ToolGroup.EDIT))          // 生成工程骨架（写工作区）
        put("app_build", rw(ToolGroup.SHELL))       // aapt2/ecj/d8/apksigner：写产物
        // 装应用会改变设备上的软件状态，但落地上必须用户点系统安装弹窗，这里按 MUTATE
        // 而不是 DESTRUCTIVE —— 否则平台侧再叠一次高危确认，等于同一件事问两遍。
        put("app_install", rw(ToolGroup.DEVICE))
    }

    /** 未登记工具使用的中性默认：按写操作对待（保守优先），但仍能执行 */
    private val fallback = ToolMeta(ToolGroup.PLUGIN, readOnly = false, alwaysAllowed = false, risk = Risk.MUTATE)

    /** 运行时 MCP 工具的公共名字前缀（与桌面 `mcp__<server>__<raw>` 同名约定）。 */
    const val MCP_PREFIX = "mcp__"

    /**
     * 运行时登记（外部清单插件 / Agent 自造插件 / 运行时发现的 MCP 工具）。
     *
     * **风险分类不由登记方声明。** 早先清单可以自带 `readOnly: true` 直接拿到只读身份，
     * 而它的处理器是 `sh -c` —— 结果是只读会话能执行任意命令。现在一律按写操作对待：
     * 要成为只读，只能进编译期 [table] 并经过人工复核，没有任何运行时自助通道。
     */
    private val dynamic = java.util.concurrent.ConcurrentHashMap<String, ToolMeta>()

    fun registerDynamic(name: String, group: ToolGroup = ToolGroup.PLUGIN) {
        if (name.isBlank() || name in table) return
        dynamic[name] = ToolMeta(group, readOnly = false, risk = Risk.MUTATE)
    }

    fun unregisterDynamic(name: String) {
        dynamic.remove(name)
    }

    /**
     * MCP 工具的兜底分类。桌面 mcp-client 同样是 `tools/list` 之后才注册工具，
     * 公共名字形如 `mcp__<server>__<raw>`。远端工具有没有副作用不可静态判定，
     * 因此按可写对待：只读/计划模式下宁可不放行，也不冒险当成只读。
     */
    private fun mcpFallback(name: String): ToolMeta? =
        if (name.startsWith(MCP_PREFIX) && name.length > MCP_PREFIX.length) {
            ToolMeta(ToolGroup.PLUGIN, readOnly = false, risk = Risk.MUTATE)
        } else null

    fun of(name: String): ToolMeta = table[name] ?: dynamic[name] ?: mcpFallback(name) ?: fallback

    fun isReadOnly(name: String): Boolean = of(name).readOnly

    fun allowedWithoutWrite(name: String): Boolean = of(name).allowedWithoutWrite

    fun risk(name: String): Risk = of(name).risk

    fun groupOf(name: String): ToolGroup = of(name).group

    /** 只读工具名（供并发池与计划模式使用）；顺序稳定 */
    fun readOnlyNames(): List<String> =
        table.filterValues { it.readOnly }.keys.toList() +
            dynamic.filterValues { it.readOnly }.keys.toList()

    /** 启动自检：返回未登记的工具名，调用方负责记日志（不阻断加载） */
    fun validate(registered: Collection<String>): List<String> =
        // `mcp__*` 有通配兜底（运行时才发现的外部工具），不算「忘了登记」
        registered.filter { it !in table && !dynamic.containsKey(it) && mcpFallback(it) == null }

    /** 已登记但内核里根本没有的工具（插件被禁用/改名后留下的死条目） */
    fun orphans(registered: Collection<String>): List<String> =
        table.keys.filter { it !in registered }

    fun size(): Int = table.size
}
