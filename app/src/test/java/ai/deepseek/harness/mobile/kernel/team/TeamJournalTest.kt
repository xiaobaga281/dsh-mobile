package ai.deepseek.harness.mobile.kernel.team

import ai.deepseek.harness.mobile.agent.SessionStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 日志层的提交语义测试 —— 桌面 `appendAndFlush` 的手机端等价物。
 *
 * 这里测的不是「能不能写」，而是「**写失败时会不会撒谎**」：
 *   · 状态类事件写不进去 → 必须抛 TEAM_JOURNAL_FAILED，不能回 ok
 *   · 进度类事件写不进去 → 只丢这一条，不能把正在跑的成员掐死
 *   · 队友给 Lead 的消息要能回放出来，直到被认领
 *   · provisioning 对账的判据（成员会话里有没有首条任务）必须可读
 */
class TeamJournalTest {

    private fun tmp(): File =
        File(System.getProperty("java.io.tmpdir"), "dsh-team-journal/${System.nanoTime()}").apply { mkdirs() }

    /** 一个必然写失败的存储：把「目录」位置放成一个普通文件 */
    private fun brokenStore(): SessionStore {
        val f = File(System.getProperty("java.io.tmpdir"), "dsh-broken-store-${System.nanoTime()}")
        f.writeText("not a dir")
        return SessionStore(f)
    }

    private fun member(name: String = "reviewer") = TeamMember(
        name = name,
        role = MemberRole.TEAMMATE,
        description = "审改动",
        context = "fresh",
        model = "m",
        provider = "in-process",
        sessionId = "s1#$name",
    )

    @Test
    fun strictWriteFailureIsReported() {
        val journal = TeamJournal(brokenStore())
        val e = assertThrows(TeamError::class.java) { journal.member("s1", member()) }
        assertEquals("TEAM_JOURNAL_FAILED", e.code)
        assertTrue("错误要说清是什么没写进去", e.message!!.contains("成员 reviewer"))
    }

    @Test
    fun progressWriteFailureDoesNotKillTheMember() {
        // 每轮的 turns/tokens 快照是尽力而为：磁盘抖一下不该让整条执行链抛异常
        TeamJournal(brokenStore()).memberProgress("s1", member())
    }

    /**
     * 进度必须是小事件。
     *
     * 以前每步 append 一份**整份成员快照**（带 description / diagnostics / 时间戳 ≈ 500B），
     * 一场几十步就把 Lead 会话日志灌成几十份近似副本；打开团队面板要整份回放，代价实打实。
     * 桌面只在事务边界写 team/member。类型也必须分开：进度不是状态迁移，不能参与不变量校验。
     */
    @Test
    fun progressEventsAreSmallAndMergeOnReplay() {
        val store = SessionStore(tmp())
        val journal = TeamJournal(store)
        val m = member()
        journal.member("s1", m)
        m.turns = 7; m.toolCalls = 12; m.tokensIn = 900; m.tokensOut = 300; m.lastAction = "bash ls -1 /sdcard"
        journal.memberProgress("s1", m)
        m.turns = 9
        journal.memberProgress("s1", m)

        val progress = store.read("s1").filter { it.optString("type") == "team/progress" }
        assertEquals(2, progress.size)
        assertTrue("进度事件只该带那几个数，别把整份快照再写一遍：${progress[0]}", progress[0].length() < 160)
        assertFalse("不该带 diagnostics", progress[0].has("diagnostics"))
        assertFalse("不该带会话身份", progress[0].has("session"))

        val back = journal.replay("s1").members.getValue("reviewer")
        assertEquals(9, back.turns)
        assertEquals(12, back.toolCalls)
        assertEquals(900, back.tokensIn)
        assertEquals("bash ls -1 /sdcard", back.lastAction)
        assertEquals("进度不是状态迁移", MemberPhase.PROVISIONING, back.phase)
    }

    @Test
    fun progressBeforeMemberFailsTheReplay() {
        val journal = TeamJournal(SessionStore(tmp()))
        journal.memberProgress("s1", member("ghost"))
        assertNotNull(
            "没有成员记录就来进度 = 日志残缺或被手改，必须报出来，不能静默凭空造一个成员",
            journal.replay("s1").failure,
        )
    }

    @Test
    fun leadMessagesStayPendingUntilDelivered() {
        val journal = TeamJournal(SessionStore(tmp()))
        journal.leadMessage("s1", "m1", "reviewer", "审完了，发现两处并发问题")
        journal.leadMessage("s1", "m2", "writer", "周报已写到 docs/weekly.md")

        val first = journal.replay("s1")
        assertEquals(2, first.pendingMessages.size)

        journal.leadDelivered("s1", "m1")
        val second = journal.replay("s1")
        assertEquals(1, second.pendingMessages.size)
        assertEquals("m2", second.pendingMessages.single().optString("id"))
        assertEquals("writer", second.pendingMessages.single().optString("from"))
    }

