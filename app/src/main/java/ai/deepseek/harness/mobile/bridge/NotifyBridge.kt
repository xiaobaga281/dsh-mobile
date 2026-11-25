package ai.deepseek.harness.mobile.bridge

import ai.deepseek.harness.mobile.AppPrefs

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import ai.deepseek.harness.mobile.MainActivity
import ai.deepseek.harness.mobile.glass.GlassSheet
import ai.deepseek.harness.mobile.glass.HonorGlass
import org.json.JSONObject

/**
 * 通知域：会话运行通知、电源与自启动设置、桥接就绪回调。
 */
class NotifyBridge(private val core: BridgeCore) {

    private val activity get() = core.activity
    private val webView get() = core.webView
    private val prefs get() = core.prefs
    private fun emitRaw(js: String) = core.raw(js)
    private fun emit(fn: String, id: String, payload: String) = core.emit(fn, id, payload)

    /* ---------------- 会话运行通知（系统通知，非厂商胶囊） ---------------- */

    @JavascriptInterface
    fun sessionBegin(title: String, sessionId: String) {
        ai.deepseek.harness.mobile.MainActivity.sessionStarted()
        try {
            ai.deepseek.harness.mobile.notify.RunService.begin(
                activity.applicationContext, title, sessionId ?: ""
            )
        } catch (_: Throwable) {}
    }

    @JavascriptInterface
    fun sessionProgress(text: String, sessionId: String) {
        try {
            ai.deepseek.harness.mobile.notify.RunService.progress(
                activity.applicationContext, text, sessionId ?: ""
            )
        } catch (_: Throwable) {}
    }

    @JavascriptInterface
    fun sessionEnd(sessionId: String) {
        ai.deepseek.harness.mobile.MainActivity.sessionFinished()
        try {
            ai.deepseek.harness.mobile.notify.RunService.finish(
                activity.applicationContext, "done", "", sessionId ?: ""
            )
        } catch (_: Throwable) {}
    }

    /** kind: done | fail | stopped；summary 用于「已完成」通知正文 */
    @JavascriptInterface
    fun sessionEndWith(kind: String, summary: String, sessionId: String) {
        ai.deepseek.harness.mobile.MainActivity.sessionFinished()
        try {
            ai.deepseek.harness.mobile.notify.RunService.finish(
                activity.applicationContext, kind.ifBlank { "done" }, summary, sessionId ?: ""
            )
        } catch (_: Throwable) {}
    }

    /**
     * 需要用户处理（审批 / 追问 / 计划评审）：后台或用户不在该会话时发提醒。
     * sessionId 用来判断「用户是不是正看着这个会话」，空值按旧行为（在应用内就不提醒）。
     */
    @JavascriptInterface
    fun sessionAttention(title: String, text: String, sessionId: String) {
        try {
            ai.deepseek.harness.mobile.notify.RunService.attention(
                activity.applicationContext, title, text, sessionId ?: ""
            )
        } catch (_: Throwable) {}
    }

    /** 前端切换会话时上报，决定还要不要补提醒 */
    @JavascriptInterface
    fun setActiveSession(sessionId: String) {
        try {
            ai.deepseek.harness.mobile.notify.RunService.setActiveSession(sessionId ?: "")
        } catch (_: Throwable) {}
    }

    /* 后台运行三件套：前台服务（已在 sessionBegin 起）+ 电池白名单 + 厂商启动管理 */
    @JavascriptInterface
    fun powerStatus(): String = try {
        JSONObject().apply {
            put("ok", true)
            put("overlay", android.provider.Settings.canDrawOverlays(activity))
            put("battery", activity.isIgnoringBattery())
            put(
                "notifications",
                androidx.core.app.NotificationManagerCompat.from(activity).areNotificationsEnabled()
            )
            put("sessionRunning", ai.deepseek.harness.mobile.MainActivity.sessionRunning)
        }.toString()
    } catch (t: Throwable) {
        JSONObject().put("ok", false).put("error", t.message ?: "detect failed").toString()
    }

    @JavascriptInterface
    fun requestIgnoreBattery() {
        activity.runOnUiThread { activity.requestIgnoreBattery() }
    }

    @JavascriptInterface
    fun openStartupSettings() {
        activity.runOnUiThread { activity.openStartupSettings() }
    }

    /* 运行通知：状态快照 + 跳系统通知设置 */
    @JavascriptInterface
    fun notifyInfo(): String = try {
        ai.deepseek.harness.mobile.notify.RunService.info(activity)
    } catch (t: Throwable) {
        JSONObject().put("ok", false).put("error", t.message ?: "detect failed").toString()
    }

    /**
     * 「完成后通知」开关（设置 → Agent）。前端在启动与切换时各推一次，
     * 原生这边只认 [AppPrefs]（与 [RunService.finish] 同一份），不另存一份状态 ——
     * 以前这个开关只写在 localStorage、原生完全没读，等于装饰品。
     */
    @JavascriptInterface
    fun setNotifyDone(on: Boolean) {
        AppPrefs.setNotifyDone(activity, on)
    }

    @JavascriptInterface
    fun notifyOpenSettings() {
        activity.runOnUiThread {
            runCatching { ai.deepseek.harness.mobile.notify.RunService.openSettings(activity) }
        }
    }

    /** 未授权悬浮窗时引导到系统设置 */

    /* ---------------- 运行时权限（补充） ---------------- */

    @JavascriptInterface
    fun onReady() {
        // 把系统栏高度交给前端做安全区微调
        activity.runOnUiThread {
            val root: View = activity.findViewById(android.R.id.content)
            val bars = ViewCompat.getRootWindowInsets(root)
                ?.getInsets(WindowInsetsCompat.Type.systemBars())
            val density = activity.resources.displayMetrics.density
            val cssPx = ((bars?.top ?: 0) / density)
            val bottomPx = ((bars?.bottom ?: 0) / density)
            // 通透能力状态不再往 JS 推：前端没有 onGlassInfo 这条通道（设备域已经报过
            // honorGlass 可用性），曾经往不存在的处理器上推事件，纯死流量
            webView.evaluateJavascript(
                "document.documentElement.style.setProperty('--safe-top','${cssPx + 8}px');",
                null,
            )
        }
    }
}
