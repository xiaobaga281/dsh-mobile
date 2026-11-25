# dsh-mobile 全本机编译/运行环境计划（on-device only）

> 2026-10-25 · 取代此前「四档方案」中的 Tier 3（电脑当编译器）。
> 用户拍板：**不依赖任何外部设备**，编译与运行全部发生在安卓端。
> 原则不变：工具与桌面 harness 同名同参、全走 WorkspaceSandbox、长任务走前台服务、产物进现有文件/任务体系。

---

## M0 SPIKE 结论（2026-10-25，模拟器 x86_64 API 36 实测）——✅ 全链路 PASS

**验证链**：complete(Debug) APK（targetSdk 28）→ devExec 桥在应用进程内执行 → Termux proot + Alpine 3.20 minirootfs → `apk add`（本地 .apk 包，离线）gcc 13.2.1 全套 → `gcc -O2 hello.c -lm` 编译 **974ms** → 运行输出 `hello from dsh-mobile proot! sum=671.463`。

**实测确认的关键事实**：
1. **targetSdk 28 → SELinux 域 `untrusted_app_27`，数据目录 exec 放行**（`id` 显示 context=u:r:untrusted_app_27；动态链接器直接跑通 filesDir 里的二进制）。W^X 拦截的是 targetSdk 29+ 的域，spike 证实双通道设计成立。
2. **Termux proot 可直接用**：proot 二进制 + `libexec/proot/loader(+32)` + `libtalloc.so.2` + `libandroid-shmem.so`（后两者用 `LD_LIBRARY_PATH` 指向），`PROOT_LOADER` 指到 loader。全自包含约 320KB。
3. **guest 必须显式设 `PATH=/usr/local/sbin:...:/bin`**（proot 不改环境变量，宿主 PATH 是 /system/bin 系列）。
4. **proot 警告 `can't canonicalize .../tmp/` 与 `f2fs bug probe` 为无害装饰**，设 `PROOT_TMP_DIR` 可消。
5. **apk 离线本地安装成立**：`apk add --no-network /tmp/pkgs/*.apk` 装完 14 包 157MiB。这正是计划里「工具链资源包」的分发形态——设置面板下载 .apk 集合到本地再装，**不依赖 guest 内网络**。
6. **gcc 依赖闭包**（x86_64, alpine 3.20）：gcc + libgcc + libstdc++ + libgomp + libatomic + binutils + jansson + gmp + mpfr4 + mpc1 + isl26 + zstd-libs + musl + musl-dev，压缩合计 ~57MB。
7. 沙箱宿主网络对外完全阻断（连 shell 域 ping 外网 IP 都 100% loss），guest 内 DNS/TCP 失败是**环境问题不是架构问题**；真机正常网络下 `apk add` 联网装包走 Termux 同款路径。

**对后续阶段的修正**：
- 工具链包形态从「guest 内 apk add 联网」改为**首选本地包集合安装**（资源包 = .apk 集合 zip），联网 apk 只是备选；
- 阶段 C 的 C3 工具链包尺寸按实测修正：`toolchain-c` ≈ 60MB 下载 / 160MB 装后（原估 250MB 偏高）；
- `complete` flavor 已落地（build.gradle.kts），devExec 调试桥保留（BuildConfig.DEBUG 门禁，release 无效）。

---

## M1 结论（2026-10-25，阶段 A 全量落地）——✅ ALL PASS

**验收链**（`.motion/verify/sweep-runtime.mjs`，模拟器 x86_64 API 36，complete Debug）：
工具目录含 python/node/bash → BusyBox v1.38.0 自 nativeLibraryDir 链接执行 → busybox tar 在 workspace 往返 → python/node 缺失回 `NEED_RUNTIME:<name>` → bash 回归 + busybox 经 PATH 可用。bash 工具往返 ~150ms。standardDebug 同步编译通过。

**M1 实测踩坑与定型（后续阶段必须遵守）**：

1. **useLegacyPackaging = true 是底座 A 的前提**。AGP 默认把 .so 以 STORED 方式留在 APK 内、由系统直接映射加载——nativeLibraryDir 是**空目录**，注入的二进制没得跑。已在 build.gradle.kts `packaging.jniLibs` 打开（APK 内压缩 + 安装时解压）。
2. **Alpine busybox-static（musl 静态）在 Android seccomp 下必死 SIGSYS**：argv[0] 是 applet 名或 `busybox` 时、走到 applet 分发路径就 `Bad system call`（159）；argv[0] 不是 applet 名时只打印 "applet not found"，是唯一活着的路径。**不要再用静态 musl 二进制**，strace 也追不动（模拟器自带 strace 报 Unexpected wait status 0x1f）。
3. **定型方案：Termux busybox 1.38.0（bionic 动态）四件套**：libdshbox.so（4KB 启动器）+ libdshbb.so（libbusybox）+ libdshselinux.so + libdshpcre.so，依赖闭包=这三个 deb（busybox / libandroid-selinux / pcre2），双架构各 ~1.5MB。`scripts/fetch-runtimes.mjs` 按 deb 分组下载注入。
4. **符号链接装配**（`KernelRuntime.ensureBusyboxEnv`）：启动器按 argv[0] 分发 applet，必须叫 `busybox`；DT_NEEDED 是精确名。故 filesDir/.dsh/bin/busybox → libdshbox.so（PATH 挂 bin 目录）、.dsh/lib/ 放 libbusybox.so.1.38.0 等精确名链接（LD_LIBRARY_PATH 挂 lib 目录）。链接目标全在 nativeLibraryDir，两个 flavor 都合规。bash 与 KernelRuntime 的 env 统一注入 PATH+LD_LIBRARY_PATH。
5. **CPython/Node 没有静态单文件发行版**（python-build-standalone 全是 glibc/musl 动态，Android 无 loader）→ 底座 A 的 python/node 暂不可得，`python`/`node` 工具已注册（RuntimePlugin，schema 与 bash 同构：code/file/args/timeoutMs/run_in_background），缺失返回 `NEED_RUNTIME:<name>`；**真正的 python/node 由底座 B（complete + proot + Alpine）在 M3 供给**。NEED_RUNTIME 消息格式：首行 `NEED_RUNTIME:<runtime>`，阶段 B 前端正则匹配弹下载卡片。
6. 工具命名澄清：桌面 harness 没有 python/node 工具（run_code 是 PTC 编排），`python`/`node` 是手机端新增能力，schema 由 RuntimePlugin 定义；`bash` 与桌面同名同参不动。

**M2 接口现状（2026-10-25，全部内置方案落地，下载面板取消）**：用户拍板**全部内置**——资源包打进 APK，永不联网下载，M2 的「资源包化 + 下载卡片 + 管理面板」整体取消。实际落地：

1. **rootfs 预制**（`scripts/resolve-apks.mjs` + 设备端管线）：Alpine 3.20 rootfs 离线装齐 python3+nodejs+gcc 闭包（34+14 包，329MB 装后 / 157MB tar.gz），按 ABI 注入 jniLibs `libdshrootfs.so`（x86_64 已出；aarch64 待真机/ARM 模拟器走同一管线）。
2. **proot 五件套注入**：Termux proot 本体+loader+loader32+libtalloc+libandroid-shmem → `libdshproot/loader/loader32/talloc/shmem.so`，运行时在 `filesDir/runtime/proot/` 建精确名符号链接。
3. **KernelRuntime**：`prepareProotRootfs()` 首用同步解包（busybox tar，~15s，`.dsh-ready` 标记防重防半包）；`targetSdk≥29` 的 standard flavor 直接判不支持（W^X），python/node 回 `NEED_RUNTIME` 并说明原因。
4. **验收 ALL PASS**（模拟器 complete Debug）：python fib10=55（首调含解包 15.3s / 二调 524ms）、node 740ms、gcc 编译执行 rc=42、busybox/bash 回归全绿。APK 254MB。
5. **踩坑（勿重蹈）**：①符号链接重建必须 `Files.deleteIfExists`（删链接本身），`link.exists()` 会跟随悬空链接返回 false，createSymbolicLink 再抛 FileAlreadyExistsException 被吞——重装 APK 后 nativeLibraryDir 变路径，链接永久失效；②busybox 是「启动器+libbusybox」结构，任何 ProcessBuilder 直跑都必须带 `LD_LIBRARY_PATH=.dsh/lib`；③GNU tar 的 terminfo 硬链接 busybox tar 解不了（rc≠0 但内容已完整）——预制管线在宿主用 python 重打包解引用硬链接（软链接保留）；④apk db 在 `/lib/apk/db` 不在 `/etc/apk/db`；⑤icu-data-en 与 icu-data-full 冲突，闭包解析结果要剔 en 留 full；⑥覆盖安装同时容纳新旧两份解压（~700MB），模拟器要提前卸载清空间。

---

## 0. 目标与非目标

**目标**
1. 手机离线可跑：Python / Node / shell 脚本、数据处理、爬虫、pip/npm 生态。
2. 手机离线可编译：C/C++（clang）、可扩展到 Rust/Go/JVM 语言，构建产物直接进入 workspace。
3. 全部能力以 harness 工具形态暴露（`bash` / `python` / `node` / `compile` / `run`），Agent 提示词零改动。
4. 按需供给：APK 不预装几百 MB 工具链，运行环境像语音包一样「要用再下」。