    @Test
    fun memberHasPromptIsTheProvisioningJudge() {
        val journal = TeamJournal(SessionStore(tmp()))
        assertFalse("没写过任务 = 没建成", journal.memberHasPrompt("s1#reviewer"))
        journal.userTurn("s1#reviewer", "完整任务", from = "lead", strict = true)
        assertTrue("首条任务落盘 = 创建其实成功了", journal.memberHasPrompt("s1#reviewer"))
    }

    /* ---------------- 回放期不变量（对齐桌面 projection.ts） ---------------- */

    private fun memberEvent(name: String, status: String, session: String, rev: Int = 0) = JSONObject().apply {
        put("ts", 1L); put("type", "team/member")
        put("target", name); put("role", "teammate"); put("status", status)
        put("session", session); put("provider", "in-process"); put("context", "fresh")
        put("revision", rev)
    }

    private fun taskEvent(id: String, revision: Int) = JSONObject().apply {
        put("ts", 1L); put("type", "team/task")
        put("id", id); put("revision", revision); put("subject", "s")
        put("description", "d"); put("status", "pending")
        put("blockedBy", JSONArray()); put("writeScopes", JSONArray())
    }

    @Test
    fun memberMustStartInProvisioning() {
        val dir = tmp()
        val store = SessionStore(dir)
        // 直接写一条「已经 active」的首记录 —— 桌面投影会拒绝并冻结
        store.appendOrThrow("s1", "team/member", memberEvent("reviewer", "active", "s1#reviewer"))
        val replay = TeamJournal(store).replay("s1")
        assertNotNull("首记录不是 provisioning 应当被拒绝", replay.failure)
        assertTrue(replay.failure!!.contains("provisioning"))
    }

    @Test
    fun memberCannotChangeIdentityOrResurrect() {
        val dir = tmp()
        val store = SessionStore(dir)
        store.appendOrThrow("s1", "team/member", memberEvent("reviewer", "provisioning", "s1#reviewer"))
        store.appendOrThrow("s1", "team/member", memberEvent("reviewer", "active", "s1#reviewer"))
        // 换会话身份 = 违反不可变字段
        store.appendOrThrow("s1", "team/member", memberEvent("reviewer", "running", "s1#other"))
        val replay = TeamJournal(store).replay("s1")
        assertNotNull(replay.failure)
        assertTrue(replay.failure!!.contains("会话身份"))
    }

    @Test
    fun taskRevisionMustBeContiguous() {
        val dir = tmp()
        val store = SessionStore(dir)
        store.appendOrThrow("s1", "team/task", taskEvent("task-1", 1))
        store.appendOrThrow("s1", "team/task", taskEvent("task-1", 3))
        val replay = TeamJournal(store).replay("s1")
        assertNotNull("revision 跳号应当被拒绝", replay.failure)
        assertTrue(replay.failure!!.contains("revision"))
    }

    @Test
    fun healthyLogHasNoFailure() {
        val dir = tmp()
        val store = SessionStore(dir)
        store.appendOrThrow("s1", "team/member", memberEvent("reviewer", "provisioning", "s1#reviewer"))
        store.appendOrThrow("s1", "team/member", memberEvent("reviewer", "active", "s1#reviewer"))
        store.appendOrThrow("s1", "team/member", memberEvent("reviewer", "running", "s1#reviewer"))
        store.appendOrThrow("s1", "team/task", taskEvent("task-1", 1))
        store.appendOrThrow("s1", "team/task", taskEvent("task-1", 2))
        val replay = TeamJournal(store).replay("s1")
        assertNull(replay.failure)
        assertEquals(1, replay.members.size)
        assertEquals(2, replay.tasks["task-1"]!!.revision)
    }

    /* ---------------- rc.97：phase 与 status 分离 + 消息投递不变量 ---------------- */

    private fun memberEventPhase(name: String, phase: String, session: String, provider: String = "in-process", context: String = "fresh") =
        JSONObject().apply {
            put("ts", 1L); put("type", "team/member")
            put("target", name); put("role", "teammate"); put("phase", phase)
            put("session", session); put("provider", provider); put("context", context)
        }

    /** 桌面 projection.ts:261：provider/context 与会话身份一样，都是不可变身份字段 */
    @Test
    fun providerAndContextAreImmutable() {
        val store = SessionStore(tmp())
        store.appendOrThrow("s1", "team/member", memberEventPhase("reviewer", "provisioning", "s1#reviewer"))
        store.appendOrThrow("s1", "team/member", memberEventPhase("reviewer", "active", "s1#reviewer"))
        store.appendOrThrow("s1", "team/member", memberEventPhase("reviewer", "active", "s1#reviewer", provider = "acp"))
        val replay = TeamJournal(store).replay("s1")
        assertNotNull(replay.failure)
        assertTrue(replay.failure!!.contains("身份"))
    }

