package ai.deepseek.harness.mobile.kernel.plugin

import ai.deepseek.harness.mobile.agent.HookBus
import ai.deepseek.harness.mobile.agent.HookBus.HookContext

/**
 * 插件视角的事件总线 —— 对应桌面 Harness 里 `ctx.on(event, fn)` 的语义。
 *
 * 和直接拿 [HookBus] 的区别只有一点，但很关键：**监听器 id 自动加 `<插件id>/` 前缀**。
 * 好处是插件不需要自己记账，卸载时内核按前缀一次摘干净，
 * 也不可能误摘别的插件挂的钩子（`off("tools/pre-execute")` 这种全局误伤不可能发生）。
 *
 * 插件在 [KernelPlugin.onLoad] 里挂事件、在 [KernelPlugin.onUnload] 里什么都不用做：
 * registry 卸载时会调用 `offPrefix("<id>/")`。
 */
class PluginHooks internal constructor(
    private val bus: HookBus?,
    val owner: String,
) {
    /** 挂 waterfall 监听：可以改写值，返回 null 表示不干预 */
    fun <T : Any> onWaterfall(event: String, id: String, priority: Int = 0, fn: (T, HookContext) -> T?) {
        bus?.onWaterfall(event, qualify(id), priority, fn)
    }

    /** 挂 serial 监听：副作用型通知，不看返回值 */
    fun onSerial(event: String, id: String, priority: Int = 0, fn: (HookContext) -> Unit) {
        bus?.onSerial(event, qualify(id), priority, fn)
    }

    /** 自己在某个事件上挂了哪些监听（相对 id，不含前缀） */
    fun listeners(event: String): List<String> =
        bus?.listeners(event).orEmpty()
            .filter { it.startsWith("$owner/") }
            .map { it.removePrefix("$owner/") }

    private fun qualify(id: String): String = if (id.startsWith("$owner/")) id else "$owner/$id"

    companion object {
        /** 没有总线时的空实现（纯数据场景/单元测试） */
        fun disabled(): PluginHooks = PluginHooks(null, "-")
    }
}
