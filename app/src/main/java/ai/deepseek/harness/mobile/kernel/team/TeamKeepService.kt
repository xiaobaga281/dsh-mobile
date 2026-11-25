package ai.deepseek.harness.mobile.kernel.team

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import ai.deepseek.harness.mobile.MainActivity
import ai.deepseek.harness.mobile.R
import androidx.core.app.NotificationCompat

/**
 * 团队保活（agent-team 插件的基础设施，不是业务）。
 *
 * 为什么手机端必须有自己的前台服务：
 *   桌面版把 teammate 跑在同一个进程里，窗口最小化也照跑；Android 不是 ——
 *   用户切走几十秒后进程就进 cached 状态，后台线程被冻结，teammate 的 LLM 请求
 *   停在半路，roster 里永远显示 running。之前「等队友等不到」的根因就在这里。
 *
 * 服务只做两件事：
 *   1. 用一条低优先级常驻通知把进程顶到 foreground 优先级
 *   2. 把「谁在跑」写进通知，用户退出 App 也知道团队还在干活
 *
 * 启动时机很关键：Android 12+ 禁止后台启动前台服务，所以只在 spawn（用户刚发完
 * 指令、App 一定在前台）时 ensure 一次，之后只 notify 更新文案；全员 idle 就 stop。
 * 启动失败不抛：降级成「应用内跑」，并在成员诊断里留一句实话。
 */
class TeamKeepService : Service() {

    companion object {
        private const val ACTION_START = "ai.dsh.team.KEEP_START"
        private const val CHANNEL = "dsh_team_keep"
        private const val NOTI = 20280

        @Volatile private var instance: TeamKeepService? = null

        @Volatile private var lastText: String = ""

        fun isRunning(): Boolean = instance != null

        /**
         * 按当前团队状态同步：有人在跑 → 起服务 / 更新文案；没人跑 → 撤服务。
         * 任何一步失败都安静降级（保活是增强，不是功能本身）。
         */
        fun sync(context: Context?, running: Int, text: String) {
            if (context == null) return
            lastText = text
            if (running <= 0) {
                if (instance != null) {
                    val app = context.applicationContext
                    android.os.Handler(android.os.Looper.getMainLooper()).post {
                        runCatching { app.stopService(Intent(app, TeamKeepService::class.java)) }
                    }
                }
                return
            }
            val app = context.applicationContext
            val i = Intent(app, TeamKeepService::class.java).setAction(ACTION_START)
            // 生命周期调用一律回主线程：spawn/sync 来自团队工作线程，
            // startForegroundService 在非主线程偶尔会撞上 "Calling startForegroundService() from non-main thread"
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                try {
                    if (instance == null) {
                        if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i) else app.startService(i)
                    } else {
                        instance?.refresh()
                    }
                } catch (_: Throwable) {
                    // 后台启动受限 / 通知权限被关：不抛，团队仍在应用内跑
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        startAsForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        return START_STICKY
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun refresh() {
        runCatching {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTI, build(lastText.ifBlank { "队友在后台继续工作" }))
        }
    }

    private fun build(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("团队运行中")
            .setContentText(text)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setOngoing(true)
            .build()
    }

    private fun startAsForeground() {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (nm.getNotificationChannel(CHANNEL) == null) {
                    nm.createNotificationChannel(
                        NotificationChannel(CHANNEL, "团队运行", NotificationManager.IMPORTANCE_LOW).apply {
                            setShowBadge(false)
                            enableVibration(false)
                            setSound(null, null)
                        }
                    )
                }
            }
            val n = build(lastText.ifBlank { "队友在后台继续工作" })
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTI, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTI, n)
            }
        }
    }
}
