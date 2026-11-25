package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickInt
import ai.deepseek.harness.mobile.kernel.plugin.pickBool
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/**
 * 采集与出口插件（P1）：让 Agent 的输入端能「看一眼现实」、输出端能「离开这个应用」。
 *
 *   photo_capture  系统相机拍一张 → 落工作区（配合 read_image 即成 OCR 闭环）
 *   transcribe     边录音边转写：系统语音引擎出文本，同时存一份录音到工作区
 *   share_file     工作区文件 → 系统分享面板（微信/邮件/网盘收到真文件）
 */
class CapturePlugin : KernelPlugin {
    override val id = "capture"
    override val name = "采集与分享"
    override val description = "系统相机拍照、语音转写、把工作区文件分享到其它应用"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var app: Context? = null
    private var captures = 0
    private var transcribes = 0
    private var shares = 0

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        app = ctx.service("app.context") as? Context
    }

    override fun onUnload() {
        ctx = null
        app = null
    }

    override fun status(): Map<String, String> = mapOf(
        "拍照" to captures.toString(),
        "转写" to transcribes.toString(),
        "分享" to shares.toString(),
    )

    private val c: Context
        get() = app ?: throw KernelError("采集插件未就绪（应用上下文缺失），重启应用后再试")

    private fun runtime(): ai.deepseek.harness.mobile.agent.ToolPipeline.RuntimeTools =
        ctx?.service("agent.runtime") as? ai.deepseek.harness.mobile.agent.ToolPipeline.RuntimeTools
            ?: throw KernelError("当前没有进行中的会话，attach 只在对话里可用")

    private fun mimeOf(f: File): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "photo_capture",
            description = "打开系统相机请用户拍一张照片，照片自动落到工作区。" +
                "拍完返回工作区路径。要看清拍了什么，接着调 read_image（OCR、认场景、找东西都靠它）。" +
                "调这个工具时屏幕会切到相机，用户拍完（或取消）后才回来。",
            parameters = Schemas.params(
                mapOf(
                    "name" to Schemas.prop("string", "照片文件名，默认 photo-<时间戳>.jpg"),
                    "attach" to Schemas.prop("boolean", "拍完直接读入对话（省一步 read_image），默认 true"),
                ),
                emptyList(),
            ),
        ) { a ->
            captures++
            val ctxRef = ctx ?: throw KernelError("插件未就绪")
            if (c.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                throw KernelError("还没有相机权限：请到系统设置 → 应用 → 权限，允许「相机」后重试")
            }
            val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.getDefault())
                .format(java.util.Date())
            val name = ai.deepseek.harness.mobile.kernel.device.MediaPaths
                .cleanName(a.pick("name"), "photo-$stamp.jpg")
                .let { if (it.endsWith(".jpg") || it.endsWith(".jpeg") || it.endsWith(".png")) it else "$it.jpg" }
            val rel = "captures/$name"
            val f = ctxRef.sandbox.checkWrite(rel) ?: ctxRef.workspace.resolve(rel)
            ctxRef.workspace.mkdirs(f)
            if (f.exists()) f.delete()
            val err = ai.deepseek.harness.mobile.kernel.device.UiIntents.awaitCamera(c, f)
            if (err != null) throw KernelError(err)
            val attach = a.pickBool("attach", "autoAttach", default = true)
            val head = "已保存到工作区：$rel（${f.length() / 1024}KB）"
            if (!attach) return@SimpleTool head
            val bytes = runCatching { f.readBytes() }.getOrElse { return@SimpleTool head }
            val dataUrl = ai.deepseek.harness.mobile.kernel.device.ImageResize.dataUrl(bytes, "image/jpeg")
            "$head\n" + runtime().addImageData(dataUrl, "刚拍的照片 $name")
        },

        SimpleTool(
            name = "transcribe",
            description = "说一段话，回来转写文本：工具会切到录音界面收音（默认 15 秒），" +
                "系统语音引擎实时转文字，同时在 recordings/ 存一份录音文件（M4A）。" +
                "适合「记一笔」「语音备忘」这类免打字输入。设备不支持语音识别时只返回录音文件路径。",
            parameters = Schemas.params(
                mapOf(
                    "duration_ms" to Schemas.prop("number", "收音时长毫秒，默认 15000，上限 120000"),
                    "name" to Schemas.prop("string", "录音文件名，默认 voice-<时间戳>.m4a"),
                ),
                emptyList(),
            ),
        ) { a ->
            transcribes++
            val ctxRef = ctx ?: throw KernelError("插件未就绪")
            if (c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw KernelError("还没有麦克风权限：请到系统设置 → 应用 → 权限，允许「麦克风」后重试")
            }
            val durationMs = a.pickInt("duration_ms", "duration", default = 15_000).coerceIn(3_000, 120_000).toLong()
            val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.getDefault())
                .format(java.util.Date())
            val name = ai.deepseek.harness.mobile.kernel.device.MediaPaths
                .cleanName(a.pick("name"), "voice-$stamp.m4a")
                .let { if (it.endsWith(".m4a") || it.endsWith(".aac")) it else "$it.m4a" }
            val rel = "recordings/$name"
            val f = ctxRef.sandbox.checkWrite(rel) ?: ctxRef.workspace.resolve(rel)
            val text = ai.deepseek.harness.mobile.kernel.device.UiIntents.transcribe(c, durationMs, f)
            val saved = if (f.isFile) "录音已存到工作区：$rel（${f.length() / 1024}KB）" else "录音保存失败"
            if (text.isBlank()) "$saved\n（没有识别到文字）"
            else "转写结果：$text\n$saved"
        },

        SimpleTool(
            name = "share_file",
            description = "弹出系统分享面板，把工作区文件发给微信/QQ/邮件/网盘等任意应用（对方收到真文件）。" +
                "适合把生成的文档、图片、录音交付到应用之外。一次分享一个文件。",
            parameters = Schemas.params(
                mapOf(
                    "file_path" to Schemas.prop("string", "工作区内文件的相对路径"),
                    "text" to Schemas.prop("string", "随文件附言（可选）"),
                ),
                listOf("file_path"),
            ),
        ) { a ->
            shares++
            val f = ctx!!.workspace.resolve(a.pick("file_path", "path"), mustExist = true)
            if (!f.isFile || f.length() == 0L) throw KernelError("文件不存在或为空：${f.name}")
            val uri = FileProvider.getUriForFile(c, "${c.packageName}.fileprovider", f)
            val text = a.pick("text")
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mimeOf(f)
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, f.name)
                if (text.isNotBlank()) putExtra(Intent.EXTRA_TEXT, text)
                clipData = android.content.ClipData.newRawUri(f.name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, "分享 " + f.name).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val ok = runCatching { c.startActivity(chooser); true }
                .getOrElse { throw KernelError("没有可分享的应用：${it.message}") }
            if (!ok) throw KernelError("分享面板没有打开")
            "已弹出分享面板（${f.name}，${f.length() / 1024}KB），请在面板里选择目标应用。"
        },
    )
}
