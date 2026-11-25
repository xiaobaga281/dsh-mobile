package ai.deepseek.harness.mobile.kernel.plugin.builtin.doc

import ai.deepseek.harness.mobile.kernel.GenConfig
import ai.deepseek.harness.mobile.kernel.GenProbe
import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.jobs.JobRegistry
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * 视频生成 —— 调用用户在「设置 → 生成模型」里配置的视频端点
 * （OpenAI `/videos` 兼容：创建任务 → 轮询状态 → 下载成品）。
 *
 * 边界要说清：手机上跑不了视频扩散模型，必须配外部 API；没配就如实报错，不假装生成。
 * 产出是**真的 .mp4/.webm 文件**，写入工作区，并作为一条媒体消息即时插进对话（可播放）。
 *
 * 模型可见参数（对齐端点真实能力，避免「少参数生成不了」）：
 *   - 文生视频：prompt + duration/aspect_ratio/size
 *   - 图生视频：image_path 给参考图（multipart `input_reference`，OpenAI sora-2 同款）
 *   - model 按次覆盖：一个端点常挂多个视频模型
 *   - seconds 的字符串/数字两种 wire 形态 400 时互换重试（端点规范不一致，实测踩过）
 */
class VideoPlugin : KernelPlugin {
    override val id = "video"
    override val name = "视频生成"
    override val description = "调用已配置的视频模型生成视频（支持图生视频），成品进工作区并显示在对话里"
    override val version = "1.1.0"

