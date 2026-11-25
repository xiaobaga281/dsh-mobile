package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 技能（skills）—— 对应桌面 `packages/skill/skill-filesystem` + `tool-skill`。
 *
 * 桌面版把技能做成「可选指令」而不是会话事件：注册表按 scope 合并各提供方的候选，
 * 模型先看到目录（名字 + 一句说明），需要时再用 `skill` 工具加载正文。
 * 手机端保留同样的渐进披露，只是扫描范围收敛成两处：
 *
 *   files/skills/<name>/SKILL.md      随应用/用户放的技能
 *   workspace/skills/<name>/SKILL.md  跟着工作区走的技能
 *
 * 正文只在被调用时才读，所以目录里放 100 个技能也不会顶掉上下文。
 */
class SkillStore(
    private val appSkillsDir: File,
    private val workspaceSkillsDir: File,
    private val log: (String) -> Unit = {},
) {

    data class Skill(val name: String, val description: String, val body: String, val source: String)

    private var cache: List<Skill>? = null

    fun list(force: Boolean = false): List<Skill> {
        val hit = cache
        if (hit != null && !force) return hit
        val out = LinkedHashMap<String, Skill>()
        listOf(appSkillsDir to "app", workspaceSkillsDir to "workspace").forEach { (dir, tag) ->
            if (!dir.exists()) return@forEach
            dir.listFiles()?.sortedBy { it.name }?.forEach { entry ->
                val file = if (entry.isDirectory) File(entry, "SKILL.md") else entry
                if (!file.isFile) return@forEach
                if (entry.isFile && !entry.name.endsWith(".md", true)) return@forEach
                parse(file, tag)?.let { s -> out.putIfAbsent(s.name, s) }
            }
        }
        val list = out.values.toList()
        cache = list
        log("skills: ${list.size} 个（${list.joinToString("、") { it.name }}）")
        return list
    }

    private fun parse(file: File, source: String): Skill? {
        return try {
            val text = file.readText()
            if (text.length > 200_000) return null
            var name = if (file.name.equals("SKILL.md", true)) file.parentFile?.name ?: "" else file.nameWithoutExtension
            var description = ""
            var body = text
            // 极简 frontmatter：--- ... --- 之间的 key: value
            if (text.startsWith("---")) {
                val end = text.indexOf("\n---", 3)
                if (end > 0) {
                    val head = text.substring(3, end)
                    head.lines().forEach { line ->
                        val idx = line.indexOf(':')
                        if (idx > 0) {
                            val k = line.substring(0, idx).trim().lowercase()
                            val v = line.substring(idx + 1).trim().trim('"', '\'')
                            if (k == "name" && v.isNotEmpty()) name = v
                            if (k == "description" && v.isNotEmpty()) description = v
                        }
                    }
                    body = text.substring(end + 4).trim()
                }
            }
            if (name.isBlank()) return null
            if (description.isBlank()) {
                description = body.lineSequence().firstOrNull { it.isNotBlank() && !it.startsWith("#") }
                    ?.trim()?.take(80) ?: "（无说明）"
            }
            Skill(name, description, body, source)
        } catch (_: Throwable) { null }
    }

    fun load(name: String): Skill? = list().firstOrNull { it.name.equals(name, true) }

    /** 目录段落：只给名字与说明，正文按需加载 */
    fun catalogText(limit: Int = 20): String {
        val items = list().take(limit)
        if (items.isEmpty()) return ""
        return "可用技能（需要时调用 skill 工具加载正文）：\n" +
            items.joinToString("\n") { "- ${it.name}：${it.description}" }
    }

    fun toJson(): JSONArray = JSONArray().apply {
        list().forEach { s ->
            put(JSONObject().put("name", s.name).put("description", s.description).put("source", s.source))
        }
    }
}
