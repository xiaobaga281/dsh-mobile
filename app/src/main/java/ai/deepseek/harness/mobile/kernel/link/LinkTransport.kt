package ai.deepseek.harness.mobile.kernel.link

import ai.deepseek.harness.mobile.kernel.NetPolicy
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * 三种到电脑的走法，一套请求语义。
 *
 * - relay  ：手机 → 中继 → 电脑（电脑出站轮询，两边都不用被打通）。
 *            内置中继跑在电脑上，所以开箱范围是同一局域网；外部中继要有人部署。
 * - tunnel ：手机 → Cloudflare 隧道 → 电脑上的 127.0.0.1 RPC。用户不用部署任何东西，
 *            代价是地址随机、且中间那一跳归别人 —— 所以载荷仍然是端到端信封。
 * - direct ：手机 → 电脑自己的 HTTPS（全局 IPv6 或公网 IPv4）。不经过任何第三方，
 *            证书自签，按 SHA-256 指纹固定；对不上就当没连上。
 *
 * 三条路都只负责「把一次请求送到电脑的 handle() 并拿回 JSON」，业务语义完全一致。
 */
object LinkTransport {

    const val MODE_RELAY = "relay"
    const val MODE_TUNNEL = "tunnel"
    const val MODE_DIRECT = "direct"

    fun isCross(mode: String): Boolean = mode == MODE_TUNNEL || mode == MODE_DIRECT

    class Reply(val status: Int, val body: JSONObject)

    /**
     * 一次业务请求。
     *
     * 两种线上形状（差别只在中继多包一层，因为中继自己要看 headers）：
     *   中继：`{method, path, body:{headers, body}}` —— 中继按 x-link-key 认房间，再把里层转给电脑
     *   跨网：`{method, path, headers, body}` —— 整包进信封，中间层看不到任何东西，直接就是电脑 handle() 的入参
     * 把这两份写清楚比统一成一份重要：混一次就会出现「口令明明对，电脑却说 bad-key」。
     */
    fun call(
        mode: String,
        base: String,
        room: String,
        key: String,
        fingerprint: String,
        method: String,
        path: String,
        body: JSONObject?,
        deviceToken: String?,
        attempts: Int = 3,
        onFatal: (status: Int, body: JSONObject) -> Unit = { _, _ -> },
    ): Reply {
        val headers = JSONObject().apply {
            if (!deviceToken.isNullOrEmpty()) put("x-device-token", deviceToken)
        }
        // 幂等键：同一次逻辑调用的所有重试共用，电脑端按它回放应答，
        // 所以「其实到了只是回包丢了」不会把同一条消息发两遍
        val requestId = java.util.UUID.randomUUID().toString()
        return if (isCross(mode)) {
            val input = JSONObject().put("method", method).put("path", path)
                .put("headers", headers).put("body", body ?: JSONObject.NULL)
            crossCall(mode, base, key, fingerprint, input, requestId, attempts, onFatal)
        } else {
            val input = JSONObject().put("method", method).put("path", path)
                .put("body", JSONObject().put("headers", headers).put("body", body ?: JSONObject.NULL))
            relayCall(base, room, key, input, requestId, attempts, onFatal)
        }
    }

    /* ---------------- 跨网：隧道 / 直连 ---------------- */

