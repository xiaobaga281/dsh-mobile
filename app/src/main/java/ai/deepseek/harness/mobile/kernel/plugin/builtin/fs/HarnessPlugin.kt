package ai.deepseek.harness.mobile.kernel.plugin.builtin.fs

import ai.deepseek.harness.mobile.agent.ToolPipeline
import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickInt
import ai.deepseek.harness.mobile.kernel.plugin.pickLong
import org.json.JSONArray
import org.json.JSONObject

/**
 * Harness 行为插件：把「计划 / 目标 / 待办 / 检索 / 子智能体 / 提问」这几件
 * 需要会话级状态的能力，按插件形式暴露成模型工具。
 *
 * 工具的**实现**不在这里——它们在 AgentDriver 里，按轮注入成 `agent.runtime` 服务。
 * 这与桌面版完全同构：插件声明工具与 schema，真正干活的服务由 ctx 提供，
 * 插件本身不持有会话状态，因此可以随时装卸而不影响内核。
 *
 * 参数名与桌面 tool-catalog 逐字对齐（plan / todos / queries / prompt / goal_id /
 * revision / action / questions…），并用 pick* 兼容早期版本用过的旧名
 * （title / items / query / task / status）——模型按桌面习惯调用即可跑。
 */
class HarnessPlugin : KernelPlugin {
    override val id = "harness"
    override val name = "Harness 行为"
    override val description = "计划评审、目标推进、待办清单、联网检索、子智能体、向用户提问"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null

    override fun onLoad(ctx: PluginContext) { this.ctx = ctx }
    override fun onUnload() { ctx = null }

