package ai.deepseek.harness.mobile.kernel.plugin.builtin.fs

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.KernelRuntime
import ai.deepseek.harness.mobile.kernel.Workspace
import ai.deepseek.harness.mobile.kernel.jobs.JobRegistry
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.exitCodeOfHeader
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickLong
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 语言运行时插件（全本机执行环境计划 · 阶段 A2）。
 *
 * 桌面 harness 没有 python/node 工具（桌面的 run_code 是 PTC 编排，程序内调
 * tools.*，不是通用语言运行时），所以这两个工具是手机端**新增**能力，schema
 * 由本插件定义；`bash` 已由 [ShellPlugin] 与桌面同名同参，不在此重复。
 *
 * - 执行走 [KernelRuntime] 双底座解析（nativeLibraryDir 静态二进制 → proot Alpine）；
 * - 运行时缺失返回结构化 `NEED_RUNTIME`（计划 §5 协议），阶段 B 前端据此弹下载卡片；
 * - read-only 档直接拒绝执行（partial 完整性，与 bash 同规矩）；
 * - `run_in_background` 与 bash 同款：JobRegistry 后台任务 + job_output/job_kill。
 */
class RuntimePlugin : KernelPlugin {
    override val id = "runtime"
    override val name = "语言运行时"
    override val description = "本机执行 python / node 脚本（运行时按需供给，缺失返回 NEED_RUNTIME）"
    override val version = "1.0.0"

    private var runtime: KernelRuntime? = null
    private var sandbox: WorkspaceSandbox? = null
    private var ws: Workspace? = null
    private var ctxRef: PluginContext? = null
    private var calls = 0

    override fun onLoad(ctx: PluginContext) {
        ctxRef = ctx
        sandbox = ctx.sandbox
        ws = ctx.workspace
        runtime = KernelRuntime(ctx.workspace, ctx.service("app.context") as? android.content.Context)
        // 其它插件（app_build）要在 guest 里跑 java 工具，共用同一个运行时实例，
        // 不另起一套 proot 参数（M1 定的「单一执行入口」）
        runtime?.let {
            ctx.provide("runtime.kernel", it)
            // 执行内存探针的执行入口：JvmStartupJitter 的报错文案要附判别证据时经这里跑
            ai.deepseek.harness.mobile.kernel.terminal.ExecProbe.reporter = { it.execProbeReport() }
        }
        // 后台预解 rootfs：把首次 python/node 调用的解包时间藏进应用启动路径
        runtime?.warmup()
    }

    override fun onUnload() {
        runtime = null
        sandbox = null
        ws = null
        ctxRef = null
    }

    override fun status(): Map<String, String> {
        val rt = runtime
        val label = when (rt?.prootStage()) {
            "READY" -> "可用（proot 底座）"
            "STAGED" -> "已内置（启动时后台准备，完成后可用）"
            "SDK_UNSUPPORTED" -> "标准版不支持（完整版安装包可用）"
            else -> "该架构未内置"
        }
        return mapOf(
            "调用次数" to calls.toString(),
            "python" to label,
            "node" to label,
            "gcc/g++" to label,
            // 基础环境之外的组件：装了就能用，没装就按需联网装（pkg 工具）
            "按需组件" to when (rt?.prootStage()) {
                "READY" -> listOf("java", "rustc", "cargo").joinToString(" / ") {
                    if (rt.guestEntryBaked(PROOT_ENTRY_ENTRY[it] ?: it)) "$it ✓" else "$it ·未装"
                }
                "STAGED" -> "待解包后判定"
                "SDK_UNSUPPORTED" -> "标准版不支持"
                else -> "—"
            },
        )
    }

    /** 按需组件的 guest 入口（status 展示用，不触发解包） */
    private val PROOT_ENTRY_ENTRY: Map<String, String> = mapOf(
        "java" to "/usr/bin/java",
        "rustc" to "/usr/bin/rustc",
        "cargo" to "/usr/bin/cargo",
    )

