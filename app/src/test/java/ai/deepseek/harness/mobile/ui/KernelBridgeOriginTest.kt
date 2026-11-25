package ai.deepseek.harness.mobile.ui

import ai.deepseek.harness.mobile.bridge.HostUrl
import ai.deepseek.harness.mobile.bridge.KernelBridgeOrigin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WebView 桥 origin 判定的规则钉死（纯函数，无 Android 依赖）。
 *
 * 背景：loadRemote 会载入配对宿主的**任意** http 页面，而 12 个 @JavascriptInterface
 * 以前无条件挂在 WebView 上 —— 远端页面拿到 DSHNative* 就等于拿到设备能力。
 * 这里钉死「哪些 URL 算本地页」，MainActivity 的 attach/detach 全靠它。
 */
class KernelBridgeOriginTest {

    private val local = "https://appassets.androidplatform.net/assets/web/index.html?theme=dark"
    private val localNoQuery = "https://appassets.androidplatform.net/assets/web/index.html"

    /* ---------------- isLocalOrigin ---------------- */

    @Test
    fun local_asset_page_is_local_origin() {
        assertTrue(KernelBridgeOrigin.isLocalOrigin(local))
        assertTrue(KernelBridgeOrigin.isLocalOrigin(localNoQuery))
        // 显式默认端口也算本地
        assertTrue(
            KernelBridgeOrigin.isLocalOrigin(
                "https://appassets.androidplatform.net:443/assets/web/index.html"
            )
        )
        // 大小写不敏感（URL scheme/host 本身不区分大小写）
        assertTrue(
            KernelBridgeOrigin.isLocalOrigin(
                "HTTPS://APPASSETS.ANDROIDPLATFORM.NET/assets/web/index.html"
            )
        )
    }

    @Test
    fun everything_else_is_not_local_origin() {
        // 远端宿主机页面（http 常见于局域网）
        assertFalse(KernelBridgeOrigin.isLocalOrigin("http://192.168.1.5:3080/"))
        assertFalse(KernelBridgeOrigin.isLocalOrigin("https://example.com/assets/web/index.html"))
        // 本地页必须是 https：http 的 appassets 不是 assetLoader 提供的那个 origin
        assertFalse(KernelBridgeOrigin.isLocalOrigin("http://appassets.androidplatform.net/assets/web/index.html"))
        // 非默认端口不能当成同一个 origin
        assertFalse(KernelBridgeOrigin.isLocalOrigin("https://appassets.androidplatform.net:8443/assets/web/index.html"))
        // 域名后缀伪装：evil.com 结尾的相似域名
        assertFalse(
            KernelBridgeOrigin.isLocalOrigin(
                "https://appassets.androidplatform.net.evil.com/assets/web/index.html"
            )
        )
        // userinfo 伪装：真实 host 是 evil.com
        assertFalse(
            KernelBridgeOrigin.isLocalOrigin(
                "https://appassets.androidplatform.net@evil.com/assets/web/index.html"
            )
        )
        // 查询参数里塞本地 URL 不算
        assertFalse(
            KernelBridgeOrigin.isLocalOrigin(
                "https://evil.com/?next=https://appassets.androidplatform.net/assets/web/index.html"
            )
        )
        // 其它 scheme 全部拒绝（file:/javascript:/content:/data:）
        assertFalse(KernelBridgeOrigin.isLocalOrigin("file:///android_asset/web/index.html"))
        assertFalse(KernelBridgeOrigin.isLocalOrigin("javascript:alert(1)"))
        assertFalse(KernelBridgeOrigin.isLocalOrigin("content://com.example/x"))
        assertFalse(KernelBridgeOrigin.isLocalOrigin("data:text/html,<script>1</script>"))
        assertFalse(KernelBridgeOrigin.isLocalOrigin(null))
        assertFalse(KernelBridgeOrigin.isLocalOrigin(""))
        assertFalse(KernelBridgeOrigin.isLocalOrigin("   "))
    }

    /* ---------------- isBridgePage ---------------- */

    @Test
    fun only_assets_path_counts_as_bridge_page() {
        assertTrue(KernelBridgeOrigin.isBridgePage(local))
        assertTrue(KernelBridgeOrigin.isBridgePage("https://appassets.androidplatform.net/assets/web/x.js"))
        // 同一个域名的其它路径（assetLoader 没注册）不给桥
        assertFalse(KernelBridgeOrigin.isBridgePage("https://appassets.androidplatform.net/other/page.html"))
        assertFalse(KernelBridgeOrigin.isBridgePage("https://appassets.androidplatform.net/assets"))
        assertFalse(KernelBridgeOrigin.isBridgePage("https://example.com/assets/web/index.html"))
    }

