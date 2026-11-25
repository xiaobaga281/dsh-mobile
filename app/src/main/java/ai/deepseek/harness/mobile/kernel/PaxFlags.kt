package ai.deepseek.harness.mobile.kernel

import java.io.File
import java.io.RandomAccessFile

/**
 * paxctl 等价实现的 ELF64 补丁器 —— PaX/W^X 内核上 JVM **确定性**启动失败的根治项。
 *
 * 机制（用户真机实测：app_build 守护进程连续 5 次同一拒绝，非抖动）：内核启用
 * grsecurity/PaX 的 MPROTECT 策略后，普通进程不允许把「先写后执行」的内存页改成
 * 可执行（W^X 策略），JVM 初始化必经 mprotect(PROT_EXEC)，被内核直接拒绝并打
 * "Failed to mark memory page as executable - check if grsecurity/PaX is enabled"。
 * proot 只拦 syscall 改不了内核策略；setarch -R 只去地址随机化，同样动不了策略。
 *
 * PaX 支持按可执行文件豁免：ELF 的 PT_PAX_FLAGS 段（paxctl 工具维护）。把 MPROTECT
 * /RANDMMAP 清除（NOMPROTECT|NORANDMMAP 置位）后，该进程的 W^X 强制解除 —— 这正是
 * Debian 时代 grsec 内核跑 OpenJDK 的官方做法（`paxctl -c -m -r java`）。JVM 启动器
 * 在我们自己的 rootfs 里，宿主进程可直接改写文件，无需 root。
 *
 * ⚠️ 适用边界（rc.117 纠偏）：**只有真 PaX 内核读 PT_PAX_FLAGS**——标准 Android
 * 内核对这段是无害 no-op。真机（标准 Android 6.12，无 PaX）上仍 100% 失败的案例
 * 已证实不是 PaX，而是 OEM 内核 W^X 加固（只禁 mprotect 翻转出可执行页）——那类
 * 设备用户态无解，用 [ai.deepseek.harness.mobile.kernel.terminal.ExecProbe] 的
 * 探针判决向用户说明，别再归因到本补丁「没生效」。
 *
 * 语义逐位对齐 paxctl 0.9（paxctl-elf.c）：
 *  - 无 PT_PAX_FLAGS 时把 PT_GNU_STACK 转换为 PT_PAX_FLAGS（`-c`），初值
 *    PF_NORANDEXEC | PF_NOEMUTRAMP；
 *  - ET_DYN 上叠加 -m -r 时 RANDEXEC 位强制走 NORANDEXEC（paxctl 的 ET_DYN 特判）；
 *  - GNU_STACK 信息被覆盖：musl 默认非执行栈，JVM 从不在栈上跑代码，可接受。
 *
 * 逐文件幂等：PT_PAX_FLAGS 已存在且 NOMPROTECT|NORANDMMAP 就位即跳过（ALREADY_OK）。
 */
object PaxFlags {

    enum class Outcome {
        /** 已写入豁免标志 */
        PATCHED,
        /** 已有豁免，无需再改 */
        ALREADY_OK,
        /** 不是 ELF64（脚本等），无事可做 */
        NOT_ELF,
        /** ELF 但既无 PT_PAX_FLAGS 也无 PT_GNU_STACK，无从标注 */
        NO_SEGMENT,
        /** 结构不支持（32 位/大端/段表异常等） */
        UNSUPPORTED,
        /** IO 失败 */
        FAILED,
    }

    private const val PT_PAX_FLAGS = 0x65041580
    private const val PT_GNU_STACK = 0x6474E551

    // paxctl.h 权威位定义（PF_PAX_MASK = 0xFFF0）
    private const val PF_MPROTECT = 1 shl 8
    private const val PF_NOMPROTECT = 1 shl 9
    private const val PF_RANDEXEC = 1 shl 10
    private const val PF_NORANDEXEC = 1 shl 11
    private const val PF_NOEMUTRAMP = 1 shl 13
    private const val PF_RANDMMAP = 1 shl 14
    private const val PF_NORANDMMAP = 1 shl 15

    private const val ET_EXEC = 2
    private const val ET_DYN = 3

