package ai.deepseek.harness.mobile.kernel.mission

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 统一唤醒层：job 完成 / 定时到点不再各自维护通知队列，全部落进这里。
 *
 * 一条记录 = 一次「要回到对话」的请求：
 *  - `id` 用 `missionId + transition` 去重（job 只结算一次；定时按 scheduledAt 区分每一次）；
 *  - `policy` 来自 Mission 的 `wakePolicy`（idle-auto / queue / notify / defer）；
 *  - `text` 是真正要交给模型/输入框的内容；`display` 是给用户看的原文（定时用 prompt）；
 *  - 前端空闲时认领并消费；忙碌时留在队列；agent 的 pre-step 也会认领（谁先拿到谁负责）。
 *
 * 与旧 JobRegistry notices 的关系：那是按 owner 的纯文本队列，无法携带 mission/policy。
 * Step 2 起由本队列统一承载；旧字段仅保留兼容，不再作为唤醒事实源。
 */
class WakeRouter(
    file: File,
    private val log: (String) -> Unit = {},
    private val clock: () -> Long = System::currentTimeMillis,
) {

    private val store = WakeStore(file, log)
    private val queue = ConcurrentHashMap<String, JSONObject>()

    init { load() }

    @Synchronized
    private fun load() {
        val items = runCatching { store.load() }.getOrElse { e ->
            log("wake 队列读取失败：${e.message}")
            emptyList()
        }
        items.forEach { raw ->
            val id = raw.optString("id")
            if (id.isNotBlank()) queue[id] = JSONObject(raw.toString())
        }
        persist()
    }

    /* ---------------- 入队 ---------------- */

    /** job 正常结算（awaited / 模型主动 kill 的由调用方跳过）。 */
    @Synchronized
    fun enqueueJob(
        jobId: String,
        title: String,
        sessionId: String,
        text: String,
        policy: String = MissionRegistry.WAKE_IDLE_AUTO,
    ): JSONObject? {
        if (jobId.isBlank() || sessionId.isBlank() || text.isBlank()) return null
        val id = "job:$jobId:settled"
        return enqueue(
            JSONObject().apply {
                put("id", id)
                put("missionId", "job:$jobId")
                put("sessionId", sessionId)
                put("kind", "job")
                put("title", title.ifBlank { "后台任务" })
                put("text", text)
                put("display", text)
                put("delivered", true)
                put("policy", policy)
                put("reason", "settled")
                put("createdAt", clock())
                put("notifiedAt", 0L)
                put("consumedAt", 0L)
            },
        )
    }

    /**
     * 团队任务完成 → 通知 Lead 会话。策略用 `queue`：不抢当前回合，等空闲时补一轮。
     * 去重键带 revision，同一个任务被 reopen 再完成时还能再提醒一次。
     */
    @Synchronized
    fun enqueueTeam(
        taskId: String,
        title: String,
        sessionId: String,
        text: String,
        revision: Int = 0,
    ): JSONObject? {
        if (taskId.isBlank() || sessionId.isBlank() || text.isBlank()) return null
        val id = "team:$taskId:completed:$revision"
        return enqueue(
            JSONObject().apply {
                put("id", id)
                put("missionId", "team:$taskId")
                put("sessionId", sessionId)
                put("kind", "team")
                put("title", title.ifBlank { "团队任务" })
                put("text", text)
                put("display", text)
                put("delivered", true)
                put("policy", MissionRegistry.WAKE_QUEUE)
                put("reason", "completed")
                put("createdAt", clock())
                put("notifiedAt", 0L)
                put("consumedAt", 0L)
            },
        )
    }

    /** 定时到点：delivered=true 表示提醒已写进原会话日志，text 用 nudge；否则 text 用 prompt。 */
    @Synchronized
    fun enqueueSchedule(
        sourceId: String,
        title: String,
        sessionId: String,
        prompt: String,
        delivered: Boolean,
        scheduledAt: Long,
        policy: String = MissionRegistry.WAKE_IDLE_AUTO,
    ): JSONObject? {
        if (sourceId.isBlank() || sessionId.isBlank()) return null
        val body = prompt.ifBlank { title.ifBlank { "定时任务" } }
        val nudge = "（定时任务「${title.ifBlank { "提醒" }}」已到点，请根据上一条提醒继续处理。）"
        val id = "schedule:$sourceId:due:$scheduledAt"
        return enqueue(
            JSONObject().apply {
                put("id", id)
                put("missionId", "schedule:$sourceId")
                put("sessionId", sessionId)
                put("kind", "schedule")
                put("title", title.ifBlank { "定时任务" })
                put("text", if (delivered) nudge else body)
                put("display", body)
                put("prompt", body)
                put("delivered", delivered)
                put("policy", policy)
                put("reason", "due")
                put("scheduledAt", scheduledAt)
                put("createdAt", clock())
                put("notifiedAt", 0L)
                put("consumedAt", 0L)
            },
        )
    }

    @Synchronized
    private fun enqueue(record: JSONObject): JSONObject? {
        val id = record.optString("id")
        val existing = queue[id]
        if (existing != null && existing.optLong("consumedAt", 0L) == 0L) return null
        queue[id] = record
        persist()
        return JSONObject(record.toString())
    }

    /* ---------------- 认领 ---------------- */

    /** 未消费的唤醒；sessionId 为空 = 全部（诊断用）。 */
    @Synchronized
    fun pending(sessionId: String = ""): JSONArray = JSONArray().apply {
        queue.values
            .asSequence()
            .filter { it.optLong("consumedAt", 0L) == 0L }
            .filter { sessionId.isBlank() || it.optString("sessionId") == sessionId }
            .sortedBy { it.optLong("createdAt", 0L) }
            .forEach { put(JSONObject(it.toString())) }
    }

    /**
     * 删会话时的级联：指向这一场的唤醒全部带走（含已消费的存根）。
     *
     * 留着它们不是「历史」而是**定时炸弹**：`drainForAgent` 按 sessionId 取货，
     * 会话早没了、唤醒还在，到点照样把这件事叫起来 —— 用户看到的正是
     * 「删掉的会话自己又开了一轮」。
     */
    @Synchronized
    fun dropSession(sessionId: String): Int {
        if (sessionId.isBlank()) return 0
        val gone = queue.entries.filterTo(ArrayList()) { (_, w) -> w.optString("sessionId") == sessionId }
        if (gone.isEmpty()) return 0
        gone.forEach { (id, _) -> queue.remove(id) }
        persist()
        log("会话 $sessionId 删除：唤醒带走 ${gone.size} 条")
        return gone.size
    }

    /** 队列里指向这些会话之外的会话 id（开机清扫孤儿用；空 sessionId 不算）。 */
    @Synchronized
    fun orphanSessionIds(live: Set<String>): List<String> = queue.values
        .map { it.optString("sessionId") }
        .filter { it.isNotBlank() && !live.contains(it) }
        .distinct()

    /** 前端认领并消费；返回实际消费条数。 */
    @Synchronized
    fun consume(ids: Collection<String>): Int {
        if (ids.isEmpty()) return 0
        val now = clock()
        var n = 0
        ids.forEach { id ->
            val rec = queue[id] ?: return@forEach
            if (rec.optLong("consumedAt", 0L) != 0L) return@forEach
            rec.put("consumedAt", now)
            n++
        }
        if (n > 0) persist()
        return n
    }

    /**
     * agent pre-step：忙碌轮次里先把唤醒注入模型；defer 不参与自动续轮。
     * 返回完整记录（不只是文本）—— 调用方要把「这条唤醒被谁消费」写回那条 Mission 的证据。
     */
    @Synchronized
    fun drainForAgent(sessionId: String): List<JSONObject> {
        if (sessionId.isBlank()) return emptyList()
        val now = clock()
        val out = ArrayList<JSONObject>()
        queue.values
            .asSequence()
            .filter { it.optLong("consumedAt", 0L) == 0L }
            .filter { it.optString("sessionId") == sessionId }
            .filter { it.optString("policy") != MissionRegistry.WAKE_DEFER }
            .sortedBy { it.optLong("createdAt", 0L) }
            .forEach { rec ->
                rec.put("consumedAt", now)
                out.add(JSONObject(rec.toString()))
            }
        if (out.isNotEmpty()) persist()
        return out
    }

    /**
     * 把一条已经认领的唤醒退回队列（补的那一轮失败了 / 端点不可达）。
     *
     * 不做这件事的话，「先消费再启动」的代价就是**事情被静默吃掉**：记录 consumedAt 已非 0，
     * 下一轮再也不会补它，用户只看到一条失败卡。回滚带上 attempts 上限：
     * 连续失败到达次数就不再重投，避免端点一直坏时无限循环。
     */
    @Synchronized
    fun requeue(id: String, reason: String = ""): JSONObject? {
        val rec = queue[id] ?: return null
        if (rec.optLong("consumedAt", 0L) == 0L) return JSONObject(rec.toString())
        val attempts = rec.optInt("attempts", 0)
        if (attempts >= MAX_ATTEMPTS) return null
        rec.put("consumedAt", 0L)
        rec.put("attempts", attempts + 1)
        rec.put("failReason", reason.take(160))
        rec.put("failedAt", clock())
        persist()
        return JSONObject(rec.toString())
    }

    @Synchronized
    fun markNotified(id: String) {
        val rec = queue[id] ?: return
        if (rec.optLong("notifiedAt", 0L) != 0L) return
        rec.put("notifiedAt", clock())
        persist()
    }

    @Synchronized
    fun get(id: String): JSONObject? = queue[id]?.let { JSONObject(it.toString()) }

    /* ---------------- 持久化 ---------------- */

    @Synchronized
    private fun persist() {
        val all = queue.values.toList()
        val pending = all.filter { it.optLong("consumedAt", 0L) == 0L }
        val consumed = all
            .filter { it.optLong("consumedAt", 0L) != 0L }
            .sortedByDescending { it.optLong("consumedAt", 0L) }
            .take(MAX_CONSUMED)
        val keep = pending + consumed
        val keepIds = keep.mapTo(HashSet()) { it.optString("id") }
        queue.keys.retainAll(keepIds)
        runCatching { store.save(keep) }.onFailure {
            log("wake 队列写入失败：${it.message}")
        }
    }

    companion object {
        const val MAX_CONSUMED = 100

        /** 一条唤醒最多回滚重投几次：端点一直坏时不能无限循环，超了就留在失败状态让人看 */
        const val MAX_ATTEMPTS = 3
    }
}
