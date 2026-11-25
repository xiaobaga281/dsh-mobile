package ai.deepseek.harness.mobile.kernel.plugin.builtin.app

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.Workspace
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * 装 App：把工作区里的 .apk 交给系统安装器（PackageInstaller 会话），并等真实结果。
 *
 * 为什么不用 `Intent.ACTION_VIEW`：那条路只会「弹个界面然后失联」，装没装、为什么失败
 * 全靠用户自己看；而 PackageInstaller 会回传 STATUS_PENDING_USER_ACTION / SUCCESS / FAILURE，
 * 我们能把「等待确认 / 已安装 / 失败原因」如实回给模型。
 *
 * 权限：targetSdk 28 只需清单里的 REQUEST_INSTALL_PACKAGES，外加系统里给本应用打开
 * 「安装未知应用」。没有这项开关时 commit 会失败，这里会把原因翻译成人话。
 */
class AppInstallPlugin : KernelPlugin {
    override val id = "app-install"
    override val name = "装应用"
    override val description = "把工作区里的 APK 交给系统安装器安装，并回传安装结果"
    override val version = "1.0.0"

    private var app: Context? = null
    private var ws: Workspace? = null
    private var sandbox: WorkspaceSandbox? = null
    private var installs = 0

    override fun onLoad(ctx: PluginContext) {
        app = ctx.service("app.context") as? Context
        ws = ctx.workspace
        sandbox = ctx.sandbox
    }

    override fun onUnload() {
        pending.clear()
        app = null
        ws = null
        sandbox = null
    }

    override fun status(): Map<String, String> = mapOf(
        "安装次数" to installs.toString(),
        "系统开关" to when {
            app == null -> "未就绪"
            canInstall() -> "已允许安装未知应用"
            else -> "未允许（系统设置 → 安装未知应用）"
        },
    )

    private val c: Context get() = app ?: throw KernelError("装应用插件未就绪（应用上下文缺失）")

