package ai.deepseek.harness.mobile.kernel

import ai.deepseek.harness.mobile.kernel.plugin.builtin.fs.HarnessPlugin
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.zip.GZIPOutputStream
import kotlin.concurrent.thread

/**
 * http_request 的裸通路测试：方法/头/体确实发出，响应可读，危险输入被拒。
 *
 * 用最小自建 HTTP/1.1 服务端（ServerSocket）而不是 com.sun.net.httpserver：
 * 后者不在 Android 单测的编译类路径里。全程只监听 127.0.0.1，不访问外网。
 */
class HttpExchangeTest {

    private lateinit var server: ServerSocket
    private lateinit var otherServer: ServerSocket
    private lateinit var base: String
    private lateinit var otherBase: String

    private data class Request(val method: String, val path: String, val headers: Map<String, String>, val body: String)
    private data class Response(val status: Int, val headers: Map<String, String>, val body: ByteArray)

    @Before
    fun setUp() {
        server = ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"))
        base = "http://127.0.0.1:${server.localPort}"
        otherServer = ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"))
        otherBase = "http://127.0.0.1:${otherServer.localPort}"
        acceptLoop(server)
        acceptLoop(otherServer)
    }

    private fun acceptLoop(socket: ServerSocket) {
        thread(start = true, isDaemon = true, name = "http-exchange-test") {
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (_: Throwable) { break }
                runCatching { serve(client) }
            }
        }
    }

    @After
    fun tearDown() {
        runCatching { server.close() }
        runCatching { otherServer.close() }
    }

    @Test
    fun post_sends_method_headers_and_body() {
        val out = HttpExchange.request(
            url = "$base/echo",
            method = "POST",
            headers = mapOf("X-Test" to "yes", "Authorization" to "Bearer token"),
            body = """{"a":1}""",
            contentType = "application/json",
        )
        assertTrue(out, out.startsWith("HTTP 200"))
        assertTrue(out, out.contains("method=POST"))
        assertTrue(out, out.contains("x-test=yes"))
        assertTrue(out, out.contains("auth=Bearer token"))
        assertTrue(out, out.contains("body={\"a\":1}"))
    }

    @Test
    fun rejects_non_http_schemes_and_header_injection() {
        assertThrows(KernelError::class.java) {
            HttpExchange.request("file:///etc/passwd")
        }
        assertThrows(KernelError::class.java) {
            HttpExchange.request("$base/echo", headers = mapOf("X-Bad" to "a\r\nInjected: 1"))
        }
        assertThrows(KernelError::class.java) {
            HttpExchange.request("$base/echo", method = "GET", body = "nope")
        }
        assertThrows(KernelError::class.java) {
            HttpExchange.request("$base/echo", method = "POST", body = "x", contentType = "text/plain\r\nInjected: 1")
        }
        assertThrows(KernelError::class.java) {
            HttpExchange.request("$base/echo\r\nInjected: 1")
        }
    }

    @Test
    fun truncates_large_text_but_keeps_status_and_headers() {
        val out = HttpExchange.request("$base/long", maxChars = 100)
        assertTrue(out, out.startsWith("HTTP 200"))
        assertTrue(out, out.contains("响应已截断"))
        assertTrue("正文不能超过上限：${out.length}", out.length < 900)
    }

    @Test
    fun binary_response_returns_metadata_only() {
        val out = HttpExchange.request("$base/binary")
        assertTrue(out, out.startsWith("HTTP 200"))
        assertTrue(out, out.contains("二进制响应"))
        assertTrue(out, out.contains("application/octet-stream"))
    }

    @Test
    fun follows_redirects_by_default_and_can_stop() {
        val followed = HttpExchange.request(
            "$base/redirect",
            method = "GET",
            headers = mapOf("Authorization" to "Bearer keep"),
        )
        assertTrue(followed, followed.startsWith("HTTP 200"))
        assertTrue(followed, followed.contains("method=GET"))
        assertTrue("同 origin 重定向不应丢 Authorization", followed.contains("auth=Bearer keep"))
        val stopped = HttpExchange.request("$base/redirect", method = "GET", followRedirects = false)
        assertTrue(stopped, stopped.startsWith("HTTP 302"))
    }

    @Test
    fun decodes_gzip_response() {
        val out = HttpExchange.request("$base/gzip")
        assertTrue(out, out.contains("compressed hello"))
    }

    @Test
    fun redirect_to_another_origin_drops_authorization() {
        val out = HttpExchange.request(
            "$base/redirect-other",
            headers = mapOf("Authorization" to "Bearer secret", "X-Keep" to "yes"),
        )
        assertTrue(out, out.startsWith("HTTP 200"))
        assertTrue(out, out.contains("auth=\n"))
        assertTrue("跨 origin 重定向必须丢掉 Authorization", !out.contains("Bearer secret"))
    }

    @Test
    fun tool_accepts_json_object_body() {
        val tool = HarnessPlugin().tools.first { it.name == "http_request" }
        val args = JSONObject()
            .put("url", "$base/echo")
            .put("method", "POST")
            .put("headers", JSONObject().put("X-Test", "yes"))
            .put("body", JSONObject().put("a", 1))
        val out = tool.execute(args)
        assertTrue(out, out.contains("body={\"a\":1}"))
    }

    private fun serve(socket: Socket) {
        socket.use { s ->
            s.soTimeout = 5_000
            val input = s.getInputStream()
            val request = readRequest(input) ?: return
            val response = when (request.path) {
                "/echo" -> Response(
                    200,
                    mapOf("Content-Type" to "text/plain"),
                    ("method=${request.method}\n" +
                        "x-test=${request.headers["x-test"].orEmpty()}\n" +
                        "auth=${request.headers["authorization"].orEmpty()}\n" +
                        "body=${request.body}").toByteArray(),
                )
                "/long" -> Response(200, mapOf("Content-Type" to "text/plain"), "a".repeat(1_000).toByteArray())
                "/binary" -> Response(
                    200,
                    mapOf("Content-Type" to "application/octet-stream"),
                    byteArrayOf(0, 1, 2, 3, 0x7f),
                )
                "/redirect" -> Response(302, mapOf("Location" to "/echo"), ByteArray(0))
                "/redirect-other" -> Response(302, mapOf("Location" to "$otherBase/echo"), ByteArray(0))
                "/gzip" -> {
                    val raw = ByteArrayOutputStream()
                    GZIPOutputStream(raw).use { it.write("compressed hello".toByteArray()) }
                    Response(200, mapOf("Content-Type" to "text/plain", "Content-Encoding" to "gzip"), raw.toByteArray())
                }
                else -> Response(404, mapOf("Content-Type" to "text/plain"), "not found".toByteArray())
            }
            writeResponse(s, response)
        }
    }

    private fun readRequest(input: InputStream): Request? {
        val head = StringBuilder()
        while (!head.endsWith("\r\n\r\n")) {
            val b = input.read()
            if (b < 0) return null
            head.append(b.toChar())
            if (head.length > 65_536) return null
        }
        val lines = head.toString().split("\r\n")
        val parts = lines.first().split(" ")
        if (parts.size < 3) return null
        val headers = LinkedHashMap<String, String>()
        for (line in lines.drop(1)) {
            if (line.isBlank()) continue
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }
        val length = headers["content-length"]?.toIntOrNull() ?: 0
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(body, read, length - read)
            if (n <= 0) return null
            read += n
        }
        return Request(parts[0], parts[1].substringBefore('?'), headers, String(body, Charsets.UTF_8))
    }

    private fun writeResponse(socket: Socket, response: Response) {
        val head = buildString {
            append("HTTP/1.1 ${response.status} ${if (response.status in 200..299) "OK" else "STATUS"}\r\n")
            append("Content-Length: ${response.body.size}\r\n")
            append("Connection: close\r\n")
            for ((k, v) in response.headers) append("$k: $v\r\n")
            append("\r\n")
        }
        socket.getOutputStream().use { out ->
            out.write(head.toByteArray(Charsets.ISO_8859_1))
            out.write(response.body)
            out.flush()
        }
    }
}
