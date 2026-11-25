package ai.deepseek.harness.mobile.kernel

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream

/**
 * 通用 HTTP 请求（http_request 工具的实现）。
 *
 * 存在的理由：专用工具（web_fetch / 各生成插件）把参数封装死了，一旦工具 schema
 * 和端点方言对不上，模型没有任何逃生通道，只能等发版修工具。这里给一条受权限
 * 门控的裸通路：方法、请求头、请求体都由调用方给，按接口文档原样发。
 *
 * 与 [HttpDownload] 的分工：那个只负责「把文件下到本地」，带大小上限、不暴露
 * 状态码/头/错误体；这里要的是调试接口所需的完整往返信息。
 *
 * 安全边界：
 *   · 只允许 http/https（file/content/javascript 一律拒绝）；
 *   · 请求头禁止 CR/LF（防注入），Host/Content-Length 等由 HttpURLConnection 管理；
 *   · 重定向自己跟（不用 HttpURLConnection 的自动跟随）：跨 origin 一律摘掉
 *     Authorization/Cookie，避免 token 跟着 302 泄漏到别的域；
 *   · 响应体按字符截断，二进制响应只返回元信息（不把乱码塞给模型）。
 */
object HttpExchange {

    private val METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
    private val FORBIDDEN_HEADERS = setOf("host", "content-length", "connection", "transfer-encoding", "upgrade")
    private val SENSITIVE_HEADERS = setOf("authorization", "cookie", "proxy-authorization")
    private val REDIRECTS = setOf(301, 302, 303, 307, 308)
    private val TEXTUAL = listOf(
        "json", "text", "xml", "html", "javascript", "x-www-form-urlencoded", "graphql", "yaml", "csv",
    )
    private const val MAX_REQUEST_BYTES = 1_000_000
    private const val DEFAULT_MAX_CHARS = 12_000
    private const val MAX_CHARS = 40_000
    private const val MAX_REDIRECTS = 5

    fun request(
        url: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: String? = null,
        contentType: String? = null,
        timeoutMs: Int = 30_000,
        maxChars: Int = DEFAULT_MAX_CHARS,
        followRedirects: Boolean = true,
    ): String {
        if (url.contains('\r') || url.contains('\n')) throw KernelError("URL 不能包含换行")
        val parsed = try {
            URL(url)
        } catch (e: Throwable) {
            throw KernelError("URL 不合法：$url")
        }
        if (parsed.protocol != "http" && parsed.protocol != "https") {
            throw KernelError("只支持 http/https，收到 ${parsed.protocol}：$url")
        }
        NetPolicy.requireAllowed(url)
        val initialMethod = method.trim().uppercase().ifBlank { "GET" }
        if (initialMethod !in METHODS) {
            throw KernelError("不支持的 HTTP 方法：$method（可选 ${METHODS.joinToString("/")}）")
        }
        if ((initialMethod == "GET" || initialMethod == "HEAD") && !body.isNullOrEmpty()) {
            throw KernelError("$initialMethod 请求不能带 body")
        }
        if (body != null && body.toByteArray(Charsets.UTF_8).size > MAX_REQUEST_BYTES) {
            throw KernelError("请求体过大（上限 1MB）；大文件请先写入工作区再分片发送")
        }
        val budget = timeoutMs.coerceIn(1_000, 60_000)
        val chars = maxChars.coerceIn(500, MAX_CHARS)
        if (contentType != null && (contentType.contains('\r') || contentType.contains('\n'))) {
            throw KernelError("Content-Type 不能包含换行")
        }
        for ((name, value) in headers) {
            if (name.isBlank() || name.contains('\r') || name.contains('\n') ||
                value.contains('\r') || value.contains('\n')
            ) {
                throw KernelError("请求头不合法（不能为空或包含换行）：$name")
            }
        }

        var current = parsed
        var currentMethod = initialMethod
        var currentBody = body
        var currentHeaders = headers
        var hops = 0
        while (true) {
            val conn = current.openConnection() as HttpURLConnection
            var next: URL? = null
            try {
                conn.requestMethod = currentMethod
                conn.connectTimeout = minOf(15_000, budget)
                conn.readTimeout = budget
                // 自己跟重定向：这样才能在跨 origin 时摘掉敏感头
                conn.instanceFollowRedirects = false
                conn.setRequestProperty("User-Agent", "DSH-Mobile/1.0 (Android)")
                for ((name, value) in currentHeaders) {
                    if (name.lowercase() in FORBIDDEN_HEADERS) continue
                    conn.setRequestProperty(name, value)
                }
                val hasContentType = currentHeaders.keys.any { it.equals("Content-Type", ignoreCase = true) } ||
                    !contentType.isNullOrBlank()
                if (!contentType.isNullOrBlank()) conn.setRequestProperty("Content-Type", contentType)
                if (!currentBody.isNullOrEmpty()) {
                    if (!hasContentType) {
                        val looksJson = currentBody.trimStart().startsWith("{") || currentBody.trimStart().startsWith("[")
                        conn.setRequestProperty(
                            "Content-Type",
                            if (looksJson) "application/json; charset=utf-8" else "text/plain; charset=utf-8",
                        )
                    }
                    conn.doOutput = true
                    conn.outputStream.use { it.write(currentBody.toByteArray(Charsets.UTF_8)) }
                }
                val code = conn.responseCode
                if (followRedirects && code in REDIRECTS && hops < MAX_REDIRECTS) {
                    val location = conn.getHeaderField("Location")
                    val target = location?.let { runCatching { URL(current, it) }.getOrNull() }
                    if (target != null && (target.protocol == "http" || target.protocol == "https")) {
                        hops += 1
                        currentHeaders = if (originKey(current) == originKey(target)) {
                            currentHeaders
                        } else {
                            currentHeaders.filterKeys { it.lowercase() !in SENSITIVE_HEADERS }
                        }
                        currentMethod = when (code) {
                            303 -> if (currentMethod == "HEAD") "HEAD" else "GET"
                            301, 302 -> if (currentMethod == "POST") "GET" else currentMethod
                            else -> currentMethod
                        }
                        if (currentMethod == "GET" || currentMethod == "HEAD") currentBody = null
                        next = target
                    }
                }
                if (next == null) return readResponse(conn, currentMethod, chars)
            } catch (e: java.net.SocketTimeoutException) {
                throw KernelError("请求超时（${budget}ms）：$current")
            } catch (e: KernelError) {
                throw e
            } catch (e: Throwable) {
                throw KernelError("请求失败：${e.message ?: e.javaClass.simpleName}（$current）")
            } finally {
                conn.disconnect()
            }
            current = next ?: throw KernelError("请求失败：重定向目标缺失（$current）")
        }
    }

