package ai.deepseek.harness.mobile.kernel.device

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * 手机操控服务（无障碍） —— 桌面 computer-use 的手机端等价物。
 *
 * 桌面（docs/subsystems/computer-use.zh.md）：computer-use 共享服务只注册一个
 * 提供方（Cua Driver MCP / 原生），模型经提供方观察桌面（截图）并操作（鼠标/
 * 键盘）。安卓没有 cua-driver，等价运行时是系统 AccessibilityService：
 *   - 观察 = 屏幕节点树（比截图信息密度更高：文本、角色、可交互性、边界）
 *            + 截图（API 30+ takeScreenshot，等价桌面 Cua 的 screenshot）
 *   - 操作 = performAction（点击/长按/设置文本/滚动）+ dispatchGesture（坐标点击、
 *            滑动）+ performGlobalAction（返回/主页/最近任务/通知栏）
 *
 * 授权模型与桌面一致：用户必须显式开启（系统设置 → 无障碍），服务未开启时
 * 工具返回结构化原因并给出引导，不静默失败。
 *
 * 读屏质量要点（踩过的坑，别退回去）：
 *   1. 屏幕上大量可点容器自身没有 text，文本在子节点里 —— 必须聚合后代文本，
 *      否则模型只能看到一排空 label 的 LinearLayout，等于读不了屏。
 *   2. 不可见（isVisibleToUser=false）或布局越界的节点要剔除，否则会出现
 *      bottom < top 的假边界，坐标点击必落空。
 *   3. 文本命中的往往是 TextView，真正可点的是父容器 —— 点击要向上找可点祖先。
 */
class PhoneControlService : AccessibilityService() {

    companion object {
        @Volatile
        var instance: PhoneControlService? = null
            private set

        /** 服务是否已获授权并运行 */
        val enabled: Boolean get() = instance != null

        /** 后台「等用户回来」的通知渠道与 id（同一 id 覆盖，不堆一屏） */
        private const val CHANNEL_WAIT = "dsh_control_wait"
        private const val NOTI_WAIT = 0x0D5A01

        /** 排队闸门：最多等多久（用户的手一直不停就报错回给模型，不无限等） */
        private const val QUEUE_WAIT_MS = 15_000L

        /** 用户的手停多久算「让出来了」：滚动/点按的间隙超过它，操控就可以走 */
        private const val TOUCH_QUIET_MS = 2500L

        /**
         * 「屏幕能不能让给操控」的纯判定（JVM 单测锁行为，服务层喂 Android 状态）：
         *  - DSH 前台 → 让（用户正看着，哪怕刚摸过屏）；
         *  - 息屏 → 让（人走开了）；
         *  - 从没收到触摸事件 → 让（服务刚连上 / 机型不上报：宁可少拦不卡死）；
         *  - 其余（亮屏 + 后台）→ 看手：手停满 [TOUCH_QUIET_MS] 才让。
         */
        fun screenFreeForControl(
            appVisible: Boolean,
            interactive: Boolean,
            lastTouchAtMs: Long,
            now: Long,
        ): Boolean = appVisible || !interactive ||
            lastTouchAtMs == Long.MIN_VALUE ||
            now - lastTouchAtMs >= TOUCH_QUIET_MS

        /** 打开系统无障碍设置页（引导用户授权） */
        fun settingsIntent(): android.content.Intent =
            android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)

        /**
         * 授权闸门的提供方：由 ComputerUsePlugin 在 onLoad 时从 `agent.runtime` 注入。
         * 每轮注入一次（拿的是**当前轮次**的确认通道），没有活跃轮次时返回 null
         * → 需要授权的操作一律 APP_APPROVAL_UNAVAILABLE。
         */
        @Volatile
        var gateProvider: (() -> ApprovalGate?)? = null

        /**
         * 操控事件观察者（一切皆插件：ControlIslandPlugin 在 onLoad 挂上）。
         * kind = 动作类别（read/tap/text/…）；brief = 收起态的简略文案；
         * detail = 展开态的完整描述（坐标/元素数/应用等）。
         * 事件在工具工作线程发出，展示层自己切线程；没有观察者时零开销。
         */
        @Volatile
        var controlObserver: ((kind: String, brief: String, detail: String) -> Unit)? = null

        /** 当前可用的确认通道；null = 后台/团队/委派，问不了人 */
        fun currentGate(): ApprovalGate? = gateProvider?.invoke()

        /** 应用级授权策略（进程单例；纯逻辑层见 [PhoneApprovalPolicy]） */
        val approval = PhoneApprovalPolicy()

