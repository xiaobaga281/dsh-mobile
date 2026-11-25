package ai.deepseek.harness.mobile.agent

import ai.deepseek.harness.mobile.kernel.ToolKernel
import ai.deepseek.harness.mobile.kernel.agents.AgentRegistry
import ai.deepseek.harness.mobile.kernel.agents.SubagentCapacity
import org.json.JSONArray
import org.json.JSONObject

/**
 * 子智能体执行器 —— 把原来长在 [AgentDriver] 里的 `runSubagent` 抽出来，
 * 让「主 Agent 派子代理」和「teammate 派子代理」共用同一条路径。
 *
 * 与桌面的对应关系：
 *   · `delegationDepth`：主 Agent 0，子 = 父 + 1；`maxDepth` 之外不再给 `subagent` schema
 *   · `maxActiveSubagents`：按 root 会话计数的容量池，满了**拒绝**而不是排队
 *     （排队会让「父占槽等子」变成死锁）
 *
 * 桌面的 `subagent` 工具对**任何**有该工具的 Agent 都可用，深度由运行时裁决；
 * 手机端同样不在工具层写死「子代理不能再派」，而是按当前深度动态决定给不给 schema ——
 * 不给 schema 只是省 token，真正的边界在 [run] 开头的深度检查。
 */
