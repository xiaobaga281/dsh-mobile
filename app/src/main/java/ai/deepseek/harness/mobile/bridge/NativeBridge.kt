package ai.deepseek.harness.mobile.bridge

import android.webkit.WebView
import ai.deepseek.harness.mobile.MainActivity
import org.json.JSONObject

/**
 * JS ↔ Native 桥的**装配门面**。
 *
 * 以前这里是 1374 行的上帝对象：设备、网络、智能体、内核、语音、通知全塞在一个类里，
 * 加一个能力要在同一个文件里翻来翻去。现在按域拆成九个 bridge，各自只认识自己那摊事，
 * 本类只剩三件工作：
 *
 *  1. 建一个共享 [BridgeCore]（Activity / WebView / prefs / 回传出口）；
 *  2. 把九个域实例注册成前端的九个命名空间（`DSHNativeDevice` … `DSHNativeNotify`），
 *     前端用一行 Proxy 合成原来的 `window.DSHNative`，业务代码零改动；
 *  3. 把 Activity 侧的反向调用（语音状态、权限回调）转发到对应域。
 *
 * 新增能力的落点很明确：找个域加方法，或新建一个 `XxxBridge` 并在这里挂一行。
 */
class NativeBridge(
    activity: MainActivity,
    webView: WebView,
    onVoiceRequest: (() -> Unit)? = null,
    stickerStore: ai.deepseek.harness.mobile.kernel.StickerStore? = null,
) {

    val core = BridgeCore(activity, webView, onVoiceRequest, stickerStore)

    val device = DeviceBridge(core)
    val host = HostBridge(core)
    val net = NetBridge(core)
    val agent = AgentBridge(core)
    val account = AccountBridge(core)
    val voice = VoiceBridge(core)
    val kernel = KernelBridge(core)
    val notify = NotifyBridge(core)
    val link = LinkBridge(core)
    val update = UpdateBridge(core)

    /**
     * 注册到 WebView 的命名空间。顺序无关（方法名互不重复），
     * 前端合成时后者覆盖同名，所以新增域请确认方法名没被占用。
     */
    val domains: List<Pair<String, Any>> = listOf(
        "DSHNativeDevice" to device,
        "DSHNativeHost" to host,
        "DSHNativeNet" to net,
        "DSHNativeAgent" to agent,
        "DSHNativeAccount" to account,
        "DSHNativeVoice" to voice,
        "DSHNativeKernel" to kernel,
        "DSHNativeNotify" to notify,
        "DSHNativeLink" to link,
        "DSHNativeSticker" to ai.deepseek.harness.mobile.bridge.StickerBridge(core),
        "DSHNativeTeam" to ai.deepseek.harness.mobile.bridge.TeamBridge(core),
        "DSHNativeUpdate" to update,
    )

    init {
        // 内核级事件出口必须在桥接创建时就装上：present 交付物与定时任务到期
        // 都可能发生在没有任何活跃轮次的时候（手动调工具、后台到点）。
        activity.kernel.eventSink = { ev ->
            core.raw(
                "window.DSHHost&&window.DSHHost.onKernelEvent&&window.DSHHost.onKernelEvent(" +
                    JSONObject.quote(ev.toString()) + ")"
            )
        }
    }

    /* ---------------- Activity 侧反向调用（保持原签名，调用点不用改） ---------------- */

    fun permissionResult(name: String, granted: Boolean, canAsk: Boolean) =
        device.permissionResult(name, granted, canAsk)

    fun deliverVoice(text: String) = voice.deliverVoice(text)

    fun voiceEvent(state: String, text: String, clip: String = "", durMs: Int = 0) =
        voice.voiceEvent(state, text, clip, durMs)

    fun voiceLevel(rmsRaw: Float) = voice.voiceLevel(rmsRaw)

    fun voiceLevel01(v: Float) = voice.voiceLevel01(v)

    fun voiceHoldReleased() = voice.voiceHoldReleased()

    fun asrModelProgress(done: Long, total: Long, err: String?) =
        voice.asrModelProgress(done, total, err)

    fun asrModelDone(ok: Boolean) = voice.asrModelDone(ok)
}
