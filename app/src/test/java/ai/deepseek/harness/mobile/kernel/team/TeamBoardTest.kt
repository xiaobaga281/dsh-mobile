package ai.deepseek.harness.mobile.kernel.team

import ai.deepseek.harness.mobile.agent.SessionStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 团队领域层的状态机测试（纯 JVM，不碰 Android）。
 *
 * 覆盖的是「错了会让整支团队悄悄乱掉」的四类：
 *   · CAS：过期 revision 必须拒绝，不能覆盖别人的成果
 *   · DAG：成环要拒绝；删除任务要从别人的依赖里摘掉，否则永远解不开
 *   · tombstone：删掉的任务 id 不复用，历史引用不会指错
 *   · 回放：进程重启后 roster/task 从会话日志还原，running 不能还挂着
 */
class TeamBoardTest {

    private val lead = TeamBoard.Actor("lead", MemberRole.LEAD)

    private fun newBoard(maxTasks: Int = 8): Pair<TeamBoard, TeamJournal> {
        val dir = File(System.getProperty("java.io.tmpdir"), "dsh-team-test/${System.nanoTime()}")
        dir.mkdirs()
        val journal = TeamJournal(SessionStore(dir))
        val cap = TeamCapacity()
        cap.maxTasks = maxTasks
        val board = TeamBoard(journal, cap)
        board.load("s-test")
        return board to journal
    }

    @Test
    fun dependencyGatesReadiness() {
        val (b, _) = newBoard()
        val a = b.create("A", "first", emptyList(), listOf("src/a"))
        val c = b.create("B", "second", listOf(a.id), listOf("src/b"))
        assertFalse("有未完成依赖时不该 ready", b.readyOf(c))
        b.update(a.id, b.get(a.id)!!.revision, "claim", lead)
        b.update(a.id, b.get(a.id)!!.revision, "complete", lead)
        assertTrue("依赖完成后 ready", b.readyOf(b.get(c.id)!!))
    }

    @Test
    fun staleRevisionIsRejected() {
        val (b, _) = newBoard()
        val t = b.create("A", "做这件事", emptyList(), emptyList())
        val stale = t.revision
        b.update(t.id, stale, "claim", lead)
        val e = assertThrows(TeamError::class.java) {
            b.update(t.id, stale, "complete", lead)
        }
        assertEquals("TEAM_TASK_STALE_REVISION", e.code)
        assertEquals(TaskStatus.IN_PROGRESS, b.get(t.id)!!.status)
    }

    @Test
    fun dependencyCycleIsRejected() {
        val (b, _) = newBoard()
        val a = b.create("A", "做这件事", emptyList(), emptyList())
        val c = b.create("B", "做这件事", listOf(a.id), emptyList())
        val e = assertThrows(TeamError::class.java) {
            b.update(a.id, a.revision, "set_dependencies", lead, blockedBy = listOf(c.id))
        }
        assertEquals("TEAM_TASK_DEPENDENCY_CYCLE", e.code)
    }

    @Test
    fun deleteRefusesWhileDependentsExist() {
        val (b, _) = newBoard()
        val a = b.create("A", "做这件事", emptyList(), emptyList())
        val c = b.create("B", "做这件事", listOf(a.id), emptyList())

        // 桌面语义：还有活动任务依赖它时拒绝删除，而不是偷偷改别人的 blockedBy
        val e = assertThrows(TeamError::class.java) { b.update(a.id, a.revision, "delete", lead) }
        assertEquals("TEAM_TASK_HAS_DEPENDENTS", e.code)

        b.update(c.id, c.revision, "set_dependencies", lead, blockedBy = emptyList())
        b.update(a.id, a.revision, "delete", lead)
        assertEquals(TaskStatus.DELETED, b.get(a.id)!!.status)
        assertTrue("tombstone 不能出现在活动列表", b.active().none { it.id == a.id })
        // id 不复用：下一条继续往上涨
        val d = b.create("C", "做这件事", emptyList(), emptyList())
        assertEquals("task-3", d.id)
    }

