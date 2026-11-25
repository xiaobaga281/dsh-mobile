package ai.deepseek.harness.mobile.kernel.schedule

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 会话定时任务 —— 桌面 `ctx.schedule`（schedule_create/update/delete/list）的手机端等价物。
 *
 * 本次重写修掉的三件事（都会丢用户数据或对模型说谎）：
 *
 *  1. **一次性任务触发后不再删行**。旧实现 `fire()` 对非周期任务直接
 *     `entries.remove(id)` + `persist()`，触发即删除 —— 而那一刻 prompt 只发给了一个
 *     可能并不存在的 WebView 事件出口，于是「任务消失 + 内容永久丢失」。
 *     现在改为 `state=inactive`：行保留，`schedule_list` 仍看得到它和它的回执。
 *
 *  2. **投递先写原会话，再改任务行**。旧实现只 `onDue` 发一个 UI 事件就算送达；
 *     应用不在前台时事件发不出去，任务却照样推进/删除。现在通过 [ScheduleDelivery]
 *     把消息真正追加进 `SessionStore`（`user/message`，`producer=schedule`），
 *     写入成功才推进任务行；失败则保持 active、累计 missedRuns 并稍后重试。
 *
 *  3. **幂等**。`(id, scheduledAt)` 是幂等键：同一条记录同一个目标时刻只投递一次，
 *     定时器/开机补发/闹钟三个入口同时醒来也不会重复送达。
 *
 * 仍然如实承认的边界（不假装）：手机端到点精度是**近似**，记录里写
 * `deliveryMode=device`、`timingGuarantee=inexact`；进程被系统杀掉后只能等下次进程
 * 启动（或闹钟拉起）补发，不能保证准点。
 *
 * 构造签名保持与 ToolKernel 现有调用兼容（`dir` / `onDue` / `log`），
 * 新增参数都有默认值，因此不必改 ToolKernel。
 */
