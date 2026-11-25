package ai.deepseek.harness.mobile.kernel

import ai.deepseek.harness.mobile.agent.SpillPolicy
import ai.deepseek.harness.mobile.kernel.mission.MissionRegistry
import ai.deepseek.harness.mobile.kernel.mission.WakeRouter
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 本地数据的「谁占多少、上限多少、超了怎么办」收在一处。
 *
 * 之前每个注册表各写一份常量（输出环、账本、唤醒队列、语音缓存、spill、改动存档），
 * 代码里都在、界面上一个都看不见 —— 用户感知存储的唯一方式变成「手机满了」。
 * 工作站的前提是**看得见自己占了多少**：这里只读与如实报告，唯一的删除动作是
 * 清溢出缓存（可再生），其余任何一项要删都是删用户的东西，不在这个入口里干。
 *
 * 不做的事：给会话日志加自动删除。日志是长期真相与上下文来源，静默裁历史
 * 比占空间更伤；它在这里以「无上限 + 手动删除入口在会话列表」如实标出。
 */
class StorageAudit(
    private val workspace: Workspace,
    private val configDir: File,
    private val filesDir: File,
    /** (可用, 总) 字节；由桥注入 StatFs，测试里给常量 */
    private val disk: () -> Pair<Long, Long> = { 0L to 0L },
    /** 会话日志的提醒阈值（生产用 [SESSIONS_WARN_BYTES]，测试里给小值） */
    private val sessionsWarnBytes: Long = SESSIONS_WARN_BYTES,
) {

    /**
     * 一份可渲染的存储清单。`cap = 0` 表示**没有上限**（note 里会说清为什么）。
     * 目录遍历都带字节数上限，超大工作区不会因为一次统计卡住主线程以外的东西。
     */
    fun stat(): JSONObject {
        val wsBytes = SpillPolicy.dirBytes(workspace.root, SCAN_LIMIT)
        val items = JSONArray()
        fun add(key: String, label: String, file: File, cap: Long, note: String, cleanable: Boolean = false, warnAt: Long = 0L) {
            val bytes = SpillPolicy.dirBytes(file, SCAN_LIMIT)
            val o = JSONObject().put("key", key).put("label", label)
                .put("path", displayPath(file))
                .put("bytes", bytes)
                .put("cap", cap).put("note", note).put("cleanable", cleanable)
            // 没有上限不等于「没人管」：到量要主动提醒，让用户自己决定删哪些会话
            if (warnAt > 0L && bytes > warnAt) o.put("warn", "已超过 " + humanMB(warnAt) + "，建议在会话列表里删掉不需要的")
            items.put(o)
        }
        add(
            "workspace", "工作区总计", workspace.root, 0L,
            "你自己的文件，不自动清理；上限取决于设备剩余空间",
        )
        add(
            "spill", "溢出缓存（" + SPILL_SUB + "）", File(workspace.root, SPILL_SUB), SpillPolicy.MAX_BYTES,
            "工具长输出的完整落点，模型可 read；超上限按最旧会话目录删，" + RETENTION_DAYS + " 天未用也清",
            cleanable = true,
        )
        add(
            "journal", "改动存档（.dsh/journal）", File(workspace.root, ".dsh/journal"),
            WorkspaceJournal.MAX_TOTAL, "撤回上一步靠它；超量按条数与总量淘汰最旧",
            cleanable = true,
        )
        add("missions", "Mission 导出（.dsh/missions）", File(workspace.root, ".dsh/missions"), 0L, "你点「导出记录」生成的文件，删它要你自己动手")
        add("build", "构建产物（.dsh/build）", File(workspace.root, ".dsh/build"), 0L,
            "App 构建中间产物；重新构建会覆盖", cleanable = true)
        add("sessions", "会话日志（kernel/sessions）", File(configDir, "sessions"), 0L,
            "长期真相与上下文来源，不自动删；要减少占用请在会话列表里删会话", warnAt = sessionsWarnBytes)
        add("missionsJson", "Mission 账本", File(configDir, "missions.json"), 0L, "已结算最多留 " + MissionRegistry.MAX_SETTLED + " 条，进行中永远留")
        add("wakesJson", "唤醒队列", File(configDir, "wakes.json"), 0L, "已消费最多留 " + WakeRouter.MAX_CONSUMED + " 条（去重靠它，不能更早丢）")
        add("voiceCache", "语音缓存", File(filesDir, ai.deepseek.harness.mobile.voice.VoiceCache.DIR),
            VOICE_CACHE_BYTES, "识别/合成的临时音频，超上限裁到 80%", cleanable = true)
        add("runtime", "本地运行时（rootfs）", File(filesDir, "runtime"), 0L, "端侧模型与 rootfs；换版本时整树重建，平时不占额外增长")

        val (free, total) = runCatching { disk() }.getOrDefault(0L to 0L)
        return JSONObject().apply {
            put("items", items)
            put("workspaceBytes", wsBytes)
            put("free", free)
            put("total", total)
            put("root", workspace.rootPath)
        }
    }

    /**
     * 清理一个可再生项。白名单写死在这里：界面上给什么 key，都到不了删用户文件的分支。
     * 溢出缓存是「整目录清空」而不是按龄期清 —— 用户点这个按钮的意图就是「现在就要空间」，
     * 按 lastModified 判断会因为文件刚刚写入而一个都删不掉。
     */
    fun clear(key: String): JSONObject = when (key) {
        "spill" -> {
            val dir = File(workspace.root, SPILL_SUB)
            val before = SpillPolicy.dirBytes(dir)
            var removed = 0
            dir.listFiles()?.forEach { f ->
                val ok = runCatching { f.deleteRecursively() }.getOrDefault(false) && !f.exists()
                if (ok) removed++
            }
            val after = SpillPolicy.dirBytes(dir)
            JSONObject().put("ok", true).put("key", key).put("entries", removed)
                .put("freed", (before - after).coerceAtLeast(0L))
        }
        "journal" -> clearDir(File(workspace.root, ".dsh/journal"), key)
        "build" -> clearDir(File(workspace.root, ".dsh/build"), key)
        "voiceCache" -> clearDir(File(filesDir, ai.deepseek.harness.mobile.voice.VoiceCache.DIR), key)
        else -> JSONObject().put("ok", false).put("error", "这一项不能从这里清理")
    }

    /** 整目录清空（只给「可再生」项用）；返回清掉多少字节，让界面能说「释放了 X」 */
    private fun clearDir(dir: File, key: String): JSONObject {
        val before = SpillPolicy.dirBytes(dir)
        var removed = 0
        dir.listFiles()?.forEach { f ->
            val ok = runCatching { f.deleteRecursively() }.getOrDefault(false) && !f.exists()
            if (ok) removed++
        }
        val after = SpillPolicy.dirBytes(dir)
        return JSONObject().put("ok", true).put("key", key).put("entries", removed)
            .put("freed", (before - after).coerceAtLeast(0L))
    }

    private fun displayPath(file: File): String {        val root = runCatching { workspace.root.canonicalPath }.getOrElse { workspace.root.absolutePath }
        val p = runCatching { file.canonicalPath }.getOrElse { file.absolutePath }
        return if (p == root) "." else if (p.startsWith("$root${File.separator}")) p.removePrefix("$root${File.separator}") else p
    }

    companion object {
        /** spill 在工作区里的子目录 —— 名字引用写入方那一份常量，不再手抄字面量 */
        const val SPILL_SUB = ai.deepseek.harness.mobile.agent.ToolPipeline.SPILL_DIR
        private const val RETENTION_DAYS = (SpillPolicy.RETENTION_MS / 86_400_000L).toInt()
        /** 语音缓存上限引用 VoiceCache 自己那一份：改上限只改一处，面板数字不会和清理口径分叉 */
        const val VOICE_CACHE_BYTES = ai.deepseek.harness.mobile.voice.VoiceCache.MAX_BYTES
        /** 单次统计最多算这么多字节，避免超大目录把统计本身变成卡顿 */
        private const val SCAN_LIMIT = 4_000_000_000L

        /** 会话日志没有自动删除（那是用户的历史），但到量要出声提醒 */
        const val SESSIONS_WARN_BYTES = 500L * 1024 * 1024
    }

    private fun humanMB(bytes: Long): String = (bytes / (1024 * 1024)).toString() + " MB"
}
