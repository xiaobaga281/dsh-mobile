package ai.deepseek.harness.mobile.bridge

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * 账号域：DeepSeek 手机号登录、令牌、可用模型。
 */
class AccountBridge(private val core: BridgeCore) {

    private val webView get() = core.webView
    private fun emitRaw(js: String) = core.raw(js)

    /* ---------------- DeepSeek 账号（手机号登录，等价桌面 deepseek-account） ---------------- */

    private val auth get() = core.auth

    @JavascriptInterface
    fun accountState(): String {
        val s = auth.state()
        return JSONObject().apply {
            put("signedIn", s.signedIn)
            put("phase", s.phase)
            put("user", s.user ?: JSONObject())
            put("error", s.error ?: "")
            put("authorizeUrl", s.authorizeUrl ?: "")
        }.toString()
    }

    /** 拉起一次授权；结果通过 onAccount(id, state) 回传（可能在几十秒后） */
    @JavascriptInterface
    fun accountStart(id: String) {
        auth.startSignIn { st ->
            webView.post {
                emitRaw(
                    "window.DSHHost&&window.DSHHost.onAccount&&window.DSHHost.onAccount(" +
                        JSONObject.quote(id) + "," + JSONObject.quote(JSONObject().apply {
                            put("signedIn", st.signedIn)
                            put("phase", st.phase)
                            put("user", st.user ?: JSONObject())
                            put("error", st.error ?: "")
                        }.toString()) + ")"
                )
            }
        }
    }

    @JavascriptInterface
    fun accountSignOut(): String {
        auth.signOut()
        return accountState()
    }

    /**
     * 登录后可用的模型目录（桌面 `llm-deepseek-account` 的 `GET /models`）。
     * 桌面用 `x-dsh-auth-token` 而非 Bearer，同一账号看到的就是平台给它的模型。
     */
    @JavascriptInterface
    fun accountModels(): String {
        val token = auth.token()
        if (token.isNullOrBlank()) {
            return JSONObject().put("ok", false).put("code", "SIGN_IN_REQUIRED")
                .put("error", "未登录").toString()
        }
        return try {
            val c = (java.net.URL("https://api.deepseek.com/models").openConnection()
                    as java.net.HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15000
                readTimeout = 25000
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/json")
                setRequestProperty("x-dsh-auth-token", token)
                setRequestProperty("User-Agent", "deepseek-harness-mobile/0.2.1")
            }
            val code = c.responseCode
            val body = (if (code in 200..299) c.inputStream else c.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            c.disconnect()
            if (code !in 200..299) {
                return JSONObject().put("ok", false).put("code", "HTTP_$code")
                    .put("error", if (code == 401) "登录已失效，请重新登录" else "HTTP $code").toString()
            }
            val data = runCatching { JSONObject(body).optJSONArray("data") }.getOrNull()
                ?: return JSONObject().put("ok", false).put("code", "INVALID_RESPONSE")
                    .put("error", "模型列表格式异常").toString()
            val models = org.json.JSONArray()
            for (i in 0 until data.length()) {
                val m = data.optJSONObject(i) ?: continue
                val mid = m.optString("id")
                if (mid.isBlank()) continue
                models.put(JSONObject().apply {
                    put("id", mid)
                    put("name", m.optString("name").ifBlank { mid })
                    if (m.has("context_window")) put("contextWindow", m.optInt("context_window"))
                    if (m.has("max_output_tokens")) put("maxOutput", m.optInt("max_output_tokens"))
                })
            }
            JSONObject().put("ok", models.length() > 0).put("models", models).toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("code", "TRANSPORT")
                .put("error", t.message ?: "连接失败").toString()
        }
    }
}
