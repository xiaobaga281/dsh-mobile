package ai.deepseek.harness.mobile.update

import ai.deepseek.harness.mobile.BuildConfig
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 检查更新 → 下载 → 调起安装。
 *
 * 数据源：GitHub Releases（`releases/latest`）。资产名与本地打包产物同名，
 * 按当前 flavor（complete / standard）挑对应的那个 —— 交叉装会互相覆盖，
 * 体积还大一圈，没必要。
 *
 * **数据保留**靠两件事，缺一不可：
 *  1. 同 `applicationId` + 同签名覆盖安装 —— 系统原地升级，`/data/data/<pkg>` 原样保留；
 *  2. 装之前先比对 APK 的包名与签名 —— 不一致系统会拒装，但那时用户已经等完了几百 MB 的下载。
 *     这里提前拦掉并说明原因（例如换了签名密钥），避免"装上去变新应用、旧数据读不到"。
 *
 * 所有网络与文件操作都在调用方指定的后台线程跑（见 [UpdateBridge]），
 * 这个类本身不做线程调度，也不碰 UI。
 */
class UpdateCenter(private val context: Context) {

    companion object {
        private const val API = "https://api.github.com/repos/xiaobaga281/dsh-mobile/releases/latest"
        private const val UA = "dsh-mobile-updater"

        /**
         * GitHub 加速镜像，按实测速度排序，**最后才回退官方地址**。
         *
         * 实测（本机，release 资产取 512KB，2026-10-31）：
         *   gh-proxy.org          2.25s   ≈233 KB/s   ← 最快
         *   gh-proxy.com          2.44s   ≈215 KB/s
         *   ghfile.geekertao.top  2.94s   ≈178 KB/s
         *   ghfast.top            超时     —— 2026-10-31 起不可用，已移出
         *   官方 github.com        只作保底
         * 拼法是「镜像前缀 + 完整原始 URL」，这是这类代理的通用约定（已实测 206 + PK 头）。
         */
        private val MIRRORS = listOf(
            "https://gh-proxy.org/",
            "https://gh-proxy.com/",
            "https://ghfile.geekertao.top/",
        )

        /** 下载：镜像优先、官方兜底 */
        private fun candidates(url: String): List<String> = MIRRORS.map { it + url } + url

        /**
         * 元数据接口：**官方优先**。
         *
         * 返回只有几 KB，走官方最快；而这些代理解析的是 release 文件路径，
         * 对 api.github.com 往往回一个 200 的 HTML 错误页 —— 镜像排前面反而更慢更不可靠。
         */
        private fun apiCandidates(url: String): List<String> = listOf(url) + MIRRORS.map { it + url }
    }

    /**
     * 下载源序号 → 给人看的名字（浮窗上显示「正在从 X 下载」）。
     * 序号与 [download] 的回调一致：0 = 本地缓存，1..N = 镜像，N+1 = 官方。
     * 放在这里而不是前端，是为了以后增删镜像不用两边同步改判断。
     */
    fun sourceLabel(idx: Int): String = when {
        idx <= 0 -> "本地缓存"
        idx <= MIRRORS.size -> MIRRORS[idx - 1].removePrefix("https://").substringBefore("/")
        else -> "GitHub 官方"
    }

    /** 本地版本号：`version.properties` 里的 versionCode，用来和 tag 里的数字比 */
    val localCode: Int get() = BuildConfig.VERSION_CODE
    val localName: String get() = BuildConfig.VERSION_NAME

    /**
     * 查最新 Release。
     *
     * @return `{ok, code, name, hasUpdate, notes, asset:{url,name,size}}` 或 `{ok:false, error}`
     */
    fun check(): JSONObject {
        val body = try {
            httpGetFirst(apiCandidates(API), accept = "application/vnd.github+json")
        } catch (e: Throwable) {
            return JSONObject().put("ok", false).put("error", netError(e))
        }
        val release = try {
            JSONObject(body)
        } catch (e: Throwable) {
            return JSONObject().put("ok", false).put("error", "返回内容不是 JSON")
        }
        val tag = release.optString("tag_name")
        val remoteCode = Regex("rc[.\\-]?(\\d+)").find(tag)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        if (remoteCode == 0) {
            return JSONObject().put("ok", false).put("error", "无法从版本号 $tag 解析出数字")
        }
        val asset = pickAsset(release)
        if (asset == null && remoteCode > localCode) {
            return JSONObject().put("ok", false).put(
                "error",
                "新版 $tag 已发布，但没有适配当前版本（${BuildConfig.FLAVOR}）或架构" +
                    "（${Build.SUPPORTED_ABIS.firstOrNull() ?: "?"}）的安装包；请到 GitHub Releases 手动下载",
            )
        }
        return JSONObject().apply {
            put("ok", true)
            put("code", remoteCode)
            put("name", tag)
            put("hasUpdate", remoteCode > localCode)
            put("notes", release.optString("body").take(1200))
            if (asset != null) put("asset", asset)
        }
    }

