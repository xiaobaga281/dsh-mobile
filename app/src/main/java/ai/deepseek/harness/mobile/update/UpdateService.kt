package ai.deepseek.harness.mobile.update

import ai.deepseek.harness.mobile.MainActivity
import ai.deepseek.harness.mobile.R
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.net.Uri
import android.provider.Settings
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File

/**
 * 更新包下载服务（前台服务）。
 *
 * 为什么必须是前台服务：用户在设置页点「立即更新」之后，十有八九会切走去看别的
 * （几百 MB 要好几分钟）。普通后台线程在内存压力下会被连同进程一起回收，
 * 下载就断在半截 —— 而且用户完全不知道发生了什么。前台服务把进程钉住，
 * 同时用通知栏的进度条给出可见反馈。
 *
 * 下载完成后**不自动 kill**：把通知换成「下载完成 · 点此安装」，contentIntent 直接指向
 * 系统安装器（PendingIntent 由系统在用户点击时执行，不受后台启动 Activity 的限制）。
 * 于是做到：App 在前台时前端自动拉起安装器；在后台时点通知一步进安装页。
 *
 * 真正的下载/校验逻辑在 [UpdateCenter]，这里只负责生命周期、通知与状态广播。
 */
class UpdateService : Service() {

    companion object {
        const val ACTION_START = "ai.dsh.update.START"
        const val ACTION_CANCEL = "ai.dsh.update.CANCEL"
        private const val NOTI = 20266
        private const val CHANNEL = "dsh_update"

        /** 启动下载。调用方保证已经拿到可用的 url/name */
        fun start(ctx: Context, url: String, name: String, size: Long) {
            val i = Intent(ctx, UpdateService::class.java).setAction(ACTION_START)
                .putExtra("url", url).putExtra("name", name).putExtra("size", size)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun cancel(ctx: Context) {
            runCatching {
                ctx.startService(Intent(ctx, UpdateService::class.java).setAction(ACTION_CANCEL))
            }
        }

        /** 装完之后把「下载完成」那条通知收掉（服务自己已经在 stopSelf 后结束） */
        fun clearNotification(ctx: Context) {
            runCatching {
                val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(NOTI)
            }
        }

        private fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL) != null) return
            val ch = NotificationChannel(CHANNEL, "应用更新", NotificationManager.IMPORTANCE_LOW)
            ch.description = "下载新版本安装包"
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
    }

    @Volatile private var cancelled = false
    private var worker: Thread? = null

    /** 已下载但还没装的包：点通知 / 回到前台都从这里装 */
    @Volatile private var readyFile: File? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val url = intent.getStringExtra("url").orEmpty()
                val name = intent.getStringExtra("name").orEmpty()
                val size = intent.getLongExtra("size", 0L)
                if (url.isBlank() || name.isBlank()) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                ensureChannel(this)
                startForeground(NOTI, progressNotification(0, "准备下载…"))
                begin(url, name, size)
            }
            ACTION_CANCEL -> {
                cancelled = true
                UpdateBus.push(JSONObject().put("state", "idle"))
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun begin(url: String, name: String, size: Long) {
        if (worker?.isAlive == true) return
        worker = Thread({
            val center = UpdateCenter(applicationContext)
            try {
                val f = center.download(url, name, size) { pct, src ->
                    if (cancelled) throw IllegalStateException("已取消")
                    notifyProgress(pct, center.sourceLabel(src))
                    UpdateBus.push(
                        JSONObject().put("state", "downloading").put("pct", pct)
                            .put("src", src).put("srcName", center.sourceLabel(src))
                    )
                }
                if (cancelled) return@Thread
                val bad = center.verifyApk(f)
                if (bad != null) {
                    runCatching { f.delete() }
                    finishWithError(bad)
                    return@Thread
                }
                readyFile = f
                // App 在前台：前端收到 ready 会自己拉起安装器；后台：通知点一下进安装页
                notifyDone(f)
                UpdateBus.push(JSONObject().put("state", "ready").put("size", f.length()))
            } catch (e: Throwable) {
                if (!cancelled) finishWithError(e.message ?: e.javaClass.simpleName)
            } finally {
                stopForegroundCompat()
            }
        }, "dsh-update-dl").apply { isDaemon = true }
        worker?.start()
    }

    /**
     * 下载完成的通知：点一下**直接进系统安装器**。
     * PendingIntent 的 Activity 启动发生在用户点击那一刻，属于前台交互，不受
     * Android 10+ 后台启动 Activity 的限制 —— 所以不用把用户先拉回 App 再跳一次。
     */
    private fun notifyDone(file: File) {
        // 与 UpdateCenter.install 同一道门禁：没开「安装未知应用」时直接给安装器
        // 的 PendingIntent 会被系统静默拦掉，用户点通知什么也不会发生。
        val canInstall = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            packageManager.canRequestPackageInstalls()
        val install: Intent? = if (!canInstall) {
            Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:$packageName"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        } else {
            runCatching {
                val uri = androidx.core.content.FileProvider.getUriForFile(
                    this, "$packageName.fileprovider", file
                )
                Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            }.getOrNull()
        }
        val pi = if (install != null) {
            PendingIntent.getActivity(this, 1, install, pendingFlags())
        } else {
            PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java), pendingFlags())
        }
        val n = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(if (canInstall) "下载完成" else "还差一步授权")
            .setContentText(
                if (canInstall) "点此安装新版本（覆盖安装会保留全部数据）"
                else "点此允许本应用安装应用，再回来点安装",
            )
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setOngoing(false)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setOnlyAlertOnce(false)
            .build()
        runCatching {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTI, n)
        }
    }

    private fun finishWithError(msg: String) {
        UpdateBus.push(JSONObject().put("state", "error").put("error", msg))
        runCatching {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(
                NOTI,
                NotificationCompat.Builder(this, CHANNEL)
                    .setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle("更新下载失败")
                    .setContentText(msg.take(80))
                    .setAutoCancel(true)
                    .build()
            )
        }
    }

    private fun notifyProgress(pct: Int, src: String) {
        runCatching {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTI, progressNotification(pct, if (src.isBlank()) "正在下载…" else "来自 $src"))
        }
    }

    private fun progressNotification(pct: Int, where: String): Notification {
        val open = PendingIntent.getActivity(this, 3, Intent(this, MainActivity::class.java), pendingFlags())
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("正在下载新版本 $pct%")
            .setContentText(where)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, pct.coerceIn(0, 100), pct <= 0)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun pendingFlags(): Int =
        if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT

    /** 后台下载中不要在结束后把整个服务杀掉：通知要留着给用户点 */
    private fun stopForegroundCompat() {
        runCatching {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_DETACH)
            else @Suppress("DEPRECATION") stopForeground(false)
        }
        // 服务本身可以退了：Activity 没了也不影响通知（PendingIntent 由系统持有）
        stopSelf()
    }

    override fun onDestroy() {
        cancelled = true
        super.onDestroy()
    }
}