class ScheduleRegistry(
    private val dir: File,
    private val onDue: (JSONObject) -> Unit,
    private val log: (String) -> Unit = {},
    private val clock: ScheduleClock = ScheduleClock.system(),
    /** 任务行变化（创建/修改/到点推进/失败重排/启动装载）：Mission Ledger 用它对齐。 */
    private val onChanged: (JSONObject) -> Unit = {},
    /** 任务行被删除：Mission Ledger 移除对应 Mission。 */
    private val onRemoved: (String) -> Unit = {},
) {

    private val file = File(dir, "schedule.json")
    private val store = ScheduleStore(file, log)
    private val records = ConcurrentHashMap<String, ScheduleRecord>()
    private val timers = ConcurrentHashMap<String, ScheduledFuture<*>>()
    private val seq = AtomicInteger(0)
    private val pool = Executors.newScheduledThreadPool(2) { r ->
        Thread(r, "dsh-schedule").apply { isDaemon = true }
    }

    /** 坏记录隔离区（只读展示，绝不参与调度） */
    private val quarantined = CopyOnWriteArrayList<JSONObject>()

    /**
     * 会话写入器。由 SchedulePlugin 在 onLoad 时用 `session.store` 服务接上
     * （见 [attachDelivery]）。为 null 时退化为旧的事件通道，但仍然不删行。
     */
    @Volatile
    private var delivery: ScheduleDelivery? = null

    init {
        dir.mkdirs()
        live = this
        load()
    }

    /* ---------------- 装配 ---------------- */

    /**
     * 接上会话投递。可重复调用（插件重载/服务重建都安全）。
     * @param d 由持有唯一 SessionStore 实例的一方构造，避免两个 SessionStore
     *          各持一把写锁并发写同一个 .jsonl。
     */
    fun attachDelivery(d: ScheduleDelivery) {
        delivery = d
        log("schedule 已接上会话投递")
    }

    fun hasDelivery(): Boolean = delivery != null

    /* ---------------- 持久化 ---------------- */

    private fun load() {
        val result = runCatching { store.load() }.getOrElse { e ->
            // 整体损坏/版本不认识：保持原文件不动，只报告。绝不覆盖用户数据。
            log("schedule 读取失败（原文件保持不变）：${e.message}")
            return
        }
        result.records.forEach { rec ->
            records[rec.id] = rec
            if (rec.active) arm(rec)
            // 启动装载也同步一次账本：进程不在时错过的状态（active/overdue/ended）要在这时对齐
            runCatching { onChanged(rec.toView(clock.nowMillis())) }
        }
        quarantined.addAll(result.quarantined)
        if (result.migrated) {
            log("schedule.json 已从 v1 迁移到 v${ScheduleStore.VERSION}")
            persist()
        }
        val overdue = result.records.count { it.active && it.scheduledAt <= clock.nowMillis() }
        if (overdue > 0) {
            // 如实记录：这些是进程不在时错过的，不是「准时发生」的
            log("schedule 载入：$overdue 条已过期，将各补发最近一次")
        }
    }

    @Synchronized
    private fun persist() {
        runCatching { store.save(records.values) }
            .onFailure { log("schedule 写入失败：${it.message}") }
    }

    /* ---------------- 对外操作 ---------------- */

    /** 创建。校验失败抛 [ScheduleException]（code 稳定，调用方按 code 路由）。 */
    fun create(title: String, prompt: String, rule: JSONObject, sessionId: String): JSONObject {
        val t = ScheduleRule.validateTitle(title)
        val p = ScheduleRule.validatePrompt(prompt)
        val now = clock.nowMillis()
        val parsed = ScheduleRule.parse(rule, now)
        val id = newId()
        val rec = ScheduleRecord(
            id = id,
            kind = parsed.kind,
            title = t,
            prompt = p,
            sessionId = sessionId,
            createdAt = now,
            rule = parsed.rule,
            scheduledAt = parsed.scheduledAt,
            state = ScheduleRecord.STATE_ACTIVE,
            lastDelivery = null,
            deliveryHistory = emptyList(),
            earlierRecordsUnavailable = true,
            earlierRecordsPruned = false,
            missedRuns = 0,
        )
        records[id] = rec
        persist()
        arm(rec)
        log(
            "schedule create $id kind=${rec.kind} @ " +
                ScheduleRule.formatIso(rec.scheduledAt, ScheduleRule.zoneOf(rec.rule)),
        )
        runCatching { onChanged(rec.toView(now)) }
        return rec.toView(now)
    }

    /**
     * 修改。`expected` 是编辑前从 `schedule_list` 拿到的完整记录（桌面同款 CAS）：
     * 传了就做冲突检测；不传则跳过（调用方可据此标 `cas: skipped`，不假装有并发保护）。
     */
    fun update(id: String, patch: JSONObject, expected: JSONObject? = null): JSONObject {
        val rec = records[id]
            ?: throw ScheduleException(ScheduleException.NOT_FOUND, "没有这个定时任务：$id")
        if (!rec.active) {
            throw ScheduleException(
                ScheduleException.ENDED,
                "这条定时任务已经结束（state=inactive），请新建一条",
            )
        }
        expected?.let { exp ->
            val conflict = casConflict(rec, exp)
            if (conflict != null) {
                throw ScheduleException(
                    ScheduleException.CONFLICT,
                    "这条任务在你编辑期间被改过（$conflict），请重新 schedule_list 后再改",
                )
            }
        }
        val title = if (patch.has("title")) {
            ScheduleRule.validateTitle(patch.optString("title"))
        } else {
            rec.title
        }
        val prompt = if (patch.has("prompt")) {
            ScheduleRule.validatePrompt(patch.optString("prompt"))
        } else {
            rec.prompt
        }
        val now = clock.nowMillis()
        // 只有真的要换规则时才重算目标；同规则改名/改内容不重置 scheduledAt（桌面语义）
        val newParsed = if (hasSelector(patch)) ScheduleRule.parse(patch, now) else null
        val updated = rec.copy(
            title = title,
            prompt = prompt,
            kind = newParsed?.kind ?: rec.kind,
            rule = newParsed?.rule ?: rec.rule,
            scheduledAt = newParsed?.scheduledAt ?: rec.scheduledAt,
        )
        records[id] = updated
        persist()
        arm(updated)
        runCatching { onChanged(updated.toView(now)) }
        return updated.toView(now)
    }

    fun delete(id: String): Boolean {
        timers.remove(id)?.cancel(false)
        val removed = records.remove(id) != null
        if (removed) {
            persist()
            runCatching { onRemoved(id) }
        }
        return removed
    }

    /** 列表：活动 + 已结束 + 隔离区坏条目，都如实列出来 */
    fun list(): JSONArray {
        val now = clock.nowMillis()
        return JSONArray().apply {
            records.values
                .sortedWith(compareBy({ !it.active }, { it.scheduledAt }))
                .forEach { put(it.toView(now)) }
            quarantined.forEach { bad ->
                put(JSONObject().apply {
                    put("id", bad.optString("id"))
                    put("state", "invalid")
                    put("title", bad.optString("title"))
                    put("error", "这条记录无法解码，已隔离，未参与调度；原文件未删除")
                })
            }
        }
    }

    fun get(id: String): JSONObject? = records[id]?.toView(clock.nowMillis())

    fun count(): Int = records.size

    /** 供设置页/诊断展示 */
    fun describe(): JSONObject = JSONObject().apply {
        put("backend", "device")
        put("timingGuarantee", ScheduleRecord.TIMING_INEXACT)
        put("total", records.size)
        put("active", records.values.count { it.active })
        put("inactive", records.values.count { !it.active })
        put("quarantined", quarantined.size)
        put("deliveryWired", delivery != null)
        put("file", file.absolutePath)
    }

    /* ---------------- 定时与触发 ---------------- */

    private fun arm(rec: ScheduleRecord) =
        armFor(rec, (rec.scheduledAt - clock.nowMillis()).coerceAtLeast(0))

    private fun armFor(rec: ScheduleRecord, delayMs: Long) {
        timers.remove(rec.id)?.cancel(false)
        if (!rec.active) return
        val fut = pool.schedule({
            runCatching { fire(rec.id) }.onFailure { e ->
                log("schedule 触发失败 ${rec.id}：${e.message}")
                retry(rec.id)
            }
        }, delayMs, TimeUnit.MILLISECONDS)
        timers[rec.id] = fut
    }

    private fun retry(id: String) {
        val rec = records[id] ?: return
        if (!rec.active) return
        armFor(rec, RETRY_DELAY_MS)
    }

    /**
     * 到点处理。三个入口都会走到这里（进程内定时器 / 开机补发 / 闹钟唤醒），
     * 所以必须幂等且可重入安全。
     */
    @Synchronized
    private fun fire(id: String) {
        val rec = records[id] ?: return
        if (!rec.active) return
        val now = clock.nowMillis()
        if (rec.scheduledAt > now) {
            // 时钟回拨或重复唤醒：还没到点，重新排上
            arm(rec)
            return
        }
        // 幂等：这个目标时刻已经投递过，只推进，不重复送达
        if (rec.isDeliveredForCurrentTarget()) {
            advanceWithoutDelivery(rec)
            return
        }

        val d = delivery
        val result: DeliveryOutcome = if (d != null) {
            val r = d.deliver(rec)
            // 写进会话 ≠ 用户知道了：成功投递后还要把「到点」通知给前端，
            // 否则会话日志里有提醒、界面上却没有任何反应（用户实测）。
            // delivered=true 告诉前端别再把 prompt 当普通用户消息重发一遍。
            if (r.ok) runCatching {
                onDue(JSONObject().apply {
                    put("id", rec.id)
                    put("title", rec.title)
                    put("prompt", rec.prompt)
                    put("sessionId", rec.sessionId)
                    put("scheduledAt", rec.scheduledAt)
                    put("delivered", true)
                    put("text", d.buildText(rec))
                })
            }
            DeliveryOutcome(r.ok, r.deliveredAt, r.messageId, r.reason)
        } else {
            // 没有会话写入器（插件被禁用/服务未装配）：只发事件，且**不删行**
            runCatching {
                onDue(JSONObject().apply {
                    put("id", rec.id)
                    put("title", rec.title)
                    put("prompt", rec.prompt)
                    put("sessionId", rec.sessionId)
                    put("scheduledAt", rec.scheduledAt)
                })
                DeliveryOutcome(true, now, "event-${rec.id}-${rec.scheduledAt}", null)
            }.getOrElse { e ->
                DeliveryOutcome(false, now, null, e.message)
            }
        }

        if (result.ok) {
            // 周期任务推进到「严格未来」的下一次；一次性任务转 inactive（行保留）
            val nextAt = if (rec.kind.periodic) ScheduleRule.nextAfter(rec.rule, now) else null
            val updated = rec.afterDelivery(
                deliveredAt = result.deliveredAt,
                messageId = result.messageId ?: "sched-${rec.id}-${rec.scheduledAt}",
                deliveredTarget = rec.scheduledAt,
                nextAt = nextAt,
            )
            records[id] = updated
            persist()
            if (updated.active) arm(updated)
            runCatching { onChanged(updated.toView(now)) }
            log(
                "schedule 投递 ${updated.id} -> session=${rec.sessionId} " +
                    "state=${updated.state} next=${if (updated.active) updated.scheduledAt else "-"}",
            )
        } else {
            // 失败：保留任务与 prompt，累计错过次数，稍后重试
            val updated = rec.afterDeliveryFailure()
            records[id] = updated
            persist()
            armFor(updated, RETRY_DELAY_MS)
            runCatching { onChanged(updated.toView(now)) }
            log(
                "schedule 投递失败 ${rec.id}（${result.reason}），保持 active，" +
                    "${RETRY_DELAY_MS}ms 后重试",
            )
        }
    }

    /** 已投递过同一目标：只推进状态，绝不二次送达 */
    private fun advanceWithoutDelivery(rec: ScheduleRecord) {
        val now = clock.nowMillis()
        val nextAt = if (rec.kind.periodic) ScheduleRule.nextAfter(rec.rule, now) else null
        val updated = if (nextAt != null) {
            rec.copy(state = ScheduleRecord.STATE_ACTIVE, scheduledAt = nextAt)
        } else {
            rec.copy(state = ScheduleRecord.STATE_INACTIVE)
        }
        records[rec.id] = updated
        persist()
        if (updated.active) arm(updated)
        runCatching { onChanged(updated.toView(now)) }
    }

    fun shutdown() {
        timers.values.forEach { runCatching { it.cancel(false) } }
        timers.clear()
        runCatching { pool.shutdownNow() }
        if (live === this) live = null
    }

    /* ---------------- 内部小工具 ---------------- */

    private fun newId(): String = "sch-${seq.incrementAndGet()}-${clock.nowMillis() % 100000}"

    private fun hasSelector(o: JSONObject): Boolean =
        SELECTORS.any { o.has(it) && !o.isNull(it) }

    /** CAS：编辑前的记录与当前记录不一致就报冲突，并指出哪一项变了 */
    private fun casConflict(current: ScheduleRecord, expected: JSONObject): String? {
        val expScheduled = expected.optLong("scheduledAt", -1L)
        if (expScheduled != -1L && expScheduled != current.scheduledAt) {
            return "scheduledAt ${expScheduled} -> ${current.scheduledAt}"
        }
        val expState = expected.optString("state")
        if (expState.isNotBlank() && expState != current.state) {
            return "state $expState -> ${current.state}"
        }
        val expTitle = expected.optString("title")
        if (expTitle.isNotBlank() && expTitle.trim() != current.title) {
            return "title 已被改成「${current.title}」"
        }
        return null
    }

    private class DeliveryOutcome(
        val ok: Boolean,
        val deliveredAt: Long,
        val messageId: String?,
        val reason: String?,
    )

    companion object {
        /** 投递失败后的重试间隔。手机端没有宿主进程，只能靠进程内重试 + 下次启动补发。 */
        const val RETRY_DELAY_MS = 60_000L

        val SELECTORS = listOf("after_seconds", "every_seconds", "at", "daily", "weekly", "cron")

        /** 当前存活的注册表实例（开机 receiver 用它判断进程是否活着） */
        @Volatile
        private var live: ScheduleRegistry? = null

        fun live(): ScheduleRegistry? = live
    }
}
