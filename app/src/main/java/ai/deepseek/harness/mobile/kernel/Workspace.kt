package ai.deepseek.harness.mobile.kernel

import java.io.File
import java.io.IOException

/**
 * 工作区沙箱：所有文件工具都被限制在这里，越界一律拒绝。
 * 桌面内核的 ctx.workingDirectory + 权限根，在手机端等价于这个类。
 */
class Workspace(val root: File) {

    init {
        if (!root.exists()) root.mkdirs()
    }

    val rootPath: String get() = root.canonicalPath

    /**
     * 会话当前目录（相对 root，"." 表示根）—— 桌面 `ctx.workingDirectory` 的等价物。
     * working_directory 工具改它；已启动的 shell 会话仍保留各自进程的 cwd。
     */
    @Volatile var cwd: String = "."

    /** 当前目录对应的绝对目录（始终在 root 内） */
    fun baseDir(): File {
        val dir = if (cwd == "." || cwd.isBlank()) root else File(root, cwd)
        return if (dir.canonicalFile.path.startsWith(root.canonicalPath)) dir.canonicalFile else root.canonicalFile
    }

    /** 把模型给的相对/绝对路径解析成沙箱内路径；越界抛异常 */
    fun resolve(path: String, mustExist: Boolean = false): File {
        val raw = path.trim()
        if (raw.isEmpty()) throw KernelError("路径不能为空")
        val base0 = root.canonicalFile
        val candidate = when {
            raw.startsWith("/") -> File(root, raw.trimStart('/'))
            cwd != "." && cwd.isNotBlank() && !raw.startsWith("..") -> File(File(root, cwd), raw)
            else -> File(root, raw)
        }
        val canonical = candidate.canonicalFile
        val basePath = base0.path
        val target = canonical.path
        if (target != basePath && !target.startsWith("$basePath${File.separator}")) {
            throw KernelError("路径越界：$raw 不在工作区内")
        }
        // 报错带上真实根目录：模型才知道自己该写相对路径，而不是继续猜 /workspace
        if (mustExist && !canonical.exists()) {
            throw KernelError("文件不存在：$raw（工作区根：$basePath；请用相对根目录的路径，如 src/a.kt）")
        }
        return canonical
    }

    /** 相对工作区的展示路径 */
    fun relative(file: File): String {
        val base = root.canonicalPath
        val p = file.canonicalPath
        return if (p == base) "." else p.removePrefix("$base${File.separator}")
    }

    fun list(dir: File = root): List<File> =
        dir.listFiles()?.sortedBy { it.name.lowercase() } ?: emptyList()

    fun mkdirs(file: File) {
        if (!file.parentFile!!.exists()) {
            if (!file.parentFile!!.mkdirs()) throw KernelError("无法创建目录：${relative(file.parentFile!!)}")
        }
    }
}

/** 内核可预期错误（回给模型看，不当作崩溃） */
class KernelError(message: String) : IOException(message)
