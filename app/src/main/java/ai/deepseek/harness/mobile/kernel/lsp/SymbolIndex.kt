package ai.deepseek.harness.mobile.kernel.lsp

import ai.deepseek.harness.mobile.kernel.Workspace
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 内置符号索引提供方 —— 桌面 lsp 组的手机端等价物。
 *
 * 桌面架构（`packages/lsp/lsp/README.zh.md`）：「提供方注册的是能力而非工具」，
 * `tool-lsp` 是模型请求的唯一 owner，换提供方不改变模型看到的 schema。
 * 安卓端没有 node/python 去跑 typescript-language-server，所以这里是一个
 * 「正则符号索引」提供方：精度低于真 LSP，但每个结果都来自真实文件内容，不做假。
 *
 * **与桌面一致的一点，别误判成欠账**：桌面 lsp 刻意**不含诊断、符号列表、重命名、格式化**
 * （"diagnostics 需要独立的新鲜度与累积规则"）。手机端同样不做诊断，这不是差距。
 *
 * 本次改动（WP5）：
 *  1. **真缓存**。旧实现每次都 `walkTopDown` + 逐文件 `readLines()` 全量重扫 ——
 *     名为 index 实为 scanner，`hover` 一次就要把整个工作区读一遍。
 *     现在：定义索引 + 行缓存，按 (文件数, 最新 mtime) 失效，并带 TTL 防 stat 风暴。
 *  2. **稳定错误码**。`LSP_UNAVAILABLE` / `LSP_CONFLICT` 与桌面同名，调用方按 code 路由，
 *     不要去解析 message。
 *  3. **空结果 = 成功**（桌面语义："空结果是成功的无结果响应"），不再把"没找到"
 *     报成 `ok:false, NOT_FOUND` —— 那会让模型以为工具坏了。
 */
class SymbolIndex(private val ws: Workspace) {

    data class Hit(val file: String, val line: Int, val text: String)

    /** 稳定错误码（桌面 LspError.code） */
    object Errors {
        const val UNAVAILABLE = "LSP_UNAVAILABLE"
        const val CONFLICT = "LSP_CONFLICT"
    }

    private class Index(
        val defs: Map<String, List<Hit>>,
        val lines: Map<String, List<String>>,
        val fileCount: Int,
        val newestMtime: Long,
        val builtAt: Long,
        val truncated: Boolean,
    )

    @Volatile
    private var index: Index? = null
    private val lock = Any()

    private val exts = setOf(
        "kt", "java", "ts", "tsx", "js", "jsx", "py", "go", "rs", "c", "cc", "cpp", "h",
        "swift", "m", "mm", "rb", "php", "cs", "sh", "sql", "json", "yaml", "yml", "toml",
    )

    /** 定义语句模式：按语言族给出「符号在哪一行被定义」 */
    private val defPatterns = listOf(
        // Kotlin / Java
        Regex("""^\s*(?:public|private|protected|internal|open|abstract|final|static|suspend|override|inline|data|sealed|enum|annotation|\s)*\s*(?:class|object|interface|fun|val|var)\s+([A-Za-z_][\w]*)"""),
        Regex("""^\s*(?:public|private|protected|static|final|abstract|\s)*\s*[A-Za-z_][\w<>.,\s\[\]]*\s+([A-Za-z_]\w*)\s*\("""),
        // JS / TS
        Regex("""^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)"""),
        Regex("""^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)"""),
        Regex("""^\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)"""),
        Regex("""^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()"""),
        // Python
        Regex("""^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)"""),
        Regex("""^\s*class\s+([A-Za-z_]\w*)"""),
        // Go / Rust / C
        Regex("""^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)"""),
        Regex("""^\s*(?:pub\s+)?(?:struct|enum|trait|impl|fn|mod|type)\s+([A-Za-z_]\w*)"""),
        // 对象/字典键
        Regex("""^\s*["']?([A-Za-z_$][\w$]*)["']?\s*:\s*(?:function|\(|\{|async|new\b)"""),
    )

