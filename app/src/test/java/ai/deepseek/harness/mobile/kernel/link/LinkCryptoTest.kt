package ai.deepseek.harness.mobile.kernel.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject
import java.util.Base64

/**
 * 与电脑端 `dsh-mobile-link/e2e.mjs` 的跨语言钉桩测试。
 *
 * 这些向量不是随手写的期望值：HKDF 摘要、固定 iv 的密文与标签都由 Node 实跑生成，
 * `.test/cross.mjs` 里断言的是同一份。两端任何一处改动（盐、info、标签拼法、base64 变体）
 * 都会让其中一边红 —— 而真机上的表现本来是「连不上，但说不清为什么」。
 */
class LinkCryptoTest {

    private val roomKey = "test-room-key-0123456789"

    @Test
    fun `HKDF 派生与 Node 逐字节一致`() {
        assertEquals(
            "fc51d6f157b737e157160344a01d98aa353fe4461b3422f934b931688d91eba0",
            LinkCrypto.hkdf(roomKey).joinToString("") { "%02x".format(it) },
        )
    }

    @Test
    fun `解得开 Node 加密的固定信封`() {
        val envelope = JSONObject()
            .put("v", 1)
            .put("iv", "BwcHBwcHBwcHBwcH")
            .put("ct", "O1WVMujPW7Qo8feCSYSr")
            .put("tag", "WLAbk/ttGY0OOWWVhT2MVA==")
        assertEquals("""{"hello":"dsh"}""", LinkCrypto.decryptJson(envelope, roomKey)?.toString())
    }

    @Test
    fun `口令错或包损坏一律返回 null，不给区分信号`() {
        val envelope = LinkCrypto.encryptJson(JSONObject().put("a", 1), roomKey)
        assertNotNull(LinkCrypto.decryptJson(envelope, roomKey))
        assertNull(LinkCrypto.decryptJson(envelope, "another-room-key-012345678"))
        // GCM 标签是认证加密：动一个字节就解不开，而不是解出垃圾
        val tampered = JSONObject(envelope.toString()).put("ct", envelope.getString("ct") + "AA")
        assertNull(LinkCrypto.decryptJson(tampered, roomKey))
        assertNull(LinkCrypto.decryptJson(JSONObject().put("v", 2).put("iv", ""), roomKey))
        assertNull(LinkCrypto.decryptJson(null, roomKey))
    }

    @Test
    fun `信封往返一致且不含明文`() {
        val plain = JSONObject().put("path", "/session/汉/session").put("n", 42)
        val sealed = LinkCrypto.encryptJson(plain, roomKey)
        assertEquals(1, sealed.optInt("v"))
        assertEquals(12, Base64.getDecoder().decode(sealed.getString("iv")).size)
        assertEquals(16, Base64.getDecoder().decode(sealed.getString("tag")).size)
        assertFalseContains(sealed.toString(), "session")
        assertEquals("/session/汉/session", LinkCrypto.decryptJson(sealed, roomKey)?.optString("path"))
    }

    private fun assertFalseContains(text: String, needle: String) {
        assertTrue("密文里不该出现明文片段 $needle", !text.contains(needle))
    }

    @Test
    fun `配对串解析：三种走法与兜底`() {
        fun pack(obj: JSONObject) = "dshlink1:" + Base64.getUrlEncoder().withoutPadding()
            .encodeToString(obj.toString().toByteArray(Charsets.UTF_8))

        val tunnel = LinkPairing.parse(pack(JSONObject().put("mode", "tunnel").put("url", "https://a.trycloudflare.com/").put("key", roomKey).put("host", "HOME-PC")))
        assertEquals("tunnel", tunnel?.mode)
        assertEquals("https://a.trycloudflare.com", tunnel?.url)     // 尾斜杠吃掉
        assertEquals("HOME-PC", tunnel?.host)

        val direct = LinkPairing.parse(pack(JSONObject().put("mode", "direct").put("url", "https://[2400:1::2]:8788").put("key", roomKey).put("fp", "ABCD")))
        assertEquals("direct", direct?.mode)
        assertEquals("abcd", direct?.fingerprint?.lowercase())

        // 明文 http 与短口令都不接受：公网那一跳不能裸奔
        assertNull(LinkPairing.parse(pack(JSONObject().put("url", "http://a.com").put("key", roomKey))))
        assertNull(LinkPairing.parse(pack(JSONObject().put("url", "https://a.com").put("key", "short"))))
        assertNull(LinkPairing.parse("随手粘的一段网址 https://a.com"))
        assertNull(LinkPairing.parse("dshlink1:not-base64-json"))
        assertNull(LinkPairing.parse(null))
    }

    @Test
    fun `字段兜底：只粘了地址也能拼出走法`() {
        assertEquals("tunnel", LinkPairing.fromFields("https://x.trycloudflare.com", roomKey)?.mode)
        assertEquals("direct", LinkPairing.fromFields("https://[2400:1::2]:8788", roomKey)?.mode)
        assertNull(LinkPairing.fromFields("192.168.1.9:8788", roomKey))     // 没写协议
        assertNull(LinkPairing.fromFields("https://x.trycloudflare.com", ""))
    }
}
