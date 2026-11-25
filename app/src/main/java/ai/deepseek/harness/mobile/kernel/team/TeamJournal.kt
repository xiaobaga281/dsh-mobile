package ai.deepseek.harness.mobile.kernel.team

import ai.deepseek.harness.mobile.agent.SessionStore
import org.json.JSONObject

/**
 * 团队日志 —— 桌面「持久日志，派生状态」的手机端实现。
 *
 * 桌面把 roster 与任务写进 Lead 会话日志，读的时候回放成派生视图；手机端
 * 之前是 `files/kernel/teams/tasks.json` 一个明文快照，三个后果：
 *   · 不随会话走：换一个会话看到的是同一块任务板（串台）
 *   · 不可回放：进程被杀只留最后一版，谁在什么时候把任务改成 completed 查不到
 *   · 并发写整份文件：两个 teammate 同时更新会互相覆盖（revision 挡不住丢写）
 *
 * 现在一律 append：
 *   `team/member` 成员完整快照（名字首次出现即占位，失败也留档）
 *   `team/task`   任务完整快照（含 tombstone，deleted 不删记录）
 *   `team/message` / `team/message-delivered`  teammate → Lead 的收件箱
 *   `team/activity` 活动流（只给界面，不进模型历史）
 *
 * **提交语义**（对齐桌面 `appendAndFlush`）：状态类事件写不进去就抛
 * [TeamError] `TEAM_JOURNAL_FAILED`，绝不让工具回一个 ok 却在重启后消失。
 * 进度类事件（每轮 lastAction、活动流）是尽力而为：写失败只丢这一条，
 * 否则一次磁盘抖动会把正在跑的成员整条掐死。
 *
 * teammate 的对话写进它自己的会话 id（`<leadSid>#<name>`），因此冷恢复时
 * 用 [SessionStore.deriveMessages] 就能拿回上下文，不需要在内存里留任何东西。
 */
class TeamJournal(private val sessions: SessionStore) {
    private companion object {
        /** 与桌面 team 事件当前版本同一个数（types.ts 的 `version: z.literal(2)`） */
        const val TEAM_EVENT_VERSION = 2
    }

    /**
     * 团队事件的格式版本 —— 桌面每条事件都带 `{version: 2, teamId, …}`，
     * 回放在 `projection.ts:231` 遇到不认识的 version 直接判 failure。
     *
     * 手机端以前什么都没带：字段将来一改（比如把 snapshot 拆细），旧日志与新日志
     * 混在同一份文件里，回放只能靠「读不到字段就给默认值」硬猜 —— 猜错就是
     * 一个自相矛盾的团队，而且没人知道。现在写侧一律带上；
     * 读侧把**没有 version** 的行当成本场改版之前的旧日志（真机上已经有这些文件），
     * 只拒绝「明确写了但不认识」的版本。
     */
    private fun JSONObject.withTeamVersion(): JSONObject = put("version", TEAM_EVENT_VERSION)

    /* ---------------- 写 ---------------- */

    /** 成员状态（严格）：reserve/activate/idle/fail 用它 */
    fun member(leadSid: String, m: TeamMember) = commit("成员 ${m.name}") {
        sessions.appendOrThrow(leadSid, "team/member", m.snapshot().withTeamVersion())
    }

    /**
     * 成员进度（尽力而为）：每轮的 turns/tokens/lastAction —— 高频，丢了不影响状态机。
     *
     * 只带这几个数，**不写整份成员快照**：以前每步 append 一份 `team/member`，一场几十步的
     * 任务能把 Lead 会话日志灌进几十份近似的 500B 对象（桌面只在事务边界写 team/member，
     * 进度走别的通道）。日志变胖的代价是实打实的：打开团队面板要整份回放。
     * 类型也分开，免得进度被当成状态迁移参与不变量校验。
     */
    fun memberProgress(leadSid: String, m: TeamMember) {
        runCatching {
            sessions.appendOrThrow(
                leadSid, "team/progress", JSONObject()
                    .put("version", TEAM_EVENT_VERSION)
                    .put("target", m.name)
                    .put("turns", m.turns)
                    .put("toolCalls", m.toolCalls)
                    .put("tokensIn", m.tokensIn)
                    .put("tokensOut", m.tokensOut)
                    .put("lastAction", m.lastAction.take(120)),
            )
        }
    }

    fun task(leadSid: String, t: TeamTask) = commit("任务 ${t.id}") {
        sessions.appendOrThrow(leadSid, "team/task", t.toJson().withTeamVersion())
    }

