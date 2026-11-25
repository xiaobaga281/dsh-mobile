package ai.deepseek.harness.mobile.ui

import ai.deepseek.harness.mobile.kernel.device.ApprovalGate
import ai.deepseek.harness.mobile.kernel.device.ApprovalScope
import ai.deepseek.harness.mobile.kernel.device.PhoneApprovalPolicy
import ai.deepseek.harness.mobile.kernel.device.ScopedApprovalGate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 手机操控应用级授权闸门的纯逻辑钉死。
 *
 * 规则（与 PhoneApprovalPolicy 的文档一一对应）：
 *  1. 未知包首次操作问一次，task（进程内）/ always（落盘 allowedApps）两级；
 *  2. 敏感界面 / 敏感应用逐次确认，且不缓存；
 *  3. 没有活跃轮次（后台/团队/委派）→ APP_APPROVAL_UNAVAILABLE；
 *  4. 权限降档 / revokeAll 清运行时 grant（revokeAll 连持久清单一起清）。
 */
class PhoneApprovalTest {

    /** 只回答是/否的确认框，记录每次被问的理由 */
    private class Gate(var answer: Boolean = true) : ApprovalGate {
        val asked = mutableListOf<String>()
        override fun request(reason: String): Boolean {
            asked += reason
            return answer
        }
    }

    /** 能回答 task/always 的确认框 */
    private class ScopedGate(var scope: ApprovalScope = ApprovalScope.TASK) : ScopedApprovalGate {
        val asked = mutableListOf<String>()
        override fun requestScoped(reason: String): ApprovalScope {
            asked += reason
            return scope
        }

        override fun request(reason: String): Boolean {
            asked += reason
            return scope != ApprovalScope.DENY
        }
    }

    private fun policy(
        saved: MutableSet<String>? = null,
        initial: Set<String> = emptySet(),
        defaultScope: ApprovalScope = ApprovalScope.TASK,
    ): PhoneApprovalPolicy {
        val p = PhoneApprovalPolicy(defaultScope = defaultScope)
        p.installStore(
            load = { if (saved != null) saved.toSet() else initial },
            save = { set -> saved?.clear(); saved?.addAll(set) },
        )
        return p
    }

    /* ---------------- 未知包：一次授权 ---------------- */

    @Test
    fun unknown_package_asks_once_then_is_remembered_for_the_task() {
        val gate = Gate()
        val p = policy()
        assertTrue(p.guardPackage("com.android.settings", "启动应用", gate).allowed)
        assertEquals(1, gate.asked.size)
        assertTrue(gate.asked[0].contains("首次"))

        // 同一任务内第二个动作不再问（task 级授权）
        assertTrue(p.guardPackage("com.android.settings", "读取前台应用", gate).allowed)
        assertEquals(1, gate.asked.size)
        assertEquals(1, p.taskGrantCount())
        assertFalse(p.allows("com.example.other"))
    }

    @Test
    fun no_active_turn_means_unavailable_not_silent_allow() {
        val p = policy()
        val d = p.guardPackage("com.android.settings", "启动应用", gate = null)
        assertFalse(d.allowed)
        assertEquals(PhoneApprovalPolicy.CODE_UNAVAILABLE, d.code)
        assertTrue(d.reason!!.contains("活跃轮次"))
        // 没有授权被记下来：下次还得问
        assertFalse(p.allows("com.android.settings"))
    }

    @Test
    fun user_denial_is_reported_and_not_cached() {
        val gate = Gate(answer = false)
        val p = policy()
        val d = p.guardPackage("com.android.settings", "启动应用", gate)
        assertFalse(d.allowed)
        assertEquals(PhoneApprovalPolicy.CODE_DENIED, d.code)
        // 拒绝不落成 grant：下一次还会问
        assertFalse(p.allows("com.android.settings"))
        val again = p.guardPackage("com.android.settings", "启动应用", gate)
        assertFalse(again.allowed)
        assertEquals(2, gate.asked.size)
    }