    private val impl: KernelRuntime get() = runtime ?: error("运行时插件未加载")

    override val tools: List<ToolSpec> = listOf(
        runtimeTool(
            "python", "py",
            "执行 Python 3 脚本（本机运行时，工作区为当前目录）。适合数据处理、文本处理、" +
                "调用标准库。环境不可用时返回 NEED_RUNTIME 及原因。",
        ),
        runtimeTool(
            "node", "js",
            "执行 Node.js 脚本（本机运行时，工作区为当前目录）。适合 JS 工具链、" +
                "文本/JSON 处理。环境不可用时返回 NEED_RUNTIME 及原因。",
        ),
        compileTool(),
        runTool(),
        javaTool(),
        rustcTool(),
        pkgTool(),
    )

    private fun runtimeTool(name: String, ext: String, langDesc: String): ToolSpec = SimpleTool(
        name = name,
        description = "$langDesc code 与 file 二选一。" +
            "run_in_background=true 时立即返回 job id，再用 job_output 收集输出、job_kill 终止。",
        parameters = Schemas.params(
            mapOf(
                "description" to Schemas.prop("string", "一句话说明这段代码做什么（5-10 个字，显示在界面上）"),
                "code" to Schemas.prop("string", "要执行的 $name 源码（与 file 二选一）"),
                "file" to Schemas.prop("string", "工作区内脚本文件的相对路径（与 code 二选一）"),
                "args" to Schemas.prop("array", "传给脚本的命令行参数（字符串数组）"),
                "timeoutMs" to Schemas.prop("number", "超时毫秒数，默认 20000，最大 120000"),
                "run_in_background" to Schemas.prop("boolean", "后台执行，立即返回 job id"),
            ),
            listOf("description"),
        ),
        exitHeader = true,
    ) { a ->
        calls++
        val rt = impl
        val sb = sandbox ?: error("沙箱未装配")
        val workspace = ws ?: error("工作区未就绪")
        // partial 完整性：read-only 拒绝执行，与 bash 同一条规矩
        sb.checkExecutionSurface(name)

        val script: File = if (a.has("code") && a.optString("code").isNotBlank()) {
            // code 落到工作区内的暂存脚本（.dsh/tmp），模型后续可再引用/修改
            val dir = File(workspace.root, ".dsh/tmp")
            dir.mkdirs()
            File(dir, "$name-${System.currentTimeMillis()}.$ext").apply { writeText(a.getString("code")) }
        } else {
            val rel = a.pick("file", "path")
            if (rel.isBlank()) throw KernelError("$name 需要 code 或 file 参数")
            sb.resolveRead(rel, mustExist = true)
        }

        val args = mutableListOf<String>()
        (a.opt("args") as? JSONArray)?.let { ja ->
            for (i in 0 until ja.length()) args.add(ja.opt(i)?.toString() ?: "")
        }
        val timeout = a.pickLong("timeoutMs", default = KernelRuntime.TIMEOUT_MS)
            .coerceIn(1_000L, 120_000L)

        if (a.optBoolean("run_in_background")) {
            val reg = jobRegistry()
                ?: throw KernelError("后台任务服务未装配，无法后台执行；请去掉 run_in_background")
            val label = a.pick("description").ifBlank { "$name 脚本" }
            val job = reg.start(label) { j ->
                val out = rt.exec(name, script, args, 6 * 3_600_000L, onStart = { p ->
                    // 让 job_kill 能杀整棵进程树，而不是只留一堆孙进程
                    j.cancel = { rt.killTree(p) }
                })
                j.append(out)
                exitCodeOfHeader(out) ?: -1
            }
            JSONObject().put("job_id", job.id).put("name", job.name)
                .put("note", "后台运行中；用 job_output 收集、job_kill 终止").toString()
        } else {
            rt.exec(name, script, args, timeout)
        }
    }

    private fun jobRegistry(): JobRegistry? = ctxRef?.service("job.registry") as? JobRegistry

