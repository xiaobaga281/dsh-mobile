package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.device.PhoneControlService
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.PluginHooks
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.RelativeLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/**
 * 操控灵动岛 —— 手机操控时屏幕顶部的常驻胶囊，**点按原地展开成一张卡片**。
 *
 * 桌面 computer-use 操作桌面时用户看得见鼠标动；手机端无障碍操作是隐形的，
 * 用户只看到屏幕「自己会动」。这个插件把操控过程可视化：
 *   - **收起（岛）**：高度 = 摄像头视觉孔径 + 上下留白（孔径 × 7.5%，夹在 2–6dp；
 *     本机 66px 孔径 → 5px），全圆角胶囊，彩点 + 简略动作名。
 *     **宽度是常量**，不随文案长短变化；长文案在固定文字槽里跑马灯滚动。
 *   - **展开（卡片）**：**同一个窗口**从岛的位置向两侧变宽、向下变高，圆角从全圆过渡到
 *     22dp，内容交叉淡入为「彩点 + 标题 + 收起」+ 最多 4 行详情。顶边 y 始终不变。
 *   - 自动事件**不会**自动展开 —— 每次读屏都盖一张大卡会挡住正在操作的界面。
 *
 * ## 为什么不用「逐帧改 WindowManager.LayoutParams」
 *
 * 旧实现用 ValueAnimator 每帧 `updateViewLayout()`，看上去是「同一个窗口在长」，
 * 但每帧都要跨进程走 WindowManagerService → relayout → 整棵 View 树重新 measure/layout
 * → Surface 重新分配尺寸。在这台机器上 110ms 里塞 6~7 次，必掉帧，主观就是「卡顿」。
 *
 * ## 视觉窗口从挂载到卸载，一个字段都不改
 *
 * 只要 `updateViewLayout()` 改过窗口的 x / width / height，就必然存在
 * 「旧 Surface buffer + 新窗口位置」的错位帧：内容按窗口相对坐标画，窗口却已经
 * 挪到别处，整块岛瞬间平移 `pillX - cardX`（本机 309px）。展开跳一次、收起跳回来，
 * 主观就是「左右来回晃动」。逐帧改（掉帧卡顿）、切换一次（瞬移）、同步
 * `translationX` 补偿（补偿先生效、relayout 后生效，中间仍错位）都试过，都不行。
 *
 * 根治办法是**取消这次切换**：
 *   - 视觉窗口 `DSHControlIsland` 恒为 `cardW × winH`、x=`cardX`、y=`pillY`，
 *     且 `FLAG_NOT_TOUCHABLE`。从 attach 到 detach 没有任何一次 `updateViewLayout`，
 *     坐标系恒定，Canvas 里只靠 [IslandView.progress] 插值形状，零跨进程、零错位帧。
 *   - 另挂一层**全透明**的 `DSHControlIslandTouch` 热区窗口接收点按/长按。
 *     收起时它只有胶囊大小，展开时随形状变大；因为它不画任何像素，怎么切都看不见。
 *     这样既不会吞掉屏幕顶部的点击/下拉，又保住了精确命中区域。
 *   - 胶囊子 View 用 `CENTER_HORIZONTAL` 落在 `(cardW-pillW)/2`，屏幕绝对位置
 *     恒等于 `pillX`；形状同样以 `cardW/2`（孔心）为唯一固定轴等量外扩。
 *
 * 相机孔永远居中：胶囊宽度用左右对称公式算常量，`pillX = cam.cx - pillW / 2`；
 * 大窗口与胶囊共用同一条中轴，`(cardW - pillW) / 2 == pillX - cardX`。
 *
 * 分工（一切皆插件）：[PhoneControlService] 只当窗口宿主（TYPE_ACCESSIBILITY_OVERLAY
 * 只能由无障碍服务创建）+ 事件源；画什么、何时显示、怎么交互全在本插件。
 */
class ControlIslandPlugin : KernelPlugin {
    override val id = "control-island"
    override val name = "操控灵动岛"
    override val description = "手机操控时屏幕顶部常驻胶囊：实时显示读屏/点击/输入等操控动作，点按原地展开为详情卡片"
    override val version = "1.4.0"

    private val main = Handler(Looper.getMainLooper())

    /* ---------------- 渲染状态（全部主线程读写） ---------------- */

    /** 需要用户处理的醒目状态：普通动作不覆盖它，点岛直接回 App 处理 */
    private enum class Alert { NONE, APPROVAL, STOPPED }

    @Volatile
    private var alert = Alert.NONE

    private var builtHost: PhoneControlService? = null
    private var builtCamD = -1
    /** 设置页调的几何（位置/长度/上下留白）；0 = 跟随默认 */
    @Volatile
    private var tune = IslandTune.DEFAULT
    private var root: IslandView? = null
    private var pillBox: View? = null
    private var cardBox: View? = null
    /** 卡片标题行：设置页改内边距时 pillY 会动，它的最小高度要跟着重算 */
    private var cardHead: View? = null
    private var dot: View? = null
    private var labelText: TextView? = null
    private var cardDot: View? = null
    private var cardTitle: TextView? = null
    private var cardDetail: TextView? = null
    private var params: WindowManager.LayoutParams? = null

    /** 完全透明的点击层：视觉窗口不可点，靠它接收点按/长按 */
    private var touchView: View? = null
    private var touchParams: WindowManager.LayoutParams? = null

    /** 视觉窗口固定高度（详情最多 4 行）；attach 之后一个字段都不再改 */
    private var winH = 0
    private var attached = false
    private var expanded = false
    private var anim: ValueAnimator? = null

    /** 每次 morph 递增；被 cancel 的旧动画不许在 onAnimationEnd 里改窗口形状 */
    private var animStamp = 0L

    /** 几何（屏幕像素），构建时算一次；之后全是常量 */
    private var pillW = 0
    private var pillH = 0
    private var pillX = 0
    /** 胶囊在视觉窗口内的水平偏移（已按屏幕边界夹取；屏幕绝对位置 == pillX） */
    private var pillDx = 0
    /** 胶囊在视觉窗口内的垂直偏移（设置页滑块；窗口顶不动，卡片仍从顶部展开） */
    private var pillDy = 0
    private var pillY = 0
    private var cardW = 0
    private var cardH = 0
    private var cardX = 0
    private var cardRadius = 0f

