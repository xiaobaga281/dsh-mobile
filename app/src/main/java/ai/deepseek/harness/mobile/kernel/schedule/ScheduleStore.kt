package ai.deepseek.harness.mobile.kernel.schedule

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * `schedule.json` 的持久化与 v1→v2 迁移。
 *
 * 与桌面 `packages/schedule/schedule/src/storage.ts` 的差异（有意为之，写在这里以免
 * 后来者以为是漏了）：
 *   - 桌面遇到一条坏记录会**拒绝整个 domain 打开**（fail closed）。手机端不能这么做：
 *     用户手上没有 CLI 可以修文件，一条坏记录不该让所有定时任务一起失效。
 *     手机策略 = 逐条隔离到 `schedule.quarantine.json`，其余照常加载，并在
 *     `schedule_list` 里把坏条目如实报出来。
 *   - 但**版本不认识**或**结构整体损坏**仍然 fail closed：这种情况下继续写回只会
 *     把用户数据写坏，宁可保持原文件不动并报错。
 */
class ScheduleStore(
    private val file: File,
    private val log: (String) -> Unit = {},
) {

    class LoadResult(
        val records: List<ScheduleRecord>,
        val quarantined: List<JSONObject>,
        /** 文件是 v1，调用方应尽快回写成 v2（幂等） */
        val migrated: Boolean,
    )

    private val quarantineFile: File
        get() = File(file.parentFile, "schedule.quarantine.json")

    /* ------------------------------------------------------------------ */

    fun load(): LoadResult {
        if (!file.exists()) return LoadResult(emptyList(), emptyList(), migrated = false)
        val root = try {
            JSONObject(file.readText())
        } catch (t: Throwable) {
            // 整体损坏：不猜、不覆盖，抛出去让上层记录并保留原文件
            throw IllegalStateException("schedule.json 无法解析：${t.message}", t)
        }
        val version = root.optInt("version", 1)
        if (version > VERSION) {
            throw IllegalStateException(
                "schedule.json 版本 $version 高于本版本支持的 $VERSION；" +
                    "可能是更新版本写下的数据，拒绝读取与覆盖（原文件保持不变）",
            )
        }
        val items = root.optJSONArray("items")
        if (items == null) {
            if (root.length() > 0) log("schedule.json 没有 items 数组，按空任务表处理")
            return LoadResult(emptyList(), emptyList(), migrated = version < VERSION)
        }
        val records = ArrayList<ScheduleRecord>(items.length())
        val quarantined = ArrayList<JSONObject>()
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i)
            if (o == null) {
                quarantined.add(JSONObject().put("index", i).put("raw", items.opt(i) ?: JSONObject.NULL))
                continue
            }
            val rec = ScheduleRecord.fromJson(o, log)
            if (rec == null) {
                quarantined.add(o)
                log("schedule 第 $i 条记录无效，已隔离")
            } else {
                records.add(rec)
            }
        }
        if (quarantined.isNotEmpty()) writeQuarantine(quarantined)
        return LoadResult(records, quarantined, migrated = version < VERSION)
    }

    /** 原子写：先写 .tmp 再 rename，避免写一半被进程杀掉留下半个 JSON */
    @Synchronized
    fun save(records: Collection<ScheduleRecord>) {
        val arr = JSONArray()
        records.forEach { arr.put(it.toJson()) }
        val root = JSONObject().put("version", VERSION).put("items", arr)
        val text = root.toString(2)
        val tmp = File(file.parentFile, file.name + ".tmp")
        file.parentFile?.mkdirs()
        try {
            tmp.writeText(text)
            if (!tmp.renameTo(file)) {
                // rename 失败（跨文件系统/被占用）退化为直接写，至少别丢数据
                file.writeText(text)
                tmp.delete()
            }
        } catch (t: Throwable) {
            log("schedule 写入失败：${t.message}")
            runCatching { tmp.delete() }
            throw t
        }
    }

    /**
     * 隔离区只追加不删除：坏记录原样留档，用户/开发者还能捞回来。
     * 同一 id 重复隔离时保留最新一份，避免文件无限膨胀。
     */
    private fun writeQuarantine(items: List<JSONObject>) {
        runCatching {
            val byKey = LinkedHashMap<String, JSONObject>()
            if (quarantineFile.exists()) {
                runCatching { JSONObject(quarantineFile.readText()) }
                    .getOrNull()
                    ?.optJSONArray("items")
                    ?.let { old ->
                        for (i in 0 until old.length()) {
                            old.optJSONObject(i)?.let { byKey[keyOf(it)] = it }
                        }
                    }
            }
            items.forEach { byKey[keyOf(it)] = it }
            val arr = JSONArray()
            byKey.values.forEach { arr.put(it) }
            quarantineFile.writeText(
                JSONObject()
                    .put("version", VERSION)
                    .put("note", "无法解码的 schedule 记录（未调度，未删除）")
                    .put("items", arr)
                    .toString(2),
            )
        }.onFailure { log("schedule 隔离区写入失败：${it.message}") }
    }

    private fun keyOf(o: JSONObject): String =
        o.optString("id").ifBlank { "index-" + o.optInt("index", -1) }

    companion object {
        const val VERSION = 2
    }
}