    /**
     * compile：C/C++ 源文件 → 工作区可执行文件。语言 → 工具链映射：
     * .c → gcc，.cpp/.cc/.cxx/.c++ → g++。产物默认与源同名去扩展名。
     * 底座：proot Alpine（gcc/g++ 都在 rootfs 内），标准版回 NEED_RUNTIME。
     */
    private fun compileTool(): ToolSpec = SimpleTool(
        name = "compile",
        description = "编译 C/C++ 源文件为本机可执行文件（gcc/g++）。" +
            ".c 走 gcc，.cpp/.cc/.cxx/.c++ 走 g++。产物落在工作区，用 run 工具执行。",
        parameters = Schemas.params(
            mapOf(
                "description" to Schemas.prop("string", "一句话说明在编译什么（5-10 个字）"),
                "file" to Schemas.prop("string", "源文件的相对路径（.c/.cpp/.cc/.cxx）"),
                "out" to Schemas.prop("string", "输出可执行文件名，默认与源文件同名去扩展名"),
                "flags" to Schemas.prop("array", "额外编译参数，如 [\"-O2\",\"-std=c++17\"]"),
                "timeoutMs" to Schemas.prop("number", "超时毫秒数，默认 60000，最大 120000"),
            ),
            listOf("description", "file"),
        ),
        exitHeader = true,
    ) { a ->
        calls++
        val rt = impl
        val sb = sandbox ?: error("沙箱未装配")
        val workspace = ws ?: error("工作区未就绪")
        sb.checkExecutionSurface("compile")

        val src = sb.resolveRead(a.pick("file", "path"), mustExist = true)
        val compiler = when (src.extension.lowercase()) {
            "c" -> "gcc"
            "cpp", "cc", "cxx", "c++" -> "g++"
            else -> throw KernelError(
                "无法识别的 C/C++ 扩展名：.${src.extension}（支持 .c/.cpp/.cc/.cxx/.c++）"
            )
        }
        val outName = a.pick("out").ifBlank {
            src.nameWithoutExtension.ifBlank { "a.out" }
        }
        // 产物必须落在工作区（走写入口判定，防路径逃逸；read-only 在这里就被拒）
        val outFile = sb.checkWrite(outName)
        val outRel = outFile.relativeTo(workspace.root).invariantSeparatorsPath
        val flags = mutableListOf<String>()
        (a.opt("flags") as? JSONArray)?.let { ja ->
            for (i in 0 until ja.length()) flags.add(ja.opt(i)?.toString() ?: "")
        }
        val timeout = a.pickLong("timeoutMs", default = 60_000L).coerceIn(1_000L, 120_000L)

        rt.exec(compiler, src, listOf("-o", outRel) + flags, timeout)
    }

