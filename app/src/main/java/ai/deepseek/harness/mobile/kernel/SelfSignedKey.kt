package ai.deepseek.harness.mobile.kernel

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.RSAPrivateCrtKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.RSAPrivateCrtKeySpec
import java.time.ZonedDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * 自签 X.509 证书 + PKCS#8 私钥生成 —— **全程在宿主进程内**，不进 proot。
 *
 * 为什么不用 guest 里的 keytool：proot 下 JVM 启动要在匿名内存上 mprotect(PROT_EXEC)，
 * 会被 PaX 风格的 W^X 策略随机拦截（"Failed to mark memory page as executable"，
 * 实测失败率 20~35%，连 `-Xint` 都躲不掉 —— 解释器启动期同样要生成 stub 代码）。
 * 而生成密钥对与自签证书是**纯密码学操作**，Android 自带的 JCA（KeyPairGenerator /
 * Signature）就能做，根本没有理由把它送进 guest。
 *
 * 产物是两份 DER 文件，直接喂给 `apksigner sign --key <pkcs8> --cert <x509>` ——
 * 连 keystore 都不需要（apksigner 原生支持这对参数）。
 *
 * DER 编码手写（与自研 PNG 编码器同一思路）：只用到十来个 TLV 类型，引整个 BC
 * 反而重。证书取 **X.509 v1**（无 version/extension 字段，debug.keystore 的证书
 * 就是 v1）—— APK 签名证书没有任何扩展要求，v1 完全合法且编码最短。
 */
object SelfSignedKey {

    private const val OID_SHA256_RSA = "1.2.840.113549.1.1.11"
    private const val OID_RSA = "1.2.840.113549.1.1.1"
    private const val OID_CN = "2.5.4.3"
    private const val OID_O = "2.5.4.10"
    private const val OID_C = "2.5.4.6"

    class KeyMaterial(val pkcs8: ByteArray, val cert: ByteArray)

    /**
     * 生成 RSA 密钥对与自签证书。
     *
     * @param commonName 证书主体（如 "DeepSeek Harness Mobile"）
     * @param validityDays 有效期（天）；从今天起算
     */
    fun generate(commonName: String, organization: String, country: String, validityDays: Int = 36500): KeyMaterial {
        val kpg = KeyPairGenerator.getInstance("RSA")
        kpg.initialize(2048)
        val kp = kpg.generateKeyPair()
        val cert = buildCert(kp, commonName, organization, country, validityDays)
        return KeyMaterial(pkcs8Of(kp), cert)
    }

    /* ---------------- X.509 组装 ---------------- */

    private fun buildCert(kp: KeyPair, cn: String, org: String, c: String, validityDays: Int): ByteArray {
        val rnd = SecureRandom()
        val serial = BigInteger(159, rnd)                      // 正数、159 位：DER 首字节必非 0xFF，也避免负数序列号
        val notBefore = ZonedDateTime.now(ZoneOffset.UTC).minusMinutes(5)   // 留时钟偏差余量
        val notAfter = notBefore.plusDays(validityDays.toLong())
        val name = nameOf(cn, org, c)
        val algId = seq(oid(OID_SHA256_RSA), nullDer())
        val spki = spkiOf(kp)

        val tbs = seq(
            derInt(serial),
            algId,
            name,
            seq(utcOrGeneralized(notBefore), utcOrGeneralized(notAfter)),
            name,
            spki,
        )
        val sig = Signature.getInstance("SHA256withRSA").apply {
            initSign(kp.private)
            update(tbs)
        }.sign()
        return seq(tbs, algId, bitString(sig))
    }

    /** 1950–2049 用 UTCTime，其余 GeneralizedTime（严格 DER 的年代规则） */
    private fun utcOrGeneralized(t: ZonedDateTime): ByteArray {
        val year = t.year
        return if (year in 1950..2049) {
            tlv(0x17, DateTimeFormatter.ofPattern("yyMMddHHmmss'Z'").format(t).toByteArray())
        } else {
            tlv(0x18, DateTimeFormatter.ofPattern("yyyyMMddHHmmss'Z'").format(t).toByteArray())
        }
    }

