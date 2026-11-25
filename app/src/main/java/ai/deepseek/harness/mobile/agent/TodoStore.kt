package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 待办清单 —— 对应桌面 Harness 的 `todo` 子系统。
 *
 * 桌面版把待办作为会话内可写状态（todo/write 事件）交给 UI 渲染；
 * 手机端同样按会话隔离落盘，模型通过 todo_write 维护，UI 读快照渲染。
 * 目的很实际：长任务在手机上容易被系统杀掉，待办落盘后重开还能接着做。
 */
class TodoStore(private val dir: File) {

    data class Item(val text: String, val done: Boolean)

    init { if (!dir.exists()) dir.mkdirs() }

    private fun file(sessionId: String): File =
        File(dir, sessionId.replace(Regex("""[^\w.-]"""), "_").ifBlank { "draft" } + ".json")

    fun read(sessionId: String): List<Item> {
        val f = file(sessionId)
        if (!f.exists()) return emptyList()
        return try {
            val arr = JSONArray(f.readText())
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Item(o.optString("text"), o.optBoolean("done"))
            }
        } catch (_: Throwable) { emptyList() }
    }

    fun write(sessionId: String, items: List<Item>): List<Item> {
        val arr = JSONArray()
        items.take(40).forEach { arr.put(JSONObject().put("text", it.text.take(200)).put("done", it.done)) }
        runCatching { file(sessionId).writeText(arr.toString()) }
        return items
    }

    fun clear(sessionId: String) { runCatching { file(sessionId).delete() } }
}
