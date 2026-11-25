package ai.deepseek.harness.mobile.kernel.sandbox

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.Workspace
import org.json.JSONObject
import java.io.File

/**
 * 进程沙箱 seam —— 对应桌面 `packages/sandbox/sandbox` 的 `SandboxMode` /
 * `SandboxEnforcement`。
 *
 * 桌面版把 bash/fs 的 argv 包在「文件效果策略」里，再由沙箱后端（Linux bwrap/Landlock、
 * macOS Seatbelt、Windows ACL）真正执行；网络与进程可见性不在这个词汇里。
 * 安卓没有 bwrap/Landlock，能够提供的边界只有两层：
 *
 *   1. **Android 应用沙箱**：每个 APK 一个 UID + SELinux 域，工作区在 `/data/data/<pkg>/files`，
 *      别的应用读写不到 —— 这是桌面 OS 级沙箱在手机上的对应物，但它管不到「本应用自己越界」。
 *   2. **进程内策略层**（本类）：所有文件工具在动手前先按 mode 判定，
 *      路径必须落在 workspaceRoot 内；shell 的工作目录与 HOME/TMPDIR 也钉在工作区。
 *
 * ## 三档的真实语义（WP4a 修正）
 *
 * 旧实现里 `DANGER_FULL_ACCESS` 会把绝对路径「按字面解析」，宣称 fs 能到工作区外；
 * 但实际有两条相反的路径：`FsTools.normPath` 在进入本层之前就把绝对路径改写成相对路径，
 * 于是 fs 工具永远到不了外面；而 `EditorPlugin` 直接拿原始 path 调 `checkWrite`，又能到外面。
 * 同一条策略在两个工具上行为相反 —— 这不是「档位」，是缺陷。
 *
 * 现在统一为：**三档的路径语义完全相同，一律以 Workspace 为根**。`DANGER_FULL_ACCESS`
 * 的真实差异只有一条：`AgentConfig.needConfirm` 关闭逐条确认（见 `agent/AgentConfig.kt`），
 * 以及 shell 不再受任何逐条审批 —— 这正是它危险的地方，也是它需要被显式选择的理由。
 * 这样 `describe()` 不再宣传一个做不到的能力（桌面同规矩：partial 不得被当成 full）。
 *
 * ## 执行完整性
 *
 * - fs 工具：`full` —— 每次写都由本层判定，工具没有第二条写入路径
 * - shell / 终端 / V8(`dsh.exec`) / 清单插件处理器：`partial` —— 只能限制 cwd 与环境，
 *   拦不住进程内的系统调用；因此 read-only 下**直接拒绝执行**，而不是假装它被限制了
 *
 * ## Landlock 内核强制沙箱（C4）—— 实测不可用（2026-10-25）
 *
 * Android15-6.6 模拟器内核 `CONFIG_SECURITY_LANDLOCK is not set`（/proc/config.gz 实查，
 * 应用域 landlock_create_ruleset 返回 ENOSYS；应用 seccomp 白名单也未放行 444-446）。
 * 现役设备内核普遍未编 Landlock，短期内不是可靠边界 —— 本类保持
 * 「Android UID + 进程内策略」双层不变；哪天内核放行，再经独立后端接入（bwrap 同款
 * restrict-then-exec），不要在 partial 表述里偷偷新增未兑现的承诺。
 */
/**
 * 权限档位 —— **全仓唯一真值**。
 *
 * 同一个概念以前有四处各自的映射：会话档 `readonly/ask/full`、本枚举、
 * 桌面连字符 `read-only/…`、手机操控层自己认的 6 种别名。加一档要改四处，
 * 漏一处就静默失效（rc.96 的「递归深度重启后变回 1」就是这么坏的）。
 * 现在别名解析与两个对外拼写都收在这里，别处一律调 [parse] / [forSession]。
 */
enum class SandboxMode(val rank: Int, val session: String, val wire: String) {
    READ_ONLY(0, "readonly", "read-only"),
    WORKSPACE_WRITE(1, "ask", "workspace-write"),
    DANGER_FULL_ACCESS(2, "full", "danger-full-access");

    companion object {
        /** 认识所有历史写法（含英文别名）；未知返回 null，由调用方决定兜底 */
        fun parse(raw: String?): SandboxMode? = when (raw?.trim()?.lowercase()) {
            "read-only", "readonly", "read_only" -> READ_ONLY
            "workspace-write", "workspace_write", "ask", "default" -> WORKSPACE_WRITE
            "danger-full-access", "danger_full_access", "full" -> DANGER_FULL_ACCESS
            else -> null
        }

        /** 会话档 → 沙箱档：未知按工作区写（与旧 modeFor 的兜底一致） */
        fun forSession(permission: String): SandboxMode = parse(permission) ?: WORKSPACE_WRITE
    }
}

/** 执行完整性：`FULL` 表示每次效果都由本层判定；`PARTIAL` 表示只约束了入口、拦不住进程内部。 */
enum class SandboxEnforcement { FULL, PARTIAL }

