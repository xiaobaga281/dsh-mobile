package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import ai.deepseek.harness.mobile.MainActivity
import ai.deepseek.harness.mobile.R

/**
 * 陪伴式畅聊的前台保活（companion 插件的基础设施）。
 *
 * 主动触发性以前有个致命缺口：心跳挂在插件自己的 Handler 上，应用一旦退到后台，
 * 进程被冻结 / 杀掉，心跳就停了 —— 表现是「开了跟没开一样」。前台服务把进程
 * 顶到 foreground 优先级，插件的心跳在后台照常走；再配一条 allow-idle 闹钟，
 * 深睡（Doze）期间也能按节奏醒来看一眼表。
 *
 * 服务本身**不做任何业务**：不判断节奏、不生成内容、不碰模型 —— 那些都在
 * CompanionPlugin 里。它只负责两件事：让进程活着，和 Doze 期间到点叫一声
 * [onPoke]（由插件挂上自己的 beat）。
 *
 * 通知是一条 IMPORTANCE_DEFAULT 的常驻提醒（会响铃/振动），关掉陪伴开关即撤；
 * 插件卸载时同样撤。通道 ID 带 `_v2`：Android 不允许修改**已创建**通道的重要性，
 * 旧版建过的 MIN 静默通道改不动，只能换新 ID，升级用户才拿得到有声的通知。
 */
class CompanionKeepService : Service() {

    companion object {
        private const val ACTION_START = "ai.dsh.companion.KEEP_START"
        private const val ACTION_POKE = "ai.dsh.companion.KEEP_POKE"
        private const val CHANNEL_KEEP = "dsh_companion_keep_v2"
        private const val NOTI_KEEP = 20270
        private const val REQUEST_POKE = 20271

        /** Doze 兜底轮询间隔。窗口最小 10 分钟，10 分钟的查看粒度不会漏拍。 */
        private const val POKE_INTERVAL_MS = 10 * 60 * 1000L

        @Volatile
        private var instance: CompanionKeepService? = null

        /**
         * 心跳间隔：一分钟看一次表。真正开口由 CompanionEngine 按档位窗口与线索决定，
         * 这里只是「叫它看一眼」，不消耗机会。
         */
        private const val TICK_MS = 60_000L

        fun running(): Boolean = instance != null

        /**
         * 陪伴开启时调用；已在前台保活就什么都不做。
         *
         * 失败**不再静默**：以前这里 `catch (_: Exception) {}`，把「服务根本没起来」
         * 吞得干干净净 —— 结果就是清单里类名写错（少了 `.device`）也没人发现，
         * 保活从来没生效，用户只看到「开最强档一次都不主动」。现在失败会：
         *   ① 打 logcat；② 记进 [lastError]，状态页与设置面板都能看到。
         */
        @Volatile
        var lastError: String? = null
            private set

        fun ensure(context: Context) {
            if (instance != null) { lastError = null; return }
            val i = Intent(context, CompanionKeepService::class.java).setAction(ACTION_START)
            try {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
                lastError = null
            } catch (t: Throwable) {
                // 通知权限被关 / 后台启动受限 / 组件未在清单里注册：保活缺席，但不能装作没事
                lastError = (t.javaClass.simpleName + ": " + (t.message ?: "")).take(160)
                android.util.Log.e("CompanionKeep", "保活服务启动失败：$lastError", t)
            }
        }

        /** 关闭陪伴 / 插件卸载时调用：撤通知、撤闹钟 */
        fun stop(context: Context) {
            try { context.stopService(Intent(context, CompanionKeepService::class.java)) } catch (_: Exception) {}
        }
    }

    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    private var tickOn = false

