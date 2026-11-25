package ai.deepseek.harness.mobile.kernel.plugin

import java.util.ServiceLoader

/**
 * 内置插件发现 —— 走 Java 标准 `ServiceLoader`，清单是
 * `app/src/main/resources/META-INF/services/ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin`。
 *
 * 这样「一切皆插件」在**编译期**也成立：新增一个内置插件只需要
 * ①新增一个实现 [KernelPlugin] 的类（公开、无参构造）
 * ②在清单文件里加一行类名
 * 内核（ToolKernel）不需要认识它，也不需要改一行代码。
 *
 * 为什么不用注解扫描：安卓上没有 classpath 扫描能力，ServiceLoader 是唯一
 * 零依赖、零反射扫描、可被 R8 保留的标准机制（工程未开 minify，清单天然保留）。
 */
object PluginDiscovery {

    /** 与清单文件名严格一致（改接口包名要同步改这里和资源文件） */
    const val SERVICE_PATH: String =
        "META-INF/services/ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin"

    /**
     * 发现并实例化所有内置插件。
     * 单个插件构造失败不会带崩整个内核：错误进 [errors]，好插件照常装配。
     */
    fun discover(loader: ClassLoader, errors: MutableList<String>): List<KernelPlugin> {
        val found = LinkedHashMap<String, KernelPlugin>()
        val it = ServiceLoader.load(KernelPlugin::class.java, loader).iterator()
        while (true) {
            val next = try {
                if (!it.hasNext()) break
                it.next()
            } catch (t: Throwable) {
                // ServiceLoader 遇到坏条目会抛 ServiceConfigurationError，且无法跳过该条继续，
                // 这里记下原因后停止枚举，已装配的部分仍然可用。
                errors.add("内置插件清单解析中断：${t.javaClass.simpleName}: ${t.message}")
                break
            }
            val prev = found.putIfAbsent(next.id, next)
            if (prev != null) errors.add("内置插件 id 重复：${next.id}（${next.javaClass.name} 已忽略）")
        }
        if (found.isEmpty()) {
            errors.add("未发现任何内置插件：请确认 $SERVICE_PATH 已打进 APK")
        }
        return found.values.toList()
    }
}
