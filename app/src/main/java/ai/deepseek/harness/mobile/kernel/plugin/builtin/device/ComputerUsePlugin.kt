package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.agent.ToolPipeline
import ai.deepseek.harness.mobile.kernel.device.ApprovalGate
import ai.deepseek.harness.mobile.kernel.device.ImageResize
import ai.deepseek.harness.mobile.kernel.device.PhoneControlService
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * 计算机操作（computer use） —— 桌面 docs/subsystems/computer-use.zh.md 的手机端等价物。
 *
 * 桌面：共享服务只注册一个提供方（Cua Driver MCP / 原生 / macOS CUA），模型经
 * 提供方观察桌面（截图）并操作（鼠标/键盘/热键）。共享服务不定义通用操作，
 * 工具目录由提供方给出。
 *
 * 手机端：没有 cua-driver，等价运行时是系统无障碍服务
 * [ai.deepseek.harness.mobile.kernel.device.PhoneControlService]：
 *   - 观察 = 屏幕节点树（文本/角色/可交互性/边界，比截图信息密度更高）
 *   - 操作 = 点击（节点或坐标）/ 滑动 / 输入 / 全局按键 / 打开应用 / Intent 唤起
 *
 * 与桌面一致的授权模型：用户必须显式开启无障碍服务；未开启时所有工具返回
 * 结构化原因与引导路径，不静默失败、不返回假成功。
 */
