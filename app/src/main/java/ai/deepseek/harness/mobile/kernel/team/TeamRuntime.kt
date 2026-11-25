package ai.deepseek.harness.mobile.kernel.team

import ai.deepseek.harness.mobile.agent.AgentConfig
import ai.deepseek.harness.mobile.agent.HookBus
import ai.deepseek.harness.mobile.agent.LlmClient
import ai.deepseek.harness.mobile.agent.AgentLoop
import ai.deepseek.harness.mobile.agent.AgentRequest
import ai.deepseek.harness.mobile.agent.Presets
import ai.deepseek.harness.mobile.agent.PromptAssembler
import ai.deepseek.harness.mobile.agent.SessionStore
import ai.deepseek.harness.mobile.agent.ToolPipeline
import ai.deepseek.harness.mobile.agent.WebSearch
import ai.deepseek.harness.mobile.kernel.ToolKernel
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 团队部署上限的默认值与校验 —— 桌面 `TeamService.Config`（index.ts:42-64）的等价物。
 *
 * 手机端以前只有 maxMembers / maxTasks / maxConcurrent 能配，消息上限和结算超时写死在
 * 代码里；桌面对这四个数走同一个正整数校验，越界就 `TEAM_INVALID_CONFIG`。现在四个数
 * 在这一份真源里：插件装配、设置回显、运行判据读的是同一组。
 */
internal object TeamLimits {
    /**
     * 成员上限。桌面 schema 默认是 16，但 dsh 这条产品profile 实配 8
     * （agent-team-profile/cordis.patch.yml:20）—— 手机上按用户实际会碰到的那一份对齐，
     * 不是按 schema 的理论默认。含 failed 成员一起算（TeamRoster.validateName）。
     */
    const val DEFAULT_MAX_MEMBERS = 8
    const val DEFAULT_MAX_TASKS = 256

    /** 单条团队消息 JSON 序列化后的字节上限 */
    const val DEFAULT_MAX_MESSAGE_BYTES = 65_536

    /** 卸载时等待已准入工作收尾的上限（也是每个成员线程的收尾上限） */
    const val DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000L

    /** 桌面 positiveLimit（index.ts:48-52）：不是正整数就不是「配置不划算」，而是调用方写错了 */
    fun positive(name: String, value: Long): Long {
        if (value < 1L || value > Int.MAX_VALUE.toLong()) {
            throw TeamError("TEAM_INVALID_CONFIG", "$name 必须是正整数（收到 $value）")
        }
        return value
    }
}

/**
 * 团队执行器 —— 桌面 `continuable-subagent` + Team 运行时的手机端等价物。
 *
 * 和旧实现的根本区别：旧 `spawn_teammate` 是「借 Lead 当前轮的 Thread 跑一个
 * `runSubagent`」，三个后果全都真实发生过：
 *   · Lead 这一轮结束，teammate 的 runtime 就被置空，工具调用开始报「需要活跃轮次」
 *   · 进程一退，注册表在内存里，整个团队凭空消失
 *   · 多个 teammate 各起一个裸 Thread 打同一个端点，429 直接互相踩
 *
 * 现在这一层是**独立运行时**：
 *   · 有界池（默认 8，与子智能体并行上限是同一个数）
 *   · 每个成员有自己的 session id、消息历史、模型与预算，冷恢复从日志重建
 *   · 轮次之间检查 inbox（中途 steer）与预算，超限就 idle 并如实说明
 *   · 团队任何变化都 bump 一个代数，`waitForChange` 用条件变量等，不再 200ms 轮询
 *   · 写范围（write_scopes）只做**提示**：重叠写进任务视图的 warnings，与桌面一致，
 *     运行时不拦写入（谁声明了同一前缀，Lead 自己在任务板上看得见并负责分工）
 *   · **准入截止 + 有界结算**（对齐桌面 `TeamRuntimeLifecycle`）：卸载后新操作
 *     一律 `TEAM_DISPOSED`，已准入的取消后在超时内结算，并把异常如实记下来
 *   · **多团队并存**（rc.97 起对齐桌面 TeamId=SessionId）：每个顶层会话一支团队，
 *     各有独立的 roster / 任务板 / 收件箱 / 运行中成员；容量上限（成员数、任务数、
 *     并行数）是插件级的，全团队共享。
 *
 * 「完成」不是成员状态：成员的持久生命周期（phase）只有 provisioning → active / failed；
 * 「此刻在不在跑」是运行活动，由运行时派生成 status（running/inactive），不进状态机。
 */