    /* ---------------- task / always 两级 ---------------- */

    @Test
    fun scoped_gate_task_grant_lives_in_memory_only() {
        val saved = mutableSetOf<String>()
        val gate = ScopedGate(ApprovalScope.TASK)
        val p = policy(saved = saved)
        assertTrue(p.guardPackage("com.example.app", "启动应用", gate).allowed)
        assertTrue(saved.isEmpty())          // task 级不落盘
        assertEquals(1, p.taskGrantCount())
        // 新的 policy 实例（模拟重启）不认这次 task 授权
        val restarted = policy(saved = saved)
        assertFalse(restarted.allows("com.example.app"))
    }

    @Test
    fun scoped_gate_always_grant_is_persisted() {
        val saved = mutableSetOf<String>()
        val gate = ScopedGate(ApprovalScope.ALWAYS)
        val p = policy(saved = saved)
        assertTrue(p.guardPackage("com.example.app", "启动应用", gate).allowed)
        assertTrue(saved.contains("com.example.app"))
        // 「始终允许」跨进程生效：新实例加载同一份清单，不再问
        val restarted = policy(saved = saved)
        val quiet = Gate()
        assertTrue(restarted.guardPackage("com.example.app", "启动应用", quiet).allowed)
        assertEquals(0, quiet.asked.size)
    }

    /* ---------------- 敏感界面 / 敏感应用：逐次 ---------------- */

    @Test
    fun sensitive_screen_asks_every_time() {
        val gate = Gate()
        val p = policy()
        val screen = "收款方 张三  金额 128.00 元  [确认支付]"
        assertTrue(p.guardScreen("点击「确认支付」", "com.tencent.mm", screen, gate).allowed)
        assertEquals(1, gate.asked.size)
        assertTrue(gate.asked[0].contains("敏感"))
        // 逐次确认：同一次会话的下一次点击还要问
        assertTrue(p.guardScreen("点击「确认支付」", "com.tencent.mm", screen, gate).allowed)
        assertEquals(2, gate.asked.size)
        // 敏感操作不落 grant
        assertEquals(0, p.taskGrantCount())
    }

    @Test
    fun sensitive_package_asks_per_action_even_when_always_allowed_is_irrelevant() {
        val gate = Gate()
        val p = policy()
        // 银行类包名：操作本身就要逐次确认（这里用「读取前台应用」/ open_app 都算）
        assertTrue(p.guardPackage("com.icbc.mobile", "启动应用", gate).allowed)
        assertTrue(p.guardPackage("com.icbc.mobile", "启动应用", gate).allowed)
        assertEquals(2, gate.asked.size)
    }

    @Test
    fun sensitive_screen_without_gate_is_unavailable() {
        val p = policy()
        val d = p.guardScreen("点击", "com.eg.android.AlipayGphone", "确认支付", gate = null)
        assertFalse(d.allowed)
        assertEquals(PhoneApprovalPolicy.CODE_UNAVAILABLE, d.code)
    }

    @Test
    fun ordinary_screen_is_not_gated() {
        val gate = Gate()
        val p = policy()
        val d = p.guardScreen("点击「设置」", "com.android.settings", "Wi-Fi 蓝牙 显示 声音", gate)
        assertTrue(d.allowed)
        assertEquals(0, gate.asked.size)
    }

    @Test
    fun sensitive_word_and_package_detection() {
        assertTrue(PhoneApprovalPolicy.isSensitiveText("确认支付"))
        assertTrue(PhoneApprovalPolicy.isSensitiveText("转账给 张三"))
        assertTrue(PhoneApprovalPolicy.isSensitiveText("删除这条记录"))
        assertTrue(PhoneApprovalPolicy.isSensitiveText("验证码已发送"))
        assertTrue(PhoneApprovalPolicy.isSensitiveText("Confirm Payment"))
        assertFalse(PhoneApprovalPolicy.isSensitiveText("普通设置页面"))
        assertFalse(PhoneApprovalPolicy.isSensitiveText(""))
        assertFalse(PhoneApprovalPolicy.isSensitiveText(null))

        assertTrue(PhoneApprovalPolicy.isSensitivePackage("com.icbc.mobile"))
        assertTrue(PhoneApprovalPolicy.isSensitivePackage("com.eg.android.AlipayGphone"))
        assertTrue(PhoneApprovalPolicy.isSensitivePackage("com.google.android.apps.authenticator2"))
        assertFalse(PhoneApprovalPolicy.isSensitivePackage("com.android.settings"))
        assertFalse(PhoneApprovalPolicy.isSensitivePackage(null))
    }

