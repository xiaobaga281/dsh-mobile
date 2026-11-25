package ai.deepseek.harness.mobile.kernel.schedule

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import ai.deepseek.harness.mobile.notify.RunService
import java.io.File

/**
 * 定时任务的「进程不在也能被叫醒」这一层。
 *
 * 为什么需要它：进程内 ScheduledThreadPool 只在进程活着时有效。应用被系统回收后，
 * 到期任务只能等用户下次打开 App 才补发 —— 那不是提醒，那是碰运气。
 *
 * 用的是什么、以及为什么只做到这一步（如实标注，不吹）：
 *   - `AlarmManager.setAndAllowWhileIdle(RTC_WAKEUP, ...)`：**不需要** `SCHEDULE_EXACT_ALARM`
 *     权限，能被 Doze 唤醒；代价是系统会限流（Doze 内大约 9 分钟一次），所以精度是
 *     **近似**，不是秒级准点。这是 Android 上"没有 exact alarm 权限时"的正确选择。
 *   - `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED`：闹钟在重启后会被系统清空，必须重新挂。
 *     这是唯一可靠的重启入口（`START_STICKY` 不覆盖重启）。
 *   - 闹钟响时若进程已被拉起但内核尚未装配（冷启动中），这里**不假装投递**：
 *     只发一条通知把用户叫回来；真正的补发由 `ScheduleRegistry.load()` 在进程启动时
 *     按「已过期就补一次」完成，那条路径会真正写进原会话。
 *
 * 仍然不保证的（必须让用户知道）：Doze 深睡、厂商省电策略（华为/荣耀/小米等）仍可能
 * 把唤醒推迟到几十分钟甚至下次充电。这不是代码缺陷，是平台边界。
 */
object ScheduleAlarm {

    const val ACTION_ALARM = "ai.dsh.schedule.ALARM"
    private const val REQUEST_CODE = 20301

    /** 与 ToolKernel.configDir 同一位置：filesDir/kernel/schedule.json */
    fun scheduleFile(context: Context): File = File(File(context.filesDir, "kernel"), "schedule.json")

    private fun alarmManager(context: Context): AlarmManager? =
        context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager

    private fun pendingIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            Intent(context, ScheduleAlarmReceiver::class.java).setAction(ACTION_ALARM),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** 读盘（不依赖进程内状态），找出最早的一条活动任务并挂一个唤醒闹钟 */
    fun armNext(context: Context) {
        val am = alarmManager(context) ?: return
        val pi = pendingIntent(context)
        runCatching { am.cancel(pi) }
        val next = runCatching {
            ScheduleStore(scheduleFile(context)).load().records
                .filter { it.active }
                .minByOrNull { it.scheduledAt }
        }.getOrNull() ?: return

        // 已经过期的任务：给 1 秒后触发，让进程启动时的 load() 去补发
        val at = maxOf(next.scheduledAt, System.currentTimeMillis() + 1000L)
        runCatching {
            // setAndAllowWhileIdle：无需权限、可穿透 Doze，但被系统限流（约 9 分钟一次）
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }.onFailure {
            // 个别厂商 ROM 会拒绝；此时退回非唤醒型闹钟，至少进程活着时能到点
            runCatching { am.set(AlarmManager.RTC, at, pi) }
        }
    }

    fun cancel(context: Context) {
        val am = alarmManager(context) ?: return
        runCatching { am.cancel(pendingIntent(context)) }
    }

    /**
     * 闹钟到点。
     *
     * 内核活着 → 什么都不做（进程内定时器会走完整的「写会话 + 改任务行」路径），
     * 只是把下一个闹钟挂上。
     * 内核不在 → 发通知把用户叫回来；打开 App 后 load() 会补发进原会话。
     */
    fun onAlarmFired(context: Context, now: Long = System.currentTimeMillis()) {
        armNext(context)   // 先挂下一个，避免投递过程中进程被杀导致再也不响
        val live = ScheduleRegistry.live()
        val overdue = runCatching {
            ScheduleStore(scheduleFile(context)).load().records.filter {
                it.active && it.scheduledAt <= now && !it.isDeliveredForCurrentTarget()
            }
        }.getOrDefault(emptyList())
        if (overdue.isEmpty()) return
        if (live != null) {
            // 内核在跑：它自己的定时器/补发会处理，避免双通道重复通知
            return
        }
        val first = overdue.minByOrNull { it.scheduledAt } ?: return
        val more = if (overdue.size > 1) "（另有 ${overdue.size - 1} 条）" else ""
        RunService.remind(
            context,
            "定时任务到点 · ${first.title}",
            "点开应用即送达原会话$more。手机端提醒可能因省电策略延后。",
            priority = "default",
        )
    }
}

/**
 * 开机 / 应用更新后重新武装闹钟。
 *
 * 注意：这里只做「重装闹钟」，不在广播里做投递 —— 广播接收器只有约 10 秒生命周期，
 * 在里面跑投递既不安全也不可靠。
 */
class ScheduleBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            -> ScheduleAlarm.armNext(context)
        }
    }
}

/** 闹钟到点 */
class ScheduleAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ScheduleAlarm.ACTION_ALARM) return
        runCatching { ScheduleAlarm.onAlarmFired(context) }
    }
}
