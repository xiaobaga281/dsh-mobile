package ai.deepseek.harness.mobile.kernel.mission

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 本地 Mission 账本：jobs / schedules 的统一状态、来源、证据与唤醒策略。
 *
 * 这是唯一事实源。对话里的 Mission 卡、进行中带、任务页都从这里读；
 * 前端不再自己从两份旧注册表推导状态。Step 2 的 Wake Router 也只消费这里的迁移。
 *
 * 边界（不假装）：
 *  - job 的执行体在进程内；进程重启后没有对应执行体，load() 会把未结算的 job Mission
 *    标成 `settled/interrupted`，不显示成 running。
 *  - schedule 的记录本身会持久化并在启动时重新装载；本账本跟随 [onScheduleChanged] 对齐。
 *  - 暂时只做 jobs/schedules；team/pc 在后续步骤接入，字段已经预留 kind。
 */
class MissionRegistry(
    file: File,
    private val log: (String) -> Unit = {},
    private val clock: () -> Long = System::currentTimeMillis,
) {

    private val store = MissionStore(file, log)
    private val missions = ConcurrentHashMap<String, JSONObject>()

    init {
        load()
    }

    @Synchronized
    private fun load() {
        val items = runCatching { store.load() }.getOrElse { e ->
            log("mission 账本读取失败：${e.message}")
            emptyList()
        }
        val now = clock()
        var dirty = false
        items.forEach { raw ->
            val id = raw.optString("id")
            if (id.isBlank()) return@forEach
            val m = JSONObject(raw.toString())
            // 进程重启后 job 执行体已经不存在：未结算的 job 必须诚实标成 interrupted
            if (m.optString("kind") == "job" && m.optString("state") != STATE_SETTLED) {
                m.put("state", STATE_SETTLED)
                m.put("outcome", OUTCOME_INTERRUPTED)
                m.put("nextAt", JSONObject.NULL)
                m.put("overdue", false)
                m.put("updatedAt", now)
                dirty = true
            }
            missions[id] = m
        }
        if (dirty) persist()
    }

    /* ---------------- 状态迁移 ---------------- */

    @Synchronized
    fun onJobStarted(
        jobId: String,
        name: String,
        ownerSession: String,
        startedAt: Long,
        spec: JSONObject? = null,
    ) {
        if (jobId.isBlank()) return
        val id = "job:$jobId"
        val existing = missions[id]
        val m = (existing?.let { JSONObject(it.toString()) } ?: JSONObject()).apply {
            put("id", id)
            put("kind", "job")
            put("sourceId", jobId)
            put("sessionId", ownerSession)
            put("title", name.ifBlank { "后台任务" })
            put("state", STATE_RUNNING)
            put("outcome", JSONObject.NULL)
            // origin 是对象：{type, tool, command, workdir}。留下参数才谈得上重跑；
            // 老数据里它是字符串，读取方要能兼容（见 app.js 的 missionOriginType）。
            put("origin", spec?.let { JSONObject(it.toString()).put("type", "tool") }
                ?: JSONObject().put("type", "tool"))
            put("wakePolicy", WAKE_IDLE_AUTO)
            if (!has("createdAt")) put("createdAt", startedAt)
            put("updatedAt", startedAt)
            put("startedAt", startedAt)
            put("endedAt", JSONObject.NULL)
            put("nextAt", JSONObject.NULL)
            put("overdue", false)
            if (!has("evidence")) put("evidence", JSONArray())
            if (!has("permissionScope")) put("permissionScope", defaultScope())
            put("evidenceCount", optJSONArray("evidence")?.length() ?: 0)
        }
        missions[id] = m
        persist()
    }

    @Synchronized
    fun onJobSettled(
        jobId: String,
        name: String,
        ownerSession: String,
        status: String,
        startedAt: Long,
        endedAt: Long,
        outputChars: Long,
    ) {
        if (jobId.isBlank()) return
        val id = "job:$jobId"
        val existing = missions[id]
        val outcome = when (status) {
            "done" -> OUTCOME_DONE
            "failed" -> OUTCOME_FAILED
            "killed" -> OUTCOME_CANCELLED
            else -> OUTCOME_FAILED
        }
        val fresh = ArrayList<JSONObject>()
        if (outputChars > 0) {
            fresh.add(
                JSONObject()
                    .put("type", "job-output")
                    .put("ref", jobId)
                    .put("title", "任务输出")
                    .put("chars", outputChars)
                    .put("at", endedAt),
            )
        }
        // 结算不能把跑动期间攒下的证据（审批、唤醒、交付物）整表换掉 —— 账本只追加
        val evidence = mergeEvidence(existing?.optJSONArray("evidence"), fresh)
        val m = (existing?.let { JSONObject(it.toString()) } ?: JSONObject()).apply {
            put("id", id)
            put("kind", "job")
            put("sourceId", jobId)
            put("sessionId", ownerSession)
            put("title", name.ifBlank { "后台任务" })
            put("state", STATE_SETTLED)
            put("outcome", outcome)
            // 结算不能把「它是怎么来的、带什么参数」洗掉 —— 那是重跑与审计的唯一依据
            if (optJSONObject("origin") == null) put("origin", JSONObject().put("type", "tool"))
            put("wakePolicy", WAKE_IDLE_AUTO)
            if (!has("createdAt")) put("createdAt", startedAt)
            put("updatedAt", endedAt)
            put("startedAt", startedAt)
            put("endedAt", endedAt)
            put("nextAt", JSONObject.NULL)
            put("overdue", false)
            put("evidence", evidence)
            put("evidenceCount", evidence.length())
            if (!has("permissionScope")) put("permissionScope", defaultScope())
        }
        missions[id] = m
        persist()
    }

    /** 定时任务的创建 / 修改 / 到点推进 / 失败重排都会走到这里。 */
    @Synchronized
    fun onScheduleChanged(view: JSONObject) {
        val sourceId = view.optString("id")
        if (sourceId.isBlank()) return
        val id = "schedule:$sourceId"
        val active = view.optString("state") == "active"
        val now = clock()
        val existing = missions[id]

        val fresh = ArrayList<JSONObject>()
        view.optJSONObject("lastDelivery")?.let { d ->
            fresh.add(
                JSONObject()
                    .put("type", "schedule-delivery")
                    .put("ref", d.optString("messageId"))
                    .put("title", "到点投递")
                    .put("at", d.optLong("deliveredAt", 0L)),
            )
        }
        // 每次推进都重写整条记录，所以权限范围与已攒下的证据要显式带过来
        val evidence = mergeEvidence(existing?.optJSONArray("evidence"), fresh)

        val m = JSONObject().apply {
            put("id", id)
            put("kind", "schedule")
            put("sourceId", sourceId)
            put("sessionId", view.optString("sessionId"))
            put("title", view.optString("title").ifBlank { "定时任务" })
            put("state", if (active) STATE_WAITING else STATE_SETTLED)
            put("outcome", if (active) JSONObject.NULL else OUTCOME_DONE)
            put("origin", JSONObject().put("type", "schedule").put("prompt", view.optString("prompt")))
            put("wakePolicy", WAKE_IDLE_AUTO)
            put("createdAt", existing?.optLong("createdAt") ?: now)
            put("updatedAt", now)
            put("startedAt", JSONObject.NULL)
            put("endedAt", JSONObject.NULL)
            put("nextAt", if (active) view.optLong("scheduledAt") else JSONObject.NULL)
            put("overdue", active && view.optBoolean("overdue"))
            view.optJSONObject("rule")?.let { put("rule", it) }
            put("evidence", evidence)
            put("evidenceCount", evidence.length())
            put("permissionScope", existing?.optJSONObject("permissionScope") ?: defaultScope())
        }
        if (sameSignature(existing, m)) return
        missions[id] = m
        persist()
    }

    @Synchronized
    fun onScheduleRemoved(sourceId: String) {
        if (sourceId.isBlank()) return
        if (missions.remove("schedule:$sourceId") != null) persist()
    }

    /**
     * 团队成员的任务板条目 → Mission（Step 5）。
     *
     * 归属会话是 **Lead 的会话**：用户在对话里派出去的工作，追踪点也在那里；
     * 成员自己的会话日志留给成员视图。状态映射照账本原语义：
     * pending→queued、in_progress→running、被依赖挡住→waiting、completed→settled/done。
     */
    @Synchronized
    fun onTeamTask(
        taskId: String,
        leadSession: String,
        subject: String,
        status: String,
        owner: String,
        ready: Boolean = true,
        description: String = "",
        createdAt: Long,
        updatedAt: Long,
        completedAt: Long = 0L,
    ) {
        if (taskId.isBlank() || leadSession.isBlank()) return
        // 任务被从任务板上撤掉 = 这件事不再存在；留一条「已取消」只会让人以为真做过什么
        if (status == "deleted") {
            removeTeamTask(taskId)
            return
        }
        val id = "team:$taskId"
        val existing = missions[id]
        val (state, outcome) = when (status) {
            "completed" -> STATE_SETTLED to OUTCOME_DONE
            "deleted" -> STATE_SETTLED to OUTCOME_CANCELLED
            "in_progress" -> STATE_RUNNING to JSONObject.NULL
            else -> (if (ready) STATE_QUEUED else STATE_WAITING) to JSONObject.NULL
        }
        val m = (existing?.let { JSONObject(it.toString()) } ?: JSONObject()).apply {
            put("id", id)
            put("kind", "team")
            put("sourceId", taskId)
            put("sessionId", leadSession)
            put("title", subject.ifBlank { "团队任务" })
            put("state", state)
            put("outcome", outcome)
            put("origin", JSONObject().put("type", "team").put("member", owner).put("description", description.take(400)))
            put("wakePolicy", WAKE_QUEUE)
            put("createdAt", if (existing != null) existing.optLong("createdAt") else createdAt)
            put("updatedAt", updatedAt)
            put("startedAt", if (status == "in_progress" || completedAt > 0L) updatedAt else JSONObject.NULL)
            put("endedAt", if (completedAt > 0L) completedAt else JSONObject.NULL)
            put("nextAt", JSONObject.NULL)
            put("overdue", false)
            if (!has("evidence")) put("evidence", JSONArray())
            put("evidenceCount", optJSONArray("evidence")?.length() ?: 0)
            if (!has("permissionScope")) put("permissionScope", defaultScope())
        }
        if (sameSignature(existing, m)) return
        missions[id] = m
        persist()
    }

    @Synchronized
    fun removeTeamTask(taskId: String) {
        if (taskId.isBlank()) return
        if (missions.remove("team:$taskId") != null) persist()
    }

    /* ---------------- 证据与权限范围 ---------------- */

    /**
     * 往某条 Mission 追加一条证据。账本只存引用与摘要，正文由 MissionEvidence 现从
     * 会话日志 / job 输出里取（本地优先，账本不长大）。
     * 追加**不动 updatedAt**：那是「状态最近何时迁移」，被一次审批顶掉会让卡片的排序和时间都说谎。
     */
    @Synchronized
    fun appendEvidence(id: String, entry: JSONObject): Boolean {
        val m = missions[id] ?: return false
        val type = entry.optString("type")
        val ref = entry.optString("ref")
        if (type.isBlank() || ref.isBlank()) return false
        val old = m.optJSONArray("evidence")
        if (old != null) {
            for (i in 0 until old.length()) {
                val e = old.optJSONObject(i) ?: continue
                // 同一件事的同一个引用只记一次（唤醒重投、状态重放都不该刷出第二条证据）
                if (e.optString("type") == type && e.optString("ref") == ref) return false
            }
        }
        val ev = mergeEvidence(old, listOf(entry))
        m.put("evidence", ev)
        m.put("evidenceCount", ev.length())
        persist()
        return true
    }

    /** 这条 Mission 的权限范围；没有记录时按「跟随会话」返回。 */
    @Synchronized
    fun scopeOf(id: String): JSONObject =
        (missions[id]?.optJSONObject("permissionScope")?.let { JSONObject(it.toString()) }) ?: defaultScope()

    /**
     * 委派链路（团队成员 / 子代理）这一趟该用哪个权限档。
     *
     * 主对话那份在 `AgentDriver.effectivePermission()` 里，它还要读设置页的热更新；
     * 派出去的人没有轮次上下文，只能拿配置里带过来的 missionId 现合一次档。
     * 少了这一步，「Mission 只读」挡得住 Lead，挡不住 Lead 派出去写盘的人。
     */
    @Synchronized
    fun effectivePermissionFor(sessionMode: String, missionId: String): String =
        if (missionId.isBlank()) sessionMode
        else effectivePermission(sessionMode, scopeOf(missionId).optString("mode"))

    /** 收窄这条 Mission 的权限；只接受四个已知档位，返回 null 表示没改动。 */
    @Synchronized
    fun setPermission(id: String, mode: String): JSONObject? {
        val m = missions[id] ?: return null
        if (mode !in PERM_MODES) return null
        val scope = m.optJSONObject("permissionScope") ?: defaultScope()
        if (scope.optString("mode", PERM_INHERIT) == mode) return get(id)
        scope.put("mode", mode)
        m.put("permissionScope", scope)
        m.put("updatedAt", clock())
        persist()
        return get(id)
    }

    /**
     * 「这一件事以后都允许」：记在 Mission 上，不写会话级授权表。
     * 作用域到此为止，同会话的下一件事仍然会问。
     */
    @Synchronized
    fun addGrant(id: String, tool: String): Boolean {
        val m = missions[id] ?: return false
        if (tool.isBlank()) return false
        val scope = m.optJSONObject("permissionScope") ?: defaultScope()
        val grants = scope.optJSONArray("grants") ?: JSONArray()
        if ((0 until grants.length()).any { grants.optString(it) == tool }) return false
        grants.put(tool)
        scope.put("grants", grants)
        m.put("permissionScope", scope)
        persist()
        return true
    }

    @Synchronized
    fun hasGrant(id: String, tool: String): Boolean {
        val grants = missions[id]?.optJSONObject("permissionScope")?.optJSONArray("grants") ?: return false
        return (0 until grants.length()).any { grants.optString(it) == tool }
    }

    /** 只读档下危险确认也不能放行，所以档位比较只有「谁更严」，没有「批准即放宽」。 */
    private fun mergeEvidence(existing: JSONArray?, incoming: List<JSONObject>): JSONArray {
        val all = ArrayList<JSONObject>()
        existing?.let { arr -> for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { all.add(it) } }
        all.addAll(incoming)
        val seen = HashSet<String>()
        val keep = all
            .filter { it.optString("type").isNotBlank() && seen.add(it.optString("type") + "|" + it.optString("ref")) }
            .sortedBy { it.optLong("at", 0L) }
            .takeLast(MAX_EVIDENCE)
        return JSONArray().apply { keep.forEach { put(JSONObject(it.toString())) } }
    }

    private fun defaultScope(): JSONObject =
        JSONObject().put("mode", PERM_INHERIT).put("grants", JSONArray())

    /* ---------------- 读取 ---------------- */

    /** sessionId 为空 = 全部来源；否则只返回该会话的 Mission。 */
    @Synchronized
    fun list(sessionId: String = ""): JSONArray {
        val now = clock()
        return JSONArray().apply {
            missions.values
                .asSequence()
                .filter { sessionId.isBlank() || it.optString("sessionId") == sessionId }
                .sortedByDescending { it.optLong("updatedAt") }
                .forEach { m ->
                    val copy = JSONObject(m.toString())
                    // 到点但定时器还没跑到：列表上先如实显示「已到点」，别等下一次闹钟
                    if (copy.optString("state") == STATE_WAITING &&
                        copy.optLong("nextAt", 0L) > 0L &&
                        copy.optLong("nextAt") <= now
                    ) {
                        copy.put("overdue", true)
                    }
                    put(copy)
                }
        }
    }

    @Synchronized
    fun get(id: String): JSONObject? = missions[id]?.let { JSONObject(it.toString()) }

    @Synchronized
    fun remove(id: String): Boolean {
        val removed = missions.remove(id) != null
        if (removed) persist()
        return removed
    }

    /**
     * 删会话时的级联：这一场留下的所有 Mission 记录一起走。
     *
     * 不做这件事的后果很具体：页面侧 `LocalDB.remove` 只清 localStorage，任务页读的是
     * 这份账本 —— 会话没了、行还挂着（实测 8 行指向已不存在的会话），而且指向它们的
     * 唤醒到点还会把这件事叫醒。返回删掉的条数，调用方拿去说清「顺带清了 N 项」。
     */
    @Synchronized
    fun dropSession(sessionId: String): Int {
        if (sessionId.isBlank()) return 0
        val gone = missions.entries.filterTo(ArrayList()) { (_, m) -> m.optString("sessionId") == sessionId }
        if (gone.isEmpty()) return 0
        gone.forEach { (id, _) -> missions.remove(id) }
        persist()
        log("会话 $sessionId 删除：账本带走 ${gone.size} 条")
        return gone.size
    }

    /** 账本里指向这些会话之外的条目的会话 id（清扫孤儿用；空 sessionId 不算孤儿）。 */
    @Synchronized
    fun orphanSessionIds(live: Set<String>): List<String> = missions.values
        .map { it.optString("sessionId") }
        .filter { it.isNotBlank() && !live.contains(it) }
        .distinct()

    /* ---------------- 持久化 ---------------- */

    @Synchronized
    private fun persist() {
        val all = missions.values.toList()
        val active = all.filter { it.optString("state") != STATE_SETTLED }
        val settled = all
            .filter { it.optString("state") == STATE_SETTLED }
            .sortedByDescending { it.optLong("updatedAt") }
            .take(MAX_SETTLED)
        val keep = active + settled
        val keepIds = keep.mapTo(HashSet()) { it.optString("id") }
        missions.keys.retainAll(keepIds)
        runCatching { store.save(keep) }.onFailure {
            log("mission 账本写入失败：${it.message}")
        }
    }

    /** 只比较会影响界面/策略的字段；updatedAt 每次刷新都变，不能算进签名。 */
    private fun sameSignature(a: JSONObject?, b: JSONObject): Boolean {
        if (a == null) return false
        val keys = listOf(
            "kind", "sourceId", "sessionId", "title", "state", "outcome",
            "wakePolicy", "nextAt", "overdue", "evidenceCount",
        )
        for (k in keys) {
            if (a.optString(k) != b.optString(k)) return false
        }
        if ((a.optJSONObject("permissionScope")?.optString("mode") ?: "") !=
            (b.optJSONObject("permissionScope")?.optString("mode") ?: "")
        ) return false
        return (a.optJSONObject("rule")?.toString() ?: "") == (b.optJSONObject("rule")?.toString() ?: "")
    }

    companion object {
        const val STATE_QUEUED = "queued"
        const val STATE_RUNNING = "running"
        const val STATE_WAITING = "waiting"
        const val STATE_SETTLED = "settled"

        const val OUTCOME_DONE = "done"
        const val OUTCOME_FAILED = "failed"
        const val OUTCOME_CANCELLED = "cancelled"
        const val OUTCOME_INTERRUPTED = "interrupted"

        const val WAKE_IDLE_AUTO = "idle-auto"
        const val WAKE_QUEUE = "queue"
        const val WAKE_NOTIFY = "notify"
        const val WAKE_DEFER = "defer"

        /**
         * Mission 级权限：inherit 跟随会话，其余与会话 permission 同名。
         * 前端档位叫 default（内核历史叫 ask），两个都认 —— 否则合档查不到排名，
         * 收窄会被静默忽略，界面写着只读、工具按标准跑。
         */
        const val PERM_INHERIT = "inherit"
        const val PERM_READONLY = "readonly"
        const val PERM_ASK = "ask"
        const val PERM_DEFAULT = "default"
        const val PERM_FULL = "full"
        val PERM_MODES = setOf(PERM_INHERIT, PERM_READONLY, PERM_ASK, PERM_DEFAULT, PERM_FULL)
        private val PERM_RANK = mapOf(PERM_READONLY to 0, PERM_ASK to 1, PERM_DEFAULT to 1, PERM_FULL to 2)

        /**
         * 会话档与 Mission 档的合档：**只收窄，不放宽**。
         * Mission 说 inherit（或非法值）就等于没有 Mission，直接沿会话档；
         * 反过来 Mission 想 full 也顶不过会话的 readonly —— 全局切档是用户手里的闸门，
         * 账本里的字段不能自己把闸门抬起来。
         */
        fun effectivePermission(sessionMode: String, missionMode: String): String {
            val r = PERM_RANK[missionMode] ?: return sessionMode
            val s = PERM_RANK[sessionMode] ?: return sessionMode
            return if (r <= s) missionMode else sessionMode
        }

        /** 已结算的 Mission 只留最近这么多条；活动中的永远保留。 */
        const val MAX_SETTLED = 200

        /** 单条 Mission 最多留多少条证据；超出丢最旧的，正文本来也不落在账本里。 */
        const val MAX_EVIDENCE = 12
    }
}
