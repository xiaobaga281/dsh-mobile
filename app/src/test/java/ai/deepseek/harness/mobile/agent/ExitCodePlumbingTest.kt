package ai.deepseek.harness.mobile.agent

import ai.deepseek.harness.mobile.kernel.Workspace
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.PluginRegistry
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolResult
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.exitCodeOfHeader
import ai.deepseek.harness.mobile.kernel.plugin.stripExitHeader
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * 前台命令退出码的透传链路：`exit=N` 头 → [ToolResult.exitCode] → 注册表信封 → [ToolPipeline.Outcome]。
 *
 * 这条链上每一段都必须是**旁路**：
 *  · 正文（模型看到的文本）一字不改 —— 以前为了拿退出码只能改正文，模型就会读到多余的一行
 *  · 退出码跟着单次调用走，同批并发两条命令不能互相串号（所以禁止「全局最后一次退出码」）
 */
class ExitCodePlumbingTest {

    /* ---------------- 头部解析 ---------------- */

    @Test
    fun `header parser reads the code and nothing else`() {
        assertEquals(0, exitCodeOfHeader("exit=0\n"))
        assertEquals(0, exitCodeOfHeader("exit=0\nhello"))
        assertEquals(2, exitCodeOfHeader("exit=2\nls: /nope: No such file or directory"))
        assertEquals(7, exitCodeOfHeader("exit=7"))
        assertEquals(127, exitCodeOfHeader("exit=127\nsh: xyz: not found"))
        assertEquals(-1, exitCodeOfHeader("exit=-1"))
    }

    /**
     * 后台任务把 exec 结果整段塞进输出环时，`exit=N` 头会变成正文的一部分：
     * job_output 与 Mission 通知卡因此把退出码显示两遍（真机 rc.186 实锤）。
     * 后台这一路要先把头剥掉。
     */
    @Test
    fun `strip header leaves only what the command printed`() {
        assertEquals("job-finished", stripExitHeader("exit=0\njob-finished"))
        assertEquals("", stripExitHeader("exit=0"))
        assertEquals("", stripExitHeader("exit=1\n"))
        // 没有头的正文原样保留（命令自己的输出里恰好带 "exit=" 字样时不能误伤）
        assertEquals("nope\nexit=0 is not a header here", stripExitHeader("nope\nexit=0 is not a header here"))
        assertEquals("plain output", stripExitHeader("plain output"))
    }

    @Test
    fun `header parser refuses anything that is not an exit header`() {
        // 后台任务的回执是 JSON，没有退出码（也就不能画徽标）
        assertNull(exitCodeOfHeader("""{"job_id":"j1","name":"sleep 60"}"""))
        // 输出里出现 exit= 不算，只有**首行**才是头
        assertNull(exitCodeOfHeader("hello\nexit=0"))
        // 首行长得像但不是数字
        assertNull(exitCodeOfHeader("exit=abc\nout"))
        assertNull(exitCodeOfHeader("5\nout"))
        assertNull(exitCodeOfHeader(""))
    }

    /* ---------------- 工具声明 ---------------- */

    private fun simpleTool(exitHeader: Boolean, text: String) = SimpleTool(
        name = "fake_bash",
        description = "fake",
        parameters = Schemas.params(emptyMap()),
        exitHeader = exitHeader,
    ) { text }

    @Test
    fun `simple tool with exitHeader reports the code and keeps the text intact`() {
        val tool = simpleTool(exitHeader = true, text = "exit=2\nls: /nope: No such file")
        val res = tool.executeResult(JSONObject(), ToolExecContext.NONE)
        assertEquals(2, res.exitCode)
        assertEquals("正文必须原样带回给模型", "exit=2\nls: /nope: No such file", res.text)
        // 老入口不变：execute 永远只有正文
        assertEquals("exit=2\nls: /nope: No such file", tool.execute(JSONObject()))
    }

    @Test
    fun `simple tool without the flag never invents a code`() {
        val tool = simpleTool(exitHeader = false, text = "exit=3\nboom")
        assertNull(tool.executeResult(JSONObject(), ToolExecContext.NONE).exitCode)
    }

    /* ---------------- 流水线 ---------------- */