    /**
     * run：执行工作区内的可执行文件（compile 产物或任意 guest 二进制），
     * 经 proot 底座在 rootfs 环境里跑。exec 位缺失自动 chmod +x 重试一次。
     */
    private fun runTool(): ToolSpec = SimpleTool(
        name = "run",
        description = "运行工作区内的可执行文件（compile 的产物，或其它本机二进制/脚本）。" +
            "run_in_background=true 时立即返回 job id，再用 job_output 收集输出。",
        parameters = Schemas.params(
            mapOf(
                "description" to Schemas.prop("string", "一句话说明在运行什么（5-10 个字）"),
                "file" to Schemas.prop("string", "可执行文件的相对路径"),
                "args" to Schemas.prop("array", "传给程序的命令行参数（字符串数组）"),
                "timeoutMs" to Schemas.prop("number", "超时毫秒数，默认 20000，最大 120000"),
                "run_in_background" to Schemas.prop("boolean", "后台执行，立即返回 job id"),
            ),
            listOf("description", "file"),
        ),
        exitHeader = true,
    ) { a ->
        calls++
        val rt = impl
        val sb = sandbox ?: error("沙箱未装配")
        sb.checkExecutionSurface("run")

        val bin = sb.resolveRead(a.pick("file", "path"), mustExist = true)
        val rel = bin.relativeToOrNull(ws?.root ?: bin)
            ?: throw KernelError("可执行文件必须在工作区内：${bin.path}")
        val guestPath = "/workspace/" + rel.invariantSeparatorsPath
        val args = mutableListOf<String>()
        (a.opt("args") as? JSONArray)?.let { ja ->
            for (i in 0 until ja.length()) args.add(ja.opt(i)?.toString() ?: "")
        }
        val timeout = a.pickLong("timeoutMs", default = KernelRuntime.TIMEOUT_MS)
            .coerceIn(1_000L, 120_000L)

        fun once(): String {
            var out = rt.guestExec(guestPath, args, timeout)
            // exec 位缺失（打包/传输丢位）：guest 内补一次 chmod +x 再试
            if (out.startsWith("exit=126") || out.contains("Permission denied")) {
                rt.guestExec("/bin/sh", listOf("-c", "chmod +x '$guestPath'"), 5_000L)
                out = rt.guestExec(guestPath, args, timeout)
            }
            return out
        }

        if (a.optBoolean("run_in_background")) {
            val reg = jobRegistry()
                ?: throw KernelError("后台任务服务未装配，无法后台执行；请去掉 run_in_background")
            val label = a.pick("description").ifBlank { "运行 ${bin.name}" }
            val job = reg.start(label) { j ->
                val out = rt.guestExec(guestPath, args, 6 * 3_600_000L, onStart = { p ->
                    j.cancel = { rt.killTree(p) }
                })
                j.append(out)
                exitCodeOfHeader(out) ?: -1
            }
            JSONObject().put("job_id", job.id).put("name", job.name)
                .put("note", "后台运行中；用 job_output 收集、job_kill 终止").toString()
        } else {
            once()
        }
    }

    private fun strList(a: JSONObject, key: String): List<String> {
        val out = mutableListOf<String>()
        (a.opt(key) as? JSONArray)?.let { ja ->
            for (i in 0 until ja.length()) out.add(ja.opt(i)?.toString() ?: "")
        }
        return out
    }

    /**
     * java：运行工作区内的 jar（OpenJDK 21 headless 已内置 rootfs）。
     * 只有 JRE 没有编译器（jre-headless 不含 jdk.compiler），所以只收 jar；
     * 源码编译需要 JDK 扩展包。flags 直通 JVM（-Xmx/-D/-cp 等）。
     */
    private fun javaTool(): ToolSpec = SimpleTool(
        name = "java",
        description = "运行工作区内的 jar（OpenJDK 21）。只支持 jar（内置的是 headless JRE，" +
            "无源码编译器）。flags 可传 JVM 参数（如 -Xmx256m）。",
        parameters = Schemas.params(
            mapOf(
                "description" to Schemas.prop("string", "一句话说明在运行什么（5-10 个字）"),
                "file" to Schemas.prop("string", "jar 的相对路径"),
                "flags" to Schemas.prop("array", "JVM 参数（-jar 之前），如 [\"-Xmx256m\"]"),
                "args" to Schemas.prop("array", "传给 main 的命令行参数"),
                "timeoutMs" to Schemas.prop("number", "超时毫秒数，默认 20000，最大 120000"),
                "run_in_background" to Schemas.prop("boolean", "后台执行，立即返回 job id"),
            ),
            listOf("description", "file"),
        ),
        exitHeader = true,
    ) { a ->
        calls++
        val rt = impl
        val sb = sandbox ?: error("沙箱未装配")
        sb.checkExecutionSurface("java")

        val jar = sb.resolveRead(a.pick("file", "path"), mustExist = true)
        val rel = jar.relativeToOrNull(ws?.root ?: jar)
            ?: throw KernelError("jar 必须在工作区内：${jar.path}")
        val guestPath = "/workspace/" + rel.invariantSeparatorsPath
        val guestArgs = strList(a, "flags") + listOf("-jar", guestPath) + strList(a, "args")
        val timeout = a.pickLong("timeoutMs", default = KernelRuntime.TIMEOUT_MS)
            .coerceIn(1_000L, 120_000L)

        if (a.optBoolean("run_in_background")) {
            val reg = jobRegistry()
                ?: throw KernelError("后台任务服务未装配，无法后台执行；请去掉 run_in_background")
            val job = reg.start(a.pick("description").ifBlank { "运行 ${jar.name}" }) { j ->
                val out = runJava(rt, guestArgs, 6 * 3_600_000L) { p ->
                    j.cancel = { rt.killTree(p) }
                }
                j.append(out)
                exitCodeOfHeader(out) ?: -1
            }
            JSONObject().put("job_id", job.id).put("name", job.name)
                .put("note", "后台运行中；用 job_output 收集、job_kill 终止").toString()
        } else {
            runJava(rt, guestArgs, timeout)
        }
    }

