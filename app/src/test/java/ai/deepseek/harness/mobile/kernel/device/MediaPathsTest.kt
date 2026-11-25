package ai.deepseek.harness.mobile.kernel.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 路径段清洗与媒体合并的验收。
 *
 * 这两段都站在「模型给什么就写什么」的入口上：
 *   - 清洗错了 → 文件写到意料之外的位置，或者静默写失败；
 *   - 合并错了 → 模型说「最近 5 条」，实际拿到「5 张图 + 5 个视频」且顺序与时间无关。
 * 两者原本都有实现，但**散成 5 份、规则不一致、没有上限**，真机上只能靠试。
 */
class MediaPathsTest {

    @Test
    fun `斜杠与上跳会被抹平`() {
        // 判据是「清洗后作为**单个路径段**无法改变父目录」，不是「字符串里不含两个点」：
        // `.._.._etc_passwd` 整段就是一个普通文件名，`/` 已经变成 `_`，走不出当前目录。
        // 反过来若只删掉 `/` 而留下 `..`，拼成 "Pictures/../.." 才是真越界。
        val v = MediaPaths.cleanName("../../etc/passwd", "fallback")
        assertFalse("不能残留分隔符：$v", v.contains("/"))
        assertFalse("不能残留反斜杠：$v", v.contains("\\"))
        assertFalse("整段不能恰好是上跳：$v", v == ".." || v == ".")
        assertTrue("应保留可读部分，而不是整体丢弃", v.contains("etc"))
    }

    @Test
    fun `各系统的非法字符统一换成下划线`() {
        val v = MediaPaths.cleanName("a\\b:c*d?e\"f<g>h|i", "fallback")
        listOf('\\', ':', '*', '?', '"', '<', '>', '|').forEach {
            assertFalse("不该残留 $it：$v", v.contains(it))
        }
        assertEquals("a_b_c_d_e_f_g_h_i", v)
    }

    @Test
    fun `刻意保留括号空格与中文`() {
        // 换 _ 而不是删，是为了不丢信息：「微信/收藏」→「微信_收藏」而不是「微信收藏」
        assertEquals("我的照片(1)", MediaPaths.cleanName("我的照片(1)", "f"))
        assertEquals("行程 表", MediaPaths.cleanName("行程 表", "f"))
        assertEquals("微信_收藏", MediaPaths.cleanName("微信/收藏", "f"))
    }

    @Test
    fun `控制字符被清掉`() {
        // 文件名里的 \n 会让列表显示错位，也让后续按行解析的代码出错
        assertEquals("a_b", MediaPaths.cleanName("a\u0000b", "f"))
        assertEquals("ab", MediaPaths.cleanName("a\u0007b", "f").replace("_", ""))
    }

    @Test
    fun `空输入回退到默认名`() {
        assertEquals("DSH Mobile", MediaPaths.cleanName("", "DSH Mobile"))
        assertEquals("DSH Mobile", MediaPaths.cleanName("   ", "DSH Mobile"))
        // 全是控制字符 → 清洗成 "__"，那不是名字，必须回退（否则相册里多出一个下划线目录）
        assertEquals("fallback", MediaPaths.cleanName("\u0001\u0002", "fallback"))
    }

    @Test
    fun `超长名字被截断到上限`() {
        // Android 单个路径段上限 255 **字节**，中文 3 字节 —— 没有上限时会在写盘时失败，
        // 而错误信息里看不出是「名字太长」
        val long = "很".repeat(200)
        val v = MediaPaths.cleanName(long, "f")
        assertEquals(MediaPaths.MAX_SEGMENT, v.length)
        assertTrue("60 个中文 = 180 字节，低于 255", v.toByteArray(Charsets.UTF_8).size < 255)
    }

    @Test
    fun `前导空白不计入长度`() {
        // trim 在截断之前：60 个前导空格不该把真名挤出上限
        val padded = " ".repeat(MediaPaths.MAX_SEGMENT) + "真名"
        assertEquals("真名", MediaPaths.cleanName(padded, "fallback"))
    }

    @Test
    fun `合并两路结果按时间统一排序`() {
        // 图片 2 条、视频 2 条，交错的时间戳：结果必须是全局最新的 limit 条
        val images = listOf(row(100), row(300))
        val videos = listOf(row(200), row(400))
        val merged = MediaPaths.mergeRecent(images, videos, limit = 3)
        assertEquals(listOf(400L, 300L, 200L), merged.map { it.optLong("ts") })
    }

    @Test
    fun `合并后截断到 limit 而不是各自抢名额`() {
        // 旧实现的风险：两路各取 limit 再加起来，limit=2 时会返回 4 条
        val images = listOf(row(10), row(9), row(8))
        val videos = listOf(row(7), row(6), row(5))
        assertEquals(2, MediaPaths.mergeRecent(images, videos, limit = 2).size)
    }

    @Test
    fun `同一时间戳保持传入顺序`() {
        // 同一秒连拍：稳定排序，不能把图片和视频交替打乱
        val images = listOf(row(100, "img1"), row(100, "img2"))
        val videos = listOf(row(100, "vid1"))
        val merged = MediaPaths.mergeRecent(images, videos, limit = 3)
        assertEquals(listOf("img1", "img2", "vid1"), merged.map { it.optString("name") })
    }

    @Test
    fun `单路为空等价于只排一路`() {
        val images = listOf(row(5), row(1))
        assertEquals(listOf(5L, 1L), MediaPaths.mergeRecent(images, emptyList(), 10).map { it.optLong("ts") })
        assertEquals(emptyList<JSONObject>(), MediaPaths.mergeRecent(emptyList(), emptyList(), 10))
    }

    @Test
    fun `limit 非正数返回空`() {
        assertTrue(MediaPaths.mergeRecent(listOf(row(1)), listOf(row(2)), 0).isEmpty())
        assertTrue(MediaPaths.mergeRecent(listOf(row(1)), listOf(row(2)), -3).isEmpty())
    }

    private fun row(ts: Long, name: String = "n$ts") =
        JSONObject().put("ts", ts).put("name", name)
}
