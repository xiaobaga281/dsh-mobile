package ai.deepseek.harness.mobile.notify

import ai.deepseek.harness.mobile.AppPrefs

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import ai.deepseek.harness.mobile.MainActivity
import ai.deepseek.harness.mobile.R
import org.json.JSONObject

/**
 * 会话运行通知（系统通知方案）。
 *
 * 产品语义（只在需要的时候出声）：
 *  - 应用在前台：不打扰。运行态由界面自己显示，通知只是前台服务的静默载体
 *    （IMPORTANCE_MIN，会被系统收进「静默」折叠区，展开通知栏才看得到）。
 *  - 退到桌面 / 切走：通知变成可见的进度条，随时可以点「停止」。
 *  - 任务结束：若当时不在应用内，补一条「已完成」通知，点开回到该会话。
 *  - 需要你确认（审批 / 追问）：发一条提醒通知。
 *
 * 厂商胶囊说明：荣耀没有对三方 App 开放「调灵动胶囊」的运行时接口（官方路径是开发者平台
 * 申请场景 + 审核 + 白名单），所以这里不做任何厂商适配，也不自绘悬浮窗，统一走系统通知。
 */
class RunService : Service() {

    companion object {
        const val ACTION_START = "ai.dsh.run.START"
        const val ACTION_PROGRESS = "ai.dsh.run.PROGRESS"
        const val ACTION_END = "ai.dsh.run.END"
        const val ACTION_STOP = "ai.dsh.run.STOP"

        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"

        // 运行通知双渠道：前台用 MIN（静默折叠，只是前台服务的载体）；
        // 退到后台切到 LOW（通知栏正常位置可见，但不响铃不打扰）。渠道重要性创建后不可改，只能换渠道。
        private const val CHANNEL_RUN_SILENT = "dsh_run_silent"
        private const val CHANNEL_RUN_BG = "dsh_run_bg"
        private const val CHANNEL_DONE = "dsh_done"
        private const val CHANNEL_REMIND = "dsh_remind"
        private const val CHANNEL_REMIND_HIGH = "dsh_remind_high"
        /** 陪伴式畅聊的主动消息：独立渠道，用户能单独调它（像微信那样横幅弹出） */
        private const val CHANNEL_COMPANION = "dsh_companion_say"
        private const val NOTI_RUN = 20260
        private const val NOTI_DONE = 20261
        private const val NOTI_REMIND = 20262
        private const val NOTI_REMIND_HIGH = 20264
        private const val NOTI_ATTN = 20263
        private const val NOTI_COMPANION = 20265

        /**
         * 正在跑的会话（sessionId → 标题）。以前只有一个 boolean：任一回合结束就
         * stopForeground/stopSelf，多会话并行时会把仍在跑的会话一起撤掉通知和前台服务。
         */
        private val activeSessions = java.util.concurrent.ConcurrentHashMap<String, String>()
        val active: Boolean get() = activeSessions.isNotEmpty()
        fun activeCount(): Int = activeSessions.size

        private fun sessionKey(sessionId: String): String = sessionId.ifBlank { "default" }

        @Volatile
        private var instance: RunService? = null

        @Volatile
        private var appVisible = false

        @Volatile
        private var lastTitle = "会话运行中"

        /** 用户当前正在看的会话：应用可见且就在这个会话里，才不必再弹提醒 */
        @Volatile
        private var activeSession: String = ""

        /** 提醒去重：同一会话同一类提醒短时间内只响一次（前端与内核可能各发一次） */
        private val lastAttn = java.util.concurrent.ConcurrentHashMap<String, Long>()

        fun setActiveSession(sessionId: String) {
            activeSession = sessionId
            // 用户回到了那个会话，提醒已经没意义了。
            // 顺手清账本：通知都撤了，之后处理请求时不能再拿旧记录重发一条「幽灵提醒」。
            pendingAttn.clear()
            instance?.let { svc ->
                runCatching {
                    val nm = svc.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.cancel(NOTI_ATTN)
                }
            }
        }

        /** 应用当前是否在前台（内核用它决定「要不要用系统通知把人叫回来」） */
        fun isAppVisible(): Boolean = appVisible

        /** 应用前后台切换：前台撤掉「已完成」提醒；运行通知在静默/可见渠道间切换 */
        fun setAppVisible(ctx: Context, visible: Boolean) {
            appVisible = visible
            if (visible) {
                runCatching {
                    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.cancel(NOTI_DONE)
                }
            }
            instance?.let { it.appVisibleNow = visible; it.push() }
        }

        /** 会话开始：只记录标题，运行通知保持静默；真正提醒发生在结束后 */
        fun begin(context: Context, title: String, sessionId: String = "") {
            val key = sessionKey(sessionId)
            lastTitle = title.ifBlank { "会话运行中" }
            activeSessions[key] = lastTitle
            val i = Intent(context, RunService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_TITLE, lastTitle)
            try {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
            } catch (_: Exception) {
                activeSessions.remove(key)
            }
        }

        /** 进度：更新通知正文（节流由 JS 侧负责） */
        fun progress(context: Context, text: String, sessionId: String = "") {
            if (!active) return
            val svc = instance
            if (svc != null) {
                svc.applyProgress(text)
                return
            }
            try {
                val i = Intent(context, RunService::class.java)
                    .setAction(ACTION_PROGRESS)
                    .putExtra(EXTRA_TEXT, text)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
            } catch (_: Exception) {}
        }

        /**
         * 只撤保活、不发通知：后台任务结束时用。
         * 任务的完成提醒由 WakeRouter 那一条路负责（还会带「点开继续」），
         * 这里再 postDone 就是同一件事弹两条。
         */
        fun end(context: Context, sessionId: String = "") {
            val key = sessionKey(sessionId)
            activeSessions.remove(key)
            if (activeSessions.isNotEmpty()) {
                lastTitle = activeSessions.values.last()
                instance?.setTitle(lastTitle)
                return
            }
            instance?.finishNow()
        }

        /**
         * 会话结束。kind: done | fail | stopped
         *
         * 三个条件同时成立才发提醒：不在应用内、不是用户主动停止、**且用户没关掉这个开关**
         * （设置 → Agent → 完成后通知）。失败提醒不受开关约束 —— 它属于「待处理」，
         * 关掉完成提醒的人也不会希望任务悄悄挂掉。
         */
        fun finish(context: Context, kind: String, summary: String, sessionId: String = "") {
            val key = sessionKey(sessionId)
            val removedTitle = activeSessions.remove(key) ?: lastTitle
            if (activeSessions.isNotEmpty()) {
                // 还有别的会话在跑：只更新通知，不能 stopForeground/stopSelf。
                lastTitle = activeSessions.values.last()
                instance?.setTitle(lastTitle)
                return
            }
            val svc = instance
            svc?.finishNow()
            if (appVisible || kind == "stopped") return
            val wanted = kind == "fail" || AppPrefs.notifyDone(context)
            if (wanted) postDone(context, kind, summary, removedTitle)
        }

        /**
         * 需要用户处理（工具审批 / 追问 / 计划评审）：后台或「不在那个会话」时提醒。
         *
         * 之前的判定只有 `appVisible`：只要应用在前台就吞掉提醒 —— 于是「对话在后台跑、
         * 用户正在另一个会话里」这种情况永远收不到权限请求，等 90 秒超时被自动拒绝。
         * 现在按会话判定，并且与「任务完成」用两个通知 id，互不覆盖。
         */
        /**
         * 待用户处理的请求：requestKey -> (标题, 正文, 会话)。
         *
         * 通知 id 是固定的 [NOTI_ATTN]，`setAutoCancel(true)` 只覆盖「点通知」这一条路 ——
         * 用户在应用内点同意/拒绝/回答/批准计划之后，如果没有代码去 cancel，通知会一直挂着。
         * 这里按请求记账：处理完一条就把它的通知收掉；若还有别的请求在等，换成那一条显示。
         */
        private val pendingAttn =
            java.util.concurrent.ConcurrentHashMap<String, Triple<String, String, String>>()

        /** 按账本重画那条提醒：还有待处理就换成最新一条，没有就撤掉 */
        private fun repaint(context: Context) {
            runCatching {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val next = pendingAttn.entries.lastOrNull()
                if (next == null) {
                    nm.cancel(NOTI_ATTN)
                    return@runCatching
                }
                nm.notify(
                    NOTI_ATTN,
                    base(context, CHANNEL_DONE, next.value.first.ifBlank { "需要你的确认" },
                        next.value.second.take(120))
                        .setSubText("需要你的确认")
                        .setAutoCancel(true)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .build()
                )
            }
        }

        fun attention(
            context: Context,
            title: String,
            text: String,
            sessionId: String = "",
            requestKey: String = "",
        ) {
            // 应用可见 + 用户就在这个会话里，才不打扰
            if (appVisible && (sessionId.isBlank() || sessionId == activeSession)) return
            val key = "$sessionId|$title"
            val now = System.currentTimeMillis()
            val prev = lastAttn.put(key, now)
            if (prev != null && now - prev < 3000) return   // 前端与内核各报一次，只响一次
            if (requestKey.isNotBlank()) pendingAttn[requestKey] = Triple(title, text, sessionId)
            runCatching {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                ensureChannel(context, CHANNEL_DONE, "任务提醒", NotificationManager.IMPORTANCE_DEFAULT)
                nm.notify(
                    NOTI_ATTN,
                    base(context, CHANNEL_DONE, title.ifBlank { "需要你的确认" }, text.take(120))
                        .setSubText(if (title.isBlank()) "" else "需要你的确认")
                        .setAutoCancel(true)
                        .setOnlyAlertOnce(false)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .build()
                )
            }
        }

        /** 用户已经在应用内处理了某个请求：把它的通知收掉（还有别的就换成那一条）。 */
        fun resolveAttention(context: Context, requestKey: String) {
            if (requestKey.isBlank()) return
            pendingAttn.remove(requestKey)
            repaint(context)
        }

        /**
         * 一轮结束/被取消：该会话所有待处理请求都已经失效（驱动没了，没人再等答案），
         * 通知必须一起收掉 —— 否则用户点进去发现什么都没在等他。
         */
        fun clearSessionAttention(context: Context, sessionId: String) {
            val it = pendingAttn.entries.iterator()
            while (it.hasNext()) if (it.next().value.third == sessionId) it.remove()
            repaint(context)
        }

        /**
         * 陪伴式畅聊的主动消息（由 [ai.deepseek.harness.mobile.kernel.plugin.builtin.device.CompanionEngine]
         * 在原生侧生成）。
         *
         * 与「需要确认」不同：这是一条**对话消息**，走独立渠道（重要度高、允许横幅），
         * 点击直接进 App。应用可见时不弹 —— 前端会把这条消息渲染进会话，再弹一次反而重复。
         * 同一条消息只会用同一个通知 id 覆盖，避免连环说话把通知栏刷屏。
         *
         * @return 用户能不能看得见这条消息。`false` 只有一个原因：**通知权限/渠道被关**，
         *   系统把通知静默丢弃。以前这里整段 `runCatching` 吞掉，于是「它明明说话了，
         *   我却什么都没收到」既没提示也没日志 —— 用户只会以为功能坏了。
         *   调用方（引擎）据此把原因写进状态，设置面板直接显示。
         */
        fun companionSay(context: Context, text: String): Boolean {
            if (text.isBlank()) return true
            // 应用可见：前端会直接渲染进会话，不需要再弹（不算「发不出去」）
            if (appVisible) return true
            if (!notificationsOn(context)) return false
            val now = System.currentTimeMillis()
            val prev = lastAttn.put("companion", now)
            if (prev != null && now - prev < 2000) return true
            return runCatching {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                ensureChannel(context, CHANNEL_COMPANION, "陪伴消息", NotificationManager.IMPORTANCE_HIGH)
                nm.notify(
                    NOTI_COMPANION,
                    base(context, CHANNEL_COMPANION, "你的伙伴", text.take(120))
                        .setSubText("陪伴式畅聊")
                        .setAutoCancel(true)
                        .setOnlyAlertOnce(false)
                        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .build(),
                )
                true
            }.getOrElse { t ->
                android.util.Log.e("RunService", "陪伴消息通知失败：" + t.message, t)
                false
            }
        }

        /** 系统通知是否真的能送达（权限被拒 / 渠道被关都会导致 notify 静默丢弃） */
        fun notificationsOn(context: Context): Boolean = runCatching {
            NotificationManagerCompat.from(context).areNotificationsEnabled()
        }.getOrDefault(true)

        /**
         * Agent 主动提醒（notify 工具 / 定时任务到期的兜底通知）。
         * 与「需要确认」「已完成」分开：这两类会随应用回到前台自动撤掉，
         * 而主动提醒是用户明确要被叫一声的内容，前后台都发、不自动撤。
         */
        /**
         * Agent 主动提醒。
         * @param priority "high" 走 IMPORTANCE_HIGH 通道（会横幅弹出），其余走默认通道
         * @param silent 静音送达：只进通知栏，不出声不振动
         */
        fun remind(
            context: Context,
            title: String,
            text: String,
            priority: String = "default",
            silent: Boolean = false,
        ): Boolean = runCatching {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // 通知被系统关掉时 notify 不报错、直接丢弃 —— 明确回 false，让工具如实告知用户
            if (!nm.areNotificationsEnabled()) return@runCatching false
            val high = priority.equals("high", true) || priority == "urgent"
            val channel = if (high) CHANNEL_REMIND_HIGH else CHANNEL_REMIND
            ensureChannel(context, channel, if (high) "助手重要提醒" else "助手提醒",
                if (high) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT)
            val n = base(context, channel, title.ifBlank { "助手提醒" }, text.take(400))
                .setAutoCancel(true)
                .setPriority(if (high) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            if (silent) n.setSilent(true)
            // 每条提醒用独立 id：固定 id 会让「下载完成」「转码完成」互相覆盖，前面那条永远看不到
            val nid = (System.currentTimeMillis() % 100_000_000L).toInt() +
                if (high) NOTI_REMIND_HIGH else NOTI_REMIND
            nm.notify(nid, n.build())
            true
        }.getOrDefault(false)

        /** 真正发那条「已完成 / 执行失败」通知（开关判定在 [finish] 里） */
        private fun postDone(ctx: Context, kind: String, summary: String, title: String = lastTitle) {
            runCatching {
                val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                ensureChannel(ctx, CHANNEL_DONE, "任务完成提醒", NotificationManager.IMPORTANCE_DEFAULT)
                val head = if (kind == "fail") "执行失败 · " else "已完成 · "
                val body = summary.ifBlank { if (kind == "fail") "这一轮没有跑完，点开看原因" else "点开查看结果" }
                nm.notify(
                    NOTI_DONE,
                    base(ctx, CHANNEL_DONE, head + title, body.take(140))
                        .setAutoCancel(true)
                        .setOnlyAlertOnce(true)
                        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                        .build()
                )
            }
        }

        private fun largeIcon(ctx: Context): android.graphics.Bitmap? =
            BitmapFactory.decodeResource(ctx.resources, R.drawable.whale_large)

        private fun base(ctx: Context, channel: String, title: String, text: String): NotificationCompat.Builder {
            val open = PendingIntent.getActivity(
                ctx, 0,
                Intent(ctx, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            return NotificationCompat.Builder(ctx, channel)
                .setSmallIcon(R.drawable.ic_notify)
                .setLargeIcon(largeIcon(ctx))
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(open)
        }

        private fun ensureChannel(ctx: Context, id: String, name: String, importance: Int) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(id) != null) return
            nm.createNotificationChannel(
                NotificationChannel(id, name, importance).apply {
                    setShowBadge(false)
                    if (importance <= NotificationManager.IMPORTANCE_LOW) {
                        enableVibration(false)
                        setSound(null, null)
                    }
                }
            )
        }

        /** 给设置页用的状态快照 */
        fun info(ctx: Context): String = try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val runCh = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) nm.getNotificationChannel(CHANNEL_RUN_SILENT) else null
            val doneCh = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) nm.getNotificationChannel(CHANNEL_DONE) else null
            val batteryFree = runCatching {
                val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
                pm.isIgnoringBatteryOptimizations(ctx.packageName)
            }.getOrDefault(false)
            JSONObject().apply {
                put("ok", true)
                put("notificationsEnabled", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
                put("channelExists", runCh != null)
                put("channelImportance", runCh?.importance ?: -1)
                put("channelOn", runCh == null || runCh.importance != NotificationManager.IMPORTANCE_NONE)
                put("doneChannelOn", doneCh == null || doneCh.importance != NotificationManager.IMPORTANCE_NONE)
                put("running", active)
                put("appVisible", appVisible)
                put("battery", batteryFree)
                put("api", Build.VERSION.SDK_INT)
                put(
                    "note", when {
                        !NotificationManagerCompat.from(ctx).areNotificationsEnabled() ->
                            "通知权限被关闭：退到桌面后看不到进度，也收不到完成提醒。建议开启。"
                        doneCh != null && doneCh.importance == NotificationManager.IMPORTANCE_NONE ->
                            "「任务提醒」渠道被关闭：完成后不会提醒你。到通知设置里重新打开。"
                        else -> "在应用内不打扰；退到桌面后显示进度，任务结束或需要你确认时再提醒。"
                    }
                )
            }.toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "detect failed").toString()
        }

        /** 打开本应用的通知设置；能直达「任务提醒」渠道就直达 */
        fun openSettings(ctx: Context) {
            val channelPage = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_DONE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                ctx.packageManager.resolveActivity(channelPage, 0) != null
            ) {
                runCatching { ctx.startActivity(channelPage) }.onSuccess { return }
            }
            val appPage = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { ctx.startActivity(appPage) }
        }
    }

    private var title = "会话运行中"
    private var text = ""
    private var wake: PowerManager.WakeLock? = null
    private var wakeAt = 0L

    @Volatile
    private var appVisibleNow = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        appVisibleNow = appVisible
        startAsForeground()
        acquireWake()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 每次经 startForegroundService 投递都必须落到 startForeground，否则系统会判 ANR 杀进程
        startAsForeground()
        refreshWake()
        when (intent?.action) {
            ACTION_START -> {
                title = intent.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: "会话运行中"
                text = ""
                push()
            }
            ACTION_PROGRESS -> {
                intent.getStringExtra(EXTRA_TEXT)?.let { applyProgress(it) }
            }
            ACTION_STOP -> {
                // 通知里的「停止」：先让前端中断生成，再撤通知
                runCatching { MainActivity.notifyIslandStop() }
                finishNow()
            }
            ACTION_END -> finishNow()
        }
        return START_NOT_STICKY
    }

    private fun setTitle(t: String) {
        title = t
        push()
    }

    private fun applyProgress(t: String) {
        if (t.isBlank() || t == text) return
        text = t
        push()
        refreshWake()
    }

    private fun finishNow() {
        activeSessions.clear()
        // 这一轮结束/被停止：等待中的审批、追问、计划评审都不会再有人答，
        // 「需要你确认」的提醒必须一起撤 —— 只撤运行通知会把它孤零零留在通知栏。
        pendingAttn.clear()
        runCatching {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
        }
        runCatching {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTI_RUN)
            nm.cancel(NOTI_ATTN)
        }
        releaseWake()
        stopSelf()
    }

    override fun onDestroy() {
        releaseWake()
        if (instance === this) instance = null
        super.onDestroy()
    }

    /* ---------------- 通知 ---------------- */

    private fun acquireWake() {
        runCatching {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:agent-session").apply {
                setReferenceCounted(false)
                // 后台 bash 允许跑 6 小时；1 小时锁会让后半程失去唤醒。
                acquire(6 * 60 * 60 * 1000L)
            }
            wakeAt = System.currentTimeMillis()
        }
    }

    /** 进度/新回合时按需续期：锁龄超过 30 分钟就重拿，避免频繁 release/acquire */
    private fun refreshWake() {
        val w = wake
        if (w != null && w.isHeld && System.currentTimeMillis() - wakeAt < 30 * 60 * 1000L) return
        releaseWake()
        acquireWake()
    }

    private fun releaseWake() {
        runCatching { wake?.let { if (it.isHeld) it.release() } }
        wake = null
    }

    private fun build(): Notification {
        val ch = if (appVisibleNow) CHANNEL_RUN_SILENT else CHANNEL_RUN_BG
        ensureChannel(
            this, ch,
            if (appVisibleNow) "会话运行中（静默）" else "会话进度",
            if (appVisibleNow) NotificationManager.IMPORTANCE_MIN else NotificationManager.IMPORTANCE_LOW
        )
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, RunService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val body = text.ifBlank { "正在执行…" }
        val head = if (activeCount() > 1) "${activeCount()} 个会话运行中 · $title" else title
        return NotificationCompat.Builder(this, ch)
            .setSmallIcon(R.drawable.ic_notify)
            .setLargeIcon(largeIcon(this))
            .setContentTitle(head)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            // 应用在前台时只是静默载体；退到后台后这句才成为主要信息
            .setSubText(if (appVisibleNow) "应用内进行中" else "后台运行中 · 点停止可中断")
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setPriority(
                if (appVisibleNow) NotificationCompat.PRIORITY_MIN else NotificationCompat.PRIORITY_LOW
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            // 前台：静默折叠（不打扰）；后台：正常出现在通知列表（但不响铃，渠道已 LOW）
            .setSilent(appVisibleNow)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setContentIntent(open)
            .addAction(R.drawable.ic_noti_stop, "停止", stop)
            .setProgress(0, 0, true)   // 不确定进度：系统按「进行中」渲染
            .build()
    }

    private fun push() {
        runCatching {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTI_RUN, build())
        }
    }

    private fun startAsForeground() {
        val n = build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTI_RUN, n,
                if (Build.VERSION.SDK_INT >= 34)
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
            )
        } else {
            @Suppress("DEPRECATION") startForeground(NOTI_RUN, n)
        }
    }
}
