package ai.deepseek.harness.mobile.kernel.plugin.builtin.app

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.SelfSignedKey
import ai.deepseek.harness.mobile.kernel.KernelRuntime
import ai.deepseek.harness.mobile.kernel.Workspace
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickBool
import ai.deepseek.harness.mobile.kernel.plugin.pickInt
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * 在手机上把一个 Android 工程打成可安装的 APK。
 *
 * 工具链全部随包（都在 `.motion/harness-plan-ondevice.md` M7 里量过体积）：
 *   aapt2      Termux 的 bionic 构建（x86_64/aarch64 各一份），**直接 exec**，不需要 proot
 *   d8 / ecj / apksigner   纯 Java，跑现有 JRE 21（guest 内）
 *   android.jar 25.8MB     编译期骨架 + aapt2 链接用的框架资源
 *
 * 分工要点：aapt2 是 Android 原生二进制 → 在**宿主侧**跑（拿到的是 filesDir 真路径）；
 * java 系工具在 guest 内跑 → 路径必须翻成 /workspace/…，两套路径在这里显式转换。
 */
class AppBuildPlugin : KernelPlugin {
    override val id = "app-build"
    override val name = "手机打包"
    override val description = "在手机上创建并编译 Android 工程（app_new 脚手架 + aapt2/d8/ecj/apksigner 打包）"
    override val version = "1.0.0"

    private var app: Context? = null
    private var ws: Workspace? = null
    private var sandbox: WorkspaceSandbox? = null
    private var kernel: KernelRuntime? = null
    private var builds = 0
    private var scaffolds = 0
    private var daemon: BuildDaemon? = null

    override fun onLoad(ctx: PluginContext) {
        app = ctx.service("app.context") as? Context
        ws = ctx.workspace
        sandbox = ctx.sandbox
        kernel = ctx.service("runtime.kernel") as? KernelRuntime
    }

    override fun onUnload() {
        daemon?.close()
        daemon = null
        app = null
        ws = null
        sandbox = null
        kernel = null
    }

    override fun status(): Map<String, String> = mapOf(
        "打包次数" to builds.toString(),
        "新建工程" to scaffolds.toString(),
        "工具链" to if (BuildTools.staged(app)) "已就绪" else "未展开（首次打包时展开）",
        "构建进程" to if (daemon?.alive == true) "常驻（免重复类加载）" else "未启动",
    )

