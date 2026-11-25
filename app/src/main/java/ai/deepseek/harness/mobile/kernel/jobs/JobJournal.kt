package ai.deepseek.harness.mobile.kernel.jobs

import org.json.JSONArray
import org.json.JSONObject

/**
 * 后台任务的生命周期记账 —— 桌面 `job/registered` + `job/settled` 的手机端等价物。
 *
 * 桌面为什么不持久化"执行"、只持久化"记录"（`packages/jobs/jobs/README.zh.md`）：
 * 运行期执行与输出环本来就在进程里，进程死了就是死了；但有价值的是**它曾经存在过、
 * 以及最后怎么了**。有了这两条记录，重开 App 才能说清"上一轮那个任务是被系统杀了，
 * 不是跑完了"，而不是一片空白。
 *
 * 这里刻意不虚构 `ended_at`：没有 `job/settled` 的区间就是不完整的（桌面文档原文：
 * "缺少 job/settled 的区间仍不完整；消费方不得虚构结束时间戳"）。
 */
object JobJournal {

    const val EVENT_REGISTERED = "job/registered"
    const val EVENT_SETTLED = "job/settled"

    fun registeredPayload(job: JobRegistry.Job): JSONObject = JSONObject().apply {
        put("job_id", job.id)
        put("name", job.name)
        put("owner", job.owner)
        put("started_at", job.startedAt)
        put("producer", "thread")
    }

    fun settledPayload(job: JobRegistry.Job): JSONObject = JSONObject().apply {
        put("job_id", job.id)
        put("name", job.name)
        put("owner", job.owner)
        put("status", job.status)
        put("exit_code", job.exitCode ?: JSONObject.NULL)
        put("started_at", job.startedAt)
        put("ended_at", job.endedAt)
        // 生产方自己报告了终态才算 producer_reported；被强制 destroy 的是 false
        put("producer_reported", job.status == "done" || job.status == "failed")
        put("retained_chars", job.retainedChars())
    }

    /**
     * 从会话事件文本里找出「注册了但没有结算」的任务。
     *
     * @param events 会话日志事件（按时间顺序）
     * @return 每个孤儿一条：`{job_id, name, started_at, started_at_text, status:"orphaned", detail}`
     */
    fun orphans(events: List<JSONObject>): JSONArray {
        val registered = LinkedHashMap<String, JSONObject>()
        val settled = HashSet<String>()
        events.forEach { ev ->
            when (ev.optString("type")) {
                EVENT_REGISTERED -> {
                    val id = ev.optString("job_id")
                    if (id.isNotBlank()) registered[id] = ev
                }

                EVENT_SETTLED -> settled.add(ev.optString("job_id"))
            }
        }
        return JSONArray().apply {
            registered.forEach { (id, ev) ->
                if (id in settled) return@forEach
                put(JSONObject().apply {
                    put("job_id", id)
                    put("name", ev.optString("name"))
                    put("started_at", ev.optLong("started_at"))
                    put("status", "orphaned")
                    put(
                        "detail",
                        "进程在该任务结算前被终止：它没有跑完，输出也不可恢复。" +
                            "没有结束时间不是遗漏 —— 是真没有结算记录，不虚构。",
                    )
                })
            }
        }
    }
}
