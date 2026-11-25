package ai.deepseek.harness.mobile.kernel.plugin.builtin.dev

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.dev.SelfModify
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import org.json.JSONObject

/**
 * `self_modify`：让 harness 改自己的前端源码并让它生效。
 *
 * 改源码用现成的 workspace 文件工具（write / edit / patch），路径是
 * `workspace/.dsh-src/parts/` 下的 JS；这里只负责状态、重建、重载、恢复。
 * 重建规则与桌面 `scripts/build-web.mjs` 一致（见 [SelfModify.rebuild]）。
 *
 * 与设置面板的 `Native.selfModify()` 共用同一个 [SelfModify] 对象，
 * 不另起一套状态 —— 工具里 enable、面板里 restore 看到的是同一份开关。
 */
class SelfModifyPlugin : KernelPlugin {
    override val id = "self-modify"
    override val name = "前端自改"
    override val description = "读取/重建/重载本 App 自己的前端源码（workspace/.dsh-src/parts/）"
    override val version = "1.0.0"

    private var ctxRef: PluginContext? = null

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "self_modify",
            description = "改本 App 自己的前端。" +
                "先用 write/edit 改 workspace/.dsh-src/parts/ 下的 JS（或 styles.css），" +
                "再 action=rebuild 按 build.json 顺序拼成 app.js，最后 action=reload 让 WebView 重载生效。" +
                "status 看状态；enable 首次展开源码并开启覆盖；disable 暂停覆盖；" +
                "restore 清除覆盖回到 APK 内置版本。注意：覆盖的 JS 能调用全部原生桥，" +
                "改动前先想清楚，改坏了用 restore 兜底。",
            parameters = Schemas.params(
                mapOf(
                    "description" to Schemas.prop("string", "一句话说明这次改什么（5-10 个字）"),
                    "action" to Schemas.prop(
                        "string",
                        "status / enable / disable / rebuild / restore / reload",
                        listOf("status", "enable", "disable", "rebuild", "restore", "reload"),
                    ),
                ),
                listOf("action"),
            ),
        ) { a -> run(a.pick("action").ifBlank { "status" }.lowercase()) },
    )

    private fun run(action: String): String {
        val ctx = ctxRef ?: throw KernelError("前端自改插件未装配")
        val app = ctx.service("app.context") as? android.content.Context
            ?: throw KernelError("拿不到应用上下文")
        val out = JSONObject()
        return try {
            val result: JSONObject = when (action) {
                "status" -> SelfModify.status(app).put("ok", true)
                "enable" -> out.put("ok", true).put("message", SelfModify.setEnabled(app, true))
                "disable" -> out.put("ok", true).put("message", SelfModify.setEnabled(app, false))
                "rebuild" -> {
                    val r = SelfModify.rebuild(app)
                    out.put("ok", r.ok).put("message", r.message)
                    if (r.ok) out.put("hint", "接着执行 self_modify(action=\"reload\") 让改动生效")
                    out
                }
                "restore" -> out.put("ok", true).put("message", SelfModify.restore(app))
                "reload" -> {
                    val hook = SelfModify.reloadHook
                    hook?.invoke()
                    out.put("ok", hook != null)
                        .put("message", if (hook != null) "已请求重载页面" else "当前页面不支持重载")
                }
                else -> throw KernelError("不支持的动作：$action")
            }
            result.toString()
        } catch (e: Throwable) {
            android.util.Log.w("DSHSelfModify", "self_modify($action) 失败：${e.message}")
            JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName).toString()
        }
    }

    override fun onLoad(ctx: PluginContext) {
        ctxRef = ctx
    }

    override fun onUnload() {
        ctxRef = null
    }
}
