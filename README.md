# DSH Mobile

**装在口袋里的 DeepSeek Harness** —— Android 端 AI 助手客户端。本地独立可用，也能随时连上电脑接着聊。

> 本仓库为项目主文档（产品介绍 · 功能 · 开发构建 · 版本历史，四合一）。
> 安装包与宣传素材发布于 `../dsh-mobile-release/`（GitHub Releases），配套桌面插件为 `../dsh-mobile-link/`。
> **以后所有升级记录统一写在本文末尾的「版本历史」，不再单独维护 RELEASE-NOTES。**
> **所有项目文档统一收口在本文**：原 `docs/agent-team-desktop.md`（电脑端智能体团队机制解剖）与
> `docs/tool-quality-review.md`（工具质量六维评分）已全文并入[附录 A](#附录-a电脑端智能体团队机制解剖) / [附录 B](#附录-b工具质量六维评分与改进路径)；
> 今后深度专题一律作为章节或附录写入本文，与升级记录同例。
> **代码布局与模块边界见 [ARCHITECTURE.md](ARCHITECTURE.md)**（分层图、五个插件域、与桌面 packages/ 的对应表、可拆卸边界）。

## 目录

1. [来源与架构](#来源与架构)
2. [功能总览](#功能总览)
3. [陪伴式畅聊](#陪伴式畅聊内核插件-companion-v11)
4. [安装与系统要求](#安装与系统要求)
5. [连接电脑：Mobile Link 桌面插件](#连接电脑mobile-link-桌面插件)
6. [开发与构建](#开发与构建)
7. [隐私与安全](#隐私与安全)
8. [附录 A：电脑端智能体团队机制解剖](#附录-a电脑端智能体团队机制解剖)
9. [附录 B：工具质量六维评分与改进路径](#附录-b工具质量六维评分与改进路径)
10. [版本历史](#版本历史)
11. [组件版本](#组件版本)
12. [许可](#许可)
13. [Harness 对齐改进计划](docs/harness-plan.md)

## 来源与架构

DSH Mobile 是 **DeepSeek Harness（DSH）** 生态的 Android 客户端，与桌面端 DSH 同源同构：

- **同一套底层**：沿用 DSH 的会话引擎、流式协议、工具调用、任务与文件体系；
- **同一套交互范式**：桌面端打磨成熟的体验——流式思考、工具过程可视化、鲸尾思考动效、语音律动——在手机上逐一还原；
- **不是移植，是重建**：针对移动端重新设计导航、输入、通知与语音交互，是一个完整独立的 AI 应用。

本地独立模式开箱即用（会话数据只存手机，无账号、无服务器依赖）；与电脑配对后，它又成为桌面 DSH 的随身延伸。

原生壳 + Harness 会话 UI，采用 **Apple / iOS 26 Liquid Glass 设计语言**，
浮动面板优先由 **荣耀 MagicOS 通透引擎（uikit_hnvisual）** 渲染真实系统级玻璃：

```
┌─────────────────────────────────────────────┐
│  荣耀 MagicOS 原生层                          │
│    MainActivity (edge-to-edge)               │
│    ├─ HnVisualEffectLayout  ← 通透玻璃面板     │
│    ├─ GlassSheet            原生底部面板       │
│    └─ NativeBridge          触感/分享/宿主连接  │
│  ──────────────────────────────────────────  │
│  WebView 层（assets/web）                     │
│    Apple HIG 设计系统 + Harness 会话界面        │
│    会话 / 对话 / 任务 / 文件 / 设置             │
└─────────────────────────────────────────────┘
              │ http(s)
              ▼
   宿主机: npx @deepseek-ai/dsh web  (127.0.0.1:3080)
```

## 功能总览

### 对话引擎
- **全程流式输出**：思考过程、正文回复、工具调用三条流实时分开呈现，并显示思考耗时等细节
- **多会话管理**：创建、搜索、置顶、删除，会话数据完全本地
- **任意模型接入**：OpenAI 兼容 API，自定义地址 / 密钥 / 模型，多模型热切换
- **思考强度调节**：thinking effort 跟随模型能力逐档可调
- **图片发送**：对话中直接发图，配合多模态模型使用

### 交互细节
- 思考态**鲸尾 APNG 呼吸摆动**，与桌面端 RunningWhaleTail 同构
- 等待提示、思考秒数、工具调用折叠展开等微交互齐备
- 明暗双主题跟随系统，界面中英双语

### 语音
> 语音输出在 rc.84 – rc.91 之间反复换代（aishell3 → fanchen 四档 → theresa 四档 → 17 号双包 → 现状）。
> 历史版本条目按当时状态记录；**当前状态以本节为准**，被推翻的旧描述在各版本条目里用「※ 现状」标出。

- **两档音色（默认）**：**经典女**（系统 TTS 自带女声，原声不变调，默认档）· **经典男**（唯一内置模型）
  - 经典男：`vits-zh-hf-fanchen-C` sid 69，int8 量化单包 34MB（16000Hz，`assets/tts-neural/`）
  - 女声不再内置模型（rc.91 起）：省 33MB 安装包，代价是女声音质取决于设备引擎；男声保留模型，因为多数中文引擎没有男声可选
  - 纯中文走模型，英文成词/含假名表情的句子自动交系统引擎；选经典女时完全不加载模型
- **系统音色兜底**：枚举并使用设备自带的 TTS 音色，按性别偏好挑选（想要的女性别没有标注音色时也不会错挑男声）；任何一步失败都退回它（宁可系统腔，不能没声音）
- **音色调参面板**：倍速、音量、明亮度、句间停顿独立可调，轻弹动效反馈
- **语音律动**：一阶低通拆分「体声 / 气声」，近讲感与呼吸感自然（流式播放同一套系数）
- **首音优先**：合成回调直推 AudioTrack，边生成边播；重复句走 20MB LRU 缓存
- **不叠音**：连点「试听」只有最后一句在放（串行队列 + 朗读代次，旧的一句会被立刻掐断）

<details>
<summary>内置语音包：单包、来源、量化与选型</summary>

| 包 | 目录 | 模型 | 音色 | 采样率 |
|---|---|---|---|---|
| `fanchen` | `assets/tts-neural` | 32,602,257 字节 | 经典男（sid 69） | 16000Hz |

目录里还有 `lexicon.txt`（2.46MB）、`tokens.txt`、`phone/date/number.fst`，合计约 34MB。
**没有第二个包**：女声不内置模型（rc.91 起），用系统 TTS 自带的女声。

**为什么女声不内置**：曾内置过女声模型（theresa 的 17 号，rc.89–rc.90），但双包要多背 33MB，
而设备系统女声本来就可用。男声保留模型，是因为多数中文 TTS 引擎根本没有男声可选
（"选男声"长期等于拿女声压基频）。想再内置女声时按「新增音色」流程走即可（见下）。

**来源与边界（如实写）**：曾内置过的 `vits-zh-hf-theresa` 是已核实的角色音色合集（804 档）。
按角色名发布的 `eula` / `keqing` / `bronya` / `echo` / `doom` / `zenyatta` / `abyssinvoker`
与它是**同一份合集的不同导出** —— 文件字节数完全相同（121,913,906）、`n_speakers` 都是 804，
实测 F0 218–334Hz，**全部是女声**。所以「动漫男声」在开源 sherpa-onnx 中文 TTS 里不存在，
男声只能取自 `fanchen-C`（中文多音色，非角色集）。上游数据集未标注明确许可证，
本项目按个人使用内置，商用请自行确认授权。元信息统一在 `voice/VoicePack.kt`。

**为什么裁音色省不出体积**：说话人表只有 4KB（占 0.003%），122MB 全在声学网络
（189 个 Conv + decoder 的 ConvTranspose）。「只留 1 个音色」体积几乎不变；
真正压体积的是 **int8 静态 QDQ**（Conv 权重 8bit + 每通道 scale）：

| | 体积 | RTF（桌面 CPU 4 线程） | 与 fp32 的频谱距离 |
|---|---|---|---|
| fp32 | 122MB | 0.27x | — |
| int8 QDQ | **32.6MB** | **0.14x**（快 1.9 倍） | 0.57–0.60，落在「同模型跑两次」的噪声基线 0.58–0.64 内 |

量化后走 MLAS int8 kernel，所以**又快又小**（动态量化反而慢 13 倍：Conv 被量化后要插反量化节点，已弃用）。
一键复现：

```bash
python scripts/tts_quantize.py --model-dir <解包目录> --model-file xxx.onnx \
  --keep <sid> --out app/src/main/assets/tts-neural/model.onnx
```

**新增音色的流程**：模型不带 speaker 名称/性别，用 `scripts/tts_voice_probe.py` 对全部说话人
逐个合成同一句，量中位基频（带八度校正）+ 频谱重心 + 时长（语速）选候选，
再 `tts_quantize.py --keep <sid>` 重生成模型，改 `TtsVoiceTable` 一行 + `TtsAssets` 字节数。

```bash
pip install sherpa-onnx numpy
python scripts/tts_voice_probe.py --model-dir <解包目录> --model-file xxx.onnx --out .tmp/voices.json
```

**估基频必须做八度校正**：短句直接取自相关峰值会把女声算低一个八度（这也是之前误判
「theresa 里有 87–160Hz 男声」的原因）。

**防叠音怎么做的**（`voice/VoiceCenter.kt`）：
1. `speak` 走单线程队列，同一时刻只有一条朗读在跑；
2. 每次 `speak` 先 `hardStop()`（系统引擎 + 神经引擎都停），再入队；
3. 递增 `speakSeq`，排队中的旧任务发现序号变了直接退出；
4. `NeuralTts` 内部再维护一个 `gen` 代次，写音频循环发现代次变了立刻收手 ——
   光靠 `cancelled` 不行，因为每句 `speak` 开头会把它重置为 false，旧循环会被"复活"。

实测（模拟器）：连点 3 次 → 前两次 `cancelled=true`（0ms / 1ms 就退），只有最后一句完整播完；
播到 2.69s 时再点 → 旧句立刻停在 2.69s，新句完整播放。

**性能目标**（`adb logcat -s DSHTts` 有打点）：模型加载 300–800ms（仅首次，常驻，
`onTrimMemory` 时释放）；60 字首音 < 1.2s；整段 RTF < 0.35。
**存储**：模型进 APK（单包约 34MB，APK 约 127MB），运行时只有 ≤20MB 语音缓存，面板可一键清空；
`tts-neural/` 与 `voice-cache/` 均已排除云备份。
</details>


### 智能体团队（内核插件 agent-team，rc.95）
> 对应桌面 `packages/experimental/agent-team` + `tool-agent-team` 两个包，手机端**合并成一个插件**：
> 桌面拆包是为了让第三方工具适配包能复用领域服务；安卓插件本身就是「服务 + 工具 + 提示词 + 状态」，
> 再拆只会让插件列表出现两条「团队」、关掉一条还留半死状态。服务仍通过 `ctx.provide` 暴露，
> 别的插件可以消费 `team.runtime` / `team.roster` / `team.board`。
> 桌面三个包各自机制的完整解剖（触发 → 身份 → 工具 → 沟通 → 任务板 → 生命周期 → 持久化）见[附录 A](#附录-a电脑端智能体团队机制解剖)。

- **具名 teammate**：`spawn_teammate(name, description, prompt, context)`，名字小写 kebab、永久保留（创建失败也不复用）；
  `context=fresh` 不带 Lead 历史，`fork` 继承最近对话摘要。只有 Lead 能创建/中断
- **真并发，不是假并行**：独立有界池（默认 8，可配 1–8，与电脑端「子智能体并行上限」同一个数），每个成员有自己的 session id、消息历史与模型；
  旧实现是「借 Lead 当前轮的线程跑完整个子代理」，Lead 一轮结束队友就报「需要活跃轮次」
- **冷恢复**：成员 idle 后 `send_message` 会重建上下文继续跑；进程重启后从会话日志回放 roster 与任务板，
  **对账**决定每个成员的落点：创建到一半的成员会去读它自己的会话 —— 有首条任务就恢复成可唤醒的 inactive，
  没有就判 failed 并写明「进程在初始化阶段退出」，不再把创建失败伪装成空闲
  （桌面对账判据见[附录 A §7](#7-生命周期)）
- **共享任务板**：CAS（`expected_revision` 过期即拒）+ 依赖 DAG（禁止成环；还有活动任务依赖它时**拒绝删除**，
  不静默改别人的 blockedBy）+ `ready` 派生 + 写范围冲突提示 + tombstone（id 永不复用）+ 256 条活动上限
  （八种 action 的前置条件全表见[附录 A §6](#6-任务板机制)）
- **写租约（手机端比桌面更硬）**：桌面的 `writeScopes` 只是提示；这里在 teammate 执行写类工具前检查
  别人 in_progress 任务声明的范围，重叠直接拒绝并回 `TEAM_WRITE_CONFLICT` —— 两个队友不会同时改同一个文件
- **队友能回话**：`send_message(target="lead")` 落 Lead 日志（`team/message`），Lead 在下一步
  （`agent/pre-step` 钩子）或 `wait_agent` 的返回值里认领；队友互发时收件人能看到真实发送者，不再一律标成「Lead 补充」
- **提交语义**：状态类事件（成员快照、任务快照、首条任务）写盘成功才算提交，失败回 `TEAM_JOURNAL_FAILED`；
  进度类（每轮 lastAction）尽力而为 —— 磁盘抖一下不会掐死正在跑的成员，但工具也不会再假装成功
  （桌面的 appendAndFlush 对照见[附录 A §8](#8-持久化与投影)）
- **不设轮次 / token / 时长上限**：成员跑到模型自己停下，和主 Agent 的循环一致；每轮 `max_tokens` 仍是端点的硬约束。
  设置页只有「并行上限 + 最大递归深度」两个数 —— 电脑端也只有这两个；
- **递归委派**：`subagent` 按「主 Agent 第 0 层、子 = 父 + 1」传递深度，最大递归深度默认 1（只有主 Agent 能派），
  调到 2 起 teammate 也能再派一层；并行上限按同一主 Agent 下所有层级存活的子智能体合计，满了直接拒绝而不是排队。
  0 深度 = 关闭子智能体（连 schema 都不给）。普通子代理拿不到团队工具 —— 它不是 Team 成员
  （机制全貌与桌面对照见[附录 A §9](#9-子智能体委派深度与并行)）
- **团队与 subagent 互斥（rc.97 起）**：团队插件启用时，主 Agent 的 `subagent` / `subagent_fork` 从 schema 摘除
  （提示词段落随之消失），Lead 只用 spawn_teammate；底层 Subagent 服务仍供 teammate 递归使用 —— 与桌面同构
  （见[附录 A §11.2](#112-还没补的六条rc97-已全部补齐)）
  后台无人确认，危险操作直接拒绝并留诊断，不让整支团队挂在没人点的弹窗上
- **后台保活**：有成员在跑时起前台服务（`agent_team_keepalive`），切走 App 队友继续干活；
  通知栏显示「谁在跑 · 几个任务进行中」，全员 idle 即撤
- **团队面板**：会话顶栏团队按钮**常显**（没队友也能点开，面板显示当前只有 Lead 与空任务板）；有成员在跑时带绿点人数徽标。顶栏标题改为绝对定位居中，右侧按钮从 1 个变 2 个也不会把标题推偏
  面板列出成员（状态/轮次/工具数/token/当前动作）、任务板（可认领/写冲突/依赖）、预算；点成员可看**它自己的对话**，running 时可从面板叫停
- **多团队并存（rc.97 起）**：每个顶层会话一支团队（TeamId=SessionId，与桌面同构），roster / 任务板 / 收件箱
  全 per-session 分桶 —— A 团队在后台跑，B 会话照常建自己的团队，成员线程的调用落回自己的团队不会串台
  （rc.95 的「只跑一个团队 / TEAM_BUSY」是单份运行时的取舍，rc.97 拆 scope 后已移除，见[附录 A §10](#有意偏离不是缺口是取舍)）
- `wait_agent` 等「调用之后的下一次团队变化」，没有活跃同伴立即 `noProgress`；插件卸载会唤醒所有等待者
  （返回 `disposed`），不会让人白等到超时 —— 不再 200ms 轮询
  （桌面的 TeamActivity waiter 机制见[附录 A §4.3](#43-观察与等待)）

### 任务与文件
- **后台任务**：发起后可离开对话页，完成推送通知
- **文件系统**：按应用组织的附件与产出浏览
- **运行通知中心**：连接、任务、运行状态集中管理

### 连接电脑（可选扩展）
- 与桌面端 DSH 配对：手机接续电脑会话，上下文无缝衔接
- 切换电脑端模型与思考强度，查看电脑端文件与任务
- 中继三步配对（地址 / 房间号 / 口令），多设备管理、心跳在线状态、分步连接诊断
- 同一局域网直连；跨网可自备公网中继

## 陪伴式畅聊（内核插件 companion v1.1）

让 Agent 从「有问必答」变成「会主动搭话的人」。设计分三层，各管一段：

| 层 | 职责 |
|---|---|
| Kotlin 插件（CompanionPlugin + CompanionKeepService） | 什么时候**可以**开口 —— 心跳、免打扰时段、每日上限、待跟进线索、后台保活 |
| 前端（Companion 对象） | 什么时候**适合**开口 —— 正在对话中、上一句没说完、额度用完 |
| 模型 | 到底说什么 —— 人设 + 最近对话 + 线索决定，没话说回 `SILENT` |

### 主动触发性（v1.1 重点）

- **前台服务保活**：陪伴开启即驻留一条 IMPORTANCE_MIN 静默通知（收进「静默」折叠区），
  进程获得 foreground 优先级，后台/锁屏期间心跳照常到点；关掉开关即撤。
- **Doze 兜底闹钟**：allow-idle 闹钟每 10 分钟叫插件看一眼表，
  深睡期间 Handler 醒不过来的空档由它补上（陪伴窗口最小 10 分钟，粒度足够）。
- **后台开口**：心跳到点时应用在后台也照样生成、落库，并通过系统通知送达
  （原生侧判断「在不在这个会话」，正看着就不打扰）。
- **恢复补拍**：被系统强杀后回到应用，`visibilitychange` 会按过期的 `nextDueAt` 自动补一次。
- 保活状态在插件 status 与设置面板「运行状态」里可见；电池优化未加白时面板会给提醒。

### 节奏与纪律

- 档位（区间随机抽窗口，不是整点推送）：安静 60–120 分钟 / 适中 25–55 / 话多 10–30，
  每日上限 12 / 24 / 48；免打扰时段（默认 23:00–08:00）静默。
- 「有话才说」：靠 `companion_followup` 工具记线索（面试、体检、deadline、情绪），
  心跳带进上下文；没有真实由头模型回 `SILENT`，前端吞掉不显示。
- 对话里可以直接说「少说两句 / 晚上别找我 / 关掉陪伴」，`companion_control` 会真的改配置。

### 语音闭环（v1.1 新增）

- 它开口即出声：陪伴消息合成语音后**自动播放**（WebView 已关闭自动播放手势限制），
  人没看着屏幕也能听见；语音条可重播。
- **语音回聊**（设置面板可开关，默认关）：它说完一句、音频自然播完后自动接麦，
  识别结果自动发送，回复照常流式输出并朗读 —— 全程不用碰屏幕。
  手动暂停/切换/取消/识别出错都不会替用户发出任何消息。
- 前置条件：语音输入插件 + 语音输出均已开启；面板开关会校验并提示。

### 诊断

设置面板「运行状态」直接显示：下次窗口、上次心跳、上次开口、上次跳过原因
（例如「模型不可用」「免打扰时段」）、后台保活是否驻留 —— 「到底跑没跑、为什么没说」一眼可见。

## 安装与系统要求

- Android 8.0（API 26）及以上
- 前往 Releases 下载最新 `DSH-Mobile-x.x.x-release.apk`，允许「安装未知来源应用」后安装
- 打开 App，设置中配置模型 API 与密钥即可开始对话
- （可选）设置 → 连接电脑，填桌面端面板三项完成配对

## 连接电脑：Mobile Link 桌面插件

「连接电脑」由配套桌面插件 **`dsh-mobile-link`** 提供（完整文档见 `../dsh-mobile-link/README.md`，
分发副本在 `../dsh-mobile-release/desktop-plugin/`）：

1. 桌面端安装插件，侧边栏 →「手机联动」→ 启动联动，面板显示**中继地址 / 房间号 / 中继口令**三行；
2. 手机「设置 → 连接宿主机」把三行粘进去 → 连接；
3. 手机读的是电脑上**真实会话**（同一 session），发出的消息进入桌面端 agent 收件箱；
4. 同一局域网开箱即用（桌面端自起中继）；跨网络可自部署公网中继（Docker / Caddy，见插件文档）。

配对持久：重启两端都不用重新配对；面板可「移除」单台手机或「重置配对」换密钥。

DSH CLI 安装（支持 GitHub 直装）：

```bash
dsh plugin --profile <profile名> add "github:xiaobaga281/dsh-mobile#path:desktop-plugin"
```

## 开发与构建

工具链（都装在 `D:/1/tools`，不污染系统）：

| 组件 | 路径 | 说明 |
|---|---|---|
| Android SDK | `D:/1/tools/android-sdk` | platform-35 / build-tools 35.0.0 / platform-tools 37.0.1 |
| Gradle | `D:/1/tools/gradle-8.9` | 工程同时带 wrapper，distributionUrl 指向腾讯镜像 |
| JDK | `C:/Program Files/Java/jdk-17` | Gradle 用 17 |

```bash
# 命令行构建（无需 IDE）
./gradlew assembleDebug    # 产物：app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease  # 产物：app/build/outputs/apk/release/app-release.apk
# 发布副本：DSH-Mobile-0.2.1-rc.98-release.apk（仓库根目录 + ../dsh-mobile-release/）

# 安装到手机（开启 USB 调试）
"D:/1/tools/android-sdk/platform-tools/adb.exe" install -r DSH-Mobile-0.2.1-rc.98-release.apk
```

> `local.properties` 已指向 `D:/1/tools/android-sdk`；换机器时改这一行即可。
> 首次构建如遇网络问题，`settings.gradle.kts` 已优先使用阿里云 Maven 镜像。

### 目录

```
dsh-mobile/
├─ app/src/main/
│  ├─ assets/web/          # 移动端 Agent UI（HTML/CSS/JS，无外部依赖）
│  ├─ java/ai/deepseek/harness/mobile/
│  │  ├─ MainActivity.kt   # edge-to-edge WebView 容器 + 返回栈
│  │  ├─ bridge/NativeBridge.kt  # JS ↔ 原生（触感、分享、宿主、通透面板）
│  │  ├─ bridge/LinkBridge.kt    # 中继传输（幂等键、重试）
│  │  ├─ glass/HonorGlass.kt     # 荣耀 HnVisualEffectLayout 反射适配
│  │  │     glass/GlassSheet.kt  # 原生玻璃底部面板
│  │  └─ kernel/plugin/builtin/  # 内核插件（companion 等）
│  └─ res/                 # 主题、图标、网络安全配置
├─ preview/                # 与真机一致的浏览器预览（可直接打开 index.html）
├─ scripts/sync-web.mjs    # assets/web → preview 同步
└─ gradle/                 # AGP 8.7.3 / Kotlin 2.0.21
```

### 模拟器调试

- AVD：`dsh`（Pixel 6 / 1080×2400 / API 35），启动：
  `D:/1/tools/android-sdk/emulator/emulator.exe -avd dsh -gpu auto`
- 模拟器访问宿主机回环地址用 `http://10.0.2.2:8787`
- 非荣耀设备上会自动降级：设置页显示「不受支持 · 非荣耀设备，已回退半透明」，
  原生面板用不透明回退，不会出现“面板透明、文字叠在对话上”。
- WebView 调试：`adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`。

APK 实测信息：`ai.deepseek.harness.mobile` · minSdk 26 / target 35。
versionName/versionCode、权限集合、APK 大小与 sha256 以 [`docs/facts.json`](docs/facts.json) 为准 —— 该文件由 `scripts/gen-facts.mjs` 从构建产物生成，`scripts/verify-facts.mjs` 在 CI 中校验；**不再手写权限清单**（此前手写的那份与真实清单不符，已删除）。

### 荣耀通透能力接入（已接入官方 aar）

API 来自荣耀开发者平台 `uikit_hnvisual`（文档解压于 `../honor-uikit`）。
`app/libs/hnvisualeffect-11.0.0.134.aar`（773 KB，Translucent Component Kit 11.0.0.134）已放入工程，
`app/build.gradle.kts` 通过 `fileTree("libs") { include("*.aar") }` 自动参与编译。
放置 aar 即用：重新构建后，设置页「荣耀通透引擎」显示「已接入」，`⋯ → 原生通透面板` 由真机玻璃渲染。

已按 aar 的**真实字节码**核对过（`javap`），不是按文档猜的：

| 项 | 实际签名 |
|---|---|
| 容器 | `com.hihonor.uikit.transparency.api.HnVisualEffectLayout extends FrameLayout` |
| 效果 | `HnGlassEffect extends HnVisualEffect`，`setWidgetSize(HnWidgetSize)` / `setSceneType(HnSceneType)` / `setInteractive(boolean)` / `setTransparencyLevel(float)` |
| 枚举 | `HnWidgetSize.BIG/SMALL`、`HnSceneType.IMMERSIVE/GENERAL`、`HnMaterialType.LIQUID_GLASS/FROSTED_GLASS` |
| 跨窗 | `com.hihonor.uikit.transparency.window.WindowBlurManager.setWindowBlur(int, View...)` |
| 裁剪 | `HnVisualEffectLayout.setCornerRadiusWithClipChildren(float, boolean)` |
| 档位 | `TransparencyFeatureConfig.getTransparentMaterialLevel(Context)` / `getCurrentTransparentMaterial(Context)` |

关键约束（已按官方文档落实）：

| 约束 | 本工程做法 |
|---|---|
| `HnVisualEffectLayout` 不解析任何 `app:hnXxx` XML 属性 | 全部参数走 `HonorGlass.applyGlass()` 的代码调用 |
| 圆角单位是 px | `GlassSheet` 用 `dp(27)` 转 px 后 `setRadius()` |
| 显式 `setMaterialType()` 会关闭「跟随系统材质」 | 不设置，保持 `setFollowSystemSettings(true)` |
| 子 View 背景必须透明，否则遮挡模糊 | 面板内容全部透明背景 |
| 通栏贴边会削弱玻璃质感 | 面板四周留 8dp 外边距、27dp 圆角，形成悬浮层 |
| 大面板用 BIG + GENERAL、开启交互动效 | `HnWidgetSize.BIG` / `HnSceneType.GENERAL` / `setInteractive(true)` |

因此 `GlassSheet` 里做了三件关键的事：

1. `setVisualEffect()` 在 attach 之前调用（文档的编译期排查项）；
2. `dialog.show()` 后立刻 `WindowBlurManager.setWindowBlur(1, decorView)`——**弹窗是独立 window，
   不声明跨窗取景就取不到 Activity 画面，模糊会变黑**；
3. `setCornerRadiusWithClipChildren(27dp, true)`，子 View 一起按圆角裁剪。

未放置 aar 时：`HonorGlass.isAvailable()` 返回 false，面板回退为半透明圆角 + 描边，**不会崩溃**。
WebView 内的悬浮导航条、输入框则始终使用 CSS `backdrop-filter` 玻璃，保证跨机型一致。

### 底部安全区

悬浮 Tabbar 不再用 `env(safe-area-inset-bottom)`（Android WebView 恒为 0），改由原生把
`WindowInsets.systemBars().bottom` 写入 `--safe-bottom`，并在页面加载完成、`onResume`、
`onConfigurationChanged` 时重新同步；同时按 `navigation_mode` 兜底：

| 导航方式 | safe-bottom | Tabbar 距屏幕底部 |
|---|---|---|
| 手势导航 | 24px | 32px（在手势条上方） |
| 三键导航 | 48px | 56px（在按键上方 8px） |

### 设计规范（Apple HIG 映射）

| Token | 值 | 用途 |
|---|---|---|
| 背景 | `#F2F2F7` / `#000000` | iOS 分组背景 |
| 卡片 | `#FFFFFF` / `#1C1C1E` | 分组列表、工具卡 |
| 强调色 | `#007AFF` / `#0A84FF` | 链接、发送、选中 |
| 标题 | 34px / 800 / -0.9px | Large Title |
| 正文 | 16px / 1.55 | 消息气泡、段落 |
| 圆角 | 28 / 22 / 16 | Sheet / 卡片 / 行 |
| 玻璃 | `blur(28px) saturate(180%)` + 0.5px 高光描边 | Tabbar、Composer、Sheet |
| 动效 | `cubic-bezier(.32,.72,0,1)` 0.3–0.44s | iOS 弹性曲线 |

### 账号

设置页顶部是账号卡，对应 harness 的 `ui-settings-account` / `credentials-deepseek-account`：

| 状态 | 表现 |
|---|---|
| 未登录 | 卡片显示「未登录 · 登录后使用 DeepSeek 模型与额度」，右侧「登录」 |
| 登录方式 | 「使用 DeepSeek 账号登录」打开系统浏览器授权；「使用 API Key」直接在本机完成登录 |
| 已登录 | 卡片显示脱敏凭据（`sk-••••abcd · 仅本机`）与「管理」 |
| 管理页 | 「查看用量与充值」跳转 Platform；「退出登录」二次确认，并提示会中断使用该账号的托管任务 |

凭据写入本机 `localStorage.dsh.account`，不上传服务器。

## 隐私与安全

- 无遥测、无统计 SDK、不收集任何数据
- 会话数据默认只存本机
- 安装包按「现状」提供

## 附录 A：电脑端智能体团队机制解剖

> 桌面 DSH `packages/experimental/` 下三个包的机制解剖（对象与拆法见下）。
> 本附录是团队机制细节的唯一权威 —— 「功能总览 → 智能体团队」只放用户向结论层，细节以此处为准；
> §10 是手机端对照（含「有意偏离」取舍清单），§11 是 rc.96 第二轮通读记录（「还没补的六条」已在 rc.97 全部补齐，见版本历史 rc.97 条目）。

> 对象：`D:/1/dsh/deepseek-harness-dsh-v0.2.1-rc.2/packages/experimental/` 下的
> `agent-team`（领域服务）、`tool-agent-team`（工具面）、`client-ui-agent-team`（对话头入口）。
> 本文按「触发 → 身份 → 工具 → 沟通 → 任务板 → 生命周期 → 持久化」拆，最后附手机端对照。


### 1. 分层：三个包，各管一段

| 包 | 角色 | 关键文件 |
|---|---|---|
| `agent-team` | 领域服务，注册 `ctx.agentTeams` | `roster.ts` / `task-board.ts` / `journal.ts` / `lifecycle.ts` / `activity.ts` / `projection.ts` |
| `tool-agent-team` | 模型可见的九个工具 + 团队 policy | `src/index.ts`（432 行，全部在这里） |
| `client-ui-agent-team` | 会话头部「智能体团队」按钮与面板 | `TeamAction.tsx` |

依赖关系是单向的：工具层只调 `ctx.agentTeams.*`，不自己判权限、不自己写状态；UI 只读 Session 投影，不写。


### 2. 怎么触发

#### 2.1 装配触发：按 Agent 作用域安装，不是全局工具

`tool-agent-team/src/index.ts:411` 的 `apply()`：

1. 遍历当前所有 live Agent，对每个能解析出 **Team 成员关系** 的 Agent 调 `maybeInstall`
2. 订阅 `agent/created`，新 Agent 出生时同样尝试安装
3. `agent/disposed` 时执行该 scope 的 disposer，逆序撤销注册

`maybeInstall` 的条件是 `ctx.agentTeams.tryMembership(agent) !== undefined`。而 `tryMembership` 对**普通 root session 也会返回 lead**（`roster.ts:104`），所以：

- 任何顶层会话都是「隐式 Team 的 Lead」，`TeamId = SessionId`（`types.ts:8`）
- 每个 teammate 子会话是同一个 Team 的 member
- **九个工具只出现在 Team 成员的 scope 里**，不是全局工具目录；普通 provider-owned subagent 因为带 `subagent-descriptor` 会被排除，不会拿到 Team 身份（`roster.ts:103`）

#### 2.2 模型侧触发：policy + identity + schema

安装时往 system prompt 注入两段（`tool-agent-team/src/index.ts:173-190`）：

- **`team:policy`**（固定文本）：共享 cwd、写范围要分开、任务依赖、`send_message` 的 steer 语义、`inactive` 不等于任务完成、`wait_agent` 的用法、Lead 必须在收尾前等队友
- **`team:identity`**（运行时上下文，required）：`You are the Team Lead named "lead".` 或 `You are teammate "<name>". Your Team Lead is named "lead".`

九个工具 schema 同时注册进该 scope。

**关键观察：桌面的 policy 没有写「什么时候该组队」。** 它只说 "Agent Teams is available in this session"，触发完全依赖用户明说或模型自觉。手机端我在 policy 里补了三条主动触发条件（可拆两条线 / 产出与审查分离 / >8 轮且有并行调研）和一条反向约束，这点手机端比桌面更主动。

#### 2.3 用户侧触发：会话头部按钮

`TeamAction.tsx` 挂在 `conversation.session.header.actions`，按钮文案 `智能体团队 / Agent Team`（`locales.ts:8`）。点开是一个锚定面板：

- **成员区**：Lead + 每个 teammate，显示状态点（running/provisioning 为进行中、failed 为红）、模型；点一行可以「打开成员会话」（`openTeammate`），直接跳进那个 teammate 的对话
- **共享任务区**：任务卡显示 owner（未分配显示「未分配」）、依赖、写入范围、`可开始 / 被依赖阻塞`
- 空态文案：`暂无共享任务，可以通过对话创建`

也就是说桌面有两条路：**对话里让模型组队**，和**面板里看/进成员会话**；面板本身不提供「新建队友」按钮，创建只能走模型工具。


### 3. 身份与权限

`roster.ts` 的 `membership(agent)` / `tryMembership(agent)` 是权限的唯一来源：

- 输入是**调用者这个活 Agent**，不是工具参数里的名字
- 判定路径：`agent.session.header.parentSession` → 找到 root → 在 root 的 Team 日志里按 id 找成员记录
- 找到且 `phase ∈ {active, provisioning}` → `teammate`，name 来自记录
- 找不到且自己不是 provider subagent → 自己就是隐式的 `lead`
- 每个写操作都重新解析一次；`spawn`/`interrupt`/`reassign` 检查 `role === 'lead'`

这套设计的价值：**teammate 即使拿到了管理工具的 schema，执行时也会被领域层拒绝**（`TEAM_LEAD_REQUIRED`），不是靠「不给你 schema」这种软约束。


### 4. 九个工具

工具层声明了每个工具的**完整输出 schema**，渲染成紧凑 JSON（不缩进），编译期就能对照 `execute` 的返回值。

#### 4.1 创建

**`spawn_teammate(name, description, prompt, context)`** — 仅 Lead

| 参数 | 约束 |
|---|---|
| `name` | lower-kebab，≤64 字符，不能是 `lead`，本 Team 内永不复用（失败的名字也占着） |
| `description` | 非空，≤200 |
| `prompt` | 完整初始任务（ContentBlock[]） |
| `context` | `fresh`（不带 Lead 历史）/ `fork`（继承已完成轮次前缀），默认 fresh |

返回 `{member: {target, role, status, description, provider, context, model, diagnostics}}`。

#### 4.2 通信

**`send_message(target, message)`**

- `target` 可以是 `lead` 或任意 teammate 的 target
- 返回 `{sent: true}`，**不暴露 messageId**（服务层有，工具层丢掉）
- 成功只表示「进了对方 inbox」，不代表处理、不代表落盘同步完成
- 给自己发 → `TEAM_SELF_MESSAGE`

#### 4.3 观察与等待

**`list_agents()`** — 返回数组，每行 `target / role / status / description / provider / context / model / diagnostics`

- `status`：`running`、`inactive`（没有轮次在跑，含已加载与仅存储）、`provisioning`、`failed`
- `failed` 的 diagnostics 里有错误原因

**`wait_agent(timeout_ms)`** — 默认 30000，范围 10000–3600000

- 工具层先做一次 `listMembers`：**没有别的成员在 running/provisioning 时立即返回 `noProgress`**，不进入等待（`tool-agent-team/src/index.ts:269`）
- 否则等「调用之后」的下一次团队变化：成员状态、消息接收、任务更新任一
- 只返回 `{timedOut}`，不返回变化内容；调用方醒来后自己重新 list
- 超时值非法（非整数/越界）直接抛 `TEAM_INVALID_TIMEOUT`，不 clamp

**`interrupt_agent(target)`** — 仅 Lead

- 通过 `ctx.subagents.interrupt(id, {kind:'ancestor', agent: caller})` 停当前轮次
- **保留 pending inbox**，任务 owner 不变
- 返回 `{previousStatus: 'running' | 'inactive'}`（中断前采样）

#### 4.4 任务板（四个）

| 工具 | 要点 |
|---|---|
| `team_task_create(subject, description, blocked_by?, write_scopes?)` | 只能建**无主 pending** 任务；subject ≤200、description ≤16384 |
| `team_task_list(status?, owner?, ready?, cursor?, limit?)` | `owner=unowned` 过滤无主；`ready` 过滤可开始；游标 0 基，limit 1–100 |
| `team_task_get(task_id)` | 读完整最新值；**改之前必须先读，拿 revision** |
| `team_task_update(task_id, expected_revision, action, ...)` | CAS；action 八种，见下 |

`team_task_update` 的 action：`claim / release / edit / set_dependencies / complete / reopen / reassign / delete`。


### 5. 怎么沟通

#### 5.1 通道：目标 Agent 自己的 inbox

`sendMessage`（`agent-team/src/index.ts:224`）不维护 Team 级消息队列，而是把内容投进目标 Agent 的 inbox：

- 目标是 **Lead**：`root.steer(createUserMessage({content, source}))`
- 目标是 **teammate**：`steerHostSubagentPrompt(ctx.subagents, root, target.id, content, source, signal)`
  - 对 **running** 的目标：在最近的 step 边界交付（steer）
  - 对 **inactive** 的目标：冷恢复一轮再交付

#### 5.2 消息形状

- 首个内容块固定是 `Team message from <senderName>:`
- `source` = `{kind:'agent-message', form:'relay', senderSessionId: caller.id}`
  - 目标会话记录的是真实发送者，不是「Lead 转发」，sibling 之间不能伪装成 Lead
- 整条（含前缀）按 UTF-8 字节限 64KB（`maxMessageBytes`）
- 拒绝自发；不重试、不去重、不保证跨目标顺序

#### 5.3 语义边界（policy 里明说的）

- `inactive` 只表示没有轮次在跑，不代表任务完成/成功/失败
- `send_message` 成功 ≠ 对方已处理
- `wait_agent` 只观察调用之后的变化，且不会唤醒 inactive 成员
- Lead 在给最终答案前必须等必要队友
- 每个 peer 消息在目标历史里以「发送者名字」开头，身份由 runtime context 维持


### 6. 任务板机制

#### 6.1 身份与序号

- id 形如 `task-<n>`，n 来自投影里的 `nextTaskNumber`，只增不减
- 数字后缀必须是安全整数；空间耗尽报 `TEAM_TASK_LIMIT`，**不复用最后一个 id**
- 删除是 tombstone：留在状态里供回放，不出现在 list，不占 `maxTasks`

#### 6.2 CAS 与状态机（严格）

每次变更加 `expectedRevision`，不等就 `TEAM_TASK_STALE_REVISION`。各 action 的前置条件：

| action | 前置 | 结果 |
|---|---|---|
| `claim` | status=pending 且 ready；未被别人持有 | in_progress，owner=caller |
| `release` | status=in_progress；owner 或 Lead | pending，清 owner |
| `edit` | owner 或 Lead；至少给一个字段 | 改 subject/description/writeScopes |
| `set_dependencies` | owner 或 Lead；依赖存在、不重复、不自依赖、不成环 | 替换 blockedBy |
| `complete` | status=in_progress；owner 或 Lead | completed |
| `reopen` | status=completed；owner 或 Lead | pending，清 owner |
| `reassign` | 仅 Lead；status=pending/in_progress；owner 为空则回 pending；否则必须 ready 且 owner 是 active 成员 | in_progress + 新 owner |
| `delete` | owner 或 Lead；**没有任何活动任务依赖它** | deleted（有依赖则 `TEAM_TASK_HAS_DEPENDENTS`） |

#### 6.3 ready 与写入范围

- `ready = status == pending && 所有 blockedBy 都 completed`
- `writeScopes` 规范化（`validation.ts:26`）：反斜杠转正斜杠、去 `./` 前缀、去尾斜杠；**拒绝空串、绝对路径、盘符、`.`、`..`、空段**
- 重叠判定：互为前缀即重叠（`left === right || left.startsWith(right+'/') || ...`）
- `writeScopeWarnings` 只对比**其他 in_progress 任务**，文案 `write scopes overlap with task-N`
- 明确写进 policy：写入范围是 advisory，不是锁

#### 6.4 图校验

每次 create/update 后都对**整张活动任务图**重跑校验（`task-graph.ts`）：自依赖、重复依赖、缺失/已删除依赖、环。不是只检查新加的那条边。


### 7. 生命周期

#### 7.1 spawn 是一个五步事务

1. 事务内：查重名、查 `maxMembers`、append `team/member`（phase=provisioning）并 **flush**
2. `subagents.startActivation({childId, provider, prompt, parent})` 起一个 continuable child
3. `checkpointInitialPrompt`：等 child 自己的 session 里真的出现这条初始消息（history 或 inbox 任一处），**否则不算创建成功**
4. 事务内把 phase 改 active（settleProvisioning）
5. 失败路径：settle failed + 停掉 child；如果此时 recovery 已经把它判成 active → `TEAM_PROVISIONING_CONFLICT`（不允许「创建者说失败、孩子其实活了」）

#### 7.2 重启对账（reconcileProvisioning）

`agent/created` 后用 `queueMicrotask` 异步对账所有 `provisioning` 成员：

- 如果这个 child 在本进程里活着 → 跳过（创建者会给出终态）
- 否则读它**独立持久化的 child session**，同时满足才判 active：
  - `header.parentSession === root.id`
  - subagent descriptor 的 `mode === 'continuable'` 且 `provider` 匹配
  - 初始 prompt 已被接受（`messageAccepted`）
- 任何一条不满足 → failed，并把原因写进成员记录

这解决的是「进程在 spawn 中途被杀」：成员不会既显示 provisioning 又永远没人管。

#### 7.3 等待

`TeamActivity` 是**每个 Team 一组 waiter**，不是全局版本号：

- 一次性：超时、中止、被通知，先到先算，其余移除
- 超时范围 10s–1h，非法直接报错
- `close()` 时唤醒所有 waiter（dispose 不会让 `wait_agent` 悬挂到超时）
- 事件提交（journal 的 `onCommit`）和 Agent 状态变化都会 `notify`

#### 7.4 dispose 是有界结算

`TeamRuntimeLifecycle`：

1. `close()`：abort 一个 `TEAM_DISPOSED` 的 signal，之后新 spawn/send 一律拒绝
2. `activity.close()`：唤醒所有等待者
3. `settle(pending(), failures)`：等所有已准入操作结束，超时 `disposalTimeoutMs`（默认 5s），把非取消异常收集起来
4. `liveChildrenByRoot()` → 对每个 Lead `drainChildren`（各自 5s 超时）
5. 有失败就抛 `AggregateError`，不静默


### 8. 持久化与投影

- 两类事件写进 **Lead 的 session**：`team/member`、`team/task`（`version: 2`，整值快照）
- append 后必须 `sessions.flush`，成功才 `onCommit`；**Team 事件不进对话表面**（append 时移除了 surface 参数）
- 客户端读的是 `agentTeam` Session 投影：`{members, tasks, failure}`；`failure` 表示持久记录里出现了第一条坏记录，此时 members/tasks 停在最后一个有效状态
- 成员状态 = 持久 `phase` + 该成员会话的 live `running` 叠加（`TeamAction.tsx:84`），所以「active 但没在跑」显示 inactive、「active 且正在跑」显示 running
- 历史 mailbox 事件（`team/message/queued` / `delivered`）仍可读，但新发送不再写这两种记录


### 9. 子智能体委派：深度与并行

桌面把这套限制放在「设置 → 子智能体 → 运行限制」，整页只有两个数字（外加模型选择）：
**最大递归深度**、**子智能体并行数量上限**。

#### 9.1 最大递归深度 `maxDepth`

- 深度**从 0 数**：主 Agent 是 0，子 = 父 + 1（`depth.ts:delegationDepthOf`）
- 持久化值是权威的：重启后续跑的 child 会带着全新的 options 回来，深度取
  `max(header.delegationDepth, options.subagentDepth)` —— 只准加深，不准归零
- 语义：`0` = 禁用子智能体；`1` = 只有主 Agent 能创建（**默认值**）；`N` = 允许 N 层
- 某个工具若自带上限，以工具为准（文案 `subagentDepthOverride`）

#### 9.2 并行上限 `maxActiveSubagents`

- 默认 **8**；口径是「同一个主 Agent 下所有层级**存活**子智能体合计」，主 Agent 不计入
- 到达上限时**拒绝**新的启动请求，不排队 —— 排队会让「父占着槽等子、子永远等不到槽」变成死锁

#### 9.3 桌面怎么让"深度"生效

桌面不在安装工具时按深度裁剪：每个 Agent scope 都装同一套工具，执行时由
`resolveChildDepth(parent, request.maxDepth)` 裁决。所以深度是由**运行时**兜底的，
工具 schema 一直都在。

#### 9.4 手机端实现

| 桌面 | 手机端 |
|---|---|
| `delegationDepthOf(agent)` | `AgentConfig.delegationDepth`（主 0、teammate 1、子 = 父 + 1） |
| `SubagentManager` 的容量池 | `kernel/agents/SubagentCapacity`（按 root 会话分桶，`tryAcquire` 满即拒） |
| 设置页 `maxDepth` / `maxActiveSubagents` | `SubagentLimits`，值存内核，编辑入口在团队设置页 |
| `runSubagent`（driver 内） | `agent/SubagentRunner`（主 Agent 与 teammate 共用） |

手机端比桌面多一步：**先在 schema 层摘工具**（`depth >= maxDepth` 时不给 `subagent`），
执行器里再兜一道硬检查。摘 schema 是为了省 token —— 一个 `subagent` 的定义约 200 token，
在 8k 窗口的本地模型上是实打实的开销；桌面的模型窗口大，不需要这个优化。

一处**有意差异**：桌面只有一个容量池，teammate 与普通子代理一起算。手机端把
「并行上限」同时用作成员池大小与子代理容量，但**两池独立计数** —— 因为 teammate 是长驻的，
塞进同一个池会出现「池被子代理占满 → 成员起不来 → 它的任务永远卡住」。代价是极端情况下
成员与子代理各跑满 8 个，实际使用中由「并行上限」这个同一个数间接约束。

### 10. 手机端对照

> 2026-10-24 第二轮通读后重写。上一版把「队友给 Lead 发消息」和「跨会话串台」漏了，
> 这两条都会让协作链**静默断掉**，比状态显示不准严重得多。

#### 已对齐

九个工具的参数与语义、CAS、DAG、ready 派生、写范围重叠、tombstone、名字永久保留、Lead-only 创建/中断、inbox steer、`wait_agent` 一次性语义、`maxMembers` / `maxTasks` 上限、事件落 Lead 会话可回放。

本轮补上的六条（都对应桌面的具体实现，不是「看起来像」）：

| # | 桌面机制 | 手机端实现 |
|---|---|---|
| 1 | `spawn` 第三步 `checkpointInitialPrompt`：首条 prompt 必须在子会话持久接受 | `spawn` 在返回前严格写成员会话的 `user/message`；写失败即 `roster.fail` + 抛错，不留下「没任务的成员」 |
| 2 | `reconcileProvisioning`：读子会话判定 active/failed | `TeamRoster.reconcile`：provisioning 成员若成员会话有首条任务 → inactive（可唤醒）；没有 → failed 并写明「进程在初始化阶段退出」；running → inactive |
| 3 | `appendAndFlush`：落盘成功才发布 | 状态类事件走 `appendOrThrow`，失败抛 `TEAM_JOURNAL_FAILED`；进度类（每轮 lastAction）尽力而为，避免磁盘抖动掐死成员 |
| 4 | `TeamRuntimeLifecycle`：准入截止 + 有界结算 | `disposed` 闸门（spawn/send 拒绝 `TEAM_DISPOSED`）+ 取消 + 守护线程 5s 结算 + 异常汇总 |
| 5 | `TeamActivity.close()`：唤醒全部 waiter | `waitForChange` 返回 `CLOSED`，`shutdown` 里 `notifyAll` |
| 6 | `sendMessage` 支持任意成员互发（含 Lead） | `TeamCall` 线程局部身份；`target=lead` 落 Lead 日志 + 收件箱，由 `agent/pre-step` 或 `wait_agent` 认领 |
| 7 | `maxDepth` / `maxActiveSubagents`（子智能体设置页的两个数） | `SubagentLimits` + `SubagentCapacity` + `SubagentRunner`：深度逐层 +1、容量满即拒；teammate 在深度 ≥2 时可再派一层 |

#### 手机端更硬

- **写租约是真锁**：桌面明确写 scope 只是 advisory；手机端在 teammate 执行写类工具前查租约，冲突直接 `TEAM_WRITE_CONFLICT`
- **没有额外预算**：成员跑到模型自己停下为止，与主 Agent 的循环一致
  （※ 轮次 / token / 单次时长曾在 rc.94–95 加过，rc.96 全部删除 —— 桌面一个都没有，轮次与每轮 `max_tokens` 已封顶）
- **后台保活**：`TeamKeepService` 前台服务，切走 App 队友继续跑；桌面没有这个概念
- **后台危险操作直接拒绝**：没人能点确认，所以 teammate 的 bash 删除类操作会被拒并留诊断
- **限额可在设置页热改**：桌面写配置文件；手机端把「并行上限 / 最大递归深度」两个数放在设置页，拖动即生效 —— 与桌面完全同构
- **主动触发条件写进了 policy**：桌面只写「可用」，没写「何时用」
- **写日志按会话串行**：桌面有 per-Lead 事务队列；手机端 `SessionStore` 按 sessionId 加锁，AgentDriver 与团队写同一文件不会交错出半行

#### 有意偏离（不是缺口，是取舍）

- ~~**同一时刻只允许一个团队在跑**~~ → **rc.97 起已按桌面放开**：每个顶层会话一支团队
  （TeamId=SessionId 同构），TEAM_BUSY 移除。曾是 rc.95 的取舍（单份 roster/任务板宁可拒绝
  也不串台）；rc.97 拆成 per-session scope 后不再需要拒绝。
- **身份用 ThreadLocal 而不是 Agent 句柄**：teammate 跑在独立池线程里，工具执行期间
  `TeamCall.enter(name, teamSid)`；桌面是每个 Agent 自带 ctx。rc.97 起身份带所属团队，
  多团队并存下成员的调用落回自己的 roster/任务板。
- **成员收件箱在内存**：消息本身落 Lead 日志（`team/message` / `team/message-delivered`），可回放重建；成员侧 inbox 是内存队列，进程死掉时未认领的补充消息会丢（Lead 侧的不会）。

#### 仍缺（诚实清单）

1. **消息大小按原文而不是序列化后计**：桌面 `JSON.stringify(content)` 后算 64KB，手机端按 UTF-8 字节。中文场景差别不大，但结构化的超大消息会漏判
2. **`interrupt_agent` 不校验调用者角色**：靠「teammate 拿不到这个 schema」兜底；桌面是 `TEAM_LEAD_REQUIRED`
3. **任务 owner 是名字不是 SessionId**：桌面用 id，名字改了会断；手机端不支持改名，所以当前等价，但将来若支持改名要一起改
4. **没有 Session 投影框架**：UI 直接读 `runtime.snapshot()`；桌面是 `sessionProjections.register`
5. **HMR 式热拆装**：安卓只有插件启停，没有桌面那种 dispose + undo

#### 桌面独有、手机端不照搬

- **continuable subagent 的冷恢复**：桌面依赖 `ctx.subagents` 的 activation/descriptor/drain；安卓没有这个运行时，手机端用「每个成员一个独立 session + 自己重建上下文」等价实现
- **Session 投影**：见上
- **HMR dispose**：见上


### 11. 第二轮通读（rc.96）：还差什么

这一轮把 `agent-team` 的 9 个领域文件、`tool-agent-team`、`client-ui-agent-team`、
`agent-team-profile` 以及 `packages/subagent` 的 provider 与 continuation 协议都读完了。
下面是**读出来才发现**的差距，按「会不会让协作静默出错」排序。

#### 11.1 已补上的四条

| 缺口 | 桌面依据 | 手机端现在 |
|---|---|---|
| 回放期不变量与失败终态 | `projection.ts:225-310`：成员必须以 `provisioning` 开始；`name/provider/context` 不可变；只允许 `provisioning → active/failed`；任务 `revision` 必须逐一递增；**任何违规 → 置 `failure`，之后所有事件不再应用**，并由面板在最后合法状态上方显示 | `TeamJournal.replay` 逐条校验，违规即冻结并把原因放进 `snapshot().failure`，面板顶部红条提示 |
| fork 的保真度 | `subagent-fork-in-process`：child 用父会话日志到最后一个 `turn/end` 为止的**真实事件前缀**播种 | 成员拿到最近 6 轮的**完整文本 + 每轮跑过哪些工具、成功还是失败**（之前是「最后 60 条事件、每条 140 字的纯文本」，工具结果全丢） |
| 冷恢复时的工具痕迹 | continuation 保留全部事件 | 成员每次工具调用都往自己的会话写一条 `tool/result` 摘要，恢复时带进上下文 —— 队友记得上轮改过哪个文件 |
| `reassign` 的接收者 | `task-board.ts` 用 `resolveActiveMember` 解析，找不到就 `TEAM_MEMBER_NOT_FOUND` | 改派前先查名册：名字不存在 → `TEAM_MEMBER_NOT_FOUND`；成员创建失败 → `TEAM_MEMBER_FAILED`（之前打错一个字母就得到「无人认领」的任务） |

#### 11.2 还没补的六条（rc.97 已全部补齐）

> 用户的指令：「弱的地方跟桌面端对齐，需要决定的地方参照桌面端。」
> 六条全部按桌面端的决定落地，包括两处需要拍板的（③④都按桌面）：

1. **队友会话可导航**（对齐 `client-ui-agent-team` 的 addressed-subagent 路径）✅ rc.97
   面板成员卡与成员日志页新增「进入会话」：进入后聊天视图就是该成员的会话
   （顶部导航条标明「正在看 teammate xxx 的会话」），输入框里的话经
   `teamUserMessage` 走 **send_message 同一条路径** —— running 进收件箱在轮边界认领，
   inactive 冷恢复一轮。消息流 2.2s 轮询 + 内核 team 推送双通道增量刷新；
   「退出」回 Lead 会话。failed 成员不可进入（桌面 addressed-subagent 同样先验状态）。
   不改 `state.sessionId`：成员会话是内部 jsonl 视图，不会在会话列表里产生幽灵项。

2. **持久 phase 与运行 status 分离**（对齐 projection.ts 的 phase 机）✅ rc.97
   `MemberPhase: provisioning | active | failed` 落日志、被回放校验（首记录必须
   provisioning；只允许 provisioning → active/failed；name/provider/context 不可变）。
   「此刻在不在跑」由运行时派生成 `MemberStatus: running | inactive`，不进状态机 ——
   运行中的权威来源是运行时 active 表，回放一律 `running=false`。
   rc.96 的旧日志（status 单字段）回放时映射：provisioning→provisioning，
   failed→failed，其余→active，旧会话无损升级。

3. **多团队并存**（对齐桌面 TeamId=SessionId；需要拍板的第一处，按桌面）✅ rc.97
   每个顶层会话一支团队：roster / 任务板 / 收件箱 / 运行中成员 / Lead 配置
   全部 per-session 分桶（`TeamRuntime.Scope`），TEAM_BUSY 从此不存在 ——
   A 团队的成员在后台继续跑，B 会话照常建自己的团队。
   成员数 / 任务数 / 并行数是插件级容量（`TeamCapacity`），设置页改一次全局生效。
   成员线程发起的工具调用按 `TeamCall.callerTeamSid()` 落回**自己的团队**，
   用户切到别的会话也不会把 A 的汇报写进 B 的日志。

4. **团队与 subagent 互斥**（对齐 agent-team-profile；需要拍板的第二处，按桌面）✅ rc.97
   团队插件启用时，主 Agent 的 `subagent` / `subagent_fork` 从 schema 摘除
   （提示词段落随 `hasTool` 自动消失）—— 两套委派不并存，Lead 只用 spawn_teammate。
   与桌面一致：**底层 Subagent 服务仍供 teammate 使用**（递归深度 ≥2 时成员可再派），
   workflow 也不受影响。团队插件禁用后 subagent 系工具恢复。

5. **成员 provider 对齐桌面字段语义** ✅ rc.97
   安卓无法运行外部进程后端（ACP / Claude Code / Codex / SDK），provider 恒为
   `in-process` —— 这是平台边界，不是缺口。字段本身照桌面语义持久化，
   并纳入回放的不可变身份校验（provider/context 变更 = 终态拒绝）。

6. **消息字节 + 重复投递**（对齐 projection.ts 消息不变量）✅ rc.97
   · 大小：按 `JSON.stringify(content)` 等价的序列化字节算 64KB
     （`{"text":...}` 的 UTF-8 长度），错误信息带上实际字节数。
   · 投递：回放校验三条 —— 未入队先投递拒绝；同一条入队两次拒绝；
     同一条投递两次拒绝（均终态冻结）。运行时 `delivered` 集合防重复投递，
     回放后已投递的消息不再进收件箱。

#### 11.3 桌面没有、手机端反而更强的（别改回去）

- 面板能**中断**成员（桌面面板明确不能 spawn/rename/delete/interrupt）
- 有队友消息流（桌面投影里**没有** mailbox timeline，peer 消息不显示）
- 写范围是**真锁**（桌面只是 advisory metadata）
- 危险操作在后台直接拒绝（桌面有审批人）

## 附录 B：工具质量六维评分与改进路径

> 154 个内置工具（31 个插件）的六维评分与改进路径：§一 是评分口径，§二 是 9 域总表，
> §七 是 rc.97 复评（v2）与 rc.98 五项待修的落地状态，§八 是 rc.100 复评（v3），
> §九 是 rc.111 复评（v4，新增「造 App」域并补齐目录漏登记），
> §十 是 rc.112 复评（v5，把有结构性根因的六个域抬上去：终端 7.0→8.6、造 App 8.3→8.5、
> 文件制作 7.3→7.6、手机操控 7.3→7.8、媒体 7.0→7.5、桌面兼容 6.5→7.2；全局 7.4→7.8）。

审查对象：dsh-mobile 的 151 个内置工具（28 个插件；rc.98 起，149 + mindmap_generate/flowchart_generate）
审查日期：2026-10-24（rc.96 基线）；同日 rc.97 落地后复评，见 [第七节](#七rc97-复评v2)
方法：只读代码审查 + 关键事实逐条复核（所有根因均已在本机 grep 验证）


### 一、六维评分口径

| 维度 | 问的问题 |
|---|---|
| **覆盖** | 能力边界够不够用，缺什么类型 |
| **质量** | 产出物是否达到可用的视觉与信息密度 |
| **准确** | 定位与执行是否命中预期 |
| **速度** | 单次往返成本、缓存与并发 |
| **易用** | schema 描述与错误信息能否让模型一次用对 |
| **鲁棒** | 失败是否有结构化错误码与可恢复路径 |

### 二、总表

| 工具域 | 覆盖 | 质量 | 准确 | 速度 | 易用 | 鲁棒 | 均分 |
|---|---|---|---|---|---|---|---|
| 手机操控（computer-use · 27） | 8.0 | 5.5 | 5.0 | **3.0** | 8.0 | 6.0 | **5.9** |
| 文件制作与交付（doc-write/image/video/editor · 17） | 6.0 | **3.5** | 6.5 | 5.5 | 7.0 | 7.5 | **6.0** |
| 桌面兼容与插件自造（compat/plugin-builder · 18） | 5.5 | 5.5 | 6.0 | 6.0 | 6.5 | 6.5 | **6.0** |
| 终端与代码执行（terminal/shell/preset · 15） | 6.5 | 6.0 | 7.5 | 6.0 | 7.5 | 6.5 | **6.7** |
| 媒体与设备能力（capture/device-media/system-info · 11） | 7.0 | 6.5 | 7.0 | 7.5 | 7.5 | 6.5 | **7.0** |
| 会话与记忆（memory/session-tools · 12） | 7.0 | 6.5 | 7.5 | 7.5 | 7.5 | 8.0 | **7.3** |
| 智能体团队协作（agent-team/agent-control · 14） | 8.5 | 6.5 | 8.5 | 7.0 | 7.0 | 8.5 | **7.7** |
| 文件系统读写（fs · 12） | 8.0 | 7.5 | 8.0 | 8.5 | 8.0 | 8.0 | **8.0** |
| **全局加权** | **7.9** | **6.1** | **6.8** | **6.4** | **7.2** | **7.6** | **7.0** |

**结论**：整体 7.0，属于「工程底子扎实，但两个最显眼的场景被拖后腿」的结构性失衡。
短板集中在 **速度（6.4）** 与 **质量（6.1）** 两个维度，且两者恰好落在用户最在意的两个场景上。


### 三、痛点一：文件制作的视觉效果不突出（质量 3.5）

#### 根因 1 · 预览层把 HTML 的表现力全部掐掉（最致命）

- `assets/web/app.js:1580` — `frame.setAttribute("sandbox", "")`，禁脚本/表单/弹窗/同源
- `kernel/preview/DocPreview.kt:222-234` — `sanitizeHtml()` 二次清洗：
  移除 `script/iframe/object/embed/applet/form/link/meta/base`
  外链 `img/video/audio` 替换为占位文本「［外链图片已屏蔽］」

Agent 想做视觉产物，唯一能写的地方就是 HTML，而 HTML 预览恰好是能力最弱的一条路。
后果：ECharts / Chart.js 画的图表无法运行；依赖 CDN 的 CSS 海报彻底裸奔；外链背景图变占位符。

#### 根因 2 · 生成器与预览器「两套真相」，产物在预览里降维

| 生成端 | 预览端 | 后果 |
|---|---|---|
| `DocWriter.kt:303-307` heading 用内联 `<w:sz>`，**从不输出 `<w:pStyle>`**（全文件 pStyle 命中数 = 0） | `DocPreview.kt:292` 只认 `pStyle` | 所有标题塌成普通段；且回退类名 `pv-p` 在 `styles.css` 中**无定义** |
| `PptxWriter.kt:83-189` 做了 6 种版式（cover/section/bullets/two-col/quote/table），含整页主色背景、96pt 章节序号、双栏、交替底色表格 | `DocPreview.kt:315-330` 用「首段=标题、其余=要点」启发式重写 | 6 种版式视觉 **100% 丢失** |

**生成器越精致，预览越失真** —— 因为预览是「另写一套低保真渲染器」，不是渲染产物本身。

#### 根因 3 · 预览区 CSS 是为聊天设计的，不是为文档设计的

- `styles.css:2468` `.pv-slide` = 圆角灰底卡片，配合纵向 flex 堆叠 —— **不是 16:9 幻灯片**
- `styles.css:2465` `.pv-table` 无 `table-layout:fixed`、无 `overflow-x` 容器（对比 `.md-table-wrap` 在 `styles.css:651` 有）
- `styles.css:2523` `.pv-html-holder` 固定 `height:56vh` + 硬编码 `background:#fff` —— 深色模式下是刺眼白块
- `styles.css:699-701` 对话流 `.ct-img { max-height:168px; object-fit:cover }` —— **竖版海报被裁成中间一条**

#### 根因 4 · 缺少「视觉产物」这一整类工具

| 产物 | 状态 |
|---|---|
| 幻灯片 / 封面 | ���（但预览全丢，见根因 2） |
| 图表 | ❌ 全仓 grep `echarts/chart.js/mermaid` 零命中 |
| 思维导图 / 流程图 / 架构图 | ❌ 无任何布局代码 |
| 二维码 | ❌ `build.gradle.kts:84` 有 `zxing:core:3.5.3`，**代码零 import**（依赖是死的） |

#### 根因 5 · 预览层零测试

`DocPreview.kt` 466 行**零单测**；`PptxWriterTest.kt:47-51` 只测了 6 版式中的 1 种；无 androidTest、无快照回归。
→ 上述「生成器与预览器不匹配」的缺陷，**没有任何 CI 闸门能拦住**。

#### 根因 6 · 四套设计主题各自为政

`ImagePlugin.kt:220-225`（4 套 SVG 主题）、`PptxWriter.kt:409-448`（OOXML 主题 + accent 覆写）、
`DocWriter.kt:618-630`（docDefaults）、`PdfWriter.kt:59-72`（硬编码 RGB）—— 四套独立的颜色/字体定义，
Agent 无法跨格式保持视觉一致性。


### 四、痛点二：操控手机的速度与准确性（速度 3.0 / 准确 5.0）

#### 4.1 速度（最短板）

| 位置 | 问题 |
|---|---|
| `PhoneControlService.kt:858` | `compress(Bitmap.CompressFormat.PNG, 90)` —— **PNG 是无损格式，quality=90 完全无效**，1080×2340 约 1–2.5MB |
| `AgentDriver.kt:1106` | 注入对话时直接 base64 原始 PNG，**未走 `ImageResize`**（该类只服务相机/相册）→ 每轮请求体 1.4–3.4MB |
| `PhoneControlService.kt:57-59` | `onAccessibilityEvent` 空实现。配置已声明 `typeWindowContentChanged` 却完全空转 → **节点树零缓存**，每次全量重走 |
| `PhoneControlService.kt:76` | 每次 `screen_read` 固定 `sleep(200ms)`，不看界面是否真的落定 |
| `PhoneControlService.kt:1120` | 手势等 **6s** 回调（手势本身仅 80ms） |
| `PhoneControlService.kt:452` | 截图等 **20s** 回调（实测通常 <1s） |

单次「看屏幕→点一下」的模型往返是**完全串行**的：LLM 网络 → 工具执行 → 回灌 → 下一轮再请求 LLM。

#### 4.2 准确性

**P0 级缺陷（均已本机复核）**：

1. `PhoneControlService.kt:120` — 纯文本节点被 `elements.length() < maxElements` 门槛误伤。
   可交互元素攒够 60 个后，**页面文案整段消失**，模型只看到 60 个可交互元素的 label。
2. `PhoneControlService.kt:941` — `runCatching { n.refresh() }` **丢弃返回值**。
   `refresh()` 返回 false 意味着节点已被系统回收，代码却继续读缓存的 `isVisibleToUser` → 用**过期坐标**点击。
3. `PhoneControlService.kt:1083` — 点击后**不校验**。`performAction(ACTION_CLICK)` 返回 true 只代表「系统受理了点击」，
   落空/被拦截/命中父容器都返回 true。`tapText`/`tapId`/`tap(x,y)` 三条路径点完直接 `ok:true`。
4. `PhoneControlService.kt:135,148` — `lastNodes` 是 `@Volatile` 全局单例。
   子代理复用同一 kernel，`screen_read` 与 `phone_screenshot` 都是只读工具 → 进 4 线程并发池 → **跨 Agent 覆盖 lastNodes**，
   「最稳的 index 定位」变成跨 Agent 歧义索引。

**P1 级**：

5. `PhoneControlService.kt:84,87` — `budget = maxElements * 12`（默认 720 节点）截断遍历；`depth` 参数**传了从不判断**。
   大页面底部元素根本走不到。
6. `PhoneControlService.kt:900` — `screenH()` 用 `displayMetrics.heightPixels`（应用可用区），
   与 `getBoundsInScreen`（全屏含状态栏）坐标系不一致 → 靠边的元素被误判「不在屏上」。
7. `PhoneControlService.kt:1034-1038` — 同名元素永远取第一个，无 ordinal、无 scroll-into-view。
8. `PhoneControlService.kt:57-59` — 没有「页面变了 → 旧 index 自动失效」的通用机制。现有校验仅 3 处局部
   （`tapIndex` 失效重读、toggle 读回对比、setText 焦点重取）。

**测试覆盖：0**。`app/src/test` 下 15 个测试文件，`PhoneControlService`（1140 行）与 `ComputerUsePlugin`（520 行）**零覆盖**，
无 androidTest，无 Robolectric。

#### 4.3 客观地说，这套栈也有强项

- 执行器干净：纯 `AccessibilityService`（无 uiautomator/adb/MediaProjection 混用）
- 定位方式正确：用**无障碍节点树**而非 OCR 猜坐标
- 坐标换算自洽：`getBoundsInScreen` 与 `dispatchGesture` 同坐标系，旋转/状态栏不产生误差
- 文本/id 定位覆盖充分，8 个工具支持
- 错误码体系完整：13+ 个结构化错误码（`ACCESSIBILITY_NOT_ENABLED` / `STALE_INDEX` / `NOT_FOUND` / `UNSUPPORTED` …），
  未开启无障碍时**不静默失败**并给引导路径，`promptSection` 仅在真开启时才注入
- `phone_form_fill` 是唯一「一次调用多目标 + 逐项可观测」的设计

**短板不在「定位方式选错了」，而在「没有后置校验、没有缓存、截图没压缩」。**


### 五、最短改进路径（按性价比排序）

#### 文件制作（投入小、见效快）

| 优先级 | 改动 | 位置 | 预期收益 |
|---|---|---|---|
| P0 | iframe 放开脚本（工作区自产文件可信） | `app.js:1580` | 图表/动效类 HTML 立刻可用 |
| P0 | heading 补 `<w:pStyle w:val="HeadingN"/>` | `DocWriter.kt:303-307` | docx 预览标题层级恢复 |
| P0 | pptx 预览读 `layout`/坐标/填充色，而非文本启发式 | `DocPreview.kt:315-330` | 6 版式视觉还原 |
| P1 | `.pv-table` 加 `table-layout:fixed` + 外层 `overflow-x:auto` | `styles.css:2465` | 宽表不再压扁 |
| P1 | `.pv-slide` 改 `aspect-ratio:16/9` | `styles.css:2468` | PPT 预览像 PPT |
| P1 | `.pv-html-holder` 去固定高度、背景跟随主题 | `styles.css:2523` | 深色不刺眼、自适应 |
| P1 | 对话流图片改 `object-fit:contain` | `styles.css:699-701` | 海报不被裁 |
| P2 | 实现 `qr_generate`（zxing 已就位） | `build.gradle.kts:84` | 二维码，成本极低 |
| P2 | 补图表工具（离线 ECharts 或纯 SVG 生成器） | 新增 | 补齐最大能力缺口 |
| P2 | 抽共享 Theme 供 Image/Pptx/Docx/Pdf 共用 | 四处 | 跨格式视觉一致 |
| P2 | 补 `DocPreviewTest` + pptx 6 版式断言 | 新增 | 防回归 |

#### 手机操控

| 优先级 | 改动 | 位置 | 预期收益 |
|---|---|---|---|
| P0 | PNG → JPEG q85 + 缩到 768 + 走 `ImageResize` | `PhoneControlService.kt:856-858`、`AgentDriver.kt:1106` | 每次截图 2MB → ~120KB，token 与延迟同步下降 |
| P0 | `refresh()` 返回值判 false 就返回 null | `PhoneControlService.kt:941` | 消除过期坐标点击 |
| P0 | `texts` 用独立门槛 `texts.length() < 200` | `PhoneControlService.kt:120` | 页面文案不再整段消失 |
| P0 | 点击后自动 `screen_read` 比对，做后置校验层 | `PhoneControlService.kt:1083` | 消除「点了但没中」 |
| P0 | `lastNodes` 改为 per-call 句柄，不再是全局单例 | `PhoneControlService.kt:135,148` | 消除跨 Agent 串扰 |
| P1 | 监听 `TYPE_WINDOW_CONTENT_CHANGED` 标脏 + 树快照缓存 | `PhoneControlService.kt:57-59` | 消除每次全量重走 |
| P1 | settle sleep 改为「事件静默 N ms」判定 | `PhoneControlService.kt:76` | 每次省 200ms |
| P1 | 手势回调超时 6s → 1.5s；截图 20s → 3s | `:1120`、`:452` | 失败路径不拖死整轮 |
| P1 | 提高节点预算 + 真正执行 depth 上限 | `:84,87` | 底部元素可达 |
| P1 | `screenH()` 改用全屏真实高度 | `:900` | 靠边元素不再被丢 |
| P2 | 同名元素加可选 ordinal / scroll-into-view | `:1034` | 列表点第 N 个 |
| P2 | 补 phone 域单测（抽出纯逻辑层） | 新增 | 14 个风险点不再裸奔 |


### 六、值得肯定的部分（别改回去）

- 147 个工具在 `ToolCatalog` 集中登记只读/风险/分组，与插件实现 1:1 完全一致，另有启动自检兜底
- 四层工具过载防护：档位白名单 → 窗口分级（20/52/全量）→ 计划模式过滤 → 插件运行时开关；
  外加 token 预算扣减（`AgentDriver.kt:294-296`）与提示词按域归并（`PromptAssembler.kt:272-372`）
- 沙箱三档（READ_ONLY / WORKSPACE_WRITE / DANGER_FULL_ACCESS）+ 危险操作确认 + 破坏性操作标记
- 手机操控的错误码体系与「未授权不静默失败」的设计，质量高于多数同类项目
- 文件系统域 8.0 分：read/write/edit/glob/grep/undo + 沙箱 + 撤销日志，是最扎实的部分
- 团队协作域 7.7 分：CAS 任务板、DAG 环检测、写时复制、写租约冲突检测，领域层设计密度高


### 七、rc.97 复评（v2）

复评日期：2026-10-24（rc.97，versionCode 96 / versionName 0.2.1-rc.97，163 单测全绿）
方法：与基线同口径（覆盖/质量/准确/速度/易用/鲁棒，1-10），只重评 rc.97 触碰过的两个域；
其余 6 个域代码未动，分数原样保留。每个分数变化均给出代码证据。

#### 7.1 v2 总表

`↑/↓` 表示相对基线变化，`—` 表示未变动。

| 工具域 | 覆盖 | 质量 | 准确 | 速度 | 易用 | 鲁棒 | 均分 |
|---|---|---|---|---|---|---|---|
| 手机操控（computer-use · 27） | 8.0 — | 6.5 ↑1.0 | **7.5** ↑2.5 | **6.5** ↑3.5 | 8.5 ↑0.5 | 7.0 ↑1.0 | **7.3** ↑1.4 |
| 文件制作与交付（doc-write/image/video/editor · 17→19） | **7.5** ↑1.5 | **7.0** ↑3.5 | 7.5 ↑1.0 | 6.0 ↑0.5 | 7.5 ↑0.5 | 8.0 ↑0.5 | **7.3** ↑1.3 |
| 桌面兼容与插件自造（compat/plugin-builder · 18） | 5.5 | 5.5 | 6.0 | 6.0 | 6.5 | 6.5 | **6.0** — |
| 终端与代码执行（terminal/shell/preset · 15） | 6.5 | 6.0 | 7.5 | 6.0 | 7.5 | 6.5 | **6.7** — |
| 媒体与设备能力（capture/device-media/system-info · 11） | 7.0 | **7.5** ↑1.0 | **7.5** ↑0.5 | 7.5 | 7.5 | **8.0** ↑1.5 | **7.5** ↑0.5 |
| 会话与记忆（memory/session-tools · 12） | 7.0 | 6.5 | 7.5 | 7.5 | 7.5 | 8.0 | **7.3** — |
| 智能体团队协作（agent-team/agent-control · 14） | 8.5 | 6.5 | 8.5 | 7.0 | 7.0 | 8.5 | **7.7** — |
| 文件系统读写（fs · 12） | 8.0 | 7.5 | 8.0 | 8.5 | 8.0 | 8.0 | **8.0** — |
| **全局** | 7.3 ↑ | **6.5** ↑ | **7.4** ↑ | **6.9** ↑ | 7.5 ↑ | 7.4 ↑ | **7.2** ↑ |

**口径说明**：基线的全局 7.0 是加权估计（权重未落档，不可复算）。本节全局改用
**8 域均分的简单平均**，可逐位复算；基线按同口径应为 6.8，v2 为 7.2，**净升 +0.4**。
两个曾经的短板维升幅最大：**质量 5.9→6.5（+0.6）**、**速度 6.4→6.9（+0.5）**，与基线诊断一致。

#### 7.2 手机操控 5.9 → 7.3（升分依据）

| 维度 | 变化 | 证据 |
|---|---|---|
| 速度 3.0→**6.5** | 截图 PNG90（无效参数）→ JPEG85/1080px（`PhoneControlService.kt:940-943`），对话注入走 `ImageResize.dataUrl`（`ComputerUsePlugin.kt:295-296`）；`onAccessibilityEvent` 空转改为 UiChangeTracker 事件接入（`:62-82`），settle 由固定 200ms 改「事件静默 <150ms 才睡」；手势回调 6s→2s、截图 20s→8s。未到 7.5 的原因：注入链路仍是「LLM→工具→回灌→LLM」完全串行，本轮只削了固定开销，没有合并往返 |
| 准确 5.0→**7.5** | 基线 4 个 P0 全部修复：texts 独立门槛（连坐 bug 一行修）、`refresh()` 失败即 null（`:91-106` 附近）、点击后置校验 `withUiCheck` 附 `ui_changed`（tap/clickNode/setText/toggle 四路接入）、`lastNodes` 单例改 LRU(4) 快照 token 隔离（`:187-204`，跨 Agent 串扰消除）。P1 项：节点预算 `maxElements*25` + depth>30 真正生效、`screenH()` 改 `display.getRealMetrics` 全屏坐标、`tapText(exact, ordinal)` 与 `scrollIntoView`（≤3 次滚动）落地。未满分原因：`ui_changed` 是单次 600ms 短等待不重试，慢过渡动画仍可能漏报；`PhoneControlService`/`ComputerUsePlugin` 服务类本体仍零单测（纯逻辑层 ScreenOutline/UiChangeTracker 有，Android 依赖类没有） |
| 易用 8.0→8.5 | `promptSection` 补齐 snapshot token 语义、`ui_changed:false` 的解读指引、ordinal「取第 N 个」说明（`ComputerUsePlugin.kt:77-81`），模型一次用对所需的信息完整了 |
| 质量 5.5→6.5 | 截图落盘保 1080px 高清、对话注入 768 档压缩，「给模型看的」与「给用户存的」分离；`ScreenOutline` 文案+元素双视图保留 |
| 鲁棒 6.0→7.0 | 过期快照附 stale 注记而非静默用旧索引；UiChangeTracker 回绕溢出 bug 被单测抓住并修复（时间注入假时钟，6 个测试） |
| 覆盖 8.0 — | 未动 |

**基线归因更正**：基线把 `AgentDriver.kt:1106` 未压缩注入记在操控域 P0。rc.97 修复操控截图路径后复核发现，
该未压缩路径的唯一残留调用方是 **`read_image`**（`HarnessPlugin.kt:191-198`），应归 fs 域——见 7.4 待修清单。

#### 7.3 文件制作与交付 6.0 → 7.3（升分依据，工具数 17→19）

| 维度 | 变化 | 证据 |
|---|---|---|
| 质量 3.5→**7.0** | 基线 6 个根因修掉 5 个半：① `sandbox="allow-scripts"`（`app.js:1585`）放开脚本、无同源为最终防线，图表/动效类 HTML 立即可用；② heading 输出 `<w:pStyle>`（`DocWriter.kt:307-310`），docx 预览标题层级恢复；③ PPTX 预览改读 shape 几何/srgbClr 填充（`PptxLayoutParser` + `DocPreview.kt:299-308`，16:9 绝对定位 + cqw 字号，解析失败回退旧启发式），6 版式视觉不再 100% 丢失；④ 预览 CSS 四处修复（`.pv-slide` 16:9、`.pv-table` 横向滚动、`.pv-html-holder` 跟随主题、`.ct-img` contain 不裁竖图）；⑤ 共享 `Palette.kt` 接入 DocWriter/PptxWriter/ChartSvg。**半个**：PdfWriter 仍硬编码 `Color.rgb`（`:62-214` 共 9 处），跨格式视觉一致差最后一块 |
| 覆盖 6.0→7.5 | `chart_generate` 补上最大能力缺口（bar/hbar/line/pie/scatter 五类，纯本地 SVG 确定性输出）、`qr_generate` 落地（SVG/PNG 双格式，zxing 死依赖盘活）。仍缺：思维导图/流程图/mermaid 类（全仓 grep 零命中） |
| 准确 6.5→7.5 | 「生成器与预览器两套真相」在 docx 标题与 pptx 版式两处闭环：预览读的就是产物结构本身；PptxLayoutParser 喂 PptxWriter 实产 XML 做 8 个测试，不怕格式漂移 |
| 速度 5.5→6.0 | chart/qr 纯本地毫秒级生成、零网络；原有生成链路未动 |
| 易用 7.0→7.5 | chart/qr schema 带 accent 覆写与 output 路径参数，类型枚举即文档 |
| 鲁棒 7.5→8.0 | 预览层零测试状态终结：HtmlSanitizer 9 + PptxLayoutParser 8 + ChartSvg 12（含确定性断言）+ QrSvg 8 个测试。DocPreview 本体（编排层）仍无测试，未给满 |
| — | （无降分项） |

#### 7.4 仍待修清单（rc.98 状态：五项全部落地）

> rc.98（versionCode 97）状态更新：五项全部落地，测试 163 → 194 全绿。逐项标注如下。

| 优先级 | 改动 | 位置 | 预期收益 | rc.98 状态 |
|---|---|---|---|---|
| ~~**P0**~~ | ~~`read_image` 走 `ImageResize`（基线 P0 残留，归 fs 域）~~ | `HarnessPlugin.kt:198` → `AgentDriver.kt:1094-1116` | 读大图不再撑爆请求体（当前 8MB 上限硬拦，超限直接失败） | ✅ 已修：`AgentDriver.addImage` 内「先压后查」——读字节 → `ImageResize.forConversation`（1600px/JPEG85，GIF 原样）→ 压缩后字节查 8MB 上限；mime 跟随实际字节（压缩后即 `image/jpeg`）；返回文案报压缩前后 KB；session 日志加 `compressed` 标记。接口签名不动，TeamRuntime 桩零波及 |
| **P1** | `ui_changed` 加一次条件重试（页面仍变则延长等待） | `PhoneControlService.withUiCheck`（`:91-106`） | 慢过渡动画不再误报「界面没变」 | ✅ 已修：`UiChangeTracker.awaitChangeSteady`（round1=timeout，未变再补 0.5×，**总上界 1.5×timeout**——重试的是等待而非操作）；withUiCheck 三态 note（立即变化 / 延迟 Xms / 两轮未变提示自绘界面可能）；promptSection 同步说明；UiChangeTrackerTest +4 例 |
| **P1** | `DocPreview` 本体编排层单测（sanitize/renderPptx 路由/回退路径） | 新增 `DocPreviewTest` | 466 行编排逻辑从裸奔回归 | ✅ 已修：8 个测试（pptx 版式还原 happy path / 损坏 pptx→kind=error / csv 引号转义 / tsv / json 美化 / markdown / code / 未知扩展名分发）。docx/xlsx 分支依赖 android.util.Xml 桩，JVM 不可测，已在测试注释里写明边界 |
| **P2** | PdfWriter 接 `Palette.ACCENT`（替换 9 处 `Color.rgb`） | `PdfWriter.kt:62-214` | 跨 docx/pptx/pdf/chart 四格式视觉一致闭环 | ✅ 已修：`write(..., accent)` 对齐 PptxWriter 惯例；H1 下划线 + 引用竖条用 accent 实色、表头背景 accent 淡化（`argb(0x1F,…)` 打印友好）；其余 6 处灰阶保留中性语义；write_pdf schema 加 `accent` 透传 |
| **P2** | 思维导图/流程图工具（可复用 ChartSvg 的 SVG 管线） | 新增 | 补齐视觉产物最后两个缺口 | ✅ 已修：`mindmap_generate`（MindNode 树 → 横向 tidy 布局，pass1 叶子高度/后序、pass2 列宽，三次贝塞尔连线，中文宽度 1.0×字号估宽，超宽截断，深度上限 6）+ `flowchart_generate`（Kahn 拓扑分层，最长路径层，5 种形状，正交折线，decision 出边自动标是/否，环检测抛错）。20 个测试，含确定性断言 |

**测试实测抓到并修掉的真 bug**（说明这批测试不是摆设）：
- `MindmapSvg.lay()` 算盒宽用截断后 label、渲染存的是原 label —— 截断静默失效；
- FlowNode 的 label/shape 缺默认值（测试编译期暴露）；
- MindmapSvgTest 正则贪婪匹配到 `rx="8"` 尾巴（测试侧修正）。

**遗留小项（不构成待修清单，记档）**：PdfWriter/Palette 相关无 JVM 单测（android.graphics 依赖），靠真机目检；mindmap/flowchart 的 SVG 文字宽度是估值（已留 2×padding 余量），极端长字串与真实渲染有偏差。

#### 7.5 复评结论

- 全局 **6.8 → 7.2**（同口径简单平均）：两个被诊断的结构性短板都实质性抬升，失衡明显收窄——
  均分最低域从 5.9（操控）变为 6.0（兼容自造，且本轮未触碰），不再是「最显眼的场景最弱」。
- 质量维 +0.6、速度维 +0.5 的升幅全部来自代码级修复，无分数膨胀：每一分都对应已验证的
  文件行号。
- **※ 现状（rc.98）**：§7.4 五项待修已全部落地（read_image 压缩 / ui_changed 两轮观察 /
  DocPreviewTest / PdfWriter 接 Palette / mindmap+flowchart 两个新工具），测试 163 → 194 全绿。
  剩余天花板：手机操控服务类本体（PhoneControlService / ComputerUsePlugin）仍零单测、
  串行注入链路的往返合并、以及 android.graphics 依赖的 PdfWriter 只能真机目检。

### 八、rc.100 复评（v3）：最低两个域的落地改进

复评日期：2026-10-25（rc.100）。范围：**只重评 v2 未触碰的三个最低域**
（兼容自造 6.0 / 终端 6.7 / 媒体 7.0），其余五域代码未动、分数原样保留。
方法同前：只读代码审查 + 每个分数变化给出文件行号；本轮修复全部配 JVM 单测。

#### 8.1 v3 总表（变动域加粗）

| 工具域 | 覆盖 | 质量 | 准确 | 速度 | 易用 | 鲁棒 | 均分 |
|---|---|---|---|---|---|---|---|
| 手机操控（computer-use · 27） | 8.0 | 6.5 | 7.5 | 6.5 | 8.5 | 7.0 | **7.3** — |
| 文件制作与交付（doc-write/image/video/editor · 19） | 7.5 | 7.0 | 7.5 | 6.0 | 7.5 | 8.0 | **7.3** — |
| **桌面兼容与插件自造（compat/plugin-builder/preset · 18）** | 5.5 | 5.5 | **6.5** ↑0.5 | **7.0** ↑1.0 | **7.0** ↑0.5 | **7.5** ↑1.0 | **6.5** ↑0.5 |
| **终端与代码执行（terminal/shell/preset · 15）** | 6.5 | 6.0 | **8.0** ↑0.5 | 6.0 | **8.0** ↑0.5 | **7.5** ↑1.0 | **7.0** ↑0.3 |
| 媒体与设备能力（capture/device-media/system-info · 11） | 7.0 | **7.5** ↑1.0 | **7.5** ↑0.5 | 7.5 | 7.5 | **8.0** ↑1.5 | **7.5** ↑0.5 |
| 会话与记忆（memory/session-tools · 12） | 7.0 | 6.5 | 7.5 | 7.5 | 7.5 | 8.0 | **7.3** — |
| 智能体团队协作（agent-team/agent-control · 14） | 8.5 | 6.5 | 8.5 | 7.0 | 7.0 | 8.5 | **7.7** — |
| 文件系统读写（fs · 12） | 8.0 | 7.5 | 8.0 | 8.5 | 8.0 | 8.0 | **8.0** — |
| **全局** | 7.3 | 6.5 | **7.6** ↑ | **7.0** ↑ | **7.6** ↑ | **7.6** ↑ | **7.3** ↑ |

#### 8.2 兼容自造 6.0 → 6.5（升分依据）

| 维度 | 变化 | 证据 |
|---|---|---|
| 速度 6.0→**7.0** | `lsp()` 兜底实例**每次调用 new 一个**（`CompatPlugin.kt:91-92`）——SymbolIndex 的定义索引/行缓存全挂在实例上，服务缺失路径下 hover 一次就全量重扫工作区。改为懒缓存单实例；`hasGit()` 每次起子进程探测（`:110-115`）改为进程级缓存，`load_workspace_dependencies` 复用同一探测入口（`probeCommand`） | CompatPlugin.kt |
| 准确 6.0→**6.5** | `load_workspace_dependencies` 的 node 运行时**写死 `available:false`**（`:346-351`）——python 都探测了 node 不探测，Termux/自定义 ROM 装了 node 会被误报「未安装」。改为与 python 同款探测，未装时保留 run_code 指引 | CompatPlugin.kt |
| 易用 6.5→**7.0** | plugin_create 的校验只有「名字正则 + 不撞车」：**规范 §2 写了「最多 8 个工具」代码从不检查**；description 空也放行（模型按它决定要不要调用，空描述工具等于不可用）；parameters 给非对象也放行。全部收进 `PluginRules` 纯函数并逐条报因 | PluginBuilderPlugin.kt / PluginRules |
| 鲁棒 6.5→**7.5** | 校验规则从 250 行 execute 里抽出成 `PluginRules`（无 IO 无 Android 依赖），PluginRulesTest 12 个用例锁住（含「规范与实现漂移」类：超 8 个工具、空描述）；死代码 `strArray` 删除 | PluginRulesTest.kt |
| 覆盖/质量 — | `plugin_market` 在 marketUrl 已配置时仍是「暂未实现」（诚实不可用）——没有市场协议文档，硬造协议等于引入假实现，**记档不改** | PresetToolsPlugin.kt:179 |

#### 8.3 终端 6.7 → 7.0（升分依据）

| 维度 | 变化 | 证据 |
|---|---|---|
| 准确 7.5→**8.0** | **SEND_ACTIVE 护栏只覆盖 submitAndWait，terminal_send 裸写 stdin**（`TerminalRegistry.send` 无护栏）：同一会话两个并发 send（如前台 + 后台收集 job）会交叉写 stdin，前台命令读到 interleaved 输入。新增 `guardedSend`（拿不到护栏返回结构化 SEND_ACTIVE/SESSION_EXIT），前台 send 与后台收集 job 全部接入；后台 job **整个收集期**占住护栏 | TerminalRegistry.kt / TerminalPlugin.kt |
| 易用 7.5→**8.0** | 后台收集 60s 上限写死不可配 → `bg_timeout_ms`（5s-600s）；前台超时判定 `8_000 - 1_000` 魔数 hack（改常量会静默失效）→ `WAIT_MS/QUIET_MS/POLL_MS` 常量 + 显式 timedOut 判定；schema 补 SEND_ACTIVE 语义说明 | TerminalPlugin.kt |
| 鲁棒 6.5→**7.5** | Session 环形缓冲（append/slice/truncatedBefore/length 绝对坐标）此前零单测——「offset 漂移」「并发交叉写」两类最阴的缺陷全靠真机手测。TerminalRegistrySessionTest 9 个用例：未裁剪/裁剪后绝对 offset 不漂移/越界空串/护栏占用·释放·关闭六态 | TerminalRegistrySessionTest.kt |
| 速度/覆盖/质量 — | 串行等待模型未动（与操控域同一遗留）； Signals 诚实性约定（SIGINT 不谎报）v2 已修，保持 | — |

#### 8.4 媒体与设备 7.0 —（复核结论）

逐文件复核 Capture/DeviceMedia/SystemInfo：无 P0。一条死代码记档（`gallery_read` 的
`loadMediaBytes(if (kind == "video") …)` video 分支不可达——视频 mime 已在前置分支提前返回说明），
不构成缺陷；`location_get` 的 25s 上限压注与 Locale.US 坐标格式化等既有防御保持。

#### 8.5 v3 结论

- 全局 **7.2 → 7.3**：最低域不再是「桌面兼容与插件自造 6.0」，短板集中度下降；
  鲁棒维全局 +0.2（本轮 21 个新单测全部锁在「规范与实现漂移」「并发交叉写」这类真缺陷上）。
- **复评抓到的最大真 bug**：terminal_send 的并发裸写 stdin（SEND_ACTIVE 约束名存实亡）——
  v2 复评给终端域准确 7.5 时漏了这条，本轮代码审查补上。
- 剩余天花板（记档，不进待修清单）：操控/终端服务类的 Android 依赖本体只能真机目检；
  串行注入链路往返合并；plugin_market 协议未定。


### 九、rc.111 复评（v4）：新增「造 App」域 + 补齐目录漏登记

复评日期：2026-10-26（rc.111，versionCode 110，327 个单测）。范围：**M6–M10 触碰过的能力**
（M6 `app_install`、M8 手机内完整打包、M9 工程脚手架、M10 常驻构建守护）。其余六个域代码未动，
分数原样保留。方法同前：只读代码 + 实测数据，每条分数给出位置与依据。

#### 9.1 复评先抓到的事实问题（都已修）

| # | 问题 | 后果 | 处置 |
|---|---|---|---|
| 1 | **`app_new` / `app_build` / `app_install` 从未登记进 `ToolCatalog`**（151 项里查无此三项） | 三者落进 `ToolCatalog.fallback`：按写操作对待 —— 安全上没错，但**分组、风险、工具计数全都看不见它们**；六维评分自然也就没有这一域。启动自检只记日志不阻断，所以一直没人发现 | `ToolCatalog.kt` 补三行：`app_new`→EDIT、`app_build`→SHELL、`app_install`→DEVICE（MUTATE，理由见代码注释：系统安装弹窗已经是人工闸门，平台侧再叠一次高危确认等于问两遍）。工具数 **151 → 154** |
| 2 | v3 总表里「手机内打包」被算进**终端与代码执行域** | 域与工具实际归属不一致，导致终端域分数虚高、造 App 能力不可见 | v4 单独立域「造 App」，终端域回到它自己的 15 个工具 |
| 3 | 单测数停在 v3 的 194 | 读者会误判覆盖度 | 当前 **327 个 `@Test`（41 个测试文件）** |

#### 9.2 v4 总表（9 域，`↑` 为相对 v3）

| 工具域 | 覆盖 | 质量 | 准确 | 速度 | 易用 | 鲁棒 | 均分 |
|---|---|---|---|---|---|---|---|
| 手机操控（computer-use · 27） | 8.0 | 6.5 | 7.5 | 6.5 | 8.5 | 7.0 | **7.3** — |
| 文件制作与交付（doc-write/image/video/editor · 19） | 7.5 | 7.0 | 7.5 | 6.0 | 7.5 | 8.0 | **7.3** — |
| 桌面兼容与插件自造（compat/plugin-builder/preset · 18） | **7.0** ↑1.5 | **7.0** ↑1.5 | **7.0** ↑0.5 | 7.0 | 7.0 | **8.0** ↑0.5 | **7.2** ↑0.7 |
| 终端与代码执行（terminal/shell/preset · 15） | 6.5 | 6.0 | 8.0 | 6.0 | 8.0 | 7.5 | **7.0** — |
| **造 App（app_new/app_build/app_install · 3）** | **9.0** | **7.5** | **8.0** | **8.5** | **8.5** | **8.0** | **8.3** 新 |
| 媒体与设备能力（capture/device-media/system-info · 11） | 7.0 | **7.5** ↑1.0 | **7.5** ↑0.5 | 7.5 | 7.5 | **8.0** ↑1.5 | **7.5** ↑0.5 |
| 会话与记忆（memory/session-tools · 12） | 7.0 | 6.5 | 7.5 | 7.5 | 7.5 | 8.0 | **7.3** — |
| 智能体团队协作（agent-team/agent-control · 14） | 8.5 | 6.5 | 8.5 | 7.0 | 7.0 | 8.5 | **7.7** — |
| 文件系统读写（fs · 12） | 8.0 | 7.5 | 8.0 | 8.5 | 8.0 | 8.0 | **8.0** — |
| **全局（9 域均值）** | 7.3 | 6.5 | 7.7 | 7.3 | 7.8 | 7.8 | **7.4** ↑0.1 |

**口径说明**：v3 是 8 域简单平均（7.3）。v4 多了一个域，9 域均值 7.4；**同样这 8 个域仍是 7.3**，
所以「+0.1」全部来自新增域，不代表既有域变好了。

#### 9.3 造 App 域 8.3 分的取证（逐维）

| 维度 | 分 | 依据 |
|---|---|---|
| 覆盖 9.0 | 三段闭环都在：`app_new` 一次写出 13 个文件（清单 / strings / colors / **五档 PNG 图标** / 自适应图标 / 1-3 个 Activity / README）；`app_build` 走 aapt2 compile+link → ecj → d8 → 注入 dex → apksigner 全链；`app_install` 走 PackageInstaller 会话并回传终态。**扣 1 分**：只支持 Java + 纯代码搭界面（不支持 Kotlin/Compose、三方 AAR、layout XML 模板） |
| 质量 7.5 | 产物真能启动并翻页（`verify-app-new.mjs` 全 PASS）；图标不是素材而是**自研 PNG 编码器**按主色现画（IHDR/IDAT/IEND + Deflater/CRC32，五档共 7.6KB，零素材维护）。**扣分**：debug 签名、装一次要人工确认 |
| 准确 8.0 | aapt2 载荷按 ABI 只装一份（`jniLibs/libdshaapt2.so`）；重装后 uid 变化导致 `res/` 不可读会**显式报错**而不是静默跳过（`AppBuildPlugin` 里 `listFiles()==null` 检查）；分页越界 bug 已修（`next` 按 `activities` 判，不再看数组长度） |
| 速度 8.5 | **实测**（`.motion/verify/perf-app-build.mjs`，同一工程连打三次）：改前 12.3~13.9s → 常驻守护进程后 **2.1~2.6s**（第 2、3 次），首次 15.6s 含一遍类加载。依据 `BuildDaemon.kt`（一个 guest JVM 常驻，四阶段同进程，每 stage 隔离 ClassLoader）。**不满分**：冷态仍要 15s |
| 易用 8.5 | `app_build` 回传 `timings`（res/link/ecj/d8/inject/sign 分段毫秒），失败时能一眼看出卡哪一步；`app_install` 超时文案明确「弹窗还开着，不要立刻重试」 |
| 鲁棒 8.0 | proot 下 JVM 初始化抖动按 5 次递增退避重试（300/600/900/1200ms）；常驻进程空闲 120s 自动回收（实测静置 140s 后 `java`/`proot` 进程归零，176MB 全数归还）；`busy` 未复位导致永不回收的漏洞已修 |

#### 9.4 一个不进六维但必须记的数据：流式

六维是「工具」的评分，流式属前端渲染，不进表。但这轮它被改了两处，数据留在这里备查：

- **合批层**（`agent/StreamFlusher.kt`，三条流式链路共用）：delta 间隔 p50 **42ms** / p95 **70ms** —— 达标。
- **渲染层**：`dumpsys gfxinfo` 在流式窗口里量到 p50 单帧 **65ms**、掉帧 **67.9%**，但该窗口把
  模型等待与无关动画一起算进去了（两次测量 67.9% / 79.5% 波动大于改动本身），**不作为结论**。
  已做的单帧成本收口（光标不再每帧扫全树、活动段 memo、滚动进 rAF、快照进 idle）需要真机复测才算数。

#### 9.5 v4 结论

- 全局 9 域 **7.4**；8 域同口径仍 **7.3**，本轮没有靠调分制造进步。
- 真正的收获不是分数，而是 **9.1 的第 1 条**：三个工具在目录里根本不存在。
  「插件实现 ↔ ToolCatalog 1:1」这条 v3 里被当作优点写进结论的自检，实际只在启动日志里
  留了一行，没人看 —— **下次新增工具的验收清单必须包含「目录登记 + facts 计数变化」**。
- 造 App 域 8.3 的天花板很清楚：装包必须人工确认一次、只支持 Java + 代码界面。

### 十、rc.112 复评（v5）：把 8 分以下的域逐个压到 8 分以上

复评日期：2026-10-26。范围：**只重评本轮动过代码的三个域**（终端 / 造 App / 文件制作），
其余六域代码未动、分数原样保留。方法同前：先量后改，每条分数给出实测数据或文件位置。

本轮的原则是「分数是改出来的，不是调出来的」—— 三个域各有一个**结构性根因**，
不动根因就没有真分数：

| 域 | 根因（不是参数问题） | 已改 |
|---|---|---|
| 终端 7.0 | 会话后端只有安卓宿主 `/system/bin/sh`，实测 `which java python3 git gcc` **四个全空**，而工具描述写着「持久 shell 会话」 | 后端可注入：`workspace`（rootfs，java/python3/gcc/node/keytool 都在）／`device`（宿主，保留 /sdcard、pm、am） |
| 终端 速度 | 命令结束靠「输出静默 700ms」猜 | shell 自己打印哨兵 `__DSH_END_<token>_<exit>__` |
| 造 App 8.3 | 公共 debug 密钥签名（密码固定 `android`），任何人可伪造、商店拒收 | 首次构建用 rootfs 的 keytool 生成专属 RSA-2048 密钥 |
| 文件制作 7.3 | 查过才知道：慢不在生成器，而是**每行跑 6 个正则**+ 每段 4 个 + 每个标题一次 `Regex.replaceAll` | 首字符分派 + 短路，1674 段 26ms→10ms |

#### 10.1 v5 总表（`↑` 为相对 v4）

| 工具域 | 覆盖 | 质量 | 准确 | 速度 | 易用 | 鲁棒 | 均分 |
|---|---|---|---|---|---|---|---|
| 手机操控（computer-use · 27） | 8.0 | **7.0** ↑0.5 | **8.0** ↑0.5 | **7.0** ↑0.5 | 8.5 | **8.0** ↑1.0 | **7.8** ↑0.5 |
| 文件制作与交付（doc-write/image/video/editor · 19） | 7.5 | 7.0 | 7.5 | **8.5** ↑2.5 | 7.5 | 8.0 | **7.6** ↑0.3 |
| 桌面兼容与插件自造（compat/plugin-builder/preset · 18） | **7.0** ↑1.5 | **7.0** ↑1.5 | **7.0** ↑0.5 | 7.0 | 7.0 | **8.0** ↑0.5 | **7.2** ↑0.7 |
| 终端与代码执行（terminal/shell/preset · 15） | **9.0** ↑2.5 | **8.5** ↑2.5 | **8.5** ↑0.5 | **8.5** ↑2.5 | **8.5** ↑0.5 | **8.5** ↑1.0 | **8.6** ↑1.6 |
| 造 App（app_new/app_build/app_install · 3） | 9.0 | **8.5** ↑1.0 | 8.0 | 8.5 | 8.5 | 8.0 | **8.5** ↑0.2 |
| 媒体与设备能力（capture/device-media/system-info · 11） | 7.0 | **7.5** ↑1.0 | **7.5** ↑0.5 | 7.5 | 7.5 | **8.0** ↑1.5 | **7.5** ↑0.5 |
| 会话与记忆（memory/session-tools · 12） | 7.0 | 6.5 | 7.5 | 7.5 | 7.5 | 8.0 | **7.3** — |
| 智能体团队协作（agent-team/agent-control · 14） | 8.5 | 6.5 | 8.5 | 7.0 | 7.0 | 8.5 | **7.7** — |
| 文件系统读写（fs · 12） | 8.0 | 7.5 | 8.0 | 8.5 | 8.0 | 8.0 | **8.0** — |
| **全局（9 域均值）** | 7.9 | 7.1 | 7.8 | 7.8 | 7.8 | 8.1 | **7.8** ↑0.4 |

#### 10.2 终端 7.0 → 8.6（升分依据，均为实测）

| 维度 | 分 | 证据 |
|---|---|---|
| 覆盖 6.5→**9.0** | 换 rootfs 后端后 `which java python3 gcc node` 返回四个真实路径（`/usr/bin/…`），`python3 -c "sum(range(1,101))"` → 5050、`java -version` → OpenJDK 21。**扣 1**：rootfs 未内置 git / make / javac（记住这条，需要时用 ecj 或装包） |
| 质量 6.0→**8.5** | 终端第一次真的能执行代码（旧版只有安卓内置命令）；`exit_code` 如实回传，非 0 时附「非 0 通常意味着失败，先看报错不要盲重试」。**扣分**：无 PTY，全屏 TUI 与 SIGINT 仍不可用（平台限制，已在工具描述里声明） |
| 准确 8.0→**8.5** | 结束判据从「静默猜测」换成证据：`sleep 3 && echo done` 实测 **3282ms** 返回 `done-after-3s`；旧实现 700ms 就报「已结束」并把空输出交给模型。这是两个方向都会错的旧缺陷（静默等待被误判结束、慢速输出被误判仍在跑） |
| 速度 6.0→**8.5** | `which java python3 gcc node` 一条命令 **1092ms → 269ms**（含 CDP 往返，真实生成耗时更低）；不再固定等 700ms 静默窗口。**扣分**：JVM 类命令仍有 proot 下的启动成本 |
| 易用 8.0→**8.5** | `terminal_open` 新增 `backend`，返回里直接声明「这条会话能用什么、缺什么」（runtimes 字段），模型不必试探 |
| 鲁棒 7.5→**8.5** | ①`/bin/sh -> /bin/busybox` 是绝对链接，宿主 `File.exists()` 必断链 → 修 `guestEntryExists`（实测就报过 `NEED_RUNTIME:sh`）；②宿主 sh 去掉 `-i`（每条约多打两个 PS1 提示符被当成输出）；③JVM 启动抖动按严格判据重试一次；④33 个终端单测（哨兵 11 + 抖动 7 + 缓冲 9 + 信号 6） |

#### 10.3 造 App 8.3 → 8.5

| 维度 | 分 | 证据 |
|---|---|---|
| 质量 7.5→**8.5** | 扣分点原文就是「debug 签名」。现在首次构建用 rootfs 的 keytool 生成 **专属 RSA-2048**（100 年有效），keystore 与 24 位随机口令分开存放、权限 `-rw-------`，之后复用（同一 key 才能覆盖升级）。`apksigner verify --print-certs` 实测 `CN=DeepSeek Harness Mobile`（debug 是 `CN=Android Debug`）。**仍不满分**：自签不是 CA 签发，装到别人手机仍需允许未知来源 |

#### 10.4 文件制作 7.3 → 7.6

| 维度 | 分 | 证据 |
|---|---|---|
| 速度 6.0→**8.5** | 先量后改：设备端量到的「1674 段 3.2s」是**混合值**（CDP 往返 + debug 构建的 ART 解释执行 + 生成），同一份代码两次差 10 倍，不能作数。改用 JVM 基准（生成器是纯 Kotlin）做**同机新旧对照**：26ms → **10ms（2.4 倍）**。三处浪费都与行数成正比：每行 6 个 `Regex.matches`、每段 4 个（isBlockStart）、每个标题一次 `Regex.replaceAll`（字面量替换写成了正则）。**扣分**：大文档生成期间没有进度反馈 |

**未动的一个判断**：文件制作的质量维仍是 7.0 —— 这轮只改了性能，产物结构一字未变，不给自己加分。

#### 10.5 手机操控 7.3 → 7.8

先查了一遍「为什么串行」，结论是**架构性的、不该硬改**：`standard` 模式只暴露独立工具，
所以每步一个 LLM 往返；`ptc` 模式的 `run_code` 里本来就能 `await dsh.callTool(...)` 连续调
（`PtcRuntime.Bridge.call` → `registry.exec`，任何工具都能调），那才是合并往返的正道。
**所以没有新造「批量动作工具」** —— 桌面 `cua` 同样是「一次一个动作」，合并靠 PTC 模式。
真正的两处缺陷在别的地方：

| 维度 | 分 | 证据 |
|---|---|---|
| 准确 7.5→**8.0** | `findNodes` 把「按文本找到的节点」和「按 id 找到的节点」**直接相加、没有去重**。同一节点若两路都命中（按钮文本恰好等于 id 末段），`all.size` 就偏大 → `ordinal` 数到重复项 → **点到隔壁元素**。现场表现是「明明只有 3 个『更多』，点第 3 个却点到第 2 个」。改为 `LinkedHashSet` 去重，并把「可见优先 / 自身文本优先于聚合标签 / 树序即 ordinal」四条优先级抽成纯函数 `NodeMatch.select` |
| 速度 6.5→**7.0** | `findNodesRetry` 无条件重试 6 次 × 250ms：模型把元素名记错时**固定白等 1.5s** 才拿到 NOT_FOUND，而这 1.5s 里界面一次都没变过。改为「界面已静默 ≥150ms 就不再重试」（静默即「不是还没渲染完，是确实没有」），最坏 1.6s → 约 0.25s。**未端到端实测**：操控工具要求活跃轮次做应用授权，CDP 直调会被 `APP_APPROVAL_UNAVAILABLE` 拒绝；这是按代码路径算的，不是量出来的 |
| 鲁棒 7.0→**8.0** | `NodeMatchTest` 11 个用例锁住四条优先级 + 空查询保护 + 大小写语义 + 越界提示；这是「服务类本体零单测」这条记档缺陷的第一块 |
| 质量 6.5→**7.0** | 核心选择逻辑从「只能在真机目检」变成可回归；截图/注入链路本轮未动，不给更多 |

**为什么不到 8**：速度那一维的天花板是 standard 模式的串行往返，这不是改代码能动的
（PTC 是模式选择，不是能力缺失）。要再往上，只能让用户切到 PTC 模式。

#### 10.6 媒体与设备 7.0 → 7.5

这个域此前**零测试**（它是九域里唯一一个没有任何 test 文件的）。查下来的真问题不是算法，
而是「同一件事写了 5 份、规则还不一样」：

| 维度 | 分 | 证据 |
|---|---|---|
| 质量 6.5→**7.5** | 名字清洗原本散在 5 处、两套规则：`CapturePlugin` 的拍照/录音文件名、`DeviceMediaPlugin` 的相册名/导入文件名/导出子目录。相册那条用的是更严的「只留字母数字中文」，于是 `微信/收藏` 变成 `微信收藏`（丢信息），而文件名那条保留成 `微信_收藏`。收敛成 `MediaPaths.cleanName` 一处，规则统一为「非法字符换 `_`」——**改一处即全部生效**，也不会再出现「修了文件名忘了相册名」 |
| 鲁棒 6.5→**8.0** | 两处真实风险被堵上：①**没有长度上限** —— Android 单个路径段 255 **字节**，中文 3 字节，模型给个 100 字相册名就会写盘失败，而错误信息看不出是名字太长（现在截断到 60 字 = 180 字节）；②清洗后只剩 `__`（输入全是控制字符）会产出一个下划线目录，现在回退到默认名 |
| 准确 7.0→**7.5** | `gallery_read(kind=all)` 的合并排序抽成 `MediaPaths.mergeRecent` 并锁住语义：两路各取 limit 后必须**按时间统一排序再截断**，否则「最近 5 条」会变成「5 张图 + 5 个视频」且图片全排在视频前。实现本来是对的，但此前没有测试，改一行就可能回归 |
| 速度 7.5 — | 顺带把 5 次「每次调用都 `Regex(...)` 编译」收敛成 1 个预编译常量；影响很小，不据此加分 |

`MediaPathsTest` 12 个用例，包括一条**我自己写错后改对**的：最初断言「清洗结果不含 `..`」，
实际 `../../etc/passwd` 变成 `.._.._etc_passwd` —— 判据应该是「作为单个路径段无法改变父目录」，
不是「字符串里没有两个点」。断言写错会导致实现被改坏，这类判据必须以安全属性表述。

**为什么只到 7.5**：覆盖 7.0 未动（相册/导入导出/系统信息的能力边界没变），速度也没变。

#### 10.7 桌面兼容 6.5 → 7.2：`plugin_market` 从「未实现」到按桌面协议实现

**先纠正 §10.6 之前的一个错误结论**：我写的是「兼容自造缺 `plugin_market` 协议文档，
硬造等于假实现，记档不改」。**这是错的** —— 协议一直在桌面仓库里，是我没查到：

| 桌面位置 | 内容 |
|---|---|
| `packages/util/plugin-market-index` | format 1 的**校验器**：字段、`LocalizedText`、`marketInstallTarget` |
| `packages/boot/plugin-market` | 读取服务：`indexes` / `fetchTimeoutMs` / `maxBytes` / `cacheTtlMs`、`search(url, query)` |
| `.agents/notes/…/plugin-market-index-format.md` | 格式定义 |

而手机端的实情比「没有协议」更糟：**配了 `marketUrl` 就直接 `throw "市场源拉取暂未实现"`**
—— 是「有入口、没实现」，不是「能力缺失」。

| 维度 | 分 | 证据 |
|---|---|---|
| 覆盖 5.5→**7.0** | `plugin_market` 三个动作全部可用：`list_indexes`（含上次读取状态）、`list_plugins`（关键词 + 分页 `total`/`next_offset`）、`list_versions`。配置字段改名对齐桌面 `indexes`（数组），旧的 `marketUrl` 单值仍兼容。**不满分**：18 个工具里这只是 1 个；`cordis_inspect` 等覆盖问题未动 |
| 质量 5.5→**7.0** | 校验规则照抄 format 1：`format` 必须 1、`title` 必填、`plugin.name`/`versions` 非空、`version` 是 semver、`source.type ∈ {npm, git}`、git 需 40 位小写 commit；违规抛 `MarketIndexError` 并带 **JSON 路径**（`plugins[0].versions[0].version`），而不是笼统「格式错误」 |
| 准确 6.5→**7.0** | `install_spec` 逐字符照抄桌面 `marketInstallTarget`：npm → `name@version`；git → `git+<url 补 .git>#<commit>&path:/<dir>`。**注意是 `&` 不是 `?`** —— 桌面就这么拼，改成「更规范」的 `?` 会装不上。检索匹配包名/标题/描述/keywords 四个字段 |
| 鲁棒 7.5→**8.0** | 25 个用例。其中**测试抓到一个真实缺陷**：检索用了「只取主语言」的 `text()`，于是中文环境下 `title:{en:"Hello",zh:"你好"}` 搜 `hello` 得 0 结果 —— 改为 `textAll()` 匹配全部语言（展示仍取单语言）。URL 只收 http/https、无凭据、无 fragment；`search` 只接受**已配置**地址（桌面同规矩，否则这工具就是 SSRF 通道） |

**端到端实测**（模拟器 + 本地索引服务）：`list_indexes` 首次 **15.3s**（网络往返，非代码）、
二次命中缓存 **270ms**；检索「语音」`total=1` 命中；git 插件的 `install_spec` 为
`git+https://example.com/dsh/git-tools.git#0123…&path:/packages/git`；未配置 URL 返回
`MARKET_URL_NOT_CONFIGURED`、未知插件返回 `PLUGIN_NOT_FOUND`。

**与桌面的两处有意偏差**（平台限制，已写进代码注释）：`maxBytes` 16MB（桌面 128MB —
安卓应用堆放不下，解析会翻倍占内存）；不实现 `setIndexes` 写回（手机端没有 Settings/profile
持久层，**不假装能写**）。

#### 10.8 会话与团队：查过，但**没有可改的真缺陷**

这两域都已有测试（`SessionStoreTest` / `CompactorOverflowTest` / `SpillPolicyTest`；
`TeamBoardTest` / `TeamJournalTest` / `TeamRosterTest`），逐文件复核后未发现新的 P0：

- **会话与记忆 7.3**：`memory_save` 有 400 条上限 / 1200 字上限 / 同 scope 去重；
  `memory_search` 用 token 打分排序，且**明确不落盘**（只读工具进并发池，回写会和并发 save 互相覆盖）。
  质量 6.5 更多是「记忆本身写得好不好」的问题，不是代码缺陷 —— 不靠改代码能提。
- **智能体团队协作 7.7**：核心状态机（roster/journal/board）已有 3 个测试文件覆盖
  CAS、DAG 环检测、replay 不变量。质量 6.5 与易用 7.0 未定位到具体代码位置。

**不做的事**：不为了把分数抬上去而改这些域的代码。没有根因就动刀，只会引入新缺陷。

#### 10.9 v5 结论

- 全局 **7.4 → 7.8**；六个域上升：终端 7.0→8.6（最大跨度）、造 App 8.3→8.5、
  手机操控 7.3→7.8（修掉会「点错元素」的真 bug）、文件制作 7.3→7.6、媒体 7.0→7.5（该域首个测试）、
  桌面兼容 6.5→7.2（`plugin_market` 从「未实现」到按桌面协议实现）。
- 单测 **327 → 395**。
- **三个被数据推翻的假设**（记下来，下次别再犯）：
  0. 「`plugin_market` 没有协议文档」——**协议一直在桌面仓库里**（`util/plugin-market-index`
     是它的可执行规则集）。我把「我没找到」当成了「不存在」，这是最不该犯的一种：
     它让一个可做的功能被记成「记档不改」。教训是：说「缺文档」之前必须先搜到对方仓库的
     `util/` 与 `.agents/notes/`。
  1. 「设备端的毫秒数是可信的」—— debug 构建的 ART 解释执行会把字符串/循环密集代码放慢一个量级，
     同一份 42KB 内容两次测量能从 2.6s 变到 0.7s。要判断算法好坏，得在 JVM 上跑同机对照。
  2. 「终端慢是因为命令本身慢」—— 实际每条命令固定多付 700ms 静默等待，`which` 这种毫秒级命令
     被测成 1092ms。
- 剩余低于 8 的两个域：会话 7.3 / 团队 7.7，以及刚抬到 7.2 的桌面兼容（18 个工具只修了 1 个）。
  会话与团队查过，**没有可改的真缺陷**（记忆的质量是「内容写得好不好」，团队状态机已有三套测试）；
  桌面兼容还差的不是协议，是另外 17 个工具的覆盖问题。

## 版本历史

> **以后所有升级记录统一写在这一节**（每次升级在顶部新增条目，含 App 版本与涉及的插件/文档版本），不再单独维护 RELEASE-NOTES。
> 历史条目按**当时状态**如实记录；后续版本把某项改动推翻或收回时，会在该条目追加「**※ 现状**」标注 ——
> 以免读者照着旧条目找功能。最新状态以「功能总览」与最近一条条目为准。

### rc.168（versionCode 168）· 2026-10-31 · 文档富化（超链接/斜体/删除线/嵌套列表）+ schemas 缓存 + 流式光标移除 + 玻璃降级补齐

**write_docx 富文本**。Markdown 子集从此支持：`[文字](https://…)` **超链接**（外部关系
TargetMode=External，蓝色下划线可点）、`*斜体*`、`~~删除线~~`、**两级嵌套列表**（前导空格
每 2 个 = 一层，缩进 360 twips/层，上限 3 层）。所有新特征走真实 Agent 轮在设备上验证：
富文档.docx 内 w:hyperlink + rIdH1 外部关系 + w:i + w:strike + 嵌套缩进全部就位。

**schemas 缓存（性能）**。自造插件同轮生效引入的「每步重算工具目录」让 154 个 schema 的
全量裁剪（~100KB JSON 逐条扫描）每步白跑一次。改为按结构变更失效的缓存
（register/unregister/refreshTools/setEnabled 四个变更点置空），命中时返回同一实例。
JVM 测试钉住（同实例命中 + 注册新插件后失效）。

**流式光标移除（对齐桌面）**。桌面 ui-chat 的流式输出没有打字光标（streaming prop 只用于
内容分组）；手机端的蓝色闪烁竖条是自创装饰。attachCaret/removeCaret 函数、3+1 个调用点、
.caret 样式与 blink 动画全部删除——流式期间 .caret 元素为 0（设备实测）。

**玻璃降级补齐**。回到底部按钮的「材质不是玻璃」：真机 WebView 不支持 backdrop-filter 时，
项目里 @supports not 降级清单没包含 .to-bottom——0.78 半透明底无模糊=一片死白。
补进降级清单，退成与输入框一致的实色卡片。

单测 476 → **478 全绿**（+1 富文本、+1 schemas 缓存）。

### rc.167（versionCode 167）· 2026-10-31 · video_generate 显式 mode 参数 + 只读工具并发声明

**video_generate 补 `mode` 参数**（auto / text2video / image2video）。此前「文生 vs 图生」由
image_path 在场与否隐式推断——wire 形态对了，但 schema 不自解释。现在：显式声明模式；
image2video 缺参考图在创建请求**前**被拦截（`mode=image2video 需要参考图：请给 image_path`），
不再走进端点黑盒。实测走真实 Agent 轮验证拦截与错误上报。

**13 个只读工具补 `executionMode = PARALLEL`**：memory_search/memory_list、
session_event_read/search/trace、session_search/trace、schedule_list、plugin_spec/plugin_list、
device_info、sticker_list——批量读取轮次进并发池，不再串行排队。

单测 476 全绿。### rc.166（versionCode 166）· 2026-10-31 · write_docx 支持嵌入工作区图片

**write_docx 图片嵌入**。正文里写一行 `![](工作区图片相对路径)`（png/jpg/gif），生成时解析成
Word 原生 inline 图片：media part + 关系 + drawing（EMU 按 5.5 英寸宽上限、真实像素比缩放），
PNG/GIF 头与 JPEG SOF 扫描读尺寸；解析不到/超 8MB 的图降级为「图片缺失」说明段——
文档永远生成得出来。write_docx 从此能交付**带截图/带图表的报告**，不再只能纯文字。

两处平台差异实测踩过并修掉：① Android 的 java.util.regex 拒绝未转义的 `}`
（OpenJDK 容忍，桌面 JVM 测试全绿、设备上 PatternSyntaxException）——`{{DSH_IMG:\d+}}`
改为 `\{\{DSH_IMG:\d+\}\}`；② 图片字节的 zip 条目必须走二进制通道，String put 会按
UTF-8 把字节打碎。图片缺失降级与嵌入路径各有 JVM 测试（DocWriterTest +2）。

单测 474 → **476 全绿**。设备实测：真实 64x40 PNG 经 ![](real.png) 嵌入，
docx 内 `word/media/image1.png` + 1 个 drawing，模型回报 images=1。

### rc.165（versionCode 165）· 2026-10-31 · 生成模型工具参数对齐端点能力（视频图生图 + 图像编辑与质量档）

用户实测反馈「有些生成不了，因为给模型的参数太少」。逐个对照 OpenAI 兼容端点的真实 wire 形态补齐：

**video_generate 参数扩充**。此前只有 prompt/duration/size/path 四个参数：① 新增 **aspect_ratio**
（16:9 / 9:16 / 1:1，自动映射分辨率；竖屏 9:16 是手机端最高频需求）；② 新增 **image_path 图生视频**
——工作区参考图走 multipart `input_reference`（OpenAI sora-2 wire 形态），「把生成的图变成视频」
这条主链路此前完全做不了；③ 新增 **model 按次覆盖**（一个端点常挂多个视频模型）；
④ **seconds 的 wire 形态 400 互换重试**（OpenAI 规范是字符串、部分兼容端点只认数字）；
⑤ 400 错误带**可行动提示**（时长/分辨率/模型/参考图四类拒绝各给一句「怎么改」），不再只回 200 字符原始 body。

**image_generate 补齐三参**。① **quality 档位**（auto/low/medium/high，gpt-image-1 系）——callApi
早已透传该字段但 schema 没暴露给模型；② **image_path 图生图**——multipart `/images/edits`
（端点尾段自动推导 generations→edits）；③ **model 按次覆盖**。4xx 错误同样带可行动提示
（edits 不支持 / quality 不认 / 模型不存在各给一句）。

**实测**（模拟器 + mock 生成端点，真实 Agent 轮）：文生视频（9:16 映射 + mp4 落盘）、
图生视频（multipart 边界可见）、文生图（quality/model）、图生图（/images/edits multipart）
五条请求路径全部走通，工作区落 2 mp4 + 2 png。

### rc.164（versionCode 164）· 2026-10-31 · 自造插件同轮生效 + 清单插件提示词段落 + 渲染修复

本轮主题：「一切皆插件」做实——harness 真正能**自造插件、当场装配、同轮调用、随时卸载**，
并补齐清单插件对齐桌面 Cordis 的提示词段落能力。全程逐阶段实测（模拟器真实 Agent 轮 +
内核日志逐 step 分析），审查详情见 [docs/plugin-review.md](docs/plugin-review.md)。

**自造插件同轮生效（核心修复）**。此前 `Turn.toolDefs` 在轮开始时冻结：`plugin_create`
装配成功后，同一轮后续请求仍然带旧工具集，模型看到「已装配」提示却调不到，只能空转找绕路
（实测 200 秒）。修复三处：① `AgentDriver.runStep` 每步重算工具目录，与上一步 diff 非空时
换装并记 `request/tools` 事件（对齐桌面 Cordis「每请求收集工具」语义）；② 预设白名单对
运行时装配的动态工具豁免（白名单圈的是内置目录，用户批准装配的能力被它过滤 = 装了永远调不到）；
③ diff 读名时适配 OpenAI 嵌套格式（`function.name`，首版读顶层 `name` 得空串集合、diff 永不触发）。
实测：step2 装配 → step3 工具集 143→144（日志 `+[wc_demo]`）→ step5 **同轮调用成功**（返回 3 行）
→ step6 卸载后 144→143（`-[wc_demo]`）。装配审批闸门（只读拒/全权放/标准逐次）全程保持。

**清单插件提示词段落**。清单新增可选 `"prompt"` 字段（≤1500 字），插件往系统提示贡献
「何时用、怎么用」说明——桌面 Cordis 插件往 system-prompt waterfall 加段落的等价物；
没有它模型只看得到工具 schema，经常不知道何时该调用。校验与段落贡献均有 JVM 测试。

**ToolCatalog 补登记**。python/node/run/compile/java/rustc/pkg/mcp_tools 八个工具此前未登记，
内核启动告警「按写操作对待」；现显式落表（run 系任意代码执行 = DESTRUCTIVE 与 bash 同级、
mcp_tools = WEB），启动告警清零，只读/计划模式的闸门语义从"巧合正确"变为"声明正确"。

**文件渲染三项**。① `.zip/.jar` 专属预览：条目名 + 大小清单（此前按文本读二进制一屏乱码，
`write_zip` 的交付物首当其冲）；② 无扩展名二进制嗅探（控制字符占比 + zip 魔数，字节按无符号比
——首版有符号比较把中文 UTF-8 全判成控制字符），交系统查看器不再出乱码；③ PDF 文本提取的
段落重排（行尾 CJK 才折行合并，ASCII 标点/符号碎片一律不碰），中文 PDF 不再满屏断句。

单测 468 → **474 全绿**（+4 prompt 校验、+2 渲染）。插件体系审查（31 插件全量盘点 +
设计规范一致性 + 结构清理清单）见 [docs/plugin-review.md](docs/plugin-review.md)。

### rc.163（versionCode 163）· 2026-10-31 · 计划类卡片身份色改回

- `.todo-card`（执行计划）右上角绿色径向渐变、`.plan-card`（计划评审）整块靛蓝渐变（含深色档位）**改回** —— 这两块是用户点名要保留的身份色，rc.162 里为统一材质抹掉是过度改动。
- 回归用例 `surface-material` 第 5 组断言随之反转为「身份色必须还在」，防止再次被统一掉。

### rc.162（versionCode 162）· 2026-10-30 · 表面材质统一（排队队列 / 目标胶囊）

- **排队队列**：原先每条排队消息各自铺不透明卡片（`--card` + `--sep` 边框），而下方输入框是玻璃 —— 一屏两种材质。改为对齐桌面端 `QueueDock`：队列面板是输入框表面的向上延伸（玻璃渐变 + 背景模糊 + 上圆下方、底边不画线），行本身无背景无边框、只用 0.5px 分隔线；队列在场时输入框上沿圆角改直（`has-queue`），两块并成一整块表面。
- **目标胶囊**：`.mode-chip` 由「灰填充、无描边」改为与输入框同一套玻璃；状态色只落在图标与阶段文字上，不再铺彩色底块。
- **无背景模糊机型**：`@supports not (backdrop-filter)` 退色名单补上 `queue-bar` / `mode-chip`，否则玻璃下会透出正文。
- 清掉两条死样式（`.qi-act.ok`、`.queue-item.is-editing` —— 编辑是把文本取回输入框，不会就地展开）。
- 注：rc.162 曾顺手把 `.todo-card` / `.plan-card` 的专属渐变也改成中性，rc.163 按用户要求改回。

### rc.161（versionCode 161）· 2026-10-30 · 搜索命中只高亮当前一处

- 全部命中只做无样式 `<mark>` 包裹（`.hl` 继承原文字色、抹掉 UA 黄底），红色只挂在当前命中 `.hl-on` 上，切换时由 `syncCurMark()` 搬类 —— 不再整片红。
- 切换命中即 `scrollIntoView({block:"center"})` 滚到对话中部；只改颜色不改字重，避免切换时文本回跳。

### rc.160（versionCode 160）· 2026-10-30 · 搜索只搜正文 + 命中改红 + 浮窗露头修复

- 对话内搜索范围收窄到正文（`.assistant-text` / `.bubble-user`），不再把「已完成，用时」「思考」摘要、「复制·朗读·20.8k tokens」算进命中。
- 命中字色由绿改红（当前命中更深红 + 更粗），用户蓝气泡内改用浅红保证可读。
- 底部「露出浮窗顶部」：下拉关闭手势在面板已关时直接 return，手指留下的内联 y 冻在半空 → `sheetHideHard()` 收尾 + 关闭态 `visibility:hidden` 兜底。

### rc.159（versionCode 159）· 2026-10-30 · 对话内搜索高亮去背景

- 搜索命中字符残留 `<mark>` 的 UA 默认黄色背景（截图里的浅绿底），`.hl` 补 `background:none`，只保留字体变绿；当前命中仍用更深的绿 + 加粗区分。

### rc.158（versionCode 158）· 2026-10-30 · 底部悬浮导航栏再下移 6px

rc.157 真机复测通过（等待行回到用户气泡下方）。应视觉要求把底部悬浮导航栏再下移 6px：
无手势区机型离屏底 20px→14px（`bottom: calc(6px + max(var(--safe-bottom), 8px))`），
有 safe-bottom 的机型仍按安全区自动让位；语音浮层让位高度同步收到 90px 保持对齐。纯 CSS 改动。

### rc.157（versionCode 157）· 2026-10-30 · 等待行插入顺序修复（真机实锤 rc.156）

rc.156 真机复测抓到的尾巴：发消息后「深度求索中」跑到**用户消息上面**。根因不在等待行本身，
而在 `renderThread()` 首屏分帧灌入（`requestAnimationFrame`）与 `push()` 同步
`insertAdjacentHTML("beforeend")` 的竞态 —— renderThread 刚排了 rAF、一帧未执行时
`#messages` 还是空的，`beginLive → push` 的等待节点先插进空列表，下一帧历史
（用户气泡）才灌到它后面；且 `fillHead` 按 `thread.length` 灌，同一节点还会被灌两遍。

修复：新增 `appendTail(n)` 统一收口尾部插入（`push` 与 `flowAction` 兜底分支共用）——
分帧灌未完成时先同步把剩余历史灌完再插新节点，`renderTailFrom` 跟踪灌入进度，
DOM 顺序永远等于 `thread` 顺序。行为模拟测试（含截图复现时序）通过。

### rc.156（versionCode 156）· 2026-10-30 · 等待态修复 + 底部导航下移

对齐桌面端的两处 UI 修复与一处交互调整，纯 Web 层（assets/web）改动，原生零改动。

**「深度求索中」钉在回复顶部（主修复）**。桌面端 RunningStatus 是独立一行、拼在消息流末尾、
running 结束整体卸载（ChatFlow.tsx:60）；手机端却把等待行 `innerHTML` 注入流式气泡内部，
而 `paintLiveText` 增量路径只 append 不重写 —— 正文开始输出后没有任何代码摘掉它，
就一直钉在回复顶部。修复：`livePaint` 正文首帧先摘 `.runstat` 再画正文
（`beginLive` / `Flow.newText` 两个注入点全覆盖）。

**电脑会话等待行残留**。`PcRun.stop()` 只删数据节点不重绘，发送失败 catch、
`onHistory` 静默收摊等无重绘调用点会让「深度求索中」气泡一直挂屏；现在按 `data-uid` 连 DOM 一起删。

**清理与调整**。鲸尾 SVG 路径（WHALE_PATH）在两处各写一遍，抽成共用 `whaleStatHTML(label)`；
styles.css 删掉旧「三点跳动」死样式 `@keyframes typingBounce`（全仓无引用）；
底部悬浮导航栏下移 8px（无手势区机型离屏底 28px→20px，有 safe-bottom 机型仍自动让位），
语音浮层让位高度同步收 8px 保持对齐。preview/ 已同步；`node --check` + 行为模拟测试通过。

### rc.155（versionCode 155）· 2026-10-30 · 意图路由修复 + 经典男声线更换 + 三处交互修复

本轮是「Harness 对齐审查（docs/harness-review.md）第 1→2 轮」的落地：一个压制模型能力的 P0 修复、
一个应用户要求的声线更换、三个实测抓到的交互毛病。审查评分 8.7 → 8.8。

**意图路由修复（P0）**。`IntentRouter` 把显式点名工具的请求误判成闲聊——实测
『请同时调用三个 bash 工具,分别读取 /proc/version…』被判成 `chat(conf 0.35)`，策略段落随之注入
「看起来像闲聊」，直接压制模型动手（强模型硬扛过去，弱模型会照着拒绝）。修复四件事：
动作词表扩充 29 个常用祈使动词（读取/统计/汇报/列出/导出…，旧表连「读取」都没有）；
新增**点名工具**信号（英文工具名与「调用/同时…工具」句式，task +2.2，最强任务信号）；
CHAT 低分兜底加逃逸——点名工具或足量任务信号在场时不落闲聊帽；
CHAT 策略措辞改为「如果用户其实提出了具体操作，按操作照做」，不再绝对禁止工具。
新增 `IntentRouterTest` 7 项钉住（含修复前那条原句），复测同一请求 `task conf=1.0`。

**经典男声线更换（指挥老者）**。应选型要求，内置男声模型从 `fanchen-C(sid 69)` 换为
`fanchen-ZhiHuiLaoZhe`（单角色，116Hz / 频谱重心 576Hz，比旧包透亮），int8 量化 32.6MB 不变；
配套 lexicon/tokens/fst 与原包逐字节一致。伴随两项管线修复：`NeuralTts.toWav` 新增**峰值响度归一**
（目标 -1dBFS、增益上限 12×）——该角色原始输出峰值波动 0.09~0.5，轻的句子外放≈无声，
这是此前「男声语音生成不出来」体感的真凶；语音缓存键加代次（v3），升级后旧响度缓存自动失效。
`bazong` 等历史音色 id 走 LEGACY 表迁到新经典男。试听选型证据在 `D:/1/voice-audition/`
（unity/wnj/指挥老者/深渊/禅雅塔 五个角色各三句）。

**回到底部按钮与输入框重叠**。`.composer-dock` 长高经常来自 padding（安全区 inset 晚到、
键盘打开收窄），而 ResizeObserver 默认只观察 content-box，padding 变化**不触发回调**，
`--dock-h` 停在旧值（实测停在 78px、真实 88px）。修复：观察改 `{box:"border-box"}` +
观察器实例强引用（防 GC）+ `fonts.ready` 与按钮出现瞬间各补量一次。

**发送消息输入框弹跳**。发送后 `updateSendState()` 会把空输入的发送键 disable，而被点过的
按钮正持有焦点——焦点随 disabled 丢回 body，Android 立即无动画收起键盘（`--kb` 一帧 336→0），
输入框从键盘上沿砸回屏底。修复：`keepInputFocus()` 在键盘开着时发完把焦点还给输入框
（对齐微信「发完接着打」），handleSend 三分支 + 排队入队分支都覆盖。

单测 461 → **468 全绿**（+7 意图路由）。Harness 审查详情见 [docs/harness-review.md](docs/harness-review.md)。

### rc.154（versionCode 154）· 2026-10-29 · 数学公式渲染（本地懒加载 KaTeX）+ 更新面板英文语言修复 + 移除侧边轮次导航

rc.153 之后一轮「补齐桌面能力 + 收两个毛病」的版本。

**数学公式（对齐桌面 KaTeX）**。`md()` / `inline()` 之前完全没接公式，行内 `\(…\)`、`$…$` 与块级
`\[…\]`、`$$…$$` 都原样漏成文字。现在改为**本地懒加载 KaTeX**：`assets/web/katex/` 内置
`katex.min.js` + `katex.min.css` + 20 个 WOFF2 字体（约 596K），与桌面同引擎、完全离线。
体积敏感的处理是「**没有公式就零开销**」：由 `MutationObserver` 监听 `#messages`，只有出现 `.math`
节点时才注入 CSS/JS 并渲染；解析用占位符（`\u0000M{n}\u0000` 哨兵）保护公式原文，避免加粗 / 斜体 /
链接规则改写公式内部；只有完整定界符才落 `<span class="math">`，流式里没闭合的 TeX 保留原文、不闪红。
解析逻辑抽出来跑了 Node 单测（19 项全过），并接进 `init()` 首屏与流式两条路径。

**「检查更新」在英文语言下仍显示中文**。设置里的静态标签 `检查更新`（index.html）没进 `I18N` 词典；
更新浮窗（`updateBody` / `sheetUpdate` / 「不支持」提示）也整段硬编码中文。现在标签补进词典、随整树翻译，
浮窗按 `EN()` 双语分支，检查中 / 已最新 / 发现新版本 / 下载中 / 下载完成 / 失败六个状态在英文模式下
不再残留中文。

**移除对话界面侧边轮次导航（turn-rail）**。右缘那列细刻度（对齐桌面 TurnNavigator）在手机窄屏上只会
压住正文边缘，而且**从未接线**——`app.js` 里没有任何 `turnRail` 引用，元素一直 `hidden`，属于纯死代码。
本次连 HTML / CSS / 验证脚本 / 交接文档一并清干净。

### rc.153（versionCode 153）· 2026-10-29 · 对话内搜索改字符绿高亮 + 搜索态自动避让

rc.152 之后一轮纯 UI 打磨，聚焦「在对话中搜索」这条路径（搜索复用底部输入框本体，不另开浮动条）。

**命中表现：字符直接变绿**。之前命中是一条消息套蓝色描边框（`.is-hit`），丑且看不出命中的具体位置。
改为字符级 `<mark>` 高亮：普通命中浅绿底绿字，当前命中实心绿底白字更醒目；只包裹文本节点、不动外层 DOM，
不打断 markdown / 代码块结构，退出搜索时整体 `unwrap` 还原。暗色主题同步补了覆盖色。

**修复回到底部按钮搜索态避让**。CSS 早有一条「搜索时按钮上抬 52px」的规则，但它依赖 `html.search-on` 类，
而该类此前**从没被 JS 加上过**——规则形同虚设，搜索签（上一处 / 退出）和回到底部按钮会叠在一起。
现在 `openSearch` / `closeSearch` 正确切换该类，实测间隔 48px，不再重叠。

**搜索态 modeBar 只渲染搜索签**。之前搜索时还会把预设 / 计划 / 目标签和搜索签挤在同一行，正是用户点名的
「切换上 / 下一个区域还显示其他内容、没避让」问题。搜索是专注模式，现在这些切换签一律不渲染，modeBar 整条让给搜索。

**验收**：实机 10/10——绿高亮生成、当前命中 `hl-cur`、计数签 `1/N`、跳转前进、退出后 `<mark>` 全部还原、`search-on` 摘除、避让 gap=48px。

### rc.152（versionCode 152）· 2026-10-29 · 前台命令退出码徽标 + 上下文压缩真正生效（并修掉两个「一直在坏」的 bug）

三件事：给命令补上一直缺的退出码展示；把上下文压缩接通到界面；过程中挖出两个存在已久的真 bug。

**前台命令的退出码徽标**。终端 / 后台任务类工具的结果 JSON 里本来就带 `exit_code`，界面早就能画徽标；
但前台一次性命令（`bash` / `python` / `node` / `run` / `java` / `rustc` / `pkg` / `compile`）的结果是纯文本，
退出码没地方承载，界面一直只有「成功 / 失败」两种糊成一片的状态。

- 走旁路不改正文：`ToolSpec` 新增 `executeResult(args, ctx): ToolResult(text, exitCode)` 作为**唯一**派发入口
  （默认包裹旧的 `execute`，几百个工具零改动）；shell 类工具用一个 `exitHeader` 开关声明「正文首行是 exit=N」，
  注册表把退出码放进信封**同级字段**（模型看到的内容一字不动），`Outcome.exitCode` 只认这个字段、不从正文猜。
- 退出码跟着单次调用走，没有「全局最后一次」旁路——同批并发不串号。
- 界面：`exit 0` 灰徽标、非 0 红徽标，随 `tool_end` 实时出现，重载会话后仍在。
  （注意 Android toybox 的 `ls /nope` 退出码是 **1**，不是 GNU ls 的 2。）

**上下文压缩真正生效 + 账目上屏**。挖出一个自引入以来就存在的 bug：轮首压缩的「可压缩边界」参数
默认值把**整段历史都标记成本轮**，于是压缩器每次都原样返回——压缩从未压缩过任何东西。

- 修法：删掉该参数（历史整段可压缩），「本轮」语义只归轮内压缩（那处语义是对的）。
- 剪枝（折叠早期工具输出）不再折**最后一轮**的工具段：最后一条用户消息之后的一切是模型眼下的工作记忆，
  折掉就失忆；保留条数约束只作用于更早的轮次（单测锁定）。
- 压缩账目全链上屏：`folded` 计数 → `compacted` 事件 → 轮末「用量」面板新增「上下文压缩」行；
  检查点展开时正文前补一行账目（压缩 N 条 · X → Y tokens · 省 Z%）；
  剪枝路径的文案从荒谬的「省略 0 条较早消息」改为「折叠 N 处早期工具输出」。

**顺手修掉一个所有人都没发现的存量 bug**：轮末 footer 的用量按钮先渲染后赋节点 id，
导致 `data-turn-usage` 永远是空串——**「本轮用量」面板自上线以来从没被打开过**。先赋 id 再渲染修根。

- 真机验收（桩模型 + 4k 小窗口）：摘要 8602 → 3113 tokens（省 64%），检查点展开账目在，
  面板行「摘要 2 条 · 8.6k→3.1k · 省 64%」；退出码三条命令（0 灰 / 1 红 / 7 红）整链 PASS。
- 单元测试 461 项全绿（新增「最后一轮工具段不折叠」「退出码并发不串号」等 10 项）。

### rc.151（versionCode 151）· 2026-10-29 · 浮窗上拖不再露灰缝 + 一轮「不碰观感」的性能清理



两件事：先修一个肉眼可见的视觉瑕疵，再把平时每帧白烧的主线程活砍掉。

**浮窗上拖时底部会撕开一条灰色台阶**（用户实拍）。浮窗是 `bottom:0` 的定高盒子，
上拖那段橡皮筋做的是 `translateY(-12px)`，把**整块连同底边**一起抬走 —— 底边离开屏幕底，
下面露出的就是遮罩（backdrop）而不是面板材质，于是像一截台阶。

- 修法不是加一层补丁，而是「让材质多铺一截到屏外」：面板整体下沉 14px（`--sheet-skirt`），
  同时等量加大 `padding-bottom`，内容盒子、可见高度、按钮位置全部不变（静止态截图逐像素 0 差异）；
  多出来的 14px 就静静躺在屏幕外，专门给上拖吃掉（拖 12px 后底边仍在屏外 2px）。
- 带固定底部按钮的面板（`:has(.sheet-footer)`，如「额度与用量」）与键盘弹起态
  （`html.kb-open .sheet.is-on`）的 `bottom` / `max-height` 同步补上这 14px，可见下沿位置一律不变。
- 纪律：JS 的 `Math.max(-12, dy)` 与 CSS 的 `--sheet-skirt` 必须成对维护，两处注释互相点名。

**性能：只砍「同一帧里本来不需要做的活」**，不动样式、动画时长、缓动与 DOM 结构。

- `applyLang()` 每次切页 / 每次列表重绘都会把**全部文本节点重写一遍同值** —— 每个节点一次
  CharacterData 变更 → 父节点样式失效重算，还会给 MutationObserver 记一条。现在：值没变就不写，
  中文模式（没有可翻译文案）整树扫描直接跳过，只有首次与「英文切回」才全量还原。
- 文本节点的查表结果按节点缓存（原文 / 译文 / 上次写出值三态），英文模式反复渲染不再逐节点跑正则。
- `Native.xxx` 的属性读取加方法缓存：以前每次调用都要对十几个桥对象做 `typeof` 线性扫描。
  缓存**必须懒建** —— 试过启动时预热，反而把冷启动拖慢（`@JavascriptInterface` 每次取值都是跨语言），已回退。
- 原生：表情包仓库不再经 `kernel` 懒加载。装配内核要拉起插件注册表、工具目录、会话日志、钩子链，
  而这里只要一个文件路径；新增 `ToolKernel.stickerFile()` 供桥接层直接建 store，内核仍按需初始化。
  顺带把 `provideService("sticker.store")` 里重复 new 的第二个实例改成同一个。
- 清掉长按入口撤掉后没人再走的死代码：`sheetSessionActions` / `sessLongPress` / 面板里的置顶分支 /
  `TEAM_STATUS` / `VOICE_GENDERS` / `DIFF_TOOLS`。

实测（模拟器 x86_64，同构 debug 包交替安装 A/B）：400 条消息挂在页面上时，搜索框输入 4 个字的主线程
占用 610 → 529ms，连续切 4 页 502 → 466ms；冷启动在噪声内（本次没动启动路径）。四屏截图逐像素比对，
对话中部 / 设置 / 语言浮层 0 像素差异；单元测试 451 项全绿，R8 release 构建通过。

### rc.150（versionCode 150）· 2026-10-29 · 修会话页冷启动闪一下空的「置顶 / 工作区」

冷启动时没有会话，会话页会先闪出「置顶」「工作区」两个空分组再消失。

两处叠加导致：

- `#pinnedSection` / `#wsSection` 是「有数据才存在」的分组，但标记里默认可见，
  真正的隐藏逻辑写在 `renderSessions()` 里；
- `renderSessions()` 要等 `DOMContentLoaded → init()` 才跑，而 WebView 的首帧在这之前就画了 ——
  画的是静态骨架，于是两个空标题先露一下，再被 JS 收走。

修法：

- 两个条件分组在标记里就 `display:none`，由 `renderSessions()` 按实际条数放出来
  （置顶 0 条、工作区 0 个仍不占位）；
- 会话页加 `.pre-boot`，列表区在首版算完之前 `visibility:hidden`（不用 `display:none`，
  避免摘掉时整页跳动），`init()` 里 `try { renderSessions() } finally { 摘掉 }` ——
  万一渲染抛错，也不会把会话页永久留成空白。

验证：冷启动录屏抽帧（10fps / 3.7s）全程无「置顶 / 工作区」；零会话只剩「最近 · 暂无会话」；
带数据时置顶 1 条 + 工作区 1 组 + 最近 1 条均正常显示。

### rc.149（versionCode 149）· 2026-10-29 · 设置页三处修复：检查更新能用了、完成后通知不再是装饰、危险操作判定收口

设置 → 检查更新，点下去只弹一句「当前版本不支持检查更新」。功能本身是好的 ——
**前端没有登记这个原生网关**。

- 原生在 `NativeBridge.domains` 里注册了 `DSHNativeUpdate`，但网页的 `NATIVE_DOMAINS`
  白名单是手写数组，rc.146 加桥时漏了一行，于是 `Native.updateState` 恒为 `undefined`，
  `openUpdateSheet` 第一句判空就把用户挡在门外（一个功能整块哑掉，还没有任何报错）。
- 修法不是"补一行"：白名单现在只表示**优先级**，脚本启动时会把任何没列到的 `DSHNative*`
  注入对象自动追加在后面 —— 同名方法仍以先列者为准，但**新增桥不必再改这里**，
  不会再因为漏登记让一块功能静默消失。
- 同类前车之鉴见 rc.119（清单里的 `android:name` 写错同样静默失败）：凡是"手写清单 + 静默降级"
  的组合，都要么加断言、要么改成自动发现。

**「完成后通知」开关之前是装饰品**：它只写了 `localStorage`，原生侧（`RunService.finish`）
从来没读过 —— 无论开关怎么拨，「已完成」通知都照发。现在：

- 偏好收口到顶层 `AppPrefs`（文件 `dsh`）：`bridge` 与 `notify` 都要读它，挂在任何一边都会让包
  依赖成环；顺手把原 `BridgePrefs` 并进去，全进程只留一个 `SharedPreferences` 实例
  （Activity context 与 application context 各拿一份会互不同步，这条坑以前踩过）。
- `NotifyBridge.setNotifyDone/notifyDoneEnabled` + `RunService.finish` 三个条件同时判定：
  不在前台、不是用户主动停止、**开关为开**。「执行失败」与「需要你确认」不受开关约束 ——
  它们属于待处理事项，关掉完成提醒的人也不希望任务悄悄挂掉。
- 打开开关时当场核对系统通知是否被关掉（`notifyInfo().notificationsEnabled`），没授权就直说
  发不出来 —— 否则又是一个"开了却没反应"。

**「危险操作前询问」**：链路本身是通的（`askDanger → needConfirm → Gate.confirmDanger →
approval_request 卡片`），但判定逻辑埋在 pipeline 的 waterfall 里，只能靠跑真模型回合验证。
现在抽成纯函数 `DangerGuard.reason(name, args)`：

- 破坏性动词按 POSIX / Windows 两套正则分开（原来漏了 Windows 侧的 `Remove-Item` 一族）；
- **有意不剥离引号内容**：`sh -c "rm -rf /"` 是最危险的一类，剥引号会把它放过去；
- 新增 `DangerGuardTest`（6 个用例）钉住「开关关 = 判都不判」「完全授权下开关不生效」
  「日常命令不打扰」，不必再靠真机跑一轮对话验证。

**顺手修红灯**：`CompanionEngine` 在 `object` 初始化里就 `Handler(Looper.getMainLooper())`，
JVM 单测（无 Looper）一碰这个类就 `ExceptionInInitializerError`，整份 `CompanionEngineTest`
11 个用例常年全红 —— 门禁一红就没人看。改成 `by lazy` 后全量单测 451 项转绿。

### rc.148（versionCode 148）· 2026-10-29 · 更新下载改为后台进行（前台服务 + 完成即进安装页）

点「立即更新」后用户十有八九会切走（几百 MB 要好几分钟）。以前下载跑在桥的普通后台线程里，
进程被回收就断在半截，而且没有任何可见反馈。

- **前台服务 `UpdateService`**：`startForeground` 钉住进程，通知栏显示实时进度
  （`正在下载新版本 46%` + 来源 `ghfast.top`）。切到别的应用、锁屏都继续下。
- **下载完成后自动进安装页**，两条路各管一种场景：
  · **App 在前台**：服务推 `ready` → 前端 `DSHHost.onUpdate` 里直接 `updateInstall()` → 安装器弹出；
  · **App 在后台**：通知换成「下载完成 · 点此安装」，其 `contentIntent` 就是一个指向系统安装器的
    `PendingIntent` —— 用户点击那一刻属于前台交互，不受 Android 10+ 后台启动 Activity 的限制，
    所以不用先回 App 再跳一次。
- **状态总线 `UpdateBus`**：服务可能比 WebView 活得久（后台下载正是这么用的），
  所以不让服务依赖桥 —— 服务往总线里塞状态，桥在 `init` 里挂 listener 转成 `onUpdate`。
  App 被杀时 listener 为 null，只走通知栏。
- 服务用 `foregroundServiceType="specialUse"`（与项目里另外三个常驻服务一致），
  通知小图标统一 `R.drawable.ic_notify`（不用 launcher 图标，那在通知栏会显示成白块）。
- 浮窗里 `ready` 态补了「安装」按钮：重开浮窗看到的是同一个状态，手动点一下即可。

### rc.147（versionCode 147）· 2026-10-29 · 更新源实测校正：镜像按速度排序 + 修 API 回退失效

用真实资产地址逐源实测（本机，取前 2MB）：

| 源 | 2MB 耗时 | 速度 | 处理 |
|---|---|---|---|
| `ghfast.top` | 9.3s | ≈225 KB/s | 排第一 |
| `gh-proxy.com` | 19.9s | ≈105 KB/s | 排第二 |
| `ghproxy.net` | 40s 超时 | ≈11 KB/s | **移出列表**（与官方同档，白等一轮） |
| 官方 github.com | 40s 超时 | ≈14 KB/s | 只作保底 |

- **修一个会直接让「检查更新」失败的问题**：`releases/latest` 也走了「镜像优先」，而这些代理
  对 `api.github.com` 常回一个 **200 的 HTML 错误页** —— 旧代码只判 HTTP 状态码，把 HTML 当结果
  返回，外层 JSON 解析一炸就整次失败，且**不会回退到官方**。现在：
  · API **官方优先**（只有几 KB，代理反而不支持）；
  · `httpGetFirst` 增加「首字符必须是 `{` / `[`」的校验，不合格就继续试下一个地址。
- **源名称改由原生给**：`UpdateCenter.sourceLabel(idx)` 把序号翻成 `ghfast.top` / `GitHub 官方`
  再推给前端。以前前端按 `src > 3` 猜，镜像增删一次就错位一次。
- 下载侧的两道校验保持：HTTP 2xx + 首字节 `PK\x03\x04`（挡镜像的 HTML 错误页）。

### rc.146（versionCode 146）· 2026-10-29 · 设置页新增「检查更新」：镜像优先、GitHub 保底

设置 → 检查更新。没有变化时一个浮窗告知「已是最新版」；有新版显示版本号、包大小与更新说明，
点「立即更新」开始下载并显示进度，下完自动拉起系统安装器。

- **数据保留**（覆盖安装的前提，两条缺一不可）：
  · 同 `applicationId` + 同签名原地升级 —— 系统保留 `/data/data/<pkg>`，会话、记忆、设置全在；
  · 装之前先 `PackageManager` 比对**包名 + 签名**，不一致直接拒绝并说明原因。
    否则用户会等完几百 MB 才在系统那一步被拒（或者更糟：装成另一个应用、旧数据读不到）。
- **下载源：镜像优先，GitHub 保底**。直连 `github.com` / `objects.githubusercontent.com`
  国内常常只有几 KB/s，200 多 MB 的包基本下不完。候选顺序是
  `gh-proxy.com` → `ghfast.top` → `ghproxy.net` → 官方地址，逐个尝试，浮窗上会显示当前用的是哪个源。
  每个源都要过两道校验才认：HTTP 2xx + **首字节必须是 `PK\x03\x04`**（APK 是 ZIP）——
  镜像挂掉时经常返回一个 200 的 HTML 错误页，不校验就会白下几百 MB 垃圾。
- **线程模型**：`@JavascriptInterface` 跑在 JS 线程，网络/写盘一律丢到单独的 `dsh-update` 线程；
  三个入口（check / download / install）都立即返回，状态经 `window.DSHHost.onUpdate` 推回前端，
  浮窗只重画 `#upBody` 一块（整表重开会随进度不停闪）。
- **UI（改过一版）**：第一版做成「圆形图标 + 居中标题 + 灰底说明卡片」，太花、像广告弹窗，删掉重做。
  现在只有：一行标题（`发现新版本 rc.146`）+ 一行小字（当前版本 / 包大小）+ 两个按钮；
  下载态是一条 6px 进度条。**不做图标块、不做灰底说明区，也不再显示 Release 正文**
  （那是一大段 changelog，小浮窗里只会把按钮挤下去）。设置行图标是新画的**环形箭头**
  （`i-refresh`），刻意不复用现有的直线箭头类图标。

### rc.145（versionCode 145）· 2026-10-29 · 去掉输入框聚焦时的「一圈黄边」+ 补聚焦反馈

用户实测：全局记忆的添加框点进去会冒出一圈**黄色方角描边**。

- **根因**：`.mem-add input` 只写了 `border: 0`，**没清 `outline`**。Android WebView 在聚焦时
  会画系统默认聚焦环，而部分定制 ROM（荣耀/华为等）用它自己的**主题色**——实测是黄色；
  这个环还是**方角**的，套在 22px/25px 圆角的胶囊里非常突兀。
- **而且**：输入框是透明底 + 无边框，外层胶囊也没有任何聚焦反馈 —— 就算没有黄环，
  用户点了输入框也看不出「现在在哪儿输入」。
- **修法**：
  · `input, textarea, select { outline: none }` 全局清掉系统聚焦环（含 `:focus-visible`）；
  · `.mem-add:focus-within` 给**整条胶囊**加一圈蓝环（`rgba(0,122,255,.28)`，与 iOS 蓝一致），
    聚焦反馈的形状跟着胶囊走，不再有方角；
  · 记忆条目的编辑框 `.mem-input` 同样清 outline，聚焦时用 `box-shadow` 蓝环（形状随 11px 圆角）；
  · 补 `:-webkit-autofill` 覆盖：部分 ROM 判定「可填充」时会给输入框染黄底/黄边，
    统一压平为卡片色 + 主题文字色。

### rc.144（versionCode 144）· 2026-10-29 · 设置项改名：「查看系统提示词」→「查看用户提示词」

用户指出命名不准：那个入口里显示的是**自己写的角色设定**（会拼进 system prompt 的那一段），
不是完整的系统提示词 —— 叫「系统提示词」会让人以为能看到身份、环境、工具清单、工作区规则。

- 设置行文案：`查看系统提示词` → **`查看用户提示词`**（`index.html`）。
- 查看器标题：`系统提示词` → **`用户提示词`**；副标题从「只显示你的角色设定」改为
  「你写的角色设定，会拼进系统提示词一起发给模型」，把关系说清楚。
- i18n 词条与代码注释同步（`View user prompt` / `User prompt`），避免中英混用。
- 未采用「回放完整 system prompt」的方案：那需要新增原生接口读会话日志里的
  `system/message`，与「用户提示词」这个定位不是一回事，先不做。

### rc.143（versionCode 143）· 2026-10-29 · 修：设置页「系统提示词」一直显示「未设置」

用户反馈：已经开了角色设定，设置里「系统提示词」这一行还是「未设置」。

- **根因**：`#promptValue` 只在 `app.js` 初始化时算**一次**（`personaPrompt().length`）。
  选角色、切强度、保存自定义正文这三处都只更新了同组的「角色设定」值（`#personaValue`），
  没有重算提示词行 —— 于是同一会话里它永远停在启动那一刻的值；选的若是预设角色，
  重启后才会变。
- **修法**：抽出 `refreshPromptRow()`，初始化与三处变更都调用它（角色 / 强度 / 自定义正文）。
- **顺带**：没有角色时文案从「未设置」改成「默认」。默认人格本来就没有额外段落，
  写「未设置」容易让人以为设置没保存 —— 而且和左边「角色设定：默认」自相矛盾。
- **验证（无头 Edge 实测）**：初始 `默认 / 默认`；点开角色面板选「代码评审员」→
  立即 `代码评审员 / 235 字`；切「强」档 → `474 字`；写 `dsh.persona=sre` 后重载 →
  `SRE 工程师 / 214 字`，查看器里能看到完整角色段落；**自定义正文**保存后 → `自定义 / 91 字`，重开面板能回填原文 —— 预设、自定义、强度三档全部当场生效。

### rc.142（versionCode 142）· 2026-10-29 · 去掉网页里那套模拟状态栏（冷启动会露出来）

- **现象**：冷启动时应用顶部出现一条**自绘状态栏**（`9:41` + 信号 / WiFi / 电池图标）。
- **根因**：`index.html` 里还留着一套「模拟 iPhone 外壳」——`.statusbar`（假状态栏）和
  `.island`（黑胶囊），只靠 `html.native .statusbar { display:none }` 隐藏；而 `html.native`
  这个类要等 `app.js` 初始化时（原第 14710 行）才加上 —— **冷启动第一帧必然露出它**，
  JS 一旦报错还会一直露着。
- **修法**：直接删干净，而不是继续靠运行时加类去遮：
  · `index.html` 删掉 `.statusbar`（含 4 个图标 SVG）与 `.island`；
  · `styles.css` 删掉 `.statusbar` / `.sb-right` / `.sb-ico` / `.sb-batt` / `.island` 及其
    `html.native` 覆盖规则，只保留 `html.native { --safe-top: 32px }`（原生壳给的顶部安全区）；
  · `app.js` 删掉每 30 秒更新 `#sbTime` 的定时器，`nowTime()` 随之成为死代码，一并删除
    （否则 `$("#sbTime").textContent` 会在元素不存在后抛错）。
- **验证**：无头 Edge 打开首页，`.statusbar` / `.island` / `#sbTime` 均不存在，顶部为干净留白，
  标题/搜索/列表/底部标签栏布局正常，`--safe-top` 仍生效（浏览器 54px、native 壳 32px）。


### rc.141（versionCode 141）· 2026-10-29 · 修：「需要你确认」通知在应用内处理后不消失

用户实测：权限/追问/计划请求在应用里点了同意或拒绝，通知栏那条提醒还挂着。

- **根因**：提醒通知的 id 是固定的 `NOTI_ATTN`，只设了 `setAutoCancel(true)` ——
  它**只覆盖「点通知」这一条路**。应用内点同意/拒绝/回答/批准计划走的是
  `agentApprove` / `agentApproveScope` / `agentAnswer` / `agentPlanDecision`，
  这些路径**没有一行代码去 cancel**，于是通知一直留在通知栏。
- **修法**：`RunService` 按请求记账（`requestKey` = `approval|<id>` / `ask|<id>` /
  `plan|<sessionId>`），`AgentBridge` 的四个处理接口各调一次 `resolveAttention`：
  · 处理完一条就收掉它的通知；
  · **还有别的请求在等时换成最新那一条，而不是直接 cancel** —— 通知 id 是共用的，
    后来的请求会覆盖前一条，一律 cancel 会把别人的提醒也吞掉（「批准 A，B 的提醒没了」）；
  · 一轮结束/被停止（driver `finally`、`agentCancel`、`RunService.finishNow`）清掉
    该会话/全部待处理 —— 驱动没了，没人再等这些答案，提醒不该留着；
  · `setActiveSession`（用户切回该会话）清空账本，避免之后处理请求时按旧记录
    重发一条「幽灵提醒」。


### rc.140（versionCode 140）· 2026-10-29 · 团队：成员会话按桌面语义补齐

对照 `packages/experimental/agent-team` 逐项核对后，补掉成员会话视图与桌面的三处差距。

- **历史不再只给最近 120 条**：`teamMemberLog` 原来 `takeLast(120)`，用户看到的是「它只做了最后几步」。
  现在回全部（一次渲染上限 600 条，超出取尾部），并通过 `total` / `hasMore` **如实告知**被截断，
  首次进入时提示「只显示最近 N 条（共 M 条）」—— 桌面能一直往上翻到第一条，这里至少不再静默丢。
- **工具过程可见**：原来只回 `user/message` 与 `assistant/message`，把 `tool/result` 全过滤了 ——
  而「reviewer 到底看了什么」的主体正是工具。现在三类一起回（带 `kind`），前端按
  `NODES.tool` + `toolCategory()` 渲染成折叠的工具行，与桌面一致的观感。
- **修一个隐藏的增量 bug**：前端用「数组长度」当游标（`v.seen`）。一旦后端只回尾部一窗，
  窗口会随总数增长向左滑，`i` 从旧长度起、而旧长度 ≥ 新窗口长度 → **一条新消息都渲染不出来**
  （会话超过 120 条后成员说话界面就不动了）。改成按**全局序号**对齐（`offset = total - len`，
  游标记 `seenTotal`），窗口滑动也不会漏。
- **实时性确认（本来就是对的，注释写清）**：成员活动走 `bump()` → 推送团队快照
  （`ev.t === "team"`，800ms 节流）→ 前端立即拉增量；2.2s 轮询只是兜底，不是主通道。


### rc.139（versionCode 139）· 2026-10-29 · 修复：从成员会话退出后回不到原对话、历史显示错内容

用户实测两点：① 在团队成员（teammate）会话里点退出，**回不到原来的对话**；
② 退出去再从会话列表点回原对话，**历史显示的是「刚给成员颁布的任务」**（其实是上一屏的残留），
但新发一轮的上下文又是对的。

- **根因**：`openSession()` 的 `sameRunning` 分支（「同一会话还在跑就直接回到界面」）**只在
  真灌了新历史时才重绘**。从成员视图切回来时桶已经换了（`team:…#名字` → 会话 sid），
  但 DOM 里还是成员会话的内容 —— 不重绘就把上一屏留在那里了；而 `state.sessionId` 一直是对的，
  所以新发一轮的上下文/落盘都正确，形成「显示错、上下文对」的怪现象。
  退出按钮那条路径则是另一处问题：`exitTeamView` 用进入前记下的 `thread.__sid` 作为归处，
  那个值可能是空串（进入前是空态），于是 attach 到空桶 → 看起来「没退回去」。
- **修法**：
  · `sameRunning` 分支记录 attach **前后**的桶 key，`hydrated || switched` 才重绘 ——
    换了桶必须重建，没换才保持「不打断流式」的初衷；
  · `exitTeamView` 统一走 `openSession(parent)`：attach 到该会话自己的桶、必要时从库补齐、
    刷新标题与模式栏，一处收口；父会话已不存在（被删/占位 sid）则回空态，
    绝不把成员会话的内容留在界面上冒充用户的对话；
  · 团队视图的归处**只保留 `parent` 一个字段**（删掉冗余的 `mainKey`），
    进入时 `teamSid()` 只求值一次，保证 `teamOpen()` 与退出定位指向同一会话；
  · 去掉 `persistThread()` 里 `state.teamView` 的显式 return —— 分桶后
    `thread.__sid !== sessionId` 的自检已经覆盖，少一条并行规则。
- **结构检查**：`mainKey` 已无残留；`"team:"` 前缀只有「进入时拼 key」与「增量归属校验」两处、
  拼法一致；`bucketOf()` 只被 `attachThread()` 调用，外部一律走三个语义化入口。
- **连带修掉一个隐患**：整表重绘后 `Live.textEl` 仍指向已被移除的旧元素，后续 delta 会写进
  游离节点（「只有终止按钮、正文一片空白」）。新增 `rebindLiveDom()`，在 `renderThread()`
  末尾按 `data-uid` 把正文容器重新绑上 —— 这样「换了桶必须重绘」才真正安全。


### rc.138（versionCode 138）· 2026-10-29 · 删除会话弹层误弹模型配置 + 深色下回前台闪白

用户实测：会话页工作区点「选择」→ 勾选要删除的会话，**点某一条会话本该打勾，却弹出了模型配置浮层**。

- **根因：属性名撞车 + 同一个点击分发里的顺序**。弹层点击都走 `#sheet` 上的同一个大 handler，
  里面有两段用 `[data-pick]` 找元素：
  · 上面那段属于**模型表单的模型选择列表**（`sheetModelPicker`），命中就 `openSheet(sheetModelForm(...))`；
  · 下面那段才是**多选删除**的勾选切换。
  两处用了同名属性 `data-pick`，而模型那段排在前面并 `return` —— 于是点会话先被它截走，
  直接打开模型表单，删除弹层的勾选逻辑根本没跑到。
- **修法**：把模型选择项改成 `data-pick-model`（`sheetModelPicker` + 对应 handler 一起改），
  `data-pick` 从此只用于会话多选。两段判断各加注释说明为什么不能同名。
- **顺带审计**：扫了全部 100+ 个 `data-*` 属性与它们的 `closest()` 用法，另有 6 组被多处匹配
  （`data-uid`、`data-neural-id`、`data-sess-pin/rename/move/del`），逐个确认后都安全 ——
  它们分属不同容器（`#sheet` vs `#sessionsScroll`）或不同界面（音色浮层挂在 `popEl`、不在 `#sheet` 内），
  不会在同一次点击的两段逻辑里撞车。

#### 深色模式从桌面回到应用会闪白

- **现象**：深色模式下，应用在后台放一段时间再回来，界面先闪一下白/浅色，才变回深色。
- **根因（两处叠加）**：
  1. `index.html` 里 `<html data-theme="light">` 是**写死**的 —— 主题要等 `app.js` 初始化时
     `applyTheme()` 才切。渲染进程被系统回收后重载（"过段时间"正是这个）先画的一帧就是浅色底。
  2. 原生根容器 `setBackgroundColor(R.color.app_bg)` 固定用**浅色**，而 `WebView` 是
     `setBackgroundColor(Color.TRANSPARENT)` —— 页面还没绘制时露出的就是这层浅色。
- **修法（三道保险）**：
  · `index.html` 在 `<head>` 里、**样式表之前**加了内联脚本：从 `dsh.theme`（与 app 同一个键）
    读主题，立刻写 `data-theme` 和内联 `background-color`，不等 CSS 加载；
  · `applyBarAppearance(dark)` 里同时更新 `window` 与根容器底色（新增 `bgColor()`：
    浅 `#F2F2F7` / 深 `#000000`，与 CSS `--bg` 对齐），主题切换即时生效；
  · 根容器初始化就按 `barDark` 偏好取色，不再是恒定浅色。




### rc.137（versionCode 137）· 2026-10-29 · 按压高亮：贴边圆角 + 满宽无缝（深色下无灰边）

用户给了一张目标效果图：**整行高亮铺满到卡片边缘、贴边那一侧的两个角是圆的、行间分隔线保留**。

- **贴边圆角**：卡片（`.group` / `.list`）是 16px 圆角，第一行/最后一行视觉上"外面是圆的"，
  但盒子仍是矩形 —— 末行按下时高亮在卡片圆角处露出两个直角。容器的
  `overflow:hidden` + `border-radius` 在真机 WebView 上**不保证**裁得住子元素背景，
  所以让贴边的那一项**自己**带上对应的两个圆角：
  `.group > :first-child` 圆上两角、`:last-child` 圆下两角（`.list` 同理，含
  `.sess-row:first/last-child > .session-item`）。中间行保持直角 —— 高亮才连续，
  不会像 rc.135 那样被拆成一个个独立胶囊。
- **左右"灰边"**：行的高亮此前用半透明 `--fill-2`（深色 18% 灰）。半透明铺满整行时，
  左右边缘与卡片边缘的抗锯齿像素混成一条更暗的过渡带，深色主题下对比大，肉眼就是
  「左右各有一条灰边」。统一改为不透明实色 `--press`（深 `#2d2d30` = 卡片底 + 18% 灰，
  视觉完全一致）后，边缘干净无缝。`.row` / `.perm-row` / `.search-item` / `.deliver-item`
  一并改；`.sheet-item` 在玻璃弹层上，保持半透明叠加。
- **验证**：无头 Edge（深色、真实 `index.html`、DSF=3）量得按下行与卡片
  `left/right` 完全一致（446 = 446，左右差 0），首行 radius `16/16/0/0`、末行 `0/0/16/16`、
  中间行 `0`；按下背景 `rgb(45,45,48)` 不透明。


### rc.136（versionCode 136）· 2026-10-29 · 按压态形状与元素形状严格一致

承接 rc.135。用户要求「按压态形状必须和按钮本身形状相同」，据此把上一版**过度修复**的地方收回，
并把真正会让形状变形的按压变换全部去掉。

- **收回**：rc.135 曾给列表行（`.session-item` / `.row` / `.perm-row` / `.search-item` /
  `.deliver-item`）补 16px 圆角，让「矩形行」按下变成一个个独立圆角块 —— 这反而不符合
  「形状 = 自身形状」。行本身是矩形，高亮就该是矩形，边缘由卡片容器（`.list` / `.group`
  的 `overflow:hidden` + 16px 圆角）裁剪成圆角，这正是 iOS grouped list 的做法。
- **真正的矩形来源**：`.session-item:active { transform: scale(.985) }` —— 按下瞬间给行加了
  变换，元素被提升为合成层，而 **Android WebView 对合成层子元素只做矩形裁剪**，容器的 16px
  圆角失效，首行/末行按下就在卡片四角露出直角。删除该规则（按压只保留背景色反馈，
  与 iOS 列表行一致）。
- **补上缺失的反馈**：设置页概览卡 `.profile-card`（`role=button`）此前按下**毫无视觉变化**；
  它是 `backdrop-filter` 玻璃，不能替换背景，改为叠加一层半透明灰（形状跟随自身 20px 圆角）。
  `.pro-chip`（登录按钮）同步补按压色。
- **保持不变**（rc.135 已正确）：`--press` 实色令牌（浅 `#f4f4f6` / 深 `#2d2d30`）；
  堆叠卡按住时不再给祖先加 `transform`，改由底下两张「卡片边」下沉 1px。
- **验证（无头 Edge + CDP 强制 `:active`，鲜红底暴露直角）**：
  列表首行/末行按下 → 高亮为矩形、左右上角随卡片圆角裁剪，无直角溢出；
  堆叠卡 16px、概览卡 20px、追问选项 11px、菜单项 10px、芯片 8px、圆钮 50% ——
  全部等于元素自身圆角；设置页 28 个 `.row` 全部有反馈。


### rc.135（versionCode 135）· 2026-10-29 · 按压态修正：不再变透明、不再变矩形

用户实测两点：长按堆叠区最上层卡片，**下半部分会变透明**；接着问「按压态为什么是矩形」。

- **变透明的根因**：`.ws-head:active { background: var(--fill-2) }` —— `--fill-2` 是
  `rgba(118,118,128,.08)`，**8% 不透明**。它当作 `background` 会**替换**掉不透明卡片底，
  整块瞬间变成 92% 透明；`.ws-group` 自身又是 `background:none`，没有兜底底色，
  于是长按时卡片（尤其只有 padding 的下半部分）直接透出后面的列表与叠层。
  会话行同款写法还会把底下的左滑按钮透出来（「闪一下编辑态」）。
- **矩形的根因**：按压时 `.ws-group:has(.ws-head:active) { transform: scale(.985) }` 给
  **祖先**加了变换，把头部卡片推进合成层；Android WebView 对合成层只做**矩形裁剪**，
  16px 圆角的按压高亮就被切成直角。列表行则相反 —— 自身是矩形、圆角全靠 `.list` 的
  `overflow:hidden` 裁，同样在合成层下失效。
- **修法**：
  · 新增 `--press` 令牌（浅色 `#f4f4f6` / 深色 `#2d2d30`），等价于「卡片底 + 8% 灰」的
    **实色**：视觉一致但始终不透明，`background` 过渡也还能生效。所有「自带不透明底」的
    按压态（`.ws-head`、`.session-item`）改用它。
  · 去掉祖先变换：按住堆叠头不再缩放整组，改成**底下两张「卡片边」各下沉 1px**
    （读起来仍是整摞被按住），按压高亮留在普通绘制层，圆角不再被裁。
  · 给列表行自身补圆角（`.session-item` / `.row` / `.perm-row` / `.search-item` /
    `.deliver-item` / `.sess-row` = `--radius-md`），高亮形状不再依赖祖先裁剪。
  · 顺带修一个真 bug：展开态组内会话行按下**完全没有反馈** ——
    `.ws-group.is-open .session-item.in-ws`（0,4,0）盖掉了 `.session-item:active`（0,2,0），
    补一条同特异性的按压规则。
- **验证（无头 Edge + CDP 强制 `:active` 读计算样式，不靠肉眼）**：
  13 个按压元素全部「有反馈 + 高亮圆角 = 元素自身圆角」（16/14/11/10/8/50%，无一为 0 直角）；
  `.ws-group` 按压时 `transform` 为 `none`；截图确认四角圆润、无直角溢出。


### rc.134（versionCode 134）· 2026-10-28 · 会话串号根治：对话流按会话分桶（对齐桌面端 per-session 语义）

rc.133 只堵住了「延迟深拷贝」一处竞态，仍然治标 —— 因为 `thread` 依旧是**全局唯一**的可变数组，
任何一处「改了 `state.sessionId` 却没换数组」的路径都会继续串号。这次按桌面端的结构语义重做。

- **根因（结构层面）**：手机端是 `LocalDB.saveShot(state.sessionId, shotNode(thread))` ——
  用「当前渲染的全局 thread」覆盖写入「当前 sessionId 的槽位」。只要两者有一瞬间不同步就会串，
  而且写坏的快照不会自愈。桌面端从来没有「把当前窗口内容写回某个会话 id」这个动作：
  每会话一份不可变日志、只追加，由内核按会话身份落盘，前端只是读者 —— 结构上不可能串。
- **修法：对话流按会话分桶**。`thread` 从 `const []` 改成「当前会话那一份的引用」，
  由 messages 段的一组生命周期函数统一管理（切会话只能走这三个入口）：
  `attachThread(key)` 切到某会话并返回其桶、`attachBlank(key)` 开一份空白新流（新会话/删除后）、
  `adoptThread(key)` 接管刚建好的会话（免再从库灌）。各会话的数组物理隔离，切会话只换指针。
  · 覆盖全部入口：`openSession`（含 sameRunning 重载恢复）、`handleSend` 首次建会话、
    目标模式新建/续跑、`ensureSession`、`startNewSession`、删除/归档、成员会话视图、
    电脑中继会话、宿主机会话 —— 每一处都显式换桶，不再有「只改 sessionId」的路径。
  · 已加载过的会话**直接复用内存里那份**（思考展开、工具行开合、正在跑的 Live 节点都还在），
    不再「清空 + 从库重建」；从库灌入抽成幂等的 `hydrateThread(s, bucket)`，只在首次加载执行。
  · LRU 上限 8 份，淘汰前先落一次快照；**正在跑的那份永不淘汰**（否则 Live 指向游离节点，
    回来就是「只有终止按钮、正文全空」）。
- **写入身份自检（结构性防线）**：`persistThread()` 落盘前校验 `thread.__sid === state.sessionId`，
  不符就跳过 —— **宁可这一轮漏存，也绝不写错会话**。将来新增任何路径忘了换桶，最坏是漏存。
- **事件归属校验**：`AgentBridge` 给每条 `onAgent` 事件注入 `sessionId`（delta/reasoning 与
  工具/错误事件都带）；前端 `NativeAgent.on()` 只渲染 `thread.__sid` 匹配的事件 ——
  用户切走后旧会话的正文/思考继续到达时直接丢弃（这是串号的另一条路径）。
  同时修 `finally` 里的顺序：先冲刷残留聚合内容再清 `roundSession`，否则最后一批 delta 缺身份。
- **异步写一律带归属检查**：宿主机历史 `Host.call(...).then`、电脑会话轮询 `PcRun.append`、
  成员会话轮询 `refreshTeamViewMessages` —— 回来时用户可能已经切走，身份不符直接丢弃。
- **验证**：从 `app.js` 抽取**真实源码片段**跑 Node 单测（不是复制一份逻辑），
  13 项全通过：切会话互不影响、身份不符拒写、LRU 不淘汰在跑的/当前的、三种 attach 语义、幂等。
- **注意**：已经被旧版本写坏的历史快照无法自动还原（数据里没有「这段属于谁」的标记）；
  装上后用过的会话从此写入正确，个别仍显示别人内容的旧会话删掉重开即可。


### rc.133（versionCode 133）· 2026-10-28 · 修复会话串号（止血）：点 A 进去看到 B 的内容

用户反馈：会话列表是对的，但点进某个会话，对话页显示的是**另一个会话**的内容。

- **根因**：`persistThread()` 为了不卡流式渲染，把 `shotNode(thread)`（深拷贝快照）放进了
  `requestIdleCallback` 里**延迟执行**。但 `thread` 始终是**同一个数组引用** —— 切会话时
  `openSession()` 会先 `thread.length = 0` 再灌入新会话，空闲回调若在这之后才跑，
  拷到的就是「新会话内容」，却写进**旧会话的 sid** → 会话串号。列表读的是 title/摘要，
  所以看起来正常。
- **修法**：`persistThread()` 里**同步深拷贝**快照（`shotNode`），再把 stringify + 落盘交给空闲回调。
  深拷贝是 O(整段对话)，但只在切片/轮末/每 8 秒发生，换正确性值得。
- **注意**：已经被写坏的历史快照无法自动还原（数据里没有来源标记）；重新聊过或新建的会话写入正确。

### rc.132（versionCode 132）· 2026-10-28 · 会话堆叠叠层改「白纸边」＋ z-index 层次修正

用户反馈：浅色模式下堆叠中间层还是不对。

- **根因**：叠层用 `filter: brightness(.93/.86)` 压暗白色卡片来区分层次。浅色主题里 `--card`
  是 `#fff`、`--bg` 是 `#f2f2f7`，压暗后 `#EDEDED / #DBDBDB` 反而**比背景更暗** ——
  读起来是两条灰色台阶/阴影，而不是纸边。
- **修法**：不再用亮度压暗表达层次，改为 **`background: var(--card)` + `0.5px solid var(--sep)`
  细边**（`box-sizing: border-box`），亮度只留极轻的 `.985/.97` 防止纯白在浅色底上变成
  「白光带」。叠层因此是「白纸 + 细边」，浅色下干净、深色下同样成立。

### rc.131（versionCode 131）· 2026-10-28 · 陪伴保活通知改有声，去掉「只是保活，不响铃」

用户反馈：陪伴式畅聊的通知没有声音，通知上还写着「这里只是保活，不响铃」。

- **根因**：保活前台通知走 `dsh_companion_keep` 通道，`IMPORTANCE_MIN` + `setSound(null)` +
  `enableVibration(false)` + 通知 `setSilent(true)` + `PRIORITY_MIN` —— 它被系统收进「静默」区，
  自然没有声音。而「陪伴开口」的通知走的是另一个 `IMPORTANCE_HIGH` 通道，本来是有声的。
- **修法**：通道换新 ID `dsh_companion_keep_v2`（**Android 不允许修改已创建通道的重要性**，
  旧 MIN 通道改不动，只能换新 ID 让升级用户也生效）→ `IMPORTANCE_DEFAULT`，去掉
  `setSound(null)` / `enableVibration(false)`；通知去掉 `setSilent(true)`、
  `PRIORITY_MIN` → `PRIORITY_DEFAULT`；文案改为「到点它会主动开口，陪你聊两句」。
  另加 `setOnlyAlertOnce(true)`：常驻通知会随在跑名单更新，只在首次出现时响，不反复打扰。

### rc.130（versionCode 130）· 2026-10-28 · 会话堆叠「中间层又长又厚」修正

用户截图：工作区堆叠卡片底下那层几乎和主卡同宽、露出很厚，像一条白带。

- **根因**：`.ws-group.is-stacked::before` 只缩进 6px（宽度 ≈ 主卡），并沿用 `--radius-md`
  （16px）的大圆角；再叠上 `brightness(.96)` 的偏亮白 → 在浅色页面上就是一条又长又厚的
  弧带，读不出「纸边」。
- **修法**：缩进 6px → **12px**（第二层 16 → 24px），圆角 16 → **12px**，亮度 .96/.90 →
  **.93/.86**，露出高度 6/11px → **5/9px**，阴影同步减轻。叠层收窄变薄后是清楚的「还压着
  一张」，不再是厚白带。

### rc.129（versionCode 129）· 2026-10-28 · 修复流式输出截断 / 顺序错乱 / 字面量 null

用户反馈：Agent 回复与分析都被截断、输出顺序错乱，偶尔整段只输出 `null`。

- **根因（对照电脑端定位）**：电脑端传输层**逐条发**、合帧只在渲染侧（rAF + `IncrementalMarkdownParser`
  按 position 冻结尾部 2 块）。手机端在桥出口多了第二层 `StreamCoalescer`，而它的 `flushAll`
  把 `send` 放在**锁外** —— agent 线程（工具事件前 flush / 轮末）与主线程 `tick` 会并发 flush，
  两批 `webView.post` 交错投递。前端按到达顺序 `Live.text += r.text` 拼接，
  于是正文/思考**乱序**；而 `sealedCut` 是按「只追加」假设做增量冻结（电脑端有 generation
  处理非追加输入，手机端没有），乱序后冻结边界与内容错位，表现为**截断**。
- **修法**：`flushAll` 的 `send` 移入同步块串行执行 —— `webView.post` 的投递顺序即调用顺序，
  与电脑端「传输层严格保序」的纪律对齐。
- **`null`**：部分端点把 JSON null 序列化成**字符串 `"null"`**，原 `isNull()` 检查放不过它。
  `LlmClient`（OpenAI 兼容）与 `MessagesApi`（账号端点）对 `content` / `reasoning_content` /
  `text` / `thinking` 值为 `"null"` 时一律跳过，不再输出字面量。

### rc.128（versionCode 128）· 2026-10-28 · 修复 rc.127 回归：新建会话后对话页透出会话页

用户截图反馈：从会话页新建会话后，对话页中间大块灰色、露出会话页的搜索框和「最近 3 条」。

- **根因（rc.127 引入）**：`settleScreenTween` 为了让压暗层跨 push→pop 保留，对底层会话页
  整块 `return` 跳过了清理 —— 连 `is-leaving` 和 `zIndex` 都没复位。`.screen` 非 active 时
  默认 `visibility:hidden`，唯一让会话页仍可见的正是残留的 `is-leaving`；同时对话页的
  `tween-shadow`（提供 `background:var(--bg)` 不透明底）被正常清掉而变透明 → 直接透出下层。
- **修法**：改写为 `keepDim` 分支——push 完成后**保留**底层会话页的 `tween-under` 类与
  `--under-dim`（供 pop 连续淡出），但**其余复位照做**（移除 `is-leaving`/`tween-shadow`，
  复位 `zIndex`/`visibility`/`transition`/`transform`/`opacity`），让底层页真正隐藏、归位。
  pop 时 `go()` 重新给会话页 `is-active`，压暗层从 `.14` 连续淡出，两端仍柔和、也不再透出。

### rc.127（versionCode 127）· 2026-10-28 · pop 返回「闪暗、变化太直接」根治：压暗层连续对称过渡

用户反馈：rc.126 之后返回会话页仍觉得压暗「闪一下、变化太直接」，不够柔和。

- **根因**：rc.126 只在 pop 时让压暗层淡出，但进入对话页（push）后 `settle` 把底层会话页的
  `tween-under` 类和 `--under-dim` **清掉了**。于是返回（pop）时 `go()` 又给会话页**重新加**
  `tween-under` 类，`::after` 伪元素以 `.14` **瞬间出现**——等于「会话页先啪地变暗，再淡亮」，
  这就是「闪暗、变化太直接」；进入那一下伪元素一加类也是 `.14`，同样生硬（无淡入）。
- **修法**：压暗层改为**跨 push→pop 持续保留**、两端对称连续驱动——

  1. `go()` 记录 `st.chatUnder = under` 与 `st.keepUnder = push`；进入时先把底层 `--under-dim`
     置 `0`（透明）**再加类**，加类那帧伪元素透明出现、下一帧 rAF 才升到 `.14`，进入柔和不闪；
  2. `settle` 在 `keepUnder` 为真时**跳过底层会话页**的 `tween-under`/`--under-dim` 清除 ——
     进入对话页后底层一直压暗（被对话页盖住无视觉影响），直到返回才清；
  3. pop 的 rAF 把底层 `--under-dim` 设 `0`，因底层本就持续 `.14`，故是「从暗连续淡出到 0」，
     **不再有先暗后亮的硬跳**；压暗层过渡与滑动同拍对齐（360ms、同曲线）。
- **验证**（CDP，模拟器，预期）：进入时底层 `::after` opacity `0 → .14` 渐深（被盖不可见、
  无闪）；停留期间恒 `.14`；返回时 `.14 → 0` 连续淡出，与对话页滑出（translateX 0→412px，
  360ms）同帧启动、同拍收尾，全程无「重新变暗再淡出」的闪。

### rc.126（versionCode 126）· 2026-10-28 · 修复 pop 返回时会话页「从暗突变正常」

用户反馈：对话页返回会话页时，会话页会「从暗变为正常」—— 一眼能看出的闪。

- **根因**：rc.125 的压暗层 `.tween-under::after` 是固定 `opacity:.14` 且**无过渡**，
  由 `settle`（动画收尾）摘类那一刻才消失。pop 时对话页滑出、会话页归位并暴露出来，
  压暗层在收尾帧被瞬摘 → 会话页「啪」地亮起。
- **修法**：压暗层改用变量 `opacity: var(--under-dim, .14)` + 320ms emphasized 过渡；
  pop 动画启动的下一帧把底层（会话页）的 `--under-dim` 设为 `0`，压暗层随对话页滑出
  **同步淡出**（而不是等收尾帧才摘）。push 不动它（对话页整页盖住会话页，摘类时压暗
  淡出被盖住看不见）。`settle` 里 `removeProperty("--under-dim")` 复位，避免下一轮 pop 不压暗。
- **验证**（CDP，模拟器）：pop 时会话页压暗 `::after` opacity 从
  0.14 → 0.136(60ms) → 0.052(120ms) → 0.026(160ms) → 0.009(220ms) → **0(360ms)**；
  动画 360ms 完成时压暗已为 0，~408ms 收尾摘类时无可见跳变。对照：对话页滑出轨迹正常
  （translateX 0→412px，emphasized 360ms），`transitionend` 在模拟器偶发不触发，由 400ms
  定时器兜底收尾（已确认压暗在定时器之前就淡完）。

### rc.125（versionCode 125）· 2026-10-28 · 切页动画换成主流方案（结构工整）

用户反馈旧切页动画「太差、感觉像卡」。rc.124 只优化了**驱动算法的开销**，动画本身仍是
弹簧编排（双页视差滑移 + 缩放 + 进出对话时顶栏/上下文条/输入框三组子动画），几十个节点
逐帧合成，主观仍像顿。本版把动画整体换成业界通行方案，并改由**合成器线程**驱动：

- **Tab 之间 = Material 3 fade-through**：旧页 140ms 淡出并微缩到 .98，新页延迟 80ms 从
  .96 用 emphasized 曲线（`cubic-bezier(0.2,0,0,1)`）缩放淡入（260ms）。层次靠缩放表达，
  **没有横移**，方向感交给底部导航滑块（它自己有弹簧）。
- **会话 ↔ 对话 = iOS 式全幅推入/推出**：对话页整页从右滑入（push）/ 滑出（pop），
  底下会话页向左视差退让 24% 并压暗（`.tween-under::after` 黑 0.14）；
  滑动页带投影 `.tween-shadow`（44px 黑 0.28）给「浮在底层之上」的空间感。
  顶栏/上下文条/输入框**随页面一起滑**，不再单独编排（旧做法三组 chrome 子动画是顿的来源）。
  层级按 iOS 导航栈语义：谁是对话页谁在上，pop 时对话页滑出、会话页从视差位归位。
- **改用内联 CSS transition 驱动**：`transform/opacity` 的插值在合成器线程跑，
  主线程只在起、止各写一次值 —— 比 Motion 逐帧写样式省一整个每帧税。
- **修了一个层级 bug**：滑动页平时透明（只有一页可见无所谓），两页同时可见时
  会话页的搜索框/列表会透过对话页透出来。给 `.tween-shadow` 补 `background: var(--bg)`
  （与 body 同色，静止态看不出差别），滑动中两页都是不透明底。
- **收尾干净**：`transitionend` 监听 + 380/400ms 定时器双保险收尾；中断（连点切走）时
  由新一轮 `go()` 统一 `settleScreenTween`，摘掉 `is-leaving/tween-under/tween-shadow`、
  清掉内联 `transition/transform/opacity`，不留上一轮的过渡和位移。

**验证**（CDP 注采样器 + DOM 计算样式断言，模拟器）：
- Tab：旧页 0→140ms 淡到 0、缩到 .98；新页 80ms 后才起、480ms 落定到 scale 1/opacity 1，无残影。
- 会话→对话：push 中段 `translateX` 284→75→21→0px（emphasized 滑入），opaque bg 生效、
  底层 `::after` 0.14 压暗；收尾后标记类全清、对话页 `is-active`。
- 回归：rc.124 的弹簧解析解保留（底部导航滑块、卡片 hover 仍用 Motion）。

### rc.124（versionCode 124）· 2026-10-28 · 切页卡顿：弹簧驱动换成解析解

**先量化再改**：CDP 在 WebView 里连点 12 次 Tab，逐帧取间隔，只看切换后 560ms 窗口。
基线 rc.122：12 次切换 378 帧、18 个 >25ms 坏帧（4.8%）、最差一帧 **99.9ms**。

- **主因在主线程算法，不在 CSS**：`Motion` 的弹簧是「半隐式欧拉 + 240Hz 子步」，
  60Hz 帧里每属性积分 4 次；且 `tick` 每帧给每根弹簧 `Object.assign` 两份快照写回 `mem`
  —— 切页时并发 6~8 根弹簧 ≈ 每秒上千次小对象分配，GC 停顿就是切换途中规律的 33/50ms 坏帧。
- **改成闭式解**：阻尼弹簧有解析解，`x(t)/v(t)` 一次算出，无积分、无子步、无累积漂移；
  预设（k 170~520 / c 24~42 / m 1）全部欠阻尼，统一走欠阻尼解并 ζ 钳到 <1。
  打断语义不变：retarget 时以「当前值 + 当前速度」为新初值。
  数值校验：解析解 vs RK4 细步真值误差 **0.00000px**；与原 240Hz 欧拉轨迹最大差 9.4px
  （集中在欧拉滞后的尾段，落定更干脆）。
- **零每帧分配**：`mem` 复用同一个 live 快照对象，不再每帧 `Object.assign`；
  弹簧尾段位移 <0.05px（不透明度/缩放 <0.0012）直接跳写，不再整帧拼 transform 字符串。
- **进页刷新错开到 430ms**：会话/任务列表重建、设置页读记忆条数，不再和收尾帧同帧抢主线程。
  （试过把「玻璃恢复」也拆到收尾后 +34ms：A/B 实测坏帧数无差（19~26 vs 20~37，同噪声），
  已回退 —— 恢复玻璃那一帧的成本是固定的，晚一帧只是把顿挪个位置。）
- **会话↔对话**：同套弹簧驱动，push 时并发 6 根弹簧（两屏 + 顶栏/上下文条/输入框）。
  模拟器上剩余 ~2 坏帧/次集中在动画中段，是 SwiftShader 软件光栅整层重绘的地板
  （均帧 17.5ms 已超 60Hz 预算）；真机 GPU 上这是合成层变换，代价低一个量级。

**模拟器实测**（SwiftShader 软件渲染，60Hz，均帧 17.1ms 本就在预算边缘）：
热身后坏帧中位数 18 → 10，最差帧 99.9 → 33.4ms；`p90/p95` 均为 16.7/16.8ms（满帧）。

### rc.123（versionCode 123）· 2026-10-28 · 正在运行的工具行也扫光

- 之前扫光只落在**组头标签**和运行中那行的**摘要文字**上：摘要为空（或只有文件路径）
  时，运行中的工具行看起来和别的行没有区别，分不清哪一行是正在跑的那个。
- 现在工具自身的**名字**在运行中也走 `is-shimmer`（负延迟接相位，重建不闪）；
- 电脑端工具卡同步：运行中的工具名、卡片头「N 个工具 · 运行中」同样扫光。

### rc.122（versionCode 122）· 2026-10-28 · 任务可编辑可删除 ＋ 列表不再「消失」

任务页（任务 tab）三个真问题一起修：

- **「任务记录会消失」**：列表只在 App 启动时渲染一次，切页不刷新。启动那一瞬内核还没就绪、
  `scheduleList()` 返回空，或任务是对话里后来建的，页面就永远停在旧快照上。
  现在 `go("jobs")` 与「会话页」同款，每次进页都现读一次（等切换动画收尾，340ms）。
- **「删不掉也改不了」**：唯一入口是 520ms 长按且界面上毫无提示，点一下毫无反应。
  现在**点按任务行就弹操作面板**（长按保留）。
- **新增编辑**：定时任务可改名称/内容/触发方式，走新桥 `KernelBridge.scheduleUpdate`
  → 内核 `ScheduleRegistry.update`（CAS，单人操作不传 expected）；本机纯记录可改名称/说明。
  注意内核 `update` 的规则选择器在 patch **顶层**（`after_seconds`/`every_seconds`/`daily`…），
  桥接必须把前端嵌套的 `rule` 拍平，否则 `hasSelector` 恒假、改规则静默不生效。
- **「立即触发一次」不再误删周期任务**：原实现无条件 `scheduleDelete`，按一下就没了；
  现在只有一次性任务（after/at）触发后移除，周期任务保留。
- `renderJobs` 字段错位修正：内核 `toView` 给 `scheduledAt`，前端读的是 `next_at`，
  「下次执行」一直是空的；结束的任务还挂着运行中绿点 —— 现在按 `state` 显示「已结束」。

### rc.121（versionCode 121）· 2026-10-28 · 提示卡文字溢出卡片修复

- **根因**：`.turn-note`（后台任务完成 / 重试 / 失败这类提示卡）是 `display:flex`，
  而文本列（`> span`）没写 `min-width:0`。flex 子项默认 `min-width:auto` = 内容最小宽度，
  只要 tail 里有一个不可断的长 token（`{"ts":…,"type":"turn\/end",…}` 这种），
  整列最小宽度就被它顶到几百 px —— 于是每一行都在卡片右边缘**外面**换行，文字溢出圆角被裁掉。
- 文本列加 `min-width:0` ＋ `overflow-wrap:anywhere`；`.turn-note` 自身加 `min-width:0; max-width:100%`。
- 兜底：`.messages { overflow-wrap: anywhere }` —— 会话内任何长 token（路径、JSON、base64、URL）
  都不会再顶破容器。`anywhere` 与 `break-word` 的区别正是它参与**最小宽度**计算，
  所以 flex 子项也真的收得回来。
- `job_done` 的 tail 先压成单行（原来 `\n` 在 HTML 里会被折成空格，读起来是一整段），
  超长时保留末尾 140 字并加省略号；完整输出仍在「后台任务」面板。
- 用无头 Edge 在 390px 宽下做了对照：还原旧规则能复现同样的溢出，加规则后两张卡都收在卡内。

### rc.120（versionCode 120）· 2026-10-28 · 思考内容默认回缩

- **过程组里的思考行不再「一出现就展开」**：思考进行中只显示组头一行「正在分析请求」
  （扫光 + 摘要），正文要点开才看。以前每 token 整段重排既闪烁又把回答顶走；
  收起后每 token 只更新摘要一行。想看过程：点组头展开全部，或点单行看那段思考。
- 顺带删掉只为「自动展开再自动收回」服务的 `autoOpen` 状态（共 4 处），
  `markThinksDone` 只剩状态切换 —— 少一个双向纠缠的状态位。

### rc.119（versionCode 119）· 2026-10-28 · 陪伴式畅聊「开了像没开」根治：清单类名 ＋ 通知权限 ＋ 兜底心跳

- **根因一（致命）**：`AndroidManifest` 把保活服务写成
  `.kernel.plugin.builtin.CompanionKeepService`（真身在 `.builtin.device`），
  `startForegroundService()` 找不到类 → 抛异常 → 被 `runCatching{}` 静默吞掉 →
  **保活从未启动，心跳一拍都没跑**。这就是「开最强档一整天不主动」的全部原因。
  同一处 `InstallReceiver` 也少了 `.app`，一并修好。
- **根因二**：开启陪伴时没有人去要 `POST_NOTIFICATIONS`。Android 13+ 上一旦未授权，
  `notify()` 被系统静默丢弃 —— 引擎照常开口、消息也落了 outbox，用户从外面什么都看不到。
  现在 `MainActivity.onStart` 在「陪伴开着但通知未授权」时补一次系统弹窗（每组只问一次），
  `companionSay` 先查 `areNotificationsEnabled()` 再发，没发出去写进 `lastWarn`，
  状态面板新增「通知」一行；消息仍落 outbox，下次打开补进对话。
- **不再装作没事**：`ensure()` / `startForeground()` 失败都记 `lastError` ＋ logcat，
  状态页直接显示原因（原来是「受系统限制」这种和事实无关的文案）。
- **兜底心跳**：`CompanionEngine.startInAppBeat()` 在服务缺席时由应用内每分钟补一拍
  （服务在跑时完全空转，不会双倍；引擎本就有 `inFlight` ＋ `nextDueAt` 两道闸）。
- **编译期防线**：新增 Gradle 任务 `verifyManifestComponents`（挂 `preBuild`），
  逐个核对清单里每个相对类名都能在源码里找到同包同名类，找不到**直接构建失败**并指出期望包名。
  这类错编译不报、单测不覆盖、装到手机上也不崩，只能靠工具兜住。
- 验证（模拟器 + 假模型端到端）：服务 `isForeground=true` → 后台心跳到点 → 模型被调用 →
  outbox 落盘 → 通知栏出现「你的伙伴 / …」；撤销通知权限后同一路径复现
  `lastWarn=通知没送到`，消息仍进对话。

### rc.118（versionCode 117）· 2026-10-27 · 导航高亮只染滑块覆盖处 ＋ 切页流畅性 ＋ 堆叠细节 ＋ 陪聊主动性

- **悬浮导航高亮**：蓝色不再由 `is-on` 整颗点亮，只由 `.tab-blue` 克隆层按玻璃滑块的
  真实矩形逐帧裁剪（`cover-live`）；切页/松手后起 rAF 泵跟到落位，图标投影一起被裁；
  语言切换重建克隆层。裁剪绘制改为先量后写（原来每帧 4 次强制布局）、导航条 scaleX 用
  写入值缓存（不再逐帧 `getComputedStyle`）。
- **切页流畅性**：`go()` 不再每次跑 `applyLang()`（TreeWalker 全量扫描压在首帧）；
  会话列表重建推迟到动画收尾后 340ms；切换期间关掉悬浮导航的 `backdrop-filter`
  （blur 44px 每帧重采样）。
- **堆叠细节**：①单条会话不再画两层叠边（`is-single`，收起/展开两条路径同步）；
  ②叠层不再与卡片同亮度（brightness .96/.90，去掉 0.5px 高光亮边与外发光）；
  ③按住堆叠头整摞下压 1.5% 回弹，会话行按住同样微缩（左滑态不叠缩）。
- **陪伴式畅聊**：「话多」档窗口 10–30 → 6–18 分钟（Kotlin/前端两份同值副本同步）；
  提示词按档位分级，话多档放宽 SILENT 并要求**连续沉默 2 次后强制开口**
  （新增 `silentStreak`），发过一句归零。
- 单测 432 全绿（本轮纯前端/文案改动，无新增用例）。

### rc.117（versionCode 116）· 2026-10-27 · 执行内存拒绝根治（execfix）＋ 自动交付排除工程资源

- **推翻 rc.115 的 PaX 判断**：真机复核证明内核是标准 Android 6.12（无 PaX/grsecurity），
  报错里的 grsecurity/PaX 只是 HotSpot 对「拿不到可执行内存」的通用提示。
  seccomp（app 策略无 mprotect 条目，同进程 ART JIT 正常）与 SELinux
  （`untrusted_app_27` 明文 allow execmem/execmod）都已排除。
- **真机定案**：LD_PRELOAD 钩子抓到 `mprotect(4096, prot=7) = -1 errno=13`，目标页在
  **rw-p（已写过）** 映射内。该内核规则：`mmap 带 X` 放行、`未写过页加 X` 放行、
  **已写过页加 X 拒绝**（execmod W^X）——HotSpot 代码缓存提交恰好踩第三条，
  所以 paxctl / setarch / 压缓存 / `-Xint` 全部无效。
- **修法**：`ExecFix` shim —— mprotect 失败且目标含 `PROT_EXEC` 时，用
  `mmap(MAP_FIXED|ANON|NORESERVE|RWX)` 同地址重映射（属于「mmap 带 X」；空的新提交页
  清零无损）。**判据不按 errno 硬编码**：本机 `EACCES(13)`、别处可能 `EPERM(1)`。
- **落地四处坑**：源码自包含零 `#include`（rootfs 无 musl C 头）；rootfs 就绪即预热编译
  （终端入口是 `/bin/sh`，java 入口触发的懒编译永远不跑）；`LD_PRELOAD` 只走 guest 侧
  （放宿主环境会让 proot 本体起不来）；`/usr/local/bin/{java,javac}` 包装让终端 java 也生效；
  shim 版本戳（`ExecFix.VERSION` + `usr/lib/.libdshexecfix.stamp`）让旧 .so 自动作废重编。
- **诊断**：新增执行内存探针（python3+ctypes，同一条 proot 管线）；JVM 确定性失败时
  自动附判决（只禁翻转 / 整体禁死 / 另有原因）。
- **自动交付**：新增 `ProjectMarkers` —— 祖先目录含项目清单（AndroidManifest.xml /
  build.gradle / package.json / Cargo.toml / pyproject.toml …）即视为工程内文件，
  排除出「无显式 present 时按扩展名扫工作区」的兜底，修掉 app_new 建工程弹
  「5 个 png」交付卡的问题；显式 present 不受影响。
- 单测 410 → **432** 全绿。

### rc.116（versionCode 115）· 2026-10-27 · 英语界面残留中文补齐（i18n 全量修复）

- **现象**：设置切到 English 后，设置面板的按钮、说明文字与首页 chrome 仍有大量
  中文残留——静态 index.html 的分组标题、面板内动态生成的按钮行、占位符与
  aria-label 各漏一片。
- **机制补强**（`app.js`）：翻译字典新增约 230 条（17 个设置面板 + 插件清单 +
  index.html 静态分组全量覆盖）；新增 `I18N_RX` 正则处理动态组合文案
  （「N 条」「X 并行 · 深度 Y」「自动 · N%」「本地 · 模型名」等）；
  多行段落按 `\s+` 折叠空白匹配（`I18N_NORM`）。
- **观测补全**：MutationObserver 扩展到 `characterData` 与 `attributes`——
  之前只盯节点增删，纯文本改动与属性改动（placeholder / aria-label）永远漏翻。
  属性翻译用 attrStore 记「原始值 + 上次写出值」双值缓存，防止动态回写把译文
  顶回中文。
- **验收**：CDP 实测逐面板扫描（文本节点 + placeholder + aria-label），
  英语模式下残留 0 条；单测 403 → **410** 全绿。

### rc.115（versionCode 114）· 2026-10-27 · PaX W^X 确定性拒绝根治（paxctl 豁免补丁）

- **根因修正**：用户真机实测 app_build 守护进程**连续 5 次同一拒绝**——这不是
  rc.114 判断的「地址随机化抖动」，而是内核 grsecurity/PaX 的 MPROTECT（W^X）策略
  **确定性拒绝**：普通进程不允许把「先写后执行」的页改成可执行，JVM 初始化必经的
  `mprotect(PROT_EXEC)` 被内核直接拒绝。proot 只拦 syscall、setarch -R 只去随机化，
  都动不了内核策略。
- **根治：paxctl 豁免补丁**（`kernel/PaxFlags`，`paxctl -c -m -r` 的等价 ELF64 实现，
  位运算逐位对齐 paxctl 0.9）：给 JVM 启动器的 PT_PAX_FLAGS 段清除 MPROTECT/RANDMMAP
  （无该段时把 PT_GNU_STACK 转换而来，与 Debian 在 grsec 内核上跑 OpenJDK 的官方做法
  同源）。文件在我们自己 rootfs 里，宿主进程可直接改写，**无需 root**。rootfs 就绪时
  自动应用（幂等），headless JDK 全部 6 个启动器覆盖；app_build 守护进程、编译、终端
  裸 java 全走补丁后的启动器。
- **两层防御**：setarch -R 层保留（模拟器 A/B 实证：无 -R 时 8/10 过、加 -R 后 10/10，
  消除 ASLR 布局竞态）；paxctl 层处理真机的确定性 W^X 拒绝。补丁安全性已验证：
  位级单测 7 例 + 补丁后真二进制在 proot 下 10/10 正常启动。
- 若补丁后真机仍报同样错误：说明内核是 grsec **硬模式**（不读 PT_PAX_FLAGS），
  此时只能 root 豁免或换非 PaX 内核——错误指引文案已同步更新。

### rc.114（versionCode 113）· 2026-10-27 · PaX 根治（setarch 补丁）+ 滚动定位 + 授权档位

- **PaX 真根治：setarch 增量补丁**（rc.113 的 SelfSignedKey 只根除了 keytool 一条路径，
  终端/编译里的裸 JVM 仍会抖）。机制与实证：proot 转译下 `mprotect(PROT_EXEC)` 在地址
  随机化（PaX RANDMMAP / OEM 加固内核）下间歇性失败；`setarch -R`（ADDR_NO_RANDOMIZE）
  禁随机化后稳定成功——已把 util-linux setarch（约 19KB，musl 动态链接）做成 rootfs
  增量补丁（jniLibs `libdshsetarch.so`，按 ABI 双份，与 git 补丁同一套幂等解包机制）。
  镜像自带的 setarch 是 busybox 链接而 busybox 未编译该 applet（实测
  "setarch: applet not found"），模型此前绕不过去。接入点：`openGuest` / `guestExec` /
  `exec` 的 JVM 入口统一加 `-R` 前缀（app_build 常驻守护、compile、run 全覆盖）；
  补丁未就位时原样回退，由 JvmStartupJitter 重试兜底。
- **对话流滚动定位三处修复**：① 新增 `pinBottom()`（逐帧校验直到贴底稳住，扛住页面切换
  动画/键盘/图片晚加载导致「写入时刻 scrollHeight 过时」）；② 发送消息强制回底
  （`followBottomOn` 在重建前置位——此前可能为 false，renderThread 走「还原 prevTop」
  分支把视口拉回历史位置，即「一发消息就跳回历史」）；③ 重进/切换会话统一走
  `pinBottom(1200)`，进入对话页直接停在最新消息处。
- **完全访问立即生效 + 授权档位真实化**：① 权限档位热更新（设置页改动经
  `agentPermission` 即时下发运行中的轮次，Gate 每批读 live 值，不再等下一轮；
  完全访问下危险操作确认直接跳过）；② 「始终允许」改为真实档位（`agentApproveScope`
  传 once/always/deny，always 记会话级授权，同会话同名工具不再重复弹框——此前始终
  允许只回传布尔，与允许一次完全等价）；③ 终止对话后未决授权框立即结算
  （按钮隐藏 + 「已终止 · 本次确认无效」，点击侧也拦截已结束轮次的确认）。
- **phone_list_apps 只返回自身包名**：真因是 Android 11+ 包可见性过滤（manifest 缺
  `QUERY_ALL_PACKAGES`，`getInstalledApplications` 只剩自己），不是 proot——
  PhoneControlService 跑在宿主 AccessibilityService 里从未进过沙箱。补权限后恢复正常。

### rc.113（versionCode 112）· 2026-10-26 · 签名根除 PaX 拦截 + 五项交互修复

- **签名不再依赖 keytool（PaX 根治）**：proot 下 JVM 启动的 `mprotect(PROT_EXEC)` 会被
  PaX 风格 W^X 策略随机拦截（实测失败率 20~35%，`-Xint` 也躲不掉——解释器启动同样要
  生成 stub），此前靠重试撞运气。现在生成密钥对与自签证书改在**宿主进程内**用 JCA 直接
  完成（手写 DER：X.509 v1 + PKCS#8，`SelfSignedKey.kt`），`apksigner --key/--cert`
  原生支持、keystore 与口令全免。实测签名段 15s→**1.4s** 且零失败；密钥仍为
  本机专属（覆盖升级不受影响，`.dsh-keys/` 改为 `signing.pkcs8.der` + `signing.cert.der`）。
- **语音消息不再被静默吞掉**：`onVoice → handleSend` 撞上生成中会直接 return——文字
  发送有「入队」处理，语音这条入口什么都没做。现在与按钮同款：忙碌时入队并 toast 提示。
- **页面重载后自动接回运行中的轮次**：渲染进程在内存压力下被系统回收会自动重载
  （内核轮次在原生侧继续跑，但新页面已丢失轮次 id，事件全被丢弃——表现为「流式卡住、
  回复消失」）。`AgentBridge.agentActive()` + 页面就绪时重新认领，toast「已重新接入」。
- **发送后不再跳到历史**：重建对话流的中间帧会把 scrollTop 钳到 0，且非跟随态下
  发送不滚动。改为同帧贴底 + 发送一律强制贴底。
- **界面切换更顺**：切换动画期把进出两屏提升为合成层、暂停层内玻璃的 backdrop-filter
  （结束即恢复），会话列表重建挪到动画首帧之后。
- 单测 395 → **403**。端到端验证改用本地模型（宿主机 llama.cpp + MiniCPM 1B）。

### rc.112（versionCode 111）· 2026-10-26 · 六维评分 v5：六个域的实质性提升

本轮按「8 分以下逐域找根因」推进，全局 **7.4 → 7.8**（详见[附录 B §十](#十rc112-复评v5把-8-分以下的域逐个压到-8-分以上)）。功能只增不减。

- **终端 7.0→8.6**：会话后端从只有安卓宿主 shell 换成可注入双后端（`workspace`=rootfs，
  java/python3/gcc/node/keytool/git 都可用；`device`=宿主，保留 /sdcard、pm、am）。
  结束判定从「静默 700ms 猜」换成 shell 自打印的结束标记，一条 `which` 命令 1092ms→269ms，
  `sleep 3 && echo done` 从「提前报已结束给空输出」变成等到真实输出，且首次回传 `exit_code`。
- **造 App 8.3→8.5**：debug 公共密钥 → 首次构建用 rootfs 的 keytool 生成专属 RSA-2048
  （100 年有效，口令随机、权限 600，复用同 key 才能覆盖升级），`apksigner verify` 实测证书主体。
- **手机操控 7.3→7.8**：修掉元素选择不去重导致 `ordinal` 数错（会点到隔壁元素）的真 bug；
  找不到元素时不再无条件白等 6×250ms（界面已静默即停）；四条匹配优先级抽成纯函数 `NodeMatch` 加 11 测。
- **文件制作 7.3→7.6**：docx 解析去正则化（每行 6 个 `Regex.matches` → 首字符分派），
  同机新旧对照 1674 段 26ms→10ms；新增量级门禁 `DocWriterBenchTest`。
- **媒体与设备 7.0→7.5**：该域首个测试文件；名字清洗 5 处两套规则收敛成 `MediaPaths` 一处，
  补上路径段长度上限与「全非法字符回退默认名」。
- **桌面兼容 6.5→7.2**：`plugin_market` 从「配了就 throw 暂未实现」变成按桌面
  format 1 协议真实现（校验/检索/分页/install_spec，25 测 + 端到端）；
  rootfs 增量补 git 2.47.3（libdshgit.so，按 ABI 4MB），`create_worktree` 从上线起必然
  GIT_UNAVAILABLE（宿主直接执行 musl 二进制）改为走 proot，**首次真跑通**；终端里 git 可用。
- 其余：流式合批统一成 `StreamFlusher`（三条链路共用 40ms 节拍）；会话列表展开/回收不再闪白；
  插件按域模块化五子包 + ARCHITECTURE.md。单测 **327 → 395**。
- 遗留如实声明：桌面兼容 18 个工具只动了 2 个，其余覆盖核对未做；`lsp` 仍是正则索引替身；
  `pwsh` 不可用与桌面挂载策略一致。

### rc.111（versionCode 110）· 2026-10-26 · 手机内造 App 闭环 + 构建常驻守护 + 插件按域模块化

本轮把「手机上造一个 App」从演示推到可用，并把构建耗时压掉一个量级；顺带完成了内核模块化、
工具行回归桌面式渲染、ABI 拆包与工作区整理。**功能只增不减，没有为了体积裁掉任何能力。**

- **造 App 三段闭环**（`app` 域）：`app_new` 生成可编译工程（清单 + 文案 + 五档图标 + 1-3 页 Activity，
  图标由自研 PNG 编码器按主色现画，零素材）→ `app_build` 手机内完整打包（aapt2 compile/link →
  ecj → d8 → 注入 dex → apksigner）→ `app_install` 交给系统安装器并回传终态。
  **唯一的人工闸门是系统安装弹窗**（无 root 绕不过，已如实写进工具文案）。
- **构建提速（实测，同一工程连打三次）**：12.3~13.9s → **2.1~2.6s**（第 2、3 次）。
  病因不是「起三次 JVM」（`java -version` 只要 50~150ms），而是 ecj/d8/apksigner **各自把类加载一遍**
  （5.3 / 4.8 / 2.8s，ecj 不带 android.jar 也要 4.7s）再被 proot 的 ptrace 放大。
  解法对齐桌面（`packages/terminal` 的会话跨调用存活、`packages/subprocess` 的进程寿命）：
  一个 guest JVM 常驻（`BuildDaemon`），四阶段同进程、每 stage 隔离 ClassLoader。
  负载收口：空闲 120s 自动回收（实测静置 140s 后 `java`/`proot` 归零）、`-Xmx384m`、
  JVM 初始化抖动 5 次递增退避。
- **流式输出**：合批从「三条链路各写一遍、且只在下一条 chunk 到达时才刷」改成单一实现
  `StreamFlusher`（40ms 固定节拍 + 64 字阈值，文本与思考同节拍）；前端绘制从固定 48/60/80ms
  改成 rAF 按帧 + 超时兜底。实测 delta 间隔 p50 42ms / p95 70ms。**渲染层单帧成本（p50 65ms）
  尚未收干净**，需要真机复测（模拟器 gfxinfo 窗口会被无关动画污染，不作为结论）。
- **工具行回归桌面式**：轮末过程折叠时，工具调用不再随之消失，也不会变成卡片 ——
  按 `packages/client/ui-tool` 的 `ToolRow`（DisclosureRow：icon + 标题 + 摘要 + 耗时）抽成独立单行，
  点开才看参数/输出；历史快照里的旧 `tool` 节点一并统一成同一套单行渲染。
- **内核模块化**：`kernel/plugin/builtin/` 34 个文件平铺 → 五个域子包
  `fs`(8 插件/19 工具)、`doc`(5/6)、`device`(11/16)、`agent`(5/10+)、`app`(2/3)，
  与桌面 `packages/` 的能力域同名同义；发现机制仍是 ServiceLoader（换包只改清单一行）。
  新增 `ARCHITECTURE.md`：分层图、五域职责、新增插件三步、与桌面的对应表、可拆卸边界。
- **ABI 拆包**：complete universal release 345.9MB 里有 110MB 是「另一台设备的 rootfs」
  （`libdshrootfs.so` arm64 103.5 + x86_64 113.3）。开 `splits.abi` 后
  **arm64 222.3MB / x86_64 232.9MB**；aapt2 载荷也从 assets 挪进 jniLibs，只带本机那份。
- **工具目录补登记（v4 复评抓到）**：`app_new`/`app_build`/`app_install` 此前**从未进 `ToolCatalog`**，
  落在 fallback 里——安全上按写操作对待没错，但分组/风险/计数全看不见它们。已补三行，
  工具数 151 → **154**。六维评分 v4 见[附录 B §九](#九rc111-复评v4新增造-app-域--补齐目录漏登记)：
  新增「造 App」域 8.3，9 域均值 7.4（同口径 8 域仍 7.3）。
- **验收脚本**（都在 `.motion/verify/`）：`perf-build.sh`/`perf-breakdown.sh`（逐阶段耗时）、
  `perf-app-build.mjs`（墙钟 + 分段 timings）、`perf-stream.mjs`（delta/上屏/帧率三串时间戳）、
  `verify-app-new.mjs`（脚手架→打包→安装→翻页全链路）、`verify-agent-make-app.mjs`（自然语言触发）。

### rc.110（versionCode 109）· 2026-10-25 · 修「abstract method on receiver Class」工具崩溃（R8 类合并）

- **现象**：调用工具时崩溃/报错 `abstract method "java.lang.String n.p.a(org.json.JSONObject,
  n.l)" on receiver java.lang.Class<o.M>`（混淆名）。
- **真身（mapping.txt 对照）**：`n.p`=ToolSpec、`n.l`=ToolExecContext、
  `o.M`=**ImagePlugin$tools$1**（R8 水平类合并后的合成代表，带 `$r8$classId`/synthesized 标记）。
- **机制**：Kotlin 默认用 DefaultImpls 约定编译接口默认体（两参 `execute(args, ctx)` 在接口里
  是 abstract，实体在静态助手类 `ToolSpec$DefaultImpls`）。R8 full mode 水平合并把 20+ 个
  匿名 ToolSpec 并成合成类，并把 DefaultImpls 的静态体搬进另一个合并类（mapping 实锤：体被
  塞进装着 ZXing Encoder/CharsKt/PdfText 的巨型合并类的 `t` 方法）——类型层级没对齐后，
  调用点变成对接口抽象方法的虚调用 → AbstractMethodError。**这是整类问题**：所有带默认体
  的接口（executionMode/timeoutMs/hooks…）都在同一风险面里。
- **修复（三层）**：
  1. **`-Xjvm-default=all`**（build.gradle.kts kotlinOptions）：接口默认体编译成真正的 JVM
     default method，DefaultImpls 类彻底不生成 → R8 无体可搬，整类问题根除；
  2. **R8 规则**：`ToolSpec`/`Plugin` 及其实现类禁止水平合并（`-keep,allowobfuscation`，
     仍可改名），防御其它合并形态；
  3. **`PluginRegistry.exec` catch Exception → catch Throwable**：工具边界上连 Error 也是
     「结果」不是「崩溃」——AbstractMethodError 这类 Error 直接穿透 catch(Exception) 炸掉
     整条调用链；现在变成 `TOOL_THREW` JSON 回给模型。
- **取证**：`.motion/verify/sweep-tools.mjs`——release 包上对全部 152 个注册工具做
  `Native.toolCall` 空参扫描（脚本保留；空参大多被参数校验拦截，命中条件不充分，
  最终靠 mapping.txt 静态实锤）。rc.110 构建后 mapping.txt 中 `DefaultImpls` 归零。

### rc.109（versionCode 108）· 2026-10-25 · 修「回弹到设置 tab 滑块偏左」——布局空间量取

- **现象**：左右滑动到右缘松手，滑块回弹落到「设置」上时偏左几像素到十几像素。
- **根因**：`moveTabIndicator` 用 `getBoundingClientRect()` 量取 tab 位置（视口视觉坐标，
  含 transform）。松手后导航条还挂着形变回弹弹簧（scaleX≠1，ζ0.61 全程 ~600ms 带过冲）
  —— 左右滑动只要带一点斜向分量，副轴耦合 0.45 就让导航条带 `scaleX≈0.966`（上拔横收）。
  量到的缩放后距离写进滑块 `translateX`，又被 bar 的 scale **再乘一次**：
  落位 = 真实偏移 × sx²。偏移量 ∝ tab 离左边的距离——设置 tab 最右（~250px）偏得最多
  （~17px），会话 tab 几乎无感。
- **修复**：几何量取一律改**布局空间**——`moveTabIndicator` 用 `active.offsetLeft/offsetWidth`
  （transform 免疫）；`geom()` 列表同样改布局空间（拖拽中最近项判定不再系统性漂移）；
  legacy 路径吸附改用写入坐标 `drag.x`；`paintTabCoverage` 的滑块视口矩形按当前
  scaleX（DOMMatrix 读回）折算——染色范围与滑块视觉位置对齐。
- **顺手修**：纵向捏形变松手后滑块残留 `scale(1.03)` 按下放大态（y 锁分支直接 return
  没有归位滑块）——补 `moveTabIndicator` 落位。
- **取证**：`.motion/verify/capture-rc109.mjs`——三种斜向/水平甩动落设置 tab 中心偏差
  均 -0.33px（修复前该场景偏 ~8-17px）；点击逐 tab 落位 ≤0.84px；纵向锁定不换页 +
  滑块归位无 scale 残留；rc.107 T1~T7 形变回归全 PASS。
  注意测量时机：弹簧模拟时间每帧最多推进 32ms（防大步长失稳），页面首渲卡顿时
  墙钟 700ms 可能只跑 ~300ms 模拟时间——采样必须轮询到 transform 收敛，不能死等。

### rc.108（versionCode 107）· 2026-10-25 · 修导航条「松手跳跃」+「切页图标重影」

- **跳跃（问题 1）**：`releaseTabBar` 把手指原始甩动速度（最高 ±3000px/s）直接灌进 k300
  回弹弹簧。但形变 y 是软饱和映射 `±22·|dy|/(|dy|+70)`，导航条视觉速度只有手指速度的
  slope = 22·70/(|dy|+70)² 倍（中心处 ≤0.314，拖得越深越小）——直接灌入会把弹簧振幅吹到
  ~170px，松手瞬间导航条上蹿几十像素再荡回。**修复**：速度按形变曲线局部斜率折算成
  「导航条真实在动的速度」再夹到 ±420px/s（振幅 ≈24px → 一次干净的小 Q 弹）。
- **重影（问题 2）**：切页时 `animateTabIcons` 只给真图标挂 `ico-in/out` 动画，而选中 tab
  的蓝色克隆层 `.tab-blue`（clip-path:none）里还有一份**静止克隆图标**叠在正上方——
  真图标在滑、克隆原地不动，两颗错位即「切页图标重影」。**修复**：同一动画类同步挂到
  `:scope > .tab-blue .ico`，两层逐帧像素级重合，视觉上仍是一颗蓝色图标在滑。
- **`Motion.kill(el)`**（motion.js 新原语）：无声打断弹簧——不写终值、不触发 onComplete。
  与 `stop`（立刻收尾到目标）的区别：重新抓住正在回弹的导航条时用 kill，`stop` 会在按下
  瞬间把条 snap 到 y=0（又一次跳跃）；旧弹簧若不杀，则每帧覆写拖拽 transform，其
  onComplete 还会在拖拽中途摘 `is-dragging` + 清内联。`arm()` 起手即 `kill(bar)`。
- **额度行（顺手修）**：设置页「额度与用量」行的值此前只在绑定时写一次、且只认本地
  token 消耗——没有本地记录就永远是一条小横杠「—」。现改为优先显示账户余额
  （进设置页 60s TTL 补拉一次；`onBalance` 回调同步刷新行与面板），无余额再退回
  本地 tokens。顺带修掉 `refreshBalance` 超时兜底引用了从未定义的 `reqId`
  （弱网下 25s 兜底一执行就 ReferenceError，「正在查询…」永远不换错误卡）。
- **回归记录**：首版 rc.108 曾引入严重回归——`onEnd` 解构漏了 `dy`（严格模式下
  ReferenceError 被 `Motion.drag` 的 try/catch 静默吞掉 → 松手后回弹弹簧根本不启动，
  导航条停在形变位置「不会复原」）。已修并重新构建。
- **虚拟机取证**（`.motion/verify/capture-rc108.mjs`，4 组全 PASS）：
  上拔 165px 甩动松手 → 过冲仅 1.6px / 过零 1 次 / 终态内联清空（旧代码甩动可上蹿
  30~60px）；下压对称（1.5px）；切页动画帧中真图标与克隆图标同挂 `ico-in-l` 且
  rect 逐像素相等（重影消失）；伪注入 `onBalance` 后额度行显示 ¥12.34、面板余额卡同步。
  rc.107 七项形变回归（T1~T7）全 PASS。

### rc.107（versionCode 106）· 2026-10-25 · 悬浮导航栏「上下拖拽形变」+ 人因物理收口

- **问题**：`Motion.drag` 锁成 `axis:"x"`，纵向 `dy` 被硬写成 0——导航条只能横向拖出滑块，
  完全不能被竖向拽动；用户要求像圆形按钮一样有拖拽形变，且符合人因动画与物理规律。
- **纵向形变模型**（`app.js` `tabBarDeform`，两条拖拽路径共用）：
  1. 跟手位移取软饱和 `shift = ±D·|dy|/(|dy|+K)`（D=22px / K=70）——起手轻快、越拖越沉，
     远端位移增益趋 0（肌肉阻尼），不是「拖多少走多少」的贴纸；
  2. 形变按「拉伸轴拉长、垂直轴反向补偿」近似体积守恒：向上拔 `scaleY 1+q / scaleX 1−0.62q`，
     向下压 `scaleY 1−0.62q / scaleX 1+0.45q`，`q = 0.17·|shift|/(|shift|+26)`；
  3. 铆钉在底边（CSS `transform-origin: 50% 100%`）：向上是被拔长的软体、向下是被压扁的垫子；
  4. 松手用专用 ζ≈0.61 弹簧（k300/c21 → 过冲 ≈9%）从当前值+手指实际速度接管。
     实测复现：通用 press（ζ≈0.83）理论过冲仅 0.9%，11px 形变回摆 0.1px，肉眼无 Q 弹。
- **手势语义锁定**：主方向一经判定不翻转（|dy|>|dx|·1.15 → 纵向）——纵向=捏形变，不偷蓝、
  不动滑块、不换页；横向=拖滑块切页，纵向分量保留 0.45 权重耦合（斜向拖动自然衔接）。
- **居中方式改造**：`.tabbar` 从 `translateX(-50%)` 改为 `left:0;right:0;margin-inline:auto`
  布局居中——动效层写 transform 会把 -50% 冲掉（导航条瞬间偏左半个身位）。
  实测静止居中偏差 0.1px。
- **内联样式清理**：`go()` / 延迟露出路径在切 `is-hidden` 前 `Motion.stop+clear`，
  回弹 `onComplete` 也 clear——否则回弹终值 `translate3d(0,0,0)` 盖住 `.is-hidden` 的
  `translateY(90px)`，出现「进了对话页胶囊还浮在底部」。回归实测 PASS（Q 弹跑到一半
  进对话：opacity 0 / ty 90 / 无内联残留；返回后 opacity 1 / transform none）。
- **motion.js 分轴橡皮筋**：`rubber` 支持 `{x:{...},y:{...}}`（旧单对象写法兼容）——横向仍
  夹在一页内，纵向交给软饱和。
- **虚拟机取证**（`.motion/verify/capture-tabdeform.mjs`，7 用例全 PASS）：上拔 90px →
  拉伸 1.055×/收窄 0.966×/跟手 −12.4px；下压 90px → 压扁 0.966×/鼓出 1.025×/跟手 +12.4px
  （与模型逐位吻合）；纵向拖全程不换页；松手回弹过零 1 次、峰值 −1.04px（sy 1.0015）；
  横向切页正常；结束后内联/类名/几何全部归位。

### rc.106（versionCode 105）· 2026-10-25 · 滑块越界钳位 + 逐像素覆盖染色 + 甩动物理

- **滑块越界**：`motion.js` `resist` 补上契约写了但没实现的「越界最大 10px」上限——
  之前只有 0.35 线性衰减，拖多远就按 35% 继续往外走，滑块能滑出悬浮容器半个身位以上。
- **逐像素覆盖染色**：`.tab-blue` 克隆层 + `clip-path` 相交矩形——滑块压到哪半边哪半边
  变蓝，替换原「滑块中心一越过图标中心就整颗提前全蓝」（`is-near` 删除）。
- **甩动物理**：松手水平速度接续进落位弹簧（`tabSnapVx`，±4000px/s 钳位）+ 速度投影
  选页（最多前认 60px）；拖动中滑块举升 scale 1.03。
- ⚠️ 本条发布时漏 bump 版本号（version.properties 当时仍停在 rc.105），rc.107 一并补正。

### rc.105（versionCode 104）· 2026-10-25 · 修「进对话后会话列表残影」+ 虚拟机连续取帧验证

- **根因（单点）**：`go()` push（会话→对话）分支把离场会话页终点设为 `opacity:0.55`
  且**驻留不动**（无 onComplete），要等入场弹簧收尾（~360ms）或 500ms 保险定时器
  才被 `settleScreenTween` 清掉；对话页以 0.55 半透明起步且消息区/输入区全透明
  （真背景在 `.device`），会话列表（置顶/最近/工作区）就从透明区透出；
  chrome 快速退场只覆盖含搜索框的 `.nav-large`（140ms），列表内容只能随整页驻留——
  「搜索框以下消失慢、进了对话还残留」即此。pop（对话→会话）方向终点本就是 0，无此问题。
- **修法（最小回归面）**：离场终点 `0.55 → 0`，并给这条 exit 弹簧加 `onComplete`，
  在自身动画自然结束时（~276ms，max 280ms 封顶）单独收尾 outEl（摘 is-leaving、
  清内联、幂等清其 chrome 子元素），不等入场页；`screenTween!==st` 守卫防重入误清。
  `settleScreenTween()`/500ms 保险定时器/pop 分支/chrome 名单一概未动。
- **虚拟机连续取帧验证**（`.motion/verify/capture-pushghost.mjs`，CDP 合成真实触摸
  + 页面内 8ms 定时器密采 + screencast 逐帧，锚点=离场开始）：
  - before（修复前实测）：会话页钉在 `opacity≈0.55 + scale 0.98` **376ms**（10 个稳定
    采样点），且整个过渡期都从半透明对话页下透出；抖动帧率下更糟；
  - after：无驻留段，会话页连续淡到 0（最后可见 +206ms/+135ms 两轮），
    `is-leaving` 由离场弹簧自己的 onComplete 摘除（轻载轮 +383ms，早于 500ms 保险），
    +600ms 稳态 opacity=0；
  - 重入压测（`stress-pushghost.mjs`）：快速来回切 20 次，终态零残留
    （无 is-leaving / 无内联 transform / visibility 全部归位）；
  - `?motion=legacy` / `?motion=reduce` 两条退化路径各 3 轮来回，终态干净。
- 契约同步：`.motion/CONTRACT.md` §4/§5 更新为现行参数并新增不变量
  「离场终点必须是 0，禁止驻留中间不透明度」；`动效改进计划书.md` §6/§8.3 同步。
- 附注：模拟器 + CDP screencast 负载下 rAF 会被饿到 200ms+ 一帧，采样器已从 rAF
  改为 setInterval(8ms)（与渲染解耦），否则驻留窗口整段漏采。

### rc.104（versionCode 103）· 2026-10-25 · 果冻形变：补全圆形独立按钮 + 修拖拽被滚动抢走

- **「+」等顶部圆形按钮接入果冻通道**：会话/任务/文件页右上角的 `.icon-btn`
  （新建会话、新建任务、搜索文件等，36px 正圆独立按钮）原来不在
  `JELLY_SEL` 里，拖拽无形变。现统一接入（app.js 选择器 + styles.css 三处
  is-jelly / is-jelly-tap / reduced-motion 规则），与 `.round-btn/.send-btn/.voice-btn`
  同一套「中心铆钉不动、沿拖拽轴拉伸、垂直压扁、松手 Q 弹回圆」。
- **修拖拽形变根本不触发的 bug（touch-action）**：果冻通道的按钮原来都没声明
  `touch-action`，手指一拖就被浏览器判定为滚动手势 → `pointercancel` →
  形变直接断掉。真机/模拟器上「按住拖动」十有八九落在滚动判定里。
  现给四个类统一 `touch-action: none`，拖拽序列完整（DOWN→MOVE…→UP）。
- **模拟器实测（API 36 x86_64）**：CDP 合成真实触摸序列逐帧验证 ——
  斜向拖 180px 中途 transform 为 rotate+scale(1+p,1−0.62p)+rotate（中心不位移）；
  垂直拖 150px 数值精确吻合 p=0.163（matrix(0.899,0,0,1.163,0,0)）；
  松手 ~170ms 处 Q 弹关键帧在演、~1s 后完全归圆且位置与初始 rect 一致；
  拖拽松手不触发点击（不新建会话/不误发消息）、原地点按仍正常触发点击并走轻果冻；
  禁用态发送按钮被正确跳过（无形变、无响应）。

### rc.103（versionCode 102）· 2026-10-25 · 架构优化：卡死 / 流式卡顿 / 不上滑 三问题

- **卡死 + 流式卡顿同根因（架构级）**：LocalDB 原把**所有会话**的 messages + shot
  塞在一个 localStorage key，任何写入都全量 parse+stringify 整个库，而流式期间
  persistThread 每 8 秒 saveShot 一次（主线程同步）——长对话下每 8 秒卡一下、
  越用越重直到顶死。现拆为**索引（轻）+ 每会话独立 key `dsh.local.sess.<id>`**，
  写入只动自己那份；旧格式首读自动迁移；payload 进程内缓存（LRU 6）；
  saveShot 配额淘汰改为逐会话清 shot。列表预览改用 push 时写下的 `lastMsg` 摘要。
- **persistThread 挪到空闲时机**：shotNode 深拷贝 + 落盘走 requestIdleCallback
  （timeout 2s），不再挤占流式 paint 的节拍。
- **sealedCut 增量化**：原来每次 paint 对全文做三遍 O(n) 扫描（\n\n 边界 + 两次
  ``` 计数）；现随正文增量扫描缓存（Live.bounds/fenceOdd，回退量按模式长度取
  1/2 防重复计数），单次 paint 只花 O(新增) + O(尾部)。
- **滚动回环修复（不及时上滑根因）**：程序化滚动触发的 scroll 事件原来会把
  followBottomOn 关掉（自己写的 scrollTop 关掉了自己的跟随）——内容顶到输入框
  上边界后流式不再自动跟。现 setScrollTop 打 progScrollUntil 时间戳（240ms，
  缓动每帧刷新），窗口内的 scroll 事件不算用户意图；RO 贴底写入也走 setScrollTop。
- **原生 delta 合批**：AgentDriver 内核路径与 AgentBridge Messages 路径原来每条
  chunk 一次 evaluateJavascript，快模型时把 WebView 主线程刷爆；现攒 48-64 字符
  / 60-70ms 一批（与 OpenAI 路径既有参数一致），流式观感不变、UI 线程事件次数
  降一个量级。
- **CompatPlugin 探测/ worktree 看门狗**：`sh -c`/git 挂死时 readText() 永远阻塞、
  整轮像死掉；现 10s/60s 强杀子进程兜底。
- 单测 327 全绿。

### rc.102（versionCode 101）· 2026-10-25 · 圆形独立按钮 MagicOS 11 果冻形变

- **果冻通道**：`.round-btn` / `.send-btn` / `.voice-btn` 从通用按压形变（scale .965 + skew ±2°）切换到专用通道——
  拖动期以按钮中心为铆钉（不位移），沿拖拽轴拉伸 p、垂直压扁 p·0.62（近似体积守恒），
  p 随拖距软饱和（上限 0.2）；transform 由 JS 逐帧写入（rAF），轴角实时跟随。
- **Q 弹回圆**：松手后由 `--ja/--jp` 变量驱动关键帧 `jellySettle`（拉伸 → 反向压扁 48% → 微过冲 14% → 归位，.62s）；
  原地点按走 `jellyTap`（.965 → .885 → 1.045 → 1，.42s）。pointercancel 静默归位不演。
- 与通用通道互斥：果冻按钮拖动时不进 skew 分支；回弹途中再按立刻让位给按压弹簧；
  连点时先摘残留动画类避免旧动画覆盖新动画。
- 通用按压形变（其余按钮）保持不变；preview/ 已同步；单测/构建不受影响（纯 Web 层）。

### rc.101（versionCode 100）· 2026-10-25 · 死代码清理 + 悬浮导航栏符号方向动画

- **断链修复 2 处**：「解除配对」调用的 `Native.linkUnpair()` 在 Kotlin 侧不存在（点了没反应）→ `LinkBridge` 补真实现（清凭据 + 停连接）；切经典女声时 `Native.stopSpeaking()` 拼错（真名 `stopSpeak`）导致不打断在播语音 → 改正。
- **死桥整域删除**：`PhoneBridge`（JS 零调用）连同 NativeBridge 注册项；17 个死桥方法（Agent 3 / Voice 4 级联 MainActivity+VoiceCenter / Device 5 / Kernel 4 / Host.setHost / Team.teamSend / Account.accountToken）。
- **内核死成员**：`AgentDriver.runtimeToolDefs`（50 行死 schema）、`IntentRouter.Refiner`、Sandbox 的 per-call 三件套（`SandboxCall/policy/policyFor/wrap`）与 sessionId、`TerminalRegistry.closeAll`、团队 maxTasks/maxMembers 更新器、HookBus 的 `gate/bail/off`（**`HookContext.put` 不是死代码**，AgentDriver/ToolPipeline/PromptAssembler 8 处在用——首轮误删已恢复）、`PluginHooks.off`、DocWriter 两段死 XML 模板等零散死常量。
- **接线而非删除**：`ToolSpec.execute(args, ctx)` 两参入口此前派发端从不传 ctx → `PluginRegistry.exec` 接通。
- **Web 死代码**：app.js 4 个死函数（toolKindOf/dropVoice/refreshPluginVoiceRow/sheetLinkChat）；styles.css 51 个死类 80+ 规则块（3223→约 3050 行）；motion.js 4 个零引用 API（stopAll/value/linear/resetStats）。
- **悬浮导航栏符号动画重做**：原一次性 `tabPop`（原地缩放弹一下，观感「闪一下」）换成**方向成对的连贯动画**——旧图标朝切走方向被推让（缩小+淡出再归位），新图标从来源方向带 overshoot 滑入回正；点击与拖动滑块松手两条路径统一走 `animateTabIcons`，方向永远与滑块移动一致；`prefers-reduced-motion` 下关闭。
- 单测 327 全绿；preview/ 已同步。

### rc.100（versionCode 99）· 2026-10-25 · 工具质量 v3 复评：最低两域落地改进（兼容自造/终端）

> 附录 B §八（v3 复评）落地：单测 306 → **327 全绿**（+21，PluginRulesTest 12 + TerminalRegistrySessionTest 9；此前条目误写 348，已按实际结果修正）。

- **terminal_send 并发裸写 stdin（v3 复评抓到的最大真 bug）**：SEND_ACTIVE 单活跃约束
  原来只覆盖 `submitAndWait`，`terminal_send` 直接裸写 —— 同一会话前台 + 后台收集 job
  并发时交叉写 stdin，前台命令读到 interleaved 输入。新增 `TerminalRegistry.guardedSend`
  （拿不到护栏返回结构化 SEND_ACTIVE/SESSION_EXIT），前台与后台全接入；后台收集 job
  整个收集期占住护栏。
- **后台收集上限可配**：60s 写死 → `bg_timeout_ms`（5s-600s）；前台超时判定的
  `8_000 - 1_000` 魔数 hack 改为 `WAIT_MS/QUIET_MS/POLL_MS` 常量 + 显式 timedOut 判定。
- **plugin_create 校验收进 `PluginRules` 纯函数并补测**：规范 §2「最多 8 个工具」此前
  写在文档里但代码从不检查；description 空也放行、parameters 非对象也放行 —— 全部
  逐条报因拒绝。PluginRulesTest 12 用例。
- **lsp 兜底实例缓存**：服务缺失路径下 `lsp()` 每次调用 new 一个 SymbolIndex，
  行缓存全废、hover 一次重扫全工作区。改懒缓存单实例；git 探测子进程改进程级缓存。
- **node 运行时不再误报「未安装」**：`load_workspace_dependencies` 写死
  `available:false`，与 python 的探测不一致；改为同款探测（Termux/自定义 ROM 受益）。
- 媒体域复核无 P0（一条不可达死分支记档）；`plugin_market` 无协议文档，保持诚实不可用。



### rc.99（versionCode 98）· 2026-10-24 · 团队面板装机实测四项修复（图标/计数/成员会话/竞态）

> 模拟器真机跑通全流程（自定义端点 + 代理中继 + spawn + 成员会话进出）后修的四条，全部来自实测而非推演：

- **对话流团队工具图标与右上角团队按钮统一**：`list_agents` / `spawn_teammate` / `send_message` 等
  十个团队工具新增 `team` 类别，图标一律 `#i-agent`（原来是默认的 `#i-branch` 分叉，和团队按钮不一致）。
- **lead 统计不再是永远的 0**：roster 增内存态 lead 统计（不落日志——回放不变量要求成员首记录
  必须 provisioning，lead 是虚拟成员没有这条边），由 `agent/pre-step` 记轮次、新增
  `agent/tool` 串行钩子（AgentDriver.executeTools 发出）记工具数。实测 lead 轮次随对话递增。
- **「运行中」计数含 lead**：面板计数原来只数队友，lead 带绿点却显示 0 人。现在
  `state.busy`（Lead 本轮在跑）时 +1，计数与成员圆点对得上。
- **进出成员会话主对话流丢失**（实测最严重的一条）：进场时 `thread.length = 0` 把主对话流
  （含正在跑的 Live 节点）直接扔了，退出时若 Lead 轮次还在跑会走 `sameRunning` 短路只回界面
  不重建 → 白屏。改为**换出/换回**：进场 stash 主线程，退出原样放回；`persistThread` 加护栏，
  成员视图里的消息不会写进 Lead 会话快照。实测退出后 20 条节点完整还原。
- **成员重复 provisioning 竞态**：`TeamRuntime.submit` 在 `pool.submit` 后又 persist 一次，
  与工作线程的 `activate()` 竞争，日志出现 provisioning→active→provisioning，回放校验按设计
  终态冻结整个团队（面板红条「创建完成后又退回 provisioning」）。删掉这次冗余 persist
  （reserve 已写过 provisioning，状态变化只由 activate/idle/fail 负责）。实测重跑后
  tester 干净走完 provisioning→active→inactive，`failure: null`。
- 顺手修掉 `FlowchartSvg.kt` 一处空安全（`HashMap.merge` 返回 `Int?`，`!!` 收敛），
  否则整个 release 编译断在 chart 包。

※ 装机环境备注：模拟器 DNS/UDP 不通，应用出网走「Android 系统代理 → 宿主机 CONNECT 中继」
（`.tmp/connect_proxy.py`，TLS 端到端、SNI 不变）；`-dns-server` 与写 hosts 均无效
（verity 锁死 /system 只读）。

### rc.98（versionCode 97）· 2026-10-24 · 工具质量待修五项全部落地（操控/预览/PDF/两个新视觉工具）

> rc.97 复评（[附录 B §7.4](#74-仍待修清单rc98-状态五项全部落地)）列出的五项待修全部落地：单测 163 → **194 全绿**，APK +76KB。

- **`read_image` 读大图不再撑爆请求体**（附录 B §7.4 第一项，归 fs 域的基线 P0 残留）：
  `AgentDriver.addImage` 改为「先压后查」—— 读字节 → `ImageResize.forConversation`
  （最长边 1600px / JPEG 85，GIF 原样）→ 压缩后字节才查 8MB 上限；mime 跟随实际字节
  （压缩后即 `image/jpeg`）；返回文案报压缩前后 KB，session 日志加 `compressed` 标记。
  接口签名不动，TeamRuntime 桩零波及
- **操控等待从「睡固定值」到「事件静默判定」**：`UiChangeTracker.awaitChangeSteady` ——
  第一轮等满 timeout 未变再补 0.5×，**总上界 1.5×timeout**（重试的是等待而非操作）；
  `withUiCheck` 三态 note（立即变化 / 延迟 Xms / 两轮未变提示自绘界面可能）；
  promptSection 同步说明，UiChangeTrackerTest +4 例
- **文档预览编排层从裸奔回归**：新增 `DocPreviewTest` 8 个测试 —— pptx 版式还原
  happy path、损坏 pptx → kind=error、csv 引号转义、tsv、json 美化、markdown、code、
  未知扩展名分发；docx/xlsx 分支依赖 `android.util.Xml` 桩（JVM 不可测），已在测试注释写明边界
- **PdfWriter 接入共享 Palette**：`write(..., accent)` 对齐 PptxWriter 惯例 —— H1 下划线与
  引用竖条用 accent 实色、表头背景 accent 淡化（`argb(0x1F,…)` 打印友好），其余 6 处灰阶
  保留中性语义；`write_pdf` schema 加 `accent` 透传。docx/pptx/pdf/chart 四格式视觉一致闭环
  （PdfWriter 依赖 android.graphics，无 JVM 单测，靠真机目检）
- **两个新视觉工具补齐最后缺口**：`mindmap_generate`（MindNode 树 → 横向 tidy 布局：
  pass1 叶子高度后序汇总、pass2 列宽分配，三次贝塞尔连线，中文宽度按 1.0×字号估宽、
  超宽截断，深度上限 6）+ `flowchart_generate`（Kahn 拓扑分层取最长路径层，5 种形状，
  正交折线，decision 出边自动标「是/否」，环检测抛错），共 20 个测试含确定性断言
- **这批测试当场抓到三个真 bug**（不是摆设）：`MindmapSvg.lay()` 算盒宽用截断后 label
  而渲染存原 label（截断静默失效）；FlowNode 的 label/shape 缺默认值（编译期暴露）；
  MindmapSvgTest 正则贪婪匹配到 `rx="8"` 尾巴（测试侧修正）
- 验证：**194 个单测全绿**（163 → 194，新增 31）；APK 126,802,039 → 126,878,551 字节（+76KB）

### rc.97（versionCode 96）· 2026-10-24 · 六条弱项全部对齐电脑端（弱项对齐 + 拍板按桌面）

> 第三轮通读电脑端团队机制后列出六条差距；用户指令「弱的地方跟桌面端对齐，需要决定的地方
> 参照桌面端」—— 六条全部按桌面落地，包括两处需要拍板的。

- **队友会话可导航**（桌面 client-ui-agent-team 的 addressed-subagent 路径）：面板成员卡 / 成员日志页新增「进入会话」。进入后聊天视图就是该成员的会话（顶部导航条标明「正在看 teammate xxx 的会话」），输入框的话经 `teamUserMessage` 走 **send_message 同一条路径**：running 进收件箱在轮边界认领，inactive 冷恢复一轮。消息 2.2s 轮询 + 内核 team 推送双通道增量刷新，「退出」回 Lead 会话。failed 成员不可进入。不动 `state.sessionId`，不会在会话列表里产生幽灵项
- **phase 与 status 分离**（对齐 projection.ts）：`MemberPhase: provisioning|active|failed` 落日志并被回放校验（首记录必须 provisioning、只允许 provisioning→active/failed、**name/provider/context 不可变**）；「在不在跑」派生成 `MemberStatus: running|inactive`，权威来源是运行时 active 表，不进状态机。rc.96 旧日志（status 单字段）回放时自动映射，旧会话无损升级
- **多团队并存**（对齐桌面 TeamId=SessionId；拍板①按桌面）：每个顶层会话一支团队，roster / 任务板 / 收件箱 / 运行成员 / Lead 配置全 per-session 分桶，**TEAM_BUSY 移除** —— A 团队在后台跑，B 会话照常建队。成员数 / 任务数 / 并行数是插件级容量。成员线程的工具调用按 `TeamCall.callerTeamSid()` 落回**自己的团队**，用户切走也不会串台
- **团队与 subagent 互斥**（对齐 agent-team-profile；拍板②按桌面）：团队插件启用时主 Agent 的 `subagent` / `subagent_fork` 从 schema 摘除（提示词段落随 hasTool 自动消失），Lead 只用 spawn_teammate；与桌面一致，**底层 Subagent 服务仍供 teammate 使用**（深度 ≥2 时成员可再派），workflow 不受影响
- **成员 provider 字段对齐**：安卓无法跑外部进程后端（ACP/Claude Code/Codex/SDK），provider 恒 `in-process` 是平台边界；字段照桌面语义持久化并纳入不可变身份校验
- **消息字节 + 重复投递**（对齐 projection.ts 消息不变量）：消息大小按 JSON 序列化后的 UTF-8 字节算 64KB（错误带实际字节数）；回放校验「未入队先投递 / 入队两次 / 投递两次」三种违规均终态冻结，运行时 delivered 集合防重复投递
- 验证：团队域 **33 个单测全绿**（新增 5 个：phase 迁移、provider/context 不可变、旧日志映射、入队两次、投递三态）

### rc.96（versionCode 95）· 2026-10-24 · 团队设置与电脑端完全对齐；递归委派真正接上

- **设置页只剩两个旋钮**：并行上限（1–8，默认 8）+ 最大递归深度（0–4，默认 1），与电脑端「设置 → 子智能体 → 运行限制」逐字对应。轮次 / token 预算 / 单次时长全部删除 —— 成员跑到模型自己停下，和主 Agent 的循环一致；成员上限 16、任务上限 256 是桌面同款的结构上限，不在界面上出现
- **递归不是被禁止的，是之前没接**：`runSubagent` 原来把 `subagent` 从子代理的工具里硬过滤掉。现在抽出 `SubagentRunner`，深度按「主 Agent 0、子 = 父 + 1」传递，达到 `maxDepth` 才摘掉 schema；0 = 关闭子智能体（主 Agent 也看不到这个工具），1 = 只有主 Agent 能派（默认），2 起 teammate 也能再派下一层。运行时还有一道硬检查 —— schema 只是省 token，边界在执行器
- **并行上限按桌面口径**：同一主 Agent 下所有层级存活的子智能体合计，满了**拒绝**而不是排队（排队会让「父占槽等子」死锁）。手机端把它同时用于成员池大小与子代理容量，两池独立计数 —— 桌面是一个池子全算；差异写在对照文档里
- **普通子代理不再拿到团队工具**：`spawn_teammate` / `team_task_*` / `send_message` 等十个工具以前会跟着预设白名单进子代理的目录，而 `TeamCall` 默认 caller=lead —— 等于子代理能以 Lead 身份改任务板。桌面只有 Team 成员才有这些工具
- **回放期不变量与失败终态**（对齐桌面 `projection.ts`）：成员必须以 provisioning 开始、不可换会话身份、不能退回 provisioning、失败后不能复活；任务 revision 必须逐一递增。**任何违规 → 冻结在最后一条合法记录**，并把原因放进 `snapshot().failure`，面板顶部红条写明「哪条记录被拒绝」—— 之前是坏行静默跳过，用户看到自相矛盾的团队却毫无提示
- **fork 保真度**：桌面 `subagent-fork-in-process` 用父会话日志到最后一个 `turn/end` 为止的**真实事件前缀**播种；手机端之前只给「最后 60 条事件、每条 140 字的纯文本」。现在给最近 6 轮的**完整文本 + 每轮跑过哪些工具、成功还是失败**
- **冷恢复记得做过什么**：成员每次工具调用都往自己的会话写一条 `tool/result` 摘要，恢复时带进上下文 —— 队友不再「失忆」说自己没改过那个文件
- **改派要校验接收者**：桌面用 `resolveActiveMember` 解析，找不到就报错。手机端之前接受任意名字，名字打错一个字母就产生一个「无人认领」的任务；现在查名册，不存在 → `TEAM_MEMBER_NOT_FOUND`，成员已失败 → `TEAM_MEMBER_FAILED`
- **修掉「深度设置重启后丢失」**：面板的「递归深度 —」不是显示问题 —— 插件在 `ToolKernel` 构造函数第 393 行注册时写进的值，被第 523 行才执行的属性初始化器覆盖成默认值（Kotlin 按声明顺序执行初始化器）。把 `subagentLimits` 声明挪到插件注册之前即可
- **顺带修掉一个会自己踩的坑**：`pushTeamLimits` 原来把六个字段写死，收掉滑块后取不到的元素会得到 0，乘以 1000 传给原生再被 clamp 成下限 —— 等于「用户没动，预算被悄悄打到最低」。现在只发画面上真实存在的字段
- 验证：`assembleRelease` 通过；**52 个单测全绿**（新增 4 个委派测试 + 4 个回放不变量测试）；模拟器实测两项设置读写与落盘、深度改 2 后重启仍是 2、坏日志重启后面板红条显示「成员「ghost」的第一条记录不是 provisioning（是 active）」

### rc.95（versionCode 94）· 2026-10-24 · 团队机制二轮对账：把「静默断链」补齐

> 重新逐行读桌面 `agent-team` 的 9 个领域文件后，发现上一版漏了两条会让协作链**静默断掉**的东西，
> 另外四条是上一版自己标注「仍缺」的。这一版全部补上，并删掉了已废弃的 `TeamRegistry`。

- **队友能回话了（此前完全不通）**：`send` 里 `target=="lead"` 一律抛 `TEAM_TARGET_SELF`，而 teammate 的 identity 提示写着「用 send_message 向 lead 汇报」—— 结果队友一汇报就报错，整条链断在最后一步。现在用 `TeamCall` 线程局部身份区分调用者：teammate → lead 落 Lead 日志（`team/message`）+ 收件箱，Lead 在下一步（`agent/pre-step` 钩子，hook ctx 新增 `session`）或 `wait_agent` 返回值里认领，并写 `team/message-delivered` 回执
- **不再跨会话串台**：运行时只有一份 roster / 任务板，旧实现切会话就 `roster.load(B)`，A 里还在跑的成员会把自己的状态写进 B 的日志。现在 `attach` 遇到「别的会话还有人在跑」直接 `TEAM_BUSY`；`snapshotFor(sid)` 对未绑定会话返回空团队 + 原因，面板显示「另一个会话的团队还在跑」。**宁可拒绝，也不串台**
  **※ 现状（rc.97）**：状态按会话分桶后 TEAM_BUSY 已移除 —— 每个会话一支团队，与桌面 TeamId=SessionId 同构
- **provisioning 对账（不再是「一律转 inactive」）**：`TeamRoster.reconcile` 按桌面 `reconcileProvisioning` 的判据读成员自己的会话 —— 有首条任务说明创建其实成功（转 inactive，可唤醒），没有说明进程死在初始化阶段（判 failed 并写明原因）；running 仍收敛为 inactive。设备实测三种成员落点全部正确，且对账结果写回日志（4 行 → 7 行）
- **日志提交语义**：`SessionStore.append` 原来 `catch {}` 吞掉写失败，工具却回 ok。现在分两条路：状态类（成员快照/任务快照/首条任务）走 `appendOrThrow`，失败抛 `TEAM_JOURNAL_FAILED`；进度类（每轮 lastAction）尽力而为。同时按 sessionId 加写锁，AgentDriver 与团队写同一个 jsonl 不会交错出半行
- **准入截止 + 有界结算**：`shutdown` 先关 `disposed` 闸门（spawn/send 回 `TEAM_DISPOSED`），再取消已准入的成员，状态收敛同步做完，线程退出交给守护线程 5s 结算并汇总异常 —— 主线程不会被阻塞，也不会假装「都停了」
- **wait 不再白等**：`waitForChange` 返回 `CHANGED / TIMEOUT / CLOSED`，卸载时 `notifyAll`；`wait_agent` 把 `CLOSED` 如实回报为 `disposed`
- **几处对齐桌面**：成员名正则收紧成 `^[a-z0-9]+(-[a-z0-9]+)*$`（拒绝 `a--b`、`a-`）；`delete` 还有活动依赖时**拒绝**而不是替别人摘；任务板改「写时复制 + 提交后替换」，写失败不会留下 revision 对不上的半改状态；成员收件箱的补充消息带真实发送者（队友互发不再显示成「Lead 补充」）
- **删除**：`kernel/team/TeamRegistry.kt`（旧快照式任务板，已无引用）
- **验证**：团队领域层 **24 个单测全绿**（新增 10 个：写失败必须报错、写失败不占名字、写失败不留幽灵任务、被拒的状态迁移不改任务、provisioning 两种对账、消息回执、首条任务判据）；模拟器实测对账三种落点、快照/限额桥接、`agent/pre-step` 钩子装配（`10 个工具、1 个钩子`）

### rc.94（versionCode 93）· 2026-10-24 · 智能体团队（桌面 agent-team 完整移植 + 手机端增强）

- **一个插件，不是两个**：`agent-team` 同时注册服务（`team.runtime` / `team.roster` / `team.board`）、贡献十个工具与 team policy。桌面拆成 `agent-team` + `tool-agent-team` 是 Cordis 生态的包粒度，安卓照搬只会得到「插件列表两条、关一条就半死」；框架层补 `PluginContext.provide()`，服务随插件启停自动注册/注销
- **工具对齐桌面九个**：spawn_teammate / send_message / list_agents / wait_agent / interrupt_agent / team_task_create / team_task_list / team_task_get / team_task_update；新增 `team_status`（成员 + 任务板 + 预算全景，面板也读它）。旧 `list_agents`/`send_message`/`interrupt_agent`（AgentControlPlugin）与 `spawn_teammate`/`team_task_*`/`wait_agent`（CompatPlugin）全部删除，工具名不再两处注册
- **限额可在设置页改**（设置 → Agent → 智能体团队）：同时执行 1–4、每人轮次 4–20、输出预算 20–200k tok、单次时长 5–30 分钟、成员上限 4–32、任务上限 32–512。拖动即热更新运行时（池大小用 `ThreadPoolExecutor` 调 core/max；**已在跑的成员按启动时的预算跑完，新唤醒的按新值**，缩并发不会踢掉正在干活的成员），并写回 `files/kernel/config.json` 的 `config.agent-team`
  **※ 现状（rc.96）**：设置页只剩「并行上限 + 最大递归深度」两项（与电脑端一致）；轮次/token/时长全部删除
- **领域层**：`TeamJournal`（roster/task 全量事件落 Lead 会话日志，可回放）/ `TeamRoster`（名字永久保留、provisioning→running⇄inactive、failed、maxMembers 含失败成员）/ `TeamBoard`（CAS、DAG 环检测、ready 派生、写范围重叠、tombstone、maxTasks）
- **运行时**：独立有界池（默认 2）+ 每成员独立 session（`<leadSid>#<name>`）+ 轮次/token/墙钟预算 + inbox 轮边界 steer + 冷恢复 + `waitForChange` 条件变量（不再 200ms 轮询）
- **手机端比桌面多做的三件事**：① 写租约 —— `writeScopes` 从「提示」升级成「先查再拒」，跨任务重叠写入返回 `TEAM_WRITE_CONFLICT`；② 后台危险操作直接拒绝（无人确认），留诊断而不是挂起；③ `TeamKeepService` 前台保活 + 通知栏显示在跑成员，切走 App 队友继续跑
- **UI**：会话顶栏团队徽标（在跑人数）+ 团队面板（成员卡/任务板/预算/写冲突标记），点成员看它自己的对话，running 可从面板中断
- **踩坑**：① `runSubagent` 是同步阻塞且借用父轮 runtime，直接 `Thread{}` 起 teammate 会随轮次结束失效 —— 团队运行时必须自己拼 `ToolPipeline`；② `TeamTask.view()` 是顶层扩展函数，插件包不 import 就 Unresolved reference；③ 团队快照每个工具调用都推会把 WebView 刷屏 —— revision 照跳、快照推送按 800ms 节流；④ `startForegroundService` 在团队工作线程调用会撞 non-main-thread，一律 post 主线程
- **验证**：`assembleRelease` 通过；团队领域层 12 个单测全绿（CAS 过期拒绝、依赖成环拒绝、tombstone 不复用 id、删除解依赖、写范围租约、重启回放收敛 running）；模拟器实测 —— 插件列表只有一条 `agent-team（10 个工具）`、`team:policy` 进入系统提示、团队面板空态与满态渲染正常、限额拖动后 `teamLimits` 立刻返回新值且 `config.json` 落盘、重启后装配日志读到 `并发 3`、空团队时顶栏徽标 `display:none`



> **※ 现状（rc.84 – rc.91 陆续推翻）**：aishell3 语料与「温柔/少年」两档早已不存在 ——
> 语料经历了 aishell3 → fanchen-C → theresa → 只剩 fanchen 男声单包四轮换代；
> 「设备音色不出面板」也已反转（经典女就是系统原声，且直接列在音色浮窗里）；
> 8kHz 清晰化链保留在代码里但当前不走到。本条目只反映最初一版的设计。

**内置音色：只留两个，都是真人声**
- 语音输出不再依赖「本机装了哪些语音包」：随包内置 sherpa-onnx VITS aishell3（174 个真人说话人，31MB，`assets/tts-neural/`），离线、零下载
- 音色表**只保留两个**（用户在 174 个说话人里试听选定）：温柔（sid 20，女声，基频约 250Hz）/ 少年（sid 46，男声，基频约 140–160Hz）
- 之前那批「御姐/萝莉/学妹/清纯/奶狗/气泡/正太/霸总」原型全部移除：朗读语料换 speaker 做不出动漫配音的味道，与其给一堆半像的，不如给两个真的清楚、能长期听的
- 设备自带音色不再出现在音色面板里（同一套音色会以 `-local`/`-network`/多语言变体重复出现，又长又分不清）；它只在英文句子、或神经引擎不可用时**自动兜底**，不需要用户设置

**口齿清晰化（固定开启）**
- aishell3 原生 8kHz、带宽 4kHz 封顶，直出会发闷、字头发糊。新增一条不改字的处理链：80Hz 高通去低频轰鸣 → 1.5kHz 以上临场 +55%（中文声母集中在这段，字头才咬得住）→ 一阶包络轻压缩 → 峰值归一 → 升采样 16kHz
- 实测：频谱重心 +80~180Hz，1–4kHz 能量占比 0.18→0.25 / 0.15→0.22（女/男），同一句话明显更「清楚」
- 与系统 TTS 那条路共用同一套音量/明亮度塑形；A/B 试听页见 `D:\1\voice-out\试听AB.html`（每次生成，不入库）

**路由与速度**
- `voice/TtsRouter`：纯中文口语走神经音色；英文成词（连续 ≥5 字母）或英文占比 ≥50% → 系统引擎；日文/韩文/表情 → 系统引擎；短缩写（CPU/OK）先唱名化（「西屁优」）再进模型，避免被静默吞掉
- 分句合成、合成一句播一句（`AudioTrack` 直出，不经 WebView），首音约 0.9s；模型常驻，`onTrimMemory(CRITICAL)` 或空闲 5 分钟释放
- `OfflineTts.generate` 加串行锁：JS 桥线程与朗读线程同时进来时不再互相拖慢/卡死（实测曾卡到 14s）
- 语音条结果走 LRU 缓存（`filesDir/voice-cache`，上限 20MB，面板可一键清空）

**工具与文档**
- `scripts/tts_calibrate.py`：扫全部 174 个说话人、估中位基频并分桶，输出候选与建议行（本次选音色就是用它 + 人工试听）
- `scripts/voice_sample.py` 修一个真 bug：`fmt` 元组只有 6 个字段却取了 `fmt[6]`，任何 16bit WAV 都会 IndexError
- `com/k2fsa/sherpa/onnx/Tts.kt` vendored 说明：必须用 master 版（`.so` 的 JNI 会找 `OfflineTtsZipVoiceModelConfig`，用 v1.12.15 的 kotlin-api 会直接 JNI abort）

### rc.93（versionCode 92）· 2026-10-24

**Q 弹动效全线收敛（弹而不跳）+ 长上下文渲染优化**

动效（所有带过冲的动画统一改「缓和优雅」）：
- 快选浮窗：`pop-bounce`（0.9→1.02→1 硬关键帧回弹，0.34s，过冲 1.4）→ `pop-in` 单段缓出，
  靠曲线自带 8% 过冲自然溢出（0.38s）；**补上退出动画**——以前关闭是瞬间 `remove()`，弹出有动画、消失硬切
- 底部浮窗 `sheetPopIn`：过冲 -1.6%→-0.9%，时长 0.58→0.52s，曲线换 `--spring-soft`
- 语音卡 `cardPopIn`：过冲 -3px/1.02 → -1.5px/1.006，0.5→0.46s
- 按压回弹：1.34 过冲→1.16，0.46→0.5s，收尾帧不被提前清掉（清理定时器 470→520ms）
- 浮窗内按压项 1.7 过冲→1.2；`--spring/--spring-soft` 变量本身软化（1.32/1.18→1.12/1.08）

长上下文渲染：
- **`renderThread` 分帧分批**：以前一次性 `innerHTML` 几百条消息（markdown/代码/图片）同步解析
  卡住首帧数秒；现在尾部 40 条先出（看到的永远是最新消息），更早历史每帧往前补 60 条，
  插入时按「视口底边距文档底的距离」补偿 scrollTop，视口纹丝不动
  （`#chatScroll` 关闭浏览器 scroll anchoring，避免与手动补偿叠加跳动）
- **流式绘制自适应节流**：`md()`/morph 成本随正文长度线性涨，打字越到后面越卡——
  绘制间隔随正文长度放宽（48ms→88ms→120ms），肉眼无感但主线程不再被吃满
- 调试钩子 `window.__dsh` 补 `renderThread`；模拟器实测：400 条消息首帧 41ms、
  分批补齐完整、上翻后滚动位置稳定

### rc.92（versionCode 91）· 2026-10-24

**修「经典女是男声」**

- **根因**：系统引擎的音色只在引擎创建回调里挑一次（`ensureTts` → `applyVoice`），
  `setGender` 改了性别偏好却不重挑 —— 用户先用经典男（此时性别偏好被写成 male，
  系统引擎按 male 挑了 `cmn-cn-x-ccd-local` 男声），再点「经典女」时引擎还在用那个男声念
- **修复**：`setGender` 变更后立刻重挑系统音色（清 `lastVoiceName` 强制重挑），双向实测：
  male → female 音色 `x-ccd`(男) → `x-cce`(女)，female → male 反向同样生效
- **加固**：`applyVoice` 想要的性别没有标注音色时，回落池排除「明确是对立性别」的音色，
  宁可用未标注音色也不让「选女声」挑出男声
- **连带修**：`setGender` 清 `neuralVoiceId` 漏了 `.apply()`，重启后旧 id 会复活

### rc.91（versionCode 90）· 2026-10-24

**女声模型下线（只留经典男单包）+ 语音条直发**

- **女声不再内置模型**（用户拍板「女生用 TTS 默认女声，只留经典男一个模型」）：
  17 号（theresa）模型删除，目录 `tts-neural` 复用为男声包（fanchen sid 69，16000Hz），
  `assets/tts-neural-m/` 不复存在；APK 155MB → **约 127MB**
- 「经典女」= 系统 TTS 自带女声（原声不变调，默认档）：选它时完全不加载模型；
  音色浮窗简化为两档并列（经典女系统原声 / 经典男内置模型），删除「神经」开关及全部相关文案
- **输入框语音转文字下线，改为微信式语音条直发**
- 用户按住输入框麦克风直接录一条语音条发出：录音保存到 `cacheDir/voice-in/clip-*.wav`（保留最近 20 条）
- 聊天流里用户气泡直接渲染语音条（波形 + 时长），点击可回放（dataUrl 读取，限 8MB）
- agent 侧收到的仍是识别后的文字（识别在发送前完成，`state.pendingVoice` 携带）

### rc.90（versionCode 89）· 2026-10-24

> **※ 现状（rc.91 推翻）**：条目里「两个包 / 双包分发 / 17 号与经典男两档」的表述已过时 ——
> rc.91 删掉女声包，`VoiceCenter` 回到单引擎。其余死代码清理与注释更正仍然有效。

**语音模块整理（只动代码质量，行为不变）**

- **删死代码**：`NeuralTts.releaseIfIdle`（从未被调用，实际释放走 `onTrimMemory`/`release`）
  与它独占的 `lastUsed` 字段（6 处写入、0 处读取）
- **修掉三处「注释与实现矛盾」**（这类最难查）：
  - 类注释说「用 `generateWithCallback` 边合成边播」，实际明确**不能用**（D8 脱糖 + JNI 装箱签名 → abort）
  - 「加载 30MB onnx / 187 个角色音色」→ int8 32.6MB / 两包各一档
  - 「模型是 8k，toWav 升到 16k」→ 两个包分别是 22050 / 16000，不存在升采样
- **注释收束到事实**：清晰化链（`VoiceProsody.clarity`）注明是给 8kHz 窄带旧包补口齿用，
  当前两个包都不会走到，留着只为将来换低采样率模型时不忘
- **`VoiceCenter` 类注释**补上双包分发（`activePack` + `neural` 只读属性）与
  「停止必须同步」的原因（异步停 = 叠音）
- **`TtsRouter` 音色描述**同步为「17 号 / 经典男」
- **测试补强**：`TtsRouterTest` 增「旧 id 迁移」用例（`wenrou → anime_f`、`bazong → classic_m`），
  显式 id 优先于性别的断言改成新 id；`TtsVoiceTableTest` 的 sid 唯一性按包判定
- 项目内音色资产已收敛为**两个包**（`tts-neural` 女声 / `tts-neural-m` 男声），
  其余试听音频、原始 fp32 模型、ASR 调研残留全部清空

### rc.89（versionCode 88）· 2026-10-24

> **※ 现状（rc.91 推翻）**：「17 号」女声模型与**双包架构**已整体下线 —— rc.91 起女声用系统原声，
> 只剩经典男单包（`tts-neural`，约 34MB），APK 155MB 回落到约 127MB。
> 防叠音四级机制、sid 包内唯一的测试约定仍然有效。

**只留两档：17 号（动漫女声）+ 经典男，并修掉试听叠音**

- **女声收到 1 档**：用户从 37 个试听候选里选定 #17 → `vits-zh-hf-theresa` 的 sid 461（272Hz/亮度 1534）
- **男声用「经典男」**：`vits-zh-hf-fanchen-C` 的 sid 69（125Hz/亮度 396），说话人表裁到 1 行
- **其余音色全部删除**：两个模型的说话人表都只留 1 行，其余档在模型里物理不存在；
  试听音频（37 个 wav + 两个播放页）、下载的原始模型、调研残留一并清掉
- **双包架构**：`assets/tts-neural`（女声 22050Hz）+ `assets/tts-neural-m`（男声 16000Hz），
  各带 int8 QDQ 模型（32.6MB）；`NeuralTts` 改为每个包一个实例，`TtsAssets.Pack` 描述目录与字节表
- **修试听叠音**（用户报的 bug）：原来 `speak()` 每次 `Thread.start()` 且不掐上一句，
  连点几次就有几条 AudioTrack 同时出声。现在四级防护：
  单线程 `speakQueue` + 每次先 `hardStop()` + `speakSeq` 让排队任务退出 +
  `NeuralTts.gen` 代次让写音频循环立刻收手（光靠 `cancelled` 会被新一句重置而"复活"）
- **测试同步**：`TtsVoiceTableTest` 的「sid 全局唯一」改为「同包内唯一」（两档 sid 都是 0），
  旧 id 迁移、默认档、包存在性都补了断言
- APK 121MB → **155MB**（多带一个 32.6MB 的男声模型，双模型是必然代价）

### rc.88（versionCode 87）· 2026-10-24

> **※ 现状（rc.89 → rc.91 推翻）**：theresa 语料与四档女声（甜妹 487 / 元气 529 / 御姐 35 / 清冷 242）
> 已不存在 —— rc.89 收敛为 17 号一档，rc.91 女声模型整个下线。int8 QDQ 量化路线
> 与「裁音色省不出体积」的结论仍然成立（现在的男声单包就是这套工艺）。

**音色全部换成动漫角色 + int8 量化（APK 206MB → 121MB）**

- **语料换代**：`fanchen-C`（中文多音色，非动漫）→ `vits-zh-hf-theresa`（《原神/崩坏3》角色合集，804 档，22050Hz）
- **四档**：甜妹（sid 487）/ 元气（529）/ 御姐（35）/ 清冷（242），说话人表裁到 4 行，其余 800 档物理不存在
- **int8 静态量化（QDQ）**：122MB → 32.6MB，RTF 0.27x → 0.14x（快 1.9 倍，走 MLAS int8 kernel）
  - 频谱差异 0.57–0.60，与「同模型跑两次」的噪声基线 0.58–0.64 相同，测不出额外降质
  - 动态量化被否决：体积 39.8MB 但 RTF 0.26x → 3.6x（Conv 量化后要插反量化节点，慢 13 倍）
- **为什么裁音色省不出体积**：说话人表 `emb_g.weight` 只有 4KB（0.003%），122MB 全在声学网络
  （189 个 Conv + decoder ConvTranspose）—— 体积只由「模型份数 × 精度」决定，与音色个数无关
- **新增 `scripts/tts_quantize.py`**：裁说话人 + int8 QDQ 两种能力，一条命令复现

**一个必须说明的事实**：按角色名发布的 `eula` / `keqing` / `bronya` / `echo` / `doom` /
`zenyatta` / `abyssinvoker` 与 theresa **是同一份 804 档合集的不同导出**（字节数完全相同
121,913,906、`n_speakers` 都是 804），实测 F0 218–334Hz，**全为女声**。
所以「动漫男声」在开源 sherpa-onnx 中文 TTS 里不存在 —— 四档只能是女声，
要男声只能回退非动漫语料（`fanchen-C` 的 125Hz/167Hz）。

### rc.86（versionCode 85）· 2026-10-24

> **※ 现状（rc.88 推翻）**：这里的五档（经典女 sid 1 / 少年 / 甜妹 / 御姐）是 fanchen 语料上的
> 临时排布，rc.88 换 theresa 语料时全部作废；rc.91 起「经典女」= 系统 TTS 原声（不再是模型档），
> 「经典男」= fanchen sid 69 单包。八度校正与返回层级修复仍然有效。

**音色按需求重排 + 模型裁剪**
- 保留原「霸总」那条 → 改名 **经典男**（sid 0）
- 新增 **经典女**（sid 1，239Hz 中音）
- 其余三档全部换人：**少年**（sid 2）/ **甜妹**（sid 3）/ **御姐**（sid 4），与旧版没有一条相同
- **模型裁剪**：`emb_g` 187 → 5 行、metadata `n_speakers=5`，其余 182 个音色在模型里物理不存在
- 选型重做：对 187 档全量合成，并用**八度校正**的自相关估基频（之前短句采样把女声算低一个八度，
  误以为有男声/漏掉真男声两头都踩过）
- `auto` 默认改为**经典女**（中性耐听）；旧 id（bazong/naogou/tianmei/yujie/温柔/少年）自动迁移

**返回手势按层级逐层关闭（修复）**
- 之前 `DSHHandleBack` 只处理全屏查看器与面板，漏了音色/模型这类**气泡浮层**：
  按返回会先把下面的面板关掉，气泡还挂在屏幕上，只能点空白处消失
- 现在顺序是：气泡浮层 → 全屏查看器 → 面板 → 页面（模拟器实测：第一次返回只关气泡，面板仍在；
  第二次返回关面板回设置页）

**措辞更正**
- 面板里「内置角色音色」改为「内置音色」——这批音色来自中文多音色模型，**没有核实是动漫角色**；
  已核实的动漫语料（theresa/原神崩坏3）只有女声，这一点写进了 `VoicePack.PROVENANCE`

### rc.85（versionCode 84）· 2026-10-24

**语音层收口：MainActivity 不再持有语音逻辑**
- 新增 `voice/VoiceCenter.kt`：引擎选择、音色解析、五项微调、朗读、语音条合成、系统音色打分、
  状态 JSON、prefs 读写、模型生命周期**全部收口**；线程约定写在类注释里
  （构造/set* 任意线程；speak 自己切线程；只有系统 TTS 的创建与 speak 需要主线程）
- `MainActivity` 1618 → 974 行：删掉 16 个语音状态字段与约 600 行方法体，
  只保留 `@JavascriptInterface` 转发；`VoiceBridge` 的方法签名一行没改
- 生命周期归位：`onTrimMemory → voiceCenter.onTrimMemory()`、`onDestroy → voiceCenter.release()`；
  `onCreate` 提前构造一次，保证第一句就用对音色
- 行为等价：语音条缓存键仍是 `音色|音量|明亮度|语速|文本`，路由规则（英文成词→系统引擎）未动

### rc.84（versionCode 83）· 2026-10-24

> **※ 现状（rc.88 → rc.91 推翻）**：fanchen-C 116MB fp32 全量包、206MB APK、四档（霸总/奶狗/甜妹/御姐）
> 都已不存在 —— 后来量化到 32.6MB（rc.88）、换 theresa 语料又换回（rc.88–rc.89）、
> 最终只留男声 sid 69 单包，APK 约 127MB（rc.91 起）。本条目只反映当时状态。

**音色资源整体换成角色音色**
- 内置包：`vits-icefall-zh-aishell3`（174 个真人朗读说话人、8kHz、31MB）→
  `vits-zh-hf-fanchen-C`（187 个中文角色音色、16kHz、116MB）。APK 124MB → 206MB
- 四档全部是角色配音，不再有真人朗读语料：
  | 档位 | sid | 中位基频 | 频谱重心 | 听感 |
  |---|---|---|---|---|
  | 霸总 | 69 | 124Hz | 370Hz | 最低最暗，句子慢半拍 |
  | 奶狗 | 183 | 174Hz | 586Hz | 少年音，语速偏快、尾音上扬 |
  | 甜妹 | 33 | 286Hz | 761Hz | 最高最亮，气声轻 |
  | 御姐 | 9 | 216Hz | 763Hz | 中低女声，稳、不飘 |
- 选型可复现：新增 `scripts/tts_voice_probe.py`，对全部 187 个 sid 合成同一句，
  量中位基频 + 频谱重心 + 时长，按「低而暗 → 高而亮」分档（桌面 sherpa-onnx 推理，几分钟跑完）
- 老用户的音色 id（温柔/少年/m1..f2）自动迁移到新档位，不会被重置成默认
- `auto` 默认落**甜妹**（延续旧版女声听感，不让人一升级就换个性别）
- 模型加载窗口 2.5s → 8s：116MB 冷加载 1.2–4.8s，原窗口会让第一次朗读退回系统音色

**语音层架构清理（去历史遗留）**
- 新增 `voice/VoicePack.kt`：包名/来源/采样率/说话人数/许可**单点声明**，`neuralJson` 一并上报
  （`packId / packName / packSource / packLicense`），换包只改 3 处：VoicePack + TtsAssets 字节表 + 四行 sid
- 删除 `assets/tts-neural/speakers.txt`（模型不带说话人名，旧编号表已无用）与
  `scripts/tts_calibrate.py`（手机 CDP 标定脚本，已被桌面探针取代）
- 口齿清晰化链改为**按采样率启用**：8kHz 老包才补 1.5k 临场，16kHz 音源再 +55% 会发刺
- 清掉全仓库的 `aishell3` / `174 个真人说话人` / `8kHz` / `m1/m2/f1/f2` / 「云端音色」等过期措辞
  （代码注释、设置面板文案、README、诊断 JSON）

**许可提醒**：上游数据集（lkz99/tts_model）未标注明确许可证，本项目按个人使用内置；
商用请自行确认上游授权，或换 `matcha-icefall-zh-baker`（Apache-2.0）等许可明确的模型。

### rc.83（versionCode 82）· 2026-10-24

**工具质量收尾（rc.82 待办四项全部落地）**
- 进程树终止：`bash` 超时与 `job_kill` 不再只杀 `sh`。新增 `/proc/<pid>/stat` 扫描建树 + 从叶子 `kill -9`，gradle/curl/sleep 这类孙进程不会变成孤儿继续吃电量；`Job` 增加 `cancel` 钩子，`job_kill` 先硬终止进程再打断线程
- `terminal_read` 偏移基准：环形缓冲裁剪时累计 `dropped`，offset 一律按「会话开始」的绝对位置解释；起点已被裁掉时明确告知而不是返回别处文本；顺带修掉 SIGINT 往 stdin 写 0x03 污染下一条命令
- `plugin_create` 回滚：先写 tmp → 构造校验 → rename，旧清单备份 `.bak`；装配后按「实际装配出的工具」判断成败，失败回滚旧版本并报错，不再出现「旧版本被毁、新版本不可用、还返回 ok」
- `spawn_teammate` 接线：新增 `RuntimeTools.subagentAs(agentId, …)`，注册表里那条记录就是真正在跑的子代理 —— `interrupt_agent` 置的 cancelled、`send_message` 投的 inbox 终于生效

**动效（三条）**
- 按压形变：按住按钮拖动时沿拖动方向拉伸、垂直方向挤压，松手带过冲回弹；transform 只有 scale/skew，**没有位移**，按钮不跟手走（底部 tab 除外，它自己有拖拽切页手势）
- 浮窗 Q 弹：面板弹出走「冲过 1.6% → 回落 → 归位」的关键帧，收起换成快出曲线；语音浮层同样轻弹上来；`prefers-reduced-motion` 下自动关闭
- 滚动缓起缓停：新增 `easeInOutCubic` 程序化滚动，聊天回底、长列表跳转不再匀速硬切；流式输出每帧只差几像素时直接贴底，避免动画互相取消拖影

**浮窗文案精简（只动浮窗）**
- 权限面板：分组说明全部压到一个词（语音输入 / 定位与附近 / 查找联系人 / 拍照提问 / 读取本机媒体 / 完成与回复提醒），引导长句改成一句话
- 各设置面板：16 条说明性文案精简（"新会话默认用这个模型"→"新会话默认"、"关掉插件，它的工具立即消失"→"关闭后工具消失" 等）
- 运行时兜底 `simplifySheetCopy`：`.sheet-sub` 去掉括号补充、只留第一句、超长在自然断点收；状态行（含数字/URL/·）原样保留

### rc.82（versionCode 81）· 2026-10-23

> 本轮不做新功能，只做工具质量：三组并行审计（文件执行 / 手机设备 / 媒体元能力）逐行核对实现，
> 修掉「工具说谎、白干、崩溃」这类用户能感知的缺陷。

**会骗人的工具（最坏的一类，全部修复）**
- `read_doc` 分页永远 `has_more=false`：原先用「本次读到的长度」当总长，20 万字文档读 1.2 万字就宣称读完，模型据此漏答后半部分。改用 `DocReader` 截断前的真实总长
- `undo restore` 失败被包成成功：`{"ok":false}` 嵌在外层 `ok:true` 里，用户以为文件已还原。现在失败直接报错
- `update_goal`/`notify` 之外的 `bash` 后台任务永远 `exit=0`：退出码靠匹配「超时」二字判断（且该分支是死代码）。改为从 `exit=N` 头解析真实退出码
- `notify` 在 Android 13+ 无通知权限时静默丢弃却报成功；固定通知 ID 还会让「下载完成」「转码完成」互相覆盖。现在预先检查权限 + 每条独立 ID
- `alarm_set` 弹界面模式下用户不确认也报「已创建」。现在如实说明「需要用户确认，取消就是没创建」
- 图片生成填错端点也报成功（把 base URL 当完整端点 POST 必然 404，又被 SVG 兜底掩盖）。现在自动补 `/images/generations`，4xx 配置/鉴权错误直接抛出不再兜底

**会白干或崩溃的（修复）**
- `photo_capture` 在 Android 11+ 完全不可用：`<queries>` 缺 IMAGE_CAPTURE，`resolveActivity` 恒为 null → 永远报「没有相机应用」。补 queries + `FLAG_GRANT_WRITE_URI_PERMISSION` + clipData
- `read`/`read_doc`/`gallery_read` 没有入口体积限制，先 `readBytes()` 再判断上限等于没判断。三处都改为先查大小/限长读，超限给可操作的错误
- `gallery_read(kind="all")` 只查图片表，视频永远查不到
- `findNode` 最后 `?: pool.firstOrNull()`：文本没匹配就点第一个节点 —— 静默改错用户设置。删掉兜底，空文本直接不匹配
- `terminal_send` 的 `before` 在写入之后才取，快命令输出被吞掉，返回「暂无新输出」
- `memory.json` 非原子覆盖写 + 解析失败当空库：进程被杀一次就等于整库清空。改为 tmp+rename 原子写、保留 .bak、损坏时自动恢复
- 图片进对话：`gallery_read`/`photo_capture` attach 统一下采样（rc.81 已有），本轮补上读取前的体积防护

**诚实性与一致性（修复）**
- `memory` 用的 `session.current` 服务根本不存在，会话记忆一直是全局桶；去重也不比 sessionId。改用 `agent.session`
- `memory_search` 在目录里是只读工具（进并发池）却回写整库，与 `memory_save` 互相覆盖。命中计数不再落盘
- `str_replace_editor`/`apply_patch` 的写入不进撤销档：undo 列表里根本没有它们，工具描述承诺的「撤回刚才的改动」是假的。现在全部留档
- `session_event_search` 用整段 JSON 做 contains：搜 `type` 命中每条事件，空 query 返回前 50 条。改为只匹配值字段，空 query 报错，返回 `total_hits`/`truncated`
- `write_pdf` 描述宣称「文字可选中/可搜索」，实现是不可选中（Type3 字形）。描述改成与实现一致
- `sticker_look` 被登记为只读却调视觉模型并写库 → 30s 并发超时会毁掉整批结果。改为非只读
- `location_get` 允许 60s 但只读批次 30s 超时；上限压到 25s
- `write_zip` 打包工作区时会把 `.dsh` 撤销存档一起打进交付包。已排除
- 时区 `UTC+5` 丢分钟（印度 +5:30）；经纬度 `%.5f` 在逗号小数点地区会输出 `39,90`。均已修正
- xlsx 工作表重名会让 Excel 报「需要修复」，现在自动加 `(2)`/`(3)`

**待办（已记录，未在本轮修）**
- 进程组终止：超时/`job_kill` 只杀 `sh` 本身，孙进程仍活着
- `terminal_read` 环形缓冲裁剪后 offset 语义漂移
- `plugin_create` 覆盖已有插件失败时无回滚
- `spawn_teammate` 的外壳记录与真实子代理未接线

### rc.81（versionCode 80）· 2026-10-23

**复审修复：5 个死工具（修复）**
- 第 2 轮插件集复审发现：FsPlugin 的 `move`/`copy`、MemoryPlugin 的 `memory_update`/`memory_clear`、StickerPlugin 的 `sticker_remove` 一直注册着，但既不在 ToolCatalog（被 fallback 判成 PLUGIN 组）也不在任何 Presets 白名单——**任何档位下模型都看不见**。本轮补齐两处登记，5 个工具第一次真正可用
- `memory_clear` 定为 DESTRUCTIVE（清整库不可逆），其余照旧语义

**token 炸弹拆除：图片进对话统一下采样（修复）**
- 新增 `kernel/device/ImageResize`：attach 前解码 → 最长边压到 1600px → JPEG 85 重编码（≤400KB 透传、GIF 不动）
- `gallery_read` attach（原最大 8MB 原图直接 base64 ≈ 10.7MB 进对话）与 `photo_capture` attach 都改走它，体积降到约 1/8~1/15

**系统时钟插件（alarm 插件 · 新增）**
- `alarm_set`：在系统时钟 App 里建闹钟（ACTION_SET_ALARM，默认弹界面确认、可 skip_ui 静默创建）——schedule_create 只会应用内提醒，「明早 8 点叫我」从此落到系统时钟
- `timer_set`：系统时钟倒计时（ACTION_SET_TIMER）
- 零运行时权限（SET_ALARM 为 normal 级安装权限）；Manifest 补 SET_ALARM 权限与时钟包可见性 `<queries>`

**手机状态插件（system-info 插件 · 新增）**
- `device_info`：电量/充电状态、存储余量、网络类型（wifi/cellular/断网）、机型系统——Agent 自己判断「存储够不够」「是不是断网了」。纯只读零权限
- `location_get`：单次定位（LocationManager，fused > gps > network 自动选路，同步等待可设超时）——「附近有什么」「本地天气」的坐标入口

**日历与联系人插件（personal-data 插件 · 新增，默认关闭）**
- `calendar_read`（未来 N 天日程）、`calendar_create`（建系统日程）、`contacts_search`（通讯录搜索）
- **故意不进任何内置档位**：日程/联系人属高敏个人数据。想启用在 `files/kernel/presets.json` 的 overrides 里手动加白（如 standard: {"add": ["calendar_read", "contacts_search"]}），重启生效——overrides 机制正好为此准备
- Manifest 补 READ_CALENDAR / WRITE_CALENDAR（READ_CONTACTS / 定位权限此前已有）

### rc.80（versionCode 79）· 2026-10-23

**解锁真实手机数据（device-media 插件 · 新增）**
- `gallery_read`：MediaStore 查询系统相册（图片/视频，按时间/数量取），可读入对话给多模态模型——「看看这张截图」「整理相册」从此可用
- `gallery_save`：把工作区里的图片/视频存进系统相册
- `file_import`：拉起系统文件选择器（SAF），把任意应用里的文件导入工作区
- `file_export`：写出到系统下载目录，系统与其它应用立即可见
- 全部走 MediaStore / SAF 系统 API，不需要任何全局存储权限，隐私面可控

**采集与出口闭环（capture 插件 · 新增）**
- `photo_capture`：拉起系统相机拍照落工作区，接 `read_image` 即成「拍文档 → 识别 → 处理」闭环
- `transcribe`：系统语音引擎实时转写（中文），同时存一份录音到工作区
- `share_file`：系统分享面板，把工作区产物直接发到微信 / QQ 等外部应用

**会话档位过滤层（对齐桌面四模式）**
- 标准 / PTC / 极简 / 创造四档工具白名单（`agent/Presets.kt`，桌面 `agent-preset-registry` 的手机移植）
- **PTC 收口**：模型直接可见的只剩 `run_code` 一个 schema（130 → 1），原生工具清单以速查表进系统提示，`dsh.callTool` 程序内调度
- 用户覆盖文件 `files/kernel/presets.json`：按档位 add/remove 工具，写坏自动回退内置
- 新增工具会自动进档位目录（`ToolCatalog` 登记组别即可）

**界面**
- 设置新增「新对话默认档位」行（运行分组）：新会话的初始档位，对话内仍可随时用模式条切换
- 设置页 7 处图标撞车修复（陪伴式畅聊→笑脸、联网搜索→放大镜、搜索接口→铅笔、默认档位→人形、图片/视频模型→播放、危险操作→眼睛、完成后通知→对勾），同页零重复

### rc.79（versionCode 78）· 2026-10-23

**陪伴式畅聊 · 主动触发性（companion v1.1）**
- 前台服务保活：开启陪伴即驻留一条静默通知，后台/锁屏期间心跳照常到点，关掉即撤
- Doze 兜底闹钟：深睡期间每 10 分钟看一次表，不再整段缺席
- 后台开口：心跳到点时人在后台也照样生成、落库并走系统通知送达
- 语音闭环：它开口即自动出声（以前只是插一条语音条，不点永远不响）；新增「语音回聊」开关 —— 它说完自动接麦，识别结果自动发送，全免手
- 设置面板显示后台保活状态，电池未加白时给出提醒

**电脑联动 · 传输稳定性（dsh-mobile-link v1.1）**
- 请求幂等键：弱网重试绝不把同一条消息发两遍
- 应答补投：桌面端结果 POST 失败自动重试 3 次
- 断线退避收紧（30s→12s）+ 抖动，消除「电脑不在线」假警报；中继离线判定 60s→45s
- 手机侧网络错误最多重试 3 次，504 也可安全重试

### rc.77 – rc.78（versionCode 76–77）· 2026-10-23

- 电脑会话浮窗：底部渐隐修复（内容滚动/异步填充后遮罩实时重算）
- 连接电脑：移除 / 重置配对按钮增加忙碌态与错误提示
- 桌面插件同步清理二维码遗留代码
- 全部 22 内置插件/128 工具升级：SPILL 上限 6000→24000、ShellTool 大输出死锁修复、apply_patch 空行崩溃修复、参数预校验、Fs move/copy、read_doc 分页、memory_update/memory_clear、HttpDownload 共享下载工具等
- 桌面插件 `dsh-mobile-link` 整理为官方 DSH 插件格式并发布（v1.0.0）

### rc.76（versionCode 75）· 2026-10-23

- 首个公开发布版本。

## 组件版本

- Harness 基座：`dsh-v0.2.1-rc.2`（已下载至 `../dsh/deepseek-harness-dsh-v0.2.1-rc.2`）
- 荣耀 UIKit：`uikit_hnvisual` `hnvisualeffect-11.0.0.134`（aar 在 `app/libs/`，文档已解压至 `../honor-uikit`）
- App：`0.2.1-rc.98`（versionCode 97；发布 APK 在仓库根目录与 `../dsh-mobile-release/`）
- 桌面插件：`dsh-mobile-link` v1.1.0（`../dsh-mobile-link`，GitHub `xiaobaga281/dsh-mobile#desktop-plugin`）

## 许可

MIT
