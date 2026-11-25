package ai.deepseek.harness.mobile.kernel.mission

import ai.deepseek.harness.mobile.agent.SessionStore
import ai.deepseek.harness.mobile.kernel.jobs.JobRegistry
import org.json.JSONArray
import org.json.JSONObject

/**
 * 证据正文的组装器：账本里只存引用（type + ref + at），正文按引用回到
 * 会话日志 / job 注册表 / 唤醒队列里现取。
 *
 * 为什么不把正文抄进账本：`missions.json` 每次状态迁移都整文件重写，
 * 把 job 输出、投递正文这类大字段存进去，等于每次落盘重搬一遍旧数据；
 * 而会话日志本身就是 append-only 的事实源，引用已经足够定位它。
 * 同一条引用在进程重启后取不到正文时，也如实说「取不到」，不编一段摘要。
 */
class MissionEvidence(
    private val missions: MissionRegistry,
    private val sessions: SessionStore,
    private val jobs: JobRegistry,
    private val wakes: WakeRouter,
    private val clipChars: Int = 400,
) {

    /** 抽屉与导出都用这份：账本引用 + 现取的正文摘要。 */
    @Synchronized
    fun view(missionId: String): JSONArray {
        val m = missions.get(missionId) ?: return JSONArray()
        val log = loadLog(m.optString("sessionId"))
        val evidence = m.optJSONArray("evidence") ?: JSONArray()
        val out = JSONArray()
        for (i in 0 until evidence.length()) {
            val e = evidence.optJSONObject(i) ?: continue
            val item = JSONObject(e.toString())
            val title = e.optString("title")
            item.put("title", if (title.isBlank()) label(e.optString("type")) else title)
            item.put("text", textOf(e, log))
            item.put("kindLabel", label(e.optString("type")))
            out.put(item)
        }
        return out
    }

    /** 一条 Mission 的完整详情：状态 + 权限范围 + 时间线 + 证据。 */
    @Synchronized
    fun detail(missionId: String): JSONObject {
        val m = missions.get(missionId) ?: return JSONObject()
        return JSONObject().apply {
            put("mission", m)
            put("evidence", view(missionId))
            put("timeline", timeline(m))
        }
    }

    fun markdown(missionId: String): String {
        val d = detail(missionId)
        val m = d.optJSONObject("mission") ?: return ""
        val sb = StringBuilder()
        sb.append("# Mission ").append(m.optString("id")).append("\n\n")
        sb.append("- 标题：").append(m.optString("title")).append("\n")
        sb.append("- 来源：").append(kindLabel(m.optString("kind"))).append(" · ").append(m.optString("sourceId")).append("\n")
        sb.append("- 状态：").append(stateLabel(m.optString("state"), m.optString("outcome"))).append("\n")
        sb.append("- 唤醒策略：").append(wakeLabel(m.optString("wakePolicy"))).append("\n")
        m.optJSONObject("permissionScope")?.let { s ->
            val grants = s.optJSONArray("grants")
            sb.append("- 权限范围：").append(permLabel(s.optString("mode")))
            if (grants != null && grants.length() > 0) sb.append(" · 已允许 ").append(
                (0 until grants.length()).joinToString("/") { grants.optString(it) },
            )
            sb.append("\n")
        }
        sb.append("\n## 时间线\n\n")
        val tl = d.optJSONArray("timeline") ?: JSONArray()
        for (i in 0 until tl.length()) {
            val t = tl.optJSONObject(i) ?: continue
            sb.append("- ").append(t.optString("label")).append("：").append(t.optString("text")).append("\n")
        }
        sb.append("\n## 证据\n\n")
        val ev = d.optJSONArray("evidence") ?: JSONArray()
        if (ev.length() == 0) sb.append("（无）\n")
        for (i in 0 until ev.length()) {
            val e = ev.optJSONObject(i) ?: continue
            val title = e.optString("title")
            val label = e.optString("kindLabel")
            // 「任务输出 · 任务输出」这种重复标题是噪声：同名就只留一次
            val head = if (title.isBlank() || title == label) label.ifBlank { title } else "$label · $title"
            sb.append("### ").append(head).append("\n\n")
            sb.append("- 时间：").append(atText(e.optLong("at"))).append("\n")
            sb.append("- 引用：`").append(e.optString("ref")).append("`\n\n")
            val text = e.optString("text")
            if (text.isNotBlank()) sb.append("```\n").append(text).append("\n```\n\n")
        }
        return sb.toString()
    }

    /* ---------------- 取正文 ---------------- */

    private fun textOf(e: JSONObject, log: List<JSONObject>): String {
        val type = e.optString("type")
        val ref = e.optString("ref")
        return when (type) {
            "job-output" -> jobText(ref, log)
            "rerun" -> "新任务 $ref：" + jobText(ref, log)
            "schedule-delivery" -> deliveryText(ref, log)
            "tool" -> toolText(ref, log)
            "approval" -> approvalText(ref, e, log)
            "deliverable" -> deliverableText(ref, log)
            "wake" -> wakeText(ref)
            else -> e.optString("title")
        }.let { if (it.isBlank()) "" else clip(it) }
    }

    /** 活体任务读内存环；进程重启后只能回到会话日志里的 job/settled 记账。 */
    private fun jobText(jobId: String, log: List<JSONObject>): String {
        jobs.get(jobId)?.let { j ->
            val out = j.output()
            val head = "status=${j.status} · exit=${j.exitCode ?: "-"} · 用时 ${(j.endedAt - j.startedAt) / 1000}s"
            return if (out.isBlank()) head else "$head\n$out"
        }
        val settled = log.lastOrNull { it.optString("type") == "job/settled" && it.optString("job_id") == jobId }
        if (settled != null) {
            val ret = settled.optLong("retained_chars")
            return "已结束：status=${settled.optString("status")} · exit=${settled.opt("exit_code")} · 输出 $ret 字符" +
                "（输出环随进程一起结束，完整正文当时已由 Agent 用 job_output 读过并留在会话里）"
        }
        val registered = log.lastOrNull { it.optString("type") == "job/registered" && it.optString("job_id") == jobId }
        return if (registered == null) "取不到正文：日志里没有这个任务的记账"
        else "已注册但未见结算记录（进程被回收的痕记，不假装跑完了）"
    }

    private fun deliveryText(messageId: String, log: List<JSONObject>): String {
        val hit = log.lastOrNull {
            it.optString("type") == "user/message" && it.optString("messageId") == messageId
        } ?: return "取不到正文：会话日志里没有这条投递（messageId=$messageId）"
        return SessionStore.visibleText(hit)
    }

    private fun toolText(callId: String, log: List<JSONObject>): String {
        val call = log.lastOrNull { it.optString("type") == "tool/call" && it.optString("id") == callId }
        val result = log.lastOrNull { it.optString("type") == "tool/result" && it.optString("id") == callId }
        val name = call?.optString("name").orEmpty().ifBlank { result?.optString("name").orEmpty() }
        val args = call?.optString("args").orEmpty()
        val sb = StringBuilder()
        if (name.isNotBlank()) sb.append(name)
        if (args.isNotBlank()) sb.append("  参数：").append(args)
        if (result == null) {
            if (sb.isEmpty()) sb.append("取不到结果：日志里没有这条调用")
            return sb.toString()
        }
        sb.append(if (sb.isEmpty()) "" else "\n").append(if (result.optBoolean("ok")) "成功" else "失败")
        val out = result.optString("output").ifBlank { result.optString("text") }
        if (out.isNotBlank()) sb.append("：").append(out)
        return sb.toString()
    }

    private fun approvalText(approvalId: String, e: JSONObject, log: List<JSONObject>): String {
        val decided = log.lastOrNull {
            it.optString("type") == "approval/decided" && it.optString("id") == approvalId
        }
        if (decided != null) {
            val scope = decided.optString("scope")
            return "${decided.optString("name")} · ${decisionLabel(scope)}" +
                (if (decided.optString("reason").isNotBlank()) " · ${decided.optString("reason")}" else "")
        }
        return e.optString("title").ifBlank { "取不到正文：日志里没有这条审批记录" }
    }

    private fun deliverableText(ref: String, log: List<JSONObject>): String {
        val hit = log.lastOrNull { it.optString("type") == "deliverables/presented" && it.optString("turn") == ref }
            ?: return "取不到正文：这一轮没有交付记录"
        val files = hit.optJSONArray("files") ?: JSONArray()
        if (files.length() == 0) return hit.optString("text")
        return (0 until files.length()).joinToString("\n") { f ->
            files.optJSONObject(f)?.optString("path").orEmpty().ifBlank { files.optJSONObject(f)?.optString("name").orEmpty() }
        }
    }

    private fun wakeText(wakeId: String): String {
        // 引用可能是「失败重投」那种带后缀的 id：取回原始记录，失败次数与原因都在上面
        val raw = wakeId.substringBefore("#fail-")
        val w = wakes.get(raw) ?: return "取不到正文：唤醒记录已被清理"
        val consumed = w.optLong("consumedAt", 0L)
        val policy = wakeLabel(w.optString("policy"))
        val fail = w.optString("failReason")
        val attempts = w.optInt("attempts", 0)
        val tail = if (fail.isNotBlank()) "（此前失败 $attempts 次：$fail）" else ""
        return if (consumed > 0L) "已由 $policy 在 ${atText(consumed)} 续了一轮$tail"
        else "$policy · 仍在队列里等空闲会话认领（${atText(w.optLong("createdAt"))} 入队）$tail"
    }

    /* ---------------- 时间线与标签 ---------------- */

    private fun timeline(m: JSONObject): JSONArray = JSONArray().apply {
        fun add(label: String, ts: Long) {
            if (ts > 0L) put(JSONObject().put("label", label).put("at", ts).put("text", atText(ts)))
        }
        add("创建", m.optLong("createdAt"))
        add("开始", m.optLong("startedAt"))
        add("结束", m.optLong("endedAt"))
        val next = m.optLong("nextAt", 0L)
        if (m.optString("state") == MissionRegistry.STATE_WAITING && next > 0L) {
            put(JSONObject().put("label", "下次执行").put("at", next).put("text", atText(next)))
        }
        put(
            JSONObject().put("label", "状态").put("text", stateLabel(m.optString("state"), m.optString("outcome"))),
        )
    }

    private fun loadLog(sessionId: String): List<JSONObject> =
        if (sessionId.isBlank()) emptyList() else runCatching { sessions.read(sessionId) }.getOrDefault(emptyList())

    private fun clip(s: String): String {
        val t = s.trim()
        return if (t.length <= clipChars) t else "…" + t.takeLast(clipChars)
    }

    private fun atText(ts: Long): String =
        if (ts <= 0L) "—" else java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.CHINA).format(java.util.Date(ts))

    private fun label(type: String): String = when (type) {
        "job-output" -> "任务输出"
        "rerun" -> "重新运行"
        "team-report" -> "成员汇报"
        "schedule-delivery" -> "到点投递"
        "tool" -> "工具调用"
        "approval" -> "审批记录"
        "deliverable" -> "交付物"
        "wake" -> "唤醒记录"
        else -> if (type.isBlank()) "记录" else type
    }

    private fun kindLabel(kind: String): String = when (kind) {
        "job" -> "后台任务"
        "schedule" -> "定时任务"
        "team" -> "团队任务"
        "pc" -> "电脑会话"
        else -> kind
    }

    private fun wakeLabel(p: String): String = when (p) {
        MissionRegistry.WAKE_IDLE_AUTO -> "空闲自动续轮"
        MissionRegistry.WAKE_QUEUE -> "排队等空闲"
        MissionRegistry.WAKE_NOTIFY -> "只发通知"
        MissionRegistry.WAKE_DEFER -> "不自动打扰"
        else -> p
    }

    private fun permLabel(mode: String): String = when (mode) {
        MissionRegistry.PERM_READONLY -> "只读"
        MissionRegistry.PERM_ASK, MissionRegistry.PERM_DEFAULT -> "标准（危险操作询问）"
        MissionRegistry.PERM_FULL -> "完全访问"
        else -> "跟随会话"
    }

    private fun stateLabel(state: String, outcome: String): String = when (state) {
        MissionRegistry.STATE_QUEUED -> "排队中"
        MissionRegistry.STATE_RUNNING -> "进行中"
        MissionRegistry.STATE_WAITING -> "等待中"
        MissionRegistry.STATE_SETTLED -> when (outcome) {
            MissionRegistry.OUTCOME_DONE -> "已结束 · 完成"
            MissionRegistry.OUTCOME_FAILED -> "已结束 · 失败"
            MissionRegistry.OUTCOME_CANCELLED -> "已结束 · 已终止"
            MissionRegistry.OUTCOME_INTERRUPTED -> "已结束 · 被中断（进程回收）"
            else -> "已结束"
        }
        else -> state
    }

    private fun decisionLabel(scope: String): String = when (scope) {
        "once" -> "允许一次"
        "always" -> "这件事内始终允许"
        "deny" -> "已拒绝"
        else -> "已确认"
    }
}
