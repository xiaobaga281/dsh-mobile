package ai.deepseek.harness.mobile.bridge

import ai.deepseek.harness.mobile.kernel.link.LinkPairing
import ai.deepseek.harness.mobile.kernel.link.LinkTarget
import ai.deepseek.harness.mobile.kernel.link.LinkTransport
import android.os.Build
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.Executors

/**
 * 桌面联动域：配对 + 远程会话，三种走法（中继 / 隧道 / 直连）一套请求语义。
 *
 * 中继那一跳的方向是反的 —— 手机只连中继，电脑自己出去拉请求，所以两边都不用被打通；
 * 代价是得有人提供一台两边都够得着的中继。内置中继跑在电脑上，因此开箱范围只有同一局域网。
 * 隧道与直连把「别人给中继」这一跳换掉：地址由电脑自己出（Cloudflare 随机域名 / 全局 IPv6），
 * 手机直接打进去。这两条路上载荷仍是端到端信封，中间那一跳只看得到密文。
 *
 * 所有网络方法都是异步的：`@JavascriptInterface` 跑在 WebView 的 JS 线程上，
 * 同步等网络会把整个页面卡住。方法立即返回，结果经 `window.DSHHost.onLink*` 回传。
 */
class LinkBridge(private val core: BridgeCore) {

    private val prefs get() = core.prefs
    private val executor = Executors.newFixedThreadPool(3)

    /* ---------------- state ---------------- */

    private fun relay(): String = prefs.getString("link.relay", "").orEmpty()
    private fun room(): String = prefs.getString("link.room", "").orEmpty()
    private fun key(): String = prefs.getString("link.key", "").orEmpty()
    private fun token(): String = prefs.getString("link.token", "").orEmpty()
    private fun mode(): String = prefs.getString("link.mode", LinkTransport.MODE_RELAY).orEmpty()
    private fun crossUrl(): String = prefs.getString("link.url", "").orEmpty()
    private fun fingerprint(): String = prefs.getString("link.fp", "").orEmpty()

    /** 地址够不够：跨网看 url，中继看 relay+room。口令两边都要。 */
    private fun reachable(): Boolean =
        key().isNotEmpty() && if (LinkTransport.isCross(mode())) crossUrl().isNotEmpty() else relay().isNotEmpty() && room().isNotEmpty()

    private fun paired(): Boolean = reachable() && token().isNotEmpty()

    @JavascriptInterface
    fun linkState(): String = JSONObject().apply {
        put("paired", paired())
        put("host", prefs.getString("link.host", "").orEmpty())
        put("mode", mode())
        put("relay", relay())
        put("room", room())
        put("url", crossUrl())
        put("fingerprint", fingerprint())
        put("device", prefs.getString("link.device", "").orEmpty())
    }.toString()

    /* ---------------- pairing ---------------- */

    /**
     * 手填连接：中继地址 + 房间 + 口令。
     *
     * 没有二维码，也没有一次性配对码：口令就是房间密钥，电脑端凭它签发设备令牌。
     * 这条路不会过期，换手机、换网络、重装 App 之后照面板再填一次即可。
     */
    @JavascriptInterface
    fun linkConnect(id: String, relayRaw: String, roomRaw: String, keyRaw: String) {
        executor.execute {
            try {
                val relay = relayRaw.trim().trimEnd('/')
                val room = roomRaw.trim()
                val key = keyRaw.trim()
                if (relay.isEmpty() || room.isEmpty() || key.isEmpty()) {
                    throw IllegalArgumentException("中继地址、房间号、口令都要填")
                }
                if (!relay.startsWith("http://") && !relay.startsWith("https://")) {
                    throw IllegalArgumentException("中继地址要带 http:// 或 https://")
                }
                val host = pairAndSave(LinkTransport.MODE_RELAY, relay, room, key, "")
                core.emit("onLinkPair", id, JSONObject().apply {
                    put("ok", true)
                    put("host", host.ifEmpty { "电脑" })
                    put("mode", LinkTransport.MODE_RELAY)
                    put("relay", relay)
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkPair", id, JSONObject().apply {
                    put("ok", false)
                    put("error", LinkTransport.friendly(error))
                }.toString())
            }
        }
    }

