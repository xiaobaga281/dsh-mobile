package ai.deepseek.harness.mobile.bridge

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import ai.deepseek.harness.mobile.MainActivity
import ai.deepseek.harness.mobile.glass.HonorGlass
import org.json.JSONObject

/**
 * 设备域：设备信息、运行时权限、联系人、触感、Toast、分享、键盘、系统栏、原生通透面板。
 */
class DeviceBridge(private val core: BridgeCore) {

    private val activity get() = core.activity
    private val webView get() = core.webView
    private val prefs get() = core.prefs
    private fun emitRaw(js: String) = core.raw(js)

    @JavascriptInterface
    fun getDeviceInfo(): String {
        val root: View = activity.findViewById(android.R.id.content)
        val bars = ViewCompat.getRootWindowInsets(root)
            ?.getInsets(WindowInsetsCompat.Type.systemBars())
        return JSONObject().apply {
            put("model", "${Build.BRAND} ${Build.MODEL}")
            put("os", "Android ${Build.VERSION.RELEASE}")
            put("sdk", Build.VERSION.SDK_INT)
            put("dark", activity.isSystemDark())
            put("statusBar", bars?.top ?: 0)
            put("navigationBar", bars?.bottom ?: 0)
            put("honorGlass", HonorGlass.isAvailable(activity))
        }.toString()
    }

    /* ---------------- 运行时权限 ---------------- */

    private val permGroups = arrayOf("mic", "location", "contacts", "camera", "media", "notifications")

    /** 各权限组状态：{mic:{granted,canAsk}, location:{...}, ...} */
    @JavascriptInterface
    fun getPermissionState(): String = JSONObject().apply {
        for (g in permGroups) {
            put(g, JSONObject().put("granted", activity.hasPermGroup(g)).put("canAsk", activity.canRequestGroup(g)))
        }
    }.toString()

    /** 按组拉起系统授权弹窗（结果经 DSHHost.onPermission 逐组回传） */
    @JavascriptInterface
    fun requestPermission(group: String) {
        activity.runOnUiThread { activity.requestPermGroup(group) }
    }

    /** 一键全部允许 */
    @JavascriptInterface
    fun requestAllPermissions() {
        activity.runOnUiThread { activity.requestAllPermGroups() }
    }

    /** 跳到「应用信息 → 权限」，用于永久拒绝后的补救 */
    @JavascriptInterface
    fun openAppSettings() {
        activity.runOnUiThread { activity.openAppSettingsPage() }
    }

    /**
     * 拉起当前输入法的软键盘（语音输入交给键盘自己的麦克风）。
     * 系统没有「替用户按 IME 麦克风键」的公开 API：Gboard 等键盘的语音键
     * 只能在键盘可见时由用户点。这里把焦点和键盘一起就位，剩下的交给键盘。
     */
    @JavascriptInterface
    fun showKeyboard(): Boolean = try {
        activity.runOnUiThread {
            webView.requestFocus()
            val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE)
                as? android.view.inputmethod.InputMethodManager
            imm?.showSoftInput(webView, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        }
        true
    } catch (_: Throwable) { false }

    /** Activity 在系统弹窗返回后调用 */
    fun permissionResult(name: String, granted: Boolean, canAsk: Boolean) {
        emitRaw(
            "window.DSHHost&&window.DSHHost.onPermission&&window.DSHHost.onPermission(" +
                JSONObject.quote(name) + "," + granted + "," + canAsk + ")"
        )
    }

    @JavascriptInterface
    fun haptic(kind: String) {
        activity.runOnUiThread {
            val vibrator = activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return@runOnUiThread
            if (!vibrator.hasVibrator()) return@runOnUiThread
            val ms = when (kind) {
                "heavy" -> 18L
                "medium" -> 11L
                else -> 7L
            }
            vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    /**
     * 写系统剪贴板。
     *
     * 前端优先走 `navigator.clipboard`，但 WebView 里它是 secure-context 限定的，
     * `file://` 加载的页面拿不到，`Native.copy` 才是真正的落地路径。
     * 返回是否写成功，让前端能给出「已复制」还是「长按手动复制」。
     */
    @JavascriptInterface
    fun copy(text: String): Boolean = try {
        val cm = activity.getSystemService(android.content.ClipboardManager::class.java)
        cm.setPrimaryClip(android.content.ClipData.newPlainText("dsh", text))
        true
    } catch (t: Throwable) {
        android.util.Log.w("DSH/Device", "clipboard: ${t.message}")
        false
    }

    @JavascriptInterface
    fun share(text: String) {
        activity.runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            activity.startActivity(
                Intent.createChooser(send, "分享会话")
            )
        }
    }

    /** 分享工作区里的文件（走 FileProvider 给真文件，不是一段文字） */
    @JavascriptInterface
    fun shareFile(path: String): String {
        val f = FileIntents.resolve(activity, path)
            ?: return JSONObject().put("ok", false).put("error", "文件不存在或不在工作区").toString()
        return FileIntents.share(activity, f)
    }

    /**
     * 前端自改（设置面板入口）。Agent 走同名的 `self_modify` 工具，两者共用
     * `kernel/dev/SelfModify` 这一份实现，避免面板和工具各写一套状态。
     */
    @JavascriptInterface
    fun selfModify(action: String): String {
        val sm = ai.deepseek.harness.mobile.kernel.dev.SelfModify
        return try {
            when (action) {
                "status" -> sm.status(activity).put("ok", true).toString()
                "enable" -> JSONObject().put("ok", true).put("message", sm.setEnabled(activity, true)).toString()
                "disable" -> JSONObject().put("ok", true).put("message", sm.setEnabled(activity, false)).toString()
                "rebuild" -> {
                    val r = sm.rebuild(activity)
                    JSONObject().put("ok", r.ok).put("message", r.message).toString()
                }
                "restore" -> JSONObject().put("ok", true).put("message", sm.restore(activity)).toString()
                "reload" -> {
                    sm.reloadHook?.invoke()
                    JSONObject().put("ok", sm.reloadHook != null)
                        .put("message", if (sm.reloadHook != null) "正在重载" else "当前页面不支持重载")
                        .toString()
                }
                else -> JSONObject().put("ok", false).put("error", "未知动作：$action").toString()
            }
        } catch (e: Throwable) {
            android.util.Log.w("DSHSelfModify", "selfModify($action) 失败：${e.message}")
            JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName).toString()
        }
    }

    @JavascriptInterface
    fun setSystemBars(dark: Boolean) {
        prefs.edit().putBoolean("barDark", dark).apply()
        activity.runOnUiThread { activity.applyBarAppearance(dark) }
    }
}
