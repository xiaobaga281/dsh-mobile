package ai.deepseek.harness.mobile.kernel.preview

/**
 * HTML 净化 —— 纯 JVM 可单测（DocPreview 原样搬出，零 Android 依赖）。
 *
 * 安全模型（rc.97 起与前端 sandbox="allow-scripts" 配套，纵深防御）：
 *   - 内联 <script> 与 data:/相对路径脚本 **保留**：Agent 产出的图表/动效/H5
 *     才能在预览里活过来。防线在前端 iframe —— sandbox="allow-scripts" 不给
 *     allow-same-origin（脚本读不到父页 DOM/存储），并且 mountHtmlPreview 会在
 *     预览文档最前面注入 shim，把 addJavascriptInterface 注入到该 frame 的
 *     DSHNative* 全部抹掉 —— sandbox 只隔离同源，挡不住原生注入对象。
 *   - **外链 script（http/https/protocol-relative）删除**：预览不发任何外部请求。
 *   - iframe / object / embed / applet / form / link / meta / base 继续删。
 *   - 外链 img / video / audio 换占位提示。
 *   - javascript: 协议清洗保留；on* 事件属性清洗 **移除**（脚本已放行，删它
 *     无安全增益，只会破坏内联交互）。
 */
object HtmlSanitizer {

    /**
     * 原生生成类预览（docx/pptx/xlsx/pdf/csv/json/zip）的兜底净化。
     *
     * 这些 HTML 由 DocPreview 自己拼，本该每个字段都过 esc()。这里再剥
     * `<script>` 与 on* 事件属性：任何渲染器漏了一处转义，也不会让文件内容
     * 以脚本形式进应用 origin（应用 origin 的桥有内核工具能力）。
     * `.html` 文件预览不走这里 —— 它需要脚本，安全由前端 iframe 的桥隔离负责。
     */
    fun sanitizeGenerated(raw: String): String {
        var s = Regex("<script\\b[\\s\\S]*?</script\\s*>", RegexOption.IGNORE_CASE).replace(raw, "")
        s = Regex("<\\/?script\\b[^>]*>", RegexOption.IGNORE_CASE).replace(s, "")
        // on* 只清标签内部：文本节点里的 "one=1" 这类内容不能误删
        val onAttr = Regex("\\son[a-z]+\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOption.IGNORE_CASE)
        return Regex("<[^>]+>").replace(s) { onAttr.replace(it.value, "") }
    }

    fun sanitize(raw: String): String {
        var s = raw
        // 外链 script → 删整个标签（含成对与自闭合）
        s = Regex("<script\\b[^>]*\\bsrc\\s*=\\s*[\"']\\s*(?:https?:)?//[^\"']*[\"'][^>]*>[\\s\\S]*?</script\\s*>", RegexOption.IGNORE_CASE)
            .replace(s, "")
        s = Regex("<script\\b[^>]*\\bsrc\\s*=\\s*[\"']\\s*(?:https?:)?//[^\"']*[\"'][^>]*/?>", RegexOption.IGNORE_CASE)
            .replace(s, "")
        // iframe / object / embed / applet / form / link / meta / base：成对与自闭合都删
        s = Regex("<(iframe|object|embed|applet|form|link|meta|base)[\\s\\S]*?</\\1\\s*>", RegexOption.IGNORE_CASE)
            .replace(s, "")
        s = Regex("<(iframe|object|embed|applet|form|link|meta|base)\\b[^>]*/?>", RegexOption.IGNORE_CASE)
            .replace(s, "")
        // 外链资源 → 占位（不发起网络请求）
        s = Regex("<img\\b[^>]*src\\s*=\\s*[\"']https?://[^\"']*[\"'][^>]*>", RegexOption.IGNORE_CASE)
            .replace(s, "<span class=\"pv-ext\">［外链图片已屏蔽］</span>")
        s = Regex("<(video|audio|source)\\b[^>]*src\\s*=\\s*[\"']https?://[^\"']*[\"'][^>]*>", RegexOption.IGNORE_CASE)
            .replace(s, "<span class=\"pv-ext\">［外链媒体已屏蔽］</span>")
        // 危险协议
        s = Regex("(href|src)\\s*=\\s*[\"']\\s*javascript:[^\"']*[\"']", RegexOption.IGNORE_CASE)
            .replace(s, "$1=\"#\"")
        s = Regex("(href|src)\\s*=\\s*javascript:[^\\s>]*", RegexOption.IGNORE_CASE)
            .replace(s, "$1=\"#\"")
        return s
    }
}