class ComputerUsePlugin : KernelPlugin {
    override val id = "computer-use"
    override val name = "手机操控"
    override val description = "读屏 / 点击 / 滑动 / 输入 / 系统按键 / 打开应用 / Intent 唤起"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        // 把「向用户确认」的通道交给 PhoneControlService 的授权闸门：
        // 每轮由 AgentDriver 注入 agent.runtime，其 approve() 会弹界面确认框。
        // 后台 / 团队 / 委派时这个服务取不到（或 approve 直接拒绝）——
        // 需要授权的手机操作就变成 APP_APPROVAL_UNAVAILABLE，而不是静默放行。
        PhoneControlService.gateProvider = {
            val rt = this.ctx?.service("agent.runtime") as? ToolPipeline.RuntimeTools
            if (rt == null) null
            else ApprovalGate { reason ->
                rt.approve("phone_control", JSONObject(), reason)
            }
        }
    }

    override fun onUnload() {
        PhoneControlService.gateProvider = null
        ctx = null
    }

    override fun status(): Map<String, String> = mapOf(
        "authorized" to if (PhoneControlService.enabled) "已开启" else "未开启（系统设置→无障碍）",
        "确认通道" to if (PhoneControlService.currentGate() != null) "可用（有活跃轮次）" else "不可用（后台/团队/委派）",
        "应用授权" to "${PhoneControlService.approval.alwaysAllowedSnapshot().size} 个永久 / " +
            "${PhoneControlService.approval.taskGrantCount()} 个本次",
    )

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    /** 服务未授权：结构化原因 + 引导（桌面缺提供方时同样报错而不是改 schema） */
    private fun notEnabled(): String = JSONObject().apply {
        put("ok", false)
        put("code", "ACCESSIBILITY_NOT_ENABLED")
        put("error", "手机操控服务（无障碍）尚未开启")
        put("hint", "在系统设置 → 无障碍 / 已下载的应用里开启「DeepSeek」；开启后这些工具即可用")
        put("note", "这是「电脑端操控桌面」的手机端等价能力，授权完全由用户掌控，可随时关闭")
    }.toString()

    /**
     * 系统提示段落 —— 桌面 computer-use 在提供方就绪后往 system-prompt waterfall
     * 里加一段「怎么观察、怎么操作」；这里同款，且只在服务真的开启时才加，
     * 避免模型以为能点时点了没反应。
     */
    override fun promptSection(): String? {
        if (!PhoneControlService.enabled) return null
        return """
            |你可以直接操控这台手机（用户已开启无障碍服务），这就是电脑端「操控桌面」的手机版：
            |· 观察：先 screen_read 拿结构化界面（元素带 index / 文本 / 资源 id / 坐标 / 是否可输入；
            |  结果里的 screen.w/h 是真实屏幕尺寸，做「屏幕下方/右侧边缘」这类坐标推理时用它），
            |  节点树拿不到内容时（游戏、自绘界面）用 phone_screenshot 直接看画面
            |  （截图已压缩到 1080 宽，拿截图里的位置点坐标时按 screen.w/h 比例换算）。
            |· 定位优先级：index（最稳）→ 资源 id → 文本 → 坐标。
            |· 指针：phone_tap / phone_long_press / phone_swipe / phone_scroll / phone_scroll_until /
            |  phone_gesture（任意轨迹）/ phone_drag（按住拖拽、排序、滑杆）/ phone_pinch（双指缩放）。
            |· 文本：phone_set_text（直接写指定输入框）/ phone_type（写焦点框）/ phone_clear_text /
            |  phone_form_fill（一次填多字段）/ phone_ime_enter（搜索/完成键）/ phone_clipboard（读、写、粘贴）。
            |· 状态：phone_toggle 切开关并回报新状态；phone_wait 等目标文本出现再继续。
            |· 系统：phone_key（back/home/recents/notifications/quick_settings/lock_screen/
            |  split_screen/take_screenshot/dismiss_shade）、phone_notifications（展开并读通知）、
            |  phone_volume、phone_media。
            |· 应用：phone_list_apps → phone_open_app / phone_app_info；系统能力用 phone_launch（tel: smsto: https: geo:）。
            |· 快照：screen_read 返回 snapshot token 与 epoch；phone_tap / set_text / clear_text /
            |  form_fill / toggle 可带 snapshot 参数（并发读屏或隔了几轮操作时建议显式传）。
            |  结果里的 ui_changed 表示点击/输入后界面是否变化（两轮观察，共约 0.9s）：
            |  false 不一定是失败，可能点在无反应处或自绘界面，换 screen_read 复核。
            |· ordinal：同名元素（列表里多个「更多」）用 ordinal 取第 N 个（1 起）。
            |· 纪律：每步操作后用 screen_read 或 phone_wait 确认结果；不要盲点坐标；
            |  界面没变化就换定位方式（文本 → id → 坐标），连续两次失败就停下来问用户。
            |· 授权：档位决定要不要问 —— **完全访问下不逐条确认**；只读/标准下，首次操作某个应用
            |  （open_app / launch / foreground）会请用户确认一次，支付/转账/确认支付/授权/删除/
            |  发送/验证码等敏感界面，以及银行/支付/验证码类应用的每一步都要逐次确认。后台、
            |  团队、委派里没有确认通道，这类操作直接返回 code=APP_APPROVAL_UNAVAILABLE；用户
            |  拒绝返回 APP_APPROVAL_DENIED —— 都不要重试，如实告诉用户需要他确认或亲自操作。
            |· 视觉兜底：节点树拿不到内容的应用（自绘/游戏/藏节点的银行类），screen_read 会
            |  自动附屏幕截图——看图定位，按 screen.w/h 与截图宽高比例换算坐标直接 phone_tap x,y。
            |  也可 screen_read visual:true 主动要截图。不要因为「元素是空的」就放弃操控。
            |· 不抢屏：操控随时可用（没有前台/后台模式之分）；唯一让路条件是**用户正在摸屏幕**
            |  （最近 2.5s 内有触摸）——此时改动屏幕的操作排队 15s，等不到返回 APP_USER_BUSY，
            |  灵动岛会显示「排队」。他息屏、回到 App 或手停下后自动继续。排队期间不要连续重试；
            |  只读的 screen_read / phone_screenshot 不排队。操控停下/等确认的原因会显示在灵动岛上。
        """.trimMargin()
    }

    private fun svc(): PhoneControlService? = PhoneControlService.instance?.also {
        // 文件权限档位降档时，手机操控的运行时授权同步作废（见 PhoneApprovalPolicy）
        it.noteSandboxMode(ctx?.sandbox?.mode?.name)
    }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "screen_read"
            override val description = "读取当前屏幕的结构化内容：前台应用、可交互元素、结构化节点树（含 resource-id）、" +
                "页面文本大纲。elements 只装可交互节点，nodes 里连非交互控件也带 res_id（微信输入框这类" +
                "没有 clickable 但有 id 的控件，用 phone_tap id=... 精准定位，不用坐标蒙）。" +
                "同一屏连续读会命中缓存（返回 cached:true）；传 since=<上次 snapshot> 还会附新旧节点 diff。" +
                "节点树彻底拿不到内容的应用（自绘/游戏/藏节点的银行类）会自动附屏幕截图。"
            override val parameters = schema(
                JSONObject()
                    .put("max_elements", JSONObject().put("type", "number")
                        .put("description", "最多返回多少个可交互元素，默认 60"))
                    .put("settle_ms", JSONObject().put("type", "number")
                        .put("description", "读屏前等待界面落定的毫秒，默认 200（刚点击/滚动完可加大到 500）"))
                    .put("since", JSONObject().put("type", "string")
                        .put("description", "上一次 screen_read 返回的 snapshot token；传了就附新旧节点 diff（added/removed/changed）"))
                    .put("visual", JSONObject().put("type", "boolean")
                        .put("description", "true=无论节点树是否有内容都附屏幕截图（默认空=仅节点树为空时自动附）")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String {
                // 无上限时模型传 2000 会拿回 2000 个元素，JSON 被内核截断腰斩后反而解析失败
                val raw = svc()?.readScreen(
                    args.optInt("max_elements", 60).coerceIn(10, 120),
                    args.optInt("settle_ms", 200),
                    args.optString("since").takeIf { it.isNotBlank() },
                ) ?: return notEnabled()
                return withVisualFallback(raw, args.optBoolean("visual"))
            }

            /**
             * 视觉兜底：节点树为空（应用自绘 / 未向无障碍暴露 / 多窗口全空）时自动截屏
             * 注入对话 —— 观测的第二级。桌面 computer-use 本就是视觉路线，手机端
             * 节点树只是「快路径」，不是唯一路径；任何应用都有出路。
             */
            private fun withVisualFallback(raw: String, force: Boolean): String {
                val obj = runCatching { JSONObject(raw) }.getOrNull() ?: return raw
                val needed = force || obj.optBoolean("visual_needed")
                if (!needed || obj.has("visual")) return raw
                val s = svc() ?: return raw
                val png = s.screenshotJpeg() ?: return raw
                val rt = ctx?.service("agent.runtime") as? ToolPipeline.RuntimeTools
                val injected = rt?.addImageData(ImageResize.dataUrl(png, "image/jpeg"), "屏幕截图（节点树为空，视觉模式）")
                val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeByteArray(png, 0, png.size, bounds)
                obj.put("visual", true)
                obj.put("img_width", bounds.outWidth)
                obj.put("img_height", bounds.outHeight)
                obj.put("injected", injected != null)
                obj.remove("visual_needed")
                obj.put("note", "已附屏幕截图（节点树无内容）——看图定位，坐标换算按 screen.w/h 与 " +
                    "img_width/img_height 的比例，直接 phone_tap x,y" +
                    if (injected != null) "" else "（本轮没有注入通道，请改调 phone_screenshot）")
                return obj.toString()
            }
        },
        object : ToolSpec {
            override val name = "phone_batch"
            override val description = "一次提交多步手机动作（最多 8 步），中间不回传、末尾统一确认：" +
                "点 A → 等 B → 打字 → 点 C。只适合「路径确定」的连续操作；路径不确定时用单步工具，因为批量里看不到中间界面。" +
                "返回每步结果 + 整屏 diff（added/removed/changed）：diff 全空说明这几步没改变任何可见控件（多半没点中）。"
            override val parameters = schema(
                JSONObject()
                    .put("steps", JSONObject().put("type", "array").put(
                        "description",
                        "步骤数组，每步 {action, ...}。action=tap 用 index/id/text/x+y 之一定位；" +
                            "type 用 text（给 index/id 时先聚焦再写）；另有 wait/swipe/scroll/open_app",
                    ))
                    .put("stop_on_error", JSONObject().put("type", "boolean")
                        .put("description", "默认 true：任一步失败即停，返回里的 stopped_at 指出停在第几步"))
                    .put("description", JSONObject().put("type", "string")
                        .put("description", "一句话说明这批在做什么（5-10 个字）")),
                listOf("steps"),
            )
            override fun execute(args: JSONObject): String {
                val s = svc() ?: return notEnabled()
                return s.batch(args)
            }
        },
        object : ToolSpec {
            override val name = "phone_wait"
            override val description = "等待：等到某个文本出现（推荐，点完之后用它确认页面真的变了），" +
                "或不带 text 只等界面落定。"
            override val parameters = schema(
                JSONObject()
                    .put("text", JSONObject().put("type", "string").put("description", "期望出现的文本，可省略"))
                    .put("timeout_ms", JSONObject().put("type", "number").put("description", "超时，默认 5000")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String =
                svc()?.waitFor(args.optString("text").ifBlank { null }, args.optLong("timeout_ms", 5000))
                    ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_tap"
            override val description = "点击屏幕：给出元素文本（自动定位，会向上找可点祖先）、资源 id，或绝对坐标（x,y，来自 screen_read 的 bounds）。"
            override val parameters = schema(
                JSONObject()
                    .put("text", JSONObject().put("type", "string").put("description", "元素文本（与 id / index / x,y 四选一）"))
                    .put("id", JSONObject().put("type", "string").put("description", "资源 id 末段，如 search_bar（screen_read 的 id 字段）"))
                    .put("index", JSONObject().put("type", "number").put("description", "screen_read 返回的 index（最稳，推荐）"))
                    .put("ordinal", JSONObject().put("type", "number")
                        .put("description", "同名元素取第几个（1 起，默认 1）。列表里第 N 个「更多」用它"))
                    .put("exact", JSONObject().put("type", "boolean").put("description", "文本是否精确匹配，默认模糊"))
                    .put("snapshot", JSONObject().put("type", "string")
                        .put("description", "screen_read 返回的 snapshot token；并发读屏（子智能体）时建议显式传，缺省用最近一次"))
                    .put("x", JSONObject().put("type", "number").put("description", "屏幕坐标 x（px）"))
                    .put("y", JSONObject().put("type", "number").put("description", "屏幕坐标 y（px）")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String {
                val s = svc() ?: return notEnabled()
                val text = args.optString("text")
                val id = args.optString("id")
                val token = args.optString("snapshot").ifBlank { null }
                return when {
                    args.has("index") && args.optInt("index", -1) >= 0 -> s.tapIndex(args.optInt("index"), token)
                    text.isNotBlank() -> s.tapText(text, args.optBoolean("exact"), args.optInt("ordinal", 1))
                    id.isNotBlank() -> s.tapId(id)
                    args.has("x") && args.has("y") -> s.tap(args.optInt("x"), args.optInt("y"))
                    else -> JSONObject().apply {
                        put("ok", false); put("code", "BAD_ARGS")
                        put("error", "需要 index / text / id / x+y 其中一种")
                    }.toString()
                }
            }
        },
        object : ToolSpec {
            override val name = "phone_swipe"
            override val description = "滑动屏幕：按方向（up/down/left/right）或给定起止坐标。"
            override val parameters = schema(
                JSONObject()
                    .put("direction", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("up", "down", "left", "right"))).put("description", "方向，省略时用坐标"))
                    .put("distance", JSONObject().put("type", "number").put("description", "方向滑动的距离 px，默认 600"))
                    .put("x1", JSONObject().put("type", "number"))
                    .put("y1", JSONObject().put("type", "number"))
                    .put("x2", JSONObject().put("type", "number"))
                    .put("y2", JSONObject().put("type", "number"))
                    .put("duration_ms", JSONObject().put("type", "number").put("description", "时长，默认 300")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String {
                val s = svc() ?: return notEnabled()
                val dir = args.optString("direction")
                return if (dir.isNotBlank()) s.swipeDirection(dir, args.optInt("distance", 600))
                else if (args.has("x1") && args.has("y1") && args.has("x2") && args.has("y2")) {
                    s.swipe(args.optInt("x1"), args.optInt("y1"), args.optInt("x2"), args.optInt("y2"),
                        args.optLong("duration_ms", 300))
                } else JSONObject().apply {
                    put("ok", false); put("code", "BAD_ARGS")
                    put("error", "需要 direction 或完整坐标（x1/y1/x2/y2）")
                }.toString()
            }
        },
        object : ToolSpec {
            override val name = "phone_type"
            override val description = "向当前获得焦点的输入框写入文本（先 phone_tap 点一下输入框）。"
            override val parameters = schema(
                JSONObject().put("text", JSONObject().put("type", "string").put("description", "要写入的文本")),
                listOf("text"),
            )
            override fun execute(args: JSONObject): String =
                svc()?.type(args.optString("text")) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_key"
            override val description = "系统级按键：back / home / recents / notifications / quick_settings / " +
                "power_dialog / lock_screen / split_screen / take_screenshot / dismiss_shade。"
            override val parameters = schema(
                JSONObject().put("key", JSONObject().put("type", "string")
                    .put("enum", JSONArray(listOf("back", "home", "recents", "notifications",
                        "quick_settings", "power_dialog", "lock_screen", "split_screen",
                        "take_screenshot", "dismiss_shade")))),
                listOf("key"),
            )
            override fun execute(args: JSONObject): String =
                svc()?.key(args.optString("key")) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_open_app"
            override val description = "按包名启动一个已安装应用（先用 phone_list_apps 查包名）。"
            override val parameters = schema(
                JSONObject().put("package", JSONObject().put("type", "string").put("description", "应用包名，如 com.android.settings")),
                listOf("package"),
            )
            override fun execute(args: JSONObject): String =
                svc()?.openApp(args.optString("package")) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_list_apps"
            override val description = "列出已安装且可启动的应用（包名 + 名称），供 phone_open_app 选择。"
            override val parameters = schema(
                JSONObject().put("limit", JSONObject().put("type", "number").put("description", "最多返回多少个，默认 100")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String =
                svc()?.listApps(args.optInt("limit", 100)) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_launch"
            override val description = "用 Intent URI 唤起系统能力：打电话（tel:）、短信（smsto:）、网页（https:）、" +
                "设置（settings 动作）、地图（geo:）等。"
            override val parameters = schema(
                JSONObject()
                    .put("uri", JSONObject().put("type", "string").put("description", "Intent URI，如 https://… 或 tel:10086"))
                    .put("action", JSONObject().put("type", "string").put("description", "可选，覆盖 Intent action")),
                listOf("uri"),
            )
            override fun execute(args: JSONObject): String =
                svc()?.launch(args.optString("uri"), args.optString("action").ifBlank { null }) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_scroll"
            override val description = "滚动列表/页面（比坐标滑动可靠）：优先对可滚动容器派发无障碍滚动，不响应时退化为手势。"
            override val parameters = schema(
                JSONObject()
                    .put("direction", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("up", "down"))).put("description", "down = 往后翻（看下面的内容）"))
                    .put("text", JSONObject().put("type", "string")
                        .put("description", "可选：滚动这个元素所在的可滚动容器；省略则滚当前页第一个可滚动区域"))
                    .put("pages", JSONObject().put("type", "number").put("description", "滚动几次，默认 1，上限 5")),
                listOf("direction"),
            )
            override fun execute(args: JSONObject): String =
                svc()?.scroll(args.optString("direction"), args.optString("text").ifBlank { null },
                    args.optInt("pages", 1)) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_long_press"
            override val description = "长按元素（弹出菜单、多选、拖拽前的常见操作）。"
            override val parameters = schema(
                JSONObject()
                    .put("text", JSONObject().put("type", "string").put("description", "元素文本"))
                    .put("duration_ms", JSONObject().put("type", "number").put("description", "时长，默认 700")),
                listOf("text"),
            )
            override fun execute(args: JSONObject): String =
                svc()?.longPress(args.optString("text"), args.optLong("duration_ms", 700)) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_screenshot"
            override val description = "截取当前屏幕并加入对话（模型下一轮就能看到图像）。" +
                "读屏拿不到有效文本（游戏、自绘界面、图片界面）时用它。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String {
                val s = svc() ?: return notEnabled()
                if (!s.canScreenshot()) return JSONObject().apply {
                    put("ok", false); put("code", "SCREENSHOT_UNSUPPORTED")
                    put("error", "系统版本低于 Android 11，无障碍截图不可用")
                    put("hint", "改用 screen_read 的节点树观察屏幕")
                }.toString()
                val png = s.screenshotJpeg() ?: return JSONObject().apply {
                    put("ok", false); put("code", "SCREENSHOT_FAILED")
                    put("error", s.lastShotError ?: "系统没有返回截图")
                    put("hint", "先把本应用切到前台一次（无障碍截图权限在应用被杀后需重新开启），或改用 screen_read")
                }.toString()
                val c = ctx ?: return """{"ok":false,"code":"NO_CONTEXT","error":"插件未挂载"}"""
                return try {
                    val dir = c.workspace.resolve(".dsh/screens")
                    if (!dir.exists()) dir.mkdirs()
                    val f = java.io.File(dir, "screen-${System.currentTimeMillis()}.jpg")
                    f.writeBytes(png)
                    val rel = c.workspace.relative(f)
                    // 注入对话：与 read_image 同一条通道，但先过 ImageResize ——
                    // 截图进对话是为了让模型看 UI，1600px 长边绰绰有余；
                    // 落盘文件仍是 1080px 原图（文件页/分享用高清）
                    val rt = c.service("agent.runtime") as? ToolPipeline.RuntimeTools
                    val injected = rt?.addImageData(ImageResize.dataUrl(png, "image/jpeg"), "屏幕截图")
                    // 模型常拿截图里的像素位置去 phone_tap：把截图尺寸一起给出，
                    // 它才能按 screen_read 的 screen.w/h 比例换算坐标
                    // （截图落盘前被压到 1080 宽，不是屏幕原始尺寸）
                    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    android.graphics.BitmapFactory.decodeByteArray(png, 0, png.size, bounds)
                    JSONObject().apply {
                        put("ok", true)
                        put("path", rel)
                        put("bytes", png.size)
                        put("width", bounds.outWidth)
                        put("height", bounds.outHeight)
                        put("injected", injected != null)
                        put("note", if (injected != null) "截图已加入对话，下一轮可见" else "截图已保存（当前不在对话轮次中，未注入）")
                    }.toString()
                } catch (e: Throwable) {
                    JSONObject().put("ok", false).put("code", "SAVE_FAILED")
                        .put("error", "截图保存失败：${e.message}").toString()
                }
            }
        },
        /* ---- 编辑类 ---- */
        object : ToolSpec {
            override val name = "phone_set_text"
            override val description = "直接给指定输入框写文本（不用先点击聚焦；比 phone_type 精确）。" +
                "目标可用 index / id / text 定位，都不给则写当前焦点输入框。"
            override val parameters = schema(
                JSONObject()
                    .put("value", JSONObject().put("type", "string").put("description", "要写入的文本"))
                    .put("index", JSONObject().put("type", "number").put("description", "screen_read 的 index"))
                    .put("id", JSONObject().put("type", "string").put("description", "资源 id 末段"))
                    .put("text", JSONObject().put("type", "string").put("description", "输入框附近的文本（占位符/标题）"))
                    .put("snapshot", JSONObject().put("type", "string")
                        .put("description", "screen_read 返回的 snapshot token，缺省用最近一次")),
                listOf("value"),
            )
            override fun execute(args: JSONObject): String = svc()?.setText(
                if (args.has("index")) args.optInt("index") else null,
                args.optString("id").ifBlank { null },
                args.optString("text").ifBlank { null },
                args.optString("value"),
                args.optString("snapshot").ifBlank { null },
            ) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_clear_text"
            override val description = "清空输入框（等价全选删除）。定位方式同 phone_set_text。"
            override val parameters = schema(
                JSONObject()
                    .put("index", JSONObject().put("type", "number"))
                    .put("id", JSONObject().put("type", "string"))
                    .put("text", JSONObject().put("type", "string"))
                    .put("snapshot", JSONObject().put("type", "string")
                        .put("description", "screen_read 返回的 snapshot token，缺省用最近一次")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String = svc()?.clearText(
                if (args.has("index")) args.optInt("index") else null,
                args.optString("id").ifBlank { null },
                args.optString("text").ifBlank { null },
                args.optString("snapshot").ifBlank { null },
            ) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_ime_enter"
            override val description = "提交输入框内容（键盘上的「搜索 / 完成 / 发送」键）。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String = svc()?.imeEnter() ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_form_fill"
            override val description = "一次填多个字段：[{label|index|id, value}]，逐项定位写入并回报每条结果。"
            override val parameters = schema(
                JSONObject().put("fields", JSONObject()
                    .put("type", "array")
                    .put("description", "字段数组，如 [{label:\"用户名\",value:\"alice\"},{label:\"密码\",value:\"x\"}]")
                    .put("items", JSONObject().put("type", "object").put("properties", JSONObject()
                        .put("label", JSONObject().put("type", "string"))
                        .put("index", JSONObject().put("type", "number"))
                        .put("id", JSONObject().put("type", "string"))
                        .put("value", JSONObject().put("type", "string")))))
                    .put("snapshot", JSONObject().put("type", "string")
                        .put("description", "screen_read 返回的 snapshot token，缺省用最近一次")),
                listOf("fields"),
            )
            override fun execute(args: JSONObject): String {
                val fields = args.optJSONArray("fields") ?: return """{"ok":false,"code":"BAD_ARGS","error":"fields 必须是数组"}"""
                return svc()?.formFill(fields, args.optString("snapshot").ifBlank { null }) ?: notEnabled()
            }
        },
        object : ToolSpec {
            override val name = "phone_toggle"
            override val description = "切换开关/复选项并回报切换后的状态（读不回来会如实说明，不会假装成功）。"
            override val parameters = schema(
                JSONObject()
                    .put("text", JSONObject().put("type", "string").put("description", "开关的文本标签"))
                    .put("index", JSONObject().put("type", "number").put("description", "也可以用 screen_read 的 index"))
                    .put("checked", JSONObject().put("type", "boolean")
                        .put("description", "期望值，可选：当前值已经等于它就不点（幂等）"))
                    .put("snapshot", JSONObject().put("type", "string")
                        .put("description", "screen_read 返回的 snapshot token，缺省用最近一次")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String {
                val s = svc() ?: return notEnabled()
                val want = if (args.has("checked")) args.optBoolean("checked") else null
                return s.toggle(args.optString("text"),
                    if (args.has("index")) args.optInt("index") else null, want,
                    args.optString("snapshot").ifBlank { null })
            }
        },

        /* ---- 手势族 ---- */
        object : ToolSpec {
            override val name = "phone_gesture"
            override val description = "任意轨迹手势：给一串点，画线/滑杆/签名/连续滑动都能表达；" +
                "hold_ms>0 时先按住再走（拖拽排序）。"
            override val parameters = schema(
                JSONObject()
                    .put("points", JSONObject().put("type", "array")
                        .put("description", "点数组，如 [{x:100,y:800},{x:300,y:400}] 或 [[100,800],[300,400]]")
                        .put("items", JSONObject().put("type", "object")))
                    .put("duration_ms", JSONObject().put("type", "number").put("description", "总时长，默认 400"))
                    .put("hold_ms", JSONObject().put("type", "number").put("description", "起点按住时长，默认 0")),
                listOf("points"),
            )
            override fun execute(args: JSONObject): String {
                val pts = args.optJSONArray("points")
                    ?: return """{"ok":false,"code":"BAD_ARGS","error":"points 必须是数组"}"""
                return svc()?.gesture(pts, args.optLong("duration_ms", 400), args.optLong("hold_ms", 0))
                    ?: notEnabled()
            }
        },
        object : ToolSpec {
            override val name = "phone_drag"
            override val description = "拖拽：按住起点不放，拖到终点（列表排序、滑杆、拖放上传）。"
            override val parameters = schema(
                JSONObject()
                    .put("x1", JSONObject().put("type", "number"))
                    .put("y1", JSONObject().put("type", "number"))
                    .put("x2", JSONObject().put("type", "number"))
                    .put("y2", JSONObject().put("type", "number"))
                    .put("duration_ms", JSONObject().put("type", "number").put("description", "拖动时长，默认 600"))
                    .put("hold_ms", JSONObject().put("type", "number").put("description", "起手按住多久，默认 450")),
                listOf("x1", "y1", "x2", "y2"),
            )
            override fun execute(args: JSONObject): String = svc()?.drag(
                args.optInt("x1"), args.optInt("y1"), args.optInt("x2"), args.optInt("y2"),
                args.optLong("duration_ms", 600), args.optLong("hold_ms", 450),
            ) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_pinch"
            override val description = "双指缩放：in 放大 / out 缩小（地图、图片、网页）。"
            override val parameters = schema(
                JSONObject()
                    .put("direction", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("in", "out"))).put("description", "in 放大，out 缩小"))
                    .put("x", JSONObject().put("type", "number").put("description", "中心 x，默认屏幕中心"))
                    .put("y", JSONObject().put("type", "number").put("description", "中心 y，默认屏幕中心"))
                    .put("distance", JSONObject().put("type", "number").put("description", "指间距变化幅度，默认 300")),
                listOf("direction"),
            )
            override fun execute(args: JSONObject): String = svc()?.pinch(
                args.optString("direction"),
                if (args.has("x")) args.optInt("x") else null,
                if (args.has("y")) args.optInt("y") else null,
                args.optInt("distance", 300),
            ) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_scroll_until"
            override val description = "一直滚直到某文本出现（长列表/设置页找条目，比反复 screen_read 省轮次）。"
            override val parameters = schema(
                JSONObject()
                    .put("text", JSONObject().put("type", "string").put("description", "要找的文本"))
                    .put("direction", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("down", "up"))).put("description", "默认 down"))
                    .put("max_pages", JSONObject().put("type", "number").put("description", "最多滚几次，默认 6")),
                listOf("text"),
            )
            override fun execute(args: JSONObject): String = svc()?.scrollUntil(
                args.optString("text"), args.optString("direction", "down"), args.optInt("max_pages", 6),
            ) ?: notEnabled()
        },

        /* ---- 设备能力 ---- */
        object : ToolSpec {
            override val name = "phone_clipboard"
            override val description = "剪贴板：get 读取 / set 写入 / paste 粘贴到当前输入框。"
            override val parameters = schema(
                JSONObject()
                    .put("action", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("get", "set", "paste"))))
                    .put("text", JSONObject().put("type", "string").put("description", "set 时的内容")),
                listOf("action"),
            )
            override fun execute(args: JSONObject): String =
                svc()?.clipboard(args.optString("action"), args.optString("text").ifBlank { null })
                    ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_volume"
            override val description = "媒体音量：up / down / mute / set(percent) / get。"
            override val parameters = schema(
                JSONObject()
                    .put("action", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("up", "down", "mute", "set", "get"))))
                    .put("percent", JSONObject().put("type", "number").put("description", "set 时的 0-100")),
                listOf("action"),
            )
            override fun execute(args: JSONObject): String = svc()?.volume(
                args.optString("action"), if (args.has("percent")) args.optInt("percent") else null,
            ) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_media"
            override val description = "媒体播放控制：play / pause / play_pause / next / prev / stop。"
            override val parameters = schema(
                JSONObject().put("action", JSONObject().put("type", "string")
                    .put("enum", JSONArray(listOf("play", "pause", "play_pause", "next", "prev", "stop")))),
                listOf("action"),
            )
            override fun execute(args: JSONObject): String =
                svc()?.media(args.optString("action")) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_notifications"
            override val description = "展开通知栏并读出里面的通知（可选直接点某一条）。"
            override val parameters = schema(
                JSONObject().put("text", JSONObject().put("type", "string")
                    .put("description", "可选：要点开的那条通知的文本")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String =
                svc()?.notifications(args.optString("text").ifBlank { null }) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_app_info"
            override val description = "查应用的包信息（名称/版本/是否启用/可否启动/安装时间）。"
            override val parameters = schema(
                JSONObject().put("package", JSONObject().put("type", "string").put("description", "应用包名")),
                listOf("package"),
            )
            override fun execute(args: JSONObject): String =
                svc()?.appInfo(args.optString("package")) ?: notEnabled()
        },
        object : ToolSpec {
            override val name = "phone_foreground"
            override val description = "读取当前前台应用包名与窗口数（确认操作是否落在预期应用上）。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String =
                svc()?.foreground() ?: notEnabled()
        },
    )
}
