package ai.deepseek.harness.mobile.kernel.agents

/**
 * 委派限制 —— 对齐桌面 `packages/subagent/subagent/src/index.ts` 的 `Config`：
 *
 * | 桌面 | 默认 | 语义 |
 * |---|---|---|
 * | `maxDepth` | 1 | 递归层级。0 = 禁用子智能体；1 = 只有主 Agent 能创建；2 起允许嵌套 |
 * | `maxActiveSubagents` | 8 | 同一主 Agent 下所有层级存活子智能体合计，主 Agent 不计入 |
 *
 * 桌面把这两个值放在「设置 → 子智能体 → 运行限制」里，只有这两项 + 模型选择。
 * 手机端同样只暴露这两个数（外加团队自己的「每人轮次」，那是唯一一个不属于子代理的旋钮）。
 */
data class SubagentLimits(
    val maxDepth: Int = 1,
    val maxParallel: Int = 8,
) {
    fun normalized(): SubagentLimits = SubagentLimits(
        maxDepth = maxDepth.coerceIn(0, 6),
        maxParallel = maxParallel.coerceIn(1, 16),
    )

    /** 某个深度的 Agent 还能不能再创建子智能体（深度 0 = 主 Agent） */
    fun canDelegate(depth: Int): Boolean = depth < maxDepth
}