    private fun crossCall(
        mode: String,
        base: String,
        key: String,
        fingerprint: String,
        inner: JSONObject,
        requestId: String,
        attempts: Int,
        onFatal: (Int, JSONObject) -> Unit,
    ): Reply {
        val url = "$base/mobile-link/rpc"
        NetPolicy.requireAllowed(url)
        val envelope = LinkCrypto.encryptJson(inner, key)
        var lastError: Throwable? = null
        repeat(attempts) { attempt ->
            if (attempt > 0) runCatching { Thread.sleep(if (attempt == 1) 600L else 1800L) }
            val connection = try {
                (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 12_000
                    readTimeout = 40_000
                    doOutput = true
                    setRequestProperty("Connection", "close")
                    setRequestProperty("content-type", "application/json; charset=utf-8")
                    setRequestProperty("x-request-id", requestId)
                    if (this is HttpsURLConnection) secure(this, mode, fingerprint)
                }
            } catch (error: Throwable) {
                lastError = error
                return@repeat
            }
            try {
                connection.outputStream.use { it.write(envelope.toString().toByteArray(Charsets.UTF_8)) }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
                val parsed = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
                if (status == 401) {
                    onFatal(status, parsed)
                    throw IllegalStateException(whyRejected(parsed, key))
                }
                if (status !in 200..299) {
                    if (attempt < attempts - 1) return@repeat
                    throw IllegalStateException("电脑应答异常（HTTP $status）")
                }
                // 应答同样是信封：解不开就等于这台电脑不是我们配对的那台
                val opened = LinkCrypto.decryptJson(parsed, key)
                if (opened == null) {
                    if (attempt < attempts - 1) return@repeat
                    throw IllegalStateException("应答解不开：口令已变或包体损坏")
                }
                // 电脑端把 handle() 的返回值包在 result 里（错误才是顶层的 {ok:false,error}）：
                // 不拆这一层，配对就变成「拿到了应答但没有设备令牌」这种说不清的失败
                val payload = opened.opt("result")
                val body = if (payload is JSONObject) payload else opened
                // 设备被移除 / 口令换过：电脑在信封里回 unauthorized，效果和中继那个 401 一样，
                // 本地凭据已经没意义了，清掉，别让界面继续显示「已配对」
                if (body.optString("error") == "unauthorized") onFatal(401, body)
                return Reply(status, body)
            } catch (error: Throwable) {
                lastError = error
                if (error is IllegalStateException) throw error
            } finally {
                connection.disconnect()
            }
        }
        throw lastError ?: IllegalStateException("请求失败")
    }

    /**
     * 401 的两种原因分开说：口令错（信封解不开）和「解开了但电脑拒绝这个设备」。
     * 后者不该被写成「口令不对」，那是把人往错的方向推。
     */
    private fun whyRejected(parsed: JSONObject, key: String): String {
        val opened = LinkCrypto.decryptJson(parsed, key)
        if (opened != null) return errorText(opened)
        val code = parsed.optString("error")
        return when (code) {
            "unauthorized" -> "口令不对，或这行配对串已经过期（电脑重置过配对）。回电脑面板复制一次新的。"
            else -> if (code.isEmpty()) "连接被拒绝" else code
        }
    }

    private fun errorText(body: JSONObject): String = when (body.optString("error")) {
        "bad-key" -> "口令不对"
        "unauthorized" -> "设备未获授权，请重新配对一次"
        "link-off" -> "电脑上还没点「启动联动」"
        else -> body.opt("error")?.toString() ?: "请求失败"
    }

    /* ---------------- 中继 ---------------- */

    private fun relayCall(
        base: String,
        room: String,
        key: String,
        inner: JSONObject,
        requestId: String,
        attempts: Int,
        onFatal: (Int, JSONObject) -> Unit,
    ): Reply {
        val url = "$base/link/$room/call"
        NetPolicy.requireAllowed(url)
        var lastError: Throwable? = null
        repeat(attempts) { attempt ->
            if (attempt > 0) runCatching { Thread.sleep(if (attempt == 1) 600L else 1800L) }
            val connection = try {
                (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 12_000
                    // 比中继的 30 秒上限多一点：让它先回 504，我们才好说准确的「电脑没应答」
                    readTimeout = 35_000
                    doOutput = true
                    setRequestProperty("Connection", "close")
                    setRequestProperty("content-type", "application/json; charset=utf-8")
                    setRequestProperty("x-link-key", key)
                    setRequestProperty("x-request-id", requestId)
                }
            } catch (error: Throwable) {
                lastError = error
                return@repeat
            }
            try {
                connection.outputStream.use { it.write(inner.toString().toByteArray(Charsets.UTF_8)) }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
                val parsed = if (text.isBlank()) JSONObject()
                else runCatching { JSONObject(text) }.getOrElse { JSONObject().put("ok", false).put("error", text.take(200)) }
                if (status == 503 && parsed.optString("error") == "host-offline") {
                    throw IllegalStateException("电脑不在线：确认桌面端已打开「手机联动」")
                }
                if (status == 504) {
                    if (attempt < attempts - 1) return@repeat
                    throw IllegalStateException("电脑没有响应，请确认桌面端在运行")
                }
                if (status == 401) {
                    onFatal(status, parsed)
                    throw IllegalStateException(errorText(parsed))
                }
                return Reply(status, parsed)
            } catch (error: Throwable) {
                lastError = error
                if (error is IllegalStateException) throw error
            } finally {
                connection.disconnect()
            }
        }
        throw lastError ?: IllegalStateException("请求失败")
    }

    /* ---------------- 指纹固定 ---------------- */

