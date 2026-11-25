package ai.deepseek.harness.mobile.kernel.plugin

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.Workspace
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 外部清单插件：不用重新编译 APK，也不用 Node/JVM 运行时，
 * 往 `kernel/plugins/<id>.json` 放一份清单，就能给 Agent 增加一个工具。
 *
 * 清单示例：
 * ```json
 * {
 *   "id": "word-count",
 *   "name": "字数统计",
 *   "description": "统计文本文件的行数/词数",
 *   "command": "wc -l -w \"$1\"",     // 用 sh -c 执行；参数 JSON 从 stdin 传入
 *   "tools": [{
 *     "name": "word_count",
 *     "description": "统计文件行数与词数",
 *     "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
 *   }]
 * }
 * ```
 *
 * 约定：stdin 收到工具参数的 JSON，stdout 作为工具输出；退出码非 0 视为失败。
 * 命令跑在工作区、15 秒超时、输出截断，和内置 bash 工具的限制保持一致。
 *
 * ## 信任模型（WP4a 修正，对齐桌面 cordis-host-runner）
 *
 * 桌面让模型自造代码时：**激活要人类批准**（`cordis-host-runner/src/index.ts:295-321`），
 * 激活后拿到的是**白名单 ctx**（只有 inject 声明过的服务可达，`guard.ts:709-744`），
 * 工具注册走受校验的 façade（`guard.ts:551,626`）。手机端清单插件对齐为三条：
 *
 * 1. **不能自声明只读**：`"readOnly": true` 不再被读取，动态工具一律按写操作对待
 *    （`ToolCatalog.registerDynamic`）。旧行为等于让清单给自己发权限。
 * 2. **只读档整体拒绝执行**：shell 与 JS 处理器都是「本层拦不住」的能力，
 *    只读档直接拒绝（`Sandbox.checkExecutionSurface`），不假装被限制住了。
 * 3. **只能拿声明过的服务、不能 provide**：实现 [PluginRegistry.DeclaresServices]，
 *    服务名必须同时出现在清单 `services` 与 [PluginRegistry.MANIFEST_SAFE_SERVICES]。
 *
 * 另外参数里「像路径」的键统一过 `checkWrite`，堵住「插件用参数绕开 Workspace」这条旁路。
 */