        /** 「始终允许」的应用包名（只存键，不存界面内容） */
        private const val APPROVAL_PREFS = "phone_approval"
        private const val KEY_ALLOWED_APPS = "allowedApps"
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        // 持久化「始终允许」的应用清单：只记包名/Intent 键
        val prefs = getSharedPreferences(APPROVAL_PREFS, MODE_PRIVATE)
        approval.installStore(
            load = { prefs.getStringSet(KEY_ALLOWED_APPS, emptySet())?.toSet() ?: emptySet() },
            save = { set -> prefs.edit().putStringSet(KEY_ALLOWED_APPS, set).apply() },
        )
    }

    /**
     * 事件驱动基建（此前是空实现，导致节点树零缓存、点击后无从校验）：
     * 只统计「界面可能变了」的三类事件，进 UiChangeTracker 做去抖与代数递增。
     * 读屏 settle、点击后置校验、快照过期提醒都吃这里的信号。
     */
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            -> uiTracker.onEvent(System.currentTimeMillis())
            // 用户的手是「屏幕归谁」的最终裁判（见 isScreenFreeForControl）：
            // 一次触摸交互开始就记时刻，操控与用户抢屏的仲裁只看这个
            AccessibilityEvent.TYPE_TOUCH_INTERACTION_START ->
                lastTouchAtMs = System.currentTimeMillis()
        }
        // 前台包名事件驱动地记一份：排队闸门每个动作都要判「DSH 是否在前台」，
        // 每次都去 rootInActiveWindow 走 binder 会让每个动作多 ~0.9s。
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            event.packageName?.toString()?.takeIf { it.isNotBlank() }?.let { fgPackage = it }
        }
    }

    /** 最近一次「窗口状态变化」报告的包名（事件驱动，O(1) 读） */
    @Volatile
    private var fgPackage: String = ""

    /** 用户最近一次触摸屏幕的时刻（TYPE_TOUCH_INTERACTION_START；MIN = 从未摸过） */
    @Volatile
    private var lastTouchAtMs: Long = Long.MIN_VALUE

    override fun onInterrupt() {}

    override fun onDestroy() {
        instance = null
        // 无障碍被关掉 = 用户撤销了手机操控授权：运行时 grant 一并作废
        approval.revokeRuntimeGrants()
        super.onDestroy()
    }

    /** 供插件层在每次工具调用前同步当前文件权限档位（降档 → 清运行时 grant） */
    fun noteSandboxMode(mode: String?) {
        PhoneControlService.approval.noteSandboxMode(mode)
    }

    /* ---------------- 授权闸门（入口拦截） ---------------- */

    /** 把判定转成模型可见的结构化错误（拒绝时用） */
    private fun deniedJson(d: ApprovalDecision): String = JSONObject().apply {
        put("ok", false)
        put("code", d.code ?: PhoneApprovalPolicy.CODE_DENIED)
        put("error", d.reason ?: "需要用户授权")
        d.hint?.let { put("hint", it) }
    }.toString()

    /** open_app / launch / foreground 的「首次操作未知包」闸门；允许返回 null */
    private fun guardTarget(packageName: String, action: String): String? {
        val d = PhoneControlService.approval.guardPackage(packageName, action, PhoneControlService.currentGate())
        return if (d.allowed) null else deniedJson(d)
    }

    /* ---------------- 不跟用户抢屏幕（前台/后台已合并，仲裁只看「手」） ---------------- */

    /**
     * 操控会话的排队闸门：**用户正在摸屏幕时不执行**，手停了自动继续。
     *
     * 旧的「前台 / 后台」两档已合并：拿「DSH 是否在前台」判「用户是不是在用手机」
     * 会把操控会话本身卡死 —— Agent 替用户操作别的应用时 DSH 必然在后台，
     * 亮屏 + 后台 = 每个动作都排队到超时，表现就是「操控不可用、老是中途停下」。
     *
     * 新仲裁只看**手**：用户正在触摸屏幕（TYPE_TOUCH_INTERACTION_START 后
     * [TOUCH_QUIET_MS] 内）就排队让路，手一停就继续；息屏 / DSH 在前台一律放行。
     * 「用户盯着 Agent 操控」与「用户自己在用手机」由此天然区分。
     *
     * @return null = 屏幕空闲，可以执行；非 null = 直接回给模型的结构化错误
     */
    private fun awaitScreenFree(action: String): String? {
        if (isScreenFreeForControl()) return null
        // 排队也上岛：用户能看到「它在等我放下手机」，而不是一条莫名其妙的通知
        reportControl("queue", "排队", "后台排队：等你放下手机再$action")
        val notified = notifyQueued(action)
        val deadline = System.currentTimeMillis() + QUEUE_WAIT_MS
        while (System.currentTimeMillis() < deadline) {
            if (isScreenFreeForControl()) {
                runCatching {
                    getSystemService(android.app.NotificationManager::class.java)?.cancel(NOTI_WAIT)
                }
                return null
            }
            // 无障碍被关掉 / 服务被销毁：别在这里空等
            if (instance !== this) break
            Thread.sleep(250)
        }
        return err(
            "APP_USER_BUSY",
            "用户正在用手机，$action 排队 ${QUEUE_WAIT_MS / 1000}s 没等到空档，没有执行",
            (if (notified) "已发一条排队提醒。" else "通知发不出去（系统通知未授权）。") +
                "灵动岛上也显示「排队」；等用户停手或息屏后重试，不要连续重试，也不要改成盲点坐标",
        )
    }

    /**
     * 屏幕能不能让给操控：
     *  - DSH 在前台 → 用户正看着，可以让（哪怕他刚摸过屏）；
     *  - 息屏 → 人走开了，可以让；
     *  - 亮屏 + DSH 在后台 → 看**手**：最近 [TOUCH_QUIET_MS] 内有触摸就排队，
     *    手停了就让。从没收到过触摸事件（服务刚连上/机型不上报）按空闲处理：
     *    宁可少拦一次，也不把正常操控卡死。
     */
    private fun isScreenFreeForControl(): Boolean {
        val pm = runCatching { getSystemService(android.os.PowerManager::class.java) }.getOrNull()
        val interactive = pm?.isInteractive ?: true
        return screenFreeForControl(isAppVisible(), interactive, lastTouchAtMs, System.currentTimeMillis())
    }

    /**
     * App 是否在前台。
     *
     * 主判据是**无障碍事件里报告的前台包名**（TYPE_WINDOW_STATE_CHANGED，事件驱动、
     * O(1) 读）—— 这是"用户此刻眼睛在看哪个应用"的第一手事实；
     * `RunService.isAppVisible()` 只是 Activity 的 onStart/onStop 标志，实测在 HOME
     * 之后存在没及时翻成 false 的窗口，会让排队闸门整个失效。
     *
     * 事件缓存为空（服务刚连上、还没收到窗口事件）才回退去查 rootInActiveWindow，
     * 再拿不到按「在前台」处理（宁可少拦一次，不误伤正常操作）。
     */
    private fun isAppVisible(): Boolean {
        val cached = fgPackage
        if (cached.isNotBlank()) return cached == packageName
        val fg = runCatching { rootInActiveWindow?.packageName?.toString() }.getOrNull()
        if (!fg.isNullOrBlank()) return fg == packageName
        return runCatching { ai.deepseek.harness.mobile.notify.RunService.isAppVisible() }
            .getOrDefault(true)
    }

    /* ---------------- 内容窗口：读前台应用的全部窗口（多窗口架构的正面解） ---------------- */

    /**
     * 合并读取的说明；readScreen 会带在结果里告诉模型。
     */
    @Volatile
    var windowMergeNote: String? = null
        private set

    /**
     * 前台应用的**全部**内容窗口根，活跃窗口排第一。
     *
     * 微信/钉钉这类多窗口应用：界面分布在同应用的多个窗口里，前台"活跃"的那个
     * 经常是透明覆盖 Activity（包名对、整棵树无子节点）。只读活跃窗口 = 读到空壳。
     * 正确做法是把同应用的窗口**全部**读一遍合并 —— 这不是"回退"，是多窗口应用的
     * 正常形态（主界面 + 弹窗 + 悬浮层同时存在）。
     *
     * 过滤：排除自身的悬浮窗（岛）与别的应用；按窗口 id 去重（active 往往就是
     * windows 列表里的某一个）。
     */
    private fun contentRoots(): List<AccessibilityNodeInfo> {
        windowMergeNote = null
        val out = ArrayList<AccessibilityNodeInfo>()
        val seen = HashSet<Int>()
        val self = packageName
        fun windowIdOf(n: AccessibilityNodeInfo): Int =
            runCatching { n.getWindow()?.id }.getOrDefault(-1) ?: -1
        val ime = imePackages()
        val active = rootInActiveWindow
        val activePkg = active?.packageName?.toString().orEmpty()
        // 活跃根不是自己、也不是输入法才收。**以前这里 `?: return out`** ——
        // 系统不给活跃根（锁屏/无障碍被降权/ROM 返回 null）时直接空手而归，
        // 后面读 windows 的机会都没有，模型只能拿到 elements: []。
        if (active != null && activePkg != self && activePkg !in ime) {
            out.add(active)
            runCatching { seen.add(windowIdOf(active)) }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val cands = ArrayList<Pair<Int, AccessibilityNodeInfo>>()
            runCatching { windows }.getOrNull()?.forEach { w ->
                val r = runCatching { w.root }.getOrNull() ?: return@forEach
                val pkg = r.packageName?.toString().orEmpty()
                // 自己的灵动岛不读；输入法窗口单独排除 —— 它置顶时活跃根就是它，
                // 以前「只收与活跃根同包」会把真正的应用窗口全丢掉（读屏空的主因之一）
                if (pkg == self || pkg in ime) return@forEach
                val wid = runCatching { w.id }.getOrDefault(-1)
                if (wid >= 0 && !seen.add(wid)) return@forEach
                cands.add(runCatching { w.layer }.getOrDefault(0) to r)
            }
            // 按层从高到低，最多 4 个窗口：权限弹窗 / 分屏另一半 / 悬浮层都能读到，
            // 又不至于把整台设备的窗口树全搬进 JSON
            cands.sortByDescending { it.first }
            cands.forEach { if (it.second !== active && out.size < 4) out.add(it.second) }
        }
        if (out.size > 1) {
            val pkgs = out.mapNotNull { runCatching { it.packageName?.toString() }.getOrNull() }
                .filter { it.isNotBlank() }.distinct()
            windowMergeNote = if (pkgs.size > 1) {
                "读到 ${out.size} 个窗口（${pkgs.joinToString("/")}），已合并；节点带 pkg 字段可分辨来源"
            } else {
                "前台应用有 ${out.size} 个窗口（多窗口架构），读屏已合并全部窗口内容"
            }
        } else if (out.isEmpty()) {
            windowMergeNote = "没拿到任何窗口根（无障碍可能被系统降权或锁屏）；" +
                "可让他重新打开无障碍服务，或改用截图 + 坐标操作"
        }
        return out
    }

    /** 已启用的输入法包名：这些窗口置顶时不该抢走真正的应用窗口 */
    private fun imePackages(): Set<String> = runCatching {
        val imm = getSystemService(android.view.inputmethod.InputMethodManager::class.java)
        imm?.enabledInputMethodList?.mapNotNull { it.packageName }?.toSet() ?: emptySet()
    }.getOrDefault(emptySet())

    /** 当前全部窗口的速览（readScreen 结果里带一份，模型据此判断读的是哪个窗口） */
    private fun windowsSnapshot(): JSONArray {
        val arr = JSONArray()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return arr
        runCatching { windows }.getOrNull()?.forEach { w ->
            val r = runCatching { w.root }.getOrNull()
            arr.put(JSONObject().apply {
                put("pkg", r?.packageName?.toString() ?: "")
                put("active", w.isActive)
                put("focused", w.isFocused)
                put("children", runCatching { r?.childCount }.getOrDefault(0))
                put("layer", w.layer)
            })
        }
        return arr
    }

    /**
     * 发一条「操控在排队」的通知（纯告知，点它回 App 也能让队列继续）。
     *
     * @return 是否真的发出去了。Android 13+ 未授权通知时 `notify()` 会被静默丢弃，
     *   所以这里显式核对 `areNotificationsEnabled()`，把「发不出去」如实带进错误 hint。
     */
    private fun notifyQueued(action: String): Boolean = runCatching {
        val nm = getSystemService(android.app.NotificationManager::class.java) ?: return false
        nm.createNotificationChannel(
            android.app.NotificationChannel(
                CHANNEL_WAIT, "操控排队提醒", android.app.NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "后台操控等你放下手机时，告知它还在排队" },
        )
        if (!nm.areNotificationsEnabled()) return false
        val back = android.content.Intent(this, ai.deepseek.harness.mobile.MainActivity::class.java).apply {
            addFlags(
                android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                    android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
        }
        val pi = android.app.PendingIntent.getActivity(
            this, 0, back,
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = android.app.Notification.Builder(this, CHANNEL_WAIT)
            .setSmallIcon(ai.deepseek.harness.mobile.R.drawable.ic_notify)
            .setContentTitle("操控在排队")
            .setContentText("$action 会占用你的屏幕；放下手机后自动继续")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        nm.notify(NOTI_WAIT, n)
        true
    }.getOrDefault(false)

    /** 敏感界面采样缓存：键 = (界面代数, 前台包名)，界面没变就不重走全树 */
    private class TextSample(val epoch: Long, val pkg: String, val text: String)

    @Volatile
    private var textSample: TextSample? = null

    /** 敏感界面判定用的屏幕文本（截断，够命中「确认支付」「发送」这类按钮文案即可） */
    private fun screenTextSample(roots: List<AccessibilityNodeInfo>, limit: Int = 6000): String {
        if (roots.isEmpty()) return ""
        val pkg = roots.firstOrNull()?.packageName?.toString().orEmpty()
        val epoch = uiTracker.epoch()
        // 每次点击/输入都要过敏感词采样，之前是无条件全树走一遍：连续操作同一屏
        // （多开关、失败重试、form_fill 外的逐字段写入）全是重复劳动。界面代数没变
        // = 没产生过任何无障碍事件，可见文本不可能变（自绘界面本来就不贡献文本）
        textSample?.takeIf { it.epoch == epoch && it.pkg == pkg }?.let { return it.text }
        val sb = StringBuilder()
        fun walk(n: AccessibilityNodeInfo, depth: Int) {
            if (sb.length >= limit || depth > 24) return
            val t = n.text?.toString().orEmpty()
            if (t.isNotBlank()) sb.append(t).append(' ')
            val cd = n.contentDescription?.toString().orEmpty()
            if (cd.isNotBlank()) sb.append(cd).append(' ')
            for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
        }
        for (r in roots) walk(r, 0)
        val sample = sb.toString().take(limit)
        textSample = TextSample(epoch, pkg, sample)
        return sample
    }

    /** 批量动作（form_fill）外层已确认过：内层逐字段的 set_text 不再追问，避免刷屏 */
    private val suppressScreenGate = java.lang.ThreadLocal<Boolean>()

    /** 敏感界面逐次确认；允许返回 null，拒绝返回结构化错误 JSON */
    private fun guardScreen(action: String): String? {
        if (suppressScreenGate.get() == true) return null
        // 后台不抢屏：用户正在用手机时先排队（读屏 / 截图不走这里，不受影响）
        awaitScreenFree(action)?.let { return it }
        // 完全访问：反正不问，就不必为「要不要问」去采一遍全树文本 ——
        // 这是每次点击 300–500ms 的隐藏成本，端到端实测里 phone_tap 从 1260ms 降下来的关键。
        if (PhoneControlService.approval.isFullAccess()) return null
        val roots = contentRoots()
        val d = PhoneControlService.approval.guardScreen(
            action,
            roots.firstOrNull()?.packageName?.toString(),
            screenTextSample(roots),
            PhoneControlService.currentGate(),
        )
        return if (d.allowed) null else deniedJson(d)
    }

    /* ---------------- 操控事件与悬浮窗宿主（内容归插件） ---------------- */

    /** 报一次操控动作（工具线程安全；runCatching 保证展示层异常不碰工具） */
    private fun reportControl(kind: String, brief: String, detail: String) {
        runCatching { PhoneControlService.controlObserver?.invoke(kind, brief, detail) }
    }

    /**
     * 悬浮窗宿主：TYPE_ACCESSIBILITY_OVERLAY 只能由无障碍服务创建，服务只当
     * 窗口壳 —— 画什么、何时显示、窗口参数（含触摸穿透），全是插件的事
     * （ControlIslandPlugin）。操控类悬浮窗必须自带 FLAG_NOT_TOUCHABLE。
     */
    fun attachOverlay(view: android.view.View, params: WindowManager.LayoutParams) {
        val wm = getSystemService(WindowManager::class.java)
        mainHandler.post { runCatching { wm?.addView(view, params) } }
    }

    fun detachOverlay(view: android.view.View) {
        val wm = getSystemService(WindowManager::class.java)
        mainHandler.post { runCatching { wm?.removeViewImmediate(view) } }
    }

    /**
     * 改已挂载窗口的尺寸/位置（灵动岛原地展开成卡片时逐帧调用）。
     *
     * 与 attach/detach 不同：调用方已在主线程且是**逐帧动画**，再 post 会让帧
     * 全部堆到消息队列里、动画结束才一起执行，所以主线程直接改；其它线程才补 post。
     */
    fun updateOverlay(view: android.view.View, params: WindowManager.LayoutParams) {
        val wm = getSystemService(WindowManager::class.java)
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            runCatching { wm?.updateViewLayout(view, params) }
        } else {
            mainHandler.post { runCatching { wm?.updateViewLayout(view, params) } }
        }
    }

    /* ---------------- 观察：读屏 ---------------- */

    /** 界面变化代数跟踪（事件基建，见 UiChangeTracker；纯 JVM 可单测） */
    private val uiTracker = UiChangeTracker()

    /**
     * 点击/输入类操作后的便宜校验：两轮等待界面变化（1×timeout + 未变再补 0.5×），
     * 结果附 ui_changed。条件重试的是「等待」而非操作 —— 绝不循环重试操作本身，
     * 界面没变就让模型拿着三态 note 自己决定下一步（重试或 screen_read）。
     */
    /**
     * 操作后「界面变了没」的便宜校验。
     *
     * 450ms 是实测折中：绝大多数点击 100–300ms 内就有窗口事件，第一轮就能命中；
     * 没命中时 [UiChangeTracker.awaitChangeSteady] 会按「这期间有没有事件」决定
     * 第二轮只补 112ms 还是 225ms。旧值 600 让每次点击固定多花 ~300ms，
     * 一个十步任务就是三秒纯等待。
     */
    private fun withUiCheck(
        raw: String,
        sinceEpoch: Long,
        timeoutMs: Long = 450,
        /** 动作**之前**的节点指纹；给了就在「界面确实变化」时附 diff，替代重截图 */
        beforePrints: Map<String, String>? = null,
    ): String {
        if (isOnMainThread()) return raw // 主线程发起的防御分支不能 sleep
        val r = runCatching { JSONObject(raw) }.getOrNull() ?: return raw
        if (!r.optBoolean("ok")) return raw // 失败结果无需校验
        val v = uiTracker.awaitChangeSteady(sinceEpoch, timeoutMs,
            sleep = { Thread.sleep(it) }, now = { System.currentTimeMillis() })
        r.put("ui_changed", v.changed)
        // 变了才 diff：模型真正想知道的是「变成了什么」，而不是「变了」。
        // 没变化时不花这一次全树遍历（省 ~50ms），note 里已经说明可能没点中。
        if (v.changed && beforePrints != null) {
            val after = runCatching { fingerprintsNow() }.getOrDefault(emptyMap())
            if (after.isNotEmpty()) r.put("diff", ScreenOutline.diff(beforePrints, after))
        }
        val note = r.optString("note")
        r.put("note", when {
            v.changed && v.rounds == 1 ->
                if (note.isBlank()) "界面已变化，操作可能已生效" else "$note；界面已变化"
            v.changed ->
                if (note.isBlank()) "界面已变化（延迟约 ${v.elapsedMs}ms），操作可能已生效" else "$note；界面已变化（延迟约 ${v.elapsedMs}ms）"
            else -> {
                val msg = "连续两轮等待（共 ${v.elapsedMs}ms）界面均未变化：可能操作未生效，" +
                    "或为自绘界面（不产生无障碍事件）；建议 screen_read 确认后再决定是否重试"
                if (note.isBlank()) msg else "$note；$msg"
            }
        })
        return r.toString()
    }

    /**
     * 读取当前屏幕的结构化大纲：前台应用 + 可交互元素（文本/角色/id/边界/状态）
     * + 页面文本。maxElements 控制返回密度，默认 60。
     */
    fun readScreen(maxElements: Int = 60, settleMs: Int = 200, since: String? = null): String {
        // 过渡动画 / 列表滚动惯性还没落定时读屏会读到半截。
        // 事件驱动：界面已静默 ≥150ms（稳态）直接跳过等待，每次读屏省 200ms；
        // 刚有事件才补睡，上限仍是 settleMs（事件基建见 UiChangeTracker）
        if (settleMs > 0 && uiTracker.msSinceLastEvent(System.currentTimeMillis()) < 150) {
            runCatching { Thread.sleep(settleMs.toLong().coerceIn(0, 3000)) }
        }
        // 快照缓存：界面代数没变（无任何无障碍事件）就复用上一次结果。
        // 命中时仍刷新 snapshot token —— 指向同一批节点，避免 LRU 挤掉旧 token
        // 之后按 index 定位失效。
        val epochNow = uiTracker.epoch()
        treeCache?.takeIf { it.epoch == epochNow && it.maxElements == maxElements }?.let { c ->
            val s = synchronized(snapLock) {
                val t = "s${++snapSeq}"
                val snap = Snap(c.elementNodes, c.epoch, c.fingerprints)
                snapshots[t] = snap
                t to snap
            }
            val obj = JSONObject(c.json).put("snapshot", s.first).put("cached", true)
            since?.let { token ->
                snapshotOf(token)?.fingerprints?.takeIf { it.isNotEmpty() }?.let { before ->
                    obj.put("diff", diffFingerprints(before, c.fingerprints))
                }
            }
            return obj.toString()
        }
        // 真实显示区每次读屏只取一次：getRealMetrics 是进 WindowManager 的 binder 调用
        val display = realDisplaySize()
        // ×25（默认 60 → 1500 节点）：×12 会在大页面上把底部元素截掉
        val budget = maxElements * 25

        val snaps = ArrayList<ScreenOutline.NodeSnap>()
        val liveNodes = ArrayList<AccessibilityNodeInfo>()
        var visited = 0
        var visibleNodes = 0

        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            // 预算按**可见节点**算：不可见容器不占名额，但遍历总数仍设上限防病态深树
            if (visibleNodes > budget || visited++ > budget * 8) return
            if (depth > 30) return // 防病态深树（与 allWindowTexts/screenHasText 的先例一致）
            val bounds = Rect().also { node.getBoundsInScreen(it) }
            val onScreen = node.isVisibleToUser && bounds.bottom > bounds.top &&
                bounds.right > bounds.left && bounds.top < display.y && bounds.bottom > 0
            if (onScreen) visibleNodes++
            val clickable = node.isClickable || node.isLongClickable
            val editable = node.isEditable || node.className?.toString().orEmpty().contains("EditText")
            val scrollable = node.isScrollable
            val fullId = runCatching { node.viewIdResourceName }.getOrNull().orEmpty()
            val cd = runCatching { node.contentDescription?.toString() }.getOrNull().orEmpty()
            val pkg = runCatching { node.packageName?.toString() }.getOrNull().orEmpty()
            val own = ownText(node)
            // 只收「可见」或「有 id / 文本 / 可交互」的节点：纯空容器不进树（控制体积）。
            // **关键改动**：isVisibleToUser 从「准入条件」降级为输出字段 —— WebView /
            // Compose 自绘 / 部分国产 ROM 会对整树返回 false，以前 elements 因此全空。
            val keep = onScreen || fullId.isNotBlank() || own.isNotBlank() || cd.isNotBlank() ||
                clickable || editable || scrollable
            if (keep) {
                // 聚合标签只给交互元素算：texts 大纲只吃 ownText，非交互容器再聚
                // 后代是纯浪费 —— 同一批后代 walk 马上会自己遍历
                val label = own.ifBlank { if (clickable || editable || scrollable) labelOf(node) else "" }
                // 采集判定快照；同一块 bounds 去重 / 门槛 / JSON 组装在 ScreenOutline（纯函数，可单测）
                snaps.add(ScreenOutline.NodeSnap(
                    ownText = own,
                    label = label,
                    cls = simpleClass(node),
                    id = fullId.substringAfterLast('/'),
                    clickable = clickable,
                    editable = editable,
                    scrollable = scrollable,
                    checkable = node.isCheckable,
                    checked = if (node.isCheckable) node.isChecked else null,
                    enabled = node.isEnabled,
                    l = bounds.left, t = bounds.top, r = bounds.right, b = bounds.bottom,
                    visible = onScreen,
                    resId = fullId,
                    cd = cd.take(200),
                    pkg = pkg,
                    depth = depth,
                ))
                liveNodes.add(node)
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                walk(child, depth + 1)
            }
        }

        var roots = contentRoots()
        fun collect() {
            for (r in roots) walk(r, 0)
        }
        collect()
        var outline = ScreenOutline.build(snaps, maxElements)
        var attempts = 1
        if (outline.elements.length() == 0 && roots.isNotEmpty()) {
            // 空结果 ≠ 屏幕真没内容：微信冷启动/切页时内容异步加载，读早了整棵树是空的。
            // 等一次窗口/内容事件（≤900ms）再读，而不是把空列表丢给模型。
            val before = uiTracker.epoch()
            uiTracker.awaitChange(before, 900, sleep = { Thread.sleep(it) }, now = { System.currentTimeMillis() })
            snaps.clear(); liveNodes.clear(); visited = 0
            roots = contentRoots()
            collect()
            outline = ScreenOutline.build(snaps, maxElements)
            attempts = 2
        }
        val root = roots.firstOrNull()
        // index 定位必须与 elements **同序**：以前存的是全量 liveNodes，而 elements[0]
        // 是第 0 个「可交互」节点 —— 列表里第一个是标题 TextView 时，index=0 会点错节点。
        // elementSnaps 早就备好了映射，只是一直没被用上。
        val elementNodes = outline.elementSnaps.mapNotNull { liveNodes.getOrNull(it) }
        val prints = fingerprintsOf(snaps)
        val snap = synchronized(snapLock) {
            val t = "s${++snapSeq}"
            val s = Snap(elementNodes, uiTracker.epoch(), prints)
            snapshots[t] = s
            t to s
        }
        val text = JSONObject().apply {
            put("ok", true)
            put("app", root?.packageName?.toString() ?: "")
            // 真实屏幕尺寸（与 bounds / 手势同一坐标系）：模型做「屏幕下方 /
            // 右侧边缘」这类坐标推理的依据，没有它坐标只能靠猜
            put("screen", JSONObject().put("w", display.x).put("h", display.y))
            put("elements", outline.elements)
            put("texts", outline.texts)
            // 结构化节点树：可见节点 + 带 res_id 的不可见节点。elements 只装可交互的，
            // 很多控件（输入框容器、列表项）没有 clickable 但有 resource-id，
            // 模型靠 nodes 里的 res_id 精准定位，不必再用坐标蒙。
            put("nodes", outline.nodes)
            put("interactive_count", outline.elements.length())
            put("node_count", outline.nodes.length())
            put("snapshot", snap.first)   // index 定位时回传它，跨会话/子代理互不串扰
            put("epoch", snap.second.epoch)
            put("windows", windowsSnapshot()) // 模型据此知道读的是哪几个窗口
            windowMergeNote?.let {
                put("window_note", it)
                put("note", it)
            }
            // since=<上一次 snapshot>：顺手给出新旧树的差异，省一次重读/重截图
            since?.let { token ->
                snapshotOf(token)?.fingerprints?.takeIf { it.isNotEmpty() }?.let { before ->
                    put("diff", diffFingerprints(before, prints))
                }
            }
            if (outline.elements.length() == 0 && outline.nodes.length() == 0) {
                // 节点树拿不到内容：这应用自绘/不向无障碍暴露（游戏、银行、canvas UI）。
                // 标记 visual_needed，插件层自动截屏注入对话 —— 模型看图换算坐标继续操控。
                put("visual_needed", true)
                put("attempts", attempts)
                put("note", "节点树无内容（应用自绘或未向无障碍暴露），已请求附屏幕截图；" +
                    "看图直接用 phone_tap x,y 换算坐标操作")
                put("diag", JSONObject().apply {
                    put("visited", visited)
                    put("on_screen_nodes", snaps.count { it.visible })
                    put("kept_nodes", snaps.size)
                    put("active_pkg", rootInActiveWindow?.packageName?.toString() ?: "")
                    put("roots", roots.size)
                })
            }
            if (outline.truncated) put("truncated", true)
            if (visited > budget * 8) put("truncated_walk", true) // 与 truncated（元素满）区分：这是遍历预算满
        }.toString()
        treeCache = TreeCache(uiTracker.epoch(), maxElements, text, elementNodes, prints)
        return text
    }

    /**
     * screen_read 结果缓存：界面代数（epoch）没变就直接复用上一次的 JSON。
     *
     * 为什么安全：epoch 只有在无障碍事件（窗口/内容/焦点变化）时才递增，同一屏反复
     * 读屏不会产生事件。命中时仍会分配新的 snapshot token（指向同一批节点），
     * 避免 LRU 把旧 token 挤掉后 index 定位失效。
     */
    private class TreeCache(
        val epoch: Long,
        val maxElements: Int,
        val json: String,
        val elementNodes: List<AccessibilityNodeInfo>,
        val fingerprints: Map<String, String>,
    )

    @Volatile
    private var treeCache: TreeCache? = null

    /** 节点指纹：`pkg|resId|cls|bounds` → `label|checked`，用于新旧屏 diff */
    private fun fingerprintsOf(snaps: List<ScreenOutline.NodeSnap>): Map<String, String> {
        val m = HashMap<String, String>(snaps.size * 2)
        for (s in snaps) {
            if (!s.visible) continue
            m[ScreenOutline.fingerprintKey(s.pkg, s.resId, s.cls, s.l, s.t, s.r, s.b)] =
                ScreenOutline.fingerprintValue(s.label, s.checked)
        }
        return m
    }

    /** 新屏相对旧屏的增/删/改 —— 纯逻辑在 ScreenOutline.diff（JVM 可测） */
    private fun diffFingerprints(before: Map<String, String>, after: Map<String, String>): JSONObject =
        ScreenOutline.diff(before, after)

    /**
     * 批量动作：一次提交多步（点 A → 等 B → 打字 → 点 C），中间不回传，末尾统一确认。
     *
     * 为什么要它：每一步单独一个工具调用 = 一次模型往返（几百毫秒到几秒），
     * 4 步就是 4 个往返，而其中 3 步的结果模型根本不需要看。批量把往返压成 1 次，
     * 只在末尾给一份「每步结果 + 整屏 diff」—— 点没点中，看 diff 就知道，不用重截图。
     *
     * 纪律：任一步失败即停（除非 stop_on_error=false），`stopped_at` 指出停在第几步；
     * 每步之间按动作类型给一点节流（点击 220ms / 输入 90ms），避免下一步点在旧界面上。
     */
    fun batch(args: JSONObject): String {
        val steps = args.optJSONArray("steps")
            ?: return err("BAD_ARGS", "steps 必须是数组，每项 {action, ...}")
        if (steps.length() == 0) return err("BAD_ARGS", "steps 不能为空")
        if (steps.length() > 8) return err("BAD_ARGS", "一次最多 8 步，再多请拆成两批（失败定位更容易）")
        val stopOnError = args.optBoolean("stop_on_error", true)
        val before = runCatching { fingerprintsNow() }.getOrDefault(emptyMap())
        val results = JSONArray()
        var failed = 0
        var stoppedAt = 0
        for (i in 0 until steps.length()) {
            val st = steps.optJSONObject(i) ?: continue
            val action = st.optString("action").trim().lowercase()
            val t0 = System.currentTimeMillis()
            val raw = runCatching { step(action, st) }
                .getOrElse { err("STEP_FAILED", "第 ${i + 1} 步（$action）抛异常：${it.message}") }
            val obj = runCatching { JSONObject(raw) }.getOrNull()
                ?: JSONObject().put("ok", true).put("raw", raw)
            val ok = obj.optBoolean("ok", true)
            obj.put("step", i + 1).put("action", action).put("ms", System.currentTimeMillis() - t0)
            results.put(obj)
            if (!ok) {
                failed++
                if (stoppedAt == 0) stoppedAt = i + 1
                if (stopOnError) break
            }
            val gap = when (action) {
                "tap", "tap_text", "tap_id", "tap_index" -> 220L
                "type", "set_text" -> 90L
                else -> 0L
            }
            if (gap > 0 && i < steps.length() - 1) runCatching { Thread.sleep(gap) }
        }
        val after = runCatching { fingerprintsNow() }.getOrDefault(emptyMap())
        return JSONObject().apply {
            put("ok", failed == 0)
            put("steps", steps.length())
            put("done", results.length())
            put("failed", failed)
            if (stoppedAt > 0) put("stopped_at", stoppedAt)
            put("results", results)
            // 整批的净效果：一次 diff 说明这几步到底改变了什么
            put("diff", diffFingerprints(before, after))
            put("epoch", uiTracker.epoch())
        }.toString()
    }

    /** 单步分派：只复用已有的公开动作方法，不另写一套点击/输入实现 */
    private fun step(action: String, st: JSONObject): String = when (action) {
        "tap" -> {
            val idx = if (st.has("index")) st.optInt("index") else null
            val id = st.optString("id").takeIf { it.isNotBlank() }
            val text = st.optString("text").takeIf { it.isNotBlank() }
            when {
                idx != null -> tapIndex(idx, st.optString("snapshot").takeIf { it.isNotBlank() })
                id != null -> tapId(id)
                text != null -> tapText(text, st.optBoolean("exact", false), st.optInt("ordinal", 1))
                st.has("x") && st.has("y") -> tap(st.optInt("x"), st.optInt("y"))
                else -> err("BAD_STEP", "tap 需要 index / id / text / x+y 之一")
            }
        }
        "type", "set_text" -> {
            val id = st.optString("id").takeIf { it.isNotBlank() }
            val idx = if (st.has("index")) st.optInt("index") else null
            val value = st.optString("text")
            if (id != null || idx != null) {
                setText(idx, id, null, value, st.optString("snapshot").takeIf { it.isNotBlank() })
            } else {
                type(value)
            }
        }
        "wait" -> {
            Thread.sleep(st.optInt("ms", 300).coerceIn(50, 3000).toLong())
            JSONObject().put("ok", true).put("waited_ms", st.optInt("ms", 300)).toString()
        }
        "swipe" -> swipe(
            st.optInt("x1"), st.optInt("y1"), st.optInt("x2"), st.optInt("y2"),
            st.optInt("durationMs", 300).toLong(),
        )
        "scroll" -> scroll(
            st.optString("direction", "down"),
            st.optString("text").takeIf { it.isNotBlank() },
            st.optInt("pages", 1),
        )
        "open_app" -> openApp(st.optString("package"))
        else -> err("BAD_STEP", "不支持的 action：$action（可用 tap/type/wait/swipe/scroll/open_app）")
    }

    /** 轻量指纹：只走深度 12 / 300 节点、不聚合标签、不建 JSON —— 比整次读屏便宜得多 */
    private fun fingerprintsNow(): Map<String, String> {
        val m = HashMap<String, String>()
        var n = 0
        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > 12 || n > 300) return
            n++
            val b = Rect().also { node.getBoundsInScreen(it) }
            val visible = node.isVisibleToUser && b.bottom > b.top && b.right > b.left
            if (visible) {
                val pkg = runCatching { node.packageName?.toString() }.getOrNull().orEmpty()
                val id = runCatching { node.viewIdResourceName }.getOrNull().orEmpty()
                val cls = simpleClass(node)
                val text = ownText(node)
                val checked = if (node.isCheckable) node.isChecked else null
                m[ScreenOutline.fingerprintKey(pkg, id, cls, b.left, b.top, b.right, b.bottom)] =
                    ScreenOutline.fingerprintValue(text, checked)
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, depth + 1) }
        }
        for (r in contentRoots()) walk(r, 0)
        return m
    }

    /**
     * screen_read 快照存储：token → (节点列表, 读取时的界面代数)。LRU 上限 4 份。
     * 此前是全局单例 lastNodes：主 Agent 与子代理/队友并发 screen_read 时互相覆盖
     * （只读工具进并发池），「最稳的 index 定位」变成跨 Agent 歧义索引。
     * 工具层可显式传 token；缺省取最新一份 —— 与旧行为完全一致，向后兼容。
     */
    private class Snap(
        /** 与 elements 同序的节点列表（index 定位用它，不再存全量节点） */
        val nodes: List<AccessibilityNodeInfo>,
        val epoch: Long,
        /** 这屏的节点指纹，供 since=<token> 的 diff 用 */
        val fingerprints: Map<String, String> = emptyMap(),
    )

    private val snapLock = Any()
    private val snapshots = object : LinkedHashMap<String, Snap>(8, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Snap>): Boolean = size > 4
    }
    private var snapSeq = 0

    private fun snapshotOf(token: String?): Snap? = synchronized(snapLock) {
        if (token.isNullOrBlank()) snapshots.values.lastOrNull() else snapshots[token]
            ?: snapshots.values.lastOrNull()
    }

    /** 快照是否已明显过期（读取后界面又发生了 ≥2 批变化） */
    private fun snapshotStale(token: String?): Boolean {
        val e = snapshotOf(token)?.epoch ?: return false
        return uiTracker.epoch() - e >= 2
    }

    private fun appendStaleNote(raw: String): String {
        val r = runCatching { JSONObject(raw) }.getOrNull() ?: return raw
        val note = r.optString("note")
        r.put("note", (if (note.isBlank()) "" else "$note；") +
            "screen_read 快照已过期（界面此后有变化），建议重读")
        return r.toString()
    }

    /* ---------------- 操作 ---------------- */

    /** 按屏幕坐标点击（无障碍手势，等价桌面鼠标点击） */
    fun tap(x: Int, y: Int): String {
        guardScreen("点击坐标 ($x, $y)")?.let { return it }
        reportControl("tap", "点击", "点击 ($x, $y)")
        return tapAt(x, y)
    }

    /**
     * 真正的坐标点击（已过闸门）。clickNode 的坐标退化路径复用它，
     * 否则同一次点击会在敏感界面连问两遍。
     */
    private fun tapAt(x: Int, y: Int): String {
        val bp = runCatching { fingerprintsNow() }.getOrDefault(emptyMap())
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 80))
            .build()
        val raw = dispatchAndReport(gesture, "点击 ($x, $y)")
        return withUiCheck(raw, uiTracker.epoch(), beforePrints = bp)
    }

    /**
     * 按文本/资源 id 点击：优先节点 performAction(CLICK)，其次按可点祖先，最后按坐标派发手势。
     * [ordinal] 指定第几个同名元素（1 起；列表里多个「更多」时不再永远点第一个）。
     */
    fun tapText(text: String, exact: Boolean = false, ordinal: Int = 1): String {
        if (text.isBlank()) return err("BAD_TEXT", "text 不能为空")
        guardScreen("点击「$text」")?.let { return it }
        val all = findNodesRetry(text, exact)
        if (all.isEmpty()) return JSONObject().apply {
            put("ok", false); put("code", "NOT_FOUND")
            put("error", "屏幕上没有找到「$text」")
            put("hint", "先用 screen_read 看当前屏幕有哪些元素")
        }.toString()
        val n = all.size
        if (ordinal > n || ordinal < 1) return JSONObject().apply {
            put("ok", false); put("code", "NOT_FOUND")
            put("error", "「$text」匹配到 $n 个元素，ordinal=$ordinal 越界")
            put("matched", n)
            put("hint", NodeMatch.ordinalHint(n))
        }.toString()
        val picked = all[ordinal - 1].let { if (it.isVisibleToUser) it else scrollIntoView(it) }
        return clickNode(picked, if (n > 1) "$text（第 $ordinal/$n 个）" else text)
    }

    /** 按资源 id 点击（比文本稳定，等价桌面按 selector 定位） */
    fun tapId(id: String): String {
        guardScreen("点击资源 id「$id」")?.let { return it }
        val nodes = contentRoots().firstNotNullOfOrNull { root ->
            root.findAccessibilityNodeInfosByViewId(fullId(id)).orEmpty().filter { it.isVisibleToUser }
        } ?: emptyList()
        val hit = nodes.firstOrNull() ?: return JSONObject().apply {
            put("ok", false); put("code", "NOT_FOUND")
            put("error", "没有找到资源 id：$id")
        }.toString()
        return clickNode(hit, id)
    }

    /** 长按（节点 ACTION_LONG_CLICK，退化为长按手势） */
    fun longPress(text: String, durationMs: Long = 700): String {
        guardScreen("长按「$text」")?.let { return it }
        reportControl("long", "长按", "长按「$text」")
        val node = findNodeRetry(text, exact = false) ?: return JSONObject().apply {
            put("ok", false); put("code", "NOT_FOUND"); put("error", "屏幕上没有找到「$text」")
        }.toString()
        val target = clickableAncestor(node) ?: node
        if (target.isLongClickable && target.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) {
            return JSONObject().put("ok", true).put("via", "node").put("text", text)
                .put("note", "已长按「$text」").toString()
        }
        val b = Rect().also { target.getBoundsInScreen(it) }
        if (b.isEmpty) return err("NOT_FOUND", "元素没有可用的布局边界")
        val path = Path().apply { moveTo(b.centerX().toFloat(), b.centerY().toFloat()) }
        val g = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(
                path, 0, durationMs.coerceIn(400, 4000)))
            .build()
        return dispatchAndReport(g, "长按 (${b.centerX()}, ${b.centerY()})")
    }

    /** 滑动（惯性由时长近似控制） */
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long = 300): String {
        awaitScreenFree("滑动 ($x1,$y1)→($x2,$y2)")?.let { return it }
        reportControl("swipe", "滑动", "滑动 ($x1,$y1)→($x2,$y2)")
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(50, 5000)))
            .build()
        return dispatchAndReport(gesture, "滑动 ($x1,$y1)→($x2,$y2)")
    }

    /** 方向滑动（默认从屏幕中下部往上 = 上滑翻页） */
    fun swipeDirection(direction: String, distance: Int = 600): String {
        // 手势坐标在整屏坐标系（见 realDisplaySize）；displayMetrics 不含系统栏，
        // 以前算出的起点整体偏移半条导航栏
        val size = realDisplaySize()
        val w = size.x
        val h = size.y
        val cx = w / 2
        return when (direction.lowercase()) {
            "up" -> swipe(cx, (h * 0.75).toInt(), cx, (h * 0.75).toInt() - distance)
            "down" -> swipe(cx, (h * 0.25).toInt(), cx, (h * 0.25).toInt() + distance)
            "left" -> swipe((w * 0.8).toInt(), h / 2, (w * 0.8).toInt() - distance, h / 2)
            "right" -> swipe((w * 0.2).toInt(), h / 2, (w * 0.2).toInt() + distance, h / 2)
            else -> err("BAD_DIRECTION", "direction 只支持 up/down/left/right，收到：$direction")
        }
    }

    /**
     * 滚动列表 —— 比坐标滑动更可靠（对齐桌面 Cua 的 scroll 语义）：
     * 优先对「含目标文本的可滚动容器」派发 ACTION_SCROLL_FORWARD/BACKWARD，
     * 容器不可滚动时退化为屏幕方向滑动。
     */
    fun scroll(direction: String, text: String? = null, pages: Int = 1): String {
        val forward = when (direction.lowercase()) {
            "down", "forward", "next" -> true
            "up", "backward", "prev", "previous" -> false
            else -> return err("BAD_DIRECTION", "direction 只支持 up/down")
        }
        awaitScreenFree("滚动 $direction")?.let { return it }
        reportControl("scroll", "滚动", "滚动 $direction")
        val roots = contentRoots()
        if (roots.isEmpty()) return err("NO_WINDOW", "拿不到当前窗口")
        val container = if (!text.isNullOrBlank()) {
            findNode(text, exact = false)?.let { scrollableAncestor(it) }
        } else roots.firstNotNullOfOrNull { firstScrollable(it) }
        val action = if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        var done = 0
        if (container != null) {
            repeat(pages.coerceIn(1, 5)) {
                if (container.performAction(action)) done++ else return@repeat
            }
        }
        if (done > 0) {
            return JSONObject().put("ok", true).put("via", "node")
                .put("pages", done).put("direction", direction).toString()
        }
        // 退化：手势滑动（部分应用的自绘列表不响应无障碍滚动）
        val gestureResult = swipeDirection(if (forward) "up" else "down", 700)
        return JSONObject(gestureResult).put("via", "gesture")
            .put("note", "容器不响应无障碍滚动，已改用手势滑动").toString()
    }

    /**
     * 等待界面稳定 / 等待目标出现（桌面 Cua 的 wait 等价物）。
     * text 为空时只做稳定等待（过渡动画、列表滚动惯性都需要时间落定）。
     */
    fun waitFor(text: String?, timeoutMs: Long = 5000): String {
        reportControl("wait", "等待", if (text.isNullOrBlank()) "等待界面落定" else "等待「$text」")
        val start = System.currentTimeMillis()
        val limit = timeoutMs.coerceIn(200, 30000)
        if (text.isNullOrBlank()) {
            Thread.sleep(limit.coerceAtMost(3000))
            return JSONObject().put("ok", true).put("waited_ms", limit.coerceAtMost(3000))
                .put("note", "已等待界面落定").toString()
        }
        while (System.currentTimeMillis() - start < limit) {
            if (findNode(text, exact = false) != null) {
                return JSONObject().apply {
                    put("ok", true)
                    put("text", text)
                    put("elapsed_ms", System.currentTimeMillis() - start)
                    put("note", "「$text」已出现")
                }.toString()
            }
            Thread.sleep(200)
        }
        return JSONObject().apply {
            put("ok", false); put("code", "TIMEOUT")
            put("error", "${limit}ms 内没有等到「$text」")
            put("hint", "先用 screen_read 看当前界面；也可能是点错了地方")
        }.toString()
    }

    /** 向焦点输入框写入文本 */
    fun type(text: String): String {
        if (text.isEmpty()) return err("EMPTY_TEXT", "text 不能为空")
        guardScreen("向输入框写入 ${text.length} 字符")?.let { return it }
        reportControl("text", "输入", "输入 ${text.length} 字")
        val focus = contentRoots().firstNotNullOfOrNull { it.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
            ?: return err("NO_FOCUS", "当前没有获得焦点的输入框", "先用 phone_tap 点一下目标输入框再输入")
        if (!focus.isEditable && !focus.className?.toString().orEmpty().contains("EditText")) {
            return err("NOT_EDITABLE", "焦点元素不是输入框：${focus.className}")
        }
        val args = android.os.Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val ok = focus.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        return JSONObject().apply {
            put("ok", ok)
            put("chars", text.length)
            put("note", if (ok) "已写入 ${text.length} 字符" else "输入框拒绝了本次写入")
        }.toString()
    }

    /** 系统级按键（桌面 Cua 的 hotkey 等价物） */
    fun key(action: String): String {
        val a = action.lowercase()
        // lock_screen 本身就是「把屏幕让出来」的动作，它自己不能排队等空闲（会死等）
        if (a != "lock" && a != "lock_screen") {
            awaitScreenFree("按键 $a")?.let { return it }
        }
        val global = when (a) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "power_dialog" -> GLOBAL_ACTION_POWER_DIALOG
            "lock", "lock_screen" -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                    return err("UNSUPPORTED", "Android 9 以下不支持锁屏动作")
                }
                GLOBAL_ACTION_LOCK_SCREEN
            }
            "split_screen", "split" -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                    return err("UNSUPPORTED", "Android 12 以下不支持分屏动作")
                }
                GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN
            }
            "take_screenshot", "screenshot" -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    return err("UNSUPPORTED", "Android 14 以下不支持全局截图动作",
                        "用 phone_screenshot（无障碍截图）代替")
                }
                GLOBAL_ACTION_TAKE_SCREENSHOT
            }
            "dismiss_shade", "close_shade" -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                    return err("UNSUPPORTED", "Android 12 以下不支持收起通知栏")
                }
                GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE
            }
            else -> return JSONObject().apply {
                put("ok", false); put("code", "BAD_KEY")
                put("error", "不支持的按键：$action")
                put("supported", JSONArray(listOf("back", "home", "recents", "notifications",
                    "quick_settings", "power_dialog", "lock_screen", "split_screen",
                    "take_screenshot", "dismiss_shade")))
            }.toString()
        }
        reportControl("key", "按键", "按键 $a")
        val ok = performGlobalAction(global)
        return JSONObject().apply {
            put("ok", ok); put("key", a)
            put("note", if (ok) "已发送" else "系统拒绝了该全局动作")
        }.toString()
    }

    /** 打开一个应用（按包名） */
    fun openApp(packageName: String): String {
        val intent = packageManager.getLaunchIntentForPackage(packageName)
            ?: return JSONObject().apply {
                put("ok", false); put("code", "APP_NOT_FOUND")
                put("error", "没有找到可启动的应用：$packageName")
                put("hint", "用 phone_list_apps 看已安装的应用")
            }.toString()
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        // 后台不抢屏：用户在别的应用里时先排队，他放下手机/回到 App 再继续。
        // 放在 guardTarget 之前 —— 否则后台会先弹一张没人看的审批卡、白等一轮再拒。
        awaitScreenFree("打开「$packageName」")?.let { return it }
        // 首次操作这个应用要一次授权（task/always 两级；敏感应用逐次）
        guardTarget(packageName, "启动应用")?.let { return it }
        reportControl("app", "打开应用", "打开 $packageName")
        return runCatching { startActivity(intent) }.fold(
            onSuccess = { JSONObject().put("ok", true).put("package", packageName).put("note", "已启动").toString() },
            onFailure = { e -> err("LAUNCH_FAILED", "启动失败：${e.message}") },
        )
    }

    /** 应用清单缓存：全量 PM 查询每个可启动应用一发 binder，装机清单 60s 内直接复用 */
    private class AppListCache(val atMs: Long, val apps: List<Pair<String, String>>)

    @Volatile
    private var appListCache: AppListCache? = null

    /** 列已安装的可启动应用（供模型选择） */
    fun listApps(limit: Int = 100): String {
        val pm = packageManager
        val now = System.currentTimeMillis()
        var apps = appListCache?.takeIf { now - it.atMs < 60_000 }?.apps
        if (apps == null) {
            apps = pm.getInstalledApplications(0)
                .filter { pm.getLaunchIntentForPackage(it.packageName) != null }
                .map {
                    it.packageName to runCatching { pm.getApplicationLabel(it).toString() }.getOrDefault("")
                }
            appListCache = AppListCache(now, apps)
        }
        val slice = apps.sortedBy { it.second }.take(limit.coerceIn(1, 300))
        return JSONObject().apply {
            put("ok", true); put("count", slice.size)
            put("apps", JSONArray(slice.map { (pkg, label) ->
                JSONObject().put("package", pkg).put("label", label)
            }))
        }.toString()
    }

    /** 用 Intent URI 唤起系统能力（打电话/短信/网页/设置/地图…桌面 launch 等价物） */
    fun launch(uri: String, action: String? = null): String {
        if (uri.isBlank()) return err("BAD_URI", "uri 不能为空")
        val intent = runCatching {
            android.content.Intent.parseUri(uri, android.content.Intent.URI_INTENT_SCHEME)
        }.getOrNull()
        if (intent == null) {
            return err("BAD_URI", "无法解析 Intent URI：$uri",
                "示例：https://… / tel:10086 / smsto:10086 / geo:39.9,116.4")
        }
        if (!action.isNullOrBlank()) intent.action = action
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        // 后台不抢屏（tel:/https: 同样会占屏），先排队再走授权
        awaitScreenFree("唤起 ${uri.take(48)}")?.let { return it }
        // Intent 唤起同样过应用闸门：tel:/smsto: 等按 scheme（+host）记授权键
        val decision = PhoneControlService.approval.guardIntent(uri, "用 Intent 唤起", PhoneControlService.currentGate())
        if (!decision.allowed) return deniedJson(decision)
        reportControl("app", "唤起", "唤起 ${uri.take(48)}")
        return runCatching { startActivity(intent) }.fold(
            onSuccess = { JSONObject().put("ok", true).put("uri", uri).put("note", "已发出").toString() },
            onFailure = { e -> err("NO_HANDLER", "没有应用能处理这个 Intent：${e.message}",
                "换个 URI，或先用 phone_list_apps 找对应应用") },
        )
    }

    /** 前台应用包名与窗口数（观察的补充） */
    fun foreground(): String {
        val root = rootInActiveWindow
        // 读取前台包名同样会暴露「模型正在操作哪个应用」：未知包先问一次
        root?.packageName?.toString()?.takeIf { it.isNotBlank() }?.let { pkg ->
            guardTarget(pkg, "读取前台应用")?.let { return it }
        }
        return JSONObject().apply {
            put("ok", root != null)
            put("app", root?.packageName?.toString() ?: "")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                put("note", "windows=${windows?.size ?: 0}")
            }
        }.toString()
    }

    /**
     * 截取当前屏幕（等价桌面 Cua 的 screenshot 观察手段）。
     * API 30+ 走 AccessibilityService.takeScreenshot；更低版本如实报不可用。
     * 输出 JPEG q85（PNG 是无损格式，compress 的 quality 参数对它完全无效，
     * 之前一张 1~2.5MB；JPEG 同尺寸 150~400KB）。落盘文件保持本格式高清；
     * 进对话的再压缩由工具层经 ImageResize 完成。失败原因写在 [lastShotError]。
     */
    @Volatile
    var lastShotError: String? = null
        private set

    fun screenshotJpeg(): ByteArray? {
        reportControl("shot", "截图", "截图")
        lastShotError = null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            lastShotError = "系统版本低于 Android 11，无障碍截图不可用"
            return null
        }
        // 截图回调走 mainExecutor：绝不能在主线程等，否则回调排队 → 死锁到超时
        // （实测：卡满 20s 后才在 await 超时那一刻回调）。
        if (isOnMainThread()) {
            lastShotError = "截图不能从主线程发起（会与回调互锁）"
            return null
        }
        val holder = arrayOfNulls<ByteArray>(1)
        val latch = java.util.concurrent.CountDownLatch(1)
        mainHandler.post { requestScreenshot(holder, latch) }
        // 实测回调通常 <1s；20s 的等待会把失败路径拖成整轮对话的灾难
        if (!latch.await(8, java.util.concurrent.TimeUnit.SECONDS)) {
            if (lastShotError == null) lastShotError = "截图超时（8s 没有回调）"
        }
        return holder[0]
    }

    /** 截图是否可用（用于工具层给出准确原因） */
    fun canScreenshot(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    /* ---------------- 精确定位：index / 表单 / 开关 ---------------- */

    /** 按 screen_read 返回的 index 点击（最稳的定位方式：不受同名文本干扰） */
    fun tapIndex(index: Int, token: String? = null): String {
        guardScreen("点击元素 #$index")?.let { return it }
        val stale = snapshotStale(token)
        var node = nodeAt(index, token)
        if (node == null) {
            // 节点失效（界面重绘）时重新读一次屏再取，避免"读屏后点空"
            runCatching { readScreen(60, 150) }
            node = nodeAt(index)
        }
        node ?: return err("STALE_INDEX",
            "index=$index 没有对应元素（界面可能已变化）", "重新 screen_read 再点")
        val raw = clickNode(node, "#$index")
        return if (stale) appendStaleNote(raw) else raw
    }

    /**
     * 给指定输入框写文本（不需要先点击聚焦，比 phone_type 更准）。
     * 目标可用 index / id / text 定位；省略则用当前焦点输入框。
     */
    fun setText(index: Int?, id: String?, text: String?, value: String, token: String? = null): String {
        guardScreen("向输入框写入 ${value.length} 字符")?.let { return it }
        reportControl("text", if (value.isEmpty()) "清空" else "输入",
            if (value.isEmpty()) "清空输入框" else "写入 ${value.length} 字")
        val field = when {
            index != null && index >= 0 -> nodeAt(index, token)
            !id.isNullOrBlank() -> findByViewId(id)
            !text.isNullOrBlank() -> findNodeRetry(text, exact = false)
            else -> contentRoots().firstNotNullOfOrNull { it.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
        } ?: return err("NOT_FOUND", "没有找到目标输入框", "先 screen_read 看 editable=true 的元素")

        val editable = editableSelf(field) ?: descendantEditable(field)
            ?: run {
                // 容器本身不可写：点一下再取焦点输入框
                clickNode(field, "输入框")
                Thread.sleep(250)
                contentRoots().firstNotNullOfOrNull { it.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
            }
            ?: return err("NOT_EDITABLE", "目标不可编辑：${field.className}",
                "可能被禁用，或需要先点击进入编辑态")

        val args = android.os.Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        }
        val before = uiTracker.epoch()
        val ok = editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        return withUiCheck(JSONObject().apply {
            put("ok", ok)
            put("chars", value.length)
            put("note", if (ok) "已写入 ${value.length} 字符" else "输入框拒绝了写入（可能只读）")
        }.toString(), before, timeoutMs = 400)
    }

    /** 清空输入框（等价桌面全选删除） */
    fun clearText(index: Int?, id: String?, text: String?, token: String? = null): String =
        setText(index, id, text, "", token)

    /** 提交输入（键盘上的完成/搜索键，等价桌面回车） */
    fun imeEnter(): String {
        guardScreen("提交输入框内容")?.let { return it }
        reportControl("text", "提交", "提交输入")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return err("UNSUPPORTED", "Android 11 以下无法直接派发 IME 动作",
                "改用 phone_tap 点界面上的「搜索/确定」按钮")
        }
        val focus = contentRoots().firstNotNullOfOrNull { it.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
            ?: return err("NO_FOCUS", "当前没有输入框在编辑")
        val ok = focus.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        return JSONObject().put("ok", ok).put("note", if (ok) "已提交" else "输入法拒绝了提交").toString()
    }

    /**
     * 开关切换：点一下并回报新状态（模型据此判断是否真的生效，
     * 而不是点完就假设成功）。
     */
    fun toggle(target: String, index: Int?, want: Boolean? = null, token: String? = null): String {
        guardScreen("切换「$target」")?.let { return it }
        reportControl("tap", "切换", "切换「$target」")
        val node = (if (index != null && index >= 0) nodeAt(index, token)
        else findNodeRetry(target, exact = false))
            ?: return err("NOT_FOUND", "屏幕上没有找到「$target」")
        val clickable = clickableAncestor(node) ?: node
        if (!node.isCheckable && !clickable.isCheckable) {
            return err("NOT_A_TOGGLE", "「$target」不是开关/复选项",
                "普通按钮请用 phone_tap")
        }
        val beforeState = if (node.isCheckable) node.isChecked else clickable.isChecked
        // 幂等：已经是目标状态就不点（避免把用户的设置改反）
        if (want != null && beforeState == want) {
            return JSONObject().put("ok", true).put("before", beforeState).put("after", beforeState)
                .put("unchanged", true).put("note", "已经是${if (want) "开" else "关"}，未改动").toString()
        }
        val epochBefore = uiTracker.epoch()
        val ok = clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        Thread.sleep(250)
        val fresh = if (index != null && index >= 0) nodeAt(index, token) else findNode(target, exact = false)
        val after = when {
            fresh == null -> null
            fresh.isCheckable -> fresh.isChecked
            else -> clickableAncestor(fresh)?.takeIf { it.isCheckable }?.isChecked
        }
        return withUiCheck(JSONObject().apply {
            put("ok", ok)
            put("before", beforeState)
            put("after", after)
            put("note", when {
                !ok -> "开关拒绝了点击"
                after == null -> "已点击，但读不回新状态"
                after != beforeState -> "已切换为 ${if (after) "开" else "关"}"
                else -> "点击后状态没变（可能需要更长动画，或该开关受策略限制）"
            })
        }.toString(), epochBefore, timeoutMs = 400)
    }

    /**
     * 批量填表：fields = [{label|index|id, value}]，逐项定位写入。
     * 等价桌面 CUA 的表单批处理，避免模型为每个字段单独来回。
     */
    fun formFill(fields: JSONArray, token: String? = null): String {
        if (fields.length() == 0) return err("BAD_ARGS", "fields 不能为空")
        guardScreen("批量填写 ${fields.length()} 个字段")?.let { return it }
        val results = JSONArray()
        var okCount = 0
        val prevSuppress = suppressScreenGate.get()
        suppressScreenGate.set(true)
        try {
            for (i in 0 until fields.length()) {
                val f = fields.optJSONObject(i) ?: continue
                val label = f.optString("label", f.optString("text"))
                val idx = if (f.has("index")) f.optInt("index") else null
                val vid = f.optString("id").ifBlank { null }
                val value = f.optString("value")
                val raw = setText(idx, vid, label.ifBlank { null }, value, token)
                val obj = runCatching { JSONObject(raw) }.getOrDefault(JSONObject().put("ok", false))
                if (obj.optBoolean("ok")) okCount++
                results.put(JSONObject().apply {
                    put("field", label.ifBlank { vid ?: "#$idx" })
                    put("ok", obj.optBoolean("ok"))
                    obj.optString("code").takeIf { it.isNotBlank() }?.let { put("code", it) }
                    obj.optString("error").takeIf { it.isNotBlank() }?.let { put("error", it) }
                })
                Thread.sleep(120)
            }
        } finally {
            if (prevSuppress == true) suppressScreenGate.set(true) else suppressScreenGate.remove()
        }
        return JSONObject().apply {
            put("ok", okCount == fields.length())
            put("filled", okCount)
            put("total", fields.length())
            put("results", results)
        }.toString()
    }

    /* ---------------- 手势族：任意轨迹 / 拖拽 / 双指 ---------------- */

    /**
     * 任意轨迹手势（点数组，等价桌面 CUA 的路径输入）：
     * 画线、滑杆、签名、连续滑动都能表达；hold_ms > 0 时先按住再走（拖拽排序）。
     */
    fun gesture(points: JSONArray, durationMs: Long = 400, holdMs: Long = 0): String {
        if (points.length() < 2) return err("BAD_ARGS", "points 至少两个点：[{x,y},{x,y}]")
        guardScreen("轨迹手势 ${points.length()} 点")?.let { return it }
        reportControl("gesture", "手势", "轨迹 ${points.length()} 点")
        fun pt(i: Int): Pair<Float, Float> {
            val p = points.optJSONObject(i)
            if (p != null) return p.optDouble("x").toFloat() to p.optDouble("y").toFloat()
            val a = points.optJSONArray(i) ?: return 0f to 0f
            return a.optDouble(0).toFloat() to a.optDouble(1).toFloat()
        }
        val (sx, sy) = pt(0)
        val path = Path().apply {
            moveTo(sx, sy)
            for (i in 1 until points.length()) {
                val (x, y) = pt(i)
                lineTo(x, y)
            }
        }
        val builder = GestureDescription.Builder()
        if (holdMs > 0) {
            val holdPath = Path().apply { moveTo(sx, sy) }
            val first = GestureDescription.StrokeDescription(
                holdPath, 0, holdMs.coerceIn(300, 4000), true)
            builder.addStroke(first)
            builder.addStroke(first.continueStroke(
                path, 0, durationMs.coerceIn(100, 5000), false))
        } else {
            builder.addStroke(GestureDescription.StrokeDescription(
                path, 0, durationMs.coerceIn(80, 5000)))
        }
        val what = "轨迹 ${points.length()} 点" + if (holdMs > 0) "（先按住 ${holdMs}ms）" else ""
        return dispatchAndReport(builder.build(), what)
    }

    /** 拖拽：按住起点 → 移到终点（列表排序、滑杆、拖放） */
    fun drag(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long = 600, holdMs: Long = 450): String {
        if (x1 == x2 && y1 == y2) return err("BAD_ARGS", "起点与终点相同")
        guardScreen("拖拽 ($x1,$y1)→($x2,$y2)")?.let { return it }
        reportControl("gesture", "手势", "拖拽 ($x1,$y1)→($x2,$y2)")
        val begin = Path().apply { moveTo(x1.toFloat(), y1.toFloat()) }
        val move = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val first = GestureDescription.StrokeDescription(begin, 0, holdMs.coerceIn(300, 3000), true)
        val second = first.continueStroke(move, 0, durationMs.coerceIn(150, 5000), false)
        val g = GestureDescription.Builder().addStroke(first).addStroke(second).build()
        val r = dispatchAndReport(g, "拖拽 ($x1,$y1)→($x2,$y2)")
        // 连续笔段（按住再拖）被系统取消时，退化为单笔段慢速滑动（多数应用可接受）
        if (JSONObject(r).optBoolean("ok")) return r
        val slow = swipe(x1, y1, x2, y2, (durationMs + holdMs).coerceAtMost(2000))
        return JSONObject(slow).put("via", "fallback_swipe")
            .put("note", "按住拖拽被系统取消，已退化为慢速滑动").toString()
    }

    /** 双指缩放：scale = "in" 放大 / "out" 缩小（地图、图片、网页） */
    fun pinch(direction: String, centerX: Int? = null, centerY: Int? = null, distance: Int = 300): String {
        awaitScreenFree("双指${if (direction.lowercase().startsWith("o")) "缩小" else "放大"}")?.let { return it }
        val size = realDisplaySize()
        val cx = centerX ?: size.x / 2
        val cy = centerY ?: size.y / 2
        val d = distance.coerceIn(80, 800)
        val half = d / 2
        val (from, to) = when (direction.lowercase()) {
            "in", "open", "zoom_in", "放大" -> (half / 3) to half
            "out", "close", "zoom_out", "缩小" -> half to (half / 3)
            else -> return err("BAD_DIRECTION", "direction 支持 in / out，收到：$direction")
        }
        reportControl("gesture", "手势", if (to > from) "双指放大" else "双指缩小")
        // 两指沿相反方向移动；from → to 控制张开或收拢
        val p1 = Path().apply {
            moveTo((cx - from).toFloat(), cy.toFloat())
            lineTo((cx - to).toFloat(), cy.toFloat())
        }
        val p2 = Path().apply {
            moveTo((cx + from).toFloat(), cy.toFloat())
            lineTo((cx + to).toFloat(), cy.toFloat())
        }
        val g = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(p1, 0, 300))
            .addStroke(GestureDescription.StrokeDescription(p2, 0, 300))
            .build()
        return dispatchAndReport(g, if (to > from) "双指放大" else "双指缩小")
    }

    /** 滚动直到某文本出现（列表很长时比反复读屏省轮次） */
    fun scrollUntil(text: String, direction: String = "down", maxPages: Int = 6): String {
        if (text.isBlank()) return err("BAD_ARGS", "text 不能为空")
        if (screenHasText(text)) {
            return JSONObject().put("ok", true).put("pages", 0).put("note", "「$text」已经在屏幕上").toString()
        }
        val pages = maxPages.coerceIn(1, 10)
        for (i in 1..pages) {
            val r = scroll(direction, null, 1)
            if (!JSONObject(r).optBoolean("ok")) return r
            Thread.sleep(350)
            if (screenHasText(text)) {
                return JSONObject().put("ok", true).put("pages", i)
                    .put("note", "滚动 $i 次后找到「$text」").toString()
            }
        }
        return JSONObject().apply {
            put("ok", false); put("code", "NOT_FOUND")
            put("error", "滚动 $pages 次仍没有「$text」")
            put("hint", "可能方向不对（试 up），或内容在别的标签页里")
        }.toString()
    }

    /* ---------------- 设备能力：剪贴板 / 音量 / 媒体 / 通知 / 应用信息 ---------------- */

    /** 剪贴板：get / set / paste（paste 会粘贴到当前焦点输入框） */
    fun clipboard(action: String, text: String? = null): String {
        val cm = getSystemService(android.content.ClipboardManager::class.java)
            ?: return err("NO_SERVICE", "系统没有剪贴板服务")
        return when (action.lowercase()) {
            "set", "copy" -> {
                if (text == null) return err("BAD_ARGS", "set 需要 text")
                runCatching { cm.setPrimaryClip(android.content.ClipData.newPlainText("dsh", text)) }
                    .fold(
                        onSuccess = { JSONObject().put("ok", true).put("chars", text.length)
                            .put("note", "已写入剪贴板").toString() },
                        onFailure = { err("CLIPBOARD_DENIED", "写剪贴板被拒绝：${it.message}") },
                    )
            }
            "get", "read" -> {
                val clip = runCatching { cm.primaryClip }.getOrNull()
                val item = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
                val t = item?.coerceToText(this)?.toString()
                if (t == null) JSONObject().apply {
                    put("ok", false); put("code", "CLIPBOARD_EMPTY_OR_HIDDEN")
                    put("error", "读不到剪贴板（Android 10+ 只有前台应用能读，且需要非空）")
                    put("hint", "需要剪贴板内容时，让用户粘贴到输入框，再用 screen_read 读出来")
                }.toString()
                else JSONObject().put("ok", true).put("text", t.take(4000)).put("chars", t.length).toString()
            }
            "paste" -> {
                val focus = contentRoots().firstNotNullOfOrNull { it.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }
                    ?: return err("NO_FOCUS", "当前没有输入框在编辑", "先 phone_tap 输入框")
                val ok = focus.performAction(AccessibilityNodeInfo.ACTION_PASTE)
                JSONObject().put("ok", ok).put("note", if (ok) "已粘贴" else "输入框拒绝粘贴").toString()
            }
            else -> err("BAD_ACTION", "action 支持 get / set / paste")
        }
    }

    /** 音量与铃声（媒体音量，无需权限） */
    fun volume(action: String, percent: Int? = null): String {
        val am = getSystemService(android.media.AudioManager::class.java)
            ?: return err("NO_SERVICE", "系统没有音频服务")
        val stream = android.media.AudioManager.STREAM_MUSIC
        val max = am.getStreamMaxVolume(stream)
        return when (action.lowercase()) {
            "up" -> {
                am.adjustStreamVolume(stream, android.media.AudioManager.ADJUST_RAISE,
                    android.media.AudioManager.FLAG_SHOW_UI)
                JSONObject().put("ok", true).put("level", am.getStreamVolume(stream)).put("max", max).toString()
            }
            "down" -> {
                am.adjustStreamVolume(stream, android.media.AudioManager.ADJUST_LOWER,
                    android.media.AudioManager.FLAG_SHOW_UI)
                JSONObject().put("ok", true).put("level", am.getStreamVolume(stream)).put("max", max).toString()
            }
            "mute", "0" -> {
                am.setStreamVolume(stream, 0, android.media.AudioManager.FLAG_SHOW_UI)
                JSONObject().put("ok", true).put("level", 0).put("note", "已静音媒体音量").toString()
            }
            "set" -> {
                val p = (percent ?: return err("BAD_ARGS", "set 需要 percent 0-100")).coerceIn(0, 100)
                val level = Math.round(max * p / 100f)
                am.setStreamVolume(stream, level, android.media.AudioManager.FLAG_SHOW_UI)
                JSONObject().put("ok", true).put("percent", p).put("level", level).put("max", max).toString()
            }
            "get" -> JSONObject().put("ok", true)
                .put("level", am.getStreamVolume(stream)).put("max", max).toString()
            else -> err("BAD_ACTION", "action 支持 up / down / mute / set / get")
        }
    }

    /** 媒体播放控制（需要当前有媒体会话；等价桌面媒体键） */
    fun media(action: String): String {
        val am = getSystemService(android.media.AudioManager::class.java)
            ?: return err("NO_SERVICE", "系统没有音频服务")
        val key = when (action.lowercase()) {
            "play" -> android.view.KeyEvent.KEYCODE_MEDIA_PLAY
            "pause" -> android.view.KeyEvent.KEYCODE_MEDIA_PAUSE
            "play_pause", "toggle" -> android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            "next" -> android.view.KeyEvent.KEYCODE_MEDIA_NEXT
            "prev", "previous" -> android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS
            "stop" -> android.view.KeyEvent.KEYCODE_MEDIA_STOP
            else -> return err("BAD_ACTION", "action 支持 play/pause/play_pause/next/prev/stop")
        }
        am.dispatchMediaKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, key))
        am.dispatchMediaKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, key))
        return JSONObject().put("ok", true).put("action", action)
            .put("note", "已派发媒体键（没有正在播放的会话时不会有效果）").toString()
    }

    /** 打开通知栏并读里面的内容（可选直接点某条通知） */
    fun notifications(tap: String? = null): String {
        reportControl("key", "通知栏", "展开通知栏")
        performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
        Thread.sleep(700)
        if (!tap.isNullOrBlank()) {
            val r = tapText(tap, exact = false)
            Thread.sleep(500)
            return JSONObject(r).put("opened", true).toString()
        }
        return JSONObject().apply {
            put("ok", true)
            put("note", "通知栏已展开（texts 来自全部窗口：通知栏是独立窗口，" +
                "rootInActiveWindow 仍会落在后面的应用上）")
            put("texts", allWindowTexts(120))
            put("elements", runCatching {
                JSONObject(readScreen(30, 100)).optJSONArray("elements") ?: JSONArray()
            }.getOrDefault(JSONArray()))
        }.toString()
    }

    /** 应用信息（版本/安装时间/是否启用），配合 phone_list_apps 使用 */
    fun appInfo(packageName: String): String {
        val pm = packageManager
        val info = runCatching { pm.getPackageInfo(packageName, 0) }.getOrNull()
            ?: return err("APP_NOT_FOUND", "没有安装：$packageName")
        val app = info.applicationInfo ?: return err("APP_NOT_FOUND", "包信息不完整：$packageName")
        return JSONObject().apply {
            put("ok", true)
            put("package", packageName)
            put("label", runCatching { pm.getApplicationLabel(app).toString() }.getOrDefault(""))
            put("version", info.versionName ?: "")
            put("enabled", app.enabled)
            put("launchable", pm.getLaunchIntentForPackage(packageName) != null)
            put("installed_at", java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US)
                .format(java.util.Date(info.firstInstallTime)))
        }.toString()
    }

    /* ---------------- 内部 ---------------- */

    /** 只在主线程发起截图请求；结果由调用方在后台线程等待（不阻塞主线程） */
    private fun requestScreenshot(png: Array<ByteArray?>, latch: java.util.concurrent.CountDownLatch) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            lastShotError = "系统版本低于 Android 11，无障碍截图不可用"
            latch.countDown()
            return
        }
        runCatching {
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(result: ScreenshotResult) {
                        try {
                            val buffer = result.hardwareBuffer
                            val bmp = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
                            if (bmp == null) {
                                lastShotError = "系统返回的截图无法解码为位图（colorSpace=${result.colorSpace}）"
                            } else {
                                val soft = bmp.copy(Bitmap.Config.ARGB_8888, false)
                                if (soft == null) {
                                    lastShotError = "截图位图复制失败"
                                } else {
                                    val scaled = scaleDown(soft, 1080)
                                    val out = java.io.ByteArrayOutputStream()
                                    scaled.compress(Bitmap.CompressFormat.JPEG, 85, out)
                                    png[0] = out.toByteArray()
                                }
                            }
                            buffer.close()
                        } catch (t: Throwable) {
                            lastShotError = "截图处理失败：${t.javaClass.simpleName} ${t.message ?: ""}"
                        }
                        latch.countDown()
                    }

                    override fun onFailure(errorCode: Int) {
                        lastShotError = when (errorCode) {
                            1 -> "系统内部错误（ERROR_INTERNAL_ERROR）"
                            2 -> "没有无障碍截屏权限（检查无障碍服务是否已重新开启）"
                            3 -> "截屏太频繁（ERROR_INTERVAL_TIME_SHORT），稍等再试"
                            4 -> "显示器无效（ERROR_INVALID_DISPLAY）"
                            else -> "系统拒绝截图，错误码 $errorCode"
                        }
                        latch.countDown()
                    }
                })
        }.onFailure {
            lastShotError = "调用截图接口失败：${it.message}"
            latch.countDown()
        }
    }

    private fun scaleDown(src: Bitmap, maxSide: Int): Bitmap {
        val long = maxOf(src.width, src.height)
        if (long <= maxSide) return src
        val ratio = maxSide.toFloat() / long
        return Bitmap.createScaledBitmap(src,
            (src.width * ratio).toInt().coerceAtLeast(1),
            (src.height * ratio).toInt().coerceAtLeast(1), true)
    }

    private fun isOnMainThread(): Boolean =
        android.os.Looper.myLooper() == android.os.Looper.getMainLooper()

    private val mainHandler: android.os.Handler by lazy { android.os.Handler(android.os.Looper.getMainLooper()) }

    /**
     * 真实显示区（宽,高）：含状态栏/导航栏，与 getBoundsInScreen、dispatchGesture
     * 同一坐标系。displayMetrics 是应用可用区（不含系统栏），拿它算滑动/捏合的
     * 起点会把坐标整体偏移半条导航栏 —— 所有屏幕坐标统一走这里。
     */
    private fun realDisplaySize(): android.graphics.Point {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            runCatching {
                val dm = android.util.DisplayMetrics()
                @Suppress("DEPRECATION")
                display?.getRealMetrics(dm)
                if (dm.heightPixels > 0) return android.graphics.Point(dm.widthPixels, dm.heightPixels)
            }
        }
        val dm = resources.displayMetrics
        return android.graphics.Point(dm.widthPixels, dm.heightPixels)
    }

    private fun simpleClass(node: AccessibilityNodeInfo): String =
        node.className?.toString().orEmpty().substringAfterLast('.').take(60)

    /** 节点"自己的"文本：text → contentDescription（不聚后代） */
    private fun ownText(node: AccessibilityNodeInfo): String {
        val t = node.text?.toString()?.trim().orEmpty()
        if (t.isNotBlank()) return t
        return node.contentDescription?.toString()?.trim().orEmpty()
    }

    /**
     * 节点的可读标签：自身文本为空时聚合后代文本（最多 4 层 / 120 字）。
     * 这是让「可点容器」能被读懂的关键。
     */
    private fun labelOf(node: AccessibilityNodeInfo): String {
        val own = ownText(node)
        if (own.isNotBlank()) return own.take(120)
        val sb = StringBuilder()
        fun collect(n: AccessibilityNodeInfo, depth: Int) {
            if (depth > 4 || sb.length > 120) return
            val t = ownText(n)
            if (t.isNotBlank()) {
                if (sb.isNotEmpty()) sb.append(" / ")
                sb.append(t)
            }
            for (i in 0 until n.childCount) {
                n.getChild(i)?.let { collect(it, depth + 1) }
            }
        }
        collect(node, 0)
        return sb.toString().take(120)
    }

    private fun fullId(id: String): String =
        if (id.contains(':')) id else "${rootInActiveWindow?.packageName ?: ""}:id/$id"

    /** 按 screen_read 的 index 取节点（先 refresh，失效则报错让模型重读，不猜） */
    private fun nodeAt(index: Int, token: String? = null): AccessibilityNodeInfo? {
        val n = snapshotOf(token)?.nodes?.getOrNull(index) ?: return null
        // refresh() 返回 false 意味着节点已被系统回收 —— 之前丢弃返回值继续读缓存的
        // isVisibleToUser，等于拿着过期坐标去点。失效就报错让模型重读，不猜
        val ok = runCatching { n.refresh() }.getOrDefault(false)
        if (!ok) return null
        return if (n.isVisibleToUser) n else null
    }

    private fun findByViewId(id: String): AccessibilityNodeInfo? =
        contentRoots().firstNotNullOfOrNull { root ->
            runCatching {
                root.findAccessibilityNodeInfosByViewId(fullId(id)).orEmpty()
                    .firstOrNull { it.isVisibleToUser }
            }.getOrNull()
        }

    private fun editableSelf(node: AccessibilityNodeInfo): AccessibilityNodeInfo? =
        if (node.isEditable || node.className?.toString().orEmpty().contains("EditText")) node else null

    /** 向下找第一个可编辑后代（容器包输入框的常见结构） */
    private fun descendantEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var found: AccessibilityNodeInfo? = null
        fun walk(n: AccessibilityNodeInfo, depth: Int) {
            if (found != null || depth > 4) return
            if (n.isEditable) { found = n; return }
            for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(node, 0)
        return found
    }

    /** 收集当前所有可见窗口的文本（通知栏 / 分屏 / 悬浮窗都用得上） */
    private fun allWindowTexts(max: Int): JSONArray {
        val out = JSONArray()
        fun collectRoot(root: AccessibilityNodeInfo?) {
            if (root == null || out.length() >= max) return
            fun walk(n: AccessibilityNodeInfo, depth: Int) {
                if (out.length() >= max || depth > 25) return
                val t = ownText(n)
                if (t.isNotBlank() && t.length > 1) {
                    var dup = false
                    for (i in 0 until out.length()) if (out.optString(i) == t) { dup = true; break }
                    if (!dup) out.put(t.take(200))
                }
                for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
            }
            walk(root, 0)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            runCatching { windows }.getOrNull()?.forEach { w ->
                if (w.isActive) collectRoot(w.root)
            }
        }
        if (out.length() == 0) collectRoot(rootInActiveWindow)
        return out
    }

    /** 当前屏幕（不含通知栏）是否已出现某文本 */
    private fun screenHasText(text: String): Boolean =
        contentRoots().any { root ->
            var hit = false
            fun walk(n: AccessibilityNodeInfo, depth: Int) {
                if (hit || depth > 30) return
                val t = ownText(n)
                if (t.isNotBlank() && t.contains(text, ignoreCase = true)) { hit = true; return }
                for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
            }
            walk(root, 0)
            hit
        }

    /**
     * 界面是否已经「静下来」——没有任何无障碍事件。
     *
     * 这是重试该不该等的判据：重试**只对「界面还没渲染完」有意义**。
     * 界面已经静默 150ms 以上还找不到，说明元素就是不存在（模型把名字记错了），
     * 继续试满 6 次只是白等 1.5s 才拿到一个必然的 NOT_FOUND。
     */
    private fun settled(): Boolean =
        uiTracker.msSinceLastEvent(System.currentTimeMillis()) >= 150

    /** 单结果版 [findNodesRetry]：界面在动时短暂重试，静默即停 */
    private fun findNodeRetry(text: String, exact: Boolean, attempts: Int = 6): AccessibilityNodeInfo? {
        var found = findNode(text, exact)
        if (found != null || settled()) return found
        var i = 0
        while (found == null && i++ < attempts) {
            Thread.sleep(250)
            found = findNode(text, exact)
            if (found == null && settled()) break
        }
        return found
    }

    /**
     * 找不到就重试，但**只在界面还在动的时候**重试。
     *
     * 旧实现无条件 6 次 × 250ms：模型点错名字时固定白等 1.5s 才报 NOT_FOUND，
     * 而这段时间里界面根本没变过、再试也不会有结果。静默即停。
     */
    private fun findNodesRetry(text: String, exact: Boolean, attempts: Int = 6): List<AccessibilityNodeInfo> {
        var found = findNodes(text, exact)
        if (found.isNotEmpty() || settled()) return found
        var i = 0
        while (found.isEmpty() && i++ < attempts) {
            Thread.sleep(250)
            found = findNodes(text, exact)
            if (found.isEmpty() && settled()) break
        }
        return found
    }

    private fun findNode(text: String, exact: Boolean): AccessibilityNodeInfo? =
        findNodes(text, exact).firstOrNull()

    /**
     * 找全部匹配（树序，供 ordinal 取第 N 个）：
     * 先按自身文本匹配，空了再按聚合标签匹配；可见节点优先，
     * 全都不可见时放宽到不可见节点（配合 scrollIntoView 滚进屏）。
     */
    private fun findNodes(text: String, exact: Boolean): List<AccessibilityNodeInfo> {
        // 空文本绝不能查：findAccessibilityNodeInfosByText("") 会命中整棵树，
        // 后面任何兜底都会变成「点第一个节点」——静默改错用户的设置
        if (text.isBlank()) return emptyList()
        for (root in contentRoots()) {
            val hit = findNodesInRoot(root, text, exact)
            if (hit.isNotEmpty()) return hit
        }
        return emptyList()
    }

    /** 单窗口内的文本/id 匹配（NodeMatch 选序不变），供 [findNodes] 遍历多个内容窗口 */
    private fun findNodesInRoot(
        root: AccessibilityNodeInfo,
        text: String,
        exact: Boolean,
    ): List<AccessibilityNodeInfo> {
        val byText: List<AccessibilityNodeInfo> =
            root.findAccessibilityNodeInfosByText(text).orEmpty()
        val byId: List<AccessibilityNodeInfo> =
            runCatching { root.findAccessibilityNodeInfosByViewId(fullId(text)).orEmpty() }
                .getOrDefault(emptyList())
        // **必须去重**：同一个节点可能既被文本匹配、又被 id 匹配（按钮文本恰好等于 id 末段），
        // 两列相加后 all.size 偏大 → ordinal 数到的是重复项 → 点到隔壁元素。
        // 现场表现是「明明只有 3 个『更多』，点第 3 个却点到第 2 个」。
        val pool = LinkedHashSet<AccessibilityNodeInfo>(byText.size + byId.size).apply {
            addAll(byText)
            addAll(byId)
        }.toList()
        // 匹配与可见性优先级在 NodeMatch（纯函数，可单测）里，这里只做适配
        val cands = pool.map {
            NodeMatch.Cand(text = ownText(it), label = labelOf(it), visible = it.isVisibleToUser)
        }
        return NodeMatch.select(cands, text, exact).map { pool[it] }
    }

    /**
     * 目标不可见时滚动进屏（列表项在可视区外）：先向后滚 3 次（目标多半在下方），
     * 仍不可见再向前滚 3 次 —— 之前只 FORWARD，目标在视口上方时永远够不到，
     * 滚完只能拿一个依然点不中的节点。
     */
    private fun scrollIntoView(node: AccessibilityNodeInfo): AccessibilityNodeInfo {
        var cur = node
        for (action in intArrayOf(
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,
            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,
        )) {
            var hops = 0
            while (hops < 3 && runCatching { cur.isVisibleToUser }.getOrDefault(false).not()) {
                val scroller = scrollableAncestor(cur) ?: break
                if (!scroller.performAction(action)) break
                Thread.sleep(150)
                runCatching { cur.refresh() }
                hops++
            }
            if (runCatching { cur.isVisibleToUser }.getOrDefault(false)) break
        }
        return cur
    }

    private fun clickableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var cur: AccessibilityNodeInfo? = node
        var hops = 0
        while (cur != null && hops < 6) {
            if (cur.isClickable && cur.isEnabled) return cur
            cur = cur.parent
            hops++
        }
        return null
    }

    private fun scrollableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var cur: AccessibilityNodeInfo? = node
        var hops = 0
        while (cur != null && hops < 8) {
            if (cur.isScrollable) return cur
            cur = cur.parent
            hops++
        }
        return null
    }

    private fun firstScrollable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var found: AccessibilityNodeInfo? = null
        fun walk(n: AccessibilityNodeInfo, depth: Int) {
            if (found != null || depth > 10) return
            if (n.isScrollable && n.isVisibleToUser) { found = n; return }
            for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
        return found
    }

    private fun clickNode(node: AccessibilityNodeInfo, label: String): String {
        reportControl("tap", "点击", "点击「$label」")
        val bp = runCatching { fingerprintsNow() }.getOrDefault(emptyMap())
        val before = uiTracker.epoch()
        val target = clickableAncestor(node)
        if (target != null) {
            val ok = target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            if (ok) return withUiCheck(
                JSONObject().put("ok", true).put("via", "node").put("text", label)
                    .put("note", "已点击「$label」").toString(), before, beforePrints = bp)
        }
        val b = Rect().also { (target ?: node).getBoundsInScreen(it) }
        if (b.isEmpty || b.bottom <= b.top) return err("NOT_CLICKABLE",
            "「$label」既不可点击也没有有效坐标", "先用 screen_read 看可交互元素")
        val r = tapAt(b.centerX(), b.centerY())
        return JSONObject(r).put("via", "gesture").put("text", label).toString()
    }

    private fun dispatchAndReport(gesture: GestureDescription, what: String): String {
        // 手势回调同样回主线程：主线程发起时不能等待，否则互锁
        if (isOnMainThread()) {
            val ok = runCatching { dispatchGesture(gesture, null, null) }.getOrDefault(false)
            return JSONObject().put("ok", ok).put("gesture", what)
                .put("note", if (ok) "已派发（主线程发起，未等完成回调）" else "系统拒绝派发手势")
                .toString()
        }
        val ok = booleanArrayOf(false)
        val accepted = booleanArrayOf(false)
        val finished = booleanArrayOf(false)
        val latch = java.util.concurrent.CountDownLatch(1)
        mainHandler.post {
            accepted[0] = runCatching {
                dispatchGesture(gesture, object : GestureResultCallback() {
                    override fun onCompleted(g: GestureDescription?) {
                        ok[0] = true; finished[0] = true; latch.countDown()
                    }

                    override fun onCancelled(g: GestureDescription?) {
                        finished[0] = true; latch.countDown()
                    }
                }, mainHandler)
            }.getOrDefault(false)
            if (!accepted[0]) latch.countDown()
        }
        if (!latch.await(2, java.util.concurrent.TimeUnit.SECONDS)) {
            accepted[0] = true
            finished[0] = false
        }
        if (!accepted[0]) return err("DISPATCH_FAILED", "系统拒绝派发手势：$what")
        return JSONObject().apply {
            put("ok", ok[0]); put("gesture", what)
            put("note", when {
                ok[0] -> "已执行"
                !finished[0] -> "手势已派发，2s 内没有完成回调（结果未知）"
                else -> "手势被取消（可能上层有蒙层，或坐标在屏幕外）"
            })
        }.toString()
    }

    private fun err(code: String, message: String, hint: String? = null): String =
        JSONObject().apply {
            put("ok", false); put("code", code); put("error", message)
            hint?.let { put("hint", it) }
        }.toString()
}

