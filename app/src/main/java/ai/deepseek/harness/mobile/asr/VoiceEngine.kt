package ai.deepseek.harness.mobile.asr

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineZipformer2CtcModelConfig
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

/**
 * 端侧语音识别，两档模型：
 *
 * - **标准（内置）**：Zipformer2-CTC 中文 int8，26MB，随 APK 分发。
 *   流式解码，边说边出字；中文够用，英文术语会丢。
 * - **增强（可选）**：SenseVoiceSmall int8，239MB，用户在插件面板按需下载。
 *   中英日韩粤五语混说都能认，非流式——录完一次性解码，所以没有中间结果。
 *
 * 为什么不用系统 SpeechRecognizer：国内多数 ROM 的语音服务会把请求发到厂商云端，
 * 无 GMS / 无网络时直接报「连不上网」；用户也无法指定输入法的语音键。
 *
 * 两档共用一套录音链路，只是「怎么解码」不同；选哪档由磁盘上有没有增强模型决定
 * （下了就用好的，删了就回内置，不需要额外的偏好开关）。
 */
class VoiceEngine(private val context: Context) {

    /**
     * 上一次录音保存的 wav 路径与时长（毫秒）。
     *
     * 为什么要留音频：输入框的「按住说话」现在直接生成一条**用户语音条**，
     * 界面上要有东西可回放；识别出的文字只作为消息内容发给 agent。
     * 空字符串 = 这次没录到东西（或写盘失败），前端就不画语音条。
     */
    @Volatile
    var lastClipPath: String = ""
        private set
    @Volatile
    var lastClipMs: Int = 0
        private set

    interface Listener {
        /** 实时中间结果，用于边说边显示（仅内置流式模型会回调） */
        fun onPartial(text: String)
        /** 音量包络 0..1，驱动波形 */
        fun onLevel(level: Float)
        /** 非流式模型：录音结束、开始整段解码。前端此时应显示「正在识别」 */
        fun onDecoding() {}
        /** 结束后的最终结果 */
        fun onFinal(text: String)
        fun onError(message: String)
    }

    companion object {
        private const val TAG = "DSHVoice"
        private const val SAMPLE_RATE = 16000

        /** 内置模型（assets，随包分发） */
        private const val ASSET_DIR = "asr-small"

        /** 流式路径每次喂 100ms：太小会频繁 decode，太大则中间结果发涩 */
        private const val CHUNK_SAMPLES = SAMPLE_RATE / 10

        /** 离线路径最长录音 120 秒，超出部分丢弃，避免长按把内存撑爆 */
        private const val MAX_OFFLINE_SAMPLES = SAMPLE_RATE * 120

        /** 没人说话就自动收工：防止「松手事件丢了」导致麦克风一直开着 */
        private const val IDLE_STOP_MS = 15_000L
        /** 单次会话硬上限：再久也不听 */
        private const val MAX_SESSION_MS = 120_000L

        const val KIND_BUILTIN = "builtin"
        const val KIND_PRO = "pro"
    }

    /** 当前生效的模型：builtin=内置中文小模型，pro=SenseVoice 多语增强模型 */
    @Volatile var modelKind: String = KIND_BUILTIN
        private set

    @Volatile private var online: OnlineRecognizer? = null
    @Volatile private var offline: OfflineRecognizer? = null
    @Volatile private var loadError: String? = null
    private var loading = false

    private val loadExecutor = Executors.newSingleThreadExecutor()
    private val audioExecutor = Executors.newSingleThreadExecutor()

    private val running = AtomicBoolean(false)
    @Volatile private var recording = false

    /** 本次会话被取消：收尾时不再回吐文本，避免「取消后又插进来」 */
    @Volatile private var cancelled = false

    /* ---------------- 模型 ---------------- */

    val isReady: Boolean get() = online != null || offline != null

    /** 是否有一段录音正在进行（前端据此判断「松手」是不是有效指令） */
    val isRunning: Boolean get() = running.get()

