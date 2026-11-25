package ai.deepseek.harness.mobile.agent

import ai.deepseek.harness.mobile.kernel.ToolKernel
import ai.deepseek.harness.mobile.kernel.device.ImageResize
import ai.deepseek.harness.mobile.kernel.plugin.pick
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Agent 驱动 —— 对应桌面 Harness 的 `agent` + `driver`。
 *
 * 一轮（turn）由若干步（step）组成，每步 = 一次模型请求 + 一批工具调用。
 * 与桌面版一一对应的四个介入点，全部落在 [HookBus] 上：
 *   agent/pre-step   认领待办输入（steering）、决定进不进这一步
 *   agent/request    组装请求（压缩、工具目录、系统提示）
 *   agent/request-error  请求失败后的重试/放弃决策
 *   agent/turn-stopping  自然停下前的收尾检查
 *
 * 事件既写 [SessionStore]（可回放），也实时推给前端（只做渲染）。
 * 前端因此不再持有循环 —— 这是「内核在原生、UI 只是壳」的分界线。
 */
class AgentDriver(
    private val kernel: ToolKernel,
    private val hooks: HookBus,
    private val sessions: SessionStore,
    private val todos: TodoStore,
    private val emit: (JSONObject) -> Unit,
    private val log: (String) -> Unit = {},
    /** 账号登录态 token（DeepSeek 平台额度）。只在账号端点使用，第三方端点仍用配置里的 key */
    private val accountToken: (() -> String?)? = null,
) {

    private val pipeline = ToolPipeline(kernel.registry, kernel.workspace, hooks, log)
    private val subagents = SubagentRunner(kernel, hooks, log)
    private val compactor = Compactor(log)
    private val router = IntentRouter(log)

    private companion object {
        /**
         * 「始终允许」的会话级授权：sessionId → 已授权工具名集合（进程内存活，跨轮次）。
         * 只按工具名记 —— 命中即放行同名调用；敏感界面/敏感应用闸门（手机操控等）
         * 自带逐次确认，不查这里。
         */
        val alwaysApprovedBySession =
            java.util.concurrent.ConcurrentHashMap<String, MutableSet<String>>()
        /** 自动交付兜底认可的扩展名：都是「给人看/给人拿」的产物，代码文件不在此列 */
        val AUTO_DELIVER_EXT = setOf(
            "md", "markdown", "txt", "csv", "json", "html", "docx", "xlsx", "pptx", "pdf", "zip",
            "png", "jpg", "jpeg", "webp", "gif", "svg", "mp4",
        )

        fun guessMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
            "md", "markdown" -> "text/markdown"
            "txt" -> "text/plain"
            "csv" -> "text/csv"
            "json" -> "application/json"
            "html" -> "text/html"
            "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            "pdf" -> "application/pdf"
            "zip" -> "application/zip"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "svg" -> "image/svg+xml"
            "mp4" -> "video/mp4"
            else -> "application/octet-stream"
        }

        /**
         * 标题生成专用单线程执行器：daemon，进程退出不阻塞。
         * 标题是一次完整的非流式 HTTP（可能数秒），绝不许压住 turn_end —— 那会让
         * 前端 busy 态迟迟不解，体感就是「轮尾卡一下」。所以 turn_end 先发，标题慢慢来。
         */
        val titleExecutor = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
            Thread(r, "dsh-title").apply { isDaemon = true }
        }

        /** per-session 去重：同一会话同一时刻只允许一个标题任务在跑 */
        val titleInFlight = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    }

    private val cancelled = AtomicBoolean(false)
    private val steering = LinkedBlockingQueue<String>()
    @Volatile private var client: LlmClient? = null
    @Volatile private var cfg: AgentConfig? = null

    /* 计划评审 / 危险操作确认：一次性等待槽 */
    private class Waiter<T> {
        val latch = CountDownLatch(1)
        val value = AtomicReference<T?>()
        fun done(v: T) { value.set(v); latch.countDown() }
        fun await(seconds: Long): T? { latch.await(seconds, TimeUnit.SECONDS); return value.get() }
    }

    private val planWaiter = AtomicReference<Waiter<PlanDecision>?>(null)
    private val askWaiters = java.util.concurrent.ConcurrentHashMap<String, Waiter<String>>()
    private val approveWaiters = java.util.concurrent.ConcurrentHashMap<String, Waiter<Boolean>>()
    /** approval_request 的 id → 工具名：前端选「始终允许」时按它记授权 */
    private val approvalNames = java.util.concurrent.ConcurrentHashMap<String, String>()
    /** approval id → 用户选的档位（once / always / deny），结算时落审计与证据要用 */
    private val approvalScopes = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** 运行中权限热更新：设置页切「完全访问」要立刻作用于本轮剩余的工具调用 */
    @Volatile
    private var livePermission: String? = null
    private var pendingPlan: JSONObject? = null

    /** read_image 读取的图片（OpenAI image_url part），在下一轮请求前注入对话 */
    private val injectedImages = mutableListOf<JSONObject>()

    data class PlanDecision(val approved: Boolean, val feedback: String)

    fun cancel() {
        cancelled.set(true)
        client?.cancel()
        // 长等待不一定能靠线程中断收尾（工具可能忽略 InterruptedException）。
        // 这里主动释放所有「等人」的闸门，保证停止键立刻有结果：
        // 计划评审 → 拒绝、提问 → 已停止、危险确认 → 拒绝。
        planWaiter.getAndSet(null)?.done(PlanDecision(false, "用户已停止本轮"))
        pendingPlan = null
        for ((id, waiter) in askWaiters) {
            askWaiters.remove(id)
            runCatching { waiter.done("（用户已停止本轮）") }
        }
        for ((id, waiter) in approveWaiters) {
            approveWaiters.remove(id)
            runCatching { waiter.done(false) }
        }
    }

    fun steer(text: String) {
        if (text.isNotBlank()) steering.offer(text)
    }

    fun decidePlan(approved: Boolean, feedback: String = "") {
        planWaiter.get()?.done(PlanDecision(approved, feedback))
    }

    /** 用户回答了 ask_user_question 的问题 */
    fun answer(id: String, label: String) {
        askWaiters.remove(id)?.done(label)
    }

    fun decideApproval(id: String, allowed: Boolean) {
        approvalScopes[id] = if (allowed) "once" else "deny"
        approveWaiters.remove(id)?.done(allowed)
    }

    /**
     * 带档位的确认回传（前端「允许一次 / 始终允许 / 拒绝」三个按钮）。
     * 「始终允许」记会话级授权：同会话后续对同一工具的 approve 直接放行 ——
     * 修复「点了始终允许，下一条照样弹框」；敏感操作由各自闸门另行逐次确认，不受此影响。
     *
     * 例外：这一轮绑定了 Mission（唤醒续轮、或为某件事专门跑的一轮）时，
     * 「始终允许」只记在那件事上（Mission.grants），不写会话表 ——
     * 用户批准的是「这件事里以后不用再问我」，不是「这个工具在本会话从此免问」。
     */
    fun decideApprovalScope(id: String, allowed: Boolean, always: Boolean) {
        approvalScopes[id] = if (!allowed) "deny" else if (always) "always" else "once"
        val name = approvalNames.remove(id)
        val mission = cfg?.missionId.orEmpty()
        if (allowed && always && mission.isBlank() && !name.isNullOrBlank()) {
            alwaysApprovedBySession.computeIfAbsent(sidOrNull() ?: "") {
                java.util.Collections.synchronizedSet(LinkedHashSet())
            }.add(name)
        }
        approveWaiters.remove(id)?.done(allowed)
    }

    private fun sidOrNull(): String? = cfg?.sessionId

    /**
     * 这一轮真正生效的权限档：会话档与 Mission 档里**更严**的那个。
     * 沙箱、Gate、审批三处都读它，否则会出现「界面写着只读、工具按标准跑」。
     * Mission 只能收窄：账本里的字段不能把用户手里的全局闸门抬起来。
     */
    private fun effectivePermission(): String {
        val session = livePermission ?: cfg?.permission ?: "ask"
        val mission = cfg?.missionId.orEmpty()
        if (mission.isBlank()) return session
        return ai.deepseek.harness.mobile.kernel.mission.MissionRegistry.effectivePermission(
            session, kernel.missions.scopeOf(mission).optString("mode"),
        )
    }

    /** 设置页切换权限档位时热更新运行中的轮次（「完全访问」立即生效，不等下一轮） */
    fun updatePermission(permission: String) {
        if (permission.isBlank()) return
        livePermission = permission
        // 会话抬到 full，也顶不过这件事被收窄成只读：沙箱按合档结果应用
        val eff = effectivePermission()
        runCatching { kernel.sandbox.apply(eff) }
        log("权限热更新 → $permission（本轮生效 $eff）")
    }

    /* ---------------- 主流程 ---------------- */

    /**
     * 把「这一轮是为哪件事跑的」写回那条 Mission 的证据。
     * 引用优先用唤醒记录 id（正文能从唤醒队列现取）；手动接着跑的轮次没有唤醒记录，用轮次 id。
     */
    private fun recordWakeEvidence(config: AgentConfig, turnId: String) {
        val ref = if (config.wakeId.isNotBlank()) config.wakeId else "turn:$turnId"
        runCatching {
            kernel.missions.appendEvidence(
                config.missionId,
                JSONObject().put("type", "wake")
                    .put("ref", ref)
                    .put("title", if (config.wake) "唤醒替我续了这一轮" else "为这件事跑了一轮")
                    .put("at", System.currentTimeMillis()),
            )
        }
    }

    fun run(turnId: String, config: AgentConfig) {
        cfg = config
        cancelled.set(false)
        val sid = config.sessionId
        val llm = LlmClient(config.baseUrl, config.apiKey, log, accountToken).also { client = it }

        // 沙箱模式由这一轮的权限档位派生（桌面 sandboxPolicy.resolve 的同构做法）；
        // 绑了 Mission 的轮次按合档结果走，只读的事不会因为有会话级 full 就写进去。
        kernel.sandbox.apply(effectivePermission())
        if (config.missionId.isNotBlank()) recordWakeEvidence(config, turnId)
        // 本轮产物统一在轮次结束时交付：这里开始缓冲中途 present 的卡片
        kernel.beginTurnDeliverables()
        val runtime = runtimeFor(config, turnId, sid)
        kernel.provideService("agent.runtime", runtime)
        // 会话级服务：会话查询/定时/子代理控制等工具从这里取「当前是谁在跑」
        kernel.provideService("agent.session", sid)
        kernel.provideService("agent.model", config.model)
        // 团队/插件要用完整轮次配置（端点、权限、预设、检索开关）：只给 model 不够\.\.\. 
        kernel.provideService("agent.config", config)
        // 表情包标注：仓库里只有 dataUrl，模型得先「看一眼」才知道画面内容
        kernel.provideService("agent.caption", VisionCaptioner(config, log))

        var turn: Turn? = null
        try {
            turn = prepareTurn(turnId, config, llm, runtime)
            // 与桌面 agent-loop 一致：步数不设人为上限，
            // 只要模型还返回工具调用就继续下一步，直到它自然停下或用户中止。
            while (!cancelled.get() && runStep(turn!!)) {
                // runStep 返回 true 表示「本轮还有工具结果要回灌，继续下一步」
            }
            finishTurn(turn!!)
        } catch (t: Throwable) {
            // 桌面 `TOOL_OUTCOME_UNKNOWN` 的手机端等价物：出错时把没配对的
            // assistant.tool_calls 补一条错误结果。少了这一步，下一次请求里
            // 就存在「有 tool_call 没有 tool 结果」的历史，OpenAI 兼容端点会直接 400，
            // 会话从此卡死；补上之后历史始终成对，模型也能看到上一次到底断在哪。
            turn?.let { runCatching { pairOrphanToolCalls(it, t) } }
            failTurn(sid, config, t)
        } finally {
            // 先让插件收尾（此时 agent.caption 等服务还在），再拆服务
            runCatching { kernel.endTurn() }
            client = null
            kernel.provideService("agent.runtime", null)
            kernel.provideService("agent.session", null)
            kernel.provideService("agent.model", null)
            kernel.provideService("agent.config", null)
            kernel.provideService("agent.caption", null)
        }
    }

    /**
     * 一轮的运行时状态。
     *
     * 拆方法之前这些变量是 `run` 里的十几个局部 var，任何一段想复用都得整段搬；
     * 集中成一个对象后，各步只依赖它，方法签名稳定。
     */
    private class Turn(
        val turnId: String,
        val sid: String,
        val config: AgentConfig,
        val llm: LlmClient,
        val runtime: ToolPipeline.RuntimeTools,
        val messages: MutableList<JSONObject>,
        /**
         * 本轮工具定义。**每一步开始时重算**（见 [runStep]）：
         * 自造插件在轮内装配/卸载后，同轮后续请求要立刻带上/摘掉对应 schema ——
         * 这是「装配即生效」承诺的实现点；冻结在轮开始时，新工具同轮就调不到。
         */
        var toolDefs: JSONArray?,
        /** 本轮消息在 [messages] 里的起点：压缩不得越过它（本轮刚发生的事不能被抽走） */
        val contextStart: Int,
        /** 扣掉工具 schema 后的有效窗口（压缩预算用） */
        val effWindow: Int,
        /** 本轮序号（事件里的 turn 字段；step 不等于 turn，不能混用）。默认 0 只为兼容旧调用点 */
        val turnNo: Int = 0,
    ) {
        var step = 0
        var promptTokens = 0
        var completionTokens = 0
        var finalText = ""
        /** 连续请求失败次数，成功后归零（桌面 retryPolicy 的 retry 计数语义） */
        var retries = 0
        /** 本轮 CONTEXT_OVERFLOW 强制压缩次数（桌面 maxOverflowRetries 的同义计数） */
        var overflowRetries = 0
        /** 本轮用户原话：压缩时用它定位「当前这句」的起点 */
        val userText: String get() = config.userText

        /**
         * max_tokens 被端点拒绝后的降档值（只作用于本轮）。
         * 用户把输出下限设成 64k，但有些端点（老版 deepseek-chat、部分兼容网关）
         * 上限仍是 8192；遇到 400 时降档重发一次，总比整轮失败好。
         */
        var maxOutOverride: Int? = null
        val startedAt = System.currentTimeMillis()
    }

    /** 意图分类 → 系统提示装配 → 历史压缩 → 首条 messages 与工具目录 */
    private fun prepareTurn(
        turnId: String,
        config: AgentConfig,
        llm: LlmClient,
        runtime: ToolPipeline.RuntimeTools,
    ): Turn {
        val sid = config.sessionId
        // WS1：必须在写本轮 user/message 之前从日志派生历史 —— 否则「当前这句」会既
        // 出现在派生历史里、又被压缩器追加一次，模型看到两遍同一句话。
        // 系统提示由下面单独装配，派生历史里的旧 system 段落要丢掉（只保留最新装配的一份）。
        val historyBeforeTurn = sessions.deriveMessages(sid)
            .filter { it.optString("role") != "system" }
        val intent = router.detect(
            text = config.userText,
            hasAttachments = config.attachments.isNotEmpty(),
            modePlan = config.planMode && !config.planApproved,
            goalActive = config.goalActive,
            toolsEnabled = config.toolsEnabled,
            priorKind = lastKind(sid),
            msgCount = config.history.size,
        )
        emit(ev("intent", intent.toJson()))
        sessions.append(sid, "intent/classified", intent.toJson())

        val turnNumber = sessions.summary(sid).optInt("turns") + 1
        emit(ev("turn_start", JSONObject().apply {
            put("turn", turnNumber)
            put("intent", intent.toJson())
        }))
        sessions.append(sid, "turn/start", JSONObject().put("turn", turnNumber).put("text", config.userText).put("intent", intent.toJson()))
        // 陪伴式畅聊那一轮的 userText 是「内心提示」，不是用户说的话：
        // 记成 user/message 会让会话历史里凭空多出一段用户从没打过的字。
        if (!config.companion) sessions.append(sid, "user/message", JSONObject().apply {
            put("turn", turnNumber)
            put("text", config.userText)
            // 唤醒续轮不是「用户此刻在说话」：审计回看时必须能分出谁开的口
            put("source", if (config.wake) "wake" else "human")
            if (config.missionId.isNotBlank()) put("missionId", config.missionId)
        })

        // Agent 预设：白名单圈定模型可见目录（桌面 preset 决定挂载哪些子插件的等价物）。
        // 与桌面一致：工具目录每轮完整在场（request-cache 稳定），模型自己决定是否调用；
        // 意图分析只提供策略段落，不裁剪工具目录。
        // 工具 schema 本身就要占几千个 prompt token：121 个工具的目录在云端 128k 上无所谓，
        // 在 8k 的本地模型上直接把窗口吃光（实测一个 "你好" 撑到 18738 tokens 被 400 拒绝）。
        // 按窗口分级收窄目录，再把这部分开销从压缩预算里扣掉。
        // 新的一轮：插件里按轮计数的状态（表情包一轮一个）必须清零
        runCatching { kernel.beginTurn() }
        val toolNames = currentToolNames(config)

        // 系统提示词与运行时上下文走两条通道（桌面同样切法）：
        //   system      —— 静态规则，每轮相同，能吃到前缀缓存
        //   runtimeCtx  —— 每轮都变的状态，单独一条消息，插在当前这句用户输入之前
        val preset = Presets.byId(config.preset)
        val assembler = PromptAssembler(hooks, log)
        val workspacePath = kernel.workspace.rootPath
        // 与子代理/成员共用同一个出口：模板、工作区、预设规则只有一份实现
        val system = AgentLoop.system(
            assembler, config, toolNames, workspacePath,
            intent = intent, skills = kernel.skills.catalogText(),
        )
        // PTC：补一段 SDK 速查（对齐桌面 PTC_ONLY_INSTRUCTION + 生成的 SDK 文档）——
        // 原生工具清单 + dsh.callTool 调用方式，替代被收口掉的 schema。
        val systemFinal = if (preset.id == "ptc") system + "\n\n" + ptcSdkSection(preset) else system
        val runtimeCtx = assembler.assembleContext(config, todos.read(sid), workspacePath)

        // WS1：日志即上下文。前端历史只在日志为空时兜底（v1 迁移期/首轮），并记降级。
        val picked = HistoryPolicy.pick(historyBeforeTurn, config.history)
        if (picked.degraded) {
            sessions.append(sid, "history/degraded", JSONObject().apply {
                put("reason", "log_empty_use_client_history")
                put("count", config.history.size)
            })
        }
        val history = picked.messages

        // 系统提示入日志：模型看见的每个字节都能从日志回放（桌面 system/message 的等价物）
        sessions.append(sid, "system/message", JSONObject().apply {
            put("turn", turnNumber)
            put("step", 0)
            put("text", systemFinal)
        })

        // 每个工具 schema 约 110 token（实测经验值），从窗口里先扣掉再交给压缩器，
        // 否则「预算够」但加上 tools 就超，模型端直接 400。
        // 窗口算法与子代理/成员共用一处（AgentRequest.effWindow），改口径只改那里
        val effWindow = AgentRequest.effWindow(config.contextWindow, toolNames.size)
        recordRequestEnvelope(sid, turnNumber, config, toolNames)
        val compacted = compactor.applySmart(
            llm = llm,
            model = config.model,
            system = systemFinal,
            history = history,
            userText = config.userText,
            contextWindow = effWindow,
            maxOut = config.maxOut,
            mode = config.compactMode,
            onCompacting = { before, budget ->
                // 摘要是一次真正的模型调用，可能几秒：先把状态推给界面，别让用户以为卡住
                emit(ev("compacting", JSONObject().put("before", before).put("budget", budget)))
                sessions.append(sid, "compaction/start", JSONObject().put("before", before).put("budget", budget))
            },
        )
        compacted.note?.let { note ->
            sessions.append(
                sid,
                "compaction/applied",
                JSONObject().put("dropped", compacted.dropped)
                    .put("summarized", compacted.summarized)
                    .put("folded", compacted.folded)
                    .put("before", compacted.beforeTokens)
                    .put("after", compacted.afterTokens)
                    .put("note", note),
            )
            emit(
                ev(
                    "compacted",
                    JSONObject().put("dropped", compacted.dropped)
                        .put("summarized", compacted.summarized)
                        .put("summarizedCount", compacted.summarizedCount)
                        .put("folded", compacted.folded)
                        .put("before", compacted.beforeTokens)
                        .put("after", compacted.afterTokens)
                        .put("note", note)
                        // 检查点正文随事件给界面：桌面压缩标记可展开看摘要，手机同样要给得出内容
                        .put("summary", compacted.summary ?: ""),
                ),
            )
        }

        val messages = mutableListOf<JSONObject>()
        messages.add(JSONObject().put("role", "system").put("content", systemFinal))
        // 运行时上下文快照插在历史之后、当前这句用户输入之前：桌面的位置也是这里，
        // 图的是「保留历史 + 最新状态 + 本轮提问」这个顺序，前两者都能被缓存。
        val ctxInsertAt = if (runtimeCtx.isBlank()) -1
        else compacted.messages.indexOfLast { it.optString("role") == "user" }
        compacted.messages.forEachIndexed { i, m ->
            if (i == ctxInsertAt) {
                messages.add(JSONObject().put("role", "user").put("content", runtimeCtx))
            }
            messages.add(JSONObject(m.toString()))
        }
        if (runtimeCtx.isNotBlank() && ctxInsertAt < 0) {
            messages.add(JSONObject().put("role", "user").put("content", runtimeCtx))
        }
        // 本轮起点：本条用户原话所在下标。压缩只允许动它之前的历史，
        // 否则「模型刚做完的事」会被压缩从眼前抽走（桌面 surface 替换也保留当前尾段）。
        // 附件/历史图片会在下面改写最后一条消息的 content，所以下标必须在此之前确定。
        var contextStart = messages.indexOfLast { it.optString("role") == "user" }
        if (contextStart < 0) contextStart = messages.size
        if (contextStart > 0 && messages[contextStart].optString("content") != config.userText) {
            val explicit = messages.indexOfLast {
                it.optString("role") == "user" && it.optString("content") == config.userText
            }
            if (explicit >= 0) contextStart = explicit
        }
        // 附件：图片走 OpenAI 多模态格式，文本文件直接拼进来
        attachContent(messages, config)
        // 历史里的图也要回到上下文里（见函数注释）
        attachHistoryImages(messages)

        val toolDefs = toolDefsFor(config)
        return Turn(turnId, sid, config, llm, runtime, messages, toolDefs, contextStart, effWindow, turnNumber)
    }

    /**
     * 按本轮的固定过滤器（预设白名单 / 窗口档 / 计划模式 / 团队互斥）计算**当前**可见工具集。
     *
     * 每一步都重算（见 [runStep]）：自造插件在轮内装配/卸载后，同轮后续请求要立刻
     * 带上/摘掉对应 schema。过滤规则本身仍取自本轮 config，不随注册表变化。
     */
    private fun currentToolNames(config: AgentConfig): List<String> {
        if (!config.toolsEnabled) return emptyList()
        val preset = Presets.byId(config.preset)
        // 目录大小按设置里的上下文窗口裁（规则与子代理/成员共用 Presets.catalogFor）
        val coreTools = Presets.catalogFor(config.contextWindow)
        // 桌面 agent-team-profile 的互斥规则：开启团队包后，subagent / subagent_fork
        // 工具与名称重叠的全局 child control 一律禁用 —— 两套委派不并存。
        // 团队的委派走 spawn_teammate；成员侧仍可用底层 Subagent 服务（TeamRuntime）。
        val teamEnabled = runCatching { kernel.service("team.runtime") != null }.getOrDefault(false)
        // 自造插件（运行时装配）的工具不受预设白名单限制：白名单圈的是内置目录，
        // 用户批准装配的动态能力被它过滤 = 「装了但永远调不到」（实测复现过）。
        // 计划模式/只读闸门已在 visibleTools 里先行生效，这里只放行动态工具的预设豁免。
        val dynamic = kernel.registry.dynamicToolNames()
        val visible = pipeline.visibleTools(config.planMode, config.planApproved)
            .filter { it in preset.allow || it in dynamic }
            .filter {
                coreTools == null || it in dynamic || it in coreTools ||
                    // 团队工具豁免窗口裁剪（桌面同义：作用域注册不受 restrict 过滤）
                    (teamEnabled && it in Presets.TEAM_TOOLS)
            }
            // 递归深度 0 = 禁用子智能体（桌面 subagentDepthZero 同义）：
            // 连 schema 都不给，模型不会去试一个注定被拒的调用
            .filter { it != "subagent" || (kernel.subagentLimits.maxDepth > 0 && !teamEnabled) }
            .filter { it != "subagent_fork" || !teamEnabled }
        // PTC 收口（对齐桌面 agent-tool-presentation mode:ptc）：模型直接可见的只有 run_code，
        // 原生工具改为 run_code 程序内经 dsh.callTool 子调度——schema 从 130 个降到 1 个。
        return if (preset.id == "ptc") listOf("run_code") else visible
    }

    /** 工具名集 → 请求用 tool 定义（含 schema 预算瘦身）；空集返回 null（请求不带 tools 字段）。 */
    private fun toolDefsFor(config: AgentConfig): JSONArray? {
        val names = currentToolNames(config)
        val schemas = if (names.isEmpty()) JSONArray() else kernel.schemas().let { all ->
            JSONArray().apply {
                for (i in 0 until all.length()) {
                    val s = all.optJSONObject(i) ?: continue
                    if (s.optString("name") in names) put(s)
                }
            }
        }
        return if (schemas.length() == 0) null else LlmClient.toolDefs(schemas)
    }

    /** tool 定义数组里的工具名集合（diff 用）。wire 是 OpenAI 嵌套格式：名字在 `function.name`。 */
    private fun namesOf(defs: JSONArray?): Set<String> = buildSet {
        if (defs != null) for (i in 0 until defs.length()) {
            val o = defs.optJSONObject(i) ?: continue
            val n = o.optJSONObject("function")?.optString("name").takeUnless { it.isNullOrBlank() }
                ?: o.optString("name")
            if (n.isNotBlank()) add(n)
        }
    }

    /**
     * 记录请求信封（桌面 `request/header` + `request/context` 的手机等价物）。
     *
     * header 只在模型/工具目录变化时追加（reason=initial/change），避免每轮写一条；
     * context 记录有效窗口，便于回放时解释「当时为什么压缩/为什么 400」。
     */
    private fun recordRequestEnvelope(
        sid: String,
        turnNumber: Int,
        config: AgentConfig,
        toolNames: List<String>,
    ) {
        runCatching {
            val header = JSONObject().apply {
                put("model", config.model)
                put("tools", JSONArray(toolNames.sorted()))
                put("maxOut", config.maxOut)
                put("reasoningEffort", config.reasoningEffort)
            }
            val last = sessions.read(sid).lastOrNull { it.optString("type") == "request/header" }
                ?.optJSONObject("header")
            if (last == null) {
                sessions.append(sid, "request/header", JSONObject().put("turn", turnNumber)
                    .put("header", header).put("reason", "initial"))
            } else if (last.optJSONArray("tools")?.toString() != header.optJSONArray("tools")?.toString() ||
                last.optString("model") != header.optString("model")
            ) {
                sessions.append(sid, "request/header", JSONObject().put("turn", turnNumber)
                    .put("header", header).put("reason", "change"))
            }
            val context = JSONObject().apply {
                put("turn", turnNumber)
                put("provider", config.baseUrl)
                put("model", config.model)
                put("contextWindow", config.contextWindow)
            }
            val lastContext = sessions.read(sid).lastOrNull { it.optString("type") == "request/context" }
            if (lastContext?.optString("model") != context.optString("model") ||
                lastContext?.optInt("contextWindow") != context.optInt("contextWindow")
            ) {
                sessions.append(sid, "request/context", context)
            }
        }
    }

    /**
     * 跑一步：认领 steering → 请求模型（含重试）→ 记录用量 → 执行工具。
     *
     * @return true 表示模型还要继续（有工具结果回灌），false 表示本轮该收尾了
     */
    private fun runStep(turn: Turn): Boolean {
        turn.step++
        claimSteering(turn)
        // WS3：每一步之前的压力压缩（桌面 agent/pre-step 触发点），只动本轮之前的历史
        compactInTurn(turn)
        emit(ev("step_start", JSONObject().put("round", turn.step)))
        sessions.append(turn.sid, "step/start", JSONObject().put("round", turn.step))

        // 自造插件同轮生效：每步重算工具目录，与上一步不同就换上（桌面 Cordis
        // 「每请求收集工具」的同语义）。轮内装配/卸载后，下一份请求立刻生效；
        // 代价是本轮请求前缀变化让 provider 缓存失效一次 —— 自装配能力的固有成本。
        val freshDefs = toolDefsFor(turn.config)
        log("step${turn.step} 工具集 fresh=${namesOf(freshDefs).size} frozen=${namesOf(turn.toolDefs).size} " +
            "dynamic=${kernel.registry.dynamicToolNames().sorted()} preset=${turn.config.preset} tools=${turn.config.toolsEnabled}")
        // 不能只比工具名：探测/自造插件可能只改 schema（枚举、描述）而不增删工具，
        // 只按名字判断会把旧枚举一路用到轮末。整份定义逐字比较，变了就换。
        val schemaChanged = freshDefs?.toString() != turn.toolDefs?.toString()
        if (schemaChanged) {
            val added = (namesOf(freshDefs) - namesOf(turn.toolDefs)).sorted()
            val removed = (namesOf(turn.toolDefs) - namesOf(freshDefs)).sorted()
            if (added.isNotEmpty() || removed.isNotEmpty()) {
                log("本轮工具目录变更：+${added} -${removed}")
                emit(ev("notice", JSONObject().put("level", "info").put("text",
                    "工具目录已更新" +
                        (if (added.isNotEmpty()) "：新增 ${added.joinToString("、")}" else "") +
                        (if (removed.isNotEmpty()) "；移除 ${removed.joinToString("、")}" else ""))))
                sessions.append(turn.sid, "request/tools", JSONObject()
                    .put("turn", turn.turnNo).put("step", turn.step)
                    .put("added", JSONArray(added)).put("removed", JSONArray(removed)))
            } else {
                log("本轮工具 schema 变更（枚举/描述更新，工具名未变）")
            }
            turn.toolDefs = freshDefs
        }

        val result = requestWithRetry(turn, buildBody(turn))
        recordUsage(turn, result)

        if (result.toolCalls.isEmpty()) return false

        val calls = appendToolCalls(turn, result)
        executeTools(turn, calls)
        sessions.append(turn.sid, "step/end", JSONObject().put("round", turn.step).put("tools", calls.size))
        return true
    }

    /**
     * 轮内压力压缩（桌面 `agent/pre-step` 的压缩监听器）：只压缩 [Turn.contextStart]
     * 之前的历史，本轮已经发生的调用/结果原样保留。
     *
     * 第一步跳过：prepareTurn 刚做过一次轮首压缩，紧接着再量一遍是白花钱。
     * 无收益（[Compactor.Result.shrunk] 为 false）时不动 messages。
     */
    private fun compactInTurn(turn: Turn) {
        if (turn.step <= 1) return
        val system = turn.messages.firstOrNull { it.optString("role") == "system" }
            ?.optString("content").orEmpty()
        val result = compactor.compactInTurn(
            llm = turn.llm,
            model = turn.config.model,
            system = system,
            messages = turn.messages,
            keepFrom = turn.contextStart,
            contextWindow = turn.effWindow,
            maxOut = turn.config.maxOut,
            mode = turn.config.compactMode,
            onCompacting = { before, budget ->
                emit(ev("compacting", JSONObject().put("before", before).put("budget", budget)))
                sessions.append(turn.sid, "compaction/start", JSONObject().apply {
                    put("turn", turn.turnNo); put("before", before); put("budget", budget)
                })
            },
        )
        if (!result.shrunk) return
        turn.messages.clear()
        turn.messages.addAll(result.messages)
        logCompaction(turn, result, trigger = "pressure", phase = "step")
    }

    /** 压缩结果落盘 + 推前端（轮首/轮内/溢出三条路径共用）。 */
    private fun logCompaction(turn: Turn, result: Compactor.Result, trigger: String, phase: String) {
        sessions.append(turn.sid, "compaction/applied", JSONObject().apply {
            put("turn", turn.turnNo); put("phase", phase); put("trigger", trigger)
            put("dropped", result.dropped); put("summarized", result.summarized)
            put("summarizedCount", result.summarizedCount)
            put("folded", result.folded)
            put("before", result.beforeTokens); put("after", result.afterTokens)
            put("note", result.note ?: "")
            put("summary", result.summary ?: "")
        })
        emit(ev("compacted", JSONObject().apply {
            put("turn", turn.turnNo); put("trigger", trigger)
            put("dropped", result.dropped); put("summarized", result.summarized)
            put("summarizedCount", result.summarizedCount)
            put("folded", result.folded)
            put("before", result.beforeTokens); put("after", result.afterTokens)
            put("note", result.note ?: ""); put("summary", result.summary ?: "")
        }))
    }

    /** agent/pre-step：插件先看本轮、再把用户中途补充（steering）认领进来 */
    private fun claimSteering(turn: Turn) {
        // session 一定要给：团队插件要据此把「队友汇报」投进正确的会话，
        // 只给 messages 的话多会话下会把 A 的汇报塞进 B 的对话
        val steerCtx = HookBus.HookContext("agent/pre-step").apply {
            put("messages", turn.messages)
            put("session", turn.sid)
        }
        hooks.waterfall<PromptAssembler.Section>("agent/pre-step", PromptAssembler.Section(emptyList()), steerCtx)
        val steered = mutableListOf<String>()
        while (true) { steering.poll()?.let { steered.add(it) } ?: break }
        if (steered.isEmpty()) return
        steered.forEach {
            turn.messages.add(JSONObject().put("role", "user").put("content", "（用户中途补充）$it"))
        }
        sessions.append(turn.sid, "user/steer", JSONObject().put("text", steered.joinToString("\n")))
        emit(ev("steer", JSONObject().put("text", steered.joinToString("\n"))))
    }

    private fun buildBody(turn: Turn): JSONObject = JSONObject().apply {
        val config = turn.config
        put("model", config.model)
        put("messages", JSONArray(turn.messages.map { it }))
        put("stream", true)
        // 默认按用户设置的 64k 上限发；端点明确拒绝时由 requestWithRetry 降档并记在本轮
        put("max_tokens", turn.maxOutOverride ?: config.maxOut)
        // 档位是「配置里填的英文标识」；off 必须显式关思考（官方端点默认开启，不发关不掉）
        if (config.reasoningEffort.isNotBlank()) {
            when (config.reasoningEffort) {
                // 开关型模型：只认 thinking: enabled / disabled，没有强度档位
                "off" -> put("thinking", JSONObject().put("type", "disabled"))
                "on", "enabled" -> put("thinking", JSONObject().put("type", "enabled"))
                else -> put("reasoning_effort", config.reasoningEffort)
            }
        }
        if (turn.toolDefs != null) { put("tools", turn.toolDefs); put("tool_choice", "auto") }
    }

    /**
     * 请求模型；失败时走 `agent/request-error` 瀑布 + 内置重试预算。
     *
     * 重试在原地循环（不消耗步数，等价桌面「重跑同一个 step」），
     * 退避可被用户中止打断——点停止要立刻生效，不能等满一个间隔。
     */
    private fun requestWithRetry(turn: Turn, body: JSONObject): LlmClient.Result {
        while (true) {
            if (cancelled.get()) throw LlmClient.LlmError("已停止", "ABORTED")
            val live = StringBuilder()
            // 流式合批交给 StreamFlusher：40ms 固定节拍兜底 + 64 字阈值。
            // 为什么不能只在「下一条 chunk 到达」时刷：chunk 之间天然有间隔，
            // 几十个字会压在缓冲里等下一块，观感就是「明明在出字却半天不动」。
            // 三条流式链路（内核轮次 / 桥的 OpenAI 流 / 桥的 Messages 流）共用这一份规则。
            val flusher = ai.deepseek.harness.mobile.agent.StreamFlusher(
                onText = { t -> emit(ev("delta", JSONObject().put("text", t))) },
                onThink = { t -> emit(ev("reasoning", JSONObject().put("text", t))) },
            )
            try {
                val r = turn.llm.stream(
                    body,
                    onDelta = { chunk ->
                        live.append(chunk)
                        flusher.pushText(chunk)
                    },
                    onReasoning = { chunk -> flusher.pushThink(chunk) },
                )
                flusher.finish()
                return r
            } catch (e: LlmClient.LlmError) {
                flusher.finish()
                // 取消时把已流给用户的文本归档成 interrupted 锚点（桌面 assistant/message
                // interrupted:true 的等价物）：下一次请求因此包含用户真正看到的字，而不是丢掉。
                if (e.code == "ABORTED" && live.isNotBlank()) {
                    runCatching { archiveInterrupted(turn, live.toString()) }
                }
                // WS3：CONTEXT_OVERFLOW 先压缩、只有产生真实缩减才重发一次
                // （桌面 compaction-basic 的 agent/request-error 分支；无收益不重发）
                if (e.code == "CONTEXT_OVERFLOW" && !cancelled.get() &&
                    turn.overflowRetries < Compactor.MAX_OVERFLOW_RETRIES
                ) {
                    if (recoverOverflow(turn, body)) continue
                }
                // 端点不接受 64k 输出：降档到 8192 再试一次（只在本轮生效，不改用户设置）
                val msg = (e.message ?: "").lowercase()
                val outRejected = e.status == 400 && (msg.contains("max_tokens") || msg.contains("max output") ||
                    msg.contains("completion") || msg.contains("too large") || msg.contains("超出"))
                if (outRejected && turn.maxOutOverride == null && turn.config.maxOut > 8192) {
                    turn.maxOutOverride = 8192
                    body.put("max_tokens", 8192)
                    log("端点拒绝 max_tokens=${turn.config.maxOut}，本轮降档到 8192")
                    emit(ev("notice", JSONObject().put("level", "warn")
                        .put("text", "端点输出上限低于设置值，本轮已降到 8192 tokens")))
                    continue
                }
                // agent/request-error：插件有决定权（桌面语义），没人接管时走内置策略
                val ctx = HookBus.HookContext("agent/request-error").apply {
                    put("error", e.message ?: ""); put("code", e.code); put("status", e.status)
                }
                val decided = hooks.waterfall<RetryDecision>("agent/request-error", RetryDecision(false), ctx)
                // 内置策略 = 桌面 llm-retry 的默认预算：只重试瞬时失败
                val eligible = (decided.retry || e.retryable) && turn.retries < LlmRetry.MAX_RETRIES
                if (!eligible || cancelled.get()) throw e

                turn.retries++
                val delay = LlmRetry.delayMs(turn.retries)
                sessions.append(turn.sid, "llm/retry", JSONObject().apply {
                    put("step", turn.step); put("retry", turn.retries)
                    put("maxRetries", LlmRetry.MAX_RETRIES); put("delayMs", delay)
                    put("code", e.code); put("status", e.status)
                    put("message", e.message ?: "")
                })
                // 不再额外弹 toast：会话里已有重试卡片，再弹一个说同一件事的提示纯属打扰
                emit(ev("retry", JSONObject().apply {
                    put("attempt", turn.retries); put("max", LlmRetry.MAX_RETRIES)
                    put("delayMs", delay); put("code", e.code)
                    put("reason", e.message ?: "")
                }))
                var waited = 0L
                while (waited < delay && !cancelled.get()) {
                    Thread.sleep(100)
                    waited += 100
                }
                if (cancelled.get()) throw LlmClient.LlmError("已停止", "ABORTED")
            } finally {
                // 节拍器必须收（重试会新建一个）：finish/close 幂等
                flusher.close()
            }
        }
    }

    /** 取消时归档已交付的流式前缀（桌面 interrupted assistant/message 的手机等价物）。 */
    private fun archiveInterrupted(turn: Turn, text: String) {
        sessions.append(turn.sid, "assistant/message", JSONObject().apply {
            put("turn", turn.turnNo)
            put("step", turn.step)
            put("interrupted", true)
            put("text", text)
            put("message", JSONObject().put("content", JSONArray().put(
                JSONObject().put("type", "text").put("text", text)
            )))
        })
        emit(ev("interrupted", JSONObject().put("text", text)))
    }

    /**
     * 上下文溢出恢复：强制压一轮；只有 [Compactor.Result.shrunk] 才允许重发。
     * 返回 true 表示 messages 已更新、调用方应以同一 step 重发。
     */
    private fun recoverOverflow(turn: Turn, body: JSONObject): Boolean {
        val system = turn.messages.firstOrNull { it.optString("role") == "system" }
            ?.optString("content").orEmpty()
        val result = compactor.compactForOverflow(
            llm = turn.llm,
            model = turn.config.model,
            system = system,
            messages = turn.messages,
            keepFrom = turn.contextStart,
            contextWindow = turn.effWindow,
            maxOut = turn.config.maxOut,
            mode = turn.config.compactMode,
            onCompacting = { before, budget ->
                emit(ev("compacting", JSONObject().put("before", before).put("budget", budget)))
                sessions.append(turn.sid, "compaction/start", JSONObject().apply {
                    put("turn", turn.turnNo); put("trigger", "context-overflow")
                    put("before", before); put("budget", budget)
                })
            },
        )
        if (!result.shrunk) {
            log("CONTEXT_OVERFLOW 压缩无收益，不重发（避免空烧额度）")
            return false
        }
        turn.overflowRetries++
        turn.messages.clear()
        turn.messages.addAll(result.messages)
        body.put("messages", JSONArray(turn.messages.map { it }))
        logCompaction(turn, result, trigger = "context-overflow", phase = "retry")
        emit(ev("notice", JSONObject().put("level", "info")
            .put("text", "上下文超出模型窗口，已压缩到约 ${result.afterTokens} tokens 并重发")))
        return true
    }

    /** 记录用量与回复正文；成功一次就把连续失败计数清零 */
    private fun recordUsage(turn: Turn, result: LlmClient.Result) {
        val config = turn.config
        turn.promptTokens += result.usage.prompt
        turn.completionTokens += result.usage.completion
        turn.retries = 0
        if (result.text.isNotBlank()) turn.finalText = result.text

        sessions.append(turn.sid, "assistant/message", JSONObject().apply {
            put("turn", turn.turnNo)
            put("step", turn.step)
            put("text", result.text)
            put("reasoning", result.reasoning.take(400))
            put("promptTokens", result.usage.prompt)
            put("completionTokens", result.usage.completion)
            put("finish", result.finishReason)
            // WS1：模型可见内容按块落盘（text + tool_call）。requests 由日志派生，
            // 因此这里必须存 arguments 原文，不能只存「调用了什么」。
            put("message", JSONObject().put("content", JSONArray().apply {
                if (result.text.isNotBlank()) {
                    put(JSONObject().put("type", "text").put("text", result.text))
                }
                result.toolCalls.forEach { c ->
                    put(JSONObject().apply {
                        put("type", "tool_call")
                        put("id", c.id)
                        put("name", c.name)
                        put("arguments", c.args)
                    })
                }
            }))
        })
        emit(ev("usage", JSONObject().apply {
            put("prompt", result.usage.prompt); put("completion", result.usage.completion)
            put("total", result.usage.total); put("round", turn.step)
        }))
        // 达到输出上限：桌面有独立的 turn-max-tokens 节点，这里给同义事件
        if (result.finishReason.equals("length", true)) {
            emit(ev("max_tokens", JSONObject().apply {
                put("completion", result.usage.completion); put("maxOut", config.maxOut)
            }))
        }
    }

    /** 把 assistant 的 tool_calls 写回对话，并解析成可执行的调用清单 */
    private fun appendToolCalls(turn: Turn, result: LlmClient.Result): List<ToolPipeline.Call> {
        val wire = AgentLoop.wire(result.toolCalls)
        turn.messages.add(JSONObject().apply {
            put("role", "assistant")
            put("content", if (result.text.isBlank()) JSONObject.NULL else result.text)
            put("tool_calls", wire)
        })

        return result.toolCalls.mapNotNull { c ->
            val args = runCatching { if (c.args.isBlank()) JSONObject() else JSONObject(c.args) }.getOrElse {
                emit(ev("tool_start", JSONObject().put("id", c.id).put("name", c.name).put("meta", "参数解析失败")))
                val badArgs = "Error: 参数不是合法 JSON：${it.message}"
                turn.messages.add(AgentLoop.toolMessage(c.id, badArgs))
                sessions.append(turn.sid, "tool/result", JSONObject().apply {
                    put("turn", turn.turnNo); put("step", turn.step)
                    put("id", c.id); put("name", c.name); put("ok", false)
                    put("isError", true).put("code", "BAD_ARGUMENTS")
                    put("message", JSONObject().put("toolCallId", c.id).put("isError", true)
                        .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", badArgs))))
                })
                null
            } ?: return@mapNotNull null
            ToolPipeline.Call(c.id, c.name, args)
        }
    }

    /**
     * 失败收尾：为每个「有 tool_call 却没 tool 结果」的调用补一条 Error。
     *
     * 桌面在关闭失败步骤前做同一件事（TOOL_OUTCOME_UNKNOWN / TOOL_NOT_STARTED）：
     * 成对的历史才能让下一次请求合法，也让模型知道上一步断在哪里、不要假设成功。
     */
    private fun pairOrphanToolCalls(turn: Turn, cause: Throwable) {
        val answered = turn.messages
            .filter { it.optString("role") == "tool" }
            .mapNotNull { it.optString("tool_call_id").takeIf { id -> id.isNotBlank() } }
            .toHashSet()
        val reason = cause.message?.takeIf { it.isNotBlank() } ?: cause.javaClass.simpleName
        turn.messages.filter { it.optString("role") == "assistant" }.forEach { msg ->
            val calls = msg.optJSONArray("tool_calls") ?: return@forEach
            for (i in 0 until calls.length()) {
                val c = calls.optJSONObject(i) ?: continue
                val id = c.optString("id")
                if (id.isBlank() || id in answered) continue
                val name = toolNameOf(c.optJSONObject("function")?.optString("name"))
                val unknown = "Error: 这次调用没有完成（$reason），结果未知；不要假设它成功。"
                sessions.append(turn.sid, "tool/result", JSONObject().apply {
                    put("turn", turn.turnNo); put("step", turn.step)
                    put("id", id); put("name", name); put("ok", false)
                    put("isError", true).put("code", "TOOL_OUTCOME_UNKNOWN")
                    put("message", JSONObject().put("toolCallId", id).put("isError", true)
                        .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", unknown))))
                })
                turn.messages.add(AgentLoop.toolMessage(id, unknown))
            }
        }
    }

    /** 过守卫批量执行工具，把结果回灌对话（含 read_image 注入的图片） */    private fun executeTools(turn: Turn, calls: List<ToolPipeline.Call>) {
        val config = turn.config
        calls.forEach { c ->
            sessions.append(turn.sid, "tool/call", JSONObject().apply {
                put("turn", turn.turnNo); put("step", turn.step)
                put("id", c.id); put("name", c.name)
                // WS1：arguments 存原文（v1 只存 500 字截断值，回放会丢参数）
                put("arguments", c.args.toString())
                put("args", c.args.toString().take(500))
            })
            // 串行通知：让插件（如团队）能按会话给 Lead 记工具数；
            // 不放 waterfall —— 统计是旁路，不该有插件能靠返回值改掉一次工具调用
            runCatching {
                hooks.serial("agent/tool", HookBus.HookContext("agent/tool").apply {
                    put("session", turn.sid); put("name", c.name)
                })
            }
            emit(ev("tool_start", JSONObject().apply {
                put("id", c.id); put("name", c.name); put("args", c.args)
                put("meta", toolMeta(c.name, c.args))
            }))
        }

        val outcomes = pipeline.executeBatch(
            calls,
            // 权限读合档结果：设置页热更新（updatePermission）与 Mission 的收窄都立即生效，
            // 不再等下一轮 —— 之前的写法每批都拿轮次开始时冻结的 config。
            ToolPipeline.Gate(
                permission = effectivePermission(),
                planMode = config.planMode,
                planApproved = config.planApproved,
                confirmDanger = effectivePermission() != "full" && config.askDanger,
            ),
            runtime = turn.runtime,
            onEnd = { o ->
                emit(ev("tool_end", JSONObject().apply {
                    put("id", o.id); put("name", o.name); put("ok", o.ok)
                    put("output", o.output); put("ms", o.ms); put("denied", o.denied)
                    if (!o.ok) put("code", o.code.ifBlank { "TOOL_FAILED" })
                    // 退出码优先取流水线带出来的字段（前台命令：bash / run / java…），
                    // 没有再回落到对 JSON 载荷的解析（终端 / 后台任务类工具把 exit_code 写在结果里）
                    (o.exitCode ?: exitCodeOfJson(o.output))?.let { put("exitCode", it) }
                }))
                // 被权限拦下的调用要留进这件事的账：回看时「它想写但没写成」和「它没试」是两回事
                if (o.denied && config.missionId.isNotBlank()) {
                    runCatching {
                        kernel.missions.appendEvidence(
                            config.missionId,
                            JSONObject().put("type", "tool").put("ref", o.id)
                                .put("title", o.name + " 被权限拦下")
                                .put("at", System.currentTimeMillis()),
                        )
                    }
                }
            },
            // 实时输出：长命令不必等进程退出才在界面上「活过来」。走合帧器（见 AgentBridge），
            // 所以这里只管把读到的每一块交出去，节流与保序在出口统一处理。
            onOutput = { id, chunk ->
                emit(ev("tool_output", JSONObject().put("id", id).put("text", chunk)))
            },
            // WS2/T2：取消必须接进管道，否则未派发的调用不会立刻产出 ABORTED_BEFORE_DISPATCH；
            // sessionId 让 spill 按会话分桶（同会话的溢出文件不互相覆盖）。
            cancelled = { cancelled.get() },
            sessionId = turn.sid,
            // 用**这一步真的发出去的那份目录**判（不是重新算一遍）：设置页热更新、
            // 轮内装配都会让「重算的集合」与模型看到的集合不一致，拿它拒绝就是误伤。
            catalog = namesOf(turn.toolDefs),
        )

        outcomes.forEach { o ->
            val modelText = if (o.ok) o.output else "Error: " + o.output.ifBlank { "工具执行失败（无错误信息）" }
            sessions.append(turn.sid, "tool/result", JSONObject().apply {
                put("turn", turn.turnNo); put("step", turn.step)
                put("id", o.id); put("name", o.name); put("ok", o.ok); put("ms", o.ms)
                put("chars", o.output.length)
                // WS1：模型可见正文必须落盘（v1 只有 chars，日志无法派生历史）
                put("message", JSONObject().apply {
                    put("toolCallId", o.id)
                    put("isError", !o.ok)
                    put("content", JSONArray().put(JSONObject().put("type", "text").put("text", modelText)))
                })
                // 与桌面 tool/result 对齐：失败要落 isError + 结构化 code，
                // 回放/会话检索时才能分清是参数错了、权限拒了还是工具不存在
                if (!o.ok) {
                    put("isError", true)
                    put("code", o.code.ifBlank { "TOOL_FAILED" })
                    put("error", JSONObject().put("name", "ToolError").put("code", o.code.ifBlank { "TOOL_FAILED" }))
                    if (o.denied) put("denied", true)
                }
            })
            // 桌面契约：任何抛错/被拒的调用，模型看到的就是 `Error: <message>`。
            // 以前是「错误：…」——中文前缀被当成普通正文，小模型经常顺着自己的假设往下编。
            turn.messages.add(AgentLoop.toolMessage(o.id, modelText))
        }

        // read_image 注入的图片：紧跟工具结果进入对话（桌面 read_image 同款行为）
        if (injectedImages.isNotEmpty()) {
            val parts = JSONArray()
            parts.put(JSONObject().put("type", "text").put("text", "（以上是你用 read_image 读取的图片）"))
            injectedImages.forEach { parts.put(it) }
            turn.messages.add(JSONObject().put("role", "user").put("content", parts))
            injectedImages.clear()
        }
    }

    /** 收尾：中止、turn-stopping 钩子、标题、turn/end 事件 */
    private fun finishTurn(turn: Turn) {
        val config = turn.config
        if (cancelled.get()) {
            runCatching { flushTurnDeliverables(turn) }
                .onFailure { log("交付收尾失败（中止分支）：${it.message ?: it.javaClass.simpleName}") }
            sessions.append(turn.sid, "turn/end", JSONObject().put("cancelled", true))
            emit(ev("turn_end", JSONObject().apply {
                put("cancelled", true); put("steps", turn.step); put("text", turn.finalText)
                put("usage", JSONObject().put("prompt", turn.promptTokens).put("completion", turn.completionTokens)
                    .put("total", turn.promptTokens + turn.completionTokens).put("contextWindow", config.contextWindow))
            }))
            hooks.serial("agent/turn-end", HookBus.HookContext("agent/turn-end").apply {
                put("cancelled", true); put("steps", turn.step); put("text", turn.finalText)
            })
            return
        }

        // agent/turn-stopping：自然停下前的收尾检查（插件可在这里补一条提醒）
        val stopCtx = HookBus.HookContext("agent/turn-stopping").apply {
            put("cfg", config); put("text", turn.finalText); put("steps", turn.step)
        }
        hooks.serial("agent/turn-stopping", stopCtx)

        sessions.append(turn.sid, "turn/end", JSONObject().apply {
            put("steps", turn.step)
            put("promptTokens", turn.promptTokens)
            put("completionTokens", turn.completionTokens)
        })
        emit(ev("turn_end", JSONObject().apply {
            put("cancelled", false); put("steps", turn.step); put("text", turn.finalText)
            put("usage", JSONObject().put("prompt", turn.promptTokens).put("completion", turn.completionTokens)
                .put("total", turn.promptTokens + turn.completionTokens))
            put("goalContinue", config.goalActive && config.goalRounds + 1 < config.goalRoundCap())
            put("ms", System.currentTimeMillis() - turn.startedAt)
        }))
        hooks.serial("agent/turn-end", HookBus.HookContext("agent/turn-end").apply {
            put("cancelled", false); put("steps", turn.step); put("text", turn.finalText)
        })
        // 这一轮产出的文件直接推到对话界面：用户不用自己去文件页翻
        runCatching { flushTurnDeliverables(turn) }
            .onFailure { log("交付收尾失败：${it.message ?: it.javaClass.simpleName}") }
        // 标题放最后投递：一次非流式 HTTP 不许压住 turn_end（见 submitTitleTask）
        submitTitleTask(turn)
    }

    /**
     * 标题任务投递：只有首轮生成；投递时快照取消态。
     *
     * 注意 cancelled 必须快照——driver 会被目标续跑复用并 `cancelled.set(false)`，
     * 任务体里再读实时标志会被新一轮的复位冲掉。run() 返回后 emit 闭包依然有效
     * （走 webView.post，不依赖 drivers map），晚到的 title 事件能正常送达；
     * HTTP 期间用户点停止取消不了这个任务（max_tokens=40，代价可忽略），不做取消。
     */
    private fun submitTitleTask(turn: Turn) {
        val cfg = turn.config
        if (cfg.history.isNotEmpty()) return
        val cancelledAtSubmit = cancelled.get()
        if (!titleInFlight.add(turn.sid)) return
        titleExecutor.execute {
            try {
                runCatching { maybeTitle(cfg, turn.llm, turn.sid, cancelledAtSubmit) }
            } finally {
                titleInFlight.remove(turn.sid)
            }
        }
    }

    /**
     * 轮次收尾的两件事，严格对齐桌面：
     *
     *  1. **交付物**（`deliverables/presented`）：只认 agent 显式 `present` 的文件。
     *     中途 present 的先缓冲，这里统一推送一次，卡片因此永远落在本轮最后。
     *     桌面同一事件带 turn 号，这里也带上，便于前端把它挂到正确轮次。
     *  2. **本轮改动**（`workspace/changes`）：工作区里这一轮写过的文件只做记录，
     *     **不**当成交付物弹卡片（桌面把它交给变更摘要 UI，与交付是两回事）。
     */
    /** 当前轮次序号（桌面 deliverables 事件里的 turn 字段） */
    private fun turnNumber(turn: Turn): Int =
        runCatching { sessions.summary(turn.sid).optInt("turns") }.getOrDefault(0)

    private fun flushTurnDeliverables(turn: Turn) {
        val explicit = runCatching { kernel.drainTurnDeliverables() }.getOrDefault(emptyList())
        log("交付收尾：explicit=${explicit.size} root=${kernel.workspace.rootPath}")
        val files = JSONArray()
        val seen = HashSet<String>()
        explicit.forEach { f ->
            val path = f.optString("path")
            if (path.isBlank() || !seen.add(path)) return@forEach
            files.put(f)
        }
        var auto = false
        if (files.length() == 0) {
            // 兜底：小参数模型（1B 级本地模型）写完文件常常直接收尾，想不起调 present。
            // 这种情况下一句「已完成」后面什么都没有，用户会以为交付功能坏了。
            // 只兜文档/图片这类「给人看的产物」，代码文件仍旧只进 workspace/changes。
            val autoArr = autoDeliverables(turn)
            if (autoArr.length() > 0) {
                for (i in 0 until minOf(autoArr.length(), 5)) files.put(autoArr.get(i))
                auto = true
            }
        }
        if (files.length() > 0) {
            val payload = JSONObject().put("turn", turnNumber(turn)).put("files", files)
            if (auto) payload.put("auto", true)
            sessions.append(turn.sid, "deliverables/presented", payload)
            // 这件事产出了什么文件也要能回看：引用用轮次号，正文由证据组装器从日志里取
            if (turn.config.missionId.isNotBlank()) {
                runCatching {
                    kernel.missions.appendEvidence(
                        turn.config.missionId,
                        JSONObject().put("type", "deliverable").put("ref", payload.optString("turn"))
                            .put("title", "交付 " + files.length() + " 个文件")
                            .put("at", System.currentTimeMillis()),
                    )
                }
            }
            emit(ev("deliverable", payload))
        }
        recordWorkspaceChanges(turn)
    }

    /** 本轮新写/改过的文档类产物（自动交付兜底用） */
    private fun autoDeliverables(turn: Turn): JSONArray {
        val out = JSONArray()
        runCatching {
            val root = kernel.workspace.root
            val since = turn.startedAt - 1_000
            var seen = 0
            root.walkTopDown()
                .onEnter { it == root || (it.name != "node_modules" && !it.name.startsWith(".")) }
                .forEach { f ->
                    if (out.length() >= 5) return@forEach
                    if (!f.isFile || f.length() <= 0 || f.lastModified() < since) return@forEach
                    if (f.extension.lowercase() !in AUTO_DELIVER_EXT) return@forEach
                    val rel = kernel.workspace.relative(f)
                    if (rel.startsWith(".dsh")) return@forEach
                    // 工程内的源/资源（祖先含项目清单）不是交付物：脚手架一次生成
                    // 一堆密度图标/资源，全被兜底捞进来就成了「交付了 5 个 png」
                    if (ProjectMarkers.insideProject(root, f)) return@forEach
                    seen++
                    out.put(
                        JSONObject()
                            .put("path", rel).put("name", f.name).put("size", f.length())
                            .put("mime", guessMime(f.name)),
                    )
                }
            log("自动交付扫描：命中 ${out.length()}（root=$root since=$since）")
            if (seen == 0) log("自动交付扫描：本轮没有符合扩展名/时间条件的产物")
        }
        return out
    }

    /**
     * 本轮改动：按 mtime >= 轮次开始时间扫描工作区，只写 session 事件（供变更摘要/历史回放用），
     * 不推送界面，也不会变成交付卡片。
     */
    private fun recordWorkspaceChanges(turn: Turn) {
        runCatching {
            val root = kernel.workspace.root
            val since = turn.startedAt - 1_000
            val files = JSONArray()
            root.walkTopDown()
                .onEnter { it == root || (it.name != "node_modules" && !it.name.startsWith(".")) }
                .forEach { f ->
                    if (!f.isFile || f.length() <= 0) return@forEach
                    if (f.lastModified() < since) return@forEach
                    val rel = kernel.workspace.relative(f)
                    if (rel.startsWith(".dsh")) return@forEach
                    if (files.length() >= 50) return@forEach
                    files.put(JSONObject().apply {
                        put("path", rel)
                        put("size", f.length())
                    })
                }
            if (files.length() == 0) return
            sessions.append(
                turn.sid,
                "workspace/changes",
                JSONObject().put("turn", turnNumber(turn)).put("count", files.length()).put("files", files),
            )
        }
    }

    /** 失败收尾：面向用户的是诊断，不是异常类名 */
    private fun failTurn(sid: String, config: AgentConfig, t: Throwable) {
        val msg = if (t is LlmClient.LlmError) {
            // 按「错误码 + 本次真实端点/模型 + 原始报错」现算：同一个错误码在不同环境下
            // 原因不同（回环没人监听 / 局域网不可达 / DNS / TLS / 鉴权）
            LlmRetry.diagnose(t.code, t.message, config.baseUrl, config.model, t.status)
        } else (t.message ?: t.javaClass.simpleName)
        sessions.append(sid, "turn/error", JSONObject()
            .put("message", msg)
            .put("code", (t as? LlmClient.LlmError)?.code ?: "")
            .put("raw", t.message ?: ""))
        emit(ev("error", JSONObject()
            .put("message", msg)
            .put("code", (t as? LlmClient.LlmError)?.code ?: "")))
        emit(ev("turn_end", JSONObject().apply { put("cancelled", cancelled.get()); put("error", msg) }))
        hooks.serial("agent/turn-end", HookBus.HookContext("agent/turn-end").apply {
            put("cancelled", cancelled.get()); put("error", msg)
        })
        log("turn 失败：$msg")
    }

    /** 标题只生成一次：首轮结束后用一次极短请求，失败就用首句截断兜底。
     *  在后台执行器线程上跑（见 [submitTitleTask]）；cancelledAtSubmit 是投递时的取消快照。 */
    private fun maybeTitle(cfg: AgentConfig, llm: LlmClient, sid: String, cancelledAtSubmit: Boolean) {
        if (cancelledAtSubmit) return
        if (cfg.history.isNotEmpty()) return
        // 二次检查收窄并发窗口（投递去重 + append 前检查，双保险）
        if (sessions.read(sid).any { it.optString("type") == "session/title" }) return
        val fallback = cfg.userText.replace(Regex("\\s+"), " ").trim().take(14)
        var title = fallback
        if (cfg.baseUrl.isNotBlank()) {
            title = runCatching {
                val body = JSONObject().apply {
                    put("model", cfg.model)
                    put("messages", JSONArray().apply {
                        put(JSONObject().put("role", "system").put("content",
                            "按用户第一句话起一个会话标题：不超过 12 个字，不加引号、不加句号，只输出标题。"))
                        put(JSONObject().put("role", "user").put("content", cfg.userText.take(500)))
                    })
                    put("max_tokens", 40)
                }
                llm.complete(body).replace(Regex("[\"\n《》]"), "").trim().take(16)
            }.getOrNull()?.takeIf { it.isNotBlank() } ?: fallback
        }
        sessions.append(sid, "session/title", JSONObject().put("title", title).put("source", "provider"))
        // run() 此时可能已返回：WebView 也许在销毁路上，emit 包一层别让标题砸了收尾
        runCatching { emit(ev("title", JSONObject().put("title", title))) }
    }

    /* ---------------- 子智能体 ---------------- */

    /**
     * 子智能体执行入口 —— 实现在 [SubagentRunner]（主 Agent 与 teammate 共用）。
     * 这里只补上「父轮怎么算被取消」与「工具运行时从哪来」两个装配参数。
     */
    internal fun runSubagent(
        parentCfg: AgentConfig,
        task: String,
        maxRounds: Int,
        onStep: (String, Int, String) -> Unit,
        /** 已注册的 agent 条目：teammate 传进来，注册表里那条就是真正在跑的那个 */
        existing: ai.deepseek.harness.mobile.kernel.agents.AgentRegistry.Agent? = null,
    ): String = subagents.run(
        parentCfg = parentCfg,
        task = task,
        maxRounds = maxRounds,
        onStep = onStep,
        runtimeFactory = { cfg, turnId, sid -> runtimeFor(cfg, turnId, sid) },
        existing = existing,
        cancelled = { cancelled.get() },
    )

    /* ---------------- 运行时能力（exit_plan_mode / update_goal / todo / search / subagent / 审批） ---------------- */

    private fun runtimeFor(config: AgentConfig, turnId: String, sid: String): ToolPipeline.RuntimeTools =
        object : ToolPipeline.RuntimeTools {
            /** 本轮内被 Agent 改写后的目标：get_goal 立刻反映，下一轮由前端重新打包 */
            private var liveObjective: String? = config.goalObjective
            private var liveMaxRounds: Int = config.goalMaxRounds

            override fun editGoal(objective: String, maxRounds: Int): String {
                val next = objective.trim()
                if (next.isBlank()) return "新目标不能为空：请用一句话写清这一阶段要达成什么。"
                liveObjective = next
                if (maxRounds > 0) liveMaxRounds = maxRounds.coerceIn(1, 60)
                emit(ev("goal_edited", JSONObject().apply {
                    put("objective", next)
                    put("maxRounds", liveMaxRounds)
                    put("round", config.goalRounds + 1)
                }))
                sessions.append(sid, "goal/edited", JSONObject().apply {
                    put("objective", next); put("maxRounds", liveMaxRounds)
                })
                return "目标已更新为：$next。接下来围绕新目标推进，全部达成后再调用 update_goal(action=complete)。"
            }
            override fun presentPlan(title: String, plan: String): String {
                val waiter = Waiter<PlanDecision>()
                planWaiter.set(waiter)
                pendingPlan = JSONObject().put("title", title).put("plan", plan)
                emit(ev("plan_request", JSONObject().apply {
                    put("title", title); put("plan", plan); put("id", turnId)
                }))
                sessions.append(sid, "plan/requested", JSONObject().put("title", title))
                val decision = waiter.await(600)
                planWaiter.set(null)
                pendingPlan = null
                if (decision == null) {
                    sessions.append(sid, "plan/expired", JSONObject())
                    return "用户没有响应计划评审，本轮先把计划留着，不要继续执行。"
                }
                sessions.append(sid, "plan/decided", JSONObject().apply {
                    put("approved", decision.approved); put("feedback", decision.feedback)
                })
                return if (decision.approved) "用户已批准计划。现在开始按计划执行，先做第一步。"
                else if (decision.feedback.isNotBlank()) "用户要求继续规划：${decision.feedback}。请按反馈修订后重新调用 exit_plan_mode。"
                else "用户结束了本轮规划，先不要执行。"
            }

            override fun markGoal(status: String, summary: String): String {
                val normalized = when (status) {
                    "complete", "done", "完成" -> "complete"
                    "blocked", "受阻" -> "blocked"
                    else -> "active"
                }
                emit(ev("goal_end", JSONObject().apply {
                    put("status", normalized); put("summary", summary); put("round", config.goalRounds + 1)
                }))
                sessions.append(sid, "goal/updated", JSONObject().put("status", normalized).put("summary", summary))
                return when (normalized) {
                    "complete" -> "已记录：目标完成。用一句话收尾，不要继续调用工具。"
                    "blocked" -> "已记录：目标受阻。说明卡点，等用户决定。"
                    else -> "已记录：目标进行中。"
                }
            }

            override fun todoWrite(items: JSONArray): String {
                val list = (0 until items.length()).mapNotNull { i ->
                    val o = items.optJSONObject(i) ?: return@mapNotNull null
                    val text = if (o.has("text")) o.optString("text") else o.optString("content")
                    TodoStore.Item(text, o.optBoolean("done") || o.optString("status") == "completed")
                }.filter { it.text.isNotBlank() }
                todos.write(sid, list)
                emit(ev("todo", JSONObject().put("items", JSONArray(list.map {
                    JSONObject().put("text", it.text).put("done", it.done)
                }))))
                return "待办已更新（${list.count { it.done }}/${list.size} 完成）"
            }

            override fun search(queries: List<String>, max: Int, fetchTop: Int, charsPerPage: Int): String {
                // 失败一律抛 KernelError：以前返回「没有配置搜索接口…」「搜索失败：…」这种字符串，
                // ToolPipeline 会把它当成成功结果回给模型，模型于是以为自己搜过了。
                if (config.searchUrl.isBlank()) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError(
                        "没有配置搜索接口，无法联网：请到「设置 → 联网搜索」填写端点（Bing / Tavily / 自建网关均可）",
                    )
                }
                val qs = queries.map { it.trim() }.filter { it.isNotBlank() }.distinct().take(4)
                if (qs.isEmpty()) throw ai.deepseek.harness.mobile.kernel.KernelError("queries 不能为空")
                val per = max.coerceIn(1, config.searchMax.coerceAtLeast(1))
                val (hits, note) = try {
                    WebSearch.searchMany(config.searchUrl, config.searchKey, qs, per)
                } catch (e: Throwable) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError("搜索失败：${e.message ?: e.javaClass.simpleName}")
                }
                if (hits.isEmpty()) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError(note ?: "没有搜到结果，换个说法或改用 web_fetch 直接抓页面")
                }
                val sb = StringBuilder()
                sb.append("搜索「").append(qs.joinToString("；")).append("」，共 ").append(hits.size).append(" 条结果：\n")
                hits.forEachIndexed { i, h ->
                    sb.append(i + 1).append(". ").append(h.title.ifBlank { "(无标题)" })
                    if (h.url.isNotBlank()) sb.append("（").append(h.url).append("）")
                    sb.append('\n')
                    if (h.snippet.isNotBlank()) sb.append(h.snippet.take(400)).append('\n')
                }
                if (note != null) sb.append("注意：").append(note)
                // 深度调研：自动抓前 N 条结果的正文并合并（省掉模型逐条 web_fetch 的往返）。
                // 单页失败不中断整轮——记一行抓取失败，其余照常返回。
                val top = fetchTop.coerceIn(0, 3)
                if (top > 0) {
                    val perPage = charsPerPage.coerceIn(1_000, 12_000)
                    val picked = hits.filter { it.url.startsWith("http") }.take(top)
                    if (picked.isEmpty()) {
                        sb.append("\n\n（要求抓正文，但没有可抓的链接）")
                    } else {
                        sb.append("\n\n=== 已抓取正文（前 ")
                            .append(picked.size).append(" 条，每页上限 ")
                            .append(perPage).append(" 字）===")
                        picked.forEachIndexed { i, h ->
                            sb.append("\n--- [").append(i + 1).append("] ")
                                .append(h.title.ifBlank { h.url }).append(" ---")
                            sb.append("\n来源：").append(h.url)
                            val body = try {
                                fetchUrl(h.url, perPage, 0)
                            } catch (e: Throwable) {
                                "（抓取失败：${e.message ?: e.javaClass.simpleName}）"
                            }
                            sb.append(body.take(perPage))
                        }
                        sb.append("\n（如需更多细节，用 web_fetch + offset 继续读同一页）")
                    }
                }
                return sb.toString().trim()
            }

            override fun subagent(task: String, maxRounds: Int): String =
                subagentFlow(task, maxRounds, null)

            override fun subagentAs(agentId: String, task: String, maxRounds: Int): String =
                subagentFlow(task, maxRounds, kernel.agents.get(agentId))

            /** 普通子代理 / teammate 共用一条执行路径，区别只在「agent 条目是自己注册还是外部给」 */
            private fun subagentFlow(
                task: String,
                maxRounds: Int,
                existing: ai.deepseek.harness.mobile.kernel.agents.AgentRegistry.Agent?,
            ): String {
                val subId = existing?.id ?: "sub-${System.currentTimeMillis()}"
                // 进度事件里的 id 用**这次工具调用的 id**：前端把子代理渲染成一条工具行，
                // 行是按 tool_start 的 id 建的。用注册表 id 两边对不上 —— 同一个子代理
                // 会留下两行，其中一行永远写着「启动中」（实测：子代理跑完后界面多一行）。
                val evId = ai.deepseek.harness.mobile.kernel.plugin.ToolExecContext.currentOrNone().callId
                    ?.takeIf { it.isNotBlank() } ?: subId
                val rounds = maxRounds.coerceIn(1, 40)
                emit(
                    ev("subagent", JSONObject().put("id", evId).put("phase", "start")
                        .put("task", task).put("rounds", rounds)),
                )
                val out = runSubagent(config, task, rounds, onStep = { step, round, tool ->
                    emit(
                        ev("subagent", JSONObject().put("id", evId).put("phase", "step")
                            .put("step", step).put("round", round).put("rounds", rounds)
                            .put("tool", tool)),
                    )
                }, existing = existing)
                emit(
                    ev("subagent", JSONObject().put("id", evId).put("phase", "end")
                        .put("result", out.take(1200)).put("rounds", rounds)),
                )
                return out
            }

            override fun useSkill(name: String): String {
                val store = kernel.skills
                val hit = store.load(name)
                if (hit == null) {
                    val names = store.list().joinToString("、") { it.name }
                    throw ai.deepseek.harness.mobile.kernel.KernelError(
                        "没有这个技能：$name。可用技能：${names.ifBlank { "（空）" }}",
                    )
                }
                sessions.append(sid, "skill/loaded", JSONObject().put("name", hit.name))
                return "技能「${hit.name}」的说明：\n\n" + hit.body.take(20_000)
            }

            override fun createGoal(objective: String, maxRounds: Int): String {
                if (objective.isBlank()) return "目标不能为空。请用一句话说清要达成什么。"
                emit(ev("goal_created", JSONObject().apply {
                    put("objective", objective); put("maxRounds", maxRounds)
                }))
                sessions.append(sid, "goal/created", JSONObject().apply {
                    put("objective", objective); put("maxRounds", maxRounds)
                })
                val cap = if (maxRounds > 0) "最多 $maxRounds 轮" else "智能轮数（做到完成或受阻）"
                return "目标已建立：$objective（$cap）。之后每轮围绕它推进；完成时调用 update_goal(status=complete)。"
            }

            override fun getGoal(): String {
                val objective = liveObjective
                if (objective.isNullOrBlank()) return "当前会话没有目标。可以用 create_goal 建立。"
                return JSONObject().apply {
                    put("objective", objective)
                    put("phase", config.goalPhase)
                    put("rounds", config.goalRounds)
                    put("roundCap", if (liveMaxRounds > 0) liveMaxRounds else config.goalRoundCap())
                    put("maxRounds", liveMaxRounds)
                }.toString()
            }

            override fun fetchUrl(url: String, maxChars: Int, offset: Int): String {
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError("只支持 http/https 链接：$url")
                }
                val page = maxChars.coerceIn(500, 40_000)
                val from = offset.coerceAtLeast(0)
                val conn = try {
                    (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                        connectTimeout = 15_000
                        readTimeout = 30_000
                        instanceFollowRedirects = true
                        setRequestProperty("User-Agent", "Mozilla/5.0 (Android) DSH-Mobile")
                        setRequestProperty("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
                        setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                    }
                } catch (e: Throwable) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError("抓取失败：${e.message ?: e.javaClass.simpleName}（$url）")
                }
                val code = try { conn.responseCode } catch (e: Throwable) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError("抓取失败：${e.message ?: e.javaClass.simpleName}（$url）")
                }
                if (code !in 200..299) {
                    conn.disconnect()
                    throw ai.deepseek.harness.mobile.kernel.KernelError("抓取失败：HTTP $code（$url）")
                }
                val ctype = conn.contentType.orEmpty()
                if (ctype.isNotBlank() && !ctype.contains("text", true) &&
                    !ctype.contains("json", true) && !ctype.contains("xml", true)
                ) {
                    conn.disconnect()
                    throw ai.deepseek.harness.mobile.kernel.KernelError("这不是文本页面（Content-Type: $ctype），无法按正文读取：$url")
                }
                val body = try {
                    conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                } catch (e: Throwable) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError("读取响应失败：${e.message ?: e.javaClass.simpleName}（$url）")
                } finally {
                    runCatching { conn.disconnect() }
                }
                val title = Regex("(?is)<title[^>]*>(.*?)</title>").find(body)
                    ?.groupValues?.get(1)?.replace(Regex("\\s+"), " ")?.trim().orEmpty()
                // 去掉脚本/样式与标签，只留正文文本；顺带把常见实体还原成可读字符
                val text = body
                    .replace(Regex("(?is)<(script|style|noscript|svg)[^>]*>.*?</\\1>"), " ")
                    .replace(Regex("(?i)<br\\s*/?>|</p>|</div>|</li>|</h[1-6]>"), "\n")
                    .replace(Regex("(?s)<[^>]+>"), " ")
                    .replace(Regex("&nbsp;|&#160;"), " ")
                    .replace(Regex("&quot;|&#34;"), "\"")
                    .replace(Regex("&#39;|&apos;"), "'")
                    .replace(Regex("&lt;"), "<")
                    .replace(Regex("&gt;"), ">")
                    .replace(Regex("&amp;"), "&")
                    .replace(Regex("&#(\\d+);")) { m -> m.groupValues[1].toIntOrNull()?.toChar()?.toString() ?: m.value }
                    .replace(Regex("[ \\t\\x0B\\f\\r]+"), " ")
                    .replace(Regex("\\n\\s*\\n+"), "\n")
                    .trim()
                if (text.isBlank()) throw ai.deepseek.harness.mobile.kernel.KernelError("页面没有可提取的正文文本（$url）")
                if (from >= text.length) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError("offset=$from 已超出正文长度（共 ${text.length} 字符）")
                }
                val end = (from + page).coerceAtMost(text.length)
                val head = buildString {
                    append("「").append(url).append("」")
                    if (title.isNotBlank()) append(" 标题：").append(title.take(120))
                    append("\n正文 ").append(from).append("-").append(end).append(" / ").append(text.length).append(" 字符")
                    if (end < text.length) append("（还有 ${text.length - end} 字符，继续读用 offset=$end）")
                }
                return head + "\n" + text.substring(from, end)
            }

            override fun addImage(path: String): String {
                val file = try { kernel.workspace.resolve(path, mustExist = true) } catch (e: Throwable) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError("读不到图片：${e.message}")
                }
                val bytes0 = try { file.readBytes() } catch (e: Throwable) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError("读取图片失败：${e.message}")
                }
                val ext = file.extension.lowercase().ifBlank { "png" }
                val mime0 = when (ext) {
                    "jpg", "jpeg" -> "image/jpeg"
                    "gif" -> "image/gif"
                    "webp" -> "image/webp"
                    else -> "image/png"
                }
                // rc.98：先压缩再查上限 —— 压缩是「读大图进对话」的兜底，先拦会让相机原图
                // 拿不到 1/8~1/15 的体积收益直接失败。GIF 在 ImageResize 内原样返回（保留动画帧），
                // 压完仍超限才报错。webp 重编码 JPEG 会丢透明度，与 dataUrl 既有行为一致。
                val bytes = ImageResize.forConversation(bytes0, mime0)
                val compressed = bytes !== bytes0
                if (bytes.size > 8 * 1024 * 1024) {
                    throw ai.deepseek.harness.mobile.kernel.KernelError("图片过大（${bytes.size / 1024}KB），压缩后仍超 8MB 上限；请先压缩或裁剪")
                }
                // 重编码后的实际字节是 JPEG，dataUrl 的 mime 必须跟字节走而不是跟扩展名走
                val mime = if (compressed) "image/jpeg" else mime0
                val dataUrl = "data:$mime;base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                injectedImages.add(JSONObject().put("type", "image_url")
                    .put("image_url", JSONObject().put("url", dataUrl)))
                sessions.append(sid, "image/attached",
                    JSONObject().put("path", path).put("bytes", bytes.size).put("compressed", compressed))
                return if (compressed) {
                    "已把图片 $path 加入对话（原 ${bytes0.size / 1024}KB → 压缩后 ${bytes.size / 1024}KB，最长边 1600px），下一轮请求你就能看到它。"
                } else {
                    "已把图片 $path 加入对话（${bytes.size / 1024}KB），下一轮请求你就能看到它。"
                }
            }

            override fun latestUserImage(): JSONObject? = config.attachments.lastOrNull {
                it.optString("dataUrl").startsWith("data:image/")
            }

            override fun addImageData(dataUrl: String, label: String): String {
                if (!dataUrl.startsWith("data:image/")) return "这不是一张图（需要 data:image/... 形式）"
                // 表情包多在 200px 内，这里只是兜底挡掉异常大的 dataUrl
                if (dataUrl.length > 12 * 1024 * 1024) return "图片过大（${dataUrl.length / 1024}KB），跳过"
                injectedImages.add(JSONObject().put("type", "image_url")
                    .put("image_url", JSONObject().put("url", dataUrl)))
                sessions.append(sid, "image/attached", JSONObject().put("label", label).put("chars", dataUrl.length))
                return "已把$label 加入对话，下一轮请求你就能看到它。"
            }

            override fun askUser(question: String, options: JSONArray, detail: String): String {                val id = "q-${System.nanoTime()}"
                val labels = (0 until options.length()).mapNotNull { i ->
                    val o = options.optJSONObject(i) ?: return@mapNotNull null
                    JSONObject().put("label", o.optString("label")).put("description", o.optString("description"))
                }
                val waiter = Waiter<String>()
                askWaiters[id] = waiter
                emit(ev("ask_request", JSONObject().apply {
                    put("id", id); put("question", question); put("detail", detail)
                    put("options", JSONArray(labels))
                }))
                val answer = waiter.await(300)
                askWaiters.remove(id)
                return if (answer == null) "用户没有回答（超时）。先按最保守的选项继续，并说明你的假设。"
                else "用户选择：$answer"
            }

            override fun approve(name: String, args: JSONObject, reason: String): Boolean {
                val missionId = cfg?.missionId.orEmpty()
                // 「这件事内始终允许」命中：只在这条 Mission 里免问
                if (missionId.isNotBlank() && kernel.missions.hasGrant(missionId, name)) return true
                // 「始终允许」命中：同会话同名工具不再重复弹框
                if (alwaysApprovedBySession[sidOrNull()]?.contains(name) == true) return true
                val id = "ap-${System.nanoTime()}"
                approvalNames[id] = name
                val waiter = Waiter<Boolean>()
                approveWaiters[id] = waiter
                // 总线事件：灵动岛等插件用它把「等待确认」顶到屏幕上（用户不在 App 里时可见）
                hooks.serial("agent/approval", HookBus.HookContext("agent/approval").apply {
                    put("phase", "request"); put("name", name); put("reason", reason)
                })
                emit(ev("approval_request", JSONObject().apply {
                    put("id", id); put("name", name); put("reason", reason); put("args", args)
                    // 审批卡要能说「这是哪件事」：批准的范围由它决定，不是由会话决定
                    if (missionId.isNotBlank()) {
                        put("missionId", missionId)
                        put("missionTitle", kernel.missions.get(missionId)?.optString("title").orEmpty())
                    }
                }))
                val ok = waiter.await(90) ?: false
                hooks.serial("agent/approval", HookBus.HookContext("agent/approval").apply {
                    put("phase", "resolved"); put("name", name); put("approved", ok)
                })
                approveWaiters.remove(id)
                approvalNames.remove(id)
                val scope = approvalScopes.remove(id) ?: if (ok) "once" else "deny"
                // Mission 轮的「始终允许」落在账本上，作用域到此件事为止
                if (ok && scope == "always" && missionId.isNotBlank()) {
                    runCatching { kernel.missions.addGrant(missionId, name) }
                }
                // 审计：谁批的、批到什么范围、为哪件事 —— 会话日志与 Mission 证据各留一份
                runCatching {
                    sessions.append(sid, "approval/decided", JSONObject().apply {
                        put("id", id); put("name", name); put("scope", scope)
                        put("reason", reason)
                        if (missionId.isNotBlank()) put("missionId", missionId)
                    })
                }
                if (missionId.isNotBlank()) {
                    runCatching {
                        kernel.missions.appendEvidence(
                            missionId,
                            JSONObject().put("type", "approval").put("ref", id)
                                .put("title", "$name · " + when (scope) {
                                    "once" -> "允许一次"
                                    "always" -> "这件事内始终允许"
                                    else -> "已拒绝"
                                })
                                .put("at", System.currentTimeMillis()),
                        )
                    }
                }
                return ok
            }
        }

    /* ---------------- 小工具 ---------------- */

    /**
     * PTC 收口段的 SDK 速查：原生工具不再以 schema 进上下文，改列「名字 — 一句话用途」，
     * 模型在 run_code 里用 await dsh.callTool(name, args) 调用（描述取首句，控 token）。
     */
    private fun ptcSdkSection(preset: AgentPreset): String {
        val lines = kernel.registry.tools()
            .filter { it.name in preset.allow && it.name != "run_code" }
            .map { spec ->
                val brief = spec.description.trim()
                    .substringBefore("。").substringBefore("\n")
                    .take(64)
                "- ${spec.name}：$brief"
            }
            .sorted()
        if (lines.isEmpty()) return ""
        return buildString {
            append("## PTC 程序化工具调用\n")
            append("本会话只直接暴露 run_code 一个工具。需要其它能力时，在 run_code 代码里调用：\n")
            append("```js\nconst r = await dsh.callTool(\"工具名\", { 参数 });\n```\n")
            append("可用原生工具（调用前先用 dsh.fs.read 之类确认前置条件，出错会抛异常，用 try/catch 兜住）：\n")
            append(lines.joinToString("\n"))
        }
    }

    private fun ev(type: String, payload: JSONObject): JSONObject = JSONObject().apply {
        put("t", type)
        payload.keys().forEach { k -> put(k, payload.get(k)) }
    }

    private fun lastKind(sid: String): IntentRouter.Kind? =
        sessions.read(sid).lastOrNull { it.optString("type") == "intent/classified" }
            ?.optString("kind")?.let { k ->
                IntentRouter.Kind.entries.firstOrNull { it.name.equals(k, true) }
            }

    /**
     * 历史消息里的图片回填。
     *
     * 以前前端只传 {role, content}，历史里的图在下一轮就消失了 ——
     * 用户问「刚才那张图/这个表情什么意思」时，模型收到的只有一句文字，
     * 于是只能瞎猜或反问，看起来像「记性差」。
     *
     * 只回填最近一条用户消息里的图（最多 2 张、单张 ≤300KB base64）：
     * 足够回答追问，又不会把每轮请求撑成几 MB。
     */
    /**
     * 历史图片注入，所有历史消息公平对待：
     * 只要预算允许，每条带图的 user 消息都能把图带给模型，
     * 不再是「只有最近一条能带图、更早的图永远看不见」。
     * 预算两道闸：总张数 6（每条最多 2 张）+ dataUrl 总量约 900KB，超出的跳过只留文字。
     * 倒序遍历（最近的优先），保证追问「刚才那张图」永远有图。
     */
    private fun attachHistoryImages(msgs: MutableList<JSONObject>) {
        var slots = 6
        var bytesLeft = 900_000L
        for (i in msgs.indices.reversed()) {
            if (slots <= 0) break
            val m = msgs[i]
            if (m.optString("role") != "user") continue
            // 已经是多模态 parts 的（比如别处注入过的）不要再加工
            if (m.optJSONArray("content") != null) continue
            val atts = m.optJSONArray("atts") ?: continue
            val imgs = (0 until atts.length()).mapNotNull { atts.optJSONObject(it) }
                .filter {
                    val u = it.optString("dataUrl")
                    u.startsWith("data:image") && u.length in 1..300_000
                }
            if (imgs.isEmpty()) continue
            val parts = JSONArray()
            parts.put(JSONObject().put("type", "text").put("text", m.optString("content")))
            var used = 0
            for (a in imgs) {
                if (used >= 2 || slots <= 0) break
                val url = a.optString("dataUrl")
                if (url.length > bytesLeft) continue
                bytesLeft -= url.length
                parts.put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", url)))
                used++; slots--
            }
            if (used > 0) {
                m.put("content", parts)
                m.remove("atts")
            }
        }
    }

    private fun attachContent(messages: MutableList<JSONObject>, cfg: AgentConfig) {
        if (cfg.attachments.isEmpty()) return
        val last = messages.lastOrNull { it.optString("role") == "user" } ?: return
        val parts = JSONArray()
        parts.put(JSONObject().put("type", "text").put("text", last.optString("content")))
        cfg.attachments.forEach { a ->
            val type = a.optString("type").lowercase()
            // 前端传的是 MIME（image/png、image/gif），这里只认 "image" 会把所有图片
            // 附件静默丢掉 —— 表现就是「发表情包模型看不懂」，只收到一句 [表情包] 名称。
            val isImage = (type == "image" || type.startsWith("image/")) && a.optString("dataUrl").isNotBlank()
            if (isImage) {
                parts.put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", a.optString("dataUrl"))))
            } else if (a.optString("text").isNotBlank()) {
                parts.put(JSONObject().put("type", "text").put(
                    "text", "\n\n[附件 ${a.optString("name")}]\n" + a.optString("text").take(20_000)
                ))
            }
        }
        if (parts.length() > 1) last.put("content", parts)
    }

    private fun toolMeta(name: String, args: JSONObject): String = when (name) {
        "read", "write", "edit", "delete_path", "stat" -> args.pick("file_path", "path")
        "list_dir" -> args.pick("path").ifBlank { "." }
        "glob" -> args.optString("pattern")
        "grep" -> args.optString("pattern")
        "bash" -> args.pick("command").take(80)
        "web_search" -> args.pick("query", "queries").take(60)
        "subagent", "subagent_fork" -> args.pick("description", "prompt", "task").take(60)
        "exit_plan_mode" -> args.optString("plan").take(50)
        "update_goal" -> args.pick("action", "status")
        "todo_write" -> "${args.optJSONArray("todos")?.length() ?: args.optJSONArray("items")?.length() ?: 0} \u9879"
        "web_fetch" -> args.optString("url").take(60)
        "read_image" -> args.pick("file_path", "path")
        "create_goal" -> args.optString("objective").take(50)
        "get_goal" -> "\u8bfb\u53d6\u76ee\u6807"
        "skill" -> args.optString("name")
        "ask_user_question" -> {
            val arr = args.optJSONArray("questions")
            if (arr != null && arr.length() > 0) arr.optJSONObject(0)?.optString("question")?.take(50).orEmpty()
            else args.optString("question").take(50)
        }
        "run_code" -> "JS \u00b7 ${args.optString("code").length} \u5b57\u7b26"
        "cordis_inspect_list" -> "\u5185\u6838\u6e05\u5355"
        "cordis_inspect_query" -> args.pick("method", "provider", "pattern")
        "plugin_manager" -> args.optString("action")
        "plugin_market" -> args.pick("query").take(40)
        "str_replace_editor" -> args.optString("path").take(60)
        "apply_patch" -> "unified diff"
        "present" -> "${args.optJSONArray("files")?.length() ?: 0} \u4e2a\u6587\u4ef6"
        "terminal_send" -> args.pick("text").take(60)
        "terminal_open" -> args.pick("name", "cwd")
        "terminal_read", "terminal_close", "terminal_signal" -> args.optString("sessionId")
        "terminal_list" -> "\u5217\u8868"
        "job_output", "job_kill" -> args.optString("job_id")
        "job_list" -> "\u5217\u8868"
        "schedule_create" -> args.pick("title").take(40)
        "schedule_update", "schedule_delete" -> args.optString("id")
        "schedule_list" -> "\u5217\u8868"
        "session_event_read", "session_event_trace" -> "#${args.optInt("seq")}"
        "session_event_search", "session_search" -> args.pick("query").take(50)
        "session_trace" -> args.pick("session_id").take(30)
        "working_directory" -> args.pick("cd").ifBlank { "\u8bfb\u53d6" }
        "list_agents" -> args.pick("scope").ifBlank { "children" }
        "send_message" -> args.pick("message").take(50)
        "interrupt_agent" -> args.optString("agent_id")
        "list_subagent_models" -> "\u6a21\u578b\u8def\u7531"
        "ralph" -> args.optString("objective").take(50)
        "workflow" -> "JS \u5de5\u4f5c\u6d41"
        else -> ""
    }

    class RetryDecision(val retry: Boolean)
}

