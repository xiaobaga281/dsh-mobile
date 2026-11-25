package ai.deepseek.harness.mobile.glass

import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import ai.deepseek.harness.mobile.R

/**
 * 原生底部面板：优先使用荣耀 HnVisualEffectLayout 渲染真实系统级模糊，
 * aar 缺失时回退为半透明圆角面板（保证视觉一致，不崩溃）。
 *
 * 这里严格按荣耀建议：BIG + GENERAL、圆角 27dp、悬浮留 8dp 外边距、开启交互动效。
 */
class GlassSheet(
    private val activity: Activity,
    private val title: String,
    private val subtitle: String,
    private val items: List<Item>,
    private val onAction: (String) -> Unit,
    /** App（WebView）当前主题。弹窗明暗必须跟它走，而不是跟系统走——
     *  系统深色 + App 浅色时，按系统取色会得到一个和界面割裂的暗色弹窗。 */
    private val light: Boolean = true,
) {
    data class Item(val id: String, val label: String)

    private var dialog: BottomSheetDialog? = null

    private val isDark: Boolean
        get() = !light

    fun show() {
        val context = activity
        val container: ViewGroup =
            (HonorGlass.createContainer(context) as? ViewGroup) ?: FrameLayout(context)
        val radiusPx = dp(27)

        // 以「效果是否真的挂上」为准，而不是 aar 是否存在：
        // 非荣耀机型上类存在但效果可能不绘制，必须回退到不透明面板。
        val glass = HonorGlass.applyGlass(
            container = container,
            radiusPx = radiusPx,
            big = true,
            immersive = false,
            interactive = true,
            light = !isDark,
        )
        if (glass) {
            // 子 View 一并按圆角裁剪，内容不会压出玻璃边缘
            HonorGlass.clipToRadius(container, radiusPx.toFloat())
        } else {
            container.background = GradientDrawable().apply {
                cornerRadius = radiusPx.toFloat()
                setColor(if (isDark) 0xFA1C1C1E.toInt() else 0xFAFFFFFF.toInt())
                setStroke(dp(1), if (isDark) 0x1FFFFFFF else 0x33FFFFFF)
            }
        }
        container.clipToOutline = false

        val content = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(8), dp(18), dp(20))
        }

        content.addView(grabber())
        content.addView(text(title, 21f, labelColor(), Typeface.BOLD).apply {
            setPadding(0, dp(10), 0, dp(4))
            letterSpacing = -0.02f
        })
        if (subtitle.isNotBlank()) {
            content.addView(text(subtitle, 12.5f, secondaryColor(), Typeface.NORMAL).apply {
                setPadding(0, 0, 0, dp(14))
                setLineSpacing(dp(3).toFloat(), 1f)
            })
        } else {
            // 无副标题时补一点间距，标题与首项之间不留空洞也不贴死
            content.addView(View(context).apply {
                layoutParams = LinearLayout.LayoutParams(1, dp(10))
            })
        }

        items.forEach { item ->
            content.addView(row(item))
        }

        container.addView(content, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ))

        val wrapper = FrameLayout(context).apply {
            setPadding(dp(8), 0, dp(8), dp(10))
            setBackgroundColor(Color.TRANSPARENT)
        }
        wrapper.addView(container, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ))

        val sheet = BottomSheetDialog(context, R.style.GlassSheetTheme)
        dialog = sheet
        sheet.setContentView(wrapper)
        // 为系统导航条让位：手势条约 24dp，三键导航约 48dp
        ViewCompat.setOnApplyWindowInsetsListener(wrapper) { v, insets ->
            val bottom = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom
            v.setPadding(dp(8), 0, dp(8), dp(10) + bottom)
            insets
        }
        // show 之前就把行为/窗口配置好：否则会先以折叠态绘制一帧再跳到展开态，肉眼就是「闪一下」
        sheet.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            // 压暗层会被玻璃采样进来：浅色模式用 0.24 会让白玻璃整体发灰发暗，降到 0.08
            setDimAmount(if (isDark) 0.24f else 0.08f)
            setLayout(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
        sheet.behavior.apply {
            isHideable = true
            skipCollapsed = true
            state = BottomSheetBehavior.STATE_EXPANDED
            peekHeight = 0
        }
        sheet.setOnShowListener {
            // 独立窗口必须声明跨窗取景，否则模糊取不到 Activity 画面（会变黑/空白）
            HonorGlass.enableWindowBlur(sheet.window?.decorView, 1)
            sheet.window?.decorView?.requestApplyInsets()
        }
        sheet.show()
    }

    private fun row(item: Item): View {
        val tv = text(item.label, 15.5f, labelColor(), Typeface.NORMAL)
        tv.gravity = Gravity.CENTER_VERTICAL
        tv.setPadding(dp(14), 0, dp(14), 0)
        tv.isClickable = true
        tv.foreground = RippleDrawable(
            ColorStateList.valueOf(if (isDark) 0x33FFFFFF else 0x14000000),
            null,
            null,
        )
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(48),
        )
        tv.layoutParams = lp
        tv.setOnClickListener {
            it.playSoundEffect(android.view.SoundEffectConstants.CLICK)
            onAction(item.id)
            dialog?.dismiss()
        }
        return tv
    }

    private fun grabber(): View = View(activity).apply {
        layoutParams = LinearLayout.LayoutParams(dp(38), dp(5)).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            topMargin = dp(2)
        }
        background = GradientDrawable().apply {
            cornerRadius = dp(3).toFloat()
            setColor(if (isDark) 0x4DFFFFFF else 0x33000000)
        }
    }

    private fun text(value: String, sp: Float, color: Int, style: Int): TextView =
        TextView(activity).apply {
            text = value
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
            setTextColor(color)
            typeface = Typeface.create(Typeface.DEFAULT, style)
        }

    private fun labelColor(): Int = if (isDark) 0xFFFFFFFF.toInt() else 0xFF000000.toInt()

    private fun secondaryColor(): Int = if (isDark) 0x99EBEBF5.toInt() else 0x993C3C43.toInt()

    private fun dp(value: Int): Int =
        (value * activity.resources.displayMetrics.density).toInt()
}