    /** 最近一次动作的类别（决定彩点颜色） */
    @Volatile
    private var lastKind = "status"

    /** 最近一次动作的简略文案（收起态胶囊与卡片标题显示它） */
    @Volatile
    private var lastBrief = "操控中"

    /** 最近一次动作的详情（卡片正文显示它） */
    @Volatile
    private var lastDetail = "操控中"

    /** phone_island hide 之后的静默：自动事件不再把窗口拉回来，show 才恢复 */
    @Volatile
    private var muted = false

    private val idleSettle = Runnable { settle() }

    /* ---------------- 生命周期 ---------------- */

    override fun onLoad(ctx: PluginContext) {
        instance = this
        PhoneControlService.controlObserver = { kind, brief, detail ->
            onControlEvent(kind, brief, detail)
        }
        // 用户不在 App 里时，审批/停下原因只有岛看得见 —— 订阅轮次总线事件把它们顶上来
        subscribeTurnEvents(ctx.hooks)
    }

    override fun onUnload() {
        if (instance === this) instance = null
        PhoneControlService.controlObserver = null
        main.removeCallbacks(idleSettle)
        muted = true
        main.post { detach() }
    }

    /* ---------------- 设置页调参（位置 / 长度 / 上下留白） ---------------- */

    /**
     * 应用一组几何参数，**就地更新**（设置页滑块拖动时实时预览）。
     *
     * 为什么不重建：早期版本走 detach + ensureBuilt + attach，连续拖动时多个
     * post 排队，`removeView` 与 `addView` 交错会把窗口弄丢（实测「拖一下岛就没了」）。
     * 视觉窗口尺寸恒定，本来就不需要重建 —— 改胶囊的 layoutParams / 偏移、热区窗口
     * 的尺寸位置、以及窗口 y（内边距变了要重新垂直居中）就够。
     *
     * @return 应用后的实际值（已夹取），前端用它回写滑块
     */
    fun applyTune(json: String?): String {
        val next = IslandTune.parse(json)
        tune = next
        // 连续拖动合并成一次：60ms 内的多次调用只跑最后一次
        main.removeCallbacks(tuneRunnable)
        main.postDelayed(tuneRunnable, 40)
        return JSONObject().put("ok", true)
            .put("dx", next.dx).put("w", next.widthPx).put("pad", next.padPx).toString()
    }

    private val tuneRunnable = Runnable { applyTuneNow() }

    private fun applyTuneNow() {
        val svc = builtHost ?: PhoneControlService.instance ?: return
        // 设置页在调参：岛没显示就先建出来 —— 否则用户拖了半天滑块，屏幕上什么也没发生
        if (!attached) {
            val cam0 = cameraOf(svc)
            val v = ensureBuilt(svc, cam0) ?: return
            attach(svc, v, cam0)
            return
        }
        val dm = svc.resources.displayMetrics
        val d = dm.density
        val cam = cameraOf(svc)
        val m = metrics(cam, d)
        val axis = cam?.cx ?: (dm.widthPixels / 2)

        pillH = m.pillH
        pillW = if (tune.widthPx > 0) tune.widthPx
        else 2 * (m.spacerW / 2 + m.gap + m.padX + m.textSlotW)
        pillX = (axis - pillW / 2 + tune.dx)
            .coerceIn((6 * d).toInt(), dm.widthPixels - pillW - (6 * d).toInt())
        pillDx = pillX - (axis - pillW / 2)
        // 高度变了要重新以孔心垂直居中（否则胶囊向上/下偏，孔不在正中）
        pillY = if (cam != null) (cam.cy - pillH / 2).coerceAtLeast(0) else (2 * d).toInt()
        // 用户给的垂直偏移：视觉窗口顶不动（卡片从那儿展开），胶囊在窗口内整体下移
        pillDy = tune.dy.coerceIn(
            -pillY,
            (dm.heightPixels - pillY - pillH).coerceAtLeast(-pillY),
        )

        pillBox?.let {
            it.layoutParams = FrameLayout.LayoutParams(
                pillW, pillH, Gravity.TOP or Gravity.CENTER_HORIZONTAL,
            )
            it.translationX = pillDx.toFloat()
            it.translationY = pillDy.toFloat()
        }
        root?.dxOffset = pillDx
        root?.dyOffset = pillDy
        root?.requestLayout()
        root?.invalidate()

        // 详情要压在孔下沿之后：pillY 动了，标题行的最小高度跟着重算
        if (cam != null) {
            val padTopCard = (13 * d).toInt()
            val detailPadTop = (10 * d).toInt()
            val holeBottom = cam.cy + cam.dHole / 2
            cardHead?.minimumHeight =
                (holeBottom + (6 * d).toInt() - pillY - padTopCard - detailPadTop)
                    .coerceIn((20 * d).toInt(), (52 * d).toInt())
        }

        // 视觉窗口尺寸恒定，只可能改 y（内边距变了）；热区窗口跟着胶囊走
        params?.let { p ->
            if (p.y != pillY) {
                p.y = pillY
                root?.let { svc.updateOverlay(it, p) }
            }
        }
        touchParams?.let { tp ->
            tp.width = pillW
            tp.height = pillH
            tp.x = pillX
            tp.y = pillY + pillDy
            touchView?.let { svc.updateOverlay(it, tp) }
        }
        // 调参时岛是被「叫出来」的：同样 7s 无动作就收，别一直挂在那儿
        armAutoHide()
    }

    override fun status(): Map<String, String> = mapOf(
        "灵动岛" to when {
            !PhoneControlService.enabled -> "待机（无障碍未开启）"
            muted -> "已隐藏（phone_island show 恢复）"
            attached && expanded -> "显示中（已展开成卡片）"
            attached -> "显示中"
            else -> "就绪（首次操控时出现）"
        },
    )

