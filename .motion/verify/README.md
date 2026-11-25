# 动效改版验证 · 说明与索引

被测 App：`ai.deepseek.harness.mobile`（DSH Mobile）
设备：`emulator-5554`（AVD `dsh36`，1080x2400，Android 16 / API 36，density 420）
WebView：`com.google.android.webview 133.0.6943.137`
视口：412x915 CSS px，dpr 2.625

> 所有截图/测量都跑 **APK 里打包的** Web 资源，不是工作区源码。
> 基线必须用已构建的 rc.98 APK；改后用新构建的 APK。这样才不受「同事正在改源码」影响。

---

## 1. 目录

### `baseline/` —— 改前基线（rc.98, versionCode 97）
| 文件 | 说明 |
|---|---|
| `01-sessions.png` ~ `08-swipe-actions.png` | 会话列表 / 对话页(20 条消息) / 任务 / 文件 / 设置 / 模型面板 / 语音音色浮窗 / 会话左滑展开 |
| `measurements.json` | 设备与版本、`motionRuntime`、各元素 CSS 过渡、各页数量、面板/浮窗/左滑的 DOM 断言 |
| `probe-baseline.json` | 逐帧动效测量（见下） |
| `audit.json` / `audit-run1.json` | `.test/audit1..5.mjs` 回归结果（run1 全过；run2 因上一个审计把 App 留在对话页导致 audit2 在 `.tab.is-on` 上炸，脚本已改为每次强制重启 App） |

### `after1/` —— 第一轮冒烟（rc.99 debug, versionCode 98，22:24 构建）
| 文件 | 说明 |
|---|---|
| `01-sessions / 03-jobs / 04-files / 05-settings / 06-sheet-model / 07-voice-popover .png` | 4 个 tab + 模型面板 + 音色浮窗 |
| `measurements.json` | 环境与静态机制（`motionRuntime.present=true`，CSS 过渡已摘） |

> 对话页与左滑两张缺失：装 debug 必须先卸载正式包（签名不同），App 数据被清空，
> 而 local 模式下会话列表只来自 `dsh.local.sessions`（`app.js:4458` 在 host 模式下才拉远端）。

### `bug-navback/` —— 「返回会话页残影」复现证据
| 文件 | 说明 |
|---|---|
| `before-030/080/150/250.png` | 点返回后 30/80/150/250ms 的帧（**注意**：切换实际 349ms 后才起步，这几帧画面还没动） |
| `before-nav+030/080/150/250.png` | **相对切换起步**的 30/80/150/250ms，残影就在这几帧里 |
| `frames/` | 全部 30 帧 |
| `navback-before.json` | 逐帧时间线、有效可见度、验收判定 |

### 其它
| 文件 | 说明 |
|---|---|
| `../probe-baseline.json` | 基线探针原始输出 |
| `../seed-local-sessions.mjs` | 自己写的会话夹具（已被官方 `scripts/seed_sessions.js` 取代，保留用于 `--clear`） |
| `capture-baseline.mjs` | 截图 + 静态机制快照（`--label` / `--out`） |
| `capture-navback.mjs` | 返回残影复现 + 验收判定（`--label`） |
| `run-audits.mjs` | 依次跑 `.test/audit1..5.mjs`，每次先重启 App，输出落 `.motion/verify/<label>/audit.json` |
| `build-after1.log` | 离线构建日志 |
| `probe-island.mjs` / `probe-island-tune.mjs` | 灵动岛几何与调参（走前端真实拖动，不直调桥） |
| `probe-cloud-tts.mjs` | 云端语音模型：本地假 TTS 服务 + 真实 UI 填表，验证配置脱敏 / 请求体 / 试听 / 语音条 / 关掉回退 |

---

## 2. 探针 `scripts/motion_probe.mjs`

```bash
node scripts/motion_probe.mjs --label baseline                       # 基线
node scripts/motion_probe.mjs --label after1 --sheet-row "#rowContext"  # 面板入口可换
node scripts/motion_probe.mjs --help
```

