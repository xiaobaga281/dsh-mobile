package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 联网检索 —— 对应桌面 Harness 的 `web` 工具族在手机端的等价能力。
 *
 * 桌面版走浏览器/内置搜索后端；手机端没有浏览器自动化，改为对接用户配置的
 * 搜索 API（Bing / Tavily / 自建网关都兼容），并把三种常见返回结构归一化。
 * 结果只回标题/摘要/链接，正文由模型决定要不要再抓。
 */
object WebSearch {

    /** 归一化后的一条搜索结果（桌面 web_search 的 sources 单元） */
    data class Hit(val title: String, val url: String, val snippet: String)

    /**
     * 单次查询，返回结构化结果。
     * 桌面把「1–4 个 query 的结果合并」交给 provider；手机端在 [searchMany] 里自己合并，
     * 因此这里只负责一次请求 + 三种返回结构的归一化。
     * 失败抛异常，由调用方决定是整体失败还是部分降级 —— 绝不返回「看起来像结果」的错误文本。
     */
    fun hits(url: String, key: String, query: String, max: Int): List<Hit> {
        val body = JSONObject().apply {
            put("query", query)
            put("max_results", max)
            put("count", max)
            if (key.isNotBlank()) put("api_key", key)
        }
        ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed(url)
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 12_000
            readTimeout = 25_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            if (key.isNotBlank()) setRequestProperty("Authorization", "Bearer $key")
        }
        try {
            c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            if (code !in 200..299) {
                val err = c.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                throw IllegalStateException("搜索接口 HTTP $code ${err.take(200)}")
            }
            val raw = c.inputStream.bufferedReader().use { it.readText() }
            val root = runCatching { JSONObject(raw) }.getOrNull()
                ?: throw IllegalStateException("搜索接口返回的不是 JSON：${raw.take(120)}")
            val items = when {
                root.optJSONArray("results") != null -> root.optJSONArray("results")
                root.optJSONObject("webPages")?.optJSONArray("value") != null ->
                    root.optJSONObject("webPages")!!.optJSONArray("value")
                root.optJSONArray("data") != null -> root.optJSONArray("data")
                root.optJSONArray("items") != null -> root.optJSONArray("items")
                else -> JSONArray()
            } ?: JSONArray()
            val out = ArrayList<Hit>()
            for (i in 0 until minOf(items.length(), max)) {
                val it = items.optJSONObject(i) ?: continue
                val title = it.optString("title").ifBlank { it.optString("name") }
                val link = it.optString("url").ifBlank { it.optString("link") }
                val snippet = it.optString("snippet").ifBlank {
                    it.optString("content").ifBlank { it.optString("description") }
                }
                if (title.isBlank() && link.isBlank()) continue
                out.add(Hit(title, link, snippet))
            }
            return out
        } finally {
            runCatching { c.disconnect() }
        }
    }

    /**
     * 多查询合并（桌面语义：1–4 个 query 的结果合并去重）。
     * 以前手机端把多个词用「；」拼成一句话再发，等于只搜了一个长句 —— 命中率明显下降。
     *
     * @return 合并后的结果 + 失败说明（部分查询失败时仍返回其余结果）
     */
    fun searchMany(url: String, key: String, queries: List<String>, max: Int): Pair<List<Hit>, String?> {
        val merged = LinkedHashMap<String, Hit>()
        val failures = mutableListOf<String>()
        queries.map { it.trim() }.filter { it.isNotBlank() }.distinct().take(4).forEach { q ->
            runCatching { hits(url, key, q, max) }
                .onSuccess { list -> list.forEach { h -> merged.putIfAbsent(h.url.ifBlank { "${h.title}#${merged.size}" }, h) } }
                .onFailure { e -> failures.add("$q（${e.message?.take(80)}）") }
        }
        val note = when {
            failures.isEmpty() -> null
            merged.isEmpty() -> "全部查询失败：" + failures.joinToString("；")
            else -> "部分查询失败（已用其余结果）：" + failures.joinToString("；")
        }
        return merged.values.toList() to note
    }

    /** 兼容旧调用：纯文本输出 */
    fun search(url: String, key: String, query: String, max: Int): String {
        val hits = hits(url, key, query, max)
        if (hits.isEmpty()) return "没有搜到结果。"
        return hits.mapIndexed { i, h ->
            buildString {
                append("${i + 1}. ${h.title}")
                if (h.url.isNotBlank()) append("（${h.url}）")
                if (h.snippet.isNotBlank()) append('\n').append(h.snippet.take(400))
            }
        }.joinToString("\n")
    }
}
