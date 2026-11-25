package ai.deepseek.harness.mobile.bridge

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * 语音域：端侧识别状态机、音量包络、语音模型下载与清理。
 */
class VoiceBridge(private val core: BridgeCore) {

    private val activity get() = core.activity
    private fun emitRaw(js: String) = core.raw(js)
    private fun toast(msg: String) = core.toast(msg)
    private val onVoiceRequest get() = core.onVoiceRequest


    /** 由 Activity 在语音识别返回后调用，把文字回填到输入框。 */
    fun deliverVoice(text: String) {
        if (text.isBlank()) return
        emitRaw("window.DSHHost&&window.DSHHost.onVoice&&window.DSHHost.onVoice(" + JSONObject.quote(text) + ")")
    }

    /** 语音面板状态：listening / thinking / partial / result / error / cancelled */
    /**
     * @param clip  这次录音的 wav 路径（空 = 没有录音，前端不画语音条）
     * @param durMs 录音时长；只在识别成功后有意义
     */
    fun voiceEvent(state: String, text: String, clip: String = "", durMs: Int = 0) {
        emitRaw(
            "window.DSHHost&&window.DSHHost.onVoiceEvent&&window.DSHHost.onVoiceEvent(" +
                JSONObject.quote(state) + "," + JSONObject.quote(text) + "," +
                JSONObject.quote(clip) + "," + durMs + ")"
        )
    }

    /** 音量（0..1），驱动波形 */
    fun voiceLevel(rmsRaw: Float) {
        val level = ((rmsRaw + 2f) / 12f).coerceIn(0f, 1f)
        emitRaw("window.DSHHost&&window.DSHHost.onVoiceLevel&&window.DSHHost.onVoiceLevel(${level})")
    }

    /** 音量（已经是 0..1），端侧识别引擎直接给归一化值 */
    fun voiceLevel01(v: Float) {
        emitRaw("window.DSHHost&&window.DSHHost.onVoiceLevel&&window.DSHHost.onVoiceLevel(${v.coerceIn(0f, 1f)})")
    }

    @JavascriptInterface
    fun stopVoiceInput() {
        activity.runOnUiThread { activity.stopVoiceRecognition() }
    }

    /**
     * 长按按住说话的手势状态。
     *
     * press：手指正按在聊天输入框上（JS pointerdown 置位）。只有这个窗口内，
     * Activity 才接管可编辑文本的长按，避免设置页等其它文本框失去系统选择。
     * hold：本次长按已经真正开始收音。原生 Touch 监听据此在抬手时补发松手 ——
     * 输入框有草稿时 Android 会先启动文字选择，DOM 的 pointerup 可能被整段吞掉。
     */
    @JavascriptInterface
    fun setVoicePress(on: Boolean) {
        activity.voicePressArmed = on
        activity.voicePressAt = if (on) android.os.SystemClock.elapsedRealtime() else 0L
    }

    @JavascriptInterface
    fun setVoiceHold(on: Boolean) {
        activity.voiceHoldArmed = on
    }

    /** 原生补发「手指抬起」：让 JS 的按住说话正常收尾 */
    fun voiceHoldReleased() {
        emitRaw("window.DSHHost&&window.DSHHost.onVoiceHoldRelease&&window.DSHHost.onVoiceHoldRelease()")
    }

    /** 让系统 UI（权限弹窗、语音识别）跟随 App 内语言：zh / en / system */
    @JavascriptInterface
    fun setLanguage(tag: String) {
        activity.runOnUiThread { activity.applyAppLanguage(tag) }
    }

    @JavascriptInterface
    fun cancelVoiceInput() {
        activity.runOnUiThread { activity.cancelVoiceRecognition() }
    }

    /* ---------------- 语音输出（TTS） ---------------- */

    /** 朗读一段文本：配了云端模型走云端，否则用系统 TTS；失败自动回退 */
    @JavascriptInterface
    fun speak(text: String, rate: Float) {
        activity.runOnUiThread { activity.speak(text, rate) }
    }

    /** 合成一条语音消息：返回 {ok,dataUrl,durMs}，前端拿它画微信式语音条 */
    @JavascriptInterface
    fun synthVoice(text: String, rate: Float): String = activity.synthVoice(text, rate)

    /**
     * 异步合成：立即返回，完成后经 window.DSHHost.onSynth(id, json) 回传同一份 JSON。
     *
     * 为什么必须有这条：synthVoice 内部要做模型加载（首用数秒）、分段合成、系统引擎
     * 兜底（synthesizeToFile 逐段 latch 等待）——全部加起来可能十几秒。@JavascriptInterface
     * 同步调用会**冻住 JS 主线程**：toast 计时器停摆（「让它想一句」赖着不走）、
     * 页面划不动、返回键没反应、语音条永远转圈。合成必须离开 JS 线程。
     */
    @JavascriptInterface
    fun synthVoiceAsync(id: String, text: String, rate: Float) {
        Thread {
            val json = runCatching { activity.synthVoice(text, rate) }
                .getOrDefault("""{"ok":false,"error":"合成异常"}""")
            emitRaw(
                "window.DSHHost&&window.DSHHost.onSynth&&window.DSHHost.onSynth(" +
                    JSONObject.quote(id) + "," + JSONObject.quote(json) + ")"
            )
        }.apply { name = "dsh-synth-$id" }.start()
    }

