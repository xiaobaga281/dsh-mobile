package ai.deepseek.harness.mobile.kernel.team

import ai.deepseek.harness.mobile.agent.AgentConfig
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 队友用哪个模型 —— rc.199 之前这条是死的：spawn 时把空的成员模型落成了 `lead.model`，
 * 于是运行时那行 `m.model.ifBlank { subagentModel … }` 永远进不去，设置里的子代理档
 * 对团队成员形同虚设（对普通子代理却生效）。这里把三档优先级和端点覆盖钉住。
 */
class MemberLlmTest {

    private fun cfg(
        model: String = "lead-pro",
        subModel: String = "",
        subUrl: String = "",
        subKey: String = "",
    ) = AgentConfig(
        sessionId = "s1",
        baseUrl = "https://lead.example/v1",
        apiKey = "k-lead",
        model = model,
        userText = "干活",
        subagentModel = subModel,
        subagentUrl = subUrl,
        subagentKey = subKey,
    )

    @Test
    fun explicitMemberModelWins() {
        val r = MemberLlm.resolve(cfg(subModel = "worker-mini"), "member-special")
        assertEquals("member-special", r.model)
    }

    /** 被修死的那条：成员没指定、但配了子代理档 → 必须用子代理档，而不是 Lead 模型 */
    @Test
    fun subagentTierAppliesWhenMemberFollows() {
        val r = MemberLlm.resolve(cfg(subModel = "worker-mini"), "")
        assertEquals("worker-mini", r.model)
        // 空白也算「没指定」：模型名里不会有意为之的空格
        assertEquals("worker-mini", MemberLlm.resolve(cfg(subModel = "worker-mini"), "   ").model)
    }

    @Test
    fun fallsBackToLeadModel() {
        assertEquals("lead-pro", MemberLlm.resolve(cfg(), "").model)
    }

    /** 端点/密钥是独立一档（把子级流量整体挪到代理端点，模型名照旧），不跟模型名绑定 */
    @Test
    fun endpointOverrideIsIndependent() {
        val only = MemberLlm.resolve(cfg(subUrl = "https://proxy.example/v1", subKey = "k-proxy"), "")
        assertEquals("lead-pro", only.model)
        assertEquals("https://proxy.example/v1", only.baseUrl)
        assertEquals("k-proxy", only.apiKey)

        val both = MemberLlm.resolve(cfg(subModel = "worker-mini", subUrl = "https://proxy.example/v1"), "m")
        assertEquals("m", both.model)
        assertEquals("https://proxy.example/v1", both.baseUrl)
        // 没配覆盖时退回 Lead 的端点与密钥
        assertEquals("k-lead", MemberLlm.resolve(cfg(), "").apiKey)
    }

    /** 名单上「跟随默认」的成员要显示生效值，而不是空串；显式指定的显示自己那个 */
    @Test
    fun memberViewShowsEffectiveModel() {
        val follow = TeamMember("mate-a", MemberRole.TEAMMATE, "职责", "fresh", "", "in-process", "s1#mate-a")
        val fixed = TeamMember("mate-b", MemberRole.TEAMMATE, "职责", "fresh", "member-special", "in-process", "s1#mate-b")
        val lead = cfg(subModel = "worker-mini")
        val effective = MemberLlm.resolve(lead, "").model
        assertEquals("worker-mini", follow.view(effective).optString("model"))
        assertEquals("member-special", fixed.view(effective).optString("model"))
        assertEquals("worker-mini", follow.snapshot(effective).optString("model"))
        // 落日志的那份不带 fallback：存的就是「显式那一份」，空 = 跟随
        assertEquals("", follow.snapshot().optString("model"))
    }
}
