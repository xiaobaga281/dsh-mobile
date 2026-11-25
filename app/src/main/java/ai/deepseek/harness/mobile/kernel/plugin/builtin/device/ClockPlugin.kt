package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.agent.PromptAssembler
import ai.deepseek.harness.mobile.agent.PromptOrder
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 时间上下文插件 —— 一个**纯能力插件**的范例：不贡献任何工具，只往事件总线上挂钩子。
 *
 * 解决的问题：模型不知道「现在」是哪天（训练截止之后的一切日期它都只能猜），
 * 用户的输入里一旦出现「今天/明天/这周/三天后」，模型只能编。这里在每轮装配系统提示时
 * 现取一次设备时间，判空、格式化、时区全部走系统，误差为零。
 *
 * 它同时是 [PluginContext.hooks] 的活样本 —— 三行代码接入事件瀑布，
 * 卸载（设置页关掉插件）时由 registry 按 `clock/` 前缀自动摘钩子，不留残余。
 */
class ClockPlugin : KernelPlugin {

    override val id: String = "clock"
    override val name: String = "时间上下文"
    override val description: String = "把设备当前日期时间注入系统提示，让「今天/明天/倒计时」有真实基准"

    /** config.json 里 config.clock.timezone 可覆盖系统时区（模拟器常见 GMT 误配） */
    private var overrideZone: String = ""

    override fun onLoad(ctx: PluginContext) {
        overrideZone = ctx.config().optString("timezone")
        // 走运行时上下文而不是系统提示词：时间是每轮都变的状态，塞进 system 会让
        // 「稳定的规则」和「每秒都在变的值」混在一起，前缀缓存每轮都失效。
        // 与桌面 working-directory / sandbox-policy 的处理方式一致。
        ctx.hooks.onWaterfall<PromptAssembler.Section>(
            "runtime-context/assemble", "clock/now", PromptOrder.priorityOf(PromptOrder.CTX_CLOCK),
        ) { section, _ ->
            section.plus(render())
        }
    }

    override fun status(): Map<String, String> = mapOf(
        "时区" to zone().id,
        // 供设置页/自检直接读到注入内容（与提示词里那段是同一个 render()）
        "当前" to render().removePrefix("当前时间：").substringBefore("（"),
    )

    private fun zone(): TimeZone =
        if (overrideZone.isNotBlank()) TimeZone.getTimeZone(overrideZone) else TimeZone.getDefault()

    private fun render(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd EEEE HH:mm", Locale.CHINA).apply { timeZone = zone() }
        // 印度 +5:30、纽芬兰 -3:30 这类半小时时区，整除丢分钟会让模型把时间算错 30 分钟
        val offMs = zone().getOffset(System.currentTimeMillis())
        val hours = offMs / 3_600_000
        val mins = Math.abs((offMs / 60_000) % 60)
        val utc = if (mins == 0) {
            if (hours >= 0) "UTC+$hours" else "UTC$hours"
        } else {
            String.format(Locale.US, "UTC%+03d:%02d", hours, mins)
        }
        return "当前时间：${fmt.format(Date())}（${zone().id}，$utc）——涉及日期、星期、倒计时、\"今天/明天\"时以此为准，不要凭训练数据推断。"
    }
}
