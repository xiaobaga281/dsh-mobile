package ai.deepseek.harness.mobile.kernel.plugin.builtin.fs

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.KernelRuntime
import ai.deepseek.harness.mobile.kernel.agents.AgentRegistry
import ai.deepseek.harness.mobile.kernel.lsp.SymbolIndex
import ai.deepseek.harness.mobile.kernel.mcp.McpClient
import ai.deepseek.harness.mobile.kernel.mcp.McpToolsPlugin
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.exitCodeOfHeader
import ai.deepseek.harness.mobile.kernel.stagehand.StagehandService
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 兼容层工具 —— 桌面有、安卓端换一种运行时后端的工具。
 *
 * 与旧版的区别：**安卓上能真实实现的一个不剩全部实现**，不再拿
 * 「结构化不可用」偷懒。逐条对照桌面机制：
 *
 *   lsp                  → 桌面 lsp 组「提供方可换」架构；安卓注册内置
 *                          [SymbolIndex]（正则符号索引）提供方，四种只读
 *                          操作全部来自真实文件内容
 *   list_mcp_* / read_mcp_resource → 桌面「只需配置 mcp-client 条目」；
 *                          安卓实现 HTTP transport 的 [McpClient]，
 *                          未配置时报 MCP_NOT_CONFIGURED（桌面同样行为）
 *   stagehand_*          → 桌面 browser-use；安卓用 [StagehandService]
 *                          （WebView 池 + JS 注入）实现同六个工具
 *                          （任务板 / 长期协作者 / 等待进展）
 *   create_worktree      → 真调 git worktree（有 git 时）；没有 git 如实报告
 *   load_workspace_dependencies → 桌面返回随包 Python/Node 路径；安卓返回
 *                          真实可用的运行时清单（V8 + 内置 Office 能力）
 *   pwsh                 → 桌面**只有 Windows 组合才挂载**，安卓没有
 *                          PowerShell 运行时 —— 唯一保持结构化不可用，
 *                          且原因与桌面挂载策略一致
 */
class CompatPlugin : KernelPlugin {
    override val id = "compat"
    override val name = "兼容工具"
    override val description = "lsp / mcp / stagehand / team / worktree / workspace-dependencies"
    override val version = "1.1.0"

    private var ctx: PluginContext? = null

    /**
     * MCP 工具桥：把远端工具注册成模型可调用的原生工具（`mcp__<server>__<raw>`）。
     * 发现放在后台线程 —— 网络慢的服务器不该拖慢内核启动。
     */
    private var mcpBridge: McpToolsPlugin? = null

    override fun onLoad(ctx: PluginContext) {
        this.ctx = ctx
        val bridge = McpToolsPlugin { ctx.service("mcp.client") as? McpClient }
        bridge.onChanged = { requestToolIndexRefresh(ctx) }
        mcpBridge = bridge
        bridge.start()
    }

    override fun onUnload() {
        mcpBridge = null
        ctx = null
    }

