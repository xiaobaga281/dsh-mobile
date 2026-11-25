package ai.deepseek.harness.mobile.kernel.team

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「谁在调用」这层身份的测试。
 *
 * 为什么值得单独测：桌面把 Lead 专属操作判在**服务层**（`roster.ts:189/234` 的
 * `membership.role !== 'lead'` → `TEAM_LEAD_REQUIRED`），手机端以前只在提示词和
 * 工具目录里「不给队友看这些 schema」。目录由档位、上下文窗口、插件启停共同决定，
 * 任何一处放行，队友就能建队或掐掉别人 —— 决定发生在哪个操作里，就必须在那强制。
 */
class TeamCallTest {

    @Test
    fun noIdentityMeansLead() {
        // Lead 的轮次不设值：默认必须是 lead，否则正常建队会被自己拒掉
        assertEquals("lead", TeamCall.callerName())
        assertEquals("lead", TeamCall.requireLead("测试"))
    }

    @Test
    fun teammateCallerIsRejectedWithDesktopCode() {
        val prev = TeamCall.enter("alpha", "s1")
        try {
            val e = assertThrows(TeamError::class.java) { TeamCall.requireLead("创建队友（spawn_teammate）") }
            assertEquals("TEAM_LEAD_REQUIRED", e.code)
            assertTrue("报错要说明当前调用者是谁", e.message!!.contains("alpha"))
            // 队友身份同样要拦住 interrupt：桌面 interrupt 第一刀就是 role 判定
            val e2 = assertThrows(TeamError::class.java) { TeamCall.requireLead("中断队友（interrupt_agent）") }
            assertEquals("TEAM_LEAD_REQUIRED", e2.code)
        } finally {
            TeamCall.exit(prev)
        }
        assertEquals("退出后必须回到 Lead", "lead", TeamCall.callerName())
    }

    @Test
    fun nestedIdentityRestoresOnExit() {
        // 队友派子代理时子代理也在成员线程里：退一层要回到上一层，不能一路清成无身份
        val outer = TeamCall.enter("alpha", "s1")
        try {
            val inner = TeamCall.enter("beta", "s1")
            try {
                assertEquals("beta", TeamCall.callerName())
                assertEquals("s1", TeamCall.callerTeamSid())
            } finally {
                TeamCall.exit(inner)
            }
            assertEquals("alpha", TeamCall.callerName())
            assertEquals("外层身份退回后团队归属不能丢", "s1", TeamCall.callerTeamSid())
        } finally {
            TeamCall.exit(outer)
        }
        assertEquals("lead", TeamCall.callerName())
    }
}
