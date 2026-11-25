package ai.deepseek.harness.mobile.kernel.device

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.MediaRecorder
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 内核工具与 Android 系统界面之间的「发起 → 等结果」桥。
 *
 * 工具在内核工作线程上执行，而相机拍照、SAF 选文件这类系统交互必须由
 * Activity 的 ActivityResultLauncher 发起并在主线程收结果。这里用一次性
 * 回调 + CountDownLatch 把异步的「用户在系统界面里操作」折叠成工具可等待
 * 的同步调用——工具线程原地等，用户拍完/选完/取消后继续。
 *
 * MainActivity 在 onCreate 里把两个 launcher 注入 [cameraLauncher] /
 * [safLauncher]；结果经 [onCameraResult] / [onSafResult] 回流。
 */
object UiIntents {

    /** 工具等待系统界面的总上限：给足用户在相机/选择器里犹豫的时间 */
    private const val AWAIT_MS = 5L * 60_000

    private val main = Handler(Looper.getMainLooper())

    /** MainActivity 注入；null = Activity 尚未创建（工具无从发起界面） */
    @Volatile var cameraLauncher: ((Intent) -> Unit)? = null
    @Volatile var safLauncher: ((Intent) -> Unit)? = null

    @Volatile private var cameraCb: ((Int) -> Unit)? = null
    @Volatile private var safCb: ((Int, Uri?) -> Unit)? = null

    /** 调用序号：超时/失败后残留的回调不能把结果投给下一次调用 */
    private val cameraSeq = java.util.concurrent.atomic.AtomicInteger()
    private val safSeq = java.util.concurrent.atomic.AtomicInteger()

    /** MainActivity 的 ActivityResult 回调入口（主线程） */
    fun onCameraResult(resultCode: Int) {
        cameraCb?.invoke(resultCode)
        cameraCb = null
    }

    fun onSafResult(resultCode: Int, uri: Uri?) {
        safCb?.invoke(resultCode, uri)
        safCb = null
    }

    /**
     * 发起系统相机拍照，照片写进 [out]（必须在工作区内，FileProvider 只暴露它）。
     * @return null = 成功；其它 = 用户可读的失败原因
     */
    fun awaitCamera(context: Context, out: File): String? {
        val launcher = cameraLauncher
            ?: return "界面还没就绪，稍后再试"
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", out)
        val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
            // 相机应用要拿到输出 Uri 的写权限：只给 EXTRA_OUTPUT 不给 grant 时，
            // 严格实现的相机（Pixel/AOSP）会打不开输出文件，用户拍完回来「没有照片」
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = android.content.ClipData.newRawUri("output", uri)
            // 相机应用若崩溃退出，不至于把整个 App 带走
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        if (intent.resolveActivity(context.packageManager) == null) return "系统里没有可用的相机应用"
        val token = cameraSeq.incrementAndGet()
        val latch = CountDownLatch(1)
        var code = Activity.RESULT_CANCELED
        var fail: String? = null
        cameraCb = { c ->
            // 只有本次调用的结果才算数（超时后用户才拍完的旧回调直接丢弃）
            if (token == cameraSeq.get()) {
                code = c
                latch.countDown()
            }
        }
        main.post {
            runCatching { launcher(intent) }.onFailure {
                fail = it.message ?: it.javaClass.simpleName
                latch.countDown()
            }
        }
        val got = latch.await(AWAIT_MS, TimeUnit.MILLISECONDS)
        if (token == cameraSeq.get()) cameraCb = null
        // 界面不可用（Activity 已销毁/后台受限）要如实说，不能伪装成「用户取消」
        fail?.let { return "打不开相机界面：$it（应用可能已退到后台，请切回后重试）" }
        if (!got) return "等拍照等了太久，已放弃"
        return if (code == Activity.RESULT_OK) {
            if (out.isFile && out.length() > 0) null else "相机没有留下照片"
        } else "已取消拍照"
    }

