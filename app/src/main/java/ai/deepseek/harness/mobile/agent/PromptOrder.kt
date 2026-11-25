package ai.deepseek.harness.mobile.agent

/**
 * 提示词段落与运行时上下文的**中央顺序表**。
 *
 * 对应桌面 `packages/core/system-prompt/src/index.ts` 里的 `SECTION_ORDERS`
 * 与 `CONTEXT_ORDERS`：数值、名字、归位方式都照抄，手机端独有的段插在
 * 语义相邻的位置并留出空档（10 的倍数之间还有余量）。
 *
 * 为什么必须有这张表：桌面把所有段的落点集中在一个常量对象里，任何插件要加一段
 * 都写 `getSectionOrder('TOOL_XXX')`，而不是自己编一个魔法数字。散落的数字迟早会
 * 撞车 —— 一旦两段同序，输出顺序就取决于注册先后，提示词结构随机漂移，而且没人
 * 能一眼看出「这段到底在第几」。手机端此前正是散落的（120/110/100/80/60…），
 * 现在收敛到这里。
 *
 * 两类通道的分工（与桌面一致）：
 *   - **section**：静态、随部署或模式变化的内容，拼进 system 角色的系统提示词，
 *     `\n\n` 连接。相对稳定，可被前缀缓存。
 *   - **context**：每轮都可能变的状态（工作目录、权限、目标、待办、记忆），
 *     走**独立的运行时上下文快照**，放在历史之后、当前用户消息之前。桌面这么做是
 *     为了让系统提示词保持稳定的缓存前缀，不必因为「目标第几轮」重写整段 system。
 */
object PromptOrder {

    /* ---------------- section：系统提示词 ---------------- */

    /** 身份句。恒在第一段，不随预设与模式变化（桌面 `harness:identity`） */
    const val HARNESS_IDENTITY = -1000

    /**
     * 部署人设前缀（桌面 `deployment:persona-prefix`）。
     * 内容来自预设的 `personaPrefix`，`{{model}}` 在装配时替换成实际模型名。
     */
    const val DEPLOYMENT_PERSONA_PREFIX = 0

    /** 计划模式规则（桌面 `plan:policy`） */
    const val PLAN_POLICY = 500

    /** 团队协作规则（桌面 `team:policy`） */
    const val TEAM_POLICY = 600

    /** 纯代码调用模式（桌面 `ptc:only`） */
    const val PTC_ONLY = 800

    /** 交付文件引用说明（桌面 `deliverable:file-references`） */
    const val DELIVERABLE_FILE_REFERENCES = 900

    /**
     * 意图策略（手机端独有：按这句话的类型调整回答方式）。
     *
     * 值故意取在工具段之后：意图是**按这一句用户输入**判断出来的，每轮都可能变。
     * 放在工具段之前的话，它一变后面全部段落的前缀缓存就废了；放到接近末尾，
     * 至少占提示词篇幅最大的工具指引还能命中。
     */
    const val INTENT_POLICY = 10050
    /* 工具指引段：桌面一个工具一段，手机端按能力域归并（工具 119 个，逐条会淹掉提示词） */

    const val TOOL_BASH = 1000
    const val TOOL_READ = 1100
    const val TOOL_WRITE = 1200
    const val TOOL_EDIT = 1300
    const val TOOL_GLOB = 1400
    const val TOOL_GREP = 1500
    const val TOOL_JOBS = 1600
    const val TOOL_PTY = 1700
    const val TOOL_WEB_SEARCH = 2000
    const val TOOL_WEB_FETCH = 2100
    const val TOOL_LSP = 2200
    const val TOOL_SESSION_QUERY = 2300
    const val TOOL_GOAL = 2400

    /** 手机端独有：语音条使用纪律 */
    const val TOOL_SPEECH = 2500

    /** 手机端独有：表情包使用纪律 */
    const val TOOL_STICKER = 2510

    const val TOOL_WORKFLOW = 2600
    const val TOOL_SUBAGENT = 2800
    const val TOOL_COMPUTER_USE = 3000

    /** 手机端独有：无障碍操控约束（桌面 computer-use 的等价物） */
    const val TOOL_DEVICE = 3050

    const val MCP_SERVERS = 3100

    /** 手机端独有：系统提醒（长任务完成、定时到点） */
    const val TOOL_NOTIFY = 3150

    /** 手机端独有：长期记忆的手动通道 */
    const val TOOL_MEMORY = 3160

    /** 技能目录（桌面渐进披露：只给名字与一句说明，正文靠 skill 工具加载） */
    const val SKILLS_CATALOG = 6000

    /** 工具使用总则（手机端补充：工具描述短，横切纪律集中说一次） */
    const val TOOLS_SDK = 5000

    const val STRUCTURED_OUTPUT = 9900

    /** 手机形态约束（对应桌面 `web:surface` 的落点） */
    const val MOBILE_SURFACE = 10100

    /** 部署方自定义后缀，恒在最后（桌面 `deployment:persona-suffix`） */
    const val DEPLOYMENT_PERSONA_SUFFIX = 10200

    /* ---------------- context：运行时上下文快照 ---------------- */

    const val CTX_WORKING_DIRECTORY = 100
    const val CTX_SANDBOX_POLICY = 110
    const val CTX_APPROVAL_POLICY = 115

    /** 交付规则：手机端没有文件路径可点，present 卡片是用户拿到产物的唯一入口 */
    const val CTX_DELIVERABLE_POLICY = 118

    /** 子智能体权限边界（桌面 `subagent:delegation`） */
    const val CTX_SUBAGENT_DELEGATION = 120

    /** 团队成员身份（桌面 `team:identity`） */
    const val CTX_TEAM_IDENTITY = 125

    /** 目标推进状态（桌面走 session projection，手机端每轮重算，落在这里） */
    const val CTX_GOAL_STATE = 130

    /** 待办清单 */
    const val CTX_TODO_STATE = 135

    /** 记忆（用户明确要求长期记住的偏好与事实） */
    const val CTX_MEMORY = 140

    const val CTX_HARNESS_SOURCE = 200

    /** 设备当前时间（桌面没有这一段；手机端用户时区强相关，且每轮都变，必须走上下文） */
    const val CTX_CLOCK = 190

    const val CTX_DEVICE_SURFACE = 210

    /* ---------------- 优先级换算 ---------------- */

    /**
     * [HookBus] 按 priority **降序**执行，桌面按 order **升序**拼接。
     * 这里做一次单调映射，让两边的心智模型统一：写段落时只看 order，不用记反向。
     */
    private const val PRIORITY_BASE = 20_000

    fun priorityOf(order: Int): Int = PRIORITY_BASE - order

    /** 插件贡献段：排在所有内置段之后（桌面插件段没有固定 order，落在末尾） */
    const val PLUGIN_TAIL = 1
}
