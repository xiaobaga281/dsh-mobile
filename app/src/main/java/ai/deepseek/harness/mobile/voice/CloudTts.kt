package ai.deepseek.harness.mobile.voice

import android.content.Context
import android.content.SharedPreferences
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 用户自己配置的云端语音模型。
 *
 * App 不再内置任何语音模型：默认只用设备自带的系统 TTS，用户在设置页填了厂商的
 * TTS API 之后才走云端；云端请求失败会自动回退系统引擎，**保证一定有声音**。
 *
 * 主配置只要三项：地址 / 密钥 / 模型名（和语言模型一样）。
 * 但 TTS 接口与 chat/completions 不同：标准 `/v1/audio/speech` 还要求 `voice`。
 * 所以 [voice] 放在「高级」里，默认给 OpenAI 兼容端点通用的 `alloy`；换厂商时
 * 用户可以改，或者在 [bodyTemplate] 里完全自定义请求体（各家字段差异太大）。
 * 返回格式不需要用户填：响应 MIME 由 [CloudTtsRequest.mimeOf] 自动识别。
 *
 * 请求体拼装与 MIME 判定是纯函数 [CloudTtsRequest]，不碰 Android API，可 JVM 单测。
 */
data class CloudTtsConfig(
    val enabled: Boolean = false,
    /** 完整的 TTS 接口地址，例如 https://api.example.com/v1/audio/speech */
    val endpoint: String = "",
    val apiKey: String = "",
    val model: String = "",
    /** 高级：音色 id。留空 = 不传 voice 字段（有些厂商把它绑在模型里） */
    val voice: String = DEFAULT_VOICE,
    /** 高级：额外请求头，JSON 对象字符串 */
    val extraHeaders: String = "",
    /** 高级：自定义请求体模板；留空 = 标准 OpenAI 兼容 JSON */
    val bodyTemplate: String = "",
) {
    /** 三项主配置齐了才算可用；密钥允许为空（局域网/自建服务常不需要） */
    val usable: Boolean get() = enabled && endpoint.isNotBlank() && model.isNotBlank()

    /** 回给前端的配置：密钥绝不回传明文，只给「有没有」和掩码 */
    fun toJson(): String = JSONObject()
        .put("enabled", enabled)
        .put("endpoint", endpoint)
        .put("model", model)
        .put("voice", voice)
        .put("extraHeaders", extraHeaders)
        .put("bodyTemplate", bodyTemplate)
        .put("hasKey", apiKey.isNotBlank())
        .put("keyHint", maskKey(apiKey))
        .toString()

    /** 落盘用（含密钥明文，与模型配置同一份 SharedPreferences） */
    fun toStorage(): String = JSONObject()
        .put("enabled", enabled)
        .put("endpoint", endpoint)
        .put("apiKey", apiKey)
        .put("model", model)
        .put("voice", voice)
        .put("extraHeaders", extraHeaders)
        .put("bodyTemplate", bodyTemplate)
        .toString()

    companion object {
        const val PREF_KEY = "cloudTts"
        const val DEFAULT_VOICE = "alloy"

        private fun maskKey(k: String): String =
            if (k.length <= 8) "" else k.take(4) + "…" + k.takeLast(4)

        fun parse(raw: String?): CloudTtsConfig {
            if (raw.isNullOrBlank()) return CloudTtsConfig()
            return runCatching {
                val o = JSONObject(raw)
                CloudTtsConfig(
                    enabled = o.optBoolean("enabled", false),
                    endpoint = o.optString("endpoint", "").trim(),
                    apiKey = o.optString("apiKey", ""),
                    model = o.optString("model", "").trim(),
                    // optString 的 fallback 只在字段缺失时生效；显式空串是「不传 voice」的合法值
                    voice = if (o.has("voice")) o.optString("voice", "") else DEFAULT_VOICE,
                    extraHeaders = o.optString("extraHeaders", ""),
                    bodyTemplate = o.optString("bodyTemplate", ""),
                )
            }.getOrDefault(CloudTtsConfig())
        }
    }
}

/** 纯函数：请求体、请求头、MIME 判定。不引用 Android API，方便 JVM 单测钉死行为。 */
object CloudTtsRequest {

    /** 一次最多送多少字（云端接口普遍有长度上限，超长交系统 TTS 分段念） */
    const val MAX_CHARS = 2000

