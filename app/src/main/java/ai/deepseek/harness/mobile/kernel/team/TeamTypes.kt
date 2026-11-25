package ai.deepseek.harness.mobile.kernel.team

import ai.deepseek.harness.mobile.agent.AgentConfig
import org.json.JSONArray
import org.json.JSONObject

/**
 * 团队领域类型 —— 与桌面 `@deepseek-ai/dsh-experimental-agent-team` 的 types.ts 对齐。
 *
 * 三条与桌面一致的硬语义（不是"差不多"）：
 *   1. 名字是 target，也是永久身份。创建失败的名字同样被占用，永不复用 ——
 *      否则「reviewer 上一轮失败、这一轮重开」会让历史任务指向另一个人。
 *   2. `inactive` 只表示「当前没有轮次在执行」，不代表任务完成/成功/失败。
 *      持久生命周期（phase）只有 provisioning → active 以及 → failed；
 *      running/inactive 是运行时派生的 status，不进状态机 —— 桌面同款二分。
 *   3. 任务状态只有 pending / in_progress / completed / deleted。
 *      「被依赖挡住」是派生属性 ready=false，不是第五种状态 —— 一旦把 blocked
 *      存成状态，前置任务重开后就会留下一堆永远不会自己解除的死锁。
 */

enum class MemberRole(val wire: String) { LEAD("lead"), TEAMMATE("teammate") }

/**
 * 成员的**持久生命周期**（桌面 `phase: provisioning | active | failed`）：
 * 只在创建、失败这类真正的事务节点变化，进日志、被回放校验。
 *
 * 「此刻有没有在跑」不是 phase —— 那是运行活动，由运行时派生成
 * [MemberStatus]（running/inactive），不落状态机。rc.96 之前两者混在一个
 * status 里，代价是每轮进度都往日志写状态事件，回放时分不清
 * 「这个成员真的被创建过」与「它只是活跃过」。
 */
enum class MemberPhase(val wire: String) {
    PROVISIONING("provisioning"),
    ACTIVE("active"),
    FAILED("failed"),
}

/**
 * 成员的**运行状态**（桌面由 Session 状态派生的 `status: running | inactive`）：
 * 不进状态机，只给界面与模型看。provisioning/failed 由 phase 决定，
 * running/inactive 由「运行时里有没有这人的活跃 Future」决定。
 */
enum class MemberStatus(val wire: String) {
    RUNNING("running"),
    INACTIVE("inactive"),
    PROVISIONING("provisioning"),
    FAILED("failed"),
}

/**
 * 团队容量上限 —— 一个进程可以有多个团队（每个顶层会话一支，桌面 TeamId=SessionId），
 * 但成员/任务上限是插件级配置：所有团队共用同一份额度对象，设置页改一次全局生效。
 */
class TeamCapacity {
    @Volatile var maxMembers: Int = TeamLimits.DEFAULT_MAX_MEMBERS
    @Volatile var maxTasks: Int = TeamLimits.DEFAULT_MAX_TASKS
}

/** 带错误码的团队异常：工具层原样转成 {ok:false, code, error}，不吞成一句话 */
class TeamError(val code: String, message: String, val detail: JSONObject? = null) : Exception(message)

/**
 * 一名团队成员。Lead 是虚拟成员（不落盘），teammate 落 Lead 会话日志。
 *
 * 统计字段（turns/tokens/toolCalls/lastAction）只给界面看，不进模型视图 ——
 * 模型需要的是 roster 语义，不是账单。
 */