    private var ctx: PluginContext? = null
    private var gen: GenConfig? = null
    private var sink: ((JSONObject) -> Unit)? = null
    private var made = 0

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        val dir = (ctx.service("plugin.dir") as? File)?.parentFile ?: ctx.workspace.root
        gen = GenConfig(File(dir, "gen.json"))
        sink = ctx.service("media.sink") as? ((JSONObject) -> Unit)
    }

    override fun onUnload() { ctx = null; gen = null; sink = null }

    override fun status(): Map<String, String> = buildMap {
        put("已生成", made.toString())
        put("视频模型", if (gen?.section("video")?.optBoolean("configured") == true) "已配置" else "未配置")
    }

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    /**
     * 工具目录**动态生成**：mode/size 的枚举值来自探测习得的端点契约（gen.json
     * 的 capabilities）。没有契约（未探测）时用通用枚举并提示探测；
     * 探测/换厂商后调 ctx.refreshTools("video") 重索引，模型即刻看到新枚举。
     */
    override val tools: List<ToolSpec> get() = buildTools()

    private fun contract(): GenProbe.Contract? =
        gen?.section("video")?.optJSONObject("capabilities")?.let { GenProbe.Contract.from(it) }

    companion object {
        /** mode 枚举唯一来源：探测习得的契约；没有契约就是空（不编造端点值）。 */
        internal fun modeEnum(cap: GenProbe.Contract?): List<String> =
            cap?.modes?.distinct().orEmpty()

        /**
         * auto 的客户端推断：有参考图时，从契约里挑一个图生 mode（image/reference/i2v）。
         * 没有契约或契约里没有图生模式时保持 auto（执行时不会把 auto 发给端点）。
         */
        internal fun autoModeFor(imageProvided: Boolean, cap: GenProbe.Contract?): String {
            if (!imageProvided) return "auto"
            return modeEnum(cap).firstOrNull {
                it.contains("image", ignoreCase = true) ||
                    it.contains("ref", ignoreCase = true) ||
                    it.contains("i2v", ignoreCase = true)
            } ?: "auto"
        }
    }

    private fun buildTools(): List<ToolSpec> {
        val cap = contract()
        // mode 枚举只来自探测习得的端点契约。没有契约时不编造枚举 —— 让 mode 保持自由字符串，
        // 由模型按端点文档传值（端点自行裁决），或先调 probe_gen_endpoint 学习。
        val modes = modeEnum(cap)
        val sizeHint = cap?.sizes?.takeIf { it.isNotEmpty() }?.joinToString(" / ")
            ?: "1280x720 / 720x1280"
        val modeHint = if (modes.isNotEmpty()) {
            "端点探测习得的合法 mode：${modes.joinToString(" / ")}。"
        } else {
            "mode 方言尚未探测：先调 probe_gen_endpoint 学习；也可以不传 mode，让端点自行判断。"
        }
        val probeHint = if (cap == null)
            "首次使用建议先调 probe_gen_endpoint 探测端点契约（合法 mode/size 由端点决定）。"
        else "端点契约已探测：mode=${cap.modes.ifEmpty { listOf("（端点未要求）") }} / size=${cap.sizes}。"
        val modeProp = JSONObject().put("type", "string").put("description",
            "$modeHint 不传 mode = 客户端按有无参考图推断（有 image_path 且契约里有图生模式时自动选它），不会把推断值原样发给端点。")
        if (modes.isNotEmpty()) modeProp.put("enum", GenProbe.strArr(modes))
        return listOf(
        object : ToolSpec {
            override val name = "video_generate"
            override val description =
                "生成一段视频并保存到工作区，同时作为可播放的媒体消息出现在对话里。" +
                    "给 image_path 工作区参考图走图生视频，否则文生视频。" +
                    "模式取值由端点方言决定：$modeHint" +
                    "需要用户在「设置 → 生成模型」里配置视频端点；未配置时会明确报错，不要伪装成功。" +
                    "生成通常要 30–180 秒。run_in_background=true 会立即返回 job id，完成后视频进对话并自动续跑；" +
                    "否则调用会一直等待到出片或超时（上限 10 分钟）。" + probeHint
            override val parameters = schema(
                JSONObject()
                    .put("mode", modeProp)
                    .put("prompt", JSONObject().put("type", "string")
                        .put("description", "画面描述：主体、动作、镜头、风格"))
                    .put("duration", JSONObject().put("type", "number")
                        .put("description", "时长（秒），默认 5；端点只认白名单值（如 4/8/12）时给白名单内的值"))
                    .put("aspect_ratio", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("16:9", "9:16", "1:1")))
                        .put("description", "画面比例：横屏 16:9 / 竖屏 9:16（手机端最常用）/ 方形 1:1，默认 16:9"))
                    .put("size", JSONObject().put("type", "string")
                        .put("description", "分辨率。端点合法值：$sizeHint（给了就优先于 aspect_ratio）"))
                    .put("image_path", JSONObject().put("type", "string")
                        .put("description", "图生视频：工作区里的参考图（png/jpg），作为首帧参考让图动起来"))
                    .put("model", JSONObject().put("type", "string")
                        .put("description", "临时换用端点上的另一个视频模型（默认用设置里配的）"))
                    .put("path", JSONObject().put("type", "string")
                        .put("description", "保存路径（相对工作区），默认 art/<时间戳>.mp4"))
                    .put("run_in_background", JSONObject().put("type", "boolean")
                        .put("description", "后台生成，立即返回 job id；适合 10 分钟级长任务。完成后结果进对话并自动续跑")),
                listOf("prompt"),
            )
            override fun execute(args: JSONObject): String {
                val cfg = gen?.section("video")
                    ?: throw KernelError("生成模型配置未就绪")
                if (cfg.optString("url").isBlank()) {
                    throw KernelError("尚未配置视频模型：请到「设置 → 生成模型」填写视频端点后再试")
                }
                val prompt = args.optString("prompt").trim()
                if (prompt.isBlank()) throw KernelError("prompt 不能为空")
                val ws = ctx?.workspace ?: throw KernelError("工作区不可用")
                if (args.optBoolean("run_in_background")) {
                    val reg = ctx?.service("job.registry") as? JobRegistry
                        ?: throw KernelError("后台任务服务未装配，无法后台生成；请去掉 run_in_background")
                    val owner = ctx?.service("agent.session") as? String ?: ""
                    val snapshot = JSONObject(args.toString())
                    val job = reg.start("video_generate: ${prompt.take(30)}", owner) { j ->
                        try {
                            val file = generate(cfg, prompt, snapshot)
                            j.append(publishVideo(file, ws).toString())
                            0
                        } catch (e: Throwable) {
                            j.append("视频生成失败：${e.message ?: e::class.simpleName}")
                            1
                        }
                    }
                    return JSONObject().put("ok", true).put("job_id", job.id)
                        .put("running", true)
                        .put("note", "视频在后台生成；完成后会自动续跑，也可用 job_output 查看进度/结果").toString()
                }
                val result = runCatching { generate(cfg, prompt, args) }
                    .getOrElse { e ->
                        val msg = e.message ?: e::class.simpleName ?: "unknown"
                        // 参数被端点拒绝（400 类）：自愈——重新探测一次契约再报可行动错误，
                        // 模型下一步用新枚举重试（同轮工具目录刷新会带上）
                        if (msg.contains("HTTP 4")) {
                            runCatching { probeAndStore() }
                            // 探测可能学到了新契约：刷新工具索引让 schema 缓存失效，
                            // 同轮下一步的 toolDefsFor() 会拿到新枚举
                            ctx?.refreshTools("video")
                            val cap2 = contract()
                            val hint = buildString {
                                if (cap2?.modes?.isNotEmpty() == true) append("端点合法 mode：${cap2.modes}。")
                                if (cap2?.sizes?.isNotEmpty() == true) append("端点合法 size：${cap2.sizes}。")
                            }
                            throw KernelError("视频生成失败：$msg${if (hint.isBlank()) "" else "（$hint）"}")
                        }
                        throw KernelError("视频生成失败：$msg")
                    }
                return publishVideo(result, ws).toString()
            }
        },
        object : ToolSpec {
            override val name = "probe_gen_endpoint"
            override val description =
                "探测生成端点的真实能力（合法 mode 值 / size 白名单 / mode 是否必填），" +
                    "结果存入配置并立即生效——video_generate 的枚举会随之更新。" +
                    "换视频厂商、端点报「invalid mode / mode is required」时先调这个。" +
                    "探测请求全部会被端点校验拒绝（size 用非法探针值），不会真的创建视频任务。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String {
                probeAndStore()
                // 契约变了，工具 schema 必须立刻跟着变：不刷新注册表缓存，本轮/下一轮
                // 模型看到的仍是旧枚举（探测结果「已生效」只写在返回值里，schema 没动）。
                ctx?.refreshTools(id)
                val c = contract()
                val modes: List<String> = c?.modes ?: emptyList()
                val sizes: List<String> = c?.sizes ?: emptyList()
                return JSONObject().put("ok", true)
                    .put("modes", GenProbe.strArr(modes))
                    .put("modeRequired", c?.modeRequired ?: false)
                    .put("sizes", GenProbe.strArr(sizes))
                    .put("note", "契约已探测并存入配置；video_generate 的 mode/size 枚举已按端点方言更新。" +
                        "traces: ${GenProbe.strArr(c?.traces ?: emptyList())}").toString()
            }
        },
    )
    }

    /** 把生成好的视频推给对话（前台与后台任务共用），返回模型可见的回执。 */
    private fun publishVideo(result: File, ws: ai.deepseek.harness.mobile.kernel.Workspace): JSONObject {
        val rel = ws.relative(result)
        synchronized(this) { made++ }
        // dataUrl 是前端 <video> 的播放源，但 base64 会让字符串膨胀 1.37 倍、
        // JSONObject 再放大内存峰值 —— 大视频只给路径不内嵌，防 OOM。
        val ev = JSONObject().apply {
            put("kind", "video")
            put("name", result.name)
            put("path", rel)
            put("mime", "video/mp4")
            put("bytes", result.length())
            put("sessionId", ctx?.service("agent.session") as? String ?: "")
        }
        if (result.length() <= 12L * 1024 * 1024) {
            ev.put("dataUrl", "data:video/mp4;base64," +
                android.util.Base64.encodeToString(result.readBytes(), android.util.Base64.NO_WRAP))
        }
        sink?.invoke(ev)
        return JSONObject().put("ok", true).put("kind", "api").put("path", rel)
            .put("bytes", result.length())
            .put("note", if (ev.has("dataUrl")) "视频已生成并显示在对话里"
                else "视频已生成：$rel（文件较大未内嵌预览，在文件页查看）")
    }

    /** 探测端点契约并存入 gen.json（换厂商/首次使用时由 probe_gen_endpoint 触发） */
    private fun probeAndStore() {
        val cfg = gen?.section("video") ?: throw KernelError("生成模型配置未就绪")
        val url = cfg.optString("url")
        if (url.isBlank()) throw KernelError("尚未配置视频端点")
        val model = cfg.optString("model").ifBlank { "sora-2" }
        val c = GenProbe.probeVideo(url, cfg.optString("key"), model)
        gen?.setCapabilities("video", c.toJson())
    }

    /* ---------------- OpenAI /videos 兼容：创建 → 轮询 → 下载 ---------------- */

    private fun generate(cfg: JSONObject, prompt: String, args: JSONObject): File {
        val ws = ctx?.workspace ?: throw KernelError("工作区不可用")
        val base = cfg.optString("url").trim().trimEnd('/')
        ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed("$base/videos")
        val key = cfg.optString("key")
        // model 允许按次覆盖：一个端点常挂多个视频模型，能力/价格不同
        val model = args.optString("model").ifBlank { cfg.optString("model").ifBlank { "sora-2" } }
        val duration = args.optInt("duration", 5).coerceIn(2, 20)
        // 比例 → 分辨率映射（size 显式给出时优先）；竖屏 9:16 是手机端最高频需求
        val aspect = args.optString("aspect_ratio").ifBlank { "16:9" }
        val size = args.optString("size").ifBlank {
            when (aspect) {
                "9:16" -> "720x1280"
                "1:1" -> "1024x1024"
                else -> "1280x720"
            }
        }
        // 生成模式：不做硬编码校验——端点方言由探测习得或由端点自行裁决。
        // 有契约时按契约白名单校验（可行动错误）；无契约直接透传让端点自行裁决。
        val imageRel = args.optString("image_path").trim().takeIf { it.isNotBlank() }
        // 端点契约校验：探测习得的白名单（modes/sizes）在场时，非法值直接报可行动错误，
        // 不用等端点 400 再猜。显式给了合法值照常透传；缺省时按契约推断图生模式。
        val cap = cfg.optJSONObject("capabilities")?.let { GenProbe.Contract.from(it) }
        val requestedMode = args.optString("mode").trim()
        val mode = if (requestedMode.isNotBlank() && requestedMode != "auto") {
            requestedMode
        } else {
            autoModeFor(imageRel != null, cap)
        }
        val contractHint = if (cap == null) ""
            else buildString {
                if (cap.modes.isNotEmpty()) append("端点合法 mode：${cap.modes}。")
                if (cap.sizes.isNotEmpty()) append("端点合法 size：${cap.sizes}。")
                append("可先调 probe_gen_endpoint 重新探测。")
            }
        if (cap != null && cap.modes.isNotEmpty() && mode != "auto" && mode !in cap.modes) {
            throw KernelError("端点不认 mode=$mode。$contractHint")
        }
        // 图生视频参考图：工作区相对路径 → 绝对文件；仅支持 png/jpg
        val refImage = imageRel?.let { rel ->
            val f = ws.resolve(rel)
            if (!f.isFile) throw KernelError("参考图不存在：$rel（先用相机/图片工具把图放进工作区）")
            val ext = f.extension.lowercase()
            if (ext !in setOf("png", "jpg", "jpeg")) {
                throw KernelError("参考图必须是 png 或 jpg：$rel（当前 .$ext）")
            }
            f
        }

        fun conn(url: String, method: String, body: String? = null): HttpURLConnection =
            (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 20_000
                readTimeout = 120_000
                doOutput = body != null
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                if (key.isNotBlank()) setRequestProperty("Authorization", "Bearer $key")
                if (body != null) outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }

        fun readBody(c: HttpURLConnection): String =
            ((if (c.responseCode in 200..299) c.inputStream else c.errorStream)
                ?.bufferedReader()?.use { it.readText() }).orEmpty()

        // OpenAI /videos 规范：seconds 是字符串；部分兼容端点只认数字 —— 400 时互换重试一次
        val fields = JSONObject().apply {
            put("model", model)
            put("prompt", prompt)
            put("seconds", duration.toString())
            put("size", size)
            // mode 透传：**不写死枚举**——端点自己按 mode 分流（agnes 的 text/reference、
            // OpenAI 系没有该字段）。auto 是客户端推断语义，不发给端点。
            if (mode != "auto" && mode.isNotBlank()) put("mode", mode)
        }

        fun post(body: ByteArray, contentType: String): Pair<Int, String> {
            val c = (URL("$base/videos").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 20_000
                readTimeout = 120_000
                doOutput = true
                setRequestProperty("Content-Type", contentType)
                if (key.isNotBlank()) setRequestProperty("Authorization", "Bearer $key")
                outputStream.use { it.write(body) }
            }
            val r = c.responseCode to readBody(c)
            c.disconnect()
            return r
        }

        fun postJson(o: JSONObject): Pair<Int, String> =
            post(o.toString().toByteArray(Charsets.UTF_8), "application/json; charset=utf-8")

        /** 图生视频 wire：JSON base64（agnes 等国内厂商）——图片 base64 放进 body 的某个字段 */
        fun withImageBase64(o: JSONObject, img: File, field: String): JSONObject {
            val b64 = android.util.Base64.encodeToString(img.readBytes(), android.util.Base64.NO_WRAP)
            val out = JSONObject(o.toString())
            // images 约定是数组；image / image_url 是单值
            if (field == "image" || field == "image_url") out.put(field, b64)
            else out.put(field, JSONArray().apply { put(b64) })
            return out
        }

        /** 图生视频：multipart `input_reference`（OpenAI sora-2 的 wire 形态） */
        fun postMultipart(o: JSONObject, img: File): Pair<Int, String> {
            val boundary = "dsh-" + UUID.randomUUID().toString()
            val ext = img.extension.lowercase()
            val head = ByteArrayOutputStream()
            for (k in o.keys()) {
                head.write(("--$boundary\r\n").toByteArray())
                head.write(("Content-Disposition: form-data; name=\"$k\"\r\n\r\n").toByteArray())
                head.write((o.optString(k) + "\r\n").toByteArray())
            }
            head.write(("--$boundary\r\n").toByteArray())
            head.write(("Content-Disposition: form-data; name=\"input_reference\"; filename=\"ref.$ext\"\r\n").toByteArray())
            head.write(("Content-Type: image/${if (ext == "jpg") "jpeg" else ext}\r\n\r\n").toByteArray())
            val body = head.toByteArray() + img.readBytes() +
                ("\r\n--$boundary--\r\n").toByteArray()
            return post(body, "multipart/form-data; boundary=$boundary")
        }

        fun createError(code: Int, body: String): String {
            val low = body.lowercase()
            val hint = when {
                // 队列满 = 参数全对、只是端点忙：这是重试信号，不是配置问题
                "queue_full" in low || "queue is full" in low || "busy" in low || "retry later" in low ->
                    "参数已通过端点校验，只是服务端队列满——等 1–2 分钟重试；不要改参数"
                "second" in low || "duration" in low -> "端点不认这个时长；改用白名单值（如 4/8/12 秒）重试"
                "size" in low || "resolution" in low || "dimension" in low -> "端点不认这个分辨率；改用 1280x720 / 720x1280 重试"
                "model" in low -> "端点没有这个模型；到设置 → 生成模型确认模型名，或用 model 参数换端点上已存在的"
                "image" in low || "reference" in low -> "参考图被端点拒绝：换一张更小的 png/jpg，或去掉 image_path 走纯文生视频"
                else -> "检查端点配置（设置 → 生成模型）与参数"
            }
            return "创建任务 HTTP $code：${body.take(300)}（提示：$hint）"
        }

        // 参考图 wire 形态：**按探测习得的契约执行**（通用——不绑任何厂商）。
        //   json-base64 → 图片 base64 放进 JSON body（agnes 的 images 字段）
        //   multipart   → 以文件上传 input_reference（OpenAI sora-2）
        //   未探测      → 两种都试：先 json-base64（字段候选依次 images/image），
        //                 被端点明确拒绝后再走 multipart。两条路都支持，谁都不破。
        val wire = cap?.imageWire.orEmpty()
        val field = cap?.imageField?.takeIf { it.isNotBlank() } ?: "images"
        val jsonFirst = refImage != null && wire != "multipart"
        val multipartOnly = refImage != null && wire == "multipart"
        fun attempt(secondsValue: Any): Pair<Int, String> {
            val f = JSONObject(fields.toString()).put("seconds", secondsValue)
            if (refImage == null) return postJson(f)
            if (multipartOnly) return postMultipart(f, refImage)
            // json-first：字段候选依次试；都被拒才落 multipart
            for (candidate in if (wire == "json-base64") listOf(field) else listOf("images", "image")) {
                val r = postJson(withImageBase64(f, refImage, candidate))
                if (r.first in 200..299) return r
                val low = r.second.lowercase()
                val imageRejected = ("image" in low || "reference" in low) &&
                    ("invalid" in low || "require" in low || "missing" in low || "unsupported" in low)
                if (!imageRejected && r.first != 400) return r  // 别的错误（如 size）直接返回，让上层提示
            }
            return postMultipart(f, refImage)
        }

        var (createCode, createText) = attempt(duration.toString())
        if (createCode == 400) {
            // seconds 的字符串/数字形态在不同端点间不一致：互换重试一次
            val r2 = attempt(duration)
            if (r2.first in 200..299) { createCode = r2.first; createText = r2.second }
        }
        if (createCode !in 200..299) {
            throw IllegalStateException(createError(createCode, createText))
        }
        val job = runCatching { JSONObject(createText) }.getOrNull() ?: throw IllegalStateException("创建响应无法解析")
        val id = job.optString("id").ifBlank { job.optJSONObject("data")?.optString("id") ?: "" }
        if (id.isBlank()) throw IllegalStateException("创建响应里没有任务 id：${createText.take(200)}")

        // 轮询直到出片（上限 10 分钟）
        val deadline = System.currentTimeMillis() + 10 * 60_000
        var videoUrl = ""
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(5000)
            val poll = conn("$base/videos/$id", "GET")
            val pollText = readBody(poll)
            val pollCode = poll.responseCode
            poll.disconnect()
            if (pollCode !in 200..299) throw IllegalStateException("查询任务 HTTP $pollCode")
            val state = runCatching { JSONObject(pollText) }.getOrNull() ?: continue
            val status = state.optString("status").ifBlank { state.optJSONObject("data")?.optString("status") ?: "" }
            when (status) {
                "completed", "succeeded" -> {
                    videoUrl = state.optString("video_url")
                        .ifBlank { state.optJSONObject("data")?.optString("video_url") ?: "" }
                    if (videoUrl.isBlank()) videoUrl = state.optString("url").ifBlank {
                        state.optJSONObject("data")?.optString("url") ?: ""
                    }
                    break
                }
                "failed", "cancelled", "error" -> throw IllegalStateException(
                    "视频任务失败（$status）：${(state.optString("error").take(200))}",
                )
            }
        }
        if (videoUrl.isBlank()) throw IllegalStateException("等待超时（10 分钟）仍未出片")

        // 流式落盘（原实现把整段视频读进内存再 base64 一份，中端机 OOM 风险高），带超时
        val rel = args.optString("path").ifBlank { "art/video-${System.currentTimeMillis()}.mp4" }
            .let { if (it.contains('.')) it else "$it.mp4" }
        val file = ws.resolve(rel)
        ai.deepseek.harness.mobile.kernel.HttpDownload.toFile(videoUrl, file)
        return file
    }
}
