package ai.deepseek.harness.mobile.agent

import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 钩子总线 —— 桌面 Harness 里由 Cordis 提供的 waterfall / serial / parallel 事件，
 * 在手机端收敛成这一个类。
 *
 * 与桌面语义保持一致的点：
 * - **waterfall**：监听器按优先级串行拿到上一位的返回值，可改写（返回非 null 即替换），
 *   返回 [REJECT] 表示硬拒绝（不可被后续监听器翻案）；异常按 reject 处理，不允许静默吞掉。
 * - **serial**：副作用型通知，按顺序执行，异常只记日志不打断主流程。
 *
 * 这样每项能力（意图分析、权限守卫、上下文贡献、结果改写）都能以监听器身份挂进来，
 * 增删一个监听器不改变 Driver 本体 —— 也就是「一切皆插件」在内核侧的另一半。
 */
class HookBus(private val log: (String) -> Unit = {}) {

    /** 硬拒绝哨兵：waterfall 里出现即终止，后续监听器无法改写。 */
    class Reject(val reason: String) {
        override fun toString(): String = "Reject($reason)"
    }

    class Listener<T>(
        val id: String,
        val priority: Int,
        val fn: (T, HookContext) -> T?,
    )

    /** 监听器拿到的上下文（事件名 + 附加数据袋；发送侧 put，监听侧 str/bool/any 读）。 */
    class HookContext(
        val event: String,
        private val bag: MutableMap<String, Any?> = mutableMapOf(),
    ) {
        fun put(key: String, value: Any?) { bag[key] = value }
        fun str(key: String): String? = bag[key] as? String
        fun bool(key: String): Boolean = bag[key] as? Boolean ?: false
        fun any(key: String): Any? = bag[key]
    }

    private val waterfalls = HashMap<String, CopyOnWriteArrayList<Listener<Any?>>>()
    private val serials = HashMap<String, CopyOnWriteArrayList<Listener<Unit>>>()

    /* ---------------- 注册 ---------------- */

    fun <T : Any> onWaterfall(event: String, id: String, priority: Int = 0, fn: (T, HookContext) -> T?) {
        val listener: Listener<Any?> = Listener(id, priority) { value, ctx -> fn(value as T, ctx) }
        waterfalls.getOrPut(event) { CopyOnWriteArrayList() }
            .apply { add(listener); sortByDescending { it.priority } }
    }

    fun onSerial(event: String, id: String, priority: Int = 0, fn: (HookContext) -> Unit) {
        serials.getOrPut(event) { CopyOnWriteArrayList() }
            .apply { add(Listener(id, priority) { _: Unit, ctx -> fn(ctx); null }); sortByDescending { it.priority } }
    }

    /**
     * 按 id 前缀批量摘除 —— 插件卸载时用 `offPrefix("fs/")` 一次清干净。
     * 约定插件监听器 id 形如 `<插件id>/<自定义名>`，这样卸载不影响别人。
     */
    fun offPrefix(prefix: String): Int {
        var n = 0
        waterfalls.values.forEach { list -> n += list.count { it.id.startsWith(prefix) }; list.removeIf { it.id.startsWith(prefix) } }
        serials.values.forEach { list -> n += list.count { it.id.startsWith(prefix) }; list.removeIf { it.id.startsWith(prefix) } }
        return n
    }

    fun listeners(event: String): List<String> =
        (waterfalls[event]?.map { it.id } ?: emptyList()) + (serials[event]?.map { it.id } ?: emptyList())

    /** 某个前缀（插件）总共挂了多少监听器 —— 设置页展示可插拔度用 */
    fun countPrefix(prefix: String): Int =
        waterfalls.values.sumOf { list -> list.count { it.id.startsWith(prefix) } } +
            serials.values.sumOf { list -> list.count { it.id.startsWith(prefix) } }

    /* ---------------- 触发 ---------------- */

    @Suppress("UNCHECKED_CAST")
    fun <T : Any> waterfall(event: String, initial: T, ctx: HookContext = HookContext(event)): T {
        var current: Any? = initial
        waterfalls[event]?.forEach { listener ->
            if (current is Reject) return current as T
            val next = try {
                listener.fn(current, ctx)
            } catch (t: Throwable) {
                log("hook $event/${listener.id} 抛错：${t.message}")
                Reject(t.message ?: t.javaClass.simpleName)
            }
            if (next != null) current = next
        }
        return current as T
    }

    fun serial(event: String, ctx: HookContext = HookContext(event)) {
        serials[event]?.forEach { listener ->
            try { listener.fn(Unit, ctx) } catch (t: Throwable) { log("hook $event/${listener.id} 抛错：${t.message}") }
        }
    }

    /** 给设置/调试页看的快照 */
    fun describe(): JSONObject = JSONObject().apply {
        waterfalls.forEach { (k, v) -> put(k, org.json.JSONArray(v.map { it.id })) }
        serials.forEach { (k, v) -> put("$k#serial", org.json.JSONArray(v.map { it.id })) }
    }
}