    /** 桌面 projection.ts:264：只允许 provisioning → active/failed，不能在 active/failed 之间来回 */
    @Test
    fun phaseOnlyMovesProvisioningToTerminal() {
        val store = SessionStore(tmp())
        store.appendOrThrow("s1", "team/member", memberEventPhase("reviewer", "provisioning", "s1#reviewer"))
        store.appendOrThrow("s1", "team/member", memberEventPhase("reviewer", "active", "s1#reviewer"))
        // 回放的成员 phase 应是 active，运行状态由运行时派生 —— 不落日志
        val ok = TeamJournal(store).replay("s1")
        assertNull(ok.failure)
        assertEquals(MemberPhase.ACTIVE, ok.members["reviewer"]!!.phase)
        // active 打回 provisioning = 非法迁移
        store.appendOrThrow("s1", "team/member", memberEventPhase("reviewer", "provisioning", "s1#reviewer"))
        val bad = TeamJournal(store).replay("s1")
        assertNotNull(bad.failure)
    }

    /** 旧版日志（只有 status 字段）要能映射成 phase：running/inactive 都是创建成功的 active */
    @Test
    fun legacyStatusEventsMapToPhase() {
        val store = SessionStore(tmp())
        store.appendOrThrow("s1", "team/member", memberEvent("reviewer", "provisioning", "s1#reviewer"))
        store.appendOrThrow("s1", "team/member", memberEvent("reviewer", "inactive", "s1#reviewer"))
        val replay = TeamJournal(store).replay("s1")
        assertNull(replay.failure)
        assertEquals(MemberPhase.ACTIVE, replay.members["reviewer"]!!.phase)
    }

    /** 桌面 projection.ts:294：同一条消息入队两次 = 终态拒绝 */
    @Test
    fun queuedTwiceIsTerminal() {
        val store = SessionStore(tmp())
        store.appendOrThrow("s1", "team/message", JSONObject().put("id", "m1").put("from", "reviewer").put("text", "x"))
        store.appendOrThrow("s1", "team/message", JSONObject().put("id", "m1").put("from", "reviewer").put("text", "x"))
        val replay = TeamJournal(store).replay("s1")
        assertNotNull(replay.failure)
        assertTrue(replay.failure!!.contains("入队"))
    }

    /** 桌面 projection.ts:299-303：先入队才能投递；同一条只投一次 */
    @Test
    fun deliveryInvariants() {
        // 没入队就投递
        val a = SessionStore(tmp())
        a.appendOrThrow("s1", "team/message-delivered", JSONObject().put("id", "m1"))
        val ra = TeamJournal(a).replay("s1")
        assertNotNull("未入队先投递应被拒绝", ra.failure)

        // 正常入队 → 投递：通过，且 deliveredIds 记录在案
        val b = SessionStore(tmp())
        b.appendOrThrow("s1", "team/message", JSONObject().put("id", "m1").put("from", "reviewer").put("text", "x"))
        b.appendOrThrow("s1", "team/message-delivered", JSONObject().put("id", "m1"))
        val rb = TeamJournal(b).replay("s1")
        assertNull(rb.failure)
        assertTrue(rb.deliveredIds.contains("m1"))
        assertTrue("已投递的不在待认领里", rb.pendingMessages.isEmpty())

        // 投递两次
        b.appendOrThrow("s1", "team/message-delivered", JSONObject().put("id", "m1"))
        val rc = TeamJournal(b).replay("s1")
        assertNotNull("重复投递应被拒绝", rc.failure)
        assertTrue(rc.failure!!.contains("两次"))
    }

    /**
     * 事件版本闸门（桌面 projection.ts:231）。
     *
     * 两条都要成立：未来的、写着不认识 version 的事件必须终态拒绝；
     * 本机带上 version 之前的旧日志（**没有**这个字段）必须照常读得出来 ——
     * 否则一次升级就把所有现役团队判成「记录无效」，用户看到的是团队凭空消失。
     */
    @Test
    fun teamEventVersionGatesTheReplay() {
        // 现在写的每一条都带 version
        val dir = tmp()
        val store = SessionStore(dir)
        val journal = TeamJournal(store)
        val m = member()
        journal.member("s1", m)                       // provisioning（每条日志必须以它开头）
        m.phase = MemberPhase.ACTIVE
        journal.member("s1", m)                       // 再写 active 那条边
        val first = store.read("s1").first { it.optString("type") == "team/member" }
        assertEquals("写侧要带上 version", 2, first.optInt("version"))
        assertNull("自己写的日志自己必须读得通", TeamJournal(SessionStore(dir)).replay("s1").failure)

        // 一条写着未来版本的记录：终态拒绝，并说清是第几类事件
        val future = SessionStore(tmp())
        future.appendOrThrow("s1", "team/member", JSONObject().put("version", 99).put("target", "x"))
        val rf = TeamJournal(future).replay("s1")
        assertNotNull("不认识的 version 必须被拒", rf.failure)
        assertTrue("要报出是哪类事件：${rf.failure}", rf.failure!!.contains("team/member"))
    }
}
