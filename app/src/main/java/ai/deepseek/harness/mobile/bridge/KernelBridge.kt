package ai.deepseek.harness.mobile.bridge

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import ai.deepseek.harness.mobile.BuildConfig
import ai.deepseek.harness.mobile.MainActivity
import ai.deepseek.harness.mobile.glass.GlassSheet
import ai.deepseek.harness.mobile.glass.HonorGlass
import ai.deepseek.harness.mobile.kernel.mission.MissionRegistry
import org.json.JSONArray
import org.json.JSONObject

/**
 * WebView 桥的 origin 判定 —— 纯函数，JVM 可单测（见 KernelBridgeOriginTest）。
 *
 * 本地 UI 是 `https://appassets.androidplatform.net/assets/...`（WebViewAssetLoader），
 * 配对宿主机则是任意 http(s) 页面。JS 桥只允许挂在本地 origin：
 *   - [isLocalOrigin]：是不是本地 appassets（scheme/host/port，拒绝 userinfo 伪装）；
 *   - [isBridgePage]：再要求路径落在 /assets/ 下（assetLoader 唯一注册的入口）；
 *   - [isHttpUrl]：远端 URL 白名单（loadRemote 与 connectHost 共用）。
 */
object KernelBridgeOrigin {
    const val LOCAL_DOMAIN = "appassets.androidplatform.net"
    const val LOCAL_SCHEME = "https"
    const val ASSETS_PREFIX = "/assets/"

    /** 本地 appassets origin（含 https 与默认端口；拒绝对端伪造的 userinfo/端口） */
    fun isLocalOrigin(url: String?): Boolean {
        val p = split(url) ?: return false
        if (p[0] != LOCAL_SCHEME) return false
        val authority = p[1]
        val host = authority.substringBefore(':')
        if (host != LOCAL_DOMAIN) return false
        if (!authority.contains(':')) return true
        val port = authority.substringAfter(':')
        return port == "443"
    }

    /** 真正允许挂 JS 桥的页面：本地 origin + /assets/ 路径 */
    fun isBridgePage(url: String?): Boolean {
        if (!isLocalOrigin(url)) return false
        val p = split(url) ?: return false
        return p[2].startsWith(ASSETS_PREFIX)
    }

    /** 远端地址白名单：只接受 http / https，且必须有 host（拒绝 file:/javascript:/content:） */
    fun isHttpUrl(url: String?): Boolean {
        val p = split(url) ?: return false
        if (p[0] != "http" && p[0] != "https") return false
        return p[1].substringBefore(':').isNotBlank()
    }

    /**
     * 同一个 origin（scheme + host + 规范化端口）。
     * 宿主导航必须用它做精确比对：`url.startsWith(host)` 会被
     * `http://host:3080@evil.com/`、`http://host:3080.evil.com/` 这类前缀伪装绕过。
     */
    fun sameOrigin(a: String?, b: String?): Boolean {
        val pa = split(a) ?: return false
        val pb = split(b) ?: return false
        if (pa[0] != pb[0]) return false
        return normalizeAuthority(pa[0], pa[1]) == normalizeAuthority(pb[0], pb[1])
    }

    /** host:port，默认端口（http 80 / https 443）折叠成不带端口 */
    private fun normalizeAuthority(scheme: String, authority: String): String {
        val host = authority.substringBefore(':')
        if (!authority.contains(':')) return host
        val port = authority.substringAfter(':')
        val default = when (scheme) {
            "http" -> "80"
            "https" -> "443"
            else -> ""
        }
        return if (port == default) host else "$host:$port"
    }

    /** 小写 host（无端口）；非法 URL 返回 null */
    fun hostOf(url: String?): String? =
        split(url)?.get(1)?.substringBefore(':')?.takeIf { it.isNotBlank() }

