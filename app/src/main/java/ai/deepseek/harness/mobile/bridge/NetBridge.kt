package ai.deepseek.harness.mobile.bridge

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import ai.deepseek.harness.mobile.MainActivity
import ai.deepseek.harness.mobile.glass.GlassSheet
import ai.deepseek.harness.mobile.glass.HonorGlass
import org.json.JSONObject

/**
 * 网络域：模型列表、余额、通用 HTTP 代理（绕过 WebView CORS）。
 */
class NetBridge(private val core: BridgeCore) {

    private val activity get() = core.activity
    private val webView get() = core.webView
    private val prefs get() = core.prefs
    private fun emitRaw(js: String) = core.raw(js)
    private fun emit(fn: String, id: String, payload: String) = core.emit(fn, id, payload)

    private val streams get() = core.streams
    private val auth get() = core.auth

    private companion object {
        /** 平台（账号登录）根地址：余额、钱包都在这台机器上，和 api.deepseek.com 不是一套凭据 */
        const val PLATFORM = "https://platform.deepseek.com"
    }

    @JavascriptInterface
    fun fetchModels(requestId: String, baseUrl: String, apiKey: String) {
        Thread {
            val result = JSONObject()
            try {
                val trimmed = baseUrl.trim().trimEnd('/')
                val endpoint = if (trimmed.endsWith("/models")) trimmed else "$trimmed/models"
                ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed(endpoint)
                val conn = (java.net.URL(endpoint).openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 15000
                    readTimeout = 25000
                    setRequestProperty("Accept", "application/json")
                    if (apiKey.isNotBlank()) setRequestProperty("Authorization", "Bearer $apiKey")
                }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                if (code !in 200..299) {
                    result.put("ok", false)
                    result.put("error", "HTTP $code")
                } else {
                    val ids = org.json.JSONArray()
                    // 顺带捞上下文长度：llama.cpp 放在 meta.n_ctx，Ollama 放在 details /
                    // context_length，别家多半没有。本地模型窗口远小于云端（常见 4k~32k），
                    // 拿不到这个数就会按 128k 去压缩，请求必然 400。
                    val ctx = JSONObject()
                    val root = runCatching { JSONObject(body) }.getOrNull()
                    val data = root?.optJSONArray("data") ?: root?.optJSONArray("models")
                    if (data != null) {
                        for (i in 0 until data.length()) {
                            val item = data.optJSONObject(i) ?: continue
                            val id = item.optString("id").takeIf { it.isNotBlank() }
                                ?: item.optString("name").takeIf { it.isNotBlank() }
                            if (id != null) ids.put(id)
                            val metaCtx = item.optJSONObject("meta")?.optInt("n_ctx", 0) ?: 0
                            val n = if (metaCtx > 0) metaCtx else item.optInt("context_length", 0)
                            if (id != null && n > 0) ctx.put(id, n)
                        }
                    }
                    result.put("ok", ids.length() > 0)
                    result.put("models", ids)
                    if (ctx.length() > 0) result.put("ctx", ctx)
                    if (ids.length() == 0) result.put("error", "该端点没有返回模型列表")
                }
                conn.disconnect()
            } catch (t: Throwable) {
                runCatching {
                    result.put("ok", false)
                    result.put("error", t.message ?: "请求失败")
                }
            }
            emit("onModels", requestId, result.toString())
        }.apply { isDaemon = true }.start()
    }

    /**
     * 账户余额（额度）。两条路，别混：
     *   · API Key 模式 → `GET api.deepseek.com/user/balance`，Authorization: Bearer。
     *   · 账号登录模式 → 平台钱包 `GET platform.deepseek.com/api/v0/users/get_user_summary`，
     *     带 x-dsh-auth-token + 客户端标识头（平台缺头会 403）。
     *     信封 {code:0,data:{biz_code,biz_data:{normal_wallets,bonus_wallets}}}。
     * 早先两种模式都打到 api.deepseek.com，账号模式下必然 403 —— 这就是「余额一直 403」。
     *
     * 这里是 **GET**：平台这条路径只挂了 GET 路由，POST 会被边缘直接回 405
     * （`Method Not Allowed`，不带业务 code）。桌面 account-platform 的
     * `requestAccount()` 也是 GET，手机端此前写成了 POST 且带 `{}` 请求体 —— 那就是 405 的全部来源。
     */
    @JavascriptInterface
    fun fetchBalance(requestId: String, baseUrl: String, apiKey: String) {
        Thread {
            val result = when {
                apiKey.isBlank() -> accountBalance()
                // 只有 DeepSeek 官方端点才有 /user/balance；往第三方/本地网关上打，
                // 只会得到一句「connection refused / 404」，用户还以为是账号坏了。
                isDeepseekHost(baseUrl) -> keyBalance(baseUrl, apiKey)
                else -> JSONObject().put("ok", false).put("code", "THIRD_PARTY").put(
                    "error",
                    "当前模型端点（${hostOf(baseUrl)}）不是 DeepSeek 官方，不提供余额查询；余额以平台为准",
                )
            }
            emit("onBalance", requestId, result.toString())
        }.apply { isDaemon = true }.start()
    }

