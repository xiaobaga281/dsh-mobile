package ai.deepseek.harness.mobile.agent

import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong

/**
 * 工具结果溢出（spill）的**纯策略** —— 只回答三个问题，不碰线程、不碰钩子：
 *
 *   1. 这段结果要不要落盘？（按 token 预算判定，按字符数判定会低估中文、高估代码）
 *   2. 落盘后留给模型什么？（首尾各半：开头有调用参数/表头，结尾有错误尾/最后几行）
 *   3. 落不下的时候说什么？（如实说「没存下来」，绝不报一个不存在的路径）
 *
 * 为什么单独成类：原来的实现把「截断 + 落盘 + 骗人提示」写死在流水线里，
 * 结果只能靠读代码确认行为，也测不了。这里全是纯函数 + 一个可注入的落盘目录，
 * JVM 单测直接覆盖（见 SpillPolicyTest）。
 *
 * 三类必须遵守的规矩，都写在上一次真机事故里：
 *   · **token 预算**：24000 字符对中文约 24000 tokens，对代码约 7000 —— 同一句「太长就截」
 *     对两者完全不是一回事。默认 12500 tokens（`Compactor.estimate` 口径）。
 *   · **read / read_image 豁免**：read 的结果是模型主动要的原文，截了它模型会再 read 一次，
 *     落盘后按提示再 read 又会命中同样的截断 —— 递归 spill，永远读不完。
 *   · **写失败不撒谎**：以前 `runCatching { writeText }` 失败也照样回「完整内容见 xxx」，
 *     模型去读必然报「文件不存在」，然后把整轮判断建立在一个不存在的证据上。
 */