    fun activity(leadSid: String, kind: String, target: String, text: String) {
        sessions.append(leadSid, "team/activity", JSONObject().apply {
            put("version", TEAM_EVENT_VERSION)
            put("kind", kind)
            put("target", target)
            put("text", text.take(400))
        })
    }

    /**
     * teammate 的对话轮：写进它自己的 session，供冷恢复与「查看某个成员干了什么」。
     *
     * [strict] 用于 spawn 的初始任务：桌面在返回创建成功之前会 `checkpointInitialPrompt`
     * 确认首条 prompt 已在子会话里持久接受；手机端等价于「写不进去就不算创建成功」。
     */
    fun userTurn(memberSid: String, text: String, from: String = "lead", strict: Boolean = false) {
        val payload = JSONObject().apply {
            put("text", text)
            put("from", from)
        }
        if (strict) {
            commit("成员初始任务") { sessions.appendOrThrow(memberSid, "user/message", payload) }
        } else {
            runCatching { sessions.appendOrThrow(memberSid, "user/message", payload) }
        }
    }

    /**
     * 成员的 assistant 轮：文本 + （有工具调用时的）tool_calls wire 一起落日志。
     *
     * 此前只记文本——冷恢复的队友看不到自己上轮调了什么工具、用了什么参数，
     * 对话结构也无效（工具结果被 memberHistory 伪装成 user 消息）。
     * wire 与主会话日志同构：[{id,type,function:{name,arguments}}]。
     */
    fun assistantTurn(
        memberSid: String,
        text: String,
        tokensIn: Int = 0,
        tokensOut: Int = 0,
        wire: org.json.JSONArray? = null,
    ) {
        runCatching {
            sessions.appendOrThrow(memberSid, "assistant/message", JSONObject().apply {
                put("text", text)
                if (wire != null && wire.length() > 0) put("tool_calls", wire)
                if (tokensIn > 0) put("promptTokens", tokensIn)
                if (tokensOut > 0) put("completionTokens", tokensOut)
            })
        }
    }

    /** teammate → Lead 的消息：落进 Lead 日志，Lead 下一轮或 wait_agent 认领 */
    fun leadMessage(leadSid: String, id: String, from: String, text: String) = commit("发给 Lead 的消息") {
        sessions.appendOrThrow(leadSid, "team/message", JSONObject().apply {
            put("version", TEAM_EVENT_VERSION)
            put("id", id)
            put("from", from)
            put("text", text.take(8_000))
        })
    }

    /** 认领回执：尽力而为 —— 丢了最多重复投递一次，不会丢消息 */
    fun leadDelivered(leadSid: String, id: String) {
        runCatching {
            sessions.appendOrThrow(leadSid, "team/message-delivered", JSONObject().put("version", TEAM_EVENT_VERSION).put("id", id))
        }
    }

    /* ---------------- 读 ---------------- */

    class Replay(
        val members: LinkedHashMap<String, TeamMember>,
        val tasks: LinkedHashMap<String, TeamTask>,
        val activities: List<JSONObject>,
        /** 还没被 Lead 认领的队友消息 */
        val pendingMessages: List<JSONObject> = emptyList(),
        /**
         * 第一条被拒绝的持久记录。桌面 `projection.ts` 把校验失败设为**终态**：
         * 状态冻结在最后合法值，后续事件一律不再应用，并把失败暴露给界面。
         * 手机端之前是「坏行静默跳过」—— 日志被截断或写坏时，用户看到的是一个
         * 自相矛盾的团队（两个同名成员、revision 跳号），却没有任何提示。
         */
        val failure: String? = null,
        /** 已成功投递过的消息 id：运行时据此防重复投递（桌面 delivered 列表） */
        val deliveredIds: Set<String> = emptySet(),
    )

