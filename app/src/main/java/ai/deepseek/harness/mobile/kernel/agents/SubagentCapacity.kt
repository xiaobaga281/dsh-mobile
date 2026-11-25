package ai.deepseek.harness.mobile.kernel.agents

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * 子智能体并行容量 —— 桌面 `SubagentManager.pool.reserve(maxActiveSubagents)` 的手机端等价物。
 *
 * 计数口径与桌面一致：**同一个主 Agent 下所有层级存活的子智能体合计**，主 Agent 自己不计入。
 * 到了上限就拒绝新的启动请求（不排队）—— 排队会让「上一层的子代理还在等下一层」
 * 变成死锁：父占着槽位等子，子永远等不到槽位。
 *
 * 为什么按 root 会话分桶：桌面按「同一个主 Agent」计数；手机端的 root 是会话 id，
 * 嵌套两层时子代理的 sessionId 仍然是主会话的，所以一个桶就够。
 */
object SubagentCapacity {

    private val live = ConcurrentHashMap<String, AtomicInteger>()

    fun count(root: String): Int = live[root]?.get() ?: 0

    /** 申请一个槽位；满了返回 false（调用方必须如实拒绝，不能悄悄降级成串行） */
    fun tryAcquire(root: String, max: Int): Boolean {
        val cap = max.coerceAtLeast(1)
        val n = live.computeIfAbsent(root) { AtomicInteger(0) }
        while (true) {
            val cur = n.get()
            if (cur >= cap) return false
            if (n.compareAndSet(cur, cur + 1)) return true
        }
    }

    fun release(root: String) {
        val n = live[root] ?: return
        if (n.decrementAndGet() <= 0) live.remove(root, n)
    }

    /** 插件卸载/进程内核对账时清空（正常路径靠 release，这里是兜底） */
    fun reset() = live.clear()
}
