package ai.deepseek.harness.mobile.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 溢出策略的纯逻辑断言 —— 对应真机上「结果被截断后模型读不回来」的几类事故：
 *
 *  - 按**字符数**判定导致中文被低估：24000 字符的中文 ≈ 24000 tokens，代码只有 ≈ 7000 tokens
 *  - 只留头部导致**错误尾/最后几行**丢失（编译错误、测试失败摘要都在末尾）
 *  - 按 UTF-16 下标硬切，把 emoji 切成孤立代理项，回给模型的文本成乱码
 *  - `read` 的结果被截断 → 模型再读一次 → 又被截断：递归 spill，永远读不完
 *  - 落盘失败仍然回「完整内容见 xxx」，模型去读必然「文件不存在」
 */
class SpillPolicyTest {

    private val compactor = Compactor()

    private fun tempDir(tag: String): File = Files.createTempDirectory("dsh-$tag").toFile()

    private fun policy(
        spillDir: File? = tempDir("dsh-spill-policy"),
        workspaceRoot: File? = null,
        maxTokens: Int = SpillPolicy.DEFAULT_MAX_INLINE_TOKENS,
    ) = SpillPolicy(spillDir, workspaceRoot, maxTokens)

    /** 找孤立代理项：头部切在 emoji 中间时会出现 */
    private fun hasLoneSurrogate(text: String): Boolean {
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c.isHighSurrogate()) {
                if (i + 1 >= text.length || !text[i + 1].isLowSurrogate()) return true
                i += 2
                continue
            }
            if (c.isLowSurrogate()) return true
            i++
        }
        return false
    }

    @Test
    fun `短结果原样返回，不落盘`() {
        val p = policy()
        val rendered = p.render("bash", "hello world")
        assertFalse(rendered.spilled)
        assertNull(rendered.locator)
        assertEquals("hello world", rendered.text)
    }

    @Test
    fun `read 与 read_image 豁免，永不落盘`() {
        val p = policy()
        val huge = "x".repeat(200_000)
        assertFalse("read 的结果是模型要的原文，截它会导致递归 spill", p.needsSpill("read", huge))
        assertFalse(p.needsSpill("read_image", huge))
        assertEquals(huge, p.render("read", huge).text)
        assertTrue("bash 这类写结果仍要落盘", p.needsSpill("bash", huge))
    }

    @Test
    fun `长结果首尾各半并给出省略量与真实落点`() {
        val dir = tempDir("dsh-spill-ok")
        val p = policy(spillDir = dir)
        val text = "HEAD-MARKER\n" + "A".repeat(120_000) + "\nTAIL-MARKER"
        val rendered = p.render("bash", text)

        assertTrue("超预算必须落盘", rendered.spilled)
        val locator = rendered.locator
        assertTrue("落点必须真实存在", locator != null && File(locator).isFile)

        val out = rendered.text
        assertTrue("开头要保留", out.contains("HEAD-MARKER"))
        assertTrue("结尾要保留（错误尾/最后几行都在末尾）", out.contains("TAIL-MARKER"))
        assertTrue("要说明落点", out.contains("完整内容已落盘"))
        // 这里 workspaceRoot 没给（= 不知道工作区在哪），locator 落成绝对路径；
        // 提示语既要说清「工作区外」，也要给出**可执行**的读法（read 分页 / bash cat），
        // 否则模型下一步只能瞎猜。
        assertTrue("工作区外要如实说明：$out", out.contains("工作区之外"))
        assertTrue("工作区外也要给可执行读法：$out", out.contains("read(file_path=") && out.contains("cat "))
        assertTrue("省略量要带字节数：$out", Regex("省略 \\d+ 字符 / \\d+ 字节").containsMatchIn(out))
    }

    @Test
    fun `inline 预算按 token 计算且首尾合计不超预算`() {
        val p = policy(maxTokens = 12_500)
        val text = "汉".repeat(30_000)
        val plan = p.plan(text)
        assertTrue("头部不能为空", plan.head.isNotEmpty())
        assertTrue("尾部不能为空", plan.tail.isNotEmpty())
        assertTrue("要真的丢掉一段", plan.omittedChars > 0)
        val inline = compactor.estimate(plan.head) + compactor.estimate(plan.tail)
        assertTrue("inline 合计（$inline）不能超过预算 12500", inline <= 12_500)
        assertTrue("首尾应大致各半：head=${plan.head.length} tail=${plan.tail.length}",
            kotlin.math.abs(plan.head.length - plan.tail.length) <= 2)
    }

    @Test
    fun `切点不切开代理对`() {
        val p = policy(maxTokens = 12_500)
        // 每个 😀 = 2 个 char；奇数长度的预算切点最容易切在中间
        val text = "😀".repeat(40_000)
        val plan = p.plan(text)
        assertFalse("头部不能有孤立代理项", hasLoneSurrogate(plan.head))
        assertFalse("尾部不能有孤立代理项", hasLoneSurrogate(plan.tail))
        val rendered = p.render("bash", text)
        assertFalse("组装后的文本也不能有孤立代理项", hasLoneSurrogate(rendered.text))
        // 每段还必须是合法 UTF-8（换回字节再解一次，长度不变）
        val bytes = plan.head.toByteArray(Charsets.UTF_8)
        assertEquals(plan.head, String(bytes, Charsets.UTF_8))
    }

    @Test
    fun `落盘失败如实说没存下来，不给假路径`() {
        val blocker = File(tempDir("dsh-spill-blocked"), "not-a-dir").apply { writeText("x") }
        // 父路径是个普通文件：mkdirs/写盘必然失败
        val brokenDir = File(blocker, "session-x")
        val p = policy(spillDir = brokenDir)
        val rendered = p.render("bash", "Q".repeat(200_000))

        assertFalse(rendered.spilled)
        assertNull("失败时不能给 locator", rendered.locator)
        assertTrue(rendered.text.contains("(full result unavailable: storage error)"))
        assertFalse("不许谎称有文件", rendered.text.contains("完整内容已落盘"))
        assertTrue("仍然要有截断后的正文", rendered.text.length > 0)
    }

    @Test
    fun `工作区内的落点用相对路径，工作区外如实说明读法`() {
        val wsRoot = tempDir("dsh-spill-ws")
        val inside = File(wsRoot, "spill/s1").apply { mkdirs() }
        val pInside = SpillPolicy(inside, wsRoot)
        val rIn = pInside.render("bash", "z".repeat(200_000))
        assertTrue(rIn.spilled)
        assertFalse(
            "工作区内 locator 用工作区相对路径（平台无关判定）：${rIn.locator}",
            File(rIn.locator!!).isAbsolute,
        )
        assertTrue("工作区内要提示用 read 分页读", rIn.text.contains("read(file_path="))
        assertFalse("工作区内不该说「读不到」", rIn.text.contains("工作区之外"))

        val outside = tempDir("dsh-spill-outside")
        val pOutside = SpillPolicy(outside, wsRoot)
        val rOut = pOutside.render("bash", "z".repeat(200_000))
        assertTrue(rOut.spilled)
        // 平台无关：Windows 上是 C:\…，Android 上是 /data/…，都必须是绝对路径
        assertTrue("工作区外 locator 是绝对路径：${rOut.locator}", File(rOut.locator!!).isAbsolute)
        assertTrue("要如实说明标准权限 read 读不到", rOut.text.contains("工作区之外"))
        assertTrue("仍要给可执行读法", rOut.text.contains("read(file_path=") && rOut.text.contains("cat "))
    }

    @Test
    fun `会话目录名用哈希，不泄露会话 id`() {
        val a = SpillPolicy.sessionDirName("session-abc-123")
        val b = SpillPolicy.sessionDirName("session-abc-123")
        val c = SpillPolicy.sessionDirName("other")
        assertEquals(a, b)
        assertNotEquals(a, c)
        assertTrue(a.startsWith("session-"))
        assertEquals("session- + 8 位哈希", 8 + 8, a.length)
        assertFalse("会话 id 不能出现在路径里", a.contains("abc"))
        assertEquals(SpillPolicy.sessionDirName(null), SpillPolicy.sessionDirName(null))
    }

    @Test
    fun `30 天后清理过期落盘，保留新文件并跳过未知时间`() {
        val root = tempDir("dsh-spill-clean")
        val old = File(root, "session-old").apply { mkdirs(); File(this, "a.txt").writeText("a") }
        val freshness = File(root, "session-new").apply { mkdirs(); File(this, "b.txt").writeText("b") }
        val unknown = File(root, "session-unknown").apply { mkdirs(); File(this, "c.txt").writeText("c") }
        val now = System.currentTimeMillis()
        old.setLastModified(now - SpillPolicy.RETENTION_MS - 60_000)
        freshness.setLastModified(now - 1_000)
        unknown.setLastModified(0)

        val removed = SpillPolicy.cleanupOlderThan(root, now = now)
        assertEquals(1, removed)
        assertFalse(old.exists())
        assertTrue("新会话目录要留着", freshness.isDirectory)
        assertTrue("拿不到修改时间的目录不能盲删", unknown.isDirectory)
        assertEquals("不存在的目录返回 0", 0, SpillPolicy.cleanupOlderThan(File(root, "nope")))
    }
}
