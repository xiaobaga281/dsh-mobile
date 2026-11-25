package ai.deepseek.harness.mobile.kernel.market

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 市场索引 format 1 的解析与检索验收。
 *
 * 这条线上「错了会怎样」有两种，都很隐蔽：
 *   - **校验太松**：坏索引被当成好的，模型照着一个不存在的版本说「可以装」；
 *   - **校验太紧**：合法索引被拒，功能看起来「没实现」——手机端此前正是
 *     `marketUrl` 一配置就 `throw 暂未实现`，等于永远走不到这一步。
 * 每个用例对应桌面 `util/plugin-market-index` 的一条规则，字段名与路径都照抄。
 */
class PluginMarketIndexTest {

    private fun index(plugins: String) = """
        {"format":1,"title":"DSH 插件市场","description":"官方索引","plugins":[$plugins]}
    """.trimIndent()

    private fun plugin(
        name: String = "@dsh/hello",
        version: String = "1.2.3",
        source: String = """{"type":"npm"}""",
        extra: String = "",
    ) = """{"name":"$name","title":{"en":"Hello","zh":"你好"},"versions":[{"version":"$version","source":$source}]$extra}"""

    // ---------- 校验 ----------

    @Test
    fun `format 必须是 1`() {
        val e = runCatching { PluginMarketIndex.parse("""{"format":2,"title":"x","plugins":[]}""", "u") }.exceptionOrNull()
        assertTrue("应当拒绝 format 2", e is PluginMarketIndex.MarketIndexError)
        assertEquals("format", (e as PluginMarketIndex.MarketIndexError).path)
    }

    @Test
    fun `缺少 title 被拒绝并指出路径`() {
        val e = runCatching { PluginMarketIndex.parse("""{"format":1,"plugins":[]}""", "u") }.exceptionOrNull()
        assertEquals("title", (e as PluginMarketIndex.MarketIndexError).path)
    }

    @Test
    fun `插件缺 name 时路径精确到该插件`() {
        val bad = """{"format":1,"title":"t","plugins":[{"versions":[{"version":"1.0.0","source":{"type":"npm"}}]}]}"""
        val e = runCatching { PluginMarketIndex.parse(bad, "u") }.exceptionOrNull()
        assertEquals("plugins[0].name", (e as PluginMarketIndex.MarketIndexError).path)
    }

    @Test
    fun `空 versions 被拒绝`() {
        // 一个没有版本可装的插件，对调用方毫无用处；放行只会让模型报「有这个插件但装不了」
        val bad = """{"format":1,"title":"t","plugins":[{"name":"a","versions":[]}]}"""
        val e = runCatching { PluginMarketIndex.parse(bad, "u") }.exceptionOrNull()
        assertEquals("plugins[0].versions", (e as PluginMarketIndex.MarketIndexError).path)
    }

    @Test
    fun `非语义化版本被拒绝`() {
        val bad = """{"format":1,"title":"t","plugins":[{"name":"a","versions":[{"version":"v1","source":{"type":"npm"}}]}]}"""
        val e = runCatching { PluginMarketIndex.parse(bad, "u") }.exceptionOrNull()
        assertEquals("plugins[0].versions[0].version", (e as PluginMarketIndex.MarketIndexError).path)
    }

    @Test
    fun `预发布版本是合法的`() {
        // 1.0.0-rc.1 这种必须放行：它正是「装指定预发布版」的常见诉求
        assertTrue(PluginMarketIndex.isSemver("1.0.0-rc.1"))
        assertTrue(PluginMarketIndex.isSemver("2.0.0+build.7"))
        assertNotNull(PluginMarketIndex.parse(index(plugin(version = "1.0.0-rc.1")), "u"))
    }

    @Test
    fun `git 源的 commit 必须是 40 位小写十六进制`() {
        val short = """{"type":"git","url":"https://example.com/repo","commit":"abc123"}"""
        val e = runCatching { PluginMarketIndex.parse(index(plugin(source = short)), "u") }.exceptionOrNull()
        assertEquals("plugins[0].versions[0].source.commit", (e as PluginMarketIndex.MarketIndexError).path)
    }

    @Test
    fun `不支持的 source 类型被拒绝`() {
        val bad = """{"type":"svn","url":"x"}"""
        val e = runCatching { PluginMarketIndex.parse(index(plugin(source = bad)), "u") }.exceptionOrNull()
        assertEquals("plugins[0].versions[0].source.type", (e as PluginMarketIndex.MarketIndexError).path)
    }

    // ---------- LocalizedText ----------

    @Test
    fun `本地化文本优先中文再英文`() {
        assertEquals("你好", PluginMarketIndex.text(JSONObject().put("en", "Hello").put("zh", "你好")))
        assertEquals("Hello", PluginMarketIndex.text(JSONObject().put("en", "Hello")))
        assertEquals("纯字符串", PluginMarketIndex.text("纯字符串"))
        assertEquals("", PluginMarketIndex.text(null))
    }