    /**
     * 极简 URL 切分：scheme / 小写 authority / path。
     * 不用 java.net.URI（部分畸形输入它照样接受），也拒绝空白、控制字符与 userinfo。
     */
    private fun split(url: String?): Array<String>? {
        val u = url?.trim() ?: return null
        if (u.isEmpty()) return null
        if (u.any { it.isWhitespace() || it.code < 0x20 || it.code == 0x7F }) return null
        val sep = u.indexOf("://")
        if (sep <= 0) return null
        val scheme = u.substring(0, sep).lowercase()
        if (scheme.any { !it.isLetterOrDigit() && it != '+' && it != '-' && it != '.' }) return null
        val rest = u.substring(sep + 3)
        val authority = rest.substringBefore('/').substringBefore('?').substringBefore('#')
        if (authority.isEmpty()) return null
        // https://appassets.androidplatform.net@evil.com 这类伪装必须拒
        if (authority.contains('@')) return null
        if (authority.count { it == ':' } > 1) return null   // IPv6 不在白名单用途里
        val slash = rest.indexOf('/')
        val path = if (slash >= 0) {
            rest.substring(slash).substringBefore('?').substringBefore('#')
        } else {
            "/"
        }
        return arrayOf(scheme, authority.lowercase(), path)
    }
}

/**
 * 内核域：工具目录、插件启停、工作区文件、定时任务、后台作业。
 */
class KernelBridge(private val core: BridgeCore) {

    private val activity get() = core.activity
    private val prefs get() = core.prefs
    private fun emitRaw(js: String) = core.raw(js)

    private fun workspaceFile(p: String) = FileIntents.resolve(activity, p)
    private fun openWithSystem(f: java.io.File) = FileIntents.open(activity, f)

    /**
     * origin 兜底：桥只应挂在本地 appassets 页（远端页导航前已摘除）。
     * 万一出现「桥还在、页面已是远端」的时序漏洞，这些敏感入口再拒一次。
     */
    private fun remoteOriginError(): String? {
        if (activity.isLocalPage()) return null
        return JSONObject().put("ok", false)
            .put("code", "BRIDGE_ORIGIN_DENIED")
            .put("error", "当前页面不是本地资源页（JS 桥已摘除），拒绝本次内核调用")
            .toString()
    }


    /* ---------------- 手机端内核（工具层） ---------------- */

    private val pendingTools = java.util.concurrent.ConcurrentHashMap<String, Boolean>()

    /**
     * M0 spike 专用（仅 Debug 构建存在）：从应用进程的真实 SELinux 域执行 shell 命令，
     * 验证「数据目录 exec / proot 运行编译链」可行性（.motion/harness-plan-ondevice.md）。
     * release 构建里调用只会得到 debug-only 拒绝。
     */
    @JavascriptInterface
    fun devExec(cmd: String): String {
        if (!BuildConfig.DEBUG) {
            return JSONObject().put("ok", false).put("error", "devExec is debug-only").toString()
        }
        return try {
            val pb = ProcessBuilder("/system/bin/sh", "-c", cmd)
                .directory(activity.filesDir)
                .redirectErrorStream(true)
            val p = pb.start()
            val out = p.inputStream.bufferedReader().readText()
            val done = p.waitFor(150, java.util.concurrent.TimeUnit.SECONDS)
            if (!done) p.destroyForcibly()
            JSONObject().put("ok", done && p.exitValue() == 0)
                .put("code", if (done) p.exitValue() else -1)
                .put("out", out.take(80000))
                .toString()
        } catch (e: Throwable) {
            JSONObject().put("ok", false)
                .put("error", "${e.javaClass.simpleName}: ${e.message}")
                .toString()
        }
    }


    /** 模型可见的工具 schema（OpenAI tools 格式由前端转换） */
    @JavascriptInterface
    fun toolSchemas(): String = activity.kernel.schemas().toString()

    /** 插件清单（内置 + 外部清单插件）与装配日志，设置页消费 */
    @JavascriptInterface
    fun pluginList(): String = activity.kernel.pluginsJson().toString()