    /**
     * 回放一名 Lead 的团队状态。
     *
     * 成员按名字覆盖：最后一条快照即当前状态。任务同理，**包括 deleted** ——
     * tombstone 必须留在表里，否则 id 会被下一次 create 复用，历史引用就指错了。
     *
     * 注意：这里**不再**把 running/provisioning 一律收敛成 inactive。
     * 那条规则会让「创建到一半进程被杀」的成员看起来只是「空闲」，掩盖了真实失败。
     * 收敛与对账交给 [TeamRoster.reconcile]：它会去看成员自己的会话里有没有首条任务。
     */
    fun replay(leadSid: String): Replay {
        val members = LinkedHashMap<String, TeamMember>()
        val tasks = LinkedHashMap<String, TeamTask>()
        val acts = mutableListOf<JSONObject>()
        val pending = LinkedHashMap<String, JSONObject>()
        // 回放期不变量（对齐桌面 projection.ts 的 applyCurrentTeamEvent）
        val memberSession = HashMap<String, String>()   // 名字 → 会话身份
        val memberPhase = HashMap<String, String>()     // 名字 → 上一个 phase
        val memberIdentity = HashMap<String, String>()  // 名字 → provider|context（不可变身份）
        val taskRevision = HashMap<String, Int>()        // 任务 id → 上一个 revision
        val deliveredIds = HashSet<String>()            // 已投递的消息 id（重复投递 = 终态拒绝）
        var failure: String? = null
        for (ev in sessions.read(leadSid)) {
            if (failure != null) break
            // 版本闸门（桌面 projection.ts:231「unsupported Agent Teams event version」）：
            // 明确写了 version 但不是这一版认得的数 → 终态拒绝，状态冻在最后一条合法记录上。
            // 没有 version 字段的行是本机带上这个字段之前的旧日志，照旧按当前语义读，
            // 不然一次升级就把所有现役团队判成「记录无效」。
            val evType = ev.optString("type")
            if (evType.startsWith("team/") && ev.has("version") && ev.optInt("version") != TEAM_EVENT_VERSION) {
                failure = "团队事件「$evType」的 version 是 ${ev.optInt("version")}，当前只认 $TEAM_EVENT_VERSION；" +
                    "下面的成员与任务停在最后一条合法记录上"
                break
            }
            when (ev.optString("type")) {
                "team/member" -> {
                    val name = ev.optString("target")
                    if (name.isBlank()) continue
                    // phase：新日志直接读；rc.96 的旧日志只有 status —— 运行活动与
                    // 持久生命周期当时混在一个字段里，按当时的语义映射成 phase。
                    val phase = ev.optString("phase").ifBlank {
                        when (ev.optString("status")) {
                            MemberStatus.PROVISIONING.wire -> MemberPhase.PROVISIONING.wire
                            MemberStatus.FAILED.wire -> MemberPhase.FAILED.wire
                            // running/inactive 都说明成员创建成功过
                            else -> MemberPhase.ACTIVE.wire
                        }
                    }
                    val sid = ev.optString("session")
                    val provider = ev.optString("provider", "in-process")
                    val context = ev.optString("context", "fresh")
                    val priorSid = memberSession[name]
                    if (priorSid == null) {
                        // 桌面：成员必须以 provisioning 开始（roster.ts 与 projection.ts 同规则）
                        if (phase != MemberPhase.PROVISIONING.wire) {
                            failure = "成员「$name」的第一条记录不是 provisioning（是 $phase）"
                            break
                        }
                    } else {
                        if (sid != priorSid) {
                            failure = "成员「$name」换了会话身份（$priorSid → $sid）"
                            break
                        }
                        // 桌面 projection.ts:261：name/provider/context 三样身份不可变
                        if (memberIdentity[name] != "$provider|$context") {
                            failure = "成员「$name」改了不可变的身份字段（provider/context）"
                            break
                        }
                        if (phase == MemberPhase.PROVISIONING.wire) {
                            failure = "成员「$name」在创建完成后又退回 provisioning"
                            break
                        }
                        // 桌面 projection.ts:264：只允许 provisioning → active/failed
                        if (memberPhase[name] == MemberPhase.PROVISIONING.wire &&
                            phase != MemberPhase.ACTIVE.wire && phase != MemberPhase.FAILED.wire
                        ) {
                            failure = "成员「$name」的 ${memberPhase[name]} → $phase 不是合法迁移"
                            break
                        }
                        if (memberPhase[name] == MemberPhase.FAILED.wire && phase != MemberPhase.FAILED.wire) {
                            failure = "成员「$name」已经失败，却又被打回 $phase"
                            break
                        }
                    }
                    memberSession[name] = sid
                    memberPhase[name] = phase
                    memberIdentity[name] = "$provider|$context"
                    val m = TeamMember(
                        name = name,
                        role = if (ev.optString("role") == "lead") MemberRole.LEAD else MemberRole.TEAMMATE,
                        description = ev.optString("description"),
                        context = context,
                        model = ev.optString("model"),
                        provider = provider,
                        sessionId = ev.optString("session"),
                        createdAt = ev.optLong("createdAt", System.currentTimeMillis()),
                    )
                    m.phase = MemberPhase.values().firstOrNull { it.wire == phase }
                        ?: MemberPhase.ACTIVE
                    m.lastError = ev.optString("error")
                    m.turns = ev.optInt("turns")
                    m.toolCalls = ev.optInt("toolCalls")
                    m.tokensIn = ev.optInt("tokensIn")
                    m.tokensOut = ev.optInt("tokensOut")
                    m.lastAction = ev.optString("lastAction")
                    m.startedAt = ev.optLong("startedAt")
                    m.endedAt = ev.optLong("endedAt")
                    ev.optJSONArray("diagnostics")?.let { a ->
                        for (i in 0 until a.length()) a.optString(i).takeIf { it.isNotBlank() }?.let { m.diagnostics.add(it) }
                    }
                    members[name] = m
                }
                "team/task" -> {
                    val id = ev.optString("id")
                    if (id.isBlank()) continue
                    val rev = ev.optInt("revision", 1)
                    val prior = taskRevision[id]
                    if (prior == null) {
                        if (rev != 1) {
                            failure = "任务「$id」的第一条记录 revision 是 $rev（应为 1）"
                            break
                        }
                    } else if (rev != prior + 1) {
                        failure = "任务「$id」的 revision 从 $prior 跳到 $rev（必须逐一递增）"
                        break
                    }
                    taskRevision[id] = rev
                    tasks[id] = TeamTask.from(ev)
                }
                "team/message" -> {
                    val id = ev.optString("id")
                    if (id.isBlank()) continue
                    // 桌面 projection.ts:294：同一条消息入队两次 = 终态拒绝
                    if (pending.containsKey(id)) {
                        failure = "消息「$id」被入队了两次"
                        break
                    }
                    pending[id] = ev
                }
                "team/message-delivered" -> {
                    val id = ev.optString("id")
                    // 桌面 projection.ts:299-303：先入队才能投递；同一条只投一次。
                    // 注意顺序：先查已投递集合，否则第二次投递会被「pending 已移除」
                    // 误报成「未入队」，桌面那条 delivered twice 的终态错误就永远不会出现。
                    if (id in deliveredIds) {
                        failure = "消息「$id」被投递了两次"
                        break
                    }
                    if (!pending.containsKey(id)) {
                        failure = "消息「$id」还没入队就被投递了"
                        break
                    }
                    deliveredIds.add(id)
                    pending.remove(id)
                }
                "team/progress" -> {
                    val name = ev.optString("target")
                    val m = members[name]
                    if (m == null) {
                        // 进度只能跟在成员记录之后：reserve 是严格写，写不进日志就不会开跑。
                        // 走到这里说明日志被截断或被人手改过 —— 如实报，别假装回放成功
                        failure = "成员「$name」的进度先于它的记录出现"
                        break
                    }
                    m.turns = ev.optInt("turns", m.turns)
                    m.toolCalls = ev.optInt("toolCalls", m.toolCalls)
                    m.tokensIn = ev.optInt("tokensIn", m.tokensIn)
                    m.tokensOut = ev.optInt("tokensOut", m.tokensOut)
                    m.lastAction = ev.optString("lastAction", m.lastAction)
                }
                "team/activity" -> acts.add(ev)
            }
        }
        return Replay(members, tasks, acts.takeLast(80), pending.values.toList(), failure, deliveredIds)
    }

