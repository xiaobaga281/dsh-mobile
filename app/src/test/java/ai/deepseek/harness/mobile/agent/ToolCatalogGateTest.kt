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
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * 「本轮到底把这个工具发给模型了吗」的判定回归。
 *
 * 对应两条实测出来的缺陷：
 *  1) 设置里窗口 ≤32k 时 `Presets.catalogFor` 把 `spawn_teammate` 等团队工具整个裁掉，
 *     Lead 的 schema 里没有它们 —— 实测跑 168 秒也建不出队友，模型只能嘴上说「我建了」；
 *  2) 模型调到本轮没给的工具时，落到 PluginRegistry 得到「未知工具：x（对应插件可能被禁用）」，
 *     把人和模型一起往插件清单上带，真正原因是目录裁剪。桌面端在执行器里按同一个谓词拒绝
 *     并把可用清单说清楚（core/tools 派发口 + 「与执行器同一个谓词」的提示段）。
 */
class ToolCatalogGateTest {

    private fun tempDir(tag: String): File = Files.createTempDirectory("dsh-cat-$tag").toFile()

    private class FakeTool(
        override val name: String,
        private val body: (JSONObject) -> String,
    ) : ToolSpec {
        override val description: String get() = "fake $name"
        override val parameters: JSONObject = Schemas.params(emptyMap())
        override val timeoutMs: Long? = null
        override val executionMode: ToolExecutionMode = ToolExecutionMode.PARALLEL
        override fun execute(args: JSONObject): String = body(args)
    }

    private class FakePlugin(override val tools: List<ToolSpec>) : KernelPlugin {
        override val id: String get() = "fake"
        override val name: String get() = "fake"
        override val description: String get() = "fake plugin"
    }

    private class FakeRuntime : ToolPipeline.RuntimeTools {
        val approves = AtomicInteger(0)
        override fun presentPlan(title: String, plan: String) = "ok"
        override fun markGoal(status: String, summary: String) = "ok"
        override fun editGoal(objective: String, maxRounds: Int) = "ok"
        override fun todoWrite(items: JSONArray) = "ok"
        override fun search(queries: List<String>, max: Int, fetchTop: Int, charsPerPage: Int) = "ok"
        override fun subagent(task: String, maxRounds: Int) = "ok"
        override fun useSkill(name: String) = "ok"
        override fun createGoal(objective: String, maxRounds: Int) = "ok"
        override fun getGoal() = "ok"
        override fun fetchUrl(url: String, maxChars: Int, offset: Int) = "ok"
        override fun addImage(path: String) = "ok"
        override fun addImageData(dataUrl: String, label: String) = "ok"
        override fun latestUserImage(): JSONObject? = null
        override fun askUser(question: String, options: JSONArray, detail: String) = "ok"
        override fun approve(name: String, args: JSONObject, reason: String): Boolean {
            approves.incrementAndGet()
            return true
        }
    }

    private fun pipeline(tools: List<ToolSpec>): ToolPipeline {
        val ws = Workspace(tempDir("ws"))
        val ctx = object : PluginContext {
            override val workspace: Workspace get() = ws
            override val sandbox: WorkspaceSandbox = WorkspaceSandbox(ws)
            override fun config(): JSONObject = JSONObject()
            override fun service(name: String): Any? = null
            override fun provide(name: String, value: Any?) {}
            override fun log(msg: String) {}
        }
        val reg = PluginRegistry(ctx, tempDir("state"), HookBus {})
        reg.registerAll(listOf(FakePlugin(tools)))
        return ToolPipeline(reg, ws, HookBus {}, spillRoot = tempDir("spill"))
    }

    private val gate = ToolPipeline.Gate("standard", false, false, false)

    @Test
    fun `目录里没有的调用在执行前就被拒绝，并且不落进工具本体`() {
        val executed = AtomicBoolean(false)
        val p = pipeline(listOf(
            FakeTool("bash") { executed.set(true); "ran" },
            FakeTool("write") { executed.set(true); "wrote" },
        ))
        val outcomes = p.executeBatch(
            listOf(ToolPipeline.Call("c1", "write", JSONObject())),
            gate, FakeRuntime(), catalog = setOf("bash"),
        )
        assertEquals(1, outcomes.size)
        val o = outcomes[0]
        assertFalse("本轮没给的工具必须失败", o.ok)
        assertTrue("要按拒绝处理", o.denied)
        assertEquals("TOOL_NOT_IN_CATALOG", o.code)
        assertFalse("工具本体一次都不该被执行", executed.get())
        assertTrue("要说清是哪个工具：${o.output}", o.output.contains("write"))
        assertTrue("要把本轮可用的工具告诉模型：${o.output}", o.output.contains("bash"))
        assertFalse("不该再误导成「插件可能被禁用」", o.output.contains("可能被禁用"))
    }

    @Test
    fun `不传目录时保持旧行为（内部调用不被误伤）`() {
        val executed = AtomicBoolean(false)
        val p = pipeline(listOf(FakeTool("bash") { executed.set(true); "ran" }))
        val outcomes = p.executeBatch(
            listOf(ToolPipeline.Call("c1", "bash", JSONObject())), gate, FakeRuntime(),
        )
        assertTrue(outcomes[0].ok)
        assertTrue("没给 catalog 就照常执行", executed.get())
    }

    @Test
    fun `空目录说明本轮根本没带工具`() {
        val p = pipeline(listOf(FakeTool("bash") { "ran" }))
        val o = p.executeBatch(
            listOf(ToolPipeline.Call("c1", "bash", JSONObject())), gate, FakeRuntime(),
            catalog = emptySet(),
        ).first()
        assertFalse(o.ok)
        assertTrue("文案要如实说明没带任何工具：${o.output}", o.output.contains("没有给模型任何工具"))
    }

    @Test
    fun `团队工具确实不在裁剪档里，所以豁免表是必需的`() {
        // 这条不是「测个常量」：它钉住豁免存在的理由。哪天有人把团队工具塞进 CORE/MID，
        // 或者反过来删掉豁免表，这条会红，逼他重新看一遍上面那条 168 秒建不出队友的实测。
        for (win in listOf(4096, 12288, 16384, 32768)) {
            val catalog = Presets.catalogFor(win)
            assertTrue("$win 应该有裁剪档", catalog != null)
            assertTrue("小窗口下 spawn_teammate 不在裁剪档里（所以才要豁免）",
                "spawn_teammate" !in catalog!!)
            assertTrue("豁免表必须包含它", "spawn_teammate" in Presets.TEAM_TOOLS)
        }
        assertEquals("窗口大于 32k 不裁剪", null, Presets.catalogFor(65536))
    }
}