    /** 后台加载模型，可重复调用；已就绪直接回调。两个回调都在后台线程。 */
    fun prepare(onReady: (Long) -> Unit, onError: (String) -> Unit) {
        if (isReady) {
            onReady(0)
            return
        }
        loadError?.let {
            onError(it)
            return
        }
        if (loading) return
        loading = true

        loadExecutor.execute {
            val started = System.currentTimeMillis()
            try {
                // 增强模型在盘上就用它；没有就用包里的内置模型。
                // 增强模型的目录只在用户下载后存在，所谓「加载失败」不该出现，
                // 真失败就明确报错，不静默换模型——否则用户会以为下的是坏的。
                if (ModelDownloader.installed(context)) {
                    val proDir = ModelDownloader.dir(context)
                    val config = OfflineRecognizerConfig(
                        featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
                        modelConfig = OfflineModelConfig(
                            senseVoice = OfflineSenseVoiceModelConfig(
                                model = proDir.resolve("model.int8.onnx").absolutePath,
                                // auto：按音频自己判断中/英/日/韩/粤，混说时不会整段跑偏
                                language = "auto",
                                useInverseTextNormalization = true,
                            ),
                            tokens = proDir.resolve("tokens.txt").absolutePath,
                            numThreads = 2,
                            debug = false,
                            provider = "cpu",
                            modelType = "sense_voice",
                        ),
                        decodingMethod = "greedy_search",
                    )
                    offline = OfflineRecognizer(assetManager = null, config = config)
                    online = null
                    modelKind = KIND_PRO
                } else {
                    val config = OnlineRecognizerConfig(
                        featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
                        modelConfig = OnlineModelConfig(
                            zipformer2Ctc = OnlineZipformer2CtcModelConfig(
                                model = "$ASSET_DIR/model.int8.onnx",
                            ),
                            tokens = "$ASSET_DIR/tokens.txt",
                            numThreads = 2,
                            debug = false,
                            provider = "cpu",
                            modelType = "zipformer2",
                        ),
                        // 不自动断句：一次会话说多长由用户点停止决定
                        enableEndpoint = false,
                        decodingMethod = "greedy_search",
                    )
                    online = OnlineRecognizer(assetManager = context.assets, config = config)
                    offline = null
                    modelKind = KIND_BUILTIN
                }
                loadError = null
                loading = false
                val ms = System.currentTimeMillis() - started
                Log.i(TAG, "model ready in ${ms}ms ($modelKind)")
                onReady(ms)
            } catch (t: Throwable) {
                loading = false
                loadError = "离线语音模型加载失败：${t.message ?: t.javaClass.simpleName}"
                Log.e(TAG, "load failed", t)
                onError(loadError!!)
            }
        }
    }

    /* ---------------- 识别 ---------------- */

    private var record: AudioRecord? = null

    fun start(listener: Listener) {
        if (!isReady) {
            loadError?.let { listener.onError(it); return }
            listener.onError("离线语音还在准备中")
            return
        }
        // 一次只能有一条录音线程：CAS 抢 running，抢不到说明已经有会话在跑，
        // 直接忽略。绝不能用「先看再置」的写法——两次并发 start 会各起一条
        // AudioRecord，松手只停掉一条，另一条就在后台一直收音（一说话就弹面板）。
        if (!running.compareAndSet(false, true)) return
        cancelled = false

        if (offline != null) startOffline(listener) else startStreaming(listener)
    }