    /* ---------------- isHttpUrl ---------------- */

    @Test
    fun remote_host_urls_must_be_http_or_https() {
        assertTrue(KernelBridgeOrigin.isHttpUrl("http://192.168.1.5:3080"))
        assertTrue(KernelBridgeOrigin.isHttpUrl("https://host.example/app"))
        assertTrue(KernelBridgeOrigin.isHttpUrl("HTTPS://HOST.EXAMPLE"))
        assertFalse(KernelBridgeOrigin.isHttpUrl("file:///sdcard/x.html"))
        assertFalse(KernelBridgeOrigin.isHttpUrl("javascript:alert(1)"))
        assertFalse(KernelBridgeOrigin.isHttpUrl("content://x/y"))
        assertFalse(KernelBridgeOrigin.isHttpUrl("http://"))
        assertFalse(KernelBridgeOrigin.isHttpUrl("http://user:pw@host.example/"))
        assertFalse(KernelBridgeOrigin.isHttpUrl("http://host example/"))
        assertFalse(KernelBridgeOrigin.isHttpUrl(null))
    }

    /* ---------------- sameOrigin（宿主导航的精确比对） ---------------- */

    @Test
    fun same_origin_requires_scheme_host_port_to_match_exactly() {
        val host = "http://192.168.1.5:3080"
        assertTrue(KernelBridgeOrigin.sameOrigin(host, "http://192.168.1.5:3080/chat?x=1"))
        assertTrue(KernelBridgeOrigin.sameOrigin(host, "http://192.168.1.5:3080"))
        // 默认端口折叠
        assertTrue(KernelBridgeOrigin.sameOrigin("https://h.example", "https://h.example:443/x"))
        assertTrue(KernelBridgeOrigin.sameOrigin("http://h.example", "http://h.example:80/x"))
        // 端口/协议/域名后缀不同都不算同一 origin
        assertFalse(KernelBridgeOrigin.sameOrigin(host, "http://192.168.1.5:3081/"))
        assertFalse(KernelBridgeOrigin.sameOrigin(host, "https://192.168.1.5:3080/"))
        assertFalse(KernelBridgeOrigin.sameOrigin(host, "http://192.168.1.5.evil.com:3080/"))
        assertFalse(KernelBridgeOrigin.sameOrigin(host, "http://192.168.1.5:3080@evil.com/"))
        assertFalse(KernelBridgeOrigin.sameOrigin(host, null))
        assertFalse(KernelBridgeOrigin.sameOrigin(null, host))
    }

    @Test
    fun host_of_is_lowercase_and_portless() {
        assertEquals("appassets.androidplatform.net", KernelBridgeOrigin.hostOf(local))
        assertEquals("host.example", KernelBridgeOrigin.hostOf("https://HOST.example:8443/x"))
        assertNull(KernelBridgeOrigin.hostOf("not a url"))
    }

    /* ---------------- HostUrl.normalize ---------------- */

    @Test
    fun host_url_normalizes_scheme_and_host() {
        assertEquals("http://192.168.1.5:3080", HostUrl.normalize(" http://192.168.1.5:3080/ "))
        assertEquals("https://host.example/app", HostUrl.normalize("HTTPS://Host.Example/app"))
        assertEquals("https://host.example/app?x=1", HostUrl.normalize("https://host.example/app?x=1"))
        // 默认端口规范化成不带端口（同样可达，外观一致）
        assertEquals("https://host.example/app", HostUrl.normalize("https://host.example:443/app"))
    }

    @Test
    fun host_url_rejects_unsafe_forms() {
        assertNull(HostUrl.normalize("file:///data/local/tmp/host.html"))
        assertNull(HostUrl.normalize("javascript:alert(1)"))
        assertNull(HostUrl.normalize("http://"))
        assertNull(HostUrl.normalize("https://user:pw@bank.example/"))
        assertNull(HostUrl.normalize("https://host.example:99999/"))
        assertNull(HostUrl.normalize(""))
        assertNull(HostUrl.normalize(null))
    }
}
