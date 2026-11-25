package ai.deepseek.harness.mobile.voice

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * 语音消息的「韵律」处理。
 *
 * 系统 TTS 的默认朗读是**平**的：整段一个音高、一个语速，问句不上扬、感叹不加重，
 * 句号之间也不留气口 —— 听起来就是机器念稿。这里做两件不改引擎的事：
 *
 *  1. **按句切分**：每个句子单独合成，句子之间插入真实静音（气口）；
 *  2. **按句式给参数**：疑问句升调、感叹句加快并升调、省略号降调拖慢、
 *     长句略放慢、短促语气词略提亮。
 *
 * 之所以不是 SSML：Android 的 TextToSpeech 只把文本丢给引擎，
 * 系统引擎（Google TTS / eSpeak / 各家 ROM）对 `<prosody>` 的支持全凭运气，
 * 不认的时候会把尖括号原样念出来。分句 + setPitch/setSpeechRate 是**所有引擎都吃**的做法。
 *
 * 拼接在 PCM 层完成：同一引擎同一音色的各段格式一致，拼出来仍是合法 WAV。
 */
object VoiceProsody {

    /** 一阶低通系数（音量/明亮度塑形用）：越小越"闷"。[shape] 与 [StreamShaper] 共用一套 */
    private const val LP_A = 0.32f

    /** 一段待合成的文本及其韵律参数 */
    data class Segment(
        val text: String,
        /** 相对用户设定语速的倍率 */
        val rateScale: Float,
        /** 音高（1.0 = 引擎默认） */
        val pitch: Float,
        /** 这句读完之后的静音时长 */
        val pauseMs: Int,
    )

    /** 裸 WAV（只保留 PCM，重打包时统一写标准头） */
    data class Wav(val sampleRate: Int, val channels: Int, val bits: Int, val pcm: ByteArray) {
        val bytesPerFrame: Int get() = channels * (bits / 8).coerceAtLeast(1)
        val durationMs: Long
            get() = if (bytesPerFrame <= 0) 0L
            else pcm.size.toLong() * 1000L / (sampleRate.toLong() * bytesPerFrame)
    }

    /**
     * 把整段回复切成若干句，并给每句算出韵律。
     *
     * 只按**句末**标点切（。！？…；!?），不按逗号：逗号切太碎，
     * 每段都要一次 synthesizeToFile，延迟会翻几倍，收益却不大。
     */
    fun plan(text: String, maxChars: Int = 600): List<Segment> {
        val body = text.trim().take(maxChars)
        if (body.isEmpty()) return emptyList()

        // 先按句末标点切，保留标点本身（引擎会据此处理停顿）
        val raw = ArrayList<String>()
        val buf = StringBuilder()
        var i = 0
        while (i < body.length) {
            val c = body[i]
            buf.append(c)
            val isEnd = c in "。！？!?；;"
            val isEllipsis = c == '…' || (c == '.' && i + 1 < body.length && body[i + 1] == '.')
            if (isEnd || isEllipsis) {
                // 连续标点（「？！」「……」）一起吃进同一句
                while (i + 1 < body.length && body[i + 1] in "。！？!?…；;～~") {
                    i++
                    buf.append(body[i])
                }
                val s = buf.toString().trim()
                if (s.isNotEmpty()) raw.add(s)
                buf.setLength(0)
            }
            i++
        }
        val tail = buf.toString().trim()
        if (tail.isNotEmpty()) raw.add(tail)

        // 太短的相邻句（「嗯。」「好。」）合并，减少合成次数
        val merged = ArrayList<String>()
        for (s in raw) {
            val last = merged.lastOrNull()
            if (last != null && (last.length + s.length) <= 8) {
                merged[merged.size - 1] = last + s
            } else {
                merged.add(s)
            }
        }

        return merged.map { sentence ->
            val core = sentence.trimEnd { it in "。！？!?…；;～~ \n" }
            val enders = sentence.substring(core.length)
            val question = enders.any { it == '？' || it == '?' }
            val exclaim = enders.any { it == '！' || it == '!' }
            val ellipsis = enders.contains('…') || enders.contains("..")
            val pause = when {
                ellipsis -> 380
                question -> 260
                exclaim -> 200
                enders.contains('；') || enders.contains(';') -> 200
                else -> 170
            }
            // 语速与音高：只做小幅偏移，夸张了会像变声器
            var pitch = 1.0f
            var rate = 1.0f
            if (question) pitch += 0.07f
            if (exclaim) { pitch += 0.09f; rate += 0.05f }
            if (ellipsis) { pitch -= 0.05f; rate -= 0.08f }
            if (core.length in 1..4) { pitch += 0.03f; rate += 0.04f }     // 「嗯」「好呀」
            if (core.length > 45) rate -= 0.05f                              // 长句留呼吸
            Segment(sentence, rate.coerceIn(0.75f, 1.35f), pitch.coerceIn(0.8f, 1.25f), pause)
        }
    }