    /**
     * 启动 JVM。proot 下 HotSpot 偶发在 VM 初始化阶段 mprotect(PROT_EXEC) 失败
     * （"Failed to mark memory page as executable"），实测 ~40% 概率，与参数无关
     * （-Xint / -Xshare:off 都不改变）。这类失败发生在**用户代码执行之前**，
     * 重试是安全的；其他错误一律不重试（不掩盖真实问题）。
     */
    private fun runJava(
        rt: KernelRuntime,
        guestArgs: List<String>,
        timeoutMs: Long,
        onStart: ((Process) -> Unit)? = null,
    ): String {
        var last = ""
        repeat(3) { attempt ->
            last = rt.guestExec("/usr/bin/java", guestArgs, timeoutMs, onStart)
            val vmStartFail = last.contains("Failed to mark memory page as executable")
            if (!vmStartFail) return last
            if (attempt < 2) Thread.sleep(120)
        }
        return last.trimEnd() + "\n[提示] JVM 在 proot 下启动 3 次均失败（exec 内存映射被拒）；" +
            "这不是代码问题。连续确定性失败时请看 JvmStartupJitter.advice 附带的执行内存探针判决" +
            "（终端报错里会带 [执行内存探针] 段落），按判决的结论向用户说明。"
    }

    /**
     * rustc：编译 .rs 源为可执行文件（rust 扩展位）。载荷未内置时回 NEED_RUNTIME ——
     * 按同一条 rootfs 管线把 rust/cargo 追加进载荷即可点亮，无需改代码。
     */
    private fun rustcTool(): ToolSpec = SimpleTool(
        name = "rustc",
        description = "编译 Rust 源文件为本机可执行文件（rust 扩展语言包）。" +
            "环境未内置时返回 NEED_RUNTIME；产物用 run 工具执行。",
        parameters = Schemas.params(
            mapOf(
                "description" to Schemas.prop("string", "一句话说明在编译什么（5-10 个字）"),
                "file" to Schemas.prop("string", ".rs 源文件的相对路径"),
                "out" to Schemas.prop("string", "输出可执行文件名，默认与源文件同名去扩展名"),
                "flags" to Schemas.prop("array", "额外 rustc 参数，如 [\"-O\"]"),
                "timeoutMs" to Schemas.prop("number", "超时毫秒数，默认 60000，最大 120000"),
            ),
            listOf("description", "file"),
        ),
        exitHeader = true,
    ) { a ->
        calls++
        val rt = impl
        val sb = sandbox ?: error("沙箱未装配")
        val workspace = ws ?: error("工作区未就绪")
        sb.checkExecutionSurface("rustc")

        val src = sb.resolveRead(a.pick("file", "path"), mustExist = true)
        if (!src.name.endsWith(".rs")) {
            throw KernelError("rustc 只接受 .rs 源文件：${src.name}")
        }
        val outName = a.pick("out").ifBlank {
            src.nameWithoutExtension.ifBlank { "a.out" }
        }
        val outFile = sb.checkWrite(outName)
        val outRel = outFile.relativeTo(workspace.root).invariantSeparatorsPath
        val timeout = a.pickLong("timeoutMs", default = 60_000L).coerceIn(1_000L, 120_000L)

        rt.exec("rustc", src, listOf("-o", outRel) + strList(a, "flags"), timeout)
    }

