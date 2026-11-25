package ai.deepseek.harness.mobile.kernel.device

/**
 * 按文本选元素 —— 手机操控里「准确」维度最核心的一段判断。
 *
 * 抽出来的原因：这段逻辑原本长在 `PhoneControlService.findNodes` 里，输入输出都是
 * `AccessibilityNodeInfo`，于是只能在真机上目检。而它恰好有四个容易错的语义
 * （空查询、精确/模糊、可见优先、树序即 ordinal），任何一个错都表现为
 * 「点到了隔壁元素」—— 用户看到的是「AI 乱点」，排查时却看不出是哪一步错的。
 *
 * 现在它只吃 [Cand]（文本/聚合标签/是否可见），可以完整单测。
 * Android 侧只负责把节点映射成 [Cand]、再用返回的下标取回节点。
 */
object NodeMatch {

    /**
     * 一个候选节点的匹配相关属性。
     *
     * @param text 节点自身文本（不含子节点）
     * @param label 聚合标签（自身文本 + 子节点文本，某些控件的可读文本只在后者里）
     * @param visible 是否对用户可见
     */
    data class Cand(val text: String, val label: String, val visible: Boolean)

    /** 单个字段是否命中。空值永不命中 —— 否则「查空串」会把整屏都算成匹配。 */
    fun hit(value: String, query: String, exact: Boolean): Boolean {
        if (value.isBlank() || query.isBlank()) return false
        return if (exact) value == query else value.contains(query, ignoreCase = true)
    }

    /**
     * 返回命中候选的**下标**（保持传入顺序 = 无障碍树的树序，`ordinal` 才稳定）。
     *
     * 优先级（与原实现逐级对齐）：
     *   1. 可见 + 自身文本
     *   2. 可见 + 聚合标签
     *   3. 全部 + 自身文本
     *   4. 全部 + 聚合标签
     *
     * 为什么要「可见优先、全不可见才放宽」：列表里的元素常常在屏幕外仍然存在，
     * 直接按树序取第一个会选中屏幕外的那个（然后靠 scrollIntoView 硬滚，
     * 用户看到界面莫名其妙跳一下）。先可见，是为了让 ordinal 数的是「看得见的第 N 个」。
     */
    fun select(cands: List<Cand>, query: String, exact: Boolean): List<Int> {
        if (query.isBlank()) return emptyList()
        val idx = cands.indices.toList()

        fun byText(list: List<Int>) = list.filter { hit(cands[it].text, query, exact) }
        fun byLabel(list: List<Int>) = list.filter { hit(cands[it].label, query, exact) }

        val visible = idx.filter { cands[it].visible }
        return byText(visible)
            .ifEmpty { byLabel(visible) }
            .ifEmpty { byText(idx) }
            .ifEmpty { byLabel(idx) }
    }

    /**
     * `ordinal` 越界时的 hint 文案（1 起）。
     *
     * 单独抽出来是因为这句话直接决定模型下一步做得对不对：它必须给出**合法范围**，
     * 否则模型会拿着同一个越界值原地重试。原文案保持一字不改，只是不再散落在 execute 里。
     */
    fun ordinalHint(matched: Int): String = "ordinal 取 1..$matched；先 screen_read 确认目标位置"
}
