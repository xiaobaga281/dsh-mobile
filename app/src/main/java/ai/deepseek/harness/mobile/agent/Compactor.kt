package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject

/**
 * 上下文压缩 —— 对应桌面 Harness 的 `compaction` 子系统，但按手机的调用方式重排。
 *
 * 桌面版在 `agent/pre-step` 里分层处理压力，手机端照同一顺序落地：
 *   1. **剪枝**（对应 `compaction-tool-result-pruner`）：先把早期工具输出折成一行摘要。
 *      工具结果是历史里最占地方、信息密度最低的部分，扔掉它们几乎无损。
 *   2. **摘要**（对应 `compaction-basic`）：仍然超预算时，把最老的一段对话交给模型，
 *      按固定八段结构写成一份「检查点」，再用它替换掉那段原文。
 *   3. **兜底**：模型不可用/摘要失败时，退回确定性裁剪，保证请求一定发得出去。
 *
 * WS3 新增（对齐桌面 compaction-basic 的两个触发点）：
 *   · [compactInTurn]：同一轮内每一步之前的压力压缩（桌面 `agent/pre-step` 的等价物），
 *     由 `keepFrom` 圈定「本轮消息」不被压缩。
 *   · [compactForOverflow]：`CONTEXT_OVERFLOW` 恢复链用的一次强制压缩（桌面
 *     `agent/request-error` + `context-overflow`）；只有真的产生缩减
 *     （[Result.shrunk]）调用方才允许重发，最多 [MAX_OVERFLOW_RETRIES] 次。
 *   · 预算阈值对齐桌面：`min(contextWindow*0.8, contextWindow-maxOut-1024)`，
 *     并为最近的对话保留约 16% 窗口。
 *
 * 摘要提示词与替换文案都对齐桌面版：用 `<compacted-summary>` 包住正文，
 * 并在前面写明这是自动检查点、当作既定背景、不要复述。
 */
class Compactor(private val log: (String) -> Unit = {}) {

    data class Result(
        val messages: List<JSONObject>,
        val dropped: Int,
        val beforeTokens: Int,
        val afterTokens: Int,
        val note: String?,
        /** 是否真的走了「模型摘要」这条路径 */
        val summarized: Boolean = false,
        /** 被摘要掉的消息条数（剪枝不算） */
        val summarizedCount: Int = 0,
        /** 检查点正文（摘要路径才有）：界面据此提供展开查看 */
        val summary: String? = null,
        /** 本次被折成一行的早期工具输出条数（只在「只剪枝」路径非 0，前端据此区分文案）。 */
        val folded: Int = 0,
    ) {
        /** 是否产生了真实缩减：溢出重发必须以它为闸门。 */
        val shrunk: Boolean get() = afterTokens < beforeTokens
    }

    fun estimate(text: String): Int {
        var cjk = 0
        var other = 0
        text.forEach { ch -> if (ch.code in 0x2E80..0x9FFF || ch.code in 0xFF00..0xFFEF) cjk++ else other++ }
        return cjk + (other / 3.5).toInt() + 1
    }

    fun estimate(msg: JSONObject): Int {
        val content = msg.opt("content")
        val text = when (content) {
            is String -> content
            is JSONArray -> buildString {
                for (i in 0 until content.length()) {
                    val part = content.optJSONObject(i) ?: continue
                    append(part.optString("text"))
                    if (part.optString("type") == "image_url") append(" [图片] ")
                }
            }
            else -> ""
        }
        return estimate(text) + 6 + (msg.optJSONArray("tool_calls")?.length() ?: 0) * 30
    }

    private fun tokensOf(messages: List<JSONObject>): Int = messages.sumOf { estimate(it) }

    /* ---------------- 1. 剪枝：早期工具输出折成一行 ---------------- */

    /** 最近这么多次工具结果保留原文，更早的折叠 */
    private val keepRecentTools = 4
    /** 工具结果超过这个字符数才折叠 */
    private val foldAbove = 360