/* ======================================================================
 * 应用级授权闸门（纯逻辑层，全部可 JVM 单测）
 *
 * 问题：手机操控此前只靠「无障碍开关」这一道授权，模型一旦拿到 phone_* 工具，
 * 就能在任意应用里点任意按钮、往任意输入框写字 —— 包括点「确认支付」「发送」。
 * 标准权限档默认放行 phone_*，这等于把用户的钱包和社交账号交给一次误判。
 *
 * 现在的规则（与桌面 computer-use 的授权模型对齐，但默认档更保守）：
 *  0. **完全访问档（danger-full-access）= 本层全部放行**：桌面 `permission-presets` 里
 *     `danger-full-access` 是 `sandbox: danger-full-access` + `approval: 'never'`
 *     —— 两个旋钮一起变。手机端此前只接了 sandbox 这一维，审批这一维没接，
 *     于是「开了完全访问，点删除/支付/首次打开应用还是弹卡片」。现在档位到 full
 *     就整层不弹（不是"问了自动答应"），其余档位才走下面 1–4。
 *  1. 首次操作某个未见过的应用（open_app / launch / foreground）要一次授权；
 *     授权分 task（本次任务，进程内存）与 always（永久，只持久化包名）两级。
 *  2. 敏感界面（支付 / 转账 / 确认支付 / 授权 / 删除 / 发送 / 验证码 …）与敏感应用
 *     （银行 / 支付 / 验证码类包名）**逐次**确认，且不缓存 —— 即使之前 always 过。
 *  3. 后台 / 团队 / 委派（没有活跃轮次可以问人）一律拒绝，返回
 *     code=APP_APPROVAL_UNAVAILABLE，而不是默默放行或默默失败。
 *  4. 权限降档 / 无障碍被关掉时清空运行时（task）授权；[PhoneApprovalPolicy.revokeAll]
 *     连持久 allowedApps 一起清。
 *
 * 本层不碰 Android API：确认框由 [ApprovalGate] 注入，持久化由 load/save 回调注入。
 * ====================================================================== */

