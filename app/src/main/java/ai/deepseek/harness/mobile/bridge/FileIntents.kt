package ai.deepseek.harness.mobile.bridge

import android.content.Intent
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.core.content.FileProvider
import ai.deepseek.harness.mobile.MainActivity
import org.json.JSONObject
import java.io.File

/**
 * 工作区文件的「用系统应用打开」能力，被宿主域与内核域共用。
 *
 * 单独抽出来的原因：预览（host.openWorkspaceFile）和「其它应用打开」（kernel.externalOpen）
 * 走的是同一套路径校验 + FileProvider + 意图拼装，逻辑一旦分两份就会一边改一边忘。
 */
internal object FileIntents {

    /** 相对路径按工作区解析，绝对路径必须落在工作区内，防止越权读文件 */
    fun resolve(activity: MainActivity, p: String): File? = runCatching {
        val ws = activity.kernel.workspace
        val raw = p.trim()
        if (raw.isEmpty()) return@runCatching null
        val abs = File(raw)
        if (abs.isAbsolute) {
            val c = abs.canonicalFile
            if (c.path.startsWith(ws.root.canonicalPath) && c.isFile) c else null
        } else {
            ws.resolve(raw, mustExist = true).takeIf { it.isFile }
        }
    }.getOrNull()

    fun mime(f: File): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "*/*"

    /** 分享文件给其它应用：ACTION_SEND + FileProvider，微信/邮件/网盘都能收到真文件 */
    fun share(activity: MainActivity, f: File): String {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", f)
        val mime = mime(f)
        var err = ""
        activity.runOnUiThread {
            runCatching {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, f.name)
                    clipData = android.content.ClipData.newRawUri(f.name, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.startActivity(
                    Intent.createChooser(send, "分享文件").apply {
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    },
                )
            }.onFailure { t ->
                err = t.message ?: "没有可分享的应用"
                Toast.makeText(activity, "分享失败：$err", Toast.LENGTH_SHORT).show()
            }
        }
        return if (err.isEmpty()) JSONObject().put("ok", true).toString()
        else JSONObject().put("ok", false).put("error", err).toString()
    }

    /** 交给系统查看器打开；返回 JSON {ok,error}，前端不会再「点了没反应」 */
    fun open(activity: MainActivity, f: File): String {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", f)
        val mime = mime(f)
        val view = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            // 部分机型按类型匹配不到时会退回看 ClipData，两个都加上
            clipData = android.content.ClipData.newRawUri(f.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        var err = ""
        activity.runOnUiThread {
            runCatching {
                activity.startActivity(Intent.createChooser(view, "用其它应用打开").apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                })
            }.onFailure { t ->
                err = t.message ?: "没有能打开该文件的应用"
                Toast.makeText(activity, "没有能打开「${f.name}」的应用（$mime）", Toast.LENGTH_SHORT).show()
            }
        }
        return if (err.isEmpty()) JSONObject().put("ok", true).toString()
        else JSONObject().put("ok", false).put("error", "系统里没有能打开 $mime 的应用").toString()
    }
}
