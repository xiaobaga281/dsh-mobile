package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * 语音输出工具 —— 让 Agent 能**主动**把一段话念出来。
 *
 * 为什么需要它：自动策略只覆盖"适合口述的短回复"；用户明确要求"念给我听/读出来"、
 * 或内容稍长但仍想听时，需要一个显式入口。工具只负责把文本与语速交给前端播放，
 * 不做策略判断（策略写在前端 SpeechOut.decide 与系统提示的规范里）。
 */
class SpeechPlugin : KernelPlugin {
    override val id = "speech"
    override val name = "语音输出"
    override val description = "把文本朗读出来（本机 TTS：内置神经音色优先，不可用时退回系统引擎）"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var sink: ((JSONObject) -> Unit)? = null
    private var spoken = 0

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        sink = ctx.service("speech.sink") as? ((JSONObject) -> Unit)
    }

    override fun onUnload() { ctx = null; sink = null }

    override fun status(): Map<String, String> = mapOf("已朗读" to spoken.toString())

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "speak"
            override val description =
                "把一段文本朗读出来（本机 TTS，离线；内置神经音色优先，英文多的句子自动换系统引擎）。" +
                    "用于：用户明确要求「念给我听 / 读出来 / 用语音说」，" +
                    "或自动语音策略没覆盖到但确实适合听的场景。规范：一次不超过 600 字；" +
                    "代码、表格、大段数据不要念（那些用文字回答）；念完仍要用文字给出结论。"
            override val parameters = JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().apply {
                    put("text", JSONObject().put("type", "string").put("description", "要朗读的文本（纯文字，不要 Markdown 记号）"))
                    put("rate", JSONObject().put("type", "number").put("description", "语速 0.6–2.0，默认 1.0"))
                })
                put("required", JSONArray(listOf("text")))
                put("additionalProperties", false)
            }
            override fun execute(args: JSONObject): String {
                val text = args.optString("text").trim()
                if (text.isBlank()) throw KernelError("text 不能为空")
                if (text.length > 1200) throw KernelError("一次最多朗读 1200 字，请拆成几次")
                val rate = args.optDouble("rate", 1.0).coerceIn(0.6, 2.0)
                val s = sink ?: throw KernelError("语音输出通道未就绪")
                spoken++
                s.invoke(JSONObject().apply {
                    put("text", text)
                    put("rate", rate)
                })
                return JSONObject().put("ok", true)
                    .put("note", "正在朗读（${text.length} 字）").toString()
            }
        },
    )
}
