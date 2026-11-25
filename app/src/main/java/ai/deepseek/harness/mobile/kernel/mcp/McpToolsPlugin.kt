package ai.deepseek.harness.mobile.kernel.mcp

import ai.deepseek.harness.mobile.kernel.plugin.ToolExecutionMode
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * 把远端 MCP 工具桥接成**模型可调用的原生工具**。
 *
 * 这是本次 WP5 最重要的一条缺口修复：`McpClient` 早就有 `tools()` / `callTool()`，
 * 但没有任何代码调用它们 —— 死代码。于是"配了 MCP 服务器"对模型毫无意义，
 * 只能读资源，不能调工具。
 *
 * 设计要点（与桌面 `packages/mcp/mcp-client/src/tools.ts` 对齐）：
 *   - 公开名 `mcp__<server>__<raw>`，由 [McpToolName] 计算；`tools/call` 永远发 **rawName**
 *   - `inputSchema` **原样透传**（MCP 用的就是 JSON Schema，`validateArgs` 只读
 *     `properties`/`required`，透传即天然兼容；不要"翻译"成自家 schema，翻译必然丢字段）
 *   - `isError` → 工具层显式失败（ok=false + code），模型不会看到虚假成功
 *   - 发现失败**保留上一代工具**（桌面"要么完整世代，要么没有"）
 *
 * 为什么它不是 `KernelPlugin`（而是被 CompatPlugin 持有）：
 * 内置插件靠 `META-INF/services/...KernelPlugin` 清单注册，那个资源文件不在本 WP
 * 的写范围内；把桥接挂到已经在插件清单里的 CompatPlugin 上，同样达成"模型能看到
 * 并能调用"，且不需要动别人的文件。后续若要独立成插件，只需加一行清单。
 */
class McpToolsPlugin(
    private val clientProvider: () -> McpClient?,
) {

    @Volatile
    private var specs: List<ToolSpec> = emptyList()

    @Volatile
    private var lastSyncAt: Long = 0L

    @Volatile
    private var lastError: String? = null

    @Volatile
    private var syncing: Boolean = false

    private val syncLock = Any()

    /** 工具集变化回调（用于让 PluginRegistry 重建索引） */
    @Volatile
    var onChanged: (() -> Unit)? = null

    fun tools(): List<ToolSpec> = specs

    fun toolCount(): Int = specs.size

    /** 启动后台首次发现：不阻塞内核启动（网络慢的服务器不该拖慢 App） */
    fun start() {
        syncAsync()
    }

    fun syncAsync() {
        if (syncing) return
        syncing = true
        Thread({
            try {
                syncNow()
            } finally {
                syncing = false
            }
        }, "dsh-mcp-tools").apply { isDaemon = true }.start()
    }

    /**
     * 同步发现。返回注册到的工具数。
     * 单个服务器失败不影响其他服务器；全部失败时保留上一代工具（不静默清空）。
     */
    fun syncNow(): Int = synchronized(syncLock) {
        val client = clientProvider()
            ?: return@synchronized specs.size
        val out = ArrayList<ToolSpec>()
        val errors = ArrayList<String>()
        var anySuccess = false
        client.servers().forEach { server ->
            runCatching { client.toolDefs(server.name) }
                .onSuccess { defs ->
                    anySuccess = true
                    defs.forEach { out.add(spec(client, it)) }
                }
                .onFailure { e ->
                    errors.add("${server.name}: ${e.message ?: e.javaClass.simpleName}")
                }
        }
        if (anySuccess || out.isNotEmpty()) {
            specs = out
        }
        lastError = if (errors.isEmpty()) null else errors.joinToString("; ")
        lastSyncAt = System.currentTimeMillis()
        onChanged?.invoke()
        specs.size
    }

    /** 诊断视图（设置页 / `mcp_tools` 工具用） */
    fun describe(): JSONObject {
        val client = clientProvider()
        return JSONObject().apply {
            put("ok", true)
            put("registered", specs.size)
            put("lastSyncAt", lastSyncAt)
            put("syncing", syncing)
            lastError?.let { put("lastError", it) }
            put("servers", client?.let { c ->
                runCatching { JSONObject(c.describe()).optJSONArray("servers") }.getOrNull()
            } ?: JSONArray())
            put(
                "tools", JSONArray().apply {
                    specs.forEach { s ->
                        put(JSONObject().put("name", s.name).put("description", s.description))
                    }
                },
            )
        }
    }

    private fun spec(client: McpClient, t: McpClient.McpTool): ToolSpec = object : ToolSpec {
        override val name: String = t.publicName
        override val description: String =
            "${t.description.ifBlank { t.rawName }}（MCP 服务器 ${t.server} 的远端工具）"

        /** JSON Schema 原样透传 */
        override val parameters: JSONObject = t.inputSchema

        override val executionMode: ToolExecutionMode = ToolExecutionMode.PARALLEL

        override fun execute(args: JSONObject): String = try {
            val result = client.callTool(t.server, t.rawName, args)
            JSONObject().apply {
                put("ok", true)
                put("output", client.extractText(result))
                put("server", t.server)
                put("tool", t.rawName)
            }.toString()
        } catch (e: McpClient.McpError) {
            JSONObject().apply {
                put("ok", false)
                put("code", e.code)
                put("error", e.message ?: "MCP 调用失败")
            }.toString()
        } catch (t2: Throwable) {
            JSONObject().apply {
                put("ok", false)
                put("code", McpClient.CODE_TOOL_ERROR)
                put("error", t2.message ?: "MCP 调用失败")
            }.toString()
        }
    }
}