    /**
     * 工具集变化后请求重建索引。
     *
     * `PluginContext.refreshTools(pluginId)` 已由 WP4a 落地（Plugin.kt），且在
     * `PluginRegistry.contextFor()` 里转发到注册表本体，所以这里直接调用即可。
     *
     * 即使没刷新也不会坏 —— `PluginRegistry.schemas()` 读的是实时 `tools()`，
     * 模型下一次请求就能看到新工具；且 exec 对索引未命中会回落到实时视图。
     */
    private fun requestToolIndexRefresh(ctx: PluginContext) {
        runCatching { ctx.refreshTools(id) }
    }

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object"); put("properties", props)
        put("required", JSONArray(required)); put("additionalProperties", false)
    }

    private fun unavailable(code: String, message: String, hint: String): String =
        JSONObject().apply {
            put("ok", false)
            put("code", code)
            put("error", message)
            put("hint", hint)
        }.toString()

    /**
     * lsp 兜底实例必须缓存：SymbolIndex 的定义索引/行缓存都挂在实例上，
     * 每次调用 new 一个等于缓存全废 —— hover 一次就把整个工作区重扫一遍。
     * （正常路径走 kernel.lsp 服务，内核只建一份；这里只兜服务缺失的异常路径。）
     */
    @Volatile
    private var lspFallback: SymbolIndex? = null

    private fun lsp(): SymbolIndex =
        (ctx?.service("kernel.lsp") as? SymbolIndex) ?: lspFallback ?: synchronized(this) {
            lspFallback ?: SymbolIndex(ctx?.workspace ?: throw KernelError("工作区未就绪")).also { lspFallback = it }
        }

    private fun mcp(): McpClient =
        (ctx?.service("mcp.client") as? McpClient) ?: McpClient(File(ctx?.workspace?.root, "../kernel/mcp.json"))

    private fun stagehand(): StagehandService? = ctx?.service("stagehand.service") as? StagehandService


    private fun agents(): AgentRegistry? = ctx?.service("agents.registry") as? AgentRegistry

    /** agent.runtime 由 Driver 在每轮注入：派子代理 / 读会话要点 */
    private fun runtime(): Any =
        ctx?.service("agent.runtime") ?: throw KernelError("当前没有活跃的 Agent 轮次，团队工具不可用")

    override fun status(): Map<String, String> = buildMap {
        put("mcp_servers", runCatching { mcp().servers().size.toString() }.getOrDefault("0"))
    }

    /** 探测一次，缓存到进程生命周期：hasGit 在 create_worktree 与依赖清单里都会问 */
    @Volatile
    private var gitPath: String? = null

    private fun probeCommand(vararg names: String): String? = runCatching {
        val p = ProcessBuilder(listOf("sh", "-c", names.joinToString(" || ") { "command -v $it" }))
            .redirectErrorStream(true).start()
        // 看门狗：sh 偶发挂死时 readText() 会永远阻塞，整轮工具卡死像「应用死了」。
        // 10s 强杀子进程，管道随之 EOF，读线程自然脱身。
        val wd = java.util.concurrent.ScheduledThreadPoolExecutor(1)
        wd.schedule({ p.destroyForcibly() }, 10, java.util.concurrent.TimeUnit.SECONDS)
        try {
            val out = p.inputStream.bufferedReader().readText().trim()
            p.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)
            out.ifBlank { null }
        } finally {
            wd.shutdownNow()
        }
    }.getOrNull()

    private fun hasGit(): Boolean = gitPath().isNotBlank()

    private fun gitPath(): String = gitPath ?: synchronized(this) {
        gitPath ?: probeCommand("git").orEmpty().also { gitPath = it }
    }

    /** 静态工具（MCP 之外的全部；MCP 工具是运行时发现后追加的） */
    private val baseTools: List<ToolSpec> = listOf(
        /* ---------------- lsp：内置符号索引提供方 ---------------- */
        object : ToolSpec {
            override val name = "lsp"
            override val description = "查询代码索引，精确导航：goToDefinition / findReferences / goToImplementation / hover。" +
                "安卓端由内置正则符号索引提供方服务（非完整语言服务器），结果全部来自真实文件内容。"
            override val parameters = schema(
                JSONObject()
                    .put("operation", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("goToDefinition", "findReferences", "goToImplementation", "hover"))))
                    .put("file_path", JSONObject().put("type", "string").put("description", "相对工作区的源文件"))
                    .put("line", JSONObject().put("type", "number").put("description", "1 起的行号"))
                    .put("character", JSONObject().put("type", "number").put("description", "1 起的 UTF-16 列")),
                listOf("operation", "file_path", "line", "character"),
            )
            override fun execute(args: JSONObject): String {
                val f = args.optString("file_path")
                if (f.isBlank()) throw KernelError("file_path 不能为空")
                val line = args.optInt("line", 1)
                val ch = args.optInt("character", 1)
                val idx = lsp()
                return when (args.optString("operation")) {
                    "goToDefinition" -> idx.goToDefinition(f, line, ch)
                    "findReferences" -> idx.findReferences(f, line, ch, includeDeclaration = true)
                    "goToImplementation" -> idx.goToImplementation(f, line, ch)
                    "hover" -> idx.hover(f, line, ch)
                    else -> throw KernelError("未知 operation：${args.optString("operation")}")
                }
            }
        },

        /* ---------------- mcp：HTTP transport 客户端 ---------------- */
        object : ToolSpec {
            override val name = "list_mcp_resources"
            override val description = "列出某个已配置 MCP 服务器暴露的资源。"
            override val parameters = schema(
                JSONObject()
                    .put("server", JSONObject().put("type", "string").put("description", "mcp.json 里配置的服务器名"))
                    .put("cursor", JSONObject().put("type", "string").put("description", "分页游标")),
                listOf("server"),
            )
            override fun execute(args: JSONObject): String =
                mcp().listResources(args.optString("server"), args.optString("cursor").ifBlank { null })
        },
        object : ToolSpec {
            override val name = "list_mcp_resource_templates"
            override val description = "列出某个已配置 MCP 服务器的资源模板。"
            override val parameters = schema(
                JSONObject()
                    .put("server", JSONObject().put("type", "string"))
                    .put("cursor", JSONObject().put("type", "string")),
                listOf("server"),
            )
            override fun execute(args: JSONObject): String =
                mcp().listResourceTemplates(args.optString("server"), args.optString("cursor").ifBlank { null })
        },
        object : ToolSpec {
            override val name = "read_mcp_resource"
            override val description = "读取某个已配置 MCP 服务器的资源内容。"
            override val parameters = schema(
                JSONObject()
                    .put("server", JSONObject().put("type", "string"))
                    .put("uri", JSONObject().put("type", "string").put("description", "资源 URI")),
                listOf("server", "uri"),
            )
            override fun execute(args: JSONObject): String =
                mcp().readResource(args.optString("server"), args.optString("uri"))
        },

        /* ---------------- stagehand：WebView 池浏览器自动化 ---------------- */
        object : ToolSpec {
            override val name = "stagehand_navigate"
            override val description = "把内置浏览器标签页导航到指定 URL（页面结构由 WebView 渲染，JS 引擎可用）。"
            override val parameters = schema(
                JSONObject()
                    .put("pageId", JSONObject().put("type", "string").put("description", "标签页 id，省略用 default"))
                    .put("url", JSONObject().put("type", "string").put("description", "目标 URL")),
                listOf("url"),
            )
            override fun execute(args: JSONObject): String =
                stagehand()?.navigate(args.optString("pageId"), args.optString("url"))
                    ?: unavailable("BROWSER_UNAVAILABLE", "浏览器运行时未装配", "重启应用；仍失败说明该构建未包含浏览器组件")
        },
        object : ToolSpec {
            override val name = "stagehand_observe"
            override val description = "观察当前页面可交互元素（按钮/链接/输入框，含文本、name、role）。"
            override val parameters = schema(
                JSONObject()
                    .put("pageId", JSONObject().put("type", "string"))
                    .put("instruction", JSONObject().put("type", "string").put("description", "观察重点（可选）")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String =
                stagehand()?.observe(args.optString("pageId"))
                    ?: unavailable("BROWSER_UNAVAILABLE", "浏览器运行时未装配", "先 stagehand_navigate")
        },
        object : ToolSpec {
            override val name = "stagehand_extract"
            override val description = "从当前页面提取结构化数据：标题、标题层级、链接、表格、正文（按 instruction 侧重返回）。"
            override val parameters = schema(
                JSONObject()
                    .put("pageId", JSONObject().put("type", "string"))
                    .put("instruction", JSONObject().put("type", "string").put("description", "要提取什么，如「表格」「链接」"))
                    .put("schema", JSONObject().put("type", "object").put("description", "可选输出 schema（记录用，不影响提取字段）")),
                listOf("instruction"),
            )
            override fun execute(args: JSONObject): String =
                stagehand()?.extract(args.optString("pageId"), args.optString("instruction"))
                    ?: unavailable("BROWSER_UNAVAILABLE", "浏览器运行时未装配", "先 stagehand_navigate")
        },
        object : ToolSpec {
            override val name = "stagehand_act"
            override val description = "在页面上执行一次动作。安卓端按确定性规则解析：点击<文本> / 输入<内容> / 滚动 / 等待 N 毫秒，" +
                "并如实回报命中的元素。"
            override val parameters = schema(
                JSONObject()
                    .put("pageId", JSONObject().put("type", "string"))
                    .put("instruction", JSONObject().put("type", "string").put("description", "动作的自然语言描述")),
                listOf("instruction"),
            )
            override fun execute(args: JSONObject): String =
                stagehand()?.act(args.optString("pageId"), args.optString("instruction"))
                    ?: unavailable("BROWSER_UNAVAILABLE", "浏览器运行时未装配", "先 stagehand_navigate")
        },
        object : ToolSpec {
            override val name = "stagehand_screenshot"
            override val description = "截取当前页面（JPEG，base64 回传，可存盘后交付）。页面在后台时无法绘制，会如实报告。"
            override val parameters = schema(
                JSONObject()
                    .put("pageId", JSONObject().put("type", "string"))
                    .put("fullPage", JSONObject().put("type", "boolean")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String =
                stagehand()?.screenshot(args.optString("pageId"), args.optBoolean("fullPage"))
                    ?: unavailable("BROWSER_UNAVAILABLE", "浏览器运行时未装配", "先 stagehand_navigate")
        },
        object : ToolSpec {
            override val name = "stagehand_tabs"
            override val description = "列出全部浏览器标签页及各自 URL/标题。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String =
                stagehand()?.tabs() ?: unavailable("BROWSER_UNAVAILABLE", "浏览器运行时未装配", "")
        },

        /* ---------------- worktree：真实 git ---------------- */
        object : ToolSpec {
            override val name = "create_worktree"
            override val description = "从本地提交创建 git 分支与检出目录（走 rootfs 里的 git 2.47；" +
                "要求工作区本身是 git 仓库，没有时先在终端 git init/clone）。"
            override val parameters = schema(
                JSONObject()
                    .put("name", JSONObject().put("type", "string").put("description", "新分支名（同时作为检出目录名）"))
                    .put("from", JSONObject().put("type", "string").put("description", "起点提交/分支/标签，默认 HEAD")),
                emptyList(),
            )
            override fun execute(args: JSONObject): String {
                val dir = ctx?.workspace?.root ?: throw KernelError("工作区未就绪")
                // 先决条件是「工作区本身是个 git 仓库」：worktree 是从现有提交长分支，
                // 没有 .git 就没有 HEAD 可长。没有时给出**能落地**的指引（终端里有 git 了）。
                if (!File(dir, ".git").exists()) return unavailable(
                    "NOT_A_GIT_REPO",
                    "工作区不是 git 仓库（没有 .git），没有可用来长分支的提交",
                    "在终端（terminal_send 或 bash）里先 `git clone <url>` 或 `git init && git add -A && git commit`，再回来建 worktree",
                )
                val name = args.optString("name").ifBlank { "wt-${System.currentTimeMillis() % 100000}" }
                val from = args.optString("from", "HEAD")
                // **必须走 guest**：宿主没有 git，rootfs 里的 git 是 musl 动态二进制，
                // 宿主直接 ProcessBuilder("git") 会报 "No such file or directory"
                // （缺 /lib/ld-musl 解释器）—— 旧实现从上线起就永远 GIT_UNAVAILABLE，
                // 因为它试的是宿主进程执行。
                val rt = ctx?.service("runtime.kernel") as? KernelRuntime
                    ?: return unavailable("RUNTIME_UNAVAILABLE", "运行时未装配", "重启应用后重试")
                val hostPath = File(dir.parentFile, "worktrees/$name")
                hostPath.parentFile?.mkdirs()
                val out: String
                try {
                    out = rt.guestExec(
                        "/usr/bin/git",
                        listOf("worktree", "add", "-b", name, "/workspace/worktrees/$name", from),
                        timeoutMs = 60_000L,
                    )
                } catch (e: KernelError) {
                    return unavailable("GIT_UNAVAILABLE", "rootfs 里没有 git：${e.message?.take(200)}",
                        "git 由 rootfs 补丁提供（rootfs 就绪后自动解包）；若刚更新应用，先跑一次终端命令触发准备")
                }
                val exit = exitCodeOfHeader(out) ?: -1
                val body = out.lineSequence().drop(1).joinToString("\n").trim()
                if (exit != 0) return unavailable("GIT_FAILED", "git worktree 失败：${body.take(400)}",
                    "确认 from 是有效提交/分支；分支已存在时换一个 name")
                return JSONObject().put("ok", true).put("branch", name)
                    .put("path", hostPath.absolutePath)
                    .put("guest_path", "/workspace/worktrees/$name")
                    .put("output", body.take(400)).toString()
            }
        },

        /* ---------------- load_workspace_dependencies：真实环境清单 ---------------- */
        object : ToolSpec {
            override val name = "load_workspace_dependencies"
            override val description = "获取本机可用的运行时与库目录。桌面返回随包 Python（含 numpy/pandas/python-docx/" +
                "python-pptx/openpyxl/Pillow/lxml/XlsxWriter）与 Node/pnpm 路径；安卓端返回真实可用的等价运行时清单。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String {
                val root = ctx?.workspace?.root
                val nodeModules = root?.let { File(it, "node_modules") }
                val hasNodeModules = nodeModules?.isDirectory == true &&
                    (nodeModules.listFiles()?.isNotEmpty() == true)
                val pyVersion = probeCommand("python3", "python")
                val nodePath = probeCommand("node", "nodejs")
                val gitPath = gitPath().ifBlank { null }
                val runtimes = JSONArray()
                runtimes.put(JSONObject().apply {
                    put("id", "javascript")
                    put("engine", "WebView V8（随系统，必装）")
                    put("entry", "run_code 工具")
                    put("available", true)
                    put("stable", true)
                    put("apis", JSONArray(listOf(
                        "dsh.fs.read/write/append/list/exists/remove/stat（工作区内）",
                        "dsh.http({method,url,headers,body}) → {status,body}（原生发请求，无 CORS）",
                        "dsh.callTool(name,args)（调内核工具）",
                        "console.log 自动回传；dsh.workspace 为工作区绝对路径",
                    )))
                    put("note", "这是本机唯一保证可用的代码运行时：写 JS 就能真跑，读写真文件、发真请求")
                })
                runtimes.put(JSONObject().apply {
                    put("id", "shell")
                    put("engine", "/system/bin/sh")
                    put("entry", "bash 工具")
                    put("available", true)
                })
                runtimes.put(JSONObject().apply {
                    put("id", "python")
                    put("engine", "系统 Python")
                    put("entry", pyVersion ?: "未安装")
                    put("available", pyVersion != null)
                    put("note", "安卓系统镜像默认不含 Python；有则经 bash 调用，无 Office 库保证")
                })
                runtimes.put(JSONObject().apply {
                    put("id", "node")
                    // 别写死「未安装」：Termux/自定义 ROM 装了 node 就是真实可用运行时
                    put("engine", "Node.js")
                    put("entry", nodePath ?: "未安装（JS 能力请用 run_code）")
                    put("available", nodePath != null)
                    if (nodePath == null) {
                        put("note", "未探测到 node 可执行文件；写 JS 计算请用 run_code（必然可用）")
                    }
                })
                val office = JSONObject().apply {
                    put("docx", "内置解析（DocPreview：标题/段落/表格）；生成用 write/edit 直接写 OOXML")
                    put("pptx", "内置解析（逐页标题/要点）；生成用 write/edit")
                    put("xlsx", "内置解析（共享字符串表 + 单元格值）；生成用 write/edit")
                    put("note", "桌面随包 Python 库（python-docx 等）在安卓端以上述等价能力覆盖")
                }
                return JSONObject().apply {
                    put("ok", true)
                    put("workspace", root?.absolutePath)
                    put("runtimes", runtimes)
                    put("node_modules_present", hasNodeModules)
                    put("git", gitPath ?: "未安装")
                    put("office", office)
                    put("hint", "要“写代码算一算/验证一下”就直接用 run_code（JS，必然可用）；" +
                        "Office 解析直接用 read + 交付卡预览")
                }.toString()
            }
        },

        /* ---------------- pwsh：桌面仅 Windows 组合挂载，安卓无运行时 ---------------- */
        object : ToolSpec {
            override val name = "pwsh"
            override val description = "执行 PowerShell 命令（桌面仅 Windows 组合挂载此工具）。"
            override val parameters = schema(
                JSONObject()
                    .put("description", JSONObject().put("type", "string"))
                    .put("command", JSONObject().put("type", "string"))
                    .put("workdir", JSONObject().put("type", "string"))
                    .put("timeoutMs", JSONObject().put("type", "number"))
                    .put("run_in_background", JSONObject().put("type", "boolean")),
                listOf("description", "command"),
            )
            override fun execute(args: JSONObject): String = unavailable(
                "PWSH_UNAVAILABLE",
                "安卓没有 PowerShell 运行时；桌面侧此工具本就只在 Windows 组合挂载",
                "用 bash 执行同一条命令（手机端唯一 shell 方言）；确需 PowerShell 请在桌面 Harness 里做。",
            )
        },
    )

    /**
     * 对模型暴露的工具 = 静态工具 + 运行时发现的 MCP 工具。
     *
     * 用 getter 而不是固定 list：`PluginRegistry.schemas()` 每次请求都会重新读 `tools`，
     * 所以后台发现一完成，**下一次请求**模型就能看到 MCP 工具 —— 不依赖
     * `refreshTools` 是否已落地（它只影响索引提前对齐，不影响正确性）。
     */
    override val tools: List<ToolSpec> get() = baseTools + dynamicTools()

    /** 动态工具（MCP 远端工具 + 一个诊断入口） */
    private fun dynamicTools(): List<ToolSpec> {
        val bridge = mcpBridge ?: return emptyList()
        val out = ArrayList<ToolSpec>(bridge.tools())
        out.add(object : ToolSpec {
            override val name = "mcp_tools"
            override val description = "列出已注册的 MCP 远端工具（名为 mcp__<server>__<raw>），" +
                "并显示各服务器连接状态；refresh=true 立即重新发现。"
            override val parameters = schema(
                JSONObject().put(
                    "refresh",
                    JSONObject().put("type", "boolean")
                        .put("description", "是否立即重新发现（默认 false，只读当前状态）"),
                ),
                emptyList(),
            )

            override fun execute(args: JSONObject): String {
                if (args.optBoolean("refresh")) bridge.syncNow()
                return bridge.describe().toString()
            }
        })
        return out
    }
}
