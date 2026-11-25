package ai.deepseek.harness.mobile.kernel.team

import org.json.JSONArray
import org.json.JSONObject

/**
 * 共享任务板 —— 桌面 `task-board.ts` + `task-view.ts` 的手机端等价物。
 *
 * 关键语义（逐条对齐，不是"差不多"）：
 *   · 每次变更都是 compare-and-set：带 `expectedRevision`，过期就拒绝，不覆盖别人的成果。
 *   · `ready` 是派生值，有两个口径，别混（真机踩过：混了之后进行中的任务永远改派不动）：
 *     [unblockedOf] = 所有 blockedBy 已 completed（桌面的 taskReady，reassign 用它）；
 *     [readyOf] = 还没人认领 **且** unblockedOf（界面/统计的「现在能领几条」）。
 *     「被挡住」不存成状态，否则前置任务 reopen 后永远解不开。
 *   · 依赖必须存在、不能成环；删除任务时从别人的依赖里摘掉，避免死锁。
 *   · 删除是 tombstone：id 永久保留，不复用（历史任务引用不会指错人）。
 *   · writeScopes 规范化后做重叠提示 —— 与桌面一致，**只是提示**（task-view.ts:44-49 塞一句
 *     warning，validation.ts:22-26 写明不当锁）：提示给在任务板上，谁该让谁由 Lead 分工，
 *     运行时不拦写入。以前手机端把它升级成写租约，两条任务都声明 src/ 时后动手的成员
 *     每次写都被挡，看上去像「队友调用工具失败」。
 *   · 只有 Lead 能 reassign；claim 只能认领自己（Lead 可代领），别人已领走的报
 *     `TEAM_TASK_ALREADY_CLAIMED`；其余变更走 [authorizeOwner] —— 不是 owner 又不是 Lead
 *     就 `TEAM_TASK_UNAUTHORIZED`，**没有 owner 也算**（替一条自己没做过的活 complete
 *     是「别人以为在做、其实被抢先收了」的来源）。
 *   · 错误码一律用桌面的名字（对齐 `task-board.ts`）：`TEAM_TASK_NOT_FOUND` /
 *     `TEAM_INVALID_ARGUMENT` / `TEAM_TASK_DEPENDENCY_CYCLE` / `TEAM_LEAD_REQUIRED`。
 *     同一件事在两端给出两种码，模型的纠正经验跨端就失效了。
 */
