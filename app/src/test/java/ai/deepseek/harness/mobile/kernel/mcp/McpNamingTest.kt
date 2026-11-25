package ai.deepseek.harness.mobile.kernel.mcp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MCP 公开工具名的 JVM 验收（桌面 `publicToolName` 的等价实现）。
 *
 * 名字是**对外约定**：会话历史与权限规则都记着它。所以两条不变量必须焊死：
 *   1. 干净情况就是 `mcp__<server>__<raw>`，不做无谓改写
 *   2. 需要规范化时，不同 (server, raw) **绝不折叠**（有损部分用哈希兜住）
 */
class McpNamingTest {

    @Test
    fun `干净名字原样保留`() {
        assertEquals("mcp__github__create_issue", McpToolName.publicName("github", "create_issue"))
        assertEquals("mcp__web__search", McpToolName.publicName("web", "search"))
    }

    @Test
    fun `两个服务器同名工具共存且不折叠`() {
        val a = McpToolName.publicName("github", "search")
        val b = McpToolName.publicName("web", "search")
        assertNotEquals("不同 server 的同名工具必须可区分", a, b)
        assertEquals("mcp__github__search", a)
        assertEquals("mcp__web__search", b)
    }

    @Test
    fun `非法字符被规范化且追加哈希`() {
        val n = McpToolName.publicName("my server", "do/thing")
        assertFalse("不能含空格", n.contains(' '))
        assertFalse("不能含斜杠", n.contains('/'))
        assertTrue("必须以 mcp__ 前缀开头", n.startsWith("mcp__"))
        assertTrue("规范化后长度受限", n.length <= McpToolName.MAX_LENGTH)
    }

    @Test
    fun `超长名字被截断但仍带哈希后缀`() {
        val raw = "very_long_tool_name_" + "x".repeat(200)
        val n = McpToolName.publicName("server", raw)
        assertTrue(n.length <= McpToolName.MAX_LENGTH)
        assertTrue("必须有哈希后缀以保区分度", n.takeLast(McpToolName.HASH_LEN).all { it.isDigit() || it in 'a'..'f' })
    }

    @Test
    fun `规范化是确定性的`() {
        val raw = "weird name with spaces"
        assertEquals(McpToolName.publicName("s", raw), McpToolName.publicName("s", raw))
    }

    @Test
    fun `不同身份在规范化后仍然互不相同`() {
        val cases = listOf(
            "s" to "weird name",
            "s" to "weird/name",
            "s" to "weird-name",
            "s 2" to "weird name",
            "other" to "weird name",
        )
        val names = cases.map { McpToolName.publicName(it.first, it.second) }
        assertEquals("不能有任何折叠：$names", cases.size, names.toSet().size)
    }

    @Test
    fun `server 名合法性按桌面规则校验`() {
        assertTrue(McpToolName.validServerName("github"))
        assertTrue(McpToolName.validServerName("my_server-1"))
        assertFalse(McpToolName.validServerName(""))
        assertFalse("含空格不合法", McpToolName.validServerName("my server"))
        assertFalse("超过 32 字不合法", McpToolName.validServerName("a".repeat(33)))
    }

    @Test
    fun `展示用拆分对干净名字有效_对规范化名字返回 null`() {
        assertEquals("github" to "create_issue", McpToolName.displayParts("mcp__github__create_issue"))
        assertNull(McpToolName.displayParts("not_an_mcp_tool"))
    }
}
