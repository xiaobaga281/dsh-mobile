package ai.deepseek.harness.mobile.kernel.jobs

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * 后台任务注册表 —— 桌面 `ctx.jobs` 的手机端等价物。
 *
 * 本次改动（WP5）：
 *  1. **输出环改成绝对偏移 + lossy**（照抄本仓 `TerminalRegistry.Session` 已验证的实现）。
 *     旧实现只有一个 `StringBuilder` + `output().take(12_000)`：模型拿到的是
 *     "最后 64KB 里的头部 12k"，既不是最新输出也不是开头，而且无法增量读取。
 *     现在 `job_output` 支持 `offset`，读过的位置不会丢，超出保留窗口的读返回
 *     `lossy=true` 而不是假装读到。
 *  2. **生命周期写回 owner 会话**（`job/registered` / `job/settled`）。
 *     桌面持久化的就是这个（执行本身是进程本地的，桌面也一样）。
 *     有了它，进程被杀后重开才能说清"上次那个任务没有结算"，而不是一片空白。
 *  3. **每次 owner 的并发上限**（桌面 `maxConcurrentJobsPerOwner=10`），
 *     防止模型开一堆后台任务把手机拖死。
 *
 * 仍然如实承认：**执行本身不跨进程**。桌面 `packages/jobs/jobs/README.zh.md` 明确
 * "任务只存在于进程本地……持久或跨重启执行需要一个单独实现该 seam 的后端"。
 * 手机端不做"跨进程 job"（那是桌面也没做的事），只保证死亡可追溯。
 */
