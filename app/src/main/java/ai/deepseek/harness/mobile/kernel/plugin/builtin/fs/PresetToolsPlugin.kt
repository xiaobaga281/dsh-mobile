package ai.deepseek.harness.mobile.kernel.plugin.builtin.fs

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.ToolKernel
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickBool
import ai.deepseek.harness.mobile.kernel.ptc.PtcRuntime
import org.json.JSONArray
import org.json.JSONObject

/**
 * 预设能力插件 —— 承载四个内置预设里除标准工具之外的两类工具：
 *
 *  - run_code（PTC 模式独有）：桌面 `agent-tool-presentation mode:ptc` + `ptc-runtime-node` 的
 *    安卓等价物。实现交给 [PtcRuntime]（WebView V8），经 `ptc.runtime` 服务注入，插件不持有运行时。
 *  - cordis_inspect_list / cordis_inspect_query / plugin_manager / plugin_market（创造模式独有）：
 *    对应桌面 `@deepseek-ai/dsh-tool-cordis`（只读运行时检查）与 `plugin-manager/tools`、
 *    `plugin-market/tools`。检查与启停直接落在内核门面上，市场未配置源时如实报告。
 *
 * 这些工具在 standard / minimal 预设下不在白名单里，模型看不到也调不了——
 * 与桌面「preset 未挂载对应插件」语义一致。
 */
class PresetToolsPlugin : KernelPlugin {
    override val id = "preset-tools"
    override val name = "预设能力"
    override val description = "PTC 运行代码、Cordis 只读检查、插件管理与市场"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null

    /** 索引客户端（带 10 分钟缓存，见 MarketClient）。懒创建，插件卸载时丢弃即可。 */
    private var market: ai.deepseek.harness.mobile.kernel.market.MarketClient? = null

    /**
     * 已配置的索引地址。
     *
     * 字段名对齐桌面 `plugin-market` 的 `indexes`（数组）；`marketUrl` 是手机端此前唯一支持的
     * 单值写法，保留兼容 —— 老配置不该因为升级而失效。
     */
    private fun marketIndexes(): List<String> {
        val cfg = ctx?.config() ?: return emptyList()
        val out = LinkedHashSet<String>()
        cfg.optJSONArray("indexes")?.let { arr ->
            for (i in 0 until arr.length()) {
                arr.optString(i).trim().takeIf { it.isNotEmpty() }?.let(out::add)
            }
        }
        cfg.optString("marketUrl").trim().takeIf { it.isNotEmpty() }?.let(out::add)
        return out.toList()
    }

    private fun findPlugin(index: ai.deepseek.harness.mobile.kernel.market.PluginMarketIndex.Parsed, name: String): JSONObject? {
        for (i in 0 until index.plugins.length()) {
            val p = index.plugins.optJSONObject(i) ?: continue
            if (p.optString("name") == name) return p
        }
        return null
    }

    /**
     * 一个插件对外的形状 —— **对齐桌面 search 的返回**：`defaultVersion` 与它的 `install`
     * 参数都要带，模型拿到就能直接说出「装哪个版本、用什么 spec」，不必再问一轮。
     */
    private fun pluginJson(p: JSONObject): JSONObject {
        val idx = ai.deepseek.harness.mobile.kernel.market.PluginMarketIndex
        val name = p.optString("name")
        val versions = JSONArray()
        p.optJSONArray("versions")?.let { arr ->
            for (i in 0 until arr.length()) {
                val v = arr.optJSONObject(i) ?: continue
                versions.put(JSONObject().put("version", v.optString("version"))
                    .put("install_spec", idx.installSpec(name, v)))
            }
        }
        val def = idx.defaultVersion(p)
        return JSONObject().apply {
            put("name", name)
            put("title", idx.text(p.opt("title")))
            put("description", idx.text(p.opt("description")))
            if (def != null) {
                put("default_version", JSONObject()
                    .put("version", def.optString("version"))
                    .put("install_spec", idx.installSpec(name, def)))
            }
            put("versions", versions)
        }
    }

    override fun onLoad(ctx: PluginContext) { this.ctx = ctx }
    override fun onUnload() { ctx = null }