internal class SubagentRunner(
    private val kernel: ToolKernel,
    private val hooks: HookBus,
    private val log: (String) -> Unit,
) {

    private val pipeline = ToolPipeline(kernel.registry, kernel.workspace, hooks, log)
    private val compactor = Compactor(log)
    private val assembler = PromptAssembler(hooks, log)

    /**
     * 跑一个子智能体并返回它的最终文本。
     *
     * @param parentCfg 父 Agent 的配置（`delegationDepth` 是父的深度）
     * @param existing 已注册的 agent 条目：teammate 冷恢复时传进来
     * @param cancelled 父级的取消信号（用户点了停止 / teammate 被中断）
     */
    fun run(
        parentCfg: AgentConfig,
        task: String,
        maxRounds: Int,
        onStep: (String, Int, String) -> Unit,
        /** 子代理自己的工具运行时；由调用方给（主 Agent 与会话级工具在各层里不一样） */
        runtimeFactory: (AgentConfig, String, String) -> ToolPipeline.RuntimeTools,
        existing: AgentRegistry.Agent? = null,
        cancelled: () -> Boolean = { false },
    ): String {
        val limits = kernel.subagentLimits
        val childDepth = parentCfg.delegationDepth + 1
        if (childDepth > limits.maxDepth) {
            return "子智能体未启动：递归深度已达上限 ${limits.maxDepth} 层" +
                "（主 Agent 算第 0 层）。要更深请在 设置 → 智能体团队 → 最大递归深度 调大。"
        }
        val root = parentCfg.rootSessionId.ifBlank { parentCfg.sessionId }
        if (!SubagentCapacity.tryAcquire(root, limits.maxParallel)) {
            return "子智能体未启动：并行已达上限 ${limits.maxParallel}" +
                "（同一主 Agent 下所有层级的存活子智能体合计）。等一个跑完再派。"
        }
        try {
            return runAdmitted(
                parentCfg, childDepth, limits.canDelegate(childDepth), task, maxRounds, onStep,
                runtimeFactory, existing, cancelled,
            )
        } finally {
            SubagentCapacity.release(root)
        }
    }

    private fun runAdmitted(
        parentCfg: AgentConfig,
        childDepth: Int,
        canNest: Boolean,
        task: String,
        maxRounds: Int,
        onStep: (String, Int, String) -> Unit,
        runtimeFactory: (AgentConfig, String, String) -> ToolPipeline.RuntimeTools,
        existing: AgentRegistry.Agent?,
        cancelled: () -> Boolean,
    ): String {
        // 子代理可用不同模型/端点（subagentModel 为空则完全跟随父级，行为与以前一致）
        val subBase = parentCfg.subagentUrl.ifBlank { parentCfg.baseUrl }
        val subKey = parentCfg.subagentKey.ifBlank { parentCfg.apiKey }
        val sub = LlmClient(subBase, subKey, log)
        val agent = existing ?: kernel.agents.register("subagent", task, parentCfg.sessionId)
        fun done(text: String): String {
            kernel.agents.finish(agent, "done", text.take(400))
            return text
        }
        // 子代理继承父轮的预设白名单（桌面 subagent 继承 preset 组合的等价做法）
        val allow = Presets.byId(parentCfg.preset).allow
        val blocked = buildSet {
            add("exit_plan_mode"); add("ralph"); add("workflow"); add("subagent_fork")
            // 深度用完就摘掉 subagent：省 token，也让模型不会去试一个注定被拒的调用
            if (!canNest) add("subagent")
            // 桌面只有 Team 成员才拿得到团队工具；普通子代理不是成员，给了会让它
            // 以 lead 的身份改任务板（TeamCall 默认 caller=lead）
            addAll(TEAM_TOOLS)
        }
        val tools = pipeline.visibleTools(false, false)
            .filter { it in allow && it !in blocked }
            // 目录大小跟设置里的「上下文窗口」走（与主对话同一个口径）：小窗口下 165 个
            // schema 本身就超窗，子代理每一发都被端点 400 掉 —— 用户看到的正是「处理失败」。
            .let { list ->
                val core = Presets.catalogFor(parentCfg.contextWindow)
                    ?: return@let list
                val dynamic = kernel.registry.dynamicToolNames()
                list.filter { it in core || it in dynamic }
            }
        val system = AgentLoop.system(assembler, parentCfg, tools, kernel.workspace.rootPath)
        val subCtx = assembler.assembleContext(parentCfg, emptyList(), kernel.workspace.rootPath, subagent = true)
        val messages = mutableListOf<JSONObject>()
        messages.add(JSONObject().put("role", "system").put("content", system))
        if (subCtx.isNotBlank()) messages.add(JSONObject().put("role", "user").put("content", subCtx))
        messages.add(JSONObject().put("role", "user").put("content", task))
        val schemas = kernel.schemas().let { all ->
            JSONArray().apply {
                for (i in 0 until all.length()) {
                    val s = all.optJSONObject(i) ?: continue
                    if (s.optString("name") in tools) put(s)
                }
            }
        }
        val defs = LlmClient.toolDefs(schemas)
        // 上限放宽到 40：手机上派子代理常常要读多个文件/多步核对，8 轮很容易半途截断
        val rounds = maxRounds.coerceIn(1, 40)
        // 子代理自己的工具执行上下文：深度 +1，这样它再派子代理时能算出正确的层级
        val childCfg = parentCfg.copy(
            delegationDepth = childDepth,
            // 模型分档：给了 subagentModel 就用它（工人档），否则跟随父级
            model = parentCfg.subagentModel.ifBlank { parentCfg.model },
        )
        var last = ""
        var sawReasoning = false
        // 上下文预算与主对话同口径：设置里的「上下文窗口」先扣掉工具目录
        // （每个 schema 约 110 token），剩下的才是历史可用量；超了就压 ——
        // 子代理动辄几十轮，不压必然超窗，端点直接 400。
        val effWindow = AgentRequest.effWindow(childCfg.contextWindow, defs?.length() ?: 0)
        val contextStart = messages.size
        for (r in 1..rounds) {
            if (cancelled()) { kernel.agents.finish(agent, "interrupted", last); return last.ifBlank { "子智能体被中断" } }
            if (agent.cancelled) { kernel.agents.finish(agent, "interrupted", last); return last.ifBlank { "子智能体已被用户中断" } }
            // send_message 投递的消息在轮边界认领
            val inbox = agent.drainInbox()
            if (inbox.isNotEmpty()) {
                inbox.forEach { messages.add(JSONObject().put("role", "user").put("content", "（中途补充）$it")) }
                onStep("认领 ${inbox.size} 条补充消息", r, "")
            }
            if (r > 1) {
                val cr = compactor.compactInTurn(
                    llm = sub, model = childCfg.model, system = system,
                    messages = messages, keepFrom = contextStart,
                    contextWindow = effWindow, maxOut = childCfg.maxOut,
                    mode = childCfg.compactMode,
                )
                if (cr.shrunk) {
                    messages.clear()
                    messages.addAll(cr.messages)
                    log("subagent 压缩: ${cr.beforeTokens} → ${cr.afterTokens} tokens")
                }
            }
            // 不再往步骤树里写「第 r/rounds 轮推理」：轮数是内核的循环计数，用户点名撤掉
            // 那张轮数卡片；这一轮真的做了什么，由下面的工具调用那几行说。
            // 请求体统一由 AgentRequest.body 生成：预算（childCfg.maxOut）照设置那一档，
            // 不再另压 4096 —— 推理型模型会把预算全花在「想」上，压了就等于永远没结论。
            val body = AgentRequest.body(childCfg.model, messages, childCfg.maxOut, defs)
            val result = try {
                sub.stream(body, onDelta = {}, onReasoning = {})
            } catch (e: LlmClient.LlmError) {
                kernel.agents.finish(agent, "failed", e.message ?: "")
                return "子智能体失败：${e.message}"
            }
            if (result.text.isNotBlank()) last = result.text
            if (result.reasoning.isNotBlank()) sawReasoning = true
            if (result.toolCalls.isEmpty()) break
            // 循环骨架与团队成员共用 AgentLoop.execCalls：assistant 消息、参数解析、
            // 逐条执行、tool 消息都由那一份管；这一趟只交「步骤树要写什么」和闸门。
            AgentLoop.execCalls(
                pipeline, result.toolCalls, result.text, messages,
                // 子代理的闸门原样继承父轮，不放宽（桌面 child-agent：子级范围派出时定死）：
                // 以前这里硬编码 (planMode=false, planApproved=true) —— 父会话还在计划模式，
                // 派出去的子代理就能写盘；权限也没合 Mission 收窄。
                ToolPipeline.Gate(
                    kernel.missions.effectivePermissionFor(childCfg.permission, childCfg.missionId),
                    childCfg.planMode,
                    childCfg.planApproved,
                    childCfg.needConfirm,
                ),
                runtimeFactory(childCfg, "sub", parentCfg.sessionId),
                // 与发给模型的目录同一份判据：小窗口下被裁掉的工具，子代理调它就给结构化拒绝
                tools.toSet(),
                parentCfg.sessionId,
                cancelled = cancelled,
                onStart = { c, args -> onStep("${c.name} ${toolMeta(c.name, args)}", r, c.name) },
            )
        }
        return done(last.ifBlank {
            // 想完了但没说话 ≠ 模型坏了：把原因说清楚，用户才知道去调「最大输出」或关思考
            if (sawReasoning) "子智能体只产出了思考，没有结论：输出预算被思考占满（调大设置里的「最大输出」，或给这一档关掉思考）"
            else "子智能体没有产出结论"
        })
    }

    private fun toolMeta(name: String, args: JSONObject): String {
        val path = args.optString("file_path").ifBlank { args.optString("path") }
        if (path.isNotBlank()) return path.take(80)
        val cmd = args.optString("command")
        if (cmd.isNotBlank()) return cmd.take(80)
        val subject = args.optString("subject")
        if (subject.isNotBlank()) return subject.take(60)
        return ""
    }

    companion object {
        /** 普通子代理不是 Team 成员，桌面不会给它团队工具 */
        private val TEAM_TOOLS = setOf(
            "spawn_teammate", "send_message", "list_agents", "wait_agent", "interrupt_agent",
            "team_task_create", "team_task_list", "team_task_get", "team_task_update", "team_status",
        )
    }
}
