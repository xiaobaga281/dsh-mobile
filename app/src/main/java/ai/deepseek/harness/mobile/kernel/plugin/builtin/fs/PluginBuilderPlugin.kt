package ai.deepseek.harness.mobile.kernel.plugin.builtin.fs

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.ManifestPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.PluginRegistry
import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 自造插件 —— 让 Agent 自己写插件、现场装配、随时卸载。
 *
 * 手机上不可能动态加载 dex，但「清单插件」（`kernel/plugins/<id>.json`）本来就是给这个用的：
 * 一份 JSON 声明工具，处理器可以走 shell（`command`）或 JS（`code`，跑在 WebView 的 V8 里）。
 * 这个插件只做三件事：写清单、注册/卸载、列出已装。
 *
 * 装配是**当场生效**的：注册表里工具索引立刻多出/少掉那几个名字，下一轮对话模型就能看到。
 * 卸载会摘掉工具与钩子并删文件，重启也不会复活。
 */
/**
 * 清单与工具定义的纯校验规则（无 IO、无 Android 依赖，可 JVM 单测）。
 *
 * 抽出来的原因：plugin_create 里的校验是「模型一次装对」的全部保障，
 * 但它们埋在 250 行的 execute 里没有任何测试 —— 规范说「最多 8 个工具」
 * 代码却从不检查这类漂移，只有抽成纯函数 + 单测才能锁住。
 */
object PluginRules {
    val ID = Regex("^[a-z0-9_-]{2,40}$")
    val TOOL_NAME = Regex("^[a-z][a-z0-9_]{1,48}$")

    /** 与 PLUGIN_SPEC §2 一致：至少 1 个，最多 8 个 */
    const val MIN_TOOLS = 1
    const val MAX_TOOLS = 8

    /** 校验并规范化插件 id；非法时给出带原因的错误 */
    fun checkId(raw: String): String {
        val id = raw.trim().lowercase()
        if (!ID.matches(id)) {
            throw ai.deepseek.harness.mobile.kernel.KernelError(
                "插件 id 只能用小写字母/数字/-/_，2-40 字：$id",
            )
        }
        return id
    }

    /**
     * 校验工具定义数组，返回全部工具名。
     *
     * 每项必须有：合法 name（正则）、非空 description（模型按它决定要不要用这个工具，
     * 空描述注册出来模型只能瞎猜）、parameters 若给必须是 object（ManifestPlugin 的
     * probe 只挡「装配不出工具」，挡不住「装出的工具没法用」）。
     */
    fun checkToolDefs(tools: org.json.JSONArray): List<String> {
        val n = tools.length()
        if (n < MIN_TOOLS) throw ai.deepseek.harness.mobile.kernel.KernelError("tools 不能为空：至少给一个工具定义")
        if (n > MAX_TOOLS) throw ai.deepseek.harness.mobile.kernel.KernelError(
            "tools 最多 $MAX_TOOLS 个工具（规范 §2），现在有 $n 个：拆成多个插件或砍掉不核心的",
        )
        val names = ArrayList<String>(n)
        for (i in 0 until n) {
            val t = tools.optJSONObject(i)
                ?: throw ai.deepseek.harness.mobile.kernel.KernelError("第 ${i + 1} 个工具不是对象")
            val toolName = t.optString("name").trim()
            if (toolName.isBlank()) throw ai.deepseek.harness.mobile.kernel.KernelError("第 ${i + 1} 个工具缺 name")
            if (!TOOL_NAME.matches(toolName)) {
                throw ai.deepseek.harness.mobile.kernel.KernelError("工具名要小写字母开头，只用 a-z0-9_：$toolName")
            }
            if (t.optString("description").isBlank()) {
                throw ai.deepseek.harness.mobile.kernel.KernelError(
                    "工具 $toolName 缺 description：模型按它决定何时调用，空描述的工具等于不可用",
                )
            }
            val params = t.opt("parameters")
            if (params != null && params !is org.json.JSONObject) {
                throw ai.deepseek.harness.mobile.kernel.KernelError(
                    "工具 $toolName 的 parameters 必须是 JSON Schema 对象（{\"type\":\"object\",...}）",
                )
            }
            names.add(toolName)
        }
        // 同一份清单里重名：register 只会保留第一个，返回却列两个，模型调用必 UNKNOWN_TOOL
        val dup = names.groupBy { it }.filterValues { it.size > 1 }.keys
        if (dup.isNotEmpty()) {
            throw ai.deepseek.harness.mobile.kernel.KernelError("tools 里有重名工具：${dup.joinToString("、")}")
        }
        return names
    }