测量项：按压响应、Tab 指示器收敛/过冲、底部面板打开收敛/过冲、左滑松手落位、拖动跟手保真度、
帧率与长任务。

### 关键设计
- **可信触摸**：用 CDP `Input.dispatchTouchEvent` 合成真实手势（`isTrusted=true`）。
  不可用时自动退化为 JS `PointerEvent` 并在 JSON 里标 `input.trusted=false`。
- **逐帧采样**：页面内 `requestAnimationFrame` 循环读 `getComputedStyle` + `DOMMatrix`，
  比 CDP 往返精确。
- **时间拆解**（Lead 要求单列）：
  - `inputToFirstFrameMs` —— pointerdown → 首帧视觉变化（用户感知总延迟）
  - `inputToClickMs` —— WebView 把 touch 合成 click 的延迟（动效层管不到）
  - `clickToFirstFrameMs` —— 收到 click → 首帧
  - `switchToFirstFrameMs` —— 状态真的变了（class/style 突变）→ 首帧
- **收敛口径**：`settleMs` = 从 input 到数值稳定在 ±0.5px；`motionStartMs` = 到开始动；
  `settleFromMotionMs` = 动起来到收敛。`overshootPx/Pct` = 越过终值的最大额外位移。
- **帧率**：`idleControl` 是**无交互 1s 的对照**，交互期帧率必须和它比才有意义
  （宿主机被其它 agent 抢 CPU 时 idle 会掉）。
  `phaseFrames` / `longTasks.byPhase` 把掉帧与长任务归到 press / tabIndicator / sheetOpen / swipeRelease。
- **seeded 标注**：读到 `localStorage["dsh.local.sessions"]` 里有 `t-` 前缀的 id 时，
  自动置 `seeded:true` 并写明来源。

---

## 3. 基线（rc.98）关键结论

1. **没有 `Motion`**：12 处动效全是 CSS transition（`#tabIndicator` `transform .46s`，`#sheet` `transform .44s`，`.session-item` `transform .28s`）。
2. **按压零反馈**：按住会话行 320ms，11 个计算属性逐帧比对**全无变化**（5/5 次）。
3. **点按 → 动效起步有明显延迟**：Tab ~117ms；面板 ~350ms（其中约 300ms 是 WebView touch→click 合成）。
4. **Tab 指示器**：settle 467ms，**过冲 0**，宽度不参与动画。
5. **会话左滑跟手基本失效**：拖动期 **61% 的帧**里 `.session-item` 的 `style.transform` 被按压态
   `scale(1.14,0.913) skewX(-3.12deg)` 覆盖，`translateX` 被顶掉；跟手区平均偏差 **70px**，
   只有 **11%** 的帧在 8px 内；硬夹在 -228px；松手落位 467ms。
6. **帧率** ~59.7fps（当次宿主机较空）。

---

## 4. 返回会话页残影（已复现，证据在 `bug-navback/`）

以「点返回」的 pointerdown 为 0：

| 时刻 | 现象 |
|---|---|
| 0 → 349ms | 画面完全没动：仍是对话页，tabbar 仍 `is-hidden`。这 349ms 是 WebView touch→click 合成延迟 |
| 349ms | 切换起步：tabbar 立刻显示；sessions 到 opacity 0.55；chat 仍 1.0 |
| 349 → 706ms | **残影窗口 357ms**，两页同时可见 |
| 349 → 706ms | chat opacity 只从 1.0 衰减到 **0.860 就停住**，随后在 ~718ms **硬切到 0** |

判定（几何相交 + 有效可见度）：
- chat `.nav-compact` ∩ sessions `.nav-large` 最大 **21325 px²**；
- chat `#composerDock` ∩ `#tabbar` 最大 **21576 px²**（底部也叠）；
- `#composerDock` ∩ sessions 顶栏 = 0（dock 在底部）；
- sessions 大标题自身 opacity 恒为 1，**没有独立闪动**，是随整页 0.55→1 淡入。

