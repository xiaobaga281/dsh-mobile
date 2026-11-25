package ai.deepseek.harness.mobile.voice

/**
 * 「这句话该由谁念」—— 语音输出的唯一岔路口。
 *
 * 内置神经模型已整条移除，现在只有两条路：
 *  · 用户配好了云端 TTS → 云端（音色/模型由厂商决定）
 *  · 没配、或文本过长不适合一次请求 → 设备自带的系统 TTS
 *
 * 云端请求失败不算路由决策：[VoiceCenter] 拿到 null 会当场回退系统引擎，
 * 保证任何情况下都有声音。这个类是纯函数，规则在 JVM 单测里逐条断言。
 */
object TtsRouter {

    enum class Engine { CLOUD, SYSTEM }

    data class Decision(val engine: Engine, val reason: String)

    fun decide(text: String, cloudUsable: Boolean): Decision {
        val body = text.trim()
        if (body.isEmpty()) return Decision(Engine.SYSTEM, "没有可念的正文")
        if (!cloudUsable) return Decision(Engine.SYSTEM, "未配置云端语音模型，用系统 TTS")
        if (body.length > CloudTtsRequest.MAX_CHARS) {
            return Decision(Engine.SYSTEM, "文本超过 ${CloudTtsRequest.MAX_CHARS} 字，交系统 TTS 分段念")
        }
        return Decision(Engine.CLOUD, "已配置的云端语音模型")
    }
}
