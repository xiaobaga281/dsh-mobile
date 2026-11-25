package ai.deepseek.harness.mobile.kernel.plugin.builtin.doc

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 编辑与交付工具 —— 对应桌面三个独立包：
 *
 *  - `@deepseek-ai/dsh-tool-str-replace-editor` → `str_replace_editor`
 *    （view / create / str_replace / insert；官方 schema 的四个 command 原样保留）
 *  - `@deepseek-ai/dsh-tool-present` → `present`
 *    （把已有文件声明为最终交付物；手机端 emit `deliverable` 事件，前端出交付卡片）
 *  - `apply_patch`（桌面按工具名分类表归 edit 类）：统一 diff 补丁应用，
 *    手机端给的是标准 unified diff 支持，不假装支持厂商私有格式。
 *
 * 所有写入都走 `ctx.sandbox.checkWrite`，与其它文件工具共用唯一写入口。
 */
class EditorPlugin : KernelPlugin {
    override val id = "editor"
    override val name = "编辑与交付"
    override val description = "str_replace_editor、present 交付物、apply_patch 补丁"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var deliverSink: ((JSONObject) -> Unit)? = null
    private var journal: ai.deepseek.harness.mobile.kernel.WorkspaceJournal? = null

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        @Suppress("UNCHECKED_CAST")
        deliverSink = ctx.service("deliverable.sink") as? ((JSONObject) -> Unit)
        // 改动进撤销档：否则 str_replace_editor / apply_patch 的写入根本不在 undo 列表里，
        // 用户说「改回去」只能撤到更早的一次 write，工具描述里的承诺是假的
        journal = ctx.service("workspace.journal") as? ai.deepseek.harness.mobile.kernel.WorkspaceJournal
    }

    override fun onUnload() { ctx = null; deliverSink = null; journal = null }

    /** 写盘前留档（失败不阻断：撤销能力降级比改不了文件轻） */
    private fun stamp(f: java.io.File, tool: String) {
        runCatching { journal?.record(f, tool) }
    }

    private fun ws() = ctx?.workspace ?: throw KernelError("工作区未就绪")
    private fun sandbox() = ctx?.sandbox ?: throw KernelError("沙箱未就绪")

    /** 内核门面：present 要判断「当前有没有打开的轮次」 */
    private fun kernel(): ai.deepseek.harness.mobile.kernel.ToolKernel =
        ctx?.service("kernel.facade") as? ai.deepseek.harness.mobile.kernel.ToolKernel
            ?: throw KernelError("内核门面未就绪")

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "str_replace_editor"
            override val description =
                "查看、创建、按唯一字面量替换、或按行插入来编辑文件。" +
                    "command 取 view（查看文件或目录）、create（新建文件）、str_replace（替换唯一出现的 old_str）、" +
                    "insert（在第 insert_line 行之后插入 new_str）。"
            override val parameters = schema(
                JSONObject()
                    .put("command", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("view", "create", "str_replace", "insert")))
                        .put("description", "要执行的操作：view / create / str_replace / insert"))
                    .put("path", JSONObject().put("type", "string").put("description", "相对工作区的文件或目录路径"))
                    .put("file_text", JSONObject().put("type", "string").put("description", "create 时的文件内容"))
                    .put("insert_line", JSONObject().put("type", "number").put("description", "insert 的行号，插入到该行之后（0 表示文件开头）"))
                    .put("new_str", JSONObject().put("type", "string").put("description", "替换后的文本 / 要插入的文本"))
                    .put("old_str", JSONObject().put("type", "string").put("description", "要被替换的原文，必须在文件中唯一出现"))
                    .put("view_range", JSONObject().apply {
                        put("type", "array")
                        put("description", "view 时的行范围 [起始行, 结束行]，-1 表示到文件末尾")
                        put("items", JSONObject().put("type", "number"))
                    }),
                listOf("command", "path"),
            )
            override fun execute(args: JSONObject): String = when (val cmd = args.optString("command")) {
                "view" -> {
                    val f = ws().resolve(args.optString("path"), mustExist = true)
                    if (f.isDirectory) {
                        val items = f.listFiles()?.sortedBy { it.name }?.take(200) ?: emptyList()
                        "目录 ${ws().relative(f)}（${items.size} 项）：\n" + items.joinToString("\n") {
                            (if (it.isDirectory) "d " else "f ") + it.name
                        }
                    } else {
                        if (f.length() > 4L * 1024 * 1024) {
                            throw KernelError("文件过大（${f.length() / 1024}KB），view 只支持 4MB 以内；用 read 分页或 grep 定位")
                        }
                        val lines = f.readText().split("\n")
                        val range = args.optJSONArray("view_range")
                        val start = (range?.optInt(0, 1) ?: 1).coerceAtLeast(1)
                        var end = range?.optInt(1, -1) ?: -1
                        if (end < 0 || end > lines.size) end = lines.size
                        // 起止倒置（如 [50,10]）会直接 IllegalArgumentException，收编成明确报错
                        if (range != null && end in 1 until start) {
                            throw KernelError("view_range 起止倒置：[$start, $end]，start 应小于等于 end")
                        }
                        val body = lines.subList((start - 1).coerceAtMost(lines.size), end.coerceAtMost(lines.size))
                        "文件 ${ws().relative(f)}（共 ${lines.size} 行，本次 $start-$end）：\n" +
                            body.mapIndexed { i, l -> "${start + i}\t$l" }.joinToString("\n")
                    }
                }
                "create" -> {
                    val f = sandbox().checkWrite(args.optString("path"))
                    if (f.exists()) throw KernelError("文件已存在，create 不会覆盖：${args.optString("path")}（用 str_replace 或 write）")
                    ws().mkdirs(f)
                    stamp(f, "editor.create")
                    f.writeText(args.optString("file_text"))
                    "已创建 ${ws().relative(f)}（${f.length()} 字节）"
                }
                "str_replace" -> {
                    val oldStr = args.optString("old_str")
                    if (oldStr.isEmpty()) throw KernelError("str_replace 需要 old_str")
                    val f = sandbox().checkWrite(args.optString("path"))
                    if (!f.exists()) throw KernelError("文件不存在：${args.optString("path")}")
                    val text = f.readText()
                    val count = text.split(oldStr).size - 1
                    if (count == 0) throw KernelError("没有找到 old_str（要替换的原文必须逐字符一致）")
                    if (count > 1) throw KernelError("old_str 在文件中出现 $count 次，必须唯一；请带上更多上下文")
                    stamp(f, "editor.str_replace")
                    f.writeText(text.replace(oldStr, args.optString("new_str")))
                    "已替换 ${ws().relative(f)} 中的 1 处文本"
                }
                "insert" -> {
                    val f = sandbox().checkWrite(args.optString("path"))
                    if (!f.exists()) throw KernelError("文件不存在：${args.optString("path")}")
                    val line = args.optInt("insert_line", 0).coerceAtLeast(0)
                    val lines = f.readText().split("\n").toMutableList()
                    if (line > lines.size) throw KernelError("insert_line=$line 超出文件行数 ${lines.size}")
                    lines.addAll(line, args.optString("new_str").split("\n"))
                    stamp(f, "editor.insert")
                    f.writeText(lines.joinToString("\n"))
                    "已在第 $line 行之后插入 ${args.optString("new_str").split("\n").size} 行：${ws().relative(f)}"
                }
                else -> throw KernelError("未知 command：$cmd（可用 view/create/str_replace/insert）")
            }
        },
        object : ToolSpec {
            override val name = "apply_patch"
            override val description =
                "把一段标准 unified diff 补丁应用到工作区文件。每段补丁以 --- a/<path> / +++ b/<path> 开头，" +
                    "hunk 用 @@ -l,c +l,c @@ 标记。适合一次性改动多处。"
            override val parameters = schema(
                JSONObject().put("patch", JSONObject().put("type", "string").put("description", "unified diff 文本")),
                listOf("patch"),
            )
            override fun execute(args: JSONObject): String {
                val patch = args.optString("patch")
                if (patch.isBlank()) throw KernelError("patch 不能为空")
                return applyUnifiedDiff(patch)
            }
        },
        object : ToolSpec {
            override val name = "present"
            override val description =
                "把已有文件声明为交付给用户的最终交付物（Office 文档、表格、演示文稿、代码等）。" +
                    "用户打开的是当前文件本身，不复制内容。通常 1-2 个最重要的，一次最多 8 个；" +
                    "只在对话轮次进行中可用，卡片会在这一轮结束时出现在对话末尾。"
            override val parameters = schema(
                JSONObject().put("files", JSONObject().apply {
                    put("type", "array")
                    put("description", "通常 1-2 个最重要的交付物，最多 4 个")
                    put("items", JSONObject().apply {
                        put("type", "object")
                        put("properties", JSONObject()
                            .put("path", JSONObject().put("type", "string").put("description", "相对工作区的已有文件路径"))
                            .put("description", JSONObject().put("type", "string").put("description", "给用户看的一句说明")))
                        put("required", JSONArray(listOf("path")))
                    })
                }),
                listOf("files"),
            )
            override fun execute(args: JSONObject): String {
                val arr = args.optJSONArray("files") ?: throw KernelError("files 不能为空")
                if (arr.length() == 0) throw KernelError("files 不能为空")
                if (arr.length() > 8) throw KernelError("一次最多交付 8 个文件（推荐 1-2 个）")
                if (ctx != null && !kernel().isTurnActive()) {
                    throw KernelError("present 只能在对话轮次进行中调用：直接把它作为本轮产出交付即可")
                }
                val out = JSONArray()
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val path = o.optString("path")
                    val raw = try {
                        // 完全访问档可交付工作区外的文件；其余档位 resolveRead 等价于工作区内解析
                        ctx?.sandbox?.resolveRead(path) ?: ws().resolve(path, mustExist = true)
                    } catch (e: Throwable) {
                        throw KernelError("交付文件不存在：$path")
                    }
                    if (raw.isDirectory) throw KernelError("交付物必须是文件：$path")
                    // FileProvider 只开放工作区：工作区外的文件先拷进来，用户拿到的仍是完整内容
                    val f = if (raw.canonicalPath.startsWith(ws().root.canonicalPath)) raw
                    else copyIntoPresent(raw)
                    out.put(JSONObject().apply {
                        put("path", ws().relative(f))
                        put("name", f.name)
                        put("size", f.length())
                        put("mime", guessMime(f.name))
                        put("description", o.optString("description"))
                    })
                }
                if (out.length() == 0) throw KernelError("没有可交付的文件")
                deliverSink?.invoke(JSONObject().put("files", out))
                // 落一条 session 事件：文件页「产出」页签据此列出历史交付物
                runCatching {
                    val sid = ctx?.service("agent.session") as? String
                    val store = ctx?.service("session.store") as? ai.deepseek.harness.mobile.agent.SessionStore
                    if (store != null) store.append(sid ?: "draft", "deliverable", JSONObject().put("files", out))
                }
                return "已交付 ${out.length()} 个文件：" + (0 until out.length())
                    .mapNotNull { out.optJSONObject(it)?.optString("path") }.joinToString("、")
            }
        },
    )

    /* ---------------- unified diff ---------------- */

    /** 工作区外文件交付前的落位：拷进 workspace/.present/，重名追加序号 */
    private fun copyIntoPresent(src: File): File {
        val dir = File(ws().root, ".present").apply { mkdirs() }
        var dst = File(dir, src.name)
        var n = 1
        while (dst.exists()) {
            dst = File(dir, "${src.nameWithoutExtension}-${n++}.${src.extension}")
        }
        src.copyTo(dst, overwrite = true)
        return dst
    }

    private fun applyUnifiedDiff(patch: String): String {
        val lines = patch.split("\n")
        var i = 0
        val touched = mutableListOf<String>()
        while (i < lines.size) {
            val line = lines[i]
            if (!line.startsWith("--- ")) { i++; continue }
            val oldPath = line.removePrefix("--- ").trim().removePrefix("a/")
            if (i + 1 >= lines.size || !lines[i + 1].startsWith("+++ ")) throw KernelError("补丁格式错误：缺少 +++ 行")
            val newPath = lines[i + 1].removePrefix("+++ ").trim().removePrefix("b/")
            val target = sandbox().checkWrite(newPath.ifBlank { oldPath })
            i += 2
            val source = if (target.exists()) target.readText().split("\n").toMutableList() else mutableListOf()
            var shift = 0
            while (i < lines.size && lines[i].startsWith("@@")) {
                val m = Regex("""@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@""").find(lines[i])
                    ?: throw KernelError("hunk 头格式错误：${lines[i]}")
                val oldStart = m.groupValues[1].toInt()
                i++
                val removed = mutableListOf<String>()
                val added = mutableListOf<String>()
                while (i < lines.size && !lines[i].startsWith("@@") && !lines[i].startsWith("--- ")) {
                    val l = lines[i]
                    when {
                        l.startsWith("+") -> added.add(l.substring(1))
                        l.startsWith("-") -> removed.add(l.substring(1))
                        // 上下文行：带空格前缀。空串是「补丁以换行结尾」产生的尾元素
                        // （split("\n") 的必然产物），当作空上下文行处理；
                        // 原来对空串调 substring(1) 直接 StringIndexOutOfBounds，
                        // 导致几乎所有真实补丁都 TOOL_THREW。
                        l.startsWith(" ") -> { val c = l.substring(1); removed.add(c); added.add(c) }
                        l.isEmpty() -> { removed.add(""); added.add("") }
                        l.startsWith("\\") -> {}
                        else -> break
                    }
                    i++
                }
                val idx = (oldStart - 1 + shift).coerceAtLeast(0)
                if (idx > source.size) throw KernelError("hunk 越界：第 $oldStart 行不存在")
                // 校验原文：越界（actual == null）也要拒绝 —— 原来静默放行，
                // 然后把补丁内容追加到文件尾，产生看起来成功实则错误的文件。
                for (k in removed.indices) {
                    val actual = source.getOrNull(idx + k)
                    if (actual == null || actual != removed[k]) {
                        throw KernelError("补丁上下文不匹配：第 ${oldStart + k} 行期望「${removed.getOrNull(k) ?: "<越界>"}」实际「${actual ?: "<越界>"}」")
                    }
                }
                if (removed.isNotEmpty()) source.subList(idx, (idx + removed.size).coerceAtMost(source.size)).clear()
                source.addAll(idx, added)
                shift += added.size - removed.size
            }
            ws().mkdirs(target)
            stamp(target, "apply_patch")
            target.writeText(source.joinToString("\n"))
            touched.add(ws().relative(target))
        }
        if (touched.isEmpty()) throw KernelError("补丁里没有可应用的段落（需要 --- / +++ / @@ 结构）")
        return "已应用补丁到：" + touched.joinToString("、")
    }

    private fun guessMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        "pdf" -> "application/pdf"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "svg" -> "image/svg+xml"
        "md", "markdown" -> "text/markdown"
        "html" -> "text/html"
        "json" -> "application/json"
        "csv" -> "text/csv"
        "kt", "java", "js", "ts", "py" -> "text/plain"
        else -> "application/octet-stream"
    }
}