    @Test
    fun completeRequiresInProgress() {
        val (b, _) = newBoard()
        val t = b.create("A", "做这件事", emptyList(), emptyList())
        // 跳过 claim 直接 complete 必须被拒（否则 revision 对得上就能伪造完成）
        assertEquals(
            "TEAM_TASK_INVALID_TRANSITION",
            assertThrows(TeamError::class.java) { b.update(t.id, t.revision, "complete", lead) }.code,
        )
        b.update(t.id, b.get(t.id)!!.revision, "claim", lead)
        b.update(t.id, b.get(t.id)!!.revision, "complete", lead)
        assertEquals(TaskStatus.COMPLETED, b.get(t.id)!!.status)
        // 已完成不能再 release
        assertEquals(
            "TEAM_TASK_INVALID_TRANSITION",
            assertThrows(TeamError::class.java) { b.update(t.id, b.get(t.id)!!.revision, "release", lead) }.code,
        )
    }

    /**
     * 任务板要认得出「是谁在改」。
     *
     * 真机上的样子：插件层以前把调用者一律写成 lead，于是队友 claim 的任务 owner 显示 "lead"
     * （Lead 面板看不见是谁在干、写租约冲突报成「Lead 占着这个文件」），
     * 而下面这些 owner 判定一次都不会触发 —— 任何成员都能替别人 complete。
     */
    @Test
    fun memberActorOwnsOnlyItsOwnTask() {
        val (b, _) = newBoard()
        val alice = TeamBoard.Actor("alice", MemberRole.TEAMMATE)
        val bob = TeamBoard.Actor("bob", MemberRole.TEAMMATE)
        val t = b.create("A", "做这件事", emptyList(), emptyList())

        b.update(t.id, t.revision, "claim", alice)
        assertEquals("成员认领要记在成员自己名下", "alice", b.get(t.id)!!.owner)

        b.update(t.id, b.get(t.id)!!.revision, "release", lead)
        // 代别人领是 reassign 的活儿（桌面 claim 直接 ownerId = caller.id），成员传的 owner 不算数
        b.update(t.id, b.get(t.id)!!.revision, "claim", bob, owner = "alice")
        assertEquals("bob", b.get(t.id)!!.owner)

        assertEquals(
            "TEAM_TASK_UNAUTHORIZED",
            assertThrows(TeamError::class.java) {
                b.update(t.id, b.get(t.id)!!.revision, "complete", alice)
            }.code,
        )
        assertEquals(
            "只有 Lead 能改派",
            "TEAM_LEAD_REQUIRED",
            assertThrows(TeamError::class.java) {
                b.update(t.id, b.get(t.id)!!.revision, "reassign", alice, owner = "alice")
            }.code,
        )
        // Lead 收回自己手上（桌面 resolveActiveMember 认 lead 伪行）与代领都合法
        b.update(t.id, b.get(t.id)!!.revision, "reassign", lead, owner = "lead")
        assertEquals("lead", b.get(t.id)!!.owner)
        b.update(t.id, b.get(t.id)!!.revision, "complete", lead)
        assertEquals(TaskStatus.COMPLETED, b.get(t.id)!!.status)
    }

    /**
     * 改派的判据是「前置依赖有没有完成」（桌面 taskReady），不是「现在能不能领」。
     *
     * 混用 readyOf（要求 status==pending）时，改派**进行中**的任务 —— 也就是
     * 「干到一半的人卡住了，换人」这个主要场景 —— 永远失败，而且报的是
     * 「任务 task-1 还被  挡着」：挡住它的依赖一个都没有，纯误导。
     */
    @Test
    fun reassignCoversInProgressTasks() {
        val (b, _) = newBoard()
        val t = b.create("A", "做这件事", emptyList(), emptyList())
        b.update(t.id, t.revision, "claim", TeamBoard.Actor("alice", MemberRole.TEAMMATE))

        val moved = b.update(t.id, b.get(t.id)!!.revision, "reassign", lead, owner = "bob")
        assertEquals("bob", moved.owner)
        assertEquals("换人之后仍在进行中（不是退回待办）", TaskStatus.IN_PROGRESS, moved.status)

        // 前置没完成时依然挡得住，且这次报得出是谁挡的
        val dep = b.create("前置", "做这件事", emptyList(), emptyList())
        val blocked = b.create("B", "做这件事", emptyList(), emptyList())
        b.update(blocked.id, blocked.revision, "claim", lead)
        // 先领了活、后来才被压上一个没完成的前置 —— 桌面也允许这样改依赖
        b.update(blocked.id, b.get(blocked.id)!!.revision, "set_dependencies", lead, blockedBy = listOf(dep.id))
        val e = assertThrows(TeamError::class.java) {
            b.update(blocked.id, b.get(blocked.id)!!.revision, "reassign", lead, owner = "bob")
        }
        assertEquals("TEAM_TASK_BLOCKED", e.code)
        assertTrue("要说清是谁挡的：${e.message}", e.message!!.contains(dep.id))
        assertTrue("没有前置依赖就不算被挡（moved 是进行中的）", b.unblockedOf(moved))
        assertFalse("前置没完成就是被挡", b.unblockedOf(b.get(blocked.id)!!))
    }

