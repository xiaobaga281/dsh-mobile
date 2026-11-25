package ai.deepseek.harness.mobile.kernel.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 委派限制 —— 对齐桌面 `subagent` 的两个数。
 *
 * 这里只测纯逻辑：深度递推与容量池。真正的执行路径（子代理循环）在
 * [ai.deepseek.harness.mobile.agent.SubagentRunner]，它依赖内核，放到设备上验。
 */
class SubagentLimitsTest {

    /**
     * 桌面文案：0 = 禁用子智能体；1 = 仅允许主 Agent 创建；2 起允许嵌套一层。
     * 深度是从 0 数起的，所以第 1 层能不能再派，取决于 maxDepth 是否 > 1。
     */
    @Test
    fun depthSemanticsMatchDesktop() {
        val off = SubagentLimits(maxDepth = 0)
        assertFalse("0 = 谁都不能派", off.canDelegate(0))

        val mainOnly = SubagentLimits(maxDepth = 1)
        assertTrue("主 Agent（第 0 层）可以派", mainOnly.canDelegate(0))
        assertFalse("第 1 层不能再派", mainOnly.canDelegate(1))

        val nested = SubagentLimits(maxDepth = 3)
        assertTrue(nested.canDelegate(0))
        assertTrue(nested.canDelegate(1))
        assertTrue(nested.canDelegate(2))
        assertFalse("第 3 层到顶", nested.canDelegate(3))
    }

    @Test
    fun limitsAreClamped() {
        assertEquals(SubagentLimits(6, 16), SubagentLimits(99, 99).normalized())
        assertEquals(SubagentLimits(0, 1), SubagentLimits(-3, 0).normalized())
    }

    /** 容量满了必须拒绝（桌面：New start requests are rejected），不能悄悄排队 */
    @Test
    fun capacityRejectsAtTheLimitAndFreesOnRelease() {
        val root = "cap-test-${System.nanoTime()}"
        assertEquals(0, SubagentCapacity.count(root))
        assertTrue(SubagentCapacity.tryAcquire(root, 2))
        assertTrue(SubagentCapacity.tryAcquire(root, 2))
        assertFalse("满了就该拒绝", SubagentCapacity.tryAcquire(root, 2))
        assertEquals(2, SubagentCapacity.count(root))

        SubagentCapacity.release(root)
        assertEquals(1, SubagentCapacity.count(root))
        assertTrue("释放后可以再进一个", SubagentCapacity.tryAcquire(root, 2))

        SubagentCapacity.release(root)
        SubagentCapacity.release(root)
        assertEquals("归零后不留桶", 0, SubagentCapacity.count(root))
    }

    /** 不同主 Agent 的容量互不影响（桌面按「同一个主 Agent」计数） */
    @Test
    fun capacityIsPerRoot() {
        val a = "root-a-${System.nanoTime()}"
        val b = "root-b-${System.nanoTime()}"
        assertTrue(SubagentCapacity.tryAcquire(a, 1))
        assertFalse(SubagentCapacity.tryAcquire(a, 1))
        assertTrue("另一个主 Agent 不受影响", SubagentCapacity.tryAcquire(b, 1))
        SubagentCapacity.release(a)
        SubagentCapacity.release(b)
    }
}
