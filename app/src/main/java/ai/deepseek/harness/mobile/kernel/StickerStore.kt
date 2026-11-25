package ai.deepseek.harness.mobile.kernel

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 表情包仓库 —— 让 Agent 也能"发表情包"，像人在聊天里那样。
 *
 * 存 `files/kernel/stickers.json`（应用私有目录，卸载即删）：
 *   { "items": [ { id, name, kind: static|gif, mime, dataUrl, w, h, uses, lastUsedAt, by: user|agent } ] }
 *
 * dataUrl 直接内联：表情包通常几十到几百 KB，数量上限 200，
 * 比再引一套文件路径 + FileProvider 简单，且 Agent 端只需要 id/name 就能引用。
 */
class StickerStore(private val file: File) {

    companion object {
        private const val MAX_ITEMS = 200
    }

    private fun read(): JSONArray {
        if (!file.exists()) return JSONArray()
        return runCatching { JSONObject(file.readText()).optJSONArray("items") ?: JSONArray() }
            .getOrDefault(JSONArray())
    }

    private fun write(items: JSONArray) {
        runCatching {
            file.parentFile?.mkdirs()
            file.writeText(JSONObject().put("items", items).toString(2), Charsets.UTF_8)
        }
    }

    @Synchronized
    fun list(): JSONArray = read()

    @Synchronized
    fun find(id: String): JSONObject? {
        val items = read()
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            if (it.optString("id") == id) return it
        }
        return null
    }

    /** 添加或更新（同 id 覆盖）；超量丢最久没用过的 */
    @Synchronized
    fun add(entry: JSONObject): JSONObject {
        val items = read()
        val id = entry.optString("id").ifBlank { "s-" + System.currentTimeMillis().toString(36) }
        // 老条目已经有画面描述时不要被一次「加权」覆盖掉：描述比 id 更贵（要跑一次视觉模型）
        val prev = (0 until items.length()).mapNotNull { items.optJSONObject(it) }
            .firstOrNull { it.optString("id") == id }
        val merged = JSONObject().apply {
            put("id", id)
            put("name", entry.optString("name", "表情"))
            put("kind", entry.optString("kind", "static"))
            put("mime", entry.optString("mime", "image/png"))
            put("dataUrl", entry.optString("dataUrl"))
            put("w", entry.optInt("w", 0))
            put("h", entry.optInt("h", 0))
            put("by", entry.optString("by", "user"))
            put("desc", entry.optString("desc").ifBlank { prev?.optString("desc").orEmpty() })
            put("uses", entry.optInt("uses", 0))
            put("lastUsedAt", entry.optLong("lastUsedAt", 0))
            // order 只在「有人手动拖过」之后才存在（reorder 写入）。新条目一律 -1：
            // 既保留默认的常用优先排序，也让新表情落在已经排好的格子后面。
            put("order", prev?.optInt("order", -1) ?: -1)
            put("createdAt", entry.optLong("createdAt", System.currentTimeMillis()))
        }
        val kept = JSONArray()
        var replaced = false
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            if (it.optString("id") == id) { kept.put(merged); replaced = true } else kept.put(it)
        }
        if (!replaced) kept.put(merged)
        if (kept.length() > MAX_ITEMS) {
            val trimmed = JSONArray()
            for (i in maxOf(0, kept.length() - MAX_ITEMS) until kept.length()) trimmed.put(kept.optJSONObject(i))
            write(trimmed)
        } else {
            write(kept)
        }
        return merged
    }

    /** 用了一次：计数 + 时间（前端发送与 Agent 发送都走这里，使用频率会沉淀下来） */
    @Synchronized
    fun bump(id: String): JSONObject? {
        val items = read()
        var hit: JSONObject? = null
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            if (it.optString("id") == id) {
                it.put("uses", it.optInt("uses") + 1)
                it.put("lastUsedAt", System.currentTimeMillis())
                hit = it
            }
        }
        hit?.let { write(items) }
        return hit
    }

    /** 记下「这张图画的是什么」：视觉模型看过之后写回，清单里就能给模型看内容而不是只有 id */
    @Synchronized
    fun describe(id: String, desc: String): Boolean {
        if (desc.isBlank()) return false
        val items = read()
        var hit = false
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            if (it.optString("id") == id) { it.put("desc", desc.trim()); hit = true }
        }
        if (hit) write(items)
        return hit
    }

    @Synchronized
    fun remove(id: String): Boolean {
        val items = read()
        val kept = JSONArray()
        var removed = false
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            if (it.optString("id") == id) removed = true else kept.put(it)
        }
        if (removed) {
            // 删掉一个之后重排 order，否则前面的空洞会让下一次拖动排序落到意外的位置
            renumber(kept)
            write(kept)
        }
        return removed
    }

    /**
     * 手动排序：按前端给的 id 顺序重写数组，并给每条写回 order。
     *
     * 面板里的顺序此前一直是「常用优先」算出来的，人手拖过之后必须能压过它，
     * 所以这里落的是显式位置，而不是再存一份使用次数。
     */
    @Synchronized
    fun reorder(ids: List<String>): Boolean {
        if (ids.isEmpty()) return false
        val items = read()
        val byId = LinkedHashMap<String, JSONObject>()
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            byId[it.optString("id")] = it
        }
        val out = JSONArray()
        for (id in ids) byId.remove(id)?.let { item -> out.put(item) }
        // 前端没提到的（并发新增）原样跟在后面，不丢
        for (it in byId.values) out.put(it)
        renumber(out)
        write(out)
        return true
    }

    /** 让 order 与数组下标一致，中间不留空洞 */
    private fun renumber(items: JSONArray) {
        for (i in 0 until items.length()) items.optJSONObject(i)?.put("order", i)
    }

    /** 常用优先（uses 降序，再按最近使用） */
    @Synchronized
    fun ranked(): List<JSONObject> {
        val items = read()
        val list = ArrayList<JSONObject>()
        for (i in 0 until items.length()) items.optJSONObject(i)?.let { list.add(it) }
        return list.sortedWith(compareByDescending<JSONObject> { it.optInt("uses") }.thenByDescending { it.optLong("lastUsedAt") })
    }
}