    /**
     * 粘贴电脑面板上那一行配对串。
     *
     * 为什么要它：跨网时地址是随机/易变的（隧道），口令是 128 bit（两种都是），
     * 让用户抄 = 让他失败。面板复制一次、手机粘贴一次，长地址和口令都不用碰。
     */
    @JavascriptInterface
    fun linkPairPaste(id: String, pasted: String) {
        executor.execute {
            try {
                val target = LinkPairing.parse(pasted)
                    ?: throw IllegalArgumentException("这不是电脑面板复制的配对串（以 dshlink1: 开头的一行）")
                val saved = pairCross(id, target, true)
                if (saved != null) core.emit("onLinkPair", id, saved.toString())
            } catch (error: Throwable) {
                core.emit("onLinkPair", id, JSONObject().apply {
                    put("ok", false)
                    put("error", LinkTransport.friendly(error))
                }.toString())
            }
        }
    }

    /**
     * 跨网配对。直连且配对串没带指纹时，先取证再让用户核对 —— 首连是唯一的中间人窗口，
     * 不能悄悄信了；其余情况（隧道 / 串里带 fp）直接固定。
     *
     * 返回 null 表示这一步没有结论（等用户核对指纹），结果都从 onLinkPair 出去。
     */
    private fun pairCross(id: String, target: LinkTarget, allowTofu: Boolean): JSONObject? {
        var fp = target.fingerprint
        if (target.mode == LinkTransport.MODE_DIRECT && fp.isEmpty()) {
            val observed = LinkTransport.observeFingerprint(target.url)
            if (!allowTofu) {
                prefs.edit()
                    .putString("link.mode", target.mode)
                    .putString("link.url", target.url)
                    .putString("link.key", target.key)
                    .putString("link.host", target.host)
                    .remove("link.token").remove("link.fp").apply()
                return JSONObject().apply {
                    put("ok", false)
                    put("needFingerprint", true)
                    put("fingerprint", observed)
                    put("error", "第一次连这台电脑：请核对指纹 $observed 与电脑面板上是否一致")
                }
            }
            // TOFU：把看到的钉上，随后仍要求用户核对（界面显示指纹原文）
            fp = observed
        }
        val host = pairAndSave(target.mode, target.url, "", target.key, fp)
        return JSONObject().apply {
            put("ok", true)
            put("host", host.ifEmpty { target.host.ifEmpty { "电脑" } })
            put("mode", target.mode)
            put("url", target.url)
            put("fingerprint", fp)
        }
    }

    /** 用户核对过指纹后走这里：把钉上的证书换成核对过的那一份再配一次 */
    @JavascriptInterface
    fun linkConfirmFingerprint(id: String, fingerprint: String) {
        executor.execute {
            try {
                val stored = LinkTarget(
                    mode(), crossUrl(), key(), prefs.getString("link.host", "").orEmpty(), fingerprint.trim().lowercase(),
                )
                if (stored.url.isEmpty() || stored.key.isEmpty()) throw IllegalStateException("先粘贴一次配对串")
                val out = pairCross(id, stored, false)
                if (out != null) core.emit("onLinkPair", id, out.toString())
            } catch (error: Throwable) {
                core.emit("onLinkPair", id, JSONObject().apply {
                    put("ok", false)
                    put("error", LinkTransport.friendly(error))
                }.toString())
            }
        }
    }

    /** 签发设备令牌并落盘；失败时抛出，本地不留半套凭据 */
    private fun pairAndSave(mode: String, base: String, room: String, key: String, fp: String): String {
        val device = JSONObject().apply {
            put("id", deviceId())
            put("name", deviceName())
            put("platform", "android ${Build.VERSION.SDK_INT}")
        }
        val claim = LinkTransport.call(
            mode, base, room, key, fp,
            "POST", "/pair/key",
            // 口令同时放 header 与 body：电脑端两个都认，跨网信封里的 header 才是唯一
            // 能穿过中间层的形式，body 那份留给「用户手填」这条最直白的路
            JSONObject().put("device", device).put("key", key),
            null,
        )
        val body = claim.body
        if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
        val deviceToken = body.optString("deviceToken")
        if (deviceToken.isEmpty()) throw IllegalStateException("连接被拒绝：没有拿到设备令牌")

        prefs.edit()
            .putString("link.mode", mode)
            .putString("link.relay", if (LinkTransport.isCross(mode)) "" else base)
            .putString("link.url", if (LinkTransport.isCross(mode)) base else "")
            .putString("link.room", room)
            .putString("link.key", key)
            .putString("link.fp", fp)
            .putString("link.token", deviceToken)
            .putString("link.host", body.optJSONObject("host")?.optString("name").orEmpty())
            .putString("link.device", deviceName())
            .apply()
        return body.optJSONObject("host")?.optString("name").orEmpty()
    }

