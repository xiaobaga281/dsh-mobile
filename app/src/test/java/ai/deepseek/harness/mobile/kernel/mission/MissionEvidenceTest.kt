package ai.deepseek.harness.mobile.kernel.mission

import ai.deepseek.harness.mobile.agent.SessionStore
import ai.deepseek.harness.mobile.kernel.jobs.JobRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Step 3 的证据组装：账本只存引用，正文按引用回会话日志 / job 输出环 / 唤醒队列现取。
 *
 * 这里守的是「不可见的自主等于 bug」那一半 —— 用户回看一件事时，
 * 每条证据要么给出真实正文，要么如实说取不到，不许编一段看着像的摘要。
 */
class MissionEvidenceTest {

    private fun dir(): File = Files.createTempDirectory("mission-evidence").toFile()

    private class Harness(dir: File) {
        val missions = MissionRegistry(File(dir, "missions.json"))
        val sessions = SessionStore(File(dir, "sessions"))
        val jobs = JobRegistry()
        val wakes = WakeRouter(File(dir, "wakes.json"))
        fun evidence() = MissionEvidence(missions, sessions, jobs, wakes)
    }

    /** 起一个真后台任务并等它结算，同时按 ToolKernel 的接线把账本对齐；返回 job id。 */
    private fun settleJob(h: Harness, name: String, output: String): String {
        val job = h.jobs.start(name, "s1") { j -> j.append(output); 0 }
        h.jobs.await(job.id, 3_000)
        h.missions.onJobStarted(job.id, name, "s1", job.startedAt)
        h.missions.onJobSettled(
            job.id, name, "s1", job.status, job.startedAt, job.endedAt, output.length.toLong(),
        )
        return job.id
    }

    private fun firstLabel(view: org.json.JSONArray, type: String): String {
        for (i in 0 until view.length()) {
            val e = view.optJSONObject(i) ?: continue
            if (e.optString("type") == type) return e.optString("kindLabel")
        }
        return ""
    }

    private fun firstText(view: org.json.JSONArray, type: String): String {
        for (i in 0 until view.length()) {
            val e = view.optJSONObject(i) ?: continue
            if (e.optString("type") == type) return e.optString("text")
        }
        return ""
    }

    @Test
    fun `活体任务的输出正文能取到`() {
        val h = Harness(dir())
        val jobId = settleJob(h, "构建", "job-finished\n")
        val view = h.evidence().view("job:$jobId")
        assertEquals(1, view.length())
        assertTrue(firstText(view, "job-output").contains("job-finished"))
        assertTrue(firstText(view, "job-output").contains("status=done"))
    }

    @Test
    fun `进程重启后回到会话日志的记账`() {
        val h = Harness(dir())
        val jobId = settleJob(h, "构建", "ok")
        // 新进程：输出环没了，只剩 job/registered + job/settled 两条记账
        h.sessions.append("s1", "job/registered", JSONObject().put("job_id", jobId).put("name", "构建"))
        h.sessions.append(
            "s1", "job/settled",
            JSONObject().put("job_id", jobId).put("status", "done").put("exit_code", 0).put("retained_chars", 2),
        )
        val cold = MissionEvidence(h.missions, h.sessions, JobRegistry(), h.wakes)
        val text = firstText(cold.view("job:$jobId"), "job-output")
        assertTrue(text.contains("已结束：status=done"))
    }

    @Test
    fun `投递证据回到会话里的提醒正文`() {
        val h = Harness(dir())
        h.missions.onScheduleChanged(
            JSONObject().put("id", "sch-9").put("title", "每日巡检").put("sessionId", "s1")
                .put("state", "active").put("scheduledAt", 0L)
                .put("lastDelivery", JSONObject().put("messageId", "sched-sch-9-1").put("deliveredAt", 1L)),
        )
        h.sessions.append(
            "s1", "user/message",
            JSONObject().put("messageId", "sched-sch-9-1").put("text", "[SCHEDULE REMINDER]\n该巡检了"),
        )
        val text = firstText(h.evidence().view("schedule:sch-9"), "schedule-delivery")
        assertTrue(text.contains("该巡检了"))
    }

