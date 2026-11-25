package ai.deepseek.harness.mobile.kernel.team

/**
 * 「谁在说话」—— 桌面端每个团队成员都有一个 Agent 句柄，工具能从中拿到调用者身份；
 * 手机端所有工具调用都经过同一个 [ai.deepseek.harness.mobile.agent.ToolPipeline]，
 * 没有 per-agent 的执行上下文。
 *
 * 于是用线程局部变量补上这一层：teammate 的每一轮跑在自己的池线程里，
 * 工具执行前进入身份、执行后退回。Lead 的轮次不设值 —— 默认为 `lead`。
 *
 * 没有它，`send_message(target="lead")` 只能靠「target 是不是 lead」硬判断，
 * 结果就是：队友给 Lead 汇报会被当成「自己给自己发消息」拒掉，整条协作链断在最后一步。
 *
 * 多团队并存（桌面 TeamId=SessionId）之后，身份还必须带上**所属团队**：
 * 用户切到会话 B 时，A 团队的队友仍在后台跑，它发的 send_message / team_task_update
 * 必须落回 A 的 roster / 任务板 —— 按前台会话解析就会把 A 的汇报写进 B 的日志（串台）。
 */
internal object TeamCall {

    private val current = ThreadLocal<String?>()
    private val currentTeamSid = ThreadLocal<String?>()

    /** 当前线程正在以哪个成员的身份执行；null = Lead（或非团队上下文） */
    fun current(): String? = current.get()

    fun callerName(): String = current.get() ?: "lead"

    /** 当前线程所属团队的 Lead 会话 id；null = 不在成员线程里 */
    fun callerTeamSid(): String? = currentTeamSid.get()

    /** 进入某个成员身份，返回上一个身份供 [exit] 还原 */
    fun enter(name: String, teamSid: String?): String? {
        val prev = current.get()
        val prevSid = currentTeamSid.get()
        current.set(name)
        currentTeamSid.set(teamSid)
        return prev
    }

    /** 兼容旧签名：只换名字，团队归属不变 */
    fun enter(name: String): String? = enter(name, currentTeamSid.get())

    /**
     * 「只有 Lead 能做」的操作在**服务层**判一次身份（桌面 `roster.ts:189/234` 的
     * `membership.role !== 'lead'` → `TEAM_LEAD_REQUIRED`）。
     *
     * 为什么不能只靠「不给队友这些 schema」：成员可见目录由 Lead 档位、上下文窗口大小、
     * 插件启停共同决定，任何一处放行就能建队或掐掉别人；桌面工程同样的规矩是
     * 「决定发生在哪个操作里，就在哪强制」。schema 那层照旧留着（少一份 token），
     * 这里补的是真正兜底的那一刀。
     */
    fun requireLead(op: String): String {
        val caller = callerName()
        if (caller != "lead") {
            throw TeamError("TEAM_LEAD_REQUIRED", "只有 Team Lead 能$op；当前调用者是队友「$caller」")
        }
        return caller
    }

    fun exit(prev: String?) {
        if (prev == null) {
            current.remove()
            currentTeamSid.remove()
        } else {
            current.set(prev)
        }
    }
}