    @Test
    fun `本地化对象不会被原样 toString`() {
        // 直接把对象 toString 会得到 {"en":"…"}，模型看到的是「有值但不可读」
        val v = PluginMarketIndex.text(JSONObject().put("en", "Only English"))
        assertEquals("Only English", v)
        assertTrue("不能出现 JSON 花括号", !v.contains("{"))
    }

    // ---------- install spec ----------

    @Test
    fun `npm 的安装 spec 是 name@version`() {
        val v = JSONObject("""{"version":"1.2.3","source":{"type":"npm"}}""")
        assertEquals("@dsh/hello@1.2.3", PluginMarketIndex.installSpec("@dsh/hello", v))
    }

    @Test
    fun `git 的安装 spec 沿用桌面的 与 path 语法`() {
        // 桌面 marketInstallTarget 拼的是 `git+<repo>.git#<commit>&path:/<dir>`。
        // 这里必须是 & 不是 ?，也要补 .git —— 照抄，不改「更规范」的写法，否则 pnpm 装不上
        val v = JSONObject(
            """{"version":"1.0.0","source":{"type":"git","url":"https://example.com/repo",
                "commit":"0123456789abcdef0123456789abcdef01234567","path":"packages/hello"}}""".trimIndent(),
        )
        assertEquals(
            "git+https://example.com/repo.git#0123456789abcdef0123456789abcdef01234567&path:/packages/hello",
            PluginMarketIndex.installSpec("@dsh/hello", v),
        )
    }

    @Test
    fun `已经是 git 后缀的 url 不重复追加`() {
        val v = JSONObject(
            """{"version":"1.0.0","source":{"type":"git","url":"https://example.com/repo.git",
                "commit":"0123456789abcdef0123456789abcdef01234567"}}""".trimIndent(),
        )
        assertTrue(PluginMarketIndex.installSpec("a", v).startsWith("git+https://example.com/repo.git#"))
    }

    // ---------- 检索 ----------

    @Test
    fun `空查询列出全部`() {
        val p = PluginMarketIndex.parse(index(plugin("@a/one") + "," + plugin("@a/two")), "u")
        val page = PluginMarketIndex.search(p, "", limit = 10, offset = 0)
        assertEquals(2, page.total)
        assertEquals(2, page.hits.length())
        assertNull(page.nextOffset)
    }

    @Test
    fun `匹配包名标题描述与关键词`() {
        val withKw = """{"name":"@a/kw","metadata":{"keywords":["语音转写"]},"versions":[{"version":"1.0.0","source":{"type":"npm"}}]}"""
        val p = PluginMarketIndex.parse(index(plugin("@a/alpha") + "," + withKw), "u")
        assertEquals(1, PluginMarketIndex.search(p, "alpha", 10, 0).total)
        assertEquals("标题里的 Hello 应当命中", 1, PluginMarketIndex.search(p, "hello", 10, 0).total)
        assertEquals("关键词应当命中", 1, PluginMarketIndex.search(p, "语音", 10, 0).total)
        assertEquals(0, PluginMarketIndex.search(p, "不存在的词", 10, 0).total)
    }

    @Test
    fun `分页给出 total 与 nextOffset`() {
        val many = (1..5).joinToString(",") { plugin("@a/p$it") }
        val p = PluginMarketIndex.parse(index(many), "u")
        val first = PluginMarketIndex.search(p, "", limit = 2, offset = 0)
        assertEquals(5, first.total)
        assertEquals(2, first.hits.length())
        assertEquals(2, first.nextOffset)
        val last = PluginMarketIndex.search(p, "", limit = 2, offset = 4)
        assertEquals(1, last.hits.length())
        assertNull("最后一页没有 nextOffset", last.nextOffset)
    }

    @Test
    fun `offset 越界返回空页而不是抛异常`() {
        val p = PluginMarketIndex.parse(index(plugin()), "u")
        val page = PluginMarketIndex.search(p, "", limit = 10, offset = 99)
        assertEquals(0, page.hits.length())
        assertNull(page.nextOffset)
    }

    @Test
    fun `默认版本取 versions 第一个`() {
        val multi = """{"name":"@a/multi","versions":[
            {"version":"2.0.0","source":{"type":"npm"}},
            {"version":"1.0.0","source":{"type":"npm"}}]}"""
        val p = PluginMarketIndex.parse(index(multi), "u")
        val first = p.plugins.getJSONObject(0)
        assertEquals("2.0.0", PluginMarketIndex.defaultVersion(first)?.optString("version"))
    }

    @Test
    fun `索引里的 plugins 保持原顺序`() {
        val p = PluginMarketIndex.parse(index(plugin("@a/z") + "," + plugin("@a/a")), "u")
        val names = JSONArray().let {
            for (i in 0 until p.plugins.length()) it.put(p.plugins.getJSONObject(i).optString("name"))
            it
        }
        // 不重排：桌面也按索引默认顺序返回，排序交给 UI/调用方
        assertEquals("@a/z", names.getString(0))
        assertEquals("@a/a", names.getString(1))
    }
}