    /** 实现/继承关系 */
    private val implPatterns = listOf(
        Regex("""(?:class|object|interface)\s+\w+\s*(?::|extends|implements)\s*([\w<>, ]+)"""),
        Regex("""implements\s+([\w<>, ]+)"""),
    )

    /* ------------------------------------------------------------------ */
    /* 索引                                                                */
    /* ------------------------------------------------------------------ */

    private fun iterableFiles(): Sequence<File> =
        ws.root.walkTopDown()
            .onEnter { it.name != "node_modules" && !it.name.startsWith(".git") && it.name != "build" }
            .filter { it.isFile && it.extension.lowercase() in exts && it.length() < MAX_FILE_BYTES }

    /**
     * 取索引。失效判据 = (文件数, 最新 mtime) 变了；另外加 TTL，
     * 避免连续查询每次都做一遍 stat 遍历（文件多时 stat 也不便宜）。
     */
    private fun ensureIndex(): Index {
        val cached = index
        val now = System.currentTimeMillis()
        if (cached != null && now - cached.builtAt < TTL_MS) return cached
        synchronized(lock) {
            val again = index
            if (again != null && System.currentTimeMillis() - again.builtAt < TTL_MS) return again
            var count = 0
            var newest = 0L
            val files = ArrayList<File>()
            for (f in iterableFiles()) {
                if (count >= MAX_FILES) break
                count++
                if (f.lastModified() > newest) newest = f.lastModified()
                files.add(f)
            }
            if (again != null && again.fileCount == count && again.newestMtime == newest) {
                // 内容没变：只刷新 builtAt，省掉重建
                val refreshed = Index(
                    again.defs, again.lines, again.fileCount, again.newestMtime,
                    System.currentTimeMillis(), again.truncated,
                )
                index = refreshed
                return refreshed
            }
            val defs = HashMap<String, MutableList<Hit>>()
            val lines = HashMap<String, List<String>>()
            var cachedBytes = 0
            for (f in files) {
                val rel = ws.relative(f)
                val fileLines = runCatching { f.readLines() }.getOrDefault(emptyList())
                if (cachedBytes + f.length() <= MAX_CACHE_BYTES) {
                    lines[rel] = fileLines
                    cachedBytes += f.length().toInt()
                }
                fileLines.forEachIndexed { i, text ->
                    for (re in defPatterns) {
                        val m = re.find(text) ?: continue
                        val name = m.groupValues[1]
                        if (name.isNotBlank()) {
                            defs.getOrPut(name) { ArrayList() }.add(Hit(rel, i + 1, text.trim().take(200)))
                        }
                        break
                    }
                }
            }
            val built = Index(
                defs = defs,
                lines = lines,
                fileCount = count,
                newestMtime = newest,
                builtAt = System.currentTimeMillis(),
                truncated = count >= MAX_FILES,
            )
            index = built
            return built
        }
    }

    private fun linesOf(file: String, idx: Index): List<String> =
        idx.lines[file] ?: runCatching { File(ws.root, file).readLines() }.getOrDefault(emptyList())

    /* ------------------------------------------------------------------ */
    /* 查询                                                                */
    /* ------------------------------------------------------------------ */

    /** 光标（1-based line/character）所在标识符 */
    fun wordAt(file: String, line: Int, character: Int): String {
        val f = runCatching { ws.resolve(file, mustExist = true) }.getOrNull() ?: return ""
        val lines = runCatching { f.readLines() }.getOrDefault(emptyList())
        val l = lines.getOrNull(line - 1) ?: return ""
        val idx = (character - 1).coerceIn(0, l.length)
        var s = idx
        while (s > 0 && (l[s - 1].isLetterOrDigit() || l[s - 1] == '_' || l[s - 1] == '$')) s--
        var e = idx
        while (e < l.length && (l[e].isLetterOrDigit() || l[e] == '_' || l[e] == '$')) e++
        return l.substring(s, e)
    }