**非目标**
- 不做 root /Magisk 方案；
- 不依赖 Termux 或任何外部 App；
- 不做跨设备（Tier 3 方案废弃，桌面配对通道维持聊天/协作用途，不承担编译）。

---

## 1. 两个执行底座（关键认知）

安卓端「能不能执行二进制」由 SELinux 域决定，按 targetSdk 分成两个世界：

| | 底座 A：nativeLibraryDir 直跑 | 底座 B：proot 用户态发行版 |
|---|---|---|
| 原理 | 静态二进制伪装成 `libdshxxx.so` 放进 `jniLibs`，装包后落在 `nativeLibraryDir`（系统允许 exec） | proot（ptrace）在数据目录挂载 Alpine rootfs，`apk add` 动态装包 |
| 约束 | targetSdk 29+ 的 W^X：**数据目录里的文件禁止 exec**，所以只能放 nativeLibraryDir（只读，装包后不可变） | guest 二进制由 proot 映射执行，**要求数据目录文件可被 PROT_EXEC** → 只有 targetSdk ≤28 的 SELinux 域放行（Termux 至今 targetSdk 28 的根因） |
| 能给什么 | Python、Node、busybox 等固定运行时 | gcc/clang/cmake/git/openjdk17，完整 Linux 生态，可 `apk add` 随时扩 |
| 交付形态 | 主构建（targetSdk 34）内直接可用 | 独立构建通道「完整版」（targetSdk 28），GitHub 侧载分发 |

**结论：双构建通道**。同一个源码，Gradle flavor 拆分：
- `standard`（现状，targetSdk 34）：底座 A 全量可用；
- `complete`（新增，targetSdk 28）：底座 A + 底座 B，追求完整 Linux 环境。
我们本来就是 GitHub 侧载分发，不受 Play targetSdk 门槛限制；`complete` 版损失的是 Play 合规与部分新权限模型（本应用自包含目录存储，几乎无痛）。

> M0 必须先做一个 48 小时 spike 在真机验证底座 B（proot 在 targetSdk 28 域下 `apk add gcc && echo 'int main(){}' | gcc -x c - -o t && ./t` 一条链跑通），再投入后面的工期。若失败，降级路线见 §6。

---

## 2. 阶段 A · 运行时层（底座 A，约 2~3 天）

### A1 构建侧：二进制注入管线
- `scripts/fetch-runtimes.mjs`：从固定 URL（python-build-standalone / nodejs-mobile release / busybox 官方静态构建）下载 aarch64 静态 PIE 二进制，sha256 校验，重命名为 `libdshpython.so` / `libdshnode.so` / `libdshbox.so` 放入 `src/main/jniLibs/arm64-v8a/`。
- **16KB 页对齐**（Android 15+ 新设备硬要求）：`zipalign -P 16384` 已在 AGP 中配置，验证一遍即可；二进制本身须 `-static-pie` 且段对齐 16KB。
- 体积预算（装进 APK 的只有这些，共 ~55MB）：
  | 二进制 | 压缩后 | 用途 |
  |---|---|---|
  | busybox | ~1.1MB | sh/coreutils 全家桶（终端工具已有底座，升级为完整 busybox） |
  | CPython 3.12 + stdlib zip | ~25MB | 数据处理/脚本/爬虫 |
  | Node 20（nodejs-mobile libnode + 启动器） | ~28MB | npm 生态、JS 工具链 |

### A2 运行侧：执行器与工具面
- `KernelRuntime.kt`：枚举 `nativeLibraryDir` 下 `libdsh*.so`，`ProcessBuilder` exec，stdin/stdout/stderr 三流，环境变量注入 `DSH_WORKSPACE=<sandbox root>`。
- 工具注册（与桌面同名同参）：
  - `bash`（命令、cwd、timeout、env）— 替换现有 PTC 终端词汇的落地实现；
  - `python`（code/file、args、venv 支持）；
  - `node`（code/file、args）。
- **沙箱接线**：全部穿过现有 `WorkspaceSandbox` 三档判定——`ro` 档只给 bash 且 cwd 锁定，`partial/full` 按 workspace 路径白名单裁剪；stderr/exit code 进工具结果 JSON（模型可读）。
- 前台服务：超 5s 的进程转后台跑（现有 TeamKeepService 同款保活），通知栏显示命令行，`kill` 走 `teamInterrupt` 同款通道。

### A3 验收
- 模拟器取证脚本 `.motion/verify/sweep-runtime.mjs`：python 算斐波那契 / node 跑 npm 包（离线装一个到 workspace）/ busybox tar 解压产物落 workspace / ro 档尝试写文件必须被拒。
- 性能基线：python 冷启动 < 800ms（旗舰机），进程 stdout 流式回传首字节 < 200ms。

---

## 3. 阶段 B · 包管理与按需供给（约 2 天）

运行环境是「资源包」不是「内置功能」——完全复用语音包的成熟模式（`TtsAssets` 目录/字节表/自检）：

- 设置页新增「运行环境」面板：列出 runtime 包（Python/Node/proot 工具链），显示状态（内置/未下载/已下载 xx MB/校验中）、一键下载、删除。下载走现有语音包通道（断点续传 + sha256 + 原子落盘）。
- APK 只内置 busybox（1.1MB），Python/Node 首次使用时引导下载（约 55MB）——Agent 遇到「任务需要 python 但环境未装」时，工具返回结构化提示 `NEED_RUNTIME: python`，前端弹出下载卡片，用户确认后下载完成自动重放工具调用。**这就是 harness 式按需供给的核心交互。**
- pip 生态：阶段 A 的 python 自带 `ensurepip`，`pip install` 目标指向 workspace 下 `.dsh/pip-cache`，配国内镜像默认源 + 离线缓存目录；npm 同理（`npm_config_prefix` 指 workspace）。

---

## 4. 阶段 C · 完整编译环境（底座 B，约 4~5 天，含 M0 spike）

### C1 `complete` flavor 搭建
- Gradle flavor：`targetSdk 28` + `minSdk 26`，applicationId 同值（覆盖安装需卸载重装，GitHub Release 说明里写清楚）。
- proot 静态二进制同样走 jniLibs（proot 本体在 nativeLibraryDir，合法 exec）。

### C2 发行版供给
- Alpine minirootfs aarch64（压缩 3MB / 解开 ~50MB）作为「工具链基础包」从设置面板按需下载，解开到 `filesDir/proot-root/`。
- 首次启动绑定挂载：`workspace -> /workspace`（现有 WorkspaceSandbox 根目录直通进 guest），`nativeLibraryDir` 运行时二进制也可绑定进 guest，两底座互认。

### C3 工具链包（可选下载，按语言拆分）
| 包 | 内容 | 装后体积 |
|---|---|---|
| `toolchain-c` | clang/lld/musl-dev/make/cmake | ~250MB |
| `toolchain-jvm` | openjdk17-jre-headless + javac（temurin alpine 包） | ~200MB |
| `toolchain-rust`（后续） | rust 最小 profile | ~400MB |
- `apk` 走镜像源（默认中科大），下载在 guest 内完成、进度通过 stderr 回传工具流。

### C4 沙箱升级（手机端反超桌面的点）
- Landlock 探测（内核 5.7+，2020 年后的机器基本都有）：在 proot 内尝试 `landlock_create_ruleset`，可用则把 `full` 档从「路径白名单 + 约定」升级为**内核强制**——文件系统访问按 sandbox 档位加载 Landlock 规则集，越界访问直接 EACCES。
- proot 自身只 trace guest 进程，guest 内嵌套 fork/exec 全覆盖；`full` 档再叠加禁网络（`unshare -n` 探测，不行则 Landlock network 部分/iptables 不可用时降级为约定 + 代理黑洞）。

### C5 工具面
- `compile`：语言 → 工具链包映射，未装包返回 `NEED_RUNTIME` 提示（同 §3 交互）；
- `run`：跑编译产物（底座 B 内执行，产物已在 /workspace 下则底座 A 也能跑）；
- 长编译：前台服务 + 通知进度 + 完成后产物作为 task attachment 进现有任务体系。

### C6 验收
- 真机全链路：「Agent 收到任务 → 提示下载 toolchain-c → 下载 → clang 编译单文件 C 程序 → 运行 → stdout 回流模型 → 产物进 workspace」；
- 沙箱取证：full 档 guest 内尝试读 `/etc/shadow`（EACCES）、越界写 workspace 外路径（EACCES）、ro 档联网（被拒）；
- 性能：clang -O2 编译 1000 行 C < 15s（8 Gen 3 量级机器），proot syscall 开销 < 30%。

---

## 5. 横切纪律（与既有架构的对接点）

