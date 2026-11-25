package ai.deepseek.harness.mobile.kernel

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 生成端点能力探测 —— 错误驱动的契约学习（对齐「一切皆插件」：方言由运行时习得，不写死）。
 *
 * 各厂商视频/图像端点的 mode 取值、size 格式、必填参数都不同。端点的校验错误本身就是
 * 说明书：`mode is required`（必填）、`invalid mode`（候选不合法）、
 * `size must be one of 720P` + valid_sizes（白名单直接给出）。
 *
 * 探针逐候选发**带非法 size 的请求**——size 校验必然拒绝（真实 size 不叫 PROBE_INVALID），
 * 所以探测永不误创建真实任务（不产生费用），从错误流里学出契约：
 *   · data.param == "mode" / "mode is required" → mode 必填
 *   · 错误不再是 mode 类 → 该候选合法（记录进契约）
 *   · 任何一步的 valid_sizes → size 白名单
 *
 * [VideoContractLearner] 是纯 JVM 的学习器（可单测）；[probeVideo]/[probeImage] 只负责 HTTP。
 */
object GenProbe {

    /** Android JSONArray(List) 有重载歧义——逐条 put 绕过 */
    fun strArr(items: List<String>): JSONArray = JSONArray().apply { items.forEach { put(it) } }

    private const val TIMEOUT = 40_000
    private const val SIZE_PROBE = "PROBE_INVALID"
    /** 探测用极小合法 PNG（32x32 纯色）——配合非法 size 保证请求必被校验拒绝 */
    private val TINY_PNG_B64: String by lazy {
        val w = 32; val h = 32
        val raw = java.io.ByteArrayOutputStream()
        for (y in 0 until h) {
            raw.write(0)
            for (x in 0 until w) { raw.write(200); raw.write(60); raw.write(60) }
        }
        val png = java.io.ByteArrayOutputStream()
        png.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        fun chunk(type: String, data: ByteArray) {
            val len = java.nio.ByteBuffer.allocate(4).putInt(data.size).array()
            val td = type.toByteArray(Charsets.US_ASCII) + data
            val crc = java.util.zip.CRC32().apply { update(td) }.value
            png.write(len); png.write(td); png.write(java.nio.ByteBuffer.allocate(4).putInt(crc.toInt()).array())
        }
        val ihdr = java.nio.ByteBuffer.allocate(13)
            .putInt(w).putInt(h).put(8).put(2).put(0).put(0).put(0).array()
        chunk("IHDR", ihdr)
        val deflated = java.io.ByteArrayOutputStream().let { bos ->
            java.util.zip.DeflaterOutputStream(bos).use { it.write(raw.toByteArray()) }
            bos.toByteArray()
        }
        chunk("IDAT", deflated)
        chunk("IEND", ByteArray(0))
        android.util.Base64.encodeToString(png.toByteArray(), android.util.Base64.NO_WRAP)
    }


    /** 学到的契约（写入 gen.json 的 capabilities，供工具 schema 动态生成与执行期校验） */
    data class Contract(
        /** 合法的 mode 值（空 = 端点不要求 mode，OpenAI 风格） */
        val modes: List<String>,
        /** mode 是否必填 */
        val modeRequired: Boolean,
        /** 合法的 size 值（空 = 端点没给白名单，按原样透传） */
        val sizes: List<String>,
        /** 探测过程原始错误（诊断用，最多 8 条） */
        val traces: List<String>,
        /**
         * 参考图的 wire 形态：json-base64 = 图片 base64 放进 JSON body 的 [imageField]
         * （agnes 等国内厂商）；multipart = 以文件形式上传 input_reference（OpenAI sora-2）。
         * 空串 = 未探测（调用方按端点报错自助重试）。
         */
        val imageWire: String = "",
        /** json-base64 形态下的字段名（如 images / image） */
        val imageField: String = "",
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            // JSONArray(List) 在 Android 上可能走 JSONArray(Object) 重载并抛
            // "Not a primitive array" —— 逐条 put 绕过这个坑
            fun strArr(items: List<String>): JSONArray = JSONArray().apply { items.forEach { put(it) } }
            put("modes", strArr(modes))
            put("modeRequired", modeRequired)
            put("sizes", strArr(sizes))
            put("probedAt", System.currentTimeMillis())
            put("traces", strArr(traces.take(8)))
            if (imageWire.isNotBlank()) put("imageWire", imageWire)
            if (imageField.isNotBlank()) put("imageField", imageField)
        }

