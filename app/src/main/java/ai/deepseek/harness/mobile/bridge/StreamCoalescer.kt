package ai.deepseek.harness.mobile.bridge

import ai.deepseek.harness.mobile.agent.StreamFlusher
import ai.deepseek.harness.mobile.agent.StreamTicker
import org.json.JSONArray
import org.json.JSONObject

/**
 * 内核通道的流式出口 = [StreamFlusher] 的合批窗口 + 一份「已经发给页面」的回放日志。
 *
 * 桌面端（dsh）的纪律是「传输层老实逐条发，节流全在渲染侧」——WebSocket 每 delta
 * 一帧，渲染层用三层 rAF 合帧（≈50ms）+ 冻结前缀的增量 Markdown 消化洪峰。
 * 手机端唯一的回传通道是 evaluateJavascript：每个 token 一次主线程 post + JS 端
 * JSON.parse，是整条链路最贵的一跳，不能照搬「传输逐条」。所以把桌面渲染侧的
 * 合帧位置前移到桥出口：
 *
 *  - delta / reasoning 按「时间窗 + 字符窗」合并（规则在 StreamFlusher，全手机只有一份），
 *    等价桌面的 animation-frame 档；
 *  - 工具实时输出（[feedOutput]）走同一个窗口，只是按调用 id 各排一条通道 —— 多个工具
 *    并发时不会互相打断，也不会把 8KB 一块的 stdout 原样刷成每秒几百次 evaluateJavascript；
 *  - 其余事件（工具开始/结束、审批、计划、错误…）由调用方先 [flushAll] 再原样直发，
 *    等价桌面的 immediate 档 —— 工具、审批的顺序与延迟和内核完全一致；
 *  - 旁路直发同时天然覆盖「轮次结束/取消」的尾字冲刷，不需要额外钩子。
 *
 * 本类自己不再攒段队列（以前它攒一份、StreamFlusher 又攒一份，同一套窗口与保序规则
 * 写在两处，改一处漏一处）。这里只剩两件事：把每一段**按出桥顺序**记进回放日志，
 * 以及页面重载后按这份日志把已显示的内容补回去。
 */
class StreamCoalescer(private val send: (type: String, text: String) -> Unit) {

    companion object {
        /**
         * 合帧窗口。前端 schedulePaint 是 48/88/120ms 自适应（app.js），Kotlin 侧取
         * 24ms 保证每个前端 paint 周期都有新鲜数据；每秒最多 ~40 次 evaluateJavascript，
         * 较逐 token 的每秒数百次降一个数量级。
         */
        private const val WINDOW_MS = 24L

        /** 字符窗：模型突发吐长段时不必干等窗口，攒够即出手，体感更跟手 */
        private const val CHAR_WINDOW = 32

        /**
         * 「已发给页面」的回放预算（整条日志共用）：只给「页面被系统回收后重新认领轮次」
         * 用。超过就停止记录并标 truncated —— 宁可少补一段，也不为了补全把内存翻倍
         * （内核那份完整文本本来就在，轮末仍会整条落库）。
         */
        private const val SNAPSHOT_MAX = 300_000

        /** 回放条数上限：正文按窗口切段，长轮次会攒出成千上万条小段 */
        private const val LOG_MAX_ENTRIES = 4_000

        /** 工具实时输出的通道前缀（后面接调用 id，多个工具并发时各排各的段） */
        const val OUTPUT_PREFIX = "tool_output:"
    }

    /** 只管回放日志：段队列与窗口都在 [flusher] 里，别在这里加第三份攒法 */
    private val lock = Any()

    /**
     * 页面见过的每一段，**按发出顺序**：delta / reasoning / 工具开始结束 …… 都记在这一条线上。
     *
     * 为什么要有这份：WebView 渲染进程被系统回收后页面会**重载**，内核这一轮仍在跑，
     * 但新页面手里没有「已经流出去的东西」—— 用户看到的就是一条停在半路、甚至空白的回复
     * （实测：退出应用再进来、息屏再亮屏，像被终止了一样）。页面就绪时认领轮次 +
     * 按这份顺序回放，界面立刻接上原样，后面的事件继续往后长。
     *
     * 为什么是「一条有序日志」而不是「每种通道各攒一份」：原来只攒 delta/reasoning，
     * 工具事件直发不记 —— 重载前已经跑过的那几条工具行在新页面上根本不存在，
     * 过程组凭空少一半，要等回合结束落库再进来才看得到（用户实测点名）。
     */
    private val log = ArrayList<JSONObject>()
    private var logChars = 0
    private var sentTruncated = false

    private val flusher = StreamFlusher(
        onSegment = { type, text ->
            // 记账与出桥必须在同一把锁里成对发生：remember() 记直发事件用的就是这把锁，
            // 换一把就有了「事件排在它自己的文本前面」的空档 —— 回放顺序与出桥顺序不一致。
            // 这也保住了原来那条纪律：send 串行执行，投给 WebView 的顺序就是段队列的顺序。
            synchronized(lock) {
                rememberEventLocked(JSONObject().put("t", type).put("text", text))
                send(type, text)
            }
        },
        flushMs = WINDOW_MS,
        batchChars = CHAR_WINDOW,
        // 到点就是把文本投进 WebView，投的人本来就在主线程：挂主线程 Looper，不新起线程
        ticker = StreamTicker.MainLooper,
    )

    /** agent 线程调用：追加一段流式文本 */
    fun feed(type: String, text: String) {
        flusher.feed(type, text)
    }

    /** 工具实时输出：与正文同一套合帧窗口与保序规则，但按调用 id 各排各的段 */
    fun feedOutput(id: String, chunk: String) {
        flusher.feed(OUTPUT_PREFIX + id, chunk)
    }

    /**
     * 冲刷全部待发段（任何线程可调）。
     * 调用方约定：任何非 delta/reasoning 事件、轮次结束、取消，都先调这里。
     */
    fun flushAll() {
        flusher.flush(true)
    }

    /**
     * 直发给页面的事件也要记下来（调用方：任何非 delta/reasoning 的事件）。
     * 顺序由调用点保证 —— 事件直发前一定先 [flushAll]，文本段已经排在前面。
     */
    fun remember(ev: JSONObject) {
        synchronized(lock) { rememberEventLocked(ev) }
    }

    /**
     * 已发给页面的内容：`{delta, reasoning, truncated, segments}`。
     * 页面重载后认领正在跑的轮次时用它把已输出的部分补回去（见 AgentBridge.agentActive）。
     * `segments` 是带顺序的全量（含工具事件），`delta`/`reasoning` 是从中拼出的两条通道，
     * 给「只认文本尾巴」的老调用方留着。
     */
    fun snapshot(): JSONObject = synchronized(lock) {
        JSONObject()
            .put("delta", joinedLocked("delta"))
            .put("reasoning", joinedLocked("reasoning"))
            .put("truncated", sentTruncated)
            .put("segments", JSONArray().apply { log.forEach { put(it) } })
    }

    private fun rememberEventLocked(o: JSONObject) {
        val t = o.optString("t")
        // 工具实时输出不进回放日志：一条命令能刷出几 MB，而 tool_end 本来就带完整结果
        if (t.startsWith(OUTPUT_PREFIX)) return
        if (log.size >= LOG_MAX_ENTRIES || logChars >= SNAPSHOT_MAX) { sentTruncated = true; return }
        log.add(o)
        logChars += o.toString().length
    }

    private fun joinedLocked(type: String): String =
        log.filter { it.optString("t") == type }.joinToString("") { it.optString("text") }
}