class WorkspaceSandbox(
    private val ws: Workspace,
) {

    companion object {
        const val BACKEND = "android-uid+workspace"

        /**
         * 只能约束入口、无法约束进程内部的能力。列在这里的工具一律报 `PARTIAL`，
         * 且 read-only 下被 [checkExecutionSurface] 拒绝执行。
         */
        val PARTIAL_SURFACES: Set<String> = setOf(
            "bash", "pwsh", "run_code", "python", "node", "compile", "run", "java", "rustc", "pkg",
            "terminal_open", "terminal_send", "terminal_close",
            "terminal_signal", "create_worktree", "plugin_create", "plugin_install",
        )

        /** 权限档位 → 沙箱模式（与桌面「策略由会话派生」一致） */
        fun modeFor(permission: String): SandboxMode = SandboxMode.forSession(permission)

        /** 桌面 `SandboxMode` 的连字符拼写；denial marker 与设置页都用它。 */
        fun modeName(mode: SandboxMode): String = mode.wire
    }

    @Volatile var mode: SandboxMode = SandboxMode.WORKSPACE_WRITE
        private set

    fun apply(permission: String) {
        mode = modeFor(permission)
    }

    /**
     * 文件工具的读入口。
     *
     * 三档语义一致：全部以工作区为根（旧实现让 full 档按字面解析绝对路径，与
     * `FsTools.normPath` / `EditorPlugin` 的实际行为互相矛盾，见类注释）。
     * 需要读工作区外文件的能力，应当是一个**显式声明的、单独的**能力，
     * 而不是沙箱档位的一个隐式副作用。
     */
    fun resolveRead(path: String, mustExist: Boolean = true): File = ws.resolve(path, mustExist)

    /** 文件工具的唯一写入口：read-only 直接拒绝，其余档位必须落在工作区内 */
    fun checkWrite(path: String): File = when (mode) {
        SandboxMode.READ_ONLY ->
            throw KernelError("沙箱为只读模式：拒绝写入 $path（切换到标准/完全授权后可用）")
        // READ_ONLY 之外只剩 workspace 语义；DANGER_FULL_ACCESS 不再放宽路径
        // （它的差异在「逐条确认」这一层，由 AgentConfig.needConfirm 决定）
        else -> ws.resolve(path)
    }

    fun checkDelete(path: String): File = when (mode) {
        SandboxMode.READ_ONLY -> throw KernelError("沙箱为只读模式：拒绝删除 $path")
        else -> ws.resolve(path, mustExist = true)
    }

    /**
     * 任一「本层无法做系统调用级限制」的执行体的统一入口：shell、常驻终端、
     * PTC 的 `dsh.exec`、清单插件处理器。
     *
     * read-only 下必须拒绝执行，而不是把 cwd 钉在工作区就当作限制住了 ——
     * 桌面同一条规矩：`partial` 的执行完整性不得被当成 `full` 使用。
     */
    fun checkExecutionSurface(what: String) {
        if (mode == SandboxMode.READ_ONLY) {
            throw KernelError(
                "沙箱为只读模式：本机无法对 $what 做系统调用级限制，" +
                    "因此不执行。需要执行请切到标准权限。"
            )
        }
    }

    /** shell 的边界（cwd/HOME/TMPDIR + 应用 UID），read-only 下直接拒绝执行 */
    fun checkShell(command: String) {
        if (mode == SandboxMode.READ_ONLY) {
            throw KernelError(
                "沙箱为只读模式：本机无法对 shell 做系统调用级限制，" +
                    "因此不执行命令（${command.take(120)}）。需要执行请切到标准权限。"
            )
        }
    }

    fun enforcementFor(tool: String): SandboxEnforcement =
        if (tool in PARTIAL_SURFACES) SandboxEnforcement.PARTIAL else SandboxEnforcement.FULL

    /** 给设置页/调试看的自述：后端、模式、逐项执行完整性 */
    fun describe(): JSONObject = JSONObject().apply {
        put("backend", BACKEND)
        put("mode", modeName(mode))
        put("workspaceRoot", ws.rootPath)
        put("fs", enforcementFor("read").name.lowercase())
        put("shell", enforcementFor("bash").name.lowercase())
        // 逐项完整性：界面据此显示「哪些能力只是入口约束」，不再一句「沙箱已开启」糊过去
        put("surfaces", JSONObject().apply {
            PARTIAL_SURFACES.sorted().forEach { put(it, "partial") }
            put("read", "full")
            put("write", "full")
            put("delete", "full")
        })
        put("note", if (mode == SandboxMode.DANGER_FULL_ACCESS)
            "完全访问：不再逐条确认；文件效果仍以工作区为根（与标准档一致），" +
                "shell/终端/代码运行时在应用 UID 下可触达应用可见的任何位置"
        else
            "Android UID/SELinux 提供应用级隔离；文件效果由进程内策略判定，" +
                "shell/终端/代码运行时仅限 cwd/环境（partial）")
    }
}
