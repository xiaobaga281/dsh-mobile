package ai.deepseek.harness.mobile.kernel.plugin.builtin.agent

import ai.deepseek.harness.mobile.agent.SessionStore
import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.schedule.ScheduleDelivery
import ai.deepseek.harness.mobile.kernel.schedule.ScheduleException
import ai.deepseek.harness.mobile.kernel.schedule.ScheduleRegistry
import org.json.JSONArray
import org.json.JSONObject

/**
 * 定时任务 —— 对应桌面 `@deepseek-ai/dsh-tool-schedule` 的四个管理工具：
 * schedule_create / schedule_update / schedule_delete / schedule_list。
 *
 * 本次改动（WP5）：
 *  1. `onLoad` 里把 [ScheduleDelivery] 接到 `session.store` 服务上 —— 到期消息真正
 *     追加进原会话（`user/message`，`producer=schedule`），而不是只发一个可能没人收的
 *     UI 事件。之所以在这里接线而不是在 ToolKernel：`session.store` 是内核已经提供的
 *     服务（ToolKernel.kt:263），而且服务先于插件注册（plugins 在 ToolKernel.kt:413 注册），
 *     所以插件里拿得到，且不必改 ToolKernel。
 *  2. `schedule_update` 支持传 `expected` 做 CAS；规则未变时不重置目标时刻。
 *  3. 校验错误带**稳定错误码**（`invalid_prompt` / `invalid_rule` / `schedule_not_found`
 *     / `schedule_ended` / `schedule_conflict`），与桌面同名，调用方按 code 路由。
 *  4. 如实告知精度：返回里带 `deliveryMode=device` 与 `timingGuarantee=inexact`。
 */
class SchedulePlugin : KernelPlugin {
    override val id = "schedule"
    override val name = "定时任务"
    override val description = "schedule_create / update / delete / list：按时间或 cron 触发一条提醒"
    override val version = "1.1.0"

