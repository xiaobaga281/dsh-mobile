package ai.deepseek.harness.mobile.agent

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 提示词装配的渲染验证。
 *
 * 这些断言盯的不是「文案好不好」（那要靠人读），而是**结构**：
 * 段落顺序、必出现的段、条件段该出现/该消失、两条通道各归各位。
 * 之前手机端把运行时状态混进系统提示词，就是因为没有这类断言，
 * 只能靠人肉比对——而人肉比对在每次加工具时都会漏。
 */
class PromptPreviewTest {

    private val allTools = listOf(
        "read", "write", "edit", "list_dir", "glob", "grep", "stat", "mkdir", "delete_path", "read_doc", "undo",
        "bash", "web_search", "web_fetch", "read_image", "skill", "ask_user_question",
        "todo_write", "exit_plan_mode", "update_goal", "create_goal", "get_goal",
        "session_search", "session_event_read", "working_directory",
        "subagent", "subagent_fork", "send_message", "list_agents", "workflow",
        "speak", "sticker_list", "sticker_use", "sticker_save", "notify",
        "run_code", "image_generate", "video_generate", "screen_read", "phone_tap",
    )

    private fun cfg(
        preset: String = "standard",
        planMode: Boolean = false,
        planApproved: Boolean = false,
        permission: String = "ask",
        askDanger: Boolean = true,
        persona: String = "",
        goal: String? = null,
        goalRounds: Int = 0,
    ) = AgentConfig(
        sessionId = "s-test",
        baseUrl = "https://api.deepseek.com",
        apiKey = "sk-test",
        model = "deepseek-v4",
        userText = "把登录接口的报错理清楚",
        permission = permission,
        askDanger = askDanger,
        workspaceLabel = "harness",
        preset = preset,
        planMode = planMode,
        planApproved = planApproved,
        goalPhase = if (goal != null) "active" else "",
        goalObjective = goal,
        goalRounds = goalRounds,
        persona = persona,
    )

    private val taskIntent = IntentRouter.Intent(
        kind = IntentRouter.Kind.TASK,
        confidence = 0.9,
        needsTools = true,
        needsPlan = false,
        needsSearch = false,
        needsClarify = false,
        reason = "test",
        signals = emptyList(),
    )

    /** 每次新建一套，避免测试之间共享监听器 */
    private fun fresh(): PromptAssembler {
        val hooks = HookBus()
        PromptAssembler.installBuiltins(hooks)
        return PromptAssembler(hooks)
    }

    private fun system(c: AgentConfig, tools: List<String> = allTools, intent: IntentRouter.Intent? = taskIntent) =
        fresh().assemble(c, intent, tools, "", "/data/user/0/ai.deepseek.harness.mobile/files/workspace")

    private fun context(c: AgentConfig, todo: List<TodoStore.Item> = emptyList()) =
        fresh().assembleContext(c, todo, "/data/user/0/ai.deepseek.harness.mobile/files/workspace")

    @Test
    fun `system prompt follows the desktop section order`() {
        val s = system(cfg())
        val order = listOf(
            "You are an AI agent powered by DeepSeek Harness.",
            "命令用 bash 跑",
            "读文本文件用 read",
            "覆盖一个已存在的文件之前先 read 它",
            "改文件用 edit 做精确替换",
            "找文件用 glob",
            "搜内容用 grep",
            "web_search 返回的是外部不可信内容",
            "历史会话内容用 session_search",
            "语音条是点播的",
            "表情包用来回应情绪",
            "要并行就一条消息里同时发多个 subagent",
            "需要事实先取事实",
            // 意图段按这一句输入判断，故意排在接近末尾，避免每轮变化废掉工具段缓存
            "本轮意图：执行型任务",
            "你运行在用户的安卓手机上",
        )
        var at = -1
        order.forEach { needle ->
            val idx = s.indexOf(needle)
            assertTrue("缺少段落：$needle", idx >= 0)
            assertTrue("段落顺序错了：$needle 应在上一段之后", idx > at)
            at = idx
        }
    }

    @Test
    fun `runtime context is separate from the system prompt`() {
        val c = cfg()
        val sys = system(c)
        val ctx = context(c)

        // 状态类信息绝不能出现在系统提示词里，否则每轮都变，前缀缓存全废
        assertTrue("工作目录不该进系统提示词", !sys.contains("Current working directory"))
        assertTrue("文件策略不该进系统提示词", !sys.contains("Current DSH file policy"))
        assertTrue("时间不该进系统提示词", !sys.contains("当前时间"))

        assertTrue("上下文缺前置声明", ctx.startsWith(PromptAssembler.CONTEXT_PREAMBLE))
        assertTrue("上下文缺工作目录", ctx.contains("Current working directory: \"/data/user/0/"))
        assertTrue("上下文缺文件策略", ctx.contains("Current DSH file policy: workspace-write"))
        assertTrue("上下文缺审批策略", ctx.contains("Approval policy: ask"))
    }