    /**
     * 挑当前 **flavor + ABI** 对应的 APK。
     *
     * rc.220 起资产名不再带 `complete`（complete 叫 `...-arm64-v8a-release.apk`，
     * standard 叫 `...-standard-arm64-v8a-release.apk`）。旧代码靠
     * `contains("complete")` 猜通道，命不中就退化到 `firstOrNull` —— 可能装上
     * 另一个通道、甚至另一个 ABI 的包（complete 的 rootfs 按 ABI 拆，装错直接崩）。
     */
    private fun pickAsset(release: JSONObject): JSONObject? {
        val assets = release.optJSONArray("assets") ?: return null
        val all = (0 until assets.length()).mapNotNull { assets.optJSONObject(it) }
            .filter { it.optString("name").endsWith(".apk") }
        if (all.isEmpty()) return null
        val wantStandard = BuildConfig.FLAVOR == "standard"
        val abi = Build.SUPPORTED_ABIS.firstOrNull().orEmpty()
        val pool = all.filter { it.optString("name").contains("-standard-") == wantStandard }
            .filter {
                val n = it.optString("name")
                // 没有 ABI 标注的通用包也接受；带别的 ABI 的一律不要
                abi.isBlank() || n.contains(abi) || (!n.contains("arm64") && !n.contains("x86"))
            }
        val hit = pool.firstOrNull() ?: return null
        return JSONObject().apply {
            put("url", hit.optString("browser_download_url"))
            put("name", hit.optString("name"))
            put("size", hit.optLong("size"))
        }
    }

    /**
     * 下载到 `cacheDir/updates/<name>`：按 [candidates] 顺序换源，**镜像先、官方最后**。
     *
     * 每个源都要过两道校验，不合格立刻换下一个：
     *  1. HTTP 2xx；
     *  2. 首字节是 `PK\x03\x04` —— 镜像挂了常返回一个 200 的 HTML 错误页，
     *     不校验就会白下几百 MB 垃圾，最后在安装器那一步才失败。
     *
     * @param onProgress 第一个参数是 0..100（总大小未知时为 -1），第二个是当前源序号（从 1 起）
     */
    fun download(
        url: String,
        fileName: String,
        expectSize: Long,
        onProgress: (Int, Int) -> Unit,
    ): File {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        val out = File(dir, fileName)
        if (out.exists() && expectSize > 0 && out.length() == expectSize) {
            onProgress(100, 0)
            return out
        }
        val list = candidates(url)
        var lastErr: Throwable? = null
        for ((idx, src) in list.withIndex()) {
            try {
                onProgress(0, idx + 1)
                return fetchTo(src, out, expectSize) { pct -> onProgress(pct, idx + 1) }
            } catch (e: Throwable) {
                lastErr = e
                runCatching { out.delete() }
            }
        }
        throw IllegalStateException(
            "所有下载源都失败了（镜像 ${MIRRORS.size} 个 + 官方）。最后一个错误：" +
                (lastErr?.message ?: "未知")
        )
    }

