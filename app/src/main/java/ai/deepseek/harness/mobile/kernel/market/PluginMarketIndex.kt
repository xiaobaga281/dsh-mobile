package ai.deepseek.harness.mobile.kernel.market

import org.json.JSONArray
import org.json.JSONObject

/**
 * 插件市场索引（format 1）的解析、校验与检索 —— 逐条对齐桌面
 * `packages/util/plugin-market-index`（对应 Agent Note `plugin-market-index-format`）。
 *
 * 为什么先做纯函数：协议的核心是**校验规则**（哪条字段缺失该拒、拒的时候报哪个 JSON 路径），
 * 而这部分不碰网络也不碰 Android，完全可以单测。手机端此前这里是
 * `marketUrl` 配置了就直接 `throw "暂未实现"` —— 那不是能力缺失，是**没有实现却装作有入口**。
 *
 * 与桌面的两处**有意偏差**（平台限制，不是漏做）：
 *   - `maxBytes` 默认 16MB（桌面 128MB）。安卓应用堆上限通常 192~512MB，128MB 的响应体
 *     在解析成 JSONObject 时会翻倍占内存，直接 OOM。超限按「索引过大」拒，不静默截断。
 *   - 不实现 `entry(url, name)` 的 Remote 形态，用 `list_versions` 覆盖同一查询。
 */
object PluginMarketIndex {

    /** 本实现只认 format 1；别的数字一律拒绝（宁可报错，也不猜字段含义）。 */
    const val FORMAT = 1

    class MarketIndexError(val path: String, val reason: String) :
        IllegalArgumentException("$path: $reason") {
        fun toJson(): JSONObject = JSONObject()
            .put("ok", false)
            .put("code", "MARKET_INDEX_INVALID")
            .put("path", path)
            .put("error", reason)
    }

    /** 校验通过的索引。原始 JSON 保留一份，供 `list_versions` 直接取用。 */
    class Parsed(
        val url: String,
        val title: String,
        val description: String,
        val plugins: JSONArray,
    ) {
        val fetchedAt: Long = System.currentTimeMillis()
    }

    /**
     * `LocalizedText` 在协议里是 `string | { en: string, [locale]: string }`。
     *
     * 中文环境优先 `zh`，其次 `en`，最后取任意一个非空值 —— 直接把对象 `toString()` 会把
     * `{"en":"…"}` 原样喂给模型，那是最常见的一种「字段看起来有值、实际不可读」。
     */
    fun text(v: Any?): String {
        if (v == null || v == JSONObject.NULL) return ""
        if (v is String) return v
        if (v is JSONObject) {
            for (k in listOf("zh", "zh-CN", "en")) {
                val s = v.optString(k)
                if (s.isNotBlank()) return s
            }
            // 兜底：取第一个非空的字符串值
            val keys = v.keys()
            while (keys.hasNext()) {
                val s = v.optString(keys.next())
                if (s.isNotBlank()) return s
            }
        }
        return ""
    }

    /**
     * 把一个 `LocalizedText` 的**所有**语言值拼起来（检索用）。
     *
     * 为什么不能复用 [text]：展示要的是「一种语言」，检索要的是「每种语言都算命中」。
     * 用 `text()` 去检索，中文环境下 `title: {en:"Hello", zh:"你好"}` 只能搜到「你好」，
     * 搜 "hello" 会 0 结果 —— 这正是本文件写完第一次跑测试就抓到的问题。
     */
    fun textAll(v: Any?): String {
        if (v == null || v == JSONObject.NULL) return ""
        if (v is String) return v
        if (v is JSONObject) {
            val sb = StringBuilder()
            val keys = v.keys()
            while (keys.hasNext()) {
                val s = v.optString(keys.next())
                if (s.isNotBlank()) sb.append(s).append(' ')
            }
            return sb.toString()
        }
        return ""
    }

