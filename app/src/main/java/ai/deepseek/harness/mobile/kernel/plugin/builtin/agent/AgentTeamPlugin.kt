package ai.deepseek.harness.mobile.kernel.plugin.builtin.agent

import ai.deepseek.harness.mobile.agent.AgentConfig
import ai.deepseek.harness.mobile.agent.HookBus
import ai.deepseek.harness.mobile.agent.PromptAssembler
import ai.deepseek.harness.mobile.agent.SessionStore
import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.ToolKernel
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.team.MemberLlm
import ai.deepseek.harness.mobile.kernel.team.MemberRole
import ai.deepseek.harness.mobile.kernel.team.MemberPhase
import ai.deepseek.harness.mobile.kernel.team.TaskStatus
import ai.deepseek.harness.mobile.kernel.team.TeamBoard
import ai.deepseek.harness.mobile.kernel.team.TeamCall
import ai.deepseek.harness.mobile.kernel.team.TeamError
import ai.deepseek.harness.mobile.kernel.team.TeamJournal
import ai.deepseek.harness.mobile.kernel.team.TeamLimits
import ai.deepseek.harness.mobile.kernel.team.TeamRuntime
import ai.deepseek.harness.mobile.kernel.team.TeamTask
import ai.deepseek.harness.mobile.kernel.team.view
import org.json.JSONArray
import org.json.JSONObject

/**
 * 智能体团队 —— 桌面 `experimental/agent-team` + `tool-agent-team` 的手机端合并版。
 *
 * **一个插件，不是两个。** 桌面拆成两个包是因为 Cordis 生态里「领域服务」要能被
 * 第三方工具适配包复用（换一套 UI/工具面而不动领域）；安卓端插件模型本身就是
 * 「一个能力域 = 服务 + 工具 + 提示词 + 状态」，再拆只会得到三条坏处：
 *   · 插件列表里出现两条「团队」，用户不知道关哪个
 *   · 关掉服务插件，工具插件还挂着（十个工具全部半死）
 *   · 关掉工具插件，服务还在空转（roster 照写日志，没人能操作）
 *
 * 所以合并：服务照旧 `ctx.provide("team.runtime")`（roster / 任务板按会话分桶活在
 * 运行时内部，rc.97 起与桌面 TeamId=SessionId 同构），别的插件仍可消费；
 * 工具、team policy、状态展示都挂在同一个插件上，启停一次干净。
 *
 * 工具面与桌面九个同名 + 手机端独有的 `team_status`：
 *   spawn_teammate / send_message / list_agents / wait_agent / interrupt_agent
 *   team_task_create / team_task_list / team_task_get / team_task_update / team_status
 *
 * 领域判定全在 [TeamRuntime] / [TeamBoard] / [TeamRoster]，工具层不另开弱路径。
 */
class AgentTeamPlugin : KernelPlugin {
    override val id = "agent-team"
    override val name = "智能体团队"
    override val description = "具名 teammate 协作：roster、收件箱、共享任务板、预算、后台保活（十个工具）"
    override val version = "2.0.0"

    private var ctx: PluginContext? = null
    private var runtime: TeamRuntime? = null

    /* ---------------- 装配 ---------------- */

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        val sessions = ctx.service("session.store") as? SessionStore
            ?: throw KernelError("智能体团队需要会话存储（session.store）")
        val kernel = ctx.service("kernel.facade") as? ToolKernel
            ?: throw KernelError("智能体团队需要内核门面（kernel.facade）")
        val hooks = ctx.service("kernel.hooks") as? HookBus
            ?: throw KernelError("智能体团队需要事件总线（kernel.hooks）")

        val cfg = ctx.config()
        val journal = TeamJournal(sessions)
        val capacity = ai.deepseek.harness.mobile.kernel.team.TeamCapacity().apply {
            maxMembers = cfg.optInt("maxMembers", 16).coerceIn(1, 64)
            maxTasks = cfg.optInt("maxTasks", 256).coerceIn(8, 2048)
        }
        val limit = TeamRuntime.Config(
            // 与桌面「子智能体并行上限」同一个数（桌面默认 8）
            maxConcurrent = cfg.optInt("maxConcurrent", 8).coerceIn(1, 8),
            // 桌面 Config 的另外两个数（index.ts:59-64）：以前写死在运行时代码里，
            // 现在与 maxMembers/maxTasks 一样从插件配置读，越界夹到安全区
            maxMessageBytes = cfg.optInt("maxMessageBytes", TeamLimits.DEFAULT_MAX_MESSAGE_BYTES)
                .coerceIn(1_024, 1_048_576),
            disposalTimeoutMs = cfg.optLong("disposalTimeoutMs", TeamLimits.DEFAULT_DISPOSAL_TIMEOUT_MS)
                .coerceIn(1_000L, 60_000L),
        )
        // 委派限制交给内核：subagent 工具不属于团队，团队插件被禁用时也该按同一份值走。
        // 这里只负责「从配置读出来 + 装配时推一次」，编辑入口在设置页（走 teamSetLimits）。
        kernel.setSubagentLimits(
            ai.deepseek.harness.mobile.kernel.agents.SubagentLimits(
                maxDepth = cfg.optInt("maxDepth", 1),
                maxParallel = limit.maxConcurrent,
            ),
        )
        val rt = TeamRuntime(kernel, hooks, sessions, capacity, journal, limit) { ctx.log(it) }

