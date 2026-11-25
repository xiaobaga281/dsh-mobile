package ai.deepseek.harness.mobile.kernel.mission

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * `missions.json` 的持久化。
 *
 * 为什么是快照而不是 append-only JSONL：Mission 的状态迁移很少（开始/结算/定时推进），
 * 但读非常频繁（对话卡、进行中带、任务页每次刷新）。快照 + 原子替换实现更小、读取更直接，
 * 也不需要 JSONL 的压缩/重放逻辑；这与项目里已验证的 [ai.deepseek.harness.mobile.kernel.schedule.ScheduleStore]
 * 用的是同一套「先写 .tmp 再 rename」的保命写法。
 *
 * 数据损坏或版本高于本版本时：不覆盖、不猜，原文件改名留档，返回空账本并记录日志。
 */
class MissionStore(
    private val file: File,
    private val log: (String) -> Unit = {},
) {

    /** 读取账本；文件不存在返回空列表。 */
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
            val id = o.optString("id")
            if (id.isBlank()) {
                log("mission 第 $i 条缺少 id，已跳过")
                continue
            }
            out.add(o)
        }
        return out
    }

    /** 原子写：先写 .tmp 再 rename；rename 失败退化为直接写，至少不丢数据。 */
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
            log("mission 写入失败：${t.message}")
            runCatching { tmp.delete() }
            throw t
        }
    }

    /** 保留原文件，别让下一次写入把「看不懂的数据」直接盖掉。 */
    private fun quarantine(reason: String) {
        val backup = File(file.parentFile, file.name + ".bad-" + System.currentTimeMillis())
        runCatching {
            if (file.renameTo(backup)) {
                log("mission 账本$reason，已留档为 ${backup.name}")
            } else {
                log("mission 账本$reason，且留档失败（原文件保持不变）")
            }
        }.onFailure { log("mission 账本$reason：${it.message}") }
    }

    companion object {
        const val VERSION = 1
    }
}