    private fun definitionsOf(word: String): List<Hit> = ensureIndex().defs[word] ?: emptyList()

    fun goToDefinition(file: String, line: Int, character: Int): String {
        unsupportedExtension(file)?.let { return it }
        val word = wordAt(file, line, character)
        if (word.isBlank()) return err(Errors.UNAVAILABLE, "光标处没有标识符", "把光标放到一个符号上再查询")
        val hits = definitionsOf(word)
        return ok("goToDefinition", word, hits)
    }

    fun findReferences(file: String, line: Int, character: Int, includeDeclaration: Boolean = true): String {
        unsupportedExtension(file)?.let { return it }
        val word = wordAt(file, line, character)
        if (word.isBlank()) return err(Errors.UNAVAILABLE, "光标处没有标识符", "把光标放到一个符号上再查询")
        val idx = ensureIndex()
        val pattern = Regex("""\b${Regex.escape(word)}\b""")
        val declLines = idx.defs[word].orEmpty().map { it.file to it.line }.toHashSet()
        val hits = ArrayList<Hit>()
        // 有行缓存的直接查缓存；超出缓存预算的文件按需读盘（不假装索引了全部）
        val files = idx.lines.keys.toList() + filesNotCached(idx)
        for (rel in files) {
            val lines = linesOf(rel, idx)
            lines.forEachIndexed { i, text ->
                if (!pattern.containsMatchIn(text)) return@forEachIndexed
                val isDecl = declLines.contains(rel to (i + 1))
                if (includeDeclaration || !isDecl) hits.add(Hit(rel, i + 1, text.trim().take(200)))
                if (hits.size >= MAX_HITS) return@forEachIndexed
            }
            if (hits.size >= MAX_HITS) break
        }
        return ok("findReferences", word, hits)
    }

    fun goToImplementation(file: String, line: Int, character: Int): String {
        unsupportedExtension(file)?.let { return it }
        val word = wordAt(file, line, character)
        if (word.isBlank()) return err(Errors.UNAVAILABLE, "光标处没有标识符", "把光标放到一个接口/协议名上再查询")
        val wordRe = Regex("""\b${Regex.escape(word)}\b""")
        val hits = ArrayList<Hit>()
        for (f in iterableFiles()) {
            val rel = ws.relative(f)
            val lines = runCatching { f.readLines() }.getOrDefault(emptyList())
            lines.forEachIndexed { i, text ->
                for (re in implPatterns) {
                    val m = re.find(text) ?: continue
                    val list = m.groupValues[1]
                    if (wordRe.containsMatchIn(list)) {
                        val name = defPatterns.firstNotNullOfOrNull { p ->
                            p.find(text)?.groupValues?.get(1)
                        }
                        hits.add(
                            Hit(rel, i + 1, text.trim().take(200) + if (name != null) "  → $name" else ""),
                        )
                        break
                    }
                }
            }
            if (hits.size >= MAX_HITS) break
        }
        return ok("goToImplementation", word, hits)
    }