    private val c: Context get() = app ?: throw KernelError("打包插件未就绪（应用上下文缺失）")
    private val workspace get() = ws ?: throw KernelError("工作区未就绪")
    private val sb get() = sandbox ?: throw KernelError("沙箱未装配")
    private val rt get() = kernel ?: throw KernelError("运行时未装配（RuntimePlugin 未加载）")

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "app_new",
            description = "在工作区生成一个**能直接编译运行**的 Android 工程骨架：清单 + 文案资源 + " +
                "启动图标（按主色现画）+ Activity 源码（界面全用代码搭）。" +
                "做「给我做个 App」这类需求的第一步：先 app_new 建工程，再改 src/…/MainActivity.java " +
                "的界面或 res/values/strings.xml 的文案，最后 app_build 打包、app_install 安装。",
            parameters = Schemas.params(
                mapOf(
                    "description" to Schemas.prop("string", "一句话说明要做什么 App（5-10 个字）"),
                    "dir" to Schemas.prop("string", "工程目录名（工作区相对路径），如 hello"),
                    "package" to Schemas.prop("string", "包名，默认 com.dsh.<目录名>"),
                    "label" to Schemas.prop("string", "应用显示名（桌面图标下那行字），默认取目录名"),
                    "activities" to Schemas.prop("number", "页面数量 1-3，默认 1（多页会生成页面间跳转）"),
                    "color" to Schemas.prop("string", "图标主色 #RRGGBB，默认 #4C6FFF"),
                    "force" to Schemas.prop("boolean", "目录已存在且非空时是否覆盖，默认 false"),
                ),
                listOf("description", "dir"),
            ),
        ) { a ->
            val dir = a.pick("dir")
            if (dir.isBlank()) throw KernelError("需要 dir（工程目录名，如 hello）")
            val r = AppScaffold.generate(
                sb = sb,
                dirArg = dir,
                pkgArg = a.pick("package"),
                labelArg = a.pick("label"),
                activitiesArg = a.pickInt("activities", default = 1),
                colorArg = a.pick("color"),
                force = a.pickBool("force"),
            )
            scaffolds++
            JSONObject().put("ok", true)
                .put("dir", r.dir.relativeTo(workspace.root).invariantSeparatorsPath)
                .put("package", r.pkg)
                .put("activities", r.activities)
                .put("files", r.files.size)
                .put("sample", org.json.JSONArray(r.files.take(8)))
                .put("next", "改 src/${r.pkg.replace('.', '/')}/MainActivity.java 或 res/values/strings.xml，" +
                    "然后 app_build(dir=\"${r.dir.name}\")")
                .toString()
        },
        SimpleTool(
            name = "app_build",
            description = "在手机上把工作区里的 Android 工程编译成 APK。工程目录需含 AndroidManifest.xml，" +
                "可选 res/（资源）与 src/ 或 java/（Java 源码，包名与 manifest 的 package 一致）。" +
                "没有工程就先用 app_new 生成。产物用本机专属密钥签名（首次构建自动生成），可直接用 app_install 安装。",
            parameters = Schemas.params(
                mapOf(
                    "description" to Schemas.prop("string", "一句话说明在打什么（5-10 个字）"),
                    "dir" to Schemas.prop("string", "工程目录（工作区相对路径），默认根目录"),
                    "out" to Schemas.prop("string", "输出 APK 名，默认 <工程目录名>.apk"),
                    "minSdk" to Schemas.prop("number", "minSdkVersion，默认 21"),
                    "targetSdk" to Schemas.prop("number", "targetSdkVersion，默认 28"),
                ),
                listOf("description"),
            ),
        ) { a ->
            builds++
            val dir = a.pick("dir").ifBlank { "." }
            val project = sb.resolveRead(dir, mustExist = true)
            val manifest = File(project, "AndroidManifest.xml")
            if (!manifest.isFile) throw KernelError("$dir 里没有 AndroidManifest.xml")

            val tools = BuildTools.ensure(c, workspace, rt, sb)
            val outName = a.pick("out").ifBlank {
                val base = project.name.ifBlank { "app" }.replace(Regex("[^A-Za-z0-9_.-]"), "_")
                "$base.apk"
            }
            val out = sb.checkWrite(outName)
            val minSdk = a.optInt("minSdk", 21)
            val targetSdk = a.optInt("targetSdk", 28)

            val started = System.currentTimeMillis()
            val timings = build(project, manifest, out, tools, minSdk, targetSdk)
            val size = out.length()
            timings.put("wall", System.currentTimeMillis() - started)
            JSONObject().put("ok", true)
                .put("apk", out.relativeTo(workspace.root).invariantSeparatorsPath)
                .put("bytes", size)
                .put("timings", timings)
                .put(
                    "note",
                    "已用**本机专属密钥**签名（不是公共 debug 密钥）：同一台设备后续升级可直接覆盖安装；" +
                        "密钥在 .dsh-keys/signing.pkcs8.der 与 signing.cert.der —— " +
                        "删掉就再也无法覆盖升级，别删。仍属自签：装到别的手机需允许未知来源。",
                )
                .put("signed_with", if (tools.signing.fresh) "本机专属密钥（本次首次生成）" else "本机专属密钥（沿用已有）")
                .toString()
        },
    )

    /* ---------------- 打包流水线 ---------------- */

    /** 返回分段耗时（毫秒）：res/link 是宿主侧 aapt2，driver 内是各 Java 阶段 */
    private fun build(
        project: File,
        manifest: File,
        out: File,
        tools: BuildTools,
        minSdk: Int,
        targetSdk: Int,
    ): JSONObject {
        val timings = JSONObject()
        val work = File(workspace.root, ".dsh/build/${System.currentTimeMillis()}")
        work.mkdirs()
        val gen = File(work, "gen").apply { mkdirs() }
        val classes = File(work, "classes").apply { mkdirs() }
        val dex = File(work, "dex").apply { mkdirs() }
        val base = File(work, "base.apk")

        // 工程必须真的可读：重装 APK 后 uid 会变，旧工作区文件属主是上一个 uid，
        // 这时 res 目录 stat 得到「是目录」但 listFiles()=null —— 静默跳过资源编译会
        // 变成「@string/app_name not found」这种莫名其妙的链接错误（实测踩过）
        if (!project.canRead()) throw KernelError("工程目录不可读：${project.path}（属主可能属于上一个安装），" +
            "把工程重新写一遍或改属主后再试")
        // 1) aapt2 compile（有资源才做）
        val res = File(project, "res")
        if (res.isDirectory && res.listFiles() == null) {
            throw KernelError("读不到 res/ 目录（权限）：${res.path}")
        }
        val compiled = File(work, "compiled.zip")
        if (res.isDirectory && res.listFiles()?.isNotEmpty() == true) {
            val t = System.currentTimeMillis()
            runHost(
                listOf(tools.aapt2.absolutePath, "compile", "--dir", res.absolutePath, "-o", compiled.absolutePath),
                work, tools.aapt2LibDir, "aapt2 compile",
            )
            timings.put("res", System.currentTimeMillis() - t)
        }

        // 2) aapt2 link（生成 R.java 与资源表）
        val link = mutableListOf(
            tools.aapt2.absolutePath, "link",
            "-o", base.absolutePath,
            "-I", tools.androidJar.absolutePath,
            "--manifest", manifest.absolutePath,
            "--java", gen.absolutePath,
            "--min-sdk-version", minSdk.toString(),
            "--target-sdk-version", targetSdk.toString(),
            "--auto-add-overlay",
        )
        if (compiled.isFile) { link += "-R"; link += compiled.absolutePath }
        val tLink = System.currentTimeMillis()
        runHost(link, work, tools.aapt2LibDir, "aapt2 link")
        timings.put("link", System.currentTimeMillis() - tLink)

        // 3~6) ecj → d8 → 注入 dex → 签名：**一次 JVM 全跑完**
        //
        // 三个工具（ecj / d8 / apksigner）各自是独立 jar，原先每一步起一个新 JVM。
        // proot 下 HotSpot 启动本身就要好几秒（还有 ~40% 概率在 VM 初始化阶段失败要重试），
        // 对 hello world 这种小工程，「把 JVM 拉起来」的成本大于真正干活的时间。
        // 现在由随包的 DshBuild 驱动串起来：启动 1 次，抖动重试的暴露面从 3 次降到 1 次；
        // 每个 stage 用隔离的 ClassLoader（d8 与 apksigner 各自内联了不同版本的
        // guava/kotlin，塞进同一条 classpath 会互相遮蔽，症状是莫名的 NoSuchMethodError）。
        val sources = mutableListOf<File>()
        listOf("src", "java").forEach { d ->
            File(project, d).takeIf { it.isDirectory }?.let { root ->
                root.walkTopDown().filter { it.isFile && it.name.endsWith(".java") }.forEach { sources += it }
            }
        }
        gen.walkTopDown().filter { it.isFile && it.name.endsWith(".java") }.forEach { sources += it }
        if (sources.isEmpty()) throw KernelError("工程里没有 Java 源码：先用 app_new 生成，或往 src/ 里写 .java")

        val sourceList = File(work, "sources.txt").apply {
            writeAll(sources.map { g(it) })
        }
        val ecjArgs = File(work, "ecj.args").apply {
            writeAll(
                listOf(
                    "-nowarn", "-source", "8", "-target", "8",
                    "-bootclasspath", g(tools.androidJar),
                    "-d", g(classes),
                    "@" + g(sourceList),
                ),
            )
        }
        // d8 的 argfile 首行是 class 目录（驱动自己扫 *.class），其后是选项
        val d8Args = File(work, "d8.args").apply {
            writeAll(
                listOf(
                    g(classes),
                    "--lib", g(tools.androidJar),
                    "--min-api", minSdk.toString(),
                    "--output", g(dex),
                ),
            )
        }
        val withDex = File(work, "withdex.apk")
        val injectArgs = File(work, "inject.args").apply {
            writeAll(listOf(g(base), g(File(dex, "classes.dex")), g(withDex)))
        }
        val signArgs = File(work, "sign.args").apply {
            writeAll(
                listOf(
                    "sign",
                    // PKCS#8 + X.509 直接喂，不需要 keystore 与口令（apksigner 原生支持）
                    "--key", g(tools.signing.keyFile),
                    "--cert", g(tools.signing.certFile),
                    "--min-sdk-version", minSdk.toString(),
                    "--out", g(out), g(withDex),
                ),
            )
        }

        // 四个阶段写成一份 plan，交给常驻守护进程执行。
        //
        // 为什么不是「一次 JVM 跑完」（那是上一版的试错）：实测三个 Java 工具的
        // 固定成本是各自把类加载起来（ecj 5.3s / d8 4.8s / sign 2.8s，而 java -version
        // 只要 0.1s），合进一个 JVM 只省下两次 ~0.1s 的启动。真正省时间的做法是把
        // 这些类**留在内存里**——见 BuildDaemon 的注释与桌面对照（packages/terminal
        // 的会话跨调用存活、packages/subprocess 的 process lifetime）。
        val planFile = File(work, "plan.txt").apply {
            writeAll(
                listOf(
                    "--ecj", g(tools.ecj), g(ecjArgs),
                    "--d8", g(tools.d8), g(d8Args),
                    "--inject", g(injectArgs),
                    "--sign", g(tools.apksigner), g(signArgs),
                ),
            )
        }
        val dm = daemon ?: BuildDaemon(rt, g(tools.dshbuild)).also { daemon = it }
        val driverOut = dm.run(g(planFile))
        timings.put("driver", parseStages(driverOut))
        if (!out.isFile || out.length() == 0L) throw KernelError("签名失败：没有产出 APK")
        return timings
    }

    private companion object {
        /** argfile：一行一个参数（与 scripts/dshbuild/DshBuild.java 的 readArgs 对应） */
        fun File.writeAll(args: List<String>) = writeText(args.joinToString("\n") + "\n")

        /** 解析驱动打的 `[stage] --ecj ms=123 ok=true`，作为可观测的分段耗时 */
        val STAGE = Regex("""\[stage] (--\w+) ms=(\d+) ok=""")
        fun parseStages(out: String): JSONObject {
            val o = JSONObject()
            STAGE.findAll(out).forEach { m ->
                o.put(m.groupValues[1].removePrefix("--"), m.groupValues[2].toLong())
            }
            return o
        }
    }

    /** 宿主侧执行（aapt2 是 bionic 原生二进制，直接 exec，不走 proot） */
    private fun runHost(cmd: List<String>, dir: File, libDir: File, label: String) {
        val pb = ProcessBuilder(cmd).directory(dir).redirectErrorStream(true)
        pb.environment().apply {
            clear()
            put("LD_LIBRARY_PATH", libDir.absolutePath)
            put("TMPDIR", dir.absolutePath)
            put("HOME", dir.absolutePath)
        }
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        if (!p.waitFor(180, java.util.concurrent.TimeUnit.SECONDS)) {
            p.destroyForcibly()
            throw KernelError("$label 超时（180s）")
        }
        if (p.exitValue() != 0) {
            throw KernelError("$label 失败（exit=${p.exitValue()}）：\n" + out.takeLast(1500).trim())
        }
    }

    /** 把工作区绝对路径翻成 guest 里的 /workspace/… */
    private fun g(f: File): String = "/workspace/" + f.relativeTo(workspace.root).invariantSeparatorsPath
}