    /** 折剪结果：messages 是折剪后的历史，folded 是真正被折成一条的输出数。 */
    private data class Pruned(val messages: List<JSONObject>, val folded: Int)

    private fun pruneToolResults(history: List<JSONObject>): Pruned {
        val toolIndexes = history.indices.filter { history[it].optString("role") == "tool" }
        if (toolIndexes.isEmpty()) return Pruned(history, 0)
        // 最后一轮刚跑完的工具结果不许折：最后一条 user 消息之后的一切（工具输出、
        // 助手复述）都是模型「眼下的工作记忆」，折掉它模型下一步就失忆 —— 比省的那点
        // 窗口贵得多。keepRecentTools 只约束更早的轮次。
        // （轮内压缩时本轮整体在 pinned 里，进不到这里；这条防线护的是轮首/溢出路径
        //  的上一轮工具段。）
        val protectFrom = history.indexOfLast { it.optString("role") == "user" } + 1
        val foldable = toolIndexes.filter { it < protectFrom }
        val foldBefore = foldable.size - keepRecentTools
        if (foldBefore <= 0) return Pruned(history, 0)
        val folded = HashSet<Int>(foldable.take(foldBefore))
        var count = 0
        val out = history.mapIndexed { index, msg ->
            if (index !in folded) return@mapIndexed msg
            val content = msg.optString("content")
            if (content.length <= foldAbove) return@mapIndexed msg
            val head = content.take(160).replace("\n", " ⏎ ")
            count++
            JSONObject(msg.toString()).put(
                "content",
                "$head …（工具输出已折叠，原 ${content.length} 字；需要细节时重新调用工具，不要凭记忆猜）",
            )
        }
        return if (count > 0) Pruned(out, count) else Pruned(history, 0)
    }

    /* ---------------- 2. 摘要：模型写检查点 ---------------- */

    /** 与桌面 `compaction-basic` 同一套骨架，换成中文表述。 */
    private val compactionInstruction = listOf(
        "你现在是这台 AI 编程助手的上下文压缩引擎。把上面的对话浓缩成一份结构化检查点，让另一个模型能无损接着干。",
        "",
        "严格按下面的 Markdown 结构输出，段落顺序与标题都不变；用短句要点，不要写散文；某段没有内容就写「（无）」，任何一段都不能省。",
        "",
        "## 主要请求与意图",
        "- [用户最初和后来变化的目标；措辞重要处原样引用]",
        "",
        "## 关键技术概念",
        "- [技术、框架、模式、约定]",
        "",
        "## 文件与代码",
        "- [精确路径：为什么重要、改了哪些关键点或片段]",
        "",
        "## 错误与修复",
        "- [错误原文：怎么解决的，以及相关用户反馈]",
        "",
        "## 待办事项",
        "- [用户明确要求但尚未完成的]",
        "",
        "## 当前进展",
        "- [检查点这一刻正在做什么]",
        "",
        "## 下一步",
        "- [一个最直接的下一个动作，或「（无）」]",
        "",
        "## 关键上下文",
        "- [决策与理由、约束、用户偏好、未决问题、继续所需的数据]",
        "",
        "规则：",
        "- 用简洁的中文工程语言；精确保留文件路径、命令、错误原文、标识符、数值、函数签名、代码片段。",
        "- 忠实记录用户的反馈与明确指令，尤其是纠正。",
        "- 如果对话里已经有 <compacted-summary> 块，那是上一份检查点：保留仍然成立的事实，丢弃过时内容，把新信息合并进同一份摘要。",
        "- 不要提「压缩」这件事，不要调用工具，只输出检查点正文。",
        "- 总长度控制在 1200 字以内。",
    ).joinToString("\n")

