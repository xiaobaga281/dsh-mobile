package ai.deepseek.harness.mobile.agent

import ai.deepseek.harness.mobile.kernel.Workspace
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.PluginRegistry
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * 流水线结算契约 —— 这些断言对应真机上一次事故的每一条：
 *
 *  - 一条慢调用超时，**不**再打掉整批（以前整批 `get(30s)` 抛 TimeoutException → AgentDriver.failTurn → 整轮失败，
 *    同批已经成功的结果全被丢掉，模型看到的对话里那几条调用「没有结果」）
 *  - 超时只作用于**声明了 `ToolSpec.timeoutMs` 的那一条**，同批其它调用照常返回
 *  - 取消后没派发的调用必须各自有条 `ABORTED_BEFORE_DISPATCH`，而不是「未执行」或干脆没有
 *  - `onEnd` 每条恰好一次（界面的 tool_end 少一条，前端就会有一条调用永远显示「运行中」）
 *  - 守卫的硬拒绝不能被「危险操作确认」改写为待批准（否则只读档下点一下批准就能执行命令）
 */
class ToolPipelineTimeoutTest {

    /* ---------------- 夹具 ---------------- */

    private fun tempDir(tag: String): File = Files.createTempDirectory("dsh-$tag").toFile()

    private class FakeTool(
        override val name: String,
        override val timeoutMs: Long? = null,
        override val executionMode: ToolExecutionMode = ToolExecutionMode.PARALLEL,
        private val body: (JSONObject) -> String,
    ) : ToolSpec {
        override val description: String get() = "fake tool $name"
        override val parameters: JSONObject = Schemas.params(emptyMap())
        override fun execute(args: JSONObject): String = body(args)
    }

    private class FakePlugin(
        override val id: String,
        override val tools: List<ToolSpec>,
    ) : KernelPlugin {
        override val name: String get() = id
        override val description: String get() = "fake plugin $id"
    }

    private class FakeRuntime(
        private val approveResult: Boolean = true,
    ) : ToolPipeline.RuntimeTools {
        val approveCalls = AtomicInteger(0)

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
        override fun approve(name: String, args: JSONObject, reason: String): Boolean {
            approveCalls.incrementAndGet()
            return approveResult
        }
    }

    private fun registry(ws: Workspace, plugins: List<KernelPlugin>): PluginRegistry {
        val ctx = object : PluginContext {
            override val workspace: Workspace get() = ws
            override val sandbox: WorkspaceSandbox = WorkspaceSandbox(ws)
            override fun config(): JSONObject = JSONObject()
            override fun service(name: String): Any? = null
            override fun provide(name: String, value: Any?) {}
            override fun log(msg: String) {}
        }
        val reg = PluginRegistry(ctx, tempDir("dsh-plugin-state"), HookBus {})
        reg.registerAll(plugins)
        return reg
    }

    private fun pipeline(
        tools: List<ToolSpec>,
        hooks: HookBus = HookBus {},
    ): Pair<ToolPipeline, PluginRegistry> {
        val ws = Workspace(tempDir("dsh-ws"))
        val reg = registry(ws, listOf(FakePlugin("fake", tools)))
        val p = ToolPipeline(reg, ws, hooks, spillRoot = tempDir("dsh-spill"))
        return p to reg
    }

    private fun call(id: String, name: String, args: JSONObject = JSONObject()): ToolPipeline.Call =
        ToolPipeline.Call(id, name, args)

    private val gate = ToolPipeline.Gate(
        permission = "standard", planMode = false, planApproved = false, confirmDanger = false,
    )

    /* ---------------- 超时 ---------------- */

    @Test
    fun `one slow call times out without losing the rest of the batch`() {
        val (p, _) = pipeline(
            listOf(
                FakeTool("slow", timeoutMs = 120) { Thread.sleep(3_000); "should never be seen" },
                FakeTool("fast") { "fast ok" },
            ),
        )
        val outcomes = p.executeBatch(
            listOf(call("c1", "slow"), call("c2", "fast")),
            gate,
            FakeRuntime(),
        )

        assertEquals("每条调用都要有结果", 2, outcomes.size)
        assertEquals("顺序必须与模型给的 calls 一致", listOf("c1", "c2"), outcomes.map { it.id })

        val slow = outcomes[0]
        assertFalse(slow.ok)
        assertEquals("TOOL_TIMEOUT", slow.code)
        assertTrue("超时文案要带具体毫秒数：${slow.output}", slow.output.contains("timed out after 120ms"))

        val fast = outcomes[1]
        assertTrue("同批的成功结果不能因为别人超时被丢掉", fast.ok)
        assertEquals("fast ok", fast.output)
    }

