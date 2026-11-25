package ai.deepseek.harness.mobile.account

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * DeepSeek 手机账号登录 —— 复刻桌面 Harness 的 `deepseek-account` 授权流程。
 *
 * 桌面版：本地 loopback HTTP 服务接 `/oauth/callback`，用 PKCE 换 token，
 * token 只放在 Host 侧，模型请求时按 origin 解析（api.deepseek.com 才给）。
 * 安卓端照搬同一条链路，只把「本地 webServer 路由」换成一次性的 ServerSocket：
 *
 *   1. 起 127.0.0.1:<随机端口>，redirect_uri = http://127.0.0.1:<port>/oauth/callback
 *      （平台只接受 loopback 回调，这是 OAuth 原生应用的通行做法）
 *   2. POST platform.deepseek.com/auth-api/v0/dsh/auth_init（code_challenge=S256）
 *      → authorize_url，用系统浏览器打开，用户在网页里用手机号登录
 *   3. 浏览器带着 ?code&state 回到本机端口，校验 state 后
 *      POST auth_exchange（code + code_verifier + device_id）→ token
 *   4. token 存本地（不进工作区），作为 api.deepseek.com 的 Bearer，也可用于
 *      platform 的 getProfile / balance（x-dsh-auth-token 头）
 *
 * 和桌面一致的取舍：token 没有刷新流程，401 即失效，重新登录即可。
 */
class DeepSeekAuth(private val context: Context) {

    companion object {
        private const val PLATFORM = "https://platform.deepseek.com"
        private const val PREFS = "dsh.account"
        private const val KEY_TOKEN = "token"
        private const val KEY_USER = "user"
        private const val KEY_AT = "signedAt"
    }

    data class State(
        val signedIn: Boolean,
        val phase: String = "idle",       // idle | waiting-browser | exchanging | error
        val user: JSONObject? = null,
        val error: String? = null,
        val authorizeUrl: String? = null,
    )

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    @Volatile private var phase = "idle"
    @Volatile private var lastError: String? = null
    @Volatile private var authorizeUrl: String? = null
    @Volatile private var cancelRequested = false

    fun token(): String? = prefs.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun signOut() {
        val t = token()
        prefs.edit().remove(KEY_TOKEN).remove(KEY_USER).remove(KEY_AT).apply()
        phase = "idle"
        if (t != null) {
            Thread {
                runCatching {
                    val c = (URL("$PLATFORM/auth-api/v0/users/logout").openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        doOutput = true
                        connectTimeout = 8000
                        readTimeout = 8000
                        setRequestProperty("x-dsh-auth-token", t)
                    }
                    c.outputStream.use { it.write("{}".toByteArray()) }
                    c.responseCode
                    c.disconnect()
                }
            }.start()
        }
    }

    fun state(): State = State(
        signedIn = token() != null,
        phase = phase,
        user = runCatching { prefs.getString(KEY_USER, null)?.let { JSONObject(it) } }.getOrNull(),
        error = lastError,
        authorizeUrl = authorizeUrl,
    )

    fun cancel() { cancelRequested = true; phase = "idle" }

