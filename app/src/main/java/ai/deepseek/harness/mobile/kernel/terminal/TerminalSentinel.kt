package ai.deepseek.harness.mobile.kernel.terminal

/**
 * 命令结束哨兵 —— 没有 PTY 时「命令到底跑完没有」的可判定证据。
 *
 * 病根：管道 shell 不吐提示符，旧实现只能靠「输出静默 400~700ms」猜命令结束。
 * 后果有两层：
 *   1) **慢**：每条命令固定多等一个静默窗口（实测 `which java` 一条 1092ms，
 *      而它本身是毫秒级）。二十条命令就是一二十秒。
 *   2) **不可靠**：`sleep 5 && echo done` 前 5 秒没有任何输出，静默判定会提前
 *      认为「已经结束」并把空输出交给模型；反过来慢速吐字的命令又会被当成还在跑。
 *
 * 解法：把结束标记**由 shell 自己打印**。写入时在命令后追加一行
 *   `printf '__DSH_END_<token>_%s__\n' "$?"`
 * 于是「看到标记」= 命令真的退出了，而且 `$?` 就是退出码 —— 从猜变成证据。
 * 这不是手机端自创机制：桌面的 PTY 语义同样依赖「提示符出现」作为前台空闲证据，
 * 我们只是把提示符换成了一个不可能与业务输出撞车的随机标记。
 *
 * token 每轮随机 8 位 hex，与用户输出撞车的概率可忽略；解析只认**最后一个**标记，
 * 因此多次写入残留也不会互相干扰。
 */
object TerminalSentinel {

    /** 标记前缀：`__DSH_END_<token>_<exit>__` */
    private const val PREFIX = "__DSH_END_"

    private val TOKEN_RE = Regex("^[0-9a-f]{8}$")

    /** 生成一轮写入用的 token（8 位小写 hex）。 */
    fun token(): String {
        val v = java.util.concurrent.ThreadLocalRandom.current().nextInt()
        val hex = Integer.toHexString(v).padStart(8, '0')
        return hex.substring(hex.length - 8)
    }

    /**
     * 追加到用户命令之后的那一行。
     *
     * 用单引号包住格式串，`$?` 保持双引号内展开 —— 整行不经过任何额外转义层，
     * 因此 busybox ash / dash / bash / 安卓 mksh 都能原样执行。
     */
    fun command(token: String): String = "printf '$PREFIX${token}_%s__\\n' \"\$?\""

    /** 一次命中的结果：退出码 + 已剥离标记的正文。 */
    class Hit(val exitCode: Int, val text: String)

    /**
     * 在 [output] 里找 [token] 对应的结束标记。
     *
     * 找不到返回 null（命令还在跑，或标记还没落盘）。
     * 找到则把整行标记剥掉 —— 标记是内部机制，不能污染模型看到的输出。
     */
    fun find(token: String, output: String): Hit? {
        if (!TOKEN_RE.matches(token)) return null
        val marker = "$PREFIX${token}_"
        val at = output.lastIndexOf(marker)
        if (at < 0) return null
        val close = output.indexOf("__", at + marker.length)
        if (close < 0) return null
        val code = output.substring(at + marker.length, close).trim().toIntOrNull() ?: return null

        // 连同标记前的换行一起剥掉，避免留下一个空行（模型会误以为输出没结束）
        var head = at
        while (head > 0 && (output[head - 1] == '\n' || output[head - 1] == '\r')) head--
        val text = (output.substring(0, head) + output.substring(close + 2)).trimEnd('\n', '\r')
        return Hit(code, text)
    }

    /** 命令是否已经出现结束标记（只看有无，不解析）。 */
    fun seen(token: String, output: String): Boolean = find(token, output) != null
}
