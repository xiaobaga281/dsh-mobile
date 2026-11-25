package ai.deepseek.harness.mobile.kernel.plugin

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.builtin.fs.PluginRules
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 自造插件的纯校验规则（PluginRules）。
 *
 * 这批规则是「模型一次装对」的全部保障，此前埋在 plugin_create 的 250 行
 * execute 里零覆盖 —— 规范说「最多 8 个工具」代码却从不检查这类漂移，
 * 就是没有测试才养出来的。
 */
class PluginRulesTest {

    private fun tool(name: String, desc: String = "说明", params: JSONObject? = null): JSONObject {
        val t = JSONObject().put("name", name).put("description", desc)
        if (params != null) t.put("parameters", params)
        return t
    }

    /* ---------------- id ---------------- */

    @Test fun `id 合法形态全部通过并规范化`() {
        assertEquals("word-count", PluginRules.checkId("Word-Count"))
        assertEquals("a1", PluginRules.checkId(" a1 "))
        assertEquals("x_y-2", PluginRules.checkId("x_y-2"))
    }

    @Test fun `id 非法形态各自给出原因`() {
        // 注意：checkId 先 trim+lowercase 再校验，所以纯大写形态（A_b）会被规范化成
        // 合法 id 放行 —— 真正非法的是结构不对的输入
        for (bad in listOf("", "a", "A b", "中文id", "has space", "tool-ish!", "x".repeat(41))) {
            try {
                PluginRules.checkId(bad)
                fail("应当拒绝：$bad")
            } catch (e: KernelError) {
                assertTrue(e.message!!.contains("插件 id"))
            }
        }
    }

    /* ---------------- 工具定义 ---------------- */

    @Test fun `合法工具定义返回全部名字`() {
        val arr = JSONArray().put(tool("md_lines")).put(
            tool("wc_lines", params = JSONObject().put("type", "object")),
        )
        assertEquals(listOf("md_lines", "wc_lines"), PluginRules.checkToolDefs(arr))
    }

    @Test fun `空数组拒绝`() {
        try { PluginRules.checkToolDefs(JSONArray()); fail() } catch (e: KernelError) {
            assertTrue(e.message!!.contains("至少给一个"))
        }
    }

    @Test fun `超过上限拒绝（规范说最多 8 个，旧实现从不检查）`() {
        val arr = JSONArray()
        repeat(9) { arr.put(tool("tool_$it")) }
        try { PluginRules.checkToolDefs(arr); fail() } catch (e: KernelError) {
            assertTrue(e.message!!.contains("最多 8 个"))
        }
    }

    @Test fun `恰好 8 个放行`() {
        val arr = JSONArray()
        repeat(8) { arr.put(tool("tool_$it")) }
        assertEquals(8, PluginRules.checkToolDefs(arr).size)
    }

    @Test fun `缺 description 拒绝`() {
        try {
            PluginRules.checkToolDefs(JSONArray().put(tool("t1", desc = "")))
            fail()
        } catch (e: KernelError) {
            assertTrue(e.message!!.contains("description"))
        }
    }

    @Test fun `parameters 非对象拒绝`() {
        try {
            PluginRules.checkToolDefs(JSONArray().put(tool("t1", params = null).put("parameters", "path")))
            fail()
        } catch (e: KernelError) {
            assertTrue(e.message!!.contains("JSON Schema"))
        }
    }

    @Test fun `清单内重名拒绝`() {
        val arr = JSONArray().put(tool("dup")).put(tool("dup"))
        try { PluginRules.checkToolDefs(arr); fail() } catch (e: KernelError) {
            assertTrue(e.message!!.contains("重名"))
        }
    }

    @Test fun `工具名非法拒绝`() {
        try {
            PluginRules.checkToolDefs(JSONArray().put(tool("Bad-Name")))
            fail()
        } catch (e: KernelError) {
            assertTrue(e.message!!.contains("小写字母开头"))
        }
    }

    /* ---------------- 冲突 ---------------- */

    @Test fun `与已装配插件撞名拒绝`() {
        try {
            PluginRules.checkConflicts(listOf("read", "mine_tool"), listOf("read", "write"))
            fail()
        } catch (e: KernelError) {
            assertTrue(e.message!!.contains("已被其它插件占用"))
            assertTrue(e.message!!.contains("read"))
            // 自己的名字不在指控里
            assertTrue(!e.message!!.contains("mine_tool"))
        }
    }

    @Test fun `无冲突静默通过`() {
        PluginRules.checkConflicts(listOf("mine_tool"), listOf("read", "write"))
    }

    /* ---------------- prompt 段落（一切皆插件：自造插件可贡献系统提示说明） ---------------- */

    @Test fun `prompt 合法时通过`() {
        PluginRules.checkPrompt(JSONObject().put("prompt", "何时用：统计文本行数。参数给相对路径。"))
    }

    @Test fun `prompt 缺省或空串视为没有段落`() {
        // 无 prompt 字段 = 合法（可选能力）
        PluginRules.checkPrompt(JSONObject())
        try {
            PluginRules.checkPrompt(JSONObject().put("prompt", "   "))
            fail("纯空白 prompt 应被拒绝")
        } catch (e: KernelError) { assertTrue(e.message!!.contains("非空")) }
    }

    @Test fun `prompt 非字符串或超长给出可行动错误`() {
        try {
            PluginRules.checkPrompt(JSONObject().put("prompt", JSONObject()))
            fail("非字符串应被拒绝")
        } catch (e: KernelError) { assertTrue(e.message!!.contains("非空字符串")) }
        try {
            PluginRules.checkPrompt(JSONObject().put("prompt", "x".repeat(1501)))
            fail("超长应被拒绝")
        } catch (e: KernelError) { assertTrue(e.message!!.contains("1500")) }
    }

    @Test fun `清单带 prompt 时插件贡献系统提示段落`() {
        val manifest = JSONObject()
            .put("id", "wc")
            .put("prompt", "何时用：统计行数。")
            .put("tools", JSONArray().put(tool("wc_lines").put("parameters", JSONObject().put("type", "object"))))
        val plugin = ManifestPlugin(manifest, java.io.File("wc.json"))
        assertEquals("何时用：统计行数。", plugin.promptSection())
        val none = ManifestPlugin(JSONObject().put("id", "wc2").put("tools", JSONArray().put(tool("wc2_lines"))), java.io.File("wc2.json"))
        assertEquals(null, none.promptSection())
    }
}
