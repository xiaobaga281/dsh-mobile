package ai.deepseek.harness.mobile.kernel.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 元素选择的不变量验收。
 *
 * 这一段决定「点哪个」：错了的表现是「AI 乱点」，但日志里看不出哪一步错的。
 * 下面每条用例都对应一个**真机上会发作、静态审查却看不出来**的语义。
 */
class NodeMatchTest {

    private fun cand(text: String, label: String = "", visible: Boolean = true) =
        NodeMatch.Cand(text = text, label = label, visible = visible)

    @Test
    fun `空查询绝不命中`() {
        // 系统 API findAccessibilityNodeInfosByText("") 会返回整棵树；
        // 这里必须挡住，否则任何兜底都会退化成「点第一个节点」
        assertEquals(emptyList<Int>(), NodeMatch.select(listOf(cand("确定"), cand("取消")), "", false))
        assertEquals(emptyList<Int>(), NodeMatch.select(listOf(cand("确定")), "   ", false))
        assertFalse(NodeMatch.hit("确定", "", false))
    }

    @Test
    fun `模糊匹配大小写不敏感`() {
        assertEquals(listOf(0), NodeMatch.select(listOf(cand("Search")), "search", exact = false))
        assertEquals(listOf(0), NodeMatch.select(listOf(cand("搜索框")), "搜索", exact = false))
    }

    @Test
    fun `精确匹配不做大小写折叠`() {
        // exact 走的是 ==，这是原实现的语义；不能因为「更友好」就偷偷改成 equalsIgnoreCase，
        // 否则 exact=true 的用户以为在用严格匹配，实际仍会命中大小写变体
        assertEquals(emptyList<Int>(), NodeMatch.select(listOf(cand("Search")), "search", exact = true))
        assertEquals(listOf(0), NodeMatch.select(listOf(cand("Search")), "Search", exact = true))
    }

    @Test
    fun `自身文本优先于聚合标签`() {
        // 第 0 个只有聚合标签命中，第 1 个自身文本命中 → 必须选第 1 个，
        // 否则会点到一个「包含这些字的大容器」，触发整块区域的事件
        val cands = listOf(
            cand(text = "", label = "删除 取消 确定", visible = true),
            cand(text = "确定", label = "确定", visible = true),
        )
        assertEquals(listOf(1), NodeMatch.select(cands, "确定", exact = false))
    }

    @Test
    fun `自身文本都没命中时才退回聚合标签`() {
        val cands = listOf(cand(text = "", label = "音量 铃声 振动", visible = true))
        assertEquals(listOf(0), NodeMatch.select(cands, "铃声", exact = false))
    }

    @Test
    fun `可见元素优先于屏幕外的同文本元素`() {
        // 列表里第 0 个在屏幕外、第 1 个可见：ordinal 数的是「看得见的第 1 个」
        val cands = listOf(cand("更多", visible = false), cand("更多", visible = true))
        assertEquals(listOf(1), NodeMatch.select(cands, "更多", exact = false))
    }

    @Test
    fun `全不可见时放宽而不是返回空`() {
        // 典型场景：目标在列表下方，需要先滚进屏。放宽后由 scrollIntoView 处理
        val cands = listOf(cand("设置", visible = false), cand("设置", visible = false))
        assertEquals(listOf(0, 1), NodeMatch.select(cands, "设置", exact = false))
    }

    @Test
    fun `可见的聚合标签优先于不可见的自身文本`() {
        // 优先级 2（可见+标签）高于优先级 3（全部+文本）—— 这是原实现 ifEmpty 的顺序，
        // 换顺序会让「看得见但文本在子节点里」的按钮反而选不中
        val cands = listOf(
            cand(text = "确定", visible = false),
            cand(text = "", label = "确定", visible = true),
        )
        assertEquals(listOf(1), NodeMatch.select(cands, "确定", exact = false))
    }

    @Test
    fun `结果保持树序`() {
        // ordinal 直接按下标取，顺序一旦被打乱（比如按可见性重排），
        // 「第 2 个删除」就会点到另一个删除
        val cands = listOf(cand("删除"), cand("无关"), cand("删除"), cand("删除"))
        assertEquals(listOf(0, 2, 3), NodeMatch.select(cands, "删除", exact = false))
    }

    @Test
    fun `空白候选值不算命中`() {
        assertFalse(NodeMatch.hit("   ", "确定", false))
        assertFalse(NodeMatch.hit("", "", false))
    }

    @Test
    fun `越界提示必须给出合法范围`() {
        val hint = NodeMatch.ordinalHint(3)
        assertTrue("要给出范围，否则模型会拿同一个越界值原地重试", hint.contains("1..3"))
        assertTrue("要指向下一步动作", hint.contains("screen_read"))
    }
}