    /* ---------------- 事件 → 展示 ---------------- */

    private fun onControlEvent(kind: String, brief: String, detail: String) {
        if (muted) return
        main.post { showAction(kind, brief, detail) }
    }

    /* ---------------- 轮次事件（审批 / 停下原因上岛） ---------------- */

    private fun subscribeTurnEvents(hooks: PluginHooks) {
        // HookBus 的监听在调用线程执行（轮次线程），一律切主线程再碰 View
        hooks.onSerial("agent/approval", "island") { c ->
            val phase = c.str("phase") ?: return@onSerial
            val name = c.str("name").orEmpty()
            val reason = c.str("reason").orEmpty()
            val approved = c.bool("approved")
            main.post {
                when (phase) {
                    "request" -> {
                        alert = Alert.APPROVAL
                        if (!muted) showAlert("alert-wait", "待确认",
                            reason.ifBlank { "操控需要你确认：$name" })
                    }
                    "resolved" -> if (alert == Alert.APPROVAL) {
                        alert = Alert.NONE
                        if (!muted) {
                            showAction("status", if (approved) "已确认" else "已拒绝",
                                if (approved) "确认通过，继续操控" else "这次操作被拒绝，Agent 会换方式或停下来")
                            // 展开的卡片让人看清结果，2.5s 后自动收起
                            main.postDelayed({ if (expanded && alert == Alert.NONE) morph(false) }, 2500)
                        }
                    }
                }
            }
        }
        hooks.onSerial("agent/turn-end", "island") { c ->
            val error = c.str("error").orEmpty()
            val cancelled = c.bool("cancelled")
            main.post {
                if (alert == Alert.APPROVAL && error.isBlank()) {
                    // 等确认时轮次先结束了（超时/取消）：提示已经没有意义
                    alert = Alert.NONE
                }
                if (error.isNotBlank() && !muted) {
                    alert = Alert.STOPPED
                    showAlert("alert-stop", "已停下", error.take(300))
                }
            }
        }
    }

    /**
     * 醒目提示（待确认 / 已停下）：自动展开成卡片 —— 用户此刻多半盯着被控应用，
     * 收起的胶囊只有一行字，看不出「为什么停了」；展开 + 点岛回 App 是完整链路。
     */
    private fun showAlert(kind: String, brief: String, detail: String) {
        val svc = PhoneControlService.instance ?: return
        val cam = cameraOf(svc)
        val view = ensureBuilt(svc, cam) ?: return
        if (!attached) attach(svc, view, cam)
        lastKind = kind
        lastBrief = brief
        lastDetail = detail
        labelText?.let { tv ->
            tv.text = pillLabel(brief)
            tv.isSelected = false
            tv.isSelected = true
        }
        (dot?.background as? GradientDrawable)?.setColor(ACCENTS[kind] ?: ACCENT_STATUS)
        fillCard()
        if (!expanded) morph(true) else syncCardHeight()
        main.removeCallbacks(idleSettle)
    }

    /**
     * 岛上的醒目状态点下去 = 回到 DeepSeek 处理（审批卡/错误详情都在 App 里）。
     * 后台启动 Activity 需要 悬浮窗权限 或 可见窗口；被系统拦就退化为通知。
     */
    private fun openDsh() {
        val svc = builtHost ?: PhoneControlService.instance ?: return
        alert = Alert.NONE
        val ok = runCatching {
            svc.startActivity(android.content.Intent(svc, ai.deepseek.harness.mobile.MainActivity::class.java).apply {
                addFlags(
                    android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                        android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        android.content.Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED,
                )
            })
        }.isSuccess
        if (ok) showAction("status", "已回到应用", "正在打开 DeepSeek，处理岛上的提示事项")
        else notifyAttention(svc)
    }

    /** 点岛回不去时（后台启动被拦）：发一条点回去就能处理的通知兜底 */
    private fun notifyAttention(svc: PhoneControlService) {
        runCatching {
            val nm = svc.getSystemService(android.app.NotificationManager::class.java) ?: return
            nm.createNotificationChannel(
                android.app.NotificationChannel(
                    "control_island_alert", "操控提醒",
                    android.app.NotificationManager.IMPORTANCE_HIGH,
                ).apply { description = "操控需要确认或已停下时提醒你回到 DeepSeek" },
            )
            if (!nm.areNotificationsEnabled()) return
            val back = android.content.Intent(svc, ai.deepseek.harness.mobile.MainActivity::class.java).apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val pi = android.app.PendingIntent.getActivity(
                svc, 0x0D5A, back,
                android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
            )
            nm.notify(0x0D5B, android.app.Notification.Builder(svc, "control_island_alert")
                .setSmallIcon(ai.deepseek.harness.mobile.R.drawable.ic_notify)
                .setContentTitle("DeepSeek 操控")
                .setContentText(lastDetail.ifBlank { "有事项需要你处理" })
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build())
        }
    }

    /** 新动作：只更新彩点 + 简略文案 + 卡片正文；**绝不动窗口尺寸** */
    private fun showAction(kind: String, brief: String, detail: String) {
        val svc = PhoneControlService.instance ?: return
        val cam = cameraOf(svc)
        val view = ensureBuilt(svc, cam) ?: return
        if (!attached) attach(svc, view, cam)
        // 待确认/已停下是当前最要紧的信息：普通动作（含排队）不覆盖它
        if (alert != Alert.NONE) return
        lastKind = kind
        lastBrief = brief
        lastDetail = detail
        labelText?.let { tv ->
            tv.text = pillLabel(brief)
            // 固定宽度 + MARQUEE 兜底（字体偏大时 4 字也可能超宽）：
            // setText 后切一下 selected 才能重新开始滚动
            tv.isSelected = false
            tv.isSelected = true
        }
        val color = ACCENTS[kind] ?: ACCENT_STATUS
        (dot?.background as? GradientDrawable)?.setColor(color)
        // 动画期间卡片高度恒定；只有展开态换详情时才整块重测一次（不在动画帧里）
        if (expanded) {
            fillCard()
            syncCardHeight()
        }
        main.removeCallbacks(idleSettle)
        main.postDelayed(idleSettle, IDLE_SETTLE_MS)
        // 每次操控动作都把「自动收起」的计时往后推
        armAutoHide()
    }

