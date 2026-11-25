package ai.deepseek.harness.mobile.kernel.dev

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * 前端自改（self-modification）的宿主侧唯一入口。
 *
 * 桌面 harness 能「改自己的源码 → 重编 → 热重载」，前提是源码与构建链在同一台机器。
 * 预编译 APK 里只有 `assets/web/app.js` 这个拼接产物，`web/src` 下的 JS 与 `build.json`
 * 全在桌面磁盘，Agent 够不着自己。这里补上那条链上最短的一段：
 *
 *  1. 随包带 `assets/devsrc/`（4 个 part + build.json）；首次启用时展开到
 *     `workspace/.dsh-src/parts/`（可写，之后不再覆盖用户的改动）；
 *  2. [rebuild] 严格复刻 `scripts/build-web.mjs` 的拼接规则（LF 归一化、末尾换行、
 *     中间 part 不许 IIFE 结尾、sha256 banner），在设备内重建 `app.js`；
 *  3. `MainActivity.shouldInterceptRequest()` 经 [overlay] 优先把 workspace 里的
 *     `app.js` / `styles.css` 交给 WebView；
 *  4. 改完一次 `rebuild` + `reload` 即生效，不需要重编译 Kotlin、不需要签名、不需要装 APK。
 *
 * **为什么拼接放在 Kotlin 而不是复用 Node 脚本**：standard flavor 没有 proot/Node，
 * 而界面自改不该只属于 complete 版。规则与 build-web.mjs 保持一致，由
 * `scripts/regress/self-modify.test.mjs` 静态守卫盯着，避免两套实现分叉。
 *
 * **安全边界**（这份文件能拿到全部 DSHNative* 桥，权重远高于普通 workspace 文件）：
 *  - 默认关闭，必须显式 `enable` 才展开源码并允许覆盖；
 *  - 覆盖只对 `app.js` / `styles.css` 两个白名单文件生效，index.html 与桥不可替换；
 *  - [overlay] 对 JS 做体检，坏了就忽略覆盖、回落 APK 内置版本（避免改坏一次就白屏变砖）；
 *  - [restore] 一键删覆盖并关开关，设置面板有入口。
 */
object SelfModify {

    private const val ASSET_DIR = "devsrc"
    private const val WS_DIR = ".dsh-src"
    private const val PARTS_DIR = "parts"
    private const val BUILD_JSON = "build.json"
    private const val ENABLED_FLAG = ".enabled"
    private val OVERLAY_ALLOW = setOf("app.js", "styles.css")

    /** 由 MainActivity 注入：在 UI 线程重载 WebView。工具/桥的 reload action 走它。 */
    @Volatile
    var reloadHook: (() -> Unit)? = null

    private fun dir(ctx: Context) = File(File(ctx.filesDir, "workspace"), WS_DIR)
    private fun flag(ctx: Context) = File(dir(ctx), ENABLED_FLAG)

    fun isEnabled(ctx: Context): Boolean = flag(ctx).isFile

    fun setEnabled(ctx: Context, on: Boolean): String {
        val d = dir(ctx)
        if (on) {
            ensureSources(ctx)
            if (!flag(ctx).exists()) flag(ctx).writeText("1")
            return "已开启前端自改：源码在 workspace/.dsh-src/parts/，改完执行 rebuild + reload"
        }
        flag(ctx).delete()
        return "已关闭前端自改（覆盖文件保留，可用 restore 清空）"
    }

    /**
     * 首次把 APK 内的源码展开到 workspace。之后**绝不覆盖**：用户的改动是主体，
     * 重装 APK 升版本也不该把它冲掉（要恢复有显式 restore）。
     */
    fun ensureSources(ctx: Context): File {
        val d = dir(ctx)
        val p = File(d, PARTS_DIR)
        p.mkdirs()
        val names = runCatching { ctx.assets.list(ASSET_DIR)?.toList() }.getOrDefault(emptyList())
        for (n in names.orEmpty()) {
            if (n.isBlank()) continue
            val out = if (n == BUILD_JSON) File(d, BUILD_JSON) else File(p, n)
            if (out.isFile) continue
            runCatching {
                ctx.assets.open("$ASSET_DIR/$n").use { input -> out.writeBytes(input.readBytes()) }
            }
        }
        if (!File(d, BUILD_JSON).isFile) {
            // 载荷缺失时给一份与 web/build.json 相同的兜底，避免启用后面板里一片空
            File(d, BUILD_JSON).writeText(
                """{"parts":["00-app.js","10-chat.js","20-ui.js","30-bridge.js"]}""",
            )
        }
        return d
    }

    data class RebuildResult(val ok: Boolean, val message: String)