    /**
     * 解除配对：清掉本地全部配对凭据（令牌、地址、房间、口令、指纹）。
     * 之后 linkState().paired = false，再连要重新走配对。
     */
    @JavascriptInterface
    fun linkUnpair() {
        prefs.edit()
            .remove("link.token")
            .remove("link.relay")
            .remove("link.room")
            .remove("link.key")
            .remove("link.host")
            .remove("link.device")
            .remove("link.mode")
            .remove("link.url")
            .remove("link.fp")
            .apply()
    }

    /* ---------------- sessions ---------------- */

    @JavascriptInterface
    fun linkSessions(id: String) {
        executor.execute {
            try {
                val reply = call("GET", "/sessions", null)
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                val rows = JSONArray()
                val items = body.optJSONArray("sessions") ?: JSONArray()
                for (index in 0 until items.length()) rows.put(items.getJSONObject(index))
                core.emit("onLinkSessions", id, JSONObject().apply {
                    put("ok", true)
                    put("sessions", rows)
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkSessions", id, failure(error).toString())
            }
        }
    }

    /* 电脑上的模型目录：手机上要能选真正的模型，不是摆着好看 */
    @JavascriptInterface
    fun linkModels(id: String) {
        executor.execute {
            try {
                val reply = call("GET", "/models", null)
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                core.emit("onLinkModels", id, JSONObject().apply {
                    put("ok", true)
                    put("catalog", body.optJSONObject("catalog") ?: JSONObject())
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkModels", id, failure(error).toString())
            }
        }
    }

    /**
     * 在电脑上新建一场会话。
     *
     * 和电脑端「新会话」是同一个入口：会话属于一个工作区（cwd），
     * 不传就交给电脑用它配置的默认目录 —— 手机这边不自己发明一套位置。
     */
    @JavascriptInterface
    fun linkCreateSession(id: String, cwd: String) {
        executor.execute {
            try {
                val body = JSONObject()
                if (cwd.isNotBlank()) body.put("cwd", cwd.trim())
                val reply = call("POST", "/session", body)
                val replyBody = reply.body
                if (!replyBody.optBoolean("ok")) throw IllegalStateException(claimError(replyBody))
                core.emit("onLinkCreate", id, JSONObject().apply {
                    put("ok", true)
                    put("sessionId", replyBody.optString("sessionId"))
                    put("title", "新会话")
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkCreate", id, failure(error).toString())
            }
        }
    }

    /** 电脑上的工作区列表（新建会话前选一个） */
    @JavascriptInterface
    fun linkWorkspaces(id: String) {
        executor.execute {
            try {
                val reply = call("GET", "/workspaces", null)
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                core.emit("onLinkWorkspaces", id, JSONObject().apply {
                    put("ok", true)
                    put("workspaces", body.optJSONArray("workspaces") ?: JSONArray())
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkWorkspaces", id, failure(error).toString())
            }
        }
    }

    /** 新建工作区：注册电脑上一个已存在的目录 */
    @JavascriptInterface
    fun linkCreateWorkspace(id: String, path: String) {
        executor.execute {
            try {
                val reply = call("POST", "/workspace", JSONObject().put("path", path.trim()))
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                core.emit("onLinkWorkspaceCreated", id, JSONObject().apply {
                    put("ok", true)
                    put("created", body.optBoolean("created"))
                    put("workspace", body.optJSONObject("workspace") ?: JSONObject())
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkWorkspaceCreated", id, failure(error).toString())
            }
        }
    }

    /** 在指定工作区新建会话 */
    @JavascriptInterface
    fun linkCreateSessionIn(id: String, workspaceId: String) {
        executor.execute {
            try {
                val body = JSONObject()
                if (workspaceId.isNotBlank()) body.put("workspaceId", workspaceId.trim())
                val reply = call("POST", "/session", body)
                val replyBody = reply.body
                if (!replyBody.optBoolean("ok")) throw IllegalStateException(claimError(replyBody))
                core.emit("onLinkCreate", id, JSONObject().apply {
                    put("ok", true)
                    put("sessionId", replyBody.optString("sessionId"))
                    put("title", "新会话")
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkCreate", id, failure(error).toString())
            }
        }
    }

    /**
     * 电脑上这场会话可用的斜杠命令（和电脑端输入框里的 / 是同一个服务）。
     * 拿不到就回空列表：菜单里不显示这一组，而不是摆一个点了没反应的。
     */
    @JavascriptInterface
    fun linkCommands(id: String, sessionId: String) {
        executor.execute {
            try {
                val reply = call("GET", "/commands?session=${encode(sessionId)}", null)
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                core.emit("onLinkCommands", id, JSONObject().apply {
                    put("ok", true)
                    put("commands", body.optJSONArray("commands") ?: JSONArray())
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkCommands", id, failure(error).toString())
            }
        }
    }

    /** 执行一行斜杠命令（整行，带前导 /）。 */
    @JavascriptInterface
    fun linkCommand(id: String, sessionId: String, line: String) {
        executor.execute {
            try {
                val reply = call("POST", "/session/${encode(sessionId)}/command", JSONObject().put("line", line))
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                core.emit("onLinkCommand", id, JSONObject().apply {
                    put("ok", true)
                    put("matched", body.optBoolean("matched"))
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkCommand", id, failure(error).toString())
            }
        }
    }

    /** 切这一场电脑会话用的模型 / 思考档位（下一次请求生效） */
    @JavascriptInterface
    fun linkSelectModel(id: String, sessionId: String, provider: String, model: String, effort: String) {
        executor.execute {
            try {
                val body = JSONObject().apply {
                    put("provider", provider)
                    put("model", model)
                    if (effort.isNotBlank()) put("reasoningEffort", effort)
                }
                val reply = call("POST", "/session/${encode(sessionId)}/model", body)
                val replyBody = reply.body
                if (!replyBody.optBoolean("ok")) throw IllegalStateException(claimError(replyBody))
                core.emit("onLinkModel", id, JSONObject().apply {
                    put("ok", true)
                    put("selected", replyBody.optJSONObject("selected") ?: JSONObject())
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkModel", id, failure(error).toString())
            }
        }
    }

    @JavascriptInterface
    fun linkHistory(id: String, sessionId: String, after: Int) {
        executor.execute {
            try {
                val reply = call("GET", "/session/${encode(sessionId)}?after=$after", null)
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                body.put("ok", true)
                core.emit("onLinkHistory", id, body.toString())
            } catch (error: Throwable) {
                core.emit("onLinkHistory", id, failure(error).toString())
            }
        }
    }

    /** 增量帧：只拿游标之后的，前端拼起来就是流式输出 */
    @JavascriptInterface
    fun linkLive(id: String, sessionId: String, since: Int) {
        executor.execute {
            try {
                val reply = call("GET", "/session/${encode(sessionId)}/live?since=$since", null)
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                val deltas = body.optJSONArray("deltas") ?: JSONArray()
                core.emit("onLinkLive", id, JSONObject().apply {
                    put("ok", true)
                    put("cursor", body.optInt("cursor"))
                    put("deltas", deltas)
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkLive", id, failure(error).toString())
            }
        }
    }

    /**
     * 发一条消息给电脑上的这一场。图片以 base64 内联进 prompt（桌面端会转成持久附件），
     * 没有图就传 "[]"。
     *
     * 为什么是一个方法而不是 linkSend / linkSendImages 两个：`@JavascriptInterface` 的
     * 重载在 JS 侧选不出档位，而两个方法各自复制整段 prompt 构造（时区判定、ok 校验、
     * 回执事件）—— 改协议时漏改一处就是「带图的发送不认时区」这种说不清的差异。
     */
    @JavascriptInterface
    fun linkSend(id: String, sessionId: String, text: String, imagesJson: String) {
        executor.execute {
            try {
                val payload = JSONObject().put("text", text)
                val images = try { JSONArray(imagesJson) } catch (_: Throwable) { JSONArray() }
                payload.put("images", images)
                // 只传桌面端认的 IANA 名字。安卓在部分机型/模拟器上返回 "GMT+08:00"，
                // 直接送过去会被 host 拒绝，整条消息发不出去（踩过）。
                val zone = java.util.TimeZone.getDefault().id
                val iana = zone == "UTC" || Regex("^[A-Za-z][A-Za-z0-9_+-]*/[A-Za-z0-9_+\\-/]+$").matches(zone)
                if (iana) payload.put("timeZone", zone)
                val reply = call("POST", "/session/${encode(sessionId)}/prompt", payload)
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                core.emit("onLinkSend", id, JSONObject().put("ok", true).toString())
            } catch (error: Throwable) {
                core.emit("onLinkSend", id, failure(error).toString())
            }
        }
    }

    /**
     * 分步探测：把「连不上」拆成可定位的几步。
     *
     * 「连不上」其实是一堆完全不同的故障：TCP 根本没通（网络不通 / 防火墙 / 地址过期）、
     * TLS 或证书不行、口令不对、电脑压根没在应答。合成一句「中继可达但电脑没应答」
     * 就只能靠猜。这里按走法逐步给结论，前端原样显示，截图即可定位。
     */
    @JavascriptInterface
    fun linkProbe(id: String, targetRaw: String, roomRaw: String) {
        executor.execute {
            val steps = org.json.JSONArray()
            fun step(name: String, ok: Boolean, detail: String) {
                steps.put(JSONObject().put("name", name).put("ok", ok).put("detail", detail))
            }
            // 空串 = 用已配对的那一份；非空 = 用户在表单里刚填的
            val base = targetRaw.trim().trimEnd('/').ifEmpty { crossUrl().ifEmpty { relay() } }
            val room = roomRaw.trim().ifEmpty { room() }
            val useCross = LinkTransport.isCross(mode()) || base.startsWith("https://")
            try {
                if (base.isEmpty()) throw IllegalArgumentException("先填地址")
                if (!base.startsWith("http://") && !base.startsWith("https://")) {
                    throw IllegalArgumentException("地址要带 http:// 或 https://")
                }
                val url = URL(base)
                val port = if (url.port > 0) url.port else if (url.protocol == "https") 443 else 80
                val host = url.host.removePrefix("[").removeSuffix("]")

                // 1) TCP：只建连，不发数据。过不去就是网络 / 防火墙 / 地址问题
                val t0 = System.currentTimeMillis()
                try {
                    java.net.Socket().use { it.connect(java.net.InetSocketAddress(host, port), 6000) }
                    step("TCP 连接 $host:$port", true, "${System.currentTimeMillis() - t0} 毫秒")
                } catch (error: Throwable) {
                    step("TCP 连接 $host:$port", false, LinkTransport.friendly(error))
                    throw IllegalStateException("连不上电脑：${LinkTransport.friendly(error)}")
                }

                if (useCross) {
                    // 2) TLS：直连是自签 + 指纹固定，隧道走公共 CA
                    val fp = fingerprint()
                    val hello = try {
                        LinkTransport.hello(base, mode().ifEmpty { LinkTransport.MODE_TUNNEL }, fp)
                    } catch (error: Throwable) {
                        step("TLS 握手", false, LinkTransport.friendly(error))
                        throw IllegalStateException("握手失败：${LinkTransport.friendly(error)}")
                    }
                    val peerFp = hello.optString("fingerprint")
                    step("TLS 握手", true, hello.optString("host").ifEmpty { "对端已应答" })
                    if (LinkTransport.MODE_DIRECT == mode()) {
                        step(
                            "证书指纹",
                            fp.isNotEmpty() && peerFp.equals(fp, true),
                            if (fp.isEmpty()) "本机还没固定指纹：先粘贴配对串或核对一次" else "期望 ${fp.take(16)}… · 实际 ${peerFp.take(16)}…",
                        )
                    }
                    // 3) 电脑应答：不带口令的自报家门之外，还要能真正解开一次请求
                    if (paired()) {
                        try {
                            val reply = call("GET", "/ping", null)
                            step("电脑应答", reply.body.optBoolean("ok"), reply.body.optJSONObject("host")?.optString("name").orEmpty().ifEmpty { "电脑" })
                        } catch (error: Throwable) {
                            step("电脑应答", false, LinkTransport.friendly(error))
                        }
                    }
                } else {
                    // 2) 中继 health：不需要口令，能知道房间注册了没有、电脑多久前在轮询
                    val healthUrl = "$base/link/$room/health"
                    ai.deepseek.harness.mobile.kernel.NetPolicy.requireAllowed(healthUrl)
                    val h = JSONObject(URL(healthUrl).readText())
                    val registered = h.optBoolean("registered", false)
                    val hostSeen = h.optLong("hostSeenAt", 0)
                    val gap = if (hostSeen > 0) (System.currentTimeMillis() - hostSeen) / 1000 else -1
                    step(
                        "中继应答",
                        true,
                        if (registered) "房间已注册 · 电脑 ${gap} 秒前还在轮询" else "中继正常，但这个房间还没被电脑注册",
                    )

                    // 3) 已配对的话再问一次电脑：这一步超时才是「电脑未应答」
                    if (paired()) {
                        try {
                            val reply = call("GET", "/ping", null)
                            step("电脑应答", reply.body.optBoolean("ok"), reply.body.optString("host", "电脑"))
                        } catch (error: Throwable) {
                            step("电脑应答", false, LinkTransport.friendly(error))
                        }
                    }
                }
                core.emit("onLinkProbe", id, JSONObject().apply {
                    put("ok", true)
                    put("steps", steps)
                    put("mode", if (useCross) mode().ifEmpty { LinkTransport.MODE_TUNNEL } else LinkTransport.MODE_RELAY)
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkProbe", id, JSONObject().apply {
                    put("ok", false)
                    put("error", LinkTransport.friendly(error))
                    put("steps", steps)
                }.toString())
            }
        }
    }

    /**
     * 存活心跳：手机告诉电脑「我还在」。
     *
     * 桌面端的「手机在线」看的是设备最近有没有真的发过请求，而人打开 App 后
     * 可能几分钟不动一下 —— 那时候桌面端就显示不在线。心跳把「在线」定义成
     * 「App 活着并愿意上报」，同时它本身也是一次连通性验证：不通的时候前端
     * 能直接把原因显示出来，不用猜。
     */
    @JavascriptInterface
    fun linkPing(id: String) {
        executor.execute {
            try {
                val reply = call("GET", "/ping", null)
                val body = reply.body
                if (!body.optBoolean("ok")) throw IllegalStateException(claimError(body))
                core.emit("onLinkPing", id, JSONObject().apply {
                    put("ok", true)
                    put("host", body.optJSONObject("host")?.optString("name").orEmpty())
                }.toString())
            } catch (error: Throwable) {
                core.emit("onLinkPing", id, failure(error).toString())
            }
        }
    }

    @JavascriptInterface
    fun linkCancel(id: String, sessionId: String) {
        executor.execute {
            try {
                val reply = call("POST", "/session/${encode(sessionId)}/cancel", JSONObject())
                val body = reply.body
                core.emit("onLinkSend", id, JSONObject().put("ok", body.optBoolean("ok")).toString())
            } catch (error: Throwable) {
                core.emit("onLinkSend", id, failure(error).toString())
            }
        }
    }

    /* ---------------- transport ---------------- */

    private class Reply(val status: Int, val body: JSONObject)

    /**
     * 一次「手机 → 电脑」的往返，走法由配对时存下的 mode 决定。
     * 业务判断都留给调用方，这里只管送到、拿回、把明确错误说成人话。
     */
    private fun call(method: String, path: String, body: JSONObject?): Reply {
        if (!paired()) throw IllegalStateException("还没有配对")
        val reply = LinkTransport.call(
            mode(), crossUrl().ifEmpty { relay() }, room(), key(), fingerprint(),
            method, path, body, token(),
        ) { _, _ ->
            // 电脑端把我们这台设备移除了 / 重置了口令：本地凭据已经没有意义，
            // 清掉以免反复撞墙，界面也会老实显示「未连接」
            core.prefs.edit().remove("link.token").apply()
        }
        return Reply(reply.status, reply.body)
    }

    /* ---------------- helpers ---------------- */

    private fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")

    private fun deviceId(): String {
        val stored = prefs.getString("link.deviceId", "")
        if (!stored.isNullOrEmpty()) return stored
        val fresh = java.util.UUID.randomUUID().toString()
        prefs.edit().putString("link.deviceId", fresh).apply()
        return fresh
    }

    private fun deviceName(): String {
        val brand = Build.MANUFACTURER?.replaceFirstChar { it.uppercase() }.orEmpty()
        return "$brand ${Build.MODEL}".trim().ifEmpty { "Android" }
    }

    /** 电脑/中继的错误码 → 一句人话。 */
    private fun claimError(body: JSONObject): String = when (body.optString("error")) {
        "bad-key" -> "口令不对：对照电脑面板复制的配对串重新粘一次"
        "unauthorized" -> "设备未获授权：请重新配对一次"
        "link-off" -> "电脑上还没点「启动联动」"
        "host-offline" -> "电脑不在线"
        "host-timeout" -> "电脑没有响应"
        "empty-prompt" -> "内容为空"
        "prompt-too-long" -> "内容太长"
        // 图片链路的上限（手机端会先压缩，能走到这里说明还是超了）
        "body-too-large", "queue-too-large" -> "这条消息太大了：图片少一点或小一点再发"
        "too-many-images" -> "图片太多了（最多 4 张）"
        "image-too-large" -> "有一张图太大，换一张或压一下再发"
        else -> body.optString("error").ifEmpty { "请求失败" }
    }

    private fun failure(error: Throwable): JSONObject = JSONObject().apply {
        put("ok", false)
        put("error", LinkTransport.friendly(error))
    }
}
