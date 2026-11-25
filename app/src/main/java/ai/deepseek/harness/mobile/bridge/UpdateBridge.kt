package ai.deepseek.harness.mobile.bridge

import ai.deepseek.harness.mobile.update.UpdateBus
import ai.deepseek.harness.mobile.update.UpdateCenter
import ai.deepseek.harness.mobile.update.UpdateService
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 检查更新（设置页 → 检查更新）。
 *
 * 分工：
 *   · **查版本**在这里的后台线程跑（一次几 KB 的请求，很快）；
 *   · **下载**交给 [UpdateService] 前台服务 —— 用户点完十有八九会切走，普通后台线程
 *     会随进程被回收，下载断在半截还没人知道。服务用通知栏进度条给可见反馈。
 *
 * 状态统一经 [UpdateBus] 出：桥在 `init` 里挂上 listener，转成 `window.DSHHost.onUpdate`
 * 推给前端；服务那侧直接往总线里塞。页面重载后 [updateState] 能从总线还原。
 *
 * 所有 `@JavascriptInterface` 方法都**立即返回**，绝不在 JS 线程做网络或写盘。
 */
class UpdateBridge(private val core: BridgeCore) {

    private val center by lazy { UpdateCenter(core.activity.applicationContext) }
    private val work = Executors.newSingleThreadExecutor { r ->
        Thread(r, "dsh-update-check").apply { isDaemon = true }
    }

    /** 同一时刻只允许一个检查在跑，避免连点把线程池塞满 */
    private val checking = AtomicBoolean(false)

    /** 上一次检查的结果（版本号 / 资产地址），下载与安装都要用 */
    @Volatile private var lastCheck: JSONObject? = null

    init {
        // 服务在后台推来的状态也要能到达页面（App 被切走时 JS 不执行，忽略即可）
        UpdateBus.listener = { st ->
            runCatching {
                core.raw(
                    "window.DSHHost&&window.DSHHost.onUpdate&&window.DSHHost.onUpdate(" +
                        JSONObject.quote(st.toString()) + ")"
                )
            }
        }
    }

    private fun state(name: String) = JSONObject().put("state", name)
        .put("local", center.localName).put("localCode", center.localCode)

    private fun push(st: JSONObject) = UpdateBus.push(st)

    /**
     * 已下载好、等待安装的包。
     *
     * 不能依赖内存里的 `lastCheck`：下载被交给前台服务，用户很可能切走甚至被系统回收进程，
     * 回来时 `lastCheck == null`，旧实现直接报「安装包不在了，请重新下载」—— 包明明
     * 还在缓存里。改成扫缓存目录取最新的 .apk，进程重启一样装得上。
     */
    private fun downloadedFile(): File? {
        val dir = File(core.activity.cacheDir, "updates")
        return dir.listFiles { f -> f.isFile && f.name.endsWith(".apk") && f.length() > 0 }
            ?.maxByOrNull { it.lastModified() }
    }

    /** 当前版本 + 最近一次状态，浮窗重开时用它还原，不用再请求一次 */
    @JavascriptInterface
    fun updateState(): String = JSONObject().apply {
        put("local", center.localName)
        put("localCode", center.localCode)
        UpdateBus.last?.let { put("last", it) }
        lastCheck?.let { put("check", it) }
        put("downloaded", downloadedFile() != null)
    }.toString()

    @JavascriptInterface
    fun updateCheck(): String {
        if (!checking.compareAndSet(false, true)) return JSONObject().put("started", false).toString()
        push(state("checking"))
        work.execute {
            try {
                val r = center.check()
                lastCheck = r
                if (!r.optBoolean("ok")) {
                    push(state("error").put("error", r.optString("error")))
                } else if (!r.optBoolean("hasUpdate")) {
                    push(state("latest").put("name", r.optString("name")))
                } else {
                    val a = r.optJSONObject("asset")
                    push(
                        state("available").put("name", r.optString("name"))
                            .put("code", r.optInt("code"))
                            .put("size", a?.optLong("size") ?: 0L)
                            .apply { a?.let { put("url", it.optString("url")); put("file", it.optString("name")) } }
                    )
                }
            } catch (e: Throwable) {
                push(state("error").put("error", e.message ?: e.javaClass.simpleName))
            } finally {
                checking.set(false)
            }
        }
        return JSONObject().put("started", true).toString()
    }

    /** 启动前台服务下载：切走 App 也不断，通知栏可看进度 */
    @JavascriptInterface
    fun updateDownload(): String {
        val r = lastCheck
        val asset = r?.optJSONObject("asset")
        val url = asset?.optString("url").orEmpty()
        val name = asset?.optString("name").orEmpty()
        if (url.isBlank() || name.isBlank()) {
            push(state("error").put("error", "没有可下载的安装包，先检查更新"))
            return JSONObject().put("started", false).toString()
        }
        push(state("downloading").put("pct", 0))
        return try {
            UpdateService.start(core.activity.applicationContext, url, name, asset?.optLong("size") ?: 0L)
            JSONObject().put("started", true).toString()
        } catch (e: Throwable) {
            push(state("error").put("error", e.message ?: e.javaClass.simpleName))
            JSONObject().put("started", false).toString()
        }
    }

    @JavascriptInterface
    fun updateInstall(): String {
        val f = downloadedFile()
        if (f == null) {
            push(state("error").put("error", "安装包不在了，请重新下载"))
            return JSONObject().put("ok", false).toString()
        }
        val bad = center.verifyApk(f)
        if (bad != null) {
            push(state("error").put("error", bad))
            return JSONObject().put("ok", false).toString()
        }
        return try {
            if (!center.install(f)) {
                // 「安装未知应用」没开：install() 已跳系统设置页。
                // 这里保留那条「下载完成·点此安装」通知 —— 用户开完权限回来
                // 还要靠它或在面板里再点一次安装，清掉了就彻底没入口了。
                push(state("permission").put(
                    "error",
                    "系统还没允许 DSH Mobile 安装应用。已打开设置页，请开启" +
                        "「允许来自此来源的应用」，回来后点「已打开，继续安装」。",
                ))
                return JSONObject().put("ok", false).put("needPermission", true).toString()
            }
            // 不清通知：系统安装器仍可能因签名/存储/用户取消被拦下，
            // 那条通知是唯一的兜底入口；由 updateCancel 或下次启动清理。
            JSONObject().put("ok", true).toString()
        } catch (e: Throwable) {
            push(state("error").put("error", e.message ?: e.javaClass.simpleName))
            JSONObject().put("ok", false).toString()
        }
    }

    /** 面板里的「去设置里打开」：重新跳一次本应用的安装权限设置页 */
    @JavascriptInterface
    fun updatePermission(): String {
        center.openInstallSettings()
        return JSONObject().put("ok", true).toString()
    }

    /** 放弃这次更新：停服务、清缓存的包 */
    @JavascriptInterface
    fun updateCancel(): String {
        val ctx = core.activity.applicationContext
        runCatching { UpdateService.cancel(ctx) }
        runCatching { UpdateService.clearNotification(ctx) }
        runCatching { center.clearDownloads() }
        lastCheck = null
        UpdateBus.last = null
        push(state("idle"))
        return JSONObject().put("ok", true).toString()
    }
}
