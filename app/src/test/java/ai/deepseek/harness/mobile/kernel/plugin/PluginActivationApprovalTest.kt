package ai.deepseek.harness.mobile.kernel.plugin

import ai.deepseek.harness.mobile.kernel.plugin.builtin.fs.PluginBuilderPlugin
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * WP4a-② 回归：装配插件必须先过信任闸门。
 *
 * 对齐桌面 cordis-host-runner 的 human-approved activation
 * （`packages/extensions/cordis-host-runner/src/index.ts:295-321`）：
 *  - 只读档：直接拒绝，连审批都不该发起；
 *  - 标准档：逐次审批；无人能批准（团队/后台/无活跃轮次）→ 拒绝，不得默认放行；
 *  - 完全授权档：不再逐条确认（该档位的定义）。
 *
 * 旧行为：`plugin_create` 直接把清单写盘并注册，一段任意代码从这一刻起随时可被模型调用，
 * 且重启后由 ExternalPluginLoader 自动复活 —— 全程没有任何人类动作。
 */
class PluginActivationApprovalTest {

    private class Env(val ctx: FakePluginContext, val registry: PluginRegistry)

    private fun env(permission: String, approve: Boolean?): Env {
        val root = tempDir("dsh-activation")
        val ctx = FakePluginContext(File(root, "workspace"))
        ctx.sandbox.apply(permission)
        val kernelDir = File(root, "kernel").apply { mkdirs() }
        val pluginDir = File(kernelDir, "plugins").apply { mkdirs() }
        ctx.services["plugin.dir"] = pluginDir
        val registry = PluginRegistry(ctx, kernelDir)
        ctx.services["plugin.registry"] = registry
        if (approve != null) ctx.services["agent.runtime"] = FakeRuntime(approve)
        registry.register(PluginBuilderPlugin())
        return Env(ctx, registry)
    }

    private fun createArgs(id: String): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", id)
        put("description", "测试插件")
        put("handler", "shell")
        put("command", "echo hi")
        put("tools", JSONArray().put(JSONObject().apply {
            put("name", "${id}_tool")
            put("description", "工具")
            put("parameters", JSONObject().put("type", "object"))
        }))
    }

    private fun dispatch(e: Env, tool: String, args: JSONObject): JSONObject =
        JSONObject(e.registry.exec(tool, args.toString()))

    private fun runtime(e: Env): FakeRuntime =
        e.ctx.services["agent.runtime"] as FakeRuntime

    @Test
    fun `read only refuses activation without even asking`() {
        val e = env("readonly", approve = true)
        val r = dispatch(e, "plugin_create", createArgs("demo"))
        assertFalse(r.optBoolean("ok", true))
        assertTrue("应说明只读档拒绝：${r.optString("error")}", r.optString("error").contains("只读"))
        assertFalse("只读档不得留下任何插件", e.registry.has("demo"))
        assertEquals("只读档不应发起审批", 0, runtime(e).approveCalls)
    }

    @Test
    fun `standard mode denial aborts the activation`() {
        val e = env("ask", approve = false)
        val r = dispatch(e, "plugin_create", createArgs("demo"))
        assertFalse(r.optBoolean("ok", true))
        assertTrue("应说明未获批准：${r.optString("error")}", r.optString("error").contains("未获批准"))
        assertFalse(e.registry.has("demo"))
        assertEquals(1, runtime(e).approveCalls)
    }

    @Test
    fun `standard mode with approval activates and registers tools`() {
        val e = env("ask", approve = true)
        val r = dispatch(e, "plugin_create", createArgs("demo"))
        assertTrue("装配失败：${r.optString("error")}", r.optBoolean("ok", false))
        assertTrue(e.registry.has("demo"))
        assertTrue(e.registry.toolNamesOf("demo").contains("demo_tool"))
        val reason = runtime(e).lastReason
        assertTrue("审批文案要说清风险：$reason", reason.contains("sh -c") || reason.contains("V8"))
    }

    @Test
    fun `no approval channel denies instead of defaulting to allow`() {
        val e = env("ask", approve = null)
        val r = dispatch(e, "plugin_create", createArgs("demo"))
        assertFalse("无人值守时不得默认放行：${r.optString("error")}", r.optBoolean("ok", true))
        assertFalse(e.registry.has("demo"))
    }

    @Test
    fun `full access activates without prompting`() {
        val e = env("full", approve = null)
        val r = dispatch(e, "plugin_create", createArgs("demo"))
        assertTrue("完全授权档应直接装配：${r.optString("error")}", r.optBoolean("ok", false))
        assertTrue(e.registry.has("demo"))
    }

    @Test
    fun `plugin install goes through the same gate`() {
        // 先前写下一份清单（模拟"上次没装配完"），再用 plugin_install 激活
        val e = env("ask", approve = false)
        val f = File(e.ctx.services["plugin.dir"] as File, "demo.json")
        f.writeText(JSONObject().apply {
            put("id", "demo")
            put("handler", "shell")
            put("command", "echo hi")
            put("tools", JSONArray().put(JSONObject().apply {
                put("name", "demo_tool")
                put("description", "工具")
                put("parameters", JSONObject().put("type", "object"))
            }))
        }.toString())
        val r = dispatch(e, "plugin_install", JSONObject().put("id", "demo"))
        assertFalse(r.optBoolean("ok", true))
        assertTrue(r.optString("error").contains("未获批准"))
        assertFalse(e.registry.has("demo"))
    }
}