/**
 * 一次性授权回调：有活跃轮次时可向用户提问；拿不到（后台/团队/委派）就返回 null 表示不可问。
 * 实现方由 [ai.deepseek.harness.mobile.kernel.plugin.builtin.ComputerUsePlugin] 从
 * `agent.runtime` 的 approve 通道注入。
 */
fun interface ApprovalGate {
    /** @return true = 用户同意本次操作 */
    fun request(reason: String): Boolean
}

/** 授权范围：只本次任务 / 永久允许这个应用 / 拒绝 */
enum class ApprovalScope { TASK, ALWAYS, DENY }

/**
 * 能返回「本次 / 始终」两级的确认框。实现不了这层时退回 [ApprovalGate]，
 * 授权档位取 [PhoneApprovalPolicy.defaultScope]（默认 TASK = 不落盘）。
 */
interface ScopedApprovalGate : ApprovalGate {
    fun requestScoped(reason: String): ApprovalScope
}

/** 闸门判定结果：allowed=false 时 [code]/[reason]/[hint] 直接作为结构化错误回给模型 */
data class ApprovalDecision(
    val allowed: Boolean,
    val code: String? = null,
    val reason: String? = null,
    val hint: String? = null,
    val asked: Boolean = false,
) {
    companion object {
        val OK = ApprovalDecision(true)

        fun deny(code: String, reason: String, hint: String? = null) =
            ApprovalDecision(false, code = code, reason = reason, hint = hint)
    }
}

