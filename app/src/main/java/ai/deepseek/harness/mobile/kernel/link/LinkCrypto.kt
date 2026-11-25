package ai.deepseek.harness.mobile.kernel.link

import org.json.JSONObject
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 手机 ↔ 电脑的端到端信封 —— 与电脑端 `dsh-mobile-link/e2e.mjs` 逐字节一致。
 *
 * 为什么要这一层：跨网时中间那一段（Cloudflare 隧道，或任何中继）在它的边缘终结 TLS，
 * 那一跳看得到明文。设备之间再用房间口令派生同一把 AES-256-GCM 会话密钥，
 * 中间层只剩密文与长度 —— 包括配对口令与设备令牌本身。
 *
 * 算法两端必须一模一样，所以它有跨语言测试向量（LinkCryptoTest 里那份来自 Node 实跑）：
 *   key   = HKDF-SHA256(ikm=utf8(roomKey), salt="dsh-mobile-link-v1", info="rpc-aes-256-gcm", len=32)
 *   信封  = { v:1, iv:base64(12B), ct:base64, tag:base64(16B) }
 */
object LinkCrypto {

    private const val SALT = "dsh-mobile-link-v1"
    private const val INFO = "rpc-aes-256-gcm"
    private const val TAG_BITS = 128

    /** HKDF-SHA256，只取一个块（32 字节够用，省掉 counter 循环） */
    fun hkdf(secret: String, len: Int = 32): ByteArray {
        val prk = hmac(SALT.toByteArray(Charsets.UTF_8), secret.toByteArray(Charsets.UTF_8))
        val info = INFO.toByteArray(Charsets.UTF_8)
        val okm = hmac(prk, info + byteArrayOf(0x01))
        return if (len <= okm.size) okm.copyOf(len) else okm
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    fun encryptJson(obj: JSONObject, roomKey: String): JSONObject {
        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(hkdf(roomKey), "AES"), GCMParameterSpec(TAG_BITS, iv))
        val out = cipher.doFinal(obj.toString().toByteArray(Charsets.UTF_8))
        val ct = out.copyOfRange(0, out.size - 16)
        val tag = out.copyOfRange(out.size - 16, out.size)
        return JSONObject()
            .put("v", 1)
            .put("iv", b64(iv))
            .put("ct", b64(ct))
            .put("tag", b64(tag))
    }

    /**
     * 解不开就返回 null：口令错、被截断、版本不对一律同一个结果 ——
     * 不给中间层任何「猜对了没有」的区分信号。
     */
    fun decryptJson(envelope: JSONObject?, roomKey: String): JSONObject? {
        if (envelope == null || envelope.optInt("v") != 1) return null
        return runCatching {
            val iv = b64d(envelope.getString("iv"))
            val ct = b64d(envelope.getString("ct"))
            val tag = b64d(envelope.getString("tag"))
            if (iv.size != 12 || tag.size != 16 || ct.isEmpty()) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(hkdf(roomKey), "AES"), GCMParameterSpec(TAG_BITS, iv))
            val plain = cipher.doFinal(ct + tag)
            JSONObject(String(plain, Charsets.UTF_8))
        }.getOrNull()
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    private fun b64d(text: String): ByteArray = Base64.getDecoder().decode(text.trim())
}

/**
 * 电脑面板复制下来的那一行配对串：`dshlink1:<base64url(json)>`。
 *
 * 为什么不让用户抄三个字段：房间口令是 128 bit，手抄不现实；隧道地址还是随机的。
 * 一行粘贴把「抄长地址」和「抄口令」两件事一起消掉。
 */
data class LinkTarget(val mode: String, val url: String, val key: String, val host: String, val fingerprint: String)

object LinkPairing {

    private const val PREFIX = "dshlink1:"

    fun parse(text: String?): LinkTarget? {
        val trimmed = text?.trim().orEmpty()
        if (!trimmed.startsWith(PREFIX)) return null
        val json = runCatching {
            String(Base64.getUrlDecoder().decode(trimmed.substring(PREFIX.length)), Charsets.UTF_8)
        }.getOrNull() ?: return null
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return null
        val url = obj.optString("url").trim().trimEnd('/')
        val key = obj.optString("key")
        if (!url.startsWith("https://")) return null
        if (key.length < 8) return null
        val mode = if (obj.optString("mode") == "direct") "direct" else "tunnel"
        return LinkTarget(mode, url, key, obj.optString("host"), obj.optString("fp"))
    }

    /** 兼容用户只粘了地址/口令分项的情况：从裸地址拼出一个 tunnel 目标 */
    fun fromFields(urlRaw: String, keyRaw: String, hostName: String = ""): LinkTarget? {
        val url = urlRaw.trim().trimEnd('/')
        val key = keyRaw.trim()
        if (!url.startsWith("https://") || key.length < 8) return null
        return LinkTarget(if (url.contains(".trycloudflare.com")) "tunnel" else "direct", url, key, hostName, "")
    }
}
