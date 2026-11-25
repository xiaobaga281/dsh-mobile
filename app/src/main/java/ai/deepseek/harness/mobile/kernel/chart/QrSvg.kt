package ai.deepseek.harness.mobile.kernel.chart

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.WriterException
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.QRCodeWriter

/**
 * 二维码 SVG 渲染器（qr_generate 的内核）。
 *
 * zxing 的 core 包（纯 Java）早已在依赖里（com.google.zxing:core:3.5.3），
 * 这里第一次真正用上它：BitMatrix → 合并横向连续暗模块 → 单条 SVG path。
 * 纯 JVM 可单测；SVG 矢量输出任意缩放不糊，扫描器普遍兼容。
 */
object QrSvg {

    /**
     * 生成二维码 SVG。
     * @param size 呈现尺寸（px）；内部 viewBox 按模块数计，缩放无损
     * @param color 码点颜色（6 位 hex，缺省纯黑）
     * @throws IllegalArgumentException 文本超出二维码容量等编码失败
     */
    fun build(text: String, size: Int = 512, color: String? = null): String {
        if (text.isBlank()) throw IllegalArgumentException("text 不能为空")
        val hints = mapOf(
            EncodeHintType.MARGIN to 1,                     // 1 模块静区（扫描器最低要求）
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
        )
        val matrix = try {
            // 用 1×1 请求编码：QRCodeWriter 会取 max(requested, 模块数)，1×1 得到
            // 「一模块一单元」的 BitMatrix（viewBox 即模块数，任意尺寸无损缩放）；
            // 若请求 512 会按倍率放大坐标，path 的 1 单位步长就对不上了
            QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 1, 1, hints)
        } catch (e: WriterException) {
            throw IllegalArgumentException(
                if (e.message?.contains("too big", ignoreCase = true) == true) "TEXT_TOO_LONG: 文本太长，二维码装不下"
                else "二维码编码失败：${e.message}", e)
        }
        val n = matrix.width
        val fg = color?.removePrefix("#")?.takeIf { it.matches(Regex("[0-9A-Fa-f]{6}")) } ?: "1c1c1e"
        val path = StringBuilder()
        for (y in 0 until n) {
            var x = 0
            while (x < n) {
                if (matrix.get(x, y)) {
                    var run = 1
                    while (x + run < n && matrix.get(x + run, y)) run++
                    path.append("M").append(x).append(',').append(y)
                        .append('h').append(run).append("v1h-").append(run).append('z')
                    x += run
                } else x++
            }
        }
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"$size\" height=\"$size\" " +
            "viewBox=\"0 0 $n $n\" shape-rendering=\"crispEdges\">" +
            "<rect width=\"$n\" height=\"$n\" fill=\"#ffffff\"/>" +
            "<path fill=\"#$fg\" d=\"$path\"/></svg>"
    }

    /** 模块矩阵（PNG 路径用：工具层拿它逐位画 Bitmap） */
    fun matrix(text: String): com.google.zxing.common.BitMatrix {
        val hints = mapOf(
            EncodeHintType.MARGIN to 1,
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
        )
        return try {
            QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 1, 1, hints)
        } catch (e: WriterException) {
            throw IllegalArgumentException(
                if (e.message?.contains("too big", ignoreCase = true) == true) "TEXT_TOO_LONG: 文本太长，二维码装不下"
                else "二维码编码失败：${e.message}", e)
        }
    }
}