    private fun nameOf(cn: String, org: String, c: String): ByteArray = seq(
        set(rdn(OID_CN, utf8(cn))),
        set(rdn(OID_O, utf8(org))),
        set(rdn(OID_C, printable(c))),
    )

    private fun rdn(oidStr: String, value: ByteArray) = seq(oid(oidStr), value)

    private fun spkiOf(kp: KeyPair): ByteArray {
        val pub = kp.public as java.security.interfaces.RSAPublicKey
        val rsaPub = seq(derInt(pub.modulus), derInt(pub.publicExponent))
        return seq(seq(oid(OID_RSA), nullDer()), bitString(rsaPub))
    }

    /** PKCS#8 PrivateKeyInfo：SEQ(INTEGER 0, AlgorithmIdentifier, OCTET(RSAPrivateKey)) */
    private fun pkcs8Of(kp: KeyPair): ByteArray {
        val priv = kp.private as RSAPrivateCrtKey
        val rsa = seq(
            derInt(BigInteger.ZERO),
            derInt(priv.modulus),
            derInt(priv.publicExponent),
            derInt(priv.privateExponent),
            derInt(priv.primeP),
            derInt(priv.primeQ),
            derInt(priv.primeExponentP),
            derInt(priv.primeExponentQ),
            derInt(priv.crtCoefficient),
        )
        return seq(derInt(BigInteger.ZERO), seq(oid(OID_RSA), nullDer()), octetString(rsa))
    }

    /** JVM 单测与调用方共用：从 PKCS#8 还原私钥（校验可解析性） */
    fun parsePkcs8(pkcs8: ByteArray): RSAPrivateCrtKey =
        KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(pkcs8)) as RSAPrivateCrtKey

    /* ---------------- DER 原语 ---------------- */

    private fun tlv(tag: Int, content: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(tag)
        when {
            content.size < 0x80 -> out.write(content.size)
            content.size < 0x100 -> { out.write(0x81); out.write(content.size) }
            else -> { out.write(0x82); out.write(content.size shr 8); out.write(content.size and 0xff) }
        }
        out.write(content)
        return out.toByteArray()
    }

    private fun concat(parts: List<ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        parts.forEach { out.write(it) }
        return out.toByteArray()
    }

    private fun seq(vararg parts: ByteArray) = tlv(0x30, concat(parts.toList()))
    private fun set(vararg parts: ByteArray) = tlv(0x31, concat(parts.toList()))
    private fun derInt(v: BigInteger) = tlv(0x02, v.toByteArray())     // BigInteger 已是最简二补码（正数自动带前导 0）
    private fun oid(s: String) = tlv(0x06, encodeOid(s))
    private fun nullDer() = tlv(0x05, ByteArray(0))
    private fun octetString(b: ByteArray) = tlv(0x04, b)
    private fun bitString(b: ByteArray) = tlv(0x03, byteArrayOf(0) + b)   // 0 个未用位
    private fun utf8(s: String) = tlv(0x0C, s.toByteArray(Charsets.UTF_8))
    private fun printable(s: String) = tlv(0x13, s.toByteArray(Charsets.US_ASCII))

    private fun encodeOid(s: String): ByteArray {
        val parts = s.split('.').map { it.toLong() }
        val out = ByteArrayOutputStream()
        out.write((parts[0] * 40 + parts[1]).toInt())
        for (p in parts.drop(2)) {
            var v = p
            val stack = ArrayDeque<Byte>()
            stack.addFirst((v and 0x7f).toByte())
            v = v shr 7
            while (v > 0) {
                stack.addFirst(((v and 0x7f) or 0x80).toByte())
                v = v shr 7
            }
            stack.forEach { out.write(it.toInt()) }
        }
        return out.toByteArray()
    }
}
