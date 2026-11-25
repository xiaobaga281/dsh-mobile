package ai.deepseek.harness.mobile

import android.content.Context
import android.content.SharedPreferences

/**
 * 进程内唯一的 SharedPreferences（文件 `dsh`）。
 *
 * 为什么要有这一层：`SharedPreferences` 实例按 **Context + 文件名** 缓存，
 * 在 Activity 与 applicationContext 上分别 `getSharedPreferences` 会拿到
 * **互不同步**的两份内存 map —— 一边写入、另一边读到空（实测过：
 * 配对成功写进去 48 字符，换个域再读是空的）。所以全进程只认这里，
 * 且一律用 applicationContext。
 *
 * 为什么放在顶层包而不是 `bridge`：`bridge`（桥要读设置）与 `notify`
 * （服务要读同一份设置）都需要它，挂在任何一边都会让包依赖成环 ——
 * 这是两者共同的下层，不该属于某一个域。
 */
object AppPrefs {
    private const val FILE = "dsh"

    /** 「完成后通知」：设置页开关，决定系统通知栏要不要发「已完成」 */
    const val KEY_NOTIFY_DONE = "notify.done"

    @Volatile
    private var cached: SharedPreferences? = null

    fun get(context: Context): SharedPreferences {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            return context.applicationContext
                .getSharedPreferences(FILE, Context.MODE_PRIVATE)
                .also { cached = it }
        }
    }

    /**
     * 完成通知是否开启。默认 **true**：老用户升级上来行为不变（以前是必发）。
     *
     * 只约束「已完成」这一条；「执行失败」与「需要你确认」属于待处理事项，
     * 关掉这个开关也照发 —— 否则用户会以为任务还在跑。
     */
    fun notifyDone(context: Context): Boolean = get(context).getBoolean(KEY_NOTIFY_DONE, true)

    fun setNotifyDone(context: Context, on: Boolean) {
        get(context).edit().putBoolean(KEY_NOTIFY_DONE, on).apply()
    }
}
