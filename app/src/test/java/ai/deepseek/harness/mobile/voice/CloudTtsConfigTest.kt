package ai.deepseek.harness.mobile.voice

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 云端语音配置的纯逻辑测试：三项主配置、密钥脱敏、请求体、任意厂商模板、MIME 判定。
 *
 * 这里钉死的是「用户填了什么就发什么」——TTS 接口和语言模型不一样（还要 voice），
 * 而各家字段又不同，所以默认体 + 自定义模板两条路都必须可验证。
 */
class CloudTtsConfigTest {

    private val cfg = CloudTtsConfig(
        enabled = true,
        endpoint = "https://tts.example.com/v1/audio/speech",
        apiKey = "sk-abcdefgh-1234",
        model = "cosyvoice-v2",
        voice = "longwan",
    )

    @Test
    fun `三项主配置齐了才可用，密钥可以为空`() {
        assertTrue(cfg.usable)
        assertTrue(cfg.copy(apiKey = "").usable)          // 局域网/自建服务常不需要密钥
        assertFalse(cfg.copy(enabled = false).usable)
        assertFalse(cfg.copy(endpoint = "").usable)
        assertFalse(cfg.copy(model = "  ").usable)
    }

    @Test
    fun `回给前端的配置里没有密钥明文`() {
        val j = JSONObject(cfg.toJson())
        assertTrue(j.getBoolean("hasKey"))
        assertEquals("sk-a…1234", j.getString("keyHint"))
        assertFalse(j.has("apiKey"))
        assertFalse(cfg.toJson().contains("sk-abcdefgh-1234"))
        // 落盘那份才带明文（和语言模型配置同一份 prefs）
        assertEquals("sk-abcdefgh-1234", JSONObject(cfg.toStorage()).getString("apiKey"))
    }

    @Test
    fun `坏 JSON 回退到默认配置，不会半初始化`() {
        val d = CloudTtsConfig.parse("{not json")
        assertFalse(d.enabled)
        assertEquals("", d.endpoint)
        assertEquals(CloudTtsConfig.DEFAULT_VOICE, d.voice)
    }

    @Test
    fun `默认请求体是 OpenAI 兼容形态，含 model input voice speed`() {
        val j = JSONObject(CloudTtsRequest.defaultBody(cfg, "你好", 1.25f))
        assertEquals("cosyvoice-v2", j.getString("model"))
        assertEquals("你好", j.getString("input"))
        assertEquals("longwan", j.getString("voice"))
        assertEquals("mp3", j.getString("response_format"))
        assertEquals(1.25, j.getDouble("speed"), 0.001)
    }

    @Test
    fun `音色留空就不传 voice 字段`() {
        val j = JSONObject(CloudTtsRequest.defaultBody(cfg.copy(voice = ""), "你好", 1f))
        assertFalse(j.has("voice"))
    }

    @Test
    fun `自定义请求体模板能适配任意厂商，且文本会 JSON 转义`() {
        val tpl = """{"app":{"text":"${'$'}text","spk":"${'$'}voice"},"mid":"${'$'}model","spd":${'$'}speed}"""
        val body = CloudTtsRequest.body(
            cfg.copy(bodyTemplate = tpl),
            "他说\"你好\"\n换行",
            1.5f,
        )
        val j = JSONObject(body)
        assertEquals("他说\"你好\"\n换行", j.getJSONObject("app").getString("text"))
        assertEquals("longwan", j.getJSONObject("app").getString("spk"))
        assertEquals("cosyvoice-v2", j.getString("mid"))
        assertEquals(1.5, j.getDouble("spd"), 0.001)
    }

    @Test
    fun `额外请求头能覆盖默认值，密钥默认走 Bearer`() {
        val h = CloudTtsRequest.headers(cfg)
        assertEquals("Bearer sk-abcdefgh-1234", h["Authorization"])
        assertEquals("application/json", h["Content-Type"])
        val extra = CloudTtsRequest.headers(
            cfg.copy(extraHeaders = """{"X-App-Id":"42","Authorization":"APPCODE xyz"}"""),
        )
        assertEquals("42", extra["X-App-Id"])
        assertEquals("APPCODE xyz", extra["Authorization"])
        // 坏 JSON 不能把整份请求头弄丢
        assertEquals("Bearer sk-abcdefgh-1234", CloudTtsRequest.headers(cfg.copy(extraHeaders = "{oops"))["Authorization"])
    }

    @Test
    fun `MIME 按响应头或文件头判定，未知按 mp3`() {
        assertEquals("audio/wav", CloudTtsRequest.mimeOf("audio/wav", ByteArray(4)))
        assertEquals("audio/ogg", CloudTtsRequest.mimeOf("application/ogg", ByteArray(4)))
        assertEquals(
            "audio/wav",
            CloudTtsRequest.mimeOf(null, byteArrayOf(82, 73, 70, 70) + ByteArray(40)),
        )
        assertEquals("audio/mpeg", CloudTtsRequest.mimeOf(null, ByteArray(40)))
        assertEquals("wav", CloudTtsRequest.extOf("audio/wav"))
        assertEquals("mp3", CloudTtsRequest.extOf("audio/mpeg"))
    }
}
