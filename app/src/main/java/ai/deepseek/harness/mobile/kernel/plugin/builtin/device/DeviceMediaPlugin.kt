package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolCatalog
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickInt
import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 手机媒体插件（P0）：打通应用沙箱与系统媒体库之间的最后一公里。
 *
 * 之前整个内核被锁在 filesDir/workspace 里——相册、下载目录、录音全摸不到，
 * 「整理我下载的文件」「看看这张截图」这类手机最高频需求物理上做不到。
 * 本插件全部走系统 API（MediaStore / SAF），**不需要** MANAGE_EXTERNAL_STORAGE：
 *   - gallery_read   查询系统相册（图片/视频），可把选中的一张读入对话给多模态模型
 *   - gallery_save   工作区里的图片存进系统相册
 *   - file_import    SAF 系统文件选择器 → 导入工作区
 *   - file_export    工作区文件 → 系统下载目录（微信/浏览器都能看到的真实位置）
 */
class DeviceMediaPlugin : KernelPlugin {
    override val id = "device-media"
    override val name = "手机媒体"
    override val description = "读写系统相册与下载目录、从系统文件选择器导入（MediaStore / SAF，无需全局存储权限）"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var app: Context? = null
    private var calls = 0

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        app = ctx.service("app.context") as? Context
    }

    override fun onUnload() {
        ctx = null
        app = null
    }

    override fun status(): Map<String, String> =
        mapOf("调用次数" to calls.toString(), "媒体能力" to if (app != null) "可用" else "未就绪（缺 app.context）")

    private val c: Context
        get() = app ?: throw KernelError("媒体插件未就绪（应用上下文缺失），重启应用后再试")

    /** 相册读权限（API 33+ 细分为图片/视频；33 以下统一 READ_EXTERNAL_STORAGE） */
    private fun hasMediaRead(): Boolean {
        val p = c
        return if (Build.VERSION.SDK_INT >= 33) {
            p.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED ||
                p.checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED
        } else {
            p.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun runtime(): ai.deepseek.harness.mobile.agent.ToolPipeline.RuntimeTools =
        ctx?.service("agent.runtime") as? ai.deepseek.harness.mobile.agent.ToolPipeline.RuntimeTools
            ?: throw KernelError("当前没有进行中的会话，attach 只在对话里可用")

    /** 查询系统媒体库，返回行数据（id/name/size/date/bucket/mime） */
    private fun queryMedia(kind: String, album: String, query: String, limit: Int): List<JSONObject> {
        // kind=all 必须同时查图片表和视频表：只查 Images 表且不加 MIME 过滤时，
        // 视频永远查不到，模型会以为相册里没有视频
        if (kind == "all") {
            return ai.deepseek.harness.mobile.kernel.device.MediaPaths.mergeRecent(
                images = queryTable(video = false, album = album, query = query, limit = limit),
                videos = queryTable(video = true, album = album, query = query, limit = limit),
                limit = limit,
            )
        }
        return queryTable(video = kind == "video", album = album, query = query, limit = limit)
    }

    private fun queryTable(video: Boolean, album: String, query: String, limit: Int): List<JSONObject> {
        val uri = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.RELATIVE_PATH,
        )
        val selection = ArrayList<String>()
        val args = ArrayList<String>()
        // 表已经限定了类型，这里仍然按 MIME 过滤一次：某些 ROM 会把动态照片/RAW 混进 Images 表
        selection.add("${MediaStore.MediaColumns.MIME_TYPE} LIKE ?")
        args.add(if (video) "video/%" else "image/%")
        if (album.isNotBlank()) {
            selection.add("${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?")
            args.add("%$album%")
        }
        if (query.isNotBlank()) {
            selection.add("${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?")
            args.add("%$query%")
        }
        val out = ArrayList<JSONObject>()
        c.contentResolver.query(
            uri,
            projection,
            selection.joinToString(" AND "),
            args.toTypedArray(),
            "${MediaStore.MediaColumns.DATE_MODIFIED} DESC",
        )?.use { cur ->
            while (cur.moveToNext() && out.size < limit) {
                val id = cur.getLong(0)
                val name = cur.getString(1).orEmpty()
                val size = cur.getLong(2)
                val date = cur.getLong(3) * 1000
                val mime = cur.getString(4).orEmpty()
                val path = cur.getString(5).orEmpty()
                out.add(JSONObject()
                    .put("id", id)
                    .put("name", name)
                    .put("size", size)
                    .put("ts", date)
                    .put("modified", SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(date)))
                    .put("bucket", path)
                    .put("mime", mime))
            }
        }
        return out
    }

    /** 读一个媒体条目的字节（上限与 read_image 相同：8MB） */
    private fun loadMediaBytes(id: Long): Pair<ByteArray, String> {
        val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val target = android.content.ContentUris.withAppendedId(uri, id)
        // 先看长度再读：readBytes() 之后判断上限等于没判断，50MB 的动态照片会先把进程打死
        val declared = runCatching {
            c.contentResolver.openAssetFileDescriptor(target, "r")?.use { it.length }
        }.getOrNull() ?: -1L
        if (declared > 8L * 1024 * 1024) {
            throw KernelError("图片过大（${declared / 1024 / 1024}MB），上限 8MB：可先让用户裁剪或改用截图")
        }
        val bytes = c.contentResolver.openInputStream(target)?.use { stream ->
            // 无长度信息时按 8MB+1 限长读，边读边判断，避免一次性把大文件拉进内存
            val buf = java.io.ByteArrayOutputStream(64 * 1024)
            val chunk = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val n = stream.read(chunk)
                if (n <= 0) break
                total += n
                if (total > 8L * 1024 * 1024) throw KernelError("图片过大（超过 8MB），已停止读取")
                buf.write(chunk, 0, n)
            }
            buf.toByteArray()
        } ?: throw KernelError("读不到该媒体内容（可能已被删除）")
        val mime = c.contentResolver.getType(target).orEmpty()
        return bytes to mime
    }

    private fun mimeOf(f: File): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "gallery_read",
            description = "查询手机系统相册（MediaStore）：按类型/相册/文件名筛选最近的照片和视频。" +
                "返回编号列表（id、文件名、大小、时间、所在相册）。要看清某张图时传 attach=该行 id，" +
                "图片会被读进对话（下一轮请求你就能看到它），配合多模态模型可以做「看图说话」。",
            parameters = Schemas.params(
                mapOf(
                    "kind" to Schemas.prop("string", "image 图片 / video 视频 / all 都要（默认 image）",
                        listOf("image", "video", "all")),
                    "album" to Schemas.prop("string", "按相册路径过滤，如 Camera / Screenshots / Pictures/微信"),
                    "query" to Schemas.prop("string", "按文件名模糊匹配，如 IMG_2026"),
                    "limit" to Schemas.prop("number", "最多返回几条，默认 20，上限 50"),
                    "attach" to Schemas.prop("number", "把这一条（id）读入对话；视频只回信息不入对话"),
                ),
                emptyList(),
            ),
        ) { a ->
            calls++
            if (!hasMediaRead()) {
                throw KernelError("还没有相册读取权限：请到系统设置 → 应用 → 权限，允许「照片和视频」后重试")
            }
            val kind = a.pick("kind").ifBlank { "image" }
            val limit = a.pickInt("limit", default = 20).coerceIn(1, 50)
            val rows = queryMedia(kind, a.pick("album"), a.pick("query"), limit)
            if (rows.isEmpty()) return@SimpleTool "相册里没有匹配的媒体（检查 kind/album/query 是否过严）"
            val attachId = a.optLong("attach", -1L)
            val sb = StringBuilder("系统相册最近 ${rows.size} 条：\n")
            rows.forEachIndexed { i, r ->
                sb.append(i + 1).append(". id=").append(r.optLong("id"))
                    .append(" · ").append(r.optString("name"))
                    .append(" · ").append(r.optLong("size") / 1024).append("KB")
                    .append(" · ").append(r.optString("modified"))
                    .append(" · ").append(r.optString("bucket")).append('\n')
            }
            if (attachId > 0) {
                val hit = rows.firstOrNull { it.optLong("id") == attachId }
                    ?: throw KernelError("attach 的 id=$attachId 不在这次结果里，先用列表里的 id")
                if (hit.optString("mime").startsWith("video") || kind == "video") {
                    sb.append("\n视频无法直接进入对话（多模态只收图片）：id=").append(attachId)
                        .append("，可建议用户在相册里截图后再 attach。")
                } else {
                    val (bytes, mime) = loadMediaBytes(attachId)
                    val dataUrl = ai.deepseek.harness.mobile.kernel.device.ImageResize
                        .dataUrl(bytes, mime.ifBlank { "image/jpeg" })
                    sb.append('\n').append(runtime().addImageData(dataUrl, "相册图片 " + hit.optString("name")))
                }
            }
            sb.toString().trim()
        },

        SimpleTool(
            name = "gallery_save",
            description = "把工作区里的图片存进系统相册（生成图、海报、截图处理结果都能进相册）。" +
                "存到 Pictures/<相册名>，相册名默认 DSH Mobile。只收图片文件。",
            parameters = Schemas.params(
                mapOf(
                    "file_path" to Schemas.prop("string", "工作区内图片的相对路径"),
                    "album" to Schemas.prop("string", "目标相册名，默认 DSH Mobile"),
                ),
                listOf("file_path"),
            ),
        ) { a ->
            calls++
            val f = ctx!!.workspace.resolve(a.pick("file_path", "path"), mustExist = true)
            if (!f.isFile || f.length() == 0L) throw KernelError("文件不存在或为空：${f.name}")
            if (!f.extension.lowercase().let { it == "png" || it == "jpg" || it == "jpeg" || it == "webp" || it == "gif" }) {
                throw KernelError("gallery_save 只收图片（png/jpg/webp/gif），这个文件是 .${f.extension}")
            }
            // 名字清洗统一走 MediaPaths：原先这里与 Capture/导入/导出各写一份、规则还不一致
            val album = ai.deepseek.harness.mobile.kernel.device.MediaPaths
                .cleanName(a.pick("album"), "DSH Mobile")
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, f.name)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(f))
                if (Build.VERSION.SDK_INT >= 29) {
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + album)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
            }
            val uri = c.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw KernelError("相册拒绝写入（存储空间不足或被系统策略限制）")
            runCatching {
                c.contentResolver.openOutputStream(uri)?.use { os -> f.inputStream().use { it.copyTo(os) } }
                    ?: throw KernelError("相册条目打开失败")
                if (Build.VERSION.SDK_INT >= 29) {
                    values.clear()
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    c.contentResolver.update(uri, values, null, null)
                }
            }.onFailure { e ->
                runCatching { c.contentResolver.delete(uri, null, null) }
                throw KernelError("写入相册失败：${e.message}")
            }
            "已存入相册 $album/${f.name}（${f.length() / 1024}KB），打开系统相册就能看到。"
        },

        SimpleTool(
            name = "file_import",
            description = "弹出系统文件选择器（SAF），把用户选中的文件导入工作区。适合「处理我手机里的 PDF/文档/图片」：" +
                "调这个工具，用户在系统界面里挑文件，挑完自动落到工作区并返回路径。一次导一个文件。",
            parameters = Schemas.params(
                mapOf(
                    "mime" to Schemas.prop("string", "限定类型，如 image/*、application/pdf、*/*（默认不限）"),
                    "dest" to Schemas.prop("string", "导入到工作区的哪个目录，默认 imports/"),
                ),
                emptyList(),
            ),
        ) { a ->
            calls++
            val uri = ai.deepseek.harness.mobile.kernel.device.UiIntents.awaitPick(c, a.pick("mime").ifBlank { "*/*" })
                ?: throw KernelError("用户没有选择文件（或等待超时）")
            val name = ai.deepseek.harness.mobile.kernel.device.UiIntents.displayName(c, uri)
            val destDir = a.pick("dest").ifBlank { "imports" }
            val safeName = ai.deepseek.harness.mobile.kernel.device.MediaPaths
                .cleanName(name, "import-${System.currentTimeMillis()}")
            val rel = "$destDir/$safeName"
            val f = ctx!!.sandbox.checkWrite(rel) ?: ctx!!.workspace.resolve(rel)
            ctx!!.workspace.mkdirs(f)
            val n = c.contentResolver.openInputStream(uri)?.use { ins -> f.outputStream().use { ins.copyTo(it) } }
                ?: throw KernelError("读不了所选文件（可能是临时文件或已失效）")
            "已导入工作区：$rel（${n / 1024}KB，原名 $safeName）。接下来可以用 read / read_doc / read_image 处理它。"
        },

        SimpleTool(
            name = "file_export",
            description = "把工作区里的文件导出到系统「下载」目录（Download/DSH Mobile/），" +
                "微信、浏览器、文件管理器都能看到这个真实位置。任何类型都可以导。",
            parameters = Schemas.params(
                mapOf(
                    "file_path" to Schemas.prop("string", "工作区内文件的相对路径"),
                    "subdir" to Schemas.prop("string", "下载目录下的子目录，默认 DSH Mobile"),
                ),
                listOf("file_path"),
            ),
        ) { a ->
            calls++
            val f = ctx!!.workspace.resolve(a.pick("file_path", "path"), mustExist = true)
            if (!f.isFile || f.length() == 0L) throw KernelError("文件不存在或为空：${f.name}")
            val sub = ai.deepseek.harness.mobile.kernel.device.MediaPaths
                .cleanName(a.pick("subdir"), "DSH Mobile")
            val mime = mimeOf(f)
            val savedTo: String = if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, f.name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + sub)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = c.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw KernelError("下载目录写入被拒绝")
                runCatching {
                    c.contentResolver.openOutputStream(uri)?.use { os -> f.inputStream().use { it.copyTo(os) } }
                        ?: throw KernelError("下载条目打开失败")
                    values.clear()
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    c.contentResolver.update(uri, values, null, null)
                }.onFailure { e ->
                    runCatching { c.contentResolver.delete(uri, null, null) }
                    throw KernelError("导出失败：${e.message}")
                }
                "Download/$sub/${f.name}"
            } else {
                // API 26-28：MediaStore.Downloads 不存在，走公共目录 + 媒体扫描
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), sub)
                if (!dir.isDirectory && !dir.mkdirs()) throw KernelError("建不了下载子目录（缺存储权限）")
                val out = File(dir, f.name)
                f.inputStream().use { ins -> out.outputStream().use { ins.copyTo(it) } }
                runCatching {
                    android.media.MediaScannerConnection.scanFile(c, arrayOf(out.absolutePath), null, null)
                }
                out.absolutePath
            }
            "已导出到 $savedTo（${f.length() / 1024}KB），文件管理器和其它应用都能看到。"
        },
    )
}