    /**
     * 输入长度与必填：三个上限照桌面同数（task-board.ts:60-61 / 150-153）。
     *
     * 不卡的代价不是「不好看」：subject / description 会整份进 Lead 会话日志、进每一次
     * 成员快照与回放，本地 8k/16k 窗口下一轮就被模型自己写满，日志体积也没边。
     */
    @Test
    fun taskTextCapsMatchDesktop() {
        val (b, _) = newBoard()
        assertEquals(
            "TEAM_INVALID_ARGUMENT",
            assertThrows(TeamError::class.java) { b.create("  ", "做这件事", emptyList(), emptyList()) }.code,
        )
        assertEquals(
            "TEAM_INVALID_ARGUMENT",
            assertThrows(TeamError::class.java) { b.create("A", "  ", emptyList(), emptyList()) }.code,
        )
        val long = assertThrows(TeamError::class.java) {
            b.create("标".repeat(201), "做这件事", emptyList(), emptyList())
        }
        assertTrue("要说清限多少：${long.message}", long.message!!.contains("200"))
        val t = b.create("刚好 200", "x".repeat(TASK_DESC_MAX), emptyList(), emptyList())
        assertEquals(TASK_DESC_MAX, t.description.length)

        // edit 三个可改字段一个都没给 = 调用方写错了，不该白涨一个 revision
        val rev = b.get(t.id)!!.revision
        assertEquals(
            "TEAM_INVALID_ARGUMENT",
            assertThrows(TeamError::class.java) { b.update(t.id, rev, "edit", lead) }.code,
        )
        assertEquals("被拒的 edit 不许涨 revision", rev, b.get(t.id)!!.revision)
        assertEquals(
            "TEAM_INVALID_ARGUMENT",
            assertThrows(TeamError::class.java) {
                b.update(t.id, rev, "edit", lead, subject = "y".repeat(201))
            }.code,
        )
    }

    @Test
    fun writeScopeRejectsDotDotAndAbsolute() {
        val (b, _) = newBoard()
        assertEquals(
            "TEAM_INVALID_WRITE_SCOPE",
            assertThrows(TeamError::class.java) { b.create("A", "做这件事", emptyList(), listOf("src/../etc")) }.code,
        )
        assertEquals(
            "TEAM_INVALID_WRITE_SCOPE",
            assertThrows(TeamError::class.java) { b.create("B", "做这件事", emptyList(), listOf("/sdcard")) }.code,
        )
        assertEquals(
            "TEAM_INVALID_WRITE_SCOPE",
            assertThrows(TeamError::class.java) { b.create("C", "做这件事", emptyList(), listOf("C:/tmp")) }.code,
        )
    }

