package ai.deepseek.harness.mobile.kernel.team

import org.json.JSONObject

/**
 * 成员名册 —— 桌面 `roster.ts` 的手机端等价物。
 *
 * 只做三件事，但每件都必须严：
 *   1. **名字即身份**：小写 kebab（`^[a-z0-9]+(-[a-z0-9]+)*$`）、≤64 字符、不能叫 lead。
 *      首次创建即占位，创建失败也占着（桌面同样永不复用），否则历史任务/消息会指向另一个人。
 *   2. **状态机**：持久生命周期只有 provisioning → active，以及 → failed（桌面 phase）。
 *      「在不在跑」是运行时派生的 status，不落状态机。
 *      不存在 done —— 完成是任务的状态，不是人的状态。
 *   3. **上限**：含失败成员一起算（桌面 maxMembers=16），
 *      否则反复失败 spawn 会把内存和日志撑爆。
 */
class TeamRoster(
    private val journal: TeamJournal,
    private val capacity: TeamCapacity,
) {

    private val members = LinkedHashMap<String, TeamMember>()
    private var leadSid: String = ""

    /**
     * Lead 的运行统计（仅内存，不落日志）。
     *
     * 为什么不落：回放不变量要求成员的首条日志必须是 provisioning，而 lead 是虚拟成员、
     * 从来没有 provisioning 这条边 —— 给它写 member 事件会让 replay 判 failure。
     * 桌面同样把 lead 的进度算成运行时投影，不写 roster 事件。
     * 代价：进程重启后归零（Lead 的真实历史在会话线程里，面板只是速览）。
     */
    private var leadTurns = 0
    private var leadToolCalls = 0
    private var leadLastAction = ""

    @Synchronized
    fun load(sessionId: String) = load(sessionId, journal.replay(sessionId))

    /**
     * 用一次已经回放好的日志装载名册。
     *
     * 运行时同时要装 roster 与任务板，两个都各自 replay 会把同一个 jsonl 读两遍；
     * 更重要的是两次读之间可能夹进写入，导致成员与任务看到的时间点不一致。
     */
    @Synchronized
    fun load(sessionId: String, replay: TeamJournal.Replay) {
        leadSid = sessionId
        members.clear()
        replay.members.forEach { (name, m) -> members[name] = m }
        reconcileLocked()
    }

    /**
     * 重启对账 —— 桌面 `reconcileProvisioning` 的手机端等价物。
     *
     * 为什么不能「一律收敛成 inactive」：那会把**创建失败**伪装成**空闲**。
     * 桌面的判据是去读子会话：parent 对、descriptor 是 continuable、provider 一致、
     * 首条 prompt 已被持久接受，四条全满足才算 active，否则 failed。
     * 手机端的成员会话就是 `<leadSid>#<name>` 这个 jsonl，四道判据逐条对应过去
     * （见 TeamJournal.provisioningIsResumable）：会话 id 在、就挂在这支团队下面、
     * provider 是本进程接得回来的那一种、里面确实留下了那条初始任务。
     * 四条全过 = 创建其实成功了（转 active，重启后 inactive、可被唤醒）；少任何一条 = failed。
     */
    @Synchronized
    fun reconcile(): JSONObject {
        reconcileLocked()
        return JSONObject().apply {
            put("running", members.values.count { it.running })
            put("provisioning", members.values.count { it.phase == MemberPhase.PROVISIONING })
            put("failed", members.values.count { it.phase == MemberPhase.FAILED })
        }
    }

    private fun reconcileLocked() {
        if (leadSid.isBlank()) return
        for (m in members.values) {
            when (m.phase) {
                MemberPhase.ACTIVE -> {
                    // 进程重启：上次执行不可能还在跑，运行活动归零（可被 send_message 唤醒）。
                    // phase 不动 —— active 是持久事实，重启不改写它。
                    m.running = false
                    if (m.endedAt == 0L) m.endedAt = System.currentTimeMillis()
                    m.diagnostic("进程重启：上次执行未完成，已转为 inactive（可 send_message 唤醒）")
                    runCatching { journal.member(leadSid, m) }
                }
                MemberPhase.PROVISIONING -> {
                    // 桌面 reconcileProvisioning 逐条查 parentSession / provider / 首条 prompt
                    // （手机端没有「mode」那一查），少任何一道都会把接不回来的记录认成 active：
                    // 之后每次 send_message 都唤不醒它，界面却常年显示「未运行」
                    val (resumable, why) = journal.provisioningIsResumable(leadSid, m)
                    if (resumable) {
                        // 创建其实成功了，只是 active 那条边没来得及写：补成 active，
                        // 而不是把活人判死（桌面：creator 说失败但子会话真的活了 → active）
                        m.phase = MemberPhase.ACTIVE
                        m.running = false
                        m.diagnostic("创建已完成（对账通过），进程重启后转为 inactive")
                    } else {
                        m.phase = MemberPhase.FAILED
                        m.running = false
                        m.lastError = "对账判定创建失败：$why"
                        m.diagnostic("对账判定创建失败：$why")
                    }
                    runCatching { journal.member(leadSid, m) }
                }
                else -> {}
            }
        }
    }

    /* ---------------- 查询 ---------------- */

    @Synchronized
    fun get(name: String): TeamMember? = members[name]

    @Synchronized
    fun teammates(): List<TeamMember> = members.values.toList()

    @Synchronized
    fun lead(model: String = ""): TeamMember = TeamMember(
        name = "lead",
        role = MemberRole.LEAD,
        description = "团队负责人：拆任务、派活、验收",
        context = "fresh",
        model = model,
        provider = "in-process",
        sessionId = leadSid,
    ).apply {
        phase = MemberPhase.ACTIVE
        running = true
        startedAt = System.currentTimeMillis()
        turns = leadTurns
        toolCalls = leadToolCalls
        if (leadLastAction.isNotBlank()) lastAction = leadLastAction
    }

    @Synchronized
    fun list(model: String = ""): List<TeamMember> = listOf(lead(model)) + teammates()

    @Synchronized
    fun maxMembers(): Int = capacity.maxMembers

    fun counts(): Map<String, Int> = members.values.groupingBy { it.status.wire }.eachCount()

    /* ---------------- 创建 ---------------- */

    @Synchronized
    fun validateName(raw: String): String {
        val name = raw.trim()
        if (name.isBlank()) throw TeamError("TEAM_INVALID_MEMBER_NAME", "name 不能为空")
        if (name == "lead") throw TeamError("TEAM_INVALID_MEMBER_NAME", "lead 是保留名字")
        // 与桌面 memberName() 同一条正则：不允许连续连字符、不允许结尾连字符
        if (name.length > 64 || !Regex("^[a-z0-9]+(?:-[a-z0-9]+)*$").matches(name)) {
            throw TeamError(
                "TEAM_INVALID_MEMBER_NAME",
                "name 只能是小写 kebab-case（a-z 0-9，单连字符分隔），≤64 字符：$name",
            )
        }
        if (members.containsKey(name)) {
            throw TeamError("TEAM_MEMBER_NAME_TAKEN", "名字 $name 已被占用（创建失败的成员也保留名字，永不复用）")
        }
        val cap = capacity.maxMembers
        if (members.size >= cap) {
            throw TeamError("TEAM_MEMBER_LIMIT", "团队成员已达上限 $cap（含失败的成员）")
        }
        return name
    }

    /**
     * 预占名字并进入 provisioning；真正启动成功后调用 [activate]。
     *
     * 顺序是「先落日志、再进内存」：写失败就抛 TEAM_JOURNAL_FAILED，名字不占、内存不改。
     * 反过来会得到一个只存在于本进程的幽灵成员 —— 重启后名单少一个人，任务却还指着它。
     */
    @Synchronized
    fun reserve(
        name: String,
        description: String,
        context: String,
        model: String,
        provider: String,
        memberSid: String,
    ): TeamMember {
        validateName(name)
        val m = TeamMember(
            name = name,
            role = MemberRole.TEAMMATE,
            description = description,
            context = context,
            model = model,
            provider = provider,
            sessionId = memberSid,
        )
        m.phase = MemberPhase.PROVISIONING
        m.running = false
        journal.member(leadSid, m)
        members[name] = m
        journal.activity(leadSid, "member-provisioning", name, "${m.description}（${m.context}/${m.model.ifBlank { "默认模型" }}）")
        return m
    }

    @Synchronized
    fun activate(m: TeamMember) {
        // 只允许 provisioning → active 这一次持久迁移；之后的 activate（唤醒）只翻运行位
        if (m.phase == MemberPhase.PROVISIONING) m.phase = MemberPhase.ACTIVE
        m.running = true
        m.startedAt = System.currentTimeMillis()
        m.lastError = ""
        journal.member(leadSid, m)
        journal.activity(leadSid, "member-running", m.name, "开始执行")
    }

    @Synchronized
    fun idle(m: TeamMember, note: String = "") {
        // phase 不动：本轮结束只是运行活动停止，成员仍是 active（可被唤醒）
        m.running = false
        m.endedAt = System.currentTimeMillis()
        if (note.isNotBlank()) m.lastAction = note
        journal.member(leadSid, m)
        journal.activity(leadSid, "member-idle", m.name, note.ifBlank { "本轮结束，可被消息唤醒" })
    }

    /**
     * 把「没建完」定成终态 failed。
     *
     * 桌面的 `settleProvisioning`（roster.ts:447-465）只允许 provisioning → active|failed 这一条
     * 单向迁移；如果创建者报错时这个人其实已经被人唤醒成 active 了，桌面不写终态，
     * 而是抛 `TEAM_PROVISIONING_CONFLICT`（roster.ts:283-291）让调用方知道「别按失败处理」。
     * 手机端以前直接就地写 failed —— 那等于用一次创建失败把一个已经活着的人打死：
     * 它正在跑的那一轮还会写日志，名册里却已是 failed，之后 send_message 撞
     * TEAM_MEMBER_NOT_FOUND，历史接不回来。
     *
     * @return true 确实落成 failed；false 表示这人已经 active，改记「这一轮没跑完」
     *         并由调用方按冲突处理（不抛就吞成无事，抛就丢掉已经活着的成员）。
     */
    @Synchronized
    fun fail(m: TeamMember, error: String): Boolean {
        if (m.phase == MemberPhase.ACTIVE) {
            // 已经是持久事实了，别为了记一个失败去发明 active → failed 这条不可能的迁移
            error(m, error)
            return false
        }
        m.phase = MemberPhase.FAILED
        m.running = false
        m.lastError = error.take(400)
        m.endedAt = System.currentTimeMillis()
        journal.member(leadSid, m)
        journal.activity(leadSid, "member-failed", m.name, m.lastError)
        return true
    }

    /**
     * 运行期出错 —— 成员**不**进终态。
     *
     * 桌面的 `failed` 只可能是「没建完」：projection.ts:264 只承认
     * provisioning → active/failed 这一条迁移，roster.ts:301-305 更明确写了
     * 「已经接住首条 prompt 的成员就是真孩子，不要为了记一个失败而发明
     * active → failed 这种不可能的迁移」，运行期问题走 diagnostics / 回合结果。
     *
     * 手机端以前把任何异常都记成 FAILED，后果是：一次端点 400、一次读超时就把队友
     * 永久打死 —— 之后 Lead 再发消息就撞 TEAM_MEMBER_NOT_FOUND，团队少一个人、
     * 它的历史也接不上，只能重新 spawn。现在只记「这一轮没跑完」，Lead 重发一条就唤醒。
     */
    @Synchronized
    fun error(m: TeamMember, error: String) {
        m.running = false
        m.endedAt = System.currentTimeMillis()
        m.lastError = error.take(400)
        journal.member(leadSid, m)
        journal.activity(leadSid, "member-error", m.name, m.lastError)
    }

    /**
     * 把统计与当前动作写进快照（节流由调用方负责）。
     * 这是进度类写入：磁盘抖一下不该把正在跑的成员掐死，所以走尽力而为。
     */
    @Synchronized
    fun persist(m: TeamMember) {
        journal.memberProgress(leadSid, m)
    }

    @Synchronized
    fun activity(kind: String, target: String, text: String) {
        journal.activity(leadSid, kind, target, text)
    }

    /* ---------------- Lead 统计（内存态，见 leadTurns 注释） ---------------- */

    /** Lead 的一个 step：由 agent/pre-step 钩子驱动（每个 LLM 往返一次） */
    @Synchronized
    fun noteLeadStep(action: String = "") {
        leadTurns++
        if (action.isNotBlank()) leadLastAction = action
    }

    /** Lead 的一次工具调用：由 agent/tool 串行钩子驱动 */
    @Synchronized
    fun noteLeadTool(name: String) {
        leadToolCalls++
        if (name.isNotBlank()) leadLastAction = name
    }
}
