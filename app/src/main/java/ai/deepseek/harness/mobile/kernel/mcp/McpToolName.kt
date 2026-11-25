package ai.deepseek.harness.mobile.kernel.mcp

import java.security.MessageDigest

/**
 * MCP 工具的公开名字。
 *
 * 与桌面 `packages/mcp/mcp-client/src/tools.ts:81` 的 `publicToolName` 同构：
 *   - 干净情况就是 `mcp__<server>__<rawName>` 原样
 *   - 需要替换字符或超长时，规范化后追加 12 位十六进制 SHA-256 前缀，保证
 *     **不同身份绝不折叠**（两个服务器都有 `search` 也能共存，且重启/重连后名字不变）
 *
 * 关键不变量：`tools/call` 永远收到 **rawName**，公开名绝不发给服务器、
 * 也绝不被解析来还原 rawName。这一条决定了"模型看到的工具名可以在版本间稳定"。
 *
 * 这个文件刻意不依赖网络与 Android，纯函数，可在 JVM 单测里穷举验证。
 */
object McpToolName {

    /** DeepSeek 函数名允许的字符集 */
    private val SAFE = Regex("[A-Za-z0-9_-]+")
    /** 公开名最大长度（留出余量给前缀与哈希后缀） */
    const val MAX_LENGTH = 64
    const val HASH_LEN = 12

    fun publicName(serverName: String, rawName: String): String {
        val joined = "mcp__${serverName}__$rawName"
        if (joined.length <= MAX_LENGTH && SAFE.matches(joined)) return joined
        val hash = sha256(joined).take(HASH_LEN)
        val suffix = "_$hash"
        val keep = (MAX_LENGTH - suffix.length).coerceAtLeast(1)
        val normalized = joined
            .map { if (it.isLetterOrDigit() || it == '_' || it == '-') it else '_' }
            .joinToString("")
            .take(keep)
        return normalized + suffix
    }

    /** 从公开名解析回 (server, raw) 是不可靠的（有损规范化），所以这里只做展示用拆分 */
    fun displayParts(publicName: String): Pair<String, String>? {
        val body = publicName.removePrefix("mcp__")
        val idx = body.indexOf("__")
        if (idx <= 0 || idx >= body.length - 2) return null
        return body.substring(0, idx) to body.substring(idx + 2)
    }

    /** server 名合法性（桌面：`[A-Za-z0-9_-]{1,32}`） */
    fun validServerName(name: String): Boolean =
        name.length in 1..32 && Regex("[A-Za-z0-9_-]+").matches(name)

    private fun sha256(s: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(d.size * 2)
        d.forEach { b -> sb.append("%02x".format(b)) }
        return sb.toString()
    }
}
