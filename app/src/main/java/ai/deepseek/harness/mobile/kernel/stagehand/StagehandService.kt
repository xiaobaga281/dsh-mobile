package ai.deepseek.harness.mobile.kernel.stagehand

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 浏览器自动化（stagehand 的安卓端等价物）。
 *
 * 桌面 packages/experimental/browser-use-stagehand-native：模型通过
 * navigate/observe/extract/act/screenshot/tabs 六个工具操作浏览器，
 * 自然语言动作由 LLM 解释成选择器。安卓端：
 *   - 用 WebView 池承担「浏览器」，evaluateJavascript 注入脚本取页面结构
 *     （WebView 未 attach 窗口时 JS 引擎仍照常执行，PtcRuntime 已同路验证）
 *   - observe / extract 返回**真实** DOM 结构（可交互元素、标题、链接、表格、正文）
 *   - act 用启发式把自然语言映射成点击/输入/滚动/等待，并如实回报命中情况
 *   - screenshot 需要 WebView 真实绘制；页面不在可见窗口时如实报告不可用
 */
class StagehandService(private val context: Context) {

    private val main = Handler(Looper.getMainLooper())
    private val pages = ConcurrentHashMap<String, Page>()

    private class Page(val id: String) {
        @Volatile var webview: WebView? = null
        @Volatile var url: String = ""
        @Volatile var title: String = ""
        @Volatile var ready: Boolean = false
        val gate = CountDownLatch(1)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun build(id: String): Page {
        val p = Page(id)
        val latch = CountDownLatch(1)
        main.post {
            val wv = WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = true
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false
                    override fun onPageFinished(view: WebView?, url: String?) {
                        p.ready = true
                        p.url = url.orEmpty()
                        p.title = runCatching { view?.title.orEmpty() }.getOrDefault("")
                    }
                }
            }
            p.webview = wv
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        return p
    }

    private fun page(pageId: String): Page {
        val id = pageId.ifBlank { "default" }
        return pages.getOrPut(id) { build(id) }
    }