    /** 解析 WAV：只取 fmt 与 data，别的块丢掉 */
    fun parse(bytes: ByteArray): Wav? {
        if (bytes.size < 44) return null
        var pos = 12
        var sampleRate = 0
        var channels = 0
        var bits = 0
        var pcm: ByteArray? = null
        while (pos + 8 <= bytes.size) {
            val id = String(bytes, pos, 4, Charsets.US_ASCII)
            val size = ByteBuffer.wrap(bytes, pos + 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
            val body = pos + 8
            if (size < 0 || body + size > bytes.size) break
            when (id) {
                "fmt " -> {
                    // 注意：ByteBuffer 的绝对读下标是**数组下标**，不是相对偏移。
                    // 之前写成 wrap(bytes, body, 16).getShort(2)，读到的其实是文件头第 2 字节，
                    // 采样率/声道全是垃圾 → parse 永远返回 null（自己 build 出来的包也解析不了）。
                    val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                    channels = bb.getShort(body + 2).toInt()
                    sampleRate = bb.getInt(body + 4)
                    bits = bb.getShort(body + 14).toInt()
                }
                "data" -> pcm = bytes.copyOfRange(body, body + size)
            }
            pos = body + size + (size and 1)   // 块按偶数字节对齐
        }
        val data = pcm ?: return null
        if (sampleRate !in 8000..48000 || channels !in 1..2 || bits !in 8..32) return null
        return Wav(sampleRate, channels, bits, data)
    }

    fun silence(sampleRate: Int, channels: Int, bits: Int, ms: Int): ByteArray {
        val frame = channels * (bits / 8).coerceAtLeast(1)
        val count = sampleRate * ms / 1000 * frame
        return ByteArray(count)            // 16bit PCM 的静音就是全 0
    }

    /** 按顺序拼接（段间插入 lead 静音），格式不一致就返回 null 交给调用方退回单段合成 */
    fun concat(parts: List<Pair<Wav, Int>>): Wav? {
        if (parts.isEmpty()) return null
        val first = parts.first().first
        if (parts.any { it.first.sampleRate != first.sampleRate || it.first.channels != first.channels || it.first.bits != first.bits }) {
            return null
        }
        val out = ByteArrayOutputStream()
        for ((wav, pauseMs) in parts) {
            out.write(wav.pcm)
            if (pauseMs > 0) out.write(silence(first.sampleRate, first.channels, first.bits, pauseMs))
        }
        return Wav(first.sampleRate, first.channels, first.bits, out.toByteArray())
    }

    /**
     * 音色塑形：音量 + 明亮度。
     *
     * 引擎只给「音高/语速」两个旋钮，剩下的听感差异得自己做：
     * 用一个一阶低通把信号拆成「体」和「气」两部分，再按明亮度重新配比 ——
     * 往下更闷更柔（适合低音男声），往上更亮更清（适合元气女声）。
     * 只处理 16bit PCM（系统引擎实际给的都是这种），其它位深原样返回。
     */
    fun shape(w: Wav, volume: Float, brightness: Float): Wav {
        if (w.bits != 16 || volume == 1f && brightness == 0f) return w
        val pcm = w.pcm.copyOf()
        val buf = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN)
        val gain = volume.coerceIn(0.2f, 1.5f)
        val k = brightness.coerceIn(-1f, 1f) * 1.6f
        val a = LP_A                        // 低通系数：越小越"闷"
        var lp = 0f
        while (buf.remaining() >= 2) {
            val at = buf.position()
            val sample = buf.getShort(at).toFloat()
            lp += a * (sample - lp)
            val air = sample - lp
            val mixed = (lp + air * (1f + k)) * gain
            buf.putShort(at, mixed.coerceIn(-32768f, 32767f).toInt().toShort())
        }
        return w.copy(pcm = pcm)
    }

    /**
     * 流式塑形器：[shape] 的"边来边处理"版本。
     *
     * 边合成边播时音频是一块一块到的，没有"整段"可处理；低通状态必须跨块保留，
     * 否则每个块边界都会出现一次台阶（听感像轻微的爆音）。
     * 系数与 [shape] 完全一致，两条路径听感才对得上。
     */
    class StreamShaper(volume: Float, brightness: Float) {
        private val gain = volume.coerceIn(0.2f, 1.5f)
        private val k = brightness.coerceIn(-1f, 1f) * 1.6f
        private var lp = 0f

        /** 浮点样本（-1..1）→ 16bit PCM，顺手做音量与明亮度 */
        fun process(samples: FloatArray): ShortArray {
            val out = ShortArray(samples.size)
            for (i in samples.indices) {
                val s = samples[i].coerceIn(-1f, 1f) * 32767f
                lp += LP_A * (s - lp)
                val air = s - lp
                val mixed = (lp + air * (1f + k)) * gain
                out[i] = mixed.coerceIn(-32768f, 32767f).toInt().toShort()
            }
            return out
        }
    }