    private fun isDeepseekHost(url: String): Boolean =
        hostOf(url).endsWith("deepseek.com")

    private fun hostOf(url: String): String = try {
        java.net.URI(url.trim().ifBlank { "https://api.deepseek.com" }).host.orEmpty()
    } catch (_: Throwable) {
        url.removePrefix("https://").removePrefix("http://").substringBefore('/').substringBefore(':')
    }

    /** 平台钱包：账号登录态查余额（与桌面 account-platform 同一条协议） */
    private fun accountBalance(): JSONObject {
        val token = auth.token().orEmpty()
        if (token.isBlank()) {
            return JSONObject().put("ok", false).put("code", "NOT_SIGNED_IN")
                .put("error", "未登录且没有 API Key，无法查询余额")
        }
        return try {
            val conn = (java.net.URL("$PLATFORM/api/v0/users/get_user_summary").openConnection()
                as java.net.HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 12_000
                readTimeout = 20_000
                // GET 不带请求体：doOutput 保持 false，否则 HttpURLConnection 会自己改成 POST
                doOutput = false
                setRequestProperty("Accept", "application/json")
                setRequestProperty("x-dsh-auth-token", token)
                setRequestProperty("x-client-bundle-id", "")
                setRequestProperty("x-client-platform", "web")
                setRequestProperty("x-client-version", "0.2.1-rc.2")
                setRequestProperty("x-client-locale", "zh_CN")
                setRequestProperty(
                    "x-client-timezone-offset",
                    (java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 1000).toString(),
                )
            }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            conn.disconnect()

            if (code == 401) {
                return JSONObject().put("ok", false).put("code", "HTTP_401").put("error", "登录状态已失效，请重新登录")
            }
            if (code == 405) {
                // 只可能是路由/方法不匹配，不是登录态问题：把方法写进提示，省得来回猜
                return JSONObject().put("ok", false).put("code", "HTTP_405")
                    .put("error", "平台余额接口不接受该请求方法（GET /api/v0/users/get_user_summary）")
            }
            if (code !in 200..299) {
                return JSONObject().put("ok", false).put("code", "HTTP_$code")
                    .put("error", "平台余额接口返回 HTTP $code${if (body.isNotBlank()) "（${body.take(120)}）" else ""}")
            }
            val root = runCatching { JSONObject(body) }.getOrNull()
                ?: return JSONObject().put("ok", false).put("code", "BAD_JSON").put("error", "余额响应无法解析")
            // 平台把「没带 token / token 过期」也放在 HTTP 200 的 body 里：
            //   40002 Missing Token，40003 token 无效。这两种都要按「重新登录」处理，
            //   否则用户只会看到一句「平台拒绝查询（code=40002）」猜不出下一步。
            when (root.optInt("code", -1)) {
                40002, 40003 -> return JSONObject().put("ok", false).put("code", "HTTP_401")
                    .put("error", "登录状态已失效，请重新登录")
            }
            if (root.optInt("code", -1) != 0) {
                val msg = root.optString("msg").take(80)
                return JSONObject().put("ok", false).put("code", "PLATFORM_${root.optInt("code")}")
                    .put("error", "平台拒绝查询（code=${root.optInt("code")}${if (msg.isNotBlank()) " · $msg" else ""}）")
            }
            val data = root.optJSONObject("data")
            if (data != null && data.has("biz_code") && data.optInt("biz_code") != 0) {
                return JSONObject().put("ok", false).put("code", "BIZ_${data.optInt("biz_code")}")
                    .put("error", "平台业务错误（biz_code=${data.optInt("biz_code")}）")
            }
            val biz = data?.optJSONObject("biz_data") ?: data ?: root
            aggregateWallets(biz)
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("code", "TRANSPORT").put("error", t.message ?: "查询失败")
        }
    }

