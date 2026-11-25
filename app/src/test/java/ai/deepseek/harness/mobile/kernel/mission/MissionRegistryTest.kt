package ai.deepseek.harness.mobile.kernel.mission

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Mission Ledger v1 的 JVM 验收：
 *  - jobs/schedules 进入同一份账本，状态/来源/证据/唤醒策略字段齐全；
 *  - 进程重启后未结算的 job 必须诚实标 interrupted；
 *  - 定时任务的 active/inactive、到点未触发、删除都能对齐；
 *  - 会话过滤与持久化不能串号/丢数据。
 */
class MissionRegistryTest {

    private var now = 10_000L

    private fun dir(): File = Files.createTempDirectory("mission-test").toFile()

    private fun registry(dir: File = dir()) =
        MissionRegistry(File(dir, "missions.json"), clock = { now })

    private fun scheduleView(
        id: String = "sch-1",
        sessionId: String = "sess-a",
        active: Boolean = true,
        at: Long = 20_000L,
        overdue: Boolean = false,
        lastDelivery: JSONObject? = null,
    ): JSONObject = JSONObject().apply {
        put("id", id)
        put("title", "每日巡检")
        put("sessionId", sessionId)
        put("state", if (active) "active" else "inactive")
        put("scheduledAt", at)
        put("overdue", overdue)
        put("rule", JSONObject().put("every_seconds", 3600))
        lastDelivery?.let { put("lastDelivery", it) }
    }

    @Test
    fun `job 开始与结束写进同一份账本`() {
        val r = registry()
        r.onJobStarted("j1", "构建报告", "sess-a", 1_000L)

        val running = r.list("sess-a").optJSONObject(0)!!
        assertEquals("job:j1", running.optString("id"))
        assertEquals("job", running.optString("kind"))
        assertEquals("sess-a", running.optString("sessionId"))
        assertEquals("running", running.optString("state"))
        assertEquals("idle-auto", running.optString("wakePolicy"))

        r.onJobSettled("j1", "构建报告", "sess-a", "done", 1_000L, 2_000L, 120L)
        val settled = r.get("job:j1")!!
        assertEquals("settled", settled.optString("state"))
        assertEquals("done", settled.optString("outcome"))
        assertEquals(1, settled.optInt("evidenceCount"))
        assertEquals(2_000L, settled.optLong("endedAt"))
    }

    @Test
    fun `被终止的 job 记为 cancelled`() {
        val r = registry()
        r.onJobStarted("j2", "构建", "sess-a", 1_000L)
        r.onJobSettled("j2", "构建", "sess-a", "killed", 1_000L, 2_000L, 0L)
        assertEquals("cancelled", r.get("job:j2")!!.optString("outcome"))
        assertEquals(0, r.get("job:j2")!!.optInt("evidenceCount"))
    }

    @Test
    fun `进程重启后未结算的 job 标 interrupted 而不是继续 running`() {
        val dir = dir()
        val first = MissionRegistry(File(dir, "missions.json"), clock = { now })
        first.onJobStarted("j3", "长编译", "sess-a", 1_000L)

        now = 50_000L
        val reopened = MissionRegistry(File(dir, "missions.json"), clock = { now })
        val m = reopened.get("job:j3")!!
        assertEquals("settled", m.optString("state"))
        assertEquals("interrupted", m.optString("outcome"))
        assertEquals(50_000L, m.optLong("updatedAt"))
    }

    @Test
    fun `定时任务 active 与 inactive 的状态对齐`() {
        val r = registry()
        r.onScheduleChanged(scheduleView(at = 40_000L))
        val waiting = r.get("schedule:sch-1")!!
        assertEquals("waiting", waiting.optString("state"))
        assertEquals(40_000L, waiting.optLong("nextAt"))
        assertEquals("每日巡检", waiting.optString("title"))
        assertEquals("idle-auto", waiting.optString("wakePolicy"))
        assertNotNull(waiting.optJSONObject("rule"))

        r.onScheduleChanged(scheduleView(active = false))
        val settled = r.get("schedule:sch-1")!!
        assertEquals("settled", settled.optString("state"))
        assertEquals("done", settled.optString("outcome"))
        assertNull(settled.opt("nextAt").takeUnless { it == JSONObject.NULL })
    }

    @Test
    fun `定时任务到点未触发也如实显示 overdue`() {
        val r = registry()
        now = 30_000L
        r.onScheduleChanged(scheduleView(at = 30_000L))
        val m = r.list("sess-a").optJSONObject(0)!!
        assertTrue(m.optBoolean("overdue"))
    }