    /**
     * 线性重采样（单声道优先，多声道按帧处理）。
     *
     * 语音条要经 base64 过 JS 桥，22.05kHz 降到 16kHz 能省近三成字节，
     * 而 16k 对语音的听感损失几乎听不出来（系统 TTS 本身也常见 16k）。
     */
    fun resample(w: Wav, targetRate: Int): Wav {
        if (targetRate <= 0 || targetRate == w.sampleRate) return w
        if (w.bits != 16 || w.channels < 1) return w
        val frameBytes = w.bytesPerFrame
        val frames = w.pcm.size / frameBytes
        if (frames < 2) return w
        val ratio = w.sampleRate.toDouble() / targetRate
        val outFrames = (frames / ratio).toInt().coerceAtLeast(1)
        val out = ByteArray(outFrames * frameBytes)
        val src = java.nio.ByteBuffer.wrap(w.pcm).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val dst = java.nio.ByteBuffer.wrap(out).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until outFrames) {
            val pos = i * ratio
            val i0 = pos.toInt().coerceIn(0, frames - 1)
            val i1 = (i0 + 1).coerceAtMost(frames - 1)
            val frac = (pos - i0).toFloat()
            for (c in 0 until w.channels) {
                val s0 = src.getShort(i0 * frameBytes + c * 2).toInt()
                val s1 = src.getShort(i1 * frameBytes + c * 2).toInt()
                val v = (s0 + (s1 - s0) * frac).toInt()
                dst.putShort(i * frameBytes + c * 2, v.coerceIn(-32768, 32767).toShort())
            }
        }
        return Wav(targetRate, w.channels, w.bits, out)
    }

    /**
     * 清晰化（口齿）：旧包 8kHz、带宽 4kHz 封顶，听感发闷、字头发糊。
     * 现在的 16kHz 包不走这条链（见 NeuralTts.toWav 的采样率判断），保留给低采样率模型。
     * 这里做三件**不改字**的事：
     *
     *  1. 80Hz 高通 —— 去掉低频轰鸣，字与字之间更干净；
     *  2. 1.5kHz 以上补 +55% —— 中文声母（j/q/x/z/c/s/zh/ch/sh）能量集中在这一段，
     *     字头咬得住，听感就从"含着一口气"变成"说清楚了"；
     *  3. 轻压缩 + 峰值归一 —— 句子内忽大忽小会让人觉得含糊，压平一点更清楚。
     *
     * 只做线性的高通/增益与一阶包络压缩，不引入非线性，避免金属味；
     * 只处理 16bit 单声道（模型输出就是这种），其它格式原样返回。
     */
    fun clarity(w: Wav): Wav {
        if (w.bits != 16 || w.channels != 1) return w
        val n = w.pcm.size / 2
        if (n < 64) return w
        val src = java.nio.ByteBuffer.wrap(w.pcm).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val x = FloatArray(n) { src.getShort(it * 2) / 32768f }

        val hp = highpass(x, w.sampleRate, 80f)          // 去轰鸣
        val air = highpass(hp, w.sampleRate, 1500f)      // 临场段
        for (i in 0 until n) hp[i] += 0.55f * air[i]

        // 轻压缩：小声抬起来、大声压一点（一阶包络，够用且没有延迟）
        val thr = 0.30f
        val ratio = 2.5f
        var env = 0f
        var peak = 0f
        for (i in 0 until n) {
            val v = hp[i]
            val a = kotlin.math.abs(v)
            env = if (a > env) a else env * 0.995f + a * 0.005f
            val g = if (env <= thr) 1f else (thr + (env - thr) / ratio) / env
            val y = v * g
            hp[i] = y
            val ay = kotlin.math.abs(y)
            if (ay > peak) peak = ay
        }
        val gain = if (peak > 1e-6f) 0.95f / peak else 1f
        val out = ByteArray(n * 2)
        val dst = java.nio.ByteBuffer.wrap(out).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until n) {
            val v = (hp[i] * gain).coerceIn(-1f, 1f)
            dst.putShort(i * 2, (v * 32767f).toInt().toShort())
        }
        return w.copy(pcm = out)
    }

    /** 一阶高通（RC），返回新数组 */
    private fun highpass(x: FloatArray, sampleRate: Int, fc: Float): FloatArray {
        val a = 1.0 / (1.0 + 2.0 * Math.PI * fc / sampleRate)
        val y = FloatArray(x.size)
        var prevX = 0f
        var prevY = 0f
        for (i in x.indices) {
            val v = (a * (prevY + x[i] - prevX)).toFloat()
            prevX = x[i]
            prevY = v
            y[i] = v
        }
        return y
    }

    fun build(w: Wav): ByteArray {
        val byteRate = w.sampleRate * w.bytesPerFrame
        val out = ByteArray(44 + w.pcm.size)
        val b = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray(Charsets.US_ASCII))
        b.putInt(36 + w.pcm.size)
        b.put("WAVE".toByteArray(Charsets.US_ASCII))
        b.put("fmt ".toByteArray(Charsets.US_ASCII))
        b.putInt(16)
        b.putShort(1)                                  // PCM
        b.putShort(w.channels.toShort())
        b.putInt(w.sampleRate)
        b.putInt(byteRate)
        b.putShort(w.bytesPerFrame.toShort())
        b.putShort(w.bits.toShort())
        b.put("data".toByteArray(Charsets.US_ASCII))
        b.putInt(w.pcm.size)
        b.put(w.pcm)
        return out
    }
}
