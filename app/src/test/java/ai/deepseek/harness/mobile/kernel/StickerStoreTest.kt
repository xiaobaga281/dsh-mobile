package ai.deepseek.harness.mobile.kernel

import org.json.JSONObject
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 表情仓库的画面描述（desc）是「模型认识表情」的关键：
 * 只存 id/name 时模型只能按名字猜，存了 desc 才能按内容挑。这里锁住三条规则：
 *  - desc 存得下、读得回；
 *  - 重新 add 同一 id（比如加权）时不会把已有 desc 冲掉；
 *  - describe() 能补标注，且不会把别的条目带坏。
 */
class StickerStoreTest {

    private fun tmpStore(): Pair<StickerStore, File> {
        val f = File.createTempFile("stickers", ".json")
        f.delete()
        return StickerStore(f) to f
    }

    private fun item(id: String, name: String, desc: String = ""): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("kind", "static")
        .put("mime", "image/png").put("dataUrl", "data:image/png;base64,AAAA")
        .put("desc", desc)

    @Test
    fun `desc 能存进仓库并读回来`() {
        val (st, f) = tmpStore()
        try {
            st.add(item("s-1", "狗头", "黄色柴犬侧脸，嘴角上扬，嘲讽表情"))
            val hit = st.find("s-1")
            assertEquals("黄色柴犬侧脸，嘴角上扬，嘲讽表情", hit?.optString("desc"))
            // 重新打开文件也能读到（不是只在内存里）
            assertEquals("黄色柴犬侧脸，嘴角上扬，嘲讽表情", StickerStore(f).find("s-1")?.optString("desc"))
        } finally {
            f.delete()
        }
    }

    @Test
    fun `加权时不会冲掉已有描述`() {
        val (st, f) = tmpStore()
        try {
            st.add(item("s-1", "狗头", "黄色柴犬侧脸，嘲讽表情"))
            // 模拟「只给 id/name 加权重」：没有 desc 字段
            st.add(JSONObject().put("id", "s-1").put("name", "狗头").put("dataUrl", "data:image/png;base64,AAAA"))
            assertEquals("黄色柴犬侧脸，嘲讽表情", st.find("s-1")?.optString("desc"))
        } finally {
            f.delete()
        }
    }

    @Test
    fun `describe 能补标注且只改目标条目`() {
        val (st, f) = tmpStore()
        try {
            st.add(item("s-1", "红块"))
            st.add(item("s-2", "蓝块", "纯蓝色方块"))
            assertTrue(st.describe("s-1", "纯红色方块，无文字"))
            assertEquals("纯红色方块，无文字", st.find("s-1")?.optString("desc"))
            assertEquals("纯蓝色方块", st.find("s-2")?.optString("desc"))
            assertFalse(st.describe("s-404", "不存在"))
            assertFalse(st.describe("s-1", "   "))
        } finally {
            f.delete()
        }
    }

    @Test
    fun `手动排序会落成 order 并且重开也保持`() {
        val (st, f) = tmpStore()
        try {
            st.add(item("s-1", "甲"))
            st.add(item("s-2", "乙"))
            st.add(item("s-3", "丙"))
            // 没拖过之前不该有 order（面板仍按常用优先排）
            assertEquals(-1, st.find("s-1")?.optInt("order", -1))

            assertTrue(st.reorder(listOf("s-3", "s-1", "s-2")))

            val ids = (0 until st.list().length()).map { st.list().optJSONObject(it).optString("id") }
            assertEquals(listOf("s-3", "s-1", "s-2"), ids)
            assertEquals(0, st.find("s-3")?.optInt("order", -1))
            assertEquals(2, st.find("s-2")?.optInt("order", -1))
            // 重开文件：顺序是持久化的，不是内存里的假象
            val again = StickerStore(f)
            assertEquals("s-3", again.list().optJSONObject(0).optString("id"))
        } finally {
            f.delete()
        }
    }

    @Test
    fun `删除后 order 不留空洞`() {
        val (st, f) = tmpStore()
        try {
            st.add(item("s-1", "甲"))
            st.add(item("s-2", "乙"))
            st.add(item("s-3", "丙"))
            st.reorder(listOf("s-1", "s-2", "s-3"))
            assertTrue(st.remove("s-2"))
            assertEquals(0, st.find("s-1")?.optInt("order", -1))
            assertEquals(1, st.find("s-3")?.optInt("order", -1))
        } finally {
            f.delete()
        }
    }
}
