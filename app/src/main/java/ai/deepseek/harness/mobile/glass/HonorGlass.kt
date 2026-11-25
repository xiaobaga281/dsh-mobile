package ai.deepseek.harness.mobile.glass

import android.content.Context
import android.util.Log
import android.view.View

/**
 * 荣耀 MagicOS 通透能力适配层（基于 uikit_hnvisual / hnvisualeffect aar）。
 *
 * 设计要点（来自荣耀官方 SKILL.md / api-reference.md；参考件未随仓库保留，改这里时以 aar 里的类签名为准）：
 *  - HnVisualEffectLayout 继承 FrameLayout，子 View 背景必须透明，效果绘制在子 View 之下；
 *  - 它**不解析任何 app:hnXxx XML 属性**，所有参数必须走 setVisualEffect()；
 *  - 圆角通过 setRadius(px) 设置；
 *  - 材质默认跟随系统，不要显式 setMaterialType()，否则会关闭"跟随系统材质"；
 *  - 大面板用 BIG + GENERAL，浮层弹窗开启 setInteractive(true)。
 *
 * 由于 aar 属于可选依赖（未上架 Maven），这里全部通过反射调用：
 * 没有放 aar 时工程照常编译，[isAvailable] 返回 false，UI 回退到半透明 + 阴影。
 */
object HonorGlass {

    private const val TAG = "HonorGlass"

    /** aar 中 API 的真实包名（荣耀开发者文档）。附带两个历史/变体包名做兜底。 */
    private val PACKAGES = listOf(
        "com.hihonor.uikit.transparency.api",
        "com.hihonor.uikit.transparency",
        "com.honor.uikit.transparency.api",
    )

    @Volatile private var resolvedPackage: String? = null
    @Volatile private var probed = false
    @Volatile private var platformSupported: Boolean? = null

    /** com.hihonor.uikit.transparency.api -> com.hihonor.uikit.transparency */
    private fun rootPackage(): String? = resolvedPackage?.removeSuffix(".api")

    /** 加载 transparency 根包下的类（configuration.* / window.*） */
    private fun loadRootClass(suffix: String): Class<*>? {
        val root = rootPackage() ?: return null
        return try {
            Class.forName("$root.$suffix")
        } catch (_: Throwable) {
            null
        }
    }

    private fun loadClass(simpleName: String): Class<*>? {
        val pkgs = resolvedPackage?.let { listOf(it) } ?: PACKAGES
        for (pkg in pkgs) {
            try {
                return Class.forName("$pkg.$simpleName")
            } catch (_: ClassNotFoundException) {
                // try next
            }
        }
        return null
    }

    private fun probe(): String? {
        for (pkg in PACKAGES) {
            try {
                Class.forName("$pkg.HnVisualEffectLayout")
                Class.forName("$pkg.HnGlassEffect")
                return pkg
            } catch (_: Throwable) {
                // continue
            }
        }
        return null
    }

    fun isAvailable(@Suppress("UNUSED_PARAMETER") context: Context?): Boolean {
        if (!probed) {
            synchronized(this) {
                if (!probed) {
                    resolvedPackage = probe()
                    probed = true
                }
            }
        }
        if (resolvedPackage == null) return false
        // aar 里有类 ≠ 设备支持：非荣耀机型上 HnVisualEffectLayout 会静默不绘制，
        // 表现为面板全透明、文字直接叠在内容上。必须问系统能力。
        platformSupported?.let { return it }
        val supported = queryPlatformSupport(context)
        platformSupported = supported
        return supported
    }

    /** TransparencyFeatureConfig.isSupportTransparencyMaterial(Context) */
    private fun queryPlatformSupport(context: Context?): Boolean {
        val ctx = context ?: return true
        return try {
            val cfg = loadRootClass("configuration.TransparencyFeatureConfig") ?: return true
            val ctxCls = Context::class.java
            val supported = cfg.getMethod("isSupportTransparencyMaterial", ctxCls)
                .invoke(null, ctx) as Boolean
            if (!supported) return false
            val level = cfg.getMethod("getTransparentMaterialLevel", ctxCls).invoke(null, ctx) as Int
            val invalid = cfg.getField("INVALID_DATA").getInt(null)
            level != invalid
        } catch (t: Throwable) {
            Log.w(TAG, "platform support probe failed, assume supported", t)
            true
        }
    }

