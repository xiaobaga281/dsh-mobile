package ai.deepseek.harness.mobile.kernel.doc

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * docx 生成器的热路径基准（JVM 上跑，把 CDP/设备调度剥掉）。
 *
 * 为什么要单测来量：在设备上量到的是「CDP 往返 + 类加载 + JIT + 生成」的混合值，
 * 同一份代码两次能差 10 倍（实测 small 172ms → 1852ms），根本不能用来判断改动有没有效。
 * 生成器本身是纯 Kotlin（只依赖 java.util.zip），放到 JVM 上量才是干净的。
 *
 * 这条用例**不是**严格性能门禁（CI 机器快慢差异大），阈值放得很宽，只拦「量级退化」：
 * 一旦有人把正则写回逐行 `Regex("…")`，1600 段会从几十毫秒涨到秒级，这里就会红。
 */
class DocWriterBenchTest {

    private fun big(n: Int): String {
        val sb = StringBuilder("# 性能测试\n\n")
        repeat(n) { i ->
            sb.append("## 第 ${i + 1} 节\n\n")
            sb.append("这是一段用于压测的正文，包含**粗体**与普通文字，长度适中以便观察解析开销。\n\n")
        }
        sb.append("| 列A | 列B | 列C |\n|---|---|---|\n")
        repeat(20) { i -> sb.append("| 值$i | 数据$i | 备注$i |\n") }
        return sb.toString()
    }

    private fun timeOnce(content: String, rounds: Int): Long {
        val dir = Files.createTempDirectory("dshdoc").toFile()
        // 预热两轮：把类加载与 JIT 摘出去，再计时
        repeat(2) { DocWriter.writeDocx(File(dir, "warm$it.docx"), content, title = "性能测试") }
        var best = Long.MAX_VALUE
        repeat(rounds) { i ->
            val t = System.nanoTime()
            val r = DocWriter.writeDocx(File(dir, "bench$i.docx"), content, title = "性能测试")
            val ms = (System.nanoTime() - t) / 1_000_000
            assertTrue("产物不该是空的", r.bytes > 0)
            if (ms < best) best = ms
        }
        dir.deleteRecursively()
        return best
    }

    @Test
    fun `1600 段文档的生成必须是毫秒级`() {
        val ms = timeOnce(big(800), rounds = 3)
        println("[bench] docx 1674 段落 最短耗时 = ${ms}ms")
        // 改前（逐行 Regex 即时编译）在设备上约 3.2s；JVM 上也有数百毫秒。
        // 预编译后应当是几十毫秒。300ms 是很宽松的上界，只拦量级退化。
        assertTrue("1674 段生成耗时 ${ms}ms，明显退化（正则是否又写回逐行编译了？）", ms < 300)
    }

    @Test
    fun `短文档不该有启动成本`() {
        val ms = timeOnce(big(10), rounds = 5)
        println("[bench] docx 94 段落 最短耗时 = ${ms}ms")
        assertTrue("短文档 ${ms}ms 偏慢", ms < 60)
    }
}
