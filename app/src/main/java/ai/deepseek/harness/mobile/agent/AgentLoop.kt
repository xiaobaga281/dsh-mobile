package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject

/**
 * 三条请求循环（Lead / 子代理 / 团队成员）共用的部分：取 system、跑一条工具、
 * 以及委派链路那一口气的循环骨架 [execCalls]。
 *
 * 与 [AgentRequest] 的分工：那里是纯数据（窗口/请求体），这里是需要运行时对象的两步。
 * 收在一处的理由和 1a 一样 —— 以前三条循环各写一遍，Gate 的审批语义、取消信号、
 * spill 分桶这些只有一处是对的，另外两处是抄的（这次的「委派链路不越权」就得改两处）。
 */
internal object AgentLoop {

    /**
     * 组装本轮 system。
     *
     * 子代理/成员没有意图路由与技能目录（传 null / 空串），Lead 有 —— 那是参数差异，
     * 不是另一套实现：模板、工作区、预设规则都走同一个 assembler。
     */
    fun system(
        assembler: PromptAssembler,
        cfg: AgentConfig,
        tools: List<String>,
        workspaceRoot: String,
        intent: IntentRouter.Intent? = null,
        skills: String = "",
    ): String = assembler.assemble(cfg, intent, tools, skills, workspaceRoot)

    /**
     * 跑一条工具调用并返回给模型的结果文本。
     *
     * 出口只有一个：审批 Gate、取消信号、spill 按会话分桶的语义都从调用方传入，
     * 但「单条调用 → 结果文本」的包装只在这里定义一次（没有结果时给结构化失败，
     * 不再各自拼一句人话）。
     */
    /**
     * 跑一条工具调用，返回**完整的 Outcome**（成败 + 输出 + 结构化码）。
     *
     * 三条循环都必须从这里取 `ok`，而不是拿输出文本再解析一次：工具的成功输出
     * 常常是纯文本（`exit=0 Alarms DCIM…`、`已写入 notes/a.md（41 字节）`），
     * `JSONObject(text).optBoolean("ok")` 对它们只能给 false ——
     * 实测队友三条全部成功的命令在成员视图里都显示「执行失败」（用户报的「成员调工具老是失败」）。
     */
    fun execOutcome(
        pipeline: ToolPipeline,
        call: ToolPipeline.Call,
        gate: ToolPipeline.Gate,
        runtime: ToolPipeline.RuntimeTools,
        cancelled: () -> Boolean,
        sessionId: String?,
        catalog: Set<String>? = null,
    ): ToolPipeline.Outcome =
        pipeline.executeBatch(listOf(call), gate, runtime, cancelled = cancelled, sessionId = sessionId,
            catalog = catalog)
            .firstOrNull()
            ?: ToolPipeline.Outcome(
                call.id, call.name, false,
                """{"ok":false,"code":"NO_TOOL_RESULT","error":"工具没有返回结果"}""", 0,
                code = "NO_TOOL_RESULT",
            )

    /**
     * 「模型出了一口气 + 它点名的工具」—— 委派链路（团队成员 / 子代理）的循环骨架。
     *
     * Lead 的批处理不走来这里（它要并发派发、界面 tool_end 与实时输出），但底下是同一个
     * [ToolPipeline]；差别只在「一次交一批」还是「逐条交」。
     *
     * 为什么要有这一份：这两条循环以前各写一遍同样的五步（拼 assistant 消息、解析参数、
     * 跑一条、追 tool 消息、记痕迹），Gate 与取消语义各抄一份 —— 这次的「委派链路不越权」
     * 之所以要改两处，就是这份重复的直接后果。骨架收拢后调用方只交两个钩子：
     *   · [onStart] 每条调用**开始**时：成员写 lastAction、子代理写步骤树，都在这一刻
     *   · [onOutcome] 每条调用**结算**后恰好一次（成功、失败、被取消都算）
     *
     * 并且钉住一条流水线里的纪律：**每个 tool_call 都有一条对应的 tool 消息**。以前成员
     * 被中断是 `break`，后面几条调用没有回答，这份历史再发出去就是端点 400 ——
     * 现在取消掉的那几条拿 `TOOL_NOT_STARTED` 收口，与 [ToolPipeline.executeBatch] 一致。
     */
    fun execCalls(
        pipeline: ToolPipeline,
        calls: List<LlmClient.ToolCall>,
        text: String,
        messages: MutableList<JSONObject>,
        gate: ToolPipeline.Gate,
        runtime: ToolPipeline.RuntimeTools,
        catalog: Set<String>,
        sessionId: String,
        cancelled: () -> Boolean,
        onStart: (LlmClient.ToolCall, JSONObject) -> Unit = { _, _ -> },
        onOutcome: (LlmClient.ToolCall, JSONObject, ToolPipeline.Outcome) -> Unit = { _, _, _ -> },
    ): List<ToolPipeline.Outcome> {
        if (calls.isEmpty()) return emptyList()
        messages.add(JSONObject().apply {
            put("role", "assistant")
            put("content", if (text.isBlank()) JSONObject.NULL else text)
            put("tool_calls", wire(calls))
        })
        val out = ArrayList<ToolPipeline.Outcome>(calls.size)
        for (c in calls) {
            val args = runCatching { JSONObject(c.args.ifBlank { "{}" }) }.getOrElse { JSONObject() }
            val outcome = if (cancelled()) {
                ToolPipeline.Outcome(
                    c.id, c.name, false,
                    """{"ok":false,"code":"TOOL_NOT_STARTED","error":"本轮在它执行前已结束"}""", 0,
                    code = "TOOL_NOT_STARTED",
                )
            } else {
                onStart(c, args)
                execOutcome(
                    pipeline, ToolPipeline.Call(c.id, c.name, args), gate, runtime,
                    cancelled = cancelled, sessionId = sessionId, catalog = catalog,
                )
            }
            messages.add(toolMessage(c.id, outcome.output))
            out.add(outcome)
            onOutcome(c, args, outcome)
        }
        return out
    }

    /** 工具调用的 wire（assistant 消息里的 tool_calls）：子代理与成员各拼过一遍，字段必须一致 */
    fun wire(toolCalls: List<LlmClient.ToolCall>): JSONArray = JSONArray().apply {
        toolCalls.forEach { c ->
            put(JSONObject().apply {
                put("id", c.id); put("type", "function")
                put("function", JSONObject().put("name", c.name).put("arguments", c.args))
            })
        }
    }

    /** 工具结果回灌给模型的消息：role=tool + tool_call_id 配对（三条循环同一形状） */
    fun toolMessage(id: String, output: String): JSONObject =
        JSONObject().put("role", "tool").put("tool_call_id", id).put("content", output)
}
