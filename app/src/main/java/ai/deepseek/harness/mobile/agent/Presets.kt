package ai.deepseek.harness.mobile.agent

/**
 * Agent 预设 —— 桌面 Harness「Agent 预设」四个内置模式的手机端移植。
 *
 * 权威来源（逐行核对，不臆造）：
 *   - packages/bundle/web-app/presets/standard.patch.yml   （标准模式，order 1，新任务默认）
 *   - packages/bundle/web-app/presets/ptc.patch.yml        （PTC 模式，order 2，agent-tool-presentation mode:ptc）
 *   - packages/bundle/web-app/presets/minimal.patch.yml    （极简模式，order 3，persona complete + 仅图片读取与常驻终端）
 *   - packages/bundle/web-app/presets/cordis.patch.yml     （创造模式，order 4，tool-cordis + plugin_manager/market）
 *   - packages/client/ui-agent-preset/src/client/locales.ts （展示名与描述的官方中文文案）
 *
 * 桌面用「preset 决定哪些子插件挂载」来圈定工具目录；手机端等价做法：
 * 内核全量装配插件（一切皆插件不变），preset 持有工具白名单，Driver 按
 * 白名单过滤模型可见目录 —— 效果与桌面「没挂载就看不到也调不了」一致。
 *
 * 手机端工具映射（桌面 → 安卓等价物）：
 *   tool-bash/pwsh/terminal → bash（本机 shell，走沙箱校验）
 *   tool-fs / tool-fs-search → read/write/edit/list_dir/glob/grep/stat
 *   tool-web → web_search / web_fetch
 *   tool-jobs/tool-schedule → 待后续插件（白名单先留空缺省不可见）
 *   agent-tool-presentation(ptc) → run_code（WebView JS 运行时，见 kernel/ptc/PtcRuntime）
 *   tool-cordis → cordis_inspect_list / cordis_inspect_query（只读内核检查）
 *   plugin-manager/tools / plugin-market/tools → plugin_manager / plugin_market
 */
data class AgentPreset(
    val id: String,
    val order: Int,
    val name: String,
    val description: String,
    /** persona 插件的 prefix（patch yml 原文；{{model}} 由 Driver 替换） */
    val personaPrefix: String,
    /** minimal 的 persona：complete=true、includeRuntimeContext=false */
    val personaComplete: Boolean = false,
    /** 模型可见工具白名单 */
    val allow: Set<String>,
) {
    fun persona(model: String): String = personaPrefix.replace("{{model}}", model)
}

object Presets {

    /**
     * 小窗口（<=12k）端点只挂核心工具。目录里上百个 schema 本身就上万 token，
     * 8k 的本地模型连一句「你好」都放不下 —— 这不是压缩能解决的，只能少给。
     */
    val CORE_TOOLS = setOf(
        "read", "write", "edit", "list_dir", "glob", "grep", "stat",
        "bash", "present", "todo_write", "ask_user_question",
        "exit_plan_mode", "update_goal", "web_search", "subagent",
        // 表情包是聊天本身的能力，不是「额外工具」：小窗口下也得有，
        // 否则 4k 端点里模型根本看不见它们，只能拿 read 去读一个叫 sticker_list 的文件。
        "sticker_list", "sticker_look", "sticker_use", "sticker_save", "sticker_remove",
    )

    /** 中窗口（<=32k）：核心 + 文档/任务/记忆/终端这类常有需求的能力 */
    val MID_TOOLS = CORE_TOOLS + setOf(
        "read_doc", "write_docx", "write_xlsx", "write_pptx", "write_pdf", "write_zip",
        "mkdir", "delete_path", "undo",
        "apply_patch", "str_replace_editor",
        "terminal_open", "terminal_list", "terminal_send", "terminal_read",
        "terminal_signal", "terminal_close",
        "job_list", "job_output", "job_kill",
        "session_search", "session_trace", "web_fetch", "read_image",
        "skill", "create_goal", "get_goal", "notify",
        "memory_save", "memory_search", "memory_list",
        "sticker_list", "sticker_look", "sticker_use", "sticker_save", "sticker_remove", "speak",
    )

