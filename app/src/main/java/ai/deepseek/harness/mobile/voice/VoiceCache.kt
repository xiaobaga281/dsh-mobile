package ai.deepseek.harness.mobile.voice

import android.content.Context
import java.io.File
import java.security.MessageDigest

/**
 * 语音合成结果的小缓存（LRU，上限 20MB）。
 *
 * 为什么值得做：固定寒暄（「嗯，我在呢」）、重播同一条语音、试听同一句话，
 * 都要重跑一次合成（系统引擎几百毫秒，云端还要走一趟网络）。缓存把它们变成读文件。
 *
 * 为什么放 filesDir 而不是 cacheDir：面板上要如实显示占用，cacheDir 会被系统
 * 静默回收，显示的数字会对不上；这里自己按 mtime 修剪，行为可预期。
 * 目录已加进 backup_rules / data_extraction_rules 的排除清单，不会被云备份带走。
 */
object VoiceCache {
    /** 目录名与存储面板共用这一份：面板要显示「谁占多少」，不能再抄一个字面量 */
    const val DIR = "voice-cache"
    /** 上限的唯一真源：存储面板（StorageAudit）也引用这个数，不许再抄一份字面量 */
    const val MAX_BYTES = 20L * 1024 * 1024

    /**
     * 缓存代次：合成链路一换，旧音频就作废（升级后同一句话不该命中旧链路的音频）。
     * 改动模型或交付链路时 +1。
     */
    private const val GEN = "v3"

    fun dir(ctx: Context): File = File(ctx.filesDir, DIR)

    /** 键 = 代次 + 引擎 + 音色 + 语速 + 文本；同一句话换个音色就是另一条 */
    fun key(engine: String, voiceKey: String, rate: Float, text: String): String {
        val raw = "$GEN|$engine|$voiceKey|$rate|$text"
        val md = MessageDigest.getInstance("SHA-1")
        val digest = md.digest(raw.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun get(ctx: Context, key: String): ByteArray? {
        val f = File(dir(ctx), "$key.wav")
        if (!f.exists()) return null
        val bytes = runCatching { f.readBytes() }.getOrNull() ?: return null
        if (bytes.size < 44) { runCatching { f.delete() }; return null }
        // 命中就把 mtime 顶上去，LRU 才不会把它当最旧的
        runCatching { f.setLastModified(System.currentTimeMillis()) }
        return bytes
    }

    fun put(ctx: Context, key: String, bytes: ByteArray) {
        if (bytes.size < 44) return
        val d = dir(ctx)
        d.mkdirs()
        runCatching {
            File(d, "$key.wav").writeBytes(bytes)
            trim(ctx)
        }
    }

    /** 超上限就按 mtime 从旧到新删，砍到 80% 为止（避免每次都删一条） */
    fun trim(ctx: Context) {
        val files = dir(ctx).listFiles() ?: return
        var total = files.sumOf { it.length() }
        if (total <= MAX_BYTES) return
        val target = (MAX_BYTES * 8 / 10)
        for (f in files.sortedBy { it.lastModified() }) {
            if (total <= target) break
            total -= f.length()
            runCatching { f.delete() }
        }
    }

    fun bytes(ctx: Context): Long = dir(ctx).listFiles()?.sumOf { it.length() } ?: 0L

    fun clear(ctx: Context): Long {
        val d = dir(ctx)
        val used = bytes(ctx)
        d.listFiles()?.forEach { runCatching { it.delete() } }
        return used
    }
}