package ai.deepseek.harness.mobile.kernel.jobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

/**
 * 后台任务结算语义（Step 2 起由 WakeRouter 接管唤醒）：
 *   · 正常结算：completionNotice 非空，交给 ToolKernel 入统一唤醒队列；
 *   · 有活体 wait 等到了：不再产生 completionNotice；
 *   · wait 超时但任务仍在跑：之后结算照常产生通知；
 *   · 模型自己 job_kill / 无主任务：不产生完成通知。
 * 旧的 JobRegistry notices 队列只保留兼容，不再写入；持久化/去重/认领由 WakeRouterTest 覆盖。
 */
class JobCompletionTest {

    private fun waitDone(job: JobRegistry.Job, timeoutMs: Long = 3_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (job.status == "running" && System.currentTimeMillis() < deadline) Thread.sleep(5)
        assertFalse("任务没有在超时内结算", job.status == "running")
        Thread.sleep(40)
    }

    @Test
    fun `spec 随任务留下，供账本记住「怎么来的」`() {
        val reg = JobRegistry()
        val spec = org.json.JSONObject().put("tool", "bash").put("command", "make release").put("workdir", "app")
        val job = reg.start("构建", "s1", spec) { 0 }
        waitDone(job)
        assertEquals("make release", job.spec?.optString("command"))
        assertEquals("app", job.spec?.optString("workdir"))
        // 不传 spec 的旧调用点（内部任务）保持为空，界面上就不会给重跑按钮
        val plain = reg.start("内部", "s1") { 0 }
        waitDone(plain)
        assertEquals(null, plain.spec)
    }

    @Test
    fun `正常结算产生完成正文（唤醒正文只此一份）`() {
        val reg = JobRegistry()
        val job = reg.start("echo", "s1") { 0 }
        waitDone(job)
        assertTrue("完成正文应包含 job id", job.completionNotice.contains(job.id))
    }

    @Test
    fun `活体等待收走结果后不产生完成通知`() {
        val reg = JobRegistry()
        val release = CountDownLatch(1)
        val job = reg.start("slow", "s1") { release.await(); 0 }
        val waiter = thread { reg.await(job.id, 5_000) }
        Thread.sleep(80)
        release.countDown()
        waiter.join(3_000)
        assertTrue("等待中的结算应标记 awaited", job.awaited)
        assertEquals("", job.completionNotice)
    }

    @Test
    fun `等待超时后任务仍会通知`() {
        val reg = JobRegistry()
        val release = CountDownLatch(1)
        val job = reg.start("slow", "s1") { release.await(); 0 }
        val result = reg.await(job.id, 80)
        assertTrue(result != null && result.status == "running")
        assertFalse("超时的 wait 不能吞掉后续完成通知", job.awaited)
        release.countDown()
        waitDone(job)
        assertTrue(job.completionNotice.isNotBlank())
    }

    @Test
    fun `模型自己 kill 的任务不再回完成通知`() {
        val reg = JobRegistry()
        val release = CountDownLatch(1)
        val job = reg.start("slow", "s1") { release.await(); 0 }
        assertTrue(reg.kill(job.id, byModel = true))
        release.countDown()
        waitDone(job)
        assertTrue(job.killRequested)
        assertEquals("", job.completionNotice)
    }

    @Test
    fun `无主任务不产生通知`() {
        val reg = JobRegistry()
        val job = reg.start("echo", "") { 0 }
        waitDone(job)
        assertEquals("", job.completionNotice)
    }
}
