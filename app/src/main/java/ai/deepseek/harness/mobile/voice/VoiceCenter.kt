package ai.deepseek.harness.mobile.voice

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * 语音输出的**唯一门面**：选引擎、挑音色、朗读、合成语音条、微调、状态上报都在这里。
 *
 * 引擎只有两条，由 [TtsRouter] 一句话定：
 *  · [cloud]  用户在设置页配好的云端 TTS（任意厂商，地址/密钥/模型名）
 *  · 系统 TTS 设备自带引擎，**默认且兜底**：没配云端、文本过长、云端请求失败都走它
 *
 * App 不再内置任何语音模型（原 32.6MB 神经包与「经典男」整条删除）。
 *
 * 朗读串行队列 [speakQueue] + [speakSeq] + [hardStop] 这三件不能省：
 * 连点试听时旧句子必须被掐掉，否则多个 AudioTrack/MediaPlayer 同时出声。
 * 系统 TTS 的创建与 speak 必须在主线程（TextToSpeech 的硬要求）。
 */
class VoiceCenter(
    private val context: Context,
    private val prefs: SharedPreferences,
) {
    companion object {
        private const val TAG = "DSHTts"
    }

    private val main = Handler(Looper.getMainLooper())
    private fun post(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }

    /* ---------------- 引擎 ---------------- */

    /** 用户配置的云端语音模型；没配时 usable=false，全部朗读走系统引擎 */
    private val cloud = CloudTts(context.applicationContext, prefs)

    /**
     * 朗读串行队列。为什么需要：`speak` 原来每次都 `Thread { ... }.start()`，
     * 连点几次试听就有几条线程同时合成、同时 new AudioTrack —— 声音叠在一起。
     * 改成单线程队列后，同一时刻只有一条朗读在跑；新请求靠 [speakSeq] 把旧的挤掉。
     */
    private val speakQueue = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "dsh-tts-speak").apply { isDaemon = true }
    }

    /** 朗读请求序号：单调自增，旧任务发现序号变了就立刻收手 */
    @Volatile
    private var speakSeq = 0

    private var tts: android.speech.tts.TextToSpeech? = null

    @Volatile
    private var ttsReady = false

    /** 系统引擎初始化完成前进来的第一句，初始化后补发 */
    private var pendingSpeech: Pair<String, Float>? = null

    /* ---------------- 状态（持久化在 prefs） ---------------- */

    /** 上一次出声的渠道：system / cloud，前端据此显示"谁在说话" */
    @Volatile
    var lastEngine: String = "system"
        private set

    /** 最近一次系统引擎选中的音色名 */
    @Volatile
    var lastVoiceName: String = ""
        private set

    /** 用户选的性别：auto / female / male（只在系统兜底音色时用得上） */
    @Volatile
    var voiceGender: String = "auto"
        private set

    /** 最近一次真正生效的音色性别（"" = 认不出） */
    @Volatile
    var activeVoiceGender: String = ""
        private set

    /** 指定了性别但系统引擎里没有对应音色，退回中性音色 */
    @Volatile
    var voiceFallback: Boolean = false
        private set

    /** 系统引擎里可用的中文音色数（0 = 没装中文语音包） */
    @Volatile
    var zhVoiceCount: Int = 0
        private set

    /* 五项微调：rate 语速 / pitch 音高 / volume 音量 / brightness 明亮度 / pause 句间停顿 */
    @Volatile var voiceRate: Float = 1f; private set
    @Volatile var voicePitch: Float = 1f; private set
    @Volatile var voiceVolume: Float = 1f; private set
    @Volatile var voiceBrightness: Float = 0f; private set
    @Volatile var voicePause: Float = 1f; private set

    init {
        // 偏好必须在引擎初始化之前就位，否则第一句会用默认音色念出来
        // 系统 TTS 默认挑女声（多数中文引擎只有一条女声可用）
        voiceGender = prefs.getString("voiceGender", "female") ?: "female"
        voiceRate = prefs.getFloat("voiceRate", 1f).coerceIn(0.4f, 2.2f)
        voicePitch = prefs.getFloat("voicePitch", 1f).coerceIn(0.3f, 2f)
        voiceVolume = prefs.getFloat("voiceVolume", 1f).coerceIn(0.2f, 1f)
        voiceBrightness = prefs.getFloat("voiceBrightness", 0f).coerceIn(-1f, 1f)
        voicePause = prefs.getFloat("voicePause", 1f).coerceIn(0.5f, 2f)
    }

    /* ---------------- 对外：朗读 ---------------- */

    /**
     * 朗读一段文本：配了云端模型走云端，没配 / 超长 / 请求失败都落回系统 TTS。
     * 两条路都保证出声 —— 云端没响应时宁可用系统腔，也不能静默。
     */
    fun speak(text: String, rate: Float = 1f) {
        val body = text.trim()
        if (body.isEmpty()) return
        val d = TtsRouter.decide(body, cloud.config.usable)
        val mySeq = ++speakSeq
        // 同步掐掉上一句：连点试听时不能有两条音频叠着放
        hardStop()
        if (d.engine == TtsRouter.Engine.CLOUD) {
            speakQueue.execute {
                if (mySeq != speakSeq) return@execute
                if (!speakCloud(body, rate)) speakSystem(body, rate)
            }
            return
        }
        speakQueue.execute {
            if (mySeq != speakSeq) return@execute
            speakSystem(body, rate)
        }
    }

    /**
     * 立刻静音：系统引擎与云端播放器各停一遍。
     * 不碰 [speakSeq]（那是给排队任务看的），只负责让声音停下来。
     */
    private fun hardStop() {
        runCatching { tts?.stop() }
        runCatching { cloud.stop() }
    }

    /** 停止当前朗读（两条路径都要停：系统 stop 管不到云端自己的 MediaPlayer） */
    fun stopSpeaking() {
        speakSeq++
        hardStop()
    }

    /** 云端朗读：失败一律返回 false，让调用方当场回退系统引擎 */
    private fun speakCloud(text: String, rate: Float): Boolean {
        val started = System.currentTimeMillis()
        val cfg = cloud.config
        val bytes = cloud.synth(text, rate * voiceRate) ?: return false
        val ok = cloud.play(bytes, CloudTtsRequest.mimeOf(null, bytes))
        if (ok) {
            lastEngine = "cloud"
            lastVoiceName = cfg.model + if (cfg.voice.isBlank()) "" else " / ${cfg.voice}"
            activeVoiceGender = ""
            voiceFallback = false
            Log.i(TAG, "云端朗读 ${bytes.size}B / ${System.currentTimeMillis() - started}ms / ${cfg.model}")
        }
        return ok
    }

    private fun speakSystem(text: String, rate: Float = 1f) {
        val body = text.trim()
        if (body.isEmpty()) return
        post {
            ensureTts(rate)
            if (!ttsReady) {
                pendingSpeech = body.take(2000) to rate
                return@post
            }
            tts?.setSpeechRate((rate * voiceRate).coerceIn(0.4f, 2.2f))
            tts?.setPitch(voicePitch.coerceIn(0.3f, 2f))
            val params = android.os.Bundle().apply {
                putFloat(
                    android.speech.tts.TextToSpeech.Engine.KEY_PARAM_VOLUME,
                    voiceVolume.coerceIn(0.2f, 1f),
                )
            }
            tts?.speak(
                body.take(2000),
                android.speech.tts.TextToSpeech.QUEUE_FLUSH,
                params,
                "dsh-${System.currentTimeMillis()}",
            )
        }
    }

    /** 预热系统引擎（幂等）：进聊天页/开启语音输出时调一次 */
    fun warmUpTts() = post { ensureTts() }

    /**
     * 起一次系统 TTS 引擎（幂等）。TextToSpeech 构造是异步的，ttsReady 要等回调；
     * 初始化完成前进来的第一句由 [pendingSpeech] 补发。
     */
    private fun ensureTts(rate: Float = 1f) {
        if (tts != null) return
        tts = android.speech.tts.TextToSpeech(context.applicationContext) { status ->
            ttsReady = status == android.speech.tts.TextToSpeech.SUCCESS
            if (ttsReady) {
                val e = tts ?: return@TextToSpeech
                val zh = java.util.Locale.SIMPLIFIED_CHINESE
                val ok = e.isLanguageAvailable(zh) >= android.speech.tts.TextToSpeech.LANG_AVAILABLE
                if (ok) {
                    e.language = zh
                }
                e.setSpeechRate(rate.coerceIn(0.5f, 2f))
                // 设置 language 会把 voice 重置回默认，音色必须在语言确定之后再挑
                lastVoiceName = ""
                applyVoice(e)
                pendingSpeech?.let { (q, r) -> pendingSpeech = null; speak(q, r) }
            }
        }
    }

    /* ---------------- 对外：语音条合成 ---------------- */

    /**
     * 合成一条「语音消息」：返回 {ok, dataUrl, durMs, bytes} 或 {ok:false, error}。
     * 与 [speak] 的区别是「产出可点播的气泡」，不是立刻念出来。
     */
    fun synthVoice(text: String, rate: Float = 1f): String {
        val body = text.trim()
        if (body.isEmpty()) return """{"ok":false,"error":"没有可合成的文本"}"""
        if (TtsRouter.decide(body, cloud.config.usable).engine == TtsRouter.Engine.CLOUD) {
            val json = synthVoiceCloud(body, rate)
            if (json != null) return json
            Log.w(TAG, "云端语音条失败（${cloud.lastError}），改走系统引擎")
        }
        return synthVoiceSystem(body, rate)
    }

    /** 云端语音条：返回的音频字节直接做 data URL（mp3/wav/ogg 都能被 <audio> 播） */
    private fun synthVoiceCloud(body: String, rate: Float): String? {
        val cfg = cloud.config
        val speed = rate * voiceRate
        val cacheKey = VoiceCache.key(
            engine = "cloud",
            voiceKey = "${cfg.endpoint}|${cfg.model}|${cfg.voice}",
            rate = speed,
            text = body.take(600),
        )
        val bytes = VoiceCache.get(context, cacheKey) ?: run {
            val fresh = cloud.synth(body, speed) ?: return null
            VoiceCache.put(context, cacheKey, fresh)
            fresh
        }
        val mime = CloudTtsRequest.mimeOf(null, bytes)
        lastEngine = "cloud"
        lastVoiceName = cfg.model + if (cfg.voice.isBlank()) "" else " / ${cfg.voice}"
        return JSONObject()
            .put("ok", true)
            .put("engine", "cloud")
            .put("voice", lastVoiceName)
            .put("dataUrl", "data:$mime;base64," +
                android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
            .put("durMs", 0)
            .put("bytes", bytes.size)
            .toString()
    }

    /** 系统引擎合成（云端没配 / 请求失败时的兜底） */
    /** 系统引擎合成（英文句子、或内置音色不可用时的兜底） */
    private fun synthVoiceSystem(body0: String, rate: Float = 1f): String {
        val body = body0.trim()
        if (!ttsReady) {
            // 引擎还没起：真的创建它（空串 speak 什么也不做，以前就是这里卡住）
            post { ensureTts(rate) }
            return """{"ok":false,"error":"synth-preparing"}"""
        }
        val engine = tts ?: return """{"ok":false,"error":"语音引擎不可用"}"""
        return try {
            pickBestVoice(engine)
            val dir = java.io.File(context.filesDir, "voice").apply { mkdirs() }
            val finalWav = renderPlan(body, voicePause) { seg ->
                synthSegment(engine, dir, seg.text, rate * seg.rateScale, seg.pitch)
            }?.first ?: return """{"ok":false,"error":"合成失败（系统语音引擎没有返回音频）"}"""

            val shaped = VoiceProsody.shape(finalWav, voiceVolume, voiceBrightness)
            val bytes = VoiceProsody.build(shaped)
            JSONObject()
                .put("ok", true)
                .put("dataUrl", "data:audio/wav;base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                .put("durMs", shaped.durationMs.coerceAtLeast(300L))
                .put("bytes", bytes.size)
                .put("voice", lastVoiceName)
                .put("voiceGender", activeVoiceGender)
                .put("voiceFallback", voiceFallback)
                .toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "合成异常").toString()
        }
    }

    /**
     * 两条路径共用的「分句 → 逐句合成 → 句间气口 → 拼接」管线。
     * 段数上限、超 8 段退回整段、某段失败整体重来 —— 这些规则以前抄了两份。
     */
    private fun renderPlan(
        body: String,
        pauseScale: Float,
        synth: (VoiceProsody.Segment) -> VoiceProsody.Wav?,
    ): Pair<VoiceProsody.Wav, Int>? {
        val vp = VoiceProsody
        val plan = vp.plan(body, 600)
        val pause = pauseScale.coerceIn(0.5f, 2f)
        if (plan.size in 1..8) {
            val pieces = ArrayList<Pair<VoiceProsody.Wav, Int>>(plan.size)
            var okAll = true
            for (seg in plan) {
                val wav = synth(seg)
                if (wav == null) { okAll = false; break }
                pieces.add(wav to (seg.pauseMs * pause).toInt())
            }
            if (okAll) vp.concat(pieces)?.let { return it to plan.size }
        }
        val whole = synth(VoiceProsody.Segment(body.take(600), 1f, 1f, 0)) ?: return null
        return whole to 1
    }

    /** 合成一段到 wav 并解析成裸 PCM；失败返回 null（调用方决定整段退回） */
    private fun synthSegment(
        engine: android.speech.tts.TextToSpeech,
        dir: java.io.File,
        text: String,
        rate: Float,
        pitch: Float,
    ): VoiceProsody.Wav? {
        val chunk = text.trim()
        if (chunk.isEmpty()) return null
        val file = java.io.File(dir, "seg-${System.nanoTime()}.wav")
        val latch = java.util.concurrent.CountDownLatch(1)
        var ok = false
        engine.setSpeechRate(rate.coerceIn(0.5f, 2f))
        engine.setPitch(pitch.coerceIn(0.5f, 2f))
        engine.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { ok = true; latch.countDown() }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { latch.countDown() }
            override fun onError(utteranceId: String?, errorCode: Int) { latch.countDown() }
        })
        val params = android.os.Bundle()
        val code = engine.synthesizeToFile(chunk, params, file, "dsh-${System.nanoTime()}")
        if (code != android.speech.tts.TextToSpeech.SUCCESS) {
            runCatching { file.delete() }
            return null
        }
        // 10 秒足够离线引擎出活；网络音色没网时会等满 —— 段数一多就是分钟级假死，
        // 这里封顶单段等待（整条语音最坏 8 段 × 10s + 整段兜底，不再是无界的）
        latch.await(10, java.util.concurrent.TimeUnit.SECONDS)
        if (!ok || !file.exists() || file.length() < 44) {
            runCatching { file.delete() }
            return null
        }
        val bytes = runCatching { file.readBytes() }.getOrNull()
        runCatching { file.delete() }
        if (bytes == null) return null
        return VoiceProsody.parse(bytes)
    }

    /* ---------------- 对外：音色选择与状态 ---------------- */

    fun setGender(gender: String) {
        voiceGender = if (gender == "male" || gender == "female") gender else "auto"
        prefs.edit().putString("voiceGender", voiceGender).apply()
        // 系统引擎的 voice 只在创建回调里挑过一次（见 [ensureTts]）：
        // 性别偏好变了必须立刻重挑，否则「切女声」后还在用上一个性别挑的音色念
        post {
            val e = tts ?: return@post
            if (!ttsReady) return@post
            lastVoiceName = ""
            applyVoice(e)
        }
    }

    fun gender(): String = voiceGender

    fun setTuning(
        rate: Float,
        pitch: Float,
        volume: Float = 1f,
        brightness: Float = 0f,
        pause: Float = 1f,
    ): String {
        voiceRate = rate.coerceIn(0.4f, 2.2f)
        voicePitch = pitch.coerceIn(0.3f, 2f)
        voiceVolume = volume.coerceIn(0.2f, 1f)
        voiceBrightness = brightness.coerceIn(-1f, 1f)
        voicePause = pause.coerceIn(0.5f, 2f)
        prefs.edit()
            .putFloat("voiceRate", voiceRate)
            .putFloat("voicePitch", voicePitch)
            .putFloat("voiceVolume", voiceVolume)
            .putFloat("voiceBrightness", voiceBrightness)
            .putFloat("voicePause", voicePause)
            .apply()
        return infoJson()
    }

    /** 云端语音模型配置（不含密钥明文） */
    fun cloudConfigJson(): String = cloud.json()

    /** 保存云端语音模型配置，返回保存后的状态（前端唯一写入口） */
    fun setCloudConfig(raw: String?): String {
        cloud.setConfig(raw)
        return cloud.json()
    }

    /** 音色实况：前端据此如实回显「到底是谁在说话」 */
    fun infoJson(): String = JSONObject()
        .put("want", voiceGender)
        .put("actual", activeVoiceGender)
        .put("name", lastVoiceName)
        .put("systemName", lastVoiceName)
        .put("engine", lastEngine)
        .put("fallback", voiceFallback)
        .put("zhCount", zhVoiceCount)
        .put("rate", voiceRate)
        .put("pitch", voicePitch)
        .put("volume", voiceVolume)
        .put("brightness", voiceBrightness)
        .put("pause", voicePause)
        .put("cacheBytes", VoiceCache.bytes(context))
        .put("cloud", JSONObject(cloud.json()))
        .toString()

    fun cacheClear(): Long = VoiceCache.clear(context)

    /* ---------------- 系统音色挑选 ---------------- */

    /** 猜音色性别：命名完全不统一，按「显式标注 → 厂商代号 → 常见命名」三级退让 */
    private fun genderOf(v: android.speech.tts.Voice): String {
        val name = v.name.lowercase()
        val feats = runCatching { v.features }.getOrNull()?.joinToString(" ")?.lowercase() ?: ""
        val hay = "$name $feats"
        // 顺序要紧："female" 里含 "male"，先判女
        if (hay.contains("female") || hay.contains("woman") || hay.contains("女")) return "female"
        if (hay.contains("male") || hay.contains("man") || hay.contains("男")) return "male"
        // Google 中文音色代号：ccc 是女、ccd 是男（旧正则 x-cc[ae] 漏掉了 ccc）
        if (Regex("x-ccc|x-cce").containsMatchIn(name)) return "female"
        if (name.contains("x-ccd")) return "male"
        if (Regex("xiaoxiao|xiaoyi|xiaomo|xiaoxuan|xiaohan|xiaoshuang|xiaorui|xiaoyan|nuannuan|wanqing|huihui|tingting|meijia|vixy").containsMatchIn(name)) return "female"
        if (Regex("yunxi|yunjian|yunyang|yunfeng|yunhao|kangkang|aisjiuxu|aismale|vixm|yixian").containsMatchIn(name)) return "male"
        return ""
    }

    /** 按当前性别偏好挑音色并应用（强制重挑，不看 lastVoiceName） */
    private fun applyVoice(engine: android.speech.tts.TextToSpeech) {
        val voices = runCatching { engine.voices }.getOrNull() ?: return
        val zh = voices.filter { it.locale.language == "zh" }
        zhVoiceCount = zh.size
        if (zh.isEmpty()) return
        val want = voiceGender
        val matched = if (want == "auto") zh else zh.filter { genderOf(it) == want }
        voiceFallback = want != "auto" && matched.isEmpty()
        // 想要的性别没有标注音色时，回落池要排除「明确是对立性别」的音色：
        // 宁可用未标注的，也不能让"选女声"挑出 x-ccd 这类男声
        var pool = if (matched.isNotEmpty()) matched
        else zh.filter { want == "auto" || genderOf(it) != (if (want == "male") "female" else "male") }
        if (want == "male") {
            val noOld = pool.filterNot { Regex("old|aged|elder|senior|child|kid|boy").containsMatchIn(it.name.lowercase()) }
            if (noOld.isNotEmpty()) pool = noOld
        }
        val youth = Regex("yunxi|yunjian|x-ccd|qingnian|youth|young")
        // 离线音色优先：network 音色音质高，但没网时 synthesizeToFile 直接无声
        val best = pool.sortedWith(
            compareByDescending<android.speech.tts.Voice> { if (it.isNetworkConnectionRequired) 0 else 1 }
                .thenByDescending { if (want == "male" && youth.containsMatchIn(it.name.lowercase())) 1 else 0 }
                .thenByDescending { it.quality }
                .thenByDescending { if (it.latency == android.speech.tts.Voice.LATENCY_LOW) 1 else 0 },
        ).firstOrNull() ?: return
        runCatching {
            engine.voice = best
            lastVoiceName = best.name
            activeVoiceGender = genderOf(best)
        }
    }

    private fun pickBestVoice(engine: android.speech.tts.TextToSpeech) {
        if (lastVoiceName.isNotEmpty()) return
        applyVoice(engine)
    }

    /* ---------------- 生命周期 ---------------- */

    /** 没有内置模型要释放，留空实现给 Activity 的 onTrimMemory 调用 */
    fun onTrimMemory() = Unit

    fun release() {
        speakSeq++
        runCatching { cloud.stop() }
        runCatching { tts?.stop() }
        runCatching { tts?.shutdown() }
        tts = null
        ttsReady = false
    }
}