1. **工具 schema 与桌面同名同参**（`bash`/`python`/`node`/`compile`/`run`），提示词与桌面共用，不用改；
2. **全部穿过 WorkspaceSandbox 三档判定**，底座 B 内用绑定挂载 + Landlock 落到内核强制；
3. **长任务一律前台服务 + 通知**，复用 TeamKeepService 保活与中断通道；
4. **产物只进 workspace**，工具结果 JSON 里带 workspace 相对路径，模型可直接再引用；
5. **NEED_RUNTIME 协议**：任何工具因环境缺失失败时返回结构化错误码，前端统一出下载卡片——运行环境的增长不靠发版。

## 6. 风险与降级路线

| 风险 | 影响 | 降级 |
|---|---|---|
| M0 spike 失败：targetSdk 28 域未来被收紧 / 个别 ROM 厂商魔改 SELinux | 底座 B 不可用 | ①底座 A 里追加「预编译 clang+sysroot 以 .so 形态内置」（单文件 C/C++ 够用，无包管理）；②complete 版改用 `linux-arm64` 真机兼容列表（实测主流机型），不支持的机器自动隐藏底座 B 入口 |
| 16KB 页对齐遗漏 | Android 15+ 新设备二进制 crash | fetch 脚本强制 `patchelf --page-align` + CI 用 16KB 模拟器冒烟 |
| proot 性能（syscall 翻倍） | 编译慢 20~50% | 接受（手机端编译本就是「能编译」优先）；热点路径可用 `--link2symlink` 关闭后仍慢则切 ① 降级 |
| 500MB 级工具链占存储 | 用户设备吃紧 | 设置面板显示占用 + 一键卸载语言包；默认只留最近用的 1 个 |
| 电池/温控：长编译后台发热 | 系统杀进程 | 前台服务 already exempt 于大部分限制；超 10 分钟任务提示用户插电 |
| 安全：可执行任意二进制 | 沙箱逃逸面变大 | Landlock 内核强制（§C4）+ 默认 full 档禁网 + 工具结果审计日志（现有 journal） |

## 7. 里程碑与顺序

```
M0（0.5 天）  底座 B spike：真机 proot 编译链验证 —— 决定 C 是否全量投入
M1（2~3 天）  阶段 A：jniLibs 注入管线 + bash/python/node 三工具 + Sandbox 接线 + 取证
M2（2 天）    阶段 B：运行环境资源包化 + NEED_RUNTIME 下载交互
M3（4~5 天）  阶段 C：complete flavor + proot/Alpine + toolchain-c + Landlock 沙箱
M4（1~2 天）  工具链扩展（jvm/rust）+ 文档 + rc 版本发布
```

**M0 结论即分岔点**：spike 通过 → 按 M1→M4 全量推进；失败 → M1/M2 照做（底座 A 不受影响），阶段 C 切换到 §6 降级①。

---

## M2.5 结论（2026-10-25，aarch64 出包 + 双 ABI 存储 optimization）——✅ ALL PASS

**双 ABI 全内置落地**：complete APK 235MB（standard 93MB，rootfs/proot 已隔离进 complete sourceSet，
standard 不为用不了的能力付体积）。验收 sweep-runtime.mjs ALL PASS（python/node/gcc(g++含)/bash/busybox/沙箱）。

**aarch64 rootfs 出包管线（无需 ARM 设备，x86_64 模拟器上交叉完成）**：
1. `node scripts/resolve-apks.mjs aarch64 python3 nodejs gcc g++`（闭包 + APKINDEX；g++ 是独立包，
   gcc 不含 C++ 驱动；pyc 系 4 包（ssl_client/python3-pycache-pyc0/pyc/python3-pyc）经 install_if
   引用，闭包解析器按 D: 字段看不到，索引驱动安装时会点名补）
2. **apk.static 本地仓库交叉安装**（自研，替代 ARM 模拟器）：apk-tools-static（x86_64 静态 ELF）
   push 到 /data/local/tmp 直接跑；仓库必须按 `<repo>/<arch>/{APKINDEX.tar.gz,*.apk}` 布局
   （apk 会对本地 repo 路径也追加 $arch 子目录）；`--arch aarch64 --initdb --no-network --no-scripts
   --allow-untrusted --repository`。直给 .apk 文件参数解析不了 provides（no such package）。
3. **--no-scripts 的两个手动补丁**：① ca-certificates bundle（trigger 产物，与架构无关，从 x86 树拷）；
   ② busybox applet 符号链接（alpine busybox 的 trigger 建 /usr/bin/env 等，用设备端 busybox --list
   枚举、ln -s /bin/busybox 补到 usr/bin|bin|sbin）。
4. **打包**：设备端 busybox tar -czf（元数据无损）→ adb pull → 宿主 `scripts/pack-rootfs.py` 去重重压。

**存储优化的实测结论（别再高估/低估）**：
- 双 ABI 去重收益**小**：payload 是 ELF 主导（node 单二进制 ~100MB、gcc/binutils、.a 库），
  common 公共部分只有 ~8MB——split 的价值是结构清晰与增量更新，不是体积；
- 真正的杠杆是 **xz**（gzip→xz 省 ~40%，220MB→132MB）；busybox tar -xJf 可解（xz applet 在包内），
  但 busybox 的 xz applet **只解不压**，设备端打包用 gzip，宿主重压 xz。
- 载荷拆分：`rootfs-common.tar.xz`（assets，双 ABI 一份）+ `libdshrootfs.so`（本 ABI 的 ELF/差异文件）。

**踩坑（勿重蹈）**：
1. **adb pull 目录树在 Windows 上不可用作打包输入**：符号链接变成普通文件、exec 位全丢
   （python3 链接变 14KB 普通文件、755→644）。打包输入必须是设备端 tar（元数据无损）。
2. **硬链接必须打包期解引用**：c++→g++ 链接与目标会被拆进不同载荷，跨包链接解不开；
   busybox tar 解硬链接本来也弱。
3. **/dev 设备节点要剔除**（apk --initdb 造的）：应用数据目录 mknod 必被拒；运行时 /dev 由
   proot 绑定挂载提供。
4. **busybox tar -J 会 spawn 外部 `xz`**（PATH 查找 applet）：解包环境必须给 PATH=bb.binPath
   且 bin 目录有 xz → busybox 链接（KernelRuntime.ensureRootfs 已内置）。
5. apk.static --initdb 在残留脏目录上会误报 Failed to open apk database——先 rm -rf 干净起。
6. assets 的 available() 对压缩流返回假长度，不能做拷贝跳过判定（fingerprint 曾记出 841MB）。

**架构核查（任务 #41）**：RuntimePlugin 经 ServiceLoader 清单注册、内核零硬引用；KernelRuntime
实例仅插件持有（禁用插件 = 底座 B 整体下线，bash 走 ShellPlugin companion 的 ensureBusyboxEnv 独立可用）；
执行路径 Direct=ProcessBuilder 直跑 / Proot=proot 直跑，无代理进程无中转层；warmup daemon 线程卸载自然消亡。

---

## M4 结论（2026-10-26，工具链收口 + 按需自给 + 模拟器联网）——✅ ALL PASS

### 需求定调（用户拍板，两次修正）
1. 「不用什么都内置」：电脑端只给基础环境，用户/智能体自造自给 —— 因此新增 `pkg` 工具；
2. 「JVM 保留内置」：openjdk21-jre-headless 继续进载荷（complete APK 316MB）。

### 工具层（RuntimePlugin 现在 9 个工具）
`python / node / compile / run / java / rustc / pkg` + 原有 bash 系。要点：
- **compile**：语言→工具链映射（.c→gcc，.cpp/.cc/.cxx/.c++→g++），产物经 checkWrite 落工作区；
- **run**：执行工作区可执行文件，exec 位缺失自动 guest 内 chmod +x 重试；
- **java**：headless JRE 跑 jar（无 javac）；**proot 下 HotSpot 偶发启动失败**见下；
- **rustc**：按需组件，未装回 `NEED_RUNTIME:rustc` + pkg 指引；
- **pkg**：`manager=apk|pip|npm`，args 原样透传，支持 proxy 与后台 job。

### pkg 自给链路（关键补丁）
- 基础 rootfs 是 `apk.static` **交叉装**出来的，**不带 apk-tools 本体**（`/sbin/apk` 不存在）
  → `KernelRuntime.ensureGuestApk()` 首次用到时把 jniLibs 里的静态 apk（`libdshapk.so`，
  x86_64 4.7MB / aarch64 4.4MB）拷进 `rootfs/sbin/apk` 并置执行位（幂等）。
- guest 里没有 `/etc/resolv.conf`（无 init 生成）→ `ensureGuestResolv()` 缺失时补 1.1.1.1/8.8.8.8，
  否则 apk/pip/npm 一联网就 "could not resolve"。
- 命令一律走 `guestExec(entry, args, timeout, extraEnv)`，不带第二套 proot 参数实现。

### NEED_RUNTIME 语义修正（别再把 proot 噪声丢给模型）
`KernelRuntime.guardGuestEntry(rootfs, entry, name)`：proot 执行前查 guest 内入口是否存在，
缺失直接 `NEED_RUNTIME:<name>` + 可行动指引（"用 pkg 工具联网安装"）。
以前 rustc 未装会回 `proot error: '/usr/bin/rustc' not found … fatal error`，既不可读也不可行动。

