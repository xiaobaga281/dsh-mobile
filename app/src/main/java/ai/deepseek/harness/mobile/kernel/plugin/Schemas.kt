package ai.deepseek.harness.mobile.kernel.plugin

import org.json.JSONArray
import org.json.JSONObject

/** JSON Schema 的小工具，插件用它声明参数，避免每处手写 JSONObject 嵌套 */
object Schemas {
    fun prop(type: String, desc: String, enum: List<String>? = null): JSONObject =
        JSONObject().apply {
            put("type", type)
            put("description", desc)
            if (enum != null) put("enum", JSONArray(enum))
        }

    fun params(props: Map<String, JSONObject>, required: List<String> = emptyList()): JSONObject =
        JSONObject().apply {
            put("type", "object")
            put("properties", JSONObject().apply { props.forEach { (k, v) -> put(k, v) } })
            put("required", JSONArray(required))
            put("additionalProperties", false)
        }
}

/**
 * 参数别名兼容：schema 一律用桌面 tool-catalog 的权威名字（file_path / old_string / todos / queries…），
 * 但早期版本用过的旧名（path / old / items / query）仍然接受——模型两种叫法都能跑。
 */
fun JSONObject.pick(vararg names: String): String {
    for (n in names) {
        if (has(n)) {
            val v = opt(n)
            when (v) {
                is String -> if (v.isNotBlank()) return v
                is Number, is Boolean -> return v.toString()
            }
        }
    }
    return ""
}

fun JSONObject.pickBool(vararg names: String, default: Boolean = false): Boolean {
    for (n in names) if (has(n)) return optBoolean(n, default)
    return default
}

fun JSONObject.pickInt(vararg names: String, default: Int = 0): Int {
    for (n in names) if (has(n)) return optInt(n, default)
    return default
}

fun JSONObject.pickLong(vararg names: String, default: Long = 0L): Long {
    for (n in names) if (has(n)) return optLong(n, default)
    return default
}

/** 把一段 lambda 包成 ToolSpec，省掉每个工具写一个类 */
class SimpleTool(
    override val name: String,
    override val description: String,
    override val parameters: JSONObject,
    override val executionMode: ToolExecutionMode = ToolExecutionMode.EXCLUSIVE,
    /**
     * 结果首行是 `exit=N` 头时，把这个 N 当作退出码带出去（只填旁路，正文一字不动）。
     *
     * 前台命令类工具（bash / run / java / rustc / pkg / compile）声明它即可，
     * 不必各自写一个 ToolSpec 子类去覆盖 [executeResult]；
     * 后台分支返回的是 `{"job_id":…}`，解析不出退出码，自然是 null。
     */
    private val exitHeader: Boolean = false,
    private val body: (JSONObject) -> String,
) : ToolSpec {
    override fun execute(args: JSONObject): String = body(args)

    // 复用同一份 body：不要在这里调 execute()，子类/自定义实现会因此跑两遍
    override fun executeResult(args: JSONObject, ctx: ToolExecContext): ToolResult {
        val text = body(args)
        return ToolResult(text, if (exitHeader) exitCodeOfHeader(text) else null)
    }
}