    /**
     * 团队工具：装配了团队运行时就必须进目录，**不参与窗口裁剪**。
     *
     * 依据桌面 core/tools/src/index.ts:1212 —— 「本层注册不受 restrict 过滤」：团队工具是
     * 按 Agent 作用域装上去的，任何掩码都裁不掉它。手机端以前把 spawn_teammate 留在
     * CORE/MID 之外，于是设置里窗口 ≤32k（本地模型 8k/16k/32k 全在这档）时 Lead 的 schema
     * 里根本没有建队工具：模型只能嘴上说「我建了个队友」，实测跑 168 秒也没发出一次调用。
     * 少这一档 schema 换掉整个团队能力，不值。
     */
    val TEAM_TOOLS = setOf(
        "spawn_teammate", "send_message", "list_agents", "wait_agent", "interrupt_agent",
        "team_task_create", "team_task_list", "team_task_get", "team_task_update", "team_status",
    )

    /**
     * 按**设置里的上下文窗口**决定工具目录大小（null = 全量）。
     *
     * 主对话、子代理、团队成员必须同一个口径：只有一方裁剪，另外两方每一发都超窗 ——
     * 端点直接 400，用户看到的就是「子代理老是处理失败」。
     */
    fun catalogFor(contextWindow: Int): Set<String>? = when {
        contextWindow <= 12_288 -> CORE_TOOLS
        contextWindow <= 32_768 -> MID_TOOLS
        else -> null
    }


    private val FS = setOf(
        "read", "write", "edit", "list_dir", "glob", "grep", "stat", "mkdir", "delete_path",
        "read_doc", "write_docx", "write_xlsx", "write_pptx", "write_pdf", "write_zip", "undo",
        "move", "copy",
    )
    private val EDIT = setOf("str_replace_editor", "apply_patch", "present")
    private val BEHAVIOR = setOf(
        "exit_plan_mode", "update_goal", "create_goal", "get_goal", "todo_write",
        "web_search", "web_fetch", "http_request", "read_image", "skill", "ask_user_question",
    )
    private val SHELL = setOf("bash")
    /** 终端会话（桌面 minimal 的 persistent-shell 组；手机端所有非极简模式也可用） */
    private val TERMINAL = setOf(
        "terminal_open", "terminal_list", "terminal_read", "terminal_send", "terminal_signal", "terminal_close",
    )
    private val JOBS = setOf("job_list", "job_output", "job_kill")
    private val SCHEDULE = setOf("schedule_create", "schedule_update", "schedule_delete", "schedule_list")
    private val SESSIONQ = setOf(
        "session_event_read", "session_event_search", "session_event_trace",
        "session_search", "session_trace", "working_directory",
    )
    private val CONTROL = setOf(
        "subagent", "subagent_fork", "list_subagent_models", "ralph", "workflow",
    )

    /**
     * 智能体团队：桌面 experimental tool-agent-team 的九个工具 + team_status。
     *
     * list_agents / send_message / interrupt_agent 从 CONTROL 移过来 —— 它们现在的
     * 唯一实现是团队运行时（roster + inbox + 冷恢复），旧子代理控件已删。
     * 白名单里只能有一条，否则工具名冲突时后注册的会被 registry 静默跳过。
     */
    private val TEAM = setOf(
        "spawn_teammate", "send_message", "list_agents", "wait_agent", "interrupt_agent",
        "team_task_create", "team_task_list", "team_task_get", "team_task_update", "team_status",
    )
    /** 桌面里不属于四个预设、只在特定部署挂载的工具：手机端放在创造模式里可见可探 */
    private val COMPAT = setOf(
        "lsp", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
        "stagehand_navigate", "stagehand_act", "stagehand_extract", "stagehand_observe",
        "stagehand_screenshot", "stagehand_tabs",
        "pwsh", "create_worktree", "load_workspace_dependencies",
    )

