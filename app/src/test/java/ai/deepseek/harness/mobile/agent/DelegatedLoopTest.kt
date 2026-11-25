package ai.deepseek.harness.mobile.agent

import ai.deepseek.harness.mobile.kernel.Workspace
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.PluginRegistry
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

/**
 * 委派链路循环骨架 [AgentLoop.execCalls] 的契约 —— 团队成员与子代理现在都跑这一份。
 *
 * 钉的就是「两条循环各写一遍」时最容易各写错的四件事：
 *  · **每个 tool_call 都有一条对应的 tool 消息**，被取消没跑的那几条也要 ——
 *    成员以前被中断是 `break`，剩下的调用没有回答，这份历史再发出去就是端点 400
 *  · 钩子每条恰好各一次，顺序是 start → 执行 → outcome
 *  · 目录外的调用拿 TOOL_NOT_IN_CATALOG，而不是误导人的「未知工具（可能被禁用）」
 */
class DelegatedLoopTest {

    private fun dir(tag: String): File = Files.createTempDirectory("dsh-$tag").toFile()

    private class FakeTool(
        override val name: String,
        private val body: (JSONObject) -> String,
    ) : ToolSpec {
        override val description: String get() = "fake $name"
        override val parameters: JSONObject = Schemas.params(emptyMap())
        override fun execute(args: JSONObject): String = body(args)
    }

    private class FakePlugin(override val id: String, override val tools: List<ToolSpec>) : KernelPlugin {
        override val name: String get() = id
        override val description: String get() = "fake plugin $id"
    }

    private class StubRuntime : ToolPipeline.RuntimeTools {
        override fun presentPlan(title: String, plan: String): String = "ok"
        override fun markGoal(status: String, summary: String): String = "ok"
        override fun editGoal(objective: String, maxRounds: Int): String = "ok"
        override fun todoWrite(items: JSONArray): String = "ok"
        override fun search(queries: List<String>, max: Int, fetchTop: Int, charsPerPage: Int): String = "ok"
        override fun subagent(task: String, maxRounds: Int): String = "ok"
        override fun useSkill(name: String): String = "ok"
        override fun createGoal(objective: String, maxRounds: Int): String = "ok"
        override fun getGoal(): String = "ok"
        override fun fetchUrl(url: String, maxChars: Int, offset: Int): String = "ok"
        override fun addImage(path: String): String = "ok"
        override fun addImageData(dataUrl: String, label: String): String = "ok"
        override fun latestUserImage(): JSONObject? = null
        override fun askUser(question: String, options: JSONArray, detail: String): String = "ok"
        override fun approve(name: String, args: JSONObject, reason: String): Boolean = true
    }

    private fun pipeline(tools: List<ToolSpec>): ToolPipeline {
        val ws = Workspace(dir("dsh-ws"))
        val ctx = object : PluginContext {
            override val workspace: Workspace get() = ws
            override val sandbox: WorkspaceSandbox = WorkspaceSandbox(ws)
            override fun config(): JSONObject = JSONObject()
            override fun service(name: String): Any? = null
            override fun provide(name: String, value: Any?) {}
            override fun log(msg: String) {}
        }
        val reg = PluginRegistry(ctx, dir("dsh-plugin"), HookBus {})
        reg.registerAll(listOf(FakePlugin("fake", tools)))
        return ToolPipeline(reg, ws, HookBus {}, spillRoot = dir("dsh-spill"))
    }

    private val gate = ToolPipeline.Gate("standard", planMode = false, planApproved = true, confirmDanger = false)

    private fun call(id: String, name: String, args: String = "{}") = LlmClient.ToolCall(id, name, args)

    /** 跑一遍骨架，返回 (消息列表, 结果列表, 钩子轨迹) */
    private fun run(
        tools: List<ToolSpec>,
        calls: List<LlmClient.ToolCall>,
        cancelled: () -> Boolean = { false },
        catalog: Set<String> = tools.map { it.name }.toSet(),
    ): Triple<List<JSONObject>, List<ToolPipeline.Outcome>, List<String>> {
        val messages = mutableListOf<JSONObject>()
        val trace = mutableListOf<String>()
        val outs = AgentLoop.execCalls(
            pipeline(tools), calls, "先做这两件事", messages, gate, StubRuntime(),
            catalog, "s-1", cancelled,
            onStart = { c, _ -> trace.add("start:${c.id}") },
            onOutcome = { c, _, o -> trace.add("end:${c.id}:${if (o.ok) "ok" else o.code}") },
        )
        return Triple(messages, outs, trace)
    }

    @Test
    fun `被取消的调用也要有一条结果`() {
        val ran = AtomicInteger(0)
        val (messages, outs, trace) = run(
            listOf(FakeTool("bash") { ran.incrementAndGet(); "ran" }),
            listOf(call("c1", "bash"), call("c2", "bash")),
            cancelled = { true },
        )
        assertEquals("一条都没执行", 0, ran.get())
        assertEquals("两条调用都要有结果", 2, outs.size)
        assertEquals(listOf("TOOL_NOT_STARTED", "TOOL_NOT_STARTED"), outs.map { it.code })
        assertFalse("取消的结果必须是失败", outs.all { it.ok })
        // assistant 一条 + 两条 tool 消息，且 tool_call_id 一一对应
        assertEquals(3, messages.size)
        assertEquals("assistant", messages[0].optString("role"))
        assertEquals(
            listOf("c1", "c2"),
            messages.drop(1).map { it.optString("tool_call_id") },
        )
        assertEquals(
            "取消的不该触发 start / 否决钩子，只结算一次",
            listOf("end:c1:TOOL_NOT_STARTED", "end:c2:TOOL_NOT_STARTED"),
            trace,
        )
    }

    @Test
    fun `assistant 消息形状与文本为空时的 null`() {
        val (withText, _, _) = run(listOf(FakeTool("bash") { "ran" }), listOf(call("c1", "bash", """{"command":"ls"}""")))
        assertEquals("先落 assistant 再落结果", "assistant", withText[0].optString("role"))
        assertEquals("先做这两件事", withText[0].optString("content"))
        val fn = withText[0].getJSONArray("tool_calls").getJSONObject(0).getJSONObject("function")
        assertEquals("bash", fn.optString("name"))
        assertEquals("""{"command":"ls"}""", fn.optString("arguments"))

        val blank = mutableListOf<JSONObject>()
        AgentLoop.execCalls(
            pipeline(listOf(FakeTool("bash") { "ran" })), listOf(call("c1", "bash")), "", blank,
            gate, StubRuntime(), setOf("bash"), "s-1", { false },
        )
        assertTrue("模型没说正文时 content 必须是 null，不能是空串", blank[0].isNull("content"))
    }

    @Test
    fun `目录外的调用给结构化码而不是误导文案`() {
        val (messages, outs, _) = run(
            listOf(FakeTool("bash") { "ran" }),
            listOf(call("c1", "spawn_teammate")),
            catalog = setOf("bash"),
        )
        assertEquals("TOOL_NOT_IN_CATALOG", outs[0].code)
        val fed = messages[1].optString("content")
        assertTrue("要把本轮有什么告诉模型：$fed", fed.contains("bash"))
        assertNull("不该出现把人往插件清单上带的旧文案", fed.takeIf { it.contains("可能被禁用") })
    }
}