    private class FakeTool(
        override val name: String,
        override val executionMode: ToolExecutionMode = ToolExecutionMode.PARALLEL,
        private val body: (JSONObject) -> ToolResult,
    ) : ToolSpec {
        override val description: String get() = "fake $name"
        override val parameters: JSONObject = Schemas.params(emptyMap())
        override fun execute(args: JSONObject): String = body(args).text
        override fun executeResult(args: JSONObject, ctx: ToolExecContext): ToolResult = body(args)
    }

    private class FakePlugin(override val tools: List<ToolSpec>) : KernelPlugin {
        override val id: String = "fake-exit"
        override val name: String get() = "fake"
        override val description: String get() = "fake"
    }

    private class NoopRuntime : ToolPipeline.RuntimeTools {
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

    private val gate = ToolPipeline.Gate("standard", planMode = false, planApproved = false, confirmDanger = false)

    private fun pipeline(tools: List<ToolSpec>): Pair<ToolPipeline, PluginRegistry> {
        val ws = Workspace(Files.createTempDirectory("dsh-exit-ws").toFile())
        val ctx = object : PluginContext {
            override val workspace: Workspace get() = ws
            override val sandbox: WorkspaceSandbox = WorkspaceSandbox(ws)
            override fun config(): JSONObject = JSONObject()
            override fun service(name: String): Any? = null
            override fun provide(name: String, value: Any?) {}
            override fun log(msg: String) {}
        }
        val reg = PluginRegistry(ctx, Files.createTempDirectory("dsh-exit-state").toFile(), HookBus {})
        reg.registerAll(listOf(FakePlugin(tools)))
        val p = ToolPipeline(reg, ws, HookBus {}, spillRoot = Files.createTempDirectory("dsh-exit-spill").toFile())
        return p to reg
    }

    @Test
    fun `registry envelope carries the code beside an unchanged output`() {
        val (_, reg) = pipeline(listOf(FakeTool("cmd") { ToolResult("exit=7\nout", 7) }))
        val env = JSONObject(reg.exec("cmd", "{}"))
        assertTrue(env.optBoolean("ok"))
        assertEquals("exit=7\nout", env.optString("output"))
        assertEquals(7, env.optInt("exit_code"))
    }

    @Test
    fun `registry omits the field when the tool has no code`() {
        val (_, reg) = pipeline(listOf(FakeTool("plain") { ToolResult("just text") }))
        val env = JSONObject(reg.exec("plain", "{}"))
        assertTrue("没有退出码就不写字段（界面据此决定画不画徽标）", !env.has("exit_code"))
    }

    @Test
    fun `non zero exit keeps the tool successful but exposes the code`() {
        val (p, _) = pipeline(listOf(FakeTool("cmd") { ToolResult("exit=2\nls: /nope", 2) }))
        val out = p.executeBatch(
            listOf(ToolPipeline.Call("c1", "cmd", JSONObject())), gate, NoopRuntime(),
        ).single()

        // 「命令跑了并失败」不是「工具调用失败」：bash 的语义一直如此，正文照回给模型
        assertTrue(out.ok)
        assertEquals("", out.code)
        assertEquals("exit=2\nls: /nope", out.output)
        assertEquals(2, out.exitCode)
    }

    @Test
    fun `parallel calls do not swap codes`() {
        val (p, _) = pipeline(
            listOf(
                FakeTool("zero") { Thread.sleep(30); ToolResult("exit=0\nok", 0) },
                FakeTool("seven") { ToolResult("exit=7\nnope", 7) },
            ),
        )
        val ends = mutableListOf<ToolPipeline.Outcome>()
        val out = p.executeBatch(
            listOf(
                ToolPipeline.Call("c1", "zero", JSONObject()),
                ToolPipeline.Call("c2", "seven", JSONObject()),
            ),
            gate, NoopRuntime(), onEnd = { ends.add(it) },
        )

        assertEquals(listOf(0, 7), out.map { it.exitCode })
        assertEquals("onEnd 里带的也是各自那一条的退出码", listOf(0, 7), ends.map { it.exitCode })
    }

    @Test
    fun `no code is invented for tools that never report one`() {
        val (p, _) = pipeline(listOf(FakeTool("plain") { ToolResult("text with exit=0 inside") }))
        val out = p.executeBatch(
            listOf(ToolPipeline.Call("c1", "plain", JSONObject())), gate, NoopRuntime(),
        ).single()
        assertNull("正文里出现 exit= 不能当退出码", out.exitCode)
        assertEquals("text with exit=0 inside", out.output)
    }
}