    /** 校验可选的 prompt 段落：给了就必须是非空字符串且 ≤1500 字（防止清单把系统提示撑爆）。 */
    fun checkPrompt(manifest: org.json.JSONObject) {
        val prompt = manifest.opt("prompt") ?: return
        if (prompt !is String || prompt.isBlank()) {
            throw ai.deepseek.harness.mobile.kernel.KernelError("prompt 若提供必须是说明用途的非空字符串")
        }
        if (prompt.length > 1500) {
            throw ai.deepseek.harness.mobile.kernel.KernelError(
                "prompt 超长（${prompt.length} 字，上限 1500）：说明「这个插件何时用、怎么用」即可，" +
                    "长篇教程放到 description 或插件的输出里",
            )
        }
    }

    /** 工具名与已装配插件撞名检测（撞了注册表会跳过，模型以为装好了却调不到） */
    fun checkConflicts(mine: List<String>, existingElsewhere: Collection<String>) {
        val conflicts = mine.filter { it in existingElsewhere }
        if (conflicts.isNotEmpty()) {
            throw ai.deepseek.harness.mobile.kernel.KernelError("工具名已被其它插件占用：${conflicts.joinToString("、")}")
        }
    }
}

class PluginBuilderPlugin : KernelPlugin {
    override val id = "plugin-builder"