    @Test
    fun `通知回执进入证据计数`() {
        val r = registry()
        val delivery = JSONObject().put("messageId", "sched-sch-1-20000").put("deliveredAt", 21_000L)
        r.onScheduleChanged(scheduleView(active = true, at = 40_000L, lastDelivery = delivery))
        val m = r.get("schedule:sch-1")!!
        assertEquals(1, m.optInt("evidenceCount"))
        assertEquals("schedule-delivery", m.optJSONArray("evidence")!!.optJSONObject(0)!!.optString("type"))
    }

    @Test
    fun `删除定时任务会移除对应 Mission`() {
        val r = registry()
        r.onScheduleChanged(scheduleView())
        assertNotNull(r.get("schedule:sch-1"))
        r.onScheduleRemoved("sch-1")
        assertNull(r.get("schedule:sch-1"))
    }

    @Test
    fun `按会话过滤且不串号`() {
        val r = registry()
        r.onJobStarted("j4", "构建", "sess-a", 1_000L)
        r.onScheduleChanged(scheduleView(id = "sch-2", sessionId = "sess-b"))

        assertEquals(1, r.list("sess-a").length())
        assertEquals("job:j4", r.list("sess-a").optJSONObject(0)!!.optString("id"))
        assertEquals(1, r.list("sess-b").length())
        assertEquals("schedule:sch-2", r.list("sess-b").optJSONObject(0)!!.optString("id"))
        assertEquals(2, r.list("").length())
    }

    @Test
    fun `Mission 持久化后重启仍可读`() {
        val dir = dir()
        val first = MissionRegistry(File(dir, "missions.json"), clock = { now })
        first.onScheduleChanged(scheduleView(at = 40_000L))
        first.onJobStarted("j5", "构建", "sess-a", 1_000L)
        first.onJobSettled("j5", "构建", "sess-a", "done", 1_000L, 2_000L, 10L)

        val reopened = MissionRegistry(File(dir, "missions.json"), clock = { now })
        assertEquals(2, reopened.list("sess-a").length())
        assertEquals("done", reopened.get("job:j5")!!.optString("outcome"))
        assertEquals("waiting", reopened.get("schedule:sch-1")!!.optString("state"))
    }

    @Test
    fun `团队任务进同一账本并按状态迁移`() {
        val r = registry()
        r.onTeamTask("t1", "lead-sess", "写导入脚本", "pending", "", ready = true, createdAt = 1_000L, updatedAt = 1_000L)
        val queued = r.get("team:t1")!!
        assertEquals("team", queued.optString("kind"))
        assertEquals("lead-sess", queued.optString("sessionId"))
        assertEquals("queued", queued.optString("state"))
        assertEquals("queue", queued.optString("wakePolicy"))
        assertEquals("team", queued.optJSONObject("origin")!!.optString("type"))

        r.onTeamTask("t1", "lead-sess", "写导入脚本", "pending", "", ready = false, createdAt = 1_000L, updatedAt = 2_000L)
        assertEquals("被依赖挡住就该是 waiting", "waiting", r.get("team:t1")!!.optString("state"))

        r.onTeamTask("t1", "lead-sess", "写导入脚本", "in_progress", "小林", createdAt = 1_000L, updatedAt = 3_000L)
        val running = r.get("team:t1")!!
        assertEquals("running", running.optString("state"))
        assertEquals("小林", running.optJSONObject("origin")!!.optString("member"))

        r.onTeamTask(
            "t1", "lead-sess", "写导入脚本", "completed", "小林",
            createdAt = 1_000L, updatedAt = 4_000L, completedAt = 4_000L,
        )
        val done = r.get("team:t1")!!
        assertEquals("settled", done.optString("state"))
        assertEquals("done", done.optString("outcome"))
        assertEquals(4_000L, done.optLong("endedAt"))
        // 归属会话过滤：Lead 会话看得到，别人的会话看不到
        assertEquals(1, r.list("lead-sess").length())
        assertEquals(0, r.list("other-sess").length())
    }

    @Test
    fun `团队任务删除后账本移除，缺会话不记账`() {
        val r = registry()
        r.onTeamTask("t2", "lead-sess", "任务", "pending", "", createdAt = 1L, updatedAt = 1L)
        assertNotNull(r.get("team:t2"))
        r.onTeamTask("t2", "lead-sess", "任务", "deleted", "", createdAt = 1L, updatedAt = 2L)
        assertNull("deleted 等价于从任务板上撤下", r.get("team:t2"))
        r.onTeamTask("t3", "", "没有归属会话", "pending", "", createdAt = 1L, updatedAt = 1L)
        assertNull(r.get("team:t3"))
    }

