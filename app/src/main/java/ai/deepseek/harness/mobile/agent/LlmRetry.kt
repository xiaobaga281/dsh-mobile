package ai.deepseek.harness.mobile.agent

/**
 * 模型请求重试策略 —— 对齐桌面 `@deepseek-llm-retry` 的语义。
 *
 * 桌面把重试做成 provider 级策略（mode / maxRetries / retryableCodes / backoff），
 * 由 `agent/request-error` 瀑布上的插件执行：先写 `llm/retry` 持久事件，再退避等待，
 * 然后重跑同一个 step（不消耗步数、不产生模型消息）。
 *
 * 手机端在同一套边界之上做了一处简化：**固定间隔**。桌面用指数退避（0.5→1→2→4→8s + 抖动），
 * 但手机上第一次失败往往是端点没起、钥匙没填这类「等多久都不会好」的情况，
 * 指数退避只是让用户多等；固定 5 秒既能给瞬时抖动留恢复机会，又不会让最后一跳等到 10 秒。
 */
object LlmRetry {

    /** 桌面 DEFAULT_MAX_RETRIES */
    const val MAX_RETRIES = 5

    /** 每次重试的固定间隔 */
    const val RETRY_INTERVAL_MS = 5_000L

    /** 桌面 DEFAULT_RETRYABLE_CODES */
    val RETRYABLE_CODES = setOf("EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT")

    /**
     * 错误码 → 中文诊断。
     *
     * 这里只放**与环境无关**的通用说法；涉及具体端点、主机、端口的诊断由 [diagnose] 现算，
     * 不写死「127.0.0.1」「模拟器」这类只对某种环境成立的提示。
     */
    val CODE_HINTS = mapOf(
        "AUTH" to "密钥无效或已过期，请在设置里重新填写 API Key",
        "PERMISSION" to "该密钥没有访问这个模型的权限，检查模型名或账号额度",
        "BAD_REQUEST" to "请求被拒绝，多半是参数或消息格式问题",
        "CONTEXT_OVERFLOW" to "上下文超出模型窗口，项目会自动压缩后重试；仍失败请新建会话",
        "QUOTA" to "账户余额或配额不足",
        "ACCOUNT_SIGN_IN_REQUIRED" to "这个模型走 DeepSeek 账号额度，需要先在设置里登录",
        "ABORTED" to "已被用户停止",
    )

    fun retryable(code: String): Boolean = code in RETRYABLE_CODES

    /** 第 [retry] 次重试（从 1 开始）前等多久：固定 [RETRY_INTERVAL_MS] */
    @Suppress("UNUSED_PARAMETER")
    fun delayMs(retry: Int, random: Double = 0.0): Long = RETRY_INTERVAL_MS

    /** 面向用户的一句话诊断（不知道端点时用；知道端点请用 [diagnose]，能给出更具体的原因） */
    fun human(code: String, raw: String?): String = diagnose(code, raw, null, null, 0)

    /**
     * 按**实际环境**生成失败原因：错误码 + 真实主机/端口/状态码，控制在一行以内。
     *
     * 目标是「一眼知道哪儿断了」，不写教程：手机上这条要挤在一行窄气泡里，
     * 长篇指引反而看不清。同一个错误码在不同环境原因不同（回环没人监听 / 域名解析 / TLS / 鉴权），
     * 所以按实际端点分开说，而不是套一句固定的「网络不通」。
     *
     * @param baseUrl 本次请求实际用的端点（就绪前可为空）
     * @param model   本次请求的模型名
     * @param status  HTTP 状态码（非 HTTP 错误为 0）
     */
    fun diagnose(code: String, raw: String?, baseUrl: String?, model: String?, status: Int = 0): String {
        val detail = raw?.trim().orEmpty()
        val target = Endpoint.parse(baseUrl)
        val host = target?.authority.orEmpty()
        val where = if (host.isEmpty()) "" else "（$host）"
        return when (code) {
            "TRANSPORT" -> transportHint(detail, target)
            "TIMEOUT" -> "响应超时" + (if (host.isEmpty()) "" else "（$host）")
            "NOT_FOUND" -> "404 端点不存在" + (if (target == null) "" else "（${target.authority}${target.path.ifBlank { "/" }}）")
            "AUTH" -> "401 密钥无效或与端点不匹配" + where
            "PERMISSION" -> "403 无权访问" + (if (model.isNullOrBlank()) "该模型" else "「$model」") + where
            "QUOTA" -> "额度不足" + where
            "RATE_LIMIT" -> "429 限流，稍后再试"
            "SERVER" -> (if (status > 0) "$status" else "5xx") + " 服务端错误" + where
            "EMPTY_RESPONSE" -> "模型返回空内容" + (if (model.isNullOrBlank()) "" else "（$model）")
            "BAD_REQUEST" -> "400 请求被拒绝（参数或消息格式）"
            "CONTEXT_OVERFLOW" -> "上下文超出模型窗口"
            else -> CODE_HINTS[code] ?: detail.ifEmpty { "请求失败" }
        }
    }

    /** 连不上的几种情况，各自给一句最短的原因（不带教程） */
    private fun transportHint(detail: String, target: Endpoint?): String {
        val host = target?.host.orEmpty()
        val authority = target?.authority.orEmpty()
        val lower = detail.lowercase()
        val refused = lower.contains("refused") || lower.contains("拒绝")
        val dns = lower.contains("unable to resolve") || lower.contains("unknownhost") ||
            lower.contains("nodename nor servname") || lower.contains("解析")
        val tls = lower.contains("ssl") || lower.contains("tls") || lower.contains("certificate") ||
            lower.contains("certpath")
        return when {
            dns -> "域名解析失败" + (if (host.isEmpty()) "" else "（$host）")
            tls -> "TLS 握手失败" + (if (authority.isEmpty()) "" else "（$authority）")
            refused && target != null && target.loopback -> "$authority 连接被拒绝（本地端口没有服务在听）"
            refused -> "连接被拒绝" + (if (authority.isEmpty()) "" else "（$authority）")
            authority.isNotEmpty() -> "连不上 $authority"
            else -> "网络不通"
        }
    }

    /** 端点拆解：只做「主机/端口/路径/是否回环」这几件诊断需要的事 */
    data class Endpoint(val scheme: String, val host: String, val port: Int, val path: String) {
        val authority: String get() = if (port > 0) "$host:$port" else host
        val loopback: Boolean
            get() = host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "0.0.0.0" ||
                host == "10.0.2.2"

        companion object {
            fun parse(baseUrl: String?): Endpoint? {
                val s = baseUrl?.trim().orEmpty()
                if (s.isEmpty()) return null
                return try {
                    val uri = java.net.URI(if (s.contains("://")) s else "http://$s")
                    val scheme = uri.scheme ?: "http"
                    val host = uri.host ?: return null
                    val port = if (uri.port > 0) uri.port
                    else if (scheme == "https") 443 else 80
                    Endpoint(scheme, host, port, uri.path.orEmpty())
                } catch (_: Throwable) {
                    null
                }
            }
        }
    }
}
