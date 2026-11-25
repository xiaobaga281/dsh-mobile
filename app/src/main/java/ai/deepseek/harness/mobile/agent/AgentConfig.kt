package ai.deepseek.harness.mobile.agent

import ai.deepseek.harness.mobile.kernel.sandbox.SandboxMode

import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次运行所需的全部上下文参数（由前端在发话时打包传入）。
 *
 * 桌面 Harness 里这些值散落在 settings / credentials / session state 中，
 * 由 ctx 注入各子系统；手机端没有注入容器，收敛成一个不可变值对象，
 * 每轮由前端快照一次 —— 因此用户在设置里改的东西下一轮就生效，无需重启。
 */
data class AgentConfig(
    /* 会话与端点 */
    val sessionId: String,
    val baseUrl: String,
    val apiKey: String,
    val model: String,
    val userText: String,

    /* 预算：下限是硬约束（上下文 ≥128k、单次输出 ≥64k） */
    val contextWindow: Int = CONTEXT_FLOOR,
    val maxOut: Int = OUT_FLOOR,
    /** 思考档位标识（off/minimal/low/medium/high/xhigh/max）；空 = 不发该字段 */
    val reasoningEffort: String = "",
    val compactMode: String = "auto",      // auto | aggressive | off

    /* 权限与工作区 */
    val permission: String = "ask",         // readonly | ask | full
    val askDanger: Boolean = true,
    val workspaceLabel: String = "harness",
    /**
     * 这一轮是为哪件事（Mission）跑的。空 = 用户直接说话，权限完全按会话档。
     * 非空时会话档只能被这条 Mission 收窄、不能被放宽，且「始终允许」记在这件事上而不是会话里。
     */
    val missionId: String = "",
    /** 这一轮由唤醒自动发起：日志里要能与「用户此刻在说话」区分开 */
    val wake: Boolean = false,
    /** 认领掉的那条唤醒记录 id，用于把「谁把这一轮叫起来」写回 Mission 证据 */
    val wakeId: String = "",

    /* 内置模式 */
    val preset: String = Presets.DEFAULT_ID,   // standard | ptc | minimal | cordis（Agent 预设）
    val planMode: Boolean = false,
    val planApproved: Boolean = false,
    val goalObjective: String? = null,
    val goalPhase: String = "",             // active | complete | blocked | paused
    val goalRounds: Int = 0,
    val goalMaxRounds: Int = 0,             // 0 = 智能

    /* 记忆 */
    val persona: String = "",
    val globalMemories: List<String> = emptyList(),
    val sessionMemories: List<String> = emptyList(),

    /* 检索 */
    val searchUrl: String = "",
    val searchKey: String = "",
    val searchMax: Int = 5,
    val searchOn: Boolean = false,

    /* 能力开关 */
    val toolsEnabled: Boolean = true,
    val subagentEnabled: Boolean = true,
    /**
     * 子代理用的模型（空 = 跟主 Agent 同一个）。让「Lead 用强模型、工人用便宜模型」成立——
     * 团队/子代理是并发的，模型分档能显著压成本与延迟。
     */
    val subagentModel: String = "",
    /** 子代理端点覆盖（空 = 用主 Agent 的 baseUrl；一般同厂商不需要改） */
    val subagentUrl: String = "",
    /** 子代理密钥覆盖（空 = 用主 Agent 的 apiKey） */
    val subagentKey: String = "",
    /**
     * 委派深度：主 Agent 为 0，子智能体 = 父深度 + 1（桌面 `delegationDepth` 同义）。
     * 由运行时在派生子代理时写入，前端不会传。
     */
    val delegationDepth: Int = 0,
    /**
     * 并行容量按哪个会话计数。teammate 自己的 sessionId 是 `<leadSid>#<name>`，
     * 但桌面是按「同一个主 Agent」合计的，所以这里固定指回 Lead 会话。
     */
    val rootSessionId: String = "",
    val intentLlmRefine: Boolean = false,
    val device: String = "Android",
    /** 陪伴式畅聊发起的一轮：不是用户问的，会话里不要记成 user/message */
    val companion: Boolean = false,

    /* 历史（前端已按会话隔离，原生只负责裁剪与压缩） */
    val history: List<JSONObject> = emptyList(),
    val attachments: List<JSONObject> = emptyList(),
) {
    val goalActive: Boolean get() = goalPhase == "active" && !goalObjective.isNullOrBlank()
    val readOnly: Boolean
        get() = SandboxMode.parse(permission) == SandboxMode.READ_ONLY
    val needConfirm: Boolean
        get() = SandboxMode.parse(permission) != SandboxMode.DANGER_FULL_ACCESS && askDanger
    val smartRounds: Boolean get() = goalMaxRounds <= 0

    fun goalRoundCap(): Int = if (smartRounds) 40 else goalMaxRounds.coerceIn(1, 60)

    companion object {
        /** 上下文窗口下限：128k。低于它工具目录 + 历史 + 交付物会互相挤占。 */
        const val CONTEXT_FLOOR = 131_072

        /** 单次输出下限：64k。长文档/长代码一次写不完会被截断成半成品。 */
        const val OUT_FLOOR = 65_536

        fun parse(o: JSONObject): AgentConfig {
            fun strs(key: String): List<String> {
                val arr = o.optJSONArray(key) ?: return emptyList()
                return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotBlank() } }
            }
            fun objs(key: String): List<JSONObject> {
                val arr = o.optJSONArray(key) ?: return emptyList()
                return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
            }
            val goal = o.optJSONObject("goal")
            return AgentConfig(
                sessionId = o.optString("sessionId", "draft"),
                baseUrl = o.optString("baseUrl"),
                apiKey = o.optString("apiKey"),
                model = o.optString("model"),
                userText = o.optString("userText"),
                // 下限由前端统一保证（菜单不再提供小档位、旧配置启动时抬升）；
                // 这里只兜「没传」的情况。不能无条件 maxOf：端点自报 8k 的本地模型
                // 会因此发出 128k 请求，直接被 400 拒绝。
                contextWindow = o.optInt("contextWindow", CONTEXT_FLOOR).coerceAtLeast(2048),
                maxOut = o.optInt("maxOut", OUT_FLOOR).coerceAtLeast(256),
                reasoningEffort = o.optString("reasoningEffort").trim(),
                compactMode = o.optString("compactMode", "auto"),
                permission = o.optString("permission", "ask"),
                askDanger = o.optBoolean("askDanger", true),
                workspaceLabel = o.optString("workspaceLabel", "harness"),
                missionId = o.optString("missionId").trim(),
                wake = o.optBoolean("wake"),
                wakeId = o.optString("wakeId").trim(),
                preset = o.optString("preset", Presets.DEFAULT_ID),
                planMode = o.optBoolean("planMode", false),
                planApproved = o.optBoolean("planApproved", false),
                goalObjective = goal?.optString("objective")?.takeIf { it.isNotBlank() },
                goalPhase = goal?.optString("phase").orEmpty(),
                goalRounds = goal?.optInt("rounds") ?: 0,
                goalMaxRounds = goal?.optInt("maxRounds") ?: 0,
                persona = o.optString("persona"),
                globalMemories = strs("globalMemories"),
                sessionMemories = strs("sessionMemories"),
                searchUrl = o.optString("searchUrl"),
                searchKey = o.optString("searchKey"),
                searchMax = o.optInt("searchMax", 5),
                searchOn = o.optBoolean("searchOn", false),
                toolsEnabled = o.optBoolean("toolsEnabled", true),
                subagentEnabled = o.optBoolean("subagentEnabled", true),
                subagentModel = o.optString("subagentModel"),
                subagentUrl = o.optString("subagentUrl"),
                subagentKey = o.optString("subagentKey"),
                intentLlmRefine = o.optBoolean("intentLlmRefine", false),
                device = o.optString("device", "Android"),
                companion = o.optBoolean("companion", false),
                history = objs("history"),
                attachments = objs("attachments"),
            )
        }
    }
}
