package ai.deepseek.harness.mobile.kernel.plugin.builtin.agent

import ai.deepseek.harness.mobile.agent.ToolPipeline
import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.agents.AgentRegistry
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickInt
import ai.deepseek.harness.mobile.kernel.ptc.PtcRuntime
import org.json.JSONArray
import org.json.JSONObject

/**
 * 子代理控制、ralph 与 workflow —— 对应桌面三个包：
 *
 *  注：list_agents / send_message / interrupt_agent 已由「智能体团队工具」插件接管
 *  （团队语义：roster + inbox + 冷恢复），这里只保留模型发现、ralph、workflow、fork。
 *  - `@deepseek-ai/dsh-tool-subagent` 的 `list_subagent_models`（模型发现；
 *    手机端没有 provider 目录，如实返回当前路由并说明限制）
 *  - `@deepseek-ai/dsh-tool-ralph`：固定前台工作流，每个 Round 起一个全新子代理推进同一目标
 *  - `@deepseek-ai/dsh-tool-workflow`：JS 工作流脚本。手机端用 PTC 运行时承担脚本执行，
 *    `agent(prompt)` 桥接到子代理——与桌面 `exec.agent` 派生子级的语义一致。
 */
class AgentControlPlugin : KernelPlugin {
    override val id = "agent-control"
    override val name = "子代理控制"
    override val description = "ralph / workflow / subagent_fork / list_subagent_models"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null

    override fun onLoad(ctx: PluginContext) { this.ctx = ctx }
    override fun onUnload() { ctx = null }

    private fun registry(): AgentRegistry =
        ctx?.service("agents.registry") as? AgentRegistry ?: throw KernelError("子代理注册表未装配")

    private fun runtime(): ToolPipeline.RuntimeTools =
        ctx?.service("agent.runtime") as? ToolPipeline.RuntimeTools
            ?: throw KernelError("当前没有进行中的会话，子代理能力只在对话里可用")