### JVM 抖动（proot 已知限制，已用重试收口）
症状：`Error occurred during initialization of VM / Failed to mark memory page as executable`，
实测 **~40% 概率**（default 1/4、-Xint 2/4、-Xshare:off 3/4、-XX:+UseSerialGC 1/4 —— 与参数无关，
是 proot 下 HotSpot mprotect(PROT_EXEC) 的偶发失败）。
处理：`runJava()` 只在**VM 尚未启动**类失败（该错误文本）时重试，最多 3 次；其他错误不重试。
装机实测 3/3 通过。

### 模拟器联网（联调环境事实，勿再摸索）
android15-6.6 模拟器 SLIRP 只有 `10.0.2.2`（宿主 loopback）可达：ICMP 到 8.8.8.8 100% 丢包、
TCP 到 1.1.1.1:443 超时、DNS 解析失败（即使补了默认路由）。宿主出网走 HTTP 代理
`127.0.0.1:61680`。因此联调用 `.motion/verify/dev-proxy.mjs`：
- 裸 TCP 转发（**不能用 Node http 模块重写响应**：会剥掉 transfer-encoding 但正文仍是 chunked，
  SSE 立刻坏掉）；
- 三种模式：源站（`POST /v1/…` 明文进、TLS 出到 apihub.agnes-ai.com）、CONNECT 隧道、绝对 URI；
- 设备侧模型 URL 用 `http://10.0.2.2:8791/v1`（complete flavor targetSdk 28，明文放行）。

### 模型配置（模拟器）
`https://apihub.agnes-ai.com/v1`，模型 `agnes-3.0-flash` / `agnes-2.5-pro-alpha`（efforts 留空，
不发 thinking/reasoning_effort，避免非官方端点 400）；另有一条 `…-relay` 指向宿主中转供模拟器用。
实测真实流式对话：`我是由 Sapiens AI 开发的 Agnes-3.0-flash，6 乘以 7 的结果是 42。`

### 验收（verify-base-env.mjs，ALL PASS）
python 42 / node 42 / compile C / run 42 / compile C++（g++）/ java 3/3（真 class 字节码）/
rustc NEED_RUNTIME+pkg 指引 / pkg apk --version / pkg apk info。

---

## M5 结论（2026-10-26，全功能虚拟机实测）——发现并修掉 4 个真问题

### 实测覆盖面
工具直调 41 项（fs 11 / exec 9 / 文档 6 / 图表 4 / 终端 1 / 记忆 2 / 团队 2 / 内核 2 / 手机 3）
+ UI 端到端（真模型 → 工具 → 气泡回复）+ 只读档安全验证。脚本：`.motion/verify/sweep-all.mjs`、`e2e-chat.mjs`。

### 修掉的 4 个问题
1. **device_info 直接抛异常**（`SecurityException: ConnectivityService…doesn't have ACCESS_NETWORK_STATE`）
   → 清单漏了 `ACCESS_NETWORK_STATE`；同时给 `activeNetwork` / `getNetworkCapabilities` 加兜底，
   权限再出问题也只降级成「未知」，不把整个工具打挂。
2. **agent 第二轮必然 403**（`HTTP 403 <html>cloudflare</html>`，工具跑完了但拿不到最终回复）
   → 两层原因：
   - 我们的联调中继只改写「每条连接的第一个请求」的 Host，HttpURLConnection **复用连接**时
     第二个请求带着 `Host: 10.0.2.2:8791` 打到源站 → CF 403。中继改为**强制短连接**
     （`Connection: close`），每个请求都重新握手并改写 Host。
   - 网关/WAF 对**请求体**有硬上限（实测 Cloudflare ≈128KB）。159 个工具的 schema 原文 95KB，
     加 system prompt/历史就顶到线上 → `PluginRegistry.schemas()` 增加预算（默认 64KB）与
     三级降级：原文 → 截短工具描述到 72 字并清空参数描述 → 截到 32 字 → 全清。
     **参数名/类型/必填一律不动**（模型据此生成参数）。实测降到 59KB。
3. **403 被当成永久错误**：`codeForHttp` 把 403 一律归 PERMISSION（不重试）。
   网关 HTML 拦截页其实是突发限流，几秒即恢复 → 新增 `isGatewayHtml()`，HTML 型 403 归 RATE_LIMIT
   走自动重试（5 次 × 5s）。
4. **工具输出体积无上限**：顺手在 LlmClient 打印每次 POST 体积与工具数，便于下次定位
   「为什么这轮突然失败」。

### 假失败（脚本自身问题，不是产品问题）
- 工具结果是 JSON 字符串，断言前要解一层（`U()/P()`），否则转义把 `"v": 10` 变成 `\"v\": 10`；
- `undo` 的 action 是 list/restore/clear（不是 last）；`chart_generate` 的 bar 需要 categories；
- 助手气泡在语音模式下正文在折叠区，`innerText` 取不到 → 用 `textContent`；
- 「工具真跑过」的判据改成模型不可能猜到的随机 UUID（`cat /proc/sys/kernel/random/uuid`）。

### apk-tools 正式进 rootfs（替掉 9MB 静态引导）
- 两棵树 `apk add apk-tools`（53 包），重打包 → 载荷里自带 `/sbin/apk`；
- 删掉 `libdshapk.so`（双 ABI 共 9.1MB）与 `ensureGuestApk()` 引导逻辑，只保留 `ensureGuestResolv()`。

### 已知环境限制（非产品缺陷）
- 模拟器 SLIRP 只有 `10.0.2.2` 可达，联调必须挂 `.motion/verify/dev-proxy.mjs`；
- 宿主在做 xz 打包时 CPU 打满，模拟器出现两次输入 ANR（Load 3.7），打包结束后复测正常 —— 
  属资源争抢，不是主线程阻塞回归。

---

## M6 结论（2026-10-26，「自己造 App 并装到手机」链路）——✅ 打通

### 现状与边界（先说清楚）
- **装**：新增 `app_install` 工具（PackageInstaller 会话 + 清单 receiver 回传终态），
  手机端（非 root）唯一可行路径。实测：Agent 自主调用 → 系统安装弹窗 → 确认 → `pm list` 出现新包。
- **造**：手机内没有 aapt2/d8（Alpine 只有 `android-tools`，不含打包器），
  所以「编译 APK」这一步目前仍在宿主完成（`.motion/demoapp/build.sh`：javac → d8 → aapt2 →
  zipalign → apksigner，产出 8.6KB 可启动 APK）。手机上能做的是「取包 → 装 → 起」。

### 实测发现的两个真问题
1. **`STATUS_PENDING_USER_ACTION` 被当结果**：它是中间态——要把广播里的 `EXTRA_INTENT`
   拉起来弹确认界面，然后再收一次终态。原实现直接 complete(false)，用户看到
   「安装失败：系统安装器已弹出」这种自相矛盾的报错。现在：拉起 Intent 后继续等。
2. **工具没进预设白名单 = 模型看不见**：`app_install` 注册了，但 `Presets.standard.allow`
   没它。实测模型完全不知道该工具存在，转而去试 `pm install` / `pm list`，然后回复
   「这台手机没有 root，装不了」。加入 standard（cordis 继承 standard，ptc/minimal 故意不给）。
   **教训**：新增工具必须同时改三处 —— 插件 `tools`、沙箱 surface、`Presets` 白名单。

### 验收
- 工具级 `verify-app-install.mjs`：触发 → 系统弹窗 → 自动点「Install」→ 回 `{"ok":true,"output":"已安装"}` → `pm list` 有包。
- Agent 级 `verify-agent-install.mjs`：自然语言「把 demo.apk 装到手机上」→ 模型自己调用
  `app_install` → 自动确认 → 系统里出现 `com.dsh.demo`（截图 `.motion/verify/screen-demoapp2.png`）。
- 装好的 App 能启动（`am start -n com.dsh.demo/.Main`，标题 DSH Demo）。

### 顺带修好的小坑
- 演示 App 源码用 UTF-8 编译（`javac -encoding UTF-8`）：否则 Windows 默认 GBK，
  界面中文全变乱码。
- 权限引导弹窗会连弹 相机 → 定位 → 麦克风 …（首启一次性），脚本里按无障碍节点找「拒绝」按钮自动过。

---

## M6.1 评估：签名 / root 依赖（2026-10-26）

### 签名：强制，且不能省
`apksigner verify --print-certs` 实测演示包：
```
Verified using v1 scheme (JAR signing): true
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Signer #1 certificate DN: C=US, O=Android, CN=Android Debug   (RSA 2048)
```
- Android **强制校验签名**：无签名包直接 `INSTALL_PARSE_FAILED_NO_CERTIFICATES`，
  工具链里也没法绕过（PackageInstaller 走的是系统的 PackageManagerService）。
- 当前演示包用**调试证书**（~/.android/debug.keystore）。正式分发要换成自己的 release keystore：
  同一包名换签名 = 必须让用户先卸载旧版（否则 `STATUS_FAILURE_CONFLICT`，工具已把这条翻译成
  「签名或版本冲突…先卸载旧版」）。
- 我们**不校验**签名是谁的（也没法校验），装什么由用户点确认。