    private var ctx: PluginContext? = null

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        wireDelivery(ctx)
    }

    override fun onUnload() {
        ctx = null
    }

    /**
     * 把会话写入器接到注册表上。
     * 用持有唯一 SessionStore 实例的内核服务，而不是自己 new 一个 —— 两个 SessionStore
     * 实例各持一把按会话写锁，并发写同一个 .jsonl 会把一行 JSON 撕成两半。
     */
    private fun wireDelivery(ctx: PluginContext) {
        val registry = ctx.service("schedule.registry") as? ScheduleRegistry ?: return
        if (registry.hasDelivery()) return
        val sessions = ctx.service("session.store") as? SessionStore ?: run {
            ctx.log("session.store 未就绪，定时任务暂不写回会话（仍会保留任务行，不会丢 prompt）")
            return
        }
        registry.attachDelivery(
            // 必须用具名参数：ScheduleDelivery 是普通 class（不是 fun interface），
            // `ScheduleDelivery { ... }` 会把尾随 lambda 误绑到最后一个函数型参数 clock 上。
            ScheduleDelivery(
                appendEvent = { sessionId, type, payload ->
                    sessions.appendOrThrow(sessionId, type, payload)
                },
            ),
        )
    }

    private fun reg(): ScheduleRegistry =
        ctx?.service("schedule.registry") as? ScheduleRegistry
            ?: throw KernelError("定时任务服务未装配")

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    /** 把扁平参数收成 registry 认的规则对象（与桌面 schema 同名字段） */
    private fun ruleOf(args: JSONObject): JSONObject {
        val rule = JSONObject()
        if (args.has("after_seconds")) rule.put("after_seconds", args.optLong("after_seconds"))
        if (args.has("every_seconds")) rule.put("every_seconds", args.optLong("every_seconds"))
        if (args.has("at")) rule.put("at", args.opt("at"))
        args.optJSONObject("daily")?.let { rule.put("daily", it) }
        args.optJSONObject("weekly")?.let { rule.put("weekly", it) }
        args.optJSONObject("cron")?.let { rule.put("cron", it) }
        return rule
    }

    /** 校验失败 → 结构化失败（ToolPipeline 会据此判 ok=false，而不是当成功） */
    private fun fail(code: String, message: String, hint: String? = null): String =
        JSONObject().apply {
            put("ok", false)
            put("code", code)
            put("error", message)
            hint?.let { put("hint", it) }
        }.toString()

    private fun timeProps(): JSONObject = JSONObject()
        .put("after_seconds", JSONObject().put("type", "number").put("description", "多少秒后触发一次（正整数）"))
        .put("every_seconds", JSONObject().put("type", "number").put("description", "固定间隔秒数（至少 60），从创建时刻对齐"))
        .put("at", JSONObject().put("type", "string").put("description", "绝对时间：RFC3339（带时区），例如 2026-10-21T09:00:00+08:00；必须是未来"))
        .put("daily", JSONObject().apply {
            put("type", "object")
            put("description", "每天固定本地时间")
            put("properties", JSONObject()
                .put("time", JSONObject().put("type", "string").put("description", "HH:mm:ss"))
                .put("time_zone", JSONObject().put("type", "string").put("description", "IANA 时区，如 Asia/Shanghai；UTC 也可")))
        })
        .put("weekly", JSONObject().apply {
            put("type", "object")
            put("description", "每周指定星期几的本地时间")
            put("properties", JSONObject()
                .put("time", JSONObject().put("type", "string").put("description", "HH:mm:ss"))
                .put("time_zone", JSONObject().put("type", "string"))
                .put("weekdays", JSONObject().apply {
                    put("type", "array")
                    put("description", "ISO 星期：1=周一 … 7=周日")
                    put("items", JSONObject().put("type", "number"))
                }))
        })
        .put("cron", JSONObject().apply {
            put("type", "object")
            put("description", "五字段 cron（分 时 日 月 周）；不支持 L/W/#/名称/@daily")
            put("properties", JSONObject()
                .put("expression", JSONObject().put("type", "string").put("description", "例如 */15 9-17 * * 1-5"))
                .put("time_zone", JSONObject().put("type", "string")))
        })

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "schedule_create"
            override val description = "创建一个定时任务：到点把 prompt 作为一条消息送达当前会话。" +
                "时间规则六选一（after_seconds / every_seconds / at / daily / weekly / cron）。" +
                "手机端到点精度为近似（省电模式可能延后几分钟）；任务行会落盘，一次性任务触发后仍可在 " +
                "schedule_list 里看到。"
            override val parameters = schema(
                timeProps()
                    .put("prompt", JSONObject().put("type", "string").put("description", "到点要呈现的内容"))
                    .put("title", JSONObject().put("type", "string").put("description", "任务名，不超过 120 字")),
                listOf("prompt", "title"),
            )
            override fun execute(args: JSONObject): String {
                val rule = ruleOf(args)
                val sid = ctx?.service("agent.session") as? String ?: ""
                return try {
                    reg().create(args.optString("title"), args.optString("prompt"), rule, sid).toString()
                } catch (e: ScheduleException) {
                    fail(e.code, e.message ?: "创建失败", hintFor(e.code))
                }
            }
        },
        object : ToolSpec {
            override val name = "schedule_update"
            override val description = "修改一个定时任务：标题、内容或时间规则（时间规则只传一种）。" +
                "时间规则不变时不会重置下一次触发时刻。" +
                "可选传 expected（schedule_list 拿到的整条记录）做并发校验。"
            override val parameters = schema(
                timeProps().also { it.remove("after_seconds") }   // 桌面 update 不支持改一次性延迟
                    .put("id", JSONObject().put("type", "string").put("description", "schedule_list 返回的 id"))
                    .put("title", JSONObject().put("type", "string"))
                    .put("prompt", JSONObject().put("type", "string"))
                    .put("expected", JSONObject()
                        .put("type", "object")
                        .put("description", "编辑前从 schedule_list 拿到的完整记录；传了就做冲突检测")),
                listOf("id"),
            )
            override fun execute(args: JSONObject): String {
                val patch = JSONObject()
                if (args.has("title")) patch.put("title", args.optString("title"))
                if (args.has("prompt")) patch.put("prompt", args.optString("prompt"))
                val rule = ruleOf(args)
                if (rule.length() > 1) {
                    return fail(
                        ScheduleException.INVALID_RULE,
                        "时间规则只能选一种，收到：${rule.keys().asSequence().toList()}",
                    )
                }
                if (rule.length() == 1) patch.put("rule", rule)
                return try {
                    // expected 里带着 model 侧看到的 rule/state 等字段，registry 只取可比较的三项
                    reg().update(args.optString("id"), patch, args.optJSONObject("expected"))
                        .toString()
                } catch (e: ScheduleException) {
                    fail(e.code, e.message ?: "更新失败", hintFor(e.code))
                }
            }
        },
        object : ToolSpec {
            override val name = "schedule_delete"
            override val description = "删除一个定时任务（连同它的投递记录）。"
            override val parameters = schema(
                JSONObject().put("id", JSONObject().put("type", "string")),
                listOf("id"),
            )
            override fun execute(args: JSONObject): String {
                val id = args.optString("id")
                return if (reg().delete(id)) {
                    JSONObject().put("ok", true).put("id", id).put("deleted", true).toString()
                } else {
                    fail(ScheduleException.NOT_FOUND, "没有这个定时任务：$id")
                }
            }
        },
        object : ToolSpec {
            override val name = "schedule_list"
            override val description = "列出所有定时任务：状态（active/inactive）、下一次触发、最近一次投递回执、" +
                "错过的次数。已触发完的一次性任务会以 inactive 保留，不会被删掉。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String {
                val now = System.currentTimeMillis()
                return JSONObject().apply {
                    put("ok", true)
                    put("deliveryMode", "device")
                    put("timingGuarantee", "inexact")
                    put(
                        "note",
                        "手机端到点精度为近似：应用被系统清理时任务不会丢，但提醒可能延后到下次进程启动或系统唤醒窗口。",
                    )
                    put("items", reg().list())
                    put("now", now)
                }.toString()
            }
        },
    )

    private fun hintFor(code: String): String = when (code) {
        ScheduleException.INVALID_RULE ->
            "时间规则六选一：after_seconds / every_seconds(≥60) / at(必须未来) / daily{time,time_zone} " +
                "/ weekly{time,time_zone,weekdays} / cron{expression,time_zone}（五字段，不支持 L/W/#/名称）"
        ScheduleException.INVALID_PROMPT -> "title 去掉首尾空白后必须非空且不超过 120 字；prompt 不能为空"
        ScheduleException.NOT_FOUND -> "先用 schedule_list 拿 id"
        ScheduleException.ENDED -> "这条任务已结束（一次性已触发）；要再提醒请重新 schedule_create"
        ScheduleException.CONFLICT -> "重新 schedule_list 拿到最新记录后再改"
        else -> ""
    }

    override fun status(): Map<String, String> = runCatching {
        val d = reg().describe()
        mapOf(
            "定时任务" to "${d.optInt("active")} 活动 / ${d.optInt("inactive")} 已结束",
            "投递通道" to if (d.optBoolean("deliveryWired")) "会话内投递" else "仅事件（未接会话）",
            "到点精度" to "近似（Doze 可能延后）",
        )
    }.getOrDefault(mapOf("定时任务" to "不可用"))
}
