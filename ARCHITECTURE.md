# 架构总览（DSH Mobile）

> 这份文档解决的是「东西在哪、边界在哪、怎么加/怎么拆」，不是功能说明书。
> 功能与版本历史见 `README.md`；运行环境与打包链的实测结论见 `.motion/harness-plan-ondevice.md`。

## 1. 分层

```
web/src/*.js                前端源码（有序 part，顺序见 web/build.json）
   ↓ scripts/build-web.mjs 拼接（gate `web-bundle` 逐字节守着）
assets/web/                 产物：单文件 app.js + styles.css + motion.js
   ↕ window.DSHHost / DSHNative*（@JavascriptInterface）
bridge/                    桥：JS ⇄ Kotlin 的唯一入口，按域拆（AgentBridge / FsBridge / DeviceBridge …）
   ↕
agent/                     轮次驱动：AgentDriver（一回合＝多步）、ToolPipeline（权限/审批/沙箱）、
                           PromptAssembler（提示词）、Compactor（上下文压缩）、StreamFlusher（流式合批）
   ↕
kernel/                    内核：ToolKernel（装配）＋ plugin（注册/发现/目录）＋ 各领域服务
   ├─ plugin/builtin/      内置插件，按域分五个子包（见 §2）
   ├─ sandbox/  fs/       路径与写入边界
   ├─ team/  terminal/    领域服务（团队运行时、终端会话）
   ├─ device/  preview/   Android 能力（无障碍操控、预览渲染）
   ├─ doc/ chart/ theme/  产物生成（docx/xlsx/pdf/pptx、SVG 图表、配色）
   └─ runtime           KernelRuntime：busybox / proot / rootfs / guest 执行
```

**一条硬边界**：`kernel/` 不 import `bridge/`；桥只调用内核的公开 API，内核不知道有前端。

## 2. 内置插件按域分五个子包（`kernel/plugin/builtin/`）

| 子包 | 插件 | 职责 | 摘掉会怎样 |
|---|---|---|---|
| `fs/` | fs, shell, terminal, preset-tools, compat, plugin-builder, runtime, harness | 读写文件、跑命令、终端会话、按需运行时、桌面兼容层、自造插件 | 不能读写/执行，基本不可用 |
| `doc/` | doc, doc-write, editor, image, video | 读文档（pdf/docx/xlsx/pptx）、生成 docx/xlsx/pdf、图片/视频 | 只剩纯文本对话 |
| `device/` | capture, device-media, system-info, computer-use, personal-data, notify, alarm, clock, speech, stickers, companion | 相机/相册/分享、手机操控（无障碍）、通知、语音、时钟、陪伴 | 变成「只会聊天的 App」 |
| `agent/` | agent-team, agent-control, session-tools, memory, schedule | 智能体团队、会话工具、记忆、定时 | 只剩单轮问答 |
| `app/` | app-build, app-install（+ AppScaffold / BuildDaemon 支撑类） | 手机内造 App 并安装（aapt2/ecj/d8/apksigner + 常驻构建进程） | 不能自己造/装 App |

> **不要再往这张表里手写「工具数」。** 以前写过 19/6/16/10+/3，实际早就涨到 165 个（`docs/facts.json`
> 的 `uniqueTools` 是唯一真源，由 `gen-facts.mjs` 从注册表统计）。而且很多工具是循环生成的
> （`phone_*` 27 个、`team_task_*`、`terminal_*`），按目录 grep 也数不准 —— 想要分域数字就先让
> `gen-facts` 输出它，别靠人手数。

**为什么按域而不是按「工具/服务」拆**：桌面端（`dsh/packages/`）的分包粒度是「能力域」
（`fs` `doc` `document` `computer-use` `terminal` `agent-team` …），手机端保持同名同义，
一处改动能在两边对上号；而 ToolKernel/ManifestPlugin/sandbox 这些是**内核设施**，不分域。

## 3. 新增一个内置插件（三步，内核零改动）

1. 在对应域子包里写一个 `KernelPlugin` 实现（公开类 + 无参构造）。
2. 在 `app/src/main/resources/META-INF/services/ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin`
   里加一行**全限定类名**（顺序＝装配顺序，先注册先占工具名）。
3. 在 `kernel/plugin/ToolCatalog.kt` 登记每个工具的只读/风险/分组（有自检兜底，漏登记启动即报）。

