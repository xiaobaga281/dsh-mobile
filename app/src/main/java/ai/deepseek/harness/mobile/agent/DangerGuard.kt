package ai.deepseek.harness.mobile.agent

import org.json.JSONObject

/**
 * 危险操作的唯一判定（设置 → Agent → 危险操作前询问 的实际内容）。
 *
 * 抽成纯函数的原因：这段判定以前埋在 [ToolPipeline] 的 waterfall 里，
 * 想验证「开关打开时 rm -rf 到底会不会先问」只能跑一整轮真模型对话 —— 既慢又受网络影响。
 * 现在它不碰钩子、不碰运行时，输入工具名 + 参数，输出一句人话原因（空串 = 不必确认）。
 *
 * 判定边界（有意为之，别随手扩大）：
 *  - **只拦「不可逆」或「不可预知影响」的动作**：删除、覆盖式移动、块设备写、重启、
 *    清空式重定向、git push、插件卸载。写文件/改文件不拦 —— 那是工作区的日常操作，
 *    每步都弹窗会把确认变成闭眼点「允许」。
 *  - `run_code` / `pwsh` 的载荷字段是 `code`，不是 `command`，这里统一取。
 *  - 正则只认「命令词 + 常见破坏形态」，不试图做 shell 解析。**有意不剥离引号内容**：
 *    `sh -c "rm -rf /"` 恰恰是最危险的一类，剥掉引号会把它放过去。代价是
 *    `echo "rm is a command"` 这种也会问一句 —— 安全侧多问一次，比漏掉真删除好。
 */
internal object DangerGuard {

    /** POSIX 侧：破坏性动词、find -delete、清空重定向、git push */
    private val POSIX = Regex(
        """\b(rm|rmdir|mv|dd|mkfs|reboot|shutdown|shred|truncate)\b|-delete\b|:>|>\s*[^&]|git\s+push""",
    )

    /**
     * 无害的「丢输出」重定向：`2>/dev/null`、`>/dev/null`、`&>/dev/null`。
     *
     * 判定前先剔掉它们 —— 原来 `>\s*[^&]` 会把 `2>/dev/null` 当成「覆盖写文件」，
     * 于是只读的 `find . -iname "README*" 2>/dev/null` 也被拦成「可能破坏数据」
     * （本地模型实测：子代理连 README 都读不了）。丢弃输出不改变任何数据。
     */
    private val DISCARD = Regex("""[0-9&]?>\s*/dev/null\b""")

    /** Windows 侧（shell 命令）：动词大小写不敏感，单独一条正则 */
    private val WINDOWS = Regex(
        """\b(remove-item|del|erase|rd|ri|format|clear-content|stop-computer)\b""",
        RegexOption.IGNORE_CASE,
    )

    /** 返回「需要用户确认」的理由；空串表示不拦 */
    fun reason(name: String, args: JSONObject): String = when (name) {
        // 工具名以 FsPlugin 注册的为准（delete_path 同时删目录，递归）
        "delete_path" -> "删除 ${args.optString("path")}（目录会递归删除）"

        "bash", "run_code", "pwsh" -> {
            val cmd = args.optString("command").ifBlank { args.optString("code") }
            val probe = cmd.replace(DISCARD, " ")     // 丢输出不算写文件
            if (cmd.isNotBlank() && (POSIX.containsMatchIn(probe) || WINDOWS.containsMatchIn(probe))) {
                "执行可能破坏数据的操作：${cmd.take(160)}"
            } else {
                ""
            }
        }

        // 裸调接口：GET/HEAD 只读，其余方法可能真的改动远端数据
        "http_request" -> {
            val method = args.optString("method", "GET").trim().uppercase().ifBlank { "GET" }
            if (method in setOf("POST", "PUT", "PATCH", "DELETE")) {
                "向 ${args.optString("url").take(160)} 发送 $method 请求（可能改动远端数据）"
            } else {
                ""
            }
        }

        "plugin_uninstall" -> "卸载插件 ${args.optString("id")}"
        else -> ""
    }
}
