package ai.deepseek.harness.mobile.kernel.plugin

/**
 * 让视觉模型「看一眼这张图，说一句它是什么」。
 *
 * 表情包在仓库里只是 dataUrl + id，模型光看 id 不可能知道画面内容；
 * 补一句画面描述存进仓库，清单里带上它，模型选表情才是按内容选，而不是按名字猜。
 *
 * 端点不支持视觉（纯文本模型）时返回 null，调用方退回「只有名字」的老行为。
 */
fun interface ImageCaptioner {
    fun caption(dataUrl: String): String?
}