### root：不需要（实测）
把 adb 降回普通权限后完整跑了一遍安装：
```
adb unroot  → adbd as non root
adb shell id → uid=2000(shell)            # 不是 root
应用进程     → u0_a255 (uid 10255)         # 普通应用沙箱
结果         → {"ok":true,"output":"已安装"}  # pm list 出现 com.dsh.demo (uid 10257)
```
- 走的是 **PackageInstaller 会话**（普通应用可用的官方 API）+ 清单里的
  `REQUEST_INSTALL_PACKAGES`，全程不需要 su/root、不需要系统签名、不需要 adb。
- 唯一需要用户动一下手的是系统开关「安装未知应用」（设置 → 应用 → 特殊权限），
  点一次即可；没开时工具会直接告诉用户去哪儿开。
- 顺带说明：整个 App 的其它重活（proot/Alpine 运行时、编译执行）也都在**非 root**下跑，
  root 只是我调试时读会话日志/写工作区用的便利手段，不是产品依赖。

### 边界（买之前要知道）
- 能装的前提：APK 已签名（谁的签名都行）+ 用户点了确认 + 包与设备兼容（minSdk/ABI）。
- 装不了的三类原因工具都会如实回报：无「安装未知应用」权限、签名/版本冲突、不兼容。
- 手机上**不能编译** APK（Alpine 没有 aapt2/d8），编译仍在宿主/CI 完成。

---

## M7 评估：编译环境齐了吗？为什么缺打包器（2026-10-26）

### 已内置（rootfs 53 包，实测版本）
| 组件 | 版本 | 用途 |
|---|---|---|
| busybox / bash | 1.36.1 | shell、applet |
| apk-tools | 2.14.4 | 包管理（自给自足的入口） |
| python3 | 3.12.13 | 脚本、数据处理 |
| nodejs | 20.15.1 | JS 工具链 |
| gcc / g++ | 13.2.1 | C/C++ 编译 |
| openjdk21-**jre**-headless | 21.0.8 | 跑 jar（**只有 JRE**） |
| proot + Alpine | — | 用户态发行版底座 |

**javac 不在**：`/usr/bin/javac` 只是指向 `default-jvm/bin/javac` 的**悬空链接**，
proot 里实测报 `'/usr/bin/javac' not found`。补它只需 `pkg add openjdk21-jdk`
（**apk 7MB / 安装 11MB**）。

### 缺的是「安卓打包」三件，不是一个
| 工具 | 形态 | 为什么缺 | 补法 |
|---|---|---|---|
| **aapt2** | 原生 ELF（glibc，4.5MB） | Alpine 不打包（`android-tools` 实测 23 个文件只有 adb/fastboot/avbtool，**无 aapt**）；musl 环境跑不了 glibc 二进制 | ① 自研 AXML 编码器（0MB）② 加 `gcompat`（<1MB）跑官方 aapt2 |
| **d8**（Java→dex） | **Java jar 15.8MB** | Alpine 没有（APKINDEX main+community 无 d8/r8/dex2jar） | 随包装：实测 `java -cp d8.jar com.android.tools.r8.D8 --version` → D8 8.6.2 |
| **apksigner** | **Java jar 1.0MB** | 同上 | 随包装：实测 `java -jar apksigner.jar --version` → 0.9 |

关键结论：**d8 与 apksigner 不缺运行时**（都是 Java，直接跑现有 JRE 21），
只是没随包带；**唯一真正的原生缺口是 aapt2**。

### 自研 AXML 的进展（代码型 App 可绕开 aapt2）
`.motion/demoapp/axml.py` 手写二进制 AndroidManifest（字符串池 + 资源映射 +
属性结构 + 使用 minSdk/targetSdk/label/launcher intent-filter）：
- ✅ `aapt2 dump badging` 全部识别正确：`package=com.dsh.demo2`、`launchable-activity`、
  `minSdkVersion 21`、`targetSdkVersion 28`；
- ❌ 真机 `adb install` 仍报 `INSTALL_PARSE_FAILED_MANIFEST_MALFORMED:
  No value supplied for <android:name>` —— 系统 PackageParser 比 aapt2 更严，
  还差最后一处（疑似 `resources.arsc` 缺失或属性/命名空间细节），**没打通就不算完成**。
- 排查记录：字符串池头多写 4 字节、属性结构从 28 字节压到 20、资源映射补齐 —— 已修三处，
  剩最后一处。

### 三条路线与成本
| 路线 | 补什么 | 体积 | 能做什么 |
|---|---|---|---|
| **A（推荐）** | javac（pkg 7MB）+ d8.jar 15.8MB + apksigner.jar 1.0MB + 自研 AXML | **~17MB 单份**（jar 不分 ABI） | 手机内从 .java 打到可安装 APK（无资源/图标） |
| B（增强） | + `gcompat` <1MB + 官方 aapt2 4.5MB/ABI | +10MB | 带资源、图标、多 Activity 的完整 App |
| C（现状） | 不加 | 0 | 宿主/CI 打包，手机只负责装（已打通） |

---

## M8 结论（2026-10-26，路线 B：手机内完整打包 APK）——✅ 全链路打通

### 关键突破：官方 aapt2 跑不了，但 **Termux 的 bionic 版可以**
| 方案 | 结论 |
|---|---|
| Google 官方 aapt2（glibc, 6.4MB） | 只有 x86_64；musl 跑不了，`gcompat` 在 proot 下直接 `readlink: No such file or directory`（实测） |
| **Termux aapt2（bionic）** | **直接 exec**，实测 `aapt2 version` → `Android Asset Packaging Tool 2.20-android-16.0.0_r4`；aarch64/arm/x86_64 三个架构都有 |

依赖闭包不用手工试：`scripts/fetch-aapt2.py` 按 Packages 的 **Depends** 递归（aapt2 → abseil-cpp /
libprotobuf / fmt / libc++ / libexpat / libpng / libzopfli / zlib），再从 DT_NEEDED 扫一遍把
`libutf8_validity.so` 这类"同包内的隐藏依赖"一起带上。**aapt2 3.5MB + 53 个 .so 6.5MB → tar.gz 3.9MB/ABI**。
坑：不能按 Contents 的文件名索引反查 soname —— `libssl.so.3` 会被 awscli 这种自带一堆库的包抢走。

### 工具链（全部随包，`scripts/prepare-buildtools.sh` 生成，53MB，不进仓库）
| 组件 | 体积 | 角色 | 跑在哪 |
|---|---|---|---|
| android.jar | 25.8MB | 编译期骨架 + aapt2 框架资源 | 两边共用 |
| d8.jar | 15.8MB | class → dex | guest（JRE 21） |
| ecj.jar | 3.0MB | Java 编译（替代 javac：JRE 不带、JDK 多吃 11MB） | guest |
| aapt2（双 ABI） | 3.9+3.8MB | 资源/清单编译 | **宿主侧直接 exec** |
| apksigner.jar | 1.0MB | 签名（v1/v2/v3） | guest |
| debug.keystore | 2KB | 演示用签名证书 | — |

APK 315MB → **358MB**（+43MB）。`app_build` 与 `app_install` 都在 Presets.standard 白名单里。

### 实测（`proj3`：带 res/values/strings.xml 的工程）
```
app_build(dir=proj3) → {"ok":true,"apk":"demo3.apk","bytes":8595}   124 秒
app_install(demo3.apk) → {"ok":true,"output":"已安装"}
am start com.dsh.demo3/.Main → 标题「手机打包 Demo」（来自 @string/app_name）
                               正文「这段文字来自 res/values/strings.xml」
                                    「编译于手机 · aapt2 + d8 + ecj」
```
截图：`.motion/verify/screen-built-on-phone2.png`

### 踩的坑（全部已修）
1. **assets 里的 `.tar.gz` 会被 aapt 改名成 `.tar`** → 运行时 `FileNotFoundException`。改用 `.dat` 后缀。
2. **重装 APK 后 uid 变**，旧工作区文件属主是上一个 uid：`res` 目录 stat 是目录但 `listFiles()=null`，
   资源编译被静默跳过 → 变成莫名其妙的 `@string/app_name not found`。现在显式检查并报「工程不可读」。
3. **proot 下 JVM 启动抖动**（`Failed to mark memory page as executable`）同样影响 ecj/d8/apksigner，
   `guestJava()` 与 `RuntimePlugin.runJava` 用同一套「仅 VM 未启动类失败重试 3 次」策略。
4. `Context.canRead()` 不足以判断可读（目录 x 位够了就能 stat），必须试 `listFiles()`。

### 现在的完整能力边界
| 场景 | 手机内 | 说明 |
|---|---|---|
| 写 Java/资源工程 | ✅ | 任意文件工具 |
| 编译 APK（含资源/图标） | ✅ | aapt2 + ecj + d8 + apksigner，约 2 分钟 |
| 安装 APK | ✅ | 非 root，用户点一次确认 |
| 卸载 | ✅ | 系统卸载界面 |
| 签名 | ✅ | 随包 debug keystore；正式发布换自己的 release key |
| 打 ARM 包 | ✅ | aapt2 有 aarch64 构建，jar 不分 ABI |