/**
 * 专属签名密钥（PKCS#8 私钥 + 自签 X.509 证书，各一份 DER 文件）。
 *
 * 为什么不再用随包的 `debug.keystore`：那是 **公开密钥**（密码固定 `password`/`android`），
 * 任何拿到 APK 的人都能用一个同样签名的包替换它，而且应用商店一律拒收 debug 签名。
 *
 * 为什么不再是 keytool 生成的 keystore：keytool 要在 proot 里起一个 guest JVM，而
 * proot 下 JVM 启动做 mprotect(PROT_EXEC) 会被 PaX 风格 W^X 策略**随机拦截**
 * （实测失败率 20~35%，`-Xint` 也躲不掉 —— 解释器启动同样要生成 stub）。
 * 生成密钥对与自签证书是纯密码学操作，Android 自带 JCA 直接能做 ——
 * 见 `SelfSignedKey`，全程宿主进程、毫秒级、零 proot 依赖。
 * apksigner 原生支持 `--key <pkcs8> --cert <x509>`，连 keystore 都省了。
 *
 * 诚实边界：仍是**自签**密钥，不是受信任 CA 签发；装到别人手机上仍需"允许未知来源"。
 * 它解决的是"任何人可伪造/商店拒收"，不解决"绕过系统安装确认"（那需要 root）。
 */
