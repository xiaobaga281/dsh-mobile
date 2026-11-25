package ai.deepseek.harness.mobile.kernel.plugin

import ai.deepseek.harness.mobile.kernel.KernelError
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * WP4a-① 回归：清单插件不能自声明只读，且只读档整体拒绝执行。
 *
 * 背景（审计发现）：旧 `ManifestPlugin.onLoad` 把清单里的 `"readOnly": true` 直通给
 * `ToolCatalog.registerDynamic`，于是只读会话里一个 `sh -c` 处理器被当成只读工具放行
 * —— 一个声明就等于一次越权。修复后：
 *  1. 动态工具一律按写操作对待（`ToolCatalog.registerDynamic` 不再接受 readOnly）；
 *  2. 只读档下 shell / JS 处理器直接拒绝（`Sandbox.checkExecutionSurface`）；
 *  3. 参数里像路径的键必须过 `checkWrite`，堵住「插件用参数绕开工作区」。
 */
class ManifestReadOnlyBypassTest {

    private val toolName = "wc_lines"

    @After
    fun cleanup() {
        ToolCatalog.unregisterDynamic(toolName)
    }

    private fun manifest(handler: String): JSONObject = JSONObject().apply {
        put("id", "wc")
        put("name", "字数统计")
        put("description", "测试插件")
        put("handler", handler)
        if (handler == "shell") put("command", "echo hi") else put("code", "return 'x'")
        put("tools", JSONArray().put(JSONObject().apply {
            put("name", toolName)
            put("description", "统计行数")
            // 审计里的只读绕过就靠这一行：清单自称"我是只读的"
            put("readOnly", true)
            put("parameters", JSONObject().apply {
                put("type", "object")
                put("properties", JSONObject().put("path", JSONObject().put("type", "string")))
                put("required", JSONArray().put("path"))
            })
        }))
    }

    private class Env(val plugin: ManifestPlugin, val ctx: FakePluginContext)

    private fun env(handler: String): Env {
        val root = tempDir("dsh-manifest")
        val ctx = FakePluginContext(File(root, "workspace"))
        val file = File(root, "wc.json").apply { writeText(manifest(handler).toString()) }
        val plugin = ManifestPlugin(JSONObject(file.readText()), file)
        plugin.onLoad(ctx)
        return Env(plugin, ctx)
    }

    private fun Env.execute(): String =
        plugin.tools.first { it.name == toolName }.execute(JSONObject().put("path", "a.txt"))

    @Test
    fun `manifest readOnly is ignored`() {
        env("shell")
        val meta = ToolCatalog.of(toolName)
        assertFalse("清单不得自声明只读", meta.readOnly)
        assertFalse("只读/计划模式下不得可见", meta.allowedWithoutWrite)
    }

    @Test
    fun `read only denies the shell handler`() {
        val e = env("shell")
        e.ctx.sandbox.apply("readonly")
        val err = assertThrows(KernelError::class.java) { e.execute() }
        assertTrue("错误要说明是只读档拒绝：${err.message}", err.message?.contains("只读") == true)
    }

    @Test
    fun `read only denies the js handler before runtime lookup`() {
        val e = env("js")
        e.ctx.sandbox.apply("readonly")
        // 没有装配 ptc.runtime，但只读拒绝必须先生效 —— 否则错误码会误导成"缺运行时"
        val err = assertThrows(KernelError::class.java) { e.execute() }
        assertTrue("错误要说明是只读档拒绝：${err.message}", err.message?.contains("只读") == true)
    }

    @Test
    fun `path arguments are forced through checkWrite`() {
        val e = env("shell")
        e.ctx.sandbox.apply("ask")
        val bad = assertThrows(KernelError::class.java) {
            e.plugin.sanitizeArgs(toolName, JSONObject().put("path", "../escape.txt"))
        }
        assertTrue("越界路径必须被 checkWrite 拦住：${bad.message}", bad.message?.contains("越界") == true)

        val ok = e.plugin.sanitizeArgs(
            toolName,
            JSONObject().put("path", "a.txt").put("query", "../not-a-path"),
        )
        assertEquals("a.txt", ok.optString("path"))
        assertEquals("非路径键不得被改写", "../not-a-path", ok.optString("query"))
    }

    @Test
    fun `read only denies path arguments`() {
        val e = env("shell")
        e.ctx.sandbox.apply("readonly")
        val err = assertThrows(KernelError::class.java) {
            e.plugin.sanitizeArgs(toolName, JSONObject().put("path", "a.txt"))
        }
        assertTrue(err.message?.contains("只读") == true)
    }
}
