package ai.deepseek.harness.mobile.kernel.plugin.builtin.fs

import ai.deepseek.harness.mobile.kernel.FsTools
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickBool
import ai.deepseek.harness.mobile.kernel.plugin.pickInt

/**
 * 文件能力插件（桌面内核 ctx.fs 的适配）。
 * 插件只负责「暴露哪些工具、参数长什么样」，真正的读写实现在 [FsTools]，
 * 这样权限/上限逻辑只有一份，换插件不换实现。
 *
 * 参数名与桌面 `@deepseek-ai/dsh-tool-fs` / `dsh-tool-fs-search` 逐字对齐
 * （file_path / old_string / new_string / replace_all / include…），
 * 同时用 pick* 兼容早期用过的旧名（path / old / new / max）。
 */
class FsPlugin : KernelPlugin {
    override val id = "fs"
    override val name = "文件"
    override val description = "在工作区内读取、写入、编辑、检索文件"
    override val version = "1.0.0"

    private var fs: FsTools? = null
    private var journal: ai.deepseek.harness.mobile.kernel.WorkspaceJournal? = null
    private var calls = 0

    override fun onLoad(ctx: PluginContext) {
        journal = ctx.service("workspace.journal") as? ai.deepseek.harness.mobile.kernel.WorkspaceJournal
        fs = FsTools(ctx.workspace, ctx.sandbox, journal)
    }

    override fun onUnload() {
        fs = null
        journal = null
    }

    override fun status(): Map<String, String> = mapOf("调用次数" to calls.toString())

