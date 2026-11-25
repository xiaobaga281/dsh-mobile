package ai.deepseek.harness.mobile.kernel

import ai.deepseek.harness.mobile.kernel.plugin.ToolExecContext
import ai.deepseek.harness.mobile.kernel.terminal.ExecProbe
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 本机运行时层（全本机执行环境计划 · 阶段 A2）。
 *
 * 双底座解析顺序（见 .motion/harness-plan-ondevice.md §1）：
 *
 *  1. **底座 A · nativeLibraryDir 直跑**：`fetch-runtimes.mjs` 把静态 PIE 二进制改名成
 *     `libdsh<name>.so` 注入 jniLibs，APK 安装后落在 nativeLibraryDir —— 这是
 *     targetSdk 29+ 的 W^X 下唯一允许 exec 的应用目录。静态 musl 二进制无 INTERP 段，
 *     不依赖 Android 动态链接器，直接 exec 可跑。
 *  2. **底座 B · proot 用户态发行版**（仅 complete flavor，targetSdk 28 域放行数据目录
 *     PROT_EXEC）：Alpine rootfs 解在 `filesDir/runtime/proot-root/`（双载荷：assets
 *     的 common 公共部分 + nativeLibraryDir 的本架构部分，见 scripts/pack-rootfs.py），
 *     proot 装在 `filesDir/runtime/proot/`（含 loader/loader32/libtalloc/libandroid-shmem），
 *     工作区绑定挂载到 guest 的 /workspace。python/node 完整生态（pip/npm）走这里。
 *
 * 运行时缺失不抛异常文案，返回结构化 `NEED_RUNTIME`（协议见计划 §5）：
 * 阶段 B 的前端据此弹下载卡片，运行环境的增长不靠发版。
 */
