package ai.deepseek.harness.mobile.kernel.team

import ai.deepseek.harness.mobile.agent.SessionStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 名册测试：三条「错了就会静默乱掉」的规则。
 *   · 名字非法/重复/保留名必须拒绝
 *   · 创建失败的名字也占位（桌面同样永不复用）
 *   · 进程重启后 running 必须收敛成 inactive —— 否则界面永远显示在跑，wait_agent 永远等不到
 */
class TeamRosterTest {

    private fun newRoster(max: Int = 16): Pair<TeamRoster, TeamJournal> {
        val dir = File(System.getProperty("java.io.tmpdir"), "dsh-team-roster/${System.nanoTime()}")
        dir.mkdirs()
        val journal = TeamJournal(SessionStore(dir))
        val roster = TeamRoster(journal, TeamCapacity().apply { maxMembers = max })
        roster.load("s1")
        return roster to journal
    }

    private fun spawn(roster: TeamRoster, name: String) =
        roster.reserve(name, "职责", "fresh", "m", "in-process", "s1#$name")

    /**
     * 运行期报错不进终态（桌面 projection.ts:264 只承认 provisioning → active/failed，
     * roster.ts:301-305 明确拒绝发明 active → failed）。
     *
     * 手机端以前任何异常都记 FAILED，于是端点抖一下就把队友永久打死：
     * Lead 后面再发消息撞 TEAM_MEMBER_FAILED，历史也接不上，只能重新 spawn。
     */
    @Test
    fun runtimeErrorKeepsMemberWakeable() {
        val (r, journal) = newRoster()
        val m = spawn(r, "alpha")
        r.activate(m)
        r.error(m, "端点 502：上游没有响应")

        assertEquals("报错后仍是 active（可被唤醒）", MemberPhase.ACTIVE, m.phase)
        assertEquals("但这一轮结束了", MemberStatus.INACTIVE, m.status)
        assertTrue("但运行位已落下", !m.running)
        assertTrue("原因要留着", m.lastError.contains("502"))
        assertTrue("active 成员的 view 也要带 error，界面才说得清为什么",
            m.view().optString("error").contains("502"))

        // 唤醒重跑：错误必须跟着清掉，不然旧账一直挂在卡上
        r.activate(m)
        assertEquals("", m.lastError)
        assertEquals(MemberStatus.RUNNING, m.status)
        assertEquals("重跑后 view 里不该再有 error", "", m.view().optString("error"))

        // 回放：active 之后写 active 是合法的（进度与错误都这么落），不能被判成非法迁移
        val replay = journal.replay("s1")
        assertEquals("回放后成员还在", 1, replay.members.size)
        assertEquals("回放后仍是 active", MemberPhase.ACTIVE,
            replay.members.values.first().phase)
    }

    @Test
    fun nameRules() {
        val (r, _) = newRoster()
        assertEquals("TEAM_INVALID_MEMBER_NAME", assertThrows(TeamError::class.java) { spawn(r, "Lead") }.code)
        assertEquals("TEAM_INVALID_MEMBER_NAME", assertThrows(TeamError::class.java) { spawn(r, "lead") }.code)
        assertEquals("TEAM_INVALID_MEMBER_NAME", assertThrows(TeamError::class.java) { spawn(r, "has space") }.code)
        assertEquals("TEAM_INVALID_MEMBER_NAME", assertThrows(TeamError::class.java) { spawn(r, "UPPER") }.code)
        val ok = spawn(r, "reviewer")
        assertEquals(MemberStatus.PROVISIONING, ok.status)
        assertEquals("TEAM_MEMBER_NAME_TAKEN", assertThrows(TeamError::class.java) { spawn(r, "reviewer") }.code)
    }

    @Test
    fun failedNameStaysTaken() {
        val (r, _) = newRoster()
        val m = spawn(r, "writer")
        r.fail(m, "模型端点 401")
        assertEquals(MemberStatus.FAILED, r.get("writer")!!.status)
        val e = assertThrows(TeamError::class.java) { spawn(r, "writer") }
        assertEquals("TEAM_MEMBER_NAME_TAKEN", e.code)
    }

    @Test
    fun maxMembersCountsFailedOnes() {
        val (r, _) = newRoster(max = 2)
        spawn(r, "a1")
        spawn(r, "a2").also { r.fail(it, "x") }
        assertEquals("TEAM_MEMBER_LIMIT", assertThrows(TeamError::class.java) { spawn(r, "a3") }.code)
    }