    private fun transcript(span: List<JSONObject>, limitPerMessage: Int = 1200): String = buildString {
        for (msg in span) {
            val role = msg.optString("role")
            val content = msg.optString("content")
            val calls = msg.optJSONArray("tool_calls")
            if (content.isBlank() && calls == null) continue
            append('[').append(
                when (role) {
                    "user" -> "用户"
                    "assistant" -> "助手"
                    "tool" -> "工具结果"
                    else -> role
                },
            ).append("] ")
            append(content.take(limitPerMessage).trim())
            if (calls != null) {
                for (i in 0 until calls.length()) {
                    val call = calls.optJSONObject(i) ?: continue
                    append("\n（调用工具 ").append(call.optString("name")).append("：")
                    append(call.optString("arguments").take(240)).append("）")
                }
            }
            append("\n\n")
        }
    }

    /**
     * 让模型把 [span] 写成检查点。失败返回 null，调用方回退到裁剪。
     * maxInputChars 限制送进去的原文长度：摘要请求本身也不能把窗口撑爆。
     */
    private fun summarize(llm: LlmClient, model: String, span: List<JSONObject>): String? {
        val text = transcript(span)
        if (text.isBlank()) return null
        val body = JSONObject().apply {
            put("model", model)
            put("messages", JSONArray().apply {
                put(JSONObject().put("role", "system").put("content", compactionInstruction))
                put(
                    JSONObject().put("role", "user").put(
                        "content",
                        text.take(28_000) + "\n\n---\n以上是较早的一段对话。现在按要求的结构输出检查点正文。",
                    ),
                )
            })
            put("stream", true)
            put("max_tokens", 1800)
            put("thinking", JSONObject().put("type", "disabled"))
        }
        return try {
            val result = llm.stream(body, {}, {})
            val summary = result.text.trim()
            if (summary.length < 40) null else summary
        } catch (error: Throwable) {
            log("上下文摘要失败，回退为裁剪：${error.message ?: error::class.java.simpleName}")
            null
        }
    }

    private fun checkpointMessage(summary: String, count: Int, before: Int, after: Int): JSONObject =
        JSONObject().put("role", "user").put(
            "content",
            "（自动检查点：下面这段总结了更早的 $count 条消息，用来释放上下文（约 $before → $after tokens）。" +
                "把它当作已经确立的背景，不要复述，直接从后面的消息继续。）\n" +
                "<compacted-summary>\n$summary\n</compacted-summary>",
        )

    /* ---------------- 对外入口 ---------------- */

    /**
     * 确定性裁剪：模型不可用、或摘要失败时的兜底。
     *
     * @param system 系统提示（不参与裁剪，只计入预算）
     * @param history 已按时间排序的历史（不含本轮用户输入）
     * @param userText 本轮用户输入（永远保留）
     */
    fun apply(
        system: String,
        history: List<JSONObject>,
        userText: String,
        contextWindow: Int,
        maxOut: Int,
        mode: String,
    ): Result = clip(
        system = system,
        prefix = history,
        pinned = listOf(JSONObject().put("role", "user").put("content", userText)),
        budget = budgetOf(contextWindow, maxOut, mode),
    )

    /**
     * 轮首压力压缩：`history` 是本轮用户输入**之前**的全部历史（整段可压缩），
     * `userText` 是本轮输入，永远原样保留。
     *
     * 旧签名里的 `keepFrom` 已删：它的「默认 0 表示整段历史都可压缩」和实现
     * （`prefix = history.take(0) = 空`）正相反 —— 默认值下整个历史被 pin 住，
     * 轮首压缩从未压过任何东西。历史里若真有不能动的「本轮」，那是
     * [compactInTurn] 的职责（keepFrom = 本轮起点），不要混进这个入口。
     */
    fun applySmart(
        llm: LlmClient?,
        model: String,
        system: String,
        history: List<JSONObject>,
        userText: String,
        contextWindow: Int,
        maxOut: Int,
        mode: String,
        onCompacting: (before: Int, budget: Int) -> Unit = { _, _ -> },
    ): Result = compactRegion(
        llm, model, system, history,
        listOf(JSONObject().put("role", "user").put("content", userText)),
        contextWindow, maxOut, mode, force = false, onCompacting,
    )