class TeamMember(
    val name: String,
    val role: MemberRole,
    val description: String,
    /** fresh 不携带 Lead 历史；fork 继承 Lead 已完成的轮次 */
    val context: String,
    val model: String,
    val provider: String,
    /** teammate 自己的会话 id：<leadSid>#<name>，冷恢复靠它 */
    val sessionId: String,
    val createdAt: Long = System.currentTimeMillis(),
) {
    @Volatile var phase: MemberPhase = MemberPhase.PROVISIONING
    /** 此刻有没有轮次在执行（运行活动，由运行时维护；与 [phase] 无关） */
    @Volatile var running: Boolean = false
    @Volatile var lastError: String = ""
    @Volatile var endedAt: Long = 0
    @Volatile var turns: Int = 0
    @Volatile var toolCalls: Int = 0
    @Volatile var tokensIn: Int = 0
    @Volatile var tokensOut: Int = 0
    @Volatile var lastAction: String = ""
    /**
     * 本轮正在流的正文（只给界面看：成员视图要和主对话一样逐字长）。
     *
     * 不落日志、不进 [view]/[snapshot] 的持久字段 —— 轮末 journal.assistantTurn 写的是
     * 权威全文，这里只是「还没写完的那半截」，写盤会让冷恢复看到重复内容。
     */
    @Volatile var liveText: String = ""
    /** 本轮累计吐出过多少字符（单调递增；liveText 会截尾，页面靠它判断有没有新内容） */
    @Volatile var liveSeq: Long = 0
    @Volatile var startedAt: Long = 0
    val diagnostics: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf<String>())

    /** 派生的运行状态：界面与模型看到的是它，状态机校验看的是 [phase] */
    val status: MemberStatus
        get() = when (phase) {
            MemberPhase.PROVISIONING -> MemberStatus.PROVISIONING
            MemberPhase.FAILED -> MemberStatus.FAILED
            MemberPhase.ACTIVE -> if (running) MemberStatus.RUNNING else MemberStatus.INACTIVE
        }

    fun diagnostic(msg: String) {
        diagnostics.add(msg.take(300))
        while (diagnostics.size > 12) diagnostics.removeAt(0)
    }

    /**
     * 模型视图：target 是名字，不含内部 id/会话 id（桌面 modelMember 同款）。
     *
     * [model] 存的是「成员显式指定的那一个」，空 = 跟随。跟随的时候界面上要显示的是
     * **生效值**，所以由调用方把 fallback（子代理档 → Lead）传进来；不传就照实显示空。
     */
    fun view(fallbackModel: String = ""): JSONObject = JSONObject().apply {
        put("target", name)
        put("role", role.wire)
        put("status", status.wire)
        put("phase", phase.wire)
        put("description", description)
        put("provider", provider)
        put("context", context)
        put("model", model.ifBlank { fallbackModel })
        put("diagnostics", JSONArray(diagnostics.toList()))
        // 上一次运行没跑完的原因：ACTIVE 也要给（桌面对 active 成员用 diagnostics 表达同一件事）。
        // 只在 FAILED 时给的话，「队友这轮失败了但仍可唤醒」在界面上就成了「等待唤醒」，
        // Lead 和用户都看不出它刚报错。activate() 会清空 lastError，所以不会长期挂着旧错。
        if (lastError.isNotBlank()) put("error", lastError)
    }

    /** 界面视图：多给统计与时间，团队面板据此画卡片 */
    fun snapshot(fallbackModel: String = ""): JSONObject = view(fallbackModel).apply {
        put("session", sessionId)
        put("createdAt", createdAt)
        put("startedAt", startedAt)
        put("endedAt", endedAt)
        put("turns", turns)
        put("toolCalls", toolCalls)
        put("tokensIn", tokensIn)
        put("tokensOut", tokensOut)
        put("lastAction", lastAction)
    }
}

/**
 * 队友这一轮实际用的「模型 + 端点 + 密钥」。
 *
 * 模型走三档优先级：成员显式指定 > 子代理档（`subagentModel`）> Lead 当前模型。
 * 端点/密钥是**独立**的一档覆盖（`subagentUrl` / `subagentKey`，与
 * [ai.deepseek.harness.mobile.agent.SubagentRunner] 同一语义：把子级流量整体换到一个
 * 代理/镜像端点去，模型名照旧），所以不跟着模型名走。
 *
 * 原来这里分两处各写一套：模型那行注释声称有优先级，但 spawn 时已经把空值落成了
 * `lead.model`，`ifBlank` 永远进不去 —— 子代理档对队友形同虚设。集中到一处，
 * 也让「成员到底在用什么模型」只剩一个答案。
 */
data class MemberLlm(val model: String, val baseUrl: String, val apiKey: String) {
    companion object {
        fun resolve(lead: AgentConfig, explicit: String): MemberLlm = MemberLlm(
            explicit.ifBlank { lead.subagentModel.ifBlank { lead.model } },
            lead.subagentUrl.ifBlank { lead.baseUrl },
            lead.subagentKey.ifBlank { lead.apiKey },
        )
    }
}

enum class TaskStatus(val wire: String) {
    PENDING("pending"),
    IN_PROGRESS("in_progress"),
    COMPLETED("completed"),
    DELETED("deleted"),
    ;

    companion object {
        fun of(s: String): TaskStatus = values().firstOrNull { it.wire == s } ?: PENDING
    }
}

/**
 * 共享任务板上的一条任务。每次变更都是完整快照 + revision+1（CAS）。
 *
 * [owner] 是成员 name，不是 id —— 与桌面 ownerName 一致：重命名不支持，
 * 所以名字就是稳定外键。
 */
