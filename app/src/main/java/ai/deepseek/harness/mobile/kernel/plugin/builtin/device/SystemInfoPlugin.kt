package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pickInt
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.NetworkCapabilities
import android.net.ConnectivityManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 手机状态插件：让 Agent 能感知这台设备自身的处境。
 *
 *   device_info   电量/充电状态/存储余量/网络类型/机型系统（全只读，零权限）
 *   location_get  单次定位（LocationManager，运行时权限；用于「附近有什么」「本地天气」）
 *
 * 前台应用不在这里给——ComputerUsePlugin 的 phone_foreground 已经做了，不重复造。
 */
class SystemInfoPlugin : KernelPlugin {
    override val id = "system-info"
    override val name = "手机状态"
    override val description = "电量、存储、网络状态与单次定位（device_info 零权限；定位需位置权限）"
    override val version = "1.0.0"

    private var app: Context? = null
    private var fixes = 0

    override fun onLoad(ctx: PluginContext) {
        app = ctx.service("app.context") as? Context
    }

    override fun onUnload() {
        app = null
    }

    override fun status(): Map<String, String> = mapOf(
        "定位次数" to fixes.toString(),
        "状态能力" to if (app != null) "可用" else "未就绪",
    )

    private val c: Context
        get() = app ?: throw KernelError("状态插件未就绪（应用上下文缺失），重启应用后再试")

    /* ---------------- device_info ---------------- */

    private fun batteryText(): String {
        val bm = c.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val sticky = c.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        val source = when (sticky?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1) {
            BatteryManager.BATTERY_PLUGGED_AC -> "电源"
            BatteryManager.BATTERY_PLUGGED_USB -> "USB"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "无线"
            else -> ""
        }
        return "$level%" + if (charging) "（充电中${if (source.isNotBlank()) " · $source" else ""}）" else ""
    }

    private fun storageText(): String {
        val stat = StatFs(Environment.getExternalStorageDirectory().absolutePath)
        val gb = { v: Long -> Math.round(v / (1024.0 * 1024 * 1024) * 10) / 10.0 }
        val free = gb(stat.availableBlocksLong * stat.blockSizeLong)
        val total = gb(stat.blockCountLong * stat.blockSizeLong)
        return "可用 $free GB / 共 $total GB"
    }

    private fun networkText(): String {
        val cm = c.getSystemService(ConnectivityManager::class.java)
        // ACCESS_NETWORK_STATE 是普通权限，但清单漏写时 activeNetwork 会直接抛
        // SecurityException，把整个 device_info 打挂（实测踩过）——这里兜住，退化为未知
        val net = runCatching { cm.activeNetwork }.getOrNull()
            ?: return "none（断网，联网操作会失败）"
        val caps = runCatching { cm.getNetworkCapabilities(net) }.getOrNull()
            ?: return "none（断网，联网操作会失败）"
        val online = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        val type = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "other"
        }
        return type + if (online) "（已连通）" else "（未验证连通）"
    }

    /* ---------------- location_get ---------------- */

    /** 单次定位：fused（GMS）> gps > network，取第一个可用的 provider，同步等待 */
    private fun fix(timeoutSec: Long): Location {
        if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            throw KernelError("还没有定位权限：请到系统设置 → 应用 → 权限，允许「位置信息」后重试")
        }
        val lm = c.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = listOf("fused", "gps", "network").firstOrNull {
            runCatching { lm.isProviderEnabled(it) }.getOrDefault(false)
        } ?: throw KernelError("所有定位提供者都关着：请到系统设置打开「位置信息」")
        val main = android.os.Handler(android.os.Looper.getMainLooper())
        val latch = CountDownLatch(1)
        var loc: Location? = null
        var err: String? = null
        val collect: (Location?) -> Unit = { l ->
            loc = l
            if (l == null) err = "定位源没有返回位置"
            latch.countDown()
        }
        main.post {
            runCatching {
                if (Build.VERSION.SDK_INT >= 30) {
                    lm.getCurrentLocation(provider, null, c.mainExecutor) { l -> collect(l) }
                } else {
                    @Suppress("DEPRECATION")
                    lm.requestSingleUpdate(provider, LocationListener { l -> collect(l) }, main.looper)
                }
            }.onFailure {
                err = it.message
                latch.countDown()
            }
        }
        if (!latch.await(timeoutSec, TimeUnit.SECONDS)) {
            throw KernelError("定位超时（${timeoutSec}s）——室内 GPS 常这样，到窗边再试一次")
        }
        return loc ?: throw KernelError("定位失败：${err ?: "未知原因"}")
    }

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "device_info",
            description = "读取这台手机的状态：电量与充电情况、存储余量、网络类型（wifi/cellular/断网）、机型与系统版本。" +
                "判断「存储够不够」「是不是没连网」「电量还撑不撑得住」时先调这个。纯只读，零权限。",
            parameters = Schemas.params(emptyMap(), emptyList()),
            // 只读：允许进并发池
            executionMode = ToolExecutionMode.PARALLEL,
        ) {
            "电量：${batteryText()}\n" +
                "存储：${storageText()}\n" +
                "网络：${networkText()}\n" +
                "设备：${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}"
        },

        SimpleTool(
            name = "location_get",
            description = "单次定位，返回经纬度和精度（米）。「附近有什么」「本地天气」「我到哪了」都靠它拿坐标，" +
                "拿到后再交给 web_search / web_fetch 查询。需要位置权限（没授权会明确报错）。",
            parameters = Schemas.params(
                mapOf(
                    "timeout_s" to Schemas.prop("number", "最长等待秒数，默认 15，上限 60"),
                ),
                emptyList(),
            ),
        ) { a ->
            fixes++
            // 上限压到 25s：只读工具在并发池里受 30s 批次超时约束，超过会抛 TimeoutException
            // 把同批其它工具的结果一起炸掉
            val timeout = a.pickInt("timeout_s", "timeout", default = 15).coerceIn(3, 25).toLong()
            val l = fix(timeout)
            // Locale.US：德语/法语环境下 "%.5f" 会输出 "39,90420"，模型会拆成四个数
            String.format(java.util.Locale.US, "位置：%.5f, %.5f（精度约 %d 米，来源 %s）",
                l.latitude, l.longitude, Math.round(l.accuracy.toDouble()), l.provider)
        },
    )
}
