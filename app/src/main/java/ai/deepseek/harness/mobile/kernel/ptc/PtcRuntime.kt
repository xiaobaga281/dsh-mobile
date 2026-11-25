package ai.deepseek.harness.mobile.kernel.ptc

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * PTC 运行时 —— 桌面 `ptc-runtime-node`（TypeScript 运行时）的安卓等价物。
 *
 * 桌面 PTC 模式把 `agent-tool-presentation mode:ptc` 挂到 ctx.ptcRuntime 上，
 * 模型用 run_code 写 TypeScript 批量调工具、对结果做筛选/整理/去重/统计。
 * 安卓没有 Node，但 WebView 自带 V8 —— 用它承担同一职责：
 *
 *   - 模型代码在同一个 JS 上下文里执行：显式写到 globalThis 的状态跨调用保留，
 *     函数体内的局部变量不保留（桌面 PTC 的会话状态是运行时限定的，这里如实按 PARTIAL 说明）
 *   - 代码里 `dsh.callTool(name, args)` 返回 Promise，解析为工具输出字符串
 *     （桌面 PTC SDK 的等价入口；中间通信不进入模型历史，只有最终结果回流）
 *   - 支持 `reset: true` 重建上下文
 *
 * 执行模型：调用线程阻塞等待 evaluateJavascript 回调，超时兜底。
 */
