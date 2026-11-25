package ai.deepseek.harness.mobile

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 崩溃兜底：把「上次异常退出」留成可读的一行，而不是让用户只看到闪退。
 *
 * 为什么需要它：公开分发之后拿不到用户日志，任何一次崩溃都只能靠猜。
 * 这里只做三件小事：
 *  1. 挂一层 `UncaughtExceptionHandler`，落一行到私有目录的环形文件（上限 64KB），
 *     然后**交回原来的处理器** —— 不吞异常、不改系统行为，只为留证据；
 *  2. 渲染进程被杀（[noteEvent]）这类不抛异常的「静默死亡」也记一笔；
 *  3. 下次启动可以读 [lastCrashLine]，由界面决定是否提示（当前只在设置页的诊断入口用）。
 *
 * 不采集任何用户内容：只记时间、线程名、异常类型与首帧堆栈，不记消息正文、不记 key。
 */
object CrashGuard {
    private const val TAG = "DSHCrash"
    private const val FILE_NAME = "crash-ring.log"
    private const val MAX_BYTES = 64 * 1024

    @Volatile
    private var installed = false

    /** 装一次即可；重复调用无害。必须尽早调用（Application/Activity.onCreate 第一行）。 */
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val head = error.stackTrace.firstOrNull()
                    ?.let { "${it.className}.${it.methodName}:${it.lineNumber}" } ?: "-"
                append(app, "crash ${error.javaClass.simpleName} @${thread.name} $head")
            } catch (ignored: Throwable) {
                // 落盘失败也绝不能挡住原来的处理链（否则会变成「崩溃时卡死」）
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /** 记录一个「不是异常但同样致命」的事件（渲染进程被杀、OOM 回收等）。 */
    fun noteEvent(context: Context, what: String) {
        try {
            append(context.applicationContext, "event $what")
        } catch (ignored: Throwable) {
        }
    }

    /** 最近一条记录（没有就返回 null）。给诊断页用。 */
    fun lastCrashLine(context: Context): String? {
        val file = File(context.applicationContext.filesDir, FILE_NAME)
        if (!file.exists()) return null
        return runCatching { file.readLines().lastOrNull { it.isNotBlank() } }.getOrNull()
    }

    private fun append(context: Context, message: String) {
        val file = File(context.filesDir, FILE_NAME)
        val stamp = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date())
        synchronized(this) {
            if (file.length() > MAX_BYTES) {
                // 环形：超限就只留后半段，避免长期使用后诊断文件无限长
                val kept = runCatching { file.readLines().takeLast(200) }.getOrDefault(emptyList())
                file.writeText(kept.joinToString("\n") + "\n")
            }
            file.appendText("$stamp $message\n")
        }
        Log.w(TAG, message)
    }
}