    /**
     * 直连按指纹信任；隧道不在这层做判断。
     *
     * 直连的证书是自签的，没有 CA 链可验，也没有有效的域名（主机名是局域网名或 IPv6 字面量）。
     * 所以信任锚换成正文里那串 SHA-256：配对串带 fp 时首连即固定；不带时先 observe 一次，
     * 用户在界面上核对过才落盘 —— 之后任何别的证书都不接受。
     *
     * 隧道那边 trycloudflare 的地址由公共 CA 签发，走系统默认信任链才是对的；
     * 拿自签那一套去连它等于放弃校验。
     */
    fun secure(connection: HttpsURLConnection, mode: String, fingerprint: String) {
        if (mode != MODE_DIRECT) return
        connection.sslSocketFactory = if (fingerprint.isBlank()) trustAllFactory else pinnedFactory(fingerprint)
        // 主机名不参与判断：我们认的是指纹，不是 CN/SAN（自签证书根本没有 SAN）
        connection.hostnameVerifier = HostnameVerifier { _, _ -> true }
    }

    /** 观察一次公钥证书指纹（只用于首连取证，取到的东西不当信任凭据） */
    fun observeFingerprint(base: String): String {
        val url = "$base/mobile-link/hello"
        NetPolicy.requireAllowed(url)
        val connection = URL(url).openConnection() as HttpsURLConnection
        connection.sslSocketFactory = trustAllFactory
        connection.hostnameVerifier = HostnameVerifier { _, _ -> true }
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        try {
            connection.inputStream.use { it.readBytes() }
            val leaf = connection.serverCertificates.firstOrNull() as? X509Certificate
                ?: throw IllegalStateException("对方没有给出证书")
            return LinkCrypto.sha256Hex(leaf.encoded)
        } finally {
            connection.disconnect()
        }
    }

    /** hello 是不带秘密的自报家门：机器名与指纹都在那里 */
    fun hello(base: String, mode: String, fingerprint: String): JSONObject {
        val url = "$base/mobile-link/hello"
        NetPolicy.requireAllowed(url)
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        if (connection is HttpsURLConnection) secure(connection, mode, fingerprint)
        try {
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            return runCatching { JSONObject(text) }.getOrElse { JSONObject().put("ok", false).put("error", text.take(160)) }
        } finally {
            connection.disconnect()
        }
    }

    private val pinnedCache = HashMap<String, SSLSocketFactory>()

    private fun pinnedFactory(fingerprint: String): SSLSocketFactory = pinnedCache.getOrPut(fingerprint.lowercase()) {
        build(trustManager(fingerprint))
    }

    private val trustAllFactory: SSLSocketFactory by lazy { build(trustManager(null)) }

    private fun build(tm: TrustManager): SSLSocketFactory {
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(tm), java.security.SecureRandom())
        return context.socketFactory
    }

    /** 校验式 TrustManager：accepts 里只做指纹比对，链上的其它东西一概不看 */
    private fun trustManager(fingerprint: String?): X509TrustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) { /* 没有客户端证书 */ }
        override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw java.security.cert.CertificateException("对方没有给出证书")
            val want = fingerprint?.trim()?.lowercase()?.replace(":", "")
            if (want.isNullOrEmpty()) return    // 取证模式：不做判断，调用方自己负责
            val got = LinkCrypto.sha256Hex(leaf.encoded)
            if (got != want) throw java.security.cert.CertificateException(
                "证书指纹对不上：期望 ${want.take(16)}…，实际 ${got.take(16)}…（可能换过证书，或被中间人顶替）"
            )
        }
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    /** 把 Java 的网络异常翻成一句用户能行动的话 */
    fun friendly(error: Throwable): String = when {
        error is IllegalArgumentException || error is IllegalStateException -> error.message ?: "连接失败"
        error is java.security.cert.CertificateException -> error.message ?: "证书指纹校验失败"
        error is javax.net.ssl.SSLHandshakeException -> "TLS 握手失败：证书指纹不匹配，或对方不是这台电脑"
        error is java.net.UnknownHostException -> "解析不了这个地址，检查手机网络"
        error is java.net.ConnectException -> "连不上：地址或端口不对，或电脑端没在监听"
        error is java.net.SocketTimeoutException -> "连接超时：地址可达但电脑没应答"
        error is java.net.NoRouteToHostException -> "到这台电脑没有路由：手机与它不在同一网络，且这条直连走不通"
        else -> error.message ?: error.javaClass.simpleName
    }
}
