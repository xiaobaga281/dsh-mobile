package ai.deepseek.harness.mobile.kernel.preview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** HTML 净化规则钉死：内联脚本保留（配合前端 allow-scripts）、外链资源全禁 */
class HtmlSanitizerTest {

    @Test
    fun inline_script_is_kept() {
        val html = "<div><script>document.body.innerHTML='chart'</script><p>hi</p></div>"
        val out = HtmlSanitizer.sanitize(html)
        assertTrue("内联脚本被误删（图表/动效全废）：$out", out.contains("<script>"))
        assertTrue(out.contains("chart"))
    }

    @Test
    fun external_script_is_removed() {
        val html = "<script src=\"https://cdn.example.com/x.js\"></script><p>hi</p>"
        val out = HtmlSanitizer.sanitize(html)
        assertFalse("外链脚本没删（会发网络请求）：$out", out.contains("cdn.example.com"))
        assertTrue(out.contains("<p>hi</p>"))
    }

    @Test
    fun protocol_relative_script_is_removed() {
        val out = HtmlSanitizer.sanitize("<script src=\"//evil.example.com/x.js\"></script>ok")
        assertFalse(out.contains("evil.example.com"))
    }

    @Test
    fun data_url_script_is_kept() {
        val out = HtmlSanitizer.sanitize("<script src=\"data:text/javascript,alert(1)\"></script>ok")
        assertTrue(out.contains("ok"))
    }

    @Test
    fun iframe_object_link_meta_base_form_are_removed() {
        val html = "<iframe src=\"x\"></iframe><object></object><embed><link rel=\"x\"><meta http-equiv=\"refresh\"><base href=\"/\"><form></form>ok"
        val out = HtmlSanitizer.sanitize(html)
        listOf("iframe", "object", "embed", "link", "meta", "base", "form").forEach {
            assertFalse(" <$it> 没删：$out", out.contains("<$it"))
        }
        assertTrue(out.contains("ok"))
    }

    @Test
    fun external_image_becomes_placeholder() {
        val out = HtmlSanitizer.sanitize("<img src=\"https://a.com/pic.png\">")
        assertTrue("外链图没变占位：$out", out.contains("外链图片已屏蔽"))
    }

    @Test
    fun inline_image_and_style_survive() {
        val html = "<img src=\"data:image/png;base64,AAAA\" style=\"width:100%\"><b>x</b>"
        val out = HtmlSanitizer.sanitize(html)
        assertTrue(out.contains("data:image/png"))
        assertTrue(out.contains("width:100%"))
    }

    @Test
    fun javascript_protocol_is_neutralized() {
        val out = HtmlSanitizer.sanitize("<a href=\"javascript:alert(1)\">点</a>")
        assertFalse(out.contains("javascript:alert"))
        assertTrue(out.contains("href=\"#\""))
    }

    @Test
    fun on_click_attribute_is_kept_now() {
        // rc.97 起脚本已放行（sandbox 兜底），on* 清洗移除：内联交互不再被破坏
        val out = HtmlSanitizer.sanitize("<button onclick=\"go()\">go</button>")
        assertTrue("on* 属性被误删：$out", out.contains("onclick=\"go()\""))
    }

    /* ---------------- sanitizeGenerated：原生生成类预览的第二道闸 ---------------- */

    @Test
    fun generated_preview_strips_scripts_and_event_attributes() {
        val out = HtmlSanitizer.sanitizeGenerated(
            "<div onclick=\"x()\"><script>alert(1)</script><b onmouseover='y()'>ok</b></div>"
        )
        assertFalse("生成类预览里还留着 <script>：$out", out.contains("<script"))
        assertFalse("onclick 没剥掉：$out", out.contains("onclick"))
        assertFalse("onmouseover 没剥掉：$out", out.contains("onmouseover"))
        assertTrue(out.contains("ok"))
    }

    @Test
    fun generated_preview_keeps_normal_attributes() {
        val html = "<p class=\"pv-meta\">Sheet1 · 1 行</p>" +
            "<table class=\"pv-table\"><tr><td style=\"color:#fff\">甲</td></tr></table>"
        assertEquals("正常标记被改动：", html, HtmlSanitizer.sanitizeGenerated(html))
        // 文本节点不是标签，on...= 不能误删
        assertEquals("one=1", HtmlSanitizer.sanitizeGenerated("one=1"))
    }
}