    /**
     * 7s 没有新动作就撤掉窗口。
     *
     * **不设 muted**（那是长按隐藏的语义）：下次操控事件到来时 [showAction] 会
     * `ensureBuilt` + `attach` 照常出现，用户不需要再手动 show。
     */
    private val autoHideRun = Runnable { if (!expanded) detach() }

    private fun armAutoHide() {
        main.removeCallbacks(autoHideRun)
        if (attached && !expanded) main.postDelayed(autoHideRun, AUTO_HIDE_MS)
    }

    /** 静默：彩点回到默认色（岛不变形、不消失） */
    private fun settle() {
        if (!expanded) (dot?.background as? GradientDrawable)?.setColor(ACCENT_STATUS)
    }

    /* ---------------- 用户交互：点按原地展开/收起，长按隐藏 ---------------- */

    private fun toggle() = morph(!expanded)

    private fun collapse() {
        if (expanded) morph(false)
    }

    /**
     * 岛 ⇄ 卡片：**视觉窗口一个像素都不动**，只改 [IslandView.progress] 自绘。
     * 唯一会变的窗口是那层全透明点击区，改它没有任何视觉后果。
     */
    private fun morph(open: Boolean) {
        val svc = builtHost ?: return
        val v = root ?: return
        if (!attached) return

        // 先宣告新的一代，再 cancel 旧的：旧的 onAnimationEnd 会因 stamp 不符直接返回
        val stamp = ++animStamp
        anim?.cancel()
        expanded = open
        // 展开时用户在读详情，不能自动收；收起后重新开始 7s 计时
        if (open) main.removeCallbacks(autoHideRun)
        if (open) {
            fillCard()
            cardH = measureCardHeight()
            applyWindowMode(svc, true)
        }

        val from = v.progress
        val to = if (open) 1f else 0f
        val a = ValueAnimator.ofFloat(from, to).apply {
            // 固定时长：被打断时若按剩余比例缩时长，曲线会重新加速 → 顿挫
            duration = MORPH_MS
            // 起步和收尾都缓，中间快：第一帧不会「猛地跳一下」，末尾也不会硬停。
            interpolator = android.view.animation.AccelerateDecelerateInterpolator()
            addUpdateListener { va ->
                val t = va.animatedValue as Float
                v.progress = t
                // smoothstep 全程连续淡入/淡出；旧版前 22% 硬卡在 0 再启动，
                // 看起来像「内容突然蹦出来」，也是跳跃感的一部分。
                val ca = t * t * (3f - 2f * t)
                pillBox?.alpha = 1f - ca
                cardBox?.alpha = ca
                v.invalidate()   // 纯 View 重绘，不碰 WindowManager
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (stamp != animStamp) return
                    v.progress = to
                    pillBox?.alpha = if (open) 0f else 1f
                    cardBox?.alpha = if (open) 1f else 0f
                    // 收起完成才把透明热区缩回胶囊尺寸（无视觉影响）
                    if (!open && v.wide) applyWindowMode(svc, false)
                    if (!open) armAutoHide()
                    v.invalidate()
                }
            })
        }
        anim = a
        a.start()
    }

    /**
     * 唯一会改 `WindowManager.LayoutParams` 的地方，而且**只改透明热区**。
     * 视觉窗口 [params] 从 attach 到 detach 一个字段都不动 —— 没有 Surface
     * 重排/重定位，就没有「旧 buffer + 新位置」的错位帧，左右晃动从根上消失。
     */
    private fun applyWindowMode(svc: PhoneControlService, wide: Boolean) {
        val v = root ?: return
        val tv = touchView ?: return
        val tp = touchParams ?: return
        v.wide = wide
        if (wide) {
            tp.width = cardW
            tp.height = cardH
            tp.x = cardX
        } else {
            tp.width = pillW
            tp.height = pillH
            tp.x = pillX
        }
        tp.y = pillY
        // attach 之前只改参数对象，addView 会用最新值；不调 updateOverlay
        if (attached) svc.updateOverlay(tv, tp)
    }

    /**
     * 胶囊文字槽固定宽度，所以**绝不把词硬截断**（旧版 take(3) 把「打开应用」
     * 截成「打开应」）。动作名用固定简称；自由进度文案优先显示「2/5」这种进度串
     * —— 这正是 phone_island text 最常见的用法，旧版只显示「填表」把进度丢了。
     * 完整内容永远在卡片正文里。
     */
    private fun pillLabel(s: String): String {
        PILL_SHORT[s]?.let { return it }
        if (s.length <= 3) return s
        PROGRESS.find(s)?.value?.let { return it.replace(" ", "") }
        return s.take(2)
    }

    /** phone_island text 的卡片标题：只给阶段，不再把整句和详情重复一遍 */
    private fun statusLabel(t: String): String {
        val p = PROGRESS.find(t)?.value?.replace(" ", "")
        return if (p != null) "进度 $p" else "状态"
    }

    private fun fillCard() {
        // phone_island text 的 brief/detail 同源：标题只给阶段，正文才是完整内容，
        // 否则一张卡里会把同一句话重复两遍（实测发现的问题）。
        cardTitle?.text = if (lastBrief == lastDetail) statusLabel(lastDetail) else lastBrief
        cardDetail?.text = lastDetail
        (cardDot?.background as? GradientDrawable)?.setColor(ACCENTS[lastKind] ?: ACCENT_STATUS)
    }

    /** 按当前详情文本测一次卡片高度（最多 4 行），动画期间不再改 */
    private fun measureCardHeight(): Int {
        val box = cardBox ?: return pillH
        box.measure(
            View.MeasureSpec.makeMeasureSpec(cardW, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
        )
        return box.measuredHeight.coerceAtLeast(pillH)
    }

    /** 展开态换详情时重测一次形状高度；只影响自绘范围与透明热区，不碰视觉窗口 */
    private fun syncCardHeight() {
        if (!expanded) return
        val svc = builtHost ?: return
        val h = measureCardHeight()
        if (h == cardH) return
        cardH = h
        applyWindowMode(svc, true)
        root?.invalidate()
    }

    private fun hide() {
        muted = true
        main.post { detach() }
    }

    /* ---------------- 摄像头几何（一切以运行时挖孔实测为准） ---------------- */

    /**
     * [dHole]：boundingRect 短边 =「孔 + 系统保护边距」的**外包盒** → 水平让位用；
     * [dVisual]：外包盒短边 × [VISUAL_HOLE_RATIO] ≈ 真孔的视觉直径 → 胶囊高度基准。
     *
     * **Android 没有「真实孔径」的公开 API**：`DisplayCutout` 只给 `boundingRects`
     * （含厂商安全边距的外包盒）和 safe insets，真实玻璃开孔直径拿不到。所以
     * [VISUAL_HOLE_RATIO] 是实测换算系数，不是精确值；不同厂商的保护边距不一样，
     * 这也是为什么留白必须按 **dVisual 比例**算而不是写死像素（见 [IslandGeometry.EDGE_PAD_RATIO]）。
     */
    private class CameraGeom(val cx: Int, val cy: Int, val dHole: Int, val dVisual: Int)

    private fun cameraOf(svc: PhoneControlService): CameraGeom? {
        // Display.getCutout() 与 DisplayCutout.getBoundingRectTop() 都是 API 29(Q)。
        // minSdk 26：P(28) 及更早没有可查询的挖孔外包盒，走 metrics() 的无孔兜底。
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val display = runCatching {
            (svc.getSystemService(Context.DISPLAY_SERVICE) as? android.hardware.display.DisplayManager)
                ?.getDisplay(android.view.Display.DEFAULT_DISPLAY)
        }.getOrNull() ?: return null
        val cutout = runCatching { display.cutout }.getOrNull() ?: return null
        val r = cutout?.boundingRectTop ?: return null
        if (r.isEmpty || r.width() <= 0 || r.height() <= 0) return null
        val hole = minOf(r.width(), r.height())
        return CameraGeom(r.centerX(), r.centerY(), hole, (hole * VISUAL_HOLE_RATIO).toInt())
    }

    /* ---------------- 视图与窗口 ---------------- */

    private class IslandMetrics(
        val gap: Int, val spacerW: Int, val padX: Int, val dotPx: Int,
        val pillH: Int, val textSlotW: Int,
    )

    private fun metrics(cam: CameraGeom?, density: Float): IslandMetrics {
        val dotPx = (6 * density).toInt()
        val textSlotW = (TEXT_SLOT_DP * density).toInt()
        if (cam == null) {
            // 无挖孔设备（或 P 及更早）：高度仍是「26dp 内容 + 上下留白（取下限）」
            val pad = IslandGeometry.edgePadPx(0, density)
            return IslandMetrics(0, (24 * density).toInt(), (14 * density).toInt(), dotPx,
                (26 * density).toInt() + 2 * pad, textSlotW)
        }
        // 紧凑胶囊：让位区只比外包盒多一点点，间隙 / 内边距都按视觉孔径的小比例取。
        // 旧版 gap=0.3×、padX=0.42× 把胶囊撑到 468px（近半屏），这里压到 ~380px。
        val gap = (cam.dVisual * 0.15f).toInt()
        // 高度 = 视觉孔径 + 上下留白；留白优先用设置页给的值，没给才按孔径比例自动
        val pad = if (tune.padPx >= 0) tune.padPx else IslandGeometry.edgePadPx(cam.dVisual, density)
        val h = cam.dVisual + 2 * pad
        return IslandMetrics(gap, cam.dHole + 2 * gap, (cam.dVisual * 0.28f).toInt(),
            dotPx, h, textSlotW)
    }

    /**
     * 自绘岛的窗口根 View：背景、描边、圆角、内容裁剪都由 [progress] 一个值驱动。
     * 不设 background drawable（那会铺满整个窗口，无法逐帧收缩），也不做逐帧 layout。
     */
    private inner class IslandView(ctx: Context, strokeW: Float) : FrameLayout(ctx) {
        private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val glossPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            this.strokeWidth = strokeW
        }
        private val shape = Path()
        private val bounds = RectF()

        /** 0 = 胶囊，1 = 卡片 */
        var progress = 0f

        /** 当前窗口是卡片尺寸（true）还是胶囊尺寸（false） */
        var wide = false

        /**
         * 设置页给的水平偏移（px）：收起态形状整体平移这么多，展开过程中线性归中。
         * 归中而不是整段平移，是因为卡片窗口宽度固定、不能跟着偏移出屏；这样展开时
         * 形状从用户放的位置平滑长到居中卡片，收起再回到原位，两边都不跳。
         */
        var dxOffset = 0

        /** 设置页给的垂直偏移：同样只在收起态生效，展开时回到窗口顶 */
        var dyOffset = 0

        private var gL = 0f
        private var gT = 0f
        private var gR = 0f
        private var gB = 0f
        private var gRad = 0f

        init {
            setWillNotDraw(false)
            clipChildren = false
        }

        /** 纯垂直渐变：水平位置怎么变，同一 y 的颜色都一致，窗口切换不会闪一下色 */
        fun setGradient(h: Float) {
            val hh = h.coerceAtLeast(1f)
            // 主体：顶部微亮的石墨色 → 底部近黑（上一版两截都是灰，看起来像一片平板）
            fillPaint.shader = LinearGradient(
                0f, 0f, 0f, hh,
                0xFF3A3E48.toInt(), 0xFF0F1116.toInt(), Shader.TileMode.CLAMP,
            )
            // 顶部高光：上半段一道 10%→0 的白色渐变，玻璃「顶光」的来源
            glossPaint.shader = LinearGradient(
                0f, 0f, 0f, (hh * 0.55f).coerceAtLeast(1f),
                0x1AFFFFFF.toInt(), 0x00FFFFFF.toInt(), Shader.TileMode.CLAMP,
            )
            // 描边也走渐变：顶亮底暗 → 像被上方光照到的圆角边缘，而不是一圈等宽铁丝
            strokePaint.shader = LinearGradient(
                0f, 0f, 0f, hh,
                0x42FFFFFF.toInt(), 0x0FFFFFFF.toInt(), Shader.TileMode.CLAMP,
            )
        }

        /**
         * 视觉窗口从 attach 到 detach 恒为 `cardW × winH`、x 恒为 `cardX`，
         * **坐标系永不变化**，所以形状只由 [progress] 决定，没有任何「切换帧」。
         * 唯一固定轴 = 窗口中点（就是摄像头孔心），左右等量外扩；
         * progress=0 时形状落在 `(cardW-pillW)/2`，绝对位置正好 == pillX。
         */
        private fun geom() {
            val t = progress
            val cCard = cardW / 2f
            // 收起态整体偏移 dxOffset，展开过程中归中：t=1 时形状铺满窗口、中点回孔心。
            // 半宽仍按 cardW/2 插值，偏移只作用于「中点」，否则展开会一侧先到边。
            val c = cCard + dxOffset * (1f - t)
            val half = pillW / 2f + (cCard - pillW / 2f) * t
            gL = c - half
            // 垂直同理：收起态在用户放的位置，展开时线性回到窗口顶（卡片从顶部展开）
            gT = dyOffset * (1f - t)
            gR = c + half
            gB = gT + pillH + (cardH - pillH) * t
            gRad = pillH / 2f + (cardRadius - pillH / 2f) * t
        }

        override fun onDraw(canvas: Canvas) {
            geom()
            bounds.set(gL, gT, gR, gB)
            shape.reset()
            shape.addRoundRect(bounds, gRad, gRad, Path.Direction.CW)
            canvas.drawRoundRect(bounds, gRad, gRad, fillPaint)
            // 顶光：裁进形状里只刷上半段，边缘被圆角自然截断
            canvas.save()
            canvas.clipPath(shape)
            canvas.drawRect(gL, gT, gR, gT + (gB - gT) * 0.55f, glossPaint)
            canvas.restore()
            canvas.drawRoundRect(bounds, gRad, gRad, strokePaint)
        }

        override fun dispatchDraw(canvas: Canvas) {
            geom()
            bounds.set(gL, gT, gR, gB)
            shape.reset()
            shape.addRoundRect(bounds, gRad, gRad, Path.Direction.CW)
            canvas.save()
            canvas.clipPath(shape)
            super.dispatchDraw(canvas)
            canvas.restore()
        }
    }

    private fun ensureBuilt(svc: PhoneControlService, cam: CameraGeom?): IslandView? {
        val camD = cam?.dHole ?: 0
        // 只有挖孔几何变了才重建；设置页的位置/长度/留白走 applyTuneNow() 就地更新
        // （重建会 detach/attach，连续拖动时会把窗口弄丢）
        if (root != null && builtHost === svc && builtCamD == camD) return root
        main.removeCallbacks(idleSettle)
        anim?.cancel()
        anim = null
        detach()   // 挖孔几何变了要重建：别把旧 View 留在 WindowManager 上
        attached = false
        expanded = false
        params = null
        touchParams = null
        touchView = null

        val dm = svc.resources.displayMetrics
        val d = dm.density
        val m = metrics(cam, d)

        /* 几何：全部是常量，构建期一次算完。卡片布局要给挖孔让位，所以先算再用。 */
        pillH = m.pillH
        // 宽度：设置页给了就用他的（已夹在 260–520），否则用对称公式的常量宽度。
        // 常量宽度的理由没变：不测量文案，左右半区各有「半让位区 + 间隙 + 内边距 + 内容槽」，
        // 所以孔永远在正中，brief 再长也不会把胶囊撑宽。
        pillW = if (tune.widthPx > 0) tune.widthPx
        else 2 * (m.spacerW / 2 + m.gap + m.padX + m.textSlotW)
        // 卡片窗口也以孔心为中轴：大窗口的中点 == 胶囊中点 == 孔心，
        // 展开时两条边等量外扩，形状中心纹丝不动。
        val axis = cam?.cx ?: (dm.widthPixels / 2)
        cardW = minOf(
            dm.widthPixels - 2 * (16 * d).toInt(),
            (380 * d).toInt(),
            2 * minOf(axis, dm.widthPixels - axis),
        )
        cardX = (axis - cardW / 2).coerceIn(0, dm.widthPixels - cardW)
        cardRadius = CARD_RADIUS_DP * d
        // 水平位置：以孔心为 0 的偏移；夹在屏幕内，别让用户把岛推出去
        pillX = (axis - pillW / 2 + tune.dx)
            .coerceIn((6 * d).toInt(), dm.widthPixels - pillW - (6 * d).toInt())
        // 窗口内偏移用夹取后的差值：屏幕位置与热区窗口必须严格一致
        pillDx = pillX - (axis - pillW / 2)
        pillY = if (cam != null) (cam.cy - pillH / 2).coerceAtLeast(0) else (2 * d).toInt()
        // 垂直偏移要夹在屏幕内：上限是「窗口顶 + 胶囊高」不越过屏幕底
        pillDy = tune.dy.coerceIn(-pillY, (dm.heightPixels - pillY - pillH).coerceAtLeast(-pillY))
        // 挖孔是系统 ScreenDecorOverlay，永远画在我们之上：卡片内容必须绕开它。
        // 标题只占孔左侧，中间让位区空出来，详情正文压到孔下沿之后。
        val padXCard = (16 * d).toInt()
        val padTopCard = (13 * d).toInt()
        val detailPadTop = (10 * d).toInt()
        val holeClear = if (cam != null) cam.dHole + 2 * m.gap else (24 * d).toInt()
        val contentW = cardW - 2 * padXCard
        val titleW = ((contentW - holeClear) / 2 - (8 * d).toInt() - (10 * d).toInt())
            .coerceAtLeast((48 * d).toInt())
        val holeBottom = if (cam != null) cam.cy + cam.dHole / 2 else (24 * d).toInt()
        val headMinH = (holeBottom + (6 * d).toInt() - pillY - padTopCard - detailPadTop)
            .coerceIn((20 * d).toInt(), (52 * d).toInt())

        /* 收起态内容：彩点 + 挖孔让位区 + 固定宽度的跑马灯文案 */
        val dotView = View(svc).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(ACCENT_STATUS)
            }
        }
        val briefText = TextView(svc).apply {
            setTextColor(0xF2FFFFFF.toInt())
            textSize = 11f
            includeFontPadding = false
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            maxLines = 1
            isSingleLine = true
            // 胶囊宽度是常量，绝不为长文案伸长；超出的部分在固定文字槽里横向滚动
            ellipsize = TextUtils.TruncateAt.MARQUEE
            marqueeRepeatLimit = -1
            isSelected = true
            text = lastBrief
        }
        // 让位区 CENTER_IN_PARENT 钉死在胶囊正中 —— 摄像头永远居中，与文案长短无关。
        // 左右半区严格等宽，只是内容一侧放彩点、一侧放文字槽。
        val spacer = View(svc).apply { id = View.generateViewId() }
        val pill = RelativeLayout(svc).apply {
            addView(spacer, RelativeLayout.LayoutParams(m.spacerW, m.pillH).apply {
                addRule(RelativeLayout.CENTER_IN_PARENT)
            })
            addView(dotView, RelativeLayout.LayoutParams(m.dotPx, m.dotPx).apply {
                addRule(RelativeLayout.ALIGN_PARENT_START)
                addRule(RelativeLayout.CENTER_VERTICAL)
                leftMargin = m.padX
            })
            addView(briefText, RelativeLayout.LayoutParams(
                m.textSlotW, RelativeLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                addRule(RelativeLayout.ALIGN_PARENT_END)
                addRule(RelativeLayout.CENTER_VERTICAL)
                rightMargin = m.padX
            })
        }

        /* 展开态内容：标题行 + 详情正文 */
        val cdot = View(svc).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(ACCENT_STATUS)
            }
        }
        val title = TextView(svc).apply {
            setTextColor(0xF2FFFFFF.toInt())
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            includeFontPadding = false
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        val close = TextView(svc).apply {
            text = "收起"
            setTextColor(0x99FFFFFF.toInt())
            textSize = 12f
            includeFontPadding = false
            val hp = (10 * d).toInt()
            val vp = (5 * d).toInt()
            setPadding(hp, vp, hp, vp)
            setOnClickListener { collapse() }
        }
        val head = LinearLayout(svc).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = headMinH
            val ds = (8 * d).toInt()
            addView(cdot, LinearLayout.LayoutParams(ds, ds))
            // 标题固定占「孔左侧」那一栏：旧版 weight=1 会横穿屏幕中央，
            // 字被摄像头挖孔整个盖住。超长文案在这里 ellipsize，完整内容在详情区。
            addView(title, LinearLayout.LayoutParams(
                titleW, LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { leftMargin = (10 * d).toInt() })
            // 中间让位区吸收剩余宽度，把「收起」推到孔右侧
            addView(View(svc), LinearLayout.LayoutParams(0, 1, 1f))
            addView(close, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
        }
        val detail = TextView(svc).apply {
            setTextColor(0xB3FFFFFF.toInt())
            textSize = 12.5f
            includeFontPadding = false
            maxLines = 4
            ellipsize = TextUtils.TruncateAt.END
            setLineSpacing(2 * d, 1f)
            setPadding(0, detailPadTop, 0, 0)
        }
        val card = LinearLayout(svc).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padXCard, padTopCard, padXCard, (14 * d).toInt())
            addView(head, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
            addView(detail, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
            alpha = 0f
        }

        val frame = IslandView(svc, (d / 2).coerceAtLeast(1f)).apply {
            addView(pill, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ))
            addView(card, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            ))
            // 视觉窗口 FLAG_NOT_TOUCHABLE，不接收任何触摸；
            // 点按/长按全部由下面那层全透明热区处理。
        }

        val touchTarget = View(svc).apply {
            // 完全透明：只给岛一个精确的点击区域，不画任何像素。
            // 有醒目状态（待确认/已停下）时点岛 = 回 App 处理，其余时候点岛 = 展开卡片
            setOnClickListener { if (alert != Alert.NONE) openDsh() else toggle() }
            setOnLongClickListener { hide(); true }
        }

        // 视觉窗口坐标系恒定，胶囊靠 CENTER_HORIZONTAL 落在 (cardW-pillW)/2，
        // 屏幕绝对位置 == pillX，永不移动。
        pill.layoutParams = FrameLayout.LayoutParams(
            pillW, pillH, Gravity.TOP or Gravity.CENTER_HORIZONTAL,
        )
        card.layoutParams = FrameLayout.LayoutParams(
            cardW, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP or Gravity.CENTER_HORIZONTAL,
        )

        builtHost = svc
        builtCamD = camD
        root = frame
        touchView = touchTarget
        pillBox = pill
        cardBox = card
        cardHead = head
        // 设置页给的水平偏移：视觉窗口 x 恒定，胶囊在窗口内整体平移 pillDx
        // （屏幕绝对位置 = cardX + (cardW-pillW)/2 + pillDx = pillX，与热区窗口一致）
        pill.translationX = pillDx.toFloat()
        pill.translationY = pillDy.toFloat()
        frame.dxOffset = pillDx
        frame.dyOffset = pillDy
        dot = dotView
        labelText = briefText
        cardDot = cdot
        cardTitle = title
        cardDetail = detail
        // 视觉窗口高度 =「详情最多 4 行」的最坏情况，**一次算完永不改**。
        // 形状高度 cardH 仍按当前内容测，短详情不会在下半留一大片空白。
        detail.text = "占\n占\n占\n占"
        winH = measureCardHeight()
        detail.text = lastDetail
        cardH = measureCardHeight()
        frame.setGradient(winH.toFloat())
        return frame
    }

    private fun attach(svc: PhoneControlService, view: IslandView, cam: CameraGeom?) {
        // 视觉窗口：恒为 cardW × winH、x=cardX、y=pillY，**之后再无任何改动**。
        // FLAG_NOT_TOUCHABLE 让它完全不吞点击/下拉，代价是必须另配透明热区。
        val p = params ?: WindowManager.LayoutParams(
            cardW, winH,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
            gravity = Gravity.TOP or Gravity.START
            x = cardX
            y = pillY
            title = "DSHControlIsland"
        }
        val tp = touchParams ?: WindowManager.LayoutParams(
            pillW, pillH,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
            gravity = Gravity.TOP or Gravity.START
            title = "DSHControlIslandTouch"
        }
        // 重新挂载时复位形态（hide→show 之前可能正处在展开态）
        view.wide = false
        view.progress = 0f
        pillBox?.alpha = 1f
        cardBox?.alpha = 0f
        params = p
        touchParams = tp
        applyWindowMode(svc, false)   // 只定热区几何；此时 attached=false，不调 update
        svc.attachOverlay(view, p)
        touchView?.let { svc.attachOverlay(it, tp) }
        attached = true
    }

    private fun detach() {
        anim?.cancel()
        anim = null
        expanded = false
        val host = builtHost
        val view = root
        if (host != null && view != null && attached) {
            host.detachOverlay(view)
            touchView?.let { host.detachOverlay(it) }
        }
        attached = false
    }

    /* ---------------- 工具：phone_island ---------------- */

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "phone_island"
            override val description = "操控灵动岛（屏幕顶部的常驻状态胶囊，操控动作会自动显示；" +
                "用户点按胶囊可原地展开/收起详情卡片，长按隐藏）。text 设置状态文案（多步任务时报进度，" +
                "如「填表 2/5」）；hide 在输入密码/敏感操作前整体收起避免遮挡，show 恢复。"
            override val parameters = schema(
                JSONObject()
                    .put("action", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("text", "hide", "show")))
                        .put("description", "text=设置文案，hide=收起，show=恢复"))
                    .put("text", JSONObject().put("type", "string")
                        .put("description", "action=text 时的状态文案")),
                listOf("action"),
            )
            override fun execute(args: JSONObject): String {
                return when (val action = args.optString("action")) {
                    "text" -> {
                        val t = args.optString("text")
                        if (t.isBlank()) return err("BAD_ARGS", "action=text 需要 text")
                        muted = false
                        // brief/detail 同源：胶囊由 pillLabel 精简，标题由 fillCard 精简
                        onControlEvent("status", t, t)
                        JSONObject().put("ok", true).put("text", t).toString()
                    }
                    "hide" -> {
                        muted = true
                        main.post { detach() }
                        JSONObject().put("ok", true).put("note", "灵动岛已收起，phone_island show 可恢复").toString()
                    }
                    "show" -> {
                        muted = false
                        // detail 与 brief 必须不同：用户点按展开卡片时要有可读的正文
                        onControlEvent("status", "操控中", "灵动岛已恢复 · 点按胶囊展开动作详情")
                        JSONObject().put("ok", true).toString()
                    }
                    else -> err("BAD_ACTION", "action 支持 text / hide / show，收到：$action")
                }
            }
        },
    )

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    private fun err(code: String, message: String): String =
        JSONObject().put("ok", false).put("code", code).put("error", message).toString()

    companion object {
        /** 桥接层（设置页滑块）拿插件实例的唯一入口；插件卸载时置空 */
        @Volatile
        var instance: ControlIslandPlugin? = null

        /** 静默多久后彩点回到默认色（岛不变形、不消失） */
        private const val IDLE_SETTLE_MS = 3500L

        /**
         * 多久没有任何操控动作就自动收起岛（用户明确要求 7s）。
         *
         * 与 [IDLE_SETTLE_MS] 是两件事：3.5s 只是彩点变色，7s 才真正把窗口撤掉。
         * 展开成卡片时不自动收（用户正在看详情），收起后重新计时。
         */
        private const val AUTO_HIDE_MS = 7000L

        /** 简略文案的固定文字槽宽度（dp）：3 字放得下，超宽才跑马灯，绝不撑宽胶囊 */
        private const val TEXT_SLOT_DP = 36f

        /** 展开成卡片后的圆角 */
        private const val CARD_RADIUS_DP = 22f

        /** 岛 ⇄ 卡片过渡时长：纯 Canvas 重绘，没有 relayout，可以给它一条完整的缓动 */
        private const val MORPH_MS = 200L

        /** 视觉孔径 / 外包盒短边（模拟器实测 66/118 ≈ 0.56） */
        private const val VISUAL_HOLE_RATIO = 0.56f

        /** 超过文字槽的动作名 → 固定 2 字简称，禁止 take(3) 截出半个词 */
        private val PILL_SHORT = mapOf("打开应用" to "打开")

        /** 「填表 2/5」「步骤 3 / 8」这类进度串，胶囊优先显示它 */
        private val PROGRESS = Regex("""\d+\s*/\s*\d+""")

        private val ACCENT_STATUS = 0xFF34D399.toInt()

        private val ACCENTS = mapOf(
            "read" to 0xFF34D399.toInt(),
            "tap" to 0xFF60A5FA.toInt(),
            "long" to 0xFF60A5FA.toInt(),
            "text" to 0xFFFBBF24.toInt(),
            "swipe" to 0xFFA78BFA.toInt(),
            "scroll" to 0xFFA78BFA.toInt(),
            "gesture" to 0xFFA78BFA.toInt(),
            "key" to 0xFF94A3B8.toInt(),
            "app" to 0xFF38BDF8.toInt(),
            "wait" to 0xFF94A3B8.toInt(),
            // 后台排队（用户在用手机，操控没执行）：用琥珀色和普通「等待」区分开
            "queue" to 0xFFF59E0B.toInt(),
            "shot" to 0xFF94A3B8.toInt(),
            "status" to ACCENT_STATUS,
            // 需要用户处理的醒目状态：待确认琥珀、已停下红
            "alert-wait" to 0xFFFFB020.toInt(),
            "alert-stop" to 0xFFF87171.toInt(),
        )
    }
}
