package ai.deepseek.harness.mobile.kernel.agents

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger

/**
 * 子代理注册表 —— 桌面 `ctx.subagents` / `ctx.agents` 的手机端等价物。
 *
 * 桌面把每次委派登记成可寻址的子 Agent：`list_agents` 发现、`send_message` 追加消息、
 * `interrupt_agent` 中断。手机端子代理是内核里的一条线程，注册表负责：
 *   - 登记 id / 名称 / 任务 / 状态 / 开始时间（供 list_agents 发现）
 *   - 收件箱：send_message 投递的消息进入队列，子代理在下一轮开始时认领
 *   - 中断：interrupt_agent 置取消位，子代理在轮边界退出
 * 注册表本身不持有 LLM 客户端与工具流水线，那些仍由 Driver 提供。
 */
class AgentRegistry(private val log: (String) -> Unit = {}) {

    class Agent(
        val id: String,
        val name: String,
        val task: String,
        val parentSessionId: String,
        val startedAt: Long = System.currentTimeMillis(),
    ) {
        @Volatile var status: String = "running"      // running | done | failed | interrupted
        @Volatile var summary: String = ""
        @Volatile var cancelled: Boolean = false
        @Volatile var endedAt: Long = 0
        val inbox = LinkedBlockingQueue<String>()

        fun drainInbox(): List<String> = buildList {
            while (true) {
                val next = inbox.poll() ?: break
                add(next)
            }
        }
    }

    private val agents = ConcurrentHashMap<String, Agent>()
    private val seq = AtomicInteger(0)

    fun register(name: String, task: String, parentSessionId: String): Agent {
        val id = "agent-${seq.incrementAndGet()}-${System.currentTimeMillis() % 100000}"
        val a = Agent(id, name.ifBlank { "subagent-$id" }, task, parentSessionId)
        agents[id] = a
        log("agent register $id")
        return a
    }

    fun finish(agent: Agent, status: String, summary: String) {
        agent.status = status
        agent.summary = summary
        agent.endedAt = System.currentTimeMillis()
    }

    fun get(id: String): Agent? = agents[id]

    fun list(scope: String, parentSessionId: String): JSONArray = JSONArray().apply {
        val all = agents.values.sortedByDescending { it.startedAt }
        val picked = if (scope == "descendants") all else all.filter { it.parentSessionId == parentSessionId }
        picked.forEach { a ->
            put(JSONObject().apply {
                put("agent_id", a.id)
                put("name", a.name)
                put("status", a.status)
                put("task", a.task.take(200))
                put("parent_session", a.parentSessionId)
                put("started_at", a.startedAt)
                put("ended_at", a.endedAt)
                put("summary", a.summary.take(300))
            })
        }
    }

    /** 投递一条消息给子代理；返回是否受理 */
    fun send(id: String, message: String): Boolean {
        val a = agents[id] ?: return false
        if (a.status != "running") return false
        a.inbox.offer(message)
        return true
    }

    fun interrupt(id: String): Boolean {
        val a = agents[id] ?: return false
        if (a.status != "running") return false
        a.cancelled = true
        a.status = "interrupted"
        return true
    }

    fun describe(): JSONObject = JSONObject().apply {
        put("agents", agents.size)
        put("running", agents.values.count { it.status == "running" })
    }
}
