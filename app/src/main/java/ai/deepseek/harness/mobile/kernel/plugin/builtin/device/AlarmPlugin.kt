package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickBool
import ai.deepseek.harness.mobile.kernel.plugin.pickInt
import android.content.Context
import android.content.Intent
import android.provider.AlarmClock

/**
 * 系统时钟插件：把「提醒」落到系统时钟 App，而不是应用内的 schedule_*。
 *
 * schedule_create 只会在本应用里到点叫人；「明天 8 点叫我起床」「定时 10 分钟」
 * 这类需求要落进系统时钟才算数（锁屏、通知、与用户既有习惯一致）。
 * 全部走系统意图（AlarmClock），只需 SET_ALARM 这个 normal 级安装权限，无运行时权限。
 *
 *   alarm_set   在系统时钟里建一个闹钟（默认弹到闹钟界面让用户确认，可 skip_ui 静默创建）
 *   timer_set   在系统时钟里建一个倒计时
 */
class AlarmPlugin : KernelPlugin {
    override val id = "alarm"
    override val name = "系统时钟"
    override val description = "在系统时钟 App 里创建闹钟与倒计时（系统意图，零运行时权限）"
    override val version = "1.0.0"

    private var app: Context? = null
    private var created = 0

    override fun onLoad(ctx: PluginContext) {
        app = ctx.service("app.context") as? Context
    }

    override fun onUnload() {
        app = null
    }

    override fun status(): Map<String, String> = mapOf(
        "已创建" to created.toString(),
        "时钟能力" to if (app != null) "可用" else "未就绪",
    )

    private val c: Context
        get() = app ?: throw KernelError("时钟插件未就绪（应用上下文缺失），重启应用后再试")

    /** 发起系统意图；屏幕会切到时钟 App（用户确认或静默创建），回来后报告结果 */
    private fun launch(intent: Intent, what: String, detail: String, skipUi: Boolean): String {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(c.packageManager) == null) {
            throw KernelError("系统里没有支持「$what」的时钟应用（极少数精简 ROM 会这样）")
        }
        runCatching { c.startActivity(intent) }
            .getOrElse { throw KernelError("打不开系统时钟：${it.message}") }
        created++
        // 不骗模型：弹界面模式下用户可能不确认就返回，此时闹钟并没有创建
        return if (skipUi) {
            "已在系统时钟里创建$what（$detail），到点由系统响铃。"
        } else {
            "已打开系统时钟的确认界面（$detail）。需要用户在界面上点保存/确认才会真正创建；" +
                "如果用户取消或直接返回，就**没有**创建——不要向用户宣称已经设好了，可以问一句是否已确认。"
        }
    }

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "alarm_set",
            description = "在系统时钟 App 里创建一个闹钟。用户说「明早 8 点叫我」「下午 3 点提醒我开会」时用这个，" +
                "闹钟会出现在系统时钟里（锁屏可见、到点系统响铃），比 notify/schedule_create 可靠。" +
                "需要小时+分钟；默认弹出时钟界面让用户按一下确认，传 skip_ui=true 可静默创建。",
            parameters = Schemas.params(
                mapOf(
                    "hour" to Schemas.prop("number", "小时，24 小时制（0-23）"),
                    "minute" to Schemas.prop("number", "分钟（0-59），默认 0"),
                    "message" to Schemas.prop("string", "闹钟标签，如「开会」「起床」"),
                    "skip_ui" to Schemas.prop("boolean", "true=静默创建不弹界面（需要用户已授权本应用）；默认 false 弹界面确认"),
                ),
                listOf("hour"),
            ),
        ) { a ->
            val hour = a.pickInt("hour").let {
                if (it !in 0..23) throw KernelError("hour 必须是 0-23，收到的是 $it")
                it
            }
            val minute = a.pickInt("minute", default = 0).coerceIn(0, 59)
            val msg = a.pick("message").ifBlank { "闹钟" }
            val skipUi = a.pickBool("skip_ui", default = false)
            val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                putExtra(AlarmClock.EXTRA_HOUR, hour)
                putExtra(AlarmClock.EXTRA_MINUTES, minute)
                putExtra(AlarmClock.EXTRA_MESSAGE, msg)
                putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
            }
            launch(intent, "闹钟", "%02d:%02d $msg".format(hour, minute), skipUi)
        },

        SimpleTool(
            name = "timer_set",
            description = "在系统时钟 App 里创建一个倒计时。用户说「定 10 分钟」「再等 30 秒提醒我」时用这个，" +
                "倒计时到点由系统响铃。默认弹出时钟界面确认，传 skip_ui=true 可静默创建。",
            parameters = Schemas.params(
                mapOf(
                    "seconds" to Schemas.prop("number", "倒计时秒数（与 minutes 二选一）"),
                    "minutes" to Schemas.prop("number", "倒计时分钟数（与 seconds 二选一）"),
                    "message" to Schemas.prop("string", "倒计时标签"),
                    "skip_ui" to Schemas.prop("boolean", "true=静默创建不弹界面；默认 false 弹界面确认"),
                ),
                emptyList(),
            ),
        ) { a ->
            val seconds = when {
                a.has("seconds") -> a.pickInt("seconds")
                a.has("minutes") -> a.pickInt("minutes") * 60
                else -> throw KernelError("缺时长：传 seconds 或 minutes 之一")
            }
            if (seconds <= 0) throw KernelError("倒计时时长必须大于 0（收到 $seconds 秒）")
            val msg = a.pick("message").ifBlank { "倒计时" }
            val skipUi = a.pickBool("skip_ui", default = false)
            val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
                putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                putExtra(AlarmClock.EXTRA_MESSAGE, msg)
                putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
            }
            launch(intent, "倒计时", "$seconds 秒 $msg", skipUi)
        },
    )
}