    fun patch(file: File): Outcome = runCatching {
        RandomAccessFile(file, "rw").use { raf ->
            if (raf.length() < 64L) return@runCatching Outcome.NOT_ELF
            val head = ByteArray(64)
            raf.readFully(head)
            if (head[0] != 0x7F.toByte() || head[1] != 'E'.code.toByte() ||
                head[2] != 'L'.code.toByte() || head[3] != 'F'.code.toByte()
            ) return@runCatching Outcome.NOT_ELF
            // 只处理 64 位小端（aarch64/x86_64 guest JVM 全部如此）
            if (head[4].toInt() != 2 || head[5].toInt() != 1) return@runCatching Outcome.UNSUPPORTED
            val eType = u16(head, 0x10)
            if (eType != ET_EXEC && eType != ET_DYN) return@runCatching Outcome.NOT_ELF
            val phOff = u64(head, 0x20)
            val phEnt = u16(head, 0x36)
            val phNum = u16(head, 0x38)
            if (phEnt < 56 || phOff <= 0L || phOff + phEnt.toLong() * phNum > raf.length()) {
                return@runCatching Outcome.UNSUPPORTED
            }
            val table = ByteArray(phEnt * phNum)
            raf.seek(phOff)
            raf.readFully(table)

            var paxIdx = -1
            var stackIdx = -1
            for (i in 0 until phNum) {
                when (u32(table, i * phEnt)) {
                    PT_PAX_FLAGS -> if (paxIdx >= 0) return@runCatching Outcome.UNSUPPORTED else paxIdx = i
                    PT_GNU_STACK -> if (stackIdx >= 0) return@runCatching Outcome.UNSUPPORTED else stackIdx = i
                }
            }

            if (paxIdx >= 0) {
                val cur = u32(table, paxIdx * phEnt + 4)
                if ((cur and PF_MPROTECT) == 0 && (cur and PF_RANDMMAP) == 0 &&
                    (cur and PF_NOMPROTECT) != 0 && (cur and PF_NORANDMMAP) != 0
                ) return@runCatching Outcome.ALREADY_OK
                put32(table, paxIdx * phEnt + 4, paxFinal(cur, eType))
            } else if (stackIdx >= 0) {
                // -c 转换：paxctl 的初值是 PF_NORANDEXEC | PF_NOEMUTRAMP，再叠加 -m -r
                val base = paxFinal(PF_NORANDEXEC or PF_NOEMUTRAMP, eType)
                put32(table, stackIdx * phEnt, PT_PAX_FLAGS)
                put32(table, stackIdx * phEnt + 4, base)
            } else {
                return@runCatching Outcome.NO_SEGMENT
            }

            raf.seek(phOff)
            raf.write(table)
            Outcome.PATCHED
        }
    }.getOrDefault(Outcome.FAILED)

    /** paxctl 的 off/on 位运算（off = MPROTECT|RANDMMAP，on = NOMPROTECT|NORANDMMAP）。 */
    private fun paxFinal(start: Int, eType: Int): Int {
        val off = PF_MPROTECT or PF_RANDMMAP
        val on = PF_NOMPROTECT or PF_NORANDMMAP
        return if (eType == ET_DYN) {
            // paxctl：ET_DYN 上 RANDEXEC 强制走 NORANDEXEC（RANDEXEC 自 2.6.13 已不被支持）
            (start and (off or PF_RANDEXEC).inv()) or on or PF_NORANDEXEC
        } else {
            (start and off.inv()) or on
        }
    }

    private fun u16(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xFF) or ((b[o + 1].toInt() and 0xFF) shl 8)

    private fun u32(b: ByteArray, o: Int): Int =
        u16(b, o) or (u16(b, o + 2) shl 16)

    private fun u64(b: ByteArray, o: Int): Long =
        (u32(b, o).toLong() and 0xFFFFFFFFL) or
            ((u32(b, o + 4).toLong() and 0xFFFFFFFFL) shl 32)

    private fun put32(b: ByteArray, o: Int, v: Int) {
        b[o] = v.toByte()
        b[o + 1] = (v shr 8).toByte()
        b[o + 2] = (v shr 16).toByte()
        b[o + 3] = (v shr 24).toByte()
    }
}