    /**
     * 默认请求体：OpenAI 兼容的 `/v1/audio/speech` 形态。
     * `voice` 为空时不传该字段（部分厂商把音色绑在 model 里）。
     */
    fun defaultBody(cfg: CloudTtsConfig, text: String, speed: Float): String {
        val o = JSONObject()
            .put("model", cfg.model)
            .put("input", text.take(MAX_CHARS))
            .put("response_format", "mp3")
            .put("speed", "%.2f".format(Locale.US, speed.coerceIn(0.25f, 4f)).toDouble())
        if (cfg.voice.isNotBlank()) o.put("voice", cfg.voice)
        return o.toString()
    }

    /**
     * 自定义模板：占位符 `$text $model $voice $speed $format`，
     * 字符串类替换成**已 JSON 转义、不带引号**的值（模板里自己写引号），
     * 避免文本里的换行/引号把请求体拼坏。
     */
    fun renderTemplate(cfg: CloudTtsConfig, text: String, speed: Float): String {
        fun esc(v: String): String {
            val q = JSONObject.quote(v.take(MAX_CHARS))
            return q.substring(1, q.length - 1)
        }
        return cfg.bodyTemplate
            .replace("\$text", esc(text))
            .replace("\$model", esc(cfg.model))
            .replace("\$voice", esc(cfg.voice))
            .replace("\$format", "mp3")
            .replace("\$speed", "%.2f".format(Locale.US, speed.coerceIn(0.25f, 4f)))
    }

    fun body(cfg: CloudTtsConfig, text: String, speed: Float): String =
        if (cfg.bodyTemplate.isBlank()) defaultBody(cfg, text, speed)
        else renderTemplate(cfg, text, speed)

    fun headers(cfg: CloudTtsConfig): Map<String, String> {
        val h = LinkedHashMap<String, String>()
        h["Content-Type"] = "application/json"
        h["Accept"] = "*/*"
        if (cfg.apiKey.isNotBlank()) h["Authorization"] = "Bearer ${cfg.apiKey}"
        if (cfg.extraHeaders.isNotBlank()) {
            runCatching {
                val o = JSONObject(cfg.extraHeaders)
                o.keys().forEach { k -> h[k] = o.optString(k, "") }
            }
        }
        return h
    }

    /** 响应音频的 MIME：先看 Content-Type，再看文件头，最后按 mp3 兜底 */
    fun mimeOf(contentType: String?, bytes: ByteArray): String {
        val ct = contentType?.lowercase(Locale.US).orEmpty()
        return when {
            "wav" in ct || "wave" in ct -> "audio/wav"
            "ogg" in ct || "opus" in ct -> "audio/ogg"
            "flac" in ct -> "audio/flac"
            "aac" in ct -> "audio/aac"
            "mpeg" in ct || "mp3" in ct -> "audio/mpeg"
            "mp4" in ct || "m4a" in ct -> "audio/mp4"
            bytes.size >= 4 && bytes[0] == 'R'.code.toByte() && bytes[1] == 'I'.code.toByte() &&
                bytes[2] == 'F'.code.toByte() && bytes[3] == 'F'.code.toByte() -> "audio/wav"
            bytes.size >= 4 && bytes[0] == 'O'.code.toByte() && bytes[1] == 'g'.code.toByte() &&
                bytes[2] == 'g'.code.toByte() && bytes[3] == 'S'.code.toByte() -> "audio/ogg"
            bytes.size >= 3 && bytes[0] == 'f'.code.toByte() && bytes[1] == 'L'.code.toByte() &&
                bytes[2] == 'a'.code.toByte() -> "audio/flac"
            else -> "audio/mpeg"
        }
    }

    fun extOf(mime: String): String = when {
        "wav" in mime -> "wav"
        "ogg" in mime -> "ogg"
        "flac" in mime -> "flac"
        "aac" in mime -> "aac"
        "mp4" in mime -> "m4a"
        else -> "mp3"
    }
}