    /** 充值钱包 + 赠送钱包按币种合并成一行 */
    private fun aggregateWallets(biz: JSONObject): JSONObject {
        val totals = LinkedHashMap<String, DoubleArray>()   // currency -> [recharge, bonus]
        fun collect(name: String, index: Int) {
            val arr = biz.optJSONArray(name) ?: return
            for (i in 0 until arr.length()) {
                val w = arr.optJSONObject(i) ?: continue
                val currency = w.optString("currency", "CNY")
                val amount = w.optString("balance", "0").toDoubleOrNull() ?: 0.0
                val slot = totals.getOrPut(currency) { DoubleArray(2) }
                slot[index] += amount
            }
        }
        collect("normal_wallets", 0)
        collect("bonus_wallets", 1)
        if (totals.isEmpty()) {
            return JSONObject().put("ok", false).put("code", "NO_WALLET")
                .put("error", "账号没有钱包记录（可能是未充值的新账号）")
        }
        val balances = org.json.JSONArray()
        var any = 0.0
        totals.forEach { (currency, parts) ->
            val total = parts[0] + parts[1]
            any += total
            balances.put(
                JSONObject()
                    .put("currency", currency)
                    .put("total", String.format(java.util.Locale.US, "%.2f", total))
                    .put("granted", String.format(java.util.Locale.US, "%.2f", parts[1]))
                    .put("toppedUp", String.format(java.util.Locale.US, "%.2f", parts[0])),
            )
        }
        return JSONObject().put("ok", true).put("available", any > 0).put("balances", balances)
    }

    /** API Key：官方 /user/balance（Bearer） */
    private fun keyBalance(baseUrl: String, apiKey: String): JSONObject = try {
        val base = baseUrl.trim().trimEnd('/').ifBlank { "https://api.deepseek.com" }
        val root = base.removeSuffix("/anthropic").removeSuffix("/v1")
        val conn = (java.net.URL("$root/user/balance").openConnection() as java.net.HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 12_000
            readTimeout = 20_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "Bearer ${apiKey.trim()}")
        }
        val code = conn.responseCode
        val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.use { it.readText() }.orEmpty()
        conn.disconnect()
        if (code !in 200..299) {
            JSONObject().put("ok", false).put("code", "HTTP_$code")
                .put("error", if (code == 401) "API Key 无效或已过期" else "HTTP $code")
        } else {
            val obj = runCatching { JSONObject(body) }.getOrNull()
            val infos = obj?.optJSONArray("balance_infos")
            if (infos == null) {
                JSONObject().put("ok", false).put("code", "NO_BALANCE_FIELD")
                    .put("error", "该端点没有返回余额（不是 DeepSeek 官方接口）")
            } else {
                val arr = org.json.JSONArray()
                for (i in 0 until infos.length()) {
                    val b = infos.optJSONObject(i) ?: continue
                    arr.put(
                        JSONObject()
                            .put("currency", b.optString("currency", "CNY"))
                            .put("total", b.optString("total_balance", "0"))
                            .put("granted", b.optString("granted_balance", "0"))
                            .put("toppedUp", b.optString("topped_up_balance", "0")),
                    )
                }
                JSONObject().put("ok", true)
                    .put("available", obj?.optBoolean("is_available", true) ?: true)
                    .put("balances", arr)
            }
        }
    } catch (t: Throwable) {
        JSONObject().put("ok", false).put("code", "TRANSPORT").put("error", t.message ?: "查询失败")
    }

    /**
     * 通用 HTTP（给宿主机 RPC 用）。WebView 直连会撞 CORS，这里走原生。
     * 结果通过 window.DSHHost.onHttp(id, {ok,status,body,error}) 回传。
     */
    @JavascriptInterface
    fun httpJson(id: String, method: String, url: String, body: String) {
        Thread {
            val result = JSONObject()
            var conn: java.net.HttpURLConnection? = null
            try {
                conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = method.ifBlank { "GET" }
                    connectTimeout = 20000
                    readTimeout = 60000
                    setRequestProperty("Accept", "application/json")
                }
                if (body.isNotBlank()) {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                result.put("ok", code in 200..299)
                result.put("status", code)
                result.put("body", stream?.bufferedReader()?.use { it.readText() } ?: "")
            } catch (t: Throwable) {
                result.put("ok", false)
                result.put("status", 0)
                result.put("body", "")
                result.put("error", t.message ?: "网络错误")
            } finally {
                runCatching { conn?.disconnect() }
            }
            emit("onHttp", id, result.toString())
        }.start()
    }

    /** 正在进行的流式请求，用于用户点「停止」时中断 */


    /** 原生 HTTP POST 代理：绕过 WebView 的 CORS 限制（联网搜索等外部接口用） */
    @JavascriptInterface
    fun httpPostJson(url: String, authKey: String, bodyJson: String): String {
        val conn = try {
            (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("content-type", "application/json")
                if (authKey.isNotBlank()) setRequestProperty("authorization", "Bearer $authKey")
            }
        } catch (t: Throwable) {
            return """{"__status":-1,"__error":${JSONObject.quote(t.message ?: "invalid url")}}"""
        }
        return try {
            conn.outputStream.use { it.write(bodyJson.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            """{"__status":$code,"__body":${JSONObject.quote(text)}}"""
        } catch (t: Throwable) {
            """{"__status":-1,"__error":${JSONObject.quote(t.message ?: "network error")}}"""
        } finally {
            conn.disconnect()
        }
    }
}