class TeamTask(
    val id: String,
    var revision: Int,
    var subject: String,
    var description: String,
    var status: TaskStatus,
    var owner: String?,
    var blockedBy: MutableList<String>,
    var writeScopes: MutableList<String>,
    val createdAt: Long = System.currentTimeMillis(),
    var updatedAt: Long = System.currentTimeMillis(),
    var completedAt: Long = 0,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("revision", revision)
        put("subject", subject)
        put("description", description)
        put("status", status.wire)
        if (owner != null) put("ownerName", owner)
        put("blockedBy", JSONArray(blockedBy))
        put("writeScopes", JSONArray(writeScopes))
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
        if (completedAt > 0) put("completedAt", completedAt)
    }

    /** 写时复制：任务板先改副本、提交成功后才替换内存版本（见 TeamBoard.update） */
    fun copy(): TeamTask = TeamTask(
        id = id,
        revision = revision,
        subject = subject,
        description = description,
        status = status,
        owner = owner,
        blockedBy = blockedBy.toMutableList(),
        writeScopes = writeScopes.toMutableList(),
        createdAt = createdAt,
        updatedAt = updatedAt,
        completedAt = completedAt,
    )

    companion object {
        fun from(o: JSONObject): TeamTask = TeamTask(
            id = o.optString("id"),
            revision = o.optInt("revision", 1),
            subject = o.optString("subject"),
            description = o.optString("description"),
            status = TaskStatus.of(o.optString("status", "pending")),
            owner = o.optString("ownerName").ifBlank { null },
            blockedBy = o.optJSONArray("blockedBy")?.let { a ->
                (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotBlank() } }.toMutableList()
            } ?: mutableListOf(),
            writeScopes = o.optJSONArray("writeScopes")?.let { a ->
                (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotBlank() } }.toMutableList()
            } ?: mutableListOf(),
            createdAt = o.optLong("createdAt", System.currentTimeMillis()),
            updatedAt = o.optLong("updatedAt", System.currentTimeMillis()),
            completedAt = o.optLong("completedAt", 0),
        )
    }
}

/** 任务视图：ready 与 writeScopeWarnings 都是派生值，每次读取现算 */
fun TeamTask.view(ready: Boolean, warnings: List<String>): JSONObject = toJson().apply {
    put("ready", ready)
    put("writeScopeWarnings", JSONArray(warnings))
}

/**
 * 桌面 `validation.ts` 的 `requiredText` 手机端等价物：去首尾空白、非空、限长。
 *
 * 三个上限照桌面同数（task-board.ts:60-61 与 150-153、roster.ts:241）：
 * 不卡的话，模型写一条五万字的 subject 会整份进 Lead 会话日志、进每一次成员快照与
 * 回放 —— 本地 8k/16k 窗口下一轮就被自己写满，而且日志体积不可控。
 */
fun requiredText(raw: String, field: String, maxLength: Int): String {
    val text = raw.trim()
    if (text.isEmpty()) throw TeamError("TEAM_INVALID_ARGUMENT", "$field 不能为空")
    if (text.length > maxLength) {
        throw TeamError(
            "TEAM_INVALID_ARGUMENT",
            "$field 超过 ${maxLength} 字符（现在 ${text.length}）；把细节拆到多条任务或验收清单里",
        )
    }
    return text
}

/** 任务标题上限（桌面 subject 200） */
const val TASK_SUBJECT_MAX = 200
/** 任务说明上限（桌面 description 16384） */
const val TASK_DESC_MAX = 16_384
/** 成员职责一句话上限（桌面 spawn 的 description 200） */
const val MEMBER_DESC_MAX = 200

/**
 * 写范围规范化：工作区相对路径前缀。
 *
 * 与桌面 `validation.ts:writeScope` 同规则 —— 反斜杠转正斜杠、去 `./`、去尾斜杠，
 * 并**拒绝**空串 / 绝对路径 / 盘符 / `.` / `..` / 空段。
 * 为什么要这么严：`a/../b` 与 `a/b` 在字符串前缀比较里是两条不同的范围，
 * 重叠提示就会漏判；绝对路径更是永远匹配不上工作区相对前缀。
 */
fun normalizeScope(raw: String): String {
    val n = raw.trim().replace('\\', '/').removePrefix("./").trimEnd('/')
    if (n.isEmpty() || n.startsWith("/") || Regex("^[A-Za-z]:").containsMatchIn(n)) {
        throw TeamError(
            "TEAM_INVALID_WRITE_SCOPE",
            "写范围必须是工作区相对路径（不能是绝对路径/盘符/空串）：${raw.take(60)}",
        )
    }
    if (n.split('/').any { it.isEmpty() || it == "." || it == ".." }) {
        throw TeamError(
            "TEAM_INVALID_WRITE_SCOPE",
            "写范围不能含空段、`.` 或 `..`：${raw.take(60)}",
        )
    }
    return n
}

/** 两个写范围是否重叠（前缀关系即重叠；"." 与任何范围重叠） */
fun scopesOverlap(a: String, b: String): Boolean {
    if (a == "." || b == ".") return true
    return a == b || a.startsWith("$b/") || b.startsWith("$a/")
}
