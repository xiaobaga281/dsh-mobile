package ai.deepseek.harness.mobile.kernel.mission

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * `wakes.json` 的持久化：统一唤醒队列（job 完成 / 定时到点）。
 *
 * 与 [MissionStore] 一样用快照 + 原子替换：唤醒记录很小，数量少；
 * 快照读取直接，不需要追加日志的重放/压缩。
 */
class WakeStore(
    private val file: File,
    private val log: (String) -> Unit = {},
) {

    fun load(): List<JSONObject> {
        if (!file.exists()) return emptyList()
        val root = try {
            JSONObject(file.readText())
        } catch (t: Throwable) {
            quarantine("无法解析")
            return emptyList()
        }
        val version = root.optInt("version", 0)
        if (version > VERSION) {
            quarantine("版本 $version 高于本版本支持的 $VERSION")
            return emptyList()
        }
        val items = root.optJSONArray("items") ?: return emptyList()
        val out = ArrayList<JSONObject>(items.length())
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            if (o.optString("id").isBlank()) continue
            out.add(o)
        }
        return out
    }

    @Synchronized
    fun save(items: Collection<JSONObject>) {
        val arr = JSONArray()
        items.forEach { arr.put(it) }
        val text = JSONObject().put("version", VERSION).put("items", arr).toString(2)
        val tmp = File(file.parentFile, file.name + ".tmp")
        file.parentFile?.mkdirs()
        try {
            tmp.writeText(text)
            if (!tmp.renameTo(file)) {
                file.writeText(text)
                tmp.delete()
            }
        } catch (t: Throwable) {
            log("wake 写入失败：${t.message}")
            runCatching { tmp.delete() }
            throw t
        }
    }

    private fun quarantine(reason: String) {
        val backup = File(file.parentFile, file.name + ".bad-" + System.currentTimeMillis())
        runCatching {
            if (file.renameTo(backup)) log("wake 队列$reason，已留档为 ${backup.name}")
            else log("wake 队列$reason，且留档失败（原文件保持不变）")
        }.onFailure { log("wake 队列$reason：${it.message}") }
    }

    companion object {
        const val VERSION = 1
    }
}