    @Test
    fun restartConvergesRunningToInactive() {
        val dir = File(System.getProperty("java.io.tmpdir"), "dsh-team-roster/restart-${System.nanoTime()}")
        dir.mkdirs()
        val journal = TeamJournal(SessionStore(dir))
        val r1 = TeamRoster(journal, TeamCapacity())
        r1.load("s1")
        val m = r1.reserve("reviewer", "看 diff", "fresh", "m", "in-process", "s1#reviewer")
        r1.activate(m)
        assertEquals(MemberStatus.RUNNING, r1.get("reviewer")!!.status)

        // 进程重启：同一份日志回放，RUNNING 不能还挂着
        val r2 = TeamRoster(TeamJournal(SessionStore(dir)), TeamCapacity())
        r2.load("s1")
        val back = r2.get("reviewer")
        assertNotNull(back)
        assertEquals(MemberStatus.INACTIVE, back!!.status)
        assertEquals("s1#reviewer", back.sessionId)
        assertTrue("应留下一条重启诊断", back.diagnostics.any { it.contains("进程重启") })
    }

    @Test
    fun leadIsVirtualAndNotPersisted() {
        val (r, _) = newRoster()
        spawn(r, "a1")
        val all = r.list()
        assertEquals(2, all.size)
        assertEquals(MemberRole.LEAD, all.first().role)
        assertTrue("lead 不进持久 roster", r.teammates().none { it.name == "lead" })
    }

    @Test
    fun nameMustBeLowerKebabWithoutDoubledHyphen() {
        val (r, _) = newRoster()
        // 桌面 memberName() 同一套规则：连续连字符、结尾连字符都不合法
        assertEquals("TEAM_INVALID_MEMBER_NAME", assertThrows(TeamError::class.java) { spawn(r, "a--b") }.code)
        assertEquals("TEAM_INVALID_MEMBER_NAME", assertThrows(TeamError::class.java) { spawn(r, "a-") }.code)
        assertEquals("TEAM_INVALID_MEMBER_NAME", assertThrows(TeamError::class.java) { spawn(r, "-a") }.code)
        assertEquals("code-reviewer-2", spawn(r, "code-reviewer-2").name)
    }

    /**
     * 对账判据一：成员会话里没有首条任务 = 创建没完成。
     * 上一版一律收敛成 inactive，把「创建失败」伪装成了「空闲」，Lead 会一直等一个不存在的人。
     */
    @Test
    fun provisioningWithoutPromptIsReconciledAsFailed() {
        val dir = File(System.getProperty("java.io.tmpdir"), "dsh-team-roster/prov-${System.nanoTime()}")
        dir.mkdirs()
        TeamRoster(TeamJournal(SessionStore(dir)), TeamCapacity()).apply {
            load("s1")
            reserve("writer", "写周报", "fresh", "m", "in-process", "s1#writer")
        }

        val r2 = TeamRoster(TeamJournal(SessionStore(dir)), TeamCapacity())
        r2.load("s1")
        val back = r2.get("writer")!!
        assertEquals(MemberStatus.FAILED, back.status)
        assertTrue("要说明为什么判失败", back.lastError.contains("初始化"))
    }

    /** 对账判据二：首条任务在成员会话里 = 创建其实成功了，应恢复成可唤醒的 inactive */
    @Test
    fun provisioningWithPromptIsReconciledAsResumable() {
        val dir = File(System.getProperty("java.io.tmpdir"), "dsh-team-roster/prov2-${System.nanoTime()}")
        dir.mkdirs()
        val j1 = TeamJournal(SessionStore(dir))
        val r1 = TeamRoster(j1, TeamCapacity())
        r1.load("s1")
        r1.reserve("writer", "写周报", "fresh", "m", "in-process", "s1#writer")
        j1.userTurn("s1#writer", "完整任务", from = "lead", strict = true)

        val r2 = TeamRoster(TeamJournal(SessionStore(dir)), TeamCapacity())
        r2.load("s1")
        val back = r2.get("writer")!!
        assertEquals(MemberStatus.INACTIVE, back.status)
        assertTrue(back.diagnostics.any { it.contains("创建已完成") })
    }