    override fun onCreate() {
        super.onCreate()
        instance = this
        startAsForeground()
        schedulePoke()
        // 服务一起来先补一拍：进程被系统回收再拉起时，可能已经错过好几个窗口
        CompanionEngine.tick(this, "start")
        startTick()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForegroundService 投递必须落到 startForeground，否则系统判 ANR
        startAsForeground()
        when (intent?.action) {
            ACTION_POKE -> {
                // Doze 期间 Handler 可能被冻住，闹钟是唯一能醒来的入口。
                // 设备重启不会自动拉起（manifest 无 BOOT_COMPLETED / 无 receiver），
                // 这是当前已知限制，不要在文案里承诺「重启后兜底」。
                CompanionEngine.tick(this, "poke")
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        tickOn = false
        main.removeCallbacksAndMessages(null)
        cancelPoke()
        if (instance === this) instance = null
        super.onDestroy()
    }

    /* ---------------- 心跳驱动 ---------------- */

    private fun startTick() {
        if (tickOn) return
        tickOn = true
        val step = object : Runnable {
            override fun run() {
                if (!tickOn) return
                CompanionEngine.tick(this@CompanionKeepService, "loop")
                main.postDelayed(this, TICK_MS)
            }
        }
        main.postDelayed(step, TICK_MS)
    }

    /* ---------------- Doze 兜底闹钟 ---------------- */

    private fun pokeIntent(): PendingIntent = PendingIntent.getService(
        this, REQUEST_POKE,
        Intent(this, CompanionKeepService::class.java).setAction(ACTION_POKE),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun schedulePoke() {
        val am = getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        // setInexactRepeating：不保证准点；Doze 下会被系统合并/推迟到维护窗口，
        // 对陪伴节奏（窗口 ≥10 分钟）够用，也不需要 SCHEDULE_EXACT_ALARM 授权。
        // 这是**取舍**不是待办：要更准得换 setAndAllowWhileIdle 单次自续并自己处理重启续订，
        // 换来的是多一份精确闹钟授权与更难验证的边界，陪伴场景不值得。
        runCatching {
            am.setInexactRepeating(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                android.os.SystemClock.elapsedRealtime() + POKE_INTERVAL_MS,
                POKE_INTERVAL_MS,
                pokeIntent(),
            )
        }
    }

    private fun cancelPoke() {
        val am = getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        runCatching { am.cancel(pokeIntent()) }
    }

    /* ---------------- 常驻通知（静默载体） ---------------- */

    private fun startAsForeground() {
        // 这里以前整段 runCatching 吞掉：startForeground 一旦失败（Android 14+ 的
        // FGS 类型/权限不对、通知渠道被禁用），服务不是前台 → 系统几秒内就把它掐掉，
        // 表现和「清单类名写错」一模一样：保活看似开了，其实一拍都没跑。失败必须留痕。
        val r = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (nm.getNotificationChannel(CHANNEL_KEEP) == null) {
                    nm.createNotificationChannel(
                        NotificationChannel(CHANNEL_KEEP, "陪伴守护", NotificationManager.IMPORTANCE_DEFAULT).apply {
                            setShowBadge(false)
                            // 不再 enableVibration(false) / setSound(null)：这是「陪伴」常驻的载体，
                            // 用户明确要能听到它，默认通道音即可。
                        }
                    )
                }
            }
            val open = PendingIntent.getActivity(
                this, 0,
                Intent(this, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val n: Notification = NotificationCompat.Builder(this, CHANNEL_KEEP)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("陪伴已开启")
                .setContentText("到点它会主动开口，陪你聊两句")
                .setContentIntent(open)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                // 常驻通知会随「在跑名单」更新：onlyAlertOnce 只在首次出现时响，更新不反复打扰。
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .build()
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTI_KEEP, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTI_KEEP, n)
            }
        }
        r.exceptionOrNull()?.let { t ->
            lastError = ("前台常驻失败：" + t.javaClass.simpleName + ": " + (t.message ?: "")).take(160)
            android.util.Log.e("CompanionKeep", "startForeground 失败：$lastError", t)
        }
        if (r.isSuccess) lastError = null
    }
}