class SigningKey(
    /** PKCS#8 DER 私钥（宿主路径；构建时以 /workspace/.dsh-keys/… 喂给 apksigner） */
    val keyFile: File,
    /** 自签 X.509 证书 DER */
    val certFile: File,
    /** 对外声明：本机第一次生成，还是沿用已有的 */
    val fresh: Boolean,
)

/**
 * 随包工具链的展开：资产 → filesDir/buildtools（aapt2 解包到 bin/lib），
 * 并把 Java 侧要用的 jar **复制到工作区**（guest 只看得见 /workspace）。
 */
class BuildTools(
    val aapt2: File,
    val aapt2LibDir: File,
    val androidJar: File,
    val d8: File,
    val ecj: File,
    val apksigner: File,
    /** 专属签名密钥（首次构建生成、之后复用；不再是随包的公共 debug 密钥） */
    val signing: SigningKey,
    /** 一次 JVM 跑完 ecj/d8/inject/sign 的驱动（scripts/dshbuild/DshBuild.java 编译产物） */
    val dshbuild: File,
) {
    companion object {
        private const val ASSET_DIR = "buildtools"
        private val JARS = listOf(
            "android.jar" to "android.jar",
            "d8.jar" to "d8.jar",
            "ecj.jar" to "ecj.jar",
            "apksigner.jar" to "apksigner.jar",
            "dshbuild.jar" to "dshbuild.jar",
        )

        fun staged(ctx: Context?): Boolean {
            val c = ctx ?: return false
            return File(File(c.filesDir, "buildtools"), "aapt2/bin/aapt2").isFile
        }

        /**
         * 取（或首次生成）专属签名密钥。
         *
         * 文件放工作区 `.dsh-keys/`（guest 里即 /workspace/.dsh-keys/…）：
         * apksigner 在 guest 里跑，从那里直接读两份 DER。同一对文件复用 ——
         * 同一个 key 才能覆盖安装/后续升级，**删了就再也升不了级**。
         */
        private fun ensureSigningKey(ws: Workspace): SigningKey {
            val dir = File(ws.root, ".dsh-keys").apply { mkdirs() }
            val keyFile = File(dir, "signing.pkcs8.der")
            val certFile = File(dir, "signing.cert.der")
            if (keyFile.isFile && keyFile.length() > 0L && certFile.isFile && certFile.length() > 0L) {
                return SigningKey(keyFile, certFile, fresh = false)
            }
            val km = SelfSignedKey.generate(
                commonName = "DeepSeek Harness Mobile",
                organization = "DeepSeek Harness",
                country = "CN",
            )
            keyFile.writeBytes(km.pkcs8)
            certFile.writeBytes(km.cert)
            // 口令没了（无 keystore），权限收紧到仅本应用可读即可
            runCatching {
                keyFile.setReadable(false, false); keyFile.setReadable(true, true)
            }
            return SigningKey(keyFile, certFile, fresh = true)
        }

        fun ensure(ctx: Context, ws: Workspace, rt: KernelRuntime, sb: WorkspaceSandbox): BuildTools {
            val root = File(ctx.filesDir, "buildtools").apply { mkdirs() }
            val abi = android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: "x86_64"
            val aapt2Root = File(root, "aapt2").apply { mkdirs() }
            val bin = File(aapt2Root, "bin/aapt2")
            val lib = File(aapt2Root, "lib")

            if (!bin.isFile) {
                val tar = File(root, "aapt2.tar.gz")
                // aapt2 载荷按 ABI 放在 jniLibs（`libdshaapt2.so`），不再放 assets：
                // 放 assets 时**两个 ABI 的包都得各带一份**（3.9 + 3.8MB），
                // 而一台设备只用得上自己那份。jniLibs 天然按 ABI 拆分（和多载荷的
                // libdshrootfs.so 同一个道理），install 后落在 nativeLibraryDir。
                val payload = File(ctx.applicationInfo.nativeLibraryDir, "libdshaapt2.so")
                if (!payload.isFile) {
                    throw KernelError("aapt2 载荷缺失（libdshaapt2.so）：当前架构 ${abi} 的完整版安装包没带上")
                }
                payload.inputStream().use { input -> tar.outputStream().use { input.copyTo(it) } }
                // 用 busybox 解包（保留权限位）；busybox 在 KernelRuntime 装配的 bin 目录
                val bb = KernelRuntime.ensureBusyboxEnv(ctx)
                    ?: throw KernelError("busybox 未就绪，无法解包 aapt2")
                val pb = ProcessBuilder(File(bb.binPath, "busybox").absolutePath, "tar", "-xzf", tar.absolutePath,
                    "-C", aapt2Root.absolutePath).redirectErrorStream(true)
                pb.environment().apply {
                    clear(); put("LD_LIBRARY_PATH", bb.libPath); put("TMPDIR", root.absolutePath)
                }
                val p = pb.start()
                val log = p.inputStream.bufferedReader().readText()
                p.waitFor(120, java.util.concurrent.TimeUnit.SECONDS)
                if (!bin.isFile) throw KernelError("aapt2 解包失败：$log")
                bin.setExecutable(true, false)
            }

            // Java 侧的 jar 必须在工作区内，guest 才看得见
            val staged = File(ws.root, ".dsh/buildtools").apply { mkdirs() }
            val files = HashMap<String, File>()
            for ((asset, name) in JARS) {
                val dst = File(staged, name)
                if (!dst.isFile || dst.length() == 0L) {
                    ctx.assets.open("$ASSET_DIR/$asset").use { input -> dst.outputStream().use { input.copyTo(it) } }
                }
                files[name] = dst
            }
            return BuildTools(
                aapt2 = bin,
                aapt2LibDir = lib,
                androidJar = files.getValue("android.jar"),
                d8 = files.getValue("d8.jar"),
                ecj = files.getValue("ecj.jar"),
                apksigner = files.getValue("apksigner.jar"),
                signing = ensureSigningKey(ws),
                dshbuild = files.getValue("dshbuild.jar"),
            )
        }
    }
}