    /**
     * 手机端插件制造规范（v1）。
     *
     * 借鉴桌面 DSH 的两条硬规矩：
     *  1. `defineTool` 注册时**拒绝**缺 output/schema 声明的定义（见桌面 canonical-tool-output-contract）；
     *  2. 插件是「声明的能力」，不是「塞进来的代码」——手机端不能加载 dex，所以插件只能是
     *     一份 JSON 清单 + 两种受控处理器（V8 JS / sh）。
     *
     * 这份规范同时写到 `files/kernel/PLUGINS.md`（人看）并通过 `plugin_spec` 工具暴露给 Agent（机看）。
     */
    private val PLUGIN_SPEC = """
# 手机端插件制造规范（制造/装配/卸载前必读）

## 0. 边界（先读这条，别白费力气）
- 宿主 DSH Mobile 是预编译 APK：这台机器上**没有它的源码仓库和 Gradle 工程**，沙箱里只有应用私有数据目录。
- **不要**尝试反编译改字节码、重打包重签名、覆盖安装 —— 签名私钥不在本机，签名一变系统必拒装，这条路 100% 走不通。
- **也不要**找「改宿主」的邪路。宿主内核 API、新权限、新的系统交互都做不进清单插件 —— 它只能组合既有工具与沙箱能力。
- 清单插件能做的：用 dsh.fs / dsh.http / dsh.exec / await dsh.callTool 组合出**新工具**（能调用 phone_* 等全部既有工具）。
- 要改宿主本体（加内置工具、改内核行为、要新权限）：如实告诉用户「这需要人在电脑上改 dsh-mobile 源码重新发版」，插件侧做不到，不要空转。

## 1. 插件是什么
一份 JSON 清单，放在 `files/kernel/plugins/<id>.json`（应用私有目录，卸载应用即删除）。
手机端**不能加载 dex / 动态字节码**，所以插件只有两种受控处理器：
- `handler: "js"` — code 跑在 WebView 的 V8 里（推荐，能写逻辑）
- `handler: "shell"` — command 走 `/system/bin/sh -c`（适合包装现有命令）

**装配需要人类批准**（对齐桌面 cordis-host-runner 的 human-approved activation）：
- 只读权限下不能创建/激活插件（处理器等价任意代码，只读档没有能约束它的层）；
- 标准权限下每次创建/激活都会弹一次确认；无人值守（团队/后台）会被拒绝；
- 完全授权（danger-full-access）下不再逐条确认 —— 这是该档位的真实含义。
- 只读档插件工具整体不可用：`js`/`shell` 处理器都无法被系统调用级限制，因此直接拒绝执行。

## 2. 清单必填字段
{
  "id": "word-count",                  // ^[a-z0-9_-]{2,40}$，全局唯一
  "name": "字数统计",                   // 给人看的名字
  "description": "统计文本文件行数与词数", // 一句话说明用途
  "handler": "js",                     // "js" 或 "shell"
  "code": "...",                       // handler=js 时必填（见第 4 节）
  "command": "sh 命令",                // handler=shell 时必填（见第 5 节）
  "tools": [                           // 至少 1 个，最多 8 个工具
    {
      "name": "word_count",            // ^[a-z][a-z0-9_]{1,48}$，不得与内置工具重名
      "description": "统计文件行数与词数", // 写给模型看的用途说明
      // 注意：不要写 "readOnly" —— 工具性质不由清单决定（见第 3.5 节）
      "parameters": {                  // 合法 JSON Schema（模型按它生成参数）
        "type": "object",
        "properties": { "path": { "type": "string", "description": "相对工作区的路径" } },
        "required": ["path"]
      }
    }
  ]
}

## 3. 命名与冲突（最常见的翻车点）
- 工具名小写字母开头，只用 a-z0-9_；不要和内置工具同名（read/write/edit/bash/glob/grep/run_code/
  present/plugin_*/memory_*/sticker_*/image_generate/…）。撞名会被拒绝装配。
- id 会成为文件名，特殊字符会让清单写不进去。
- 想改插件：用同一个 id 再调一次 plugin_create（先卸载再装配，等于热更新）。

## 3.5 工具性质（readOnly 不再由清单决定）
清单里写 `"readOnly": true` **不会生效**：动态工具一律按写操作对待 ——
只读权限与计划模式下不可见、不可执行。
- 原因：清单的处理器是任意命令 / 任意 JS，能自己声明只读就等于自己发权限
  （审计里的只读绕过就是这么来的）。
- 想让工具成为只读，只能由内核维护者把它登记进 `ToolCatalog` 静态表并复核；
  **没有运行时自助通道**。
- 因此：需要只读跑的逻辑请做成内置工具，或接受「标准权限下才可用」。

## 3.6 服务声明（可选）
清单顶层可以写 `"services": ["job.registry"]`。只有**同时**满足两条才拿得到：
1. 名字写在这里；2. 名字在内核白名单 `PluginRegistry.MANIFEST_SAFE_SERVICES` 里。
白名单目前只有 `workspace.journal` / `job.registry` / `session.store` / `kernel.lsp` / `ptc.runtime`。
危险服务（`plugin.registry`、`plugin.dir`、`kernel.facade`、`agent.runtime`、`team.runtime`、
`app.context`）**即使写进清单也拿不到**，并且动态插件不允许 `provide` 服务。

## 3.7 提示词段落（可选，强烈建议）
清单顶层写 `"prompt": "…"`,插件就往**系统提示**贡献一段说明（每次装配都生效）——
告诉模型这个插件**何时用、参数怎么给、输出长什么样**。没有它,模型只看得到工具 schema,
经常不知道该调用。上限 1500 字;写清「何时用」比写长篇教程有用得多。

## 4. JS 处理器规则（handler=js）
code 是 **async 函数体**，可直接 await。可用：
- `dsh.args`            工具参数（已按 parameters 校验的 JSON）
- `dsh.fs.read/write/append/list/exists/remove/stat`    工作区内文件（相对路径）
- `dsh.fs.writeBase64/appendBase64/readBase64`          二进制（可自己拼 WAV/PNG/ZIP）
- `dsh.http({method,url,headers,body})` → {status,body} 原生发请求，无 CORS
- `dsh.exec(cmd)` → {code,out,ms}                       执行 shell
- `await dsh.callTool(name,args)`                       调其它工具：返回**工具输出原文**（与模型所见一致，phone_* 返回 JSON 串可直接 JSON.parse）；工具失败会 throw
- `dsh.workspace` / `dsh.sleep(ms)` / `console.log`（输出会回传给模型）
- `return` 的值就是工具结果
禁止：DOM、fetch/XMLHttpRequest、require/import、localStorage、顶层 await 函数外的阻塞循环。
硬限制：单次执行 30 秒超时；`globalThis` 跨调用保留但不要依赖；出错直接 throw（消息会作为失败原因）。

## 5. shell 处理器规则（handler=shell）
- stdin 收到工具参数的 JSON；stdout 作为工具结果；退出码非 0 即失败。
- 环境变量：DSH_WORKSPACE（工作区绝对路径）、DSH_PLUGIN_ID、DSH_TOOL、DSH_ARGS（参数 JSON）。
- cwd = 工作区；15 秒超时；输出超过 64KB 截断。
- 安卓没有 coreutils，只有 toybox：ls/cat/cp/mv/rm/mkdir/grep/sed/find/du/tar 等；
  python/node/ffmpeg 不存在，别写依赖它们的命令。

## 6. 输出约定（照搬桌面 canonical tool output）
- 工具结果必须是**面向模型的短文本**：成功给结论，失败给原因，≤2000 字。
- 不要把原始大 JSON、二进制、整份文件内容倒回给模型；要摘要。
- 失败时 throw 明确原因（缺文件/参数不对/超时），模型才能自己修。

## 7. 生命周期
- 装配 = plugin_create（写清单 + 立即注册，工具当场可用）
- 卸载 = plugin_uninstall（摘工具 + 删清单，重启也不会复活）
- plugin_list 看已装配/未装配；plugin_install 重新装配或启用未装配的清单
- 插件清单在应用私有目录：卸载 App 时连插件一起删除，不进云备份

## 8. 最小可用示例
js 版：
{ "id":"md-lines","name":"MD 行数","description":"统计 markdown 行数","handler":"js",
  "code":"const t = dsh.fs.read(dsh.args.path); return String(t.split('\\n').length) + ' 行';",
  "tools":[{"name":"md_lines","description":"统计 markdown 行数","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}] }

shell 版：
{ "id":"wc","name":"字数统计","description":"wc 包装","handler":"shell",
  "command":"wc -l -w \"${'$'}DSH_WORKSPACE/${'$'}1\"",
  "tools":[{"name":"wc_lines","description":"统计行数词数","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}] }
（shell 版注意：参数从 stdin JSON 来，命令里用 jq 不可用，简单场景用 ${'$'}DSH_ARGS 或位置参数即可）
""".trimIndent()
    override val name = "自造插件"
    override val description = "让 Agent 写插件清单、装配成工具、随时卸载"
    override val version = "1.0.0"

