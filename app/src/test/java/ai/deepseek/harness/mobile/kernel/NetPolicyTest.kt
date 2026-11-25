package ai.deepseek.harness.mobile.kernel

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 明文策略：局域网 http 是本地模型的刚需，公网 http 必须拒绝（API Key 不能明文出网）。
 */
class NetPolicyTest {

    @Test
    fun `lan and loopback http are allowed`() {
        for (url in listOf(
            "http://localhost:8090/v1",
            "http://127.0.0.1:8080/v1",
            "http://10.0.2.2:11434/v1",
            "http://192.168.0.99:8090/v1",
            "http://172.16.3.4:8000/v1",
            "http://172.31.255.1/v1",
            "http://my-pc:8080/v1",
            "http://llama.local/v1",
            "http://100.64.0.8/v1",
            "https://api.example.com/v1",
        )) {
            NetPolicy.requireAllowed(url)
            assertTrue(url, NetPolicy.isPrivateHttp(url) || url.startsWith("https://"))
        }
    }

    @Test
    fun `public http is rejected`() {
        for (host in listOf("8.8.8.8", "api.example.com", "172.32.0.1", "203.0.113.9")) {
            assertFalse(host, NetPolicy.isPrivateHost(host))
            assertThrows(KernelError::class.java) {
                NetPolicy.requireAllowed("http://$host/v1")
            }
        }
    }

    @Test
    fun `non http schemes are rejected`() {
        assertThrows(KernelError::class.java) { NetPolicy.requireAllowed("file:///etc/passwd") }
        assertThrows(KernelError::class.java) { NetPolicy.requireAllowed("ftp://192.168.1.2/x") }
    }
}
