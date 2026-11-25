package ai.deepseek.harness.mobile.update

import org.json.JSONObject

/**
 * 更新下载的状态总线。
 *
 * 下载跑在 [UpdateService]（前台服务）里，而 App 可能已经被切到后台、WebView 甚至被回收，
 * 所以状态有两路出口：
 *   · [listener] —— 桥接层注册，转成 `window.DSHHost.onUpdate` 推给前端（App 在前台时才有意义）；
 *   · 通知栏 —— 服务自己维护，后台时用户看这里。
 *
 * 用 object 而不是让服务持有桥：服务可能比 WebView 活得久（后台下载正是这么用的），
 * 反过来让服务依赖桥会把两者生命周期绑死。
 */
object UpdateBus {

    /** 桥接层在初始化时挂上；App 进程被杀后自然为 null，此时只走通知栏 */
    @Volatile
    var listener: ((JSONObject) -> Unit)? = null

    /** 最近一次状态，页面重载后 UpdateBridge 可以据此还原界面 */
    @Volatile
    var last: JSONObject? = null

    fun push(state: JSONObject) {
        last = state
        runCatching { listener?.invoke(state) }
    }

    fun reset() {
        last = null
        listener = null
    }
}
