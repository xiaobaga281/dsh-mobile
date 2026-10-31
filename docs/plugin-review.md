# dsh-mobile 插件体系审查（31 个内置插件 + 自造插件链路）

> 目标：审查全部插件能力与设计规范，把「harness 自造插件」做实（对齐桌面一切皆插件），
> 软件结构工整无历史残留。每阶段改进均有模拟器实测记录（见文末）。
> 日期：2026-10-31 · 基线 rc.155 → 本轮产出随 rc.164。

## 1. 「一切皆插件」的手机端实现（与桌面 Cordis 的对位）

| 桌面 Cordis 能力 | 手机端对应 | 自造插件可用 |
|---|---|---|
| 插件 = 容器组件（load/unload） | `KernelPlugin.onLoad/onUnload` + `PluginRegistry.Entry` | ✓ |
| 工具注册（defineTool 拒缺 schema） | `ToolSpec`（name/description/parameters 必填） | ✓（PluginRules 校验） |
| 系统提示 waterfall 段落 | `promptSection()` | ✓（本轮补：清单 `prompt` 字段） |
| 服务 provide/inject（白名单 ctx） | `ctx.provide` / `DeclaresServices` 白名单 | 服务消费 ✓（清单 `services`）；provide 仅内置 |
| 事件总线 | `PluginHooks`（`<插件id>/` 前缀、卸载整体摘除） | 内置专属（JS 钩子不做，见 §4 取舍） |
| 人类批准激活 | `activationApproved`（只读拒 / 全权放 / 标准逐次） | ✓（实测） |
| 插件市场 | `plugin_list/create/install/uninstall` + `kernel/plugins/*.json` | ✓（实测） |

**结论**：桌面「一切皆插件」的四要素（工具 / 提示段 / 服务 / 事件）在手机端全部有落点；
自造插件经本轮补齐 `prompt` 后覆盖三要素，事件钩子按信任模型刻意不做（见 §4）。

## 2. 自造插件链路（本轮实测，修复 2 个 P0/P1）

**修复前实测**（故障复现）：『请同时调用三个 bash 工具…』与全生命周期演示轮中，
模型自述「wc_demo 虽已装配，但本会话的可用函数列表里没有它」，空转 200 秒找绕路。

| # | 缺陷 | 根因 | 修复 | 实测 |
|---|---|---|---|---|
| 1 | **P0** 装配后同轮不可见 | `Turn.toolDefs` 在轮开始冻结，后续 step 的请求永远带旧工具集 | `AgentDriver.runStep` 每步重算 `toolDefsFor(config)`；diff（OpenAI 嵌套格式读 `function.name`——首版读顶层 `name` 永远得空串集合，diff 永不触发，已修）非空时换装 + 记 `request/tools` 事件 | 日志：step2 装配 → step3 `fresh=144 frozen=143` 变更 `+[wc_demo]` → step5 模型**同轮调用 wc_demo 成功**（返回 3 行） |
| 2 | **P1** 预设白名单吞掉动态工具 | `preset.allow` 是内置工具名的固定集合，清单插件工具不在其中 → 永远被过滤 | `currentToolNames` 对 `registry.dynamicToolNames()` 豁免白名单（计划模式/只读闸门仍先行生效） | 同上日志 `dynamic=[wc_demo]` |
| 3 | prompt 段落缺失 | 清单只有 tools 字段 | 清单可选 `"prompt"`（≤1500 字校验，`PluginRules.checkPrompt` + JVM 测试），`ManifestPlugin.promptSection()` 贡献系统提示 | JVM 测试 ✓；设备装配链路同一条（§3 实测 3） |

修复后完整生命周期实测（真实 Agent 轮，117s）：
`plugin_spec → plugin_create(js, wc_demo) → write demo.txt → wc_demo 同轮调用（返回 3 行）→ plugin_uninstall（清单删除、工具摘除）`，
内核日志逐 step 记录工具集变化（143 → +wc_demo → 143）。

## 3. 全部内置插件盘点（30 个带工具/钩子 + clock 纯能力 = 31）

