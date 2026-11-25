package ai.deepseek.harness.mobile.kernel

import org.json.JSONObject
import java.io.File

/**
 * 生成模型配置（图片 / 视频）——`files/kernel/gen.json`，应用私有目录。
 *
 * {
 *   "image": { "url": "...", "key": "...", "model": "..." },
 *   "video": { "url": "...", "key": "...", "model": "..." }
 * }
 *
 * 空 / 缺段 = 未配置：图片退回内置 SVG 生成，视频不可用（如实告诉模型，不要假装生成了）。
 * 用户在「设置 → 生成模型」里填，Agent 侧只读。
 */
class GenConfig(private val file: File) {

    fun section(kind: String): JSONObject {
        val root = read()
        val s = root.optJSONObject(kind) ?: JSONObject()
        return JSONObject().apply {
            put("url", s.optString("url", ""))
            put("key", s.optString("key", ""))
            put("model", s.optString("model", ""))
            put("configured", s.optString("url").isNotBlank())
            // 探测习得的端点契约（modes/sizes 白名单等，GenProbe 写入）——原样带出
            s.optJSONObject("capabilities")?.let { put("capabilities", it) }
        }
    }

    fun set(kind: String, url: String, key: String, model: String) {
        val root = read()
        root.put(
            kind,
            JSONObject().apply {
                put("url", url.trim().trimEnd('/'))
                put("key", key.trim())
                put("model", model.trim())
                put("updatedAt", System.currentTimeMillis())
            },
        )
        runCatching {
            file.parentFile?.mkdirs()
            file.writeText(root.toString(2), Charsets.UTF_8)
        }
    }

    /** 写入探测习得的端点契约（GenProbe 产出）；换 URL 后旧契约由调用方负责清除 */
    fun setCapabilities(kind: String, contract: JSONObject) {
        val root = read()
        val s = root.optJSONObject(kind) ?: JSONObject()
        s.put("capabilities", contract)
        root.put(kind, s)
        runCatching {
            file.parentFile?.mkdirs()
            file.writeText(root.toString(2), Charsets.UTF_8)
        }
    }

    private fun read(): JSONObject {
        if (!file.exists()) return JSONObject()
        return runCatching { JSONObject(file.readText()) }.getOrNull() ?: JSONObject()
    }
}