**验收口径**（`capture-navback.mjs` 已内置，重建后自动判定）：
1. 任意帧不得同时满足 `chat .nav-compact` 有效可见度>0.05 **且** `sessions .nav-large` 有效可见度>0.05；
2. 任意帧 `composerDock` ∩ `tabbar` 面积 < 2000 px²；
3. 稳定态 chat 页 opacity 必须 = 0（不是 0.86）。

> 有效可见度 = 元素自身 opacity × 所有祖先 opacity（只看自己的 computed opacity 永远是 1，会误判）。

---

## 4b. 进入对话残影（rc.105 修复，证据在 `bug-pushghost/`）

push（会话→对话）方向同款问题的另一半：**离场会话页终点被设为 `opacity:0.55` 且驻留不动**，
要等入场弹簧收尾（~360ms）或 500ms 保险定时器才清；对话页 0.55 半透明起步且消息区/输入区
全透明（真背景在 `.device`），会话列表从透明区透出；chrome 快速退场只覆盖含搜索框的
`.nav-large`（140ms），「搜索框以下消失慢」即此。

复现/验收脚本 `capture-pushghost.mjs`（锚点 = 离场开始，即 is-leaving 首次为 true）：

```
node .motion/verify/capture-pushghost.mjs --label before     # 带 screencast 逐帧
node .motion/verify/capture-pushghost.mjs --label after --noscreencast   # 轻载（避开 screencast 拖垮帧率）
node .motion/verify/stress-pushghost.mjs                     # 重入压测：20 次快速来回
node .motion/verify/modes-test.mjs legacy|reduce             # 退化路径
```

| 指标 | before（rc.104 实跑） | after（rc.105 实跑） |
|---|---|---|
| 压暗驻留段（0.3–0.75 + scale 0.98 + is-leaving，稳定 ≥3 帧） | **376ms**（10 个稳定采样点钉在 0.55） | 0（任何帧率下均无） |
| 会话页最后可见（离场开始起算） | 443.7ms（好帧率下也被入场收尾从 ~0.73 硬切） | 206.3ms / 135.8ms（两轮） |
| is-leaving 摘除 | 靠 500ms 保险定时器（+472ms） | 离场弹簧自己的 onComplete（轻载轮 +383ms，早于保险） |
| +600ms 稳态 sessions opacity | 0（保险兜底） | 0 |
| 20 次快速来回终态 | — | 零残留（`stress-pushghost.mjs` PASS） |
| `?motion=legacy` / `?motion=reduce` | — | 各 3 轮来回终态干净（`modes-test.mjs` PASS） |

**方法论教训（复用）**：
- 采样器必须用 `setInterval(8ms)` 不能用 rAF——模拟器 + screencast 负载下 rAF 会被饿到
  200ms+ 一帧，驻留窗口整段漏采（before 前几轮就是这样漏成「无驻留」假阴性）；
- CDP 触摸→WebView 点击合成 250–600ms，脚本只可单击后等待，**不可循环重点**——
  重复点击会产生多次 `go()`，互相 settle 把离场弹簧 `stop()` 掉（`stop()` 只摘活跃不触发
  onComplete），污染判定；
- `input motionevent` 多次调用会丢事件（MOVE 只到一次、UP 丢失），不可用；
- WebViewAssetLoader 走 APK 内 assets，改 web 文件必须重新构建装机；验证实跑版本可
  `fetch('/assets/web/app.js')` 回读特征串；
- 验收锚点用「离场开始」而非「点击」——点击合成延迟（250–600ms）会把点击相对时间吹胀。

---

## 5. 第一轮改后（after1）初步读数 —— 注意环境干扰

