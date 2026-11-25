package ai.deepseek.harness.mobile.kernel.plugin.builtin.doc

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.GenProbe
import ai.deepseek.harness.mobile.kernel.chart.ChartSvg
import ai.deepseek.harness.mobile.kernel.chart.ChartSpec
import ai.deepseek.harness.mobile.kernel.chart.FlowNode
import ai.deepseek.harness.mobile.kernel.chart.FlowEdge
import ai.deepseek.harness.mobile.kernel.chart.FlowchartSvg
import ai.deepseek.harness.mobile.kernel.chart.MindNode
import ai.deepseek.harness.mobile.kernel.chart.MindmapSvg
import ai.deepseek.harness.mobile.kernel.chart.QrSvg
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import android.graphics.Bitmap
import android.graphics.Color
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 图像生成 —— 两条路，先说清边界：
 *
 *  1. **配了图像 API**（`files/kernel/image.json`：`{ "url": "...", "key": "...", "model": "..." }`，
 *     OpenAI `/images/generations` 兼容）→ 真去请求、把返回的图片落到工作区。
 *     手机上跑不了扩散模型，出照片级图像必须靠外部算力，这条是唯一的正路。
 *  2. **没配 API** → 用内置的 SVG 生成器产出一张可直接打开的图（海报/封面/示意图：
 *     标题、副标题、主题色、几何底纹）。这不是"假图"，是真正的矢量成品，
 *     适合做封面、卡片、流程图占位；要写实照片就得配 API。
 *
 * 两条路都返回工作区相对路径，前端交付卡片会直接把图推到对话里。
 */
class ImagePlugin : KernelPlugin {
    override val id = "image"
    override val name = "图像生成"
    override val description = "生成图片文件：外部图像 API（可选）+ 内置 SVG 海报/示意图"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var generated = 0

    override fun onLoad(ctx: PluginContext) { this.ctx = ctx }
    override fun onUnload() { ctx = null }

    override fun status(): Map<String, String> = buildMap {
        put("已生成", generated.toString())
        put("外部 API", if (apiConfig() != null) "已配置" else "未配置（走内置 SVG）")
    }

    /** 探测契约的存取走独立实例（apiConfig 只读 image 段，这里要读写 capabilities） */
    private fun genCfg(): ai.deepseek.harness.mobile.kernel.GenConfig {
        val dir = (ctx?.service("plugin.dir") as? File)?.parentFile
            ?: ctx?.workspace?.root
        return ai.deepseek.harness.mobile.kernel.GenConfig(File(dir ?: File("."), "gen.json"))
    }

    /** 生成模型配置（设置 → 生成模型 里填的），兼容旧的 image.json */
    private fun apiConfig(): JSONObject? {
        val dir = (ctx?.service("plugin.dir") as? File)?.parentFile ?: return null
        val gen = ai.deepseek.harness.mobile.kernel.GenConfig(File(dir, "gen.json"))
        val cfg = gen.section("image")
        if (cfg.optString("url").isBlank()) {
            val legacy = File(dir, "image.json")
            if (!legacy.exists()) return null
            val old = runCatching { JSONObject(legacy.readText()) }.getOrNull() ?: return null
            if (old.optString("url").isBlank()) return null
            return JSONObject().apply {
                put("url", old.optString("url"))
                put("key", old.optString("key"))
                put("model", old.optString("model", "gpt-image-1"))
            }
        }
        return JSONObject().apply {
            put("url", cfg.optString("url"))
            put("key", cfg.optString("key"))
            put("model", cfg.optString("model", "gpt-image-1"))
        }
    }

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    /** 图像端点契约（探测习得）：size 白名单等 */
    private fun contract(): GenProbe.Contract? =
        runCatching { genCfg().section("image").optJSONObject("capabilities") }
            .getOrNull()?.let { GenProbe.Contract.from(it) }

    override val tools: List<ToolSpec> get() = buildTools()

