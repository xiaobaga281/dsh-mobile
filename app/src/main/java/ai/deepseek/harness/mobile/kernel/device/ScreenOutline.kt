package ai.deepseek.harness.mobile.kernel.device

import org.json.JSONArray
import org.json.JSONObject

/**
 * 读屏大纲的纯函数层 —— 从 PhoneControlService.readScreen 抽出，JVM 可单测。
 *
 * 两条门槛是踩过坑的（别改回去）：
 *  - 可交互元素上限 [maxElements]（default 60）：控制 JSON 体积
 *  - 纯文本上限 200 条：**独立门槛** —— 之前写成被 elements 数量连坐
 *    （`elements.length() < maxElements`），元素攒满后整页文案消失，
 *    模型只剩一排空 label，等于读不了屏
 *  - 同一块 bounds 只记最外层一次（子节点常重复上报），但 label 非空时放行
 */
object ScreenOutline {

    /** 一个屏幕节点的判定快照（服务层采集，纯层消费） */
    data class NodeSnap(
        val ownText: String,     // 节点自身 text/contentDescription（不聚合后代）
        val label: String,       // 可读标签（ownText 或聚合后代文本）
        val cls: String,
        val id: String,          // viewIdResourceName 末段，可空
        val clickable: Boolean,
        val editable: Boolean,
        val scrollable: Boolean,
        val checkable: Boolean,
        val checked: Boolean?,   // 非 checkable 为 null
        val enabled: Boolean,
        val l: Int, val t: Int, val r: Int, val b: Int,
        /**
         * 是否真的在屏幕上。以前它是**准入条件**（`isVisibleToUser` 为假就整条丢弃），
         * 结果 WebView / Compose 自绘 / 部分国产 ROM 整树返回 false 时 elements 直接空。
         * 现在只作为输出字段 + 决定要不要给 bounds，节点本身照样收进树。
         */
        val visible: Boolean = true,
        /** viewIdResourceName 全名（`pkg:id/name`）；[id] 是它的末段，保留兼容 */
        val resId: String = "",
        /** contentDescription 独立字段（不再和 text 混在一个 label 里） */
        val cd: String = "",
        /** 节点所属包名（多窗口合并后必须能分辨来自哪个应用） */
        val pkg: String = "",
        /** 在所属窗口里的层级，便于模型理解结构 */
        val depth: Int = 0,
    ) {
        val interactive: Boolean get() = clickable || editable || scrollable
        val boundsKey: String get() = "$l,$t,$r,$b"
        val hasContent: Boolean get() = label.isNotBlank() || resId.isNotBlank()
    }

    data class Result(
        val elements: JSONArray,
        val texts: JSONArray,
        /** 成为 element 的 snap 下标（服务层用它映射回真实节点做 index 定位） */
        val elementSnaps: List<Int>,
        val truncated: Boolean,       // 可交互元素满
        /** 结构化节点树：可见节点 + 带 id/文本的不可见节点，供 res_id 精准定位 */
        val nodes: JSONArray = JSONArray(),
    )