    /**
     * 启动一次登录：拿 authorize_url → 打开浏览器；回调到达后在后台换 token。
     * [onDone] 在登录成功/失败时回调（主线程由调用方切）。
     */
    fun startSignIn(onDone: (State) -> Unit) {
        if (phase == "waiting-browser" || phase == "exchanging") return
        cancelRequested = false
        lastError = null
        phase = "initializing"
        Thread {
            var server: ServerSocket? = null
            try {
                val verifier = randomToken(32)
                val state = randomToken(32)
                val challenge = base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))

                server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
                val port = server.localPort
                val redirectUri = "http://127.0.0.1:$port/oauth/callback"

                val init = post(
                    "$PLATFORM/auth-api/v0/dsh/auth_init",
                    JSONObject().apply {
                        put("code_challenge", challenge)
                        put("code_challenge_method", "S256")
                        put("state", state)
                        put("redirect_uri", redirectUri)
                        put("locale", "zh_CN")
                        put("login_source", "desktop")
                    },
                )
                val url = init.optString("authorize_url")
                if (url.isBlank()) throw IllegalStateException("平台没有返回授权地址：${init.toString().take(200)}")
                authorizeUrl = url
                phase = "waiting-browser"

                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })

                val code = awaitCallback(server, state, 240)
                if (code == null) throw IllegalStateException(lastError ?: "等待授权超时")
                phase = "exchanging"

                val deviceId = prefs.getString("device_id", null) ?: UUID.randomUUID().toString().also {
                    prefs.edit().putString("device_id", it).apply()
                }
                val exchanged = post(
                    "$PLATFORM/auth-api/v0/dsh/auth_exchange",
                    JSONObject().apply {
                        put("code", code)
                        put("code_verifier", verifier)
                        put("redirect_uri", redirectUri)
                        put("device_id", deviceId)
                        put("device_model", "Android-${android.os.Build.MODEL}")
                        put("os_version", "Android ${android.os.Build.VERSION.RELEASE}")
                    },
                )
                val token = exchanged.optString("token")
                if (token.isBlank()) throw IllegalStateException("换取登录凭据失败：${exchanged.toString().take(200)}")
                prefs.edit()
                    .putString(KEY_TOKEN, token)
                    .putString(KEY_USER, exchanged.optJSONObject("user")?.toString() ?: "{}")
                    .putLong(KEY_AT, System.currentTimeMillis())
                    .apply()
                phase = "idle"
                onDone(state())
            } catch (t: Throwable) {
                lastError = t.message ?: t.javaClass.simpleName
                phase = "error"
                onDone(state())
            } finally {
                runCatching { server?.close() }
            }
        }.start()
    }

    /* ---------------- 一次性回调服务 ---------------- */

    private fun awaitCallback(server: ServerSocket, expectedState: String, timeoutSec: Int): String? {
        val latch = CountDownLatch(1)
        val code = AtomicReference<String?>(null)
        Thread {
            try {
                server.soTimeout = timeoutSec * 1000
                val socket: Socket = server.accept()
                socket.use { s ->
                    val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
                    val requestLine = reader.readLine().orEmpty()
                    val path = requestLine.split(" ").getOrNull(1).orEmpty()
                    val query = Uri.parse("http://127.0.0.1$path").getQueryParameter("code")
                    val state = Uri.parse("http://127.0.0.1$path").getQueryParameter("state")
                    if (state != null && state != expectedState) {
                        lastError = "回调校验失败（state 不匹配）"
                    } else if (query != null) {
                        code.set(query)
                    } else {
                        lastError = "回调没有携带授权码"
                    }
                    respond(s.getOutputStream(), code.get() != null)
                }
            } catch (t: Throwable) {
                if (lastError == null) lastError = "等待授权超时或已取消"
            } finally {
                latch.countDown()
            }
        }.apply { isDaemon = true }.start()
        latch.await(timeoutSec.toLong() + 2, TimeUnit.SECONDS)
        return code.get()
    }

    private fun respond(out: OutputStream, ok: Boolean) {
        val title = if (ok) "登录成功" else "登录失败"
        val body = if (ok) "已登录 DeepSeek 账号，可以关掉这个页面回到应用。" else "登录没有完成，请回到应用重试。"
        val html = """
            <!doctype html><html lang="zh-CN"><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>$title</title>
            <body style="font-family:system-ui;padding:48px 24px;text-align:center;background:#fff;color:#111">
            <h2 style="font-weight:600">$title</h2><p style="color:#666">$body</p></body></html>
        """.trimIndent()
        val bytes = html.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"
        out.write(head.toByteArray())
        out.write(bytes)
        out.flush()
    }

    /* ---------------- 平台请求 ---------------- */

    private fun post(url: String, body: JSONObject): JSONObject {
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 30_000
            doOutput = true
            instanceFollowRedirects = false
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
            // 桌面端 platformClientHeaders 的等价物：缺失时平台会拒绝
            setRequestProperty("x-client-bundle-id", "")
            setRequestProperty("x-client-platform", "web")
            setRequestProperty("x-client-version", "0.2.1-rc.2")
            setRequestProperty("x-client-locale", "zh_CN")
            setRequestProperty("x-client-timezone-offset", (java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 1000).toString())
        }
        try {
            c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val raw = (if (code in 200..299) c.inputStream else c.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw IllegalStateException("HTTP $code ${raw.take(200)}")
            val root = JSONObject(raw)
            // 平台统一信封 {code:0,data:{biz_code,biz_data}}
            if (root.has("data")) {
                val data = root.optJSONObject("data") ?: return root
                return data.optJSONObject("biz_data") ?: data
            }
            return root
        } finally {
            runCatching { c.disconnect() }
        }
    }

    private fun randomToken(bytes: Int): String {
        val b = ByteArray(bytes)
        SecureRandom().nextBytes(b)
        return base64Url(b)
    }

    private fun base64Url(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
