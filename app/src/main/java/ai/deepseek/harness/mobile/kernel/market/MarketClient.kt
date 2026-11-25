package ai.deepseek.harness.mobile.kernel.market

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI

/**
 * 拉取并缓存插件市场索引。
 *
 * 对齐桌面 `boot/plugin-market`：URL 先规范化再校验、只接受**已配置**的地址、
 * 单个索引有超时与体积上限、成功后按 TTL 缓存。
 *
 * 三处**有意偏差**（平台限制）：
 *   - `maxBytes` 默认 16MB（桌面 128MB）：安卓应用堆通常 192~512MB，128MB 的响应体解析成
 *     JSONObject 会翻倍占内存，直接 OOM。超限按「索引过大」明确拒绝，不静默截断。
 *   - TTL 与超时沿用桌面默认（600s / 15s），没有自己发明。
 *   - 不支持 `setIndexes` 写回（手机端没有 Settings/profile 那套持久层）——
 *     配置来自插件配置块，由用户在设置里改。**不假装能写**。
 */
class MarketClient(
    private val timeoutMs: Int = 15_000,
    private val maxBytes: Int = 16 * 1024 * 1024,
    private val cacheTtlMs: Long = 600_000L,
) {

    /** 一次读取的结果：成功带 index，失败带 error（两者互斥）。 */
    class Entry(
        val url: String,
        val index: PluginMarketIndex.Parsed?,
        val error: String?,
        val fetchedAt: Long,
    ) {
        fun toJson(configOk: Boolean = true): org.json.JSONObject = org.json.JSONObject().apply {
            put("url", url)
            put("configured_ok", configOk)
            if (index != null) {
                put("title", index.title)
                put("description", index.description)
                put("plugins", index.plugins.length())
                put("fetched_at", fetchedAt)
            }
            if (error != null) put("error", error)
        }
    }

    private val cache = HashMap<String, Entry>()

    /**
     * 校验并规范化一个索引 URL。
     *
     * 规则照桌面：必须是 `http:`/`https:`、**不带凭据**（`user:pass@`）与 fragment、
     * 且必须能解析成绝对地址。返回 null 表示可用，否则返回拒绝理由。
     *
     * 为什么必须挡住凭据：索引 URL 会原样出现在工具返回里，带凭据等于把口令写进对话记录。
     */
    fun validateUrl(raw: String): String? {
        val s = raw.trim()
        if (s.isEmpty()) return "空 URL"
        val uri = try {
            URI(s)
        } catch (t: Throwable) {
            return "不是合法 URL：${t.message ?: "解析失败"}"
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return "只支持 http/https，实际：${uri.scheme ?: "缺失"}"
        if (!uri.userInfo.isNullOrBlank()) return "URL 不能带凭据（user:pass@）"
        if (!uri.fragment.isNullOrBlank()) return "URL 不能带 fragment（#…）"
        if (uri.host.isNullOrBlank()) return "URL 缺少主机名"
        return null
    }

    /** 读一个索引（命中缓存且未过期则直接用）。 */
    fun load(url: String): Entry {
        val now = System.currentTimeMillis()
        cache[url]?.let { hit ->
            val fresh = hit.index != null && now - hit.fetchedAt < cacheTtlMs
            if (fresh) return hit
        }
        val entry = fetch(url)
        cache[url] = entry
        return entry
    }

    /** 清掉缓存（配置变更时用）。 */
    fun invalidate() = cache.clear()

    private fun fetch(url: String): Entry {
        validateUrl(url)?.let { return Entry(url, null, it, System.currentTimeMillis()) }
        return try {
            val text = get(url)
            val parsed = PluginMarketIndex.parse(text, url)
            Entry(url, parsed, null, System.currentTimeMillis())
        } catch (e: PluginMarketIndex.MarketIndexError) {
            Entry(url, null, "${e.path}: ${e.reason}", System.currentTimeMillis())
        } catch (t: Throwable) {
            Entry(url, null, t.message ?: "拉取失败", System.currentTimeMillis())
        }
    }

    private fun get(url: String): String {
        val conn = (URI(url).toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = true
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "dsh-mobile/plugin-market")
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) {
                // 4xx/5xx 也把错误流读出来：多数索引服务会把原因放在 body 里
                val detail = runCatching {
                    conn.errorStream?.bufferedReader()?.use { it.readText().take(400) }
                }.getOrNull().orEmpty()
                throw IllegalStateException("HTTP $code" + if (detail.isBlank()) "" else "：$detail")
            }
            // 先看 Content-Length，再限长读：直接 readBytes() 等于没限
            val declared = conn.contentLengthLong
            if (declared > maxBytes) {
                throw IllegalStateException("索引过大（${declared / 1024 / 1024}MB），上限 ${maxBytes / 1024 / 1024}MB")
            }
            val out = ByteArrayOutputStream(64 * 1024)
            val buf = ByteArray(64 * 1024)
            var total = 0
            conn.inputStream.use { input ->
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    total += n
                    if (total > maxBytes) {
                        throw IllegalStateException("索引过大（超过 ${maxBytes / 1024 / 1024}MB），已停止读取")
                    }
                    out.write(buf, 0, n)
                }
            }
            return out.toString("UTF-8")
        } finally {
            runCatching { conn.disconnect() }
        }
    }
}