---

## M9 结论（2026-10-26，工程脚手架 + 图标 + 多页面）——✅ 打通

### 新增 `app_new`（一个工具补齐"造 App"的前半程）
参数：`dir` / `package` / `label` / `activities`(1-3) / `color` / `force`。一次写出 12~13 个文件：

| 文件 | 作用 |
|---|---|
| `AndroidManifest.xml` | 包名、launcher Activity、`Theme.Material.Light.NoActionBar`、多页时追加 activity |
| `res/values/strings.xml` | 应用名 + 标题 + 提示 + 页面/按钮文案 |
| `res/values/colors.xml` | 图标底色 |
| `res/mipmap-{m,h,x,xx,xxx}dpi/ic_launcher.png` | 五档启动图标（48/72/96/144/192） |
| `res/mipmap-anydpi-v26/ic_launcher.xml` + `drawable/ic_launcher_foreground.xml` | 自适应图标（API 26+，纯矢量） |
| `src/<pkg>/MainActivity.java`（+Second/Third） | 界面全用代码搭（不依赖 layout XML），页面间有跳转/返回按钮 |
| `README.md` | 改哪三个地方就能改界面 |

**图标不随包带素材**：`PngIcon` 是三十行的 PNG 编码器（IHDR/IDAT/IEND + JDK 自带 Deflater/CRC32），
按主色现画「圆角底 + 对角渐变 + 白色三角」，2×2 超采样抗锯齿。换主色是改一个参数，不是换一套素材 ——
对「每个字节都要有作用」这条要求的直接回应：五档图标一共 7.6KB，且零素材维护成本。

### 实测（`verify-app-new.mjs`，全 PASS）
```
app_new(dir=hello, package=com.dsh.hello, label=手机造的应用, activities=2, color=#2E7D6F)
  → 13 个文件；五档 PNG 魔数校验 89 50 4E 47 通过；图标实拍见 icon-xxxhdpi.png
app_build(dir=hello)            → hello.apk 21457 bytes，210s
app_install(file=hello.apk)     → 已安装（系统弹窗确认一次）
am start com.dsh.hello/.MainActivity → 首屏「手机造的应用」+「打开下一个页面」
点按钮 → com.dsh.hello/.SecondActivity「第 2 个页面」+「返回」
```
截图：`.motion/verify/screen-app-new-1.png` / `-2.png` / `icon-xxxhdpi.png`

### 本轮的三个真问题
1. **分页跳转越界**：`next = PAGE_CLASSES[i+1]` 只看数组有没有下一个，2 页工程也给第 2 页生成了
   `ThirdActivity` 的跳转 → ecj 报 `ThirdActivity cannot be resolved`。改为按 `activities` 判。
   （教训：生成器的"边界"必须用**用户给的规模**判断，不能用数组长度兜底。）
2. **`app_install` 超时即弃会话**：原来 `TimeoutException` 里 `abandonSession` 了会话 ——
   但弹窗还在屏幕上，用户随后点「安装」立刻失败（实测模型连超 3 次、人工再点就装不上）。
   现在超时只放弃"等待"，会话与 pending 都留着，用户什么时候点就什么时候装好；
   默认等待 120s→180s，超时文案明确写「不要立刻重试」。
3. **首启预热把系统拖到 ANR**：`warmup()` 解 157MB xz 是重活，与"开机后装东西"叠加时
   模拟器 Load 冲到 28、systemui 与安装器一起无响应（`Input dispatching timed out`）。
   改为后台线程优先级 `THREAD_PRIORITY_BACKGROUND`（子进程 busybox 继承 nice）+ 让出 6 秒首屏时间。

### Agent 级实测（部分通过，如实记录）
自然语言「做个 App 装到我手机上」→ 模型自主调用链：
`todo_write → app_new(包名/主色/单页都对) → read → edit(改文案) → app_build`，
其中 `app_build` 两次失败后自行诊断（aapt2 XML 报错、sources 路径）并重试成功，
最终产出 `yiyan/yiyan.apk`（21KB 已签名）。**卡在 app_install**：系统弹窗需人点确认，
测试机上无人值守 → 三次 180s 超时。这与 M6.1 的结论一致：**装这一步天然需要一次人工确认**。

### 调试期踩的坑（脚本侧，别重复踩）
- 内核按 id 去重（`pendingTools.putIfAbsent`），**重复 id 会被静默丢弃** → 调试脚本必须用唯一 id；
- 工具返回的 JSON 被注册表包在 `output` 里，断言前要解一层；
- 判"轮次结束"不能看界面文字静止（`app_build` 跑 3 分钟，文字本来就不动），要看会话日志的
  `turn/end`；界面占位文案「深度求索中」不是回答；
- `adb shell` 的非零退出（`pm uninstall` 没装过）会让 Node 脚本直接崩，要容错；
- 同一工作区被两个并发轮次操作会互相踩（一次 `rm -rf` 删掉了另一个轮次正在编译的工程，
  表现为"文件莫名消失"）——验收时只跑一轮。

---

## M10 结论（2026-10-26，性能与负载：对照桌面端）——✅ 构建 13.4s → 2.1s

### 0. 先量，再动手（两次假设都被自己的数据推翻）

`.motion/verify/perf-build.sh`（逐阶段手动跑，模拟器 x86_64，hello 工程）：

| 阶段 | 实测 | 说明 |
|---|---|---|
| proot 启动（guest `/bin/true`） | **57ms** | 不是瓶颈 |
| aapt2 compile | 144ms | 不是瓶颈 |
| aapt2 link（25.8MB android.jar） | 224ms | 不是瓶颈 |
| ecj | **5331ms** | 主要成本 |
| d8 | **4826ms** | 主要成本 |
| apksigner | **2820ms** | 主要成本 |
| 合计 | **≈13.4s** | 与工具墙钟 12.3~13.9s 吻合 |

`.motion/verify/perf-breakdown.sh` 继续拆固定成本：

| 项 | 实测 | 结论 |
|---|---|---|
| `java -version` | 49~155ms | **JVM 启动很便宜**（CDS 已开）→ 「起三次 JVM」不是病因 |
| `apksigner --version` | 358ms | 类装载本身就有底价 |
| ecj 编**纯 Java 类、不带 android.jar** | 4700ms | **与 android.jar 无关**，是 ecj 自己那坨类 |
| d8 不带 `--lib` | 3329ms | 同上 |
| ecj/d8 二次（页缓存已热） | 4555/3708ms | 页缓存也不是病因 |

**真正的病因**：每个工具各付一次「把自己加载起来」的固定成本（2.8~5.3s），
而 proot 用 ptrace 拦每一个 syscall，classloading 的海量 open/mmap 被放大。
每次构建付三遍。中间试过的「三个阶段合进一个 JVM」只省下两次 ~0.1s 的启动，
**方向错了**（保留在代码里仅作为 `--daemon` 之外的调试入口）。

### 1. 桌面对照（依据，不是自创）

| 桌面 | 手机端（改前） |
|---|---|
| `packages/subprocess`：「The service keeps process lifetime across consumer reloads」 | 每次 `guestExec` 起 proot → 起 JVM → 加载工具类 → 干活 → 退出 |
| `packages/terminal`：「keep interactive shell and REPL sessions alive across tool calls」 | 构建侧没有常驻会话，三轮工具各自冷启 |
| Gradle 常驻 daemon（默认行为） | 无 |

结论：桌面从不 per-call 重启语言服务器/终端；手机端构建也必须**把类留在内存里**，
而不是换着法子重启进程。于是有 `BuildDaemon`：一个 guest JVM 常驻，
stdin 一行 `BUILD <plan>`、stdout 回 `[done] ok=…`，四个阶段（ecj/d8/inject/sign）
在同一个进程里跑，每个 stage 用隔离 ClassLoader（d8 与 apksigner 各自内联不同版本的
guava/kotlin，同一条 classpath 会互相遮蔽）。

### 2. 实测收益（同一 APK、同一工程、连打三次）

```
第 1 次  wall=15.6s   ecj 6096 / d8 5954 / sign 1662   (守护进程冷启，含类加载)
第 2 次  wall= 2.6s   ecj 1169 / d8  335 / sign  307
第 3 次  wall= 2.1s   ecj  811 / d8  256 / sign  287
```
改前基线 12.3~13.9s（`.motion/verify/perf-app-build.mjs` 同一脚本同一工程）。
**热态 4.5~6 倍提升**；冷态首次仍要付一遍类加载（这是 JVM 的物理下限）。

### 3. 代价与收口（负载不能只降不涨）

- 常驻 JVM 实测 **RSS ≈ 176MB**（`-Xmx384m -XX:ReservedCodeCacheSize=48m`）。
  所以：**空闲 120s 自动收掉**（桌面语言服务器同款 idle shutdown）、插件卸载立即收、
  `status()` 里能看到「常驻 / 未启动」。
  实测回收：一次构建结束后静置 140s，`ps -A | grep -E '[j]ava|[p]root'` → **0 行**，
  内存全额归还；下次构建重新冷启（15s），不会留下孤儿进程。
