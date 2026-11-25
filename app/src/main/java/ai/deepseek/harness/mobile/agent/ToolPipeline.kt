package ai.deepseek.harness.mobile.agent

import ai.deepseek.harness.mobile.kernel.Workspace
import ai.deepseek.harness.mobile.kernel.plugin.PluginRegistry
import ai.deepseek.harness.mobile.kernel.plugin.ToolCatalog
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * 工具执行流水线 —— 对应桌面 Harness 的 `tools/pre-execute → guards → execute → post-execute → finalize`。
 *
 * 与桌面同构的四段：
 *   pre-execute  钩子与审批：权限、计划模式、危险操作确认
 *   guards       单调守卫：命中即拒，后面的监听器无法翻案（只读插件、禁写模式）
 *   execute      真正执行；只读工具同批并发，写类工具做屏障串行
 *   post-execute 结果改写：超预算结果截断并落盘到 spill，回给模型一条「去哪读全文」的提示
 *
 * 结算契约（这一层最重要的不变量）：
 *   · **每个 call 恰好一条 [Outcome]**，顺序与模型给出的 calls 一致；成功结果永不丢弃。
 *   · **任何异常都不越过 [executeBatch]**：工具抛错、超时、被取消各落各的 code，同批其它结果照常返回。
 *   · **onEnd 每条恰好一次**：界面的 tool_end 不能因为「批里另一条超时」而少一条。
 *   · **超时是单次调用的**（[ai.deepseek.harness.mobile.kernel.plugin.ToolSpec.timeoutMs]），不是整批的：
 *     以前整批 `get(30s)`，一条慢调用把整轮打成失败，还连带丢掉同批已成功的结果。
 *
 * 内置行为工具（exit_plan_mode / update_goal / todo_write / web_search / subagent）不在这里实现，
 * 而是交给当轮注入的 [RuntimeTools]——它们需要会话级状态，等价于桌面 ctx 的服务注入。
 */