    @Test
    fun `exclusive call with a declared budget also times out`() {
        val (p, _) = pipeline(
            listOf(
                FakeTool("blocker", timeoutMs = 100, executionMode = ToolExecutionMode.EXCLUSIVE) {
                    Thread.sleep(2_000)
                    "done"
                },
            ),
        )
        val outcomes = p.executeBatch(listOf(call("c1", "blocker")), gate, FakeRuntime())
        assertEquals(1, outcomes.size)
        assertEquals("TOOL_TIMEOUT", outcomes[0].code)
    }

    @Test
    fun `tool exception becomes a failed outcome instead of escaping the batch`() {
        val (p, _) = pipeline(
            listOf(
                FakeTool("boom") { throw IllegalStateException("kaboom") },
                FakeTool("ok") { "fine" },
            ),
        )
        val ends = mutableListOf<ToolPipeline.Outcome>()
        val outcomes = p.executeBatch(
            listOf(call("c1", "boom"), call("c2", "ok")),
            gate,
            FakeRuntime(),
            onEnd = { ends.add(it) },
        )

        assertEquals(2, outcomes.size)
        assertFalse(outcomes[0].ok)
        assertTrue("异常要收成失败结果：${outcomes[0].output}", outcomes[0].output.contains("kaboom"))
        assertTrue(outcomes[1].ok)

        assertEquals("onEnd 每条恰好一次", 2, ends.size)
        assertEquals(listOf("c1", "c2"), ends.map { it.id })
    }

    /* ---------------- 取消 ---------------- */

    @Test
    fun `calls not dispatched after cancellation report ABORTED_BEFORE_DISPATCH`() {
        val cancelled = AtomicBoolean(false)
        val (p, _) = pipeline(
            listOf(
                // 第一条是 exclusive：它跑完把取消位置上，后面两条只读调用就不该再派发了
                FakeTool("barrier", executionMode = ToolExecutionMode.EXCLUSIVE) {
                    cancelled.set(true)
                    "barrier done"
                },
                FakeTool("a") { "a ran" },
                FakeTool("b") { "b ran" },
            ),
        )
        val outcomes = p.executeBatch(
            listOf(call("c1", "barrier"), call("c2", "a"), call("c3", "b")),
            gate,
            FakeRuntime(),
            cancelled = { cancelled.get() },
        )

        assertEquals(3, outcomes.size)
        assertTrue("已成功的结果要保留", outcomes[0].ok)
        assertEquals("ABORTED_BEFORE_DISPATCH", outcomes[1].code)
        assertEquals("ABORTED_BEFORE_DISPATCH", outcomes[2].code)
        assertFalse(outcomes[1].ok)
        assertFalse(outcomes[2].ok)
        assertNull("没派发的调用不该有工具输出", outcomes[1].output.takeIf { it.contains("a ran") })
    }

    /* ---------------- 守卫 ---------------- */

    @Test
    fun `danger confirmation cannot overwrite a hard reject`() {
        val hooks = HookBus {}
        ToolPipeline.installBuiltinGuards(hooks)
        // 模拟「插件守卫」在危险确认之前硬拒绝只读档的 shell
        hooks.onWaterfall<ToolPipeline.GuardVerdict>("tools/pre-execute", "test/reject-shell", 60) { v, _ ->
            if (v.reject != null) return@onWaterfall v
            ToolPipeline.GuardVerdict(HookBus.Reject("策略拒绝：只读档禁止 shell"))
        }
        // 再模拟一个后到的监听器，试图把拒绝改写为「待批准」
        hooks.onWaterfall<ToolPipeline.GuardVerdict>("tools/pre-execute", "test/approve-override", 10) { _, _ ->
            ToolPipeline.GuardVerdict(null, true, "我觉得可以批准")
        }

        val executed = AtomicBoolean(false)
        val (p, _) = pipeline(listOf(FakeTool("bash") { executed.set(true); "ran" }), hooks)
        val runtime = FakeRuntime(approveResult = true)
        val outcomes = p.executeBatch(
            listOf(call("c1", "bash", JSONObject().put("command", "rm -rf /"))),
            gate.copy(confirmDanger = true),
            runtime,
        )

        assertEquals(1, outcomes.size)
        assertTrue("必须是被拒，而不是被改写成待批准：${outcomes[0]}", outcomes[0].denied)
        assertEquals("TOOL_DENIED", outcomes[0].code)
        assertEquals("不该弹审批，更不该执行", 0, runtime.approveCalls.get())
        assertFalse("工具不得被执行", executed.get())
    }