        companion object {
            fun from(o: JSONObject): Contract = Contract(
                modes = o.optJSONArray("modes")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList(),
                modeRequired = o.optBoolean("modeRequired"),
                sizes = o.optJSONArray("sizes")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList(),
                traces = o.optJSONArray("traces")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList(),
                imageWire = o.optString("imageWire"),
                imageField = o.optString("imageField"),
            )
        }
    }

    /** 端点校验错误的归一视图（各厂商错误信封 → 结构化字段） */
    class Err(body: String) {
        val json: JSONObject? = runCatching { JSONObject(body) }.getOrNull()
        val message: String = (json?.optString("message") ?: "").ifBlank { body.take(300) }
        val low: String = message.lowercase()
        val param: String = json?.optJSONObject("data")?.optString("param") ?: ""
        val validSizes: List<String> = json?.optJSONObject("data")?.optJSONArray("valid_sizes")
            ?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()

        /**
         * 端点直接给出的合法 mode 列表 —— 有的方言用 valid_modes / supported_modes，
         * 有的把候选写在 message 里（"valid modes: text, reference"）。
         * 能读到就直接用，不再靠候选清单暴力试。
         */
        val validModes: List<String> = run {
            val out = mutableListOf<String>()
            fun addArray(o: JSONObject?, keys: List<String>) {
                if (o == null) return
                for (key in keys) {
                    val arr = o.optJSONArray(key) ?: continue
                    for (i in 0 until arr.length()) {
                        arr.optString(i).trim().takeIf { it.isNotEmpty() }?.let { out.add(it) }
                    }
                }
            }
            val data = json?.optJSONObject("data")
            val keys = listOf("valid_modes", "supported_modes", "allowed_modes", "modes", "mode_enum")
            addArray(data, keys)
            addArray(json, keys)
            if (out.isEmpty()) out.addAll(modesFromMessage(message))
            out.distinct()
        }

        private fun modesFromMessage(msg: String): List<String> {
            val m = Regex(
                "(?i)(?:valid|supported|allowed)\\s+modes?\\s*(?:are|:|=)\\s*([^.\\n]+)",
            ).find(msg) ?: Regex(
                "(?i)mode\\s+must\\s+be\\s+one\\s+of\\s*:?\\s*([^.\\n]+)",
            ).find(msg) ?: return emptyList()
            return m.groupValues[1]
                .split(',', '|', '/', ' ', '\t', '"', '\'')
                .map { it.trim().trim('"', '\'') }
                .filter { it.matches(Regex("[A-Za-z0-9_-]{1,32}")) && it.lowercase() !in setOf("or", "and") }
                .distinct()
        }
    }

    /**
     * 视频契约学习器：喂进端点的错误响应，逐步学出 mode/size 契约。
     * 纯 JVM、无网络 —— GenProbe.probeVideo 只负责发请求。
     */
    class VideoContractLearner(val model: String) {
        val modes = mutableListOf<String>()
        var modeRequired = false
        var sizes = listOf<String>()
        val traces = mutableListOf<String>()
        val tried = mutableSetOf<String>()

        /** mode 候选清单（探测的搜索空间——仅用于发现，不是对外接口） */
        val candidates = listOf(
            "text", "reference", "image", "text2video", "image2video", "t2v", "i2v",
            "video", "standard", "pro", "quality", "fast",
        )

        /** 基线错误（不带 mode、size 非法）：暴露最严格的前置条件；端点直接给列表时直接收录 */
        fun baseline(e: Err) {
            traces.add(e.message.take(200))
            if (e.validSizes.isNotEmpty()) sizes = e.validSizes
            if (e.param == "mode" || "mode is required" in e.low) modeRequired = true
            addModes(e.validModes)
        }

        /**
         * 喂一个 mode 候选的探测结果。
         * @return true = 该候选通过了 mode 校验（已记录进契约）；false = 不合法，继续试下一个
         */
        fun modeCandidate(candidate: String, e: Err): Boolean {
            tried.add(candidate)
            if (e.validSizes.isNotEmpty()) sizes = e.validSizes
            addModes(e.validModes)
            if ("invalid mode" in e.low || e.param == "mode") return false
            if (candidate !in modes) modes.add(candidate)
            traces.add("mode=$candidate 通过（下一校验：${e.param.ifBlank { e.message.take(60) }}）")
            return true
        }

        private fun addModes(values: List<String>) {
            for (value in values) if (value !in modes) modes.add(value)
        }

        fun contract(): Contract = Contract(modes.distinct(), modeRequired, sizes.toList(), traces.toList())
    }

    /** 视频端点探测（POST {base}/videos）：学完即返回，绝不发出可创建任务的合法请求。
     *  网络/解析异常不会抛出——返回带错误 traces 的空契约，调用方安全降级。 */
    fun probeVideo(baseUrl: String, key: String, model: String): Contract {
        val base = baseUrl.trim().trimEnd('/')
        NetPolicy.requireAllowed("$base/videos")
        val learner = VideoContractLearner(model)

        fun post(body: JSONObject): Err = try {
            val c = (URL("$base/videos").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT
                readTimeout = TIMEOUT
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                if (key.isNotBlank()) setRequestProperty("Authorization", "Bearer $key")
                outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val text = (if (c.responseCode in 200..299) c.inputStream else c.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            c.disconnect()
            Err(text)
        } catch (e: Throwable) {
            Err("""{"code":"network_error","message":"${e.message ?: e::class.simpleName}"}""")
        }

        // 基线：不带 mode，size 用非法探针
        learner.baseline(post(JSONObject().apply {
            put("model", model); put("prompt", "能力探测")
            put("seconds", "4"); put("size", SIZE_PROBE)
        }))

        // 逐候选：带非法 size 的请求永不通过校验（不会真的创建任务）。
        // 端点已经直接给出合法列表时不再暴力试 —— 探测结果以端点声明为准。
        if (learner.modes.isEmpty() && (learner.modeRequired || learner.traces.any { "mode" in it.lowercase() })) {
            for (candidate in learner.candidates) {
                if (candidate in learner.tried) continue
                val e = post(JSONObject().apply {
                    put("model", model); put("prompt", "能力探测")
                    put("seconds", "4"); put("size", SIZE_PROBE); put("mode", candidate)
                })
                learner.modeCandidate(candidate, e)
                // 找到一个合法 mode 就够（模型用它生成即可）；继续试只为收集，成本可控
            }
        }

        // 参考图 wire 形态：只对「需要参考图」的 mode 探测（reference / image2video）。
        // 两种形态各发一次带**极小合法 png base64 + 非法 size** 的请求——
        // size 校验会先拒绝，所以永不真的创建任务；错误若从「缺图」变成「size」，
        // 说明该形态被端点接受。
        val imageModes = learner.modes.filter { it.contains("ref") || it.contains("image") }
        var imageWire = ""
        var imageField = ""
        if (imageModes.isNotEmpty()) {
            val probeB64 = TINY_PNG_B64
            for (field in listOf("images", "image", "image_url")) {
                val payload = JSONObject().apply {
                    put("model", model); put("prompt", "能力探测")
                    put("seconds", "4"); put("size", SIZE_PROBE)
                    put("mode", imageModes.first())
                    if (field == "image") put(field, probeB64) else
                        put(field, JSONArray().apply { put(probeB64) })
                }
                val e = post(payload)
                // 不再是「缺图 / 图片字段不认」→ 说明这个字段形态被接受
                val imageComplaint = ("requires images" in e.low || "images" == e.param ||
                    "image" == e.param || "invalid images" in e.low)
                if (!imageComplaint) {
                    imageWire = "json-base64"
                    imageField = field
                    break
                }
            }
            if (imageWire.isBlank()) {
                // 端点不认 JSON 里的图片字段 → 大概率是 OpenAI 那种 multipart 文件上传
                imageWire = "multipart"
                imageField = "input_reference"
            }
            learner.traces.add("参考图 wire：$imageWire（字段 $imageField）")
        }

        val c = learner.contract()
        return if (imageWire.isBlank()) c else c.copy(imageWire = imageWire, imageField = imageField)
    }

    /** 图像端点探测（POST {base}/images/generations）：网络/解析异常不抛出，安全降级 */
    fun probeImage(baseUrl: String, key: String, model: String): Contract {
        val base = baseUrl.trim().trimEnd('/')
        NetPolicy.requireAllowed(endpointImages(base))
        val traces = mutableListOf<String>()
        var sizes = listOf<String>()
        val body: String = try {
            val c = (URL(endpointImages(base)).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT
                readTimeout = TIMEOUT
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                if (key.isNotBlank()) setRequestProperty("Authorization", "Bearer $key")
                outputStream.use {
                    it.write(JSONObject().apply {
                        put("model", model); put("prompt", "能力探测"); put("size", SIZE_PROBE)
                    }.toString().toByteArray(Charsets.UTF_8))
                }
            }
            val text = (if (c.responseCode in 200..299) c.inputStream else c.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            c.disconnect()
            text
        } catch (e: Throwable) {
            "${e::class.simpleName}: ${e.message}"
        }
        val e = Err(body)
        traces.add(e.message.take(200))
        if (e.validSizes.isNotEmpty()) sizes = e.validSizes
        return Contract(emptyList(), false, sizes, traces)
    }

    private fun endpointImages(base: String): String {
        val u = base.trim().trimEnd('/')
        return if (u.endsWith("/images/generations") || u.endsWith("/generations")) u else "$u/images/generations"
    }
}