| 指标 | baseline | after1 |
|---|---|---|
| `window.Motion` | 无 | **有**（press, pressIn, sheet, gentle, bouncy, exit, settle） |
| 媒体过渡 | `.46s / .44s / .28s` | `none / none / background-color .16s`（已摘干净） |
| 面板过冲 | 5.58px (1%) | **0.57px (0.1%)** |
| 左滑跟手（跟手区平均偏差） | **70.3px** | **6.8 ~ 7.3px** |
| 左滑松手落位 | 466.6ms | **400ms**，过冲 0，能正常吸附 |
| Tab 指示器 settle | 467ms | 967 ~ 1033ms（**疑似变慢，待干净环境复测**） |
| Tab 过冲 | 0 | 0 ~ 0.45px |
| 帧率 | 59.7fps | 交互期 15.8 ~ 19.8fps，**但 idle 对照只有 45.9fps** |

**这些数字不可作为验收依据**：测量时宿主机 CPU 一度 81%→100%，十几个 agent 进程 + 模拟器
抢同一个 12 核。`idleControl` 从 60fps 掉到 45.9fps 就是证据。Tab 的 settle 变慢很可能是掉帧造成的
（每帧 `dt` 被钳在 32ms，掉帧会把动画在墙钟时间上拉长），**必须在安静环境重测才能定性**。

**按压反馈**：after1 仍未观察到。探针 5/5 次按压会话行无变化；另外单独按压
会话行 / Tab / 设置行也都没变化，只有「新建对话」按钮在 ~328ms 出现 `scale(.982)`
（时点在松手之后，疑似是回弹而不是按下）。`pressIn` 预设存在但没在这些元素上生效，
需要确认是否还没接上。

---

## 6. 复现命令

```bash
# 基线
adb uninstall ai.deepseek.harness.mobile   # 正式包与 debug 签名不同，必须先卸
adb install -r 1.DSH-Mobile-0.2.1-rc.98-release.apk
.test/adbw.sh true
node .motion/verify/capture-baseline.mjs --label baseline
node scripts/motion_probe.mjs --label baseline
node .motion/verify/run-audits.mjs --label baseline

# 改后
adb install -r app/build/outputs/apk/debug/app-debug.apk
.test/adbw.sh true
# 会话夹具（否则 local 模式下列表为空，左滑/按压没目标）
node -e '…执行 scripts/seed_sessions.js…'      # 或见 README 用法
node scripts/motion_probe.mjs --label after --sheet-row "#rowContext"
node .motion/verify/capture-baseline.mjs --label after
node .motion/verify/capture-navback.mjs --label after      # 内含验收判定
```

构建（离线可用）：
```bash
set JAVA_HOME=C:\Program Files\Java\jdk-17
gradlew.bat assembleDebug --offline
```

---

## 性能基准（perf-*.mjs）

同一台模拟器上量「改前 / 改后」用的四个脚本。**必须用同一台设备、同一构建类型、交替安装对比** ——
本机实测冷启动的日间漂移可达 100ms 以上，跨时间段的数字不可直接比。

| 脚本 | 量什么 |
|---|---|
| `perf-stress.mjs seed\|boot\|open\|scroll\|interact\|trace` | 压力夹具（24 会话 / 单会话 120 条消息）+ 冷启动时序、打开长会话、滚动帧率、搜索输入/切页的主线程占用、Blink 事件分布 |
| `perf-restyle.mjs` | 4 次切页的 `UpdateLayoutTree` / `Layout` / `Paint` 次数与耗时（看样式重算规模） |
| `perf-shots.mjs <前缀>` | 固定四屏截图（会话 / 对话中部 / 设置 / 语言浮层），用于逐像素比对「视觉零变化」 |
| `perf-regress.mjs` | 界面级回归：左滑四键、置顶、语言中英往返、英文模式下新插入面板是否翻译 |

用法：

```bash
adb forward tcp:9227 localabstract:webview_devtools_remote_$(adb shell pidof ai.deepseek.harness.mobile)
node .motion/verify/perf-stress.mjs seed && node .motion/verify/perf-stress.mjs interact
```