    /* ---------------- Intent 唤起 ---------------- */

    @Test
    fun intent_grants_are_keyed_by_scheme_and_host() {
        val gate = Gate()
        val p = policy()
        assertTrue(p.guardIntent("tel:10086", "用 Intent 唤起", gate).allowed)
        assertEquals(1, gate.asked.size)
        // 同一 scheme 的另一号码复用授权（一次授权覆盖 tel: 这种低危系统能力）
        assertTrue(p.guardIntent("tel:10010", "用 Intent 唤起", gate).allowed)
        assertEquals(1, gate.asked.size)
        // 不同 host 要重新确认
        assertTrue(p.guardIntent("https://example.com/a", "用 Intent 唤起", gate).allowed)
        assertEquals(2, gate.asked.size)
        assertTrue(p.guardIntent("https://example.com/b", "用 Intent 唤起", gate).allowed)
        assertEquals(2, gate.asked.size)
    }

    @Test
    fun intent_with_payment_uri_is_sensitive_every_time() {
        val gate = Gate()
        val p = policy()
        assertTrue(p.guardIntent("https://pay.example.com/transfer?amount=1", "用 Intent 唤起", gate).allowed)
        assertTrue(p.guardIntent("https://pay.example.com/transfer?amount=1", "用 Intent 唤起", gate).allowed)
        assertEquals(2, gate.asked.size)
    }

    /* ---------------- 撤销 / 降档 ---------------- */

    @Test
    fun revoke_runtime_grants_makes_next_action_ask_again() {
        val gate = Gate()
        val p = policy()
        assertTrue(p.guardPackage("com.android.settings", "启动应用", gate).allowed)
        assertEquals(1, gate.asked.size)
        p.revokeRuntimeGrants()
        assertEquals(0, p.taskGrantCount())
        assertTrue(p.guardPackage("com.android.settings", "启动应用", gate).allowed)
        assertEquals(2, gate.asked.size)
    }

    @Test
    fun revoke_all_clears_persisted_apps_too() {
        val saved = mutableSetOf<String>()
        val gate = ScopedGate(ApprovalScope.ALWAYS)
        val p = policy(saved = saved)
        assertTrue(p.guardPackage("com.example.app", "启动应用", gate).allowed)
        assertTrue(saved.contains("com.example.app"))

        p.revokeAll()
        assertTrue(p.alwaysAllowedSnapshot().isEmpty())
        assertTrue(saved.isEmpty())
        assertFalse(p.allows("com.example.app"))

        // 撤销后重新确认
        val again = Gate()
        assertTrue(p.guardPackage("com.example.app", "启动应用", again).allowed)
        assertEquals(1, again.asked.size)
    }

    @Test
    fun sandbox_downgrade_revokes_runtime_grants_but_upgrade_does_not() {
        val gate = Gate()
        val p = policy()
        // 升级：workspace-write → danger-full-access，不清
        p.noteSandboxMode("workspace-write")
        assertTrue(p.guardPackage("com.android.settings", "启动应用", gate).allowed)
        assertFalse(p.noteSandboxMode("danger-full-access"))
        assertTrue(p.allows("com.android.settings"))

        // 降档：danger-full-access → workspace-write，清运行时 grant
        assertTrue(p.noteSandboxMode("workspace-write"))
        assertFalse(p.allows("com.android.settings"))
        assertEquals(0, p.taskGrantCount())

        // 降档后第一次操作重新确认
        assertTrue(p.guardPackage("com.android.settings", "启动应用", gate).allowed)
        assertEquals(2, gate.asked.size)
    }