    /**
     * 对账判据三、四（桌面 reconcileProvisioning 的 parentSession / provider 两道）。
     *
     * 只看「有没有首条任务」时，一条 sessionId 指着别的会话、或 provider 写着外部运行时的
     * 记录也会被认成 active —— 之后每次 send_message 都唤不醒它，界面却常年显示「未运行」，
     * 用户只会觉得「这个人卡住了」。判失败必须说清是哪一道没过。
     */
    @Test
    fun provisioningMustMatchSessionAndProvider() {
        // 会话不挂在这支团队下面：sessionId 与 <leadSid>#<name> 对不上
        val dirA = File(System.getProperty("java.io.tmpdir"), "dsh-team-roster/prov-foreign-${System.nanoTime()}")
        dirA.mkdirs()
        val jA = TeamJournal(SessionStore(dirA))
        TeamRoster(jA, TeamCapacity()).apply {
            load("s1")
            reserve("writer", "写周报", "fresh", "m", "in-process", "s2#writer")
        }
        jA.userTurn("s2#writer", "完整任务", from = "lead", strict = true)
        val a = TeamRoster(TeamJournal(SessionStore(dirA)), TeamCapacity()).apply { load("s1") }
        val foreign = a.get("writer")!!
        assertEquals(MemberStatus.FAILED, foreign.status)
        assertTrue("要点名是会话归属对不上：${foreign.lastError}", foreign.lastError.contains("不挂在这支团队"))

        // provider 不是本进程能接回来的那一种
        val dirB = File(System.getProperty("java.io.tmpdir"), "dsh-team-roster/prov-provider-${System.nanoTime()}")
        dirB.mkdirs()
        val jB = TeamJournal(SessionStore(dirB))
        TeamRoster(jB, TeamCapacity()).apply {
            load("s1")
            reserve("writer", "写周报", "fresh", "m", "acp-external", "s1#writer")
        }
        jB.userTurn("s1#writer", "完整任务", from = "lead", strict = true)
        val b = TeamRoster(TeamJournal(SessionStore(dirB)), TeamCapacity()).apply { load("s1") }
        val wrong = b.get("writer")!!
        assertEquals(MemberStatus.FAILED, wrong.status)
        assertTrue("要点名是运行方式接不回来：${wrong.lastError}", wrong.lastError.contains("运行方式"))
    }

    /** 写日志失败时不能占名字：否则内存里有个只存在于本进程的幽灵成员 */
    @Test
    fun journalFailureDoesNotReserveTheName() {
        val f = File(System.getProperty("java.io.tmpdir"), "dsh-broken-roster-${System.nanoTime()}")
        f.writeText("not a dir")
        val r = TeamRoster(TeamJournal(SessionStore(f)), TeamCapacity())
        r.load("s1")
        val e = assertThrows(TeamError::class.java) {
            r.reserve("reviewer", "审", "fresh", "m", "in-process", "s1#reviewer")
        }
        assertEquals("TEAM_JOURNAL_FAILED", e.code)
        assertNull("写失败就不该占名字", r.get("reviewer"))
    }

    /**
     * `fail()` 不许把已经 active 的成员写成 failed（桌面 roster.ts:447-465 只承认
     * provisioning → active|failed 这一条单向迁移）。返回 false = 「这个人是活着的，
     * 别按失败处理」，调用方（TeamRuntime.settleCreatorFailure）据此抛
     * TEAM_PROVISIONING_CONFLICT —— 手机端以前直接就地写 failed，创建者的报错与
     * 「人还活着」被合成一条终态，之后 Lead 发消息撞 TEAM_MEMBER_NOT_FOUND。
     */
    @Test
    fun failRefusesToKillAnActiveMember() {
        val (roster, _) = newRoster()
        val m = spawn(roster, "alpha")
        assertEquals(MemberPhase.PROVISIONING, m.phase)
        assertTrue("provisioning 应该能落成 failed", roster.fail(m, "端点没答"))
        assertEquals(MemberPhase.FAILED, m.phase)

        val beta = spawn(roster, "beta")
        roster.activate(beta)
        assertEquals(MemberPhase.ACTIVE, beta.phase)
        assertTrue("已经 active 的成员不该被写成 failed", !roster.fail(beta, "唤醒后又报错"))
        assertEquals(MemberPhase.ACTIVE, beta.phase)
        assertEquals("beta 的 lastError 应记录这一轮没跑完", "唤醒后又报错", beta.lastError)
    }

    /** 成员上限按桌面实际发出去的那一份（profile 实配 8），不是 schema 的理论默认 16 */
    @Test
    fun defaultMemberLimitFollowsTheShippedProfile() {
        assertEquals(8, TeamLimits.DEFAULT_MAX_MEMBERS)
        val (roster, _) = newRoster(TeamLimits.DEFAULT_MAX_MEMBERS)
        repeat(8) { spawn(roster, "m$it") }
        val err = assertThrows(TeamError::class.java) { spawn(roster, "over") }
        assertEquals("TEAM_MEMBER_LIMIT", err.code)
    }
}