    /** 内置模型：流式，边说边出字 */
    private fun startStreaming(listener: Listener) {
        audioExecutor.execute {
            val rec = try {
                createRecord()
            } catch (t: Throwable) {
                running.set(false)
                listener.onError("麦克风打不开：${t.message ?: "未知错误"}")
                return@execute
            }
            record = rec
            val engine = online ?: run {
                running.set(false)
                runCatching { rec.release() }
                record = null
                listener.onError("离线语音模型已释放")
                return@execute
            }

            val stream = engine.createStream()
            val buf = ByteArray(CHUNK_SAMPLES * 2)
            // 流式也要留一份完整波形：用户语音条要能回放（16k 单声道 60s ≈ 1.9MB，可接受）
            var pcm = FloatArray(SAMPLE_RATE * 8)
            var filled = 0
            var lastPartialAt = 0L
            var lastLevelAt = 0L
            var finalText = ""
            recording = true

            try {
                rec.startRecording()
                val startedAt = System.currentTimeMillis()
                var lastVoiceAt = startedAt
                while (running.get()) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n <= 0) continue
                    val samples = pcm16ToFloat(buf, n)
                    stream.acceptWaveform(samples, SAMPLE_RATE)
                    while (engine.isReady(stream)) engine.decode(stream)
                    if (filled + samples.size <= MAX_OFFLINE_SAMPLES) {
                        if (filled + samples.size > pcm.size) {
                            var cap = pcm.size
                            while (cap < filled + samples.size) cap *= 2
                            pcm = pcm.copyOf(minOf(cap, MAX_OFFLINE_SAMPLES))
                        }
                        System.arraycopy(samples, 0, pcm, filled, samples.size)
                        filled += samples.size
                    }

                    val now = System.currentTimeMillis()
                    val currentLevel = level(samples)
                    // 有声帧才算「还在说话」：静音 15 秒就收工，避免麦克风常开
                    if (currentLevel > 0.08f) lastVoiceAt = now
                    if (now - lastVoiceAt > IDLE_STOP_MS || now - startedAt > MAX_SESSION_MS) {
                        Log.i(TAG, "auto stop: idle=${now - lastVoiceAt}ms total=${now - startedAt}ms")
                        running.set(false)
                        break
                    }
                    if (now - lastLevelAt > 60) {
                        lastLevelAt = now
                        listener.onLevel(currentLevel)
                    }
                    if (now - lastPartialAt > 120) {
                        lastPartialAt = now
                        val t = engine.getResult(stream).text.trim()
                        if (t.isNotEmpty() && t != finalText) {
                            finalText = t
                            listener.onPartial(t)
                        }
                    }
                }
            } catch (t: Throwable) {
                Log.e(TAG, "record loop failed", t)
            } finally {
                recording = false
                running.set(false)
                runCatching { rec.stop() }
                runCatching { rec.release() }
                record = null

                // 收尾：先补 300ms 静音再结束输入。
                // 流式编码器按 chunk 出帧，最后一个音节如果卡在 chunk 中间，
                // 直接 inputFinished 会把尾音吞掉（"星期三" → "星"）。
                runCatching {
                    stream.acceptWaveform(FloatArray(SAMPLE_RATE * 3 / 10), SAMPLE_RATE)
                    while (engine.isReady(stream)) engine.decode(stream)
                    stream.inputFinished()
                    while (engine.isReady(stream)) engine.decode(stream)
                    val text = engine.getResult(stream).text.trim()
                    if (text.isNotEmpty()) finalText = text
                }
                runCatching { stream.release() }
                listener.onLevel(0f)
                if (cancelled) {
                    // 取消：收音停了就结束，不回吐文本
                } else {
                    saveClip(pcm, filled)
                    val out = clean(finalText)
                    if (out.isBlank()) listener.onError("没有听清，再说一句")
                    else listener.onFinal(out)
                }
            }
        }
    }

    /** 增强模型：SenseVoice 是非流式，先整段录音，停止后一次性解码 */
    private fun startOffline(listener: Listener) {
        audioExecutor.execute {
            val rec = try {
                createRecord()
            } catch (t: Throwable) {
                running.set(false)
                listener.onError("麦克风打不开：${t.message ?: "未知错误"}")
                return@execute
            }
            record = rec
            val engine = offline ?: run {
                running.set(false)
                runCatching { rec.release() }
                record = null
                listener.onError("离线语音模型已释放")
                return@execute
            }

            val buf = ByteArray(CHUNK_SAMPLES * 2)
            var pcm = FloatArray(SAMPLE_RATE * 8)
            var filled = 0
            var lastLevelAt = 0L
            recording = true

            try {
                rec.startRecording()
                val startedAt = System.currentTimeMillis()
                var lastVoiceAt = startedAt
                while (running.get()) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n <= 0) continue
                    val samples = pcm16ToFloat(buf, n)
                    if (filled + samples.size > MAX_OFFLINE_SAMPLES) {
                        Log.w(TAG, "offline buffer full, stop at ${MAX_OFFLINE_SAMPLES / SAMPLE_RATE}s")
                        break
                    }
                    if (filled + samples.size > pcm.size) {
                        var cap = pcm.size
                        while (cap < filled + samples.size) cap *= 2
                        pcm = pcm.copyOf(minOf(cap, MAX_OFFLINE_SAMPLES))
                    }
                    System.arraycopy(samples, 0, pcm, filled, samples.size)
                    filled += samples.size

                    val now = System.currentTimeMillis()
                    val currentLevel = level(samples)
                    if (currentLevel > 0.08f) lastVoiceAt = now
                    if (now - lastVoiceAt > IDLE_STOP_MS || now - startedAt > MAX_SESSION_MS) {
                        Log.i(TAG, "auto stop(offline): idle=${now - lastVoiceAt}ms total=${now - startedAt}ms")
                        running.set(false)
                        break
                    }
                    if (now - lastLevelAt > 60) {
                        lastLevelAt = now
                        listener.onLevel(currentLevel)
                    }
                }
            } catch (t: Throwable) {
                Log.e(TAG, "record loop failed", t)
            } finally {
                recording = false
                running.set(false)
                runCatching { rec.stop() }
                runCatching { rec.release() }
                record = null
                listener.onLevel(0f)
                if (cancelled) {
                    // 取消：不再走解码，也不回吐文本
                } else {
                    // 解码要几百毫秒，前端得先切到「正在识别」，否则像卡住了
                    listener.onDecoding()
                    saveClip(pcm, filled)
                    val text = runCatching { decodeOffline(engine, pcm, filled) }
                        .getOrElse { Log.e(TAG, "offline decode failed", it); "" }
                    val out = clean(text)
                    if (out.isBlank()) listener.onError("没有听清，再说一句")
                    else listener.onFinal(out)
                }
            }
        }
    }

    /** 松手：停止收音，等收尾解码 */
    fun stop() {
        if (!running.get()) return
        running.set(false)
    }

    /**
     * 把这次录音写成 16bit 单声道 wav（存 cacheDir/voice-in/），供用户语音条回放。
     *
     * 为什么存盘而不是留内存：气泡在会话列表里要能反复点播，跨渲染帧、跨页面切换都得在；
     * 而且 base64 塞进消息体太胖（10 秒 ≈ 320KB），存文件只在播放时读一次。
     */
    private fun saveClip(pcm: FloatArray, filled: Int) {
        lastClipPath = ""
        lastClipMs = 0
        if (filled <= 0) return
        val dir = File(context.cacheDir, "voice-in").apply { mkdirs() }
        // 只留最近 20 条，避免缓存目录越积越多
        runCatching {
            dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(20)?.forEach { it.delete() }
        }
        val f = File(dir, "clip-${System.currentTimeMillis()}.wav")
        val ok = runCatching {
            val pcm16 = ByteArray(filled * 2)
            for (i in 0 until filled) {
                val v = (pcm[i].coerceIn(-1f, 1f) * 32767f).toInt()
                pcm16[i * 2] = (v and 0xFF).toByte()
                pcm16[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
            }
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            val dataLen = pcm16.size
            header.put("RIFF".toByteArray(Charsets.US_ASCII))
            header.putInt(36 + dataLen)
            header.put("WAVE".toByteArray(Charsets.US_ASCII))
            header.put("fmt ".toByteArray(Charsets.US_ASCII))
            header.putInt(16)
            header.putShort(1)                                   // PCM
            header.putShort(1)                                   // 单声道
            header.putInt(SAMPLE_RATE)
            header.putInt(SAMPLE_RATE * 2)                        // byteRate
            header.putShort(2)                                    // blockAlign
            header.putShort(16)                                   // bits
            header.put("data".toByteArray(Charsets.US_ASCII))
            header.putInt(dataLen)
            FileOutputStream(f).use { out ->
                out.write(header.array())
                out.write(pcm16)
            }
            true
        }.getOrElse { Log.e(TAG, "保存录音失败", it); false }
        if (ok && f.isFile && f.length() > 44) {
            lastClipPath = f.absolutePath
            lastClipMs = filled * 1000 / SAMPLE_RATE
            Log.i(TAG, "录音已保存 ${lastClipMs}ms → ${f.name}")
        }
    }

    private fun decodeOffline(engine: OfflineRecognizer, pcm: FloatArray, filled: Int): String {
        if (filled <= 0) return ""
        val stream = engine.createStream()
        return try {
            stream.acceptWaveform(pcm.copyOfRange(0, filled), SAMPLE_RATE)
            engine.decode(stream)
            engine.getResult(stream).text
        } finally {
            runCatching { stream.release() }
        }
    }

    /** 取消：丢弃本次结果，并把麦克风真正关掉（不能留给后台继续收音） */
    fun cancel() {
        cancelled = true
        running.set(false)
        recording = false
        runCatching { record?.stop() }
        runCatching { record?.release() }
        record = null
    }

    fun release() {
        running.set(false)
        runCatching { record?.release() }
        record = null
        runCatching { online?.release() }
        runCatching { offline?.release() }
        online = null
        offline = null
    }

    /** 换模型（下载完 / 删除后）调用：释放旧实例，下次 prepare 重新读盘 */
    fun reload() {
        running.set(false)
        runCatching { online?.release() }
        runCatching { offline?.release() }
        online = null
        offline = null
        loadError = null
        loading = false
    }

    private fun createRecord(): AudioRecord {
        val min = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val size = maxOf(min, CHUNK_SAMPLES * 2 * 4)
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            size,
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            throw IllegalStateException("设备不支持 16kHz 录音")
        }
        return rec
    }

    private fun pcm16ToFloat(buf: ByteArray, n: Int): FloatArray {
        val samples = FloatArray(n / 2)
        var i = 0
        while (i < samples.size) {
            val lo = buf[i * 2].toInt() and 0xFF
            val hi = buf[i * 2 + 1].toInt()
            samples[i] = ((hi shl 8) or lo).toShort() / 32768.0f
            i++
        }
        return samples
    }

    /** RMS → 0..1，平方根压一下低音量段，让波形对小声音也有反应 */
    private fun level(samples: FloatArray): Float {
        if (samples.isEmpty()) return 0f
        var sum = 0.0
        for (s in samples) sum += (s * s).toDouble()
        val rms = sqrt(sum / samples.size).toFloat()
        return (rms * 6f).coerceIn(0f, 1f)
    }

    /**
     * 模型词表外的音素会被解码成 <unk>、<blk> 这类标记，直接回填输入框就是乱码。
     * SenseVoice 还会吐 <|zh|><|NEUTRAL|> 这类标签，一并清掉；
     * 同时把英文子词之间的多余空格压成一个。
     */
    private fun clean(raw: String): String {
        if (raw.isEmpty()) return ""
        return raw
            .replace(Regex("<\\|[^|]*\\|>"), "")
            .replace("<unk>", "")
            .replace("<blk>", "")
            .replace("<sos/eos>", "")
            .replace("<sil>", "")
            .replace(Regex("[ \\t]{2,}"), " ")
            .trim()
    }
}
