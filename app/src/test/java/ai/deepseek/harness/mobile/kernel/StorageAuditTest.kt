package ai.deepseek.harness.mobile.kernel

import ai.deepseek.harness.mobile.agent.SpillPolicy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Step 4a：工作区落点统一 + 存储可见。
 *
 * 守两条：
 *  - 溢出缓存有**字节**上限（只有 30 天龄期等于「一两周能写满就写满」），删的顺序是最旧会话先走；
 *  - 存储面板如实报告每一项占多少、上限是多少，而**唯一的清理动作只能碰可再生的溢出缓存**。
 */
class StorageAuditTest {

    private fun dir(tag: String): File = Files.createTempDirectory("dsh-" + tag).toFile()

    private fun write(f: File, text: String) {
        f.parentFile?.mkdirs()
        f.writeText(text)
    }

    private fun audit(root: File, config: File, files: File) = StorageAudit(
        Workspace(root), config, files,
        disk = { 12_000_000_000L to 64_000_000_000L },
    )

    /* ---------------- spill 字节预算 ---------------- */

    @Test
    fun `spill 超上限时最旧的会话目录先走`() {
        val root = dir("spill-budget")
        val old = File(root, "session-old"); write(File(old, "a.txt"), "x".repeat(4000))
        val newer = File(root, "session-new"); write(File(newer, "b.txt"), "y".repeat(4000))
        old.setLastModified(1_000L); newer.setLastModified(9_000L)

        val freed = SpillPolicy.trimToBudget(root, 6_000L)
        assertTrue("应释放一个目录的量：$freed", freed >= 4000)
        assertFalse("最旧的应被删掉", old.exists())
        assertTrue("最近的溢出还要读得回来", newer.exists())
    }

    @Test
    fun `未超上限时一个字都不动`() {
        val root = dir("spill-under")
        write(File(root, "session-a/a.txt"), "hello")
        assertEquals(0L, SpillPolicy.trimToBudget(root, SpillPolicy.MAX_BYTES))
        assertEquals("hello", File(root, "session-a/a.txt").readText())
    }

    @Test
    fun `目录体积统计对文件与缺失目录都算得对`() {
        val root = dir("dir-bytes")
        write(File(root, "a/b.txt"), "12345")
        write(File(root, "c.txt"), "123")
        assertEquals(8L, SpillPolicy.dirBytes(root))
        assertEquals(5L, SpillPolicy.dirBytes(File(root, "a")))
        assertEquals(0L, SpillPolicy.dirBytes(File(root, "nope")))
        assertEquals(0L, SpillPolicy.dirBytes(null))
    }

    /* ---------------- 存储清单 ---------------- */

    @Test
    fun `清单报告每一项的占用与上限`() {
        val ws = dir("audit-ws"); val cfg = dir("audit-cfg"); val files = dir("audit-files")
        write(File(ws, ".dsh/spill/session-h/x.txt"), "z".repeat(1000))
        write(File(ws, ".dsh/journal/journal.json"), "j".repeat(200))
        write(File(cfg, "sessions/s1.v2.jsonl"), "s".repeat(300))
        val stat = audit(ws, cfg, files).stat()
        val items = stat.optJSONArray("items")!!
        val byKey = HashMap<String, JSONObject>()
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i)!!
            byKey[it.optString("key")] = it
        }
        assertTrue("缺 spill 项", byKey.containsKey("spill"))
        assertEquals(1000L, byKey["spill"]!!.optLong("bytes"))
        assertEquals(SpillPolicy.MAX_BYTES, byKey["spill"]!!.optLong("cap"))
        assertTrue("spill 是唯一可清理项", byKey["spill"]!!.optBoolean("cleanable"))
        assertFalse("会话日志不能从这里删", byKey["sessions"]!!.optBoolean("cleanable"))
        assertEquals(300L, byKey["sessions"]!!.optLong("bytes"))
        assertEquals("12000000000", stat.optLong("free").toString())
        assertEquals(64_000_000_000L, stat.optLong("total"))
    }

    @Test
    fun `工作区外的路径以绝对形式显示`() {
        val ws = dir("audit-rel"); val cfg = dir("audit-rel-cfg"); val files = dir("audit-rel-f")
        val stat = audit(ws, cfg, files).stat()
        val items = stat.optJSONArray("items")!!
        var spillPath = ""; var sessionsPath = ""
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i)!!
            if (it.optString("key") == "spill") spillPath = it.optString("path")
            if (it.optString("key") == "sessions") sessionsPath = it.optString("path")
        }
        assertEquals(".dsh" + File.separator + "spill", spillPath)
        assertTrue("工作区外的条目要显示绝对路径，别伪装成相对路径", File(sessionsPath).isAbsolute)
    }

    @Test
    fun `清理只认可再生项，用户数据一律拒绝`() {
        val ws = dir("audit-clear"); val cfg = dir("audit-clear-c"); val files = dir("audit-clear-f")
        val a = audit(ws, cfg, files)
        write(File(ws, ".dsh/spill/session-h/x.txt"), "q".repeat(500))
        val r = a.clear("spill")
        assertTrue(r.optBoolean("ok"))
        assertEquals(500L, r.optLong("freed"))
        assertFalse("清完就真的空了", File(ws, ".dsh/spill/session-h").exists())
        // 用户数据永远拒绝
        assertFalse(a.clear("sessions").optBoolean("ok"))
        assertFalse(a.clear("workspace").optBoolean("ok"))
        assertFalse(a.clear("missions").optBoolean("ok"))
        assertTrue(a.clear("sessions").optString("error").isNotBlank())
        // 可再生的三项现在允许清（journal / build / voiceCache）
        assertTrue("改动存档可再生", a.clear("journal").optBoolean("ok"))
        assertTrue("构建产物可再生", a.clear("build").optBoolean("ok"))
    }

    @Test
    fun `会话日志超过阈值要提醒而不是自动删`() {
        val ws = dir("audit-warn"); val cfg = dir("audit-warn-c"); val files = dir("audit-warn-f")
        write(File(cfg, "sessions/s1.v2.jsonl"), "s".repeat(2_000))
        val a = StorageAudit(Workspace(ws), cfg, files, disk = { 0L to 0L }, sessionsWarnBytes = 1_000L)
        val items = a.stat().optJSONArray("items")!!
        var warn = ""
        var bytes = 0L
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i)!!
            if (it.optString("key") == "sessions") { warn = it.optString("warn"); bytes = it.optLong("bytes") }
        }
        assertTrue("超阈值要给提醒", warn.contains("建议"))
        assertEquals(2_000L, bytes)
        assertTrue("提醒不等于自动删历史", File(cfg, "sessions/s1.v2.jsonl").exists())
    }

    @Test
    fun `默认落点在工作区内而不是应用私有目录`() {
        // 生产不再注入 appSpillRoot：注入到私有目录会让产出物对 read 半隐藏
        assertEquals(null, ai.deepseek.harness.mobile.agent.ToolPipeline.appSpillRoot)
        assertEquals(".dsh/spill", ai.deepseek.harness.mobile.agent.ToolPipeline.SPILL_DIR)
    }
}
