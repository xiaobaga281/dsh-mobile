package ai.deepseek.harness.mobile

import ai.deepseek.harness.mobile.kernel.ToolKernel
import java.io.File

/**
 * 内核的进程级单例。
 *
 * ## 为什么不是 Activity 的字段（这是实测出来的缺陷，不是洁癖）
 *
 * WebView 的**渲染进程**被系统回收时，[MainActivity.onRenderProcessGone] 走 `recreate()` 救界面。
 * 那时如果内核挂在 Activity 上，重建就等于连带把内核拆了：正在跑的 Lead 回合、整支团队、
 * 后台任务、等待中的定时唤醒全部凭空没了。实测（模拟器，杀 sandboxed 渲染进程）：
 * 成员正在流式输出、界面已有 104 字，重建后再进它的会话 —— 正文一个字都没有，Lead 的
 * `busy=false`、队友只剩 inactive。用户看到的样子就是「任务停了，但没人告诉过我」。
 * 桌面对照：harness 是常驻进程，渲染层怎么崩都不影响内核。
 *
 * ## 为什么跨 Activity 实例活着是安全的
 *
 * [ToolKernel] 只拿 `applicationContext` 与 App 私有目录（`files/workspace`），两者都不属于
 * 某个 Activity 实例；它也不反向持有界面。唯一与界面相关的出口是 `eventSink`，那是每个新的
 * [ai.deepseek.harness.mobile.bridge.NativeBridge] 在构造时重新挂上的（旧实例在 detach 时摘掉），
 * 后写者胜 —— 与 `UiIntents.cameraLauncher` 用的是同一条纪律。
 *
 * ## 仍然会丢的
 *
 * 进程真被杀（低内存 / 用户上滑清理）时一切照旧：内核与线程一起没，靠会话日志与唤醒队列
 * 在下次起来时对账。这一层不承诺跨**进程**恢复，只承诺跨界面重建。
 */
object KernelHost {

    @Volatile
    private var instance: ToolKernel? = null

    /** 第一次用到才装配（装内核要拉起插件注册表、工具目录、会话日志、钩子链） */
    fun of(appContext: android.content.Context?, workspaceDir: File): ToolKernel =
        instance ?: synchronized(this) {
            instance ?: ToolKernel(workspaceDir, appContext?.applicationContext).also { instance = it }
        }
}