class KernelRuntime(
    private val ws: Workspace,
    appContext: android.content.Context?,
) {

    companion object {
        const val TIMEOUT_MS = 20_000L
        const val MAX_OUTPUT = 64 * 1024

        /** filesDir 内的运行时资源约定目录（阶段 B 资源包下载落点） */
        const val RUNTIME_DIR = "runtime"
        const val PROOT_SUBDIR = "proot"
        const val PROOT_ROOTFS = "proot-root"

        /** 双载荷 rootfs 的公共部分（assets 内，双 ABI 共享一份） */
        const val COMMON_ASSET = "runtime/rootfs-common.tar.xz"

        /** NEED_RUNTIME 结构化错误的稳定键 */
        const val NEED_RUNTIME = "NEED_RUNTIME"

        /** guest node 的增量补丁版本（scripts/build-node-patch.py 生成，改版本要同步） */
        const val NODE_PATCH_VERSION = "v22.23.4"

        /** guest 无 init，/etc/resolv.conf 要由宿主补；这两个是公共 DNS 兜底 */
        val DEFAULT_GUEST_DNS = listOf("1.1.1.1", "8.8.8.8")

        /** 纯函数：单测直接可调，避免各处手拼 nameserver 行。
         *  空列表返回空串 —— 不能写出一个「只有换行」的文件，那会被
         *  [writeGuestResolv] 的 `length() > 0` 判成「已配置」而永远不再补齐。 */
        internal fun resolvConfText(servers: List<String>): String {
            val usable = servers.map { it.trim() }.filter { it.isNotBlank() }
            return if (usable.isEmpty()) "" else usable.joinToString("\n") { "nameserver $it" } + "\n"
        }

        /** 底座 A 注册表：运行时名 -> jniLibs 内的 so 文件名 */
        val BASE_A: Map<String, String> = mapOf(
            "python" to "libdshpython.so",
            "node" to "libdshnode.so",
        )

        /** 底座 B 注册表：运行时名 -> rootfs 内的入口（compile/run/java/rustc 也在这里解析）。
         *  **基础环境**只装 python3/nodejs/gcc/g++/busybox；java/rust 等属于「按需自给」——
         *  入口缺失时工具层回 NEED_RUNTIME，用户/智能体用 pkg 工具联网安装即可点亮，
         *  不需要改代码，也不需要把几百 MB 载荷焊进 APK。 */
        val PROOT_ENTRY: Map<String, String> = mapOf(
            "python" to "/usr/bin/python3",
            "node" to "/usr/bin/node",
            "gcc" to "/usr/bin/gcc",
            "g++" to "/usr/bin/g++",
            "sh" to "/bin/sh",
            "java" to "/usr/bin/java",
            "rustc" to "/usr/bin/rustc",
            "cargo" to "/usr/bin/cargo",
            "apk" to "/sbin/apk",
            "pip" to "/usr/bin/pip3",
            "npm" to "/usr/bin/npm",
        )

        // 重建符号链接的统一手法：Files.deleteIfExists 删的是链接本身（不跟随目标，
        // 悬空链接也能删掉）；link.exists() 会跟随目标，重装 APK 后 nativeLibraryDir
        // 路径变化产生悬空链接，exists()==false 导致跳过删除，createSymbolicLink
        // 再抛 FileAlreadyExistsException 被 runCatching 吞掉 —— 链接永久失效（踩过）。
        private fun relink(link: File, target: File): Boolean {
            if (!target.isFile) {
                android.util.Log.w("DSHRuntime", "relink 目标不存在：${target.absolutePath}")
                return false
            }
            runCatching {
                java.nio.file.Files.deleteIfExists(link.toPath())
                java.nio.file.Files.createSymbolicLink(link.toPath(), target.toPath())
            }.onFailure {
                android.util.Log.w("DSHRuntime", "relink 失败 ${link.name} -> ${target.name}：${it.message}")
            }
            // 不跟随链接判断「链接本体」是否存在（悬空链接曾让 exists() 误判并跳过删除，
            // createSymbolicLink 再抛 FileAlreadyExistsException 被吞 —— 链接永久失效）。
            val linked = java.nio.file.Files.exists(
                link.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS,
            )
            return linked && target.canRead()
        }

        /**
         * BusyBox（Termux bionic 构建）的运行时装配：
         * - jniLibs 四件套：libdshbox.so（启动器）、libdshbb.so（libbusybox）、
         *   libdshselinux.so、libdshpcre.so —— 全在 nativeLibraryDir（exec/加载合法域）；
         * - 启动器按 argv[0] 分发 applet，必须是文件名 `busybox` → bin 链接目录放
         *   `busybox -> libdshbox.so`，bash 的 PATH 挂这个目录；
         * - DT_NEEDED 是精确名（libbusybox.so.1.38.0 等）→ lib 链接目录放精确名
         *   符号链接，LD_LIBRARY_PATH 挂这个目录。链接目标都在 nativeLibraryDir，
         *   PROT_EXEC 落在允许域，standard/complete 两个 flavor 都合规。
         */
        fun ensureBusyboxEnv(appContext: android.content.Context): BusyboxEnv? {
            val native = appContext.applicationInfo.nativeLibraryDir ?: return null
            val files = appContext.filesDir
            val bin = File(File(files, ".dsh"), "bin").apply { mkdirs() }
            val lib = File(File(files, ".dsh"), "lib").apply { mkdirs() }
            val links = mapOf(
                File(bin, "busybox") to launcherFile(native),
                File(lib, "libbusybox.so.1.38.0") to File(native, "libdshbb.so"),
                File(lib, "libandroid-selinux.so") to File(native, "libdshselinux.so"),
                File(lib, "libpcre2-8.so") to File(native, "libdshpcre.so"),
            )
            for ((link, target) in links) {
                if (!relink(link, target)) return null
            }
            return BusyboxEnv(bin.absolutePath, lib.absolutePath)
        }

        private fun launcherFile(native: String) = File(native, "libdshbox.so")

        data class BusyboxEnv(val binPath: String, val libPath: String)

        /**
         * proot 组件的运行时装配：jniLibs 五件套（libdshproot/proot 本体、
         * libdshloader/loader32、libdshtalloc/libandroid-shmem 依赖库）全在
         * nativeLibraryDir；[ProotEnv.proot] 与 LD_LIBRARY_PATH 的依赖库需要
         * **精确文件名**，所以在 filesDir/runtime/proot/ 建符号链接（与 busybox 同款）。
         *
         * 但 **PROOT_LOADER 例外，必须指向 nativeLibraryDir 里的真实 .so**：
         * proot 在把 loader 注入 guest 之前要 open/mmap 这个 ELF，真机上经过
         * filesDir 的符号链接会失败并报 "the loader was not found or doesn't work"，
         * 于是 guest 里的 node/python 全部 exec 失败；用户真机实测手动
         * `export PROOT_LOADER=/data/app/.../lib/<abi>/libdshloader.so` 后一切正常。
         * libdshproot.so 二进制里硬编码的 Termux 默认路径只是「没覆盖时的兜底」，
         * 报错文案相同，容易误判成「根本没设环境变量」—— 其实设了，只是值不可用。
         */
        fun ensureProotEnv(appContext: android.content.Context): ProotEnv? {
            val native = appContext.applicationInfo.nativeLibraryDir ?: return null
            val nativeDir = File(native)
            val dir = File(File(appContext.filesDir, RUNTIME_DIR), PROOT_SUBDIR).apply { mkdirs() }
            val links = mapOf(
                File(dir, "proot") to File(nativeDir, "libdshproot.so"),
                File(dir, "loader") to File(nativeDir, "libdshloader.so"),
                File(dir, "loader32") to File(nativeDir, "libdshloader32.so"),
                File(dir, "libtalloc.so.2") to File(nativeDir, "libdshtalloc.so"),
                File(dir, "libandroid-shmem.so") to File(nativeDir, "libdshshmem.so"),
            )
            val bad = links.filter { (link, target) -> !relink(link, target) }
            if (bad.isNotEmpty()) {
                android.util.Log.w("DSHRuntime", "proot 符号链接装配失败：${bad.keys.joinToString { it.name }}")
            }
            val env = ProotEnv(dir, nativeDir)
            // loader 是整套 guest 执行的命门：装配完立刻自检，别等 proot 抛英文错误。
            if (!env.loader.isFile || !env.loader.canRead() || env.loader.length() == 0L) {
                android.util.Log.w("DSHRuntime", "libdshloader.so 不可用：${env.loader.absolutePath}")
                return null
            }
            // 真机排障用：`adb logcat -s DSHRuntime` 能直接看到 App 到底把哪个路径
            // 交给了 proot，不用再靠「手动 export 就能跑」反推。
            android.util.Log.i("DSHRuntime", "PROOT_LOADER=${env.loader.absolutePath}")
            return env
        }

        data class ProotEnv(val dir: File, val native: File) {
            /** proot 本体由宿主 ProcessBuilder 直接 exec，符号链接可用（依赖精确名） */
            val proot: File get() = File(dir, "proot")

            /** 真实 .so 优先；仅当 APK 没解出原生库时才退回符号链接 */
            private fun realOrLink(so: String, link: String): File {
                val real = File(native, so)
                return if (real.isFile && real.canRead()) real else File(dir, link)
            }

            val loader: File get() = realOrLink("libdshloader.so", "loader")
            val loader32: File get() = realOrLink("libdshloader32.so", "loader32")
        }

        /**
         * rootfs 首用解包（双载荷，见 scripts/pack-rootfs.py）：
         * - common（assets/runtime/rootfs-common.tar.xz）：双 ABI 逐字节相同的非 ELF
         *   公共内容（Python 标准库、证书……），APK 里只存一份；
         * - abi（nativeLibraryDir/libdshrootfs.so）：本架构的 ELF 二进制与差异文件。
         * 解包顺序 common → abi，用 busybox tar -xJf（xz；xz applet 实测在包内）。
         * 标记文件记录载荷指纹（大小对），APK 更新后自动重解，防止半包与陈旧树。
         * 同步阻塞，调用方必须在后台线程。
         * 注意：busybox 是「启动器 + libbusybox」结构，必须带 LD_LIBRARY_PATH，
         * 否则 CANNOT LINK EXECUTABLE（与探针 devExec 踩的是同一个坑）。
         */
        fun ensureRootfs(common: File?, src: File, dest: File, bb: BusyboxEnv): Boolean {
            val fingerprint = "${src.length()}:${common?.length() ?: 0}"
            if (File(dest, ".dsh-ready").readTextOrNull() == fingerprint) return true
            if (!src.isFile) return false
            dest.deleteRecursively()
            dest.mkdirs()
            // busybox tar 的 -J 是 spawn 外部 `xz`（applet 经 PATH 查找）——bin 目录里
            // 必须有名为 xz 的入口，否则 can't execute 'xz'（设备端实测踩过）
            relink(File(bb.binPath, "xz"), File(bb.binPath, "busybox"))
            val tar = File(bb.binPath, "busybox").absolutePath
            for (payload in listOfNotNull(common, src)) {
                val pb = ProcessBuilder(
                    tar, "tar", "-xJf", payload.absolutePath, "-C", dest.absolutePath,
                ).redirectErrorStream(true)
                pb.environment().apply {
                    clear()
                    put("PATH", bb.binPath)
                    put("LD_LIBRARY_PATH", bb.libPath)
                    put("TMPDIR", dest.absolutePath)
                }
                val p = pb.start()
                p.inputStream.readBytes() // 吸干输出防阻塞
                val ok = p.waitFor(10, TimeUnit.MINUTES) && p.exitValue() == 0
                if (!ok) { dest.deleteRecursively(); return false }
            }
            File(dest, ".dsh-ready").writeText(fingerprint)
            return true
        }

        private fun File.readTextOrNull(): String? = runCatching { readText() }.getOrNull()

        /**
         * common 公共载荷落盘：APK assets 是压缩流不可直接喂 tar，拷到
         * filesDir/runtime/ 下（~8MB，几十毫秒）。每次都重拷 —— available()
         * 对压缩 asset 流返回的是假长度，不能做跳过判定；8MB 拷贝幂等且廉价。
         */
        fun ensureCommonPayload(appContext: android.content.Context): File? {
            val f = File(File(appContext.filesDir, RUNTIME_DIR), "rootfs-common.tar.xz")
            runCatching {
                appContext.assets.open(COMMON_ASSET).use { input ->
                    f.parentFile?.mkdirs()
                    f.outputStream().use { input.copyTo(it) }
                }
            }
            return if (f.isFile && f.length() > 0) f else null
        }
    }

    private val nativeDir: File? = appContext?.applicationInfo?.nativeLibraryDir?.let(::File)
    private val ctx: android.content.Context? = appContext
    private val filesDir: File? = appContext?.filesDir
    private val bbEnv: BusyboxEnv? = appContext?.let { ensureBusyboxEnv(it) }
    private val prootEnv: ProotEnv? = appContext?.let { ensureProotEnv(it) }

    /** proot 底座只对 targetSdk ≤ 28 的 complete flavor 开放（29+ W^X 禁数据目录 exec） */
    private val prootSupported: Boolean =
        (appContext?.applicationInfo?.targetSdkVersion ?: 34) < 29

    private val rootfsDest: File? =
        filesDir?.let { File(File(it, RUNTIME_DIR), PROOT_ROOTFS) }
    private val rootfsSrc: File? = nativeDir?.let { File(it, "libdshrootfs.so") }

    /** 首用解包的互斥锁：并发工具调用只解一次 */
    private val rootfsLock = Any()

    /**
     * 底座 B 就绪检查；未解包且来源存在时同步解包（xz 双载荷，首次数十秒）。
     * 返回 null 表示底座 B 不可用（flavor 不支持 / 包未内置 / 解包失败）。
     */
    fun prepareProotRootfs(): File? {
        if (!prootSupported) return null
        val dest = rootfsDest ?: return null
        val src = rootfsSrc ?: return null
        val bb = bbEnv ?: return null
        val ready = if (File(dest, ".dsh-ready").isFile) {
            ensureGitPatch(dest, bb); ensureNpmPatch(dest, bb); ensureNodePatch(dest, bb); ensureSetarchPatch(dest, bb); ensurePaxPatch(dest)
            dest
        } else synchronized(rootfsLock) {
            if (File(dest, ".dsh-ready").isFile) {
                ensureGitPatch(dest, bb); ensureNpmPatch(dest, bb); ensureNodePatch(dest, bb); ensureSetarchPatch(dest, bb); ensurePaxPatch(dest)
            } else {
                val common = ctx?.let { ensureCommonPayload(it) }
                if (!ensureRootfs(common, src, dest, bb)) return null
                ensureGitPatch(dest, bb)
                ensureNpmPatch(dest, bb)
                ensureNodePatch(dest, bb)
                ensureSetarchPatch(dest, bb)
                ensurePaxPatch(dest)
            }
            dest
        }
        // guest 的 /etc/resolv.conf 必须在 rootfs 就绪（.dsh-ready 写好）之后补：
        // 以前只在 pkg manager=apk 分支里调，且排在 guestExec 解包之前 —— 冷启动首次
        // 那条路径上 .dsh-ready 还不存在，注入直接被跳过；pip/npm/node fetch/终端更是
        // 一次都轮不到。放到唯一入口，三条 guest 路径（exec/guestExec/openGuest）全覆盖。
        writeGuestResolv(ready)
        // execfix 必须在这里预热：终端会话的入口是 /bin/sh，永远进不到「java 入口」
        // 那段代码，靠 java 触发的懒编译在终端里永远不会发生（真机实测：.dsh/execfix.c
        // 根本没被写出来，libdshexecfix.so 也不存在，于是 java 照旧失败）。
        warmUpExecFix(ready)
        return ready
    }

    /** execfix 预热只做一次（进程级）；置位先于编译，防重入 */
    @Volatile private var execFixWarm = false

    /**
     * 在 rootfs 就绪时编译 shim 并装 `/usr/local/bin` 包装。
     *
     * 同步执行（约 1s），因为**终端里第一句 `java` 就该是好的**：放到后台线程会让
     * 「刚打开终端立刻敲 java」这一手继续失败，诊断又变成猜谜。发生在首次准备
     * rootfs 时，那一步本身要解包 100MB+，多 1s 看不出来。
     *
     * 重入：编译要走 [guestExec]（guest gcc），它会再调 [prepareProotRootfs] ——
     * 标志位在编译前置位，递归那次直接返回。
     */
    private fun warmUpExecFix(rootfs: File) {
        if (execFixWarm) return
        execFixWarm = true
        runCatching { ensureExecFix(rootfs) }
    }

    /**
     * rootfs 就绪后补齐 git —— `create_worktree` 与终端里的版本管理都依赖它，
     * 而基础镜像只带了 gcc/python/node/java，没有 git。
     *
     * 为什么做成**增量补丁**而不是把 git 打进 rootfs 主载荷：主载荷是 157MB 的 xz
     * （`pack-rootfs.py`），重建一次要重新走设备端打包 → pull → pack 全链；而 git 补丁
     * 只有 4MB、内容只增不改，放在 jniLibs（`libdshgit.so`，按 ABI 只带自己那份，
     * 与 aapt2 载荷同一个先例）+ 这里幂等解包，旧安装也直接受益。
     *
     * 幂等：`usr/bin/git` 已存在就跳过 —— gitpatch 内容升级时靠 rootfs 指纹变化
     * 触发全量重建，重建后 git 消失、这里重新补。
     *
     * 解包必须用**宿主侧** busybox（与 aapt2 解包同一个）：rootfs 里的二进制是 musl
     * 动态链接，宿主直接执行会报 "No such file or directory"（缺 /lib/ld-musl，
     * 与 guardGuestEntry 那次是同一类现象，但这次是执行而非探测）。
     */
    private fun ensureGitPatch(dest: File, bb: BusyboxEnv): Boolean {
        if (File(dest, "usr/bin/git").isFile) return true
        val payload = try {
            File(ctx?.applicationInfo?.nativeLibraryDir ?: return false, "libdshgit.so")
        } catch (_: Throwable) {
            return false
        }
        if (!payload.isFile) return false
        val pb = ProcessBuilder(
            File(bb.binPath, "busybox").absolutePath, "tar", "-xzf",
            payload.absolutePath, "-C", dest.absolutePath,
        ).redirectErrorStream(true)
        pb.environment().apply {
            clear()
            put("PATH", bb.binPath)
            put("LD_LIBRARY_PATH", bb.libPath)
            put("TMPDIR", dest.absolutePath)
        }
        val p = pb.start()
        p.inputStream.readBytes() // 吸干输出防阻塞
        return runCatching { p.waitFor(2, TimeUnit.MINUTES) && p.exitValue() == 0 }.getOrDefault(false)
    }

    /**
     * rootfs 就绪后补齐 npm / npx / node-gyp（Alpine v3.20 npm 10.9.1，纯 JS，约 2MB）。
     *
     * 为什么必须内置而不能「联网装」：基础镜像只有 node 单二进制，`pkg manager=npm`
     * 指向的正是不存在的 /usr/bin/npm；让用户「联网装 npm」等于让他用一个缺失的入口
     * 去装它自己（自举死循环）。真机上 DNS/网络还不一定通，装包这条路更不成立。
     *
     * 载荷 `libdshnpm.so` 是 gzip tar（与 git 补丁同款，由 scripts/build-npm-patch.py
     * 从 Alpine npm .apk 重组），双 ABI 内容相同 —— npm 里 0 个 ELF，node 已在本 ABI 主载荷。
     *
     * 与 git 补丁刻意不同的三点（都是既有欠账，不要照抄回去）：
     *  1. 幂等看 **npm-cli.js 本体**而不是 /usr/bin/npm —— 后者是相对 symlink，
     *     只解出链接没解出 node_modules 时 File.isFile 会误判「已装好」；
     *  2. 写独立标记 `.dsh-npm-ready`，解包成功才落，失败下次自动重试；
     *     git 补丁没有自己的标记，只靠主载荷大小变化才重解；
     *  3. 解包失败留 Log.w 出口并保留 tar 的输出 —— git 补丁把 stderr 读掉丢弃、
     *     调用方还忽略返回值，出错只能靠猜。
     */
    private fun ensureNpmPatch(dest: File, bb: BusyboxEnv): Boolean {
        val cli = File(dest, "usr/lib/node_modules/npm/bin/npm-cli.js")
        val mark = File(dest, ".dsh-npm-ready")
        if (isRegularFileNoFollow(cli) && mark.isFile) return true
        val payload = try {
            File(ctx?.applicationInfo?.nativeLibraryDir ?: return false, "libdshnpm.so")
        } catch (_: Throwable) {
            return false
        }
        if (!payload.isFile) {
            android.util.Log.w("DSHRuntime", "npm 补丁载荷缺失：libdshnpm.so（先跑 scripts/build-npm-patch.py）")
            return false
        }
        val pb = ProcessBuilder(
            File(bb.binPath, "busybox").absolutePath, "tar", "-xzf",
            payload.absolutePath, "-C", dest.absolutePath,
        ).redirectErrorStream(true)
        pb.environment().apply {
            clear()
            put("PATH", bb.binPath)
            put("LD_LIBRARY_PATH", bb.libPath)
            put("TMPDIR", dest.absolutePath)
        }
        val p = pb.start()
        val out = String(p.inputStream.readBytes(), Charsets.UTF_8).take(600)
        val ok = runCatching { p.waitFor(2, TimeUnit.MINUTES) && p.exitValue() == 0 }.getOrDefault(false)
        if (!ok || !isRegularFileNoFollow(cli)) {
            android.util.Log.w("DSHRuntime", "npm 补丁解包失败 ok=$ok：${out.ifBlank { "(无输出)" }}")
            return false
        }
        // 入口是 `#!/usr/bin/env node` 的脚本 + 相对 symlink；宿主 umask 可能抹掉 exec 位
        listOf(
            "usr/lib/node_modules/npm/bin/npm-cli.js",
            "usr/lib/node_modules/npm/bin/npx-cli.js",
            "usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js",
        ).forEach { runCatching { File(dest, it).setExecutable(true, false) } }
        runCatching { mark.writeText("npm-10.9.1") }
        return true
    }

    /**
     * rootfs 就绪后把 guest 的 node 20 换成 **22 LTS**（`libdshnode.so` 增量补丁）。
     *
     * 为什么这样能成：Alpine rootfs 是 musl，官方 nodejs.org 的 linux 二进制是 glibc
     * 跑不了；Alpine 自带 nodejs 又拖着一整套 libuv/libicu/... 共享库，升级它等于重建
     * 100MB+ 主载荷。补丁用的是 unofficial-builds 的 *-musl 半静态构建 —— 那些库都
     * 静态编进 node 自身，DT_NEEDED 只剩 `ld-musl-*.so.1` 与 `libgcc_s.so.1`，
     * 这两个基础 rootfs 里已经存在。载荷里**只放 bin/node**，npm 仍由 libdshnpm.so
     * 提供（官方 tar 自带 npm/corepack，混进来会互相覆盖）。
     *
     * 解包到 `usr/bin/node.dsh22` 后再 rename 覆盖 `/usr/bin/node`：Linux rename 是
     * 原子的，且**失败时旧 node 20 原封不动** —— 补丁出问题只是没升级，不会让 guest
     * 连 node 都没有。标记 `.dsh-node-ready` 随 rootfs 重建一起消失，自动重打补丁。
     */
    private fun ensureNodePatch(dest: File, bb: BusyboxEnv): Boolean {
        val mark = File(dest, ".dsh-node-ready")
        if (mark.isFile && mark.readTextOrNull() == NODE_PATCH_VERSION) return true
        val payload = nativeDir?.let { File(it, "libdshnode.so") } ?: return false
        if (!payload.isFile) {
            android.util.Log.w("DSHRuntime", "node 补丁载荷缺失：libdshnode.so（先跑 scripts/build-node-patch.py）")
            return false
        }
        // busybox tar 的 -J 要 spawn 外部 xz applet（与 ensureRootfs 同一手法）
        relink(File(bb.binPath, "xz"), File(bb.binPath, "busybox"))
        val pb = ProcessBuilder(
            File(bb.binPath, "busybox").absolutePath, "tar", "-xJf",
            payload.absolutePath, "-C", dest.absolutePath,
        ).redirectErrorStream(true)
        pb.environment().apply {
            clear()
            put("PATH", bb.binPath)
            put("LD_LIBRARY_PATH", bb.libPath)
            put("TMPDIR", dest.absolutePath)
        }
        val p = pb.start()
        val out = String(p.inputStream.readBytes(), Charsets.UTF_8).take(600)
        val ok = runCatching { p.waitFor(3, TimeUnit.MINUTES) && p.exitValue() == 0 }.getOrDefault(false)
        val staged = File(dest, "usr/bin/node.dsh22")
        if (!ok || !isRegularFileNoFollow(staged)) {
            android.util.Log.w("DSHRuntime", "node 补丁解包失败 ok=$ok：${out.ifBlank { "(无输出)" }}")
            return false
        }
        runCatching { staged.setExecutable(true, false) }
        if (!staged.renameTo(File(dest, "usr/bin/node"))) {
            android.util.Log.w("DSHRuntime", "node 22 替换 /usr/bin/node 失败，保留 node 20")
            return false
        }
        runCatching { mark.writeText(NODE_PATCH_VERSION) }
        android.util.Log.i("DSHRuntime", "guest node 已升级到 $NODE_PATCH_VERSION")
        return true
    }

    /**
     * rootfs 就绪后补齐 setarch（util-linux，约 19KB）—— **PaX/W^X 内核上 JVM 抖动的根治项**。
     *
     * 现象与机制：proot 转译下 guest JVM 启动要 `mprotect(PROT_EXEC)` 标记代码页，
     * 在启用地址随机化（PaX RANDMMAP / OEM 加固内核）时会**间歇性**失败，JDK 打出
     * "Failed to mark memory page as executable - check if grsecurity/PaX is enabled"。
     * 基础镜像里唯一的 setarch 是 busybox 链接，而我们的 busybox 没编译这个 applet
     * （实测报 "setarch: applet not found"），模型在终端里根本绕不过去。
     *
     * `setarch -R`（ADDR_NO_RANDOMIZE）去掉地址随机化后该路径稳定成功；personality
     * 由 fork/exec 继承，盖住整个 JVM 生命周期。与 git 补丁同一套机制：jniLibs 载荷
     * （`libdshsetarch.so`，按 ABI 只带自己那份）+ 这里幂等解包，旧安装直接受益。
     *
     * 幂等判定必须**不跟随符号链接**：基础镜像的 `usr/bin/setarch` 是指向 busybox 的
     * 链接（applet 缺失，是坏的），`File.isFile` 会跟随链接误判为已补。
     */
    private fun ensureSetarchPatch(dest: File, bb: BusyboxEnv): Boolean {
        val target = File(dest, "usr/bin/setarch")
        if (isRegularFileNoFollow(target)) return true
        val payload = try {
            File(ctx?.applicationInfo?.nativeLibraryDir ?: return false, "libdshsetarch.so")
        } catch (_: Throwable) {
            return false
        }
        if (!payload.isFile) return false
        // 坏链接先摘掉，再解包（busybox tar 对「解到已存在的符号链接上」行为不定）
        runCatching { target.delete() }
        val pb = ProcessBuilder(
            File(bb.binPath, "busybox").absolutePath, "tar", "-xzf",
            payload.absolutePath, "-C", dest.absolutePath,
        ).redirectErrorStream(true)
        pb.environment().apply {
            clear()
            put("PATH", bb.binPath)
            put("LD_LIBRARY_PATH", bb.libPath)
            put("TMPDIR", dest.absolutePath)
        }
        val p = pb.start()
        p.inputStream.readBytes() // 吸干输出防阻塞
        val ok = runCatching { p.waitFor(1, TimeUnit.MINUTES) && p.exitValue() == 0 }.getOrDefault(false)
        // 解包后权限补一道（tar 里的 mode 可能被宿主 umask 干掉）
        runCatching { target.setExecutable(true, false) }
        return ok && isRegularFileNoFollow(target)
    }

    /**
     * 「不跟随符号链接的普通文件」判定 —— android.system.Os.lstat。
     * 不用 java.nio.Files.readAttributes：AGP 的 android.jar 与 JDK 的 java.nio
     * 在 Kotlin 编译期类路径冲突（实测：BasicFileAttributes 解析不到）。
     */
    private fun isRegularFileNoFollow(f: File): Boolean = runCatching {
        val st = android.system.Os.lstat(f.absolutePath)
        (st.st_mode.toInt() and android.system.OsConstants.S_IFMT) == android.system.OsConstants.S_IFREG
    }.getOrDefault(false)

    /**
     * rootfs 就绪后给 JVM 启动器打 PaX 豁免（paxctl -c -m -r 的等价实现，见 [PaxFlags]）。
     *
     * 为什么不是 setarch：用户真机实测 app_build 守护进程**连续 5 次同一拒绝**——
     * 内核 MPROTECT（W^X）是确定性策略拒绝，不是地址随机化抖动；setarch -R 只去
     * 随机化，动不了策略。豁免要改的是 JVM 启动器自己的 PT_PAX_FLAGS 段，文件在
     * 我们 rootfs 里，宿主可直接改写、无需 root（Debian 在 grsec 内核上跑 OpenJDK
     * 的同一做法）。
     *
     * 幂等：逐文件判定（ALREADY_OK 即跳过），rootfs 全量重建后重打也安全。
     * 启动器范围：usr/lib/jvm 下每个 JDK 的 bin 目录里的全部真 ELF（headless JDK
     * 共 6 个；javac 走 JDK 内编译 API、gradle 经 JAVA_HOME 调 bin/java，全部覆盖）。
     */
    private fun ensurePaxPatch(dest: File): Boolean {
        val jvms = File(dest, "usr/lib/jvm").listFiles() ?: return false
        var ok = true
        for (jvm in jvms) {
            val bins = File(jvm, "bin").listFiles() ?: continue
            for (f in bins) {
                if (!isRegularFileNoFollow(f)) continue
                when (PaxFlags.patch(f)) {
                    PaxFlags.Outcome.PATCHED,
                    PaxFlags.Outcome.ALREADY_OK,
                    PaxFlags.Outcome.NOT_ELF,
                    PaxFlags.Outcome.NO_SEGMENT -> Unit
                    PaxFlags.Outcome.UNSUPPORTED,
                    PaxFlags.Outcome.FAILED -> ok = false
                }
            }
        }
        return ok
    }

    /**
     * 后台预解：应用启动（插件加载）即开始准备 rootfs，工具调用到达时通常已就绪，
     * 把首次调用的数十秒解包时间藏进启动路径。daemon 线程，插件卸载不阻塞退出；
     * 解包幂等（.dsh-ready 指纹防重），残余产物无副作用。
     */
    fun warmup() {
        if (prootStage() != "STAGED") return
        Thread {
            // 解包 157MB（xz）是重活：降到后台优先级，子进程 busybox 会继承 nice，
            // 否则用户刚开 App 装东西时会被自己拖到 ANR（实测：冷启动 Load 28，
            // systemui 与安装器一起无响应）。再让出 6 秒给首屏与用户操作。
            runCatching { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND) }
            runCatching { Thread.sleep(6_000) }
            runCatching { prepareProotRootfs() }
        }.apply { isDaemon = true; name = "dsh-rootfs-warmup" }.start()
    }

    /** 进程树终止与 ShellTool 同源实现（killTree 无状态，组合复用，避免复制这份 /proc 逻辑） */
    private val killer = ShellTool(ws)

    /** 供后台任务（job_kill）终止整棵进程树 */
    fun killTree(proc: Process) = killer.killTree(proc)

    /**
     * guest 入口是否已在解包树内（status 展示用）：只查文件，**绝不触发解包** ——
     * [resolve]/[isAvailable] 会同步解包，不能在 UI 路径上调用。
     */
    fun guestEntryBaked(entry: String): Boolean =
        rootfsDest?.let { File(it, entry).isFile } == true

    sealed class Resolution {
        /** 底座 A：直接 exec 的静态二进制 */
        data class Direct(val bin: File) : Resolution()

    /** 底座 B：经 proot 进 guest 执行 */
    data class Proot(val proot: File, val loader: File, val rootfs: File, val entry: String) : Resolution()
    }

    fun isAvailable(name: String): Boolean = resolve(name) != null

    /**
     * 轻量状态探针（不触发解包，供设置页/状态栏展示）：
     * READY=就绪; STAGED=已内置未解包（首次使用自动准备）; SDK_UNSUPPORTED=标准版不支持; MISSING=未内置
     */
    fun prootStage(): String = when {
        !prootSupported -> "SDK_UNSUPPORTED"
        rootfsDest?.let { File(it, ".dsh-ready").isFile } == true -> "READY"
        rootfsSrc?.isFile == true -> "STAGED"
        else -> "MISSING"
    }

    /** 解析一个运行时的可用实现；null = 两底座都没有，调用方回 NEED_RUNTIME */
    fun resolve(name: String): Resolution? {
        BASE_A[name]?.let { so ->
            val d = nativeDir ?: return@let
            val f = File(d, so)
            if (f.isFile) return Resolution.Direct(f)
        }
        val env = prootEnv ?: return null
        val entry = PROOT_ENTRY[name] ?: return null
        val rootfs = prepareProotRootfs() ?: return null
        return Resolution.Proot(env.proot, env.loader, rootfs, entry)
    }

    /**
     * NEED_RUNTIME 结构化错误：消息以稳定标记开头（前端/模型都可解析），
     * 格式 `NEED_RUNTIME:<runtime>`。
     */
    fun needRuntime(name: String): String {
        val ready = rootfsDest?.let { File(it, ".dsh-ready").isFile } == true
        val entry = PROOT_ENTRY[name]
        val missingInGuest = ready && entry != null && rootfsDest?.let { !File(it, entry).exists() } == true
        val why = when {
            !prootSupported -> "标准版（targetSdk 29+）系统禁止在数据目录执行程序，" +
                "proot 底座不可用；请安装完整版安装包。"
            name == "proot" && prootEnv == null ->
                "proot 运行时装配失败：libdshloader.so 或符号链接不可用。" +
                "proot 找不到 loader 时会报 'the loader was not found or doesn't work'，" +
                "guest 里的 node/python 会全部 exec 失败。" +
                "看 Logcat 的 DSHRuntime 标签有具体失败原因；重装完整版安装包可恢复。"
            name == "proot" ->
                "PROOT_LOADER 指向的文件不可读（proot 需要真实 .so 文件，不能是符号链接）。" +
                "看 Logcat 的 DSHRuntime 标签；重装完整版安装包可恢复。"
            rootfsSrc?.isFile != true -> "该设备架构（${android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: "?"}）" +
                "的运行环境包未内置，需更新安装包或等待架构支持。"
            missingInGuest && name == "npm" ->
                "npm / npx / node-gyp 由增量补丁 libdshnpm.so 内置（不需要联网安装），" +
                "这次没解到 rootfs 里。看 Logcat 的 DSHRuntime 标签有解包失败原因；" +
                "常见是完整版安装包里缺这份载荷、或 rootfs 解包中途失败。重试一次，" +
                "持续失败请反馈日志。"
            missingInGuest -> "$name 不在基础镜像里（只内置 python/node/gcc/g++ 与 npm 补丁）。" +
                "用系统包管理器装：pkg manager=apk args=[\"add\",\"<包名>\"]；" +
                "**不要用 pkg manager=pip/npm 去装 pip/npm 自己** —— 那正是缺失的入口。" +
                "此路径要求 guest 能联网：/etc/resolv.conf 已由运行时自动补齐，" +
                "若仍报 EAI_AGAIN（受限网络/模拟器常禁 UDP DNS），给 pkg 传 proxy 走 HTTP 代理。"
            else -> "运行环境解包失败，重试一次；持续失败请反馈日志。"
        }
        return "NEED_RUNTIME:$name\n本机 $name 运行环境不可用。$why"
    }

    /**
     * 执行脚本：workspace 内脚本 + 参数，输出回传格式与 [ShellTool.exec] 一致
     * （`exit=N` 头 + 正文），调用方（工具层）可按 bash 同款方式解析退出码。
     */
    fun exec(
        runtime: String,
        script: File,
        args: List<String> = emptyList(),
        timeoutMs: Long = TIMEOUT_MS,
        onStart: ((Process) -> Unit)? = null,
    ): String {
        val res = resolve(runtime)
            ?: throw KernelError(needRuntime(runtime))
        if (res is Resolution.Proot) guardGuestEntry(res.rootfs, res.entry, runtime)
        val rel = script.relativeToOrNull(ws.root)
            ?: throw KernelError("脚本必须在工作区内：${script.path}")
        return when (res) {
            is Resolution.Direct -> spawn(
                listOf(res.bin.absolutePath, script.absolutePath) + args,
                directEnv(),
                timeoutMs, onStart,
            )
            is Resolution.Proot -> {
                val (effEntry, guestArgs) = withJvmAntiPax(res.rootfs, res.entry,
                    listOf("/workspace/${rel.invariantSeparatorsPath}") + args)
                spawn(
                    prootArgs(Resolution.Proot(res.proot, res.loader, res.rootfs, effEntry), guestArgs),
                    prootHostEnv(),
                    timeoutMs, onStart,
                )
            }
        }
    }

    /**
     * JVM 入口统一经 `setarch -R`（ADDR_NO_RANDOMIZE）—— PaX/W^X 内核的根治项。
     *
     * 现象：proot 转译下 guest JVM 启动的 `mprotect(PROT_EXEC)` 在地址随机化下间歇性
     * 失败（"Failed to mark memory page as executable"）。禁 ASLR 后稳定成功，
     * personality 随 fork/exec 继承覆盖整个 JVM 生命周期。补丁（ensureSetarchPatch）
     * 没就位时原样返回，由 JvmStartupJitter 的重试兜底。
     *
     * @return (proot 层 entry, entry 之后的 guest 参数)。非 JVM 入口原样透传。
     */
    private fun withJvmAntiPax(rootfs: File, entry: String, args: List<String>): Pair<String, List<String>> {
        if (entry != PROOT_ENTRY["java"]) return entry to args
        if (!isRegularFileNoFollow(File(rootfs, "usr/bin/setarch"))) return entry to args
        return "/usr/bin/setarch" to (listOf("-R", entry) + args)
    }

    /** execfix shim 状态：null=未判定 / true=可用 / false=不可用（gcc 缺失或编译失败） */
    @Volatile private var execFixState: Boolean? = null

    /** 编译失败时留下的现场（gcc 缺失/报错），供守护进程把原因带给用户；成功则 null */
    @Volatile private var execFixError: String? = null

    /** execfix 不可用时的现场说明；可用或尚未判定时为 null */
    fun execFixHint(): String? = execFixError

    /**
     * W^X execmod 补丁的编译与缓存（背景与真机实证见 [ExecFix]）。
     *
     * rootfs 里没有 shim 就用 guest gcc 编一次（自包含源码，不依赖任何 C 头文件，
     * 约 1s）；已有直接复用。gcc 缺失或编译失败时返回 null —— java 入口不带
     * LD_PRELOAD，行为与 rc.116 一致，探针（[ExecProbe]）仍会给出判别证据，
     * 失败原因进 [execFixHint] 附在报错末尾（不静默）。
     */
    private fun ensureExecFix(rootfs: File): String? {
        execFixState?.let { return if (it) ExecFix.SO_GUEST_PATH else null }
        synchronized(this) {
            execFixState?.let { return if (it) ExecFix.SO_GUEST_PATH else null }
            execFixState = runCatching {
                val so = File(rootfs, ExecFix.SO_HOST_RELPATH)
                val stamp = File(rootfs, ExecFix.STAMP_HOST_RELPATH)
                // 版本戳：旧包装留下的 .so 必须作废重编。只判「文件存在」会让修正永远
                // 不生效——rc.117 的 errno 闸门 bug 就卡在这里（设备上已有旧 shim，
                // 新包装原样复用，日志一行不打）。
                val fresh = so.isFile && stamp.isFile && stamp.readText().trim() == ExecFix.VERSION
                if (fresh) return@runCatching true
                if (so.isFile) so.delete()
                stamp.delete()
                if (!isRegularFileNoFollow(File(rootfs, "usr/bin/gcc"))) {
                    execFixError = "rootfs 里没有 /usr/bin/gcc，无法编译 " + ExecFix.SO_GUEST_PATH
                    return@runCatching false
                }
                val src = File(ws.root, ExecFix.SRC_HOST_RELPATH)
                src.parentFile?.mkdirs()
                val srcGuest = "/workspace/${src.relativeTo(ws.root).invariantSeparatorsPath}"
                fun writeSrc(text: String) {
                    if (!src.isFile || src.length() != text.length.toLong()) src.writeText(text)
                }
                // 第一优先：自包含源码（镜像没有 musl 头文件，干净设备只有它能编）
                writeSrc(ExecFix.SOURCE)
                var out = guestExec(
                    "/usr/bin/gcc",
                    listOf("-shared", "-fPIC", "-O1", "-nostdinc", "-o", ExecFix.SO_GUEST_PATH, srcGuest),
                    timeoutMs = 60_000,
                )
                // 兜底：装过 musl-dev 的设备可能反而要求走标准库头（极少数），再试带 include 的老版
                if (!so.isFile) {
                    writeSrc(ExecFix.SOURCE_INCLUDE)
                    out += guestExec(
                        "/usr/bin/gcc",
                        listOf("-shared", "-fPIC", "-O1", "-o", ExecFix.SO_GUEST_PATH, srcGuest),
                        timeoutMs = 60_000,
                    )
                }
                if (so.isFile) true else {
                    execFixError = "gcc 编译失败：\n" + out.trim().takeLast(400)
                    false
                }
            }.getOrDefault(false).also { ok ->
                if (!ok && execFixError == null) execFixError = "execfix 编译未产出 " + ExecFix.SO_HOST_RELPATH
                if (ok) {
                    // 编译成功才写版本戳：写戳失败也不影响本次使用（下次会重编）
                    runCatching { File(rootfs, ExecFix.STAMP_HOST_RELPATH).writeText(ExecFix.VERSION) }
                    installGuestWrappers(rootfs)
                }
            }
            return if (execFixState == true) ExecFix.SO_GUEST_PATH else null
        }
    }

    /**
     * 给 guest 装 `PATH` 前置的 java 包装（`/usr/local/bin/java` → 真 java + LD_PRELOAD）。
     *
     * 为什么需要：app 自己的 java 入口（[guestExec]/[openGuest]）会带 shim，但**终端
     * 会话是 `/bin/sh`**，用户或智能体在里面敲 `java -version` 不会经过我们的包装，
     * 于是仍然撞 W^X 拒绝 —— 诊断时会误判成「补丁没生效 / seccomp 绕不过」。
     * `/usr/local/bin` 在 [prootHostEnv] 的 PATH 里排在 `/usr/bin` 之前，脚本因此
     * 会自然遮蔽真 java；app 内部用绝对路径 `/usr/bin/java`，不受影响。
     *
     * 只写自己那两行（带 `dsh-execfix` 标记），已是符号链接就先删再写，绝不顺着链接
     * 改到真 java。
     */
    private fun installGuestWrappers(rootfs: File) {
        runCatching {
            val dir = File(rootfs, "usr/local/bin").apply { mkdirs() }
            for (name in listOf("java", "javac")) {
                if (!guestEntryExists(rootfs, "/usr/bin/$name")) continue
                val w = File(dir, name)
                if (w.exists() && w.canonicalFile != w.absoluteFile) w.delete()
                val body = "#!/bin/sh\n# dsh-execfix: W^X execmod shim（rc.117），勿手改\n" +
                    "LD_PRELOAD=${ExecFix.SO_GUEST_PATH}\n" +
                    "export LD_PRELOAD\n" +
                    "exec /usr/bin/$name \"\$@\"\n"
                if (!w.isFile || w.readText() != body) w.writeText(body)
                w.setExecutable(true, false)
            }
        }
    }

    /**
     * java 入口（含 setarch 包装）附加 execfix shim。
     *
     * **注入必须发生在 guest 侧命令行，不能放进宿主环境**（rc.117 首包真机实测）：
     * 宿主环境是给 proot 本体（Android bionic 二进制）用的，LD_PRELOAD 指向
     * rootfs 内路径时宿主 linker 找不到文件，proot 直接起不来。改用
     * `/bin/sh -c 'export LD_PRELOAD=…; exec "$@"'` 包装 —— shim 只进 guest
     * 进程树（与真机手动验证的「guest shell 里设 LD_PRELOAD 再跑 java」完全同构），
     * proot 与宿主进程看不到这个变量。shim 不可用（gcc 缺失/编译失败）时原样返回。
     */
    private fun withExecFix(rootfs: File, entry: String, args: List<String>): Pair<String, List<String>> {
        val isJava = entry == PROOT_ENTRY["java"] || entry == "/usr/bin/setarch"
        if (!isJava) return entry to args
        val so = ensureExecFix(rootfs) ?: return entry to args
        return PROOT_ENTRY.getValue("sh") to (
            listOf("-c", ExecFix.wrapScript(so), "sh", entry) + args
            )
    }

    /** 探针脚本落点与结果缓存（.dsh 不进 glob/grep/list，见 FsTools.SKIP_NAMES） */
    private var execProbeCache: String? = null
    private var execProbeRan = false

    /**
     * 「可执行内存」探针（判别证据，见 [ExecProbe]）—— JVM **确定性**启动失败时才值得跑。
     *
     * 经与 JVM 同一条 proot 管线跑一段 python3 + ctypes 脚本（同一 seccomp /
     * SELinux / LSM 上下文），区分「OEM W^X 只禁翻转」「可执行内存整体禁掉」
     * 「执行内存没问题（另有原因）」三种情况。结果按实例缓存 —— 探针要起一个
     * guest python，别在重试循环里反复跑。python3 缺失 / rootfs 未就绪时静默返回
     * null（探针本身不能成为新的报错源）。
     */
    fun execProbeReport(): String? {
        if (execProbeRan) return execProbeCache
        synchronized(this) {
            if (execProbeRan) return execProbeCache
            execProbeRan = true
            execProbeCache = runCatching {
                val f = File(ws.root, ".dsh/exec-probe.py")
                f.parentFile?.mkdirs()
                if (!f.isFile) f.writeText(ExecProbe.script)
                val rep = ExecProbe.parse(exec("python", f, timeoutMs = 30_000))
                    ?: return@runCatching null
                buildString {
                    append(ExecProbe.verdict(rep))
                    rep.lines.forEach { append("\n  ").append(it) }
                }
            }.getOrNull()
            return execProbeCache
        }
    }

    /**
     * guest 内直跑一个入口（compile/run 用）：entry 是 rootfs 内的绝对路径
     * （或 /workspace/... 下的产物二进制）。与 [exec] 的 Proot 分支同一条命令
     * 构造路径，无第二套实现。
     */
    fun guestExec(
        entry: String,
        args: List<String> = emptyList(),
        timeoutMs: Long = TIMEOUT_MS,
        onStart: ((Process) -> Unit)? = null,
        extraEnv: Map<String, String> = emptyMap(),
    ): String {
        val env = prootEnv ?: throw KernelError(needRuntime("proot"))
        val rootfs = prepareProotRootfs() ?: throw KernelError(needRuntime("proot"))
        guardGuestEntry(rootfs, entry, runtimeNameOf(entry))
        val (effEntry, effArgs) = withJvmAntiPax(rootfs, entry, args)
        if (effEntry != entry) guardGuestEntry(rootfs, effEntry, "setarch")
        val (fixEntry, fixArgs) = withExecFix(rootfs, effEntry, effArgs)
        if (fixEntry != effEntry) guardGuestEntry(rootfs, fixEntry, "sh")
        return spawn(
            prootArgs(Resolution.Proot(env.proot, env.loader, rootfs, fixEntry), fixArgs),
            prootHostEnv().apply { putAll(extraEnv) },
            timeoutMs, onStart,
        )
    }

    /**
     * 起一个**常驻** guest 进程并交回 Process（stdin/stdout 保持连接）。
     *
     * 与 [guestExec] 的区别只有一点：那个跑完就收，这个留活口。用处是那些
     * 「启动一次就能反复干活」的进程 —— 对齐桌面 `packages/subprocess`
     * 的「keeps process lifetime across consumer reloads」与 `packages/terminal`
     * 的「sessions alive across tool calls」：桌面从不 per-call 重启语言服务器，
     * 手机端也不该 per-build 重启编译工具。
     *
     * 调用方负责：写请求、读响应、以及一定要 [killTree] 收尾（含空闲回收），
     * 否则一个 guest JVM 会一直挂在 proot 下吃内存。
     */
    fun openGuest(
        entry: String,
        args: List<String> = emptyList(),
        extraEnv: Map<String, String> = emptyMap(),
        guestCwd: String = "/workspace",
    ): Process {
        val env = prootEnv ?: throw KernelError(needRuntime("proot"))
        val rootfs = prepareProotRootfs() ?: throw KernelError(needRuntime("proot"))
        guardGuestEntry(rootfs, entry, runtimeNameOf(entry))
        val (effEntry, effArgs) = withJvmAntiPax(rootfs, entry, args)
        if (effEntry != entry) guardGuestEntry(rootfs, effEntry, "setarch")
        val (fixEntry, fixArgs) = withExecFix(rootfs, effEntry, effArgs)
        if (fixEntry != effEntry) guardGuestEntry(rootfs, fixEntry, "sh")
        val pb = ProcessBuilder(
            prootArgs(Resolution.Proot(env.proot, env.loader, rootfs, fixEntry), fixArgs, guestCwd),
        ).directory(ws.root).redirectErrorStream(true)
        pb.environment().apply { clear(); putAll(prootHostEnv()); putAll(extraEnv) }
        return pb.start()
    }

    /** guest 入口存在性检查：缺失即 NEED_RUNTIME —— 不要把 proot 的
     *  "…/usr/bin/rustc not found" 原样抛给模型，那既不可读也不可行动。 */    private fun guardGuestEntry(rootfs: File, entry: String, name: String) {
        if (entry.startsWith("/workspace/")) return
        if (!guestEntryExists(rootfs, entry)) throw KernelError(needRuntime(name))
    }

    /**
     * guest 入口是否存在 —— **不能只看 `File.exists()`**。
     *
     * rootfs 里的 `/bin/sh` 是绝对路径符号链接 `-> /bin/busybox`（Alpine / Termux 同款）。
     * 在宿主上 `File(rootfs, "/bin/sh").exists()` 会把这个**绝对**链接按宿主根解析成
     * `/bin/busybox`（Android 上没有），于是返回 false —— `sh` 被误判成「运行环境缺失」。
     *
     * 实测踩过：终端刚切到 workspace 后端就报 `NEED_RUNTIME:sh`，而 rootfs 里 busybox 好端端在。
     * 所以这里补一条：链接目标落在 rootfs 内且存在，也算可用。
     */
    private fun guestEntryExists(rootfs: File, entry: String): Boolean {
        val f = File(rootfs, entry.removePrefix("/"))
        if (f.exists()) return true
        val target = runCatching {
            java.nio.file.Files.readSymbolicLink(f.toPath()).toString()
        }.getOrNull() ?: return false
        return if (target.startsWith("/")) {
            File(rootfs, target).exists()
        } else {
            (f.parentFile ?: return false).let { File(it, target).canonicalFile.exists() }
        }
    }

    /** 入口路径反查运行时名（/usr/bin/java -> java），用于 NEED_RUNTIME 里的名字 */
    private fun runtimeNameOf(entry: String): String =
        PROOT_ENTRY.entries.firstOrNull { it.value == entry }?.key
            ?: entry.removePrefix("/").substringAfterLast("/")

    /**
     * guest 里的 /etc/resolv.conf：rootfs 是从 APK 载荷解出来的，没有系统 init 去生成它，
     * apk/pip/npm/node fetch 一联网就 "could not resolve" / EAI_AGAIN。
     *
     * **统一调用点是 [prepareProotRootfs]** —— 不要只在某个工具分支里调，否则终端、
     * node fetch、pip 全都拿不到 DNS。这里保留 public 是为了让调用方在需要时覆盖 DNS
     * （例如受限网络下换成可达的解析器），不参与日常路径。
     *
     * 写不进去必须留出口：否则现象就是「网络全废但没有任何提示」，与项目里
     * 「runCatching 包住用户可感知动作必须有出口」的纪律相冲突。
     */
    fun ensureGuestResolv(servers: List<String> = DEFAULT_GUEST_DNS) {
        val rootfs = rootfsDest ?: return
        if (!File(rootfs, ".dsh-ready").isFile) return
        writeGuestResolv(rootfs, servers)
    }

    private fun writeGuestResolv(rootfs: File, servers: List<String> = DEFAULT_GUEST_DNS) {
        val f = File(rootfs, "etc/resolv.conf")
        if (f.isFile && f.length() > 0L) return       // 已有配置（用户/工具改过）就不动
        val text = resolvConfText(servers)
        if (text.isEmpty()) return
        runCatching {
            f.parentFile?.mkdirs()
            f.writeText(text)
        }.onFailure {
            android.util.Log.w("DSHRuntime", "guest /etc/resolv.conf 写入失败：${it.message}")
        }
    }


    /** 底座 A 的宿主侧环境（Direct 分支） */
    private fun directEnv(): MutableMap<String, String> = mutableMapOf(
        "HOME" to ws.root.absolutePath,
        "TMPDIR" to ws.root.absolutePath,
        // bin（busybox 链接）在前：脚本里 busybox <applet> 直接可用；
        // lib 链接目录是 DT_NEEDED 精确名的查找路径
        "PATH" to listOfNotNull(bbEnv?.binPath, nativeDir?.absolutePath,
            "/system/bin", "/system/xbin", "/vendor/bin")
            .joinToString(":"),
        "LD_LIBRARY_PATH" to listOfNotNull(bbEnv?.libPath, nativeDir?.absolutePath)
            .joinToString(":"),
        "DSH_WORKSPACE" to ws.root.absolutePath,
    )

    /** proot 命令行（M0 spike 实证的参数集，Proot 分支与 guestExec 共用） */
    private fun prootArgs(
        res: Resolution.Proot,
        guestArgs: List<String>,
        guestCwd: String = "/workspace",
    ): List<String> = listOf(
        res.proot.absolutePath,
        "-r", res.rootfs.absolutePath,
        "-0", // 伪 root：Alpine 生态默认假设
        "-w", guestCwd,
        "-b", "${ws.root.absolutePath}:/workspace",
        "-b", "/dev",
        "-b", "/proc",
        res.entry,
    ) + guestArgs

    /** proot 的宿主侧环境（M0 实证：显式 loader/依赖库/发行版 PATH） */
    private fun prootHostEnv(): MutableMap<String, String> {
        val env = prootEnv ?: throw KernelError(needRuntime("proot"))
        // 再验一次：proot 对 loader 找不到只报一句英文 "the loader was not found or
        // doesn't work"，guest 里 node/python 全挂且没有上下文。这里提前挡住并留日志，
        // 让错误变成可读的 NEED_RUNTIME，而不是让模型对着英文报错猜。
        val loader = env.loader
        if (!loader.isFile || !loader.canRead() || loader.length() == 0L) {
            android.util.Log.w("DSHRuntime", "PROOT_LOADER 指向的文件不可用：${loader.absolutePath}")
            throw KernelError(needRuntime("proot"))
        }
        return mutableMapOf(
            // libdshproot.so 是 Termux 编译版，内置默认 loader 路径写死在
            // /data/data/com.termux/...；必须显式覆盖成**真实 .so 文件**的绝对路径，
            // 不能给 filesDir 里的符号链接（真机实测会失败，见 ensureProotEnv 注释）。
            "PROOT_LOADER" to loader.absolutePath,
            // 二进制 strings 里的名字是 PROOT_LOADER_32（设备端验收脚本写成 PROOT_LOADER32，
            // 那是脚本自己的别名）。rootfs 是 64 位，用不到，但显式给掉以免 32 位 guest
            // 或未来扩 ABI 时又回退到 Termux 硬编码路径。
            "PROOT_LOADER_32" to env.loader32.absolutePath,
            "PROOT_TMP_DIR" to File(File(filesDir, RUNTIME_DIR), "tmp").apply { mkdirs() }.absolutePath,
            "LD_LIBRARY_PATH" to env.dir.absolutePath,
            // proot 不改环境变量，guest 内必须显式给发行版 PATH（M0 实证）
            "PATH" to "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME" to "/root",
            "TMPDIR" to "/tmp",
            "DSH_WORKSPACE" to "/workspace",
        )
    }

    /** 命令执行公共路径（Direct/Proot 共用；边读边等规避管道死锁，与 ShellTool 同源） */
    private fun spawn(
        hostArgs: List<String>,
        env: Map<String, String>,
        timeoutMs: Long,
        onStart: ((Process) -> Unit)?,
    ): String {
        val pb = ProcessBuilder(hostArgs)
            .directory(ws.root)
            .redirectErrorStream(true)
        pb.environment().apply { clear(); putAll(env) }
        val proc = pb.start()
        runCatching { onStart?.invoke(proc) }

        // 边读边等：与 ShellTool.exec 同款死锁规避（先 waitFor 再读管道会在
        // 输出超过管道缓冲时互相阻塞，20s 后误报超时）
        val output = StringBuilder()
        val reader = proc.inputStream.bufferedReader()
        val deadline = System.currentTimeMillis() + timeoutMs
        var timedOut = false
        val buf = CharArray(8192)
        // 与 ShellTool.exec 同款：读到的每一块顺手吐给界面（guest 命令也是长任务大户）
        val live = ToolExecContext.currentOrNone()
        while (true) {
            if (System.currentTimeMillis() > deadline) { timedOut = true; break }
            if (reader.ready()) {
                val n = reader.read(buf)
                if (n <= 0) break
                if (output.length < MAX_OUTPUT) {
                    output.append(buf, 0, n)
                    live.emitOutput(String(buf, 0, n))
                }
            } else if (!proc.isAlive) {
                while (reader.ready()) {
                    val n = reader.read(buf)
                    if (n <= 0) break
                    if (output.length < MAX_OUTPUT) {
                        output.append(buf, 0, n)
                        live.emitOutput(String(buf, 0, n))
                    }
                }
                break
            } else {
                Thread.sleep(25)
            }
        }
        if (timedOut) {
            killer.killTree(proc)
            val partial = output.toString().trim().take(1500)
            throw KernelError(
                "执行超时（${timeoutMs / 1000}s）" +
                    (if (partial.isNotBlank()) "\n超时前已产生的输出：\n$partial" else "") +
                    "\n长任务请用 run_in_background=true 改为后台执行，或调大 timeoutMs（上限 120s）"
            )
        }
        proc.waitFor(2, TimeUnit.SECONDS)
        val code = runCatching { proc.exitValue() }.getOrElse { -1 }
        val text = if (output.length > MAX_OUTPUT) {
            output.substring(0, MAX_OUTPUT) + "\n[输出超过 ${MAX_OUTPUT / 1024}KB，已截断]"
        } else output.toString()
        return "exit=$code\n$text".trimEnd()
    }
}