    /**
     * 写范围重叠 = 提示，不是锁（桌面 task-view.ts:44-49 只塞一句 warning，
     * validation.ts:22-26 写明 "without treating it as a lock"）。
     *
     * 手机端以前把它升级成运行时硬拦：两条任务都声明 `src/` 这种正常排期会让后动手的
     * 成员每次写都被拒，界面上看就是「队友调用工具失败」。现在重叠只在任务上说话，
     * 分工由 Lead 负责。
     */
    @Test
    fun writeScopeOverlapIsAdvisory() {
        val (b, _) = newBoard()
        val a = b.create("A", "做这件事", emptyList(), listOf("src/ui"))
        val c = b.create("B", "做这件事", emptyList(), listOf("src/ui/chat.js"))
        b.update(a.id, a.revision, "claim", TeamBoard.Actor("alice", MemberRole.TEAMMATE))
        val warnings = b.warningsOf(b.get(c.id)!!)
        assertTrue("重叠要提示出来：$warnings", warnings.any { it.contains(a.id) })
        // 前缀包含关系算重叠；同名单复义不算（`src/ui2` 不在 `src/ui` 里）
        val d = b.create("C", "做这件事", emptyList(), listOf("src/ui2"))
        assertTrue("兄弟目录不该报重叠", b.warningsOf(d).isEmpty())
        // 只有 in-progress 的任务参与提示：pending 的还没开始写
        b.update(a.id, b.get(a.id)!!.revision, "release", TeamBoard.Actor("lead", MemberRole.LEAD))
        assertTrue("release 之后不该再提示重叠：${b.warningsOf(b.get(c.id)!!)}", b.warningsOf(b.get(c.id)!!).isEmpty())
    }

    /**
     * 错误码目录与桌面一致（对齐③）。
     *
     * 手机端以前自造了 TEAM_FORBIDDEN / TEAM_TASK_BAD_ACTION / TEAM_TASK_DEP_UNKNOWN /
     * TEAM_TASK_CYCLE 四个同义码。码不该按实现者觉得顺手的分法长：桌面已有的语义就用
     * 桌面的码名，否则同一件事在两端给出两种答案，模型的纠正经验在另一端全部失效，
     * 日志与将来的跨端导入也得再翻译一遍。
     */
    @Test
    fun errorCodesMatchDesktopCatalog() {
        val (b, _) = newBoard()
        val alice = TeamBoard.Actor("alice", MemberRole.TEAMMATE)
        val t = b.create("A", "做这件事", emptyList(), emptyList())

        // 未知 action → 桌面的「参数写错」，不是自造的 BAD_ACTION
        assertEquals(
            "TEAM_INVALID_ARGUMENT",
            assertThrows(TeamError::class.java) { b.update(t.id, t.revision, "shrink", lead) }.code,
        )
        // 依赖指向不存在的任务 → 桌面 task-board.ts:226 用的是 TASK_NOT_FOUND
        assertEquals(
            "TEAM_TASK_NOT_FOUND",
            assertThrows(TeamError::class.java) { b.create("B", "做这件事", listOf("task-99"), emptyList()) }.code,
        )
        // 自己依赖自己 → 桌面 task-board.ts:222 的 DEPENDENCY_CYCLE
        val e1 = assertThrows(TeamError::class.java) {
            b.update(t.id, t.revision, "set_dependencies", lead, blockedBy = listOf(t.id))
        }
        assertEquals("TEAM_TASK_DEPENDENCY_CYCLE", e1.code)
        // 没带 blocked_by 不是「清空依赖」，是参数写错（桌面 task-board.ts:159）
        assertEquals(
            "TEAM_INVALID_ARGUMENT",
            assertThrows(TeamError::class.java) {
                b.update(t.id, t.revision, "set_dependencies", lead, blockedBy = null)
            }.code,
        )
        // 队友替别人 complete → TEAM_TASK_UNAUTHORIZED（桌面 task-board.ts:125）
        b.update(t.id, t.revision, "claim", alice)
        assertEquals(
            "TEAM_TASK_UNAUTHORIZED",
            assertThrows(TeamError::class.java) {
                b.update(t.id, b.get(t.id)!!.revision, "edit", TeamBoard.Actor("bob", MemberRole.TEAMMATE), subject = "改了")
            }.code,
        )
        // 只有 Lead 能改派（桌面 task-board.ts:173）
        assertEquals(
            "TEAM_LEAD_REQUIRED",
            assertThrows(TeamError::class.java) {
                b.update(t.id, b.get(t.id)!!.revision, "reassign", alice, owner = "bob")
            }.code,
        )
    }