    /**
     * 常驻提示：不写这段，模型被要求「扩展 dsh 能力」时会去反编译 APK / 找源码 ——
     * 那是死路（无源码、无签名私钥），烧掉几十轮才承认失败。三行把它拉回清单插件。
     */
    override fun promptSection(): String? = """
        |扩展本应用（DSH Mobile）能力的唯一通道是清单插件：先 plugin_spec 读规范，再 plugin_create 装配，
        |装完当轮即可调用、可调 dsh.callTool 组合全部既有工具（含 phone_*）。
        |宿主是预编译 APK：没有源码、没有签名私钥，反编译改包必然无法覆盖安装，不要尝试；
        |要改宿主内核 / 加权限，如实告诉用户「需在电脑上改 dsh-mobile 源码重新发版」。
    """.trimMargin()

    private var ctx: PluginContext? = null
    private var calls = 0

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        // 规范同时落一份到磁盘：人要看的时候不用抓 log
        runCatching {
            val dir = (ctx.service("plugin.dir") as? java.io.File)?.parentFile ?: ctx.workspace.root
            val md = java.io.File(dir, "PLUGINS.md")
            if (!md.exists()) md.writeText(PLUGIN_SPEC, Charsets.UTF_8)
        }
    }
    override fun onUnload() { ctx = null }

    override fun status(): Map<String, String> = mapOf("调用次数" to calls.toString())

    private fun registry(): PluginRegistry =
        ctx?.service("plugin.registry") as? PluginRegistry
            ?: throw KernelError("插件注册表未就绪")

    private fun pluginDir(): File =
        (ctx?.service("plugin.dir") as? File) ?: throw KernelError("插件目录未就绪")

    /**
     * 插件激活的信任闸门（对齐桌面 cordis-host-runner 的 human-approved activation，
     * `packages/extensions/cordis-host-runner/src/index.ts:295-321`）。
     *
     * 一个插件 = 一段随时可被模型调用的任意代码（`sh -c` 或 V8），装配即生效、
     * 重启后由 ExternalPluginLoader 自动复活。所以「写清单」这一步必须有人点头：
     *
     *  - **只读档**：直接拒绝。处理器跑起来后本层拦不住（`SandboxEnforcement.PARTIAL`），
     *    只读档没有能约束它的东西，批准也不该存在。
     *  - **完全授权档**：放行。该档位的定义就是「不再逐条确认」。
     *  - **标准档**：逐次人工批准。拿不到审批通道（团队/后台/无活跃轮次）→ 拒绝，
     *    因为「没人能点确认」不能等同于「默认同意」。
     *
     * @return true 表示可以继续装配
     */
    private fun activationApproved(tool: String, detail: JSONObject): Boolean {
        val sandbox = ctx?.sandbox ?: return false
        when (sandbox.mode) {
            ai.deepseek.harness.mobile.kernel.sandbox.SandboxMode.READ_ONLY ->
                throw KernelError(
                    "只读权限下不能创建或激活插件：插件处理器在本机等价任意代码执行，" +
                        "沙箱无法限制它。切换到标准权限（需逐次确认）或完全授权后再试。"
                )
            ai.deepseek.harness.mobile.kernel.sandbox.SandboxMode.DANGER_FULL_ACCESS -> return true
            else -> Unit
        }
        val service = ctx?.service("agent.runtime")
        val runtime = service as? ai.deepseek.harness.mobile.agent.ToolPipeline.RuntimeTools
            ?: return false
        val handler = detail.optString("handler", "js")
        val how = if (handler == "js") "在 V8 里执行 JS（可用 dsh.exec / dsh.fs / dsh.http）"
        else "执行 shell 命令（sh -c）"
        return runtime.approve(
            tool,
            detail,
            "装配插件「${detail.optString("id")}」：它的工具会$how，装配后一直可用直到卸载。",
        )
    }

    private fun schema(props: JSONObject, required: List<String> = emptyList()): JSONObject =
        JSONObject().apply {
            put("type", "object")
            put("properties", props)
            put("required", JSONArray(required))
            put("additionalProperties", false)
        }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "plugin_spec"
            override val description =
                "阅读《手机端插件制造规范》：清单格式、命名与冲突规则、JS/shell 处理器可用接口与禁区、" +
                    "输出约定、生命周期、最小示例。**制造/装配/卸载插件前必须先读这份规范**，照着做才能一次成功。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String = PLUGIN_SPEC
        },

        object : ToolSpec {
            override val name = "plugin_create"
            override val description =
                "创建并装配一个插件：写一份清单到 kernel/plugins/<id>.json 后立刻注册成工具，" +
                    "**首次制作前先调用 plugin_spec 阅读制造规范**（命名规则、JS/shell 接口与禁区、输出约定），" +
                    "同一轮对话里就能调用。handler=js 时 code 是 async 函数体（可用 dsh.args、dsh.fs、dsh.http、" +
                    "await dsh.callTool，返回值即工具输出）；handler=shell 时 command 用 sh -c 执行，参数 JSON 从 stdin 给。" +
                    "想改就再用同一个 id 调一次（会先卸载再重装）。" +
                    "插件清单存在应用私有目录（/data/data/<包名>/files/kernel/plugins），" +
                    "不落外部存储、不进云备份：卸载 App 时插件连同应用数据一起删除。"
            override val parameters = schema(
                JSONObject()
                    .put("id", JSONObject().put("type", "string").put("description", "插件 id（小写字母/数字/-/_，2-40 字）"))
                    .put("name", JSONObject().put("type", "string").put("description", "插件显示名"))
                    .put("description", JSONObject().put("type", "string").put("description", "插件用途一句话"))
                    .put("handler", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("js", "shell")))
                        .put("description", "js（推荐，逻辑用 JS 写）或 shell"))
                    .put("code", JSONObject().put("type", "string")
                        .put("description", "handler=js 时的函数体；参数在 dsh.args，return 值会作为工具结果"))
                    .put("command", JSONObject().put("type", "string")
                        .put("description", "handler=shell 时的命令；参数 JSON 从 stdin 传入"))
                    .put("tools", JSONObject().put("type", "array")
                        .put("description", "这个插件贡献的工具定义数组，每项 {name, description, parameters}")
                        .put("items", JSONObject().put("type", "object")))
                    .put("enable", JSONObject().put("type", "boolean").put("description", "是否立即装配，默认 true")),
                listOf("id", "tools"),
            )
            override fun execute(args: JSONObject): String {
                calls++
                val rawId = PluginRules.checkId(args.optString("id"))
                val tools = args.optJSONArray("tools")
                    ?: throw KernelError("tools 不能为空：至少给一个工具定义")

                val handler = args.optString("handler", "js").lowercase()
                if (handler == "js" && args.optString("code").isBlank()) {
                    throw KernelError("handler=js 时必须给 code")
                }
                if (handler == "shell" && args.optString("command").isBlank()) {
                    throw KernelError("handler=shell 时必须给 command")
                }

                // 工具名/描述/参数 schema/数量上限/清单内重名 —— 纯规则，见 PluginRules
                val mine = PluginRules.checkToolDefs(tools)
                // 可选 prompt 段落（插件往系统提示贡献说明）：给了就校验长度
                PluginRules.checkPrompt(args)
                // 工具名不能和现有工具撞车（撞了注册表会跳过，模型会以为装好了却调不到）
                val reg = registry()
                val existing = reg.installedIds()
                    .filter { it != rawId }
                    .flatMap { reg.toolNamesOf(it) }
                PluginRules.checkConflicts(mine, existing)

                // 装配即生效、且会持久化到磁盘（重启后自动复活）：写任何文件之前先过信任闸门
                val detail = JSONObject().apply {
                    put("id", rawId); put("handler", handler); put("tools", JSONArray(mine))
                }
                if (!activationApproved("plugin_create", detail)) {
                    throw KernelError(
                        "插件「$rawId」未获批准，已取消装配。" +
                            "标准权限下每次装配都需要用户确认；无人值守（团队/后台）时自动拒绝。"
                    )
                }

                val manifest = JSONObject().apply {
                    put("id", rawId)
                    put("name", args.optString("name", rawId))
                    put("description", args.optString("description", ""))
                    put("version", args.optString("version", "1.0.0"))
                    put("handler", handler)
                    if (args.has("prompt") && args.optString("prompt").isNotBlank()) {
                        put("prompt", args.optString("prompt"))
                    }
                    if (handler == "js") put("code", args.optString("code")) else put("command", args.optString("command"))
                    put("tools", tools)
                }
                val dir = pluginDir().apply { mkdirs() }
                val file = File(dir, "$rawId.json")
                val backup = File(dir, "$rawId.json.bak")
                // 覆盖安装前先备份：旧清单一旦被坏清单顶掉，模型会以为「改好了」，
                // 实际组件已不可用且无法恢复（重启后坏清单还会一直加载）
                if (file.isFile) runCatching { file.copyTo(backup, overwrite = true) }
                val tmp = File(dir, "$rawId.json.tmp")
                runCatching {
                    tmp.writeText(manifest.toString(2), Charsets.UTF_8)
                    // 落盘前先构造一次：schema 非法/代码缺失在这里就暴露，不用等到注册表
                    val probe = ManifestPlugin(JSONObject(tmp.readText()), tmp)
                    if (probe.tools.isEmpty()) throw KernelError("清单里没有可用的工具定义")
                    if (!tmp.renameTo(file)) {
                        file.delete()
                        if (!tmp.renameTo(file)) throw KernelError("写入清单失败：rename 两次都失败")
                    }
                }.onFailure { e ->
                    runCatching { tmp.delete() }
                    throw KernelError("写入清单失败：${e.message}（旧版本未受影响）")
                }

                val enable = args.optBoolean("enable", true)
                if (!enable) {
                    return JSONObject().put("ok", true).put("id", rawId).put("path", file.absolutePath)
                        .put("installed", false).put("tools", JSONArray(mine))
                        .put("note", "只写了清单，未装配；要启用再调 plugin_install").toString()
                }
                // 覆盖安装：先卸掉旧的，再注册新的（register 对已存在 id 会跳过）
                if (reg.has(rawId)) reg.unregister(rawId)
                reg.register(ManifestPlugin(manifest, file), enabled = true)
                // has() 只代表「有条目」：加载失败时条目仍在（disabled），必须用实际装配出的工具判断
                val loaded = reg.toolNamesOf(rawId)
                if (!reg.has(rawId) || loaded.isEmpty()) {
                    runCatching { reg.unregister(rawId) }
                    if (backup.isFile) {
                        runCatching { backup.copyTo(file, overwrite = true) }
                        val old = runCatching { JSONObject(file.readText()) }.getOrNull()
                        if (old != null) runCatching { reg.register(ManifestPlugin(old, file), enabled = true) }
                        throw KernelError("装配失败（清单未通过校验），已回滚到上一个可用版本；详见内核日志")
                    }
                    runCatching { file.delete() }
                    throw KernelError("装配失败，已删除这份无效清单；没有旧版本可回滚")
                }
                runCatching { backup.delete() }
                return JSONObject().put("ok", true).put("id", rawId)
                    .put("tools", JSONArray(loaded))
                    .put("path", file.absolutePath)
                    .put("note", "已装配，本轮剩下的对话就能用这些工具").toString()
            }
        },

        object : ToolSpec {
            override val name = "plugin_install"
            override val description = "装配一个已存在但未启用的清单插件（按 id），或重新装配以让改动生效。"
            override val parameters = schema(
                JSONObject().put("id", JSONObject().put("type", "string").put("description", "插件 id")),
                listOf("id"),
            )
            override fun execute(args: JSONObject): String {
                calls++
                val pid = args.optString("id").trim().lowercase()
                val file = File(pluginDir(), "$pid.json")
                if (!file.exists()) throw KernelError("找不到清单：${file.name}")
                val manifest = runCatching { JSONObject(file.readText()) }
                    .getOrElse { throw KernelError("清单不是合法 JSON：${it.message}") }
                // 重新装配同样是「让任意代码生效」，闸门与 plugin_create 一致
                if (!activationApproved("plugin_install", JSONObject()
                        .put("id", pid)
                        .put("handler", manifest.optString("handler", "shell")))) {
                    throw KernelError(
                        "插件「$pid」未获批准，已取消装配。" +
                            "标准权限下每次装配都需要用户确认；无人值守（团队/后台）时自动拒绝。"
                    )
                }
                val reg = registry()
                if (reg.has(pid)) reg.unregister(pid)
                reg.register(ManifestPlugin(manifest, file), enabled = true)
                if (!reg.has(pid)) throw KernelError("装配失败：$pid")
                return JSONObject().put("ok", true).put("id", pid)
                    .put("tools", JSONArray(reg.toolNamesOf(pid))).toString()
            }
        },

        object : ToolSpec {
            override val name = "plugin_uninstall"
            override val description = "卸载插件：立刻摘掉它的工具，并删除清单文件（重启也不会回来）。"
            override val parameters = schema(
                JSONObject()
                    .put("id", JSONObject().put("type", "string").put("description", "插件 id"))
                    .put("keep_file", JSONObject().put("type", "boolean")
                        .put("description", "true 时只卸载、保留清单，方便以后再 install")),
                listOf("id"),
            )
            override fun execute(args: JSONObject): String {
                calls++
                val pid = args.optString("id").trim().lowercase()
                val removed = registry().unregister(pid)
                val deleted = if (args.optBoolean("keep_file", false)) false
                else File(pluginDir(), "$pid.json").let { if (it.exists()) it.delete() else false }
                if (!removed && !deleted) throw KernelError("没有这个插件：$pid")
                return JSONObject().put("ok", true).put("id", pid)
                    .put("unregistered", removed).put("fileDeleted", deleted).toString()
            }
        },

        object : ToolSpec {
            override val name = "plugin_list"
            override val description = "列出已装配的插件与它们贡献的工具，以及磁盘上还没装配的清单。"
            // 只读：允许进并发池
            override val executionMode = ToolExecutionMode.PARALLEL
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String {
                calls++
                val reg = registry()
                val onDisk = pluginDir().listFiles { f -> f.isFile && f.name.endsWith(".json") }
                    ?.sortedBy { it.name } ?: emptyList()
                val installed = JSONArray()
                reg.installedIds().forEach { pid ->
                    val tools = reg.toolNamesOf(pid)
                    installed.put(JSONObject().apply {
                        put("id", pid)
                        put("tools", JSONArray(tools))
                        put("toolCount", tools.size)
                    })
                }
                val idle = onDisk.map { it.nameWithoutExtension }.filter { !reg.has(it) }
                return JSONObject().put("ok", true)
                    .put("installed", installed)
                    .put("notInstalled", JSONArray(idle))
                    .put("dir", pluginDir().absolutePath).toString()
            }
        },
    )
}