    /**
     * 解析并校验一份索引文档。
     *
     * 校验顺序与桌面一致：先 `format`，再顶层 `title`，再逐个 plugin 的 `name` / `versions`，
     * 最后每个 version 的 `version` / `source`。**第一个**违规就以它的 JSON 路径抛出 ——
     * 一次只报一条是故意的：报告全部违规会诱使生成器「照单全改」，而格式错误往往同源。
     */
    fun parse(raw: String, indexUrl: String): Parsed {
        val root = try {
            JSONObject(raw)
        } catch (t: Throwable) {
            throw MarketIndexError("(root)", "不是合法的 JSON 对象：${t.message ?: "解析失败"}")
        }
        val format = root.optInt("format", -1)
        if (format != FORMAT) {
            throw MarketIndexError("format", "必须是 $FORMAT，实际是 ${if (format < 0) "缺失" else format.toString()}")
        }
        val title = text(root.opt("title"))
        if (title.isBlank()) throw MarketIndexError("title", "缺少标题（字符串或 {en:…}）")
        val plugins = root.optJSONArray("plugins")
            ?: throw MarketIndexError("plugins", "必须是数组")
        for (i in 0 until plugins.length()) {
            val p = plugins.optJSONObject(i)
                ?: throw MarketIndexError("plugins[$i]", "必须是对象")
            val name = p.optString("name")
            if (name.isBlank()) throw MarketIndexError("plugins[$i].name", "缺少包名")
            val versions = p.optJSONArray("versions")
                ?: throw MarketIndexError("plugins[$i].versions", "必须是数组")
            if (versions.length() == 0) {
                throw MarketIndexError("plugins[$i].versions", "至少需要一个版本")
            }
            for (j in 0 until versions.length()) {
                val v = versions.optJSONObject(j)
                    ?: throw MarketIndexError("plugins[$i].versions[$j]", "必须是对象")
                val ver = v.optString("version")
                if (!isSemver(ver)) {
                    throw MarketIndexError("plugins[$i].versions[$j].version", "不是语义化版本：$ver")
                }
                val src = v.optJSONObject("source")
                    ?: throw MarketIndexError("plugins[$i].versions[$j].source", "缺少 source")
                when (val type = src.optString("type")) {
                    "npm" -> Unit // registry 可选
                    "git" -> {
                        val commit = src.optString("commit")
                        if (commit.length != 40 || !commit.all { it in "0123456789abcdef" }) {
                            throw MarketIndexError(
                                "plugins[$i].versions[$j].source.commit",
                                "git 源必须是小写 40 位 commit SHA，实际：$commit",
                            )
                        }
                        if (src.optString("url").isBlank()) {
                            throw MarketIndexError("plugins[$i].versions[$j].source.url", "git 源缺少 url")
                        }
                    }
                    else -> throw MarketIndexError(
                        "plugins[$i].versions[$j].source.type",
                        "只支持 npm / git，实际：$type",
                    )
                }
            }
        }
        return Parsed(indexUrl, title, text(root.opt("description")), plugins)
    }

    /** 语义化版本的最小形状：`x.y.z` 可选预发布/构建后缀；不追求完整 SemVer 优先级比较。 */
    private val SEMVER = Regex("^\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.-]+)?$")

    fun isSemver(s: String): Boolean = SEMVER.matches(s)

    /**
     * 安装某个精确版本时需要的那条 spec —— **照抄桌面 `marketInstallTarget`**。
     *
     * npm → `name@version`；git → `git+<url 补 .git>#<commit>`，带子目录时追加 `&path:/<dir>`。
     * 注意是 `&` 不是 `?`：桌面代码就是拼 `&`，pnpm 认这个形状；改成 `?` 会装不上。
     */
    fun installSpec(name: String, version: JSONObject): String {
        val src = version.optJSONObject("source") ?: return "$name@${version.optString("version")}"
        return when (src.optString("type")) {
            "git" -> {
                val raw = src.optString("url")
                val repo = if (raw.endsWith(".git")) raw else "$raw.git"
                val path = src.optString("path")
                "git+$repo#${src.optString("commit")}" + if (path.isBlank()) "" else "&path:/$path"
            }
            else -> "$name@${version.optString("version")}"
        }
    }

    /** 一个插件在索引里的「默认版本」= versions[0]（桌面已按 SemVer 降序排好，手机端照用）。 */
    fun defaultVersion(plugin: JSONObject): JSONObject? =
        plugin.optJSONArray("versions")?.optJSONObject(0)

    class Page(val total: Int, val nextOffset: Int?, val hits: JSONArray)

    /**
     * 检索一页。
     *
     * 匹配范围对齐桌面 search：包名、标题、描述、keywords 四个字段，大小写不敏感。
     * `query` 为空视为「列全部」（桌面 Discover 的默认视图）。
     */
    fun search(index: Parsed, query: String, limit: Int, offset: Int): Page {
        val q = query.trim().lowercase()
        val matched = JSONArray()
        for (i in 0 until index.plugins.length()) {
            val p = index.plugins.optJSONObject(i) ?: continue
            if (q.isNotEmpty() && !matches(p, q)) continue
            matched.put(p)
        }
        val total = matched.length()
        val start = offset.coerceIn(0, total)
        val end = (start + limit).coerceAtMost(total)
        val hits = JSONArray()
        for (i in start until end) hits.put(matched.getJSONObject(i))
        val next = if (end < total) end else null
        return Page(total, next, hits)
    }

    private fun matches(p: JSONObject, q: String): Boolean {
        if (p.optString("name").lowercase().contains(q)) return true
        // 标题与描述用「全部语言」，理由见 textAll 的注释
        if (textAll(p.opt("title")).lowercase().contains(q)) return true
        if (textAll(p.opt("description")).lowercase().contains(q)) return true
        val meta = p.optJSONObject("metadata")
        val keys = meta?.optJSONArray("keywords")
        if (keys != null) {
            for (i in 0 until keys.length()) {
                if (keys.optString(i).lowercase().contains(q)) return true
            }
        }
        return false
    }
}