    /** 发起 SAF 文件选择；返回用户选中的 Uri，取消/失败返回 null */
    fun awaitPick(context: Context, mime: String): Uri? {
        val launcher = safLauncher ?: return null
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val token = safSeq.incrementAndGet()
        val latch = CountDownLatch(1)
        var picked: Uri? = null
        var ok = false
        safCb = { c, uri ->
            if (token == safSeq.get()) {
                ok = c == Activity.RESULT_OK
                picked = uri
                latch.countDown()
            }
        }
        main.post { runCatching { launcher(intent) }.onFailure { latch.countDown() } }
        latch.await(AWAIT_MS, TimeUnit.MILLISECONDS)
        if (token == safSeq.get()) safCb = null
        return if (ok) picked else null
    }

    /** 查询 SAF Uri 的显示名（查不到就退回时间戳名） */
    fun displayName(context: Context, uri: Uri): String {
        runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val n = c.getString(0)
                    if (!n.isNullOrBlank()) return n
                }
            }
        }
        return "import-${System.currentTimeMillis()}"
    }

    /* ---------------- 语音转写（复用系统 SpeechRecognizer，必须主线程创建） ---------------- */

    /**
     * 边录音边转写：MediaRecorder 存一份 [out]（可回放），SpeechRecognizer 出文本。
     * 系统识别引擎只支持实时收音、不支持从文件解码——这是 Android 平台限制，
     * 所以「转写」的语义是「说一段话，回来文本 + 录音文件」。
     * @return 识别出的文本（可能为空串 = 没听清）
     */
    fun transcribe(context: Context, durationMs: Long, out: File): String {
        val latch = CountDownLatch(1)
        val text = StringBuilder()
        var recorder: MediaRecorder? = null
        var recognizer: SpeechRecognizer? = null
        var stop = {}
        main.post {
            runCatching {
                // 1) 录音（存档用，识别与它并行，互不依赖）
                runCatching {
                    out.parentFile?.mkdirs()
                    val r = if (android.os.Build.VERSION.SDK_INT >= 31) MediaRecorder(context)
                    else @Suppress("DEPRECATION") MediaRecorder()
                    r.setAudioSource(MediaRecorder.AudioSource.MIC)
                    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                    r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    r.setAudioEncodingBitRate(64_000)
                    r.setAudioSamplingRate(44_100)
                    r.setOutputFile(out.absolutePath)
                    r.prepare()
                    r.start()
                    recorder = r
                }
                // 2) 实时识别（系统引擎；不在支持的设备上退化为只录音）
                if (SpeechRecognizer.isRecognitionAvailable(context)) {
                    val sr = SpeechRecognizer.createSpeechRecognizer(context)
                    recognizer = sr
                    sr.setRecognitionListener(object : RecognitionListener {
                        override fun onResults(results: android.os.Bundle?) {
                            results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                                ?.firstOrNull()?.let { text.append(it) }
                            latch.countDown()
                        }

                        override fun onError(error: Int) {
                            if (text.isEmpty()) {
                                text.append(
                                    when (error) {
                                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "(没听清)"
                                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "(缺麦克风权限)"
                                        else -> "(识别出错 $error)"
                                    }
                                )
                            }
                            latch.countDown()
                        }

                        override fun onPartialResults(partialResults: android.os.Bundle?) {
                            partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                                ?.firstOrNull()?.let { if (it.length > text.length) text.setLength(0); text.append(it) }
                        }

                        override fun onReadyForSpeech(params: android.os.Bundle?) {}
                        override fun onBeginningOfSpeech() {}
                        override fun onRmsChanged(rmsdB: Float) {}
                        override fun onBufferReceived(buffer: ByteArray?) {}
                        override fun onEndOfSpeech() {}
                        override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
                    })
                    sr.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
                    })
                } else {
                    latch.countDown() // 只等录音
                }
                stop = {
                    runCatching { recognizer?.stopListening() }
                    runCatching { recorder?.stop() }
                    latch.countDown()
                }
                main.postDelayed({ runCatching { stop() } }, durationMs)
            }.onFailure { latch.countDown() }
        }
        latch.await(durationMs + 5_000, TimeUnit.MILLISECONDS)
        runCatching { stop() }
        main.post {
            runCatching { recognizer?.destroy() }
            runCatching { recorder?.release() }
        }
        Thread.sleep(300) // 给主线程收尾留一点时间，避免 MediaRecorder 未 stop 就读文件
        return text.toString().trim()
    }
}
