package ai.deepseek.harness.mobile.bridge

import android.content.Intent
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * 宿主地址规范化 —— 纯函数（KernelBridgeOriginTest 覆盖）。
 *
 * 只接受 `http(s)://host[:port][/path][?query]`：
 *   · 拒绝 file:/javascript:/content:/intent:（WebView 载入 file: 会越过 origin 边界）；
 *   · 拒绝 userinfo（`https://bank.com@evil.com` 这类伪装）；
 *   · 拒绝控制字符/空白与非法端口。
 * 通过后返回规范化 URL（scheme/host 小写、端口保留），失败返回 null。
 */
object HostUrl {
    fun normalize(raw: String?): String? {
        val u = raw?.trim().orEmpty()
        if (u.isEmpty()) return null
        if (!KernelBridgeOrigin.isHttpUrl(u)) return null
        val uri = runCatching { java.net.URI(u) }.getOrNull() ?: return null
        if (!uri.userInfo.isNullOrBlank()) return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.trim()?.lowercase().orEmpty()
        if (host.isEmpty()) return null
        val port = uri.port
        if (port > 65535) return null
        // 默认端口不写出来；根路径 "/" 丢掉（与用户输入外观一致）
        val defaultPort = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        val authority = if (port > 0 && !defaultPort) "$host:$port" else host
        val rawPath = uri.rawPath.orEmpty()
        val path = if (rawPath == "/") "" else rawPath
        val query = uri.rawQuery?.let { "?$it" } ?: ""
        return "$scheme://$authority$path$query"
    }
}

/**
 * 宿主域：宿主服务地址、外部链接、工作区文件预览。
 */
class HostBridge(private val core: BridgeCore) {

    private val activity get() = core.activity
    private val prefs get() = core.prefs
    private fun toast(msg: String) = core.toast(msg)

    private fun openWithSystem(f: java.io.File) = FileIntents.open(activity, f)

    @JavascriptInterface
    fun connectHost(url: String) {
        // 1) 只接受 http(s)：file:/javascript: 等一律拒绝，且拒绝 userinfo 伪装
        val target = HostUrl.normalize(url)
        if (target == null) {
            toast("宿主机地址必须是 http(s)://host，且不能带账号信息")
            return
        }
        // 2) 先记录（中继/设置页读同一份），再交给用户显式确认后才真正加载
        val prev = prefs.getString("host", null)
        prefs.edit().putString("host", target).apply()
        activity.runOnUiThread { confirmHost(target, prev) }
    }

    /**
     * 载入远端页面 = 把 WebView 交给配对宿主的任意 http 页面（本地 JS 桥会摘除）。
     * 这是权限边界的切换，必须让用户看见并点一次「连接」，不能由页面脚本单方面完成。
     */
    private fun confirmHost(target: String, prev: String?) {
        if (activity.isFinishing || activity.isDestroyed) {
            // 不在前台：不静默切换页面
            toast("当前不在前台，未切换宿主机")
            return
        }
        androidx.appcompat.app.AlertDialog.Builder(activity)
            .setTitle("连接宿主机")
            .setMessage(
                "将加载远端页面：\n$target\n\n" +
                    "远端页面不是本地资源：加载前会摘除全部本地 JS 桥，它拿不到设备能力。" +
                    "确认连接？"
            )
            .setPositiveButton("连接") { _, _ -> activity.loadRemote(target) }
            .setNegativeButton("取消") { _, _ ->
                // 取消就把刚才的记录还原，避免「点了取消但地址已经换了」
                if (prev == null) prefs.edit().remove("host").apply()
                else prefs.edit().putString("host", prev).apply()
            }
            .setCancelable(false)
            .show()
    }

    @JavascriptInterface
    fun clearHost() {
        prefs.edit().remove("host").apply()
        activity.runOnUiThread { activity.loadLocal() }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        activity.runOnUiThread {
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
        }
    }

    /**
     * 打开工作区文件：
     * - DocPreview 支持的格式（OOXML / pdf / 图片 / csv / json / 代码 / html / 文本）走应用内预览
     * - 其余交给系统查看器
     * 返回 JSON：{preview:true, kind,title,html} 或 {preview:false, ok}
     */
    @JavascriptInterface
    fun openWorkspaceFile(path: String): String {
        return try {
            val kernel = activity.kernel
            val f = kernel.workspace.resolve(path, mustExist = true)
            if (f.isDirectory) return JSONObject().put("ok", false).put("error", "这是目录").toString()
            val pv = ai.deepseek.harness.mobile.kernel.preview.DocPreview.preview(f)
            val kind = pv.optString("kind")
            // DocPreview 认识的格式（OOXML/pdf/图片/csv/json/代码/html/文本）全部应用内渲染；
            // 只有解析报错（真二进制）才降级到系统应用
            if (kind == "error") {
                // 真二进制：应用内解析不了，直接交系统查看器
                openWithSystem(f)
                return JSONObject().put("preview", false).put("ok", true).toString()
            }
            // 视频不在应用内解码（几十 MB 过 base64 桥会卡死）：交系统播放器，
            // 对话流里的缩略方块仍然由 imageData / 首帧占位画出来
            if (kind == "video") {
                openWithSystem(f)
                return JSONObject().put("preview", false).put("ok", true).toString()
            }
            JSONObject().apply {
                put("preview", true)
                // 回传绝对路径：前端「用其它应用打开」拿到的是确定位置，
                // 不再受内核 cwd 变化影响（相对路径 + 已切换 cwd = 打开失败且毫无提示）
                put("path", f.absolutePath)
                pv.keys().forEach { k -> put(k, pv.get(k)) }
            }.toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "打不开").toString()
        }
    }

    /**
     * 预览对话流里的本地附件（用户 picked 的文件，尚未写入工作区）。
     * dataUrl 形如 data:<mime>;base64,<...>；落临时文件后复用 DocPreview。
     */
    @JavascriptInterface
    fun previewLocal(name: String, dataUrl: String): String {
        return try {
            val comma = dataUrl.indexOf(",")
            if (!dataUrl.startsWith("data:") || comma < 0) {
                return JSONObject().put("ok", false).put("error", "附件数据不可用").toString()
            }
            val base64 = dataUrl.substring(comma + 1)
            val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            val dir = java.io.File(activity.cacheDir, "preview-tmp").apply { mkdirs() }
            val safe = name.replace(Regex("[^a-zA-Z0-9._\\-\\u4e00-\\u9fa5]"), "_").ifBlank { "attachment.bin" }
            val f = java.io.File(dir, safe)
            f.writeBytes(bytes)
            val pv = ai.deepseek.harness.mobile.kernel.preview.DocPreview.preview(f)
            f.delete()
            if (pv.optString("kind") == "error") {
                return JSONObject().put("ok", false).put("error", pv.optString("error")).toString()
            }
            JSONObject().apply {
                put("preview", true)
                pv.keys().forEach { k -> put(k, pv.get(k)) }
            }.toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "预览失败").toString()
        }
    }
}
