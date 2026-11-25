package ai.deepseek.harness.mobile.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 意图分类的规则表测试。
 *
 * 分类结果决定注入给模型的策略段落：错判成 chat 会注入「看起来像闲聊」的反向策略，
 * 直接压制模型做本可以做的工作（第 1 轮 harness 审查的 P0 差距）。这里把
 * 「显式点名工具必须按任务走」和「寒暄不该误开工具」两条边都钉死。
 */
class IntentRouterTest {

    private val router = IntentRouter()

    private fun detect(text: String, toolsEnabled: Boolean = true) =
        router.detect(text, hasAttachments = false, modePlan = false, goalActive = false,
            toolsEnabled = toolsEnabled)

    @Test
    fun `点名工具的多工具请求必须是 TASK 且带工具`() {
        val i = detect("请同时调用三个 bash 工具,分别读取 /proc/version、/proc/uptime、/proc/meminfo 的完整内容。")
        assertEquals(IntentRouter.Kind.TASK, i.kind)
        assertTrue("点名工具就该挂工具", i.needsTools)
        assertTrue(i.confidence >= 0.6)
    }

    @Test
    fun `中文祈使动词(读取-统计-汇报)判 TASK`() {
        val i = detect("统计 /system/etc 下有多少个 xml 文件,把数字写入 count.txt,然后读出来汇报。")
        assertEquals(IntentRouter.Kind.TASK, i.kind)
        assertTrue(i.needsTools)
    }

    @Test
    fun `寒暄不判任务`() {
        for (text in listOf("你好", "在吗", "谢谢啦", "早上好")) {
            val i = detect(text)
            assertEquals("「$text」应是闲聊", IntentRouter.Kind.CHAT, i.kind)
            assertTrue("闲聊不挂工具", !i.needsTools)
        }
    }

    @Test
    fun `低分但点名工具时逃逸 CHAT 兜底`() {
        // 这句动作词与路径都很少,旧行为会落到 CHAT(conf 0.35)并注入反向策略
        val i = detect("bash 跑一下 uname")
        assertEquals(IntentRouter.Kind.TASK, i.kind)
        assertTrue(i.confidence >= 0.6)
    }

    @Test
    fun `继续类接续上一轮`() {
        val i = detect("继续刚才的事")
        assertEquals(IntentRouter.Kind.CONTINUE, i.kind)
    }

    @Test
    fun `规划词判 PLAN 且要 plan 工具`() {
        val i = detect("帮我规划一下迁移数据库的方案和步骤")
        assertEquals(IntentRouter.Kind.PLAN, i.kind)
        assertTrue(i.needsPlan)
    }

    @Test
    fun `策略段落不出现绝对禁止工具的措辞`() {
        // 错判不可避免,但策略文本不能反过来压制正确行为
        val chatPolicy = detect("你好").let { if (it.kind == IntentRouter.Kind.CHAT) it.policyText() else "" }
        assertTrue(!chatPolicy.contains("不要调用工具"))
        if (chatPolicy.isNotEmpty()) assertTrue(chatPolicy.contains("按操作照做"))
    }
}
