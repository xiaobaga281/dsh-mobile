package ai.deepseek.harness.mobile.kernel.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 读屏大纲纯层的规则钉死 —— 尤其是那条真 bug：
 * texts 门槛必须是独立的 200 条，不能被 elements 数量连坐清零。
 */
class ScreenOutlineTest {

    private fun interactive(
        label: String = "",
        l: Int = 0, t: Int = 0, r: Int = 100, b: Int = 40,
        id: String = "",
    ) = ScreenOutline.NodeSnap(
        ownText = label, label = label, cls = "Button", id = id,
        clickable = true, editable = false, scrollable = false,
        checkable = false, checked = null, enabled = true,
        l = l, t = t, r = r, b = b,
    )

    private fun plain(text: String) = ScreenOutline.NodeSnap(
        ownText = text, label = text, cls = "TextView", id = "",
        clickable = false, editable = false, scrollable = false,
        checkable = false, checked = null, enabled = true,
        l = 0, t = 0, r = 100, b = 20,
    )

    @Test
    fun texts_survive_when_elements_full() {
        // 3 个可交互元素（上限 2）+ 若干纯文本：texts 必须完整，不再被连坐
        val snaps = listOf(
            interactive("按钮一", t = 0), interactive("按钮二", t = 60),
            plain("这是页面标题"), plain("这是说明文字，比按钮的标签长很多"),
        )
        val r = ScreenOutline.build(snaps, maxElements = 2)
        assertEquals(2, r.elements.length())
        assertTrue("truncated 应为 true", r.truncated)
        assertEquals("texts 被连坐清零了（老 bug 回归）", 2, r.texts.length())
        assertEquals("这是页面标题", r.texts.optString(0))
    }

    @Test
    fun same_bounds_kept_only_once_unless_labelled() {
        // 原语义：去重只针对「空 label 的重复容器」，有 label 的节点永远保留
        // （否则卡片里 label 在子节点、bounds 相同的可点容器会被吞掉）
        val snaps = listOf(
            interactive(l = 0, t = 0, r = 100, b = 40),                    // 容器（空 label）
            interactive(l = 0, t = 0, r = 100, b = 40, label = "确定"),     // 同 bounds 但有 label → 放行
            interactive(l = 0, t = 0, r = 100, b = 40, label = "确定"),     // 同 bounds 有 label → 仍放行
            interactive(l = 0, t = 0, r = 100, b = 40),                    // 同 bounds 空 label → 去重
        )
        val r = ScreenOutline.build(snaps, maxElements = 60)
        assertEquals(3, r.elements.length())
    }

    @Test
    fun element_index_maps_back_to_snap_positions() {
        val snaps = listOf(
            plain("标题文字"),
            interactive("第一个按钮", t = 10),
            plain("说明"),
            interactive("第二个按钮", t = 90),
        )
        val r = ScreenOutline.build(snaps, maxElements = 60)
        assertEquals(listOf(1, 3), r.elementSnaps)
        assertEquals("第一个按钮", r.elements.optJSONObject(0)?.optString("text"))
        assertEquals(0, r.elements.optJSONObject(0)?.optInt("index"))
        assertEquals(1, r.elements.optJSONObject(1)?.optInt("index"))
    }

    @Test
    fun bounds_cx_cy_are_centers() {
        val r = ScreenOutline.build(listOf(interactive(l = 10, t = 20, r = 110, b = 60)), 60)
        val b = r.elements.optJSONObject(0)?.optJSONObject("bounds")!!
        assertEquals(60, b.optInt("cx"))
        assertEquals(40, b.optInt("cy"))
    }

    @Test
    fun texts_dedupe_and_short_text_dropped() {
        // "重复" 去重为 1 条；"ok" 长度 2（>1 门槛）保留；最后一条保留 → 共 3 条
        val snaps = listOf(plain("重复"), plain("重复"), plain("ok"), plain("这是足够长的一条"))
        val r = ScreenOutline.build(snaps, 60)
        assertEquals(3, r.texts.length())
    }

    @Test
    fun disabled_flag_present_and_checked_null_means_null() {
        val disabled = interactive("禁用").copy(enabled = false, checkable = true, checked = true)
        val r = ScreenOutline.build(listOf(disabled), 60)
        val el = r.elements.optJSONObject(0)!!
        assertTrue(el.optBoolean("disabled"))
        assertEquals(true, el.optBoolean("checked"))
        val plainBtn = ScreenOutline.build(listOf(interactive("普通")), 60)
            .elements.optJSONObject(0)!!
        assertFalse(plainBtn.has("disabled"))
        assertTrue(plainBtn.isNull("checked"))
    }