class ManifestPlugin(
    private val manifest: JSONObject,
    private val file: File,
) : KernelPlugin, PluginRegistry.DeclaresServices {

    companion object {
        private const val TIMEOUT_MS = 15_000L
        private const val MAX_OUTPUT = 64 * 1024

        /**
         * 参数名像路径的键。只处理这些键，避免把 `query`/`text` 这类普通字符串
         * 误当路径改写（那会让插件收到与模型给出的不同的值）。
         */
        private val PATH_ARG = Regex(
            "(?i)^(path|file|file_path|filepath|dir|directory|folder|" +
                "src|source|dest|destination|target|output|output_path|from|to)$"
        )
    }

    override val id: String = manifest.optString("id").ifBlank { file.nameWithoutExtension }
    override val name: String = manifest.optString("name").ifBlank { id }
    override val description: String = manifest.optString("description")
    override val version: String = manifest.optString("version", "0.1.0")
    override val builtin: Boolean = false

    /** handler=shell（默认，command 走 sh -c）或 js（code 在 V8 里跑，params 注入 dsh.args） */
    private val handler: String = manifest.optString("handler", "shell").lowercase()
    private val command: String = manifest.optString("command")
    private val code: String = manifest.optString("code")
    private var ptc: ai.deepseek.harness.mobile.kernel.ptc.PtcRuntime? = null
    private var ws: Workspace? = null
    private var sandbox: WorkspaceSandbox? = null
    private var calls = 0
    private var lastError: String = ""

    /**
     * 清单声明的服务（白名单交集）。
     *
     * `ptc.runtime` 是 handler=js 的**实现依赖**，由这里显式声明而不是默认开放；
     * 清单想用别的服务必须在 `services` 里写出来，且只能命中内核白名单 ——
     * 危险服务（plugin.registry / plugin.dir / kernel.facade / agent.runtime …）
     * 即使写进清单也拿不到。
     */
    override fun declaredServices(): Set<String> {
        val out = mutableSetOf<String>()
        if (handler == "js") out += "ptc.runtime"
        (manifest.optJSONArray("services") ?: JSONArray()).let { arr ->
            for (i in 0 until arr.length()) {
                val n = arr.optString(i).trim()
                if (n.isNotEmpty() && n in PluginRegistry.MANIFEST_SAFE_SERVICES) out += n
            }
        }
        return out
    }

    override fun onLoad(ctx: PluginContext) {
        ws = ctx.workspace
        sandbox = ctx.sandbox
        // 工具性质不再由清单声明：动态登记一律按写操作对待。
        // 旧实现把清单里的 "readOnly": true 直通到 ToolCatalog —— 一个声明就等于一次越权。
        tools.forEach { spec -> ToolCatalog.registerDynamic(spec.name) }
        if (handler == "js") {
            ptc = ctx.service("ptc.runtime") as? ai.deepseek.harness.mobile.kernel.ptc.PtcRuntime
            ctx.log("外部插件 $id 已挂载：JS 处理器（${code.length} 字符）")
        } else {
            ctx.log("外部插件 $id 已挂载：$command")
        }
    }

    override fun onUnload() {
        ws = null
        sandbox = null
        tools.forEach { ToolCatalog.unregisterDynamic(it.name) }
    }

    override fun status(): Map<String, String> = buildMap {
        put("命令", command.take(60))
        put("调用次数", calls.toString())
        put("清单", file.name)
        if (lastError.isNotBlank()) put("最近错误", lastError.take(80))
    }

    override val tools: List<ToolSpec> = buildList {
        val arr = manifest.optJSONArray("tools") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val t = arr.optJSONObject(i) ?: continue
            val toolName = t.optString("name").ifBlank { "${id}_$i" }
            add(SimpleTool(
                name = toolName,
                description = t.optString("description", name),
                parameters = t.optJSONObject("parameters") ?: Schemas.params(emptyMap()),
            ) { args -> run(toolName, args) })
        }
    }

    /**
     * 清单可选的 `prompt` 字段：插件给系统提示贡献一段说明（桌面 Cordis 插件往
     * system-prompt waterfall 加段落的等价物）。「一切皆插件」要求自造插件除了工具
     * 还能说明自己的用法 —— 否则模型只看到工具 schema，不知道何时该用它。
     * 校验（存在且 ≤1500 字）在 [ai.deepseek.harness.mobile.kernel.plugin.builtin.fs.PluginRules]。
     */
    override fun promptSection(): String? =
        manifest.optString("prompt").takeIf { it.isNotBlank() }

    /** JS 处理器：V8 里跑 code，参数在 dsh.args / __pluginArgs，返回 {ok,value,logs} */
    private fun runJs(toolName: String, args: JSONObject): String {
        if (code.isBlank()) throw KernelError("插件 $id 没有配置 code")
        // 只读档先拒：JS 处理器能 dsh.exec（shell）、dsh.fs.write、dsh.http —— 与 shell 同级。
        // 这一步必须在「运行时是否装配」之前，否则只读档会因为别的错误码而看起来"可执行"。
        sandbox?.checkExecutionSurface("清单插件的 JS 处理器「$id」")
        val engine = ptc ?: throw KernelError("插件 $id 需要 JS 运行时，但当前部署没有装配")
        val safeArgs = sanitizeArgs(toolName, args)
        calls++
        val raw = try {
            engine.callHandler(code, safeArgs.toString())
        } catch (t: Throwable) {
            lastError = t.message ?: "执行失败"
            throw KernelError("插件 $id 执行失败：${t.message}")
        }
        val obj = runCatching { JSONObject(raw) }.getOrNull()
        if (obj == null) return raw.trim()
        if (!obj.optBoolean("ok", true)) {
            lastError = obj.optString("error", "")
            throw KernelError("插件 $id 出错：${obj.optString("error").take(600)}")
        }
        val value = obj.opt("value")
        val text = when (value) {
            null, JSONObject.NULL -> ""
            is String -> value
            else -> value.toString()
        }
        val logs = obj.optJSONArray("logs")
        val logText = if (logs == null || logs.length() == 0) "" else buildString {
            for (i in 0 until minOf(logs.length(), 60)) append(logs.optString(i)).append('\n')
        }
        return (text + if (logText.isNotBlank()) "\n[输出]\n$logText" else "").trim()
            .ifBlank { "（插件没有返回内容）" }
    }

    private fun run(toolName: String, args: JSONObject): String {
        if (handler == "js") return runJs(toolName, args)
        if (command.isBlank()) throw KernelError("插件 $id 没有配置 command")
        val workspace = ws ?: throw KernelError("插件 $id 未加载")
        // 清单插件等价任意命令执行，只有 cwd/环境这一层约束（partial）
        sandbox?.checkShell(command)
        val safeArgs = sanitizeArgs(toolName, args)
        calls++
        val pb = ProcessBuilder("/system/bin/sh", "-c", command)
            .directory(workspace.root)
            .redirectErrorStream(true)
        pb.environment().apply {
            put("DSH_WORKSPACE", workspace.rootPath)
            put("DSH_PLUGIN_ID", id)
            put("DSH_TOOL", toolName)
            // 参数同时给一份环境变量，命令不必非得读 stdin（手机上 sh 管道更省事）
            put("DSH_ARGS", safeArgs.toString())
            put("HOME", workspace.rootPath)
            put("PATH", "/system/bin:/system/xbin:/vendor/bin")
        }
        val proc = pb.start()
        try {
            proc.outputStream.use { it.write(safeArgs.toString().toByteArray()) }
        } catch (_: Throwable) {
            // 命令不读 stdin 时写管道可能提前关闭，不当作失败
        }
        val done = proc.waitFor(TIMEOUT_MS, TimeUnit.MILLISECONDS)
        if (!done) {
            proc.destroyForcibly()
            lastError = "超时"
            throw KernelError("插件命令超时（${TIMEOUT_MS / 1000}s）：$toolName")
        }
        val bytes = proc.inputStream.readBytes()
        val text = String(bytes, Charsets.UTF_8).let {
            if (it.length > MAX_OUTPUT) it.substring(0, MAX_OUTPUT) + "\n[输出超过 ${MAX_OUTPUT / 1024}KB，已截断]" else it
        }
        val code = proc.exitValue()
        if (code != 0) {
            lastError = "exit=$code"
            throw KernelError("插件命令失败（exit=$code）：${text.take(800)}")
        }
        return text.trimEnd().ifBlank { "（插件没有输出）" }
    }

    /**
     * 参数里的路径统一过沙箱写检查。
     *
     * 为什么必须有：清单插件的处理器拿到的是**原始参数**，`cat "$path"` 完全不经过
     * `Workspace.resolve` —— 于是插件成了绕过工作区边界的第二条写入路径。
     * 这里只处理名字像路径的键（[PATH_ARG]）：
     *  - 只读档 → 直接拒绝（插件不能借参数写盘）
     *  - 其余档 → 保证落在工作区内，并把规范化后的相对路径交给处理器
     *
     * `internal` 是为了让 JVM 单测能直接验证这条旁路（不需要真的起进程）。
     */
    internal fun sanitizeArgs(toolName: String, args: JSONObject): JSONObject {
        val sb = sandbox ?: return args
        val keys = paramKeys(toolName).filter { PATH_ARG.matches(it) }
        if (keys.isEmpty()) return args
        val out = JSONObject(args.toString())
        for (k in keys) {
            val v = out.optString(k)
            if (v.isBlank()) continue
            val resolved = sb.checkWrite(v)
            out.put(k, ws?.relative(resolved) ?: v)
        }
        return out
    }

    /** 某个工具在清单里声明的参数名集合（工具名的默认规则与 [tools] 完全一致）。 */
    private fun paramKeys(toolName: String): Set<String> {
        val arr = manifest.optJSONArray("tools") ?: return emptySet()
        for (i in 0 until arr.length()) {
            val t = arr.optJSONObject(i) ?: continue
            val n = t.optString("name").ifBlank { "${id}_$i" }
            if (n != toolName) continue
            val props = t.optJSONObject("parameters")?.optJSONObject("properties") ?: return emptySet()
            return props.keys().asSequence().toSet()
        }
        return emptySet()
    }
}

/** 从 kernel/plugins 下的清单 装配外部插件，坏清单只记日志、不阻塞内核启动 */
class ExternalPluginLoader(private val dir: File) {

    data class Result(val plugins: List<ManifestPlugin>, val errors: List<String>)

    fun load(): Result {
        val plugins = mutableListOf<ManifestPlugin>()
        val errors = mutableListOf<String>()
        if (!dir.exists()) return Result(plugins, errors)
        dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.sortedBy { it.name }?.forEach { f ->
            try {
                val obj = JSONObject(f.readText())
                if (obj.optString("id").isBlank()) {
                    errors.add("${f.name}：缺 id")
                } else if (obj.optJSONArray("tools")?.length() == 0) {
                    errors.add("${f.name}：没有 tools")
                } else {
                    plugins.add(ManifestPlugin(obj, f))
                }
            } catch (e: Exception) {
                errors.add("${f.name}：${e.message}")
            }
        }
        return Result(plugins, errors)
    }
}