    /**
     * 手机操控（桌面 computer-use 的手机端等价：无障碍服务运行时）。
     *
     * ⚠️ 依赖应用授权闸门（WP4b，`kernel/device/PhoneControlService` 的 per-package 授权）：
     * 这一组留在标准档，但**闸门不在这一层** —— 本文件只决定「模型看得见哪些工具」，
     * 不负责「能不能对某个应用动手」。在闸门落地前，标准档的 phone_* 等价于无确认操控，
     * 只应给信任的会话使用；只读档由 ToolCatalog（rw → 不可用）挡住写类操作。
     */
    private val DEVICE = setOf(
        // 观察
        "screen_read", "phone_screenshot", "phone_wait", "phone_foreground",
        // 指针类
        "phone_tap", "phone_long_press", "phone_swipe", "phone_scroll", "phone_scroll_until",
        "phone_gesture", "phone_drag", "phone_pinch",
        // 文本类
        "phone_type", "phone_set_text", "phone_clear_text", "phone_ime_enter", "phone_form_fill",
        "phone_toggle", "phone_clipboard",
        // 系统类
        "phone_key", "phone_notifications", "phone_volume", "phone_media",
        "phone_open_app", "phone_list_apps", "phone_app_info", "phone_launch",
    )

    /**
     * 桌面 standard 的子插件列表 + 手机端对「工具要挂载」的落地：
     * 除极简模式外，模型看到的工具目录 = 内核全部已启用工具（含结构化不可用的兼容工具）。
     * 桌面上这些工具由各自包按需挂载；手机端没有 bundle 级开关，于是让它们在目录里出现、
     * 缺后端时执行期给结构化原因——比「目录里没有」更符合「完整移植」的预期。
     */
    /**
     * run_code 放进标准白名单：它是这台设备上**唯一保证可用**的代码运行时
     * （WebView 自带的 V8，无需安装任何东西）。不给它，Agent 就只能靠拼工具干活。
     */
    /** 自造插件：写清单 → 当场装配成工具 → 随时卸载（创造模式的核心能力，标准模式也给） */
    private val PLUGIN_BUILDER = setOf(
        "plugin_spec", "plugin_create", "plugin_install", "plugin_uninstall", "plugin_list",
    )

    /** 记忆：跨会话的偏好/约束，模型自己写、自己查（自动沉淀之外的手动通道） */
    private val MEMORY = setOf("memory_save", "memory_search", "memory_list", "memory_forget", "memory_update", "memory_clear")

    private val STICKERS = setOf("sticker_list", "sticker_look", "sticker_use", "sticker_save", "sticker_remove")

    /** 系统提醒：长任务完成 / 定时到点时主动叫用户（极简模式不给 —— 它连多轮目标都没有） */
    private val COMM = setOf("notify")

    /** 系统时钟插件：alarm_set / timer_set（schedule_* 只能应用内提醒，这里落到系统时钟） */
    private val ALARM = setOf("alarm_set", "timer_set")

    /** 手机状态插件：device_info / location_get（只读环境感知） */
    private val SYSINFO = setOf("device_info", "location_get")

    /** 装应用：把工作区里的 APK 交给系统安装器（手机没有 root，pm install 走不通） */
    // 造 App 三件套：脚手架 → 打包 → 安装（缺一个模型就卡在半路）
    private val APP_INSTALL = setOf("app_new", "app_build", "app_install")

    private val STANDARD = FS + EDIT + SHELL + TERMINAL + JOBS + SCHEDULE + SESSIONQ +
        CONTROL + TEAM + BEHAVIOR + COMPAT + DEVICE + PLUGIN_BUILDER + MEMORY + STICKERS + COMM +
        setOf("run_code", "image_generate", "video_generate", "speak",
            "chart_generate", "qr_generate", "mindmap_generate", "flowchart_generate",
            "probe_gen_endpoint", "probe_image_endpoint") +
        ALARM + SYSINFO + APP_INSTALL

    /** 手机媒体插件（P0）：系统相册 / 下载目录 / SAF 导入 */
    private val DEVICE_MEDIA = setOf("gallery_read", "gallery_save", "file_import", "file_export")

    /** 采集与分享插件（P1）：相机拍照 / 语音转写 / 系统分享面板 */
    private val CAPTURE = setOf("photo_capture", "transcribe", "share_file")

    /* 日历与联系人（calendar_read / calendar_create / contacts_search）故意**不进任何档位**：
     * 个人数据敏感度高于相册——想开的话由用户在 files/kernel/presets.json 的 overrides
     * 里手动加白（如 standard: {"add": ["calendar_read", "contacts_search"]}），重启生效。 */