夹具标题统一带 `stress-` 前缀，测完记得删（`localStorage` 里的 `dsh.local.sessions` 索引与 `dsh.local.sess.<id>` 载荷）。

---

## 操控灵动岛设备探针（rc.214 起，三条常驻）

岛是原生 `TYPE_ACCESSIBILITY_OVERLAY` 悬浮窗，**不在 WebView 里**：`uiautomator dump` 读不到它的文字，
所以文字靠截图胶片复核、彩点靠像素断言。三条脚本各管一段，跑之前都要：

```bash
export PATH="/d/1/tools/android-sdk/platform-tools:$PATH"
adb install -r app/build/outputs/apk/standard/debug/app-standard-x86_64-debug.apk
PID=$(adb shell pidof ai.deepseek.harness.mobile)
adb forward --remove tcp:9227; adb forward tcp:9227 localabstract:webview_devtools_remote_$PID
# 覆盖安装会重置无障碍授权，系统设置里重新打开 DSH 服务
```

| 脚本 | 管什么 | 关键断言 |
|---|---|---|
| `probe-island.mjs` | 几何 / 单窗口 / 源码守卫 | 胶囊 `378×76`、孔心 551、长文案宽度不变、展开 `996×213` 且 `y1` 不动、视觉窗口零 `updateViewLayout`、标题/详情给挖孔让位 |
| `probe-island-motion.mjs` | `screenrecord` 30fps 抽帧 | 相邻帧无整块瞬移 `jumps=0`、中心与宽度无系统性相关、宽度单调 `backs=0/0`；导出 `island-morph-filmstrip.png` 与离群帧图 |
| `probe-island-info.mjs` | 10 个真工具动作后的显示 | 彩点像素 10/10 `d=0`、固定简称不截词、进度 `2/5` 不丢、卡片标题/详情不重复、审批被拒时岛不谎报 |

**踩过的坑，别再踩**：

- 点击不能落在 `x≈492..610`（挖孔保护区，系统窗口吞掉点击，表现为「点了没反应」）；脚本按热区窗口实际 frame 取点并自动避开。
- 模拟器是 x86_64，装 arm64 包会 `libonnxruntime.so` SIGSEGV；只用 `app-standard-x86_64-debug.apk`。
- App 每次重启后 CDP forward 的 pid 会失效，必须重设，否则 `Empty reply from server`。
- 桌面下拉出的应用抽屉层级高于 `TYPE_ACCESSIBILITY_OVERLAY`，会盖住岛（不是岛消失）；截图前用原生 BACK 收掉。
- 离群帧**不许当编码噪声随手剔除**：上一轮就是这么把「整块瞬移 309px」的真 bug 放过，导致稳态中心、回归斜率全绿而用户看到的晃动一直在。

---

## 语音探针（2026-11-06 起）

内置神经语音模型与「经典男」整条删除后，旧的 `probe-voice.mjs` / `repro-voice.mjs` /
`verify-bazong.mjs` 全部依赖已删的 `neuralStatus`，留着只会假绿，已移除。
现在只有 `probe-cloud-tts.mjs`：在宿主起一个返回 wav 的假 TTS 服务，用 `adb reverse`
让模拟器通过 `127.0.0.1:8898` 访问，再从**真实 UI** 填表保存并试听，核对请求体、
Authorization、语音条 data URL，最后关掉云端确认不再发请求（回退系统 TTS）。

两个踩坑：
- 语音设置行在 **设置 → 插件** 面板里（`voicePluginPanel`），不在设置主列表，探针要先点 `#rowPlugins`。
- 语音条必须走 `synthVoiceAsync`。同步 `synthVoice` 在云端没配好时会落回系统 TTS，
  模拟器上逐段 `synthesizeToFile` 能占死 WebView 主线程到分钟级，后续 CDP eval 全部排队。