    /**
     * 设置页调灵动岛几何（水平位置 / 长度 / 上下留白），立刻重建。
     *
     * 只改自家悬浮窗的尺寸与位置，不碰设备状态，所以不走手机操控的授权闸门。
     * 插件没加载时返回 `ok:false`，让设置页把滑块标成不可用而不是假装成功。
     */
    @JavascriptInterface
    fun islandTune(json: String): String =
        ai.deepseek.harness.mobile.kernel.plugin.builtin.device.ControlIslandPlugin.instance
            ?.applyTune(json)
            ?: JSONObject().put("ok", false).put("error", "灵动岛插件未加载").toString()


    /**
     * 读工作区里的图片，返回 data URL —— 只给界面画缩略图用。
     *
     * 为什么不复用注入给模型的那份：那条路径的 base64 在 8MB 上限内可能很大，
     * 每次重绘都过一遍 JS 桥会卡；这里加一层按 (路径, 修改时间, 大小) 的 LRU 缓存。
     */
    private val imageCache = object : LinkedHashMap<String, String>(6, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 6
    }

    @JavascriptInterface
    fun imageData(path: String): String {
        if (path.isBlank()) return ""
        return try {
            val file = activity.kernel.workspace.resolve(path, mustExist = true)
            if (!file.isFile) return ""
            val key = "${file.absolutePath}:${file.lastModified()}:${file.length()}"
            imageCache[key]?.let { return it }
            if (file.length() > 6L * 1024 * 1024) return ""
            val bytes = file.readBytes()
            val mime = when (file.extension.lowercase()) {
                "jpg", "jpeg" -> "image/jpeg"
                "webp" -> "image/webp"
                "gif" -> "image/gif"
                // SVG 走自己的 MIME：之前落到 image/png，浏览器直接解码失败，缩略图显示不出来
                "svg" -> "image/svg+xml"
                "bmp" -> "image/bmp"
                "avif" -> "image/avif"
                "heic", "heif" -> "image/heic"
                else -> "image/png"
            }
            val url = "data:$mime;base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
            imageCache[key] = url
            url
        } catch (e: Throwable) {
            ""
        }
    }

