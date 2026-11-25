package ai.deepseek.harness.mobile.kernel.mission

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 统一唤醒队列的 JVM 验收：
 *  - job 完成 / 定时到点都进同一队列，按 mission + transition 去重；
 *  - 定时 delivered=true 用 nudge（提醒已在会话日志里），false 用 prompt；
 *  - 前端消费与 agent pre-step 互斥，谁先认领谁负责；defer 不自动注入；
 *  - 进程重启后未消费的唤醒仍在。
 */
class WakeRouterTest {

    private var now = 10_000L

    private fun dir(): File = Files.createTempDirectory("wake-test").toFile()

    private fun router(dir: File = dir()) = WakeRouter(File(dir, "wakes.json"), clock = { now })

    @Test
    fun `job 唤醒入队并按 mission 去重`() {
        val r = router()
        val a = r.enqueueJob("j1", "构建报告", "sess-a", "后台任务已完成")
        assertNotNull(a)
        assertEquals("idle-auto", a!!.optString("policy"))
        assertNull("同一 job 未消费前不能重复入队", r.enqueueJob("j1", "构建报告", "sess-a", "后台任务已完成"))
        assertEquals(1, r.pending("sess-a").length())
        assertEquals(1, r.consume(listOf(a.optString("id"))))
        assertEquals(0, r.pending("sess-a").length())
        assertEquals(0, r.consume(listOf(a.optString("id"))))
    }

    @Test
    fun `定时 delivered 用 nudge 非 delivered 用 prompt`() {
        val r = router()
        val d = r.enqueueSchedule("sch-1", "每日巡检", "sess-a", "检查构建结果", delivered = true, scheduledAt = 20_000L)
        assertNotNull(d)
        assertTrue(d!!.optString("text").contains("请根据上一条提醒"))
        assertEquals("检查构建结果", d.optString("display"))
        assertEquals("schedule:sch-1", d.optString("missionId"))

        val p = r.enqueueSchedule("sch-2", "提醒", "sess-a", "喝水", delivered = false, scheduledAt = 21_000L)
        assertNotNull(p)
        assertEquals("喝水", p!!.optString("text"))
        assertEquals(2, r.pending("sess-a").length())
    }

    @Test
    fun `按会话过滤且不串号`() {
        val r = router()
        r.enqueueJob("j1", "A", "sess-a", "a done")
        r.enqueueSchedule("sch-1", "B", "sess-b", "b", delivered = true, scheduledAt = 30_000L)
        assertEquals(1, r.pending("sess-a").length())
        assertEquals(1, r.pending("sess-b").length())
        assertEquals(2, r.pending("").length())
    }

    @Test
    fun `agent pre-step 认领并跳过 defer`() {
        val r = router()
        r.enqueueJob("j1", "A", "sess-a", "a done")
        val defer = r.enqueueJob("j2", "B", "sess-a", "b done", policy = MissionRegistry.WAKE_DEFER)
        assertNotNull(defer)

        val texts = r.drainForAgent("sess-a").map { it.optString("text") }
        assertEquals(listOf("a done"), texts)
        val left = r.pending("sess-a")
        assertEquals(1, left.length())
        assertEquals(defer!!.optString("id"), left.optJSONObject(0)!!.optString("id"))
    }

    @Test
    fun `重启后未消费的唤醒仍在`() {
        val dir = dir()
        val first = WakeRouter(File(dir, "wakes.json"), clock = { now })
        first.enqueueJob("j1", "构建", "sess-a", "完成")
        first.enqueueSchedule("sch-1", "巡检", "sess-a", "检查", true, 20_000L)

        val reopened = WakeRouter(File(dir, "wakes.json"), clock = { now })
        assertEquals(2, reopened.pending("sess-a").length())
        val texts = reopened.drainForAgent("sess-a")
        assertEquals(2, texts.size)
    }

    @Test
    fun `已消费的唤醒不会被重新投递`() {
        val dir = dir()
        val r = WakeRouter(File(dir, "wakes.json"), clock = { now })
        val rec = r.enqueueJob("j1", "构建", "sess-a", "完成")!!
        r.consume(listOf(rec.optString("id")))

        val reopened = WakeRouter(File(dir, "wakes.json"), clock = { now })
        assertEquals(0, reopened.pending("sess-a").length())
    }

    @Test
    fun `缺 session 或缺正文不产生唤醒`() {
        val r = router()
        assertNull(r.enqueueJob("j1", "A", "", "done"))
        assertNull(r.enqueueJob("j2", "A", "sess-a", ""))
        assertNull(r.enqueueSchedule("", "A", "sess-a", "p", true, 1L))
    }