    // ---- 节点树补齐（2026-11-09）：elements 空了也要有 nodes / res_id ----

    @Test
    fun nodes_keep_non_interactive_controls_with_resource_id() {
        // 微信输入框这类：没有 clickable，但有 resource-id —— 以前只进 texts（纯字符串，
        // 没有 id/class/bounds），模型只能靠坐标蒙。现在必须进 nodes。
        val editBox = plain("发消息").copy(
            resId = "com.tencent.mm:id/gaq", id = "gaq", cls = "EditText",
            editable = true, clickable = false,
        )
        val r = ScreenOutline.build(listOf(editBox), 60)
        assertEquals("可编辑控件应算可交互", 1, r.elements.length())
        assertEquals(1, r.nodes.length())
        val n = r.nodes.optJSONObject(0)!!
        assertEquals("com.tencent.mm:id/gaq", n.optString("res_id"))
        assertEquals(true, n.optBoolean("visible"))
    }

    @Test
    fun invisible_nodes_do_not_pollute_elements_or_texts_but_appear_in_nodes() {
        // isVisibleToUser=false 的节点：以前整条丢弃 → elements 可能全空。
        // 现在进 nodes（带 visible:false），但不占 elements/texts。
        val hidden = plain("隐藏的说明").copy(visible = false)
        val btn = interactive("确定", t = 100)
        val r = ScreenOutline.build(listOf(hidden, btn), 60)
        assertEquals(1, r.elements.length())
        assertEquals("不可见节点不该进 texts", 0, r.texts.length())
        assertEquals("不可见但有文本的节点要留在 nodes 里", 2, r.nodes.length())
        assertEquals(false, r.nodes.optJSONObject(0)!!.optBoolean("visible"))
    }

    @Test
    fun nodes_expose_content_description_separately() {
        val n = plain("").copy(cd = "返回按钮", resId = "android:id/back", id = "back")
        val r = ScreenOutline.build(listOf(n), 60)
        val node = r.nodes.optJSONObject(0)!!
        assertEquals("返回按钮", node.optString("cd"))
        assertEquals("android:id/back", node.optString("res_id"))
    }

    // ---- diff（操作回执）：增 / 删 / 改 / 无变化 ----

    private fun print(code: String) = ScreenOutline.fingerprintKey("pkg", code, "Button", 0, 0, 10, 10)
    private fun valT(text: String, checked: Boolean? = null) = ScreenOutline.fingerprintValue(text, checked)

    @Test
    fun diff_reports_added_removed_changed() {
        val before = mapOf(print("a") to valT("确定"), print("b") to valT("取消"))
        val after = mapOf(
            print("a") to valT("已提交"),          // 同一控件文本变了
            print("c") to valT("完成"),            // 新出现
        )
        val d = ScreenOutline.diff(before, after)
        assertEquals(1, d.optInt("added_n"))
        assertEquals(1, d.optInt("removed_n"))
        assertEquals(1, d.optInt("changed_n"))
        assertEquals(false, d.optBoolean("same"))
        assertEquals("已提交", d.optJSONArray("changed")!!.optJSONObject(0)!!.optString("text"))
        assertEquals("确定", d.optJSONArray("changed")!!.optJSONObject(0)!!.optString("was"))
        assertEquals("c", d.optJSONArray("added")!!.optJSONObject(0)!!.optString("res_id"))
        assertEquals("b", d.optJSONArray("removed")!!.optJSONObject(0)!!.optString("res_id"))
    }

    @Test
    fun diff_same_when_nothing_changed() {
        val m = mapOf(print("a") to valT("确定"))
        val d = ScreenOutline.diff(m, m)
        assertTrue("没变化时 same 必须是 true —— 模型据此判断「没点中」", d.optBoolean("same"))
        assertEquals(0, d.optInt("added_n") + d.optInt("removed_n") + d.optInt("changed_n"))
    }

    @Test
    fun diff_checked_toggle_counts_as_changed() {
        val before = mapOf(print("sw") to valT("开关", false))
        val after = mapOf(print("sw") to valT("开关", true))
        val d = ScreenOutline.diff(before, after)
        assertEquals(1, d.optInt("changed_n"))
        assertEquals(false, d.optBoolean("same"))
    }
}