    @Test
    fun `approval still happens when danger asks for it`() {
        val hooks = HookBus {}
        ToolPipeline.installBuiltinGuards(hooks)
        val (p, _) = pipeline(listOf(FakeTool("bash") { "ran" }), hooks)
        val runtime = FakeRuntime(approveResult = true)
        val outcomes = p.executeBatch(
            listOf(call("c1", "bash", JSONObject().put("command", "rm -rf /tmp/x"))),
            gate.copy(confirmDanger = true),
            runtime,
        )
        assertEquals(1, runtime.approveCalls.get())
        assertTrue("批准后照常执行", outcomes[0].ok)
    }

    /* ---------------- 超时来源 ---------------- */

    @Test
    fun `declared timeout wins and defaults cover network and screenshot tools`() {
        val (p, _) = pipeline(
            listOf(
                FakeTool("web_fetch", timeoutMs = 50) { "x" },
                FakeTool("web_search") { "x" },
                FakeTool("phone_screenshot") { "x" },
                FakeTool("plain_tool") { "x" },
            ),
        )
        assertEquals("插件声明优先", 50L, p.timeoutOf("web_fetch"))
        assertEquals(30_000L, p.timeoutOf("web_search"))
        assertEquals(8_000L, p.timeoutOf("phone_screenshot"))
        assertNull("未声明的工具不限时", p.timeoutOf("plain_tool"))
        assertNull("未知工具不限时", p.timeoutOf("nope_not_registered"))
        assertEquals(30_000L, p.timeoutOf("mcp__server__tool"))
        assertEquals(12_500, ToolPipeline.MAX_INLINE_TOKENS)
    }

    @Test
    fun `onEnd fires once for denied calls too`() {
        val hooks = HookBus {}
        ToolPipeline.installBuiltinGuards(hooks)
        val (p, _) = pipeline(listOf(FakeTool("delete_path") { "deleted" }), hooks)
        val ends = mutableListOf<ToolPipeline.Outcome>()
        // readonly 档：delete_path 会被权限守卫硬拒
        val outcomes = p.executeBatch(
            listOf(call("c1", "delete_path", JSONObject().put("path", "a.txt"))),
            gate.copy(permission = "readonly"),
            FakeRuntime(),
            onEnd = { ends.add(it) },
        )
        assertEquals(1, outcomes.size)
        assertTrue(outcomes[0].denied)
        assertEquals(1, ends.size)
        assertEquals("TOOL_DENIED", ends[0].code)
    }

    @Test
    fun `Mission 收窄到只读时写工具照样硬拒`() {
        val hooks = HookBus {}
        ToolPipeline.installBuiltinGuards(hooks)
        val (p, _) = pipeline(listOf(FakeTool("delete_path") { "deleted" }), hooks)
        val approve = FakeRuntime(approveResult = true)
        // 会话是完全访问，但这件事被收窄成只读：合档结果是只读，点批准也不能绕过
        val eff = ai.deepseek.harness.mobile.kernel.mission.MissionRegistry.effectivePermission("full", "readonly")
        assertEquals("readonly", eff)
        val outcomes = p.executeBatch(
            listOf(call("c1", "delete_path", JSONObject().put("path", "a.txt"))),
            gate.copy(permission = eff, confirmDanger = false),
            approve,
        )
        assertTrue("只读的 Mission 必须硬拒写操作", outcomes[0].denied)
        assertEquals("硬拒不该被改写成一次批准", 0, approve.approveCalls.get())
    }

    @Test
    fun `Mission 想放宽到完全访问顶不过会话只读`() {
        val eff = ai.deepseek.harness.mobile.kernel.mission.MissionRegistry.effectivePermission("readonly", "full")
        assertEquals("readonly", eff)
    }

    @Test
    fun `spill notice points at a file that really exists`() {
        val spill = tempDir("dsh-spill-exists")
        val ws = Workspace(tempDir("dsh-ws-spill"))
        val big = "HEAD\n" + "x".repeat(120_000) + "\nTAIL-MARKER"
        val reg = registry(ws, listOf(FakePlugin("fake", listOf(FakeTool("big_output") { big }))))
        val p = ToolPipeline(reg, ws, HookBus {}, spillRoot = spill)
        val outcomes = p.executeBatch(listOf(call("c1", "big_output")), gate, FakeRuntime())

        assertEquals(1, outcomes.size)
        val out = outcomes[0].output
        assertTrue("要提示省略量：$out", out.contains("字节") && out.contains("已省略"))
        assertTrue("首尾都要保留", out.contains("HEAD") && out.contains("TAIL-MARKER"))
        val locator = out.lineSequence().firstOrNull { it.contains("完整内容已落盘") }
        assertNotNull("必须给出落点", locator)
        val path = locator!!.substringAfter("完整内容已落盘：").trim()
        assertTrue("落点必须是真实存在的文件：$path", File(path).isFile)
    }
}
