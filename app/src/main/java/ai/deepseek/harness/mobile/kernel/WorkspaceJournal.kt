package ai.deepseek.harness.mobile.kernel

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 工作区改动日志 —— 改之前的原样存档，支持一键撤回。
 *
 * 为什么需要它：桌面上改坏了可以 git checkout；手机工作区绝大多数不是 git 仓库，
 * 而 Agent 的 write / edit / delete 是不可逆的。没有这一层，
 * 「让 Agent 帮忙整理一下文件」就是一次不可撤销的赌博。
 *
 * 设计取舍：
 *   - **只存被改过的那个文件**，不复制整个工作区（用户可能选了几个 GB 的目录）
 *   - 单文件上限 [MAX_FILE]，超出的只记录元信息（告知无法撤回，而不是假装能）
 *   - 环形保留 [MAX_ENTRIES] 条 / [MAX_TOTAL] 总量，超出按时间淘汰最旧
 *   - 全部落在 `.dsh/journal` 下，且 .dsh 不进 glob/grep/list
 *
 * 不做「按工具调用分组的事务」：那需要跨工具状态机，
 * 而真实使用中用户要撤的通常是「刚才那一步」，单条粒度够用且可预期。
 */
class WorkspaceJournal(private val workspace: Workspace, private val dir: File) {

    data class Entry(
        val seq: Int,
        val at: Long,
        val tool: String,
        val path: String,
        val existed: Boolean,
        val saved: Boolean,
        val size: Long,
    )

    companion object {
        const val MAX_FILE = 4L * 1024 * 1024
        const val MAX_ENTRIES = 200
        const val MAX_TOTAL = 64L * 1024 * 1024
        private const val INDEX = "journal.json"
    }

    private val lock = Any()

    private fun indexFile(): File = File(dir, INDEX)

    private fun readIndex(): JSONArray = try {
        val f = indexFile()
        if (!f.exists()) JSONArray() else JSONArray(f.readText())
    } catch (_: Throwable) {
        JSONArray()
    }

    private fun writeIndex(arr: JSONArray) {
        runCatching {
            dir.mkdirs()
            indexFile().writeText(arr.toString())
        }
    }

    /** 写操作前调用：把当前内容存档。返回条目序号（无法存档时返回 -1） */
    fun record(f: File, tool: String): Int = synchronized(lock) {
        val rel = runCatching { workspace.relative(f) }.getOrDefault(f.name)
        val existed = f.exists() && f.isFile
        val size = if (existed) f.length() else 0L
        val arr = readIndex()
        val seq = ((arr.optJSONObject(arr.length() - 1)?.optInt("seq") ?: 0) + 1)
        val saved = existed && size <= MAX_FILE
        if (saved) {
            runCatching {
                val slot = File(dir, seq.toString()).apply { mkdirs() }
                f.copyTo(File(slot, "before.bin"), overwrite = true)
            }.onFailure { return@synchronized -1 }
        }
        arr.put(JSONObject().apply {
            put("seq", seq)
            put("at", System.currentTimeMillis())
            put("tool", tool)
            put("path", rel)
            put("existed", existed)
            put("saved", saved)
            put("size", size)
        })
        prune(arr)
        writeIndex(arr)
        seq
    }

    /** 超出保留上限时从最旧开始删（索引与存档目录一起清理） */
    private fun prune(arr: JSONArray) {
        val list = (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
        if (list.size <= MAX_ENTRIES && list.sumOf { it.optLong("size") } <= MAX_TOTAL) return
        val keep = ArrayDeque<JSONObject>()
        var total = 0L
        for (e in list.asReversed()) {
            val s = e.optLong("size")
            if (keep.size >= MAX_ENTRIES) break
            if (total + s > MAX_TOTAL && keep.isNotEmpty()) break
            keep.addFirst(e); total += s
        }
        val keepSeqs = keep.map { it.optInt("seq") }.toSet()
        list.filter { it.optInt("seq") !in keepSeqs }.forEach { e ->
            runCatching { File(dir, e.optInt("seq").toString()).deleteRecursively() }
        }
        while (arr.length() > 0) arr.remove(arr.length() - 1)
        keep.forEach { arr.put(it) }
    }

    /** 最近的改动，新的在前 */
    fun list(limit: Int = 20): List<Entry> = synchronized(lock) {
        val arr = readIndex()
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Entry(
                o.optInt("seq"), o.optLong("at"), o.optString("tool"), o.optString("path"),
                o.optBoolean("existed"), o.optBoolean("saved"), o.optLong("size"),
            )
        }.sortedByDescending { it.seq }.take(limit)
    }

    /**
     * 撤回某一条：把存档写回原路径；原来不存在就删掉现在这个文件。
     * 撤回后该条从索引里移除（不能重复撤），避免「撤两次」造成状态倒退。
     */
    fun restore(seq: Int): JSONObject = synchronized(lock) {
        val arr = readIndex()
        var found: JSONObject? = null
        var idx = -1
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optInt("seq") == seq) { found = o; idx = i; break }
        }
        val e = found ?: return JSONObject().put("ok", false).put("error", "没有这条改动记录：$seq")
        val target = try {
            workspace.resolve(e.optString("path"))
        } catch (t: Throwable) {
            return JSONObject().put("ok", false).put("error", "路径不可用：${t.message}")
        }
        val existed = e.optBoolean("existed")
        val saved = e.optBoolean("saved")
        if (existed && !saved) {
            return JSONObject().put("ok", false)
                .put("error", "这个文件当时超过 ${MAX_FILE / 1024 / 1024}MB，没有存档，无法撤回")
        }
        val result = runCatching {
            if (existed) {
                val backup = File(File(dir, seq.toString()), "before.bin")
                if (!backup.exists()) return@runCatching "存档已过期（可能被清理），无法撤回"
                target.parentFile?.mkdirs()
                backup.copyTo(target, overwrite = true)
                "已还原 ${workspace.relative(target)}"
            } else {
                if (target.exists()) target.deleteRecursively()
                "已删除 ${workspace.relative(target)}（这个文件是那次操作新建的）"
            }
        }.getOrElse { t -> return JSONObject().put("ok", false).put("error", t.message ?: "撤回失败") }
        arr.remove(idx)
        writeIndex(arr)
        runCatching { File(dir, seq.toString()).deleteRecursively() }
        JSONObject().put("ok", true).put("note", result)
    }

    fun clear(): Int = synchronized(lock) {
        val n = readIndex().length()
        runCatching { dir.deleteRecursively() }
        n
    }

    fun json(): JSONObject = JSONObject().apply {
        put("entries", JSONArray(list(50).map { e ->
            JSONObject().apply {
                put("seq", e.seq); put("at", e.at); put("tool", e.tool); put("path", e.path)
                put("saved", e.saved); put("size", e.size)
            }
        }))
        put("total", readIndex().length())
        put("dir", dir.absolutePath)
    }
}
