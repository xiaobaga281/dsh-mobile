package ai.deepseek.harness.mobile.voice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sin

/**
 * 语音条新增的两块处理：线性重采样与流式塑形。
 *
 * 两者都只碰 ByteArray / FloatArray（不依赖 Android 运行时），
 * 所以把「采样率、帧数、声道、值域、跨块状态」这些容易写错的算术逐条钉死。
 */
class VoiceProsodyExtraTest {

    /** 按帧生成 16bit PCM：sample(frame, channel) 返回 -32768..32767 */
    private fun wav(
        rate: Int,
        channels: Int,
        frames: Int,
        sample: (frame: Int, ch: Int) -> Int,
    ): VoiceProsody.Wav {
        val bb = ByteBuffer.allocate(frames * channels * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (f in 0 until frames) {
            for (c in 0 until channels) bb.putShort(sample(f, c).toShort())
        }
        return VoiceProsody.Wav(rate, channels, 16, bb.array())
    }

    private fun framesIn(w: VoiceProsody.Wav): Int = w.pcm.size / w.bytesPerFrame

    private fun sampleAt(w: VoiceProsody.Wav, frame: Int, ch: Int): Int =
        ByteBuffer.wrap(w.pcm).order(ByteOrder.LITTLE_ENDIAN)
            .getShort(frame * w.bytesPerFrame + ch * 2).toInt()

    @Test
    fun `22050 降到 16000 后采样率与帧数都对`() {
        val src = wav(22050, 1, 22050) { f, _ -> (f * 7) % 2000 - 1000 }   // 1 秒单声道
        val out = VoiceProsody.resample(src, 16000)

        assertEquals(16000, out.sampleRate)
        assertEquals(1, out.channels)
        assertEquals(16, out.bits)

        val frames = framesIn(out)
        assertEquals("22050→16000 的 1 秒应约 16000 帧，实际 $frames", 16000.0, frames.toDouble(), 2.0)
        // 16bit 单声道：一帧两字节
        assertEquals(frames * 2, out.pcm.size)
        assertEquals("时长不该被重采样改变", src.durationMs.toDouble(), out.durationMs.toDouble(), 2.0)
    }

    @Test
    fun `同采样率或非法目标时原样返回同一对象`() {
        val w = wav(16000, 1, 100) { _, _ -> 0 }
        assertSame("采样率相同应直接返回入参", w, VoiceProsody.resample(w, 16000))
        assertSame("非法采样率 0 应直接返回入参", w, VoiceProsody.resample(w, 0))
        assertSame("负采样率应直接返回入参", w, VoiceProsody.resample(w, -8000))
        // 只有一帧时没有可插值的邻居，也只能原样返回
        val tiny = wav(22050, 1, 1) { _, _ -> 123 }
        assertSame(tiny, VoiceProsody.resample(tiny, 16000))
        // 只处理 16bit PCM，其它位深原样返回
        val eight = VoiceProsody.Wav(22050, 1, 8, ByteArray(100))
        assertSame(eight, VoiceProsody.resample(eight, 16000))
    }

    @Test
    fun `重采样不改变恒定电平`() {
        val src = wav(22050, 1, 2205) { _, _ -> 12345 }
        val out = VoiceProsody.resample(src, 16000)
        val frames = framesIn(out)
        assertTrue("应该产出帧", frames > 0)
        for (i in 0 until frames) {
            assertEquals("第 $i 帧电平被改动了", 12345, sampleAt(out, i, 0))
        }
    }

    @Test
    fun `立体声按帧重采样不串声道`() {
        val src = wav(22050, 2, 2205) { _, ch -> if (ch == 0) 1000 else -2000 }
        val out = VoiceProsody.resample(src, 16000)

        assertEquals(2, out.channels)
        assertEquals("16bit 立体声一帧 4 字节", 4, out.bytesPerFrame)
        val frames = framesIn(out)
        assertEquals("2205 帧（0.1 秒）应变成约 1600 帧，实际 $frames", 1600.0, frames.toDouble(), 2.0)
        for (i in 0 until frames) {
            assertEquals("左声道第 $i 帧", 1000, sampleAt(out, i, 0))
            assertEquals("右声道第 $i 帧", -2000, sampleAt(out, i, 1))
        }
    }

    @Test
    fun `流式塑形器长度一致且静音输出全零`() {
        val out = VoiceProsody.StreamShaper(1f, 0f).process(FloatArray(256))
        assertEquals(256, out.size)
        assertTrue("静音输入必须输出全 0（不能引入直流偏置）", out.all { it.toInt() == 0 })
        assertEquals("空输入应得到空输出", 0, VoiceProsody.StreamShaper(1f, 0f).process(FloatArray(0)).size)
    }

    @Test
    fun `流式塑形器输出落在 16bit 值域内`() {
        val noisy = FloatArray(1000) { i -> ((i * 2654435761L % 2000L) - 1000L) / 500f }   // ±2 之间
        val out = VoiceProsody.StreamShaper(1f, 0f).process(noisy)
        assertEquals("长度应与输入一致", noisy.size, out.size)
        assertTrue("输出必须落在 16bit 值域内", out.all { it >= Short.MIN_VALUE && it <= Short.MAX_VALUE })

        // 超范围输入被 coerce 到 ±1，削顶而不是回绕
        assertEquals("+1 满幅应到 32767", 32767, VoiceProsody.StreamShaper(1f, 0f).process(floatArrayOf(1f))[0].toInt())
        assertEquals("-1 满幅应到 -32767", -32767, VoiceProsody.StreamShaper(1f, 0f).process(floatArrayOf(-1f))[0].toInt())
        assertEquals("输入 5f 不该溢出成负数", 32767, VoiceProsody.StreamShaper(1f, 0f).process(floatArrayOf(5f))[0].toInt())

        // 音量上限 1.5 倍：满幅信号整段削到 32767，不能回绕
        val hot = VoiceProsody.StreamShaper(10f, 0f).process(FloatArray(50) { 1f })
        assertTrue("音量被放大到削顶后应恒为 32767", hot.all { it.toInt() == 32767 })
    }

    @Test
    fun `流式塑形器分块处理与整块结果完全一致`() {
        // 这个类的存在理由：低通状态必须跨块保留，否则块边界会出现台阶（听感像爆音）。
        // 分块喂与整块喂必须得到逐样本相同的结果。
        val signal = FloatArray(300) { i -> (sin(i / 7.0) * 0.8).toFloat() }
        val whole = VoiceProsody.StreamShaper(1f, 0.6f).process(signal)

        val chunked = VoiceProsody.StreamShaper(1f, 0.6f)
        val a = chunked.process(signal.copyOfRange(0, 64))
        val b = chunked.process(signal.copyOfRange(64, 128))
        val c = chunked.process(signal.copyOfRange(128, signal.size))
        assertArrayEquals(whole, a + b + c)
    }

    @Test
    fun `明亮度确实改变高频比例`() {
        // 阶跃信号的第一个样本几乎全是「气」（高频）：提亮应放大它、压暗应把它按下去
        val bright = VoiceProsody.StreamShaper(1f, 1f).process(floatArrayOf(1f))[0].toInt()
        val dark = VoiceProsody.StreamShaper(1f, -1f).process(floatArrayOf(1f))[0].toInt()
        assertTrue("提亮应放大高频：bright=$bright 应大于 dark=$dark", bright > dark)
        assertTrue("压暗应削掉高频：dark=$dark 应为负", dark < 0)
        assertEquals("提亮后满幅信号被削到 32767", 32767, bright)
    }
}
