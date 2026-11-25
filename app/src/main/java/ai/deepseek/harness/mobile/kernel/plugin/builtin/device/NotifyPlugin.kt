package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * 系统提醒 —— Agent 主动把用户"叫一声"的能力。
 *
 * 为什么它属于 Agent 的必备件而不是锦上添花：
 *   长任务（跑测试、批量处理、定时任务到期）跑完时用户很可能已经切走了应用。
 *   没有这个出口，Agent 干完了也只是一条躺在会话里的消息 —— 用户不知道，
 *   整个"自主执行"就断在最后一米。
 *
 * 与两个既有通知的分工：
 *   - 会话完成/失败提醒：由前端在每轮结束时自动发（RunService.finish）
 *   - 需要确认提醒：由审批/追问触发（RunService.attention）
 *   - [notify]：Agent 自己判断"这件事值得打断用户"时主动发，不随回到前台自动消失
 *
 * 纪律写在工具描述里：能当面说清的就不要弹通知（用户在应用内时通知纯属噪音）。
 */
class NotifyPlugin : KernelPlugin {
    override val id = "notify"
    override val name = "系统提醒"
    override val description = "让 Agent 主动发系统通知（长任务完成、定时提醒、需要用户回来处理）"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var sent = 0

    override fun onLoad(ctx: PluginContext) { this.ctx = ctx }
    override fun onUnload() { ctx = null }

    override fun status(): Map<String, String> = mapOf("已提醒" to sent.toString())

    override fun promptSection(): String? =
        "【提醒纪律】notify 是打断用户的能力，只在以下情况用：长任务（超过约 1 分钟）已结束、" +
            "定时任务到点、或你判断用户需要离开当前对话回来处理。用户正在对话里跟你一问一答时不要用 —— " +
            "直接写在回复里就行。"

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "notify"
            override val description =
                "发一条系统通知提醒用户（用户可能已切到别的应用）。用于：长任务完成/失败、定时任务到点、" +
                    "需要用户回来做决定。不要在正常一问一答时用（用户在应用内，通知是噪音）。" +
                    "标题不超过 30 字，正文不超过 200 字，别把整段结果塞进通知。"
            override val parameters = JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("title", JSONObject().put("type", "string").put("description", "通知标题，一句话说清是什么事"))
                    put("text", JSONObject().put("type", "string").put("description", "通知正文，最多 200 字；详情留在会话里"))
                    put("priority", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("default", "high")))
                        .put("description", "default 安静送达；high 会横幅弹出，只用于「必须现在处理」"))
                    put("silent", JSONObject().put("type", "boolean")
                        .put("description", "true 时只进通知栏，不出声不振动（默认 false）"))
                })
                put("required", JSONArray(listOf("title", "text")))
                put("additionalProperties", false)
            }

            override fun execute(args: JSONObject): String {
                val title = args.optString("title").trim()
                val text = args.optString("text").ifBlank { args.optString("body") }.trim()
                if (title.isBlank()) throw KernelError("title 不能为空")
                if (text.isBlank()) throw KernelError("text 不能为空")
                val app = ctx?.service("app.context") as? android.content.Context
                    ?: throw KernelError("系统提醒不可用：当前没有应用上下文")
                // Android 13+ 未授权时 NotificationManager.notify 会静默丢弃，工具却报成功 ——
                // 用户等不到提醒，还以为任务没跑完。这里显式拦住并给出可操作指引。
                if (android.os.Build.VERSION.SDK_INT >= 33 &&
                    app.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                    android.content.pm.PackageManager.PERMISSION_GRANTED
                ) {
                    throw KernelError("没有通知权限：请到系统设置 → 应用 → 通知，允许本应用发通知后重试")
                }
                val priority = args.optString("priority", "default")
                val ok = ai.deepseek.harness.mobile.notify.RunService.remind(
                    app, title.take(60), text.take(400),
                    priority = priority,
                    silent = args.optBoolean("silent", false),
                )
                if (!ok) throw KernelError("通知发送失败：请检查系统通知权限是否已对本应用开启")
                sent++
                return JSONObject().put("ok", true)
                    .put("priority", priority)
                    .put("note", "已发送系统通知").toString()
            }
        },
    )
}