class JobRegistry(
    private val log: (String) -> Unit = {},
    /** 任务结束时回调：桌面 job 完成会注入一条后台完成通知，这里交给内核 emit 事件 */
    private val onDone: (Job) -> Unit = {},
    /** 任务开始回调：前端据此立刻把「进行中」的 Mission 卡/带亮出来，不用等下一次轮询 */
    private val onStart: (Job) -> Unit = {},
) {

    /**
     * 生命周期记账出口，形如 `(ownerSessionId, eventType, payload) -> Unit`。
     * 由持有唯一 SessionStore 实例的一方注入（TerminalPlugin 用 `session.store` 接上），
     * 为 null 时只保留内存态 —— 不假装已落盘。
     */
    @Volatile
    private var journal: ((String, String, JSONObject) -> Unit)? = null

    /**
     * 归属会话兜底：调用方没显式传 owner 时（如 `bash run_in_background` 的现有调用点
     * 不在本 WP 的写范围内），用当前轮次的会话 id 归属。
     * 必须是「start() 那一刻」取值 —— 后台线程稍后再取会拿到别的会话。
     */
    @Volatile
    private var ownerProvider: (() -> String)? = null

    /** 接上记账。可重复调用（插件重载安全）。 */
    fun attachJournal(
        sink: (String, String, JSONObject) -> Unit,
        owner: (() -> String)? = null,
    ) {
        journal = sink
        if (owner != null) ownerProvider = owner
        log("job 已接上生命周期记账")
    }

    fun hasJournal(): Boolean = journal != null

    class Job(
        val id: String,
        val name: String,
        val owner: String = "",
        val startedAt: Long = System.currentTimeMillis(),
    ) {
        @Volatile var status: String = "running"      // running | done | failed | killed
        @Volatile var endedAt: Long = 0
        @Volatile var exitCode: Int? = null
        /** 有存活的 wait 正在等它：结算时跳过完成通知（结果已经由 waiter 收走） */
        @Volatile var awaited: Boolean = false
        /** 模型自己发起的 job_kill：结算时不再回一条「已完成」通知 */
        @Volatile var killRequested: Boolean = false
        /** 结算时要不要唤醒归属会话：由 WakeRouter 的入队结果决定（单一唤醒路径） */
        @Volatile var completionNotice: String = ""
        /**
         * 这个任务「是怎么来的」：命令、工作目录、说明。
         * 记账本是为了进程重启之后仍然谈得上「重新跑一次」—— 那时闭包早没了，
         * 只有参数文本留得下来。没有它（比如内部任务）就不该在界面上给重跑按钮。
         */
        @Volatile var spec: JSONObject? = null
        /** 任务自己注册的「硬终止」：光 interrupt 杀不掉已派生的子进程（shell 里的孙进程） */
        @Volatile var cancel: (() -> Unit)? = null

        private val buffer = StringBuilder()
        /** 已被环形缓冲裁掉的历史字符数：对外 offset 按「任务开始」的绝对偏移解释 */
        @Volatile private var dropped: Long = 0
        /** 消耗式读游标（桌面 `read` 消耗 / `readAt` 非消耗） */
        @Volatile var cursor: Int = 0
            private set

        @Synchronized fun append(text: String) {
            if (text.isEmpty()) return
            buffer.append(text)
            if (buffer.length > RETAIN_CHARS) {
                val cut = buffer.length - RETAIN_CHARS
                buffer.delete(0, cut)
                dropped += cut
            }
        }

        @Synchronized fun length(): Int = (dropped + buffer.length).toInt()

        @Synchronized fun retainedChars(): Int = buffer.length

        @Synchronized fun droppedChars(): Int = dropped.toInt()

        @Synchronized fun truncatedBefore(offset: Int): Boolean = offset.toLong() < dropped

        /** 从绝对偏移读到底。count<=0 表示读全部剩余。 */
        @Synchronized fun slice(offset: Int, count: Int = 0): String {
            val startLong = offset.toLong() - dropped
            if (startLong >= buffer.length) return ""
            val start = if (startLong < 0) 0 else startLong.toInt()
            val end = if (count <= 0) buffer.length else (start + count).coerceAtMost(buffer.length)
            if (start >= end) return ""
            return buffer.substring(start, end)
        }

        /** 全量视图（会因保留窗口而只剩尾部；给 list/诊断用） */
        @Synchronized fun output(): String = buffer.toString()

        /** 非消耗式读：从 from 读到当前末尾（桌面 `readAt`） */
        fun readAt(from: Int): ReadResult {
            val effective = maxOf(from, droppedChars())
            return ReadResult(
                text = slice(effective, 0),
                from = from,
                next = length(),
                lossy = truncatedBefore(from),
            )
        }

        /** 消耗式读：从游标读到末尾并推进游标（桌面 `read`） */
        @Synchronized fun readConsuming(): ReadResult {
            val from = cursor
            val effective = maxOf(from, droppedChars())
            val text = slice(effective, 0)
            val next = length()
            cursor = next
            return ReadResult(text, from, next, truncatedBefore(from))
        }

        /**
         * 结算后裁剪到较小的保留量，但**绝不低于未被消费的输出** ——
         * 桌面原文："保留模型游标尚未消费的字节数"。否则模型还没读的那段就没了。
         *
         * 注意这里算的是「游标之后还剩多少」，不是「游标之前消费了多少」：
         * 写反了就会在模型一个字都没读的情况下把全部输出裁掉（这正是本方法初版的 bug）。
         */
        @Synchronized fun trimAfterSettle() {
            val consumedInBuffer = (cursor.toLong() - dropped)
                .coerceIn(0L, buffer.length.toLong())
                .toInt()
            val unconsumed = buffer.length - consumedInBuffer
            val keep = maxOf(SETTLED_RETAIN_CHARS, unconsumed)
            if (buffer.length > keep) {
                val cut = buffer.length - keep
                buffer.delete(0, cut)
                dropped += cut
            }
        }
    }

    /** 一次读的结果：`lossy` 表示 from 之前的输出已被丢弃，不是"没有输出" */
    class ReadResult(
        val text: String,
        val from: Int,
        val next: Int,
        val lossy: Boolean,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("output", text)
            put("offset", from)
            put("next_offset", next)
            put("lossy", lossy)
            put("chars", text.length)
        }
    }

    private val jobs = ConcurrentHashMap<String, Job>()
    private val seq = AtomicInteger(0)
    private val threads = ConcurrentHashMap<String, Thread>()

    /**
     * 启动后台任务。`ownerSession` 是记账用的归属会话；空串表示无主（与桌面"共享无主桶"同义）。
     * `spec` 是「怎么来的」（command/workdir/description 等），只为留进 Mission 账本支持重跑，
     * 执行本身仍由 [block] 决定 —— 不在这里猜该怎么跑。
     */
    fun start(
        name: String,
        ownerSession: String = "",
        spec: JSONObject? = null,
        block: (Job) -> Int,
    ): Job {
        // 归属：显式传入优先；否则取 start() 这一刻的当前会话（调用点都在 agent 轮次内，
        // 背景线程稍后再取就会拿到别的会话，所以必须在这里定下来）
        val owner = ownerSession.ifBlank {
            runCatching { ownerProvider?.invoke() ?: "" }.getOrDefault("")
        }
        val running = jobs.values.count { it.status == "running" && it.owner == owner }
        if (running >= MAX_JOBS_PER_OWNER) {
            throw IllegalStateException(
                "该会话已有 $running 个后台任务在跑（上限 $MAX_JOBS_PER_OWNER）。" +
                    "先 job_kill 停掉不用的，或用 job_output 收掉已完成的。",
            )
        }
        val id = "job-${seq.incrementAndGet()}-${System.currentTimeMillis() % 100000}"
        val job = Job(id, name.ifBlank { "background" }, owner)
        job.spec = spec
        jobs[id] = job
        runCatching { onStart(job) }
        // 没有 owner 就没有可写的会话（不能往 "" 里写），此时只保留内存态，不假装落盘
        if (owner.isNotBlank()) {
            runCatching {
                journal?.invoke(owner, JobJournal.EVENT_REGISTERED, JobJournal.registeredPayload(job))
            }
        }
        val t = Thread({
            try {
                val code = block(job)
                job.exitCode = code
                job.status = if (job.status == "killed") "killed" else if (code == 0) "done" else "failed"
            } catch (e: InterruptedException) {
                job.status = "killed"
                job.append("\n[已终止]")
            } catch (t2: Throwable) {
                job.status = "failed"
                job.append("\n[异常] ${t2.message ?: t2.javaClass.simpleName}")
            } finally {
                job.endedAt = System.currentTimeMillis()
                job.trimAfterSettle()
                threads.remove(id)
                log("job $id ${job.status}")
                // 先记账再通知：记录先于通知，崩溃时至少能看出「它结束了但没通知到」
                if (owner.isNotBlank()) {
                    runCatching {
                        journal?.invoke(owner, JobJournal.EVENT_SETTLED, JobJournal.settledPayload(job))
                    }
                }
                // 完成通知入队：有活体 wait 在等（awaited）或模型自己杀停时不再打扰。
                // 入队发生在 onDone 之前，前端收到事件后可直接 drain 并唤醒空闲会话。
                // 完成正文由 WakeRouter 统一入队（Step 2）——这里只把文案备好，
                // 不在这里另开第二条唤醒路径。
                if (owner.isNotBlank() && !job.awaited && !job.killRequested) {
                    job.completionNotice = completionText(job)
                }
                runCatching { onDone(job) }
            }
        }, "dsh-job-$id").apply { isDaemon = true }
        threads[id] = t
        t.start()
        return job
    }

    fun get(id: String): Job? = jobs[id]

    fun list(): JSONArray = JSONArray().apply {
        jobs.values.sortedByDescending { it.startedAt }.forEach { j ->
            put(JSONObject().apply {
                put("job_id", j.id)
                put("name", j.name)
                put("owner", j.owner)
                put("status", j.status)
                put("started_at", j.startedAt)
                put("ended_at", j.endedAt)
                put("exit_code", j.exitCode ?: JSONObject.NULL)
                put("retained_chars", j.retainedChars())
                put("dropped_chars", j.droppedChars())
                put("next_offset", j.length())
                put("cursor", j.cursor)
            })
        }
    }

    /** 非消耗式读（桌面 `readAt`）：重复读同一偏移结果一致 */
    fun readAt(id: String, from: Int): ReadResult? = jobs[id]?.readAt(from)

    /** 消耗式读（桌面 `read`）：读过的部分下次不会再给 */
    fun readConsuming(id: String): ReadResult? = jobs[id]?.readConsuming()

    /**
     * 等待到结束或超时（超时不杀任务，与桌面一致）。
     *
     * 有活体 wait 时先把 `awaited` 立起来：任务在等待期间结算，就不再投递完成通知
     * ——结果已经由这次 wait 的调用方拿走，再通知等于重复。等待超时则撤回标记，
     * 让之后真正的结算照常入队。
     */
    fun await(id: String, timeoutMs: Long): Job? {
        val j = jobs[id] ?: return null
        if (j.status != "running") return j
        j.awaited = true
        try {
            val deadline = System.currentTimeMillis() + timeoutMs.coerceIn(0, MAX_WAIT_MS)
            while (j.status == "running" && System.currentTimeMillis() < deadline) {
                Thread.sleep(120)
            }
        } finally {
            if (j.status == "running") j.awaited = false
        }
        return j
    }

    /** @param byModel 模型自己发起的 kill：不投递完成通知（它已经知道结果） */
    fun kill(id: String, byModel: Boolean = false): Boolean {
        val j = jobs[id] ?: return false
        if (j.status != "running") return false
        if (byModel) j.killRequested = true
        j.status = "killed"
        // 先硬终止真实进程（含孙进程），再打断等待中的线程：
        // 原来只 interrupt，线程被标记 killed 了，Process 却还在跑，`job_kill` 等于撒谎
        runCatching { j.cancel?.invoke() }
        threads.remove(id)?.interrupt()
        return true
    }

    private fun completionText(job: Job): String {
        val ms = (job.endedAt - job.startedAt).coerceAtLeast(0)
        val secs = (ms / 100).toLong() / 10.0
        val exit = job.exitCode?.let { " · exit=$it" }.orEmpty()
        return "[后台任务完成] ${job.name}（${job.id}）\n" +
            "状态：${job.status}$exit · 用时 ${secs}s\n" +
            "用 job_output(job_id=\"${job.id}\") 读取完整输出后再继续；不要假设结果已经在这里。"
    }

    companion object {
        /** 运行期保留量（桌面 retainBytes 默认 262144 字节，这里按字符近似） */
        const val RETAIN_CHARS = 256 * 1024
        /** 结算后保留量（桌面 settledRetainBytes 默认 16384） */
        const val SETTLED_RETAIN_CHARS = 16 * 1024
        /** 每 owner 并发上限（桌面 maxConcurrentJobsPerOwner 默认 10） */
        const val MAX_JOBS_PER_OWNER = 10
        const val MAX_WAIT_MS = 600_000L
    }
}