    private fun buildTools(): List<ToolSpec> {
        val cap = contract()
        // size 枚举：契约优先（端点方言），无契约自由文本
        val sizeParam = if (cap?.sizes?.isNotEmpty() == true) {
            JSONObject().put("type", "string").put("enum", GenProbe.strArr(cap.sizes))
                .put("description", "尺寸。端点合法值已由探测习得，枚举即端点合法值，默认 ${cap.sizes.first()}")
        } else {
            JSONObject().put("type", "string")
                .put("description", "尺寸，如 1024x1024 / 1024x1536，默认 1024x1024。" +
                    "端点报「invalid size」时先调 probe_image_endpoint 探测合法值")
        }
        val probeHint = if (cap == null)
            "首次使用建议先调 probe_image_endpoint 探测端点契约。" else "端点契约已探测：size=${cap.sizes}。"
        return listOf(
        object : ToolSpec {
            override val name = "image_generate"
            override val description =
                "生成一张图片并保存到工作区（随后会自动出现在交付卡片里）。" +
                    "配置了外部图像 API 时出写实/插画图；没配置时用内置 SVG 渲染海报/封面/示意图" +
                    "（可指定标题、副标题、主题色）。返回值里 kind 会写明是 api 还是 svg。" + probeHint
            override val parameters = schema(
                JSONObject()
                    .put("prompt", JSONObject().put("type", "string").put("description", "画面描述（外部 API 用）"))
                    .put("title", JSONObject().put("type", "string").put("description", "SVG 模式的主标题"))
                    .put("subtitle", JSONObject().put("type", "string").put("description", "SVG 模式的副标题"))
                    .put("theme", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("midnight", "dawn", "forest", "paper")))
                        .put("description", "SVG 配色主题，默认 midnight"))
                    .put("size", sizeParam)
                    .put("n", JSONObject().put("type", "number")
                        .put("description", "生成几张（1–4），默认 1；仅外部 API 支持，SVG 模式固定 1 张"))
                    .put("negative_prompt", JSONObject().put("type", "string")
                        .put("description", "不希望出现的内容（外部 API 用），例如 文字、水印、多只手"))
                    .put("style", JSONObject().put("type", "string")
                        .put("description", "风格提示（外部 API 用），如 vivid / natural / 水墨 / 扁平插画"))
                    .put("quality", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("auto", "low", "medium", "high")))
                        .put("description", "渲染质量档位（gpt-image-1 系），默认 auto；high 更慢更贵"))
                    .put("image_path", JSONObject().put("type", "string")
                        .put("description", "图生图：工作区里的参考图（png/jpg），按参考图编辑/改画 —— 走 /images/edits"))
                    .put("model", JSONObject().put("type", "string")
                        .put("description", "临时换用端点上的另一个图像模型（默认用设置里配的）"))
                    .put("path", JSONObject().put("type", "string")
                        .put("description", "保存路径（相对工作区），多张时自动加 -1/-2 后缀")),
                listOf("prompt"),
            )
            override fun execute(args: JSONObject): String {
                val prompt = args.optString("prompt").trim()
                if (prompt.isBlank()) throw KernelError("prompt 不能为空")
                val ws = ctx?.workspace ?: throw KernelError("工作区不可用")
                val size = args.optString("size", "1024x1024")
                val n = args.optInt("n", 1).coerceIn(1, 4)
                // 图生图参考图：工作区相对路径 → 文件；走 /images/edits（multipart）
                val refImage = args.optString("image_path").trim().takeIf { it.isNotBlank() }?.let { rel ->
                    val f = ws.resolve(rel)
                    if (!f.isFile) throw KernelError("参考图不存在：$rel")
                    val ext = f.extension.lowercase()
                    if (ext !in setOf("png", "jpg", "jpeg")) throw KernelError("参考图必须是 png 或 jpg：$rel")
                    f
                }
                val cfg = apiConfig()
                if (cfg != null) {
                    val saved = runCatching { callApi(cfg, prompt, size, args.optString("path"), n, args, refImage) }
                        .getOrElse { e ->
                            val msg = e.message.orEmpty()
                            // 配置/鉴权/参数错误（4xx）不兜底：这类问题必须让用户看见，
                            // 否则填错端点也会「生成成功」一张 SVG，配置错误永远发现不了
                            if (msg.contains("HTTP 4")) {
                                // 自愈：参数被端点拒绝 → 重新探测契约（size 白名单可能记错）
                                runCatching { probeAndStore() }
                                val sizes = contract()?.sizes
                                val hint = if (sizes?.isNotEmpty() == true) "端点合法 size：$sizes" else ""
                                throw KernelError(msg + if (hint.isBlank()) "" else "（$hint）")
                            }
                            // 网络/服务端故障才退 SVG，并如实说明
                            val fallback = runCatching { renderSvg(args, prompt) }
                                .getOrElse { throw KernelError("图像 API 失败（$msg），SVG 兜底也失败") }
                            return JSONObject().put("ok", true).put("kind", "svg")
                                .put("path", ws.relative(fallback))
                                .put("note", "外部 API 暂时不可用（$msg），已用内置 SVG 顶替；这不是写实图").toString()
                        }
                    generated += saved.size
                    val paths = saved.map { ws.relative(it) }
                    return JSONObject().put("ok", true).put("kind", "api")
                        .put("count", paths.size)
                        .put("path", paths.first())
                        .put("paths", JSONArray(paths))
                        .put("note", if (paths.size > 1) "已生成 ${paths.size} 张，全部在交付卡片里" else "已生成")
                        .toString()
                }
                val file = renderSvg(args, prompt)
                generated++
                return JSONObject().put("ok", true).put("kind", "svg")
                    .put("count", 1)
                    .put("path", ws.relative(file))
                    .put("note", "未配置图像 API，已生成矢量图（SVG 模式一次只出 1 张，n 被忽略）；" +
                        "要写实图或批量出图请在「设置 → 生成模型」填图像端点")
                    .toString()
            }
        },
        object : ToolSpec {
            override val name = "probe_image_endpoint"
            override val description =
                "探测图像端点的真实能力（size 白名单等），结果存入配置并立即生效——" +
                    "image_generate 的 size 枚举会随之更新。换图像厂商、端点报「invalid size」时先调这个。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String {
                val cfg = apiConfig() ?: throw KernelError("尚未配置图像端点（设置 → 生成模型）")
                val c = GenProbe.probeImage(cfg.optString("url"), cfg.optString("key"), cfg.optString("model", "gpt-image-1"))
                genCfg().setCapabilities("image", c.toJson())
                return JSONObject().put("ok", true)
                    .put("sizes", GenProbe.strArr(c.sizes))
                    .put("note", "契约已探测并存入配置；image_generate 的 size 枚举已按端点方言更新。" +
                        "traces: ${GenProbe.strArr(c.traces.take(3))}").toString()
            }
        },
        object : ToolSpec {
            override val name = "chart_generate"
            override val description =
                "用数据画一张矢量图表（SVG，保存到工作区并出现在交付卡片里）。" +
                    "bar=柱状图 / hbar=条形图 / line=折线图 / pie=饼图 / scatter=散点图。" +
                    "适合业绩对比、趋势走势、占比分析、相关性散点。纯本地渲染，无需网络。"
            override val parameters = schema(
                JSONObject()
                    .put("type", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("bar", "hbar", "line", "pie", "scatter")))
                        .put("description", "图表类型"))
                    .put("title", JSONObject().put("type", "string").put("description", "图表标题"))
                    .put("categories", JSONObject().put("type", "array")
                        .put("description", "类目数组（bar/hbar/line 的 X 轴或 pie 的扇区名），如 [\"一月\",\"二月\",\"三月\"]"))
                    .put("series", JSONObject().put("type", "array")
                        .put("description", "数据系列。bar/hbar/line/pie：[{name:\"销售额\",data:[10,20,30]}]；" +
                            "scatter：[{name:\"样本\",data:[[1,2],[3,4]]}]"))
                    .put("x_label", JSONObject().put("type", "string").put("description", "X 轴名称（可选）"))
                    .put("y_label", JSONObject().put("type", "string").put("description", "Y 轴名称（可选）"))
                    .put("accent", JSONObject().put("type", "string")
                        .put("description", "主色（6 位 hex，如 4C8DFF）；只覆写第一系列，缺省用品牌蓝"))
                    .put("output", JSONObject().put("type", "string")
                        .put("description", "保存路径（相对工作区），缺省 art/chart-<类型>-<序号>.svg")),
                listOf("type", "series"),
            )
            override fun execute(args: JSONObject): String {
                val ws = ctx?.workspace ?: throw KernelError("工作区不可用")
                val type = args.optString("type")
                if (type.isBlank()) throw KernelError("type 不能为空（bar/hbar/line/pie/scatter）")
                val cats = args.optJSONArray("categories")?.let { a ->
                    (0 until a.length()).map { a.optString(it) }
                } ?: emptyList()
                val seriesArr = args.optJSONArray("series")
                if (seriesArr == null || seriesArr.length() == 0) throw KernelError("series 不能为空：[{name,data}]")
                val series = (0 until seriesArr.length()).mapNotNull { i ->
                    val s = seriesArr.optJSONObject(i) ?: return@mapNotNull null
                    val name = s.optString("name")
                    val data = s.optJSONArray("data") ?: JSONArray()
                    when (type) {
                        "scatter" -> ChartSpec.Serie(name, emptyList(),
                            (0 until data.length()).mapNotNull { j ->
                                data.optJSONArray(j)?.let { p ->
                                    if (p.length() >= 2) Pair(p.optDouble(0), p.optDouble(1)) else null
                                }
                            })
                        else -> ChartSpec.Serie(name,
                            (0 until data.length()).map { data.optDouble(it) })
                    }
                }
                if (series.isEmpty()) throw KernelError("series 解析后为空：需要 [{name:\"…\",data:[…]}]")
                val spec = ChartSpec(
                    type = type,
                    title = args.optString("title"),
                    categories = cats,
                    series = series,
                    xLabel = args.optString("x_label"),
                    yLabel = args.optString("y_label"),
                    accent = args.optString("accent").ifBlank { null },
                )
                val svg = try {
                    ChartSvg.build(spec)
                } catch (e: IllegalArgumentException) {
                    throw KernelError(e.message ?: "图表参数不合法")
                }
                val rel = args.optString("output").ifBlank { "art/chart-$type-${generated + 1}.svg" }
                    .let { if (it.endsWith(".svg")) it else it.substringBeforeLast('.') + ".svg" }
                val f = ws.resolve(rel)
                ws.mkdirs(f)
                f.writeText(svg, Charsets.UTF_8)
                generated++
                return JSONObject().put("ok", true).put("kind", "svg")
                    .put("path", ws.relative(f))
                    .put("note", "已生成 ${type} 图（SVG 矢量，预览/分享/导出可直接用）").toString()
            }
        },
        object : ToolSpec {
            override val name = "qr_generate"
            override val description =
                "生成一个二维码并保存到工作区（链接、文本、名片、Wi-Fi 均可）。" +
                    "默认出 SVG 矢量图（任意缩放清晰），也可选 png 位图。"
            override val parameters = schema(
                JSONObject()
                    .put("text", JSONObject().put("type", "string")
                        .put("description", "二维码内容：URL、纯文本、wifi:… 等"))
                    .put("size", JSONObject().put("type", "number")
                        .put("description", "呈现尺寸 px（128-1024），默认 512"))
                    .put("format", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("svg", "png")))
                        .put("description", "输出格式，默认 svg（矢量）"))
                    .put("accent", JSONObject().put("type", "string")
                        .put("description", "码点颜色（6 位 hex），缺省近黑"))
                    .put("output", JSONObject().put("type", "string")
                        .put("description", "保存路径（相对工作区），缺省 art/qr-<序号>.<格式>")),
                listOf("text"),
            )
            override fun execute(args: JSONObject): String {
                val ws = ctx?.workspace ?: throw KernelError("工作区不可用")
                val text = args.optString("text")
                if (text.isBlank()) throw KernelError("text 不能为空")
                val size = args.optInt("size", 512).coerceIn(128, 1024)
                val accent = args.optString("accent").ifBlank { null }
                val format = args.optString("format", "svg").lowercase()
                return if (format == "png") {
                    val m = try {
                        QrSvg.matrix(text)
                    } catch (e: IllegalArgumentException) {
                        throw KernelError(e.message ?: "二维码参数不合法")
                    }
                    val fg = accent?.removePrefix("#")?.takeIf { it.matches(Regex("[0-9A-Fa-f]{6}")) } ?: "1C1C1E"
                    val small = Bitmap.createBitmap(m.width, m.height, Bitmap.Config.ARGB_8888)
                    small.eraseColor(Color.WHITE)
                    for (y in 0 until m.height) for (x in 0 until m.width) {
                        if (m.get(x, y)) small.setPixel(x, y, Color.parseColor("#$fg"))
                    }
                    val bmp = Bitmap.createScaledBitmap(small, size, size, false)
                    val out = java.io.ByteArrayOutputStream()
                    bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
                    val rel = args.optString("output").ifBlank { "art/qr-${generated + 1}.png" }
                        .let { if (it.endsWith(".png")) it else it.substringBeforeLast('.') + ".png" }
                    val f = ws.resolve(rel)
                    ws.mkdirs(f)
                    f.writeBytes(out.toByteArray())
                    generated++
                    JSONObject().put("ok", true).put("kind", "png")
                        .put("path", ws.relative(f)).put("bytes", out.size())
                        .put("note", "已生成二维码 PNG").toString()
                } else {
                    val svg = try {
                        QrSvg.build(text, size, accent)
                    } catch (e: IllegalArgumentException) {
                        throw KernelError(e.message ?: "二维码参数不合法")
                    }
                    val rel = args.optString("output").ifBlank { "art/qr-${generated + 1}.svg" }
                        .let { if (it.endsWith(".svg")) it else it.substringBeforeLast('.') + ".svg" }
                    val f = ws.resolve(rel)
                    ws.mkdirs(f)
                    f.writeText(svg, Charsets.UTF_8)
                    generated++
                    JSONObject().put("ok", true).put("kind", "svg")
                        .put("path", ws.relative(f))
                        .put("note", "已生成二维码（SVG 矢量）").toString()
                }
            }
        },
        object : ToolSpec {
            override val name = "mindmap_generate"
            override val description =
                "画一张思维导图（SVG，保存到工作区并出现在交付卡片里）。" +
                    "输入一棵嵌套树（label + children 递归），根在左、子树向右展开。" +
                    "适合知识结构、读书笔记、任务拆解、需求拆分。纯本地渲染，无需网络。最多 6 层。"
            override val parameters = schema(
                JSONObject()
                    .put("tree", JSONObject().put("type", "object")
                        .put("description", "导图树，嵌套结构：{label:\"主题\", children:[{label:\"分支\", children:[…]}]}。" +
                            "例：{label:\"手机\", children:[{label:\"硬件\"},{label:\"软件\", children:[{label:\"系统\"}]}]}"))
                    .put("title", JSONObject().put("type", "string").put("description", "图标题（可选）"))
                    .put("accent", JSONObject().put("type", "string")
                        .put("description", "主色（6 位 hex，如 4C8DFF），缺省用品牌蓝"))
                    .put("output", JSONObject().put("type", "string")
                        .put("description", "保存路径（相对工作区），缺省 art/mindmap-<序号>.svg")),
                listOf("tree"),
            )
            override fun execute(args: JSONObject): String {
                val ws = ctx?.workspace ?: throw KernelError("工作区不可用")
                val treeJson = args.optJSONObject("tree")
                    ?: throw KernelError("tree 不能为空：{label:\"主题\", children:[…]}")
                fun parse(n: JSONObject, depth: Int): MindNode {
                    val kids = n.optJSONArray("children")?.let { a ->
                        (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { parse(it, depth + 1) } }
                    } ?: emptyList()
                    return MindNode(n.optString("label"), kids)
                }
                val root = parse(treeJson, 0)
                val svg = try {
                    MindmapSvg.build(root, args.optString("title"), args.optString("accent").ifBlank { null })
                } catch (e: IllegalArgumentException) {
                    throw KernelError(e.message ?: "思维导图参数不合法")
                }
                val rel = args.optString("output").ifBlank { "art/mindmap-${generated + 1}.svg" }
                    .let { if (it.endsWith(".svg")) it else it.substringBeforeLast('.') + ".svg" }
                val f = ws.resolve(rel)
                ws.mkdirs(f)
                f.writeText(svg, Charsets.UTF_8)
                generated++
                return JSONObject().put("ok", true).put("kind", "svg")
                    .put("path", ws.relative(f))
                    .put("note", "已生成思维导图（SVG 矢量，预览/分享/导出可直接用）").toString()
            }
        },
        object : ToolSpec {
            override val name = "flowchart_generate"
            override val description =
                "画一张流程图（SVG，保存到工作区并出现在交付卡片里）。" +
                    "输入节点与连线，自动分层布局（自上而下）。" +
                    "形状：start=开始（胶囊）/ end=结束 / process=步骤 / decision=判断（菱形，自动标是/否）/ io=输入输出。" +
                    "适合审批流、算法逻辑、操作指引。有环会报错。纯本地渲染，无需网络。"
            override val parameters = schema(
                JSONObject()
                    .put("nodes", JSONObject().put("type", "array")
                        .put("description", "节点数组：[{id:\"a\", label:\"提交申请\", shape:\"start\"}]。" +
                            "shape 可选 start/end/process/decision/io，缺省 process"))
                    .put("edges", JSONObject().put("type", "array")
                        .put("description", "连线数组：[{from:\"a\", to:\"b\", label:\"通过\"}]。" +
                            "decision 节点的出边按顺序自动标「是/否」，显式给 label 则用你的"))
                    .put("title", JSONObject().put("type", "string").put("description", "图标题（可选）"))
                    .put("accent", JSONObject().put("type", "string")
                        .put("description", "主色（6 位 hex，如 4C8DFF），缺省用品牌蓝"))
                    .put("output", JSONObject().put("type", "string")
                        .put("description", "保存路径（相对工作区），缺省 art/flowchart-<序号>.svg")),
                listOf("nodes", "edges"),
            )
            override fun execute(args: JSONObject): String {
                val ws = ctx?.workspace ?: throw KernelError("工作区不可用")
                val nodesArr = args.optJSONArray("nodes")
                if (nodesArr == null || nodesArr.length() == 0) throw KernelError("nodes 不能为空")
                val edgesArr = args.optJSONArray("edges") ?: JSONArray()
                val nodes = (0 until nodesArr.length()).mapNotNull { i ->
                    nodesArr.optJSONObject(i)?.let {
                        FlowNode(it.optString("id"), it.optString("label"), it.optString("shape", "process"))
                    }
                }
                if (nodes.size != nodesArr.length()) throw KernelError("nodes 里有不合法的节点（需要 {id,label,shape?}）")
                if (nodes.any { it.id.isBlank() }) throw KernelError("每个节点都必须有 id")
                val edges = (0 until edgesArr.length()).mapNotNull { i ->
                    edgesArr.optJSONObject(i)?.let { FlowEdge(it.optString("from"), it.optString("to"), it.optString("label")) }
                }
                val svg = try {
                    FlowchartSvg.build(nodes, edges, args.optString("title"), args.optString("accent").ifBlank { null })
                } catch (e: IllegalArgumentException) {
                    throw KernelError(e.message ?: "流程图参数不合法")
                }
                val rel = args.optString("output").ifBlank { "art/flowchart-${generated + 1}.svg" }
                    .let { if (it.endsWith(".svg")) it else it.substringBeforeLast('.') + ".svg" }
                val f = ws.resolve(rel)
                ws.mkdirs(f)
                f.writeText(svg, Charsets.UTF_8)
                generated++
                return JSONObject().put("ok", true).put("kind", "svg")
                    .put("path", ws.relative(f))
                    .put("note", "已生成流程图（SVG 矢量，预览/分享/导出可直接用）").toString()
            }
        },
    )
    }

    /* ---------------- 外部 API ---------------- */

    /**
     * 设置页的「图像端点」按 OpenAI 兼容习惯填的是 base URL（如 `https://api.example.com/v1`），
     * 直接 POST 到 base 必然 404。这里做归一化：已经是完整端点就原样用，否则补
     * `/images/generations`；以 `/` 结尾的 base 也正确处理。
     */
    private fun endpoint(raw: String): String {
        val url = raw.trim().trimEnd('/')
        if (url.isBlank()) throw KernelError("图像端点为空：请到「设置 → 生成模型」填写 base URL 或完整端点")
        val lower = url.lowercase()
        if (lower.endsWith("/images/generations") || lower.endsWith("/generations")) return url
        // 形如 .../v1、.../v1beta、.../openai 的 base：补标准路径
        return "$url/images/generations"
    }

    /** 由 generations 端点推导 edits 端点（同宿主换尾段）；已是 edits 的原样返回 */
    private fun endpointEdits(url: String): String {
        val u = url.trim().trimEnd('/')
        val lower = u.lowercase()
        return when {
            lower.endsWith("/images/edits") || lower.endsWith("/edits") -> u
            lower.endsWith("/images/generations") -> u.removeSuffix("/generations") + "/edits"
            lower.endsWith("/generations") -> u.removeSuffix("/generations") + "/edits"
            else -> "$u/images/edits"
        }
    }
    /** 探测图像端点并存入 gen.json（换厂商/首次使用时触发） */
    private fun probeAndStore() {
        val cfg = apiConfig() ?: throw KernelError("尚未配置图像端点")
        val c = GenProbe.probeImage(cfg.optString("url"), cfg.optString("key"), cfg.optString("model", "gpt-image-1"))
        genCfg().setCapabilities("image", c.toJson())
    }
    private fun callApi(
        cfg: JSONObject,
        prompt: String,
        size: String,
        path: String,
        n: Int = 1,
        args: JSONObject = JSONObject(),
        refImage: java.io.File? = null,
    ): List<File> {
        val ws = ctx?.workspace ?: throw KernelError("工作区不可用")
        val model = args.optString("model").trim().takeIf { it.isNotBlank() }
            ?: cfg.optString("model", "gpt-image-1").ifBlank { "gpt-image-1" }
        val body = JSONObject().apply {
            put("model", model)
            put("prompt", prompt)
            put("size", size)
            put("n", n)
            put("response_format", "b64_json")
            // 可选字段：只在模型给了才发，避免某些兼容端点不认识而 400
            args.optString("negative_prompt").trim().takeIf { it.isNotBlank() }?.let { put("negative_prompt", it) }
            args.optString("style").trim().takeIf { it.isNotBlank() }?.let { put("style", it) }
            args.optString("quality").trim().takeIf { it.isNotBlank() }?.let { put("quality", it) }
        }
        val text: String
        val code: Int
        if (refImage != null) {
            // 图生图：multipart /images/edits（OpenAI wire 形态；image 字段 + 提示词字段）
            val boundary = "dsh-" + java.util.UUID.randomUUID().toString()
            val ext = refImage.extension.lowercase()
            val head = java.io.ByteArrayOutputStream()
            for (k in listOf("model", "prompt", "n", "size", "quality")) {
                val v = body.optString(k)
                if (v.isBlank()) continue
                head.write(("--$boundary\r\n").toByteArray())
                head.write(("Content-Disposition: form-data; name=\"$k\"\r\n\r\n").toByteArray())
                head.write((v + "\r\n").toByteArray())
            }
            head.write(("--$boundary\r\n").toByteArray())
            head.write(("Content-Disposition: form-data; name=\"image\"; filename=\"ref.$ext\"\r\n").toByteArray())
            head.write(("Content-Type: image/${if (ext == "jpg") "jpeg" else ext}\r\n\r\n").toByteArray())
            val req = head.toByteArray() + refImage.readBytes() + ("\r\n--$boundary--\r\n").toByteArray()
            val editUrl = endpointEdits(cfg.optString("url"))
            ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed(editUrl)
            val conn = (URL(editUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 180_000
                doOutput = true
                setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                if (cfg.optString("key").isNotBlank()) {
                    setRequestProperty("Authorization", "Bearer ${cfg.optString("key")}")
                }
            }
            conn.outputStream.use { it.write(req) }
            code = conn.responseCode
            text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            conn.disconnect()
        } else {
            val genUrl = endpoint(cfg.optString("url"))
            ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed(genUrl)
            val conn = (URL(genUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 120_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                if (cfg.optString("key").isNotBlank()) {
                    setRequestProperty("Authorization", "Bearer ${cfg.optString("key")}")
                }
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            code = conn.responseCode
            text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            conn.disconnect()
        }
        if (code !in 200..299) {
            val low = text.lowercase()
            val hint = when {
                "edits" in low && ("404" in low || "not found" in low) -> "端点不支持 /images/edits（图生图）；去掉 image_path 走文生图"
                "quality" in low -> "端点不认这个 quality 档位；去掉该参数或换 auto"
                "model" in low -> "端点没有这个模型；用 model 参数换端点上已存在的，或到设置 → 生成模型确认"
                else -> "检查端点配置（设置 → 生成模型）与参数"
            }
            throw KernelError("图像 API HTTP $code：${text.take(300)}（提示：$hint）")
        }
        val root = JSONObject(text)
        val data = root.optJSONArray("data") ?: throw KernelError("图像 API 没有返回 data")
        if (data.length() == 0) throw KernelError("图像 API 返回了空的 data")
        val files = ArrayList<File>()
        for (i in 0 until data.length()) {
            val item = data.optJSONObject(i) ?: continue
            val b64 = item.optString("b64_json")
            val url = item.optString("url")
            val bytes = when {
                b64.isNotBlank() -> android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)
                url.isNotBlank() -> ai.deepseek.harness.mobile.kernel.HttpDownload.toBytes(url)
                else -> continue
            }
            val baseRel = path.ifBlank { "art/img-${System.currentTimeMillis()}" }
                .let { if (it.endsWith(".png") || it.endsWith(".jpg")) it.substringBeforeLast('.') else it }
            val rel = if (data.length() == 1) "$baseRel.png" else "$baseRel-${i + 1}.png"
            val file = ws.resolve(rel)
            ws.mkdirs(file)
            file.writeBytes(bytes)
            files.add(file)
        }
        if (files.isEmpty()) throw KernelError("图像 API 没有返回可用的图片数据")
        return files
    }

    /* ---------------- 内置 SVG ---------------- */

    private data class Theme(val bg: String, val fg: String, val accent: String, val sub: String)

    private val themes = mapOf(
        "midnight" to Theme("#0B1020", "#F2F5FF", "#6E8BFF", "#98A6C8"),
        "dawn" to Theme("#FFF7ED", "#1F1B16", "#F97316", "#7C6A58"),
        "forest" to Theme("#0E1F17", "#EAF7F0", "#34C759", "#8FBBA4"),
        "paper" to Theme("#F7F5EF", "#1B1A17", "#1B1A17", "#6B665C"),
    )

    /**
     * 生成一张 1024×1280 的 SVG：底色 + 两团柔和色光 + 细网格 + 标题/副标题 + 落款。
     * 全部是确定性排版，同样的输入永远得到同一张图（便于复现与对比）。
     */
    private fun renderSvg(args: JSONObject, prompt: String): File {
        val ws = ctx?.workspace ?: throw KernelError("工作区不可用")
        val theme = themes[args.optString("theme", "midnight")] ?: themes.getValue("midnight")
        val title = (args.optString("title").ifBlank { prompt }).take(22)
        val subtitle = args.optString("subtitle").take(48)
        val esc = { s: String ->
            s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        }
        val grid = buildString {
            var x = 0
            while (x <= 1024) { append("<line x1=\"$x\" y1=\"0\" x2=\"$x\" y2=\"1280\"/>"); x += 64 }
            var y = 0
            while (y <= 1280) { append("<line x1=\"0\" y1=\"$y\" x2=\"1024\" y2=\"$y\"/>"); y += 64 }
        }
        val svg = """
            <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1280" viewBox="0 0 1024 1280">
              <defs>
                <radialGradient id="g1" cx="30%" cy="24%" r="60%">
                  <stop offset="0%" stop-color="${theme.accent}" stop-opacity="0.45"/>
                  <stop offset="100%" stop-color="${theme.accent}" stop-opacity="0"/>
                </radialGradient>
                <radialGradient id="g2" cx="78%" cy="82%" r="55%">
                  <stop offset="0%" stop-color="${theme.accent}" stop-opacity="0.28"/>
                  <stop offset="100%" stop-color="${theme.accent}" stop-opacity="0"/>
                </radialGradient>
              </defs>
              <rect width="1024" height="1280" fill="${theme.bg}"/>
              <g stroke="${theme.sub}" stroke-opacity="0.10" stroke-width="1">$grid</g>
              <rect width="1024" height="1280" fill="url(#g1)"/>
              <rect width="1024" height="1280" fill="url(#g2)"/>
              <text x="96" y="600" fill="${theme.fg}" font-family="sans-serif" font-size="76" font-weight="700">${esc(title)}</text>
              ${if (subtitle.isBlank()) "" else "<text x=\"96\" y=\"676\" fill=\"${theme.sub}\" font-family=\"sans-serif\" font-size=\"30\">${esc(subtitle)}</text>"}
              <rect x="96" y="720" width="88" height="6" rx="3" fill="${theme.accent}"/>
              <text x="96" y="1180" fill="${theme.sub}" font-family="monospace" font-size="22">DeepSeek Harness · 本机生成</text>
            </svg>
        """.trimIndent()
        val rel = args.optString("path").ifBlank { "art/poster-${System.currentTimeMillis()}.svg" }
            .let { if (it.endsWith(".svg")) it else it.substringBeforeLast('.') + ".svg" }
        val file = ws.resolve(rel)
        ws.mkdirs(file)
        file.writeText(svg, Charsets.UTF_8)
        return file
    }
}
