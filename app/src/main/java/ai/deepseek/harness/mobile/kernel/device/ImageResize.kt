package ai.deepseek.harness.mobile.kernel.device

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream

/**
 * 「进对话」图片的下采样：data:image;base64 是按 token 计费的，相机原图（2~8MB）
 * 直接编码进去是 token/延迟炸弹。这里把图压到多模态模型足够看清的尺寸：
 *   - 最长边 ≤ [MAX_EDGE]（约 1600px，截图/文档小字仍可读）
 *   - JPEG 质量 85（体积通常降到原图 1/8 ~ 1/15）
 * 小图（≤ [PASSTHROUGH_BYTES]）原样返回，避免无谓的二次有损压缩；
 * GIF 不动（重编码会丢动画帧）。
 */
object ImageResize {

    private const val MAX_EDGE = 1600
    private const val JPEG_QUALITY = 85
    private const val PASSTHROUGH_BYTES = 400 * 1024

    /** 返回适合放进对话的图片字节；解码失败时原样返回（宁可大也别瞎给） */
    fun forConversation(bytes: ByteArray, mime: String): ByteArray =
        forConversation(bytes, mime, MAX_EDGE, JPEG_QUALITY)

    /**
     * 带参数版本：phone_screenshot 等已知来源可以用更紧的上限。
     * 默认值与旧签名完全一致，旧调用方（CapturePlugin / DeviceMediaPlugin）行为不变。
     */
    fun forConversation(bytes: ByteArray, mime: String, maxEdge: Int, quality: Int): ByteArray {
        if (bytes.size <= PASSTHROUGH_BYTES) return bytes
        if (mime.contains("gif")) return bytes
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return bytes
        val maxDim = maxOf(bounds.outWidth, bounds.outHeight)
        if (maxDim <= maxEdge && bytes.size <= PASSTHROUGH_BYTES * 2) return bytes

        // 1) inSampleSize 粗降采样（解码内存友好）
        var sample = 1
        while (maxDim / (sample * 2) >= maxEdge) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val src = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return bytes

        // 2) 仍超长边就精确缩放
        val bmp = if (maxOf(src.width, src.height) > maxEdge) {
            val scale = maxEdge.toFloat() / maxOf(src.width, src.height)
            val w = (src.width * scale).toInt().coerceAtLeast(1)
            val h = (src.height * scale).toInt().coerceAtLeast(1)
            val scaled = Bitmap.createScaledBitmap(src, w, h, true)
            if (scaled !== src) src.recycle()
            scaled
        } else src

        val out = ByteArrayOutputStream(bmp.byteCount / 4)
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        bmp.recycle()
        return out.toByteArray()
    }

    /** byte[] → dataUrl（带下采样），对话里 attach 图片统一走这里 */
    fun dataUrl(bytes: ByteArray, mime: String): String {
        val resized = forConversation(bytes, mime)
        val outMime = if (resized !== bytes) "image/jpeg" else mime.ifBlank { "image/jpeg" }
        return "data:$outMime;base64," + android.util.Base64.encodeToString(resized, android.util.Base64.NO_WRAP)
    }
}