    /** 按 build.json 顺序拼接 parts，原子写覆盖产物。规则与 scripts/build-web.mjs 一致。 */
    fun rebuild(ctx: Context): RebuildResult {
        val d = ensureSources(ctx)
        val cfg = runCatching { JSONObject(File(d, BUILD_JSON).readText()) }
            .getOrElse { return RebuildResult(false, "build.json 读不出来：${it.message}") }
        val arr = runCatching { cfg.getJSONArray("parts") }
            .getOrElse { return RebuildResult(false, "build.json 缺少 parts 数组") }
        if (arr.length() == 0) return RebuildResult(false, "parts 是空数组")
        val parts = (0 until arr.length()).map { arr.getString(it) }
        val body = StringBuilder()
        for ((i, name) in parts.withIndex()) {
            val f = File(File(d, PARTS_DIR), name)
            if (!f.isFile) return RebuildResult(false, "找不到 part：parts/$name")
            val text = f.readText().replace("\r\n", "\n")
            if (text.isEmpty()) return RebuildResult(false, "part 是空文件：parts/$name")
            if (!text.endsWith("\n")) return RebuildResult(false, "part 末尾缺少换行：parts/$name")
            if (parts.size > 1 && i < parts.size - 1 &&
                Regex("^\\}\\)\\(\\);\\s*$", RegexOption.MULTILINE).containsMatchIn(text)
            ) {
                return RebuildResult(false, "part 里出现 IIFE 结尾：parts/$name（切分点越过了函数体）")
            }
            body.append(text)
        }
        val joined = body.toString()
        val hash = MessageDigest.getInstance("SHA-256")
            .digest(joined.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(8)
        // 与 scripts/build-web.mjs 的 banner 逐字节一致 —— 设备重建的产物可以直接
        // 和桌面产物比对，也便于一眼看出「这份是拼接出来的，别手改」。
        val banner =
            "/* AUTO-GENERATED — DO NOT EDIT.\n" +
                "   Source: web/src/*.js in web/build.json order · ${parts.size} parts · parts sha256 $hash\n" +
                "   Edit the parts, then run: node scripts/build-web.mjs   (or: node scripts/sync-web.mjs) */\n"
        val next = banner + joined
        val out = File(d, "app.js")
        val tmp = File(d, "app.js.tmp")
        return try {
            tmp.writeText(next)
            if (!tmp.renameTo(out)) return RebuildResult(false, "原子替换 app.js 失败")
            RebuildResult(true, "重建完成：${parts.size} 个 part，${next.length} 字节，parts $hash")
        } catch (e: Throwable) {
            RebuildResult(false, "写 app.js 失败：${e.message}")
        }
    }

    /**
     * WebView 要 `/assets/web/<rel>` 时问一次这里。
     * 只有「开关开着 + 在白名单 + 文件体检通过」才返回 workspace 版本，
     * 任何一个条件不满足都回落到 APK 内置资源 —— 改坏了最多是不生效，不会白屏变砖。
     */
    fun overlay(ctx: Context, rel: String): File? {
        if (rel !in OVERLAY_ALLOW || !isEnabled(ctx)) return null
        val f = File(dir(ctx), rel)
        if (!f.isFile) return null
        if (rel == "app.js" && !looksValidAppJs(f)) {
            android.util.Log.w("DSHSelfModify", "workspace app.js 体检未过，回落内置版本")
            return null
        }
        return f
    }

    private fun looksValidAppJs(f: File): Boolean {
        val len = f.length()
        if (len < 50_000L || len > 3_000_000L) return false
        return runCatching {
            val head = f.inputStream().use { s -> ByteArray(512).let { s.read(it); String(it, Charsets.UTF_8) } }
            val tail = f.readText().takeLast(256)
            head.contains("AUTO-GENERATED") && tail.contains("})();")
        }.getOrDefault(false)
    }

    fun restore(ctx: Context): String {
        val d = dir(ctx)
        flag(ctx).delete()
        File(d, "app.js").delete()
        File(d, "styles.css").delete()
        return "已清除前端覆盖，下次重载回到 APK 内置版本（parts/ 里的源码保留）"
    }

    fun status(ctx: Context): JSONObject {
        val d = dir(ctx)
        val partList = org.json.JSONArray()
        File(d, PARTS_DIR).listFiles()?.filter { it.name.endsWith(".js") }?.forEach {
            partList.put(JSONObject().put("name", it.name).put("bytes", it.length()))
        }
        val built = File(d, "app.js")
        return JSONObject()
            .put("enabled", isEnabled(ctx))
            .put("sourceDir", "workspace/$WS_DIR/$PARTS_DIR/")
            .put("parts", partList)
            .put("partCount", partList.length())
            .put("builtBytes", if (built.isFile) built.length() else 0)
            .put("overlayActive", overlay(ctx, "app.js") != null)
            .put("cssOverlay", File(d, "styles.css").isFile)
            .put("reloadAvailable", reloadHook != null)
    }
}