        runtime = rt

        ctx.provide("team.runtime", rt)

        /**
         * 队友 → Lead 的汇报投递点。
         *
         * 桌面用 `root.steer()` 把消息塞进 Lead 的下一步；手机端没有跨线程 steer 入口，
         * 所以在每个 step 开头认领 Lead 收件箱。放在 pre-step 而不是 pre-turn，
         * 是为了让 Lead 在长工具链中间也能收到队友的结论，而不是等整轮结束。
         */
        ctx.hooks.onWaterfall<PromptAssembler.Section>("agent/pre-step", "lead-inbox") { _, hc ->
            val sid = hc.str("session").orEmpty()
            if (sid.isNotBlank()) {
                // Lead 的一个 step：面板上 lead 的「N 轮」从这里来（成员会话带 #，不计）
                runCatching { rt.noteLeadStep(sid) }
                val got = runCatching { rt.drainLeadInbox(sid) }.getOrDefault(emptyList())
                if (got.isNotEmpty()) {
                    @Suppress("UNCHECKED_CAST")
                    val messages = hc.any("messages") as? MutableList<JSONObject>
                    got.forEach { text ->
                        messages?.add(JSONObject().put("role", "user").put("content", text))
                        sessions.append(sid, "user/message", JSONObject().put("text", text).put("from", "team"))
                    }
                    runCatching {
                        kernel.eventSink?.invoke(JSONObject()
                            .put("t", "notice")
                            .put("level", "info")
                            .put("note", "队友汇报了 ${got.size} 条消息，已并入本轮上下文"))
                    }
                    ctx.log("lead inbox: 认领 ${got.size} 条队友消息（$sid）")
                }
            }
            null
        }

        /**
         * Lead 的工具计数：AgentDriver 每执行一个工具发一次 agent/tool（serial）。
         * 只记主会话（无 #），成员循环的工具由 runMember 自己统计。
         */
        // 监听器 id 由 PluginHooks 自动加插件前缀，卸载时 registry 按前缀一次摘干净
        ctx.hooks.onSerial("agent/tool", "lead-tools") { hc ->
            val sid = hc.str("session").orEmpty()
            if (sid.isNotBlank()) runCatching { rt.noteLeadTool(sid, hc.str("name").orEmpty()) }
        }