    @Test
    fun `团队任务完成提醒 Lead 且按 revision 去重`() {
        val r = router()
        val w = r.enqueueTeam("t1", "写导入脚本", "lead-sess", "任务已完成", revision = 3)
        assertNotNull(w)
        assertEquals("queue", w!!.optString("policy"))
        assertEquals("team:t1", w.optString("missionId"))
        assertNull("同一次完成不重复提醒", r.enqueueTeam("t1", "写导入脚本", "lead-sess", "任务已完成", revision = 3))
        assertNotNull("reopen 后再次完成要能再提醒", r.enqueueTeam("t1", "写导入脚本", "lead-sess", "又完成了", revision = 4))
        assertEquals(2, r.pending("lead-sess").length())
    }

    @Test
    fun `补的那一轮失败时唤醒退回队列`() {
        val r = router()
        val w = r.enqueueJob("j9", "构建", "sess-a", "后台任务已完成")!!
        val id = w.optString("id")
        assertEquals(1, r.consume(listOf(id)))
        assertEquals(0, r.pending("sess-a").length())

        val back = r.requeue(id, "端点不可达")
        assertNotNull(back)
        assertEquals(1, r.pending("sess-a").length())
        assertEquals(1, back!!.optInt("attempts"))
        assertTrue(back.optString("failReason").contains("端点不可达"))
        // 回滚后仍能再被认领，且不会因此多出第二条记录
        assertEquals(1, r.consume(listOf(id)))
        r.requeue(id, "又失败")
        assertEquals("队列里仍只有一条", 1, r.pending("sess-a").length())
        assertEquals(2, r.pending("sess-a").optJSONObject(0)!!.optInt("attempts"))
    }

    @Test
    fun `重投有上限，端点一直坏时不会无限循环`() {
        val r = router()
        val w = r.enqueueJob("j10", "构建", "sess-a", "done")!!
        val id = w.optString("id")
        for (i in 1..WakeRouter.MAX_ATTEMPTS) {
            r.consume(listOf(id))
            assertNotNull("第 $i 次回滚应当允许", r.requeue(id, "失败$i"))
        }
        r.consume(listOf(id))
        assertNull("超过上限就不再重投", r.requeue(id, "还是失败"))
        assertEquals(0, r.pending("sess-a").length())
    }

    @Test
    fun `未消费的记录回滚是幂等的`() {
        val r = router()
        val w = r.enqueueJob("j11", "构建", "sess-a", "done")!!
        val id = w.optString("id")
        val again = r.requeue(id, "没消费也回滚")
        assertNotNull(again)
        assertEquals(0, again!!.optInt("attempts"))
        assertEquals(1, r.pending("sess-a").length())
        assertNull(r.requeue("no-such-id", "x"))
    }

    @Test
    fun `回滚后的唤醒跨进程仍在队列里`() {
        val dir = dir()
        val r = router(dir)
        val id = r.enqueueJob("j12", "构建", "sess-a", "done")!!.optString("id")
        r.consume(listOf(id))
        r.requeue(id, "网络断开")

        val reopened = WakeRouter(File(dir, "wakes.json"), clock = { now })
        assertEquals(1, reopened.pending("sess-a").length())
        assertEquals(1, reopened.pending("sess-a").optJSONObject(0)!!.optInt("attempts"))
    }

    @Test
    fun `删会话带走指向它的唤醒包括已消费的存根`() {
        val r = router()
        val a = r.enqueueJob("j1", "构建报告", "sess-a", "后台任务已完成")!!
        val b = r.enqueueJob("j2", "另一场的报告", "sess-b", "后台任务已完成")!!
        r.consume(listOf(a.optString("id")))          // 已消费也留在队列里（有上限的存根）

        assertEquals("没消费过的也算上，一场共 1 条", 1, r.dropSession("sess-a"))
        assertEquals(0, r.pending("sess-a").length())
        assertEquals(1, r.pending("sess-b").length())
        assertEquals("空 id 不许当成「全清」", 0, r.dropSession(""))
        assertNotNull("别场会话的唤醒不许被牵连", r.get(b.optString("id")))
    }

    @Test
    fun `唤醒队列里的孤儿只报会话 id`() {
        val r = router()
        r.enqueueJob("j1", "甲", "sess-a", "完成")
        r.enqueueJob("j2", "乙", "sess-gone", "完成")
        r.enqueueJob("j3", "丙", "sess-gone", "完成")
        assertEquals(listOf("sess-gone"), r.orphanSessionIds(setOf("sess-a")))
        assertEquals(2, r.dropSession("sess-gone"))
        assertEquals(0, r.pending("sess-gone").length())
    }
}
