package ai.deepseek.harness.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.provider.Settings
import android.os.Build
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.ValueCallback
import android.webkit.WebView
import android.widget.Toast
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.ContextCompat
import androidx.core.os.LocaleListCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import ai.deepseek.harness.mobile.bridge.NativeBridge
import ai.deepseek.harness.mobile.kernel.plugin.builtin.device.CompanionKeepService
import ai.deepseek.harness.mobile.glass.HonorGlass

/**
 * 单 Activity 容器：
 *  - WebView 承载 Harness 的会话 UI（assets/web，或用户配置的宿主机地址）
 *  - NativeBridge 提供触感 / 分享 / 原生通透面板
 *  - 边缘到边缘 + IME inset，交给前端 env(safe-area-inset-*) 处理安全区
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val DOMAIN = "appassets.androidplatform.net"
        private const val LOCAL_URL = "https://$DOMAIN/assets/web/index.html"
        private const val BACK_JS =
            "(function(){try{return window.DSHHandleBack?String(window.DSHHandleBack()):'false'}catch(e){return 'false'}})()"

        /** 灵动岛「停止」按钮 → 通知前端中断生成 */
        @Volatile
        private var islandWebView: WebView? = null

        /**
         * 正在跑的会话数（不是 boolean）：多会话/团队并行时，先结束的那个不能把
         * “还在跑”的标记清掉，否则退后台会销毁仍有 Agent 的 WebView。
         */
        private val runningSessions = java.util.concurrent.atomic.AtomicInteger(0)
        val sessionRunning: Boolean get() = runningSessions.get() > 0

        fun sessionStarted() { runningSessions.incrementAndGet() }

        fun sessionFinished() {
            runningSessions.updateAndGet { if (it > 0) it - 1 else 0 }
        }

        fun notifyIslandStop() {
            val wv = islandWebView ?: return
            wv.post {
                wv.evaluateJavascript(
                    "(function(){try{window.DSHIslandStop&&window.DSHIslandStop()}catch(e){}})()", null
                )
            }
        }
    }

    private lateinit var webView: WebView
    /** 根容器：页面未绘制时露出的底色就是它（跟随主题，见 applyBarAppearance） */
    private var appRoot: android.widget.FrameLayout? = null
    private lateinit var assetLoader: WebViewAssetLoader
    // 与桥接域共用同一份实例：WebView 重建后各自 getSharedPreferences 会拿到
    // 两个互不同步的实例，表现为「设置改了不生效」
    private val prefs by lazy { AppPrefs.get(applicationContext) }
    private var lastTopInset = -1f
    private var lastBottomInset = -1f
    private var lastNavMode = ""
    @Volatile
    private var showingRemote = false
    /** 最近一次文档提交的 URL（onPageStarted/Finished 在 UI 线程写，桥线程读） */
    @Volatile
    private var currentPageUrl: String? = null
    /** 上次因渲染进程被杀而重建 Activity 的时刻：用于防止「崩→重建→崩」死循环 */
    private var lastRenderRecoverAt = 0L
    private var bridge: NativeBridge? = null
    /** 当前 JS 桥是否挂在 WebView 上（只有本地 appassets origin 允许为 true） */
    @Volatile
    private var bridgesAttached = false
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var lastKbCss = -1f

    /** 手指正按在聊天输入框上（JS pointerdown 置位）。原生长按只在这个窗口内接管文本输入框 */
    @Volatile
    var voicePressArmed = false

    /** 置位时刻（elapsedRealtime）：老化的置位不能被当成「这一次长按」 */
    @Volatile
    var voicePressAt = 0L

    /** 本次长按已进入「按住说话」。Touch 抬手时据此补发松手（DOM pointerup 可能被系统选择吞掉） */
    @Volatile
    var voiceHoldArmed = false

    /**
     * 语音输出门面：引擎选择、音色、五项微调、朗读、语音条、系统音色挑选全在
     * [ai.deepseek.harness.mobile.voice.VoiceCenter]。
     * Activity 只保留 @JavascriptInterface 转发，方法签名与 VoiceBridge 对齐。
     */
    private val voiceCenter by lazy {
        ai.deepseek.harness.mobile.voice.VoiceCenter(applicationContext, prefs)
    }

    /** 工作区目录：App 私有空间，内核与贴纸库共用同一处 */
    private fun workspaceDir() = java.io.File(filesDir, "workspace")

    /**
     * 手机端内核：工具注册表 + 工作区沙箱。
     *
     * 进程级单例（[KernelHost]），**不随 Activity 重建**：WebView 渲染进程被回收时我们
     * `recreate()` 救界面，内核若是 Activity 的字段就会连带把正在跑的回合与整支团队杀掉
     * （实测过，细节写在 KernelHost 的注释里）。
     */
    val kernel: ai.deepseek.harness.mobile.kernel.ToolKernel
        get() = KernelHost.of(applicationContext, workspaceDir())

    /**
     * 表情包仓库：与内核同一份文件，但**不经过 [`kernel`] 懒加载**。
     *
     * 装配内核要拉起插件注册表、全部工具目录、会话日志、钩子链，而这里只想要一个文件路径。
     * 以前写的是 `stickerStore = kernel.stickerStore`，等于让 onCreate 顺手把整个内核装好 ——
     * 一次跟「装表情包」毫无关系的装配。现在改用 [ToolKernel.stickerFile] 直接建 store，
     * 内核仍然按需初始化（第一次真正用到工具 / 会话时才装）。
     */
    private val stickerStore by lazy {
        ai.deepseek.harness.mobile.kernel.StickerStore(
            ai.deepseek.harness.mobile.kernel.ToolKernel.stickerFile(workspaceDir()),
        )
    }

    /** <input type="file"> 的选择结果 */
    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = filePathCallback
        filePathCallback = null
        if (cb == null) return@registerForActivityResult
        val data = result.data
        cb.onReceiveValue(
            if (result.resultCode == RESULT_OK && data != null) collectUris(data) else null
        )
    }

    /** 内核工具发起的系统相机（photo_capture）：只回 resultCode，产物已在 EXTRA_OUTPUT */
    private val deviceCamera = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        ai.deepseek.harness.mobile.kernel.device.UiIntents.onCameraResult(result.resultCode)
    }

    /** 内核工具发起的 SAF 文件选择（file_import） */
    private val deviceSaf = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        ai.deepseek.harness.mobile.kernel.device.UiIntents.onSafResult(
            result.resultCode,
            result.data?.data,
        )
    }

    /** 麦克风权限：点麦克风时才申请，授权后直接开始识别 */
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startOfflineVoice()
        else bridge?.voiceEvent("error", "需要麦克风权限才能语音输入")
    }

    /** 通用权限申请：按权限组批量申请，逐组回报前端 */
    private val multiPerm = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        prefs.edit().putBoolean("permAsked", true).apply()
        val seen = mutableSetOf<String>()
        for ((perm, granted) in result) {
            val group = permGroupOf(perm) ?: continue
            if (!seen.add(group)) continue
            bridge?.permissionResult(group, granted, canRequestGroup(group))
        }
        // WebView 定位弹窗等待中：定位组授权后放行
        val geo = pendingGeoCallback
        if (geo != null) {
            pendingGeoCallback = null
            geo.invoke(pendingGeoOrigin, hasPermGroup("location"), false)
        }
    }

    private var pendingGeoCallback: android.webkit.GeolocationPermissions.Callback? = null
    private var pendingGeoOrigin: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 第一件事：装崩溃兜底。之后任何未捕获异常都会留一行到私有目录（不吞异常，只留证据）。
        CrashGuard.install(this)

        // 内核工具的系统意图出口（photo_capture / file_import）：launcher 必须在 Activity 就绪后注入
        ai.deepseek.harness.mobile.kernel.device.UiIntents.cameraLauncher = { deviceCamera.launch(it) }
        ai.deepseek.harness.mobile.kernel.device.UiIntents.safLauncher = { deviceSaf.launch(it) }

        // 提前构造语音门面：它在 init 里先读偏好，第一句才不会用默认音色念出来
        voiceCenter

        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        applyBarAppearance(prefs.getBoolean("barDark", isSystemDark()))

        // 根容器底色跟随主题：WebView 设置成 TRANSPARENT，页面还没绘制时露出的就是这层。
        // 以前固定用浅色 app_bg，深色用户从桌面回到应用（渲染进程被回收、页面重载）
        // 会先看到一下浅色底 —— 就是那下「闪白」。initBgDark 与 applyBarAppearance 同源。
        val initDark = prefs.getBoolean("barDark", isSystemDark())
        val root = FrameLayout(this).apply {
            setBackgroundColor(bgColor(initDark))
        }
        appRoot = root
        webView = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            overScrollMode = View.OVER_SCROLL_NEVER
        }
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)
        islandWebView = webView
        // 语音引擎预热：引擎构造是异步的（几百毫秒），不预热的话第一次发语音
        // 要多等一轮「准备中」。延后 2.5s，避开冷启动最忙的时段。
        webView.postDelayed({ runCatching { warmUpTts() } }, 2500)

        // 键盘为「覆盖」模式（manifest adjustNothing）：窗口与 WebView 都不缩短，
        // IME 高度经 webView 的 insets 监听以 --kb 交给前端做局部上移。
        // 这里绝不能再对 root 加 ime padding，否则 WebView 先缩短、前端再上移 = 双重复位，
        // 输入框会被顶到屏幕中部（实测空隙正好等于键盘高度）。
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            // 把系统栏尺寸持续同步给 WebView（手势条/三键导航都会变）
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val density = resources.displayMetrics.density
            val topCss = bars.top / density + 8f

            // 导航方式决定底部最小避让：三键 48dp、手势条 20dp、无导航 0
            // 部分窗口模式（分屏 / 自由窗口）系统不给 navigationBar inset，
            // 这里按模式补一个下限，避免浮层按钮被系统导航压住。
            val mode = navMode()
            val insetBottom = bars.bottom / density
            val minBottom = when (mode) {
                "3btn" -> 48f
                "gesture" -> 26f
                else -> 26f
            }
            val bottomCss = maxOf(insetBottom, minBottom)

            if (topCss != lastTopInset || bottomCss != lastBottomInset || mode != lastNavMode) {
                lastTopInset = topCss
                lastBottomInset = bottomCss
                lastNavMode = mode
                // documentElement 在页面导航/重建的瞬间可能还没挂载：判空，
                // 否则每次冷启动都会在 logcat 里炸一条无害但烦人的 TypeError
                webView.evaluateJavascript(
                    "var d=document.documentElement;if(d){" +
                        "d.style.setProperty('--safe-top','${topCss}px');" +
                        "d.style.setProperty('--safe-bottom','${bottomCss}px');" +
                        "d.style.setProperty('--nav-h','${insetBottom}px');" +
                        "d.dataset.nav='$mode';}",
                    null,
                )
            }
            insets
        }

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        configureWebView()
        loadLocal()

        // self_modify(reload) 的落点：在 UI 线程重载页面，让刚重建的 app.js 生效。
        // 覆盖响应带 no-store，reload 会重新走 shouldInterceptRequest 拿到新文件。
        ai.deepseek.harness.mobile.kernel.dev.SelfModify.reloadHook = {
            webView.post { webView.reload() }
        }

        // 启动即申请全部运行时权限（麦克风/定位/通讯录/相机/媒体/通知）。
        // 只自动问一次：用户拒绝后不再骚扰，需要时走设置页里的权限清单。
        if (!prefs.getBoolean("permAutoAsked", false)) {
            prefs.edit().putBoolean("permAutoAsked", true).apply()
            runCatching { requestAllPermGroups() }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = handleBack()
        })
    }

    /**
     * 所有子 frame 的 document-start 桥隔离。
     *
     * `addJavascriptInterface` 注入每个 frame；预览 srcdoc 里的 shim 只覆盖当前文档，
     * 页面运行时新建的 data:/blob: iframe 会重新拿到 DSHNative* 且没有 shim。
     * 这里在 WebView 层对每个新文档执行：主 frame 直接返回（UI 需要桥），
     * 任何子 frame 都把 DSHNative* 与 DshPtc 置 undefined 并锁死。
     * WebView 不支持 DOCUMENT_START_SCRIPT 时保留 srcdoc shim 兜底。
     */
    private fun installChildFrameBridgeShim() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val script = """
            (function(){
              try {
                if (window.top === window.self) return;
                var keys = Object.getOwnPropertyNames(window).filter(function (k) {
                  return k.indexOf("DSHNative") === 0 || k === "DshPtc";
                });
                for (var i = 0; i < keys.length; i++) {
                  var k = keys[i];
                  try { window[k] = undefined; } catch (e) {}
                  try {
                    Object.defineProperty(window, k, {
                      value: undefined, writable: false, configurable: false
                    });
                  } catch (e) {}
                }
              } catch (e) {}
            })();
        """.trimIndent()
        runCatching {
            WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))
        }.onFailure {
            android.util.Log.w("DSHWeb", "子 frame 桥隔离脚本不可用（旧 WebView）", it)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        // 调试通道只在 debug 构建里开：release 包被 chrome://inspect 挂上就等于把
        // WebView 里的登录态、会话内容全部暴露给 adb 可达的任何人
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // 本地页面是 https(appassets)，远端宿主机/局域网接口常是 http：
            // debug 放行混合内容便于联调；release 一律禁止（防明文降级/注入）
            mixedContentMode = if (BuildConfig.DEBUG) WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            else WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
            javaScriptCanOpenWindowsAutomatically = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                isAlgorithmicDarkeningAllowed = false
            }
        }

        // 预览是 sandbox 子 frame：srcdoc 里的 shim 只能保护「当前这份文档」，
        // 页面运行时再 new 一个 data: iframe，子 frame 会重新拿到 addJavascriptInterface
        // 注入的 DSHNative*。document-start 脚本对**所有 frame**生效，在主文档之外
        // 统一把桥抹掉；主文档继续保留桥，UI 不受影响。
        installChildFrameBridgeShim()

        // 长按聊天输入框 = 语音输入。输入框有字时，Android 会先走原生文字选择：
        // JS 的 420ms 长按计时会被 pointercancel/原生选择打断，用户的体感就是
        // 「有字时怎么按都不出语音」。这里在原生层只接管「按在输入框上的那一次长按」
        // （voicePressArmed 由 JS 在 pointerdown 置位），返回 true 抑制系统选择，
        // 再由 JS 走统一的开始逻辑；其它文本框、链接、图片保持默认长按行为。
        webView.setOnLongClickListener {
            val fresh = voicePressArmed && voicePressAt > 0 &&
                android.os.SystemClock.elapsedRealtime() - voicePressAt in 0..3000
            if (fresh && webView.hitTestResult.type == WebView.HitTestResult.EDIT_TEXT_TYPE) {
                webView.evaluateJavascript(
                    "window.DSHHost&&window.DSHHost.onNativeLongPress&&window.DSHHost.onNativeLongPress()",
                    null,
                )
                true
            } else {
                false
            }
        }

        // 原生文字选择会吞掉 DOM 的 pointerup：按住说话的收尾靠这里补发。
        // 只观察不消费（返回 false），WebView 自身的触摸处理完全不变。
        webView.setOnTouchListener { _, e ->
            if (voicePressArmed || voiceHoldArmed) {
                when (e.actionMasked) {
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        voicePressArmed = false
                        voicePressAt = 0L
                        if (voiceHoldArmed) {
                            voiceHoldArmed = false
                            bridge?.voiceHoldReleased()
                        }
                    }
                }
            }
            false
        }

        val b = NativeBridge(this, webView, onVoiceRequest = { startVoice() }, stickerStore = stickerStore)
        bridge = b
        // 注意：这里**不再**直接 addJavascriptInterface。
        // 桥只挂给本地 appassets origin（见 attachBridges / onPageStarted / onPageFinished）：
        // loadRemote 载入的是配对宿主的任意 http 页面，远端页面绝不能拿到 DSHNative*。

        // 键盘改用「覆盖」模式：窗口不再缩小，只把 IME 高度推给前端做局部上移
        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
            val imePx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            pushKeyboard(imePx / resources.displayMetrics.density)
            insets
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) {
                    android.util.Log.d("DSHWeb", "${msg.message()} @${msg.lineNumber()}")
                }
                return true
            }

            // 页面调用 navigator.geolocation 时：已授权直接放行，否则先申请
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: android.webkit.GeolocationPermissions.Callback?,
            ) {
                if (hasPermGroup("location")) {
                    callback?.invoke(origin, true, false)
                } else {
                    pendingGeoCallback = callback
                    pendingGeoOrigin = origin
                    multiPerm.launch(permsOfGroup("location"))
                }
            }

            // 没有这个回调，页面里的 <input type="file"> 点了不会有任何反应
            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    val intent = fileChooserParams?.createIntent()
                        ?: Intent(Intent.ACTION_GET_CONTENT).apply { type = "*/*" }
                    pickFiles.launch(intent)
                    true
                } catch (t: Throwable) {
                    filePathCallback = null
                    false
                }
            }
        }

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                if (request.url.host == DOMAIN) {
                    // 前端自改：开关开启时，app.js / styles.css 优先用 workspace 里
                    // 由 self_modify(rebuild) 生成的副本。overlay() 自带白名单与体检，
                    // 不满足就落到下面的 APK 内置资源 —— 改坏了不会白屏变砖。
                    val rel = request.url.path?.removePrefix("/assets/web/").orEmpty()
                    val overlay = if (rel.isNotEmpty() && !rel.contains("/")) {
                        ai.deepseek.harness.mobile.kernel.dev.SelfModify.overlay(this@MainActivity, rel)
                    } else null
                    if (overlay != null) {
                        val mime = if (rel.endsWith(".css")) "text/css" else "application/javascript"
                        return WebResourceResponse(mime, "utf-8", overlay.inputStream()).apply {
                            setResponseHeaders(mapOf("Cache-Control" to "no-store"))
                        }
                    }
                    // WebViewAssetLoader 不带任何缓存校验头，LOAD_DEFAULT 会启发式缓存 ——
                    // 升级 APK 后网页可能继续用旧 CSS/JS（改了界面没生效就是这么来的）。
                    // 本地资源没有网络成本，一律 no-cache 保证永远和包内一致。
                    return assetLoader.shouldInterceptRequest(request.url)?.apply {
                        setResponseHeaders(mapOf("Cache-Control" to "no-cache"))
                    }
                }
                return null
            }

            /**
             * 渲染进程被杀（OOM / 系统回收 / 自身崩溃）：WebView 此刻已经是死的，
             * 继续留着就是一片白屏且没有任何提示 —— 用户只能杀进程重开。
             *
             * 处理：记一笔诊断，然后把 Activity 重建（会话从本地库里恢复）。
             * 必须 return true，否则系统会连带杀掉整个 App 进程（那是更差的体验）。
             * 连续 15 秒内二次崩溃就不再重建，直接收场，避免「崩→重建→崩」死循环。
             */
            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail?,
            ): Boolean {
                CrashGuard.noteEvent(
                    this@MainActivity,
                    "webview-render-gone didCrash=${detail?.didCrash() == true} url=$currentPageUrl",
                )
                val now = System.currentTimeMillis()
                if (now - lastRenderRecoverAt < 15_000L) {
                    finish()
                    return true
                }
                lastRenderRecoverAt = now
                window.decorView.post { recreate() }
                return true
            }

            /**
             * 每次文档开始加载时决定桥的挂载：
             *  - 本地 appassets → 挂上（在页面脚本执行前）；
             *  - 其它 origin（宿主机 http 页面）→ 先摘除全部命名空间。
             * 这一步比 onPageFinished 早，既保证本地页第一行 JS 就能用 DSHNative，
             * 又保证远端文档一提交就没有桥可调。
             */
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                android.util.Log.d("DSHWeb", "onPageStarted url=$url bridgeNull=${bridge == null}")
                if (url != null) {
                    currentPageUrl = url
                    showingRemote = !ai.deepseek.harness.mobile.bridge.KernelBridgeOrigin.isLocalOrigin(url)
                }
                if (ai.deepseek.harness.mobile.bridge.KernelBridgeOrigin.isLocalOrigin(url)) attachBridges()
                else detachBridges()
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                // 再确认一次（有些 ROM 上 onPageStarted 的 url 为空/被重定向）：
                // 只允许 appassets 本地 origin 持有 JS 桥
                if (url != null) {
                    currentPageUrl = url
                    showingRemote = !ai.deepseek.harness.mobile.bridge.KernelBridgeOrigin.isLocalOrigin(url)
                }
                if (ai.deepseek.harness.mobile.bridge.KernelBridgeOrigin.isLocalOrigin(url)) attachBridges()
                else detachBridges()
                // 页面刷新后重新同步安全区，避免首帧 JS 丢失
                lastTopInset = -1f
                lastBottomInset = -1f
                webView.postDelayed({ pushInsets() }, 120)
                // 首屏稳定后再把离线语音模型读进内存：用户第一次按麦就不用等
                webView.postDelayed({
                    ai.deepseek.harness.mobile.asr.ModelDownloader.cleanupPartials(this@MainActivity)
                    runCatching { warmUpVoice() }
                }, 2500)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                val target = url.toString()
                // 本地资源页：按 origin 精确判定，仍留在 WebView 内
                if (ai.deepseek.harness.mobile.bridge.KernelBridgeOrigin.isLocalOrigin(target)) return false
                // 配对宿主机：只放行同一 origin（scheme+host+端口全等）。
                // 前缀比对会被 http://host:3080@evil.com/ 这类 userinfo 伪装骗过。
                val host = prefs.getString("host", null)
                if (host != null && ai.deepseek.harness.mobile.bridge.KernelBridgeOrigin.sameOrigin(host, target)) {
                    // 宿主页里再跳转同样要保证「远端文档没有桥」：先摘桥，再放行
                    detachBridges()
                    showingRemote = true
                    return false
                }
                // 子框架的外部导航直接拦截（不弹外部应用，也不让它带着父页的桥跑）
                if (!request.isForMainFrame) return true
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (_: Throwable) {
                    true
                }
            }
        }
    }

    /** 把键盘高度（CSS px）交给前端，避免整页重排 */
    private fun pushKeyboard(cssPx: Float) {
        // 键盘收起时 --kb 直接归零，不做 0.5px 抖动过滤，避免关不干净
        if (cssPx > 0f && lastKbCss > 0f && kotlin.math.abs(cssPx - lastKbCss) < 0.5f) return
        if (cssPx <= 0f && lastKbCss <= 0f) return
        lastKbCss = cssPx
        webView.post {
            val js = "var d=document.documentElement;if(d){d.style.setProperty('--kb','" + cssPx +
                "px');d.classList.toggle('kb-open'," + (cssPx > 0) + ");}"
            webView.evaluateJavascript(js, null)
        }
    }

    private fun collectUris(data: Intent): Array<Uri> {
        val out = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) out.add(clip.getItemAt(i).uri)
        }
        if (out.isEmpty()) data.data?.let { out.add(it) }
        return out.toTypedArray()
    }

    /* ---------------- 应用内语音输入（自绘面板，不拉起系统弹窗） ---------------- */

    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    /** 端侧离线识别：模型随包分发，不走网络，也不依赖厂商语音服务 */
    private val voiceEngine by lazy { ai.deepseek.harness.mobile.asr.VoiceEngine(this) }
    private var voiceListener: ai.deepseek.harness.mobile.asr.VoiceEngine.Listener? = null
    /** 模型还在加载时用户已按下：加载完自动开录 */
    private var pendingVoiceStart = false

    /* ---------------- 运行时权限（按组管理） ---------------- */

    /** 权限 → 组名 */
    private fun permGroupOf(p: String): String? = when (p) {
        Manifest.permission.RECORD_AUDIO -> "mic"
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION -> "location"
        Manifest.permission.READ_CONTACTS -> "contacts"
        Manifest.permission.CAMERA -> "camera"
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
        Manifest.permission.READ_MEDIA_AUDIO,
        Manifest.permission.READ_EXTERNAL_STORAGE -> "media"
        Manifest.permission.POST_NOTIFICATIONS -> "notifications"
        else -> null
    }

    /** 组内包含的权限（Android 版本相关） */
    fun permsOfGroup(group: String): Array<String> = when (group) {
        "mic" -> arrayOf(Manifest.permission.RECORD_AUDIO)
        "location" -> arrayOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        "contacts" -> arrayOf(Manifest.permission.READ_CONTACTS)
        "camera" -> arrayOf(Manifest.permission.CAMERA)
        "media" -> if (Build.VERSION.SDK_INT >= 33)
            arrayOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_AUDIO,
            )
        else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        "notifications" -> if (Build.VERSION.SDK_INT >= 33)
            arrayOf(Manifest.permission.POST_NOTIFICATIONS)
        else emptyArray()
        else -> emptyArray()
    }

    fun hasPermGroup(group: String): Boolean {
        val ps = permsOfGroup(group)
        if (ps.isEmpty()) return true // 低版本上通知默认有
        return ps.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
    }

    /** 还能不能再拉系统弹窗：没问过 → 能；问过 → 看系统是否还允许 */
    fun canRequestGroup(group: String): Boolean {
        val ps = permsOfGroup(group)
        if (ps.isEmpty() || hasPermGroup(group)) return false
        if (!prefs.getBoolean("permAsked", false)) return true
        return ps.any { shouldShowRequestPermissionRationale(it) }
    }

    fun requestPermGroup(group: String) {
        if (hasPermGroup(group)) {
            bridge?.permissionResult(group, true, false)
            return
        }
        val ps = permsOfGroup(group).filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (ps.isEmpty() || !canRequestGroup(group)) {
            bridge?.permissionResult(group, false, false)
            return
        }
        multiPerm.launch(ps.toTypedArray())
    }

    /** 一键全部允许：把还能申请的组一次打包给系统弹窗 */
    fun requestAllPermGroups() {
        val ps = linkedSetOf<String>()
        for (g in listOf("mic", "location", "contacts", "camera", "media", "notifications")) {
            if (canRequestGroup(g)) ps += permsOfGroup(g)
        }
        if (ps.isEmpty()) {
            // 全都授权过或被永久拒绝：逐组回报当前状态
            for (g in listOf("mic", "location", "contacts", "camera", "media", "notifications")) {
                bridge?.permissionResult(g, hasPermGroup(g), canRequestGroup(g))
            }
            return
        }
        prefs.edit().putBoolean("permAsked", true).apply()
        multiPerm.launch(ps.toTypedArray())
    }

    /** 拒绝了且不再询问时，唯一出路是应用设置页 */
    fun openAppSettingsPage() {
        runCatching {
            startActivity(
                Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", packageName, null),
                ),
            )
        }
    }

    /** 是否已在电池优化白名单里（不在 → 退后台会被系统冻结） */
    fun isIgnoringBattery(): Boolean = runCatching {
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        pm.isIgnoringBatteryOptimizations(packageName)
    }.getOrDefault(false)

    /** 引导加入电池优化白名单：部分国产 ROM 会拦这个 Intent，拦了就退回列表页 */
    fun requestIgnoreBattery() {
        if (isIgnoringBattery()) return
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.fromParts("package", packageName, null))
        if (runCatching { startActivity(direct) }.isSuccess) return
        runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
    }

    /** 荣耀「应用启动管理」：不设为手动允许，后台服务会被系统清理 */
    fun openStartupSettings() {
        val candidates = listOf(
            "com.hihonor.systemmanager/.appcontrol.activity.StartupAppControlActivity",
            "com.hihonor.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
            "com.hihonor.systemmanager/.appcontrol.activity.ManualControlActivity",
        )
        for (c in candidates) {
            val cn = android.content.ComponentName.unflattenFromString(c) ?: continue
            val it = Intent().setComponent(cn).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { packageManager.resolveActivity(it, 0) }.getOrNull() != null &&
                runCatching { startActivity(it) }.isSuccess
            ) return
        }
        openAppSettingsPage()
    }

    fun startVoice() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        startOfflineVoice()
    }

    /**
     * 离线识别优先。模型首次加载需要读 26MB onnx，耗时几十到几百毫秒——
     * 加载期间先把「正在准备」推给前端，就绪后自动开始录音。
     * 只有离线引擎真的起不来（ABI 不匹配等）才回退系统识别。
     */
    private fun startOfflineVoice() {
        val b = bridge ?: return
        val l = voiceListener ?: object : ai.deepseek.harness.mobile.asr.VoiceEngine.Listener {
            override fun onPartial(text: String) { bridge?.voiceEvent("partial", text) }
            override fun onLevel(level: Float) { bridge?.voiceLevel01(level) }
            // 增强模型是非流式：说完才开始解码，几百毫秒里得让用户看到「正在识别」
            override fun onDecoding() { bridge?.voiceEvent("thinking", "") }
            override fun onFinal(text: String) {
                // 带上这次录音的 wav：前端据此画一条可回放的「用户语音条」
                bridge?.voiceEvent("result", text, voiceEngine.lastClipPath, voiceEngine.lastClipMs)
            }
            override fun onError(message: String) { bridge?.voiceEvent("error", message) }
        }.also { voiceListener = it }

        if (voiceEngine.isReady) {
            b.voiceEvent("listening", "")
            voiceEngine.start(l)
            return
        }

        pendingVoiceStart = true
        b.voiceEvent("preparing", "")
        voiceEngine.prepare(
            onReady = {
                runOnUiThread {
                    if (!pendingVoiceStart) return@runOnUiThread
                    pendingVoiceStart = false
                    bridge?.voiceEvent("listening", "")
                    voiceEngine.start(l)
                }
            },
            onError = { msg ->
                runOnUiThread {
                    pendingVoiceStart = false
                    // 端侧引擎不可用：退回系统识别（有本地语音引擎的设备仍能出字）
                    if (SpeechRecognizer.isRecognitionAvailable(this)) {
                        bridge?.voiceEvent("thinking", "")
                        beginRecognition()
                    } else {
                        bridge?.voiceEvent("error", msg)
                    }
                }
            },
        )
    }

    /* ---------------- 语音输出：全部转发给 VoiceCenter ----------------
       这里曾经是 ~600 行：引擎选择、系统音色打分、分句合成、五项微调、状态 JSON 全在
       Activity 里，与 voice/ 包职责重叠。搬到 VoiceCenter 后，Activity 只剩转发，
       方法签名保持不变（VoiceBridge 不用改）。 */

    fun speak(text: String, rate: Float = 1f) = voiceCenter.speak(text, rate)

    fun stopSpeaking() = voiceCenter.stopSpeaking()

    fun synthVoice(text: String, rate: Float = 1f): String = voiceCenter.synthVoice(text, rate)

    fun voiceInfoJson(): String = voiceCenter.infoJson()

    fun setVoiceTuning(
        rate: Float,
        pitch: Float,
        volume: Float = 1f,
        brightness: Float = 0f,
        pause: Float = 1f,
    ): String = voiceCenter.setTuning(rate, pitch, volume, brightness, pause)

    /** 云端语音模型配置：读（脱敏）/ 写（前端唯一入口） */
    fun cloudTtsConfig(): String = voiceCenter.cloudConfigJson()

    fun setCloudTtsConfig(raw: String): String = voiceCenter.setCloudConfig(raw)

    fun warmUpTts() = voiceCenter.warmUpTts()

    fun voiceCacheClear(): Long = voiceCenter.cacheClear()

    fun setVoiceGender(gender: String) = voiceCenter.setGender(gender)

    fun currentVoiceGender(): String = voiceCenter.gender()

    /** 提前把模型读进内存，减少第一次按麦时的等待 */
    fun warmUpVoice() {
        voiceEngine.prepare(onReady = {}, onError = {})
    }

    /* ---------------- 语音模型管理（可选的双语增强模型） ---------------- */

    fun asrModelJson(): String = ai.deepseek.harness.mobile.asr.ModelDownloader.status(this)

    fun asrModelDownload() {
        Thread {
            val ok = ai.deepseek.harness.mobile.asr.ModelDownloader.download(this) { done, total, err ->
                bridge?.asrModelProgress(done, total, err)
            }
            if (ok) {
                voiceEngine.reload()
                warmUpVoice()
            }
            bridge?.asrModelDone(ok)
        }.start()
    }

    fun asrModelRemove(): Boolean {
        val ok = ai.deepseek.harness.mobile.asr.ModelDownloader.remove(this)
        if (ok) {
            voiceEngine.reload()
            warmUpVoice()
        }
        return ok
    }

    private fun beginRecognition() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            bridge?.voiceEvent("error", "当前设备没有可用的语音识别服务")
            return
        }
        val b = bridge
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).also { r ->
                r.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        listening = true
                        b?.voiceEvent("listening", "")
                    }
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {
                        b?.voiceLevel(rmsdB)
                    }
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {
                        b?.voiceEvent("thinking", "")
                    }
                    override fun onError(error: Int) {
                        listening = false
                        b?.voiceEvent("error", voiceErrorMessage(error))
                    }
                    override fun onResults(results: Bundle?) {
                        listening = false
                        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull().orEmpty()
                        if (text.isBlank()) b?.voiceEvent("error", "没有听清，再说一次")
                        else b?.voiceEvent("result", text)
                    }
                    override fun onPartialResults(partialResults: Bundle?) {
                        val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull().orEmpty()
                        b?.voiceEvent("partial", text)
                    }
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
            }
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            // 优先端侧识别：国内 ROM 多数带本地语音引擎，不上云也就不会「连不上网」。
            // 系统没有端侧引擎时会自动回退到它的在线服务（模拟器/无 GMS 设备会报网络错误）。
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
        listening = true
        bridge?.voiceEvent("listening", "")
        runCatching { recognizer?.startListening(intent) }.onFailure {
            listening = false
            bridge?.voiceEvent("error", "无法启动语音识别")
        }
    }

    /** 松手：停止收音，等待最终结果 */
    fun stopVoiceRecognition() {
        if (pendingVoiceStart) {
            // 模型还没加载完就松手了：这次放弃，下次按下会直接开录
            pendingVoiceStart = false
            bridge?.voiceEvent("cancelled", "")
            return
        }
        if (voiceEngine.isReady) {
            // 引擎在、但已经没在录音（上一次会话已收尾）：回一个终态，
            // 否则前端会一直停在「正在识别…」——这正是「点确认没反应」的观感。
            if (!voiceEngine.isRunning) {
                bridge?.voiceEvent("cancelled", "")
                return
            }
            voiceEngine.stop()
            return
        }
        if (!listening) return
        runCatching { recognizer?.stopListening() }
    }

    /** 取消：丢弃本次识别 */
    fun cancelVoiceRecognition() {
        pendingVoiceStart = false
        if (voiceEngine.isReady) {
            voiceEngine.cancel()
            bridge?.voiceEvent("cancelled", "")
            return
        }
        listening = false
        runCatching { recognizer?.cancel() }
        bridge?.voiceEvent("cancelled", "")
    }

    private fun voiceErrorMessage(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "录音出错"
        SpeechRecognizer.ERROR_CLIENT -> "识别客户端异常"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "没有麦克风权限"
        // App 自身有 INTERNET 权限；这里报的是「系统语音识别服务」连不上它的云端。
        // 常见于：模拟器 / 无 Google 语音服务的设备 / 语音服务被网络策略拦截。
        SpeechRecognizer.ERROR_NETWORK -> "系统语音服务连不上网，已为你打开键盘：点键盘上的麦克风说话即可"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "语音识别服务网络超时"
        SpeechRecognizer.ERROR_NO_MATCH -> "没有听清，再说一次"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "识别器忙，稍后再试"
        SpeechRecognizer.ERROR_SERVER -> "语音识别服务不可用"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有检测到说话"
        else -> "语音识别失败"
    }

    /** App 内语言 → 系统级应用语言，让权限弹窗 / 语音识别等系统 UI 用同一语言 */
    fun applyAppLanguage(tag: String) {
        val target = when (tag) {
            "zh" -> LocaleListCompat.forLanguageTags("zh-CN")
            "en" -> LocaleListCompat.forLanguageTags("en")
            else -> LocaleListCompat.getEmptyLocaleList()
        }
        val current = AppCompatDelegate.getApplicationLocales()
        if (current == target) return
        runOnUiThread { AppCompatDelegate.setApplicationLocales(target) }
    }

    /** 挂载全部 JS 桥命名空间（只允许在本地 appassets origin 调用） */
    @SuppressLint("JavascriptInterface")
    private fun attachBridges() {
        val b = bridge
        if (b == null) { android.util.Log.w("DSHWeb", "attachBridges: bridge 未初始化，跳过"); return }
        if (bridgesAttached) { android.util.Log.d("DSHWeb", "attachBridges: 已挂过，跳过"); return }
        try {
            b.domains.forEach { (name, impl) -> webView.addJavascriptInterface(impl, name) }
            android.util.Log.d("DSHWeb", "attachBridges: 挂上 ${b.domains.size} 个域")
        } catch (e: Exception) {
            android.util.Log.e("DSHWeb", "attachBridges 失败", e)
        }
        bridgesAttached = true
        // addJavascriptInterface 只对「之后创建的文档」生效。onPageStarted 触发时本文档已经
        // commit，若进程生命周期里只有这一次加载（冷启动且 URL 已带参数、页面不再二次跳转），
        // 这份文档永远拿不到桥 —— 症状就是 DSHNative* 全不存在、假状态栏显示、插件页全废。
        // 补一次 reload：新文档创建时桥已注册，onPageStarted 再进来会命中「已挂过」不重挂。
        android.util.Log.d("DSHWeb", "attachBridges: 首挂补 reload（让当前文档拿到桥）")
        webView.post { webView.reload() }
    }

    /**
     * 摘除全部命名空间。按 NativeBridge.domains 统一遍历，新增域自动覆盖：
     * 以前只在 onDestroy 里手写摘除，漏一个域就是一个永远挂在远端页面上的接口。
     */
    private fun detachBridges() {
        if (!bridgesAttached) return
        bridge?.domains?.forEach { (name, _) -> webView.removeJavascriptInterface(name) }
        bridgesAttached = false
    }

    /**
     * 当前 WebView 是否是本地资源页（KernelBridge 等敏感入口用它做最后一道兜底）。
     * 三个条件全要满足：全局标志没在远端 + 桥确实挂着 + 最近提交的文档 URL 是本地 origin。
     */
    fun isLocalPage(): Boolean =
        !showingRemote && bridgesAttached &&
            ai.deepseek.harness.mobile.bridge.KernelBridgeOrigin.isLocalOrigin(currentPageUrl)

    fun loadLocal() {
        showingRemote = false
        // 从远端回本地：先摘桥再导航，新文档在 onPageStarted 里重新挂上
        detachBridges()
        invalidateAssetCacheOnce()
        val theme = if (isSystemDark()) "dark" else "light"
        // 带版本号：文档 URL 随版本变化，HTML 本身也不会命中旧缓存
        webView.loadUrl("$LOCAL_URL?theme=$theme&v=${BuildConfig.VERSION_CODE}")
    }

    /**
     * 升级后必须丢掉 WebView 的 HTTP 缓存。
     *
     * 本地页面走 `https://appassets.androidplatform.net`（WebViewAssetLoader），
     * `cacheMode = LOAD_DEFAULT` 且 index.html 里 `app.js` / `styles.css` 不带版本号 ——
     * Chromium 会按启发式规则缓存这两份资源。结果就是**装了新 APK 仍跑旧前端**：
     * 资源已在 assets 里更新（md5 可对），行为却是上一版。真机实测踩过：rc.118 的
     * 导航高亮修复装上去之后，看到的还是 rc.117 的旧表现。
     *
     * 用 versionCode 作缓存代次：升级后第一次进本地页清一次缓存（只此一次，
     * 之后仍走正常缓存，不牺牲启动速度）。
     */
    private fun invalidateAssetCacheOnce() {
        // key 换了：上一版在同名 key 里存的是 Int，直接改 getLong 会抛
        // ClassCastException（Integer→Long）在启动路径上直接闪退——真机踩过。
        // 教训：SharedPreferences 同一个 key 不能换值类型，要么换 key，要么先删。
        val key = "assetCacheGenMs"
        // 用「安装时间」而不是 versionCode：同版本重装（改完就装、还没升版本号）也要失效，
        // 否则每次迭代都得骗一个 versionCode 才能看到新前端。
        val gen = runCatching {
            packageManager.getPackageInfo(packageName, 0).lastUpdateTime
        }.getOrDefault(0L)
        val last = runCatching { prefs.getLong(key, -1L) }.getOrDefault(-1L)
        if (gen <= 0L || last == gen) return
        runCatching { webView.clearCache(true) }
        prefs.edit().putLong(key, gen).apply()
    }

    fun loadRemote(url: String) {
        val target = url.trim()
        // 只接受 http(s)：file:/javascript:/content: 会越过 origin 边界，直接拒绝
        if (!ai.deepseek.harness.mobile.bridge.KernelBridgeOrigin.isHttpUrl(target)) {
            Toast.makeText(this, "宿主机地址必须以 http(s):// 开头", Toast.LENGTH_SHORT).show()
            return
        }
        // 远端页面 = 配对宿主的任意 http 页面：导航前先把全部 JS 桥摘掉。
        // 顺序很重要 —— 先 detach 再 load，远端文档一提交就没有桥可调。
        detachBridges()
        showingRemote = true
        webView.loadUrl(target)
    }

    fun isSystemDark(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES

    /**
     * 当前导航方式：3btn / gesture / none。
     * navigation_mode: 0=三键，1=手势，2=手势（双键）；读不到时按 insets 推断。
     */
    fun navMode(): String {
        val mode = try {
            Settings.Secure.getInt(contentResolver, "navigation_mode", -1)
        } catch (_: Exception) {
            -1
        }
        return when (mode) {
            0 -> "3btn"
            1, 2 -> "gesture"
            else -> {
                val h = ViewCompat.getRootWindowInsets(window.decorView)
                    ?.getInsets(WindowInsetsCompat.Type.navigationBars())?.bottom ?: 0
                when {
                    h <= 0 -> "none"
                    h / resources.displayMetrics.density >= 32f -> "3btn"
                    else -> "gesture"
                }
            }
        }
    }

    fun applyBarAppearance(dark: Boolean) {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        /* 窗口与根容器的底色一起跟随主题。
           WebView 是 TRANSPARENT 的，页面还没绘制（从桌面回来、渲染进程被回收后重载）
           时露出的就是这两层；固定浅色会让深色用户看到一下白闪（用户实测）。
           页面内还有一道保险：index.html 的 head 内联脚本会在样式表之前定住主题。 */
        val bg = bgColor(dark)
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(bg))
        appRoot?.setBackgroundColor(bg)
    }

    /** 页面/窗口底色：浅色 #F2F2F7、深色 #000000（与 CSS 的 --bg 对齐） */
    private fun bgColor(dark: Boolean): Int = ContextCompat.getColor(
        this,
        if (dark) R.color.app_bg_dark else R.color.app_bg,
    )

    /** 把状态栏 / 导航栏尺寸写给 WebView（手势条、三键都覆盖；页面加载后也会补推） */
    private fun pushInsets() {
        val root = findViewById<View>(android.R.id.content) ?: return
        val bars = ViewCompat.getRootWindowInsets(root)
            ?.getInsets(WindowInsetsCompat.Type.systemBars()) ?: return
        val density = resources.displayMetrics.density
        val top = bars.top / density + 8f

        // 统一按导航方式给底部最小避让：三键 48dp、手势条 20dp
        val mode = navMode()
        val minBottom = when (mode) {
            "3btn" -> 48f
            "gesture" -> 26f
            else -> 26f
        }
        val bottom = maxOf(bars.bottom / density, minBottom)

        lastTopInset = top
        lastBottomInset = bottom
        lastNavMode = mode
        webView.evaluateJavascript(
            "var d=document.documentElement;if(d){" +
                "d.style.setProperty('--safe-top','${top}px');" +
                "d.style.setProperty('--safe-bottom','${bottom}px');" +
                "d.style.setProperty('--nav-h','${(bars.bottom / density)}px');" +
                "d.dataset.nav='$mode';}",
            null,
        )
    }

    private fun handleBack() {
        webView.evaluateJavascript(BACK_JS) { result ->
            val handled = result?.trim()?.trim('"') == "true"
            if (handled) return@evaluateJavascript
            if (showingRemote && webView.canGoBack()) {
                webView.goBack()
            } else if (sessionRunning) {
                // 会话还在跑：退到桌面而不是 finish()。
                // finish() 会 onDestroy → webView.destroy()，Agent 直接被杀，后台就"不运行"了。
                moveTaskToBack(true)
            } else {
                finish()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.postDelayed({ pushInsets() }, 150)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 切换手势/三键导航后 inset 可能不会重新派发，这里主动同步一次
        webView.postDelayed({ pushInsets() }, 200)
    }

    override fun onStart() {
        super.onStart()
        ai.deepseek.harness.mobile.notify.RunService.setAppVisible(this, true)
        maybeAskNotifyForCompanion()
    }

    /**
     * 陪伴式畅聊开着、但系统通知没授权时，补一次权限弹窗。
     *
     * 没有这一步的后果是：引擎照常到点开口、消息也写进了待投递队列，
     * 但 `NotificationManager.notify` 被系统静默丢弃 —— 用户从外面完全看不到，
     * 表现就是「它一句话都没说过」。每组只问一次，问过还拒绝就靠面板里的提示引导去设置页。
     */
    private fun maybeAskNotifyForCompanion() {
        if (Build.VERSION.SDK_INT < 33) return
        if (hasPermGroup("notifications")) return
        if (prefs.getBoolean("companionNotifyAsked", false)) return
        val on = runCatching {
            val f = java.io.File(filesDir, "kernel/companion.json")
            if (!f.isFile) false else org.json.JSONObject(f.readText()).optBoolean("enabled", false)
        }.getOrDefault(false)
        if (!on) return
        prefs.edit().putBoolean("companionNotifyAsked", true).apply()
        // 等这一帧的界面挂完再弹，避免在 onStart 里同步弹窗把首帧顶掉
        window.decorView.postDelayed({ if (!isFinishing) requestPermGroup("notifications") }, 800)
    }

    override fun onStop() {
        // 退到桌面：运行通知从「静默载体」变成可见进度，用户能随时停止
        ai.deepseek.harness.mobile.notify.RunService.setAppVisible(this, false)
        // 语音只属于前台交互：App 不可见时绝不能继续占着麦克风，
        // 否则会出现「没人点语音，一说话却弹出语音面板」。
        runCatching {
            val hadVoice = voiceEngine.isRunning || pendingVoiceStart || listening
            pendingVoiceStart = false
            listening = false
            if (voiceEngine.isRunning) voiceEngine.cancel()
            runCatching { recognizer?.cancel() }
            if (hadVoice) bridge?.voiceEvent("cancelled", "")
        }
        super.onStop()
    }

    override fun onPause() {
        // 两种情况下**不能**暂停 WebView：
        // ① 会话在跑：页面一旦被判为不可见，Chromium 会压制定时器、极端情况下冻结渲染进程，
        //    流式输出就断在这里；
        // ② 陪伴式畅聊开着（保活服务驻留）：心跳是原生定时器发的，但「判断该不该开口 →
        //    问模型 → 落到会话」整条链路在 JS 里跑。页面一暂停，原生那条消息就躺在
        //    事件队列里没人处理 —— 表现正是「退到后台以后一次都不主动」。
        val companionOn = CompanionKeepService.running()
        if (!sessionRunning && !companionOn) webView.onPause()
        super.onPause()
    }

    /**
     * 内存吃紧时先放掉神经 TTS：模型常驻值钱，但内存更值钱 ——
     * 它随时能重新加载（约 0.3–0.8s），而 OOM 会直接把会话弄没。
     * 阈值取 CRITICAL 而不是 LOW：LOW 在聊天页会很频繁，反复加载反而更卡。
     */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
            voiceCenter.onTrimMemory()
        }
    }

    override fun onDestroy() {
        voiceCenter.release()
        runCatching { voiceEngine.release() }
        detachBridges()
        // reloadHook 的 lambda 持有 webView（进而持有 Activity），销毁时必须摘掉
        ai.deepseek.harness.mobile.kernel.dev.SelfModify.reloadHook = null
        webView.destroy()
        if (islandWebView === webView) islandWebView = null
        super.onDestroy()
    }
}