    @Test
    fun `工具证据拼出调用与结果`() {
        val h = Harness(dir())
        h.missions.onJobStarted("j3", "构建", "s1", 1_000L)
        h.missions.appendEvidence("job:j3", JSONObject().put("type", "tool").put("ref", "c1").put("at", 2_000L))
        h.sessions.append("s1", "tool/call", JSONObject().put("id", "c1").put("name", "write").put("args", "{\"path\":\"a.md\"}"))
        h.sessions.append("s1", "tool/result", JSONObject().put("id", "c1").put("ok", true).put("output", "写入 3 行"))
        val text = firstText(h.evidence().view("job:j3"), "tool")
        assertTrue(text.contains("write"))
        assertTrue(text.contains("写入 3 行"))
    }

    @Test
    fun `唤醒证据如实区分已补和待补`() {
        val h = Harness(dir())
        h.missions.onJobStarted("j4", "构建", "s1", 1_000L)
        val wake = h.wakes.enqueueJob("j4", "构建", "s1", "[后台任务完成] 构建")
        val ref = wake!!.optString("id")
        h.missions.appendEvidence("job:j4", JSONObject().put("type", "wake").put("ref", ref).put("at", 3_000L))

        var text = firstText(h.evidence().view("job:j4"), "wake")
        assertTrue("未消费的唤醒要说清还在排队：$text", text.contains("仍在队列"))

        h.wakes.consume(listOf(ref))
        text = firstText(h.evidence().view("job:j4"), "wake")
        assertTrue("消费后要说明续过一轮：$text", text.contains("续了一轮"))
    }

    @Test
    fun `重跑记录指向新任务并带它的状态`() {
        val h = Harness(dir())
        val oldId = settleJob(h, "构建", "first run")
        val newId = settleJob(h, "构建", "second run")
        h.missions.appendEvidence(
            "job:$oldId",
            JSONObject().put("type", "rerun").put("ref", newId).put("title", "重新跑了一次").put("at", 9_000L),
        )
        val text = firstText(h.evidence().view("job:$oldId"), "rerun")
        assertTrue("要指向新任务：$text", text.contains(newId))
        assertTrue("要能看出新任务跑得怎样：$text", text.contains("second run"))
        assertEquals("重新运行", firstLabel(view = h.evidence().view("job:$oldId"), type = "rerun"))
    }

    @Test
    fun `引用取不到正文时如实说取不到`() {
        val h = Harness(dir())
        h.missions.onJobStarted("j5", "构建", "s1", 1_000L)
        h.missions.appendEvidence("job:j5", JSONObject().put("type", "schedule-delivery").put("ref", "ghost").put("at", 1L))
        h.missions.appendEvidence("job:j5", JSONObject().put("type", "wake").put("ref", "also-ghost").put("at", 1L))
        val view = h.evidence().view("job:j5")
        assertTrue(firstText(view, "schedule-delivery").startsWith("取不到正文"))
        assertTrue(firstText(view, "wake").startsWith("取不到正文"))
    }

    @Test
    fun `未知 mission 的详情与证据都是空`() {
        val h = Harness(dir())
        assertEquals(0, h.evidence().view("job:ghost").length())
        assertTrue(h.evidence().detail("job:ghost").length() == 0)
        assertEquals("", h.evidence().markdown("job:ghost"))
    }

    @Test
    fun `导出正文包含状态权限与证据`() {
        val h = Harness(dir())
        val jobId = settleJob(h, "构建报告", "built ok")
        h.missions.setPermission("job:$jobId", "readonly")
        h.missions.appendEvidence(
            "job:$jobId",
            JSONObject().put("type", "approval").put("ref", "ap-1").put("title", "允许 bash").put("at", 4_000L),
        )
        val md = h.evidence().markdown("job:$jobId")
        assertTrue(md.contains("# Mission job:$jobId"))
        assertTrue(md.contains("权限范围：只读"))
        assertTrue(md.contains("## 时间线"))
        assertTrue(md.contains("## 证据"))
        assertTrue(md.contains("built ok"))
        assertFalse("同类标题不该重复两遍", md.contains("任务输出 · 任务输出"))
        assertFalse(md.contains("inherit"))
    }

    @Test
    fun `长正文按预算裁剪`() {
        val h = Harness(dir())
        val long = "x".repeat(1_200)
        val jobId = settleJob(h, "构建", long)
        val text = firstText(h.evidence().view("job:$jobId"), "job-output")
        assertTrue("裁剪后不该超过预算：${text.length}", text.length <= 460)
        assertTrue(text.startsWith("…"))
    }
}
