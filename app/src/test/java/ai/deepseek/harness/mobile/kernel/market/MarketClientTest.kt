package ai.deepseek.harness.mobile.kernel.market

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 索引 URL 的准入校验。
 *
 * 这段决定「插件市场能不能被当成任意地址抓取通道」。桌面同样只接受已配置的地址，
 * 但桌面在服务层做（`search` 只认 configured URL），手机端没有那层服务，只能落在工具里
 * ——所以这里的判据必须单独测，否则「顺手支持一下自定义 URL」会把 SSRF 口子打开。
 *
 * 只测纯校验，不发任何请求（`load` 需要网络，这里不碰）。
 */
class MarketClientTest {

    private val c = MarketClient()

    @Test
    fun `合规的 http 与 https 通过`() {
        assertNull(c.validateUrl("https://example.com/market/index.json"))
        assertNull(c.validateUrl("http://example.com/index.json"))
        assertNull(c.validateUrl("  https://example.com/a/b  "))
    }

    @Test
    fun `非 http 协议被拒绝`() {
        // file:// 能读本机文件，ftp:// 能打内网服务 —— 都必须挡
        assertNotNull(c.validateUrl("file:///data/local/tmp/x.json"))
        assertNotNull(c.validateUrl("ftp://example.com/x.json"))
        assertNotNull(c.validateUrl("javascript:alert(1)"))
        assertNotNull(c.validateUrl("data:application/json,{}"))
    }

    @Test
    fun `带凭据的 URL 被拒绝`() {
        // 索引 URL 会原样出现在工具返回里；带 user:pass@ 等于把口令写进对话记录
        val why = c.validateUrl("https://user:secret@example.com/index.json")
        assertNotNull(why)
        assertEquals("URL 不能带凭据（user:pass@）", why)
    }

    @Test
    fun `带 fragment 的 URL 被拒绝`() {
        assertNotNull(c.validateUrl("https://example.com/index.json#section"))
    }

    @Test
    fun `缺少主机名被拒绝`() {
        assertNotNull(c.validateUrl("https:///index.json"))
        assertNotNull(c.validateUrl("http://"))
    }

    @Test
    fun `空串与纯空白被拒绝`() {
        assertNotNull(c.validateUrl(""))
        assertNotNull(c.validateUrl("   "))
    }
}