/**
 * 「工程内文件」判定（自动交付兜底的排除项，见 [AgentDriver.flushTurnDeliverables]）。
 *
 * 文件的祖先目录里出现任何一个项目清单，就说明它是**工程内的源/资源**（脚手架
 * 生成、构建输入），不是交付产物。否则 app_new 生成 Android 工程时，res/mipmap
 * 各密度目录下的 ic_launcher.png 五份图标会被兜底打包成一张「5 个 png」的
 * 交付卡（真机实测）。显式 present 不受影响：兜底只在没有任何显式交付时触发。
 */
internal object ProjectMarkers {
    val NAMES = setOf(
        "AndroidManifest.xml",
        "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
        "package.json", "Cargo.toml", "pom.xml", "go.mod",
        "pyproject.toml", "setup.py", "CMakeLists.txt", "Makefile", "meson.build",
    )

    /** f 的祖先目录（含 root 本身）是否含项目清单——含即视为工程内文件 */
    fun insideProject(root: File, f: File): Boolean {
        var d: File? = f.parentFile
        while (d != null) {
            if (NAMES.any { File(d, it).isFile }) return true
            if (d == root) break
            d = d.parentFile
        }
        return false
    }

}

/** 兜底路径：从工具输出里取退出码，只认 JSON 载荷里的 exit_code / exitCode，纯文本返回 null。
 *  前台命令走主路径（[ToolPipeline.Outcome.exitCode]），这里留给终端 / 后台任务类工具。
 *  放在文件级：调用点在 AgentDriver 内部的嵌套运行器里，成员私有函数够不着。 */
private fun exitCodeOfJson(out: String): Int? {
    val t = out.trimStart()
    if (!t.startsWith("{")) return null
    return runCatching {
        val j = org.json.JSONObject(t)
        when {
            j.has("exit_code") -> j.optInt("exit_code")
            j.has("exitCode") -> j.optInt("exitCode")
            else -> null
        }
    }.getOrNull()
}
