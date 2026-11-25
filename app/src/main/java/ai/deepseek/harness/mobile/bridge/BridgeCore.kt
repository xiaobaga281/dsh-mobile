package ai.deepseek.harness.mobile.bridge

import android.content.Context
import android.content.SharedPreferences
import android.webkit.WebView
import ai.deepseek.harness.mobile.MainActivity
import org.json.JSONObject

/**
 * 各域桥接共享的宿主上下文。
 *
 * 拆域之后，每个 bridge 只拥有自己那块能力，但都需要同一份
 * Activity / WebView / SharedPreferences，以及唯一的「回传 JS」出口。
 * 把出口收到这里有两个好处：
 *  - 所有回调都在主线程、格式一致（`window.DSHHost.<fn>(id, payload)`）；
 *  - 域类里 `activity` / `webView` / `prefs` / `emit` 这些名字保持不变，
 *    迁移是纯搬迁，不用逐行改写调用点。
 */
class BridgeCore(
    val activity: MainActivity,
    val webView: WebView,
    val onVoiceRequest: (() -> Unit)? = null,
    val stickerStore: ai.deepseek.harness.mobile.kernel.StickerStore? = null,
) {

    /**
     * 全进程共用的那一份偏好存储。
     *
     * 必须走 applicationContext + 进程内单例：WebView 重建（或域被第二次装配）时
     * 会 new 出新的 BridgeCore，而 Activity context 上的 SharedPreferences
     * 会得到**另一个**实例 —— 两边内存 map 不互通，于是出现「配对明明成功了，
     * 换个接口又说还没配对」这种怪事（实测：写入实例 readback 48 字符，
     * 另一个实例读到空）。
     */
    val prefs: SharedPreferences by lazy {
        ai.deepseek.harness.mobile.AppPrefs.get(activity)
    }

    /**
     * 正在进行的 HTTP 连接（按请求 id）。会话流式回复在 agent 域，
     * 通用 HTTP 代理在 net 域，两者都要能按 id 取消，所以挂在共享层。
     */
    val streams = java.util.concurrent.ConcurrentHashMap<String, java.net.HttpURLConnection>()

    /** 账号令牌：net 域取余额、agent 域走 Messages 协议都要用，共用一份实例 */
    val auth by lazy { ai.deepseek.harness.mobile.account.DeepSeekAuth(activity) }

    /** 直接执行一段 JS（调用方负责拼 window.DSHHost.xxx） */
    fun raw(js: String) {
        webView.post { webView.evaluateJavascript("$js;", null) }
    }

    /** 统一回调：window.DSHHost.<fn>(id, payload) */
    fun emit(fn: String, id: String, payload: String) {
        raw(
            "window.DSHHost&&window.DSHHost.$fn&&window.DSHHost.$fn(" +
                JSONObject.quote(id) + "," + JSONObject.quote(payload) + ")"
        )
    }

    /**
     * 对象直发：payload 以 JS 对象字面量内联，跳过 Kotlin 侧 quote 转义扫描与前端 JSON.parse。
     *
     * JSON 转义集是 JS 字符串转义的子集，JSONObject.toString() 的输出本身就是合法的
     * JS 对象字面量 —— 唯一例外是 U+2028/U+2029（合法 JSON 内容，但 ES2019 之前的
     * JS 引擎里连放在字面量里都非法），这里做廉价 sanitize 保长期未更新设备。
     * evaluateJavascript 走 V8 编译器、不经 HTML 解析器，无 `</script>` 注入面；
     * payload 来自内核自己构造的 JSONObject，不是外部输入原样拼接。
     * 只用于 onAgent 这条高频通道；onDelta/onError 等低频回调继续走 [emit]。
     */
    fun emitObject(fn: String, id: String, obj: JSONObject) {
        val lit = obj.toString()
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        raw(
            "window.DSHHost&&window.DSHHost.$fn&&window.DSHHost.$fn(" +
                JSONObject.quote(id) + "," + lit + ")"
        )
    }

    /** 短提示（各域都用得上，UI 入口统一在设备域） */
    fun toast(msg: String) {
        android.widget.Toast.makeText(activity, msg, android.widget.Toast.LENGTH_SHORT).show()
    }
}


