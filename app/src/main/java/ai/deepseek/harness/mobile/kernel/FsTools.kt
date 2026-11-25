package ai.deepseek.harness.mobile.kernel

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 文件类工具（桌面内核 ctx.fs 的手机适配）：
 * read / write / edit / list / glob / grep / mkdir / delete / stat。
 * 全部限制在 [Workspace] 内，结果大小有上限，避免把内存打爆。
 */
class FsTools(
    private val ws: Workspace,
    private val sandbox: ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox? = null,
    /** 改动存档：写/编辑/删除前留一份原件，供 undo 撤回（可空，测试环境不需要） */
    private val journal: WorkspaceJournal? = null,
) {

    companion object {
        const val MAX_READ = 256 * 1024
        const val MAX_WRITE = 2 * 1024 * 1024
        /** 单次 read 允许读入的原始字节上限（远超输出上限即可，只为拦住 OOM） */
        const val MAX_READ_BYTES = 8L * 1024 * 1024
        /** 与桌面 grep 的 250 条上限对齐：再多模型也读不完，只会挤占上下文 */
        const val MAX_GREP_HITS = 250
        /** 与桌面 read 的默认分页对齐：不指定 limit 时最多 2000 行 */
        const val DEFAULT_READ_LINES = 2000
        /** 与桌面 glob 的默认上限对齐（按修改时间取最近的 100 个） */
        const val DEFAULT_GLOB_MAX = 100
        private val TEXT_SNIFF = 8000

        /**
         * 遍历时跳过的名字。
         * `.dsh` 是内核自己的运行时目录（工具超长结果的溢出文件），不进 glob/grep/list，
         * 否则 Agent 搜自己的历史输出、或者把溢出文件当成工作区内容来读，都是噪声。
         * 需要读溢出文件时按显式路径 read 即可（read 不走遍历）。
         */
        val SKIP_NAMES = setOf(".dsh", "node_modules", ".git", ".gradle", "build")
    }

    fun read(rawPath: String, offset: Int = 1, limit: Int = DEFAULT_READ_LINES): String {
        val path = normPath(rawPath)
        val f = sandbox?.resolveRead(path) ?: ws.resolve(path, mustExist = true)
        if (f.isDirectory) throw KernelError("这是目录，请用 list：$path")
        if (!f.exists()) throw KernelError("文件不存在：$path")
        // 先看大小再读：readBytes 之后才切片等于没限制，几百 MB 的日志会直接把进程打死
        if (f.length() > MAX_READ_BYTES) {
            throw KernelError(
                "文件过大（${f.length() / 1024 / 1024}MB，read 上限 ${MAX_READ_BYTES / 1024 / 1024}MB）：" +
                    "请用 grep 定位关键行，或按 offset/limit 配合更小的文件；" +
                    "确实要整份处理可先 `bash(\"head -c …\")` 截取，或让用户拆分文件"
            )
        }
        val bytes = f.readBytes()
        if (looksBinary(bytes)) throw KernelError("二进制文件，无法按文本读取：$path")
        val text = String(bytes, Charsets.UTF_8)
        val all = text.split("\n")
        val start = (offset.coerceAtLeast(1) - 1).coerceAtMost(all.size)
        if (offset > all.size + 1) throw KernelError("offset=$offset 超出文件长度（共 ${all.size} 行）")
        val cap = if (limit > 0) limit else DEFAULT_READ_LINES
        val end = (start + cap).coerceAtMost(all.size)
        var body = all.subList(start, end).joinToString("\n")
        var truncated = false
        if (body.length > MAX_READ) {
            body = body.substring(0, MAX_READ)
            truncated = true
        }
        val header = buildString {
            append("文件：${ws.relative(f)}（共 ${all.size} 行")
            if (start > 0 || end < all.size) append("，本次 ${start + 1}-$end")
            append("）")
            if (truncated) append("\n[内容超过 ${MAX_READ / 1024}KB，已截断]")
            // 桌面 read 的分页靠 offset/limit；不告诉模型还剩多少，它会以为文件就读完了
            if (end < all.size) append("\n[还有 ${all.size - end} 行；继续读请用 offset=${end + 1}]")
        }
        return "$header\n$body"
    }

    fun write(rawPath: String, content: String, append: Boolean = false): String {
        val path = normPath(rawPath)
        val f = sandbox?.checkWrite(path) ?: ws.resolve(path)
        if (content.toByteArray().size > MAX_WRITE) throw KernelError("内容过大（上限 ${MAX_WRITE / 1024}KB）")
        if (f.isDirectory) throw KernelError("目标是目录：$path")
        journal?.record(f, if (append) "append" else "write")
        ws.mkdirs(f)
        if (append && f.exists()) f.appendText(content) else f.writeText(content)
        return "已${if (append) "追加" else "写入"} ${ws.relative(f)}（${f.length()} 字节）"
    }

    fun edit(rawPath: String, oldText: String, newText: String, replaceAll: Boolean = false): String {
        if (oldText.isEmpty()) throw KernelError("old 不能为空")
        val path = normPath(rawPath)
        val f = sandbox?.checkWrite(path) ?: ws.resolve(path)
        if (!f.exists()) throw KernelError("文件不存在：$path")
        val text = f.readText()
        val hits = countOccurrences(text, oldText)
        if (hits == 0) throw KernelError("未找到要替换的内容")
        if (hits > 1 && !replaceAll) throw KernelError("匹配到 $hits 处，请提供更长的唯一片段，或设置 replaceAll=true")
        journal?.record(f, "edit")
        val out = if (replaceAll) text.replace(oldText, newText) else text.replaceFirst(oldText, newText)
        f.writeText(out)
        return "已修改 ${ws.relative(f)}（替换 $hits 处）"
    }

    fun list(rawPath: String = "."): String {
        val path = normPath(rawPath)
        val dir = if (path == "." || path.isEmpty()) ws.resolve(".")
        else sandbox?.resolveRead(path) ?: ws.resolve(path, mustExist = true)
        if (!dir.isDirectory) throw KernelError("不是目录：$path")
        val items = ws.list(dir).filterNot { SKIP_NAMES.contains(it.name) }
        if (items.isEmpty()) return "目录为空：${ws.relative(dir)}"
        val arr = JSONArray()
        items.forEach { f ->
            arr.put(JSONObject().apply {
                put("name", f.name)
                put("dir", f.isDirectory)
                put("size", if (f.isDirectory) 0 else f.length())
                put("mtime", f.lastModified())
            })
        }
        return JSONObject().apply {
            put("path", ws.relative(dir))
            put("count", items.size)
            put("items", arr)
        }.toString(2)
    }

    /**
     * 按通配符找文件（与桌面同语义）：
     *  - 只返回文件，不返回目录（目录用 list_dir）
     *  - 按修改时间倒序，最近改过的排前面 —— 模型找「刚才那个文件」时不用翻
     *  - 命中数超过 max 时说明总数并提示收窄模式，而不是静默截断
     */
    fun glob(pattern: String, max: Int = DEFAULT_GLOB_MAX, rawPath: String = "."): String {
        if (pattern.isBlank()) throw KernelError("pattern 不能为空")
        val path = normPath(rawPath)
        val cap = max.coerceIn(1, 500)
        val regex = globToRegex(pattern)
        // 先收到 5000 个为止：排序前不能截断，否则「按修改时间取最近」是假的
        val hits = ArrayList<File>()
        var total = 0
        val root = if (path == "." || path.isBlank()) ws.root
        else sandbox?.resolveRead(path) ?: ws.resolve(path, mustExist = true)
        root.walkTopDown()
            // 起点自身不跳过：显式 glob(".dsh/spill") 仍应能列出内容，跳过只针对下钻
            .onEnter { it == root || (it.name !in SKIP_NAMES && !it.name.startsWith(".git")) }
            .forEach { f ->
                if (f.isDirectory) return@forEach
                val rel = ws.relative(f)
                if (rel == ".") return@forEach
                // 桌面语义：pattern 不含 "/" 时匹配任意深度的文件名
                val matched = if (pattern.contains('/')) regex.matches(rel) else regex.matches(rel) || regex.matches(f.name)
                if (!matched) return@forEach
                total++
                if (hits.size < 5000) hits.add(f)
            }
        if (total == 0) return "没有匹配 $pattern 的文件"
        // 最多返回 cap 个：先按 mtime 取最近的一批，避免把整个仓库按字典序塞给模型
        val sorted = hits.sortedByDescending { it.lastModified() }.take(cap)
        val sb = StringBuilder()
        sb.append("匹配 $pattern：共 $total 个文件")
        if (total > sorted.size) sb.append("，按修改时间取最近 ${sorted.size} 个（用更具体的模式收窄）")
        sb.append('\n')
        sorted.forEach { sb.append(ws.relative(it)).append('\n') }
        return sb.toString().trimEnd()
    }

    /**
     * 正则搜索（桌面 dsh-tool-fs-search 的同构实现）：
     *  - 按文件分组输出，模型能一眼看出「哪几个文件里有」
     *  - context 给出命中行前后文，改代码前不用再 read 一遍
     *  - files_only 只要文件名清单（找定义位置时最省 token）
     *  - 超过 max 条时说明总数并为其余命中留一句提示
     */
    fun grep(
        pattern: String,
        rawPath: String = ".",
        ignoreCase: Boolean = true,
        max: Int = MAX_GREP_HITS,
        include: String = "",
        context: Int = 0,
        filesOnly: Boolean = false,
    ): String {
        if (pattern.isBlank()) throw KernelError("pattern 不能为空")
        val path = normPath(rawPath)
        val re = try {
            Regex(pattern, if (ignoreCase) setOf(RegexOption.IGNORE_CASE) else emptySet())
        } catch (e: Exception) {
            throw KernelError("正则无效：${e.message}")
        }
        val includeRe = include.takeIf { it.isNotBlank() }?.let {
            runCatching { globToRegex(it) }.getOrNull()
                ?: throw KernelError("include 不是合法 glob：$include")
        }
        val cap = max.coerceIn(1, 1000)
        val ctx = context.coerceIn(0, 10)
        val start = if (path == "." || path.isBlank()) ws.root
        else sandbox?.resolveRead(path) ?: ws.resolve(path, mustExist = true)
        // 文件 → 命中行（保持扫描顺序，便于稳定复现）
        val byFile = LinkedHashMap<String, MutableList<Pair<Int, String>>>()
        var total = 0
        var omitted = 0
        val files: Sequence<File> = if (start.isDirectory) {
            start.walkTopDown()
                .onEnter { it == start || (it.name !in SKIP_NAMES && !it.name.startsWith(".git")) }
                .filter { f ->
                    f.isFile && f.length() < MAX_READ &&
                        (includeRe == null || includeRe.matches(f.name)) &&
                        !looksBinary(f.readBytes().take(TEXT_SNIFF).toByteArray())
                }
        } else sequenceOf(start)
        for (f in files) {
            if (total >= cap) break
            val rel = ws.relative(f)
            try {
                val lines = f.readLines()
                for ((idx, line) in lines.withIndex()) {
                    if (!re.containsMatchIn(line)) continue
                    total++
                    if (total > cap) { omitted++; continue }
                    if (filesOnly) {
                        byFile.getOrPut(rel) { mutableListOf() }
                        break
                    }
                    val bucket = byFile.getOrPut(rel) { mutableListOf() }
                    bucket.add(idx + 1 to line.trim().take(200))
                    if (ctx > 0) {
                        // 前后文单独记在行号前缀上，渲染时按行号排序去重
                        for (j in maxOf(0, idx - ctx)..minOf(lines.lastIndex, idx + ctx)) {
                            if (j == idx) continue
                            bucket.add(j + 1 to "  " + lines[j].trim().take(200))
                        }
                    }
                }
            } catch (_: Exception) {
                // 单个文件读失败不影响整体搜索
            }
        }
        if (byFile.isEmpty()) return "没有匹配「$pattern」的内容"
        val sb = StringBuilder()
        sb.append("匹配「$pattern」：${byFile.size} 个文件")
        if (!filesOnly) sb.append("，$total 处命中")
        if (omitted > 0) sb.append("（已截断，另有 $omitted 处未列出；收窄 pattern 或 include）")
        sb.append('\n')
        byFile.forEach { (rel, hits) ->
            sb.append(rel)
            if (!filesOnly) sb.append("（${hits.size} 行）")
            sb.append('\n')
            if (!filesOnly) {
                hits.distinctBy { it.first }
                    .sortedBy { it.first }
                    .forEach { (no, text) -> sb.append("  $no: $text\n") }
            }
        }
        return sb.toString().trimEnd()
    }

    fun mkdir(rawPath: String): String {
        val path = normPath(rawPath)
        val f = sandbox?.checkWrite(path) ?: ws.resolve(path)
        if (!f.exists() && !f.mkdirs()) throw KernelError("创建目录失败：$path")
        return "已创建目录 ${ws.relative(f)}"
    }

    fun delete(rawPath: String): String {
        val path = normPath(rawPath)
        val f = sandbox?.checkDelete(path) ?: ws.resolve(path, mustExist = true)
        val rel = ws.relative(f)
        val isDir = f.isDirectory
        // 目录不逐个存档（可能是几千个文件），只登记一条「不可撤回」的记录
        if (!isDir) journal?.record(f, "delete")
        if (!f.deleteRecursively()) throw KernelError("删除失败：$rel")
        return if (isDir) "已删除目录 $rel（目录内容未存档，无法撤回）" else "已删除 $rel"
    }

    fun stat(rawPath: String): String {
        val path = normPath(rawPath)
        val f = sandbox?.resolveRead(path) ?: ws.resolve(path, mustExist = true)
        return JSONObject().apply {
            put("path", ws.relative(f))
            put("dir", f.isDirectory)
            put("size", if (f.isDirectory) 0 else f.length())
            put("mtime", f.lastModified())
            put("readable", f.canRead())
            put("writable", f.canWrite())
        }.toString(2)
    }

    /**
     * 移动/改名。原来改名只能借 bash mv —— 绕过沙箱写检查，也没有 undo 存档。
     * 这里走与 write/delete 同一条 checkWrite 通道，并对被覆盖的目标文件存档。
     */
    fun move(fromRaw: String, toRaw: String, overwrite: Boolean = false): String {
        val from = normPath(fromRaw)
        val to = normPath(toRaw)
        if (from == "." || to == ".") throw KernelError("路径不能是工作区根")
        if (from == to) throw KernelError("源和目标是同一个路径：$from")
        val src = sandbox?.checkDelete(from) ?: ws.resolve(from, mustExist = true)
        if (!src.exists()) throw KernelError("源不存在：$from")
        val dstFile = sandbox?.checkWrite(to) ?: ws.resolve(to)
        if (dstFile.exists() && !overwrite) {
            throw KernelError("目标已存在：$to（overwrite=true 可覆盖）")
        }
        dstFile.parentFile?.let { ws.mkdirs(it) }
        if (dstFile.exists()) journal?.record(dstFile, "write")
        if (!src.renameTo(dstFile)) {
            // renameTo 跨目录在同分区一般没问题；失败时退回复制+删除（比如挂载点边界）
            if (src.isDirectory) throw KernelError("移动目录失败：$from -> $to")
            src.copyTo(dstFile, overwrite = true)
            journal?.record(src, "delete")
            if (!src.delete()) throw KernelError("移动后删除源文件失败：$from")
        }
        return "已移动 ${ws.relative(src)} -> ${ws.relative(dstFile)}"
    }

    /** 复制文件或整个目录（带存档语义：只对被覆盖的目标登记）。 */
    fun copy(fromRaw: String, toRaw: String, overwrite: Boolean = false): String {
        val from = normPath(fromRaw)
        val to = normPath(toRaw)
        if (from == to) throw KernelError("源和目标是同一个路径：$from")
        val src = sandbox?.resolveRead(from) ?: ws.resolve(from, mustExist = true)
        if (!src.exists()) throw KernelError("源不存在：$from")
        val dstFile = sandbox?.checkWrite(to) ?: ws.resolve(to)
        if (dstFile.exists() && !overwrite) {
            throw KernelError("目标已存在：$to（overwrite=true 可覆盖）")
        }
        dstFile.parentFile?.let { ws.mkdirs(it) }
        if (dstFile.exists()) journal?.record(dstFile, "write")
        var count = 0
        if (src.isDirectory) {
            src.walkTopDown().forEach { f ->
                val rel = f.relativeTo(src)
                val target = File(dstFile, rel.path)
                if (f.isDirectory) target.mkdirs() else { f.copyTo(target, overwrite = true); count++ }
            }
            return "已复制目录 ${ws.relative(src)} -> ${ws.relative(dstFile)}（$count 个文件）"
        }
        src.copyTo(dstFile, overwrite = true)
        return "已复制 ${ws.relative(src)} -> ${ws.relative(dstFile)}（${dstFile.length()} 字节）"
    }

    /* ---------------- 内部工具 ---------------- */

    /**
     * 模型（尤其 1B 级小模型）经常把路径写成 /workspace/xxx、/xxx 甚至完整绝对路径：
     * 工作区沙箱不是文件系统根，这些路径按字面解析必然「文件不存在」，
     * 而且模型会拿着同一个失败路径原样重试七八次，一轮全耗在空转上。
     * 这里统一归一化成相对工作区的路径，所有文件工具入口都先过一遍。
     */
    private fun normPath(raw: String): String {
        val s = raw.trim()
        if (s.isBlank() || s == "/" || s == ".") return "."
        // 模型抄了 stat/read 输出里的完整绝对路径：直接转回相对
        if (s == ws.rootPath) return "."
        if (s.startsWith(ws.rootPath + "/")) return s.removePrefix(ws.rootPath + "/")
        // 相对路径原样交给上层解析
        if (!s.startsWith("/")) return s
        // 以 / 开头的路径：工作区根不是文件系统根，按字面解析必然「文件不存在」。
        // 这里不猜固定前缀（机型不同、工作区名可以改，写死一定出事），
        // 而是按「从哪一段开始能在工作区里真实找到」来判断：
        //   /workspace/a.txt 且 a.txt 存在 → a.txt
        //   /sdcard/harness/a.txt 且 harness/a.txt 存在 → harness/a.txt
        val segs = s.trimStart('/').split('/').filter { it.isNotBlank() }
        for (i in segs.indices) {
            val rel = segs.drop(i).joinToString("/")
            if (rel.isNotEmpty() && File(ws.root, rel).exists()) return rel
        }
        // 都不存在（典型是 write 新文件）：只把首段当虚拟根剥掉，剩下的交给上层如实报错
        return segs.drop(1).joinToString("/").ifBlank { "." }
    }

    private fun looksBinary(bytes: ByteArray): Boolean {
        val n = minOf(bytes.size, TEXT_SNIFF)
        for (i in 0 until n) if (bytes[i] == 0.toByte()) return true
        return false
    }

    private fun countOccurrences(text: String, sub: String): Int {
        var count = 0
        var idx = text.indexOf(sub)
        while (idx >= 0) {
            count++
            idx = text.indexOf(sub, idx + sub.length)
        }
        return count
    }

    /** glob → 正则：** 跨目录，* 单段，? 单字符 */
    private fun globToRegex(glob: String): Regex {
        val sb = StringBuilder("^")
        var i = 0
        while (i < glob.length) {
            val c = glob[i]
            when {
                c == '*' && i + 1 < glob.length && glob[i + 1] == '*' -> {
                    sb.append(".*")
                    i += 2
                    if (i < glob.length && glob[i] == '/') i++
                }
                c == '*' -> sb.append("[^/]*")
                c == '?' -> sb.append("[^/]")
                c == '.' || c == '(' || c == ')' || c == '+' || c == '|' || c == '^' || c == '$' || c == '\\' ->
                    sb.append('\\').append(c)
                else -> sb.append(c)
            }
            i++
        }
        sb.append("$")
        return Regex(sb.toString())
    }
}