| 域 | id | 工具 | 域 | id | 工具 |
|---|---|---|---|---|---|
| agent | agent-control | 4 | device | notify | 1 |
| agent | agent-team | 10 | device | companion | 2 |
| agent | memory | 6 | device | computer-use | 27 |
| agent | schedule | 4 | device | device-media | 4 |
| agent | session-tools | 6 | device | capture | 3 |
| app | app-build | 2 | device | alarm | 2 |
| app | app-install | 1 | device | system-info | 2 |
| doc | doc | 1 | device | personal-data | 3 |
| doc | doc-write | 5 | device | speech | 1 |
| doc | editor | 3 | device | stickers | 5 |
| doc | image | 5 | device | clock | 0（纯能力：时间上下文） |
| doc | video | 1 | fs | fs | 12 |
| fs | shell | 1 | fs | harness | 11 |
| fs | terminal | 9 | fs | preset-tools | 5 |
| fs | runtime | 6 | fs | compat | 14 |
| fs | plugin-builder | 5 | | | |

**规范一致性扫描**（全量静态扫描：KernelError / promptSection / status / executionMode / timeoutMs）：
- `KernelError` 失败约定：29/30 遵守。例外：`computer-use`（27 工具）走结构化 `{ok,code,error}` 返回风格
  ——风格不一致但语义等价且全插件内自洽，**文档化接受**，不为此重写 27 个工具。
- `promptSection`：8/30 直接贡献；其余靠 PromptAssembler 的 `tool:<name>` 按域提示段落
  （设计如此：内置工具的用法提示集中在装配器，插件级说明归插件的 promptSection）。
- `status()`：28/30 提供（缺 agent-control / session-tools，仅影响设置页展示密度，记入待办）。
- `executionMode`：fs/doc/agent-team 的只读工具已声明 PARALLEL 进并发池；其余域为 exclusive
  （多为有状态操作，语义正确）。**待办**：memory/session/schedule/stickers 等域的真只读工具
  （memory_list / session_event_read / schedule_list / sticker_list…）可补 PARALLEL 声明，
  批量读取轮次有并发收益（改动小，本轮因插入复杂度未做，见 §5）。
- `timeoutMs`：5 个插件显式声明（shell/runtime/compat/preset-tools/app-install），其余走
  ToolPipeline 集中表兜底 + MCP 前缀默认档 —— 「集中表 + 工具声明优先」的合取语义即 M0
  遗留清理项的落地形态，无残留。

## 4. 本轮结构清理（无历史残留）

| 项 | 处置 |
|---|---|
| ToolCatalog 未登记工具告警（python/node/run/compile/java/rustc/pkg/mcp_tools） | **已修**：8 个工具显式落表（run 系任意代码执行 = DESTRUCTIVE，与 bash 同级；mcp_tools = WEB 网络往返），启动告警清零 |
| 超时预算双轨（M0 遗留） | 确认已收敛：`ToolPipeline.timeoutOf` = 工具声明优先 → 集中表兜底 → MCP 前缀默认。无双轨残留 |
| HarnessPlugin（桌面兼容层）| 确认非残留：工具声明与实现分离（实现是 agent.runtime 注入服务），与桌面同构 |
| CompatPlugin（14 工具） | 确认非残留：桌面工具名的兼容别名层（str_replace_editor 等），有存在价值 |
| 清单 `readOnly` 自声明 | rc 前已移除（WP4a），本轮复核无回归 |

## 5. 待办（按价值排序，未含在本轮）

1. 只读工具补 `executionMode = PARALLEL`（§3 待办；改动小，注意 object 匿名类结构逐一手工改）。
2. `status()` 补齐 agent-control / session-tools。
3. computer-use 错误风格统一到 KernelError（27 工具，工作量大、收益低——现有结构化返回自洽）。
4. 团队/子代理历史结构化（承接 harness-plan M1 清单 #4）。

## 6. 实测记录（每阶段）

