package ai.deepseek.harness.mobile.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.RandomAccessFile

/**
 * PaxFlags（paxctl -c -m -r 等价 ELF64 补丁器）单测。
 * 合成最小 ELF64，逐位断言 PT_PAX_FLAGS 的最终值与 paxctl 语义一致。
 */
class PaxFlagsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    companion object {
        const val PT_LOAD = 1
        const val PT_GNU_STACK = 0x6474E551
        const val PT_PAX_FLAGS = 0x65041580
        const val ET_EXEC = 2
        const val ET_DYN = 3
        const val PF_MPROTECT = 0x100
        const val PF_NOMPROTECT = 0x200
        const val PF_RANDEXEC = 0x400
        const val PF_NORANDEXEC = 0x800
        const val PF_NOEMUTRAMP = 0x2000
        const val PF_RANDMMAP = 0x4000
        const val PF_NORANDMMAP = 0x8000

        /** 合成 64 位小端 ELF：e_phoff=64，e_phentsize=56，段表 = type+flags 列表。 */
        fun elf64(eType: Int, phdrs: List<Pair<Int, Long>>): ByteArray {
            val buf = ByteArray(64 + 56 * phdrs.size)
            buf[0] = 0x7F; buf[1] = 'E'.code.toByte(); buf[2] = 'L'.code.toByte(); buf[3] = 'F'.code.toByte()
            buf[4] = 2 // ELFCLASS64
            buf[5] = 1 // little endian
            put16(buf, 0x10, eType)
            put64(buf, 0x20, 64L)
            put16(buf, 0x36, 56)
            put16(buf, 0x38, phdrs.size)
            phdrs.forEachIndexed { i, (type, flags) ->
                val o = 64 + i * 56
                put32(buf, o, type)
                put32(buf, o + 4, flags.toInt())
            }
            return buf
        }

        fun put16(b: ByteArray, o: Int, v: Int) {
            b[o] = v.toByte(); b[o + 1] = (v shr 8).toByte()
        }

        fun put32(b: ByteArray, o: Int, v: Int) {
            b[o] = v.toByte(); b[o + 1] = (v shr 8).toByte()
            b[o + 2] = (v shr 16).toByte(); b[o + 3] = (v shr 24).toByte()
        }

        fun put64(b: ByteArray, o: Int, v: Long) {
            for (i in 0 until 8) b[o + i] = (v shr (8 * i)).toByte()
        }

        fun get32(b: ByteArray, o: Int): Int {
            var v = 0
            for (i in 3 downTo 0) v = (v shl 8) or (b[o + i].toInt() and 0xFF)
            return v
        }