    /**
     * 别人已经认领的任务，claim 报的是「已经被谁领了」，不是含糊的「被挡着」。
     *
     * 桌面判序（task-board.ts:130-135）先判归属再判 ready。反过来时 beta 会收到
     * 「TEAM_TASK_BLOCKED：当前状态是 in_progress」，它于是以为等 alpha 做完再来 ——
     * 真相是这条永远轮不到它，只有 Lead 能改派。
     */
    @Test
    fun claimByAnotherMemberReportsAlreadyClaimed() {
        val (b, _) = newBoard()
        val alice = TeamBoard.Actor("alice", MemberRole.TEAMMATE)
        val bob = TeamBoard.Actor("bob", MemberRole.TEAMMATE)
        val t = b.create("A", "做这件事", emptyList(), emptyList())
        b.update(t.id, t.revision, "claim", alice)

        val e = assertThrows(TeamError::class.java) {
            b.update(t.id, b.get(t.id)!!.revision, "claim", bob)
        }
        assertEquals("TEAM_TASK_ALREADY_CLAIMED", e.code)
        assertTrue("要说清是谁占着：${e.message}", e.message!!.contains("alice"))
        assertEquals("报错不能顺手改状态", "alice", b.get(t.id)!!.owner)
        // owner 自己重复 claim 仍然只是「被挡着」（它已经在 in_progress 了）
        assertEquals(
            "TEAM_TASK_BLOCKED",
            assertThrows(TeamError::class.java) {
                b.update(t.id, b.get(t.id)!!.revision, "claim", alice)
            }.code,
        )
    }

    /**
     * 一条没人的任务，队友不能直接替它 complete/edit/delete。
     *
     * 手机端以前把「owner 为空」当成放行条件（`t.owner != null && ...`），于是任何成员
     * 都能抢先收掉一条它根本没做过的活 —— 桌面 authorizeOwner 比的是 `ownerId === caller.id`，
     * 没有主的任务只有 Lead 能动。
     */
    @Test
    fun unownedTaskIsNotOpenToEveryMember() {
        val (b, _) = newBoard()
        val alice = TeamBoard.Actor("alice", MemberRole.TEAMMATE)
        val t = b.create("A", "做这件事", emptyList(), emptyList())
        for (action in listOf("complete", "edit", "delete", "reopen")) {
            val e = assertThrows("队友不该能直接$action 一条无主任务", TeamError::class.java) {
                b.update(t.id, b.get(t.id)!!.revision, action, alice, subject = "改了")
            }
            assertEquals("$action 的授权码", "TEAM_TASK_UNAUTHORIZED", e.code)
        }
        // Lead 动手是合法的（它就是分工的负责人）
        b.update(t.id, b.get(t.id)!!.revision, "edit", lead, subject = "Lead 改了标题")
        assertEquals("Lead 改了标题", b.get(t.id)!!.subject)
    }

    /**
     * 重复的 blocker 是参数写错，不是悄悄去重（桌面 task-board.ts:223）。
     *
     * `distinct()` 的后果：模型以为「我挂了两个前置」，任务板上只有一条；下次它按两条去
     * 核对依赖，对不上就以为任务板被别人改过。
     */
    @Test
    fun duplicateBlockerIsRejectedNotSilentlyDeduped() {
        val (b, _) = newBoard()
        val dep = b.create("前置", "做这件事", emptyList(), emptyList())
        val e = assertThrows(TeamError::class.java) {
            b.create("A", "做这件事", listOf(dep.id, dep.id), emptyList())
        }
        assertEquals("TEAM_INVALID_ARGUMENT", e.code)
        assertTrue("要点名是哪条重复：${e.message}", e.message!!.contains(dep.id))
        // set_dependencies 同一条判据
        val t = b.create("B", "做这件事", emptyList(), emptyList())
        assertEquals(
            "TEAM_INVALID_ARGUMENT",
            assertThrows(TeamError::class.java) {
                b.update(t.id, t.revision, "set_dependencies", lead, blockedBy = listOf(dep.id, dep.id))
            }.code,
        )
        // 空白项仍然只是噪声，不参与判重（桌面对空串也是先 trim 再判）
        val ok = b.create("C", "做这件事", listOf(dep.id, "  "), emptyList())
        assertEquals(listOf(dep.id), ok.blockedBy)
    }