| 阶段 | 内容 | 证据 |
|---|---|---|
| S1 | 修复前复现：同轮不可见 + 模型空转 200s | 会话日志（无 request/tools）+ 模型自述；DSHDriver 日志 `fresh=1 frozen=1` |
| S2 | 修复后全生命周期：创建→装配→**同轮调用**→卸载 | DSHDriver：`+[wc_demo]` / `-[wc_demo]`；会话日志 `tool/call step4 wc_demo`；模型报告 6 步全过 |
| S3 | prompt 字段：JVM 校验测试（合法/空白/非串/超长/段落贡献） | PluginRulesTest 4 项新用例 |
| S4 | 渲染修复：zip 清单预览 + pdf 段落重排 + 二进制嗅探 | 设备实测 `openWorkspaceFile(bundle.zip)` → kind=zip 条目表格；DocPreviewTest +2 |
| S5 | ToolCatalog 补登记后启动告警清零 | 编译 + ToolCatalogAuditTest |

## 7. 生成模型工具参数对齐（2026-10-31，随 rc.165）

用户实测「有些生成不了，因为给模型的参数太少」——video_generate 只有 4 参、image_generate 缺
图生图/质量档/按次换模型。逐项对齐端点真实 wire 形态后，**五条生成路径在模拟器 + mock 端点上
全部走通**（mock 收到的请求序列为证）：

| 路径 | wire 形态 | 实测 |
|---|---|---|
| 文生视频 | JSON /videos（seconds 字符串、比例映射） | ✓ mp4 落盘 |
| 图生视频 | multipart /videos（input_reference） | ✓ 边界可见 |
| 文生图 | JSON /images/generations（quality/model） | ✓ |
| 图生图 | multipart /images/edits（端点尾段自动推导） | ✓ |
| 400 错误 | 可行动提示（时长/分辨率/模型/参考图各一句「怎么改」） | ✓ |

## 8. write_docx 图片嵌入（2026-10-31，随 rc.166）

`![](工作区图片相对路径)` 行（png/jpg/gif）→ Word 原生 inline 图片：media part + 关系 +
drawing（EMU 缩放，5.5 英寸宽上限），尺寸读取支持 PNG/GIF 头与 JPEG SOF 扫描；
解析不到/超 8MB 降级为说明段。**两处平台差异实测踩过**：Android regex 拒绝未转义 `}`
（OpenJDK 容忍）；图片 zip 条目必须走二进制通道。设备实测：真实 PNG 嵌入，
docx 内 word/media/image1.png + 1 个 drawing，模型回报 images=1。

## 9. 显式 mode 参数 + 只读工具并发声明（2026-10-31，随 rc.167）

- **video_generate 补 `mode` 参数**（auto / text2video / image2video）：此前「文生 vs 图生」
  由 image_path 在场与否隐式推断——wire 形态对了，但 schema 不自解释，模型想图生视频却
  忘给图时会走进端点黑盒。现在：显式声明模式；image2video 缺图在**创建请求前**被拦截
  （实测：`mode=image2video 需要参考图：请给 image_path`），错误可行动。
- **只读工具补 `executionMode = PARALLEL`**（上一轮待办）：memory_search/memory_list、
  session_event_read/search/trace、session_search/trace、schedule_list、plugin_spec/plugin_list、
  device_info、sticker_list 共 13 个真只读工具进并发池——批量读取轮次不再串行排队。
- 实测：mode 校验（image2video 缺图被拦 + 错误原文上报）走真实 Agent 轮；
  全量 476 单测绿。

## 9.1 PARALLEL 声明设备实测（rc.167 发版后补充）

