package ai.deepseek.harness.mobile.kernel

import java.net.URL

/**
 * 明文 HTTP 的应用层策略。
 *
 * Android 的 network-security-config 不能按私网网段放行，只能全局开关或逐个域名。
 * 本地模型/自建网关又几乎都是 `http://192.168.x.x:port`。这里的折中是：
 *   · 系统层允许明文（否则局域网端点根本连不上）；
 *   · 应用层只允许「本机 / 局域网 / 单标签主机名」走 http；
 *   · 公网 http 在模型端点、模型拉取、裸调接口、搜索、中继等入口一律拒绝，要求 https。
 *
 * 这样局域网模型开箱即用，而 API Key / token 不会因为用户误填 http 地址被明文发到公网。
 */
object NetPolicy {

    fun isPrivateHost(rawHost: String?): Boolean {
        val host = rawHost?.trim()?.lowercase()?.removePrefix("[")?.removeSuffix("]").orEmpty()
        if (host.isBlank()) return false
        if (host == "localhost" || host == "::1" || host == "0.0.0.0") return true
        if (host == "host.docker.internal" || host.endsWith(".local") ||
            host.endsWith(".lan") || host.endsWith(".home") || host.endsWith(".internal")
        ) return true
        // 单标签主机名（如 my-pc、llama）：没有公网 DNS 可解析，按局域网处理
        if (!host.contains('.')) return true
        // IPv6 ULA / link-local
        if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true
        val parts = host.split('.')
        if (parts.size != 4) return false
        val a = parts[0].toIntOrNull() ?: return false
        val b = parts[1].toIntOrNull() ?: return false
        if (parts.any { it.toIntOrNull()?.let { n -> n in 0..255 } != true }) return false
        return when {
            a == 10 || a == 127 || a == 0 -> true
            a == 192 && b == 168 -> true
            a == 172 && b in 16..31 -> true
            a == 169 && b == 254 -> true
            a == 100 && b in 64..127 -> true   // CGNAT / 部分容器网络
            else -> false
        }
    }

    fun isPrivateHttp(url: String): Boolean = runCatching {
        val u = URL(url.trim())
        u.protocol.equals("http", ignoreCase = true) && isPrivateHost(u.host)
    }.getOrDefault(false)

    /** 公网 http 直接拒绝；https 与私网 http 放行。 */
    fun requireAllowed(url: String) {
        val u = runCatching { URL(url.trim()) }.getOrElse {
            throw KernelError("接口地址不合法：$url")
        }
        if (!u.protocol.equals("http", ignoreCase = true) && !u.protocol.equals("https", ignoreCase = true)) {
            throw KernelError("只支持 http/https：$url")
        }
        if (u.protocol.equals("http", ignoreCase = true) && !isPrivateHost(u.host)) {
            throw KernelError(
                "公网明文 HTTP 不安全，已拒绝：${u.host}。请改用 https；" +
                    "本机/局域网地址（localhost、10.x、172.16-31.x、192.168.x）可以直接用 http。"
            )
        }
    }
}