    /**
     * 同一轮内、每一步之前的压力压缩（桌面 `agent/pre-step` 的等价物）。
     *
     * `messages` 是完整对话（含本条用户消息）；`keepFrom` 之后是本轮已经发生的消息，
     * 必须原样保留 —— 压缩不能把模型刚做完的事从眼前抽走。
     */
    fun compactInTurn(
        llm: LlmClient?,
        model: String,
        system: String,
        messages: List<JSONObject>,
        keepFrom: Int,
        contextWindow: Int,
        maxOut: Int,
        mode: String,
        onCompacting: (before: Int, budget: Int) -> Unit = { _, _ -> },
    ): Result {
        val from = keepFrom.coerceIn(0, messages.size)
        return compactRegion(
            llm, model, system, messages.take(from), messages.drop(from),
            contextWindow, maxOut, mode, force = false, onCompacting,
        )
    }

    /**
     * 上下文溢出后的强制压缩（桌面 `agent/request-error` + `context-overflow` 分支）。
     *
     * 与压力压缩的差别：**不看普通阈值**，先剪枝再摘要/裁剪，只要能真的变小就返回；
     * 调用方以 [Result.shrunk] 为唯一重发闸门。
     */
    fun compactForOverflow(
        llm: LlmClient?,
        model: String,
        system: String,
        messages: List<JSONObject>,
        keepFrom: Int,
        contextWindow: Int,
        maxOut: Int,
        mode: String,
        onCompacting: (before: Int, budget: Int) -> Unit = { _, _ -> },
    ): Result {
        val from = keepFrom.coerceIn(0, messages.size)
        return compactRegion(
            llm, model, system, messages.take(from), messages.drop(from),
            contextWindow, maxOut, mode, force = true, onCompacting,
        )
    }

    /* ---------------- 内部：统一的压缩区域处理 ---------------- */

    private fun compactRegion(
        llm: LlmClient?,
        model: String,
        system: String,
        prefix: List<JSONObject>,
        pinned: List<JSONObject>,
        contextWindow: Int,
        maxOut: Int,
        mode: String,
        force: Boolean,
        onCompacting: (before: Int, budget: Int) -> Unit,
    ): Result {
        val budget = budgetOf(contextWindow, maxOut, mode)
        val systemTokens = estimate(system)
        val pinnedTokens = tokensOf(pinned)
        val before = systemTokens + tokensOf(prefix) + pinnedTokens
        if (mode == "off" || (!force && before <= budget)) {
            return Result(prefix + pinned, 0, before, before, null)
        }

        // 第一层：折叠早期工具输出。多数情况到这一步就够了，一次模型调用都不用。
        val prunedResult = pruneToolResults(prefix)
        val pruned = prunedResult.messages
        val afterPrune = systemTokens + tokensOf(pruned) + pinnedTokens
        if (!force && afterPrune <= budget) {
            val note = "压缩上下文：折叠早期工具输出（约 $before → $afterPrune tokens）"
            log(note)
            return Result(
                pruned + pinned, dropped = 0, beforeTokens = before, afterTokens = afterPrune,
                note = note, folded = prunedResult.folded,
            )
        }

        // 第二层：选出「保留区」，剩下的交给模型写检查点。
        val keepBudget = (budget - systemTokens - pinnedTokens).coerceAtLeast(0)
        val retainFloor = (contextWindow * RETAIN_RATIO).toInt().coerceAtMost(keepBudget)
        val kept = ArrayDeque<JSONObject>()
        var used = 0
        for (i in pruned.indices.reversed()) {
            val cost = estimate(pruned[i])
            // 达到保留下限之前，即使略超预算也继续保留（比历史断裂强）
            if (used + cost > keepBudget && used >= retainFloor) break
            kept.addFirst(pruned[i])
            used += cost
        }
        val dropCount = pruned.size - kept.size
        if (dropCount <= 0) {
            return Result(
                pruned + pinned, 0, before, afterPrune, null,
                folded = prunedResult.folded,
            )
        }

        val span = pruned.take(dropCount)
        val spanTokens = tokensOf(span)
        // 太短的一段不值得花一次模型调用（强制恢复时从第一条就值得）
        val minSpan = if (force) 1 else 320
        if (llm != null && spanTokens >= minSpan) {
            onCompacting(before, budget)
            val summary = summarize(llm, model, span)
            if (summary != null) {
                val out = ArrayList<JSONObject>(kept.size + pinned.size + 1)
                val afterSummary = systemTokens + estimate(summary) + 32 + used + pinnedTokens
                out.add(checkpointMessage(summary, dropCount, before, afterSummary))
                out.addAll(kept)
                out.addAll(pinned)
                val after = systemTokens + tokensOf(out)
                val note = "已压缩上下文：$dropCount 条较早消息摘要为检查点（约 $before → $after tokens）"
                log(note)
                return Result(
                    out, dropCount, before, after, note,
                    summarized = true, summarizedCount = dropCount, summary = summary,
                )
            }
        }

        // 第三层：兜底裁剪（保留剪枝结果与 pinned）。
        return clip(system, pruned, pinned, budget, before, folded = prunedResult.folded)
    }

