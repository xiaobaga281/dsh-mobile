package ai.deepseek.harness.mobile.kernel.terminal

/**
 * proot 下 JVM 启动失败（mprotect(PROT_EXEC) 被拒）—— 判定与兜底重试。
 *
 * 症状：进程以非 0 退出，输出只有一行 `Error occurred during initialization of VM`
 * 加 `Failed to mark memory page as executable - check if grsecurity/PaX is enabled`。
 *
 * ⚠️ 那行提示是 HotSpot 对「拿不到可执行内存」的**通用提示**，不代表内核真有
 * grsecurity/PaX。已知的可能机制（用 [ExecProbe] 判别，不再靠猜）：
 * - **真 PaX 内核**（MPROTECT 策略）：按文件的 PT_PAX_FLAGS 豁免有效 ——
 *   `kernel/PaxFlags` 已自动给全部 JVM 启动器打补丁；
 * - **地址随机化竞态**：setarch -R（禁 ASLR）有效 —— JVM 入口统一经
 *   [ai.deepseek.harness.mobile.kernel.KernelRuntime.withJvmAntiPax] 加 -R 前缀；
 * - **OEM 内核加固 / 等效 PaX 硬模式**（标准 Android 内核也会遇到，rc.116 真机
 *   实证）：内核/LSM 层策略，用户态无法解除 —— 探针会给出判决与下一步。
 *
 * 判据必须收得很紧，**只认「VM 根本没起来」**：
 * 这类失败发生在执行用户代码之前，重试不会重复副作用；而一旦 Java 程序自己抛异常退出，
 * 输出里不会有这两行，就不会被误判成抖动（否则 `rm -rf` 之类的命令会被跑两遍）。
 */
object JvmStartupJitter {

    private const val HEADER = "Error occurred during initialization of VM"
    private const val MARK_FAIL = "Failed to mark memory page as executable"

    /**
     * 输出是否**只**代表「JVM 没起来」。
     *
     * 两个条件都要满足：有 VM 初始化抬头、且有 mprotect 失败行。
     * 只看抬头不够 —— 堆太大（`Could not reserve enough space`）也会打同样的抬头，
     * 那种情况重试没用，应当如实报给模型去调参数。
     */
    fun isTransient(output: String): Boolean {
        if (!output.contains(HEADER)) return false
        if (!output.contains(MARK_FAIL)) return false
        // 用户代码已经跑过（有栈帧）就不是启动抖动
        val ranUserCode = output.contains("\tat ") || output.contains("Exception in thread")
        return !ranUserCode
    }

    /**
     * 给用户的可行动说明。paxctl 补丁与 setarch -R 两层都还失败时，
     * 不再断言「grsec 硬模式」（rc.115 的结论已被标准内核真机推翻），
     * 而是附上 [ExecProbe] 的判别结果，把「哪一种机制、下一步能做什么」说清。
     */
    fun advice(attempts: Int): String {
        val base = "JVM 启动被拒（mprotect(PROT_EXEC) 失败，与你的命令无关），已自动重试 $attempts 次。" +
            "报错里的 grsecurity/PaX 是 HotSpot 的通用提示，不代表内核真有 PaX。" +
            "已内置的豁免只覆盖两类已知机制：paxctl 补丁（真 PaX 内核）与 setarch -R（地址随机化竞态）；" +
            "标准内核上仍 100% 失败时，最可能是 OEM 内核加固（W^X：禁止把已写页翻转成可执行——" +
            "ART 用 mmap 时直接带 X 所以没事，HotSpot 靠 mprotect 翻转所以必死）。" +
            "请把这条输出反馈给用户：属内核/LSM 层策略时用户态无法解除，需要 root 豁免或换 ROM / 设备，" +
            "这不是命令写法问题。"
        val probe = ExecProbe.report()?.let { "\n[执行内存探针]\n$it" } ?: ""
        return base + probe
    }
}
