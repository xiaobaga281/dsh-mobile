package ai.deepseek.harness.mobile.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * guest /etc/resolv.conf 的内容生成。
 *
 * 回归的是「proot guest 里 getaddrinfo 全 EAI_AGAIN」那一类静默失败：
 * rootfs 由 APK 载荷解出，没有 init 生成 resolv.conf；文件名写对但内容不合法
 * （空文件、只有换行）同样会让下次补齐被 `length() > 0` 判成「已配置」而永远跳过。
 */
class KernelRuntimeResolvTest {

    @Test
    fun 默认DNS生成两条nameserver且以换行收尾() {
        val text = KernelRuntime.resolvConfText(KernelRuntime.DEFAULT_GUEST_DNS)
        assertEquals("nameserver 1.1.1.1\nnameserver 8.8.8.8\n", text)
    }

    @Test
    fun 空白与空项被过滤掉() {
        val text = KernelRuntime.resolvConfText(listOf("  ", "1.1.1.1", "", "  8.8.8.8  "))
        assertEquals("nameserver 1.1.1.1\nnameserver 8.8.8.8\n", text)
    }

    @Test
    fun 全空列表返回空串而不是只有换行的文件() {
        assertEquals("", KernelRuntime.resolvConfText(emptyList()))
        assertEquals("", KernelRuntime.resolvConfText(listOf("", "   ")))
    }

    @Test
    fun 自定义DNS可用且保持顺序() {
        val text = KernelRuntime.resolvConfText(listOf("192.168.1.1", "10.0.2.2"))
        assertTrue(text.startsWith("nameserver 192.168.1.1\n"))
        assertTrue(text.endsWith("nameserver 10.0.2.2\n"))
    }
}
