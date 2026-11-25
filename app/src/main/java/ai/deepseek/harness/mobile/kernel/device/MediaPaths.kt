package ai.deepseek.harness.mobile.kernel.device

import org.json.JSONObject

/**
 * 媒体与设备域里「模型给的字符串要变成路径段」的统一入口。
 *
 * 为什么必须收敛成一个函数：这段清洗原本**复制了 5 份、两套规则**
 * （`CapturePlugin` 的拍照/录音文件名、`DeviceMediaPlugin` 的相册名、导入文件名、导出子目录），
 * 其中相册与子目录用的是更严的「只留字母数字中文」，文件名用的是「非法字符换成下划线」。
 * 后果有三个，都是真问题：
 *
 *  1. **改一处忘一处**：文件名规则修了、相册名规则没修，行为在不同工具间不一致；
 *  2. **没有长度上限**：Android 单个路径段上限 255 **字节**，中文占 3 字节 —— 模型给一个
 *     100 字的相册名，写入时会以「失败」告终，但错误信息里看不出是名字太长；
 *  3. **每次调用都编译一次正则**（`Regex(...)` 在构造时就 `Pattern.compile`）。
 *
 * 统一后的规则：`/ \ : * ? " < > |` 与控制字符换成 `_`（保留括号、空格、中文这些可读字符），
 * trim，截断到 [MAX_SEGMENT] 字符，空则回退到调用方给的默认名。
 * 换 `_` 而不是直接删，是为了让 `微信/收藏` 变成 `微信_收藏` 而不是 `微信收藏`（不丢信息）。
 */
object MediaPaths {

    /**
     * 单个路径段上限（字符）。
     *
     * 取 60：最坏情况 60 个 4 字节字符（emoji，虽然会被清掉）也是 240 字节，
     * 低于文件系统的 255 字节；中文 60×3 = 180 字节，安全。
     */
    const val MAX_SEGMENT = 60

    /** 文件名/目录段里不能出现的字符（Windows 与 FAT/SDCardFS 的并集，外加控制字符）。 */
    private val UNSAFE = Regex("[\\\\/:*?\"<>|\\u0000-\\u001f\\u007f]")

    /**
     * 把模型给的任意字符串清洗成一个可用的路径段。
     *
     * @param raw 原始输入（可能为空、可能含 `/` 或 `..`）
     * @param fallback 清洗后为空时的默认值（调用方必填，避免生成空段）
     */
    fun cleanName(raw: String, fallback: String): String {
        val replaced = UNSAFE.replace(raw, "_").trim()
        if (replaced.isEmpty()) return fallback
        val cut = if (replaced.length <= MAX_SEGMENT) replaced else replaced.substring(0, MAX_SEGMENT).trim()
        // 只剩下划线/空格等于「没有名字」（输入全是非法字符，或前 60 个字符全是空白）：
        // 这时产出 `__` 这种段名比回退更难排查 —— 用户在相册里只会看到一个下划线文件夹
        return if (cut.isBlank() || cut.all { it == '_' || it == ' ' }) fallback else cut
    }

    /**
     * 把两路查询结果合并成「最近 limit 条」。
     *
     * `gallery_read(kind=all)` 要同时查图片表和视频表，两路各取 limit 条后必须**按时间
     * 统一排序再截断** —— 否则模型说「最近 5 条」，拿到的是「5 张图 + 5 个视频」，
     * 而且顺序是「所有图片在前、所有视频在后」，与「最近」完全不符。
     *
     * 排序是稳定的：同一时间戳（同一秒内的连拍）保持传入顺序，不会把图片和视频交替打乱。
     */
    fun mergeRecent(images: List<JSONObject>, videos: List<JSONObject>, limit: Int): List<JSONObject> {
        if (limit <= 0) return emptyList()
        return (images + videos)
            .sortedByDescending { it.optLong("ts") }
            .take(limit)
    }
}