class SpillPolicy(
    /** 落盘目录（已含 session-<hash> 段）；null = 本次运行没有可写目录，只能纯截断 */
    private val spillDir: File?,
    /** 工作区根：落点在工作区内时 locator 用相对路径（标准权限下 read 读得回来） */
    private val workspaceRoot: File? = null,
    /** 留给模型的 inline token 预算（头尾合计，不含提示语） */
    val maxInlineTokens: Int = DEFAULT_MAX_INLINE_TOKENS,
    /** 估算函数：默认 [Compactor.estimate]（CJK 1 token/字，其它 1 token/3.5 字符） */
    private val estimateText: (String) -> Int = { Compactor().estimate(it) },
) {

    /** 一次截断的几何：保留的头部、尾部，以及被丢掉的部分（字符数与 UTF-8 字节数） */
    data class Plan(
        val head: String,
        val tail: String,
        val omittedChars: Int,
        val omittedBytes: Int,
    )

    /** 组装结果：text 就是要回给模型的全部内容 */
    data class Rendered(
        val text: String,
        /** 是否真的落盘成功（false 时 text 里不会有任何路径） */
        val spilled: Boolean,
        /** 落盘位置（给日志/会话记录用；模型看到的是 text 里的 locator） */
        val locator: String?,
    )

    /** 豁免名单：读类工具的结果本身就是模型要的原文，截断会导致「再读一次又被截」 */
    fun isExempt(tool: String): Boolean = tool in EXEMPT_TOOLS

    /** 是否需要落盘：按 token 估算，不考虑豁免 */
    fun needsSpill(tool: String, text: String): Boolean =
        !isExempt(tool) && text.isNotEmpty() && estimateText(text) > maxInlineTokens

    /**
     * 计算首尾切分。
     *
     * 每次切分都从**字符边界**退让到**码点边界**：UTF-8/UTF-16 里一个 emoji 是两个 char，
     * 切在中间会得到孤立代理项 —— 落盘文件本身没坏，但回给模型的文本会变成乱码，
     * 更容易在后续 JSON 序列化里炸掉整轮请求。
     */
    fun plan(text: String): Plan {
        val halfBudget = halfTokenBudget()
        val headEnd = headChars(text, halfBudget)
        val tailFrom = tailStart(text, halfBudget)
        if (tailFrom <= headEnd) {
            // 文本短到首尾相接：没有真正省略什么，原样返回（调用方仍可按 needsSpill 判断）
            return Plan(text, "", 0, 0)
        }
        val omitted = text.substring(headEnd, tailFrom)
        return Plan(
            head = text.substring(0, headEnd),
            tail = text.substring(tailFrom),
            omittedChars = omitted.length,
            omittedBytes = omitted.toByteArray(Charsets.UTF_8).size,
        )
    }

    /**
     * 决定 + 落盘 + 组装。
     *
     * @param tool 工具名（决定豁免与文件名）
     * @param text post-execute 之后的最终文本
     * @param hint 文件名里的可读提示（默认用工具名）
     */
    fun render(tool: String, text: String, hint: String = tool): Rendered {
        if (!needsSpill(tool, text)) return Rendered(text, false, null)
        val p = plan(text)

        val target = spillDir?.let { File(it, fileName(tool, hint)) }
        val locator = target?.let { file ->
            // 落盘失败必须当失败处理：宁可告诉模型「没存下来」，也不能给一个读不到的路径
            val ok = runCatching {
                file.parentFile?.mkdirs()
                file.writeText(text)
                file.isFile && file.length() > 0
            }.getOrDefault(false)
            if (ok) locatorOf(file) else null
        }

        if (locator == null) {
            val notice = "\n\n…（结果过长，已截断：省略 ${p.omittedChars} 字符 / ${p.omittedBytes} 字节）" +
                "(full result unavailable: storage error)"
            return Rendered(p.head + notice, false, null)
        }

        val where = if (inWorkspace(locator)) {
            "读取方式：read(file_path=\"$locator\", offset=1, limit=150) 分页读取；每次 limit 不要超过 150 行，" +
                "否则读回的结果会再被截断"
        } else {
            // 工作区外（应用私有目录）：标准权限的 read 读不到，但提示依然要给**可执行**的读法，
            // 只写「读不到」等于把包袱丢回给模型，它下一步只能瞎猜。
            "该文件在工作区之外（应用私有目录）。读取方式：完全访问权限下 " +
                "read(file_path=\"$locator\", offset=1, limit=150) 分页读取；标准权限下可用 bash 执行 " +
                "cat \"$locator\""
        }
        val notice = "\n\n…（结果过长：共 ${text.length} 字符，已省略 ${p.omittedChars} 字符 / " +
            "${p.omittedBytes} 字节，只保留首尾各约 ${halfTokenBudget()} tokens）\n" +
            "完整内容已落盘：$locator\n$where\n\n"
        return Rendered(p.head + notice + p.tail, true, locator)
    }

    /* ---------------- 切分工具（公开给测试/复用） ---------------- */

    /** 从头部取不超过 [budget] tokens 的最长前缀长度（不切开代理对） */
    fun headChars(text: String, budget: Int): Int = avoidSplitHead(text, countForward(text, budget))

    /** 从尾部取不超过 [budget] tokens 的最长后缀的起始下标（不切开代理对） */
    fun tailStart(text: String, budget: Int): Int = avoidSplitTail(text, countBackward(text, budget))

    /** 头部有多少 token（与 [Compactor.estimate] 同口径） */
    fun tokensOf(text: String): Int = estimateText(text)

    private fun halfTokenBudget(): Int {
        // 提示语本身也占预算：先扣掉再对半分，保证 head+tail 仍落在 maxInlineTokens 以内
        val usable = (maxInlineTokens - NOTICE_TOKEN_RESERVE).coerceAtLeast(2)
        return (usable / 2).coerceAtLeast(1)
    }

    private fun countForward(text: String, budget: Int): Int {
        var cjk = 0
        var other = 0
        var i = 0
        while (i < text.length) {
            val wide = isCjk(text[i])
            val nextCjk = if (wide) cjk + 1 else cjk
            val nextOther = if (wide) other else other + 1
            if (estimateCounts(nextCjk, nextOther) > budget) break
            cjk = nextCjk
            other = nextOther
            i++
        }
        return i
    }

    private fun countBackward(text: String, budget: Int): Int {
        var cjk = 0
        var other = 0
        var i = text.length
        while (i > 0) {
            val wide = isCjk(text[i - 1])
            val nextCjk = if (wide) cjk + 1 else cjk
            val nextOther = if (wide) other else other + 1
            if (estimateCounts(nextCjk, nextOther) > budget) break
            cjk = nextCjk
            other = nextOther
            i--
        }
        return i
    }

    private fun estimateCounts(cjk: Int, other: Int): Int = cjk + (other / 3.5).toInt() + 1

    private fun avoidSplitHead(text: String, cut: Int): Int =
        if (cut in 1 until text.length && text[cut - 1].isHighSurrogate() && text[cut].isLowSurrogate()) cut - 1 else cut

    private fun avoidSplitTail(text: String, start: Int): Int =
        if (start in 1 until text.length && text[start].isLowSurrogate() && text[start - 1].isHighSurrogate()) start + 1 else start

    private fun locatorOf(file: File): String {
        val root = workspaceRoot ?: return file.absolutePath
        val base = runCatching { root.canonicalPath }.getOrElse { root.absolutePath }
        val path = runCatching { file.canonicalPath }.getOrElse { file.absolutePath }
        return if (path == base || path.startsWith("$base${File.separator}")) {
            path.removePrefix("$base${File.separator}")
        } else path
    }

    /** locator 是不是「工作区相对路径」；绝对路径（含 Windows 盘符）都算工作区外 */
    private fun inWorkspace(locator: String): Boolean = !File(locator).isAbsolute

    private fun fileName(tool: String, hint: String): String =
        "tool-${System.currentTimeMillis()}-${SEQ.incrementAndGet()}-${slug(hint.ifBlank { tool })}.txt"

    private fun slug(raw: String): String {
        val s = raw.map { if (it.isLetterOrDigit() || it == '_' || it == '-') it else '_' }.joinToString("")
        return s.take(40).ifBlank { "result" }
    }

    companion object {
        /** 默认 inline 预算（token）：约等于 40k 英文字符 / 12.5k 汉字的上下文占用 */
        const val DEFAULT_MAX_INLINE_TOKENS = 12_500

        /** 30 天后清掉 spill（真机存储小，会话记录才是长期真相） */
        const val RETENTION_MS = 30L * 24 * 60 * 60 * 1000

        /**
         * spill 总量上限：手机存储是按 MB 计较的，光有 30 天龄期等于「一两周内能写满就写满」。
         * 超出后按目录时间从旧到新删，最近一轮的溢出永远留得住。
         */
        const val MAX_BYTES = 64L * 1024 * 1024

        /** 提示语预留的 token（locator + 两个数字 + 分页建议） */
        private const val NOTICE_TOKEN_RESERVE = 250

        /** read 类工具豁免：它们的结果就是模型要的原文 */
        val EXEMPT_TOOLS = setOf("read", "read_image")

        private val SEQ = AtomicLong(0)

        /** `filesDir/spill/session-<hash>`（拿不到 app 私有目录时调用方退回工作区 `.dsh/spill`） */
        fun sessionDir(spillRoot: File?, sessionId: String?): File? =
            spillRoot?.let { File(it, sessionDirName(sessionId)) }

        /** 会话目录名：只暴露 8 位哈希，会话 id 不落进文件路径 */
        fun sessionDirName(sessionId: String?): String = "session-" + hash8(sessionId ?: "default")

        private fun hash8(seed: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray(Charsets.UTF_8))
            return digest.take(4).joinToString("") { "%02x".format(it) }
        }

        /**
         * 清理超过 [maxAgeMs] 的 spill 产物（目录或文件）。
         * 返回真正删掉的数量；目录不存在/不可读返回 0。调用方按需触发（内核启动或首次落盘时）。
         */
        fun cleanupOlderThan(
            spillRoot: File?,
            maxAgeMs: Long = RETENTION_MS,
            now: Long = System.currentTimeMillis(),
        ): Int {
            if (spillRoot == null || !spillRoot.isDirectory) return 0
            val cutoff = now - maxAgeMs
            if (cutoff <= 1) return 0
            var removed = 0
            spillRoot.listFiles()?.forEach { f ->
                val stamp = f.lastModified()
                // stamp == 0：某些文件系统拿不到时间，不能当「很久以前」直接删
                if (stamp in 1 until cutoff) {
                    val ok = runCatching { f.deleteRecursively() }.getOrDefault(false)
                    if (ok) removed++
                }
            }
            return removed
        }

        /** 一个目录（或文件）的字节数；不可读的部分按 0 计，不抛异常。 */
        fun dirBytes(root: File?, limit: Long = Long.MAX_VALUE): Long {
            val f = root ?: return 0L
            if (!f.exists()) return 0L
            if (!f.isDirectory) return f.length()
            var total = 0L
            val stack = ArrayDeque<File>()
            stack.addLast(f)
            while (stack.isNotEmpty()) {
                val cur = stack.removeLast()
                val kids = cur.listFiles() ?: continue
                kids.forEach { k ->
                    if (k.isDirectory) stack.addLast(k) else total += k.length()
                }
                if (total >= limit) return total
            }
            return total
        }

        /**
         * 把 spill 总量压回 [maxBytes]：按目录修改时间从旧到新删。
         * 返回删掉的字节数（近似：删之前先量一份）。
         */
        fun trimToBudget(spillRoot: File?, maxBytes: Long = MAX_BYTES): Long {
            val root = spillRoot ?: return 0L
            if (!root.isDirectory) return 0L
            var total = dirBytes(root)
            if (total <= maxBytes) return 0L
            var freed = 0L
            root.listFiles()?.sortedBy { it.lastModified() }?.forEach { d ->
                if (total <= maxBytes) return@forEach
                val size = dirBytes(d)
                val ok = runCatching { d.deleteRecursively() }.getOrDefault(false) && !d.exists()
                if (ok) {
                    freed += size
                    total -= size
                }
            }
            return freed
        }

        private fun isCjk(ch: Char): Boolean =
            ch.code in 0x2E80..0x9FFF || ch.code in 0xFF00..0xFFEF
    }
}