class PhoneApprovalPolicy(
    private var loadAllowed: () -> Set<String> = { emptySet() },
    private var saveAllowed: (Set<String>) -> Unit = {},
    /** 确认框只能回答「是/否」时，把授权记成哪一档 */
    var defaultScope: ApprovalScope = ApprovalScope.TASK,
) {

    companion object {
        /** 没有活跃轮次可以问人（后台 / 团队 / 委派）：拒绝，且明确告诉模型为什么 */
        const val CODE_UNAVAILABLE = "APP_APPROVAL_UNAVAILABLE"
        /** 用户明确拒绝 */
        const val CODE_DENIED = "APP_APPROVAL_DENIED"

        /** 敏感界面文案：命中即逐次确认（不缓存） */
        val SENSITIVE_WORDS = listOf(
            "支付", "付款", "转账", "汇款", "确认支付", "确认付款", "立即支付", "付款码",
            "免密", "银行卡", "授权", "验证码", "短信验证", "删除", "发送",
            // 英文界面 / 英文应用
            "payment", "transfer", "confirm payment", "authorize", "delete",
            "send", "verification code", "one-time password", "otp", "passcode",
        )

        /** 敏感应用包名片段：银行 / 支付 / 验证码类 */
        val SENSITIVE_PACKAGES = listOf(
            "bank", "pay", "wallet", "alipay", "tenpay", "unionpay", "wechat", "tencent.mm",
            "icbc", "ccb", "abchina", "psbc", "spdb", "cebbank", "cmbc", "cib", "citics",
            "pingan", "authenticator", "totp",
        )

        fun isSensitiveText(text: String?): Boolean {
            val t = text?.lowercase() ?: return false
            if (t.isBlank()) return false
            return SENSITIVE_WORDS.any { t.contains(it) }
        }

        fun isSensitivePackage(pkg: String?): Boolean {
            val p = pkg?.trim()?.lowercase() ?: return false
            if (p.isBlank()) return false
            return SENSITIVE_PACKAGES.any { p.contains(it) }
        }

        /**
         * 权限档位 → 严格度排序（数字越小越严）；未识别返回 -1。
         * 别名解析在 [SandboxMode.parse] 里，这里不再自己认第二遍。
         */
        fun sandboxRank(mode: String?): Int =
            ai.deepseek.harness.mobile.kernel.sandbox.SandboxMode.parse(mode)?.rank ?: -1

        /** 完全访问档的 rank：这一档 = 桌面 `approval: 'never'`，本层不再有任何确认 */
        const val SANDBOX_RANK_FULL = 2
    }

    /** 本次任务内的授权（进程内存；权限降档/撤销时清空） */
    private val taskGrants: MutableSet<String> =
        java.util.Collections.synchronizedSet(java.util.LinkedHashSet<String>())

    /** 永久允许的应用（只存包名/Intent 键，不存任何界面内容） */
    private val alwaysAllowed: MutableSet<String> =
        java.util.Collections.synchronizedSet(java.util.LinkedHashSet<String>())

    @Volatile
    private var lastSandboxRank: Int = -1

    /** 接上持久化（服务启动时调用；load 先读，save 在 ALWAYS 授权/撤销时回写） */
    fun installStore(load: () -> Set<String>, save: (Set<String>) -> Unit) {
        loadAllowed = load
        saveAllowed = save
        runCatching { load() }.getOrDefault(emptySet())
            .mapNotNull { it?.trim()?.lowercase()?.takeIf { s -> s.isNotBlank() } }
            .forEach { alwaysAllowed.add(it) }
    }

    fun alwaysAllowedSnapshot(): Set<String> = HashSet(alwaysAllowed)

    fun taskGrantCount(): Int = taskGrants.size

    /** 完全访问档：本层不做任何确认（连「要不要问」的敏感词采样都可以省掉） */
    fun isFullAccess(): Boolean = lastSandboxRank >= SANDBOX_RANK_FULL

    /** 该目标是否已被授权（敏感应用不在此列：它们永远逐次确认） */
    fun allows(key: String): Boolean {
        val k = key.trim().lowercase()
        if (k.isBlank()) return false
        return alwaysAllowed.contains(k) || taskGrants.contains(k)
    }

    /**
     * 权限档位变化：降档时清空运行时授权（升级不动）。
     * @return true = 本次确实因为降档清空了 grant
     */
    fun noteSandboxMode(mode: String?): Boolean {
        val rank = sandboxRank(mode)
        if (rank < 0) return false
        val prev = lastSandboxRank
        lastSandboxRank = rank
        if (prev >= 0 && rank < prev) {
            revokeRuntimeGrants()
            return true
        }
        return false
    }

    /** 清空运行时（task）授权；持久 allowedApps 保留 */
    fun revokeRuntimeGrants() {
        taskGrants.clear()
    }

    /** 全撤销：运行时授权 + 持久 allowedApps 一起清（设置页/降档兜底用） */
    fun revokeAll() {
        taskGrants.clear()
        alwaysAllowed.clear()
        runCatching { saveAllowed(emptySet()) }
    }

    /**
     * 首次操作未知应用（open_app / launch / foreground）：问一次，按 [ApprovalScope] 记住。
     * 未知包 + 拿不到确认框 = APP_APPROVAL_UNAVAILABLE（不是静默放行）。
     */
    fun guardPackage(packageName: String?, action: String, gate: ApprovalGate?): ApprovalDecision {
        val raw = packageName?.trim().orEmpty()
        val key = raw.lowercase()
        if (key.isBlank()) return ApprovalDecision.OK
        return guardTarget(key, "应用「$raw」", isSensitivePackage(key), action, gate)
    }

    /** Intent 唤起（tel:/smsto:/https:…）：按 scheme+host 记授权键；URI 含敏感词按敏感处理 */
    fun guardIntent(uri: String?, action: String, gate: ApprovalGate?): ApprovalDecision {
        val u = uri?.trim().orEmpty()
        if (u.isBlank()) return ApprovalDecision.OK
        val key = "intent:" + intentKey(u)
        val sensitive = isSensitiveText(u) || isSensitivePackage(u)
        return guardTarget(key, "Intent「${u.take(80)}」", sensitive, action, gate)
    }

    /**
     * 敏感界面闸门：屏幕文案或前台包名命中敏感规则时**逐次**确认。
     * 未命中直接放行（否则每一步都要问，等于不可用）。
     */
    fun guardScreen(
        action: String,
        packageName: String?,
        screenText: String?,
        gate: ApprovalGate?,
    ): ApprovalDecision {
        val pkg = packageName?.trim().orEmpty()
        val pkgSensitive = isSensitivePackage(pkg)
        val textSensitive = isSensitiveText(screenText)
        if (!pkgSensitive && !textSensitive) return ApprovalDecision.OK
        val label = when {
            pkgSensitive && textSensitive -> "应用「$pkg」的敏感界面"
            pkgSensitive -> "敏感应用「$pkg」"
            else -> "当前界面的敏感文案"
        }
        return guardTarget("screen:${pkg.lowercase()}", label, true, action, gate)
    }

    /* ---------------- 内部 ---------------- */

    private fun guardTarget(
        key: String,
        label: String,
        sensitive: Boolean,
        action: String,
        gate: ApprovalGate?,
    ): ApprovalDecision {
        // 完全访问 = 桌面 permission-presets 的 `approval: 'never'`：整层不弹卡。
        // 这是**档位语义**，不是"问了自动答应"—— 因此也不读/写 grant：
        // 降档回标准后，第一次操作仍然要按 1–2 的规则重新问。
        if (lastSandboxRank >= SANDBOX_RANK_FULL) return ApprovalDecision.OK
        if (sensitive) {
            // 敏感目标永远逐次确认，不查缓存、不记 grant
            val scope = ask(gate, "敏感操作：$action（$label）需要你逐次确认")
                ?: return ApprovalDecision.deny(
                    CODE_UNAVAILABLE,
                    "当前没有活跃轮次，无法向你确认敏感操作（$action / $label）",
                    "后台、团队或委派场景不能弹确认框；请在主对话里重试，或你自己操作",
                )
            return if (scope == ApprovalScope.DENY) {
                ApprovalDecision.deny(CODE_DENIED, "用户拒绝了这次操作：$action（$label）",
                    "不要重试；先问用户希望怎么做")
            } else ApprovalDecision(true, asked = true)
        }
        if (allows(key)) return ApprovalDecision.OK
        val scope = ask(gate, "首次操作 $label（$action）。允许吗？")
            ?: return ApprovalDecision.deny(
                CODE_UNAVAILABLE,
                "当前没有活跃轮次，无法向你确认是否允许操作 $label",
                "后台、团队或委派场景不能弹确认框；请在主对话里重试",
            )
        if (scope == ApprovalScope.DENY) {
            return ApprovalDecision.deny(CODE_DENIED, "用户拒绝了这次操作：$action（$label）",
                "不要重试；先问用户是否需要其它做法")
        }
        recordGrant(key, scope)
        return ApprovalDecision(true, asked = true)
    }

    /** 问一次：拿不到确认框返回 null；能答「本次/始终」就按它的粒度 */
    private fun ask(gate: ApprovalGate?, reason: String): ApprovalScope? {
        gate ?: return null
        return if (gate is ScopedApprovalGate) {
            gate.requestScoped(reason)
        } else if (gate.request(reason)) {
            defaultScope
        } else {
            ApprovalScope.DENY
        }
    }

    private fun recordGrant(key: String, scope: ApprovalScope) {
        when (scope) {
            ApprovalScope.ALWAYS -> {
                alwaysAllowed.add(key)
                runCatching { saveAllowed(alwaysAllowedSnapshot()) }
            }
            ApprovalScope.TASK -> taskGrants.add(key)
            ApprovalScope.DENY -> Unit
        }
    }

    /** Intent URI 的稳定授权键：scheme[:host]（tel:10086 → tel；https://a.com/x → https:a.com） */
    private fun intentKey(uri: String): String {
        val scheme = uri.substringBefore(':').trim().lowercase()
        val rest = uri.substringAfter("://", "")
        if (rest.isNotBlank()) {
            val host = rest.substringBefore('/').substringBefore('?').substringBefore('#')
                .substringAfterLast('@').trim().lowercase()
            if (host.isNotBlank()) return "$scheme:$host"
        }
        return scheme
    }
}