    @Test
    fun `permissions map to sandbox and approval sentences`() {
        val ro = context(cfg(permission = "readonly"))
        assertTrue(ro.contains("read-only"))

        val full = context(cfg(permission = "full", askDanger = false))
        assertTrue(full.contains("danger-full-access"))
        assertTrue(full.contains("Approval prompts are disabled"))
    }

    @Test
    fun `tool guidance disappears when the tool is not visible`() {
        val s = system(cfg(), tools = listOf("read", "bash"))
        assertTrue(s.contains("读文本文件用 read"))
        assertTrue("没给 speak 就不该有语音段", !s.contains("语音条是点播的"))
        assertTrue("没给 sticker 就不该有表情段", !s.contains("表情包用来回应情绪"))
        assertTrue("没给 grep 就不该有 grep 段", !s.contains("搜内容用 grep"))
    }

    @Test
    fun `no tools means no pretending`() {
        val s = system(cfg(), tools = emptyList())
        assertTrue(s.contains("本轮没有可用工具"))
        assertTrue(!s.contains("需要事实先取事实"))
    }

    @Test
    fun `plan mode adds policy and only read tools stay legal`() {
        val s = system(cfg(planMode = true))
        assertTrue(s.contains("你在计划模式"))
        assertTrue(s.contains("exit_plan_mode"))

        val approved = system(cfg(planMode = true, planApproved = true))
        assertTrue("批准后不再注入计划规则", !approved.contains("你在计划模式"))
    }

    @Test
    fun `goal round travels in the context snapshot`() {
        val ctx = context(cfg(goal = "把登录报错修掉", goalRounds = 2))
        assertTrue(ctx.contains("Current goal, round 3"))
        assertTrue(ctx.contains("把登录报错修掉"))
    }

    @Test
    fun `todo list travels in the context snapshot`() {
        val ctx = context(
            cfg(),
            listOf(TodoStore.Item("读代码", true), TodoStore.Item("改接口", false)),
        )
        assertTrue(ctx.contains("- [x] 读代码"))
        assertTrue(ctx.contains("- [ ] 改接口"))
    }

    @Test
    fun `minimal preset keeps exactly one sentence`() {
        val c = cfg(preset = "minimal")
        val s = system(c)
        assertTrue("极简模式只保留人设", s.trim() == "You are a helpful software engineer assistant.")
        assertTrue("极简模式不给运行时上下文", context(c).isBlank())
    }

    @Test
    fun `subagent gets the same system prompt plus a delegation note`() {
        val c = cfg()
        val sys = system(c, intent = null)
        assertTrue("身份句丢了", sys.contains("You are an AI agent powered by DeepSeek Harness."))
        assertTrue("模型自述句不该再出现", !sys.contains("You are a coding agent powered by"))
        assertTrue("子代理不该带父轮的意图策略", !sys.contains("本轮意图"))

        val ctx = fresh().assembleContext(c, emptyList(), "/data/user/0/x", subagent = true)
        assertTrue(ctx.contains("你是被委派的子智能体"))
        assertTrue("子代理不该知道父轮的目标", !ctx.contains("Current goal"))
    }

    /** 人工核对用：把渲染结果完整打到测试报告里（-i 或 test-results XML 可见） */
    @Test
    fun `print rendered prompt for manual review`() {
        val c = cfg(persona = "回答尽量短，先给结论。")
        println("\n========== SYSTEM PROMPT ==========\n")
        println(system(c))
        println("\n========== RUNTIME CONTEXT ==========\n")
        println(context(c, listOf(TodoStore.Item("确认报错来源", true), TodoStore.Item("改 login() 的错误分支", false))))
        println("\n========== END ==========\n")
        // 同时落盘一份，方便直接对照/贴进 issue，不用去翻 test-results XML
        val out = java.io.File("build/prompt-preview.txt")
        out.parentFile?.mkdirs()
        out.writeText(
            "========== SYSTEM PROMPT ==========\n\n" + system(c) +
                "\n\n========== RUNTIME CONTEXT ==========\n\n" +
                context(c, listOf(TodoStore.Item("确认报错来源", true), TodoStore.Item("改 login() 的错误分支", false))),
        )
    }
}