    /**
     * 从用户刚选的附件里抽文档正文（PDF / Word / Excel / PPT）。
     *
     * 为什么放在内核侧：格式解析在 [DocReader]，前端不该背 ZIP+XML 和 PDF 流解析。
     * 附件此刻还没进工作区（只是内存里的 dataUrl），所以先落临时文件、抽完即删。
     * 抽不出来时返回 ok=false 并说明原因，让前端如实告知用户，而不是塞一句「内容未上传」。
     */
    @JavascriptInterface
    fun docText(name: String, dataUrl: String): String {
        val comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith("data:") || comma < 0) {
            return JSONObject().put("ok", false).put("error", "附件数据不可用").toString()
        }
        val dir = java.io.File(activity.cacheDir, "doc-tmp").apply { mkdirs() }
        val safe = name.replace(Regex("[^a-zA-Z0-9._\\-\\u4e00-\\u9fa5]"), "_").ifBlank { "attachment.bin" }
        val f = java.io.File(dir, safe)
        return try {
            val bytes = android.util.Base64.decode(dataUrl.substring(comma + 1), android.util.Base64.DEFAULT)
            f.writeBytes(bytes)
            val r = ai.deepseek.harness.mobile.kernel.doc.DocReader.read(f, 40_000)
            JSONObject().apply {
                put("ok", r.text.isNotBlank())
                put("kind", r.kind)
                put("chars", r.text.length)
                r.meta.forEach { (k, v) -> put(k, v) }
                put("text", r.text)
                if (r.text.isBlank()) put("error", r.meta["note"]?.toString() ?: "抽不出正文（可能是扫描件）")
            }.toString()
        } catch (t: Throwable) {
            JSONObject().put("ok", false).put("error", t.message ?: "解析失败").toString()
        } finally {
            runCatching { f.delete() }
        }
    }

    /** 运行时启停插件：禁用后它的工具立刻从模型目录里消失 */
    @JavascriptInterface
    fun setPluginEnabled(id: String, on: Boolean): String =
        remoteOriginError() ?: activity.kernel.setPluginEnabled(id, on).toString()

    /* ---------------- 文件页 / 任务页 / 后台任务（内核数据源） ---------------- */

    /** 列工作区目录（文件页「工作区」页签）：返回 name/size/mtime/isDir/rel，最多 300 条 */
    @JavascriptInterface
    fun listWorkspace(path: String): String {
        val ws = activity.kernel.workspace
        val dir = try {
            ws.resolve(path.ifBlank { "." }, mustExist = true)
        } catch (t: Throwable) {
            return JSONObject().put("ok", false).put("error", t.message ?: "路径不可用").toString()
        }
        if (!dir.isDirectory) return JSONObject().put("ok", false).put("error", "不是目录").toString()
        val items = org.json.JSONArray()
        dir.listFiles()?.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() }))?.take(300)?.forEach { f ->
            items.put(JSONObject().apply {
                put("name", f.name)
                put("path", ws.relative(f))
                put("size", if (f.isFile) f.length() else 0)
                put("mtime", f.lastModified())
                put("isDir", f.isDirectory)
            })
        }
        return JSONObject().put("ok", true).put("cwd", ws.cwd).put("items", items).toString()
    }

    /* ---------------- 生成模型配置（图片 / 视频） ---------------- */

    /** 读取图片/视频模型配置：{ image:{url,key,model,configured}, video:{...} } */
    @JavascriptInterface
    fun genConfig(): String {
        val kernel = activity.kernel
        val gen = ai.deepseek.harness.mobile.kernel.GenConfig(
            java.io.File(kernel.configDirPath(), "gen.json"),
        )
        return JSONObject().apply {
            put("image", gen.section("image"))
            put("video", gen.section("video"))
        }.toString()
    }

    /** 保存一类生成模型配置（kind = image | video） */
    @JavascriptInterface
    fun saveGenConfig(kind: String, url: String, key: String, model: String): String {
        val kernel = activity.kernel
        val gen = ai.deepseek.harness.mobile.kernel.GenConfig(
            java.io.File(kernel.configDirPath(), "gen.json"),
        )
        gen.set(if (kind == "video") "video" else "image", url, key, model)
        return gen.section(if (kind == "video") "video" else "image").toString()
    }

    /** 删除工作区里的文件/目录（走内核 delete_path 工具，沙箱只读会被拒绝） */
    @JavascriptInterface
    fun deleteWorkspace(path: String): String =
        remoteOriginError()
            ?: activity.kernel.exec("delete_path", JSONObject().put("path", path).toString())

    /** 路径是否真的还在：文件页的交付记录来自会话事件，删完要按这个过滤掉幽灵行 */
    @JavascriptInterface
    fun fileExists(path: String): Boolean = try {
        activity.kernel.workspace.resolve(path, mustExist = true).exists()
    } catch (t: Throwable) {
        false
    }

    /** 历史交付物（文件页「产出」页签）：汇总所有会话的 deliverable 事件，最近的在前 */
    @JavascriptInterface
    fun deliverables(): String {
        val kernel = activity.kernel
        val out = org.json.JSONArray()
        val seen = HashSet<String>()
        val sessions = kernel.sessions.listSessions()
        for (i in 0 until minOf(sessions.length(), 30)) {
            val sid = sessions.optJSONObject(i)?.optString("id") ?: continue
            kernel.sessions.read(sid).forEach { ev ->
                if (ev.optString("type") != "deliverable") return@forEach
                val files = ev.optJSONArray("files") ?: return@forEach
                for (k in 0 until files.length()) {
                    val f = files.optJSONObject(k) ?: continue
                    val path = f.optString("path")
                    if (path.isBlank() || !seen.add(path)) continue
                    out.put(JSONObject().apply {
                        put("name", f.optString("name"))
                        put("path", path)
                        put("size", f.optLong("size"))
                        put("mime", f.optString("mime"))
                        put("at", ev.optLong("ts"))
                        put("sessionId", sid)
                    })
                }
            }
        }
        return out.toString()
    }

    /* ---------------- 陪伴式畅聊 ---------------- */

    @JavascriptInterface
    fun companionState(): String = activity.kernel.companionState().toString()

    @JavascriptInterface
    fun companionSave(patch: String): String = try {
        activity.kernel.saveCompanionState(patch).toString()
    } catch (t: Throwable) {
        JSONObject().put("error", t.message ?: "保存失败").toString()
    }

    /**
     * 下发「生成侧所需的上下文」给原生引擎（措辞在 JS，时机在原生）。
     *
     * 引擎在没有 WebView 的情况下要能自己问模型，所以端点/Key、system 提示词、
     * nudge 模板、最近几条对话都必须**先落到磁盘**：
     *   · 自定义模型：url + key（Key 留空即不带 Authorization，本地模型常这样）；
     *   · DeepSeek 账号额度：url 含 /anthropic，Key 留空也行 —— 引擎会自己从
     *     DeepSeekAuth 取登录 token（token 只留在原生侧，前端拿不到）。
     */
    @JavascriptInterface
    fun companionModel(json: String): String = try {
        val f = ai.deepseek.harness.mobile.kernel.plugin.builtin.device.CompanionEngine
            .modelFile(activity.applicationContext)
        f.parentFile?.mkdirs()
        f.writeText(json)
        JSONObject().put("ok", true).toString()
    } catch (t: Throwable) {
        JSONObject().put("ok", false).put("error", t.message ?: "写入失败").toString()
    }

    /** 原生引擎已经生成、但界面上还没显示的消息（{id, at, text} 数组） */
    @JavascriptInterface
    fun companionOutbox(): String = try {
        ai.deepseek.harness.mobile.kernel.plugin.builtin.device.CompanionEngine
            .outboxJson(activity.applicationContext)
    } catch (_: Throwable) {
        "[]"
    }

    /** 前端已经渲染进会话，按 id 领走 */
    @JavascriptInterface
    fun companionOutboxAck(ids: String) {
        try {
            val set = ids.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
            ai.deepseek.harness.mobile.kernel.plugin.builtin.device.CompanionEngine
                .outboxAck(activity.applicationContext, set)
        } catch (_: Throwable) {
        }
    }

    /** 用户说话时记一笔：插件据此判断「他还在场，不用主动开口」 */
    @JavascriptInterface
    fun companionTouch() {
        try {
            activity.kernel.saveCompanionState(JSONObject().put("lastUserAt", System.currentTimeMillis()).toString())
        } catch (_: Throwable) {}
    }

    @JavascriptInterface
    fun scheduleList(): String = activity.kernel.schedule.list().toString()

    @JavascriptInterface
    fun scheduleCreate(json: String): String = try {
        val o = JSONObject(json)
        val rule = o.optJSONObject("rule") ?: JSONObject()
        activity.kernel.schedule.create(
            o.optString("title", "定时任务"),
            o.optString("prompt"),
            rule,
            o.optString("sessionId", prefs.getString("lastSessionId", "") ?: ""),
        ).toString()
    } catch (t: Throwable) {
        JSONObject().put("error", t.message ?: "创建失败").toString()
    }

    /** 修改定时任务（标题/内容/规则）。内核侧是 CAS 的 update；前端单人操作不传 expected，跳过冲突检测 */
    @JavascriptInterface
    fun scheduleUpdate(id: String, json: String): String = try {
        val o = JSONObject(json)
        val patch = JSONObject()
        if (o.has("title")) patch.put("title", o.optString("title"))
        if (o.has("prompt")) patch.put("prompt", o.optString("prompt"))
        // 内核 update 的规则选择器在 patch 顶层（after_seconds/every_seconds/daily/…），
        // 前端传的是嵌套 rule 对象 —— 这里拍平；不拍平 hasSelector 永远为假，
        // 「改了触发方式」会静默不生效，只剩标题/内容被更新
        o.optJSONObject("rule")?.let { rule ->
            val keys = rule.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                patch.put(k, rule.get(k))
            }
        }
        activity.kernel.schedule.update(id, patch, null).toString()
    } catch (t: Throwable) {
        JSONObject().put("error", t.message ?: "修改失败").toString()
    }

    @JavascriptInterface
    fun scheduleDelete(id: String): Boolean = activity.kernel.schedule.delete(id)

    @JavascriptInterface
    fun jobsList(): String = activity.kernel.jobs.list().toString()

    /* ---------------- 统一唤醒队列（Step 2） ---------------- */

    /** 当前会话未消费的唤醒（job 完成 / 定时到点）；空 session 返回全部（诊断）。 */
    @JavascriptInterface
    fun wakeList(sessionId: String): String =
        activity.kernel.wakes.pending(sessionId).toString()

    /** 前端认领后消费；逗号分隔的 wake id。返回实际消费条数。 */
    @JavascriptInterface
    fun wakeConsume(idsCsv: String): Int =
        activity.kernel.wakes.consume(
            idsCsv.split(',').map { it.trim() }.filter { it.isNotEmpty() },
        )

    /**
     * 补的那一轮失败了 → 把唤醒退回队列，下次进会话再试。
     * 同时在那件事的账上记一条失败证据：回看时要能看出「它试过、没成功、为什么」。
     */
    @JavascriptInterface
    fun wakeRequeue(id: String, reason: String): String {
        val kernel = activity.kernel
        val rec = kernel.wakes.requeue(id, reason) ?: return JSONObject()
            .put("ok", false).put("error", "记录不存在或已重投太多次").toString()
        val mid = rec.optString("missionId")
        if (mid.isNotBlank()) {
            runCatching {
                kernel.missions.appendEvidence(
                    mid,
                    JSONObject().put("type", "wake")
                        .put("ref", id + "#fail-" + rec.optInt("attempts", 1))
                        .put("title", "唤醒续轮失败：" + reason.take(60))
                        .put("at", System.currentTimeMillis()),
                )
            }
        }
        return JSONObject().put("ok", true).put("attempts", rec.optInt("attempts", 1)).toString()
    }

    /* ---------------- Mission Ledger（jobs/schedules 的统一事实源） ---------------- */

    /** sessionId 为空 = 全部；前端任务页用空，对话卡/进行中带传当前会话。 */
    @JavascriptInterface
    fun missionList(sessionId: String): String =
        activity.kernel.missions.list(sessionId).toString()

    /** 详情：mission 本体 + 时间线 + 证据。抽屉打开时一次取全，避免多次跨桥。 */
    @JavascriptInterface
    fun missionDetail(id: String): String = activity.kernel.missionEvidence.detail(id).toString()

    /**
     * 收窄这条 Mission 的权限（readonly / ask / full / inherit）。
     * 只收窄不放宽的判定在 MissionRegistry.effectivePermission 里，这里不做二次裁决。
     */
    @JavascriptInterface
    fun missionSetPermission(id: String, mode: String): String {
        val updated = activity.kernel.missions.setPermission(id, mode.trim().lowercase())
        if (updated != null) return updated.toString()
        return JSONObject().put("error", "任务不存在或档位无效").toString()
    }

    /**
     * 导出这件事的完整记录到工作区 `.dsh/missions/`。
     * 文件名只取 Mission id 里的安全字符：id 来自内核（job:/schedule:），但导出这条路
     * 是用户可触发的入口，不能让它把路径分隔符带进来写出沙箱。
     */
    @JavascriptInterface
    fun missionExport(id: String, format: String): String = try {
        val safe = id.map { if (it.isLetterOrDigit() || it == '.' || it == '-' || it == '_') it else '-' }
            .joinToString("").take(80)
        if (safe.isBlank()) {
            JSONObject().put("ok", false).put("error", "Mission id 无效").toString()
        } else {
            val asJson = format.trim().lowercase() == "json"
            val content = if (asJson) activity.kernel.missionEvidence.detail(id).toString(2)
            else activity.kernel.missionEvidence.markdown(id)
            if (content.isBlank()) {
                JSONObject().put("ok", false).put("error", "这条 Mission 已经不在了").toString()
            } else {
                val dir = java.io.File(activity.kernel.workspace.root, ".dsh/missions")
                dir.mkdirs()
                val f = java.io.File(dir, "$safe.${if (asJson) "json" else "md"}")
                f.writeText(content)
                JSONObject().put("ok", true)
                    .put("path", activity.kernel.workspace.relative(f))
                    .put("chars", content.length)
                    .toString()
            }
        }
    } catch (t: Throwable) {
        JSONObject().put("ok", false).put("error", t.message ?: "导出失败").toString()
    }

    /**
     * 存储与落点清单（设置页只读）：各本地数据占多少、上限多少、哪个没有上限。
     * 数字是现场遍历出来的，不是注册表里的估算 —— 估算与真实占用会随版本漂移。
     */
    @JavascriptInterface
    fun storageStat(): String = runCatching { activity.kernel.storage.stat().toString() }
        .getOrElse { JSONObject().put("error", it.message ?: "统计失败").toString() }

    /** 清理可再生项（目前只有溢出缓存）；其余任何一项都不从这里删用户的东西。 */
    @JavascriptInterface
    fun storageClear(key: String): String =
        runCatching { activity.kernel.storage.clear(key) }.getOrElse {
            JSONObject().put("ok", false).put("error", it.message ?: "清理失败")
        }.toString()

    /** 取消/终止：job 直接 kill（随后由 job_done 落账）；定时任务没有暂停语义，交给任务页删除。 */
    @JavascriptInterface
    fun missionCancel(id: String): String {
        if (id.startsWith("job:")) {
            val ok = activity.kernel.jobs.kill(id.removePrefix("job:"))
            return JSONObject()
                .put("ok", ok)
                .put("error", if (ok) "" else "任务已结束或不存在")
                .toString()
        }
        return JSONObject().put("ok", false).put("error", "定时任务请在任务页删除").toString()
    }

    /**
     * 删掉账本里的一条历史记录（任务页/抽屉的「删除」）。
     *
     * 只删**已经落定**的：还在跑的一律拒绝，一次点击不能把在跑的东西静默抹掉 ——
     * 记录没了、进程还在跑，下次进来谁都不记得它。那种要先走 [missionCancel]
     * 或 [scheduleDelete]，它们会终止执行体并落账。
     * 团队任务的权威在任务板：这里删了，下一次同步 `onTeamTask` 又把它加回来，
     * 所以直接说清去哪儿删，不给一个"按了没用"的按钮。
     */
    @JavascriptInterface
    fun missionRemove(id: String): String {
        fun res(ok: Boolean, error: String = "") = JSONObject().put("ok", ok).put("error", error).toString()
        if (id.isBlank()) return res(false, "缺少要删的记录")
        if (id.startsWith("team:")) return res(false, "团队任务要在任务板上删除（这里删了也会被任务板同步回来）")
        val m = activity.kernel.missions.get(id) ?: return res(false, "这件事已经不在了")
        if (m.optString("state") != MissionRegistry.STATE_SETTLED) return res(false, "还在进行中，请先终止再删除")
        return res(activity.kernel.missions.remove(id))
    }

    /**
     * 页面点「删除会话」时补上的内核那一刀：账本行、唤醒、会话日志（含成员日志）一起清。
     * 返回清掉的条数，页面拿去说清「顺带清了 N 项」。
     */
    @JavascriptInterface
    fun sessionPurge(sid: String): String = runCatching { activity.kernel.purgeSession(sid).toString() }
        .getOrElse { JSONObject().put("ok", false).put("error", it.message ?: "清理失败").toString() }

    /** 开机清扫孤儿（页面递进 `{loaded, ids}`；`loaded=false` 时内核什么都不清）。 */
    @JavascriptInterface
    fun sessionSweep(payloadJson: String): String {
        val o = runCatching { JSONObject(payloadJson) }.getOrElse {
            return JSONObject().put("ok", false).put("error", "清扫参数读不出来").toString()
        }
        val arr = o.optJSONArray("ids") ?: JSONArray()
        val ids = (0 until arr.length()).map { arr.optString(it) }
        return runCatching { activity.kernel.sweepOrphans(ids, o.optBoolean("loaded", false)).toString() }
            .getOrElse { JSONObject().put("ok", false).put("error", it.message ?: "清扫失败").toString() }
    }

    /**
     * 重新跑一次这件事：按账本里留下的命令与目录再起一个后台任务。
     *
     * 只认 `origin.command` —— 那是 rc.188 之后才开始留的。老记录（或内部任务）没留参数，
     * 就老实说不清，不能凭标题猜一条命令去跑。
     * 执行能力从 `job.exec` 服务取（ShellPlugin 注册），这里不自己拼 exec 调用。
     */
    @JavascriptInterface
    fun missionRerun(id: String): String {
        fun err(msg: String) = JSONObject().put("ok", false).put("error", msg).toString()
        val kernel = activity.kernel
        val m = kernel.missions.get(id) ?: return err("这件事已经不在了")
        if (m.optString("kind") != "job") return err("只有后台任务能重跑")
        val command = m.optJSONObject("origin")?.optString("command").orEmpty()
        if (command.isBlank()) return err("这条记录没留下当时的命令，不能凭名字猜一条去跑")
        @Suppress("UNCHECKED_CAST")
        val runner = kernel.service("job.exec") as? (JSONObject) -> JSONObject
            ?: return err("命令执行能力未加载，稍后再试")
        return try {
            val started = runner(
                JSONObject().put("command", command)
                    .put("workdir", m.optJSONObject("origin")?.optString("workdir").orEmpty())
                    .put("description", m.optString("title").ifBlank { "重跑后台任务" })
                    .put("sessionId", m.optString("sessionId")),
            )
            val newId = started.optString("job_id")
            if (newId.isNotBlank()) {
                runCatching {
                    kernel.missions.appendEvidence(
                        id,
                        JSONObject().put("type", "rerun").put("ref", newId)
                            .put("title", "重新跑了一次").put("at", System.currentTimeMillis()),
                    )
                }
            }
            JSONObject().put("ok", true).put("job_id", newId).toString()
        } catch (t: Throwable) {
            err(t.message ?: "重跑失败")
        }
    }

    /** 工作区内文件定位：绝对路径按沙箱根校验，相对路径按内核 cwd 解析 */

    /** 强制用系统应用打开（预览面板里的备选） */
    @JavascriptInterface
    fun externalOpen(path: String): String = try {
        remoteOriginError()?.let { return it }
        val f = workspaceFile(path)
            ?: return JSONObject().put("ok", false)
                .put("error", "文件不在工作区里或已被删除").toString()
        openWithSystem(f)
    } catch (t: Throwable) {
        JSONObject().put("ok", false).put("error", t.message ?: "打不开").toString()
    }

    /**
     * 异步执行工具：结果经 DSHHost.onToolResult(id, json) 回传。
     * bash 等可能耗时，必须离开 JS 调用线程。
     */
    @JavascriptInterface
    fun toolCall(id: String, name: String, argsJson: String) {
        if (pendingTools.putIfAbsent(id, true) != null) return
        // 在派发线程之外先做 origin 判定：执行期间页面可能已经导航到远端
        val denied = remoteOriginError()
        Thread {
            val result = if (denied != null) denied else try {
                activity.kernel.exec(name, argsJson)
            } catch (t: Throwable) {
                """{"ok":false,"error":${JSONObject.quote(t.message ?: "exec failed")}}"""
            }
            pendingTools.remove(id)
            emitRaw(
                "window.DSHHost&&window.DSHHost.onToolResult&&window.DSHHost.onToolResult(" +
                    JSONObject.quote(id) + "," + JSONObject.quote(result) + ")"
            )
        }.apply { isDaemon = true }.start()
    }
}