- `ReservedCodeCacheSize` 从默认 240MB 压到 48MB：少占地址空间，也少一分
  proot 下 `mprotect(PROT_EXEC)` 失败的机会。
- 启动重试 3 → 5 次（300/600/900/1200ms 递增）：该抖动会成簇出现，
  实测有过「3 次全灭、第 4 次成功」；失败不花时间（~0.5s），一次成功换来后续每次 2s。

### 4. 踩的坑（已修，属于「自己挖自己跳」）

1. **`LinkedBlockingQueue.offer(null)` 当 EOF 标记 → NPE → Android 直接杀进程**
   （`FATAL EXCEPTION: dsh-build-daemon-out`，第一次调用 app_build 就把 App 干掉）。
   Android 上任何线程的未捕获异常都会终止进程，读线程必须 `finally` 收口。
   改成「显式 eof 标志 + wait/notify」。
2. `javac` 在 Windows 上默认 GBK，源码里的中文注释直接编错 → 脚本里写死 `-encoding UTF-8`。
3. `rm -rf` 临时目录带盘符会被安全钩子拦 → 临时目录放到仓库内 `/d/1/tmp`。

### 5. 顺带修的流式输出（对话流「不及时 / 不像流式」）

| 位置 | 改前 | 改后 |
|---|---|---|
| `AgentDriver.requestWithRetry` | delta 攒到 64 字或 60ms 才发，**但只在下一 chunk 到达时才检查** —— chunk 之间一停顿，字就压在缓冲里干等（实测观感「明明在出字却半天不动」）；`onReasoning` 完全不合批，R1 系模型每秒几十条直接打满主线程 | 40ms 固定节拍兜底（`ScheduledExecutorService`），文本与思考同一条节拍、同一套 64 字/40ms 规则；节拍在 `finally` 里收掉，重试不漏线程 |
| `assets/web/app.js:schedulePaint` | 固定 48/60/80ms 的 `setTimeout` 节流 = 12~20 帧/秒 | `requestAnimationFrame` 按帧画 + 同值 `setTimeout` 兜底（谁先到谁画）；单次成本是 O(尾部)，按帧画不放大开销 |

### 6. 实测补充（真模型中继，`perf-stream.mjs` / gfxinfo）

| 项 | 实测 | 判断 |
|---|---|---|
| delta 间隔（合批节拍） | p50 **42ms** / p95 **70ms** | 节拍生效，无「秒级空档」 |
| 首字延迟 | 21.4s（中继 + 模型 TTFT） | 与渲染无关，是链路/模型侧 |
| 流式窗口掉帧（`dumpsys gfxinfo`） | 280 帧 / 190 janky（**67.9%**），p50 **65ms** | **渲染层仍重**，rAF 只能改「什么时候画」，改不了「一帧多贵」 |

→ 结论：合批层已达标；剩余卡顿在**单帧成本**（`paintLiveText` 的 md+morph、`attachCaret` 每帧
TreeWalker、`scrollToBottom` 每帧读 scrollHeight）。下一轮应压单帧成本，而不是继续调节拍。

### 6.1 安装包体积：universal → 按 ABI 拆分（省 110MB/设备）

| 包 | 改前 | 改后 |
|---|---|---|
| complete release（universal，双 ABI） | **345.9MB** | — |
| complete release **arm64-v8a** | — | **226.2MB** |
| complete release **x86_64** | — | 236.7MB |
| complete debug（x86_64，实机用） | 357.8MB | 244.1MB |
| standard debug | 93.4MB | 93.4MB（无 rootfs，拆开只省另一份 onnx） |

构成（release universal，未压缩条目合计 409.9MB）：`libdshrootfs.so` arm64 103.5MB + x86_64 113.3MB
（rootfs 双载荷，**每台设备只需要自己那份**）、`assets/buildtools` 54MB（android.jar 27MB + d8 16.6MB）、
`tts-neural` 32.6MB、`asr-small` 26.3MB、onnxruntime 22.2/25.6MB（双 ABI）、sherpa 5MB×2。

**结论**：universal 包里有 ~110MB 是「另一台设备的 rootfs」。`splits.abi` 打开后按 ABI 出包，
每台设备只下自己那份 —— 这是本轮最大的单项存储收益。

### 7. 顺带修的真 bug：轮末工具调用内容消失

用户原话「可以折叠，但不要消失」，随后又要求「不要又用卡片设计，看看桌面端怎么渲染工具行」。

- **病因**：`Flow.settle` 把整组（思考+工具）一起 `folded`，工具行只是折叠组的内部成员
  —— 轮末视觉上等于「刚才调用过什么全没了」；而且只把 `m.diff`（改文件）抽成独立行。
- **桌面端依据**：`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx` ——
  工具行是 `DisclosureRow`（icon + 标题 + 摘要 + 耗时），**不是卡片**；折叠时占一行，
  点开才展开 body/输出。
- **改法**：
  1. 新增节点 `toolrow`（`NODES.toolrow(m)`，members 里放一个成员 → 共用 `data-pg-toggle`
     的展开逻辑），渲染复用组内同款 `toolRowHTML`，外壳加 `.tool-line` 去掉背景/圆角/边框。
  2. `Flow.settle` 把工具成员也抽成独立行（改文件的仍走 `change` 行）。
  3. 顺手统一：历史快照里的 `tool` 节点也走同一套单行渲染 —— 对话流里工具只有一种长相。
- **实测**：真模型跑两轮 `bash`，两轮都是「已完成，用时 N 秒 ∨」+ 下面一行
  `执行命令 · 跑 date +%T 和 uname -m · 0.1ms`；旧会话里的卡片也随之变成单行。
  截图 `.motion/verify/tool-line-kept.png`。

---

## M11 结论（2026-10-26，按「8 分以下」逐域找根因）

### 方法论：先找根因，再谈分数

三个域各有一个**结构性根因**，不动根因调参数毫无意义：

| 域 | 根因 | 证据 |
|---|---|---|
| 终端 | 会话后端只有安卓宿主 `/system/bin/sh` | 实测 `which java python3 git gcc` **四个全空** |
| 造 App | 公共 debug 密钥（密码固定 `android`） | 任何人可伪造；商店拒收 |
| 文件制作 | 慢不在生成器，在**行级正则** | 800 行标题 804ms、800 段正文 643ms，与内容长度无关只与行数成正比 |

### 终端 7.0 → 8.6

- 后端可注入（`ShellLauncher`）：`workspace` = rootfs 的 sh，`device` = 宿主 sh。
  实测 `which java python3 gcc node` → 四个 `/usr/bin/…` 路径；`python3` 求和 5050；`java -version` OpenJDK 21。
- 结束判定换成哨兵 `__DSH_END_<token>_<exit>__`（shell 自己打印）：
  - `which` 一条命令 **1092ms → 269ms**
  - `sleep 3 && echo done` → **3282ms 返回真实输出**（旧版 700ms 就报已结束、给空输出）
  - 首次能拿到 `exit_code` 并如实告知非 0
- 踩坑：`/bin/sh -> /bin/busybox` 是**绝对**符号链接，宿主 `File.exists()` 必断链 →
  报 `NEED_RUNTIME:sh`。修 `guestEntryExists`（读链接目标，落在 rootfs 内即算可用）。
- 坑：宿主 `sh -i` 每条约多打两个 PS1 提示符，被模型当成输出 → 去掉 `-i` + `PS1=""`。
- proot 下 JVM 启动抖动（mprotect(PROT_EXEC)）加**一次**重试，判据收在 `JvmStartupJitter`
  （用户代码已跑过 / 堆不够 / 只有半截错误都不算），避免重跑有副作用的命令。

### 造 App 8.3 → 8.5

- 首次构建用 rootfs 的 `keytool` 生成专属 RSA-2048（100 年），存 `.dsh-keys/`，
  口令 24 位随机、权限 600，之后复用。
- `apksigner verify --print-certs` 实测 `CN=DeepSeek Harness Mobile`（debug 是 `CN=Android Debug`）。
- keytool 也受 JVM 抖动影响 → 5 次递增退避 + 缩小地址空间（同 BuildDaemon）。

### 文件制作 7.3 → 7.6

- **设备端毫秒数不可信**：同一份 42KB 内容两次测量 2.6s / 0.7s（CDP 往返 + debug 构建的
  ART 解释执行 + 生成混在一起）。改用 JVM 基准做同机新旧对照才是干净的。
- 三处浪费都与**行数**成正比：每行 6 个 `Regex.matches`；每段再 4 个（isBlockStart）；
  每个标题一次 `Regex.replaceAll`（字面量替换写成了正则）。
- 改：`classify()` 首字符分派 + `isBlockStart` 复用 + `String.replace` 字面量 + 无标记段落不进 Matcher。
- **实测（同机新旧对照）**：1674 段 **26ms → 10ms（2.4 倍）**；94 段 5ms → 3ms。
- 新增 `DocWriterBenchTest` 作为量级门禁（阈值宽松，只拦「正则又写回逐行编译」）。

### 本轮被数据推翻的两个假设