    /**
     * 成员自己的会话里有没有「首条任务」。
     *
     * 这是桌面 `reconcileProvisioning` 里 `acceptedInitialPrompt` 的手机端等价物 ——
     * 它只是 [provisioningIsResumable] 那组对账判据里的一道，别单独拿来判定能不能恢复。
     */
    fun memberHasPrompt(memberSid: String): Boolean {
        if (memberSid.isBlank()) return false
        return sessions.read(memberSid).any { it.optString("type") == "user/message" }
    }

    /**
     * 重启后能不能把一个还停在 provisioning 的成员认成 active —— 对账判据取自桌面
     * `reconcileProvisioning`（roster.ts:384-396），一条不过就判 failed：
     *
     *   1. 子会话确实挂在这支 Lead 下面（桌面 `header.parentSession === root.id`；
     *      手机端没有 header，成员会话 id 就是 `<leadSid>#<name>`，对不上就是别人家的/被改坏的记录）
     *   2. 运行方式仍是本进程可恢复的那一种（桌面 `descriptor.provider === member.provider`；
     *      手机端 provider 恒为 in-process，但日志是能手改的，写了别的 provider 就不该假装接得上。
     *      桌面的 `descriptor.mode === 'continuable'` 这一查在手机端没有对应物 —— 这里没有
     *      第二种运行方式，所以也没有「模式写错」这种错）
     *   3. 首条任务已经在子会话里被持久接受（桌面 `acceptedInitialPrompt`）
     *
     * 只查第 3 条的后果：一条 sessionId 指错、provider 写着外部后端的记录也会被认成 active，
     * Lead 之后每一次 send_message 都唤醒不了它，界面却一直显示「未运行」。
     * 判定失败时把**是哪一条**写进 lastError，人才有可能修。
     */
    fun provisioningIsResumable(leadSid: String, m: TeamMember): Pair<Boolean, String?> = when {
        m.sessionId.isBlank() -> false to "成员没有会话 id，接不回它的历史"
        m.sessionId != "$leadSid#${m.name}" ->
            false to "子会话「${m.sessionId}」不挂在这支团队（$leadSid）下面"
        m.provider != "in-process" ->
            false to "运行方式是「${m.provider}」，本进程接不回来（手机端只有 in-process）"
        !memberHasPrompt(m.sessionId) -> false to "成员会话里没有首条任务：进程死在初始化阶段"
        else -> true to null
    }