    private fun kernel(): ToolKernel =
        ctx?.service("kernel.facade") as? ToolKernel
            ?: throw KernelError("内核门面未就绪，暂时无法执行该工具")

    private fun ptc(): PtcRuntime =
        ctx?.service("ptc.runtime") as? PtcRuntime
            ?: throw KernelError("PTC 运行时未装配（当前部署没有 WebView 运行环境）")

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object")
        put("properties", props)
        put("required", JSONArray(required))
        put("additionalProperties", false)
    }

    override val tools: List<ToolSpec> = listOf(
        object : ToolSpec {
            override val name = "run_code"
            override val description =
                "在本机 JS 运行时里执行一段代码并拿回真实结果（WebView 自带 V8，无需安装任何东西）。" +
                    "代码体是 async 函数体，可用：" +
                    "dsh.fs.read/write/append/list/exists/remove/stat（工作区内，路径相对工作区）；" +
                    "dsh.http({method,url,headers,body}) 返回 {status,body}（原生发请求，不受浏览器 CORS 限制）；" +
                    "dsh.fs.writeBase64/readBase64 处理二进制（可自己拼 WAV/PNG/ZIP 字节）；dsh.exec(cmd) 执行 shell（工作区为 cwd，返回 {code,out}）；" +
                    "await dsh.callTool(name,args) 调其它工具；console.log 会被收集回传；dsh.workspace 是工作区绝对路径。" +
                    "最后的 return 值 + 输出日志一起回给你。适合：读文件算数据、批量处理、跑算法、验证代码真的能跑。"
            override val parameters = schema(
                JSONObject()
                    .put("code", JSONObject().put("type", "string").put("description", "async 函数体形式的 JS 代码"))
                    .put("description", JSONObject().put("type", "string").put("description", "一句话说明这段代码做什么"))
                    .put("timeoutMs", JSONObject().put("type", "number").put("description", "超时毫秒数，默认 60000，最大 600000"))
                    .put("sandbox_permissions", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("workspace-write", "danger-full-access")))
                        .put("description", "代码内工具调用的文件权限档位，默认跟随会话"))
                    .put("justification", JSONObject().put("type", "string").put("description", "为什么需要这段代码"))
                    .put("reset", JSONObject().put("type", "boolean").put("description", "true 时重置 JS 上下文")),
                listOf("code", "description"),
            )
            override fun execute(args: JSONObject): String = ptc().run(
                args.optString("code"),
                args.optBoolean("reset"),
                args.optLong("timeoutMs", 60_000L).coerceIn(1_000L, 600_000L),
            )
        },
        object : ToolSpec {
            override val name = "cordis_inspect_list"
            override val description = "只读检查运行时：列出当前内核装配的插件、工具、事件钩子与服务。"
            override val parameters = schema(JSONObject(), emptyList())
            override fun execute(args: JSONObject): String {
                val k = kernel()
                return JSONObject().put("ok", true)
                    .put("plugins", k.pluginsJson().optJSONArray("plugins") ?: JSONArray())
                    .put("hooks", k.kernelJson().optJSONObject("hooks") ?: JSONObject())
                    .put("services", k.kernelJson().optJSONArray("services") ?: JSONArray())
                    .toString()
            }
        },
        object : ToolSpec {
            override val name = "cordis_inspect_query"
            override val description = "只读检查运行时：按 provider 与方法名查准确的 Service 方法、Event 模式、Config/Tool schema 或 Slot 树。platform/provider/method 必须来自 cordis_inspect_list。"
            override val parameters = schema(
                JSONObject()
                    .put("platform", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("host", "client")))
                        .put("description", "拥有该 Provider 的运行时平面；手机端固定 host"))
                    .put("provider", JSONObject().put("type", "string").put("description", "cordis_inspect_list 返回的 Provider ID"))
                    .put("method", JSONObject().put("type", "string").put("description", "Provider 声明里的方法名"))
                    .put("input", JSONObject().put("type", "object").put("description", "可选的查询输入，须符合该方法的 input schema")),
                listOf("platform", "provider", "method"),
            )
            override fun execute(args: JSONObject): String {
                val pattern = args.pick("method", "provider", "input")
                val provider = args.pick("provider")
                if (pattern.isBlank() && provider.isBlank()) throw KernelError("method 不能为空")
                val q = pattern.ifBlank { provider }.lowercase()
                val hits = JSONArray()
                val all = kernel().schemas()
                for (i in 0 until all.length()) {
                    val s = all.optJSONObject(i) ?: continue
                    if (q in s.optString("name").lowercase() || q in s.optString("description").lowercase()) hits.put(s)
                }
                return JSONObject().put("ok", true).put("count", hits.length())
                    .put("note", "手机端内核检查：按 method/provider 名检索工具与插件清单").put("tools", hits).toString()
            }
        },
        object : ToolSpec {
            override val name = "plugin_manager"
            override val description = "管理本机插件：list_plugins 列出全部插件，set_plugin 启停一个插件（禁用即卸载，工具从目录消失）。桌面另有 bundle/版本豁免动作，手机端未装配 bundle 安装器，返回结构化说明。"
            override val parameters = schema(
                JSONObject()
                    .put("action", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("list_plugins", "list_bundles", "set_plugin", "set_bundle", "install_bundle", "remove_bundle", "list_version_exemptions", "set_version_exemption")))
                        .put("description", "管理动作"))
                    .put("target", JSONObject().put("type", "string").put("description", "插件 id（set_plugin）"))
                    .put("enabled", JSONObject().put("type", "boolean").put("description", "启用或禁用"))
                    .put("limit", JSONObject().put("type", "number"))
                    .put("offset", JSONObject().put("type", "number"))
                    .put("runtimeVersion", JSONObject().put("type", "string"))
                    .put("acceptRisk", JSONObject().put("type", "boolean"))
                    .put("approvedBuilds", JSONObject().apply { put("type", "array"); put("items", JSONObject().put("type", "string")) })
                    .put("registry", JSONObject().put("type", "string")),
                listOf("action"),
            )
            override fun execute(args: JSONObject): String {
                val k = kernel()
                val action = args.pick("action")
                return when (action) {
                    "list_plugins", "list_bundles" -> k.pluginsJson().put("ok", true).toString()
                    "set_plugin" -> {
                        val id = args.pick("target", "id")
                        if (id.isBlank()) throw KernelError("set_plugin 需要 target（插件 id）")
                        k.setPluginEnabled(id, args.pickBool("enabled", default = true)).put("ok", true).toString()
                    }
                    else -> JSONObject().put("ok", false).put("code", "UNSUPPORTED_ACTION")
                        .put("error", "手机端未装配 bundle 安装器/版本豁免（桌面对应 plugin-manager 提供方）")
                        .put("hint", "可用 list_plugins / set_plugin；安装组合包请在桌面 Harness 里做").toString()
                }
            }
        },
        object : ToolSpec {
            override val name = "plugin_market"
            override val description = "查询插件市场索引（format 1，与桌面 @deepseek-ai/dsh-plugin-market 同一协议）。" +
                "action=list_indexes 列出已配置的索引与上次读取状态；list_plugins 按关键词检索并分页；" +
                "list_versions 列出某个插件的全部版本与安装 spec。只读：不安装、不改配置。"
            override val parameters = schema(
                JSONObject()
                    .put("action", JSONObject().put("type", "string")
                        .put("enum", JSONArray(listOf("list_indexes", "list_plugins", "list_versions")))
                        .put("description", "查询动作"))
                    .put("query", JSONObject().put("type", "string").put("description", "搜索词（list_plugins 可选，空则列全部）"))
                    .put("name", JSONObject().put("type", "string").put("description", "精确插件包名（list_versions 必填）"))
                    .put("url", JSONObject().put("type", "string")
                        .put("description", "索引 URL；省略时用第一个已配置的。只接受已配置的地址（防任意地址抓取）"))
                    .put("limit", JSONObject().put("type", "number").put("description", "每页条数，默认 20，上限 100"))
                    .put("offset", JSONObject().put("type", "number").put("description", "分页偏移，默认 0")),
                listOf("action"),
            )
            override fun execute(args: JSONObject): String {
                val urls = marketIndexes()
                if (urls.isEmpty()) {
                    return JSONObject().put("ok", false)
                        .put("code", "MARKET_NOT_CONFIGURED")
                        .put("error", "未配置插件市场索引。在插件配置里填 preset-tools.indexes（数组，与桌面 plugin-market 的 indexes 同名）" +
                            "或旧的 preset-tools.marketUrl（单值，已兼容）后可用。")
                        .put("hint", "索引是 format 1 的 JSON：{format:1,title,description,plugins:[{name,versions:[{version,source}]}]}")
                        .toString()
                }
                val client = market ?: ai.deepseek.harness.mobile.kernel.market.MarketClient().also { market = it }
                val action = args.optString("action")
                // 只接受已配置的 URL：桌面 search(url,…) 同样只认已配置地址，
                // 否则这个工具就成了「让 Agent 抓任意地址」的通道（SSRF）。
                val wanted = args.optString("url").ifBlank { args.optString("target") }
                val url = if (wanted.isBlank()) urls.first() else {
                    if (wanted !in urls) return JSONObject().put("ok", false)
                        .put("code", "MARKET_URL_NOT_CONFIGURED")
                        .put("error", "该地址不在已配置的索引里：$wanted")
                        .put("configured", JSONArray(urls)).toString()
                    wanted
                }
                return when (action) {
                    "list_indexes" -> {
                        val arr = JSONArray()
                        urls.forEach { u ->
                            val refused = client.validateUrl(u)
                            if (refused != null) {
                                arr.put(JSONObject().put("url", u).put("configured_ok", false).put("error", refused))
                            } else {
                                arr.put(client.load(u).toJson())
                            }
                        }
                        JSONObject().put("ok", true).put("indexes", arr).toString()
                    }
                    "list_plugins" -> {
                        val e = client.load(url)
                        if (e.index == null) {
                            return JSONObject().put("ok", false)
                                .put("code", "MARKET_INDEX_FAILED")
                                .put("url", url).put("error", e.error).toString()
                        }
                        val limit = args.optInt("limit", 20).coerceIn(1, 100)
                        val offset = args.optInt("offset", 0).coerceAtLeast(0)
                        val page = ai.deepseek.harness.mobile.kernel.market.PluginMarketIndex
                            .search(e.index, args.optString("query"), limit, offset)
                        val list = JSONArray()
                        for (i in 0 until page.hits.length()) {
                            list.put(pluginJson(page.hits.getJSONObject(i)))
                        }
                        JSONObject().put("ok", true)
                            .put("index", JSONObject().put("url", url)
                                .put("title", e.index.title).put("description", e.index.description))
                            .put("fetched_at", e.fetchedAt)
                            .put("total", page.total)
                            .put("next_offset", page.nextOffset ?: JSONObject.NULL)
                            .put("plugins", list)
                            .toString()
                    }
                    "list_versions" -> {
                        val name = args.optString("name")
                        if (name.isBlank()) {
                            return JSONObject().put("ok", false).put("code", "BAD_ARGS")
                                .put("error", "list_versions 需要 name（插件包名）").toString()
                        }
                        val e = client.load(url)
                        if (e.index == null) {
                            return JSONObject().put("ok", false)
                                .put("code", "MARKET_INDEX_FAILED").put("url", url).put("error", e.error).toString()
                        }
                        val hit = findPlugin(e.index, name)
                            ?: return JSONObject().put("ok", false).put("code", "PLUGIN_NOT_FOUND")
                                .put("error", "索引里没有插件：$name").put("index_url", url).toString()
                        pluginJson(hit).toString()
                    }
                    else -> JSONObject().put("ok", false).put("code", "BAD_ARGS")
                        .put("error", "未知 action：$action（可用 list_indexes / list_plugins / list_versions）").toString()
                }
            }
        },
    )

    override fun promptSection(): String? = null
    override fun status(): Map<String, String> = mapOf(
        "PTC" to (if (ctx?.service("ptc.runtime") != null) "已装配" else "未装配"),
    )
}