        /** 读指定序号 phdr 的 (type, flags)。 */
        fun phdr(b: ByteArray, i: Int): Pair<Int, Int> {
            val o = 64 + i * 56
            return get32(b, o) to get32(b, o + 4)
        }
    }

    private fun write(name: String, data: ByteArray): java.io.File {
        val f = tmp.newFile(name)
        RandomAccessFile(f, "rw").use { it.write(data) }
        return f
    }

    @Test
    fun `GNU_STACK converted to PAX_FLAGS with mprotect exempt on ET_DYN`() {
        val f = write("java", elf64(ET_DYN, listOf(PT_LOAD to 0x500L, PT_GNU_STACK to 0x6L)))
        assertEquals(PaxFlags.Outcome.PATCHED, PaxFlags.patch(f))
        val d = f.readBytes()
        val (type, flags) = phdr(d, 1)
        assertEquals(PT_PAX_FLAGS, type)
        // paxctl -c 初值 NORANDEXEC|NOEMUTRAMP，叠加 -m -r 后：
        // NOMPROTECT | NORANDEXEC | NOEMUTRAMP | NORANDMMAP
        assertEquals(PF_NOMPROTECT or PF_NORANDEXEC or PF_NOEMUTRAMP or PF_NORANDMMAP, flags)
        assertEquals(0, flags and (PF_MPROTECT or PF_RANDMMAP))
    }

    @Test
    fun `second run is idempotent`() {
        val f = write("java", elf64(ET_DYN, listOf(PT_LOAD to 0x500L, PT_GNU_STACK to 0x6L)))
        assertEquals(PaxFlags.Outcome.PATCHED, PaxFlags.patch(f))
        assertEquals(PaxFlags.Outcome.ALREADY_OK, PaxFlags.patch(f))
    }

    @Test
    fun `existing PAX_FLAGS with MPROTECT gets exemption applied`() {
        val f = write("java", elf64(ET_DYN, listOf(PT_LOAD to 0x500L, PT_PAX_FLAGS to (PF_MPROTECT or PF_RANDMMAP).toLong())))
        assertEquals(PaxFlags.Outcome.PATCHED, PaxFlags.patch(f))
        val (_, flags) = phdr(f.readBytes(), 1)
        assertEquals(0, flags and (PF_MPROTECT or PF_RANDMMAP))
        assertEquals(PF_NOMPROTECT or PF_NORANDMMAP, flags and (PF_NOMPROTECT or PF_NORANDMMAP))
    }

    @Test
    fun `ET_EXEC existing PAX_FLAGS keeps RANDEXEC bit untouched`() {
        // paxctl 语义：-c 转换会整体覆写 flags（GNU_STACK 信息被销毁）；
        // 「保留 RANDEXEC 位」只发生在已有 PT_PAX_FLAGS 的 ET_EXEC 上
        val f = write(
            "java-exec",
            elf64(ET_EXEC, listOf(PT_LOAD to 0x500L, PT_PAX_FLAGS to (PF_MPROTECT or PF_RANDMMAP or PF_RANDEXEC).toLong())),
        )
        assertEquals(PaxFlags.Outcome.PATCHED, PaxFlags.patch(f))
        val (_, flags) = phdr(f.readBytes(), 1)
        assertEquals(0, flags and (PF_MPROTECT or PF_RANDMMAP))
        assertEquals(PF_RANDEXEC, flags and PF_RANDEXEC)
        assertEquals(PF_NOMPROTECT or PF_NORANDMMAP, flags and (PF_NOMPROTECT or PF_NORANDMMAP))
    }

    @Test
    fun `non-elf and script files are skipped safely`() {
        val f = write("script", "#!/bin/sh\necho hi\n".toByteArray())
        assertEquals(PaxFlags.Outcome.NOT_ELF, PaxFlags.patch(f))
    }

    @Test
    fun `elf without pax or gnu_stack segment reports NO_SEGMENT`() {
        val f = write("plain", elf64(ET_DYN, listOf(PT_LOAD to 0x500L)))
        assertEquals(PaxFlags.Outcome.NO_SEGMENT, PaxFlags.patch(f))
    }

    @Test
    fun `real openjdk launcher layout is patched`() {
        // 形态复刻自真机 rootfs 的 arm64 java 启动器：ET_DYN，13 个 phdr，
        // PT_INTERP 在 [1]，PT_GNU_STACK 在 [7]，无 PT_PAX_FLAGS
        val phdrs = buildList {
            add(PT_LOAD to 0x500L)                      // PHDR-ish
            add(3 to 0x4L)                              // PT_INTERP
            repeat(5) { add(PT_LOAD to 0x500L) }
            add(PT_GNU_STACK to 0x6L)
            repeat(5) { add(PT_LOAD to 0x500L) }
        }
        val f = write("java-real", elf64(ET_DYN, phdrs))
        assertEquals(PaxFlags.Outcome.PATCHED, PaxFlags.patch(f))
        val d = f.readBytes()
        val (type, flags) = phdr(d, 7)
        assertEquals(PT_PAX_FLAGS, type)
        assertTrue(flags and PF_NOMPROTECT != 0)
        assertTrue(flags and PF_NORANDMMAP != 0)
        assertEquals(0, flags and (PF_MPROTECT or PF_RANDMMAP))
    }
}
