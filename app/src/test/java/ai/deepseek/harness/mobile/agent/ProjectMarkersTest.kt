package ai.deepseek.harness.mobile.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import kotlin.io.path.absolutePathString

/**
 * 自动交付兜底的「工程内文件」排除判定（rc.117）。
 *
 * 背景：app_new 生成 Android 工程时 res/mipmap 各密度目录下的 ic_launcher.png
 * 五份图标被兜底捞成「5 个 png」交付卡（auto:true）——工程内的源/资源不该被
 * 当成交付物。
 */
class ProjectMarkersTest {

    private fun newDir(vararg path: String): java.io.File {
        var d = java.io.File(tempRoot, path.joinToString("/"))
        d.mkdirs()
        return d
    }

    private fun touch(dir: java.io.File, name: String): java.io.File {
        val f = java.io.File(dir, name)
        f.writeText("x")
        return f
    }

    private lateinit var tempRoot: java.io.File

    private fun withTemp(block: () -> Unit) {
        tempRoot = Files.createTempDirectory("dsh-pm").toFile()
        try {
            block()
        } finally {
            tempRoot.deleteRecursively()
        }
    }

    @Test
    fun `Android 工程里的密度图标不算交付物`() = withTemp {
        val proj = newDir("MyApp")
        touch(proj, "AndroidManifest.xml")
        val icon = touch(newDir("MyApp", "res", "mipmap-xhdpi"), "ic_launcher.png")
        assertTrue(ProjectMarkers.insideProject(tempRoot, icon))
    }

    @Test
    fun `工作区根下的独立图片仍是交付物`() = withTemp {
        val poster = touch(tempRoot, "poster.png")
        assertFalse(ProjectMarkers.insideProject(tempRoot, poster))
        // 无清单的普通子目录同理（用户让 agent 建个 design 文件夹放图很常见）
        val logo = touch(newDir("design"), "logo.png")
        assertFalse(ProjectMarkers.insideProject(tempRoot, logo))
    }

    @Test
    fun `嵌套工程（package json）同样排除`() = withTemp {
        val proj = newDir("apps", "demo")
        touch(proj, "package.json")
        val icon = touch(newDir("apps", "demo", "assets"), "icon.png")
        assertTrue(ProjectMarkers.insideProject(tempRoot, icon))
    }

    @Test
    fun `清单在工作区根也能拦住`() = withTemp {
        touch(tempRoot, "build.gradle")
        val icon = touch(newDir("res", "drawable"), "logo.png")
        assertTrue(ProjectMarkers.insideProject(tempRoot, icon))
    }

    @Test
    fun `gradle kts 也算清单`() = withTemp {
        val proj = newDir("app")
        touch(proj, "build.gradle.kts")
        val f = touch(proj, "screenshot.png")
        assertTrue(ProjectMarkers.insideProject(tempRoot, f))
    }
}