    private fun ptc(): PtcRuntime =
        ctx?.service("ptc.runtime") as? PtcRuntime ?: throw KernelError("PTC 运行时未装配")

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "list_subagent_models"
            override val description = "列出可用的模型路由。手机端没有 provider 目录，只返回当前会话正在用的模型。"
            override val parameters = schema(
                JSONObject()
                    .put("provider", JSONObject().put("type", "string").put("description", "已注册的 LLM provider id"))
                    .put("model", JSONObject().put("type", "string").put("description", "精确模型 id")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String {
                val model = ctx?.service("agent.model") as? String ?: ""
                return JSONObject().apply {
                    put("routable", true)
                    put("current", model)
                    put("note", "手机端没有 provider/model 发现服务：子代理继承父会话模型；换模型请在设置的模型列表里切换。")
                }.toString()
            }
        },
        object : ToolSpec {
            override val name = "ralph"
            override val description =
                "固定的前台工作流：每一轮启动一个全新的子代理，围绕同一个不可变目标推进，" +
                    "直到目标完成或达到轮数上限。适合需要多轮收敛的清理/重构类目标。"
            override val parameters = schema(
                JSONObject()
                    .put("objective", JSONObject().put("type", "string").put("description", "每一轮都相同的完成目标"))
                    .put("maxRounds", JSONObject().put("type", "number").put("description", "轮数上限，默认 5，最大 12")),
                listOf("objective"),
            )
            override fun execute(args: JSONObject): String {
                val objective = args.optString("objective")
                if (objective.isBlank()) throw KernelError("objective 不能为空")
                val cap = args.optInt("maxRounds", 5).coerceIn(1, 12)
                val trail = JSONArray()
                for (round in 1..cap) {
                    val task = """
                        【Ralph 第 $round/$cap 轮】目标（不可更改）：$objective
                        先检查目标当前完成到什么程度，再推进未完成的部分。
                        结尾用一行「状态：DONE」表示目标已完全达成，或用「状态：CONTINUE」表示还需要下一轮。
                    """.trimIndent()
                    val out = runtime().subagent(task, 4)
                    trail.put(JSONObject().put("round", round).put("result", out.take(600)))
                    if (Regex("状态[:：]\\s*DONE", RegexOption.IGNORE_CASE).containsMatchIn(out)) {
                        return JSONObject().put("done", true).put("rounds", round).put("trail", trail).toString()
                    }
                }
                return JSONObject().put("done", false).put("rounds", cap).put("trail", trail).toString()
            }
        },
        object : ToolSpec {
            override val name = "subagent_fork"
            override val description =
                "从当前会话分叉出一个子代理执行任务（继承父会话的上下文摘要，结论只回流给你）。" +
                    "适合需要沿用父会话已掌握背景的长任务。"
            override val parameters = schema(
                JSONObject()
                    .put("description", JSONObject().put("type", "string").put("description", "一句话说明这个子代理负责什么"))
                    .put("prompt", JSONObject().put("type", "string").put("description", "要分叉出去完成的任务"))
                    .put("cwd", JSONObject().put("type", "string").put("description", "子代理工作目录，默认继承"))
                    .put("max_rounds", JSONObject().put("type", "number").put("description", "最多工具轮数，默认 6")),
                listOf("description", "prompt"),
            )
            override fun execute(args: JSONObject): String {
                val task = args.pick("prompt", "task")
                if (task.isBlank()) throw KernelError("prompt 不能为空")
                // 分叉语义：把父会话最近的对话要点带进子任务（桌面 subagent_fork 的等价做法）
                val sid = ctx?.service("agent.session") as? String ?: ""
                val brief = (ctx?.service("session.store") as? ai.deepseek.harness.mobile.agent.SessionStore)
                    ?.read(sid)?.takeLast(40)
                    ?.filter { it.optString("type") == "user/message" || it.optString("type") == "assistant/message" }
                    ?.joinToString("\n") { ev ->
                        val role = if (ev.optString("type") == "user/message") "用户" else "助手"
                        "$role：${ev.optString("text").take(120)}"
                    }.orEmpty()
                val desc = args.pick("description")
                val forked = buildString {
                    if (desc.isNotBlank()) append("【$desc】\n")
                    if (brief.isNotBlank()) append("【从父会话分叉】父会话要点：\n$brief\n\n")
                    append("【你的任务】\n$task")
                }
                return runtime().subagent(forked, args.pickInt("max_rounds", default = 6))
            }
        },
        object : ToolSpec {
            override val name = "workflow"
            override val description =
                "跑一段 JS 工作流编排多个子代理：script 是 JS 函数体，可用 await agent('任务描述') 派生子代理、" +
                    "args 读取入参、phase('名称') 标记阶段；返回值即工作流结果。"
            override val parameters = schema(
                JSONObject()
                    .put("script", JSONObject().put("type", "string").put("description", "JS 函数体（顶层可 await，不要写 export）"))
                    .put("meta", JSONObject().apply {
                        put("type", "object")
                        put("description", "工作流身份信息")
                        put("properties", JSONObject()
                            .put("name", JSONObject().put("type", "string"))
                            .put("description", JSONObject().put("type", "string"))
                            .put("whenToUse", JSONObject().put("type", "string")))
                        put("required", JSONArray(listOf("name", "description")))
                    })
                    .put("args", JSONObject().put("type", "object").put("description", "暴露给脚本的 args"))
                    .put("run_in_background", JSONObject().put("type", "boolean").put("description", "后台运行：立即返回 job id，完成时随通知回传")),
                listOf("script", "meta"),
            )
            override fun execute(args: JSONObject): String {
                val script = args.optString("script")
                if (script.isBlank()) throw KernelError("script 不能为空")
                if (args.optBoolean("run_in_background")) {
                    // 后台工作流：注册成 job，完成后由 job_done 通知带回结果
                    val jobs = ctx?.service("job.registry") as? ai.deepseek.harness.mobile.kernel.jobs.JobRegistry
                        ?: throw KernelError("后台任务服务未装配，请去掉 run_in_background")
                    val label = args.optJSONObject("meta")?.optString("name")?.ifBlank { null } ?: "workflow"
                    val job = jobs.start(label) { j ->
                        val out = runWorkflow(args)
                        j.append(out)
                        0
                    }
                    return JSONObject().put("job_id", job.id).put("note", "后台运行中；用 job_output 收集").toString()
                }
                return runWorkflow(args)
            }

            private fun runWorkflow(args: JSONObject): String {
                val script = args.optString("script")
                val argsJson = args.optJSONObject("args")?.toString() ?: "{}"
                val code = """
                    const args = $argsJson;
                    const phase = (name) => ({ phase: String(name) });
                    const agent = (prompt) => dsh.callTool('subagent', { task: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) });
                    $script
                """.trimIndent()
                return ptc().run(code, reset = false, timeoutMs = 600_000)
            }
        },
    )
}