    /** 内置四预设（顺序即桌面 order；standard 是新任务默认） */
    val builtins: List<AgentPreset> = listOf(
        AgentPreset(
            id = "standard",
            order = 1,
            name = "标准模式",
            // locales.ts presetStandardDescription 原文
            description = "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。",
            // 机型/模型自述句已按用户要求删除：人设前缀留空，提示词直接从身份句进入人设与工具段
            personaPrefix = "",
            allow = STANDARD + DEVICE_MEDIA + CAPTURE,
        ),
        AgentPreset(
            id = "ptc",
            order = 2,
            name = "PTC 模式",
            // locales.ts presetPtcDescription 原文
            description = "包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。",
            // 机型/模型自述句已按用户要求删除：人设前缀留空，提示词直接从身份句进入人设与工具段
            personaPrefix = "",
            // 桌面 agent-tool-presentation mode:ptc 的收口语义逐字对齐（tools/src/index.ts:672）：
            // 模型直接可见的工具只剩 run_code 一个，原生工具全部收进 run_code 的子调度
            // （SDK 目录由 Driver 生成、经 PromptAssembler 注入系统提示；callTool 不经白名单，
            // 与桌面「sub-dispatch keeps every visible tool」一致）。
            allow = setOf("run_code"),
        ),
        AgentPreset(
            id = "minimal",
            order = 3,
            name = "极简模式",
            // locales.ts presetMinimalDescription 原文
            description = "Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。",
            personaPrefix = "You are a helpful software engineer assistant.",
            personaComplete = true,
            // minimal.patch.yml：tool-fs 只留 readImage:true，其余 fs 工具全关；
            // persistent-shell 组给 bash + terminal_*；无目标/计划/委派/web/技能/提问/待办/jobs
            allow = setOf("read_image", "bash") + TERMINAL,
        ),
        AgentPreset(
            id = "cordis",
            order = 4,
            name = "创造模式",
            // locales.ts presetCordisDescription 原文
            description = "用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。",
            personaPrefix = "",
            // cordis.patch.yml：standard 全部能力 + tool-cordis + plugin_manager/plugin_market（profileContext 存在时启用）。
            // 注意：cordis patch 没有 agent-tool-presentation(ptc) 行，run_code 只属于 PTC 预设。
            allow = STANDARD + DEVICE_MEDIA + CAPTURE +
                setOf("cordis_inspect_list", "cordis_inspect_query",
                "plugin_manager", "plugin_market"),
        ),
    )

    const val DEFAULT_ID = "standard"

    /* ---------------- 档位的用户覆盖（可编辑 JSON） ----------------
     * files/kernel/presets.json（内核配置目录，不进模型可见的工作区）：
     * {
     *   "overrides": {
     *     "standard": { "add": ["gallery_read"], "remove": ["video_generate"] },
     *     "minimal":  { "add": ["write"] }
     *   }
     * }
     * 内置档位仍然在代码里（Presets.builtins），这份文件只做增删覆盖——
     * 改完重启应用生效；写坏 JSON 会被静默忽略（内置档位兜底，不会损坏会话）。
     */
    private val overrideAdds = mutableMapOf<String, Set<String>>()
    private val overrideRemoves = mutableMapOf<String, Set<String>>()

    /** 内核启动时读一次用户覆盖 */
    fun applyOverrides(file: java.io.File) {
        val root = runCatching { org.json.JSONObject(file.readText()) }.getOrDefault(org.json.JSONObject())
        val overrides = root.optJSONObject("overrides") ?: return
        for (key in overrides.keys()) {
            val o = overrides.optJSONObject(key) ?: continue
            fun setOfKey(k: String): Set<String>? = o.optJSONArray(k)?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotBlank() } }.toSet()
            }
            setOfKey("add")?.let { if (it.isNotEmpty()) overrideAdds[key] = it }
            setOfKey("remove")?.let { if (it.isNotEmpty()) overrideRemoves[key] = it }
        }
    }

    fun byId(id: String?): AgentPreset {
        val base = builtins.firstOrNull { it.id == id } ?: builtins.first()
        val add = overrideAdds[base.id]
        val rm = overrideRemoves[base.id]
        if (add.isNullOrEmpty() && rm.isNullOrEmpty()) return base
        return base.copy(allow = (base.allow + (add ?: emptySet())) - (rm ?: emptySet()))
    }

    fun names(): List<String> = builtins.map { it.name }
}