一轮内同时调用 4 个新声明为并发的只读工具（memory_list / schedule_list / sticker_list /
device_info）：会话日志显示 4 个调用同属 step1、**派发时间差 2ms**（进同一并发组），
执行 3–47ms 全部成功——PARALLEL 声明真实生效。会话日志留档（sessions/*.v2.jsonl）。

## 10. 文档富化 + schemas 缓存 + 光标移除（2026-10-31，随 rc.168）

- **write_docx 富文本**：超链接（外部关系）/斜体/删除线/嵌套列表（缩进 360 twips/层）。
  设备实测五特征齐备。
- **schemas 缓存**：AgentDriver 每步重算工具目录的成本从「每步 ~100KB 裁剪」降为「缓存命中 +
  结构变更失效」，JVM 测试钉住同实例命中与注册失效。
- **流式光标移除**（对齐桌面 ui-chat 无光标）：attachCaret/removeCaret/调用点/样式全删，
  设备实测流式期间 .caret = 0。
- **玻璃降级补齐**：.to-bottom 加入 @supports not 清单。

## 11. video mode 透传 + 按钮材质对齐（2026-10-31，随 rc.169）

- **mode 透传**：显式 text2video/image2video 进创建请求体（JSON 与 multipart 两路都带）；
  auto 不发——它是客户端推断语义，端点不认识。
- **回到底部按钮材质对齐输入框**：glass-strong(0.78 纯色)+blur30 → glass-a/b 渐变+blur38。
  实测断言：按钮与 .composer 的 backgroundImage / backdropFilter 计算值完全一致。

## 12. 队友历史结构化 + workflow fan-out 实证（2026-10-31，随 rc.169）

- **队友历史结构化**（M0 遗留清单 #4 清零）：assistantTurn 带 tool_calls wire、
  toolExec(id/args/output 全量)、inbox 补充落日志；memberHistory 重建结构化消息
  （旧格式日志文本近似兼容）。JVM 测试 4 项（配对/补充落日志/旧格式/limit 截断）。
- **workflow fan-out 设备实证**：一轮两次 spawn_teammate → 两成员并行激活 → wait_agent。
  成员失败均为测试端点 429（如实记 failed）。手机端 workflow 形态结论：异步团队 fan-out，
  同步脚本编排不照搬（run_code 30s 超时 vs 子代理分钟级）。
- **待办清零后新增**：无。剩余平台边界（PTY/Landlock/准点唤醒）为 Android 平台限制，如实标注。

## 13. 生成端点能力探测——方言运行时习得（2026-10-31，随 rc.170）

**核心思路**：不把厂商方言写死在代码里，把探测能力做进 harness 本体。端点的校验错误
就是说明书——探针发非法请求，从错误流学出 mode/size 契约，schema 动态生成。

- **GenProbe**（`kernel/GenProbe.kt`）：纯 JVM 学习器（VideoContractLearner）+ HTTP 驱动。
  探测请求带非法 size（PROBE_INVALID），永不误创建真实任务。agnes 实测：
  mode=[text, reference]、size=[720P]。
- **动态 schema**：video_generate / image_generate 的 mode/size 枚举从契约生成。
  探测后 ctx.refreshTools(kind) 重索引，模型即刻看到端点方言。
- **probe_gen_endpoint / probe_image_endpoint 工具**：agent 换厂商后自己探测。
- **自愈**：生成 400 → 重新探测 → refreshTools → 可行动错误带端点合法值。
- **收口**：agnes 端点探测 → 契约 [text, reference]/[720P] → video_generate 按正确
  mode=text 生成成功（设备实测）。不再需要「逐个枚举试错」。

## 14. 参考图 wire 通用化 + PPT 图片嵌入（2026-10-31，随 rc.172）

- **参考图 wire 契约化**：GenProbe 探测 json-base64 字段（images/image/image_url）vs multipart
  （input_reference）；契约存 imageWire/imageField；执行按契约；未探测时双形态都试。
  agnes 实测：mode=reference + images[base64] 全校验通过（返回 queue_full = 参数正确）。
- **PPT 图片嵌入**：write_pptx 支持 image + image_side（right/left/full），真 p:pic +
  media part + rels；缺图降级不阻断。JVM 测试 2 项 + 设备实测两页 media 齐全。
- **文本部分复制**：user-select: text + 长按放行正文区，系统原生选择接管。

## 15. 深研/子代理模型/PPT 转场（2026-10-31，随 rc.173）

- **web_search.fetch_top**：自动抓前 N（0–3）条正文合并，每页 6000 字上限、单页失败不中断；
  teammate 侧无 fetch 能力时降级为搜索清单。
- **子代理模型分档**：AgentConfig.subagentModel/Url/Key；优先级「成员显式 > 子代理档 > Lead」；
  三项空值等价旧行为（JVM 测试钉住）。
- **PPT transition**：fade/push/wipe/cover/none → `<p:transition>`；元素动画不做（timing 树成本高、
  产出物以阅读为主）。设备实测 fade 与 push 均正确落包，工具描述已告知模型。