    @Test
    fun `未知 mission id 的 get 返回空`() {
        val r = registry()
        assertNull(r.get("job:missing"))
        assertFalse(r.remove("job:missing"))
    }

    @Test
    fun `job 的来路与参数留在 origin 里，结算也不丢`() {
        val r = registry()
        val spec = JSONObject().put("tool", "bash").put("command", "make release").put("workdir", "app")
        r.onJobStarted("jc", "构建", "sess-a", 1_000L, spec)
        val running = r.get("job:jc")!!
        assertEquals("tool", running.optJSONObject("origin")!!.optString("type"))
        assertEquals("make release", running.optJSONObject("origin")!!.optString("command"))
        assertEquals("app", running.optJSONObject("origin")!!.optString("workdir"))

        r.onJobSettled("jc", "构建", "sess-a", "done", 1_000L, 2_000L, 5L)
        assertEquals(
            "结算把命令洗掉就没法重跑了",
            "make release", r.get("job:jc")!!.optJSONObject("origin")!!.optString("command"),
        )
    }

    @Test
    fun `没有参数的 job 只记来路不编命令`() {
        val r = registry()
        r.onJobStarted("jd", "内部任务", "sess-a", 1_000L)
        val origin = r.get("job:jd")!!.optJSONObject("origin")!!
        assertEquals("tool", origin.optString("type"))
        assertFalse("不该凭空长出 command", origin.has("command"))
    }

    /* ---------------- Step 3：追加式证据与权限范围 ---------------- */

    @Test
    fun `结算不覆盖跑动期间攒下的证据`() {
        val r = registry()
        r.onJobStarted("j6", "构建", "sess-a", 1_000L)
        assertTrue(
            r.appendEvidence(
                "job:j6",
                JSONObject().put("type", "approval").put("ref", "ap-1").put("title", "允许 bash").put("at", 1_500L),
            )
        )
        r.onJobSettled("j6", "构建", "sess-a", "done", 1_000L, 2_000L, 10L)
        val ev = r.get("job:j6")!!.optJSONArray("evidence")!!
        assertEquals(2, r.get("job:j6")!!.optInt("evidenceCount"))
        assertEquals("approval", ev.optJSONObject(0)!!.optString("type"))
        assertEquals("job-output", ev.optJSONObject(1)!!.optString("type"))
    }

    @Test
    fun `同类型同引用的证据不重复累积`() {
        val r = registry()
        r.onJobStarted("j7", "构建", "sess-a", 1_000L)
        val entry = JSONObject().put("type", "wake").put("ref", "w1").put("at", 1_200L)
        assertTrue(r.appendEvidence("job:j7", entry))
        assertFalse(r.appendEvidence("job:j7", JSONObject(entry.toString())))
        assertEquals(1, r.get("job:j7")!!.optJSONArray("evidence")!!.length())
        assertFalse(r.appendEvidence("job:none", entry))
    }

    @Test
    fun `证据超过上限时丢最旧的`() {
        val r = registry()
        r.onJobStarted("j8", "构建", "sess-a", 1_000L)
        for (i in 1..(MissionRegistry.MAX_EVIDENCE + 4)) {
            r.appendEvidence(
                "job:j8", JSONObject().put("type", "tool").put("ref", "c$i").put("at", 1_000L + i),
            )
        }
        val ev = r.get("job:j8")!!.optJSONArray("evidence")!!
        assertEquals(MissionRegistry.MAX_EVIDENCE, ev.length())
        assertEquals("c5", ev.optJSONObject(0)!!.optString("ref"))
        assertEquals("追加证据不该顶掉状态更新时间", 1_000L, r.get("job:j8")!!.optLong("updatedAt"))
    }

    @Test
    fun `权限范围默认跟随会话且能收窄`() {
        val r = registry()
        r.onJobStarted("j9", "构建", "sess-a", 1_000L)
        assertEquals("inherit", r.scopeOf("job:j9").optString("mode"))

        val ask = r.setPermission("job:j9", "ask")!!
        assertEquals("ask", ask.optJSONObject("permissionScope")!!.optString("mode"))
        assertNull(r.setPermission("job:j9", "everything"))
        assertNull(r.setPermission("job:ghost", "readonly"))
    }