    private fun fetchTo(url: String, out: File, expectSize: Long, onProgress: (Int) -> Unit): File {
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 30_000
                instanceFollowRedirects = true          // 资产会 302 到 objects.githubusercontent.com
                setRequestProperty("User-Agent", UA)
            }
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            val total = conn.contentLengthLong.takeIf { it > 0 } ?: expectSize
            conn.inputStream.use { input ->
                out.outputStream().use { sink ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var lastPct = -1
                    var first = true
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        if (first) {
                            first = false
                            // APK 是 ZIP：开头必须是 PK\x03\x04，否则多半是镜像的错误页
                            val ok = n >= 4 && buf[0] == 0x50.toByte() && buf[1] == 0x4B.toByte() &&
                                buf[2] == 0x03.toByte() && buf[3] == 0x04.toByte()
                            if (!ok) throw IllegalStateException("返回的不是 APK（镜像可能挂了）")
                        }
                        sink.write(buf, 0, n)
                        done += n
                        val pct = if (total > 0) ((done * 100) / total).toInt() else -1
                        if (pct != lastPct) { lastPct = pct; onProgress(pct) }
                    }
                }
            }
            onProgress(100)
            return out
        } finally {
            conn?.disconnect()
        }
    }

    /**
     * 装之前把包名和签名核一遍。
     * @return null 表示可以装；否则是给用户看的中文原因
     */
    fun verifyApk(file: File): String? {
        val pm = context.packageManager
        val info = runCatching {
            if (Build.VERSION.SDK_INT >= 28) {
                pm.getPackageArchiveInfo(file.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES)
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageArchiveInfo(file.absolutePath, PackageManager.GET_SIGNATURES)
            }
        }.getOrNull() ?: return "安装包读不出来，可能下载不完整"

        if (info.packageName != context.packageName) {
            return "这个安装包的包名是 ${info.packageName}，和当前应用不一致，装上去会变成另一个应用（旧数据读不到）"
        }
        val apkCert = certOf(info) ?: return "安装包里没有签名信息"
        val self = runCatching {
            if (Build.VERSION.SDK_INT >= 28) {
                pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
            }
        }.getOrNull() ?: return "读不到当前应用的签名"
        val selfCert = certOf(self) ?: return "读不到当前应用的签名"
        return if (apkCert.contentEquals(selfCert)) null
        else "签名和当前应用不一致（可能换了签名密钥），系统会拒绝覆盖安装，装了也会丢数据"
    }

    private fun certOf(info: PackageInfo): ByteArray? = if (Build.VERSION.SDK_INT >= 28) {
        info.signingInfo?.apkContentsSigners?.firstOrNull()?.toByteArray()
    } else {
        @Suppress("DEPRECATION") info.signatures?.firstOrNull()?.toByteArray()
    }

    /**
     * Android 8+ 的「安装未知应用」是**逐应用授权**：用户侧载预编译 APK 时给
     * 「浏览器 / 文件管理器」开过开关，不等于给 DSH Mobile 开过。清单里声明
     * REQUEST_INSTALL_PACKAGES 只是第一步，没拿到这个开关时 `ACTION_VIEW` 会被
     * 系统静默拦掉 —— 现象就是「下载完了，点安装没反应，自己升不了级」。
     * 项目里 app_install 工具早有同一判断（AppInstallPlugin.canInstall），自升级漏了。
     */
    fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            context.packageManager.canRequestPackageInstalls()

    /** 跳到本应用的「安装未知应用」设置页（开完回来点安装即可，包还在缓存里） */
    fun openInstallSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching {
            context.startActivity(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${context.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }.onFailure {
            android.util.Log.w("DSHUpdate", "打不开安装权限设置页：${it.message}")
        }
    }

    /**
     * 调起系统安装器。调用方必须先跑 [verifyApk]。
     * @return false = 没有安装权限（已跳设置页）；调用方**不要清通知**，那条
     *         「下载完成·点此安装」是用户开完权限回来唯一的兜底入口。
     */
    fun install(file: File): Boolean {
        if (!canInstall()) {
            openInstallSettings()
            return false
        }
        val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        context.startActivity(Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
        return true
    }

    fun clearDownloads() {
        runCatching { File(context.cacheDir, "updates").deleteRecursively() }
    }

    /**
     * 依次试 [urls]，返回第一个**看着像 JSON** 的正文。
     *
     * 只判 HTTP 2xx 不够：这些代理对不支持的路径（比如 api.github.com）常回 200 的 HTML
     * 错误页。那样会把 HTML 当成结果返回，外层 JSON 解析一炸就整次失败 —— 而且不会继续
     * 试后面的地址。所以这里先看首字符是不是 `{` / `[`。
     */
    private fun httpGetFirst(urls: List<String>, accept: String): String {
        var last: Throwable? = null
        for (u in urls) {
            try {
                val body = httpGet(u, accept)
                val head = body.trimStart().firstOrNull()
                if (head != '{' && head != '[') throw IllegalStateException("返回的不是 JSON")
                return body
            } catch (e: Throwable) {
                last = e
            }
        }
        throw last ?: IllegalStateException("没有可用的地址")
    }

    private fun httpGet(url: String, accept: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 20_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", UA)
            setRequestProperty("Accept", accept)
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) {
                // 403/404 是最常见的两种：限流、仓库/Release 不存在
                throw IllegalStateException(if (code == 403) "请求太频繁（GitHub 限流），稍后再试" else "HTTP $code")
            }
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun netError(e: Throwable): String = when (e) {
        is IllegalStateException -> e.message ?: "网络请求失败"
        is java.net.UnknownHostException -> "连不上 github.com（检查网络或代理）"
        is java.net.SocketTimeoutException -> "网络超时"
        else -> e.message ?: e.javaClass.simpleName
    }
}
