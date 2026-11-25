package ai.deepseek.harness.mobile.voice

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 「这句话该由谁念」的规则表测试。
 *
 * 内置神经模型移除后只剩两条路：配好云端模型走云端，否则一律系统 TTS。
 * 云端请求失败**不在这里**判定（VoiceCenter 当场回退），所以没有第三种状态。
 */
class TtsRouterTest {

    @Test
    fun `没配云端模型时一律走系统 TTS`() {
        assertEquals(TtsRouter.Engine.SYSTEM, TtsRouter.decide("今天天气不错", false).engine)
        assertEquals(TtsRouter.Engine.SYSTEM, TtsRouter.decide("   ", true).engine)
    }

    @Test
    fun `配好云端模型就走云端`() {
        assertEquals(TtsRouter.Engine.CLOUD, TtsRouter.decide("今天天气不错", true).engine)
    }

    @Test
    fun `超长文本交系统 TTS 分段念`() {
        val long = "中".repeat(CloudTtsRequest.MAX_CHARS + 1)
        assertEquals(TtsRouter.Engine.SYSTEM, TtsRouter.decide(long, true).engine)
        assertEquals(
            TtsRouter.Engine.CLOUD,
            TtsRouter.decide("中".repeat(CloudTtsRequest.MAX_CHARS), true).engine,
        )
    }
}