    /**
     * pkg：基础环境里的包管理器入口（apk / pip / npm）。
     *
     * 这是「自造自给」的通道：APK 只带基础环境（python/node/gcc/g++/busybox），
     * 具体语言/库由用户或智能体按需联网安装 —— 装完 java/rustc 等工具自动点亮
     * （它们只查 guest 内的入口是否存在），不需要改代码、不需要重新出包。
     */
    private fun pkgTool(): ToolSpec = SimpleTool(
        name = "pkg",
        description = "在本机 Alpine 基础环境里安装/删除软件包（需要联网）。" +
            "manager=apk（系统包，如 add rust / add openjdk21-jre-headless）、" +
            "pip（Python 包）、npm（Node 全局包）。装好后对应工具与命令立即可用。",
        parameters = Schemas.params(
            mapOf(
                "description" to Schemas.prop("string", "一句话说明装什么（5-10 个字）"),
                "manager" to Schemas.prop("string", "包管理器：apk（默认）/ pip / npm"),
                "args" to Schemas.prop("array", "原样传给包管理器的参数，如 [\"add\",\"rust\"]"),
                "proxy" to Schemas.prop("string", "可选 HTTP 代理（如 http://10.0.2.2:8791）；仅受限网络调试用"),
                "timeoutMs" to Schemas.prop("number", "超时毫秒数，默认 180000，最大 900000"),
                "run_in_background" to Schemas.prop("boolean", "后台执行，立即返回 job id"),
            ),
            listOf("description", "args"),
        ),
        exitHeader = true,
    ) { a ->
        calls++
        val rt = impl
        val sb = sandbox ?: error("沙箱未装配")
        sb.checkExecutionSurface("pkg")

        val manager = a.pick("manager").ifBlank { "apk" }.lowercase()
        val argv = strList(a, "args")
        if (argv.isEmpty()) throw KernelError("pkg 需要 args，例如 [\"add\",\"rust\"]")
        val entry = when (manager) {
            "apk" -> "/sbin/apk"
            "pip", "pip3" -> "/usr/bin/pip3"
            "npm" -> "/usr/bin/npm"
            else -> throw KernelError("不支持的包管理器：$manager（可用 apk / pip / npm）")
        }
        val timeout = a.pickLong("timeoutMs", default = 180_000L).coerceIn(10_000L, 900_000L)
        val proxy = a.pick("proxy").trim()
        val env = if (proxy.isBlank()) emptyMap() else mapOf(
            "http_proxy" to proxy, "https_proxy" to proxy,
            "HTTP_PROXY" to proxy, "HTTPS_PROXY" to proxy,
        )
        // guest 的 /etc/resolv.conf 由 KernelRuntime.prepareProotRootfs() 在 rootfs 就绪后
        // 统一注入（所有 guest 路径都经过那里），这里不要再按 manager 分支补一次：
        // 以前只在 apk 分支调、且排在解包之前，冷启动首次根本补不上，pip/npm/终端全漏。
        if (a.optBoolean("run_in_background")) {
            val reg = jobRegistry()
                ?: throw KernelError("后台任务服务未装配，无法后台执行；请去掉 run_in_background")
            val label = a.pick("description").ifBlank { "安装 ${argv.joinToString(" ")}" }
            val job = reg.start(label) { j ->
                val out = rt.guestExec(entry, argv, 6 * 3_600_000L, onStart = { p ->
                    j.cancel = { rt.killTree(p) }
                }, extraEnv = env)
                j.append(out)
                exitCodeOfHeader(out) ?: -1
            }
            JSONObject().put("job_id", job.id).put("name", job.name)
                .put("note", "后台安装中；用 job_output 收集、job_kill 终止").toString()
        } else {
            rt.guestExec(entry, argv, timeout, extraEnv = env)
        }
    }
}