    @JavascriptInterface
    fun stopSpeak() {
        activity.runOnUiThread { activity.stopSpeaking() }
    }

    /** 音色性别：auto / female / male。切换后下一次合成立即生效。 */
    @JavascriptInterface
    fun setVoiceGender(gender: String) {
        activity.setVoiceGender(gender)
    }

    @JavascriptInterface
    fun voiceGender(): String = activity.currentVoiceGender()


    /* ---------------- 云端语音模型（用户自己填厂商 API） ----------------

       主配置只有地址 / 密钥 / 模型名三项，音色与请求体模板在「高级」里。
       密钥不回传明文：读取接口只给 hasKey 与掩码，避免 JS 层乃至日志泄露。 */

    /** 读取云端 TTS 配置（脱敏）：{enabled,endpoint,model,voice,hasKey,error,...} */
    @JavascriptInterface
    fun cloudTtsConfig(): String = activity.cloudTtsConfig()

    /** 保存云端 TTS 配置；密钥留空 = 沿用旧值，传 clearKey:true 才真的清空 */
    @JavascriptInterface
    fun cloudTtsSet(json: String): String = activity.setCloudTtsConfig(json)

    /** 清空语音缓存，返回释放的字节数 */
    @JavascriptInterface
    fun voiceCacheClear(): Long = activity.voiceCacheClear()

    /** 五维微调：语速 / 音高 / 音量 / 明亮度 / 句间停顿，下一次朗读即生效 */
    @JavascriptInterface
    fun setVoiceTuning(rate: Float, pitch: Float, volume: Float, brightness: Float, pause: Float): String =
        activity.setVoiceTuning(rate, pitch, volume, brightness, pause)

    /** 音色实况：engine=system/cloud、当前音色名、五项微调与云端状态 */
    @JavascriptInterface
    fun voiceInfo(): String = activity.voiceInfoJson()

    /**
     * 返回是否真的启动了识别：没有识别服务时前端要立刻收起聆听面板，
     * 否则面板开着转圈、用户退不出去（陪伴「语音回聊」链路踩过）。
     */
    @JavascriptInterface
    fun startVoiceInput(): Boolean {
        val trigger = onVoiceRequest
        if (trigger == null) {
            toast("当前设备没有可用的语音识别服务")
            return false
        }
        activity.runOnUiThread {
            try { trigger() } catch (t: Throwable) {
                toast("无法启动语音识别")
            }
        }
        return true
    }

    /**
     * 自检入口：把一个 16k 单声道 wav 喂给离线识别引擎，结果打到 logcat（DSHVoice）。
     * 用来在没有真实麦克风的模拟器上验证「模型 + 解码 + 文本输出」是否正常。
     */
    /**
     * 读一条用户录音（wav）成 data URL，供气泡点击播放。
     * 每次只读一条、不常驻：10 秒 16k 单声道 ≈ 320KB，占着内存不值得。
     */
    @JavascriptInterface
    fun voiceClipData(path: String): String {
        val f = java.io.File(path)
        if (path.isBlank() || !f.isFile || f.length() <= 44 || f.length() > 8L * 1024 * 1024) {
            return "{}"
        }
        return runCatching {
            val bytes = f.readBytes()
            JSONObject()
                .put("dataUrl", "data:audio/wav;base64," +
                    android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                .put("bytes", bytes.size)
                .toString()
        }.getOrDefault("{}")
    }

    /* ---------------- 语音模型（可选增强包） ---------------- */

    @JavascriptInterface
    fun asrModelStatus(): String = activity.asrModelJson()

    @JavascriptInterface
    fun asrModelDownload() {
        activity.runOnUiThread { activity.asrModelDownload() }
    }

    @JavascriptInterface
    fun asrModelRemove(): Boolean = activity.asrModelRemove()

    /** 下载进度：done/total 字节，err 非空表示中断 */
    fun asrModelProgress(done: Long, total: Long, err: String?) {
        emitRaw(
            "window.DSHHost&&window.DSHHost.onAsrModelProgress&&window.DSHHost.onAsrModelProgress(" +
                "$done,$total," + (err?.let { JSONObject.quote(it) } ?: "null") + ")"
        )
    }

    fun asrModelDone(ok: Boolean) {
        emitRaw("window.DSHHost&&window.DSHHost.onAsrModelDone&&window.DSHHost.onAsrModelDone($ok)")
    }
}