    fun hover(file: String, line: Int, character: Int): String {
        unsupportedExtension(file)?.let { return it }
        val word = wordAt(file, line, character)
        if (word.isBlank()) return err(Errors.UNAVAILABLE, "光标处没有标识符", "把光标放到一个符号上再查询")
        val hits = definitionsOf(word)
        val first = hits.firstOrNull()
            ?: return ok("hover", word, emptyList(), markdown = "")
        val idx = ensureIndex()
        val lines = linesOf(first.file, idx)
        val sb = StringBuilder()
        for (i in (first.line - 6).coerceAtLeast(0) until first.line - 1) {
            val t = lines.getOrNull(i)?.trim().orEmpty()
            if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*") ||
                t.startsWith("/*") || t.startsWith("\"\"\"")
            ) {
                sb.appendLine(t)
            }
        }
        sb.appendLine(first.text)
        return ok("hover", word, listOf(first), markdown = sb.toString().trim())
    }

    /** 提供方自述（诊断/设置页用）：如实说明这不是完整的语言服务器 */
    fun describe(): JSONObject {
        val idx = runCatching { ensureIndex() }.getOrNull()
        return JSONObject().apply {
            put("provider", PROVIDER)
            put("precision", "regex")
            put("operations", JSONArray(listOf("goToDefinition", "findReferences", "goToImplementation", "hover")))
            put("diagnostics", false)
            put("note", "桌面 lsp 同样不含诊断；安卓端无语言服务器运行时，符号匹配用正则")
            idx?.let {
                put("indexed_files", it.fileCount)
                put("indexed_symbols", it.defs.size)
                put("cached_file_lines", it.lines.size)
                put("truncated", it.truncated)
                put("built_at", it.builtAt)
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 内部                                                                */
    /* ------------------------------------------------------------------ */

    private fun filesNotCached(idx: Index): List<String> =
        iterableFiles().map { ws.relative(it) }.filter { !idx.lines.containsKey(it) }.toList()

    private fun extensionOf(file: String): String =
        file.substringAfterLast('.', "").lowercase()

    /** 不支持的扩展名 → 桌面同款 LSP_UNAVAILABLE（而不是空结果） */
    private fun unsupportedExtension(file: String): String? {
        val ext = extensionOf(file)
        if (ext.isNotBlank() && ext in exts) return null
        return err(
            Errors.UNAVAILABLE,
            "没有能处理「${ext.ifBlank { "(无扩展名)" }}」的代码导航提供方（内置提供方支持 ${exts.size} 种扩展名）",
            "改用 grep 工具按符号名搜索；或换一个受支持类型（kt/java/ts/js/py/go/rs/c/cpp…）的文件再查",
        )
    }

    private fun ok(
        op: String,
        symbol: String,
        hits: List<Hit>,
        markdown: String? = null,
    ): String {
        val arr = JSONArray()
        hits.forEach { h ->
            arr.put(JSONObject().apply {
                put("file", h.file); put("line", h.line); put("text", h.text)
            })
        }
        val idx = index
        return JSONObject().apply {
            put("ok", true)
            put("operation", op)
            put("symbol", symbol)
            put("count", hits.size)
            put("locations", arr)
            if (markdown != null) put("markdown", markdown)
            put("provider", "$PROVIDER（安卓内置提供方，非完整语言服务器）")
            put("precision", "regex")
            // 空结果是成功的无结果响应（桌面语义），但要告诉模型它意味着什么
            if (hits.isEmpty()) {
                put(
                    "note",
                    "没有匹配项。空结果是正常的「没找到」，不是工具失败；" +
                        "正则索引只认定义行，间接实现/动态引用可能漏；可用 grep 按名字搜。",
                )
            }
            idx?.let { if (it.truncated) put("truncated", true) }
        }.toString()
    }

    private fun err(code: String, message: String, hint: String): String =
        JSONObject().apply {
            put("ok", false); put("code", code); put("error", message); put("hint", hint)
        }.toString()

    companion object {
        const val PROVIDER = "regex-symbol-index"
        /** 单文件上限：再大的文件不索引（避免一次查询读爆内存） */
        const val MAX_FILE_BYTES = 512L * 1024
        /** 索引文件数上限 */
        const val MAX_FILES = 5000
        /** 行缓存总量预算 */
        const val MAX_CACHE_BYTES = 16 * 1024 * 1024
        /** 命中数上限，防止一次查询把整个仓库倒给模型 */
        const val MAX_HITS = 200
        /** 缓存最短复用窗口：防连续查询反复 stat 遍历 */
        const val TTL_MS = 2_000L
    }
}
