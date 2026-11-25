package ai.deepseek.harness.mobile.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 韵律规划与 WAV 拼装的单元测试。
 *
 * 这块代码不依赖 Android 运行时（纯 JVM），所以能在沙箱里跑：
 * 分句对不对、问句有没有升调、拼接后的 wav 还能不能被解析 —— 都是可断言的。
 */
class VoiceProsodyTest {

    @Test
    fun `按句末标点分句并保留标点`() {
        val plan = VoiceProsody.plan("今天天气不错。要出门吗？我建议带伞！")
        assertEquals(3, plan.size)
        assertTrue(plan[0].text.contains("。"))
        assertTrue(plan[1].text.contains("？"))
        assertTrue(plan[2].text.contains("！"))
    }

    @Test
    fun `疑问句升调 感叹句更快更高`() {
        val plan = VoiceProsody.plan("你吃了吗？太好了！")
        val q = plan.first { it.text.contains("？") }
        val e = plan.first { it.text.contains("！") }
        assertTrue("疑问句音高应高于基准", q.pitch > 1.0f)
        assertTrue("感叹句音高应更高", e.pitch > 1.0f)
        assertTrue("感叹句语速应更快", e.rateScale > 1.0f)
    }

    @Test
    fun `省略号降调拖慢且停顿最长`() {
        val plan = VoiceProsody.plan("这个嘛……我再想想。")
        val dots = plan.first { it.text.contains("…") }
        assertTrue(dots.pitch < 1.0f)
        assertTrue(dots.rateScale < 1.0f)
        assertTrue(dots.pauseMs >= 300)
    }

    @Test
    fun `超长文本按上限截断`() {
        val plan = VoiceProsody.plan("啊".repeat(2000), 600)
        val total = plan.sumOf { it.text.length }
        assertTrue("总长度不应超过上限太多", total <= 601)
    }

    @Test
    fun `wav 构建与解析可往返`() {
        val pcm = ByteArray(1600) { (it % 127).toByte() }
        val wav = VoiceProsody.Wav(16000, 1, 16, pcm)
        val bytes = VoiceProsody.build(wav)
        assertEquals(44 + pcm.size, bytes.size)
        val back = VoiceProsody.parse(bytes)
        assertNotNull(back)
        assertEquals(16000, back!!.sampleRate)
        assertEquals(1, back.channels)
        assertEquals(16, back.bits)
        assertTrue(back.pcm.contentEquals(pcm))
        assertEquals(50L, back.durationMs)    // 1600 字节 / (16000Hz × 2B) = 50ms
    }

    @Test
    fun `格式不一致时拒绝拼接`() {
        val a = VoiceProsody.Wav(16000, 1, 16, ByteArray(320))
        val b = VoiceProsody.Wav(22050, 1, 16, ByteArray(320))
        assertNull(VoiceProsody.concat(listOf(a to 100, b to 100)))
    }

    @Test
    fun `拼接会插入句间静音`() {
        val a = VoiceProsody.Wav(16000, 1, 16, ByteArray(320))
        val b = VoiceProsody.Wav(16000, 1, 16, ByteArray(320))
        val merged = VoiceProsody.concat(listOf(a to 100, b to 100))
        assertNotNull(merged)
        // 两段 320 + 两段 100ms 静音（16000*0.1*2 = 3200 字节）
        assertEquals(320 * 2 + 3200 * 2, merged!!.pcm.size)
    }
}