class TeamBoard(
    private val journal: TeamJournal,
    /** 活动任务上限（不含 tombstone）：桌面默认 256 —— 与名册共用一份插件级容量 */
    private val capacity: TeamCapacity,
) {

    class Actor(val name: String, val role: MemberRole)

    private val tasks = LinkedHashMap<String, TeamTask>()
    private var leadSid: String = ""
    private var seq: Int = 0

    @Synchronized
    fun load(sessionId: String) = load(sessionId, journal.replay(sessionId))

    /** 用一次已回放好的日志装载任务板（与名册共用同一次回放，见 [TeamRoster.load]） */
    @Synchronized
    fun load(sessionId: String, replay: TeamJournal.Replay) {
        leadSid = sessionId
        tasks.clear()
        seq = 0
        replay.tasks.forEach { (id, t) -> tasks[id] = t }
        // id 水位线取「所有出现过的最大编号」，包括 tombstone
        tasks.keys.forEach { id ->
            val n = id.removePrefix("task-").toIntOrNull() ?: 0
            if (n > seq) seq = n
        }
    }

    @Synchronized
    fun maxTasks(): Int = capacity.maxTasks

    fun isEmpty(): Boolean = tasks.isEmpty()

    /* ---------------- 读 ---------------- */

    @Synchronized
    fun get(id: String): TeamTask? = tasks[id]

    @Synchronized
    fun all(): List<TeamTask> = tasks.values.toList()

    /** 活动任务（deleted 不出现） */
    @Synchronized
    fun active(): List<TeamTask> = tasks.values.filter { it.status != TaskStatus.DELETED }

    /**
     * 前置依赖是否都已完成 —— 桌面 `taskReady`（task-view.ts:24）的原样等价物。
     *
     * 它**不看**任务自己是什么状态：正在写的任务照样是「没被挡住」。
     * reassign 用的就是这一条（桌面 task-board.ts:184 也是它）。
     */
    @Synchronized
    fun unblockedOf(t: TeamTask): Boolean =
        t.blockedBy.all { dep -> tasks[dep]?.status == TaskStatus.COMPLETED }

    /** 「现在可以领」：还没人认领 **且** 前置都完成。界面与统计看它，不是桌面的 taskReady。 */
    @Synchronized
    fun readyOf(t: TeamTask): Boolean = t.status == TaskStatus.PENDING && unblockedOf(t)

    /**
     * 与其它 in-progress 任务的重叠提示。只比较**正在写**的任务：
     * pending 的任务还没开始写，把它算进来会让「先声明后执行」的正常排期到处报警。
     */
    @Synchronized
    fun warningsOf(t: TeamTask): List<String> {
        val out = mutableListOf<String>()
        for (other in tasks.values) {
            if (other.id == t.id) continue
            if (other.status != TaskStatus.IN_PROGRESS) continue
            for (a in t.writeScopes) for (b in other.writeScopes) {
                if (scopesOverlap(a, b)) {
                    // 桌面只塞一句 `write scopes overlap with task-N`（task-view.ts:44-49）：
                    // 这行既进界面也进模型的任务视图，写成长句子等于每次快照都多付一遍 token。
                    out.add("写范围与 ${other.id}（${other.owner ?: "未指派"}）重叠，仅提示不拦写入")
                }
            }
        }
        return out.distinct().take(8)
    }

    @Synchronized
    fun list(
        statuses: Set<TaskStatus>?,
        owner: String?,
        ready: Boolean?,
        cursor: Int,
        limit: Int,
    ): Pair<List<JSONObject>, Int?> {
        var rows = active().sortedBy { it.createdAt }
        if (statuses != null && statuses.isNotEmpty()) rows = rows.filter { it.status in statuses }
        if (!owner.isNullOrBlank()) {
            rows = if (owner == "unowned") rows.filter { it.owner == null }
            else rows.filter { it.owner == owner }
        }
        if (ready != null) rows = rows.filter { readyOf(it) == ready }
        val from = cursor.coerceIn(0, rows.size)
        val page = rows.drop(from).take(limit.coerceIn(1, 100))
        val next = if (from + page.size < rows.size) from + page.size else null
        return page.map { it.view(readyOf(it), warningsOf(it)) } to next
    }

    /* ---------------- 写 ---------------- */

    /**
     * 依赖清单的校验 —— 桌面 `task-board.ts:213-232` 的 `dependencies()` 逐条等价。
     *
     * 四种情形各自的码，且**顺序**照桌面：自依赖 → 重复 → 不存在 → 已删除。
     * 重复以前被 `distinct()` 静默吞掉：模型写重了照样「成功」，等到下次读 blockedBy 才发现
     * 少了一条，不知道该改哪儿（桌面对此直接 `TEAM_INVALID_ARGUMENT`）。
     */
    private fun dependencies(values: List<String>, self: String? = null): List<String> {
        val seen = LinkedHashSet<String>()
        for (raw in values) {
            val id = raw.trim()
            if (id.isEmpty()) continue
            if (id == self) throw TeamError("TEAM_TASK_DEPENDENCY_CYCLE", "任务 $self 不能依赖自己")
            if (!seen.add(id)) throw TeamError("TEAM_INVALID_ARGUMENT", "blockedBy 里「$id」重复了")
            val dep = tasks[id] ?: throw TeamError("TEAM_TASK_NOT_FOUND", "blockedBy 里的任务不存在：$id")
            if (dep.status == TaskStatus.DELETED) {
                throw TeamError("TEAM_TASK_NOT_FOUND", "blockedBy 里的任务已删除：$id")
            }
        }
        return seen.toList()
    }

    /**
     * 桌面 `authorizeOwner`（task-board.ts:124-126）：不是 Lead、也不是这条任务的 owner 就拒。
     *
     * 「没 owner」在这里不算放行条件：一条还没人认领的任务，队友不能直接替它 complete/edit ——
     * 那正是「别人以为在做、其实被人抢先收了」的来源。认领走 claim，改派走 reassign。
     */
    private fun authorizeOwner(t: TeamTask, actor: Actor, id: String, op: String) {
        if (actor.role != MemberRole.LEAD && t.owner != actor.name) {
            throw TeamError(
                "TEAM_TASK_UNAUTHORIZED",
                "只有 $id 的 owner${if (t.owner == null) "（当前未分配）" else "（${t.owner}）"}或 Lead 能$op",
                t.toJson(),
            )
        }
    }

    @Synchronized
    fun create(
        subject: String,
        description: String,
        blockedBy: List<String>,
        writeScopes: List<String>,
    ): TeamTask {
        if (active().size >= capacity.maxTasks) {
            throw TeamError("TEAM_TASK_LIMIT", "任务板已满（${capacity.maxTasks} 条活动任务）；先完成或删除一些")
        }
        // 长度判据排在容量之后（桌面 task-board.ts:46-61 就是这个顺序：先看板子满不满，
        // 再校验文本），并且 subject / description 都必须非空 —— 空说明的任务，队友
        // 认领时只能猜，猜错了整条返工。
        val subjectText = requiredText(subject, "subject", TASK_SUBJECT_MAX)
        val descriptionText = requiredText(description, "description", TASK_DESC_MAX)
        val deps = dependencies(blockedBy)
        val nextSeq = seq + 1
        val id = "task-$nextSeq"
        val t = TeamTask(
            id = id,
            revision = 1,
            subject = subjectText,
            description = descriptionText,
            status = TaskStatus.PENDING,
            owner = null,
            blockedBy = deps.toMutableList(),
            writeScopes = writeScopes.map { normalizeScope(it) }.distinct().toMutableList(),
        )
        // 先落日志再进内存：写失败就抛，id 水位线不前进、任务板不多一条幽灵任务
        journal.task(leadSid, t)
        seq = nextSeq
        tasks[id] = t
        journal.activity(leadSid, "task-created", id, "${t.subject}${if (deps.isEmpty()) "" else "（依赖 ${deps.joinToString("、")}）"}")
        return t
    }

    @Synchronized
    fun update(
        id: String,
        expectedRevision: Int,
        action: String,
        actor: Actor,
        subject: String? = null,
        description: String? = null,
        blockedBy: List<String>? = null,
        writeScopes: List<String>? = null,
        owner: String? = null,
    ): TeamTask {
        val cur = tasks[id] ?: throw TeamError("TEAM_TASK_NOT_FOUND", "没有任务：$id")
        if (cur.status == TaskStatus.DELETED) throw TeamError("TEAM_TASK_DELETED", "任务已删除：$id")
        if (expectedRevision != cur.revision) {
            throw TeamError(
                "TEAM_TASK_STALE_REVISION",
                "任务 $id 的 revision 已变成 ${cur.revision}（你拿的是 $expectedRevision）；先 team_task_get 再改",
                cur.toJson(),
            )
        }
        // 写时复制：状态机跑在副本上，日志提交成功后才替换内存版本。
        // 反过来（就地改再写盘）一旦写失败，内存已是新状态、日志还是旧的，
        // revision 也对不上 —— 之后所有 CAS 都会莫名其妙地过期。
        val t = cur.copy()
        when (action) {
            "claim" -> {
                // 桌面顺序（task-board.ts:130-135）：先判「是不是别人的活」，再判「现在能不能领」。
                // 反过来会让 beta 收到一句「TEAM_TASK_BLOCKED：当前状态是 in_progress」，
                // 它于是以为等 alpha 做完再来 —— 真相是这条永远轮不到它，只有 Lead 能改派。
                if (t.owner != null && t.owner != actor.name) {
                    throw TeamError(
                        "TEAM_TASK_ALREADY_CLAIMED",
                        "任务 $id 已被 ${t.owner} 认领；要换人只能由 Lead 用 reassign",
                        t.toJson(),
                    )
                }
                // 桌面：只有 pending 且 ready 才能认领。允许对 in_progress 重复 claim
                // 会让「谁在干」变得不可判定 —— CAS 也挡不住，因为 revision 是对的
                if (t.status != TaskStatus.PENDING || !unblockedOf(t)) {
                    val blocked = t.blockedBy.filter { tasks[it]?.status != TaskStatus.COMPLETED }
                    throw TeamError(
                        "TEAM_TASK_BLOCKED",
                        "任务 $id 不能 claim：${if (blocked.isNotEmpty()) "等 " + blocked.joinToString("、") + " 完成" else "当前状态是 ${t.status.wire}"}",
                        t.toJson(),
                    )
                }
                // 桌面：claim 只把 owner 设成调用者自己（`ownerId: caller.id`），代别人领是
                // reassign 的活儿，只有 Lead 能做。手机端保留 Lead 代领，但成员传 owner 不再算数 ——
                // 否则队友一句 claim(owner="别人") 就绕过了「只有 Lead 能改派」。
                t.owner = if (actor.role == MemberRole.LEAD && !owner.isNullOrBlank()) owner else actor.name
                t.status = TaskStatus.IN_PROGRESS
            }

            "release" -> {
                authorizeOwner(t, actor, id, "释放")
                if (t.status != TaskStatus.IN_PROGRESS) {
                    throw TeamError("TEAM_TASK_INVALID_TRANSITION", "只有进行中的任务能 release；当前 ${t.status.wire}", t.toJson())
                }
                t.owner = null
                t.status = TaskStatus.PENDING
            }

            "edit" -> {
                authorizeOwner(t, actor, id, "编辑")
                // 桌面：三个可改字段一个都没给就是调用方写错了，明确拒绝，
                // 而不是「revision 白白 +1、什么都没改」
                if (subject == null && description == null && writeScopes == null) {
                    throw TeamError(
                        "TEAM_INVALID_ARGUMENT",
                        "edit 需要至少给 subject / description / write_scopes 一个", t.toJson(),
                    )
                }
                subject?.let { t.subject = requiredText(it, "subject", TASK_SUBJECT_MAX) }
                description?.let { t.description = requiredText(it, "description", TASK_DESC_MAX) }
                writeScopes?.let { sc ->
                    t.writeScopes = sc.map { normalizeScope(it) }.distinct().toMutableList()
                }
            }

            "set_dependencies" -> {
                authorizeOwner(t, actor, id, "改依赖")
                // 桌面：set_dependencies 不给 blocked_by 就是调用方写错，不是「清空依赖」
                if (blockedBy == null) {
                    throw TeamError("TEAM_INVALID_ARGUMENT", "set_dependencies 需要带 blocked_by", t.toJson())
                }
                val deps = dependencies(blockedBy, id)
                if (wouldCycle(id, deps)) throw TeamError("TEAM_TASK_DEPENDENCY_CYCLE", "依赖会成环：${deps.joinToString("、")}")
                t.blockedBy = deps.toMutableList()
            }

            "complete" -> {
                authorizeOwner(t, actor, id, "完成")
                if (t.status != TaskStatus.IN_PROGRESS) {
                    throw TeamError("TEAM_TASK_INVALID_TRANSITION", "只有进行中的任务能 complete；当前 ${t.status.wire}（先 claim）", t.toJson())
                }
                t.status = TaskStatus.COMPLETED
                t.completedAt = System.currentTimeMillis()
            }

            "reopen" -> {
                authorizeOwner(t, actor, id, "重开")
                if (t.status != TaskStatus.COMPLETED) {
                    throw TeamError("TEAM_TASK_INVALID_TRANSITION", "只有已完成的任务能 reopen；当前 ${t.status.wire}", t.toJson())
                }
                t.status = TaskStatus.PENDING
                t.completedAt = 0
            }

            "reassign" -> {
                if (actor.role != MemberRole.LEAD) throw TeamError("TEAM_LEAD_REQUIRED", "只有 Lead 能改派任务")
                if (t.status != TaskStatus.PENDING && t.status != TaskStatus.IN_PROGRESS) {
                    throw TeamError("TEAM_TASK_INVALID_TRANSITION", "只有待办或进行中的任务能改派；当前 ${t.status.wire}", t.toJson())
                }
                val next = owner?.takeIf { it.isNotBlank() }
                if (next == null) {
                    // 取消指派：回到无主待办，别留一个「进行中但没人」的僵尸任务
                    t.owner = null
                    t.status = TaskStatus.PENDING
                } else {
                    // 桌面看的是 taskReady（前置有没有完成），不是「能不能领」：
                    // 改派的主要场景正是「干到一半的人卡住了，换人」，那条是 in_progress。
                    // 以前这里用 readyOf（要求 status==pending），于是对任何进行中的任务
                    // 都回一句「还被  挡着」——挡住它的依赖一个都没有，纯误导。
                    if (!unblockedOf(t)) {
                        val blocked = t.blockedBy.filter { tasks[it]?.status != TaskStatus.COMPLETED }
                        throw TeamError("TEAM_TASK_BLOCKED", "任务 $id 还被 ${blocked.joinToString("、")} 挡着，不能改派", t.toJson())
                    }
                    t.owner = next
                    t.status = TaskStatus.IN_PROGRESS
                }
            }

            "delete" -> {
                authorizeOwner(t, actor, id, "删除")
                // 桌面：还有活动任务依赖它时拒绝删除，由调用方先改依赖 ——
                // 自动摘依赖会静默改掉别人的 blockedBy，让「谁在等谁」失真
                val dependent = tasks.values.firstOrNull {
                    it.id != id && it.status != TaskStatus.DELETED && id in it.blockedBy
                }
                if (dependent != null) {
                    throw TeamError(
                        "TEAM_TASK_HAS_DEPENDENTS",
                        "任务 $id 还挡着 ${dependent.id}；先用 set_dependencies 改掉它的依赖再删",
                        t.toJson(),
                    )
                }
                t.status = TaskStatus.DELETED
            }

            else -> throw TeamError(
                "TEAM_INVALID_ARGUMENT",
                "未知 action：$action（可用 claim/release/edit/set_dependencies/complete/reopen/reassign/delete）",
            )
        }
        t.revision = cur.revision + 1
        t.updatedAt = System.currentTimeMillis()
        journal.task(leadSid, t)
        tasks[id] = t
        journal.activity(leadSid, "task-$action", id, "${t.subject} → ${t.status.wire}${t.owner?.let { " @$it" } ?: ""}")
        return t
    }

    /** 依赖环检测：从每个新依赖出发，看能否走回自己 */
    @Synchronized
    private fun wouldCycle(id: String, deps: List<String>): Boolean {
        val seen = HashSet<String>()
        fun walk(cur: String): Boolean {
            if (cur == id) return true
            if (!seen.add(cur)) return false
            val t = tasks[cur] ?: return false
            return t.blockedBy.any { walk(it) }
        }
        return deps.any { walk(it) }
    }

    /* ---------------- 视图 ---------------- */

    @Synchronized
    fun boardView(): JSONObject {
        val groups = active().groupBy { it.status }
        return JSONObject().apply {
            put("total", active().size)
            put("pending", groups[TaskStatus.PENDING]?.size ?: 0)
            put("inProgress", groups[TaskStatus.IN_PROGRESS]?.size ?: 0)
            put("completed", groups[TaskStatus.COMPLETED]?.size ?: 0)
            put("ready", active().count { readyOf(it) })
        }
    }

    /** 给界面：全部活动任务 + 派生字段 */
    @Synchronized
    fun json(): JSONArray = JSONArray().apply {
        active().sortedWith(compareBy({ it.status.ordinal }, { it.createdAt })).forEach {
            put(it.view(readyOf(it), warningsOf(it)))
        }
    }
}