class PtcRuntime(
    private val context: Context,
    private val execTool: (name: String, args: JSONObject) -> String,
    private val sandbox: Sandbox? = null,
    private val log: (String) -> Unit = {},
) {

    /**
     * 代码运行时可用的系统能力。
     *
     * 为什么不只给 callTool：模型写代码最常见的诉求是「读文件 → 算 → 写文件」「抓个接口看看」，
     * 只暴露工具调用等于让它用代码去模拟文件读写；有了这几个原语，run_code 才是真运行时。
     */
    interface Sandbox {
        /** 工作区绝对根目录 */
        fun workspacePath(): String
        fun read(path: String): String
        fun write(path: String, content: String, append: Boolean): String
        /** JSON 数组：[{name,path,isDir,size}] */
        fun list(path: String): String
        fun exists(path: String): Boolean
        fun remove(path: String): String
        fun stat(path: String): String
        /** 二进制写入：让 JS 能生成真的 .wav / .png / .zip */
        fun writeBase64(path: String, base64: String, append: Boolean): String
        fun readBase64(path: String): String
        /** 执行 shell 命令（工作区为 cwd）：{code, out, ms} */
        fun exec(command: String): String
        /** 入参/出参都是 JSON 字符串：{method,url,headers,body,timeoutMs} → {status,body} */
        fun http(requestJson: String): String
    }

    private companion object {
        /** 错误前缀：JS 侧看到它以 0x00 开头就当异常抛，不再当成正常内容 */
        const val ERR = "\u0000ERR:"
        const val NO_NET = "{\"status\":0,\"body\":\"\",\"error\":\"运行时没有网络通道\"}"
    }

    /** Chromium WebView 的所有 View 方法都必须在 UI 主线程调用；用主线程 Handler 串行化 */
    private val mainHandler = Handler(Looper.getMainLooper())

    /** 结果槽（保留给并发调试；run() 用轮询 + 全局变量，不再依赖它） */
    @Suppress("unused")
    private val result = AtomicReference<String?>(null)

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val wv = WebView(context.applicationContext)
        wv.settings.javaScriptEnabled = true
        wv.settings.allowFileAccess = false
        wv.settings.allowContentAccess = false
        wv.addJavascriptInterface(Bridge(), "DshPtc")
        wv.loadDataWithBaseURL(null, "<html><body></body></html>", "text/html", "utf-8", null)
        return wv
    }

    @Volatile private var webview: WebView? = null

    private fun post(task: Runnable) {
        mainHandler.post(task)
    }

    private fun ensureWebView() {
        if (webview == null) webview = buildWebView()
    }

    /** JS 侧宿主对象：工具调用与文件/网络原语都从这里回到 Kotlin */
    inner class Bridge {
        @JavascriptInterface
        fun workspace(): String = sandbox?.workspacePath() ?: ""

        @JavascriptInterface
        fun fsRead(path: String): String = try {
            sandbox?.read(path) ?: throw IllegalStateException("运行时没有挂载文件系统")
        } catch (t: Throwable) {
            ERR + (t.message ?: "读取失败")
        }

        @JavascriptInterface
        fun fsWrite(path: String, content: String, append: Boolean): String = try {
            sandbox?.write(path, content, append) ?: throw IllegalStateException("运行时没有挂载文件系统")
        } catch (t: Throwable) {
            ERR + (t.message ?: "写入失败")
        }

        @JavascriptInterface
        fun fsList(path: String): String = try {
            sandbox?.list(path) ?: "[]"
        } catch (t: Throwable) {
            ERR + (t.message ?: "列目录失败")
        }

        @JavascriptInterface
        fun fsExists(path: String): Boolean = try {
            sandbox?.exists(path) ?: false
        } catch (t: Throwable) {
            false
        }

        @JavascriptInterface
        fun fsRemove(path: String): String = try {
            sandbox?.remove(path) ?: throw IllegalStateException("运行时没有挂载文件系统")
        } catch (t: Throwable) {
            ERR + (t.message ?: "删除失败")
        }

        @JavascriptInterface
        fun fsStat(path: String): String = try {
            sandbox?.stat(path) ?: "{}"
        } catch (t: Throwable) {
            ERR + (t.message ?: "读取属性失败")
        }

        @JavascriptInterface
        fun fsWriteBase64(path: String, base64: String, append: Boolean): String = try {
            sandbox?.writeBase64(path, base64, append) ?: throw IllegalStateException("运行时没有挂载文件系统")
        } catch (t: Throwable) {
            ERR + (t.message ?: "写入失败")
        }

        @JavascriptInterface
        fun fsReadBase64(path: String): String = try {
            sandbox?.readBase64(path) ?: ""
        } catch (t: Throwable) {
            ERR + (t.message ?: "读取失败")
        }

        @JavascriptInterface
        fun exec(command: String): String = try {
            sandbox?.exec(command) ?: "{\"code\":-1,\"out\":\"运行时没有 shell\"}"
        } catch (t: Throwable) {
            JSONObject().put("code", -1).put("out", t.message ?: "执行失败").toString()
        }

        @JavascriptInterface
        fun http(requestJson: String): String = try {
            sandbox?.http(requestJson) ?: NO_NET
        } catch (t: Throwable) {
            JSONObject().put("status", 0).put("body", "").put("error", t.message ?: "请求失败").toString()
        }

        @JavascriptInterface
        fun call(name: String?, argsJson: String, callId: String) {
            // 名字这一层再守一次（JS 侧的 callTool 已经先挡）：直接调 DshPtc.call 的脚本
            // 传 null / "null" 时，不该得到一句「未知工具：null（对应插件可能被禁用）」
            val tool = name?.trim().orEmpty()
            val bad = when {
                tool.isEmpty() -> "工具名是空的"
                tool == "null" || tool == "undefined" -> "工具名是 \"$tool\"（调用方没拿到值）"
                else -> null
            }
            val out = if (bad != null) {
                JSONObject().put("ok", false).put("code", "BAD_TOOL_NAME")
                    .put("error", "$bad：dsh.callTool 的第一个参数必须是工具名字符串，工具名从系统提示的工具清单里原样复制")
                    .toString()
            } else try {
                val args = if (argsJson.isNullOrBlank()) JSONObject() else JSONObject(argsJson)
                execTool(tool, args)
            } catch (t: Throwable) {
                JSONObject().put("ok", false).put("error", t.message ?: "工具执行失败").toString()
            }
            // 把结果 resolve 回 JS（必须在 WebView 所属线程上 evaluate）
            post {
                webview?.evaluateJavascript(
                    "window.__dshPtcResolve(${JSONObject.quote(callId)}, ${JSONObject.quote(out)});", null
                )
            }
        }
    }

    /**
     * 同步执行一段 JS 表达式并取回其 JSON 解码后的字符串结果。
     * evaluateJavascript 不能 await Promise，所以只用于「立刻有值」的读取。
     */
    private fun evalOnce(expr: String, timeoutMs: Long = 10_000): String? {
        val latch = CountDownLatch(1)
        val slot = AtomicReference<String?>(null)
        post {
            webview?.evaluateJavascript(expr) { json ->
                slot.set(
                    if (json == null) null else runCatching {
                        org.json.JSONTokener(json).nextValue() as? String
                    }.getOrNull() ?: json
                )
                latch.countDown()
            } ?: latch.countDown()
        }
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        return slot.get()
    }

    /**
     * 执行一段 JS。代码体是 async 函数体，可以 await dsh.callTool(...)；
     * 最后一个表达式的值经 JSON.stringify 回传。
     */
    fun run(code: String, reset: Boolean = false, timeoutMs: Long = 60_000): String {
        if (reset) post { webview?.destroy(); webview = null }
        post { ensureWebView() }
        // 结果写进全局变量再由调用线程轮询取回：
        // WebView 的 evaluateJavascript 不 await Promise，直接取异步函数的返回值只能拿到 "{}"。
        val script = """
            (async () => {
              window.__dshPtcDone = false;
              window.__dshPtcLast = null;
              const pending = new Map();
              window.__dshPtcResolve = (callId, out) => {
                const p = pending.get(callId);
                if (p) { pending.delete(callId); p(out); }
              };

              // 输出收集：模型常写 console.log 调试，这些必须回传，否则等于白跑
              const logs = [];
              const push = (level, args) => {
                if (logs.length > 400) return;
                const text = args.map((a) => {
                  if (typeof a === 'string') return a;
                  try { return JSON.stringify(a); } catch (_) { return String(a); }
                }).join(' ');
                logs.push(level === 'log' ? text : '[' + level + '] ' + text);
              };
              const console = { log: (...a) => push('log', a), info: (...a) => push('info', a),
                                warn: (...a) => push('warn', a), error: (...a) => push('error', a),
                                debug: (...a) => push('debug', a) };

              // 桥抛错时用 0x00 前缀带回真实原因，不静默返回空串
              const unwrap = (v) => {
                if (typeof v === 'string' && v.charCodeAt(0) === 0) throw new Error(v.slice(5));
                return v;
              };

              const dsh = {
                callTool: (name, args) => new Promise((resolve, reject) => {
                  // 工具名必须是字符串：模型偶尔写成 dsh.callTool(null, …)（名字在变量里却忘了赋值）。
                  // 下面 String(name) 会把 null 变成 "null" 再送去执行，内核回一句
                  // 「未知工具：null（对应插件可能被禁用）」—— 把模型和人都往「插件被禁用」那个错方向带。
                  if (typeof name !== 'string' || !name.trim()) {
                    reject(new Error('dsh.callTool 的第一个参数必须是工具名字符串，收到的是 ' + String(name) +
                      '；工具名请从系统提示的工具清单里原样复制'));
                    return;
                  }
                  const cid = 'c' + Math.random().toString(36).slice(2);
                  pending.set(cid, (raw) => {
                    // registry.exec 的返回是 {ok,output[,exit_code]} 包装，而本函数的契约
                    // （文件头：「解析为工具输出字符串」）是插件作者拿到与模型所见一致的
                    // 工具正文。在这里解掉包装：成功 → 正文；失败 → reject（run 的
                    // try/catch 会把它变成插件工具的失败原因）。
                    // 包装判定必须同时要求 ok:boolean 与 output:string 两个键：有些工具
                    // 的正文本身就是 JSON（phone_* 全家），只看 ok 键会误解它们的输出。
                    let o = null;
                    try { o = JSON.parse(raw); } catch (_) {}
                    if (o && typeof o === 'object' && typeof o.ok === 'boolean' && typeof o.output === 'string') {
                      if (!o.ok) { reject(new Error(o.error || '工具执行失败')); return; }
                      resolve(o.output);
                      return;
                    }
                    resolve(raw);
                  });
                  DshPtc.call(name, JSON.stringify(args ?? {}), cid);
                }),
                workspace: (() => { try { return DshPtc.workspace(); } catch (_) { return ''; } })(),
                now: () => Date.now(),
                // 插件处理器用：清单插件调用时把工具参数放在这里
                get args() { return (typeof globalThis.__pluginArgs === 'object' && globalThis.__pluginArgs) || {}; },
                sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0))),
                fs: {
                  read: (p) => unwrap(DshPtc.fsRead(String(p))),
                  write: (p, content) => DshPtc.fsWrite(String(p), String(content), false),
                  append: (p, content) => DshPtc.fsWrite(String(p), String(content), true),
                  list: (p) => JSON.parse(unwrap(DshPtc.fsList(String(p ?? '.')))),
                  exists: (p) => DshPtc.fsExists(String(p)),
                  remove: (p) => DshPtc.fsRemove(String(p)),
                  stat: (p) => JSON.parse(unwrap(DshPtc.fsStat(String(p)))),
                  // 二进制：JS 里生成 .wav / .png / .zip 走这两个
                  writeBase64: (p, b64) => unwrap(DshPtc.fsWriteBase64(String(p), String(b64), false)),
                  appendBase64: (p, b64) => unwrap(DshPtc.fsWriteBase64(String(p), String(b64), true)),
                  readBase64: (p) => unwrap(DshPtc.fsReadBase64(String(p))),
                },
                // 执行 shell（工作区为 cwd）：{code, out, ms}
                exec: (cmd) => JSON.parse(unwrap(DshPtc.exec(String(cmd)))),
                http: (opts) => {
                  const req = typeof opts === 'string' ? { url: opts } : (opts || {});
                  const res = JSON.parse(unwrap(DshPtc.http(JSON.stringify({
                    method: req.method || 'GET',
                    url: req.url,
                    headers: req.headers || {},
                    body: req.body == null ? '' : String(req.body),
                    timeoutMs: req.timeoutMs || 20000,
                  }))));
                  return res;
                },
              };

              const started = Date.now();
              try {
                const fn = new Function('dsh', 'console', 'return (async () => {' + ${JSONObject.quote(code)} + '\n})()');
                const value = await fn(dsh, console);
                window.__dshPtcLast = JSON.stringify({
                  ok: true,
                  value: value === undefined ? null : value,
                  logs: logs,
                  ms: Date.now() - started,
                  workspace: dsh.workspace,
                });
              } catch (e) {
                window.__dshPtcLast = JSON.stringify({
                  ok: false,
                  error: String((e && e.stack) || (e && e.message) || e),
                  logs: logs,
                  ms: Date.now() - started,
                });
              }
              window.__dshPtcDone = true;
            })();
        """.trimIndent()

        post { webview?.evaluateJavascript(script, null) }
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(120)
            val got = evalOnce("window.__dshPtcDone ? window.__dshPtcLast : null", 5_000)
            if (got != null && got != "null") return got
        }
        return JSONObject().put("ok", false).put("error", "run_code 超时（${timeoutMs}ms），已放弃等待").toString()
    }

    /**
     * 执行「插件里的 JS 处理器」：code 是函数体，参数以 dsh.args 注入，
     * 返回值（或 console 输出）作为工具结果。清单插件靠它实现纯 JS 工具。
     */
    fun callHandler(code: String, argsJson: String): String {
        val args = argsJson.ifBlank { "{}" }
        // 处理器可以 return 一个值；没 return 就把 console 输出当结果
        val body = "const __pluginArgs = $args;\n" +
            "globalThis.__pluginArgs = __pluginArgs;\n" +
            code
        val raw = run(body, reset = false, timeoutMs = 30_000)
        return raw
    }

    fun describe(): JSONObject = JSONObject().apply {
        put("engine", "webview-v8")
        put("ready", webview != null)
        put("sandbox", sandbox != null)
        put("apis", org.json.JSONArray(listOf("dsh.callTool", "dsh.fs", "dsh.http", "console", "dsh.sleep")))
        put("workspace", sandbox?.workspacePath() ?: "")
    }
}
