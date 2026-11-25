package ai.deepseek.harness.mobile.agent

import ai.deepseek.harness.mobile.kernel.plugin.ImageCaptioner
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次性的「看图说一句」调用 —— 只给表情包仓库做画面标注，不参与主对话循环。
 *
 * 为什么单独建客户端：主循环的 [LlmClient] 会被 cancel() 打断（用户点停止），
 * 标注请求不该跟着一起死；而且它只发一次、不走流式，失败就算了（返回 null）。
 * 端点/密钥沿用本轮配置，所以换模型、换本地服务后标注能力自动跟着变。
 */
class VisionCaptioner(
    private val config: AgentConfig,
    private val log: (String) -> Unit = {},
) : ImageCaptioner {

    companion object {
        /** 描述太长会挤占清单：真实有用的信息（主体/颜色/文字）20~30 字就够 */
        private const val MAX_CHARS = 40
        private const val SYSTEM =
            "你是图像标注员。看这张图，用一句中文（不超过28字）说出：画面主体是什么、主色调、" +
                "有没有文字或表情符号。只输出这句描述本身，不要客套、不要解释、不要分点。"
    }

    override fun caption(dataUrl: String): String? {
        if (!dataUrl.startsWith("data:image/")) return null
        return runCatching {
            val body = JSONObject()
                .put("model", config.model)
                .put("max_tokens", 200)
                .put("temperature", 0)
                .put(
                    "messages", JSONArray()
                        .put(JSONObject().put("role", "system").put("content", SYSTEM))
                        .put(
                            JSONObject().put("role", "user").put(
                                "content", JSONArray()
                                    .put(JSONObject().put("type", "text").put("text", "这张图里是什么？"))
                                    .put(
                                        JSONObject().put("type", "image_url")
                                            .put("image_url", JSONObject().put("url", dataUrl)),
                                    ),
                            ),
                        ),
                )
            val out = LlmClient(config.baseUrl, config.apiKey, log).complete(body)
            clean(out)
        }.getOrElse {
            log("表情标注失败：${it.message}")
            null
        }
    }

    /** 小模型爱加「这张图是…」前缀、爱换行、爱带引号：都洗掉，只留描述本体 */
    private fun clean(raw: String): String? {
        var t = raw.replace("\r", " ").replace("\n", " ").trim()
        if (t.isBlank()) return null
        for (p in listOf("这张图是", "这张图片是", "图片中是", "图中是", "这张表情是", "描述：", "描述:")) {
            if (t.startsWith(p)) t = t.removePrefix(p).trim()
        }
        t = t.trim('"', '\'', '「', '」', '“', '”', '。', '，', ',', '.', ' ')
        // 模型偶尔会先自言自语再给答案：取最后一个句号前的短句没意义，直接截断最稳
        if (t.length > MAX_CHARS) t = t.take(MAX_CHARS).trim()
        return t.ifBlank { null }
    }
}