    private val impl: FsTools get() = fs ?: error("文件插件未加载")

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "read",
            description = "读取工作区内的文本文件，返回带行号范围的正文。默认一次 2000 行；" +
                "没读完会提示「还有 N 行」，用 offset 继续翻页。超长内容会自动截断。",
            parameters = Schemas.params(
                mapOf(
                    "file_path" to Schemas.prop("string", "相对工作区的路径，例如 src/main.ts"),
                    "offset" to Schemas.prop("number", "起始行号，从 1 开始，默认 1"),
                    "limit" to Schemas.prop("number", "本次最多读取多少行，默认 2000"),
                ),
                listOf("file_path"),
            ),
            executionMode = ToolExecutionMode.PARALLEL,
        ) { a -> calls++; impl.read(a.pick("file_path", "path"), a.pickInt("offset", default = 1), a.pickInt("limit", default = 0)) },

        SimpleTool(
            name = "write",
            description = "写入文本文件（覆盖或追加）。父目录会自动创建。",
            parameters = Schemas.params(
                mapOf(
                    "file_path" to Schemas.prop("string", "相对工作区的路径"),
                    "content" to Schemas.prop("string", "要写入的完整内容"),
                    "append" to Schemas.prop("boolean", "为 true 时追加而不是覆盖"),
                ),
                listOf("file_path", "content"),
            ),
        ) { a ->
            calls++
            impl.write(a.pick("file_path", "path"), a.getString("content"), a.pickBool("append"))
        },

        SimpleTool(
            name = "edit",
            description = "在文件中做精确文本替换。old_string 必须唯一，否则提供更长片段或设置 replace_all。",
            parameters = Schemas.params(
                mapOf(
                    "file_path" to Schemas.prop("string", "相对工作区的路径"),
                    "old_string" to Schemas.prop("string", "要被替换的原文"),
                    "new_string" to Schemas.prop("string", "替换后的内容"),
                    "replace_all" to Schemas.prop("boolean", "替换所有匹配项"),
                ),
                listOf("file_path", "old_string", "new_string"),
            ),
        ) { a ->
            calls++
            impl.edit(
                a.pick("file_path", "path"),
                a.pick("old_string", "old"),
                a.pick("new_string", "new"),
                a.pickBool("replace_all", "replaceAll"),
            )
        },

        SimpleTool(
            name = "list_dir",
            description = "列出目录内容（名称、类型、大小、修改时间）。",
            parameters = Schemas.params(mapOf("path" to Schemas.prop("string", "相对工作区的目录，默认工作区根"))),
            executionMode = ToolExecutionMode.PARALLEL,
        ) { a -> calls++; impl.list(a.pick("path", "dir").ifBlank { "." }) },

        SimpleTool(
            name = "glob",
            description = "按通配符查找文件（只返回文件，不含目录），支持 ** 跨目录，例如 **/*.kt。" +
                "pattern 不含 / 时匹配任意深度的文件名。结果按修改时间倒序，默认最多 100 个；" +
                "命中更多时会给出总数并提示收窄模式。",
            parameters = Schemas.params(
                mapOf(
                    "pattern" to Schemas.prop("string", "glob 模式，例如 **/*.kt"),
                    "path" to Schemas.prop("string", "搜索目录，默认工作区"),
                    "max" to Schemas.prop("number", "最多返回多少个，默认 100，上限 500"),
                ),
                listOf("pattern"),
            ),
            executionMode = ToolExecutionMode.PARALLEL,
        ) { a -> calls++; impl.glob(a.getString("pattern"), a.pickInt("max", default = FsTools.DEFAULT_GLOB_MAX), a.pick("path").ifBlank { "." }) },

        SimpleTool(
            name = "grep",
            description = "在工作区内按正则搜索文本（ripgrep 语法），结果按文件分组、带行号。" +
                "include 用一个 glob 过滤文件；context 给出命中行前后文；files_only 只列文件名（找定义位置最省 token）。" +
                "默认最多 250 条命中（max 可调，上限 1000），超出会说明还有多少未列出 —— 命中很多时先收窄 include 或换更精确的 pattern。",
            parameters = Schemas.params(
                mapOf(
                    "pattern" to Schemas.prop("string", "正则表达式"),
                    "path" to Schemas.prop("string", "限定目录或文件，默认全工作区"),
                    "include" to Schemas.prop("string", "文件名 glob 过滤，例如 *.kt"),
                    "ignoreCase" to Schemas.prop("boolean", "是否忽略大小写，默认 true"),
                    "context" to Schemas.prop("number", "每条命中附带前后各几行，0–10，默认 0"),
                    "files_only" to Schemas.prop("boolean", "只返回命中的文件名，不返回行内容"),
                    "max" to Schemas.prop("number", "最多返回多少条命中，默认 250，上限 1000"),
                ),
                listOf("pattern"),
            ),
            executionMode = ToolExecutionMode.PARALLEL,
        ) { a ->
            calls++
            impl.grep(
                a.getString("pattern"),
                a.pick("path").ifBlank { "." },
                a.pickBool("ignoreCase", default = true),
                a.pickInt("max", default = FsTools.MAX_GREP_HITS),
                a.pick("include"),
                a.pickInt("context", default = 0),
                a.pickBool("files_only", "filesOnly"),
            )
        },

        SimpleTool(
            name = "mkdir",
            description = "创建目录（含父目录）。",
            parameters = Schemas.params(mapOf("path" to Schemas.prop("string", "相对工作区的目录路径")), listOf("path")),
        ) { a -> calls++; impl.mkdir(a.getString("path")) },

        SimpleTool(
            name = "move",
            description = "移动或改名文件/目录（替代 bash mv：走沙箱写检查，被覆盖的目标会进 undo 存档）。",
            parameters = Schemas.params(
                mapOf(
                    "from" to Schemas.prop("string", "源路径"),
                    "to" to Schemas.prop("string", "目标路径（新名字或新位置）"),
                    "overwrite" to Schemas.prop("boolean", "目标已存在时是否覆盖，默认 false"),
                ),
                listOf("from", "to"),
            ),
        ) { a -> calls++; impl.move(a.getString("from"), a.getString("to"), a.pickBool("overwrite")) },

        SimpleTool(
            name = "copy",
            description = "复制文件或整个目录（替代 bash cp：走沙箱写检查）。",
            parameters = Schemas.params(
                mapOf(
                    "from" to Schemas.prop("string", "源路径（目录会递归复制）"),
                    "to" to Schemas.prop("string", "目标路径"),
                    "overwrite" to Schemas.prop("boolean", "目标已存在时是否覆盖，默认 false"),
                ),
                listOf("from", "to"),
            ),
        ) { a -> calls++; impl.copy(a.getString("from"), a.getString("to"), a.pickBool("overwrite")) },

        SimpleTool(
            name = "delete_path",
            description = "删除文件或目录（目录会递归删除）。",
            parameters = Schemas.params(mapOf("path" to Schemas.prop("string", "相对工作区的路径")), listOf("path")),
        ) { a -> calls++; impl.delete(a.getString("path")) },

        SimpleTool(
            name = "stat",
            description = "查看路径的元信息：是否目录、大小、修改时间、可读写。",
            parameters = Schemas.params(mapOf("path" to Schemas.prop("string", "相对工作区的路径")), listOf("path")),
            executionMode = ToolExecutionMode.PARALLEL,
        ) { a -> calls++; impl.stat(a.getString("path")) },

        SimpleTool(
            name = "undo",
            description =
                "撤回自己刚才对文件的改动（write/edit/delete 前会自动存档）。" +
                    "action=list 看最近改动（含是否可撤回）；action=restore 并给 seq 撤回那一条；action=clear 清空存档。" +
                    "用户说「改回去 / 撤销刚才那步 / 别动我的文件了」时用它。目录删除与超过 4MB 的文件没有存档，会如实告知。",
            parameters = Schemas.params(
                mapOf(
                    "action" to Schemas.prop("string", "list / restore / clear", listOf("list", "restore", "clear")),
                    "seq" to Schemas.prop("number", "restore 时要撤回的改动序号（来自 list）"),
                    "limit" to Schemas.prop("number", "list 返回条数，默认 20"),
                ),
                listOf("action"),
            ),
        ) { a ->
            calls++
            val j = journal ?: throw ai.deepseek.harness.mobile.kernel.KernelError("改动存档未启用")
            when (val act = a.getString("action")) {
                "list" -> {
                    val items = j.list(a.pickInt("limit", default = 20))
                    if (items.isEmpty()) "还没有可撤回的改动"
                    else org.json.JSONObject().apply {
                        put("count", items.size)
                        put("entries", org.json.JSONArray(items.map { e ->
                            org.json.JSONObject().apply {
                                put("seq", e.seq); put("at", e.at); put("tool", e.tool)
                                put("path", e.path); put("canUndo", e.saved || !e.existed)
                            }
                        }))
                    }.toString(2)
                }
                "restore" -> {
                    // restore 失败时返回的是 {"ok":false,...} 而不是抛异常，
                    // 直接透传会被外层包成 ok:true —— 用户以为文件撤回了，其实没有
                    val r = j.restore(a.pickInt("seq"))
                    if (!r.optBoolean("ok", true)) {
                        throw ai.deepseek.harness.mobile.kernel.KernelError(
                            "撤回失败：${r.optString("error").ifBlank { "未知原因（存档可能已被清理）" }}"
                        )
                    }
                    r.toString()
                }
                "clear" -> "已清空 ${j.clear()} 条存档"
                else -> throw ai.deepseek.harness.mobile.kernel.KernelError("未知 action：$act（list / restore / clear）")
            }
        },
    )
}
