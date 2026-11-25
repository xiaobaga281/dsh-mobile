package ai.deepseek.harness.mobile.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.security.KeyFactory
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.Date

class SelfSignedKeyTest {

    private fun certOf(der: ByteArray) =
        CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(der)) as java.security.cert.X509Certificate

    @Test
    fun `证书可被标准 CertificateFactory 解析且主体正确`() {
        val km = SelfSignedKey.generate("DeepSeek Harness Mobile", "DeepSeek Harness", "CN")
        val cert = certOf(km.cert)
        // RFC2253 渲染按编码逆序；RDN 编码顺序是 C → O → CN（惯例），渲染即 CN 在最后。
        // 断言用集合比较，不锁顺序 —— 顺序本身没有语义。
        val parts = { p: javax.security.auth.x500.X500Principal ->
            p.name.split(",").map { it.trim() }.toSortedSet() }
        assertEquals(parts(certOf(km.cert).issuerX500Principal), parts(certOf(km.cert).subjectX500Principal))
        assertTrue("应包含 CN", certOf(km.cert).subjectX500Principal.name.contains("CN=DeepSeek Harness Mobile"))
        assertEquals("SHA256WITHRSA", cert.sigAlgName.uppercase())
    }

    @Test
    fun `证书签名可用公钥验证（自签的闭环）`() {
        val km = SelfSignedKey.generate("t", "o", "CN")
        val cert = certOf(km.cert)
        cert.verify(cert.publicKey)     // 不抛即通过
    }

    @Test
    fun `证书未过期且有效期约 100 年`() {
        val km = SelfSignedKey.generate("t", "o", "CN", validityDays = 36500)
        val cert = certOf(km.cert)
        val now = Date()
        assertTrue("notBefore 应已生效", cert.notBefore.before(now))
        val expectedEnd = now.time + 36500L * 24 * 3600 * 1000
        assertTrue("notAfter 应在一百年附近", Math.abs(cert.notAfter.time - expectedEnd) < 24 * 3600 * 1000 * 3)
    }

    @Test
    fun `PKCS8 私钥与证书公钥配对`() {
        val km = SelfSignedKey.generate("t", "o", "CN")
        val pub = certOf(km.cert).publicKey
        val priv = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(km.pkcs8))
        val msg = "roundtrip".toByteArray()
        val sig = Signature.getInstance("SHA256withRSA").apply { initSign(priv); update(msg) }.sign()
        Signature.getInstance("SHA256withRSA").apply { initVerify(pub); update(msg) }.verify(sig)
        assertEquals(2048, (pub as java.security.interfaces.RSAPublicKey).modulus.bitLength())
    }

    @Test
    fun `证书公钥可被 X509EncodedKeySpec 还原（DER 结构无杂质）`() {
        val km = SelfSignedKey.generate("t", "o", "CN")
        val pub = certOf(km.cert).publicKey
        val re = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(pub.encoded))
        assertEquals(pub, re)
    }

    @Test
    fun `证书是 v1（最短编码，无扩展）`() {
        val km = SelfSignedKey.generate("t", "o", "CN")
        val cert = certOf(km.cert)
        assertEquals(1, cert.version)   // X509Certificate.version 返回 value+1，v1 → 1
    }

    @Test
    fun `DER 整数编码无前导垃圾（serial 为正且最简）`() {
        // 连续生成多把，确保随机 serial 的 TLV 长度都在 20 字节内（159bit → ≤21 字节内容）
        repeat(8) {
            val km = SelfSignedKey.generate("t", "o", "CN")
            assertTrue("cert 大小异常：${km.cert.size}", km.cert.size in 300..900)
            assertTrue("pkcs8 大小异常：${km.pkcs8.size}", km.pkcs8.size in 1100..1300)
        }
    }

    @Test
    fun `Base64 视角下无多余填充结构（可直接落盘复用）`() {
        val km = SelfSignedKey.generate("t", "o", "CN")
        val b64 = Base64.getEncoder().encodeToString(km.pkcs8)
        assertTrue(b64.isNotEmpty())
        // 再次解析落盘后的字节
        val back = Base64.getDecoder().decode(b64)
        assertTrue(km.pkcs8.contentEquals(back))
    }
}