    fun build(snaps: List<NodeSnap>, maxElements: Int, maxNodes: Int = 400): Result {
        val elements = JSONArray()
        val texts = JSONArray()
        val nodes = JSONArray()
        val elementSnaps = mutableListOf<Int>()
        val seenBounds = HashSet<String>()
        // 去重走 Set：texts 上限 200，逐条线性比对是 O(n²)（最坏 4 万次字符串比较）
        val seenTexts = HashSet<String>()

        for ((i, s) in snaps.withIndex()) {
            // 结构化树：有内容或可见的节点都进（纯空容器跳过，避免刷屏）
            if (nodes.length() < maxNodes && (s.hasContent || s.interactive)) {
                nodes.put(JSONObject().apply {
                    put("i", i)
                    put("text", s.label.take(200))
                    if (s.resId.isNotBlank()) put("res_id", s.resId)
                    if (s.cd.isNotBlank()) put("cd", s.cd.take(200))
                    put("cls", s.cls)
                    if (s.pkg.isNotBlank()) put("pkg", s.pkg)
                    put("depth", s.depth)
                    put("visible", s.visible)
                    if (s.interactive) put("clickable", true)
                    if (s.visible) put("bounds", boundsOf(s))
                })
            }
            if (s.interactive && s.visible) {
                if (elements.length() < maxElements) {
                    if (seenBounds.add(s.boundsKey) || s.label.isNotBlank()) {
                        elementSnaps.add(i)
                        elements.put(JSONObject().apply {
                            put("index", elements.length())
                            put("text", s.label)
                            put("class", s.cls)
                            if (s.id.isNotBlank()) put("id", s.id)
                            if (s.resId.isNotBlank()) put("res_id", s.resId)
                            if (s.cd.isNotBlank()) put("cd", s.cd.take(200))
                            if (s.pkg.isNotBlank()) put("pkg", s.pkg)
                            put("depth", s.depth)
                            put("clickable", s.clickable)
                            put("editable", s.editable)
                            put("scrollable", s.scrollable)
                            put("checked", s.checked?.let { it } ?: JSONObject.NULL)
                            if (!s.enabled) put("disabled", true)
                            put("bounds", boundsOf(s))
                        })
                    }
                }
            } else if (!s.interactive && s.visible && texts.length() < 200) {
                // 独立门槛（见类注释）：不随 elements 满而连坐
                val t = s.ownText.take(200)
                if (t.length > 1 && seenTexts.add(t)) texts.put(t)
            }
        }
        return Result(elements, texts, elementSnaps, truncated = elements.length() >= maxElements, nodes = nodes)
    }

    private fun boundsOf(s: NodeSnap): JSONObject = JSONObject().apply {
        put("l", s.l); put("t", s.t); put("r", s.r); put("b", s.b)
        put("cx", (s.l + s.r) / 2); put("cy", (s.t + s.b) / 2)
    }

    /** 指纹键：pkg|res_id|cls|bounds —— 定位「同一个控件」 */
    fun fingerprintKey(pkg: String, resId: String, cls: String, l: Int, t: Int, r: Int, b: Int): String =
        "$pkg|$resId|$cls|$l,$t,$r,$b"

    /** 指纹值：text|checked —— 判断「同一个控件的内容变没变」 */
    fun fingerprintValue(label: String, checked: Boolean?): String =
        "${label.take(80)}|${checked?.toString() ?: "-"}"

    /**
     * 新旧屏 diff：added（新出现）/ removed（消失）/ changed（同控件但文本或勾选变了）。
     *
     * 操作回执里替代「重截图」：模型据此立刻知道点没点中 —— `same=true` 基本等于没点中。
     * 每类最多列 12 条（控制 JSON 体积），但总数如实给。
     */
    fun diff(before: Map<String, String>, after: Map<String, String>): JSONObject {
        val added = JSONArray()
        val removed = JSONArray()
        val changed = JSONArray()
        var nAdded = 0
        var nRemoved = 0
        var nChanged = 0
        fun desc(k: String, v: String): JSONObject {
            val p = k.split('|')
            return JSONObject()
                .put("res_id", p.getOrNull(1).orEmpty())
                .put("cls", p.getOrNull(2).orEmpty())
                .put("bounds", p.getOrNull(3).orEmpty())
                .put("text", v.substringBefore('|'))
        }
        for ((k, v) in after) {
            val old = before[k]
            if (old == null) {
                nAdded++
                if (added.length() < 12) added.put(desc(k, v))
            } else if (old != v) {
                nChanged++
                if (changed.length() < 12) changed.put(desc(k, v).put("was", old.substringBefore('|')))
            }
        }
        for ((k, v) in before) {
            if (!after.containsKey(k)) {
                nRemoved++
                if (removed.length() < 12) removed.put(desc(k, v))
            }
        }
        return JSONObject()
            .put("added", added).put("removed", removed).put("changed", changed)
            .put("added_n", nAdded).put("removed_n", nRemoved).put("changed_n", nChanged)
            .put("same", nAdded == 0 && nRemoved == 0 && nChanged == 0)
    }
}
