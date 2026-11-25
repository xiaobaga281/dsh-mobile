package ai.deepseek.harness.mobile.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 危险操作判定的边界：拦「不可逆」，放「只读」。
 *
 * 回归的是实测撞到的误判：`find . -iname "README*" 2>/dev/null` 被当成
 * 「覆盖写文件」拦下，子代理连 README 都读不了（本地模型真链路复现）。
 */
class DangerGuardTest {

    private fun bash(cmd: String) = DangerGuard.reason("bash", JSONObject().put("command", cmd))

    @Test
    fun readOnlyWithDiscardedOutputIsAllowed() {
        assertEquals("", bash("""find . -iname "README*" -maxdepth 4 2>/dev/null"""))
        assertEquals("", bash("ls -1 > /dev/null"))
        assertEquals("", bash("grep -rn TODO src 2>/dev/null | head -20"))
        assertEquals("", bash("du -sh . 2 >/dev/null"))
    }

    @Test
    fun realDestructiveCommandsStillAsk() {
        assertTrue(bash("rm -rf build").contains("可能破坏数据"))
        assertTrue(bash("echo hi > notes/x.md").contains("可能破坏数据"))   // 真·覆盖写
        assertTrue(bash("find . -name '*.tmp' -delete").contains("可能破坏数据"))
        assertTrue(bash("git push origin main").contains("可能破坏数据"))
        assertTrue(bash("mv a b").contains("可能破坏数据"))
    }

    @Test
    fun otherToolsKeepTheirRules() {
        assertTrue(DangerGuard.reason("delete_path", JSONObject().put("path", "notes"))
            .startsWith("删除 notes"))
        assertEquals("", DangerGuard.reason("http_request", JSONObject().put("method", "GET")))
        assertTrue(DangerGuard.reason("http_request", JSONObject().put("method", "POST"))
            .contains("POST"))
    }
}
