package ai.deepseek.harness.mobile.kernel.plugin.builtin.doc

import ai.deepseek.harness.mobile.kernel.doc.DocReader
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickInt
import org.json.JSONObject

/**
 * 文档读取 —— 补上「read 只能读文本」这个最大缺口。
 *
 * 手机上的真实场景：用户把一份 Word / PDF / Excel 丢进来，说「总结一下」「这里哪里写错了」
 * 「把表格转成 CSV」。在补这个工具之前，Agent 只能 read 到一个「二进制文件，无法按文本读取」，
 * 然后无计可施 —— 这在一台以「资料处理」为卖点的客户端上是硬伤。
 *
 * 分工：
 *   - [DocReader] 负责格式解析（纯 JDK，无第三方库）
 *   - 本插件只做参数校验、大小限制、结果整形
 *   - 真读不出来的（扫描件 PDF）如实告知，并给出替代路径，不编内容
 */
class DocPlugin : KernelPlugin {
    override val id = "doc"
    override val name = "文档读取"
    override val description = "读取 PDF / Word / Excel / PowerPoint / 文本类文档的正文"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var reads = 0

    override fun onLoad(ctx: PluginContext) { this.ctx = ctx }
    override fun onUnload() { ctx = null }

    override fun status(): Map<String, String> = mapOf(
        "已读取" to reads.toString(),
        "支持格式" to DocReader.extensions().sorted().joinToString("/"),
    )

    override fun promptSection(): String? =
        "【读文档】read 只读纯文本；遇到 .pdf/.docx/.xlsx/.pptx 用 read_doc（正文抽取，保留段落与表格行）。" +
            "扫描件 PDF 没有文本层，read_doc 会明说读不出 —— 此时不要编内容，改用 read_image 看截图或请用户提供文字版。"

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "read_doc",
            description =
                "抽取文档正文：PDF / Word(.docx) / Excel(.xlsx) / PowerPoint(.pptx) / txt md csv json html xml。" +
                    "返回正文与元信息（页数、幻灯片数、行数、是否扫描件）。扫描件 PDF 会明确回 textLayer=false，" +
                    "此时不要编内容。长文档用 offset 分段读：返回体里的 next_offset 直接传给下一次调用的 offset，" +
                    "直到返回 has_more=false。",
            parameters = Schemas.params(
                mapOf(
                    "file_path" to Schemas.prop("string", "文档路径（相对工作区）"),
                    "max_chars" to Schemas.prop("number", "本次最多返回多少字符，默认 12000，上限 60000"),
                    "offset" to Schemas.prop("number", "从正文的第几个字符开始读，默认 0（配合 next_offset 翻页）"),
                ),
                listOf("file_path"),
            ),
            executionMode = ToolExecutionMode.PARALLEL,
        ) { a ->
            reads++
            val c = ctx ?: throw ai.deepseek.harness.mobile.kernel.KernelError("工作区未就绪")
            val path = a.pick("file_path", "path")
            if (path.isBlank()) throw ai.deepseek.harness.mobile.kernel.KernelError("file_path 不能为空")
            // 与 read 走同一条路径策略：标准模式下限工作区，完全授权模式按字面解析
            val f = c.sandbox.resolveRead(path) ?: c.workspace.resolve(path, mustExist = true)
            val max = a.pickInt("max_chars", default = 12_000).coerceIn(2_000, 60_000)
            val offset = a.pickInt("offset", default = 0).coerceAtLeast(0)
            // 先看体积：PDF/docx 解析会整份进内存，无上限等于给 OOM 留门
            if (f.length() > 32L * 1024 * 1024) {
                throw ai.deepseek.harness.mobile.kernel.KernelError(
                    "文档过大（${f.length() / 1024 / 1024}MB，read_doc 上限 32MB）：" +
                        "请让用户拆分/压缩后重试，或用 present 打开后按截图读取"
                )
            }
            // 一次性抽到 offset+max，再在插件层切片：DocReader 只认「从头取 N 字符」，
            // 深偏移时抽全文代价可接受（文档解析本来就全量），换来的是真正的分段读取。
            val r = DocReader.read(f, (offset + max).coerceAtLeast(offset + 2_000))
            // 真实总长：截断时 DocReader 会在 meta["chars"] 里给出截断前的长度；
            // 没截断就是本次文本长度。用 r.text.length 当总数是错的——那等于「本次读到的」，
            // has_more 会永远 false，模型以为长文档已读完。
            val total = (r.meta["chars"] as? Number)?.toInt() ?: r.text.length
            val end = (offset + max).coerceAtMost(r.text.length)
            val slice = if (offset < r.text.length) r.text.substring(offset, end) else ""
            JSONObject().apply {
                put("file", c.workspace.relative(f))
                put("kind", r.kind)
                put("chars", slice.length)
                put("total_chars", total)
                put("offset", offset)
                put("has_more", end < total)
                if (end < total) put("next_offset", end)
                r.meta.forEach { (k, v) -> put(k, v) }
                put("text", slice)
                if (offset >= total) {
                    put("hint", "offset=$offset 已超出正文长度（共 $total 字符），返回为空")
                }
            }.toString()
        },
    )
}