    @Test
    fun maxTasksIsEnforced() {        val (b, _) = newBoard(maxTasks = 2)
        b.create("A", "做这件事", emptyList(), emptyList())
        b.create("B", "做这件事", emptyList(), emptyList())
        val e = assertThrows(TeamError::class.java) { b.create("C", "做这件事", emptyList(), emptyList()) }
        assertEquals("TEAM_TASK_LIMIT", e.code)
    }

    @Test
    fun replayRestoresTasksAfterRestart() {
        val dir = File(System.getProperty("java.io.tmpdir"), "dsh-team-test/replay-${System.nanoTime()}")
        dir.mkdirs()
        val sessions = SessionStore(dir)
        val journal = TeamJournal(sessions)
        val b1 = TeamBoard(journal, TeamCapacity())
        b1.load("s1")
        val t = b1.create("A", "x", emptyList(), listOf("src"))
        b1.update(t.id, t.revision, "claim", lead)

        // 模拟进程重启：同一份日志重新回放
        val b2 = TeamBoard(TeamJournal(SessionStore(dir)), TeamCapacity())
        b2.load("s1")
        val back = b2.get(t.id)
        assertNotNull(back)
        assertEquals(TaskStatus.IN_PROGRESS, back!!.status)
        assertEquals("lead", back.owner)
        assertEquals(2, back.revision)
    }

    /** 日志写失败时不能留下「只存在于内存」的任务：否则重启后 id 水位线会跳号 */
    @Test
    fun journalFailureLeavesNoGhostTask() {
        val f = File(System.getProperty("java.io.tmpdir"), "dsh-broken-board-${System.nanoTime()}")
        f.writeText("not a dir")
        val b = TeamBoard(TeamJournal(SessionStore(f)), TeamCapacity())
        b.load("s1")
        val e = assertThrows(TeamError::class.java) { b.create("A", "x", emptyList(), emptyList()) }
        assertEquals("TEAM_JOURNAL_FAILED", e.code)
        assertTrue("写失败就不该有这条任务", b.active().isEmpty())
    }

    /** 状态机拒绝的分支不能留下半改状态（写时复制的另一面） */
    @Test
    fun rejectedTransitionDoesNotMutateTask() {
        val (b, _) = newBoard()
        val t = b.create("A", "做这件事", emptyList(), emptyList())
        assertEquals(
            "TEAM_TASK_INVALID_TRANSITION",
            assertThrows(TeamError::class.java) { b.update(t.id, t.revision, "complete", lead) }.code,
        )
        val after = b.get(t.id)!!
        assertEquals(TaskStatus.PENDING, after.status)
        assertEquals(1, after.revision)
    }

    /**
     * 阻塞者完成之后，被阻塞的任务**不自动推进**（桌面 task-board.ts:162-166：
     * `complete` 只写自己的快照，没有任何级联；被阻塞任务只在下一次读时派生出 ready）。
     *
     * 手机端如果哪天在这里加「自动认领 / 自动通知 owner」，就会与桌面分叉：
     * 队友的循环是「领了才干活」，自动推进会把没人打算做的任务变成有人在做的任务，
     * 而且写路径上没有 CAS，等于凭空造出一条谁都没批准的迁移。
     */
    @Test
    fun completingBlockerDoesNotAdvanceDependent() {
        val (b, _) = newBoard()
        val a = b.create("A", "前置", emptyList(), listOf("src/a"))
        val c = b.create("B", "后继", listOf(a.id), listOf("src/b"))
        b.update(a.id, b.get(a.id)!!.revision, "claim", lead)
        b.update(a.id, b.get(a.id)!!.revision, "complete", lead)

        val after = b.get(c.id)!!
        assertEquals("前置完成后后继仍应是 pending", TaskStatus.PENDING, after.status)
        assertNull("前置完成后不该有人自动认领", after.owner)
        assertTrue("但下一次读就该看见它已 ready", b.readyOf(after))
        // 非 Lead 的成员也不能替别人把它领走（桌面 task-board.ts:133-135 的 blocked 判据已解除，
        // 所以这里要的是「谁 claim 归谁」，不是「自动归某个人」）
        val alpha = TeamBoard.Actor("alpha", MemberRole.TEAMMATE)
        val claimed = b.update(c.id, after.revision, "claim", alpha)
        assertEquals("claim 之后 owner 才是它", "alpha", claimed.owner)
    }
}