class TeamRuntime(
    private val kernel: ToolKernel,
    private val hooks: HookBus,
    private val sessions: SessionStore,
    private val capacity: TeamCapacity,
    private val journal: TeamJournal,
    @Volatile private var limit: Config = Config().validated(),
    private val log: (String) -> Unit = {},
) {

    data class Config(
        /** 同时执行的 teammate 上限（1–8，与桌面「子智能体并行上限」同一个数） */
        val maxConcurrent: Int = 8,
        /** 单条团队消息的字节上限（桌面 config.maxMessageBytes：以前写死 64KB，现在可配） */
        val maxMessageBytes: Int = TeamLimits.DEFAULT_MAX_MESSAGE_BYTES,
        /** 卸载收尾上限（桌面 config.disposalTimeoutMs：以前写死 5s，现在可配） */
        val disposalTimeoutMs: Long = TeamLimits.DEFAULT_DISPOSAL_TIMEOUT_MS,
    ) {
        /** 桌面在构造服务时一次性校验全部部署上限（index.ts:77-85），越界即装配失败 */
        fun validated(): Config {
            TeamLimits.positive("maxConcurrent", maxConcurrent.toLong())
            TeamLimits.positive("maxMessageBytes", maxMessageBytes.toLong())
            TeamLimits.positive("disposalTimeoutMs", disposalTimeoutMs)
            return this
        }
    }

    enum class WaitOutcome { CHANGED, TIMEOUT, CANCELLED, CLOSED }

    /**
     * 一支团队 = 一个顶层会话（桌面 `TeamId = SessionId`）。
     * roster / 任务板 / 收件箱 / 运行中成员 / Lead 配置都是 per-scope 的。
     */
    inner class Scope(val sid: String) {
        val roster = TeamRoster(journal, capacity)
        val board = TeamBoard(journal, capacity)
        /** 成员名 → 活跃 Future（「此刻在跑」的权威来源） */
        val active = ConcurrentHashMap<String, Future<*>>()
        /** 成员收件箱：消息带发送者，队友互发时才不会被当成「Lead 补充」 */
        val inboxes = ConcurrentHashMap<String, LinkedBlockingQueue<JSONObject>>()
        /** 已投递过的 Lead 消息 id（重复投递 = 终态拒绝，桌面 delivered 列表） */
        val delivered = java.util.Collections.synchronizedSet(HashSet<String>())
        /** 最后一次 Lead 轮次配置：进程内冷恢复（send_message 唤醒）用它重建端点 */
        @Volatile var lastLead: AgentConfig? = null
        /** 回放期被拒绝的持久记录（桌面 projection 的 failure，终态） */
        @Volatile var failure: String? = null
        val gate = Object()
        @Volatile var revision: Long = 0
    }

    private val pipeline = ToolPipeline(kernel.registry, kernel.workspace, hooks, log)
    private val assembler = PromptAssembler(hooks, log)
    /** teammate 派子代理走与主 Agent 同一条路径（深度 / 并行 / 工具白名单都在里面） */
    private val subagents = ai.deepseek.harness.mobile.agent.SubagentRunner(kernel, hooks, log)
    /** 成员的历史也要按设置里的窗口压：跑几十轮的成员不压必然超窗（与主对话同一个压缩器） */
    private val compactor = ai.deepseek.harness.mobile.agent.Compactor(log)
    private val pool = Executors.newFixedThreadPool(limit.maxConcurrent.coerceIn(1, 8)) { r ->
        Thread(r, "team-member-${THREAD_SEQ.incrementAndGet()}").apply { isDaemon = true }
    }
    private val scopes = ConcurrentHashMap<String, Scope>()

    /** 队友发给 Lead 的消息（按 Lead 会话分）：下一轮 pre-step 或 wait_agent 认领 */
    private val leadInbox = ConcurrentHashMap<String, LinkedBlockingQueue<JSONObject>>()

    /** 卸载时仍异常退出的成员（有界结算后汇总上报，不静默丢） */
    private val disposeFailures = java.util.Collections.synchronizedList(mutableListOf<String>())

    /** 团队保活要用的应用上下文（插件未拿到时为 null，降级成「应用内跑」） */
    private val appContext = kernel.service("app.context") as? android.content.Context

    /** 当前绑定的团队（面板 / 工具调用所在会话的那支） */
    @Volatile private var current: Scope? = null

    @Volatile private var lastPushAt: Long = 0

    /** 准入闸门：一旦关闭，spawn/send 不再进入（对齐桌面 lifecycle.close） */
    @Volatile private var disposed = false

    /* ---------------- 生命周期 ---------------- */

    /**
     * 绑定到某个 Lead 会话的团队：首次访问时回放它的 roster / 任务板 / 未认领消息。
     *
     * rc.96 之前「同一时刻只允许一个会话的团队在跑」（有成员在跑时切会话报 TEAM_BUSY），
     * 因为 roster / 任务板 / Lead 收件箱只有一份。rc.97 起状态按会话分桶（桌面
     * TeamId=SessionId 同构），每支团队互不干扰，切换不再需要拒绝 ——
     * A 团队的成员继续在后台跑，B 会话照常建自己的团队。
     */
    @Synchronized
    fun attach(sessionId: String) {
        val sid = sessionId.ifBlank { "draft" }
        current?.let { if (it.sid == sid) return }
        val scope = scopes[sid] ?: createScope(sid)
        current = scope
        pushSnapshot()
    }

    private fun createScope(sid: String): Scope {
        val replay = journal.replay(sid)
        val s = Scope(sid)
        s.failure = replay.failure
        s.delivered.addAll(replay.deliveredIds)
        s.roster.load(sid, replay)
        s.board.load(sid, replay)
        scopes[sid] = s
        seedLeadInbox(sid, replay.pendingMessages, s)
        return s
    }

    private fun scopeFor(sid: String): Scope = scopes[sid] ?: createScope(sid)

    /**
     * 会话被删除时的团队级联：取消在跑的成员、把这支团队从内存里摘掉，
     * 并交出成员会话 id，让调用方把它们的日志一起删掉。
     *
     * 不走 [interrupt]：那条路要求「Lead 在本轮里调用」（`TeamCall.requireLead`），
     * 而这里是用户点删除 —— 已经没有「本轮」了，也不该再往日志里写一条「被 Lead 中断」。
     * 顺序要紧：先 cancel 再摘 scope，否则 Future 还在往一支已经不存在的团队写事件。
     */
    @Synchronized
    fun disposeLead(sid: String): List<String> {
        if (sid.isBlank()) return emptyList()
        val scope = scopes.remove(sid) ?: return emptyList()
        val memberSids = scope.roster.teammates().map { it.sessionId }.filter { it.isNotBlank() }
        scope.active.values.forEach { f -> runCatching { f.cancel(true) } }
        scope.active.clear()
        scope.inboxes.clear()
        if (current?.sid == sid) current = null
        log("会话 $sid 删除：团队拆掉，成员会话 ${memberSids.size} 个待清")
        return memberSids
    }

    private fun currentScope(): Scope =
        current ?: throw TeamError(
            "TEAM_NOT_MEMBER",
            "调用者不属于任何一支团队：团队还没绑定会话（先由 Lead 在本轮内建队或 attach 会话 id）",
        )

    fun leadSession(): String = current?.sid ?: ""

    /** 当前会话的 roster / 任务板（插件工具层在 attach 之后取用） */
    fun currentRoster(): TeamRoster = currentScope().roster
    fun currentBoard(): TeamBoard = currentScope().board

    /** 成员/任务上限（插件级容量，设置页读它做回显） */
    fun maxMembers(): Int = capacity.maxMembers
    fun maxTasks(): Int = capacity.maxTasks

    /** 设置页热改成员/任务上限：所有团队（每个会话一支）下一次创建即生效 */
    fun updateCapacity(maxMembers: Int, maxTasks: Int) {
        capacity.maxMembers = maxMembers.coerceIn(1, 64)
        capacity.maxTasks = maxTasks.coerceIn(8, 2048)
    }

    /** 当前生效的限额（设置页读它做回显） */
    fun limits(): Config = limit

    /**
     * 热更新限额：设置页改完立即生效，不必重启插件。
     *
     * 池大小是唯一直实要动结构的一项：固定池返回的本来就是 ThreadPoolExecutor，
     * 调整 core/max 即可；已经在跑的成员继续按旧预算跑完，新提交的按新上限排队。
     * 缩小并发不会踢掉正在跑的成员 —— 那会把用户正在等的活无声掐死。
     */
    @Synchronized
    fun updateLimits(next: Config) {
        val old = limit
        // 校验排在赋值之前（桌面在服务构造里 positiveLimit 四个数）：一个 0 或负数
        // 会让线程池直接抛 IllegalArgumentException，团队连快照都推不出来
        limit = next.validated()
        (pool as? java.util.concurrent.ThreadPoolExecutor)?.let { tpe ->
            runCatching {
                if (next.maxConcurrent >= old.maxConcurrent) {
                    tpe.maximumPoolSize = next.maxConcurrent
                    tpe.corePoolSize = next.maxConcurrent
                } else {
                    tpe.corePoolSize = next.maxConcurrent
                    tpe.maximumPoolSize = next.maxConcurrent
                }
            }
        }
        log("team limits updated: concurrent=${next.maxConcurrent}")
        current?.let { bump(it) }
    }

    fun revision(): Long = currentScope().revision

    /**
     * 插件卸载：关闭准入 → 取消已准入的工作 → 有界结算。
     *
     * 与桌面的差异只有一处：桌面在 Node 里可以 `await settle()` 直到干净，
     * Android 的卸载发生在主线程，不能阻塞。所以状态收敛同步做完（快），
     * 线程退出放到守护线程里带超时等待 —— 超时就如实记一条，
     * 而不是假装「都停了」。
     */
    @Synchronized
    fun shutdown() {
        if (disposed) return
        disposed = true
        val timeoutMs = limit.disposalTimeoutMs
        // 收走仍在跑的 Future 再清空 active：清空是必须的 —— 留着的话下一次 send
        // 会以为「它还在跑」（只进收件箱不提交），消息就躺在那儿没人读
        val live = mutableListOf<Pair<String, Future<*>>>()
        scopes.values.forEach { s ->
            synchronized(s.gate) { s.gate.notifyAll() }
            s.roster.teammates().filter { it.running }.forEach { m ->
                m.running = false
                m.diagnostic("团队插件已卸载，执行中止")
                journal.memberProgress(s.sid, m)
            }
            s.active.entries.forEach { (name, f) ->
                live.add(name to f)
                // 先「温和取消」（cancel(false)）：成员的每一轮在边界处看 !m.running，
                // 会把没跑的工具调用如实结算成 TOOL_NOT_STARTED 并写日志。
                // 以前这里直接 cancel(true)：正在写的工具被中断位打断，日志留半截，
                // 冷恢复时那条工具永远配不上对。
                runCatching { f.cancel(false) }
            }
            s.active.clear()
        }
        pool.shutdown()

        runCatching { syncKeep() }
        awaitTermination(timeoutMs, live)
        current?.let { pushSnapshot(it) }
    }

    /**
     * 有界结算：先等在边界自查的成员跑完，超时才升级成硬中断，并如实记一条
     * `TEAM_DISPOSAL_TIMEOUT`（桌面 `stopTeammates` 走 `lifecycle.withTimeout(drainChildren)`，
     * 超时同样是要报的错，不是「算了」）。
     *
     * 全程在守护线程里做：Android 的插件卸载发生在主线程，不能阻塞。
     */
    private fun awaitTermination(timeoutMs: Long, live: List<Pair<String, Future<*>>>) {
        val t = Thread({
            val settled = runCatching { pool.awaitTermination(timeoutMs, TimeUnit.MILLISECONDS) }
                .getOrDefault(true)
            if (!settled) {
                live.forEach { runCatching { it.second.cancel(true) } }
                pool.shutdownNow()
                val names = live.map { it.first }.joinToString("、")
                disposeFailures.add("TEAM_DISPOSAL_TIMEOUT: ${timeoutMs}ms 内仍有成员未收尾（$names），已强制中断")
                log("team dispose: ${timeoutMs}ms 内仍有成员线程未退出，升级成硬中断：$names")
            }
            val fails = disposeFailures.toList()
            if (fails.isNotEmpty()) {
                log("team dispose: ${fails.size} 个成员异常退出：${fails.take(3).joinToString("；")}")
            }
        }, "team-dispose")
        t.isDaemon = true
        t.start()
    }

    fun isRunning(name: String): Boolean = currentScope().active.containsKey(name)

    /**
     * Lead 侧记账（钩子入口）：pre-step 记轮次，agent/tool 记工具数。
     * 成员会话 id 形如 `<leadSid>#<name>`，带 # 的一律不计入 Lead ——
     * 那是 teammate 自己的循环，它的统计由 runMember 自己写。
     */
    fun noteLeadStep(sessionId: String, action: String = "") {
        if (sessionId.isBlank() || sessionId.contains("#")) return
        val scope = scopeFor(sessionId)
        scope.roster.noteLeadStep(action)
        bumpThrottled(scope)
    }

    fun noteLeadTool(sessionId: String, name: String) {
        if (sessionId.isBlank() || sessionId.contains("#")) return
        val scope = scopeFor(sessionId)
        scope.roster.noteLeadTool(name)
        bumpThrottled(scope)
    }

    private fun bump(scope: Scope) {
        lastPushAt = System.currentTimeMillis()
        synchronized(scope.gate) {
            scope.revision++
            scope.gate.notifyAll()
        }
        pushSnapshot(scope)
    }

    /**
     * 高频变化（每轮/每个工具调用都会改 lastAction）用节流版：
     * revision 仍然跳（waitForChange 不会漏），但快照推送最多 800ms 一次 ——
     * 否则一个 10 轮的成员会给 WebView 推几十次整块任务板，面板一直闪。
     */
    private fun bumpThrottled(scope: Scope, minGapMs: Long = 800) {
        val now = System.currentTimeMillis()
        if (now - lastPushAt < minGapMs) return
        lastPushAt = now
        bump(scope)
    }

    /** 前台服务跟着「有没有人在跑」走：有人跑就保活，全员 idle 就撤 */
    private fun syncKeep() {
        val running = scopes.values.flatMap { it.roster.teammates() }.filter { it.running }
        if (running.isEmpty()) {
            TeamKeepService.sync(appContext, 0, "")
            return
        }
        val inProgress = scopes.values.sumOf { s ->
            runCatching { s.board.boardView().optInt("inProgress") }.getOrDefault(0)
        }
        val text = buildString {
            append(running.take(3).joinToString("、") { it.name })
            if (running.size > 3) append(" 等 ${running.size} 人")
            append(" 在跑")
            if (inProgress > 0) append(" · $inProgress 个任务进行中")
        }
        TeamKeepService.sync(appContext, running.size, text)
    }

    /** 把团队快照推给界面（不阻塞；没有 sink 就只更新日志） */
    /** 推送计数（排障/回归用）：次数与近似字节，随快照下发 —— 用它证明合批真的生效 */
    @Volatile private var pushCount = 0L
    @Volatile private var pushBytes = 0L

    /**
     * 把团队快照推给界面（不阻塞；没有 sink 就只更新日志）。
     *
     * 必须推「变化发生的那支团队」而不是 `current`：current 只跟着最后一次 attach 走，
     * A 会成员在后台跑、用户在 B（或新建会话把 current 拉到 draft）时，读快照会把
     * A 的数据标成别的会话 —— 界面于是把旧会话的团队画到新会话头上。
     */
    private fun pushSnapshot(scope: Scope? = null) {
        // 卸载之后 eventSink 可能已经指向下一个插件实例：不再推，免得画出一份幽灵团队
        if (disposed) return
        val s = scope ?: current ?: return
        // 前台服务跟着「有没有人在跑」走：spawn 时起（此刻 App 一定在前台，
        // Android 12+ 才允许起前台服务），全员 idle 时撤，不在后台留常驻通知
        syncKeep()
        runCatching {
            val snap = viewOf(s)
            pushCount++
            pushBytes += snap.toString().length
            kernel.eventSink?.invoke(JSONObject().apply {
                put("t", "team")
                put("team", snap)
            })
        }
    }

    /* ---------------- spawn ---------------- */

    @Synchronized
    fun spawn(
        lead: AgentConfig,
        name: String,
        description: String,
        prompt: String,
        context: String,
        model: String,
    ): TeamMember {
        // 建队是 Lead 的专属能力：先认人，再谈装配（桌面 spawnAdmitted 的第一刀就是 role 判定）
        TeamCall.requireLead("创建队友（spawn_teammate）")
        checkAdmission("spawn_teammate")
        val sid = lead.sessionId.ifBlank { "draft" }
        attach(sid)
        val scope = currentScope()
        scope.lastLead = lead
        val clean = scope.roster.validateName(name)
        if (prompt.isBlank()) throw TeamError("TEAM_INVALID_ARGUMENT", "prompt 不能为空：teammate 需要完整初始任务")
        // 桌面 roster.ts:241 的 description 是必填 + ≤200（不是「可空就取 prompt 前 60 字」）：
        // 这一句是显示在 roster 卡上、也是成员自己被介绍的唯一一行，空的或五万字的都不行
        val duty = requiredText(description, "description", MEMBER_DESC_MAX)
        // 存「显式指定的那一个」，空就留空：跟随哪一档要等真正跑这一轮时才算得出来
        // （设置页/子代理档随时会改，spawn 时刻定死了就会带着旧值一路复制到冷恢复）。
        val useModel = model.trim()
        val memberSid = "$sid#$clean"
        val m = scope.roster.reserve(
            name = clean,
            description = duty,
            context = context.lowercase().let { if (it == "fork") "fork" else "fresh" },
            model = useModel,
            // 安卓端 provider 恒为 in-process：桌面可换外部进程后端（ACP/Claude Code/Codex/SDK），
            // 手机上没有那个运行时。字段照桌面语义持久化并纳入不可变校验（TeamJournal.replay）。
            provider = "in-process",
            memberSid = memberSid,
        )
        val task = if (m.context == "fork") forkBrief(lead) + "\n\n【你的任务】\n" + prompt else prompt
        // 桌面 spawn 的第三步是 checkpointInitialPrompt：首条任务必须已在子会话里
        // 持久接受，才算创建成功。手机端的「子会话」就是 memberSid 这个 jsonl，
        // 所以这里同步写、写失败就判失败 —— 否则进程一死，这个成员既没任务也无法冷恢复。
        try {
            journal.userTurn(memberSid, task, from = "lead", strict = true)
        } catch (e: Throwable) {
            settleCreatorFailure(scope, m, "初始任务没写进成员会话", e)
        }
        submit(scope, m, lead, task, resume = false)
        bump(scope)
        return m
    }

    /**
     * fork：把 Lead 最近的**完整轮次**（对话 + 工具执行结果）交给新成员。
     *
     * 桌面 `subagent-fork-in-process` 是把父会话日志到最后一个 `turn/end` 为止的
     * **真实事件前缀**播种子会话 —— 工具调用、结果、附件全在。
     * 手机端没有事件级复制（成员会话是独立 jsonl），但可以做到同量级的信息量：
     * 每一轮的用户原话、助手原话、以及这一轮跑过哪些工具、成功还是失败。
     *
     * 之前只取「最后 60 条事件、每条 140 字的纯文本」—— 工具结果全丢，
     * reviewer 看到的是「用戶问过几句」的残片，不是真实上下文。
     */
    private fun forkBrief(lead: AgentConfig): String {
        val blocks = mutableListOf<StringBuilder>()
        var current: StringBuilder? = null
        runCatching {
            sessions.read(lead.sessionId).forEach { ev ->
                when (ev.optString("type")) {
                    "user/message" -> {
                        val b = StringBuilder()
                        b.append("用户：").append(ev.optString("text").take(1500)).append('\n')
                        blocks.add(b)
                        current = b
                    }
                    "assistant/message" -> {
                        val t = ev.optString("text").trim()
                        val b = current
                        if (t.isNotEmpty() && b != null) b.append("助手：").append(t.take(1500)).append('\n')
                    }
                    "tool/result" -> {
                        val name = ev.optString("name")
                        val b = current
                        if (name.isNotBlank() && b != null) {
                            b.append("· 工具 ").append(name).append(' ')
                                .append(if (ev.optBoolean("ok")) "成功" else "失败").append('\n')
                        }
                    }
                }
            }
        }
        if (blocks.isEmpty()) return ""
        val tail = blocks.takeLast(FORK_TURNS)
        return "【从 Lead 会话分叉】最近 ${tail.size} 轮对话（含工具执行结果）：\n" +
            tail.joinToString("\n")
    }

    /**
     * 创建者报错时的收口 —— 桌面 roster.ts:282-298 的形状：写终态失败记录；
     * 但如果这个人已经被别的通道唤醒成 active，就抛 `TEAM_PROVISIONING_CONFLICT`
     * （roster.ts:283-291），而不是把一个活人写成 failed。
     *
     * 以前这里是 `runCatching { fail(...) }` + 原样抛出：写日志失败被吞掉，
     * 而「已经 active」这一支根本不存在 —— 创建者的报错与「人还活着」两件事
     * 合成一条 failed，之后 Lead 再发消息就撞 TEAM_MEMBER_NOT_FOUND，历史接不回来。
     */
    private fun settleCreatorFailure(scope: Scope, m: TeamMember, reason: String, cause: Throwable): Nothing {
        val detail = cause.message ?: cause.javaClass.simpleName
        val settled = runCatching { scope.roster.fail(m, "$reason：$detail") }
        bump(scope)
        if (settled.isSuccess && !settled.getOrDefault(true)) {
            throw TeamError(
                "TEAM_PROVISIONING_CONFLICT",
                "成员「${m.name}」在创建者报错时已经 active（$reason：$detail）；不写成失败，按活着的人处理",
            )
        }
        throw TeamError((cause as? TeamError)?.code ?: "TEAM_INTERNAL", "$reason：$detail")
    }

    private fun submit(scope: Scope, m: TeamMember, lead: AgentConfig, task: String, resume: Boolean) {
        if (disposed) {
            settleCreatorFailure(scope, m, "团队插件已卸载，未启动",
                TeamError("TEAM_DISPOSED", "团队插件已卸载，${m.name} 未启动"))
        }
        // 先把「运行中」登记进 scope，再把任务交给线程池。
        // 旧顺序是 submit 之后才写 active/running：工作线程完全可能在主线程回写之前
        // 跑完并 remove，随后主线程又把 active 和 running=true 写回去 —— 成员永久
        // running、前台服务不撤、wait_agent 白等到超时。FutureTask 允许先建任务后派发。
        val f = java.util.concurrent.FutureTask<Unit> {
            try {
                runMember(scope, m, lead, task, resume)
            } finally {
                ai.deepseek.harness.mobile.kernel.agents.SubagentCapacity.release(scope.sid)
            }
        }
        // 槽位在**派发之前**抢（桌面 manager.ts:744 pool.reserve() → activation.ts:24-31 抛
        // ACTIVATION_LIMIT_REACHED，roster.ts:264-281 把它落成 failed 成员并把原错误抛给调用方）。
        // 手机端以前把这一查挪进工作线程、抢不到只记一条 idle —— 结果是 Lead 收到「派成功了」，
        // 面板上那个人挂着「等待唤醒」，谁也看不出它是被额度挡住的。现在同桌面：
        // 抢不到就是 failed + member.error（面板红点），错误码原样回给模型。
        // 一个并行预算就一份（桌面只有 maxActiveSubagents：teammate 本身就是 subagent 的孩子，
        // 队友与子代理占同一份额度；以前两套计数 8 + 8 能同时跑 64 个 LLM 循环）。
        if (!ai.deepseek.harness.mobile.kernel.agents.SubagentCapacity
                .tryAcquire(scope.sid, limit.maxConcurrent)
        ) {
            scope.active.remove(m.name)
            m.running = false
            settleCreatorFailure(
                scope, m, "并行已满（队友与子代理共用这一份额度）",
                TeamError(
                    "ACTIVATION_LIMIT_REACHED",
                    "subagent limit reached (active child limit: ${limit.maxConcurrent})",
                ),
            )
        }
        scope.active[m.name] = f
        m.running = true
        try {
            pool.execute(f)
        } catch (e: Throwable) {
            scope.active.remove(m.name)
            m.running = false
            settleCreatorFailure(scope, m, "启动失败", e)
        }
        // 这里不再 persist：reserve 已写过 provisioning，而 runMember 可能在另一个
        // 线程里已经 activate 成 active —— 再写一条 provisioning 会让回放校验
        // 判定「创建完成后又退回 provisioning」（终态冻结）。状态变化只由
        // roster.activate / idle / fail 负责写日志。
    }

    /* ---------------- 消息与中断 ---------------- */

    /**
     * 桌面 `resolveActiveMember`（roster.ts:42-54）的等价物：其余名字必须解析成**持久 active**
     * 的成员 —— 查不到、创建中、创建失败一律同一个码。
     *
     * 手机端以前给这三种各造了一个码（TEAM_MEMBER_FAILED / TEAM_MEMBER_PROVISIONING），
     * 看着更细，实际后果是模型要学三套规则；「为什么不行」写在 message 里就够了。
     */
    private fun resolveActive(scope: Scope, rawName: String): TeamMember {
        val name = rawName.trim()
        val m = scope.roster.get(name)
        if (m == null || m.phase != MemberPhase.ACTIVE) {
            val why = when {
                m == null -> "roster 里没有这个名字"
                m.phase == MemberPhase.FAILED -> "它创建失败（${m.lastError}）"
                else -> "它还在创建中"
            }
            throw TeamError("TEAM_MEMBER_NOT_FOUND", "活跃成员「$name」不存在：$why（用 list_agents 看当前 roster）")
        }
        return m
    }

    /**
     * 发消息：running → 进 inbox，下一轮边界认领；inactive → 冷恢复一轮。
     * 与桌面一致：成功只代表「已进入对方收件箱」，不代表它已经处理。
     *
     * **target=lead 是合法的**，只要发送者是 teammate —— 这正是队友汇报的唯一通道。
     * 桌面用 `root.steer()` 把消息塞进 Lead 的下一轮；手机端没有 steer 的跨线程入口，
     * 所以落到 Lead 的收件箱，由 `agent/pre-step` 钩子或 wait_agent 认领。
     */
    @Synchronized
    fun send(target: String, message: String, lead: AgentConfig?): JSONObject {
        checkAdmission("send_message")
        val scope = currentScope()
        if (target.isBlank()) throw TeamError("TEAM_INVALID_ARGUMENT", "target 不能为空")
        if (message.isBlank()) throw TeamError("TEAM_INVALID_ARGUMENT", "message 不能为空")

        // 桌面 `sendAdmitted`（index.ts:224-248）的判序：先把目标解析成**活跃成员**，
        // 再判自发自收，最后才量字节。三条都在这里逐一对应，包括「解析在前」——
        // 一个不存在的 target 与「给自己发」必须是不同的错，模型看到才知道该改哪一处。
        val m = if (target.trim() == "lead") null else resolveActive(scope, target)
        val caller = TeamCall.callerName()
        if (target.trim() == caller) {
            throw TeamError("TEAM_SELF_MESSAGE", "$caller 不能给自己发消息")
        }
        // 桌面按真正下发的那一份算字节（index.ts:230-236：计含 "Team message from X:" 前缀的
        // 完整 JSON）。手机端前缀换成结构化字段 from，同一道理：只量正文会漏掉发送者，
        // 将来加结构化字段也会漏 —— 所以把 text 与 from 一起包成 JSON 再量。
        val wireBytes = JSONObject().put("text", message).put("from", caller).toString()
            .toByteArray(Charsets.UTF_8).size
        if (wireBytes > limit.maxMessageBytes) {
            throw TeamError("TEAM_MESSAGE_TOO_LARGE", "单条消息上限 ${limit.maxMessageBytes / 1024}KB（按 JSON 序列化后计，本条 $wireBytes 字节）")
        }
        if (m == null) {
            val id = UUID.randomUUID().toString()
            // 严格写：写不进日志就等于没送到，绝不给发送方一个假的 sent:true
            journal.leadMessage(scope.sid, id, caller, message)
            leadInbox.computeIfAbsent(scope.sid) { LinkedBlockingQueue() }
                .offer(JSONObject().put("id", id).put("from", caller).put("text", message))
            journal.activity(scope.sid, "lead-message", caller, message.take(80))
            bump(scope)
            return JSONObject().apply {
                put("sent", true)
                put("target", "lead")
                put("status", "queued")
                put("note", "已进 Lead 收件箱：Lead 下一轮或 wait_agent 会认领；不代表已读")
            }
        }

        val queue = scope.inboxes.getOrPut(m.name) { LinkedBlockingQueue() }
        queue.offer(JSONObject().put("from", caller).put("text", message))
        m.diagnostic("收到消息：${message.take(80)}")
        scope.roster.persist(m)
        journal.userTurn(m.sessionId, message, from = caller)
        if (!scope.active.containsKey(m.name)) {
            // inactive（或上次已结束）：冷恢复。没有 Lead 配置就拿不回端点，明确拒绝。
            val leadCfg = lead ?: scope.lastLead?.takeIf { it.sessionId == scope.sid } ?: throw TeamError(
                "TEAM_NO_LEAD_CONTEXT",
                "${m.name} 当前不在执行；唤醒它需要 Lead 的模型配置（先由 Lead spawn 或在本轮内发消息）",
            )
            scope.roster.activate(m)
            submit(scope, m, leadCfg, message, resume = true)
        }
        bump(scope)
        return JSONObject().apply {
            put("sent", true)
            put("target", m.name)
            put("status", m.status.wire)
            put("note", "已进收件箱；成功投递不代表对方已处理")
        }
    }

    /** Lead 认领队友消息：返回可直接塞进模型的文本，并写投递回执 */
    fun drainLeadInbox(sessionId: String): List<String> {
        if (sessionId.isBlank()) return emptyList()
        val q = leadInbox[sessionId] ?: return emptyList()
        val scope = scopeFor(sessionId)
        val out = mutableListOf<String>()
        while (true) {
            val msg = q.poll() ?: break
            val id = msg.optString("id")
            // 桌面：同一条消息只投递一次（重复 = 终态拒绝）。回放已投递的直接跳过
            if (id.isNotBlank() && !scope.delivered.add(id)) continue
            out.add("（队友 ${msg.optString("from")} 汇报）${msg.optString("text")}")
            journal.leadDelivered(sessionId, id)
        }
        return out
    }

    private fun seedLeadInbox(sessionId: String, pending: List<JSONObject>, scope: Scope) {
        val q = leadInbox.computeIfAbsent(sessionId) { LinkedBlockingQueue() }
        q.clear()
        pending.forEach { msg ->
            // 回放里已投递过的消息不再进收件箱（桌面 delivered 列表同义）
            val id = msg.optString("id")
            if (id.isBlank() || scope.delivered.add(id)) q.offer(msg)
        }
    }

    @Synchronized
    fun interrupt(target: String): JSONObject {
        // 桌面 roster.ts:189/192 的两刀顺序：先认人（TEAM_LEAD_REQUIRED），再判目标
        // （TEAM_INVALID_TARGET）。roster 里「lead」是真实存在的一行（TeamRoster 的伪成员），
        // 少这一刀就会把 Lead 自己的状态写成 inactive、把它的 Future 掐掉 —— 而界面只会显示
        // 「Lead 中断了」，看不出是谁掐的。
        TeamCall.requireLead("中断队友（interrupt_agent）")
        val scope = currentScope()
        if (target.trim() == "lead") throw TeamError("TEAM_INVALID_TARGET", "Team Lead 不能中断自己；要停的是当前这轮，用停止按钮")
        // 与桌面差一格：桌面在创建前用 AbortSignal 取消（team.spec.ts:447），手机端没有
        // 那条通道 —— 建队请求发出去后唯一能撤的就是这里。所以 provisioning 也允许被中断，
        // 否则端点挂住时这个成员既跑不完也叫不醒。failed 仍然算「没有这个人」。
        val m = scope.roster.get(target.trim())
        if (m == null || m.phase == MemberPhase.FAILED) {
            throw TeamError(
                "TEAM_MEMBER_NOT_FOUND",
                "活跃成员「${target.trim()}」不存在：" +
                    (if (m == null) "roster 里没有这个名字" else "它创建失败（${m.lastError}）") +
                    "（用 list_agents 看当前 roster）",
            )
        }
        val prev = m.status.wire
        m.running = false
        m.endedAt = System.currentTimeMillis()
        m.diagnostic("被 Lead 中断（保留收件箱）")
        // keepInbox：不清 queue，下次唤醒还能收到
        scope.active.remove(m.name)?.cancel(true)
        scope.roster.persist(m)
        journal.activity(scope.sid, "member-interrupted", m.name, "中断当前轮次，收件箱保留")
        bump(scope)
        return JSONObject().put("target", m.name).put("previousStatus", prev).put("status", "inactive")
    }

    /* ---------------- 等待 ---------------- */

    /**
     * 等「下一次团队变化」：成员状态、消息接收、任务更新任一发生即返回。
     * 不等某个具体成员进入终态 —— 那会把 Lead 逼成轮询，也会把
     * 「队友还在跑但任务板变了」这种有效进展漏掉。
     *
     * 卸载时 [shutdown] 会 notifyAll，这里返回 [WaitOutcome.CLOSED]，
     * 而不是让调用方白等到超时（桌面 `activity.close()` 也唤醒全部 waiter）。
     */
    fun waitForChange(
        sinceRevision: Long,
        timeoutMs: Long,
        cancelled: () -> Boolean = { false },
    ): WaitOutcome {
        if (disposed) return WaitOutcome.CLOSED
        val scope = currentScope()
        val deadline = System.currentTimeMillis() + timeoutMs.coerceIn(1_000, 3_600_000)
        synchronized(scope.gate) {
            while (scope.revision <= sinceRevision) {
                if (disposed) return WaitOutcome.CLOSED
                if (cancelled()) return WaitOutcome.CANCELLED
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) return WaitOutcome.TIMEOUT
                // 分片等待：停止按钮/Live 取消信号最多 250ms 内被看见；
                // 同时 Thread.interrupt 仍然能立刻打断 gate.wait。
                try {
                    scope.gate.wait(minOf(left, 250L))
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return WaitOutcome.CANCELLED
                }
            }
            return if (disposed) WaitOutcome.CLOSED else WaitOutcome.CHANGED
        }
    }

    /** 是否还有别的成员在跑或正在创建（没有就立即 noProgress，别让 Lead 白等） */
    fun hasActivePeer(exclude: String): Boolean {
        val scope = currentScope()
        return scope.roster.teammates().any {
            it.name != exclude && (it.running || it.phase == MemberPhase.PROVISIONING)
        }
    }

    /* ---------------- 执行 ---------------- */

    /**
     * 成员线程的一整轮都跑在**它自己的身份**里 —— 从提示词装配那一刻开始。
     *
     * 桌面的 `team:identity` 是 membership 现算的（tool-agent-team/src/index.ts:179-189），
     * 手机端以前只在跑工具之前才 enter：装配那一刻读到的还是 "lead"，于是插件那段
     * 「Lead = 你，只有你能创建/中断」也拼进了队友的系统提示词 ——
     * 它读到的身份说明与它自己的身份正好相反，接着就真的去 spawn（现在由服务层拒绝）。
     */
    private fun runMember(scope: Scope, m: TeamMember, lead: AgentConfig, task: String, resume: Boolean) {
        val prev = TeamCall.enter(m.name, scope.sid)
        try {
            runMemberTurn(scope, m, lead, task, resume)
        } finally {
            TeamCall.exit(prev)
        }
    }

    private fun runMemberTurn(scope: Scope, m: TeamMember, lead: AgentConfig, task: String, resume: Boolean) {
        try {
            scope.roster.activate(m)
        } catch (e: Throwable) {
            // 连「正在跑」都写不进日志：不启动，如实记失败（否则模型会以为它在干活）
            runCatching { scope.roster.fail(m, "启动失败：${e.message ?: e.javaClass.simpleName}") }
            scope.active.remove(m.name)
            bump(scope)
            return
        }
        bump(scope)
        val memberSid = m.sessionId
        val tools = teammateTools(lead.preset, lead.contextWindow)
        val schemas = kernel.schemas().let { all ->
            JSONArray().apply {
                for (i in 0 until all.length()) {
                    val s = all.optJSONObject(i) ?: continue
                    if (s.optString("name") in tools) put(s)
                }
            }
        }
        val defs = LlmClient.toolDefs(schemas)
        // teammate 是主 Agent 的子级：深度 1；容量仍按 Lead 会话计（桌面同口径）
        // 模型 / 端点 / 密钥一起在这里定，别分两处各走一套优先级
        val llm = MemberLlm.resolve(lead, m.model)
        val cfg = lead.copy(
            model = llm.model,
            userText = task,
            sessionId = memberSid,
            delegationDepth = 1,
            rootSessionId = scope.sid,
        )
        val system = buildString {
            append(AgentLoop.system(assembler, cfg, tools, kernel.workspace.rootPath))
            append("\n\n")
            append(identityText(m.name))
        }
        val bodyCtx = assembler.assembleContext(cfg, emptyList(), kernel.workspace.rootPath, subagent = true)

        val messages = mutableListOf<JSONObject>()
        messages.add(JSONObject().put("role", "system").put("content", system))
        if (bodyCtx.isNotBlank()) messages.add(JSONObject().put("role", "user").put("content", bodyCtx))
        // 冷恢复：从成员自己的会话日志重建文本历史（工具过程已折叠成摘要）。
        // spawn 与 send 都已经把这句话严格写进日志了 —— 这里不能再追加一遍，
        // 否则模型会看到两次同一段任务，也分不清哪句是「最新指令」。
        val history = runCatching { journal.memberHistory(memberSid, if (resume) 40 else 8) }
            .getOrNull() ?: mutableListOf()
        history.forEach { messages.add(it) }
        if (history.none { it.optString("role") == "user" && it.optString("content") == task }) {
            messages.add(JSONObject().put("role", "user").put("content", task))
        }

        val client = LlmClient(llm.baseUrl, llm.apiKey, log)
        val effWindow = AgentRequest.effWindow(cfg.contextWindow, defs?.length() ?: 0)
        val contextStart = messages.size
        var lastText = ""
        var reason = "完成本轮"

        try {
            // 不设轮次上限：与主 Agent 的循环一致，模型不再调工具就结束。
            // 桌面也没有 rounds 预算 —— 强行截断只会让成员在活干到一半时停下，
            // 而「停下来」这件事本身用户还得自己发现。
            var round = 0
            while (true) {
                round++
                if (!m.running) { reason = "已被中断"; break }

                // 轮边界认领 inbox（steering）
                val q = scope.inboxes[m.name]
                if (q != null) {
                    val got = mutableListOf<JSONObject>()
                    while (true) got.add(q.poll() ?: break)
                    got.forEach { msg ->
                        val from = msg.optString("from").ifBlank { "lead" }
                        val text = "（$from 补充）${msg.optString("text")}"
                        messages.add(JSONObject().put("role", "user").put("content", text))
                        // 日志不再写第二条：send() 落过一次原文（冷恢复靠它），这里再写一遍
                        // 就是同一条消息在成员会话里出现两行（实测：自己发的一句变两条）。
                    }
                    if (got.isNotEmpty()) {
                        m.lastAction = "认领 ${got.size} 条补充消息"
                        scope.roster.persist(m)
                    }
                }

                m.turns = round
                // 轮数是内核的循环计数，不是「它在干什么」—— 用户点名撤掉界面上的轮数提示，
                // 所以这里只留一个状态词；真的在跑工具时，下面那行会写成「<工具> <目标>」。
                m.lastAction = "思考中"
                scope.roster.persist(m)
                bumpThrottled(scope)

                // 上下文预算与主对话同口径：设置里的窗口先扣掉工具目录（每个 schema 约
                // 110 token），剩下的才是历史可用量；超了就压。
                if (round > 1) {
                    val cr = compactor.compactInTurn(
                        llm = client, model = cfg.model, system = system,
                        messages = messages, keepFrom = contextStart,
                        contextWindow = effWindow, maxOut = lead.maxOut,
                        mode = cfg.compactMode,
                    )
                    if (cr.shrunk) {
                        messages.clear()
                        messages.addAll(cr.messages)
                        log("member ${m.name} 压缩: ${cr.beforeTokens} → ${cr.afterTokens} tokens")
                    }
                }

                // 请求体与子代理共用 AgentRequest.body：预算照设置那一档（原来压到
                // 8192，推理型模型会把预算全花在「想」上、永远没结论）
                val body = AgentRequest.body(cfg.model, messages, lead.maxOut, defs)
                // 成员正文**不开增量事件通道**：桌面推给客户端只有一条 agentTeam 全量投影帧
                // （projection.ts:389 stateVersion:4，agent-team README:201「全量广播、无增量无分页」）。
                // 这里以前另造了一条 team_delta（120ms 合批的小事件）+ 页面按 seq 判连续/重复，
                // 等于同一份正文有两条真相：通道断了、seq 跳了、快照与增量交替写都要各自兜底。
                // 现在只留快照一路（liveText / liveSeq 随快照走，页面轮询日志收口）。
                val result = client.stream(body, onDelta = { chunk ->
                    if (chunk.isNotEmpty()) {
                        m.liveText = (m.liveText + chunk).takeLast(8_000)
                        m.liveSeq += chunk.length
                    }
                }, onReasoning = {})
                m.tokensIn += result.usage.prompt
                // 只记账，不做预算：桌面没有 token 上限，轮次与每轮 max_tokens 已经封顶
                m.tokensOut += result.usage.completion
                // tool_calls wire 提前构建：日志要和 messages 一样存结构化（冷恢复不失忆）
                val wire = AgentLoop.wire(result.toolCalls)
                if (result.text.isNotBlank() || wire.length() > 0) {
                    lastText = result.text.ifBlank { lastText }
                    journal.assistantTurn(
                        memberSid, result.text, result.usage.prompt, result.usage.completion,
                        wire = wire.takeIf { it.length() > 0 },
                    )
                    // 权威全文已落日志：界面从「正在写的半截」切到正式节点
                    m.liveText = ""
                    m.liveSeq = 0
                }
                if (result.toolCalls.isEmpty()) {
                    reason = if (result.text.isBlank()) "模型没有产出内容" else "完成本轮"
                    break
                }
                // 循环骨架在 AgentLoop.execCalls —— 与子代理共用同一份，钩子在这里交出去
                AgentLoop.execCalls(
                    pipeline, result.toolCalls, result.text, messages,
                    // 成员的闸门 = Lead 这一档的闸门，一个字都不放宽（桌面 child-agent 的
                    // 原则：子级范围在派出时就定死，且不能从会话内部抬起来）：
                    //  · permission 合 Mission 收窄 —— 以前直接读 cfg.permission，于是
                    //    「Mission 只读」挡得住 Lead，挡不住它派出去的人。
                    //  · planMode / planApproved 原样透传 —— 以前硬编码 (false, true)，
                    //    Lead 还在计划模式里没被批准，队友就已经在改文件了。
                    //  · confirmDanger 用 cfg.needConfirm —— 后台没有人能点确认，所以
                    //    需要确认的操作由 approve() 拒绝并如实回报；但 Lead 是完全访问时
                    //    不该凭空给队友加一道「问了自动拒」，以前固定 true 就正好把
                    //    完全访问下的危险命令（git push / 删除）全打成了失败。
                    ToolPipeline.Gate(
                        kernel.missions.effectivePermissionFor(cfg.permission, cfg.missionId),
                        cfg.planMode,
                        cfg.planApproved,
                        cfg.needConfirm,
                    ),
                    teammateRuntime(cfg, scope, m),
                    // 成员调本轮目录里没有的工具时，也要拿到「为什么没跑 + 本轮有什么」，
                    // 不再让它收到一句把人往插件清单上带的「未知工具（可能被禁用）」
                    tools.toSet(),
                    memberSid,
                    cancelled = { !m.running },
                    onStart = { c, args ->
                        m.toolCalls++
                        m.lastAction = "${c.name} ${toolMeta(c.name, args)}"
                        scope.roster.persist(m)
                    },
                    // 写范围是**提示**，不是锁（桌面 task-view.ts:44-49 只往任务视图塞一句
                    // warning，validation.ts:22-26 写明 "without treating it as a lock"）：
                    // 重叠信息由 team_task_get / team_task_list 的 warnings 交给 Lead 和成员自己判断，
                    // 运行时不拦写入 —— 拦了会把「两条任务都声明 src/」这种正常排期变成永远写不了。
                    onOutcome = { c, args, outcome ->
                        // 工具痕迹写进成员自己的日志：冷恢复的队友要记得自己做过什么。
                        // 成败**用流水线算好的那份**，不再拿输出文本回头解析：bash / write 的成功输出
                        // 是纯文本（`exit=0 …`、`已写入 …（41 字节）`），`optBoolean("ok")` 只能给 false，
                        // 于是成员视图里每一条成功命令都显示「执行失败」（用户报的「队友调工具老是失败」）。
                        journal.toolExec(memberSid, c.id, c.name, outcome.ok, args, outcome.output)
                        bumpThrottled(scope)
                    },
                )
            }
        } catch (e: Throwable) {
            if (disposed) {
                // 插件卸载导致的取消：不是执行失败，记进结算报告就够了
                disposeFailures.add("${m.name}: ${e.message ?: e.javaClass.simpleName}")
                scope.active.remove(m.name)
                return
            }
            // 被 interrupt 时线程会被中断，socket 读抛 InterruptedIOException 是预期行为，
            // 不能记成「执行失败」—— 否则用户按下中断，面板显示的是红色 FAILED
            if (!m.running) {
                scope.active.remove(m.name)
                runCatching { scope.roster.idle(m, "已被中断") }
                journal.activity(scope.sid, "member-idle", m.name, "已被中断")
                bump(scope)
                return
            }
            reason = "执行失败：${e.message ?: e.javaClass.simpleName}"
            // 建完并 activate 过的一支：只记「这一轮没跑完」，不进终态（桌面禁止
            // active → failed）—— Lead 重发一条消息就能把它叫醒。
            // 从没跑起来的那几支（没建完 / 池没派发 / 连「正在跑」都写不进日志）才真是 failed。
            runCatching {
                if (m.phase == MemberPhase.ACTIVE) scope.roster.error(m, reason)
                else scope.roster.fail(m, reason)
            }
            scope.active.remove(m.name)
            bump(scope)
            return
        }

        scope.active.remove(m.name)
        if (disposed) return
        if (m.running) runCatching { scope.roster.idle(m, reason) }
        journal.activity(scope.sid, "member-idle", m.name, "$reason${if (lastText.isNotBlank()) "：${lastText.take(80)}" else ""}")
        bump(scope)
    }

    /**
     * teammate 的身份段 —— 桌面 `team:identity`（tool-agent-team/src/index.ts:178-189）
     * 的手机端等价物：每次装配现算，写的是**当前真实生效**的上限，不写「默认如何如何」。
     */
    private fun identityText(name: String): String {
        val depth = kernel.subagentLimits.maxDepth
        return """
            |【团队身份】你是 teammate "$name"，Team Lead 叫 "lead"。
            |你们共享同一个工作区，你改的文件 Lead 立刻能看到。
            |- 用 send_message(target, message) 向 lead 或其他队友汇报/提问；消息要自包含。
            |- 用 list_agents 看当前有谁；用 team_task_list / team_task_get / team_task_update 协作。
            |- 开工前先 team_task_list 找到属于你的活 → team_task_get 拿 revision → claim 下来再动手，做完 complete；
            |  不要替别人 complete。ready 只是「没被前置挡住」，它不会自动给你 owner —— 没 claim 之前这条任务
            |  在 Lead 看来仍然没人做。
            |- spawn_teammate / interrupt_agent 在你手里能看见，但调用会被拒绝（TEAM_LEAD_REQUIRED）：
            |  建队与中断是 Lead 的专属操作。也不能向用户提问 —— 需要这些就发给 lead。
            |- 递归深度现在是 $depth：${if (depth <= 1) "只允许 Lead 派成员，你不能再派子代理"
                else "你可以用 subagent 再派一层普通子代理（不能再创建 teammate）"}。
            |- 后台运行，用户看不到你的中间过程：结论要落在最终回复里，文件要写进工作区。
        """.trimMargin()
    }

    /**
     * teammate 可见工具：继承 Lead 档位，但去掉「必须有前台轮次」与「Lead 专属交付」的工具。
     *
     * 桌面把十个团队工具都注册进每一个 agent 作用域，队友看得见 spawn_teammate /
     * interrupt_agent，执行时由服务层按身份拒绝 —— 手机端现在一样（规则落在操作里，
     * 不只落在「有没有 schema」里）。仍不给的只有 wait_agent：桌面的等待是事件循环里的
     * 异步等，手机端是占住线程池一个槽的阻塞等，八个人一起等就把团队冻住了。
     *
     * 与桌面的互斥规则相反的一条：桌面开启团队包后 `subagent`/`subagent_fork` 工具被禁用，
     * 但**底层 Subagent 服务仍然供 teammate 与 workflow 使用** —— 所以这里保留成员的
     * subagent 通道，被禁用的只是 Lead 的全局工具（见主 Agent 的 schema 过滤）。
     */
    private fun teammateTools(preset: String, contextWindow: Int): List<String> {
        val allow = Presets.byId(preset).allow
        val blocked = buildSet {
            addAll(
                listOf(
                    // 桌面把十个团队工具都注册进每一个 agent 作用域，队友当然看得见
                    // spawn_teammate / interrupt_agent —— 拦它的是**服务层的身份判定**
                    // （TEAM_LEAD_REQUIRED），不是 schema。手机端以前直接在目录里摘掉，
                    // 于是「只有 Lead 能建队」这条规则只存在于提示词里：目录一旦放行
                    // （档位、窗口裁剪、插件启停任一改动）就真的能建队。现在两处都在。
                    "wait_agent",
                    "exit_plan_mode", "create_goal", "update_goal", "get_goal",
                    "ralph", "workflow", "run_code",
                    "ask_user_question", "present", "todo_write", "skill",
                    // web_fetch 依赖 Lead 轮次里的取页服务；teammate 用 web_search 就够调研
                    "web_fetch",
                    // 交付与团队通知由 Lead 统一做
                    "notify", "share_file", "speak",
                    // fork 是团队创建 teammate 的模式，不是给成员用的工具
                    "subagent_fork",
                ),
            )
            // 递归深度 >1 时 teammate 才能再派子代理（它自己已经是第 1 层）
            if (kernel.subagentLimits.maxDepth <= 1) add("subagent")
        }
        val base = kernel.registry.tools().map { it.name }.filter { it in allow && it !in blocked }
        // 目录大小跟设置里的「上下文窗口」走（与主对话、子代理同一个口径）：
        // 小窗口下上百个 schema 本身就超窗，成员每一发都被端点 400 掉 ——
        // 团队面板上看着就是「点了没反应」。
        val core = ai.deepseek.harness.mobile.agent.Presets.catalogFor(contextWindow) ?: return base
        val dynamic = kernel.registry.dynamicToolNames()
        // 团队工具不参与窗口裁剪（与 Lead 端 AgentDriver 同一个豁免）：上面那份身份提示词
        // 逐条让成员「用 send_message 汇报」「用 team_task_* 协作」，小窗口下把这些裁掉，
        // 成员手里就只剩干活的本事 —— 每次汇报或认领任务都撞 TOOL_NOT_IN_CATALOG，
        // 团队面板上看起来正是用户报的「队友调用工具老是失败」。
        // 上面 blocked 只摘掉了 wait_agent（它会占住线程池里一个槽，桌面是事件循环里的异步等）；
        // spawn_teammate / interrupt_agent 照桌面一样落到成员手上，由服务层拒绝。
        return base.filter { it in core || it in dynamic || it in ai.deepseek.harness.mobile.agent.Presets.TEAM_TOOLS }
    }

    /* ---------------- teammate 的运行时能力 ---------------- */

    private fun teammateRuntime(cfg: AgentConfig, scope: Scope, member: TeamMember? = null): ToolPipeline.RuntimeTools =
        object : ToolPipeline.RuntimeTools {
            override fun presentPlan(title: String, plan: String): String = notSupported("present_plan")
            override fun markGoal(status: String, summary: String): String = notSupported("update_goal")
            override fun editGoal(objective: String, maxRounds: Int): String = notSupported("update_goal")
            override fun todoWrite(items: JSONArray): String = notSupported("todo_write")
            override fun createGoal(objective: String, maxRounds: Int): String = notSupported("create_goal")
            override fun getGoal(): String = notSupported("get_goal")
            override fun useSkill(name: String): String = notSupported("skill")
            override fun addImage(path: String): String = notSupported("read_image")
            override fun addImageData(dataUrl: String, label: String): String = notSupported("read_image")
            override fun latestUserImage(): JSONObject? = null

            override fun search(queries: List<String>, max: Int, fetchTop: Int, charsPerPage: Int): String {
                if (!cfg.searchOn || cfg.searchUrl.isBlank()) {
                    return """{"ok":false,"code":"SEARCH_NOT_CONFIGURED","error":"未配置联网检索；请不要编造搜索结果"}"""
                }
                // fetchTop（抓正文）成员不支持：web_fetch 在 teammate 侧被禁用，
                // 需要正文时由 lead 抓取后转发。这里仍只返回搜索清单。
                return runCatching { WebSearch.search(cfg.searchUrl, cfg.searchKey, queries.joinToString(" "), max) }
                    .getOrElse { """{"ok":false,"code":"SEARCH_FAILED","error":${JSONObject.quote(it.message ?: "检索失败")}}""" }
            }

            override fun fetchUrl(url: String, maxChars: Int, offset: Int): String =
                """{"ok":false,"code":"TEAM_NO_FETCH","error":"teammate 不支持 web_fetch；需要正文请让 lead 取后转发"}"""

            /**
             * teammate 再派子代理：与主 Agent 共用 [SubagentRunner]。
             * 深度由 cfg.delegationDepth（成员固定 1）推，容量按 Lead 会话计。
             * schema 层已经在 maxDepth<=1 时摘掉了 subagent；走到这里还被拒只可能是
             * 设置在中途被调小 —— 那时如实说明，别假装在跑。
             */
            override fun subagent(task: String, maxRounds: Int): String =
                subagents.run(
                    parentCfg = cfg,
                    task = task,
                    maxRounds = maxRounds,
                    onStep = { step, _, _ ->
                        member?.let { m ->
                            m.lastAction = "子代理 · $step"
                            // 成员的进度落回它自己的团队（多团队下 current 可能已指向别的会话）
                            runCatching { scope.roster.persist(m) }
                        }
                    },
                    runtimeFactory = { c, _, _ -> teammateRuntime(c, scope) },
                    cancelled = { disposed || (member != null && !member.running) },
                )

            override fun subagentAs(agentId: String, task: String, maxRounds: Int): String = notSupported("subagent")

            override fun askUser(question: String, options: JSONArray, detail: String): String =
                """{"ok":false,"code":"TEAM_NO_ASK_USER","error":"后台成员不能直接问用户；用 send_message 把问题发给 lead"}"""

            /**
             * 危险操作审批：后台没有人能点确认。
             * 拒绝并留诊断，让 Lead 在前台决定要不要亲自做 —— 这比「静默执行」安全得多。
             */
            override fun approve(name: String, args: JSONObject, reason: String): Boolean {
                log("teammate approve denied: $name $reason")
                return false
            }

            private fun notSupported(what: String): String =
                """{"ok":false,"code":"TEAM_UNSUPPORTED","error":"teammate 不支持 $what；请交给 lead 或改用文件/任务工具"}"""
        }

    /* ---------------- 视图 ---------------- */

    fun snapshot(): JSONObject = current?.let { viewOf(it) } ?: emptyView()

    /** 还没绑定任何会话时的形状：字段与 viewOf 对齐，界面不用判空 */
    private fun emptyView(): JSONObject = JSONObject().apply {
        put("session", "")
        put("revision", 0)
        put("members", JSONArray())
        put("tasks", JSONArray())
        put("board", JSONObject()
            .put("total", 0).put("pending", 0).put("inProgress", 0).put("completed", 0).put("ready", 0))
        put("limits", limitsJson())
        put("running", 0)
        put("disposed", disposed)
    }

    /** 某一分支团队的视图 —— 只读那一份 scope，绝不看也不用动 `current` */
    private fun viewOf(scope: Scope): JSONObject = synchronized(this) {
        JSONObject().apply {
            put("session", scope.sid)
            put("revision", scope.revision)
            // live 只进界面快照（不进 TeamMember.snapshot：那份会被写进日志/回放）
            put("members", JSONArray(scope.roster.list(scope.lastLead?.model.orEmpty())
                .map { it.snapshot(followModel(scope.lastLead)).put("live", it.liveText).put("liveSeq", it.liveSeq) }))
            put("tasks", scope.board.json())
            put("board", scope.board.boardView())
            put("limits", limitsJson())
            put("running", scope.roster.teammates().count { it.running })
            // 推送计数：合批是否生效用数字说话（回归脚本读它）
            put("stats", JSONObject().put("pushes", pushCount).put("bytes", pushBytes))
            put("disposed", disposed)
            scope.failure?.let { put("failure", it) }
        }
    }

    /**
     * 某个会话看到的团队快照：每个会话一支团队（桌面 TeamId=SessionId），
     * 没建过队的就是空名单 —— 不再需要 TEAM_BUSY，A 的团队在跑也不挡着 B 看自己的。
     */
    fun snapshotFor(sessionId: String): JSONObject = try {
        // 纯读：界面每查一次就 attach 一次的话，`current` 会被拉到 draft/别的会话，
        // 那支还在跑的团队的 roster 就不再是它自己那一份（新建会话后角标串旧团队也是这条链）
        viewOf(scopeFor(sessionId.ifBlank { "draft" }))
    } catch (e: TeamError) {
        if (e.code == "TEAM_NOT_MEMBER") emptyView()
        else throw e
    }

    private fun limitsJson(): JSONObject = JSONObject().apply {
        put("maxConcurrent", limit.maxConcurrent)
        // 面板要显示递归深度：它与并行上限一起构成「电脑端那两个数」
        put("maxDepth", kernel.subagentLimits.maxDepth)
    }

    /** 模型视图的 roster（list_agents 用） */
    fun memberViews(): JSONArray = JSONArray().apply {
        val scope = currentScope()
        val follow = followModel(scope.lastLead)
        scope.roster.list(scope.lastLead?.model.orEmpty()).forEach { put(it.view(follow)) }
    }

    /** 「跟随默认」的成员在名单上显示成哪个模型 —— 和 [MemberLlm.resolve] 同一个来源，不再各写一套 */
    private fun followModel(lead: AgentConfig?): String =
        lead?.let { MemberLlm.resolve(it, "").model }.orEmpty()

    private fun toolMeta(name: String, args: JSONObject): String {
        val path = args.optString("file_path").ifBlank { args.optString("path") }
        if (path.isNotBlank()) return path.take(80)
        val cmd = args.optString("command")
        if (cmd.isNotBlank()) return cmd.take(80)
        val subject = args.optString("subject")
        if (subject.isNotBlank()) return subject.take(60)
        return ""
    }

    private fun checkAdmission(op: String) {
        if (disposed) {
            throw TeamError("TEAM_DISPOSED", "团队插件正在卸载，$op 已拒绝（不会半执行）")
        }
    }

    companion object {
        private val THREAD_SEQ = AtomicInteger(0)

        /** fork 携带的轮次数量（桌面前缀是全部已完成轮次，这里留一个上限免得撑爆上下文） */
        private const val FORK_TURNS = 6
    }
}
