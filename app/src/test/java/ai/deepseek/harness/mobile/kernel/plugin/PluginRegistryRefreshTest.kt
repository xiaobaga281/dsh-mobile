package ai.deepseek.harness.mobile.kernel.plugin

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * WP4a-③ 回归：动态工具索引（refreshTools / 派发一致性 / 并发 / 服务白名单）。
 *
 * 两条必须同时成立的不变量（否则模型会「看得见却调不到」或「调得到却看不见」）：
 *  - **exec ⊆ schemas**：插件删掉的工具绝不能还能执行；
 *  - **schemas ⊆ exec**：插件新增的工具即使没调 refreshTools 也必须能执行。
 *
 * 另外验证桌面 cordis-host-runner 的白名单 ctx 语义（`guard.ts:709-744`）在手机端的等价物：
 * 实现 `PluginRegistry.DeclaresServices` 的插件只拿得到声明的服务，且不能 provide。
 */
class PluginRegistryRefreshTest {

    private class MutablePlugin : KernelPlugin {
        override val id = "mutable"
        override val name = "可变插件"
        override val description = "工具集合在运行时会变"

        var specs: List<ToolSpec> = listOf(simpleTool("a"))
        override val tools: List<ToolSpec> get() = specs
    }

    private class DeclaringPlugin(pid: String, private val names: Set<String>) :
        KernelPlugin, PluginRegistry.DeclaresServices {
        override val id = pid
        override val name = "声明服务"
        override val description = "只拿声明的服务"

        var seen: Any? = null
        var hijacked: Boolean = false

        override fun declaredServices(): Set<String> = names

        override fun onLoad(ctx: PluginContext) {
            seen = ctx.service("job.registry")
            // 动态插件不该能把内核服务顶掉
            ctx.provide("job.registry", "hijack")
            hijacked = ctx.service("job.registry") == "hijack"
        }
    }

    private class Env(val registry: PluginRegistry, val ctx: FakePluginContext)

    private fun env(): Env {
        val root = tempDir("dsh-registry")
        val ctx = FakePluginContext(File(root, "workspace"))
        return Env(PluginRegistry(ctx, File(root, "kernel")), ctx)
    }

    private fun ok(json: String): Boolean = JSONObject(json).optBoolean("ok", false)
    private fun code(json: String): String = JSONObject(json).optString("code")

    @Test
    fun `refreshTools indexes new tools and drops removed ones`() {
        val e = env()
        val p = MutablePlugin()
        e.registry.register(p)
        assertTrue(ok(e.registry.exec("a", "{}")))

        p.specs = listOf(simpleTool("b"))
        assertEquals(1, e.registry.refreshTools("mutable"))
        assertTrue("新工具应可执行", ok(e.registry.exec("b", "{}")))
        assertEquals("旧工具必须立刻不可执行", "UNKNOWN_TOOL", code(e.registry.exec("a", "{}")))
    }

    @Test
    fun `visible tools are always callable even without refresh`() {
        val e = env()
        val p = MutablePlugin()
        e.registry.register(p)
        p.specs = listOf(simpleTool("c"))

        assertTrue("schemas 立刻能看见新工具", e.registry.schemas().toString().contains("\"c\""))
        assertTrue("看得见就必须调得到", ok(e.registry.exec("c", "{}")))
        assertEquals("看不见就不能调", "UNKNOWN_TOOL", code(e.registry.exec("a", "{}")))
    }

    @Test
    fun `unknown plugin id returns minus one`() {
        assertEquals(-1, env().registry.refreshTools("nope"))
    }

    @Test
    fun `declared services only are reachable and provide is refused`() {
        val e = env()
        e.ctx.services["job.registry"] = "the-registry"
        val none = DeclaringPlugin("decl-none", emptySet())
        val okOne = DeclaringPlugin("decl-ok", setOf("job.registry"))
        e.registry.register(none)
        e.registry.register(okOne)

        assertNull("未声明的服务必须拿不到", none.seen)
        assertEquals("声明过的服务可以拿到", "the-registry", okOne.seen)
        assertFalse("动态插件不得 provide 服务", none.hijacked)
        assertFalse("动态插件不得 provide 服务", okOne.hijacked)
        assertEquals("内核服务不能被顶掉", "the-registry", e.ctx.services["job.registry"])
    }

    @Test
    fun `exec carries the call context to the tool`() {
        val e = env()
        val p = object : KernelPlugin {
            override val id = "ctxp"
            override val name = "上下文"
            override val description = "读执行上下文"
            override val tools = listOf(simpleTool("ctx_tool") { ToolExecContext.currentOrNone().source })
        }
        e.registry.register(p)
        val out = JSONObject(e.registry.exec("ctx_tool", "{}", ToolExecContext(source = "ptc")))
        assertEquals("ptc", out.optString("output"))
    }

    @Test
    fun `parallel exec and refresh do not corrupt the index`() {
        val e = env()
        val p = MutablePlugin()
        p.specs = listOf(simpleTool("a"), simpleTool("b"))
        e.registry.register(p)

        val errors = CopyOnWriteArrayList<Throwable>()
        val threads = (1..4).map { n ->
            Thread {
                repeat(150) {
                    try {
                        if (n % 2 == 0) e.registry.refreshTools("mutable") else e.registry.exec("a", "{}")
                    } catch (t: Throwable) {
                        errors.add(t)
                    }
                }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }

        assertTrue("并发刷新/执行不应抛异常：$errors", errors.isEmpty())
        assertTrue("并发结束后索引仍然可用", ok(e.registry.exec("b", "{}")))
        assertTrue("并发结束后 schemas 仍然可用", e.registry.schemas().length() >= 2)
    }

    @Test
    fun `schemas 缓存 - 命中同一实例且随结构变更失效`() {
        val e = env()
        val first = e.registry.schemas()
        val second = e.registry.schemas()
        assertTrue("缓存命中应返回同一实例（不做每步全量重扫）", first === second)
        // 结构变更（新增插件）→ 缓存失效，新数组包含新工具
        e.registry.register(MutablePlugin().apply { specs = listOf(simpleTool("cached_extra")) })
        val third = e.registry.schemas()
        assertTrue("注册新插件后缓存必须失效", third !== first)
        val names = (0 until third.length()).map { third.optJSONObject(it)?.optString("name") }
        assertTrue("新工具进入 schema", "cached_extra" in names)
    }
}
