package ai.deepseek.harness.mobile.agent

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

/**
 * 意图分析流（对应桌面 Harness 的 request 前处理：决定这一轮要开哪些能力）。
 *
 * 桌面版靠多段 waterfall（pre-step / request / system-prompt）分头判断；
 * 手机端一次模型请求很贵、延迟敏感，所以把「这一句话想让我干什么」收敛成
 * 一个确定性的打分器，先给出路由结论，再由 Driver 按结论装配工具与提示词：
 *
 * - TASK     需要动手改东西 → 挂工具、允许写、多轮工具循环
 * - RESEARCH 需要外部信息   → 先联网/读文件，再作答
 * - PLAN     要方案不要执行 → 只读工具 + exit_plan_mode
 * - QUESTION 知识性问题     → 不挂工具，直接答（省 token、省时间）
 * - CHAT     闲聊/情绪      → 不挂工具
 * - CONTINUE 接着上一轮做   → 继承上一轮路由，不重新探索
 *
 * 置信度低且开启 [llmRefine] 时，Driver 会用一次极短的模型调用复核，
 * 复核结果只影响路由，不进入对话历史。
 */
class IntentRouter(
    private val log: (String) -> Unit = {},
) {

    enum class Kind { CHAT, QUESTION, TASK, RESEARCH, PLAN, CONTINUE, META }

    data class Intent(
        val kind: Kind,
        val confidence: Double,
        val needsTools: Boolean,
        val needsPlan: Boolean,
        val needsSearch: Boolean,
        val needsClarify: Boolean,
        val reason: String,
        val signals: List<String>,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("kind", kind.name.lowercase())
            put("confidence", (confidence * 100).toInt() / 100.0)
            put("needsTools", needsTools)
            put("needsPlan", needsPlan)
            put("needsSearch", needsSearch)
            put("needsClarify", needsClarify)
            put("reason", reason)
            put("signals", JSONArray(signals))
        }

        /** 注入系统提示的路由段落：告诉模型「这轮该怎么开工」，避免它在闲聊里乱开工具 */
        fun policyText(): String {
            val head = when (kind) {
                Kind.TASK -> "本轮意图：执行型任务。先确认现状（读文件/列目录），再动手改；改完说明改了哪些文件。"
                Kind.RESEARCH -> "本轮意图：信息检索型。先用搜索或读文件拿到事实，再基于事实回答，注明来源。"
                Kind.PLAN -> "本轮意图：规划型。只探索、不执行；产出可评审的计划并调用 exit_plan_mode。"
                Kind.QUESTION -> "本轮意图：知识问答。直接回答，不要为了回答去翻工作区。"
                Kind.CONTINUE -> "本轮意图：延续上一轮。接着上次的进度做，不要重复已经完成的步骤。"
                Kind.META -> "本轮意图：关于助手自身/配置的元问题。简短回答，必要时指出在哪个设置里改。"
                Kind.CHAT -> "本轮看起来像闲聊：自然、简短地回应；如果用户其实提出了具体操作，按操作照做。"
            }
            val tail = buildList {
                if (!needsTools) add("本轮没有挂工具：不要假装执行了任何操作。")
                if (needsSearch) add("需要外部信息时先检索再下结论。")
                if (needsClarify) add("信息不足：先用一句话问清最关键的一点，不要猜着开工。")
            }
            return (listOf(head) + tail).joinToString("\n")
        }
    }

    private val actionVerbs = listOf(
        "改", "修改", "写", "重写", "实现", "修复", "重构", "优化", "新增", "添加", "删除", "移除",
        "建", "创建", "生成", "替换", "迁移", "接入", "部署", "打包", "编译", "跑", "执行", "运行",
        "检查", "审查", "审计", "测试", "验证", "整理", "拆分", "合并", "升级", "降级", "配置",
        "读取", "读出", "读一下", "统计", "汇报", "列出", "列一下", "查找", "打开", "关闭",
        "下载", "上传", "安装", "卸载", "重启", "翻译", "总结", "提取", "导出", "导入", "重命名",
        "压缩", "解压", "粘贴", "输出", "贴给我", "发给我", "算一下", "数一下",
        "refactor", "implement", "fix", "add", "remove", "delete", "create", "build", "run", "test",
        "read", "list", "count", "stat", "export", "import", "install", "convert", "paste",
    )
    private val planningWords = listOf("计划", "方案", "规划", "步骤", "先…再", "设计一下", "出个方案", "调研")
    private val researchWords = listOf("搜", "查一下", "查查", "最新", "资料", "新闻", "文献", "官网", "联网", "来源")
    private val continueWords = listOf("继续", "接着", "下一步", "往下", "然后呢", "go on", "continue")
    private val chatWords = listOf("你好", "嗨", "谢谢", "在吗", "早上好", "晚安", "哈哈", "ok", "嗯")
    private val metaWords = listOf("设置", "怎么用", "为什么不能", "在哪", "配置项", "权限", "模型", "插件")
    private val questionWords = listOf("吗", "什么", "为什么", "怎么", "如何", "哪个", "多少", "是否", "能不能", "区别")

    fun detect(
        text: String,
        hasAttachments: Boolean,
        modePlan: Boolean,
        goalActive: Boolean,
        toolsEnabled: Boolean,
        priorKind: Kind? = null,
        msgCount: Int = 0,
    ): Intent {
        val t = text.trim()
        val lower = t.lowercase()
        val signals = mutableListOf<String>()
        var task = 0.0
        var research = 0.0
        var planning = 0.0
        var question = 0.0
        var chat = 0.0
        var cont = 0.0
        var meta = 0.0

        actionVerbs.forEach { v ->
            if (lower.contains(v)) { task += 1.0; if (signals.size < 8) signals.add("动作:$v") }
        }
        // 动作词只加一次权重，避免长句里堆叠
        task = min(task, 3.0)

        if (Regex("""[\w./-]+\.(kt|java|js|ts|tsx|py|md|json|gradle|xml|css|html|yaml|yml|txt|sql)\b""").containsMatchIn(t)) {
            task += 1.4; signals.add("文件引用")
        }
        if (t.contains("```")) { task += 0.8; signals.add("代码块") }
        if (hasAttachments) { task += 1.2; signals.add("附件") }
        if (Regex("""/[\w.-]+/[\w./-]*""").containsMatchIn(t)) { task += 0.5; signals.add("路径") }
        // 显式点名工具（英文工具名 / 「调用…工具」句式）：这是最强的任务信号——
        // 用户指名要用的东西，判成闲聊会注入「不要调用工具」的反向策略，直接压制模型动手
        val toolMention = Regex(
            "(调用|使用|同时|一起|并行)[^。\\n]{0,8}(工具|bash|终端)|" +
                "\\b(bash|terminal|web_search|web_fetch|read|write|edit|grep|glob|todo_write|" +
                "speak|skill|spawn_teammate|memory_save|schedule_create|run_code|phone_screenshot)\\b",
        ).containsMatchIn(lower)
        if (toolMention) { task += 2.2; signals.add("点名工具") }

        researchWords.forEach { if (lower.contains(it)) { research += 1.3; signals.add("检索:$it") } }
        if (Regex("""https?://""").containsMatchIn(t)) { research += 1.0; signals.add("链接") }

        planningWords.forEach { if (lower.contains(it)) { planning += 1.6; signals.add("规划:$it") } }
        if (t.contains("先") && (t.contains("再") || t.contains("然后"))) { planning += 1.0; signals.add("先…再") }

        questionWords.forEach { if (lower.contains(it)) { question += 0.7 } }
        if (t.endsWith("?") || t.endsWith("？")) { question += 1.4; signals.add("问号") }
        if (t.length <= 12 && !actionVerbs.any { lower.contains(it) }) { question += 0.6 }

        chatWords.forEach { if (lower == it || (t.length <= 6 && lower.contains(it))) { chat += 2.0; signals.add("寒暄") } }
        continueWords.forEach { if (lower.startsWith(it) || lower.contains(it)) { cont += 1.8; signals.add("延续") } }
        metaWords.forEach { if (lower.contains(it)) { meta += 1.0 } }
        if (lower.contains("你") && (lower.contains("能") || lower.contains("会"))) { meta += 0.5 }

        if (modePlan) { planning += 2.2; signals.add("计划模式已开") }
        if (goalActive) { cont += 1.2; signals.add("目标进行中") }
        if (msgCount > 2 && priorKind == Kind.TASK) { cont += 0.6 }

        val scores = mapOf(
            Kind.TASK to task,
            Kind.RESEARCH to research,
            Kind.PLAN to planning,
            Kind.QUESTION to question,
            Kind.CHAT to chat,
            Kind.CONTINUE to cont,
            Kind.META to meta,
        )
        val best = scores.maxByOrNull { it.value }!!
        val total = scores.values.sum().coerceAtLeast(0.8)
        var kind = best.key
        var confidence = min(1.0, best.value / total * 1.35)

        // 目标/计划模式是硬约束，优先于打分
        if (modePlan) { kind = Kind.PLAN; confidence = max(confidence, 0.85) }
        else if (goalActive && best.key != Kind.TASK) { kind = Kind.CONTINUE; confidence = max(confidence, 0.7) }

        // 低分兜底是防误报的；但点名工具/足量任务信号在场时，宁可按任务走
        //（策略段落只引导不强拦），也不要给明显要动手的请求套上「闲聊」帽子
        val hardTaskSignal = toolMention || task >= 1.4
        if (best.value < 0.8 && !hardTaskSignal) { kind = Kind.CHAT; confidence = 0.35 }
        else if (best.value < 0.8 && kind == Kind.CHAT) { kind = Kind.TASK; confidence = 0.6 }

        val needsTools = toolsEnabled && kind in setOf(Kind.TASK, Kind.RESEARCH, Kind.PLAN, Kind.CONTINUE)
        val needsSearch = toolsEnabled && (kind == Kind.RESEARCH || research >= 1.3)
        val needsPlan = kind == Kind.PLAN || (planning >= 3.0 && kind != Kind.CHAT)
        // 极短且没有任何可指代对象的动作请求，先问一句再动手
        val needsClarify = kind == Kind.TASK && t.length < 6 && !hasAttachments

        val reason = buildString {
            append("打分 ").append(scores.filter { it.value > 0 }.entries.sortedByDescending { it.value }
                .joinToString(" ") { "${it.key.name.lowercase()}=${"%.1f".format(it.value)}" })
            if (modePlan) append(" · 计划模式")
            if (goalActive) append(" · 目标续跑")
        }
        log("intent=${kind.name} conf=${"%.2f".format(confidence)} $reason")
        return Intent(kind, confidence, needsTools, needsPlan, needsSearch, needsClarify, reason, signals)
    }
}