class ToolPipeline(
    private val registry: PluginRegistry,
    private val workspace: Workspace,
    private val hooks: HookBus,
    private val log: (String) -> Unit = {},
    /**
     * 执行池。默认取内核单例 [defaultPool]（[sharedToolPool] 兜底）——
     * 以前每个 ToolPipeline 自己 `newFixedThreadPool(4)` 且从不 shutdown，
     * 每轮新建一个驱动（含 subagent / 团队运行时）就多泄漏 4 个非 daemon 线程。
     */
    executor: ExecutorService? = null,
    /** spill 落点根（测试注入用）；默认内核注入的 filesDir/spill，拿不到就退回工作区 .dsh/spill */
    private val spillRoot: File? = null,
) {

    data class Call(val id: String, val name: String, val args: JSONObject)
    data class Outcome(
        val id: String,
        val name: String,
        val ok: Boolean,
        val output: String,
        val ms: Long,
        val denied: Boolean = false,
        val reason: String = "",
        /**
         * 结构化失败码（桌面 ToolResult.error.info.code 的手机端等价物）。
         * 模型看到的是 `Error: <message>`，界面与 session 日志用 code 区分
         * 是「工具自己报错」「参数不合法」「权限拒绝」「超时」还是「没派发」——
         * 以前全糊成一句话，回放时根本判断不出该改参数还是该换工具。
         */
        val code: String = "",
        /**
         * 命令退出码（旁路）：只有前台命令类工具会填，界面据此画徽标（0 灰 / 非 0 红）。
         *
         * 它是**这一次调用**的属性，随 [Outcome] 走；并发池里绝不能有「全局最后一次退出码」
         * 那种旁路字段 —— 同批两条 bash 会互相串号。
         */
        val exitCode: Int? = null,
    )

    /** 会话级能力注入：由 Driver 每轮提供一个实例 */
    interface RuntimeTools {
        fun presentPlan(title: String, plan: String): String
        fun markGoal(status: String, summary: String): String
        /** 按推进阶段改写目标（update_goal(action=edit)）；返回给模型看的确认语 */
        fun editGoal(objective: String, maxRounds: Int): String
        fun todoWrite(items: JSONArray): String
        /** 多查询检索（桌面 web_search 的 queries 数组合并语义）；失败抛 [ai.deepseek.harness.mobile.kernel.KernelError] */
        /** @param fetchTop >0 时自动抓取前 N 条结果的正文并合并（深度调研一次成型，省掉多次 web_fetch 往返） */
        fun search(queries: List<String>, max: Int, fetchTop: Int = 0, charsPerPage: Int = 6_000): String
        fun subagent(task: String, maxRounds: Int): String
        /**
         * 以注册表里**已有**的 agent 条目运行子代理（teammate 场景）。
         * 默认退化为普通 subagent：这样 list_agents 里看到的那条记录就是真正在跑的那个，
         * interrupt_agent / send_message 才不会落空。
         */
        fun subagentAs(agentId: String, task: String, maxRounds: Int): String = subagent(task, maxRounds)
        fun useSkill(name: String): String
        fun createGoal(objective: String, maxRounds: Int): String
        fun getGoal(): String
        fun fetchUrl(url: String, maxChars: Int = 12_000, offset: Int = 0): String
        fun addImage(path: String): String
        /** 注入一张已在内存里的图（表情包没有工作区文件）：dataUrl 形式,label 只用于回执措辞 */
        fun addImageData(dataUrl: String, label: String): String
        /** 用户刚发来的那张图/表情（本轮附件优先）：Agent 想把它收进口袋时用 */
        fun latestUserImage(): JSONObject?
        fun askUser(question: String, options: JSONArray, detail: String): String
        /** 危险操作确认：返回 true 才继续 */
        fun approve(name: String, args: JSONObject, reason: String): Boolean
    }

    data class Gate(
        val permission: String,
        val planMode: Boolean,
        val planApproved: Boolean,
        val confirmDanger: Boolean,
    )

    /**
     * 只读判定唯一来源：[ToolCatalog]。以前这里是一份 5 个文件工具的硬编码集合，
     * 与守卫里的白名单各写一份，结果只读权限下 web_search / memory_search /
     * ask_user_question / read_image 全被当成写操作拒掉。
     */
    private val readOnlyTools: List<String> get() = ToolCatalog.readOnlyNames()

    private val pool: ExecutorService = executor ?: defaultPool ?: sharedToolPool()

    fun readOnlyNames(): List<String> = readOnlyTools

    fun isReadOnly(name: String): Boolean = ToolCatalog.isReadOnly(name)

    private fun modeOf(name: String): ToolExecutionMode =
        if (ToolCatalog.isReadOnly(name)) ToolExecutionMode.PARALLEL else registry.executionModeOf(name)

    /**
     * 当前模式下模型可见的工具名。
     * 计划模式只留「不写用户资产」的工具：只读工具 + 元工具（提问/待办/交付/委派/计划出口），
     * 而不是只留文件读取 —— 否则计划模式下 Agent 连查记忆、搜网页、看屏幕都做不到，
     * 「先探索再出计划」就成了空话。
     */
    fun visibleTools(planMode: Boolean, planApproved: Boolean): List<String> {
        val all = registry.tools().map { it.name }
        if (planMode && !planApproved) return all.filter { ToolCatalog.allowedWithoutWrite(it) }
        return all
    }

    /* ---------------- 批量执行与结算 ---------------- */

    /**
     * 执行一批模型给出的调用，返回与 [calls] **等长同序**的结果。
     *
     * @param onEnd 每条调用结束时的旁路通知（界面 tool_end）。保证每个 call 恰好收到一次：
     *   以前守卫拒绝的分支直接 return、异常分支整轮抛出，界面会少几条 tool_end，
     *   前端把「没有 tool_end 的调用」当成还在跑，或者干脆把整段 UI 卡住。
     * @param cancelled turn 是否已被取消。默认看线程中断位；Agent 的取消按钮应把它接进来
     *   （未接线的调用点行为与以前一致，只是「取消」只能靠超时兜底）。
     * @param sessionId 会话 id：spill 目录按会话分桶（同一会话的溢出文件不互相覆盖）
     */
    fun executeBatch(
        calls: List<Call>,
        gate: Gate,
        runtime: RuntimeTools,
        onEnd: ((Outcome) -> Unit)? = null,
        /** 工具实时输出（调用 id, 一块输出）：长命令边跑边刷界面，不等到 tool_end */
        onOutput: ((String, String) -> Unit)? = null,
        cancelled: () -> Boolean = { Thread.currentThread().isInterrupted },
        sessionId: String? = null,
        /**
         * 本轮真的发给模型的工具名集合（null = 不检查）。
         *
         * 桌面把这条判据放在执行器里（core/tools:1586 派发口 + :883「与执行器同一个谓词」），
         * 手机端以前没有：小窗口下工具被裁掉后模型照旧调它，落到 PluginRegistry 得到
         * 「未知工具：x（对应插件可能被禁用）」—— 把人往插件清单上带，真正原因却是目录没给它。
         * 现在在执行前按同一个集合拒绝，并把「本轮可用什么」写回给模型，让它能改道而不是重试。
         */
        catalog: Set<String>? = null,
    ): List<Outcome> {
        if (calls.isEmpty()) return emptyList()

        val outcomes = arrayOfNulls<Outcome>(calls.size)
        val emitted = BooleanArray(calls.size)
        // 结算的唯一出口：保证「结果落位」与「onEnd 一次」永远成对
        val deliver: (Int, Outcome) -> Unit = { index, outcome ->
            outcomes[index] = outcome
            if (!emitted[index]) {
                emitted[index] = true
                if (onEnd != null) runCatching { onEnd.invoke(outcome) }
            }
        }

        // 取消信号包一层：任何实现抛异常都只能算「没取消」，不能打断结算
        val isCancelled: () -> Boolean = { runCatching { cancelled() }.getOrDefault(false) }

        val spill = spillFor(sessionId)

        try {
            // 1) 先过 pre-execute：守卫与审批（顺序执行，保持确认顺序可预期）
            val blocked = arrayOfNulls<Outcome>(calls.size)
            for ((i, call) in calls.withIndex()) {
                if (isCancelled()) {
                    deliver(i, abortedBeforeDispatch(call))
                    continue
                }
                val offCatalog = notInCatalog(call, catalog)
                if (offCatalog != null) {
                    blocked[i] = offCatalog
                    deliver(i, offCatalog)
                    continue
                }
                guard(call, gate, runtime)?.let { v ->
                    blocked[i] = v
                    deliver(i, v)
                }
            }

            // 2) 分批：连续只读并发，写类工具作为屏障
            var i = 0
            while (i < calls.size) {
                if (blocked[i] != null || outcomes[i] != null) { i++; continue }
                if (isCancelled()) {
                    deliver(i, abortedBeforeDispatch(calls[i]))
                    i++
                    continue
                }
                if (modeOf(calls[i].name) == ToolExecutionMode.PARALLEL) {
                    // 连续 parallel 调用进同一个滚动池；遇到 exclusive 就断组，形成屏障
                    var j = i
                    val group = mutableListOf<Int>()
                    while (j < calls.size && blocked[j] == null && outcomes[j] == null &&
                        modeOf(calls[j].name) == ToolExecutionMode.PARALLEL
                    ) {
                        group.add(j)
                        j++
                    }
                    if (group.size == 1) runSingle(group[0], calls, isCancelled, sessionId, spill, onOutput, deliver)
                    else runGroup(group, calls, isCancelled, sessionId, spill, onOutput, deliver)
                    i = j
                } else {
                    // exclusive：屏障，等前面全部结算完再开始（保持「写类不并发」语义）
                    runSingle(i, calls, isCancelled, sessionId, spill, onOutput, deliver)
                    i++
                }
            }
        } catch (t: Throwable) {
            // 兜底：任何漏网异常都不允许越过这一层（以前会冒到 AgentDriver.failTurn 打掉整轮）
            log("工具批次异常（已在本层收口）：${t.message ?: t.javaClass.simpleName}")
        } finally {
            // 3) 结算：不允许出现「有 tool_call 却没有结果」的调用
            for (index in calls.indices) {
                if (outcomes[index] == null) {
                    deliver(
                        index,
                        Outcome(
                            calls[index].id, calls[index].name, false,
                            "工具未执行（本轮在它派发前提前结束）", 0,
                            code = "TOOL_NOT_STARTED",
                        ),
                    )
                }
            }
        }
        return calls.indices.map { outcomes[it]!! }
    }

    /** 单条调用：声明了预算的进池等待（可超时），没声明的一律原地执行，行为与以前一致 */
    private fun runSingle(
        index: Int,
        calls: List<Call>,
        isCancelled: () -> Boolean,
        sessionId: String?,
        spill: SpillPolicy,
        onOutput: ((String, String) -> Unit)?,
        deliver: (Int, Outcome) -> Unit,
    ) {
        val call = calls[index]
        val timeout = timeoutOf(call.name)
        val startedAt = System.currentTimeMillis()
        val out = sinkFor(onOutput, call.id)
        if (timeout == null) {
            deliver(index, runOne(call, ToolExecContext(isCancelled(), null, sessionId, call.id, cancelSignal = isCancelled, onOutput = out), spill))
            return
        }
        val ctx = ToolExecContext(isCancelled(), startedAt + timeout, sessionId, call.id,
            cancelSignal = isCancelled, onOutput = out)
        val future = submit { runOne(call, ctx, spill) }
        if (future == null) {
            // 池已关闭/拒绝任务：就地跑完，不因基础设施问题丢结果
            deliver(index, runOne(call, ctx, spill))
            return
        }
        deliver(index, await(future, call, timeout, startedAt, isCancelled))
    }

    /** 一组只读并发：全部先派发，再按模型顺序逐条结算（顺序稳定，完成先后只影响 tool_end 时机） */
    private fun runGroup(
        group: List<Int>,
        calls: List<Call>,
        isCancelled: () -> Boolean,
        sessionId: String?,
        spill: SpillPolicy,
        onOutput: ((String, String) -> Unit)?,
        deliver: (Int, Outcome) -> Unit,
    ) {
        class Pending(val index: Int, val future: Future<Outcome>, val timeout: Long?, val startedAt: Long)

        val pending = ArrayList<Pending>(group.size)
        for (index in group) {
            val call = calls[index]
            val timeout = timeoutOf(call.name)
            val startedAt = System.currentTimeMillis()
            val ctx = ToolExecContext(isCancelled(), timeout?.let { startedAt + it }, sessionId, call.id,
                cancelSignal = isCancelled, onOutput = sinkFor(onOutput, call.id))
            val future = submit { runOne(call, ctx, spill) }
            if (future == null) {
                deliver(index, runOne(call, ctx, spill))
                continue
            }
            pending.add(Pending(index, future, timeout, startedAt))
        }
        for (p in pending) deliver(p.index, await(p.future, calls[p.index], p.timeout, p.startedAt, isCancelled))
    }

    private fun submit(block: () -> Outcome): Future<Outcome>? =
        try {
            pool.submit(Callable { block() })
        } catch (t: Throwable) {
            log("工具任务无法入池（${t.message ?: t.javaClass.simpleName}），改为就地执行")
            null
        }

    /**
     * 等一条已派发的调用。
     *
     * 三件事必须同时成立：
     *   · 到该调用自己的 deadline 就落 `TOOL_TIMEOUT` 并打断线程（不是整批失败）
     *   · turn 被取消时立刻收尾，别等一个注定没人看的结果
     *   · 工具自己抛出的异常收成失败结果，不让它冲出 [executeBatch]
     */
    private fun await(
        future: Future<Outcome>,
        call: Call,
        timeoutMs: Long?,
        startedAt: Long,
        isCancelled: () -> Boolean,
    ): Outcome {
        while (true) {
            val elapsed = System.currentTimeMillis() - startedAt
            if (isCancelled() && !future.isDone) {
                future.cancel(true)
                return Outcome(
                    call.id, call.name, false,
                    "工具调用已中止：本轮被取消（已执行 ${elapsed}ms）", elapsed,
                    code = "TOOL_ABORTED",
                )
            }
            val slice = when (val t = timeoutMs) {
                null -> CANCEL_POLL_MS
                else -> (t - elapsed).coerceAtLeast(1L).coerceAtMost(CANCEL_POLL_MS)
            }
            try {
                return future.get(slice, TimeUnit.MILLISECONDS)
            } catch (timeout: TimeoutException) {
                if (timeoutMs != null && System.currentTimeMillis() - startedAt >= timeoutMs) {
                    future.cancel(true)
                    // 文案不带 "Error: " 前缀：AgentDriver 对 ok=false 的结果统一加，
                    // 模型最终看到的是「Error: tool call timed out after Nms」。
                    // 这里再加一遍就成了「Error: Error: …」。
                    return Outcome(
                        call.id, call.name, false,
                        "tool call timed out after ${timeoutMs}ms", System.currentTimeMillis() - startedAt,
                        code = "TOOL_TIMEOUT",
                    )
                }
                // 只是这一片等待结束：回去看取消位/重新算剩余预算
            } catch (e: ExecutionException) {
                val cause = e.cause ?: e
                return Outcome(
                    call.id, call.name, false,
                    "${cause.javaClass.simpleName}: ${cause.message ?: "工具执行异常"}",
                    System.currentTimeMillis() - startedAt,
                    code = "TOOL_THREW",
                )
            } catch (e: CancellationException) {
                return Outcome(
                    call.id, call.name, false,
                    "工具调用已被取消", System.currentTimeMillis() - startedAt,
                    code = "TOOL_ABORTED",
                )
            } catch (e: InterruptedException) {
                // 调用线程自己被中断 = drive 正在收尾：保存中断位并如实结算
                Thread.currentThread().interrupt()
                future.cancel(true)
                return Outcome(
                    call.id, call.name, false,
                    "工具调用已中止：执行线程被中断", System.currentTimeMillis() - startedAt,
                    code = "TOOL_ABORTED",
                )
            }
        }
    }

    /**
     * pre-execute：守卫 + 审批。返回 null 表示放行，否则就是这条调用的最终结果。
     *
     * 守卫的语义（与桌面 ToolGuard 对齐）：**只能拒绝，不能放行**。
     * 危险操作确认是「拒绝的软化形式」——它必须在没有硬拒绝时才生效，
     * 否则只读权限下的 `run_code` 会被改写成「待批准」，用户点一下批准就绕过了只读档。
     */
    private fun guard(call: Call, gate: Gate, runtime: RuntimeTools): Outcome? {
        val ctx = HookBus.HookContext("tools/pre-execute").apply {
            put("name", call.name); put("args", call.args); put("gate", gate)
        }
        val decision = try {
            val v = hooks.waterfall<GuardVerdict>("tools/pre-execute", GuardVerdict(), ctx)
            // 取值放在 try 里：HookBus 的短路会把 HookBus.Reject 当值返回（泛型擦除后到不了这里），
            // 一读字段就是 ClassCastException —— 守卫内部抛错等同于拒绝，而不是让整批炸掉。
            GuardVerdict(v.reject, v.needApproval, v.reason)
        } catch (t: Throwable) {
            GuardVerdict(HookBus.Reject(t.message ?: t.javaClass.simpleName))
        }

        val reject = decision.reject
        if (reject != null) {
            return Outcome(
                call.id, call.name, false, reject.toString(), 0,
                denied = true, reason = reject.reason, code = "TOOL_DENIED",
            )
        }
        if (decision.needApproval) {
            val ok = runCatching { runtime.approve(call.name, call.args, decision.reason) }.getOrDefault(false)
            if (!ok) {
                return Outcome(
                    call.id, call.name, false, "用户拒绝了这次调用：${decision.reason}", 0,
                    denied = true, reason = "用户拒绝", code = "TOOL_DENIED_BY_USER",
                )
            }
        }
        return null
    }

    private fun abortedBeforeDispatch(call: Call): Outcome = Outcome(
        call.id, call.name, false,
        "这次调用没有派发：本轮已取消（ABORTED_BEFORE_DISPATCH）", 0,
        code = "ABORTED_BEFORE_DISPATCH",
    )

    /**
     * 本轮目录里没有这个名字 → 执行前就拒，并把「这次为什么没跑、能改道去哪」写给模型。
     *
     * 只按集合成员判定，不看注册表：模型没收到的工具，无论存不存在都不该被偷偷执行
     * （桌面「在做出决定的那个操作里强制它」同义 —— 藏 schema 不算强制）。
     */
    private fun notInCatalog(call: Call, catalog: Set<String>?): Outcome? {
        if (catalog == null || call.name in catalog) return null
        if (catalog.isEmpty()) {
            return Outcome(
                call.id, call.name, false,
                "本轮没有给模型任何工具（工具开关关着，或这个预设不带工具），所以这次调用没有执行。",
                0, denied = true, reason = "本轮没有工具目录", code = "TOOL_NOT_IN_CATALOG",
            )
        }
        val some = catalog.take(12).joinToString("、")
        val more = if (catalog.size > 12) " 等 ${catalog.size} 个" else ""
        return Outcome(
            call.id, call.name, false,
            "本轮没有把「${call.name}」发给模型（上下文窗口太小被裁掉，或这个预设没开它），" +
                "所以这次调用没有执行。本轮可用的工具：$some$more。",
            0, denied = true, reason = "本轮工具目录里没有它", code = "TOOL_NOT_IN_CATALOG",
        )
    }

    /* ---------------- 单次执行 ---------------- */

    /** 把批级的 (调用 id, 一块输出) 收成这一条调用自己的单参回调：工具里只管 emitOutput(chunk) */
    private fun sinkFor(onOutput: ((String, String) -> Unit)?, id: String): ((String) -> Unit)? =
        onOutput?.let { f -> { chunk: String -> f(id, chunk) } }


    private fun runOne(call: Call, ctx: ToolExecContext, spill: SpillPolicy): Outcome {
        val t0 = System.currentTimeMillis()
        return try {
            runOneInner(call, ctx, spill, t0)
        } catch (t: Throwable) {
            // 最后一道防线：钩子里再抛、截断/落盘再炸，也只影响这一条调用
            Outcome(
                call.id, call.name, false,
                "${t.javaClass.simpleName}: ${t.message ?: "工具执行异常"}",
                System.currentTimeMillis() - t0,
                code = "TOOL_THREW",
            )
        }
    }

    private fun runOneInner(call: Call, ctx: ToolExecContext, spill: SpillPolicy, t0: Long): Outcome {
        // 把本次调用的边界（截止时刻/取消位/会话）挂到线程上：老插件单参 execute 里也能读到
        val prev = ToolExecContext.attach(ctx)
        val result = try {
            registry.exec(call.name, call.args.toString())
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("code", "TOOL_THREW")
                .put("error", t.message ?: t.javaClass.simpleName).toString()
        }
        // 捕获 Throwable 之后一定要还原线程上下文（否则池线程带着上一次的 deadline 继续跑下一条）
        ToolExecContext.detach(prev)
        var ok = true
        var code = ""
        var out = result
        // 退出码只认注册表信封里的 exit_code（工具自己填的旁路字段）；
        // 不在这里从正文里猜 —— 正文里出现 "exit=" 不等于这条命令真的退出过。
        var exitCode: Int? = null
        // 成败判定必须保守。旧代码是 optBoolean("ok", true) + runCatching 全吞：
        //   · 工具只返回 {"error": ...}（设备控制/MCP 里十几处这样写）→ 没有 ok 字段 → 判成功
        //   · 返回的不是 JSON（异常文本、空串）→ JSONObject 抛异常被 runCatching 吞掉 → ok 仍是 true
        // 结果就是「工具失败了，模型却收到成功」，然后照着假设继续往下编：点不到控件说点到了、
        // 没写成的文件说已交付 —— 比报错更坏，因为用户完全看不出哪里断了。
        val parsed = runCatching { JSONObject(result) }.getOrNull()
        if (parsed != null) {
            val err = parsed.optString("error")
            ok = if (parsed.has("ok")) parsed.optBoolean("ok") else err.isBlank()
            code = if (ok) "" else parsed.optString("code").ifBlank { "TOOL_FAILED" }
            out = if (ok) parsed.optString("output", result) else err.ifBlank { result }
            // 非 0 退出码是「命令跑完了但失败」，工具层仍算 ok（正文照样回给模型），
            // 所以退出码跟着 ok=false 一起丢就白做了 —— 无条件带出去。
            if (parsed.has("exit_code")) exitCode = parsed.optInt("exit_code")
        } else if (looksLikeFailure(result)) {
            ok = false
            code = "TOOL_FAILED"
        }
        // post-execute：结果改写（截断 + spill），也能像桌面那样「带反馈拦住」。
        // 取值在 try 里完成（包括字段读取）：HookBus 用 Reject 对象表达「监听器抛错」，
        // 泛型擦除后它可能出现在 PostResult 的位置上（一读字段就 ClassCastException）——
        // 那种情况当作「没有改写」，不能因为一个坏监听器把工具的真实输出弄丢。
        // 注意不能用「try/catch 两处分别给同一个 val 赋值」：Kotlin 无法证明只赋值一次。
        val postCtx = HookBus.HookContext("tools/post-execute").apply {
            put("name", call.name); put("ok", ok); put("output", out)
        }
        val post = try {
            val written = hooks.waterfall<PostResult>("tools/post-execute", PostResult(out), postCtx)
            PostResult(written.text, written.fail)
        } catch (t: Throwable) {
            log("post-execute 钩子异常（忽略改写）：${t.message ?: t.javaClass.simpleName}")
            PostResult(out)
        }
        if (post.fail != null) {
            ok = false
            code = "TOOL_BLOCKED"
            out = post.fail
        } else {
            out = post.text
        }

        // 超预算结果落盘：模型只看到首尾各半 + 去哪读全文。
        // 落点与提示语规则全在 [SpillPolicy]（纯函数，可单测）；写失败会如实说「没存下来」。
        val rendered = spill.render(call.name, out)
        if (rendered.spilled) log("spill ${call.name} -> ${rendered.locator}")
        out = rendered.text

        return Outcome(
            call.id, call.name, ok, out, System.currentTimeMillis() - t0,
            code = code, exitCode = exitCode,
        )
    }

    /**
     * 非 JSON 结果里的失败特征。只认「短且以错误词开头/含异常类名」的文本 ——
     * bash 的正常输出可能是任意长文本，宁可放过也不能把成功判成失败。
     */
    private fun looksLikeFailure(raw: String): Boolean {
        val t = raw.trim()
        if (t.isEmpty() || t.length > 400) return false
        if (t.startsWith("错误") || t.startsWith("失败") || t.startsWith("Error") || t.startsWith("Exception")) return true
        return Regex("(java|kotlin|android)\\.[\\w.]*(Exception|Error):").containsMatchIn(t)
    }

    /* ---------------- 超时与 spill 的来源 ---------------- */

    /** 单次调用的预算：插件声明优先，其次内核的集中登记表（公开，便于测试与诊断页直接查） */
    fun timeoutOf(name: String): Long? {
        val declared = registry.tools().firstOrNull { it.name == name }?.timeoutMs
        if (declared != null && declared > 0) return declared
        DEFAULT_TIMEOUT_MS[name]?.let { return it }
        // MCP 工具是网络往返：没有集中登记就按「外部服务」一档给预算，否则一个卡死的 server 会挂住整轮
        if (name.startsWith(MCP_TOOL_PREFIX)) return MCP_TIMEOUT_MS
        return null
    }

    /**
     * 本次批次用的 spill 策略。
     *
     * 落点优先级：测试注入 → [appSpillRoot] → 工作区 `.dsh/spill`。
     * 生产上只走工作区那一条：溢出文件是**产出物**，落在模型与用户都读得到的地方，
     * `read` 能直接分页读它（glob/grep 仍默认跳过 `.dsh`，不污染搜索结果）。
     * 提示语里的「工作区外」分支留给测试注入的私有目录，不再作为默认路径。
     */
    private fun spillFor(sessionId: String?): SpillPolicy {
        val root = spillRoot ?: appSpillRoot ?: File(workspace.root, SPILL_DIR)
        cleanupSpillOnce(root)
        // 每批都按字节上限收一次：手机存储是 MB 级，只靠启动那一次清理挡不住一轮长任务
        runCatching { SpillPolicy.trimToBudget(root) }
        val dir = SpillPolicy.sessionDir(root, sessionId) ?: File(workspace.root, SPILL_DIR)
        return SpillPolicy(
            spillDir = dir,
            workspaceRoot = workspace.root,
            maxInlineTokens = MAX_INLINE_TOKENS,
        )
    }

    private fun cleanupSpillOnce(root: File) {
        if (!SPILL_CLEANED.compareAndSet(false, true)) return
        val removed = runCatching { SpillPolicy.cleanupOlderThan(root) }.getOrDefault(0)
        if (removed > 0) log("清理过期 spill ${removed} 项（保留 ${SpillPolicy.RETENTION_MS / 86_400_000} 天）")
    }

    class GuardVerdict(
        val reject: HookBus.Reject? = null,
        val needApproval: Boolean = false,
        val reason: String = "",
    )

    /**
     * post-execute 的返回：要么改写文本，要么带反馈拦住（`fail` 非空即判定失败）。
     * 对应桌面 `tools/post-execute` 的 "replace content or value, block with feedback"。
     */
    class PostResult(val text: String, val fail: String? = null)

    companion object {
        /** inline token 预算：中文约 12.5k 字、英文约 40k 字符（[SpillPolicy] 里按首尾各半分配） */
        const val MAX_INLINE_TOKENS = SpillPolicy.DEFAULT_MAX_INLINE_TOKENS

        const val PARALLEL_WIDTH = 4

        /** 溢出文件目录（工作区内兜底落点；glob/grep 默认跳过 .dsh） */
        const val SPILL_DIR = ".dsh/spill"

        /** 等 future 的轮询粒度：够细以观察取消位，又不至于空转 */
        private const val CANCEL_POLL_MS = 200L

        /**
         * spill 根的覆盖位（测试或特殊设备用）；生产不注入，走工作区 `.dsh/spill`。
         * 注入到工作区之外时，[SpillPolicy] 的提示语会如实说明「标准权限的 read 读不到」。
         */
        @Volatile
        var appSpillRoot: File? = null

        /**
         * 内核单例池（由 [ai.deepseek.harness.mobile.kernel.ToolKernel] 注入后所有 driver 共用）。
         * 仍是 null 时退回进程级 [sharedToolPool]，保证任何构造路径都不会「每轮新建一个池」。
         */
        @Volatile
        var defaultPool: ExecutorService? = null

        private val POOL_SEQ = AtomicInteger(0)
        private val SHARED_POOL: ExecutorService by lazy {
            newDaemonPool("dsh-tool")
        }

        /** 进程级工具池：daemon 线程，池本身不可 shutdown 也不再重建 */
        fun sharedToolPool(): ExecutorService = SHARED_POOL

        /** 建一个 daemon 线程池（内核/团队/测试都可复用这个工厂，线程名便于看线程 dump） */
        fun newDaemonPool(prefix: String, width: Int = PARALLEL_WIDTH): ExecutorService =
            Executors.newFixedThreadPool(width.coerceAtLeast(1), ThreadFactory { r ->
                Thread(r, "$prefix-${POOL_SEQ.incrementAndGet()}").apply { isDaemon = true }
            })

        private val SPILL_CLEANED = AtomicBoolean(false)

        /**
         * 声明式超时登记表（[ai.deepseek.harness.mobile.kernel.plugin.ToolSpec.timeoutMs] 的集中版本）。
         *
         * 为什么不写在各插件里：这些工具的实现文件分布在不同任务的范围里，逐个改容易互相踩；
         * 等插件自己覆盖 `timeoutMs` 后，这张表可以逐行删掉（插件声明优先，这里的值只是兜底）。
         */
        private val DEFAULT_TIMEOUT_MS: Map<String, Long> = mapOf(
            // 网络往返：搜索源 / 抓网页都可能慢，30s 是「等得到就等」的上限
            "web_fetch" to 30_000L,
            "web_search" to 30_000L,
            "fetch_url" to 30_000L,
            "url_fetch" to 30_000L,
            // 截屏/读屏：一次抓帧 + 采样，正常几百 ms；8s 还没回来就是设备侧卡住了
            "phone_screenshot" to 8_000L,
            "screen_read" to 8_000L,
        )

        private const val MCP_TOOL_PREFIX = "mcp__"
        private const val MCP_TIMEOUT_MS = 30_000L

        /** 内置守卫：权限、计划模式、只读插件、危险操作确认 */
        fun installBuiltinGuards(hooks: HookBus) {
            // 只读权限：只拦真正会改东西的工具。
            // 判定一律走 ToolCatalog —— 曾经这里是一份硬编码名单，
            // 结果 web_fetch / read_image / ask_user_question 在只读下被误拒。
            hooks.onWaterfall<GuardVerdict>("tools/pre-execute", "permission", 100) { v, c ->
                if (v.reject != null) return@onWaterfall v
                val gate = c.any("gate") as Gate
                val name = c.str("name").orEmpty()
                if (ai.deepseek.harness.mobile.kernel.sandbox.SandboxMode.parse(gate.permission)
                    == ai.deepseek.harness.mobile.kernel.sandbox.SandboxMode.READ_ONLY
                    && !ToolCatalog.allowedWithoutWrite(name)
                ) {
                    GuardVerdict(
                        HookBus.Reject("当前是只读权限，$name 会改动文件或外部状态；切换到标准权限后可用"),
                        false, "",
                    )
                } else v
            }

            hooks.onWaterfall<GuardVerdict>("tools/pre-execute", "plan-mode", 90) { v, c ->
                if (v.reject != null) return@onWaterfall v
                val gate = c.any("gate") as Gate
                val name = c.str("name").orEmpty()
                if (gate.planMode && !gate.planApproved && !ToolCatalog.allowedWithoutWrite(name)) {
                    GuardVerdict(HookBus.Reject("计划模式下只能读取与规划；先提交计划并等用户批准"), false, "")
                } else v
            }

            // 危险操作确认：**只在没有硬拒绝时**提出「要不要批准」。
            // 以前的判断是 `if (v.reject != null || !v.needApproval) { … }`：命中危险操作时
            // 返回 `GuardVerdict(null, needApproval=true)`，把前面 permission/plan 的 reject
            // 清成了「待批准」—— 只读档下 run_code 因此变成「用户点一下就能执行」。
            hooks.onWaterfall<GuardVerdict>("tools/pre-execute", "danger", 50) { v, c ->
                if (v.reject != null) return@onWaterfall v
                if (v.needApproval) return@onWaterfall v
                val gate = c.any("gate") as Gate
                // 开关就在这里：设置页「危险操作前询问」→ AgentConfig.askDanger → Gate.confirmDanger。
                // 关掉后整段判定跳过（不是"问了自动答应"），判定规则本身见 DangerGuard。
                if (!gate.confirmDanger) return@onWaterfall v
                val name = c.str("name").orEmpty()
                val args = c.any("args") as? JSONObject ?: JSONObject()
                val danger = DangerGuard.reason(name, args)
                if (danger.isNotEmpty()) GuardVerdict(null, true, danger) else v
            }

            // 硬拒绝必须粘住。
            // [HookBus.waterfall] 的短路条件是「当前值 is HookBus.Reject」，而守卫返回的是
            // `GuardVerdict(reject = Reject(...))` —— 泛型一擦除短路就失效，后面任何监听器
            // （插件守卫、或旧版 danger）都能把拒绝改写掉。HookBus 不归本任务改，这里用
            // 「记下来 + 最后重放」的方式给拒绝钉一个钉子。
            hooks.onWaterfall<GuardVerdict>("tools/pre-execute", "reject-capture", 45) { v, c ->
                if (v.reject != null) c.put(REJECT_KEY, v.reject)
                v
            }
            hooks.onWaterfall<GuardVerdict>("tools/pre-execute", "reject-latch", Int.MIN_VALUE) { v, c ->
                val held = c.any(REJECT_KEY) as? HookBus.Reject ?: return@onWaterfall v
                if (v.reject != null) v else GuardVerdict(held)
            }
        }

        /** 守卫之间传递「已经拒绝」的 key（只在本轮 pre-execute 的 HookContext 里有效） */
        private const val REJECT_KEY = "__guard_reject"
    }
}