    private fun runtime(): ToolPipeline.RuntimeTools =
        ctx?.service("agent.runtime") as? ToolPipeline.RuntimeTools
            ?: throw KernelError("当前没有进行中的会话，这些工具只在对话里可用")

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object")
        put("properties", props)
        put("required", JSONArray(required))
        put("additionalProperties", false)
    }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "exit_plan_mode"
            override val description = "把完整执行计划提交给用户评审。批准前不要执行任何写操作；用户批准后才继续。"
            override val parameters = schema(
                JSONObject().put("plan", Schemas.prop("string", "Markdown 计划正文：目标、步骤、验证方式")),
                listOf("plan"),
            )
            override fun execute(args: JSONObject): String =
                runtime().presentPlan(args.pick("title"), args.getString("plan"))
        },
        object : ToolSpec {
            override val name = "update_goal"
            override val description =
                "更新同会话目标。action 取 edit（改目标/轮数）、pause、resume、complete（完成）、" +
                    "blocked（受阻，须给 blocked_reason）。goal_id 与 revision 来自 get_goal。"
            override val parameters = schema(
                JSONObject()
                    .put("goal_id", Schemas.prop("string", "目标 id（get_goal 返回）"))
                    .put("revision", Schemas.prop("number", "目标版本号（get_goal 返回），防止并发覆盖"))
                    .put("action", Schemas.prop("string", "要执行的动作", listOf("edit", "pause", "resume", "complete", "blocked")))
                    .put("objective", Schemas.prop("string", "edit 时新的目标内容"))
                    .put("max_goal_rounds", Schemas.prop("number", "edit 时的轮数上限，0 = 智能"))
                    .put("blocked_reason", Schemas.prop("string", "blocked 时的卡点说明")),
                listOf("action"),
            )
            override fun execute(args: JSONObject): String {
                // 桌面 action 语义 → 手机端状态机；旧版 status/summary 叫法仍然接受
                val action = args.pick("action", "status")
                // 阶段推进改写目标：旧实现把 objective 当 summary 丢掉，目标永远不会变
                if (action == "edit") {
                    val objective = args.pick("objective", "summary")
                    // 原来缺 objective 时把提示当成功结果返回 —— 模型会以为目标已改。
                    if (objective.isBlank()) throw ai.deepseek.harness.mobile.kernel.KernelError(
                        "edit 需要 objective：写清这一阶段要达成什么（可验证的结果）",
                    )
                    return runtime().editGoal(objective, args.pickInt("max_goal_rounds", "max_rounds"))
                }
                val status = when (action) {
                    "complete", "done", "完成" -> "complete"
                    "blocked", "受阻" -> "blocked"
                    "pause", "paused" -> "paused"
                    "resume" -> "active"
                    else -> "active"
                }
                val summary = args.pick("blocked_reason", "summary")
                return runtime().markGoal(status, summary)
            }
        },
        object : ToolSpec {
            override val name = "create_goal"
            override val description = "为当前会话建立一个目标，Agent 会分轮推进直到完成或受阻。"
            override val parameters = schema(
                JSONObject()
                    .put("objective", Schemas.prop("string", "目标，一句话说清要达成什么"))
                    .put("max_goal_rounds", Schemas.prop("number", "最多轮数，0 表示智能（跑到完成/受阻）")),
                listOf("objective"),
            )
            override fun execute(args: JSONObject): String =
                runtime().createGoal(args.getString("objective"), args.pickInt("max_goal_rounds", "max_rounds"))
        },
        object : ToolSpec {
            override val name = "get_goal"
            override val description = "读取当前会话目标的状态、进度与 revision。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String = runtime().getGoal()
        },
        object : ToolSpec {
            override val name = "todo_write"
            override val description = "把当前任务的待办清单整体写回（覆盖式）。每项含 content 与 status（pending/in_progress/completed）。"
            override val parameters = schema(
                JSONObject().put("todos", JSONObject().apply {
                    put("type", "array")
                    put("description", "待办清单")
                    put("items", JSONObject().apply {
                        put("type", "object")
                        put("properties", JSONObject()
                            .put("content", Schemas.prop("string", "这一项要做什么"))
                            .put("status", Schemas.prop("string", "pending / in_progress / completed",
                                listOf("pending", "in_progress", "completed"))))
                        put("required", JSONArray(listOf("content")))
                    })
                }),
                listOf("todos"),
            )
            override fun execute(args: JSONObject): String {
                val src = args.optJSONArray("todos") ?: args.optJSONArray("items") ?: JSONArray()
                val items = JSONArray()
                for (i in 0 until src.length()) {
                    val o = src.optJSONObject(i) ?: continue
                    val text = o.pick("content", "text")
                    if (text.isBlank()) continue
                    val done = o.optString("status") == "completed" || o.optBoolean("done")
                    items.put(JSONObject().put("text", text).put("done", done))
                }
                return runtime().todoWrite(items)
            }
        },
        object : ToolSpec {
            override val name = "web_search"
            override val description =
                "联网搜索，返回标题/摘要/链接。queries 支持 1–4 个词，结果合并去重（比拼成一个长句准得多）。" +
                    "**深度调研一次成型**：给 fetch_top>0 就直接抓前 N 条结果的正文并合并返回，" +
                    "不用逐个 web_fetch。需要外部事实或最新信息时用；只想要链接列表就省略 fetch_top。"
            override val parameters = schema(
                JSONObject()
                    .put("queries", JSONObject().apply {
                        put("type", "array")
                        put("description", "1–4 个搜索词，分别检索后合并")
                        put("items", JSONObject().put("type", "string"))
                    })
                    .put("max_results", Schemas.prop("number", "每个查询最多返回几条，默认 5"))
                    .put("fetch_top", Schemas.prop("number",
                        "深度调研：自动抓取前 N 条结果的正文并合并（0–3，默认 0 = 只回标题摘要）。"
                            + "适合「查清某个主题」这类需要读正文的任务，省掉多次 web_fetch 往返"))
                    .put("chars_per_page", Schemas.prop("number",
                        "fetch_top>0 时每页最多返回多少字符，默认 6000，上限 12000")),
                listOf("queries"),
            )
            override fun execute(args: JSONObject): String {
                val arr = args.optJSONArray("queries")
                val qs = if (arr != null && arr.length() > 0) {
                    (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotBlank() } }
                } else listOf(args.pick("query")).filter { it.isNotBlank() }
                if (qs.isEmpty()) throw KernelError("queries 不能为空")
                return runtime().search(
                    qs,
                    args.pickInt("max_results", default = 5),
                    fetchTop = args.pickInt("fetch_top", default = 0),
                    charsPerPage = args.pickInt("chars_per_page", default = 6_000),
                )
            }
        },
        object : ToolSpec {
            override val name = "web_fetch"
            override val description =
                "抓取一个网页并返回正文文本（已去标签，带页面标题）。默认一次 12000 字符；" +
                    "长页面会提示剩余长度，用 offset 继续读同一页，不要重复抓。"
            override val parameters = schema(
                JSONObject()
                    .put("url", Schemas.prop("string", "http/https 链接"))
                    .put("max_chars", Schemas.prop("number", "本次最多返回多少字符，默认 12000，上限 40000"))
                    .put("offset", Schemas.prop("number", "从正文第几个字符开始，默认 0；用于分页读长文")),
                listOf("url"),
            )
            override fun execute(args: JSONObject): String =
                runtime().fetchUrl(
                    args.getString("url"),
                    args.pickInt("max_chars", "maxChars", default = 12_000),
                    args.pickInt("offset", default = 0),
                )
        },
        object : ToolSpec {
            override val name = "http_request"
            override val description =
                "直接发一条 HTTP 请求（方法 / 请求头 / 请求体都由你指定），用于调用没有专用封装、" +
                    "或专用工具 schema 与端点方言对不上的 API。返回状态码、响应头与响应体（文本按 max_chars 截断；" +
                    "二进制只回元信息）。GET/HEAD 不能带 body；请求体上限 1MB。会真实产生外部副作用，" +
                    "POST/PUT/PATCH/DELETE 前先确认目标与参数。"
            override val parameters = schema(
                JSONObject()
                    .put("url", Schemas.prop("string", "http/https 完整地址"))
                    .put("method", Schemas.prop("string", "HTTP 方法，默认 GET",
                        listOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")))
                    .put("headers", JSONObject().apply {
                        put("type", "object")
                        put("description", "请求头键值对，例如 {\"Authorization\":\"Bearer …\"}；禁止 CR/LF")
                        put("additionalProperties", JSONObject().put("type", "string"))
                    })
                    .put("body", Schemas.prop("string",
                        "请求体原文（JSON 也可直接传对象）。未给 content_type 时：以 { 或 [ 开头按 application/json，其余 text/plain"))
                    .put("content_type", Schemas.prop("string", "Content-Type，可选；也可直接写在 headers 里"))
                    .put("timeout_ms", Schemas.prop("number", "读超时毫秒，默认 30000，上限 60000"))
                    .put("max_chars", Schemas.prop("number", "响应正文最多返回多少字符，默认 12000，上限 40000"))
                    .put("follow_redirects", Schemas.prop("boolean", "是否自动跟随 3xx，默认 true")),
                listOf("url"),
            )
            override val timeoutMs = 75_000L
            override fun execute(args: JSONObject): String {
                val headerObj = args.optJSONObject("headers")
                val headers = LinkedHashMap<String, String>()
                if (headerObj != null) {
                    for (key in headerObj.keys()) {
                        val value = headerObj.opt(key) ?: continue
                        if (value !is JSONObject && value !== JSONObject.NULL) headers[key] = value.toString()
                    }
                }
                val rawBody = args.opt("body")
                val body = when (rawBody) {
                    null, JSONObject.NULL -> null
                    is String -> rawBody.ifBlank { null }
                    else -> rawBody.toString()
                }
                return ai.deepseek.harness.mobile.kernel.HttpExchange.request(
                    url = args.getString("url"),
                    method = args.pick("method").ifBlank { "GET" },
                    headers = headers,
                    body = body,
                    contentType = args.pick("content_type", "contentType").ifBlank { null },
                    timeoutMs = args.pickInt("timeout_ms", default = 30_000),
                    maxChars = args.pickInt("max_chars", default = 12_000),
                    followRedirects = args.optBoolean("follow_redirects", true),
                )
            }
        },
        object : ToolSpec {
            override val name = "read_image"
            override val description = "读取工作区里的图片并加入对话（需要当前模型支持图片输入）。"
            override val parameters = schema(
                JSONObject().put("file_path", Schemas.prop("string", "相对工作区的图片路径")),
                listOf("file_path"),
            )
            override fun execute(args: JSONObject): String =
                runtime().addImage(args.pick("file_path", "path"))
        },
        object : ToolSpec {
            override val name = "subagent"
            override val description = "派一个子智能体独立完成一段子任务（独立上下文，只返回结论）。"
            override val parameters = schema(
                JSONObject()
                    .put("description", Schemas.prop("string", "一句话说明这个子代理负责什么"))
                    .put("prompt", Schemas.prop("string", "完整任务描述"))
                    .put("cwd", Schemas.prop("string", "子代理的工作目录，默认继承会话"))
                    .put("max_rounds", Schemas.prop("number", "最多工具轮数（1-40），默认 12")),
                listOf("description", "prompt"),
            )
            override fun execute(args: JSONObject): String {
                val prompt = args.pick("prompt", "task")
                if (prompt.isBlank()) throw KernelError("prompt 不能为空")
                val desc = args.pick("description")
                val task = if (desc.isBlank()) prompt else "【$desc】\n$prompt"
                return runtime().subagent(task, args.pickInt("max_rounds", default = 12))
            }
        },
        object : ToolSpec {
            override val name = "skill"
            override val description = "加载一个技能的完整说明。先用目录里的名字调用，再把正文当作指令执行。"
            override val parameters = schema(
                JSONObject().put("name", Schemas.prop("string", "技能名（见系统提示里的技能目录）")),
                listOf("name"),
            )
            override fun execute(args: JSONObject): String = runtime().useSkill(args.getString("name"))
        },
        object : ToolSpec {
            override val name = "ask_user_question"
            override val description = "向用户提问后再继续。可一次给 1–4 个问题，逐个弹出；答案按 id 回传。" +
                "给出选项；推荐项放第一个并在 label 后加 (Recommended)。"
            override val parameters = schema(
                JSONObject().put("questions", JSONObject().apply {
                    put("type", "array")
                    put("description", "要问的问题列表")
                    put("items", JSONObject().apply {
                        put("type", "object")
                        put("properties", JSONObject()
                            .put("id", Schemas.prop("string", "稳定 id，回传答案时带上"))
                            .put("question", Schemas.prop("string", "要问的问题，一句说清"))
                            .put("header", Schemas.prop("string", "可选短标题，如「确认」"))
                            .put("options", JSONObject().apply {
                                put("type", "array")
                                put("description", "可选项；推荐项放第一个")
                                put("items", JSONObject().apply {
                                    put("type", "object")
                                    put("properties", JSONObject()
                                        .put("label", Schemas.prop("string", "选项标题"))
                                        .put("description", Schemas.prop("string", "选项补充说明")))
                                    put("required", JSONArray(listOf("label")))
                                })
                            }))
                        put("required", JSONArray(listOf("question")))
                    })
                }),
                listOf("questions"),
            )
            override fun execute(args: JSONObject): String {
                // 桌面 ask_user_question 支持一次带多个问题（answers 按 id 回传）。
                // 旧实现只取 questions[0]，其余问题被静默丢弃 —— 模型以为问了三个，
                // 用户只看到一个，答案自然对不上。这里逐个提问、按 id 汇总。
                data class Q(val id: String, val text: String, val header: String, val options: JSONArray)

                fun optionsOf(o: JSONObject): JSONArray {
                    val out = JSONArray()
                    val ops = o.optJSONArray("options") ?: return out
                    for (i in 0 until ops.length()) {
                        val x = ops.optJSONObject(i) ?: continue
                        val label = x.pick("label")
                        if (label.isBlank()) continue
                        out.put(JSONObject().put("label", label).put("description", x.pick("description")))
                    }
                    return out
                }

                val list = ArrayList<Q>()
                val arr = args.optJSONArray("questions")
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val o = arr.optJSONObject(i) ?: continue
                        list.add(Q(o.pick("id").ifBlank { "q${i + 1}" }, o.pick("question"), o.pick("header"), optionsOf(o)))
                    }
                }
                if (list.isEmpty()) {
                    list.add(Q(args.pick("id").ifBlank { "q1" }, args.pick("question"), args.pick("detail"),
                        optionsOf(args)))
                }
                if (list.any { it.text.isBlank() }) throw KernelError("每个问题的 question 都不能为空")
                if (list.size > 4) throw KernelError("一次最多问 4 个问题；更多请分几轮")
                val answers = JSONArray()
                for (q in list) {
                    val ans = runtime().askUser(q.text, q.options, q.header)
                    answers.put(JSONObject().put("id", q.id).put("question", q.text).put("answer", ans))
                }
                if (list.size == 1) return answers.getJSONObject(0).optString("answer")
                return JSONObject().put("ok", true).put("count", answers.length())
                    .put("answers", answers).toString(2)
            }
        },
    )

    override fun promptSection(): String =
        "- 你运行在手机端：回复要短，一次只做一件事；长任务先 todo_write 列出步骤再逐项推进。"

    override fun status(): Map<String, String> = mapOf("绑定" to if (ctx?.service("agent.runtime") != null) "会话中" else "空闲")
}