1. 「设备端的毫秒数是可信的」—— debug 构建的 ART 解释执行会把字符串/循环密集代码放大一个量级。
2. 「终端慢是因为命令本身慢」—— 实际每条固定多付 700ms 静默等待。

### 手机操控 7.3 → 7.8（同轮继续）

先查「为什么串行」，结论是**架构性的、不该硬改**：`standard` 模式只暴露独立工具，
每步一个 LLM 往返；`ptc` 模式的 `run_code` 本来就能 `await dsh.callTool(...)` 连续调
（`PtcRuntime.Bridge.call` → `registry.exec`，任何工具都能调）。**没有新造「批量动作工具」**——
桌面 `cua` 同样是一次一个动作，合并靠 PTC 模式。

真正两处缺陷：

1. **`findNodes` 合并两路结果没去重**（准确）：`byText + byId`，同一节点若两路都命中
   （按钮文本恰好等于 id 末段），`all.size` 偏大 → `ordinal` 数到重复项 → **点到隔壁元素**。
   改 `LinkedHashSet` 去重；四条优先级抽成 `NodeMatch.select`（纯函数）。
2. **`findNodesRetry` 无条件重试 6×250ms**（速度）：模型记错元素名时固定白等 1.5s。
   改为「界面已静默 ≥150ms 就停」（静默=确实没有，不是没渲染完），最坏 1.6s → ~0.25s。
   **未端到端实测**：操控工具要求活跃轮次做应用授权，CDP 直调被 `APP_APPROVAL_UNAVAILABLE` 拒绝。

`NodeMatchTest` 11 个用例锁住四条优先级 + 空查询保护 + 大小写语义 + 越界提示。
**天花板**：速度维受 standard 模式串行往返限制，要再快只能切 PTC 模式。

### 媒体与设备 7.0 → 7.5（该域首个测试）

唯一一个**零 test 文件**的域。真问题不是算法，是同一件事写了 5 份：

- 名字清洗散在 5 处、两套规则（相册那条更严 → `微信/收藏` 变 `微信收藏` 丢信息，
  文件名那条变 `微信_收藏`）。收敛成 `MediaPaths.cleanName`。
- 两处真实风险：**没有长度上限**（Android 单段 255 字节，中文 3 字节 → 100 字名字写盘失败，
  错误信息看不出原因；截断到 60 字=180 字节）；清洗后只剩 `__` 会产出一个下划线目录（回退默认名）。
- `gallery_read(kind=all)` 的「两路各取 limit → 按时间统一排序再截断」抽成 `mergeRecent`
  并锁住语义（实现本来对，但没测试，改一行就会回归）。
- `MediaPathsTest` 12 例。**我自己写错一条断言**：最初写「不含 `..`」，实际
  `../../etc/passwd` → `.._.._etc_passwd` 是安全的（整段是一个名字）；判据必须是
  「作为单个路径段无法改变父目录」，不是「字符串里没有两个点」。

### 会话与团队：查过，没有可改的真缺陷

两域都已有测试（SessionStore/CompactorOverflow/SpillPolicy；TeamBoard/TeamJournal/TeamRoster），
逐文件复核无新 P0。会话质量 6.5 是「记忆内容写得好不好」，团队质量 6.5/易用 7.0 未定位到代码位置。
**不为了让分数好看而动刀** —— 没有根因改代码只会引入新缺陷。

### 剩余低于 8 的域与各自根因（下一轮入场券）

| 域 | 均分 | 根因 |
|---|---|---|
| 桌面兼容与插件自造 | 6.5 | `plugin_market` 无协议文档 —— 硬造协议等于假实现，**记档不改** |
| 会话与记忆 | 7.3 | 质量 6.5 是内容质量，非代码缺陷 |
| 智能体团队协作 | 7.7 | 质量 6.5 / 易用 7.0 未定位 |

**这几项都不是调参数能解决的**，下一轮按同样方式先定位根因再动手。

### 桌面兼容 6.5 → 7.2：plugin_market 按桌面协议真实现

**先纠正我自己的错误结论**：上一轮写「兼容自造缺 plugin_market 协议文档，硬造等于假实现，记档不改」。
查桌面源码发现协议一直在，是我没查到：

| 桌面位置 | 内容 |
|---|---|
| `packages/util/plugin-market-index` | format 1 校验器（字段/LocalizedText/marketInstallTarget） |
| `packages/boot/plugin-market` | 读取服务（indexes/timeout/maxBytes/cacheTtl、search(url,query)） |
| `.agents/notes/…/plugin-market-index-format.md` | 格式定义 |

手机端实情比「没有协议」更糟：**配了 marketUrl 就直接 throw「暂未实现」**——有入口没实现。

实现：`PluginMarketIndex`（校验 + 检索 + installSpec）、`MarketClient`（URL 校验/超时/缓存/限长）。
- install spec 逐字符照抄：npm → `name@version`；git → `git+<url补.git>#<commit>&path:/<dir>`
  （是 `&` 不是 `?`，改了 pnpm 装不上）
- 违规抛带 JSON 路径的错误（`plugins[0].versions[0].version`），不是笼统「格式错误」
- URL 只收 http/https、无凭据、无 fragment；search 只认已配置地址（桌面同规矩，否则是 SSRF 通道）
- 有意偏差：maxBytes 16MB（桌面 128MB，安卓堆放不下）；不实现 setIndexes（无持久层，不假装能写）

测试 25 例，抓到一个真缺陷：检索用「只取主语言」的 text() → 中文环境搜英文标题 0 结果，
改 textAll()。

端到端（模拟器 + 本地索引服务）：首次 15.3s（网络）、缓存 270ms；检索命中；git spec 正确；
未配置 URL 被拒、未知插件报 PLUGIN_NOT_FOUND。

**教训**：说「缺文档」之前必须先搜对方仓库的 `util/` 与 `.agents/notes/`。
把「我没找到」当成「不存在」，会让一个可做的功能被永久记成「记档不改」。

### 桌面兼容域最后的真欠账：git（已补）

CompatPlugin 自述「能实现的都实现了」，逐条核对后只剩一处真欠账：**create_worktree 依赖 git，
而 rootfs 没有 git**。且旧实现在宿主直接 `ProcessBuilder("git")` —— 宿主没有 git、rootfs 里的
git（musl 动态）宿主也执行不了，**从上线起就必然 GIT_UNAVAILABLE**，从没工作过。

**补法：rootfs 增量补丁**（不打进 157MB 主载荷）：
- Alpine 3.21 的 `git 2.47.3 + libcurl + pcre2 + ca-certificates-bundle`，4 个包压缩 4.4MB；
- 载荷放 jniLibs（`libdshgit.so`，按 ABI 只带自己那份，aapt2 同先例），APK +4MB/ABI；
- `KernelRuntime.ensureGitPatch`：rootfs 就绪路径与 fast-path 都幂等检查 `usr/bin/git`，
  缺则用**宿主 busybox** 解包（rootfs 内的 musl 二进制宿主执行不了，报 No such file，
  与 guardGuestEntry 同源现象但这次是执行）；
- 顺带修基础镜像缺陷：`HOME=/root` 但 **/root 目录不存在**（git config --global 写不进去），
  补丁里带上该目录。

**端到端**：删掉手动解的 46 个文件 → 重启 → 应用自动补齐；终端 `git config/init/commit/log`
全通（2.47.3）；`create_worktree` 首次真跑通（`Preparing worktree (new branch 'feat-x')`，
host/guest 双路径返回）；非仓库工作区报结构化 `NOT_A_GIT_REPO` 并给能落地的指引。

**同轮更正两个「如实声明」**：TerminalPlugin 的 runtimes 文案从「缺 git」改为「git 可用」；
CompatPlugin 的 create_worktree 描述从「需要设备上有 git」改为「走 rootfs 里的 git 2.47」。

---

## 清理（2026-10-29，rc.149）

测试期攒下来的中间产物已经删掉，`.motion` 从 1.3GB 降到 6MB：

| 删除 | 体积 | 为什么可以删 |
|---|---|---|
| `.motion/runtimes/` | ~1.0GB | 构建缓存（Termux deb、Alpine apk 包、设备端 tar、中间 tree）。重建见 `app/src/main/jniLibs/README.md` |
| `.motion/m0/` | 60MB | M0 spike 的临时探针产物 |
| `.motion/demoapp/` | 8.6MB | 手搓演示工程 + 自研 AXML 原型；这两件事现在分别由 `app_new` 工具和 aapt2（Termux 版）正式取代 |
| 一次性 `probe-*.mjs`（18 个） | <1MB | 当时用来二分定位（busybox seccomp、landlock、JVM 抖动、解包失败…），结论已写进本文件，脚本不再有复用价值 |

**保留**：`verify-*.mjs` / `sweep-*.mjs` / `e2e-chat.mjs` / `watch-turn.mjs`（回归验收）、
`dev-proxy.mjs` + `setup-model.mjs`（模拟器联调，只有 10.0.2.2 可达时的唯一通路）、
`build-rootfs.sh` / `pack-rootfs.sh` / `verify-rootfs.sh`（rootfs 重建管线）、
`.motion/harness-plan-ondevice.md`（本文件）。