    /**
     * 委派链路（团队成员 / 子代理）用的合档入口。
     * 主对话那份在 AgentDriver 里读得到设置页热更新，派出去的人只有配置里带过来的 missionId ——
     * 少了这一步，「Mission 只读」挡得住 Lead，挡不住 Lead 派出去写盘的人。
     */
    @Test
    fun `委派链路权限档合 Mission 收窄`() {
        val r = registry()
        r.onJobStarted("j7", "构建", "sess-a", 1_000L)
        assertEquals("默认跟随会话", "full", r.effectivePermissionFor("full", "job:j7"))

        r.setPermission("job:j7", "readonly")
        assertEquals("收窄对队友同样生效", "readonly", r.effectivePermissionFor("full", "job:j7"))
        assertEquals("Mission 想放宽顶不过会话档", "readonly", r.effectivePermissionFor("readonly", "job:j7"))
        assertEquals("没有 Mission 就等于没合档", "ask", r.effectivePermissionFor("ask", ""))
        assertEquals("查不到的 Mission 沿用会话档", "full", r.effectivePermissionFor("full", "job:ghost"))
    }

    @Test
    fun `定时任务推进不会丢 Mission 权限范围`() {
        val r = registry()
        r.onScheduleChanged(scheduleView(at = 40_000L))
        r.setPermission("schedule:sch-1", "readonly")
        r.onScheduleChanged(scheduleView(at = 44_000L))
        assertEquals("readonly", r.get("schedule:sch-1")!!.optJSONObject("permissionScope")!!.optString("mode"))
    }

    @Test
    fun `Mission 级授权同名工具只记一次`() {
        val r = registry()
        r.onJobStarted("ja", "构建", "sess-a", 1_000L)
        assertTrue(r.addGrant("job:ja", "delete_path"))
        assertFalse(r.addGrant("job:ja", "delete_path"))
        assertFalse(r.addGrant("job:ja", ""))
        assertTrue(r.hasGrant("job:ja", "delete_path"))
        assertFalse(r.hasGrant("job:ja", "bash"))
        assertFalse(r.hasGrant("job:ghost", "bash"))
    }

    @Test
    fun `合档只收窄不放宽`() {
        // Mission 想比会话更宽 → 无效，仍按会话档
        assertEquals("readonly", MissionRegistry.effectivePermission("readonly", "full"))
        // Mission 想比会话更严 → 用更严的那一档
        assertEquals("readonly", MissionRegistry.effectivePermission("ask", "readonly"))
        assertEquals("ask", MissionRegistry.effectivePermission("full", "ask"))
        // inherit / 非法值等于没有 Mission
        assertEquals("ask", MissionRegistry.effectivePermission("ask", "inherit"))
        assertEquals("ask", MissionRegistry.effectivePermission("ask", ""))
        // 界面档位叫 default（内核旧名 ask）：两个都必须认，否则收窄被静默忽略
        assertEquals("readonly", MissionRegistry.effectivePermission("default", "readonly"))
        assertEquals("default", MissionRegistry.effectivePermission("default", "full"))
    }

    @Test
    fun `权限与证据持久化后重启仍在`() {
        val dir = dir()
        val first = MissionRegistry(File(dir, "missions.json"), clock = { now })
        first.onJobStarted("jb", "构建", "sess-a", 1_000L)
        first.setPermission("job:jb", "readonly")
        first.appendEvidence("job:jb", JSONObject().put("type", "approval").put("ref", "ap-9").put("at", 1_400L))

        val reopened = MissionRegistry(File(dir, "missions.json"), clock = { now })
        assertEquals("readonly", reopened.scopeOf("job:jb").optString("mode"))
        assertEquals(1, reopened.get("job:jb")!!.optJSONArray("evidence")!!.length())
    }

    @Test
    fun `删会话只带走那一场的记录`() {
        val r = registry()
        r.onJobStarted("jb-a", "甲的任务", "sess-a", 1_000L)
        r.onJobStarted("jb-b", "乙的任务", "sess-b", 1_200L)

        assertEquals(1, r.dropSession("sess-a"))
        assertNull("那一场留下的任务还在账本上", r.get("job:jb-a"))
        assertNotNull("别场会话的记录不许被牵连", r.get("job:jb-b"))
        assertEquals("空 id 不许当成「全清」", 0, r.dropSession(""))
    }

    @Test
    fun `清扫只认页面递进来的活会话`() {
        val r = registry()
        r.onJobStarted("jb-a", "甲的任务", "sess-a", 1_000L)
        r.onJobStarted("jb-x", "孤儿任务", "sess-gone", 1_100L)
        r.onJobStarted("jb-n", "没归属", "", 1_200L)
        val orphans = r.orphanSessionIds(setOf("sess-a", "sess-x"))
        assertEquals(listOf("sess-gone"), orphans)
        assertEquals(1, r.dropSession("sess-gone"))
        assertNotNull("没写会话 id 的记录不由清扫负责", r.get("job:jb-n"))
    }
}
