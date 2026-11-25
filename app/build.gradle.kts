import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---- 版本唯一真源 -----------------------------------------------------------
// version.properties 是唯一来源；文件缺失时回退到原常量（保留旧行为，避免
// 没有该文件的机器上构建直接失败）。改版本请同时更新 README 版本历史。
val versionProps = Properties().apply {
    val file = rootProject.file("version.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val appVersionCode: Int = versionProps.getProperty("versionCode")?.toIntOrNull() ?: 98
val appVersionName: String = versionProps.getProperty("versionName") ?: "0.2.1-rc.99"

// ---- 发布签名口令外置 --------------------------------------------------------
// 来源优先级：环境变量 > keystore.properties（已 gitignore）> 无（未签名）。
// 仓库里不再保存任何口令；CI 通过 ANDROID_* secrets 注入。
val keystoreProps = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
fun signingSecret(envName: String, propName: String): String? =
    System.getenv(envName) ?: keystoreProps.getProperty(propName)

android {
    namespace = "ai.deepseek.harness.mobile"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "ai.deepseek.harness.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        resourceConfigurations += listOf("zh", "en")
    }

    // ---- 构建通道（全本机执行环境计划，见 .motion/harness-plan-ondevice.md）----
    flavorDimensions += "channel"
    productFlavors {
        create("standard") {
            dimension = "channel"
            // 现状通道：targetSdk 35，底座 A（nativeLibraryDir 直跑 lib*.so）
        }
        create("complete") {
            dimension = "channel"
            // 完整通道：targetSdk 28 —— SELinux 域放行数据目录 exec/PROT_EXEC，
            // proot + Alpine rootfs 才跑得起来（Termux 保持 targetSdk 28 同因）。
            // 侧载分发，不受应用商店 targetSdk 门槛约束。
            targetSdk = 28
            versionNameSuffix = "-complete"
        }
    }

    // 发布签名：本机自签名密钥（keystore/dsh-release.jks）。口令只从
    // keystore.properties 或 ANDROID_* 环境变量读取，缺凭据时退回未签名
    // （assembleRelease 不失败，但发布门禁会拒绝未签名产物）。
    signingConfigs {
        create("release") {
            val ks = rootProject.file("keystore/dsh-release.jks")
            val alias = signingSecret("ANDROID_KEY_ALIAS", "keyAlias")
            val storePass = signingSecret("ANDROID_KEYSTORE_PASSWORD", "storePassword")
            if (ks.exists() && alias != null && storePass != null) {
                storeFile = ks
                storePassword = storePass
                keyAlias = alias
                keyPassword = signingSecret("ANDROID_KEY_PASSWORD", "keyPassword") ?: storePass
            } else if (ks.exists()) {
                logger.warn(
                    "release 签名跳过：缺少 keystore.properties 或 ANDROID_KEYSTORE_PASSWORD/ANDROID_KEY_ALIAS，" +
                        "将产出未签名包（发布前必须补齐，见 scripts/keystore.properties.example）",
                )
            }
        }
    }

    buildTypes {
        release {
            // R8：体积与私有符号收敛。keep 规则见 app/proguard-rules.pro。
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release").takeIf { it.storeFile != null }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        // 接口默认体编译成真正的 JVM default method（不生成 DefaultImpls 静态助手类）。
        // rc.110 实锤：R8 full mode 把几十个不相关的类水平合并，ToolSpec$DefaultImpls 的
        // execute(args, ctx) 静态体被搬进合并类但类型层级没对齐 —— 运行期对接口抽象方法
        // 虚调用直接 AbstractMethodError（崩溃栈：abstract method "n.p.a(JSONObject, n.l)"
        // on receiver Class<o.M>，o.M=ImagePlugin$tools$1 的合并代表）。
        // no DefaultImpls → R8 无体可搬，整类问题（所有接口的默认方法）从根上消失。
        freeCompilerArgs += "-Xjvm-default=all"
    }
    buildFeatures {
        buildConfig = true
    }
    androidResources {
        // 前端产物保持单文件、可读、可直接 review；但**源在 web/src/**，
        // app.js 由 scripts/build-web.mjs 拼接生成（gate web-bundle 逐字节守着）。
        // 改了 web/src 记得 `node scripts/build-web.mjs`（或直接跑 sync-web，它会先 --check）。
        // onnx/txt/fst 不压缩：内置语音模型（asr-small / tts-neural）由 native 直接读 assets，
        // 压缩过的 asset 只能整块解压，首次加载要多花几百毫秒；
        // fst 还额外要求「用 openFd 拿得到真实长度」做完整性自检（见 voice/TtsAssets.kt）
        noCompress += listOf("html", "js", "css", "zip", "onnx", "txt", "fst")
    }

    // ---- ABI 拆分：一个 rootfs 载荷只带一份 ----
    //
    // complete 通道里每个 ABI 都有一份 100MB+ 的 rootfs（libdshrootfs.so：
    // arm64 103.5MB / x86_64 113.3MB）。打 universal 包会把两份都塞进去 —— 实测
    // 346MB，其中 110MB 对任何一台设备都是纯浪费。拆开之后每台设备只下自己那份。
    // standard 通道没有 rootfs，拆开只是省下 sherpa/onnx 的另一份。
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    packaging {
        resources {
            // sherpa-onnx 的 .so 由 jniLibs 提供，运行时库同名冲突时保留第一份
            pickFirsts += listOf("lib/**/libonnxruntime.so", "lib/**/libsherpa-onnx-jni.so")
        }
        jniLibs {
            // 底座 A 的前提：.so 必须解压到 nativeLibraryDir 才能 exec（Termux 同款）。
            // AGP 默认 useLegacyPackaging=false 时 .so 以 STORED 方式留在 APK 内、
            // 由系统直接映射加载 —— nativeLibraryDir 是空的，注入的 busybox 等没得跑
            // （M1 模拟器实锤：lib/x86_64/ 空目录）。true = APK 内压缩 + 安装时解压。
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")

    // 二维码生成（QrSvg）：ZXing core 纯 Java，无 Play 服务依赖，也不联网
    implementation("com.google.zxing:core:3.5.3")

    /**
     * 离线语音识别：sherpa-onnx（jniLibs 里的 .so + 本地 Kotlin API 源码）。
     * 不走任何云端服务，飞行模式下也能识别。
     * 内置 26MB 中文流式模型；增强模型由用户在插件面板按需下载。
     */

    /**
     * 荣耀通透能力（可选）。
     * 把 hnvisualeffect-*.aar（当前是 hnvisualeffect-11.0.0.134.aar）放进 app/libs/ 即自动参与编译；
     * 未放置时工程仍可编译，HonorGlass 会走 CSS/半透明兜底。
     */
    val honorAar = fileTree("libs") { include("*.aar") }
    if (!honorAar.isEmpty) {
        implementation(honorAar)
    }

    // 单元测试：装配逻辑（提示词分段、顺序、工具目录过滤）是纯字符串运算，
    // 放在 JVM 侧跑比装到手机上点一遍快得多，也更容易在改动后立刻发现顺序漂移。
    testImplementation("junit:junit:4.13.2")
    // 仓库/工具层大量用 org.json：JVM 单测里 android.jar 的同名类是抛异常的桩，
    // 换成真实实现才能在本地跑（不是只在真机上才能测）
    testImplementation("org.json:json:20240303")
}

/**
 * 清单组件类名自检。
 *
 * 为什么需要：`android:name` 是**字符串**，编译器不认识它。上一版陪伴式畅聊整个坏掉，
 * 就是清单写成了 `.kernel.plugin.builtin.CompanionKeepService`（少了 `.device`）——
 * 类不存在 → `startForegroundService()` 抛异常 → 被 `runCatching{}` 吞掉 →
 * 保活服务从未启动 → 心跳从不发生 → 用户只看到「开了最强档也不主动」。
 * 这类错编译不报、单测不覆盖、装到手机上也不崩，只能靠约定或工具兜住。
 *
 * 规矩：清单里每个相对类名都必须能在 src/main 的源码里找到同包同名类；
 * 找不到就**直接构建失败**，并指出是清单哪一行、期望的包名是什么。
 */
val verifyManifestComponents by tasks.registering {
    group = "verification"
    description = "校验 AndroidManifest 中的相对组件类名都能在源码中找到"

    val manifestFile = layout.projectDirectory.file("src/main/AndroidManifest.xml")
    val sourceFiles = fileTree(layout.projectDirectory.dir("src/main")) {
        include("**/*.kt", "**/*.java")
    }
    inputs.file(manifestFile)
    inputs.files(sourceFiles)
    outputs.upToDateWhen { false }

    doLast {
        val manifest = manifestFile.asFile.readText()
        val declared = Regex("""android:name="\.([A-Za-z0-9_.]+)"""").findAll(manifest)
            .map { it.groupValues[1] }
            .toList()

        // 类名 → 所在包集合（同名类可能出现在多个包，取并集后逐个比对包名）
        val packages = HashMap<String, MutableSet<String>>()
        val pkgRe = Regex("""(?m)^package\s+([\w.]+)""")
        val classRe = Regex("""(?m)^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|internal\s+|private\s+|open\s+|abstract\s+|sealed\s+|final\s+|data\s+)*(?:class|object)\s+([A-Za-z0-9_]+)""")
        sourceFiles.forEach { f ->
            val src = f.readText()
            val pkg = pkgRe.find(src)?.groupValues?.get(1) ?: return@forEach
            if (!pkg.startsWith("ai.deepseek.harness.mobile")) return@forEach
            classRe.findAll(src).forEach { m ->
                packages.getOrPut(m.groupValues[1]) { HashSet() }.add(pkg)
            }
        }

        val root = "ai.deepseek.harness.mobile"
        val missing = ArrayList<String>()
        declared.forEach { rel ->
            val fq = "$root.$rel"
            val cls = rel.substringAfterLast('.')
            val pkg = fq.substringBeforeLast('.')
            val found = packages[cls]
            if (found == null) {
                missing += "  $fq\n      源码里没有任何叫 $cls 的类"
            } else if (pkg !in found) {
                missing += "  $fq\n      $cls 实际在：${found.joinToString("、")}"
            }
        }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "AndroidManifest 指向了不存在的组件类（这种错不会编译报错，只会在运行时静默失效）：\n" +
                    missing.joinToString("\n") +
                    "\n修法：把清单里的 android:name 改成上面的实际包名，或删掉该组件的声明。"
            )
        }
        logger.lifecycle("清单组件自检通过：${declared.size} 个相对类名全部命中源码")
    }
}

tasks.named("preBuild") { dependsOn(verifyManifestComponents) }