    @Test
    fun unknown_sandbox_mode_is_ignored() {
        val gate = Gate()
        val p = policy()
        // 完全访问：直接放行，且**不记 grant**（档位语义，不是"问了记住"）
        p.noteSandboxMode("danger-full-access")
        assertTrue(p.guardPackage("com.android.settings", "启动应用", gate).allowed)
        assertTrue(gate.asked.isEmpty())
        assertFalse(p.allows("com.android.settings"))
        // 未识别的档位不改变当前档位（仍是完全访问）
        assertFalse(p.noteSandboxMode(""))
        assertFalse(p.noteSandboxMode("some-future-mode"))
        assertTrue(p.guardPackage("com.android.settings", "启动应用", gate).allowed)
        assertTrue(gate.asked.isEmpty())
    }

    /* ---------------- 完全访问：整层不弹卡（对齐桌面 approval:'never'） ---------------- */

    @Test
    fun full_access_skips_sensitive_screen_and_first_app_approval() {
        val p = policy()

        // 标准档：敏感界面 + 首次应用都要问
        val std = Gate()
        assertTrue(p.guardScreen("点击坐标 (10, 20)", "com.example.bank", "确认支付 100 元", std).allowed)
        assertEquals(1, std.asked.size)
        assertTrue(p.guardPackage("com.example.app", "启动应用", std).allowed)
        assertEquals(2, std.asked.size)

        // 升到完全访问：敏感界面（命中敏感词+敏感包）、首次应用、Intent 全部直接放行
        p.noteSandboxMode("danger-full-access")
        val full = Gate()
        assertTrue(p.guardScreen("点击坐标 (10, 20)", "com.example.bank", "确认支付 100 元", full).allowed)
        assertTrue(p.guardPackage("com.unknown.app", "启动应用", full).allowed)
        assertTrue(p.guardIntent("tel:10086", "拨号", full).allowed)
        assertTrue(full.asked.isEmpty())

        // 降档回标准：恢复逐次确认（敏感界面永远不缓存）
        p.noteSandboxMode("workspace-write")
        assertTrue(p.guardScreen("点击坐标 (10, 20)", "com.example.bank", "确认支付 100 元", full).allowed)
        assertEquals(1, full.asked.size)
    }

    @Test
    fun sandbox_mode_aliases_resolve_to_one_truth() {
        // 会话档 / 桌面连字符 / 下划线 / 枚举名大写：同一档只能有一个 rank
        for (raw in listOf("readonly", "read-only", "read_only", "READ_ONLY")) {
            assertEquals("$raw 应解析为只读", 0, PhoneApprovalPolicy.sandboxRank(raw))
        }
        for (raw in listOf("ask", "default", "workspace-write", "workspace_write", "WORKSPACE_WRITE")) {
            assertEquals("$raw 应解析为标准", 1, PhoneApprovalPolicy.sandboxRank(raw))
        }
        for (raw in listOf("full", "danger-full-access", "danger_full_access", "DANGER_FULL_ACCESS")) {
            assertEquals("$raw 应解析为完全访问", 2, PhoneApprovalPolicy.sandboxRank(raw))
        }
        assertEquals(-1, PhoneApprovalPolicy.sandboxRank("nope"))
        assertEquals(-1, PhoneApprovalPolicy.sandboxRank(null))
    }

    @Test
    fun default_scope_for_plain_boolean_gate_is_configurable() {
        // 只有是/否的确认框 + defaultScope=ALWAYS：一次确认就落盘
        val saved = mutableSetOf<String>()
        val gate = Gate()
        val p = policy(saved = saved, defaultScope = ApprovalScope.ALWAYS)
        assertTrue(p.guardPackage("com.example.app", "启动应用", gate).allowed)
        assertTrue(saved.contains("com.example.app"))
    }
}