    /**
     * 成员的工具执行痕迹（结构化）：id/参数/输出全量落日志。
     *
     * 此前只写 name + 400 字符 meta 摘要——冷恢复的队友不知道自己用过什么参数、
     * 看不到真实输出。现在 memberHistory 能重建出合法的 role=tool 消息
     * （tool_call_id 与 assistant 轮的 wire 配对）。output 截 2000 字
     * （对齐「工具结果面向模型」的输出约定；主会话日志存原文，这里为队友上下文预算收紧）。
     */
    fun toolExec(memberSid: String, id: String, name: String, ok: Boolean, args: JSONObject, output: String) {
        runCatching {
            sessions.appendOrThrow(memberSid, "tool/result", JSONObject().apply {
                put("id", id)
                put("name", name)
                put("ok", ok)
                put("args", args.toString().take(4_000))
                put("output", output.take(2_000))
            })
        }
    }

    /**
     * 成员对话历史（冷恢复用）：**结构化消息**——assistant 轮带 tool_calls、
     * 工具结果是 role=tool（tool_call_id 配对），与主会话请求的 messages 同构。
     *
     * 不用 [SessionStore.deriveMessages]：它对工具结果只留一行内部 note 然后丢掉。
     * 旧格式日志（tool/result 无 id、assistant/message 无 wire）保持文本近似兼容，
     * 新日志一律结构化。
     */
    fun memberHistory(memberSid: String, limit: Int = 60): MutableList<JSONObject> {
        val out = mutableListOf<JSONObject>()
        for (ev in sessions.read(memberSid)) {
            when (ev.optString("type")) {
                "user/message" -> out.add(JSONObject().put("role", "user").put("content", ev.optString("text")))
                "assistant/message" -> {
                    val msg = JSONObject().put("role", "assistant")
                    val text = ev.optString("text")
                    msg.put("content", if (text.isEmpty()) JSONObject.NULL else text)
                    val wire = ev.optJSONArray("tool_calls")
                    if (wire != null && wire.length() > 0) msg.put("tool_calls", wire)
                    out.add(msg)
                }
                "tool/result" -> {
                    val id = ev.optString("id")
                    if (id.isNotBlank()) {
                        // 结构化：role=tool，与 assistant 轮的 tool_call_id 配对
                        out.add(JSONObject().put("role", "tool")
                            .put("tool_call_id", id)
                            .put("content", ev.optString("output").ifBlank { "（无输出）" }))
                    } else {
                        // 旧格式（只有 meta 摘要）：保持文本近似
                        val n = ev.optString("name")
                        if (n.isNotBlank()) {
                            out.add(JSONObject().put("role", "user").put("content",
                                "（工具 $n ${if (ev.optBoolean("ok")) "成功" else "失败"}）${ev.optString("text").take(300)}"))
                        }
                    }
                }
            }
        }
        return if (out.size <= limit) out else out.takeLast(limit).toMutableList()
    }

    /** 把写入失败统一翻译成带错误码的团队异常（工具层原样回报给模型） */
    private inline fun <T> commit(what: String, block: () -> T): T = try {
        block()
    } catch (e: Throwable) {
        throw TeamError(
            "TEAM_JOURNAL_FAILED",
            "$what 没写进日志，状态未提交：${e.message ?: e.javaClass.simpleName}",
        )
    }
}