    /** 从最老的消息开始丢弃，直到装进预算；pinned（本轮）永远保留。 */
    private fun clip(
        system: String,
        prefix: List<JSONObject>,
        pinned: List<JSONObject>,
        budget: Int,
        beforeOverride: Int? = null,
        folded: Int = 0,
    ): Result {
        val systemTokens = estimate(system)
        val before = beforeOverride ?: (systemTokens + tokensOf(prefix) + tokensOf(pinned))
        val kept = ArrayDeque<JSONObject>()
        var used = systemTokens + tokensOf(pinned)
        for (i in prefix.indices.reversed()) {
            val cost = estimate(prefix[i])
            if (used + cost > budget) break
            kept.addFirst(prefix[i])
            used += cost
        }
        val dropped = prefix.size - kept.size
        val out = ArrayList<JSONObject>(kept.size + pinned.size)
        out.addAll(kept)
        out.addAll(pinned)
        val after = systemTokens + tokensOf(out)
        if (dropped <= 0 || after >= before) {
            // 没有收益：保持原样，别为了「看起来压缩了」把上下文撑大
            return Result(prefix + pinned, 0, before, before, null, folded = folded)
        }
        val note = "压缩上下文：省略 $dropped 条较早消息（约 $before → $after tokens）"
        log(note)
        return Result(out, dropped, before, after, note, folded = folded)
    }

    /**
     * 预算：`min(contextWindow * 0.8, contextWindow - maxOut - 1024)`，下限 2048。
     * 与桌面 `resolveCompactSpec` 同口径：先扣输出上限，再留 20% 余量。
     */
    fun budgetOf(contextWindow: Int, maxOut: Int, mode: String): Int {
        if (mode == "off") return maxOf(2048, contextWindow)
        val ratio = if (mode == "aggressive") 0.70 else 0.80
        val byRatio = (contextWindow * ratio).toInt()
        val byReserve = contextWindow - maxOut - 1024
        return maxOf(2048, minOf(byRatio, byReserve))
    }

    companion object {
        /** 桌面 compaction-basic 的 `maxOverflowRetries` 默认值：一次。 */
        const val MAX_OVERFLOW_RETRIES = 1

        /** 为最近的对话保留的窗口占比（桌面 `retainTokens` 的同义参数）。 */
        const val RETAIN_RATIO = 0.16
    }
}