    private fun canInstall(): Boolean =
        c.packageManager.canRequestPackageInstalls()

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "app_install",
            description = "安装工作区里的 Android 安装包（.apk）。会调起系统安装器，用户确认后安装，" +
                "本工具等待并回传结果（成功/失败原因）。**装 APK 就用这个**——" +
                "手机没有 root，`pm install` / `adb install` 一律会失败，不要先去试它们。",
            parameters = Schemas.params(
                mapOf(
                    "description" to Schemas.prop("string", "一句话说明装的是什么（5-10 个字）"),
                    "file" to Schemas.prop("string", "工作区内的 .apk 相对路径"),
                    "timeoutMs" to Schemas.prop("number", "等待用户确认的毫秒数，默认 180000"),
                ),
                listOf("description", "file"),
            ),
        ) { a ->
            installs++
            val sb = sandbox ?: throw KernelError("沙箱未装配")
            val apk = sb.resolveRead(a.pick("file", "path"), mustExist = true)
            if (!apk.name.endsWith(".apk", ignoreCase = true)) {
                throw KernelError("要装的是 APK 文件，当前给的是 ${apk.name}")
            }
            if (!canInstall()) {
                throw KernelError(
                    "系统还没允许本应用安装应用：请在「设置 → 应用 → 特殊权限 → 安装未知应用」里" +
                        "给 DSH Mobile 打开开关，然后再试一次。"
                )
            }
            val timeout = a.optLong("timeoutMs", 180_000L).coerceIn(15_000L, 900_000L)
            val res = commit(apk, c.packageManager, timeout)
            if (!res.ok) throw KernelError(res.message)
            res.message
        },
    )

    private data class Outcome(val ok: Boolean, val message: String)

    /**
     * 提交安装会话并等结果（用户确认在系统弹窗里完成）。
     *
     * 超时**不能 abandonSession**：弹窗还在屏幕上，一废弃会话，用户随后点「安装」就立刻失败
     * （实测：模型连续三次 120s 超时，随后人工点确认反而装不上）。现在超时只放弃"等待"，
     * 会话与 pending 都留着 —— 用户什么时候点，安装就什么时候完成，结果走 onResult 记日志。
     */
    private fun commit(apk: File, pm: PackageManager, timeoutMs: Long): Outcome {
        val installer = pm.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setSize(apk.length())
        val sessionId = installer.createSession(params)
        val waiter = CompletableFuture<Outcome>()
        pending[sessionId] = waiter
        var keepPending = false
        try {
            installer.openSession(sessionId).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("base.apk", 0, apk.length()).use { out ->
                        input.copyTo(out, 64 * 1024)
                        session.fsync(out)
                    }
                }
                val intent = Intent(c, InstallReceiver::class.java).apply {
                    putExtra(EXTRA_SESSION, sessionId)
                    setPackage(c.packageName)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                val pi = PendingIntent.getBroadcast(c, sessionId, intent, flags)
                session.commit(pi.intentSender)
            }
            return waiter.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: java.util.concurrent.TimeoutException) {
            keepPending = true
            return Outcome(
                false,
                "等待确认超时（${timeoutMs / 1000}s）：系统安装弹窗还开着，在等用户点「安装」。\n" +
                    "**不要立刻重试**——会话仍然有效，用户点了就会装好。稍后用 bash 执行 " +
                    "`pm list packages <包名>` 确认，或问用户是否已经点过确认。",
            )
        } catch (t: Throwable) {
            return Outcome(false, "安装失败：${t.message ?: t.javaClass.simpleName}")
        } finally {
            // 超时保留 pending：用户之后确认时 onResult 还能接住（completer 已完成则空操作）
            if (!keepPending) pending.remove(sessionId)
        }
    }

    companion object {
        const val EXTRA_SESSION = "session"
        private val pending = ConcurrentHashMap<Int, CompletableFuture<Outcome>>()

        /**
         * 系统安装器的回调入口（清单里注册的 receiver 转发到这里）。
         *
         * **STATUS_PENDING_USER_ACTION 不是结果**：它表示「确认界面还没弹」，需要本应用把
         * 广播带来的确认 Intent 拉起来，之后系统再回一次终态。早先把它当失败处理，
         * 用户会看到「安装失败：系统安装器已弹出」这种自相矛盾的报错（实测踩过）。
         */
        fun onResult(ctx: Context, sessionId: Int, status: Int, message: String?, confirmIntent: Intent?) {
            val f = pending[sessionId] ?: return
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                val go = if (android.os.Build.VERSION.SDK_INT >= 33) {
                    confirmIntent?.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    confirmIntent?.getParcelableExtra(Intent.EXTRA_INTENT) as? Intent
                }
                if (go != null) {
                    go.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { ctx.startActivity(go) }
                }
                return
            }
            pending.remove(sessionId)
            val ok = status == PackageInstaller.STATUS_SUCCESS
            val text = when {
                ok -> "已安装"
                status == PackageInstaller.STATUS_PENDING_USER_ACTION ->
                    "系统安装器已弹出，等待用户确认…"
                status == PackageInstaller.STATUS_FAILURE_ABORTED -> "安装被取消"
                status == PackageInstaller.STATUS_FAILURE_BLOCKED ->
                    "系统拦截了安装（多半是没有「安装未知应用」权限）"
                status == PackageInstaller.STATUS_FAILURE_CONFLICT ->
                    "签名或版本冲突：设备上已有同包名但签名不同的应用，先卸载旧版"
                status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                    "与当前系统不兼容（minSdk / ABI 不匹配）"
                status == PackageInstaller.STATUS_FAILURE_STORAGE ->
                    "存储空间不足"
                else -> "安装失败（status=$status${message?.let { "，$it" } ?: ""}）"
            }
            f.complete(Outcome(ok, text))
        }
    }
}

/** 系统安装器的结果接收器：显式广播，清单里注册，targetSdk 28 下不受隐式广播限制 */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(AppInstallPlugin.EXTRA_SESSION, -1)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        if (id >= 0) AppInstallPlugin.onResult(context, id, status, msg, intent)
    }
}