发现机制是 Java `ServiceLoader`（`PluginDiscovery`）：安卓没有 classpath 扫描，这是唯一
零依赖、可被 R8 保留的标准机制。**换包名只需改清单里那一行**，内核不认识任何具体插件。

## 4. 与桌面端的对应关系（改哪边先看这张表）

| 桌面 `packages/` | 手机端对应 | 说明 |
|---|---|---|
| `subprocess` / `terminal` | `kernel/terminal/` + `KernelRuntime.openGuest` | 常驻子进程语义：进程寿命跨调用（构建守护进程即此形状） |
| `spill` / `compaction` | `agent/SpillPolicy.kt` / `agent/Compactor.kt` | 大输出外置 + 上下文压缩 |
| `agent-team` / `tool-agent-team` | `kernel/team/` + `plugin/builtin/agent/AgentTeamPlugin.kt` | 一个插件装服务+工具（手机端没有 Cordis 的包粒度） |
| `fs` / `shell` / `preset` | `plugin/builtin/fs/` | 同名能力 |
| `document` / `deliverables` | `kernel/doc/` + `plugin/builtin/doc/` | docx/xlsx/pdf/pptx 生成与预览 |
| `computer-use` / `browser-use` | `kernel/device/PhoneControlService` + `ComputerUsePlugin` | 手机用无障碍节点树，桌面用 CDP |
| `ui-tool`（ToolRow） | `assets/web/app.js` 的 `toolRowHTML` / `toolrow` 节点 | 工具行＝DisclosureRow，不是卡片 |
| `compaction-basic` / `llm-retry` | `AgentDriver.requestWithRetry` + `LlmRetry` | 重试预算与降档策略 |

**对齐原则**：语义对齐（同样的概念、同样的默认值），实现按平台重写（手机没有 Node/Cordis/bwrap）。
不对齐的是**载荷**：桌面靠宿主工具链，手机把工具链随包带（见 §2 `app/`）。

## 5. 可拆卸性

- 插件级：清单里删一行即卸载，工具名随之消失（`ToolCatalog` 自检会提示未登记/未注册）。
- 域级：删一个子包 + 清单里对应几行；`kernel/` 内没有对具体插件的引用（唯一例外是
  `ToolKernel` 对 `CompanionKeepService` 的引用，属前台保活服务的装配，改域时同步改一行 import）。
- 前端：`app.js` 对工具只认「名字 + 参数」，不认插件；新增工具不需要改前端。

## 6. 两端契约（结构怎么保持工整）

这个仓库的残留从来不是「大段注释掉的旧实现」，而是**删了 DOM / 换了通道之后留下来的半个调用点**：
桥方法没人调、事件推给不存在的处理器、`#id` 指向早已删掉的元素。这类东西不影响运行（都带 `if (el)`），
但会骗下一个读代码的人。所以由守卫把关，不靠人记：

| 守卫 | 管什么 |
| --- | --- |
| `scripts/build-web.mjs --check`（gate `web-bundle`） | `app/src/main/assets/web/app.js` 必须等于 `web/src` 按 `web/build.json` 拼出来的结果 —— 挡住「直接改产物」和「改了源忘 build」 |
| `scripts/regress/contract-alignment.test.mjs` | ① 每个 `@JavascriptInterface` 必须被 JS 侧（含内核自己拼的 JS 垫片）调用；② Kotlin `emit("onX")` 与 `DSHHost.onX` 两个方向都要齐；③ `app.js` 里静态 `#id` 必须存在于 `index.html`、模板串或 `.id = "x"` 赋值；④ `index.html` 的 id 与 SVG symbol 必须有人引用 |
| `scripts/regress/preview-sync.test.mjs` | `preview/` 与 `assets/web/` 逐字节一致（改完前端跑 `node scripts/sync-web.mjs`） |

三条约定：

- **屏的结构钩子**：每个屏同时带 `id="screen-x"` 与 `data-screen="x"`，CSS 与自动化按 id 挂钩，守卫对 `screen-*` 放行。
- **常量只有一个真源**：跨模块要用的值引用声明方（`StorageAudit.SPILL_SUB = ToolPipeline.SPILL_DIR`、
  `VOICE_CACHE_BYTES = VoiceCache.MAX_BYTES`），不许抄字面量 —— 抄来的两份会让面板数字与真实清理口径分叉。
- **桥方法一个动作一个入口**：`@JavascriptInterface` 的重载在 JS 侧选不出档位，所以像发送这种
  「带不带附件」的差异走同一个方法（空数组表示没有），不复制第二份构造。

