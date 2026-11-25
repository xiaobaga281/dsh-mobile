package ai.deepseek.harness.mobile.kernel.plugin

import ai.deepseek.harness.mobile.agent.ToolPipeline
import ai.deepseek.harness.mobile.kernel.Workspace
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * WP4a 单测的公共替身。
 *
 * 这里刻意只搭「内核侧最小环境」：临时工作区 + 真 Workspace 沙箱 + 服务表，
 * 不碰 Android 类（本目录的单测跑在纯 JVM 上，org.json 由 testImplementation 提供）。
 */

/** 临时目录（JUnit 4 没有 @TempDir，这里统一走 nio）。 */
fun tempDir(prefix: String): File = Files.createTempDirectory(prefix).toFile()

/** 最小 PluginContext：真 Workspace + 真沙箱 + 可变服务表。 */
class FakePluginContext(
    root: File,
    override val hooks: PluginHooks = PluginHooks.disabled(),
) : PluginContext {
    override val workspace = Workspace(root)
    override val sandbox = WorkspaceSandbox(workspace)
    val services = ConcurrentHashMap<String, Any?>()
    val logs = CopyOnWriteArrayList<String>()

    override fun config(): JSONObject = JSONObject()

    override fun service(name: String): Any? = services[name]

    override fun provide(name: String, value: Any?) {
        if (name.isBlank()) return
        if (value == null) services.remove(name) else services[name] = value
    }

    override fun log(msg: String) {
        logs.add(msg)
    }
}

/**
 * RuntimeTools 替身：只实现 [approve]（审批闸门要验的就是它）。
 * 其余成员一律 NotImplementedError —— 测试若调到它们，说明闸门顺序错了，应当炸出来。
 */
class FakeRuntime(private val approveResult: Boolean) : ToolPipeline.RuntimeTools {
    var approveCalls: Int = 0
        private set
    var lastReason: String = ""
        private set

    override fun approve(name: String, args: JSONObject, reason: String): Boolean {
        approveCalls++
        lastReason = reason
        return approveResult
    }

    private fun nope(): Nothing = throw NotImplementedError("FakeRuntime: 未实现（闸门不应走到这里）")

    override fun presentPlan(title: String, plan: String): String = nope()
    override fun markGoal(status: String, summary: String): String = nope()
    override fun editGoal(objective: String, maxRounds: Int): String = nope()
    override fun todoWrite(items: JSONArray): String = nope()
    override fun search(queries: List<String>, max: Int, fetchTop: Int, charsPerPage: Int): String = nope()
    override fun subagent(task: String, maxRounds: Int): String = nope()
    override fun useSkill(name: String): String = nope()
    override fun createGoal(objective: String, maxRounds: Int): String = nope()
    override fun getGoal(): String = nope()
    override fun fetchUrl(url: String, maxChars: Int, offset: Int): String = nope()
    override fun addImage(path: String): String = nope()
    override fun addImageData(dataUrl: String, label: String): String = nope()
    override fun latestUserImage(): JSONObject? = nope()
    override fun askUser(question: String, options: JSONArray, detail: String): String = nope()
}

/** 供注册表测试用的最小工具定义。 */
fun simpleTool(name: String, body: (JSONObject) -> String = { "ran:$name" }): ToolSpec =
    SimpleTool(name, "测试工具 $name", Schemas.params(emptyMap())) { args -> body(args) }
