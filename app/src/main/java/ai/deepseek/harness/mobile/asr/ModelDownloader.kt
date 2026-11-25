package ai.deepseek.harness.mobile.asr

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 增强识别模型（SenseVoiceSmall int8，中英日韩粤）的按需下载。
 *
 * 为什么不在 APK 内置：单文件 int8 就 239MB，内置会让安装包翻两倍多，大部分用户用不上。
 * APK 里带的是 26MB 的中文流式小模型，够用即可；需要中英混说、多语种、更高准确率时再下这一份。
 *
 * 两个文件下完并校验尺寸才算装好，中途失败不会污染已装状态。
 */
object ModelDownloader {

    private const val TAG = "DSHAsrModel"
    private const val BASE =
        "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/"

    /** 本地文件名 → 仓库文件名 */
    private val FILES = linkedMapOf(
        "model.int8.onnx" to "model.int8.onnx",
        "tokens.txt" to "tokens.txt",
    )

    private const val MODEL_BYTES = 239_233_841L
    private const val TOKENS_BYTES = 315_894L
    private const val TOTAL_BYTES = MODEL_BYTES + TOKENS_BYTES

    val dirName = "asr-pro"

    fun dir(ctx: Context): File = File(ctx.filesDir, dirName)

    fun installed(ctx: Context): Boolean {
        val d = dir(ctx)
        // 尺寸也校验：下到一半的残缺 onnx 也能过 exists()，读起来会直接崩在 JNI 里
        return d.resolve("model.int8.onnx").length() >= MODEL_BYTES * 99 / 100 &&
            d.resolve("tokens.txt").exists()
    }

    fun status(ctx: Context): String {
        val d = dir(ctx)
        val used = if (d.exists()) d.listFiles()?.sumOf { it.length() } ?: 0L else 0L
        return JSONObject()
            .put("installed", installed(ctx))
            .put("bytes", used)
            .put("total", TOTAL_BYTES)
            .toString()
    }

    fun remove(ctx: Context): Boolean {
        val d = dir(ctx)
        val ok = !d.exists() || d.deleteRecursively()
        Log.i(TAG, "removed=$ok")
        return ok
    }

    /**
     * 清理上次下载中断留下的 .part 残片。
     * 模型存在 filesDir 下：应用卸载时系统会连同整个私有目录删掉，不会留在设备上；
     * 这里只处理"下载到一半退出"的情况，避免占用几十上百 MB。
     */
    fun cleanupPartials(ctx: Context) {
        val d = dir(ctx)
        if (!d.exists()) return
        d.listFiles()?.forEach { f ->
            if (f.name.endsWith(".part")) {
                val ok = f.delete()
                Log.i(TAG, "clean partial ${f.name}: $ok")
            }
        }
    }

    /**
     * 下载并解包。回调 (已下载字节, 总字节, 错误)。
     * 在后台线程执行，调用方负责切回 UI。
     */
    fun download(ctx: Context, onProgress: (Long, Long, String?) -> Unit): Boolean {
        val d = dir(ctx)
        d.mkdirs()
        var done = 0L
        for ((local, remote) in FILES) {
            val out = File(d, "$local.part")
            try {
                downloadOne(BASE + remote, out) { read ->
                    onProgress(done + read, TOTAL_BYTES, null)
                }
                val target = File(d, local)
                if (target.exists()) target.delete()
                if (!out.renameTo(target)) {
                    out.copyTo(target, overwrite = true)
                    out.delete()
                }
                done += target.length()
                onProgress(done, TOTAL_BYTES, null)
            } catch (t: Throwable) {
                Log.e(TAG, "download failed: $local", t)
                out.delete()
                onProgress(done, TOTAL_BYTES, "下载中断：${t.message ?: "网络错误"}")
                return false
            }
        }
        if (!installed(ctx)) {
            onProgress(done, TOTAL_BYTES, "文件不完整，请重试")
            return false
        }
        onProgress(TOTAL_BYTES, TOTAL_BYTES, null)
        return true
    }

    private fun downloadOne(url: String, out: File, onRead: (Long) -> Unit) {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "dsh-mobile")
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            conn.inputStream.use { input ->
                out.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    var read = 0L
                    var lastTick = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        output.write(buf, 0, n)
                        read += n
                        val now = System.currentTimeMillis()
                        if (now - lastTick > 220) {
                            lastTick = now
                            onRead(read)
                        }
                    }
                    onRead(read)
                }
            }
        } finally {
            conn.disconnect()
        }
    }
}