    private fun awaitReady(p: Page, timeoutMs: Long) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline && !p.ready) Thread.sleep(150)
    }

    /** 在主线程执行并在 JS 回调里取值（同 PtcRuntime 的桥接模式） */
    private fun eval(p: Page, script: String, timeoutMs: Long = 15_000): String? {
        val latch = CountDownLatch(1)
        val out = arrayOfNulls<String>(1)
        main.post {
            try {
                p.webview?.evaluateJavascript(script) { v -> out[0] = v; latch.countDown() }
                    ?: latch.countDown()
            } catch (_: Throwable) { latch.countDown() }
        }
        if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) return null
        val raw = out[0] ?: return null
        // evaluateJavascript 回传 JSON 字符串字面量；解码一次
        return runCatching { org.json.JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw
    }

    fun navigate(pageId: String, url: String): String {
        if (url.isBlank()) return err("BAD_URL", "url 不能为空")
        val p = page(pageId)
        p.ready = false
        val latch = CountDownLatch(1)
        main.post {
            p.webview?.loadUrl(url)
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        awaitReady(p, 20_000)
        return JSONObject().apply {
            put("ok", true)
            put("pageId", p.id)
            put("url", p.url.ifBlank { url })
            put("title", p.title)
            put("loaded", p.ready)
        }.toString()
    }

    fun observe(pageId: String): String {
        val p = page(pageId)
        val script = """
            (function(){
              // WebView 未 attach 窗口时没有布局盒（rect 全 0）；此时不过滤可见性，
              // 只如实标注 layout=false，避免把真实存在的元素误判为不可见。
              var laid = document.documentElement.getBoundingClientRect().width > 0;
              function vis(el){ if (!laid) return true; var r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; }
              var out = [];
              var els = document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link], [role=textbox]');
              for (var i = 0; i < els.length && out.length < 200; i++) {
                var el = els[i]; if (!vis(el)) continue;
                out.push({
                  tag: el.tagName.toLowerCase(),
                  role: el.getAttribute('role') || '',
                  text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120),
                  name: el.getAttribute('name') || '',
                  id: el.id || '',
                  href: el.getAttribute('href') || ''
                });
              }
              return JSON.stringify({ ok: true, pageId: ${JSONObject.quote(p.id)}, url: location.href,
                title: document.title, count: out.length, layout: laid, elements: out });
            })()
        """.trimIndent()
        val r = eval(p, script)
            ?: return err("PAGE_NOT_READY", "页面还没加载完或已关闭", "先 stagehand_navigate 到一个 URL")
        return r
    }

    fun extract(pageId: String, instruction: String): String {
        val p = page(pageId)
        val want = instruction.lowercase()
        val wantTables = want.contains("表格") || want.contains("table")
        val wantLinks = want.contains("链接") || want.contains("link")
        val script = """
            (function(){
              function txt(el, n){ return (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, n || 2000); }
              var tables = [];
              if (${wantTables}) {
                document.querySelectorAll('table').forEach(function(t, i){
                  var rows = [];
                  t.querySelectorAll('tr').forEach(function(tr){
                    var cells = [];
                    tr.querySelectorAll('th,td').forEach(function(c){ cells.push(txt(c, 200)); });
                    if (cells.length) rows.push(cells);
                  });
                  if (rows.length) tables.push({ index: i, rows: rows });
                });
              }
              var links = [];
              if (${wantLinks}) {
                document.querySelectorAll('a[href]').forEach(function(a){
                  links.push({ text: txt(a, 120), href: a.href });
                });
              }
              var headings = [];
              document.querySelectorAll('h1,h2,h3').forEach(function(h){ headings.push(txt(h, 200)); });
              return JSON.stringify({
                ok: true, pageId: ${JSONObject.quote(p.id)}, url: location.href, title: document.title,
                headings: headings.slice(0, 50),
                links: links.slice(0, 100),
                tables: tables.slice(0, 10),
                text: txt(document.body, 8000),
                matched: ${JSONObject.quote(instruction)}
              });
            })()
        """.trimIndent()
        val r = eval(p, script)
            ?: return err("PAGE_NOT_READY", "页面还没加载完或已关闭", "先 stagehand_navigate 到一个 URL")
        return r
    }

    /**
     * 自然语言动作 → 启发式执行。桌面由 LLM 解释指令；手机端用确定性规则，
     * 并如实回报命中了哪些元素、没命中什么，不假装理解。
     */
    fun act(pageId: String, instruction: String): String {
        val p = page(pageId)
        val text = instruction.trim()
        if (text.isBlank()) return err("EMPTY_ACTION", "instruction 不能为空")
        val js = when {
            text.contains(Regex("点击|click|按一下|press", RegexOption.IGNORE_CASE)) -> {
                val target = text.replace(Regex("点击|click|按一下|press", RegexOption.IGNORE_CASE), "")
                    .replace(Regex("^(一下|这个|那个|的|在|请|按钮|链接)"), "").trim().trim('"', '“', '”', '\'')
                val q = JSONObject.quote(target)
                """
                (function(){
                  var target = $q; var hits = [];
                  var els = document.querySelectorAll('a, button, [role=button], [role=link], input[type=submit], summary, label');
                  for (var i = 0; i < els.length; i++) {
                    var el = els[i];
                    var label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
                    if (label && target && label.indexOf(target) >= 0) {
                      el.scrollIntoView({block: 'center'});
                      el.click();
                      hits.push({ tag: el.tagName.toLowerCase(), label: label.slice(0, 80) });
                      if (hits.length >= 3) break;
                    }
                  }
                  if (!hits.length && target) {
                    var loose = [];
                    els.forEach(function(el){
                      var label = (el.innerText || '').trim();
                      if (label && target.split(/\s+/).some(function(w){ return w.length > 1 && label.indexOf(w) >= 0; })) loose.push(el);
                    });
                    if (loose.length) { loose[0].scrollIntoView({block:'center'}); loose[0].click();
                      hits.push({ tag: loose[0].tagName.toLowerCase(), label: (loose[0].innerText||'').trim().slice(0,80), fuzzy: true }); }
                  }
                  return JSON.stringify({ ok: hits.length > 0, clicked: hits.length, hits: hits, target: target,
                    note: hits.length ? '' : '页面上没有文本包含「' + target + '」的可点击元素' });
                })()
                """.trimIndent()
            }
            text.contains(Regex("输入|填写|填入|type|fill", RegexOption.IGNORE_CASE)) -> {
                val m = Regex("[\"“]([^\"”]+)[\"”]").find(text)
                val value = m?.groupValues?.get(1)
                    ?: text.replace(Regex("输入|填写|填入|type|fill", RegexOption.IGNORE_CASE), "")
                        .replace(Regex("^(到|在|把)"), "").trim()
                val vq = JSONObject.quote(value)
                """
                (function(){
                  var value = $vq; var filled = [];
                  var els = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, [contenteditable]');
                  var el = els[0];
                  if (!el) return JSON.stringify({ ok: false, note: '页面上没有可输入的输入框' });
                  if (el.isContentEditable) { el.innerText = value; }
                  else { el.value = value; }
                  el.dispatchEvent(new Event('input', {bubbles: true}));
                  el.dispatchEvent(new Event('change', {bubbles: true}));
                  filled.push({ tag: el.tagName.toLowerCase(), name: el.getAttribute('name') || '',
                    placeholder: el.getAttribute('placeholder') || '' });
                  return JSON.stringify({ ok: true, filled: filled.length, value: value, elements: filled });
                })()
                """.trimIndent()
            }
            text.contains(Regex("滚动|下滑|上滑|scroll", RegexOption.IGNORE_CASE)) ->
                """
                (function(){
                  var down = !/上滑|scroll\s*up/.test(${JSONObject.quote(text)});
                  var dy = down ? window.innerHeight * 0.8 : -window.innerHeight * 0.8;
                  window.scrollBy(0, dy);
                  return JSON.stringify({ ok: true, scrolled: dy, y: window.scrollY });
                })()
                """.trimIndent()
            text.contains(Regex("等待|wait", RegexOption.IGNORE_CASE)) -> {
                val ms = Regex("(\\d+)").find(text)?.groupValues?.get(1)?.toLongOrNull()?.coerceIn(0, 30_000) ?: 1000
                Thread.sleep(ms)
                return JSONObject().put("ok", true).put("waited_ms", ms).toString()
            }
            else -> return JSONObject().apply {
                put("ok", false)
                put("code", "UNPARSED_ACTION")
                put("error", "启发式解析不了这个动作：$text")
                put("hint", "安卓端 act 支持：点击<文本> / 输入<内容> / 滚动 / 等待 N 毫秒；复杂交互请分步描述")
            }.toString()
        }
        val r = eval(p, js, timeoutMs = 25_000)
            ?: return err("PAGE_NOT_READY", "页面还没加载完或已关闭", "先 stagehand_navigate 到一个 URL")
        return r
    }

    fun screenshot(pageId: String, fullPage: Boolean): String {
        val p = page(pageId)
        awaitReady(p, 5_000)
        val latch = CountDownLatch(1)
        val bmp = arrayOfNulls<Bitmap>(1)
        main.post {
            try {
                val w = (p.webview?.width ?: 0).coerceAtLeast(1080)
                val h = (p.webview?.height ?: 0).coerceAtLeast(1920)
                val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                val canvas = android.graphics.Canvas(b)
                b.eraseColor(android.graphics.Color.WHITE)
                p.webview?.draw(canvas)
                bmp[0] = b
            } catch (_: Throwable) {}
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        val b = bmp[0] ?: return err("SCREENSHOT_FAILED", "截图失败", "确认页面已加载后重试")
        val blank = runCatching {
            // 全白判定：抽样像素
            var white = 0; var total = 0
            for (x in 0 until b.width step 37) for (y in 0 until b.height step 37) {
                if (b.getPixel(x, y) == android.graphics.Color.WHITE) white++
                total++
            }
            total > 0 && white * 100 / total > 98
        }.getOrDefault(false)
        if (blank) {
            return JSONObject().apply {
                put("ok", false)
                put("code", "SCREENSHOT_BLANK")
                put("error", "WebView 不在可见窗口，绘制结果为空白")
                put("hint", "浏览器页面在后台渲染时无法截屏；这一步需要在可见页面里完成")
            }.toString()
        }
        // JPEG q85：PNG 是无损格式，compress 的 quality 参数对它完全无效，
        // 1080×1920 一张 1~2.5MB；JPEG 同尺寸 150~400KB（PhoneControlService 已踩过同坑）
        val baos = ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.JPEG, 85, baos)
        val base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        val w = b.width
        val h = b.height
        b.recycle()
        return JSONObject().apply {
            put("ok", true)
            put("pageId", p.id)
            put("url", p.url)
            put("title", p.title)
            put("width", w); put("height", h)
            put("mime", "image/jpeg")
            put("data_base64", base64)
            put("note", "图片以 base64 回传，可用 write 工具存盘后再交付")
        }.toString()
    }

    fun tabs(): String {
        val arr = JSONArray()
        pages.values.forEach { pg ->
            arr.put(JSONObject().apply {
                put("pageId", pg.id); put("url", pg.url); put("title", pg.title)
                put("ready", pg.ready)
            })
        }
        return JSONObject().apply {
            put("ok", true); put("count", arr.length()); put("tabs", arr)
            put("hint", "pageId 省略时各工具默认操作 default 页")
        }.toString()
    }

    fun close(pageId: String): String {
        val id = pageId.ifBlank { "default" }
        val p = pages.remove(id) ?: return JSONObject().apply {
            put("ok", false); put("code", "NO_SUCH_PAGE"); put("error", "没有页面：$id")
        }.toString()
        val latch = CountDownLatch(1)
        main.post { runCatching { p.webview?.destroy() }; latch.countDown() }
        latch.await(5, TimeUnit.SECONDS)
        return JSONObject().apply { put("ok", true); put("closed", id) }.toString()
    }

    private fun err(code: String, message: String, hint: String? = null): String =
        JSONObject().apply {
            put("ok", false); put("code", code); put("error", message)
            hint?.let { put("hint", it) }
        }.toString()
}