/** 云端 TTS 客户端：合成 + 播放。播放走主线程，网络与合成在朗读队列线程。 */
class CloudTts(
    private val context: Context,
    private val prefs: SharedPreferences,
) {
    @Volatile
    var config: CloudTtsConfig = CloudTtsConfig.parse(prefs.getString(CloudTtsConfig.PREF_KEY, null))
        private set

    /** 最近一次失败原因（面板如实显示；成功即清空） */
    @Volatile
    var lastError: String = ""
        private set

    private val main = Handler(Looper.getMainLooper())
    private val playLock = Any()
    private var player: MediaPlayer? = null
    private var playFile: File? = null

    /**
     * 保存配置。前端把密钥脱敏显示（输入框是空的），所以**空密钥 = 沿用旧值**，
     * 不是「清空密钥」；要清空得显式传 `clearKey:true`。
     */
    fun setConfig(raw: String?): CloudTtsConfig {
        val next = CloudTtsConfig.parse(raw)
        val clearKey = runCatching { JSONObject(raw.orEmpty()).optBoolean("clearKey", false) }.getOrDefault(false)
        val key = if (clearKey) "" else next.apiKey.ifBlank { config.apiKey }
        val merged = next.copy(apiKey = key)
        config = merged
        prefs.edit().putString(CloudTtsConfig.PREF_KEY, merged.toStorage()).apply()
        lastError = ""
        stop()
        return merged
    }

    fun json(): String = runCatching {
        JSONObject(config.toJson())
            .put("usable", config.usable)
            .put("error", lastError)
            .toString()
    }.getOrDefault("{}")

    /** 合成一段音频。任何失败都返回 null，由 VoiceCenter 回退系统 TTS。 */
    fun synth(text: String, speed: Float): ByteArray? {
        val cfg = config
        if (!cfg.usable) return null
        val url = runCatching { URL(cfg.endpoint) }.getOrNull()
        if (url == null || url.protocol !in setOf("http", "https")) {
            lastError = "API 地址不是合法的 http(s) URL"
            return null
        }
        val conn = runCatching { url.openConnection() as HttpURLConnection }.getOrElse {
            lastError = "连不上：${it.message ?: "未知错误"}"
            return null
        }
        return try {
            conn.apply {
                connectTimeout = 12_000
                readTimeout = 45_000
                requestMethod = "POST"
                doOutput = true
                instanceFollowRedirects = true
                CloudTtsRequest.headers(cfg).forEach { (k, v) -> setRequestProperty(k, v) }
            }
            conn.outputStream.use { it.write(CloudTtsRequest.body(cfg, text, speed).toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val detail = runCatching { conn.errorStream?.readBytes()?.toString(Charsets.UTF_8) }
                    .getOrNull()?.take(180).orEmpty()
                lastError = "HTTP $code $detail".trim()
                return null
            }
            val bytes = conn.inputStream.use { it.readBytes() }
            if (bytes.size < 128) {
                lastError = "返回的不是音频（${bytes.size} 字节）"
                return null
            }
            lastError = ""
            bytes
        } catch (t: Throwable) {
            lastError = t.message?.take(180) ?: "请求异常"
            null
        } finally {
            runCatching { conn.disconnect() }
        }
    }

    /**
     * 播放云端返回的音频字节。
     *
     * 写临时文件再给 [MediaPlayer]：WebView 之外的原生朗读没有流式 data source，
     * 云端返回的 mp3/wav 用文件最稳。只等「启动完成」就返回（不等播完），
     * 否则朗读队列会被一句音频占死，新一句进不来。
     */
    fun play(bytes: ByteArray, mime: String): Boolean {
        val file = File(context.cacheDir, "cloud-tts-${System.nanoTime()}.${CloudTtsRequest.extOf(mime)}")
        if (runCatching { file.writeBytes(bytes) }.isFailure) {
            lastError = "写临时音频失败"
            return false
        }
        val started = CountDownLatch(1)
        var ok = false
        main.post {
            synchronized(playLock) {
                stopLocked()
                val mp = MediaPlayer()
                try {
                    mp.setDataSource(file.absolutePath)
                    mp.setOnCompletionListener { synchronized(playLock) { releaseLocked() } }
                    mp.setOnErrorListener { _, what, _ ->
                        lastError = "播放失败（$what）"
                        synchronized(playLock) { releaseLocked() }
                        true
                    }
                    mp.prepare()
                    mp.start()
                    player = mp
                    playFile = file
                    ok = true
                } catch (t: Throwable) {
                    lastError = t.message?.take(160) ?: "播放器启动失败"
                    runCatching { mp.release() }
                    runCatching { file.delete() }
                }
            }
            started.countDown()
        }
        started.await(3, TimeUnit.SECONDS)
        return ok
    }

    /** 掐掉当前云端朗读（hardStop 用）；不碰系统 TTS 的 stop */
    fun stop() {
        main.post { synchronized(playLock) { stopLocked() } }
    }

    /** 必须在 [playLock] 内、且在主线程调用 */
    private fun stopLocked() {
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
        runCatching { playFile?.delete() }
        playFile = null
    }

    private fun releaseLocked() {
        runCatching { player?.release() }
        player = null
        runCatching { playFile?.delete() }
        playFile = null
    }
}
