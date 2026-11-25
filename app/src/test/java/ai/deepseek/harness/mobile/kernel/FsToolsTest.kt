package ai.deepseek.harness.mobile.kernel

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 文件工具的分页 / 分组 / 收窄行为。
 *
 * 这些断言对应桌面 dsh-tool-fs 与 dsh-tool-fs-search 的实际契约：
 *  - read 默认 2000 行，并且告诉模型还剩多少（否则模型会以为读完了）
 *  - glob 只返回文件、按修改时间倒序（找「刚才那个文件」不用翻）
 *  - grep 按文件分组、可带前后文、可只要文件名
 */
class FsToolsTest {

    private fun workspace(): Pair<Workspace, File> {
        val root = Files.createTempDirectory("dsh-fs-test").toFile()
        return Workspace(root) to root
    }

    @Test
    fun `read pages a long file and reports the remainder`() {
        val (ws, root) = workspace()
        val f = File(root, "long.txt")
        f.writeText((1..2500).joinToString("\n") { "line$it" })
        val out = FsTools(ws).read("long.txt")
        assertTrue("默认应只读 2000 行", out.contains("line2000"))
        assertFalse("第 2001 行不该出现在第一页", out.contains("\nline2001"))
        assertTrue("必须提示剩余行数与 offset", out.contains("还有 500 行") && out.contains("offset=2001"))

        val second = FsTools(ws).read("long.txt", offset = 2001)
        assertTrue(second.contains("line2001") && second.contains("line2500"))
        assertFalse("最后一页不该再提示分页", second.contains("还有 0 行"))
    }

    @Test
    fun `glob returns files only sorted by modification time`() {
        val (ws, root) = workspace()
        val old = File(root, "old.kt").apply { writeText("old") }
        val fresh = File(root, "fresh.kt").apply { writeText("fresh") }
        old.setLastModified(1_000_000_000_000)
        fresh.setLastModified(1_700_000_000_000)
        File(root, "dir.kt").mkdirs()

        val out = FsTools(ws).glob("*.kt")
        assertTrue(out.contains("fresh.kt") && out.contains("old.kt"))
        assertFalse("目录不应出现在结果里", out.contains("dir.kt/"))
        assertTrue("最近的排前面", out.indexOf("fresh.kt") < out.indexOf("old.kt"))
        assertTrue("要给出总数", out.contains("共 2 个文件"))
    }

    @Test
    fun `grep groups by file and supports context and files_only`() {
        val (ws, root) = workspace()
        File(root, "a.kt").writeText("alpha\nneedle\ngamma\n")
        File(root, "b.kt").writeText("nothing\n")
        val fs = FsTools(ws)

        val grouped = fs.grep("needle")
        assertTrue(grouped.contains("a.kt"))
        assertFalse("没有命中的文件不该出现", grouped.contains("b.kt"))
        assertTrue("命中行要带行号", grouped.contains("2: needle"))

        val withCtx = fs.grep("needle", context = 1)
        assertTrue("前后文应一并给出", withCtx.contains("alpha") && withCtx.contains("gamma"))

        val names = fs.grep("needle", filesOnly = true)
        assertTrue(names.contains("a.kt"))
        assertFalse("files_only 不返回命中行内容", names.contains("2: needle"))
    }

    @Test(expected = KernelError::class)
    fun `read rejects an offset past the end`() {
        val (ws, root) = workspace()
        File(root, "short.txt").writeText("one\ntwo")
        FsTools(ws).read("short.txt", offset = 99)
    }

    /**
     * 小模型常把路径写成 /workspace/a.txt、/<工作区名>/a.txt 或完整绝对路径。
     * 这些不是真错误路径，按字面解析必然失败，模型还会拿同一个路径重试七八次。
     * 归一化只依赖「文件实际在哪」，不认死任何目录名 —— 换机型、改工作区名都成立。
     */
    @Test
    fun `absolute-looking paths resolve to real workspace files`() {
        val (ws, root) = workspace()
        File(root, "a.txt").writeText("hello")
        File(root, "sub").mkdirs()
        File(root, "sub/b.txt").writeText("world")
        val fs = FsTools(ws)

        assertTrue("虚拟前缀要剥掉", fs.read("/workspace/a.txt").contains("hello"))
        assertTrue("工作区名做前缀也成立", fs.read("/${root.name}/a.txt").contains("hello"))
        assertTrue("完整绝对路径要转相对", fs.read(root.absolutePath + "/sub/b.txt").contains("world"))
        assertTrue("深层相对路径保持不动", fs.read("/workspace/sub/b.txt").contains("world"))
    }

    @Test
    fun `write accepts a virtual prefix for new files`() {
        val (ws, root) = workspace()
        FsTools(ws).write("/workspace/new.txt", "x")
        assertTrue("新文件也要落在工作区根", File(root, "new.txt").exists())
    }
}