        ctx.log("团队已装配：并发 ${limit.maxConcurrent}、成员上限 ${capacity.maxMembers}、任务上限 ${capacity.maxTasks}")
        ctx.log("已挂 agent/pre-step：队友汇报从这里进 Lead 的下一步上下文")
        ctx.log("已挂 agent/tool：Lead 的工具计数进团队面板")
    }

    override fun onUnload() {
        runCatching { runtime?.shutdown() }
        ctx = null
        runtime = null
    }

    override fun status(): Map<String, String> = buildMap {
        val rt = runtime
        if (rt == null) {
            put("状态", "未装配")
        } else {
            val snap = rt.snapshot()
            val limits = snap.optJSONObject("limits")
            put("并发", "同时 ${limits?.optInt("maxConcurrent") ?: "—"} 人")
            if (rt.leadSession().isBlank()) {
                put("状态", "待会话（首次调用工具时绑定）")
            } else {
                put("成员", "${snap.optInt("running")} 运行 / ${snap.optJSONArray("members")?.length() ?: 0} 总计")
                put("任务", snap.optJSONObject("board")?.let { b ->
                    "${b.optInt("inProgress")} 进行 / ${b.optInt("pending")} 待办 / ${b.optInt("ready")} 就绪"
                } ?: "—")
            }
        }
    }

    /* ---------------- 依赖 ---------------- */

    private fun rt(): TeamRuntime {
        val r = (ctx?.service("team.runtime") as? TeamRuntime) ?: runtime
            ?: throw KernelError("团队服务未装配")
        val front = ctx?.service("agent.session") as? String
        when {
            // 成员线程发起的调用（send_message / team_task_*）必须落回**它自己的团队**：
            // 用户此刻可能开着别的会话，按前台会话解析会把 A 的汇报写进 B 的日志（串台）。
            !TeamCall.callerTeamSid().isNullOrBlank() -> r.attach(TeamCall.callerTeamSid()!!)
            // 前台轮次以 agent.session 为准；后台成员跑在 Lead 轮次之外，此时
            // agent.session 已被清空 —— 不能拿 "draft" 去 attach，那会把已绑定的会话
            // 撞成错误，队友连 send_message 都发不出去。
            !front.isNullOrBlank() -> r.attach(front)
            r.leadSession().isBlank() -> r.attach("draft")
            else -> Unit
        }
        return r
    }

    /** 当前会话（rt() 已 attach）的共享任务板 */
    private fun board(): TeamBoard = rt().currentBoard()

    private fun leadConfig(): AgentConfig? = ctx?.service("agent.config") as? AgentConfig

    private fun actor(): TeamBoard.Actor {
        // 任务板的鉴权要认出「是谁在改」：TeamCall 已经把成员身份带在线程上
        // （send_message 就是这么认人的）。以前这里写死 lead，于是
        //  · 成员 claim 到的任务，owner 记成 "lead" —— Lead 的任务板看不见是谁在干；
        //  · release / edit / complete / delete 的 owner 判定永远不会触发
        //   （任何成员都能替别人 complete）。
        val name = TeamCall.callerName()
        return TeamBoard.Actor(name, if (name == "lead") MemberRole.LEAD else MemberRole.TEAMMATE)
    }

    /**
     * 任务板 → Mission 账本（Step 5 团队合流）。
     *
     * 归属会话是 **Lead 的会话**：用户在对话里派出去的活，追踪与唤醒都回到他看得见的那里。
     * 账本或唤醒队列不可用时静默跳过 —— 团队功能不能因为 Mission 面板坏了而失败，
     * 但也不能反过来假装「已记账」。
     */
    private fun syncMission(b: TeamBoard, t: TeamTask, action: String) {
        val missions = ctx?.service("mission.registry")
            as? ai.deepseek.harness.mobile.kernel.mission.MissionRegistry ?: return
        val sid = runCatching { rt().leadSession() }.getOrDefault("")
        if (sid.isBlank()) return
        if (t.status == TaskStatus.DELETED) {
            runCatching { missions.removeTeamTask(t.id) }
            return
        }
        runCatching {
            missions.onTeamTask(
                taskId = t.id, leadSession = sid, subject = t.subject, status = t.status.wire,
                owner = t.owner ?: "", ready = b.readyOf(t), description = t.description,
                createdAt = t.createdAt, updatedAt = t.updatedAt, completedAt = t.completedAt,
            )
        }
        if (action != "complete") return
        val who = t.owner?.takeIf { it.isNotBlank() } ?: "成员"
        runCatching {
            missions.appendEvidence(
                "team:${t.id}",
                org.json.JSONObject().put("type", "team-report").put("ref", t.id + ":r" + t.revision)
                    .put("title", "$who 完成：${t.subject.take(60)}")
                    .put("at", if (t.completedAt > 0L) t.completedAt else System.currentTimeMillis()),
            )
        }
        val wakes = ctx?.service("wake.router")
            as? ai.deepseek.harness.mobile.kernel.mission.WakeRouter ?: return
        runCatching {
            wakes.enqueueTeam(t.id, t.subject, sid, "（团队）任务「${t.subject}」已由 $who 完成，看看下一步。", t.revision)
        }
    }

    /**
     * 统一失败出口：TeamError 带 code/detail，KernelError 归成 TEAM_TOOL_ERROR，
     * 其余归成 TEAM_INTERNAL —— 绝不让团队工具抛裸异常变成 TOOL_THREW。
     */
    private fun guard(block: () -> String): String = try {
        block()
    } catch (e: TeamError) {
        JSONObject().apply {
            put("ok", false)
            put("code", e.code)
            put("error", e.message ?: e.code)
            e.detail?.let { put("detail", it) }
        }.toString()
    } catch (e: KernelError) {
        JSONObject().put("ok", false).put("code", "TEAM_TOOL_ERROR").put("error", e.message ?: "执行失败").toString()
    } catch (e: Throwable) {
        JSONObject().put("ok", false).put("code", "TEAM_INTERNAL")
            .put("error", "${e.javaClass.simpleName}: ${e.message}").toString()
    }

    private fun schema(props: JSONObject, required: List<String> = emptyList()): JSONObject = JSONObject().apply {
        put("type", "object")
        put("properties", props)
        put("required", JSONArray(required))
        put("additionalProperties", false)
    }

    private fun str(desc: String) = JSONObject().put("type", "string").put("description", desc)
    private fun num(desc: String) = JSONObject().put("type", "number").put("description", desc)
    private fun bool(desc: String) = JSONObject().put("type", "boolean").put("description", desc)
    private fun arr(desc: String) = JSONObject().put("type", "array").put("description", desc)
        .put("items", JSONObject().put("type", "string"))

    /** 兼容桌面 camelCase 与早期安卓 snake_case */
    private fun alias(a: JSONObject, vararg keys: String): String {
        keys.forEach { k -> a.optString(k).takeIf { it.isNotBlank() }?.let { return it } }
        return ""
    }

    private fun listOfStrings(a: JSONObject, vararg keys: String): List<String> {
        for (k in keys) {
            val arr = a.optJSONArray(k) ?: continue
            return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotBlank() } }
        }
        return emptyList()
    }

    /* ---------------- 提示词 ---------------- */

    /**
     * 团队提示词 —— 桌面对应两个贡献者：`team:policy`（Lead 与队友共用，静态）与
     * `team:identity`（每次装配按 membership 现算，lead / teammate 两种话）。
     *
     * 手机端以前只有一份，而且写死「Lead = 你」：队友那一轮也读得到它，于是它一边读着
     * 「只有你能创建/中断」，一边读着自己的身份段「你没有 spawn_teammate 权限」——
     * 自相矛盾的两段同时进模型。现在按调用者分支，并把设置里的真实数值写进去，
     * 提示词不再和设置漂移。
     */
    override fun promptSection(): String? {
        // 没装配（或这是上一个被卸载的实例）就不出声：团队段只能有一份，
        // 否则插件重载一次，模型面前就多一份互相过期的团队纪律
        val rt = runtime ?: return null
        val limits = rt.limits()
        val depth = (ctx?.service("kernel.facade") as? ToolKernel)?.subagentLimits?.maxDepth ?: 1
        return if (TeamCall.callerName() == "lead") leadSection(rt, limits, depth) else teammateSection(limits)
    }

    private fun leadSection(rt: TeamRuntime, limits: TeamRuntime.Config, depth: Int): String {
        // 只写「插件级的数值上限」（并行、成员、任务、消息体、深度）—— 这些全团队共用一份，
        // 说错了模型就会照错的下限安排工作。roster / 任务板的**当前条数**不在这里报：
        // 装配发生在任何一支团队的轮次里，读 current scope 会把别的团队数过来，
        // 而模型要看的本来就是 list_agents / team_task_list（那是同一支团队的权威读法）。
        return """
            |【智能体团队】这台设备上可以组建一支具名团队（Lead = 你，teammate = 你创建的人）。
            |· 什么时候该组队（满足任一条就主动组，不要等用户说出「团队」两个字）：
            |  ① 任务能拆成两个以上互不依赖的方向（「审 A 模块 + 审 B 模块」「查前端 + 查后端」）；
            |  ② 既要产出又要审查（writer 写、reviewer 挑错，两个角色不能是同一个人）；
            |  ③ 单个任务预计超过 8 轮工具调用，且中间有可并行的调研/检索。
            |  组队前先用一句话告诉用户「我拆成 X 和 Y 两条线并行」，再 spawn。
            |· 什么时候别组队：一次读文件、一次改代码、需要用户逐步确认的危险操作、当前模型上下文很小 ——
            |  这些直接自己做更快；硬组队只会多花 token 还多一层协调。
            |· 分工：spawn_teammate(name, description, prompt, context)；建队与中断只有 Lead 能调用，
            |  队友调用会被服务层拒绝（TEAM_LEAD_REQUIRED）。名字是小写 kebab、≤64 字符，永久且不复用。
            |· 状态：list_agents 里 running = 正在跑，inactive = 当前没有轮次（不代表任务完成），provisioning/failed = 创建中/创建失败。
            |· 通信：send_message(target, message) 对 running 在最近的步骤边界 steer，对 inactive 会冷恢复一轮。
            |  队友用 target="lead" 汇报，汇报会在你的下一步或 wait_agent 返回值里以 messages 出现；
            |  投递成功只代表进了对方收件箱，不代表它已处理。消息要自包含，别写「按刚才说的办」，
            |  单条 ≤${limits.maxMessageBytes / 1024}KB。
            |· 任务板：team_task_list → team_task_get（拿 revision）→ team_task_update(claim, expected_revision) → 干活 → complete。
            |  变更必须带最新 revision，过期会被拒绝；ready=false 表示前置任务没完成。
            |  **ready 只代表「没被前置挡住」，不代表有人在做**：任务不会自己认领，owner 只在 claim 之后才出现。
            |  所以 spawn 时在 prompt 里写清 task id、要求它先 claim 再开工；你没看到它 complete 之前，
            |  那条任务在板上还是待办 —— 别把「我已经派下去了」当成「有人在执行」。
            |  write_scopes 是写范围声明，
            |  与别人 in-progress 的范围重叠时，任务板会提示「写冲突」——那是提示、不是锁，运行时不拦写入：
            |  同一批文件谁先谁后要在这里说清，两个人改同一个文件会互相覆盖。
            |· 等待：wait_agent 只等「调用之后」发生的变化（10 秒–1 小时）。没有别的成员在 running/provisioning 时
            |  它会立即返回 noProgress，这时要先用 send_message 唤醒该唤醒的人，而不是反复轮询。
            |· 收尾：给用户最终答案之前，必须确认必要的 teammate 已 idle 或任务已 complete；不要把「发出去了」当成「做完了」。
            |· 并行：同时执行的成员数与子智能体容量是同一个数 = ${limits.maxConcurrent}；
            |  成员上限 ${rt.maxMembers()}、任务板上限 ${rt.maxTasks()}（设置 → 智能体团队）。
            |  成员跑到模型自己停下为止，不设轮次/token/时长上限 —— 别为了「省时间」替它截断。
            |· 委派分工（与桌面一致：团队开启后 subagent / subagent_fork 工具被禁用，两套委派不并存）：
            |  你只能用 spawn_teammate 委派；最大递归深度现在是 $depth ——
            |  ${if (depth <= 1) "1 = 只有你能派 teammate，成员不能再派子代理" else "≥2 起成员也能再派一层普通子代理"}。
        """.trimMargin()
    }

    /**
     * teammate 侧：桌面的 team:policy 是两种身份共用的纪律段。
     * 这里只补【团队身份】段里没有的那几条（写范围语义、Lead 专属操作、真实上限），
     * 免得同一条「先 claim 再动手」在同一份系统提示词里出现两遍。
     */
    private fun teammateSection(limits: TeamRuntime.Config): String = """
        |【智能体团队 · 你是 teammate】与你的【团队身份】段一起生效。
        |· 写范围（write_scopes）重叠只是提示，不是锁：同一批文件谁先谁后由 Lead 分工，
        |  两个人改同一个文件会互相覆盖 —— 不确定就先 send_message 问 lead。
        |· 建队与中断（spawn_teammate / interrupt_agent）是 Lead 专属，你调用会被拒绝（TEAM_LEAD_REQUIRED）；
        |  要人帮忙就把活写清楚发给 lead，让它决定。
        |· 单条消息 ≤${limits.maxMessageBytes / 1024}KB；同时执行的成员上限 ${limits.maxConcurrent}。
        |· 用户看不到你的中间过程：结论落在最终回复里，产物写进工作区，并用 send_message(target="lead") 汇报。
    """.trimMargin()

    /* ---------------- 工具 ---------------- */

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "spawn_teammate"
            override val description = "创建一名具名、持久的 teammate 并立即派活。只有 Lead 能调用。" +
                "任务能拆成两条以上互不依赖的方向、或需要产出与审查分离时用它；一句话说不清怎么拆就别用。" +
                "名字小写 kebab、永久保留（创建失败也不复用）。context=fresh 不带 Lead 历史；fork 继承最近对话摘要。"
            override val parameters = schema(
                JSONObject()
                    .put("name", str("唯一名字，小写 kebab-case（a-z 0-9，单连字符分隔），≤64 字符"))
                    .put("description", str("一句话职责，会显示在 roster 里"))
                    .put("prompt", str("完整初始任务：背景、要做什么、验收标准"))
                    .put("context", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("fresh", "fork")))
                        .put("description", "fresh 不带 Lead 历史；fork 继承已完成轮次摘要。默认 fresh"))
                    .put("model", str("可选：该成员使用的模型 id；不填按子代理档（设置里的 subagentModel），也没配则跟 Lead 同一个模型")),
                listOf("name", "description", "prompt"),
            )
            override fun execute(args: JSONObject): String = guard {
                // 认人排在前：队友调用时 leadConfig() 往往是空的，于是它先撞上
                // 「不在对话轮次内，拿不到模型配置」—— 报的是「你换个时机再试」，
                // 真相却是「这件事永远轮不到你做」（桌面 roster.ts:234 就是第一句 TEAM_LEAD_REQUIRED）。
                // 服务层里还有同一刀，这里是让**错误信息**先对上身份。
                TeamCall.requireLead("创建队友（spawn_teammate）")
                val lead = leadConfig() ?: throw TeamError("TEAM_NO_LEAD_CONTEXT", "不在对话轮次内，拿不到模型配置")
                val m = rt().spawn(
                    lead,
                    alias(args, "name"),
                    alias(args, "description"),
                    alias(args, "prompt"),
                    args.optString("context").ifBlank { "fresh" },
                    args.optString("model"),
                )
                JSONObject().apply {
                    put("ok", true)
                    put("member", m.view(MemberLlm.resolve(lead, "").model))
                    put("note", "已创建并开始工作；用 list_agents 看状态、send_message 追加指示、wait_agent 等进展")
                }.toString()
            }
        },

        object : ToolSpec {
            override val name = "send_message"
            override val description = "给另一个团队成员发一条消息。running 会在最近的步骤边界收到；inactive 会被唤醒并冷恢复一轮。" +
                "teammate 可以用 target=lead 向 Lead 汇报（Lead 在下一步或 wait_agent 时认领）。" +
                "投递成功不代表对方已处理。"
            override val parameters = schema(
                JSONObject()
                    .put("target", str("成员名字（spawn_teammate / list_agents 返回的 target）；teammate 可用 lead 汇报给 Lead"))
                    .put("message", str("自包含的消息内容")),
                listOf("target", "message"),
            )
            override fun execute(args: JSONObject): String = guard {
                val r = rt().send(alias(args, "target"), alias(args, "message"), leadConfig())
                JSONObject().apply {
                    put("ok", true)
                    put("sent", true)
                    put("target", r.optString("target"))
                    put("status", r.optString("status"))
                    put("note", r.optString("note"))
                }.toString()
            }
        },

        object : ToolSpec {
            override val name = "list_agents"
            override val description = "列出 Lead 与全部 teammate：target、role、status、description、context、model、diagnostics。" +
                "inactive 只表示没有轮次在跑，不是任务结果。"
            override val parameters = schema(JSONObject())
            override val executionMode = ToolExecutionMode.PARALLEL
            override fun execute(args: JSONObject): String = guard {
                JSONObject().apply {
                    put("ok", true)
                    put("agents", rt().memberViews())
                    put("note", "用 target 调 send_message / interrupt_agent，或作为任务的 owner")
                }.toString()
            }
        },

        object : ToolSpec {
            override val name = "wait_agent"
            override val description = "等待调用之后的下一次团队变化（成员状态 / 消息 / 任务）。不会唤醒 inactive 成员；" +
                "没有别的成员在 running/provisioning 时立即返回 noProgress。醒来后重新 list，不要轮询。"
            override val parameters = schema(
                JSONObject().put("timeout_ms", num("等待毫秒，10000–3600000，默认 30000")),
            )
            override fun execute(args: JSONObject): String = guard {
                val r = rt()
                val sid = r.leadSession()
                val timeout = if (args.has("timeout_ms")) args.optLong("timeout_ms", -1) else 30_000L
                if (timeout < 10_000 || timeout > 3_600_000) {
                    throw TeamError("TEAM_INVALID_TIMEOUT", "timeout_ms 必须是 10000–3600000 的整数")
                }
                // 先认领已经到达的汇报：队友可能刚说完就 idle 了，此时 hasActivePeer=false，
                // 直接返回 noProgress 会把「它刚说的话」留在收件箱里没人看
                val arrived = r.drainLeadInbox(sid)
                if (arrived.isNotEmpty()) {
                    return@guard JSONObject().apply {
                        put("ok", true)
                        put("timedOut", false)
                        put("messages", JSONArray(arrived))
                        put("note", "队友汇报已到；重新 list_agents / team_task_list 看现状")
                    }.toString()
                }
                if (!r.hasActivePeer("lead")) {
                    return@guard JSONObject().apply {
                        put("ok", true)
                        put("timedOut", false)
                        put("noProgress", JSONObject().apply {
                            put("reason", "no-active-peer")
                            put("message", "没有其他成员在 running/provisioning；wait_agent 不会唤醒 inactive 成员。" +
                                "先 list_agents + team_task_list，再用 send_message 唤醒需要的人")
                        })
                    }.toString()
                }
                val since = r.revision()
                val cancelNow = { ToolExecContext.currentOrNone().cancelledNow() }
                when (r.waitForChange(since, timeout, cancelNow)) {
                    TeamRuntime.WaitOutcome.CANCELLED -> JSONObject().apply {
                        put("ok", false)
                        // 桌面 activity.ts:50 对「等待被中断」给的码是 TEAM_WAIT_ABORTED
                        put("code", "TEAM_WAIT_ABORTED")
                        put("cancelled", true)
                        put("note", "本轮已被用户停止，wait_agent 立即返回；不要重试")
                    }.toString()

                    TeamRuntime.WaitOutcome.CLOSED -> JSONObject().apply {
                        put("ok", true)
                        put("timedOut", false)
                        put("disposed", true)
                        put("noProgress", JSONObject().apply {
                            put("reason", "team-disposed")
                            put("message", "团队插件已卸载，等待被取消；不要再轮询")
                        })
                    }.toString()

                    TeamRuntime.WaitOutcome.TIMEOUT -> JSONObject().apply {
                        put("ok", true)
                        put("timedOut", true)
                        put("revision", r.revision())
                        put("note", "等待超时，重新 list 后决定是否继续等")
                    }.toString()

                    TeamRuntime.WaitOutcome.CHANGED -> {
                        val got = r.drainLeadInbox(sid)
                        JSONObject().apply {
                            put("ok", true)
                            put("timedOut", false)
                            put("revision", r.revision())
                            if (got.isNotEmpty()) put("messages", JSONArray(got))
                            put("note", "团队有变化：重新 list_agents / team_task_list 看现状")
                        }.toString()
                    }
                }
            }
        },

        object : ToolSpec {
            override val name = "interrupt_agent"
            override val description = "中断一名 teammate 的当前轮次，保留它的待收消息。只有 Lead 能调用。"
            override val parameters = schema(
                JSONObject().put("target", str("成员名字")),
                listOf("target"),
            )
            override fun execute(args: JSONObject): String = guard {
                val r = rt().interrupt(alias(args, "target"))
                JSONObject().apply {
                    put("ok", true)
                    put("target", r.optString("target"))
                    put("previousStatus", r.optString("previousStatus"))
                    put("status", "inactive")
                }.toString()
            }
        },

        object : ToolSpec {
            override val name = "team_task_create"
            override val description = "在共享任务板创建一条待办（无 owner）。blocked_by 里的任务必须先完成；" +
                "write_scopes 声明本任务预计改动的路径前缀；与别人进行中的范围重叠时任务板给出「写冲突」提示（不拦写入），据此分工。"
            override val parameters = schema(
                JSONObject()
                    .put("subject", str("简洁标题"))
                    .put("description", str("完整说明与验收标准"))
                    .put("blocked_by", arr("必须先完成的任务 id"))
                    .put("write_scopes", arr("预计改动的路径前缀，工作区相对路径")),
                listOf("subject", "description"),
            )
            override fun execute(args: JSONObject): String = guard {
                val b = board()
                val t = b.create(
                    alias(args, "subject"),
                    alias(args, "description"),
                    listOfStrings(args, "blocked_by", "blockedBy"),
                    listOfStrings(args, "write_scopes", "writeScopes"),
                )
                syncMission(b, t, "create")
                JSONObject().put("ok", true).put("task", t.view(b.readyOf(t), b.warningsOf(t))).toString()
            }
        },

        object : ToolSpec {
            override val name = "team_task_list"
            override val description = "列出共享任务（默认全部活动任务）：ready、owner、revision、依赖、写范围冲突提示。"
            override val parameters = schema(
                JSONObject()
                    .put("status", str("可选：pending / in_progress / completed"))
                    .put("owner", str("可选：成员 target；unowned 表示无主"))
                    .put("ready", bool("可选：只看可认领 / 未就绪"))
                    .put("cursor", num("偏移，默认 0"))
                    .put("limit", num("条数 1–100，默认 50")),
            )
            override val executionMode = ToolExecutionMode.PARALLEL
            override fun execute(args: JSONObject): String = guard {
                val b = board()
                val statusRaw = alias(args, "status")
                val statuses = statusRaw.split(',', ' ')
                    .mapNotNull { s -> TaskStatus.values().firstOrNull { it.wire == s.trim() }?.takeIf { it != TaskStatus.DELETED } }
                    .toSet().takeIf { it.isNotEmpty() }
                val ready = if (args.has("ready")) args.optBoolean("ready") else null
                val (rows, next) = b.list(
                    statuses,
                    alias(args, "owner").takeIf { it.isNotBlank() },
                    ready,
                    args.optInt("cursor", 0),
                    args.optInt("limit", 50),
                )
                JSONObject().apply {
                    put("ok", true)
                    put("tasks", JSONArray(rows))
                    if (next != null) put("nextCursor", next)
                    put("board", b.boardView())
                }.toString()
            }
        },

        object : ToolSpec {
            override val name = "team_task_get"
            override val description = "读取一条任务的完整最新值。改之前必须先读，用返回的 revision 做 CAS。"
            override val parameters = schema(
                JSONObject().put("task_id", str("任务 id，如 task-3")),
                listOf("task_id"),
            )
            override val executionMode = ToolExecutionMode.PARALLEL
            override fun execute(args: JSONObject): String = guard {
                val b = board()
                val id = alias(args, "task_id")
                val t = b.get(id) ?: throw TeamError("TEAM_TASK_NOT_FOUND", "没有任务：$id")
                JSONObject().put("ok", true).put("task", t.view(b.readyOf(t), b.warningsOf(t))).toString()
            }
        },

        object : ToolSpec {
            override val name = "team_task_update"
            override val description = "用最新 revision 对任务做 CAS 变更。action：claim / release / edit / set_dependencies / complete / reopen / reassign / delete。" +
                "revision 过期会被拒绝（不会覆盖别人的成果）。只有 Lead 能 reassign。"
            override val parameters = schema(
                JSONObject()
                    .put("task_id", str("任务 id"))
                    .put("expected_revision", num("从 team_task_get / team_task_list 拿到的最新 revision"))
                    .put("action", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("claim", "release", "edit", "set_dependencies", "complete", "reopen", "reassign", "delete"))))
                    .put("subject", str("edit：新标题"))
                    .put("description", str("edit：新说明"))
                    .put("blocked_by", arr("set_dependencies：完整依赖列表"))
                    .put("write_scopes", arr("edit：新的写范围"))
                    .put("owner", str("reassign：成员 target 或 lead（Lead 把活收回自己手上）；省略表示取消指派")),
                listOf("task_id", "expected_revision", "action"),
            )
            override fun execute(args: JSONObject): String = guard {
                val b = board()
                val action = alias(args, "action")
                val ownerArg = if (args.has("owner")) args.optString("owner") else null
                // 桌面：reassign 的接收者必须是名册里的活跃成员（resolveActiveMember 找不到就报错）。
                // 手机端之前直接接受任意名字 —— 名字打错一个字母，就得到一个「无人认领」的任务。
                if (action == "reassign" && !ownerArg.isNullOrBlank()) {
                    // lead 是名册之外的伪行（桌面 roster.ts 的 resolveActiveMember 也这么认）：
                    // Lead 把活收回自己手上是正常操作，不认它就只能眼看着改派失败。
                    if (ownerArg != "lead") {
                        val m = rt().currentRoster().get(ownerArg)
                        // 桌面 `resolveActiveMember` 只认 phase==='active'，且「查无此人」
                        // 与「有这个人但不活跃」是同一个码（TEAM_MEMBER_NOT_FOUND）：
                        // provisioning 还没建完、failed 已经起不来，指派给它们等于把任务
                        // 挂在一个永远不会来领的人身上。区别写在 message 里。
                        if (m == null || m.phase != MemberPhase.ACTIVE) {
                            throw TeamError(
                                "TEAM_MEMBER_NOT_FOUND",
                                "活跃成员「$ownerArg」不存在，不能接任务：" + when {
                                    m == null -> "名册里没有这个名字（用 list_agents 确认）"
                                    m.phase == MemberPhase.PROVISIONING -> "它还在创建中，等它 active 再指派"
                                    else -> "它创建失败（${m.lastError}）"
                                },
                            )
                        }
                    }
                }
                val t = b.update(
                    id = alias(args, "task_id"),
                    expectedRevision = args.optInt("expected_revision", args.optInt("expectedRevision", -1)),
                    action = alias(args, "action"),
                    actor = actor(),
                    subject = args.optString("subject").takeIf { args.has("subject") },
                    description = args.optString("description").takeIf { args.has("description") },
                    blockedBy = if (args.has("blocked_by") || args.has("blockedBy")) {
                        listOfStrings(args, "blocked_by", "blockedBy")
                    } else null,
                    writeScopes = if (args.has("write_scopes") || args.has("writeScopes")) {
                        listOfStrings(args, "write_scopes", "writeScopes")
                    } else null,
                    owner = if (args.has("owner")) args.optString("owner") else null,
                )
                syncMission(b, t, action)
                JSONObject().put("ok", true).put("task", t.view(b.readyOf(t), b.warningsOf(t))).toString()
            }
        },

        object : ToolSpec {
            override val name = "team_status"
            override val description = "团队全景：成员（状态/轮次/工具数/token/当前动作）、任务板统计、并发与预算上限、当前 revision。" +
                "给用户汇报团队进展时用它，不要凭记忆编。"
            override val parameters = schema(JSONObject())
            override val executionMode = ToolExecutionMode.PARALLEL
            override fun execute(args: JSONObject): String = guard {
                JSONObject().put("ok", true).put("team", rt().snapshot()).toString()
            }
        },
    )
}
