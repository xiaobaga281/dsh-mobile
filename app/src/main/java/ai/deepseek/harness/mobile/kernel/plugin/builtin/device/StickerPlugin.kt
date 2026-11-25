package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.StickerStore
import ai.deepseek.harness.mobile.agent.ToolPipeline
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * 表情包 —— 像人在聊天里那样发表情包。
 *
 * 三个工具：
 *  - `sticker_list`  看仓库里有哪些（用户发过的 + Agent 存的），按使用频率排序
 *  - `sticker_use`   把某个表情包发到对话里（本轮结束时出现在这一轮末尾）
 *  - `sticker_save`  收表情包：用户刚发的那张图，或按 id/name 给已有表情加权
 *  - `sticker_remove` 删掉一个表情包（用户嫌弃某个表情、或收错了）
 *
 * 时机约束和桌面 present 一致：只在轮次内发送，且统一在轮次结束推给界面，
 * 不会在工具过程中间突然插一张图。
 */
class StickerPlugin : KernelPlugin, ai.deepseek.harness.mobile.kernel.plugin.TurnScopedPlugin {
    override val id = "stickers"
    override val name = "表情包"
    override val description = "聊天表情包：列举、发送、收藏（静图与 GIF 动图）"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var store: StickerStore? = null
    private var storeFile: java.io.File? = null
    private var sink: ((JSONObject) -> Unit)? = null
    /**
     * 视觉标注能力随轮次提供（AgentDriver 每轮 provideService("agent.caption")），
     * 所以不能像其它服务那样在 onLoad 抓一次快照 —— 那时还没有任何一轮在跑，拿到的是 null。
     */
    private fun captioner(): ai.deepseek.harness.mobile.kernel.plugin.ImageCaptioner? =
        ctx?.service("agent.caption") as? ai.deepseek.harness.mobile.kernel.plugin.ImageCaptioner
    /** 后台补标注用：串行，避免同时打多个视觉请求；只在缺描述时排队 */
    private val captionExec = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "sticker-caption").apply { isDaemon = true }
    }
    private val captioning = java.util.Collections.synchronizedSet(HashSet<String>())
    private var sent = 0
    /** 本轮已发过几个 / 发过哪些：防的是「同一个表情连续轰炸」，不是禁止一轮发两个不同的 */
    private var turnSent = 0
    private val turnIds = HashSet<String>()
    /** 上一轮发过的表情：同一个表情连着两轮出现，看着就像复读机 */
    private var prevTurnIds = HashSet<String>()
    /** 仓库清单进系统提示：图片本体很大，按文件 mtime 缓存一份摘要，别每轮重解析 base64 */
    private var catalogCache: String? = null
    private var catalogStamp = -1L

    companion object {
        /** 提示里最多列几个：够模型挑就行，全量让 sticker_list 给 */
        private const val PROMPT_ITEMS = 16
    }

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        val dir = (ctx.service("plugin.dir") as? java.io.File)?.parentFile
            ?: ctx.workspace.root.parentFile
        val f = java.io.File(dir, "stickers.json")
        storeFile = f
        store = StickerStore(f)
        sink = ctx.service("sticker.sink") as? ((JSONObject) -> Unit)
    }

    override fun onUnload() {
        ctx = null; store = null; sink = null; storeFile = null; catalogCache = null
        runCatching { captionExec.shutdownNow() }
    }

    override fun beginTurn() {
        turnSent = 0
        prevTurnIds = HashSet(turnIds)
        turnIds.clear()
    }

    /**
     * 本轮结束后补画面描述：老表情、或存的时候标注失败的那些，一次补几个，
     * 串行跑在独立线程。放在轮次结束是因为视觉请求和主对话共用同一个模型槽位 ——
     * 轮内发会在用户等回答时排队，轮后发才是白捡的。
     */
    override fun endTurn() {
        val st = store ?: return
        if (captioner() == null) {
            android.util.Log.d("StickerPlugin", "endTurn: 没有视觉标注能力（agent.caption 未提供）")
            return
        }
        val todo = runCatching { st.ranked() }.getOrDefault(emptyList())
            .filter { descOf(it).isBlank() && it.optString("dataUrl").startsWith("data:image/") }
            .take(6)
        android.util.Log.d("StickerPlugin", "endTurn: 待补描述 ${todo.size} 个")
        todo.forEach { queueCaption(it.optString("id"), it.optString("dataUrl")) }
    }

    /**
     * 表情包清单写进系统提示 —— 这是「Agent 不知道 id」的根因所在。
     *
     * 以前 id 只出现在 `sticker_list` 的返回值里，系统提示里只有使用规范、没有仓库。
     * 模型于是要么凭印象编一个 id（"1"、"smile"），要么为了拿 id 白跑一轮工具；
     * 上下文小的模型两步都容易走歪，最后就是「表情发出来了，但 id 是猜的」。
     * id 本来就是给模型用的句柄，就该一直在它眼前。仓库变了，下一轮装配的提示自然跟着变。
     */
    override fun promptSection(): String? {
        val st = store ?: return null
        val f = storeFile
        val stamp = if (f != null && f.exists()) f.lastModified() * 31 + f.length() else -1L
        if (stamp == catalogStamp) return catalogCache
        val items = runCatching { st.ranked() }.getOrDefault(emptyList())
        val list = items.take(PROMPT_ITEMS).mapNotNull { it0 ->
            val id = it0.optString("id").trim()
            if (id.isBlank()) return@mapNotNull null
            val nm = it0.optString("name").ifBlank { "表情" }.take(12)
            val kind = if (it0.optString("kind") == "gif") "动图" else "静图"
            val desc = it0.optString("desc").trim().take(40)
            if (desc.isNotBlank()) {
                "$id=$nm：$desc（$kind）"
            } else {
                // 不在轮内触发标注：视觉请求和主对话抢同一个模型槽位，会把回答拖慢
                "$id=$nm（$kind·画面未标注，可 sticker_look）"
            }
        }
        val text = if (list.isEmpty()) {
            "表情包仓库现在是空的：没有可发的表情。用户想要表情时如实说明（让他在加号面板里存一张），不要假装发了。"
        } else {
            val more = if (items.size > list.size) "，另有 ${items.size - list.size} 个用 sticker_list 看" else ""
            "表情包仓库（共 ${items.size} 个$more）。格式是 id=名字：画面内容（类型），" +
                "照抄 id 不要自己编号：" + list.joinToString("、")
        }
        catalogStamp = stamp
        catalogCache = text
        return text
    }

    /**
     * 定位一个表情：精确 id → id 前缀 → 名字（先全等再包含）。
     * 模型抄 id 时常漏字符、带引号或多写空格，这里先容错再谈报错 —— 报错只会让它再猜一次。
     */
    private fun resolve(st: StickerStore, id: String, name: String): JSONObject? {
        val key = id.trim().trim('"', '\'', '`', '「', '」', ' ')
        if (key.isNotBlank()) {
            st.find(key)?.let { return it }
            val all = st.ranked()
            all.firstOrNull { it.optString("id").startsWith(key, ignoreCase = true) }?.let { return it }
        }
        val want = name.trim()
        if (want.isNotBlank()) {
            val all = st.ranked()
            all.firstOrNull { it.optString("name").equals(want, ignoreCase = true) }?.let { return it }
            all.firstOrNull { it.optString("name").contains(want, ignoreCase = true) }?.let { return it }
        }
        return null
    }

    override fun status(): Map<String, String> = mapOf("已发送" to sent.toString())

    /** 这张表情的画面内容（没标注过就是空串） */
    private fun descOf(it: JSONObject): String = it.optString("desc").trim()

    /** 同步看一眼并写回仓库：用户在等结果（look/save）时用，别让描述一直是空的 */
    private fun captionNow(item: JSONObject): String {
        val have = descOf(item)
        if (have.isNotBlank()) return have
        val cap = captioner() ?: return ""
        val url = item.optString("dataUrl")
        if (!url.startsWith("data:image/")) return ""
        val d = runCatching { cap.caption(url) }.getOrNull().orEmpty()
        if (d.isNotBlank()) {
            store?.describe(item.optString("id"), d)
            catalogStamp = -1L
        }
        return d
    }

    /** 后台补标注：清单里发现没描述的条目时排队，串行执行，不并发打视觉模型 */
    private fun queueCaption(id: String, dataUrl: String) {
        val st = store ?: return
        val cap = captioner() ?: return
        if (id.isBlank() || !dataUrl.startsWith("data:image/")) return
        if (!captioning.add(id)) return
        runCatching {
            captionExec.execute {
                try {
                    val d = cap.caption(dataUrl)
                    android.util.Log.d("StickerPlugin", "标注 $id -> ${d ?: "null"}")
                    if (!d.isNullOrBlank()) {
                        st.describe(id, d)
                        catalogStamp = -1L
                    }
                } catch (_: Throwable) {
                } finally {
                    captioning.remove(id)
                }
            }
        }.onFailure { captioning.remove(id) }
    }

    private fun schema(props: JSONObject, required: List<String> = emptyList()): JSONObject =
        JSONObject().apply {
            put("type", "object")
            put("properties", props)
            put("required", JSONArray(required))
            put("additionalProperties", false)
        }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "sticker_list"
            override val description =
                "列出表情包仓库（按使用频率排序）：id、名字、类型（静图/动图）、画面内容 desc、用过几次。" +
                    "desc 是视觉模型看过的画面描述；没有 desc 的条目说明还没看过画面，挑它之前用 sticker_look 看一眼。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String {
                val items = JSONArray()
                store?.ranked()?.forEach { it0 ->
                    val desc0 = descOf(it0)
                    items.put(JSONObject().apply {
                        put("id", it0.optString("id"))
                        put("name", it0.optString("name"))
                        put("kind", if (it0.optString("kind") == "gif") "gif" else "static")
                        put("desc", desc0)
                        put("uses", it0.optInt("uses"))
                        put("by", it0.optString("by"))
                    })
                }
                return JSONObject().put("ok", true).put("count", items.length())
                    .put("items", items).toString()
            }
        },
        object : ToolSpec {
            override val name = "sticker_look"
            override val description =
                "看一眼某个表情包到底画的是什么：把这张图加进对话，同时把画面描述记进仓库（之后清单里直接有内容）。" +
                    "用户问「这个表情是什么意思」、或清单里 desc 为空/对不上语境时先用它。"
            override val parameters = schema(
                JSONObject()
                    .put("id", JSONObject().put("type", "string").put("description", "「表情包仓库」里的 id，照抄"))
                    .put("name", JSONObject().put("type", "string").put("description", "或按名字模糊匹配")),
            )
            override fun execute(args: JSONObject): String {
                val st = store ?: throw KernelError("表情包仓库未就绪")
                val id = args.optString("id").trim()
                val want = args.optString("name").trim()
                val hit: JSONObject? = resolve(st, id, want)
                if (hit == null) throw KernelError("没有这个表情包：先 sticker_list 看看有哪些")
                val url = hit.optString("dataUrl")
                if (!url.startsWith("data:image/")) throw KernelError("这个表情包没有可用的图像数据")
                val rt = ctx?.service("agent.runtime") as? ToolPipeline.RuntimeTools
                    ?: throw KernelError("当前没有进行中的会话，看不了图")
                val nm = hit.optString("name").ifBlank { "表情包" }
                // 先让视觉模型说一句「这是什么」：这句会一直留在仓库里，下次不用再看
                val desc = captionNow(hit)
                val added = rt.addImageData(url, "表情包「$nm」")
                return JSONObject().put("ok", true).put("id", hit.optString("id")).put("name", nm)
                    .put("desc", desc)
                    .put("note", added + if (desc.isNotBlank()) "画面内容：$desc" else "")
                    .toString()
            }
        },
        object : ToolSpec {
            override val name = "sticker_use"
            override val description =
                "发一张表情包到对话里（静图或 GIF）。挑图看 desc（画面内容），没标注的先 sticker_look。" +
                    "怎么挑：先想这句回复的情绪是什么，再找画面对得上的——别只看名字。" +
                    "该用：① 用户讲了好消息/完成了事情 → 一起高兴；② 用户吐槽、累了、搞砸了 → 安抚或自嘲，" +
                    "别安慰得太多话，一张图顶三句；③ 你自己的失误被指出 → 认错后配一张窘迫的；" +
                    "④ 闲聊、撒娇、道晚安这种没有信息量的回合 → 用表情替掉客套话。" +
                    "别用：① 用户在办事（贴报错、要步骤、等确认）→ 一张图会把答案挤散；" +
                    "② 内容严肃（疾病、金钱、隐私、事故）→ 任何俏皮都像冒犯；③ 你正要提问或等授权；" +
                    "④ 同一轮已经发过 → 不要再补第二张，那看着像刷屏。宁可不发，也别硬凑。" +
                    "一轮最多两个不同表情；用户语气正式时一个都别发。"
            override val parameters = schema(
                JSONObject()
                    .put("id", JSONObject().put("type", "string").put("description", "「表情包仓库」里的 id，照抄"))
                    .put("name", JSONObject().put("type", "string").put("description", "或按名字模糊匹配（没有 id 时用）")),
            )
            override fun execute(args: JSONObject): String {
                val st = store ?: throw KernelError("表情包仓库未就绪")
                val id = args.optString("id").trim()
                val name = args.optString("name").trim()
                val hit: JSONObject? = if (id.isNotBlank() || name.isNotBlank()) {
                    resolve(st, id, name)
                } else {
                    // 没说哪个 → 直接发最常用的：用户说「发个表情」时这就是他要的，
                    // 逼模型先 list 一轮再 use 一轮，小模型经常在中途就跑偏了
                    st.ranked().firstOrNull()
                }
                if (hit == null && id.isBlank() && name.isBlank()) {
                    throw KernelError("表情库还是空的：让用户先在加号面板里存一张表情包")
                }
                if (hit == null) {
                    // 猜错 id 时把候选直接给出来，模型下一句就能改对，不用再 list 一次
                    val cands = st.ranked().take(6).joinToString("、") {
                        "${it.optString("id")}(${it.optString("name")})"
                    }
                    throw KernelError("没有这个表情包。现有：${cands.ifBlank { "（空）" }}")
                }
                // 防轰炸：同一个表情本轮不重复发；一条回复最多两个不同表情。
                // 模型经常一口气把同一个表情连发五六次，满屏都是它。
                val sid = hit.optString("id")
                if (turnIds.contains(sid)) {
                    return JSONObject().put("ok", true).put("id", sid)
                        .put("note", "这个表情本轮已经发过了，不要重复刷").toString()
                }
                if (prevTurnIds.contains(sid)) {
                    return JSONObject().put("ok", true).put("id", sid)
                        .put("note", "这个表情上一轮刚发过，换一张；没有更合适的就先别发").toString()
                }
                if (turnSent >= 2) {
                    return JSONObject().put("ok", true).put("id", sid)
                        .put("note", "本轮已经发过两个表情了，够了").toString()
                }
                val bumped = st.bump(hit.optString("id")) ?: hit
                sink?.invoke(JSONObject().apply {
                    put("id", bumped.optString("id"))
                    put("name", bumped.optString("name"))
                    put("kind", bumped.optString("kind", "static"))
                    put("mime", bumped.optString("mime", "image/png"))
                    put("dataUrl", bumped.optString("dataUrl"))
                    put("w", bumped.optInt("w"))
                    put("h", bumped.optInt("h"))
                })
                sent++
                turnSent++
                turnIds.add(sid)
                // 让「自己发出去的表情」也进上下文：模型下一轮真的能看到这张图，
                // 不然它只记得「我发过 id=xxx」，用户追问「你发的那个是什么意思」就答不上来
                val nm = bumped.optString("name")
                val desc = descOf(bumped)
                val rt = ctx?.service("agent.runtime") as? ToolPipeline.RuntimeTools
                if (rt != null && bumped.optString("dataUrl").startsWith("data:image/")) {
                    runCatching { rt.addImageData(bumped.optString("dataUrl"), "你刚发出的表情包「$nm」") }
                }
                return JSONObject().put("ok", true).put("id", bumped.optString("id"))
                    .put("name", nm)
                    .put("desc", desc)
                    .put("note", "表情包会在本轮结束时出现在对话里" +
                        if (desc.isNotBlank()) "；画面内容：$desc" else "；画面还没标注，别描述它的细节")
                    .toString()
            }
        },
        object : ToolSpec {
            override val name = "sticker_save"
            override val description =
                "把表情收进口袋。默认收「用户刚发的那张图/表情」（from=last），可以顺手起个名字；" +
                    "也可以给 id/name 把已有表情标记为常用。仓库是全局的，换个会话、明天再开都还在。"
            override val parameters = schema(
                JSONObject()
                    .put("id", JSONObject().put("type", "string").put("description", "已有表情的 id（只想加权时给）"))
                    .put("name", JSONObject().put("type", "string").put("description", "名字：新收藏时给它起的名，或已有表情的模糊匹配"))
                    .put("desc", JSONObject().put("type", "string")
                        .put("description", "画面内容：一句话说清这张图是什么（没给就自动看图标注）"))
                    .put("from", JSONObject().put("type", "string")
                        .put("description", "last = 收下用户刚发的那张图（默认）")),
            )
            override fun execute(args: JSONObject): String {
                val st = store ?: throw KernelError("表情包仓库未就绪")
                val id = args.optString("id").trim()
                val want = args.optString("name").trim()
                val from = args.optString("from").trim()
                // 只给了 id/name 且能命中已有条目 → 老语义：加权重
                val hit: JSONObject? = if (from.isBlank()) resolve(st, id, want) else null
                if (hit != null) {
                    st.bump(hit.optString("id"))
                    return JSONObject().put("ok", true).put("id", hit.optString("id")).toString()
                }
                // 否则：把用户刚发的这张图收进仓库（这才是「主动存储表情包」）
                val rt = ctx?.service("agent.runtime") as? ToolPipeline.RuntimeTools
                    ?: throw KernelError("当前没有进行中的会话，收不了表情包")
                val img = rt.latestUserImage()
                    ?: throw KernelError("这轮没有可收的图片：让用户先发一张表情/图片再收")
                val url = img.optString("dataUrl")
                if (!url.startsWith("data:image/")) throw KernelError("这条消息里的图片数据不可用")
                val mime = img.optString("mime").ifBlank { url.substringAfter("data:").substringBefore(";") }
                // 画面内容：模型自己给的 desc 优先；没给就现场看一眼 —— 存进去的东西，将来要靠它被认出来
                val desc = args.optString("desc").trim().ifBlank {
                    captioner()?.let { c -> runCatching { c.caption(url) }.getOrNull().orEmpty() } ?: ""
                }
                val entry = JSONObject().apply {
                    put("id", "s-" + System.currentTimeMillis().toString(36))
                    put("name", want.ifBlank { img.optString("name").ifBlank { "表情" } })
                    put("kind", if (mime.contains("gif") || url.startsWith("data:image/gif")) "gif" else "static")
                    put("mime", mime.ifBlank { "image/png" })
                    put("dataUrl", url)
                    put("w", img.optInt("w"))
                    put("h", img.optInt("h"))
                    put("by", "agent")
                    put("desc", desc)
                    put("uses", 0)
                    put("createdAt", System.currentTimeMillis())
                }
                val saved = st.add(entry)
                return JSONObject().put("ok", true)
                    .put("id", saved.optString("id"))
                    .put("name", saved.optString("name"))
                    .put("desc", saved.optString("desc"))
                    .put("note", "已收进口袋（全局仓库，任何会话都能用）" +
                        if (saved.optString("desc").isNotBlank()) "；画面内容：${saved.optString("desc")}"
                        else "；画面没能自动标注，之后可以 sticker_look 补上")
                    .toString()
            }
        },
        object : ToolSpec {
            override val name = "sticker_remove"
            override val description =
                "从表情包里删掉一个：用户说「这个表情不好看/别再用这个」时用，收错了也可以删。" +
                    "给 id 或名字（模糊匹配）；删之前先 sticker_list 确认是哪一个。"
            override val parameters = schema(
                JSONObject()
                    .put("id", JSONObject().put("type", "string"))
                    .put("name", JSONObject().put("type", "string").put("description", "按名字模糊匹配")),
            )
            override fun execute(args: JSONObject): String {
                val st = store ?: throw KernelError("表情包仓库未就绪")
                val id = args.optString("id").trim()
                val want = args.optString("name").trim()
                val hit = resolve(st, id, want)
                    ?: throw KernelError("没有这个表情包：先 sticker_list 看看有哪些")
                val name = hit.optString("name")
                if (!st.remove(hit.optString("id"))) throw KernelError("删除失败：$name")
                return JSONObject().put("ok", true).put("id", hit.optString("id"))
                    .put("name", name).put("note", "已从表情库删除").toString()
            }
        },
    )
}