    /** 创建一个带通透材质能力的容器；aar 缺失时返回 null。 */
    fun createContainer(context: Context): View? {
        if (!isAvailable(context)) return null
        return try {
            val cls = loadClass("HnVisualEffectLayout") ?: return null
            val ctor = cls.getConstructor(Context::class.java)
            ctor.newInstance(context) as? View
        } catch (t: Throwable) {
            Log.w(TAG, "createContainer failed", t)
            null
        }
    }

    /**
     * 为容器挂上毛玻璃效果。
     * @param radiusPx 圆角（px）
     * @param big true=BIG 大面板，false=SMALL 小控件
     * @param immersive true=IMMERSIVE 沉浸式，false=GENERAL 常规式
     * @param interactive 是否开启触控微动效
     * @param transparency 0f..1f，传负数表示跟随系统
     * @param light true=浅色 App 主题：锁定浅色材质，**不跟随系统**
     *   （系统处于深色时，跟随系统会让浅色界面里的弹窗发暗）
     */
    fun applyGlass(
        container: View,
        radiusPx: Int,
        big: Boolean = true,
        immersive: Boolean = false,
        interactive: Boolean = true,
        transparency: Float = -1f,
        light: Boolean = true,
    ): Boolean {
        val ctx = container.context
        if (!isAvailable(ctx)) return false
        return try {
            val effectCls = loadClass("HnGlassEffect") ?: return false
            val effect = effectCls.getConstructor().newInstance()

            invokeEnumSetter(effectCls, effect, "setWidgetSize", "HnWidgetSize", if (big) "BIG" else "SMALL")
            invokeEnumSetter(effectCls, effect, "setSceneType", "HnSceneType", if (immersive) "IMMERSIVE" else "GENERAL")

            effectCls.getMethod("setInteractive", Boolean::class.javaPrimitiveType)
                .invoke(effect, interactive)

            // 圆角（px）
            effectCls.getMethod("setRadius", Int::class.javaPrimitiveType).invoke(effect, radiusPx)

            if (transparency in 0f..1f) {
                effectCls.getMethod("setTransparencyLevel", Float::class.javaPrimitiveType)
                    .invoke(effect, transparency)
            }

            // 材质跟 App 主题走，不跟系统：
            // setFollowSystemSettings(true) 时会继承系统当前材质（可能是深色材质），
            // 于是 App 明明是浅色，弹窗却是暗的。这里显式锁定材质 + 关掉跟随。
            runCatching {
                invokeEnumSetter(
                    effectCls, effect, "setMaterialType", "HnMaterialType",
                    if (light) "LIQUID_GLASS" else "FROSTED_GLASS",
                )
            }
            runCatching {
                val styleCls = loadClass("StyleType")
                val style = styleCls?.let {
                    enumConstant(it, if (light) "LIQUID_GLASS_TRANSPARENT" else "FROSTED_GLASS_TRANSPARENCY")
                }
                if (style != null) {
                    effectCls.methods.firstOrNull { it.name == "setViewStyleType" && it.parameterTypes.size == 1 }
                        ?.invoke(effect, style)
                }
            }
            runCatching {
                val base = loadClass("HnVisualEffect")
                base?.getMethod("setFollowSystemSettings", Boolean::class.javaPrimitiveType)
                    ?.invoke(effect, false)
            }

            val setter = container.javaClass.methods.firstOrNull { it.name == "setVisualEffect" }
                ?: return false
            setter.invoke(container, effect)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "applyGlass failed", t)
            false
        }
    }

    /** 顶部/底部工具条用的渐变模糊。 */
    fun applyGradientBlur(container: View, radiusPx: Int, topToBottom: Boolean = true): Boolean {
        val ctx = container.context
        if (!isAvailable(ctx)) return false
        return try {
            val effectCls = loadClass("HnGradientBlurEffect") ?: return false
            val dirCls = loadClass("HnBlurGradientBlurDirection") ?: return false
            val dir = enumConstant(dirCls, if (topToBottom) "TOP_TO_BOTTOM" else "BOTTOM_TO_TOP")
                ?: return false
            val effect = effectCls.getConstructor(dirCls).newInstance(dir)
            effectCls.getMethod("setRadius", Int::class.javaPrimitiveType).invoke(effect, radiusPx)
            container.javaClass.methods.firstOrNull { it.name == "setVisualEffect" }?.invoke(container, effect)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "applyGradientBlur failed", t)
            false
        }
    }

    /**
     * 独立窗口（BottomSheetDialog / PopupWindow）要取到下层画面，必须显式声明跨窗取景。
     * 对应文档里的 hnWindowBLurType:
     *   1 = ONLY_VIEW（弹窗/面板覆盖普通页面，最常用）
     *   2 = ONLY_SURFACE（覆盖视频/游戏等 Surface）
     *   3 = MIX
     */
    fun enableWindowBlur(root: View?, mode: Int = 1): Boolean {
        val view = root ?: return false
        return try {
            val cls = loadRootClass("window.WindowBlurManager") ?: return false
            val method = cls.getMethod(
                "setWindowBlur",
                Int::class.javaPrimitiveType,
                Array<View>::class.java,
            )
            method.invoke(null, mode, arrayOf(view))
            true
        } catch (t: Throwable) {
            Log.w(TAG, "enableWindowBlur failed", t)
            false
        }
    }

    /** 子 View 一起按圆角裁剪，避免内容压出玻璃边缘。 */
    fun clipToRadius(container: View, radiusPx: Float): Boolean = try {
        container.javaClass.methods
            .firstOrNull { it.name == "setCornerRadiusWithClipChildren" }
            ?.invoke(container, radiusPx, true)
        true
    } catch (_: Throwable) {
        false
    }

    /** 设备当前通透档位 + 系统选择的材质（用于设置页展示）。 */
    fun describe(context: Context): String {
        if (!isAvailable(context)) {
            return if (resolvedPackage == null) "未接入 · 缺少 hnvisualeffect aar"
            else "不受支持 · 非荣耀设备，已回退半透明"
        }
        return try {
            val cfg = loadRootClass("configuration.TransparencyFeatureConfig")
                ?: return "已接入 11.0.0.134"
            val ctxCls = Context::class.java
            val level = cfg.getMethod("getTransparentMaterialLevel", ctxCls).invoke(null, context) as Int
            val material = cfg.getMethod("getCurrentTransparentMaterial", ctxCls).invoke(null, context) as Int

            val high = cfg.getField("HIGH_LEVEL_TRANSPRENT_MATERIAL").getInt(null)
            val middle = cfg.getField("MIDDLE_LEVEL_TRANSPRENT_MATERIAL").getInt(null)
            val low = cfg.getField("LOW_LEVEL_TRANSPRENT_MATERIAL").getInt(null)
            val liquid = cfg.getField("LIQUID_GLASS").getInt(null)
            val frosted = cfg.getField("FROSTED_GLASS").getInt(null)

            val levelName = when (level) {
                high -> "高端机"
                middle -> "中端机"
                low -> "低端机"
                else -> "档位未知"
            }
            val materialName = when (material) {
                liquid -> "液态玻璃"
                frosted -> "磨砂玻璃"
                else -> "跟随系统"
            }
            "已接入 11.0.0.134 · $levelName · $materialName"
        } catch (_: Throwable) {
            "已接入 11.0.0.134"
        }
    }

    private fun invokeEnumSetter(
        owner: Class<*>,
        target: Any,
        methodName: String,
        enumName: String,
        constant: String,
    ) {
        val enumCls = loadClass(enumName) ?: return
        val value = enumConstant(enumCls, constant) ?: return
        owner.methods.firstOrNull { it.name == methodName && it.parameterTypes.size == 1 }
            ?.invoke(target, value)
    }

    private fun enumConstant(enumCls: Class<*>, name: String): Any? =
        enumCls.enumConstants?.firstOrNull { (it as Enum<*>).name == name }
}
