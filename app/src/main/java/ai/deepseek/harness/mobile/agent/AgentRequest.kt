package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject

/**
 * 三条请求循环（Lead / 子代理 / 团队成员）共用的两个纯函数。
 *
 * 为什么抽出来：预算和请求体以前各写一遍 —— 子代理压到 4096、成员压到 8192、
 * 目录只在主对话按窗口裁剪，同一类 bug 每次要在三处找。这里不做 IO、不做状态，
 * 只把「窗口怎么算」「请求长什么样」定死一处，谁改都跑同一套单测。
 */
internal object AgentRequest {

    /** 每个工具 schema 的经验 token 数（与主对话同一口径） */
    const val TOKENS_PER_TOOL = 110

    /** 历史可用窗口的下限：再小连系统提示都放不下 */
    const val MIN_WINDOW = 2_048

    /** 设置里的上下文窗口先扣掉工具目录，剩下的才是历史可用量（压缩器按它算预算） */
    fun effWindow(contextWindow: Int, toolCount: Int): Int =
        (contextWindow - toolCount * TOKENS_PER_TOOL).coerceAtLeast(MIN_WINDOW)

    /** 子代理 / 成员的请求体：与主对话同形状（stream + max_tokens + 可选 tools） */
    fun body(model: String, messages: List<JSONObject>, maxOut: Int, toolDefs: JSONArray?): JSONObject =
        JSONObject().apply {
            put("model", model)
            put("messages", JSONArray(messages.map { it }))
            put("stream", true)
            put("max_tokens", maxOut)
            if (toolDefs != null && toolDefs.length() > 0) {
                put("tools", toolDefs)
                put("tool_choice", "auto")
            }
        }
}