    private fun readResponse(conn: HttpURLConnection, method: String, chars: Int): String {
        val code = conn.responseCode
        val rawStream = runCatching { if (code in 200..299) conn.inputStream else conn.errorStream }.getOrNull()
        val ctype = conn.contentType.orEmpty()
        val head = buildString {
            append("HTTP $code ${conn.responseMessage.orEmpty()}".trimEnd())
            append('\n')
            for (key in conn.headerFields.keys.filterNotNull().sorted()) {
                val values = conn.headerFields[key].orEmpty().joinToString(", ")
                if (values.isNotBlank()) append("$key: $values\n")
            }
            append('\n')
        }
        if (rawStream == null || method == "HEAD") return head + "（空响应体）"
        val capBytes = minOf(4_000_000, chars * 4 + 1)
        val bytes = rawStream.use { decodeStream(it, conn.contentEncoding).use { decoded -> readCapped(decoded, capBytes) } }
        if (!isTextual(ctype)) {
            return head + "（二进制响应，${bytes.size} 字节，Content-Type: ${ctype.ifBlank { "未知" }}；未返回正文）"
        }
        var text = String(bytes, charsetOf(ctype))
        val truncated = bytes.size >= capBytes || text.length > chars
        if (text.length > chars) text = text.substring(0, chars)
        return head + text + if (truncated) "\n\n…（响应已截断，共读取 ${bytes.size} 字节；调大 max_chars 重试）" else ""
    }

    private fun originKey(url: URL): String {
        val port = when {
            url.port != -1 -> url.port
            url.protocol == "https" -> 443
            else -> 80
        }
        return "${url.protocol}://${url.host.lowercase()}:$port"
    }

    private fun isTextual(contentType: String): Boolean {
        val lower = contentType.lowercase()
        if (lower.isBlank()) return true
        return TEXTUAL.any { lower.contains(it) }
    }

    private fun charsetOf(contentType: String): Charset {
        val name = Regex("charset\\s*=\\s*([A-Za-z0-9._-]+)", RegexOption.IGNORE_CASE)
            .find(contentType)?.groupValues?.get(1)
        return runCatching { Charset.forName(name ?: "UTF-8") }.getOrDefault(Charsets.UTF_8)
    }

    private fun decodeStream(input: InputStream, encoding: String?): InputStream = when (encoding?.lowercase()) {
        "gzip" -> GZIPInputStream(input)
        "deflate" -> InflaterInputStream(input)
        else -> input
    }

    private fun readCapped(input: InputStream, cap: Int): ByteArray {
        val out = ByteArrayOutputStream(minOf(cap, 64 * 1024))
        val buf = ByteArray(16 * 1024)
        var total = 0
        while (total < cap) {
            val read = input.read(buf, 0, minOf(buf.size, cap - total))
            if (read <= 0) break
            out.write(buf, 0, read)
            total += read
        }
        return out.toByteArray()
    }
}
