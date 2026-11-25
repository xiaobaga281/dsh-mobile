package ai.deepseek.harness.mobile.kernel

import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 带超时与大小上限的 HTTP 下载。
 *
 * 原来 image/video 插件用 URL(url).openStream() 下载结果文件 —— 没有任何
 * connect/read 超时，网络卡住时整个工具调用无限挂起（video 还是 EXCLUSIVE
 * 模式，整轮对话直接卡死）。所有「下载生成结果」的插件统一走这里。
 */
object HttpDownload {

    /**
     * @param connectMs 连接超时
     * @param readMs 单次读超时
     * @param maxBytes 结果大小上限，超过即中断（防 OOM，默认 80MB）
     */
    fun toBytes(
        url: String,
        connectMs: Int = 15_000,
        readMs: Int = 60_000,
        maxBytes: Long = 80L * 1024 * 1024,
    ): ByteArray {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = connectMs
            conn.readTimeout = readMs
            conn.instanceFollowRedirects = true
            val cl = conn.contentLengthLong
            if (cl > maxBytes) throw KernelError("下载内容过大（${cl / 1024 / 1024}MB，上限 ${maxBytes / 1024 / 1024}MB）：$url")
            conn.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    total += n
                    if (total > maxBytes) throw KernelError("下载超过大小上限 ${maxBytes / 1024 / 1024}MB，已中断：$url")
                    out.write(buf, 0, n)
                }
                if (conn.responseCode !in 200..299) {
                    throw KernelError("下载失败 HTTP ${conn.responseCode}：$url")
                }
                return out.toByteArray()
            }
            throw KernelError("下载失败（空流）：$url")
        } finally {
            conn.disconnect()
        }
    }

    /** 下载并直接写文件（大文件不经过一次性 ByteArray，流式落盘）。 */
    fun toFile(
        url: String,
        target: File,
        connectMs: Int = 15_000,
        readMs: Int = 120_000,
        maxBytes: Long = 200L * 1024 * 1024,
    ): File {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = connectMs
            conn.readTimeout = readMs
            conn.instanceFollowRedirects = true
            if (conn.responseCode !in 200..299) {
                throw KernelError("下载失败 HTTP ${conn.responseCode}：$url")
            }
            val cl = conn.contentLengthLong
            if (cl > maxBytes) throw KernelError("下载内容过大（${cl / 1024 / 1024}MB，上限 ${maxBytes / 1024 / 1024}MB）：$url")
            target.parentFile?.mkdirs()
            var total = 0L
            conn.inputStream.use { input ->
                target.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        total += n
                        if (total > maxBytes) throw KernelError("下载超过大小上限 ${maxBytes / 1024 / 1024}MB，已中断：$url")
                        out.write(buf, 0, n)
                    }
                }
            }
            if (total < 1024) throw KernelError("下载到的文件异常（仅 $total 字节）：$url")
            return target
        } finally {
            conn.disconnect()
        }
    }
}
