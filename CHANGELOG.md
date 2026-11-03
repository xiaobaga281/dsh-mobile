# 更新日志（Changelog）

> 自 rc.152 起，本文件与 README 的[版本历史](README.md#版本历史)同源同步（内容一致，此处按版本归档）。
> 两份若有出入，**以 README 的版本历史为准**；新增版本只写 README，再同步到这里。

> **rc.162–rc.202 的条目为 README 版本历史的原文归档**（沿用 README 的标题层级与列表风格，
> 内容一致；下方旧条目仍是早期手写格式。新增版本只写 README，再同步到这里。）

### rc.202（versionCode 202）· 2026-11-03 · 稳定地基：滚动收口 / 删除确认修复 / 崩溃兜底 / 首启引导（rc.202–207 计划合并版）

- **滚动收口（原来反复复发的病根）**：对话流滚动条此前有 **9 条写入路径**（流式跟手、批次收口、pinBottom、缓动跳转、插中间补偿、首屏灌入、历史补页、ResizeObserver…），「这次滚动是不是用户滑的」靠一个 **240ms 时间窗**猜 —— 工具行改成实时输出（每 120ms 长一次）之后程序写入连续不断，时间窗几乎永真，rc.192 甩底 / rc.194 回退 / rc.195 插卡跳视口 / rc.200 两端拉扯全是它的不同切面。现在：**唯一写入点 `ChatScroll._write`**（写入记账 + 距底距离度量）+ `@pure scroll-intent` 纯决策块（`classifyScroll` 按记账判定、`decideScroll` 决定写不写、`anchorCompensate` 补偿），9 处写入全部收口，240ms 时间窗整体删除；`web/src/00-app.js` 里新增 `scripts/regress/scroll-timeline.test.mjs`，按 60 帧时间线断言「不甩底、不回退、手指按下期间不抢、插中间补偿、同帧合并」。**顺手修一个潜伏 bug**：appendTail 的锚定补偿写成 `setScrollTop(host,…)` 而 `#messages` 不是滚动容器，这行补偿从未生效（往流式回复中间插内容会跳视口）。
- **删除确认修复（sheet 双重认领）**：`#sheet` 上 4 个并列 click 监听器里，`[data-sess-rename]` / `[data-sess-move]` / `[data-sess-del]` 被两处各认领一遍 —— 其中删除的旧实现**直接 `LocalDB.remove`**，新实现才弹「确认删除」，一次点击两段都跑，**确认形同虚设**（rc.138「点 A 弹 B」同源）。三处旧分支已删（保留带 `closeSwipedRow` 与确认流程的），新增 `scripts/regress/sheet-route.test.mjs`：选择器归属两两不相交（有意重叠必须登记理由）+ `[data-pick]` 单一认领 + 删除必须走确认面板。
- **崩溃兜底（公开分发的前提）**：新增 `CrashGuard` —— 挂一层 `UncaughtExceptionHandler`，崩溃留一行到私有目录环形日志（64KB 上限）后**交回原处理链**（不吞异常，只为留证据）；`WebViewClient.onRenderProcessGone` 补上渲染进程被杀的处理：记诊断 + `recreate()` 重建（会话从本地库恢复），15 秒内二次崩溃直接收场防死循环。此前渲染进程被杀 = 白屏无提示，用户只能杀进程重开。
- **首启引导**：模型未就绪且未引导过时弹一次三步面板（配 key / 权限按需 / 安装包差异），配好 key 或点「先逛逛」即永不再弹；异常时静默跳过，不挡启动。
- **设备 lane**：`run-gates device` 接入 `scripts/emulator/anchor_local.py`（自带断言与非零退出码），无设备如实 SKIP；CI 新增 `device` job（API 35 ATD + x86_64 debug 包，先跑 scroll/sealed 控制时长），`anchor_local` 两处硬编码的 Windows 截图路径改为 `DSH_SHOT_DIR` / 系统临时目录。
- **隐私说明成文**：`PRIVACY.md` 按当前代码实际行为写（数据存哪、什么会出网、无障碍看什么不看什么、权限逐条用途与代价）。分发路线定为**官网 / GitHub 直发**，`phone_*`（无障碍）、`QUERY_ALL_PACKAGES`、`REQUEST_INSTALL_PACKAGES` 一律保留 —— 隐私页负责说明，不负责砍功能。
- **工程卫生**：`app.js` 里 4 个字面 NUL 字节（数学占位符）改为 `\u0000` 转义，文件恢复纯文本（此前 grep/diff 一直把它当二进制）；删 4 组零引用样式（link-*、in-sheet、pulse-dot、ctx-chip 修饰类）与 8 个未引用 CSS 变量、2 处 Kotlin 死代码（`clamp` / `FLUSH_MS`）。
- **前端源拆分第一步**：源在 `web/src/*.js`（顺序见 `web/build.json`），`app.js` 由 `scripts/build-web.mjs` 生成并由 gate `web-bundle` 逐字节守着（排在 web-regress 之前）；`.gitattributes` 给前端与脚本声明 `eol=lf`（否则 Windows 检出后产物是 CRLF，门禁必红）；删 `.motion-baseline/web/`（14095 行陈旧快照，无脚本引用）。
- rc.202–rc.207 计划合并为本版发布；首启向导的应用内隐私页、诊断导出入口与 sheet 域物理拆分留待下一版。

### rc.201（versionCode 201）· 2026-11-03 · 子对话（成员/子代理）的对话流与主对话同一套渲染

- **成员会话里的工具行是空的**：`TeamBridge.teamMemberLog` 读 `tool/result` 时取的是 `ev.optString("text")`，而 `journal.toolExec` 存的字段叫 `output`（还有 `id` / `args` / `ok`）—— 日志里根本没有 `text`，于是每一条工具行都画成空行，「它到底看了什么」看不出来。现在按主对话同一形状下发 `{id, name, args, ok, out}`。
- **成员视图改成主对话同一套节点与同一套行渲染**：连续的工具调用折进同一个**过程组**（`Flow.toolStart` / `Flow.toolEnd` → 与主对话共用的 `toolRowHTML` / `ioHTML`，点开看输入/输出、失败标红），正文是 text 节点、用户句是 user 节点；进入时 `Flow.turnStart()` 把这一场与 Lead 那一场的过程组状态隔开，退出时 `claimRun` 重新认领。两条老路子都不要了：每条工具平铺一行不成组；每 2.2 秒 `renderThread()` **整表重绘**（已生成的内容被重写一遍 = 闪，也违反「对话流只做增量刷新」）。
- **撤掉那张轮数卡片**：成员视图原来在流尾另起一行「队友正在处理 · 第 N 轮推理」，子代理那一行显示「第 N/M 轮」加一个进度环。轮数是内核的循环计数，不是「它在干什么」—— 现在成员进度用主对话同一个**过程组头**表达（`lastAction` 是「<工具> <目标>」就说「正在运行命令 · …」，是轮次就说「正在思考…」），子代理那一行的摘要位放最新那一步；步骤树里也不再写「第 r/rounds 轮推理」；内核侧 `TeamRuntime` 的 `lastAction` 从「第 N 轮推理」改成「思考中」—— 团队面板那张成员卡片读的就是这个字段，界面上从此没有循环计数（目标模式的「第 N/M 轮」是**轮数预算**，另一回事，保留）。随带删掉只服务旧卡片的东西：`.pg-pct` / `.pg-ring` 样式、那张 `.subagent` 卡片（`NODES.subagent` 零调用点）、`[data-toggle-sub]` 处理与对应 CSS。
- **子代理与成员现在照设置里的「上下文窗口 / 最大输出」办**（这条是「子代理工具命令老是处理失败」的真因，本地 llama.cpp 端点实测复现）：
  - 输出预算原来被另压一层 —— 子代理 `minOf(maxOut, 4096)`、成员 `minOf(maxOut, 8192)`。推理型模型（R1 / QwQ / Spark 这一类）先把预算花在「想」上，压到 4096 就等于让它永远想不完、也没有结论；实测那一发 `text` 为空、只有 `reasoning`，回合以「已达到输出上限」收场。现在两处都直接用设置里的那一档。
  - 工具目录按窗口分档：主对话早就有「≤12k 只给核心集、≤32k 给中集、再大全量」的规则（上百个 schema 每个约 110 token，8k 端点连目录都装不下，每一发直接被 400），但**子代理和成员没有跟着裁** —— 于是同一端点下主对话能动、子代理全灭。规则收进 `Presets.catalogFor(contextWindow)` 三处共用。
  - 轮内压缩也补上了：子代理/成员的历史按 `contextWindow - 目录token` 走同一个 `Compactor.compactInTurn`，跑几十轮不再无限涨到超窗。
  - 截断提示说实话：端点没回传统用量时不再报「已达到输出上限（0/10922 tokens）」这种没信息量的数，改说「预算用完、正文一个字都没有，多半被思考占满」。

- **压缩进度与压缩标记照桌面源码对齐**（这次是翻了 `D:\dsh\deepseek-harness-dsh-v0.2.1-rc.2` 的源码，不是照注释猜）：
  - 桌面把这件事拆成**两个东西**：进行中是 `ui-trajectory/layout.ts` 的一格（`layout.compacting`「正在压缩上下文…」，没有标题也没有数字）；完成后是 `ui-chat/CompactionItem.tsx` 的一行（图标 +「上下文已压缩」+ 圆点 +「已压缩 N 条历史记录（约 M tokens）」，有摘要才可展开，箭头右→下）。
  - 手机端原来把两者拼成一行（于是出现「上下文已压缩 · 正在压缩…」同时显示），还带 tokens 百分比和卡片底色。现在改成同一个节点两态：运行中 = 居中一行 + 两侧细线 + 全应用统一的 `is-shimmer` 扫光；完成 = CompactionItem 同构行，摘要正文跟页面一起流（不再 42vh 封顶）。
  - 桌面源码里其实**没有**那两条侧线（`CompactionItem` 无伪元素、轨迹表也没有）—— 按用户记忆加的；如果电脑端确实是别的位置，以用户看到的为准。
  - 达到输出上限的提示也从橙色卡片改成桌面 `TurnMaxTokensItem` 同构：一行「警告点 + 已达到输出 token 上限 + 回答被截断…」。
- **一个子代理只留一行**：内核的子代理进度事件用的是注册表 id（`sub-<ts>` / agent id），而 `tool_start` 用的是工具调用 id —— 前端按 id 建行，两个 id 对不上就留下两行，其中一行永远写着「启动中」（实测截图抓到过）。现在进度事件改带 `ToolExecContext.callId`（流水线第一次把 `callId` 挂进上下文），两边同一个 id。

**实测**：新增 `anchor_local.py member`（mock 的「MOCKMATE」现在会先调一条 `bash` 再回话）—— 成员视图里 1 个过程组 + 1 条有内容的工具行、`.turn-note` 0 条、「第 N 轮」字样 0 处、进度环 0 个、正文与用户句各 1，roster 上报的是「思考中」而不是轮数；子代理那一行从两行变一行、步骤树只剩「bash ls -1」。`tools / resume / tail` 复跑全绿，静态守卫 23/23、590+2 单测 0 失败。
本地模型链路（`bendimoxing` 的 llama.cpp 代理，Spark-X2.6-4B Q8_0，`adb reverse` 进模拟器）实测：
同一端点、设置里窗口填 32768 时那一发被代理直接断连（它的 `/tokenize` 探测对超窗请求抛 400，内核对外的表现就成了「finish=length、0 tokens」）；窗口改成 8192 后同一句话**跑通了** —— 目录落到核心档、轮内压缩 6801→3225 tokens、`bash` 成功返回、回合正常收尾。

**还差的一件事，说清楚**：成员那一路的正文**不是实时流**的 —— 内核只在整轮结束时把 `assistant/message` 写进成员日志，所以成员视图是「一轮一段」出现，不像主对话逐字长。要做到逐字，需要内核把成员的 delta 也推到桥通道（现在是 `bump` 计数 + 2.2 秒读日志），这条本轮没做。

### rc.200（versionCode 200）· 2026-11-03 · 工具行：跑动中看得见输出，重载后不再整段消失

- **工具行本来不流式**：内核只有 `tool_start` / `tool_end` 两个事件，一条跑几十秒的命令在界面上只有一个计时器在转，结果在结束那一刻整块出现。现在命令读到的每一块输出走**同一个合帧窗口**发到页面（`StreamCoalescer.feedOutput`，按调用 id 各排一条通道，24ms/32 字），落在这一行的两个位置：摘要位显示「正在打印的那一行」并钉到最新（`is-live` 进入 `syncThinkTail` 的钉尾集合），展开体里是实时输出（跑动中截尾看最新、跑完截头看结论），展开着看时贴底跟随最新一行 —— 用户往上翻过（同一个 `stick` 标记）就不再被拽下去，与展开的思考正文同一套规矩。`tool_end` 一到就以权威结果为准；实时那份存在 `__live` 里 —— `shotNode` 跳过 `__` 字段，所以它不落盘、不进模型上下文。接上的是命令类工具（host `bash` 与 guest 命令共用那条边读边等的循环）；子代理与团队成员另有自己的进度事件，不走这条。
- **退出会话 / 页面被回收后，工具行整段消失**：认领快照原先只攒 `delta` / `reasoning` 两条通道，工具事件「直发不记」—— 重载前跑过的那几条命令在新页面上根本不存在，只有重载之后新发生的才看得见，要等回合结束落库、再进这场会话才齐。现在合帧器按**发出顺序**记一份完整日志（正文段与工具事件在同一条线上，`snapshot().segments`），`agentActive` 带出来；认领时先 `adoptShownTools()` 把重载前已经在流的那些行接回来（已有的行不重复画、还在跑的行挂回 `Flow._byId` 才收得到 `tool_end`、还开着的过程组交回 `Flow.group/groups`），再按原序补工具事件。上限沿用旧口径（300k 字 / 4000 条，超了标 `truncated`），`tool_output` 不进回放日志（一条命令能刷几 MB，而 `tool_end` 本来就带全文）。
- **顺带挖出一个老 bug（行里套行）**：`patchGroupRow` 把「一整行」喂给 `morphHTML`，而 `morphHTML` 比的是**子节点** —— 于是旧行的 `.pg-main` 被换成一个嵌套的 `.pg-row`、其余子节点被裁掉，DOM 里同一条工具行出现两遍。以前只在 `toolEnd` 那一刻发生一次、下一次整组重绘就顺带修好，所以没人看见；实时输出让这一行每秒被 patch 好几次，问题就一直挂在屏幕上。新增 `morphOuter`（与 `patchNode` 原本那套「同签名就 morph 子节点、否则整块换掉」的语义同一份），`patchNode` 也收敛到它，两处不再各写一份。

**实测**：模拟器新增 `anchor_local.py tools`（mock 新增「慢工具」档：一条逐行打印 25 行的命令 → 12 秒慢正文 → 第二条命令）。① 运行中那一行的摘要从「第1行输出」走到「第10行输出」、`is-live` 生效、展开体有字且**贴底**（`scrollTop=10` / 可滚 `10`，框里最后一行就是摘要那行）、`nest=0`（没有行里套行）、DOM 行数 == 组内工具成员数；② 中途重载后工具行仍在（修前是 0 行）、不重复、`busy` 仍为真；③ 回合结束两个工具成员都有独立行、没有过程组留在展开态。负对照：把认领挪到喂思考之后，立刻红「还剩 1 个过程组没收口 / 1 个成员显示运行中」—— 这条顺序就是靠它抓出来的。`scroll / sealed / rect / tail / resume / kill / stop` 七条复跑全绿。

### rc.199（versionCode 199）· 2026-11-03 · 团队视图不再打断 Lead；思考那一行的四个老问题

- **进入成员会话会把 Lead 这一轮直接停掉**：`enterTeamView` 走的是「换视图统一收尾」，里面有 `stopLive` —— 用户实测一进子会话 Lead 就终止。现在改成「让到后台」：轮次交给内核继续跑，页面这只手松开（`Live.id` 置空、事件不再进来），退出时用 `agentActive` 快照重新认领（新增 `claimRun`，和页面重载同一条路径）；离开期间已经跑完的，用新桥 `sessionLastReply` 从内核会话日志取最后一条回复补尾巴（只补没见过的部分，实测补 504 字、不是整段 680）。
- **成员会话里半天没反应**：队友在跑时只有空白。现在轮询顺手拉团队快照，在流尾挂一行「队友正在处理 · 第 N 轮推理」（取 `lastAction`），新内容一到就摘掉；自己发的那句也会立刻出现（游标推进，日志里的同一条不再重复画 —— 之前同一句话会出现两行；`TeamRuntime` 在收件箱认领时又写了一遍日志，重复的是那条）。
- **队友根本不认「子代理档」**：`spawn_teammate` 不填 `model` 时，spawn 阶段就把空值落成了 `lead.model`，运行时那行注释写着「成员显式 > 子代理档 > Lead」的 `ifBlank` 于是永远进不去 —— `subagentModel` 对团队成员形同虚设（对普通子代理却生效）。现在成员模型只存「显式那一份」（空 = 跟随），生效值到跑这一轮时由新增的 `MemberLlm.resolve` 一起定（端点/密钥仍是独立一档覆盖，与 `SubagentRunner` 同语义）；名单与 `team_status` 显示的是生效模型，不再是要么空串要么被写死的旧值。**说明白**：App 里目前没有配子代理档的入口，所以这条改动今天不改变任何可见行为（实测：默认路径下队友仍用 Lead 的模型 `deepseek-chat`，日志里成员记的是「默认模型」），它补的是那条走不通的分支。
- **思考行四个老问题**：
  - **展开再收起之后那一行不滚了**：`syncThinkTail` 只钉「DOM 里最后一个」摘要行，而收起时组体是 `display:none`（clientWidth=0）直接 return —— 组头从此不钉。现在逐行判溢出：看得见且真的有溢出的都钉，看不见的清除旧标记。
  - **展开后「卡住不再更新」**：① 组展开、行没展开时，组内那一行的摘要停在 `patchNode` 那一刻，之后再也不更新 —— 现在跟着输出就地更新并重钉；② 行展开过一次后即使组收起，`Flow.think` 仍按「展开态」走正文节流路径，组头摘要永远不更新 —— 现在只有「组展开且行展开」才算展开态。
  - **展开的思考正文顶穿屏幕（高度）**：正文没有高度上限（实测 36 步就把整屏铺满、组头被挤出屏幕）。加 `max-height: min(45vh, 380px)` + 内部滚动；默认贴底跟随最新一行，用户上翻后（滚动监听打 `stick=0`）不再被拽下去。
  - **展开的思考正文被屏幕横向截断（宽度）**：正文里一条命令那么长的代码行直接长出屏幕右边 —— 实测正文框 `clientWidth=380` 而 `scrollWidth=981`。根因不在正文框：代码块的折行规则原先挂在 `.assistant-text pre.code code` 下面，而思考正文（还有电脑会话的 `pc-think-text`、压缩详情、文档预览）用的是同一个 `md()`，没配到的地方 `<pre>` 退回默认 `white-space: pre`，一个字都不折。现在这条规则全局生效并加 `max-width: 100%`；实测同一份内容 `scrollWidth == clientWidth == 380`，正文里 25 个元素没有一个越过屏幕右边界。

**实测**：`anchor_local.py tail / resume / kill / stop` 四条全绿；宽度用新加的 mock 档「宽思考」（代码块 + 长链接 + 行内代码 + 表格 + 超长无空格串）在模拟器上逐元素量矩形，修前/修后各一遍；成员视图四条链路（进 → 看进度 → 发一句 → 回）在模拟器上逐项验过（Lead 在后台继续跑、退出后接回、离开期间跑完则补尾且不重复）；队友模型这条是 `MemberLlmTest` 5 条单测 + 负对照（把子代理档从优先级里摘掉，立刻红 2 条），另在模拟器上真跑一轮 `spawn_teammate`：名单里 `mate-one` 显示生效模型 `deepseek-chat`、成员日志记「默认模型」。

### rc.198（versionCode 198）· 2026-11-02 · 两个「看起来像终止了」的真 bug：停止后的误报 + 工具名变成 "null"

- **切走/停掉一个回合，回来会看到「这一轮没跑完」**：rc.197 的判据是「库里最后一条还是用户那句」—— 可主动停止和切走会话都会就地收尾，而这两条路**不 commit assistant 消息**，于是用户自己停掉的回合也被标成「进程被杀」。现在落盘时登记 `open`（只有回合还活着才写），结束 / 停止 / 失败三条路径都清掉；重开只有看到 `open` 才补那一行。另外 `LocalDB.get()` 原来没把 `open` 带出来，判据永远读不到（补了登记仍不触发，实测发现）。新增 `anchor_local.py stop`（停掉 → 切走 → 回来，**必须没有**标记）与原有 `kill`（真被杀，**必须有**）一对正负对照，模拟器上双绿。
- **团队工具报「工具名不合法："null"」**：模型流里工具名通常只在第一个 chunk 到达，后续 chunk 常带 `"function": {"name": null}`；设备上的 org.json 把 JSON null 读成**字符串 "null"**，旧逻辑直接赋值就把已经拿到的名字覆盖成 `"null"`，执行层只能报错（rc.197 只是把这句说得更准，根因没动）。现在按 index 累积时统一走 `mergeToolCallName`：空 / `"null"` / `"undefined"` 一律当「这一段没给名字」，不覆盖已有名字；流式、整包 JSON 兜底、Messages 协议、桥接流式四处同一套。实测：mock 先发 `team_status`、再发 `name: null`，工具行仍是 `team_status` 且执行成功（修前就是那句报错）；团队端到端 spawn → 队友跑完 → Lead 收尾仍通。单测 `ToolNameSanitizeTest`，静态守卫盯住四处调用点。
- 环境：构建被 Gradle 的 AAR 转换缓存（`~/.gradle/caches/8.9/transforms` 多条 `metadata.bin` 读不出）卡死，清空重建后恢复；这属于派生缓存，不影响产物。

### rc.197（versionCode 197）· 2026-11-02 · 用户实测的五个缺陷 + 结构减重（两端契约由守卫把关）

**用户实测报的五个缺陷**（浅色图标 / 团队角标 / 成员视图返回落点 / 「未知工具：null」/ 断线后的对话流）：

- **浅色模式下「新建电脑会话」没有图标**：`.act-ico.green` 这一档色调在 CSS 里**从来没定义过** —— 底色透明、白色加号，浅色下等于隐形；深色下白字压在深底上侥幸看得见，所以只有浅色暴露。补上与其它色调同一套写法（160° 渐变）。新守卫第⑤条跟着上线：模板里出现的 `act-ico <色调>` 必须在 `styles.css` 里有对应类，少一个就跑红。实测：浅色面板里那枚 30×30 绿底白加号可见。
- **新建对话后团队按钮角标还留着数字**：`startNewSession()` 不清 `state.team` / `state.teamView` —— 顶栏继续显示上一场的成员数；更糟的是**从成员视图里点新建**，输入框的消息会继续发给那个 teammate。现在两者都清、退出成员视图轮询、重画角标。实测：把角标摆成「2 人在跑」→ 点新建对话 → 角标 `hidden`、`state.team` 归 null、视图回到空会话。
- **成员对话界面点左上角返回落点不对**：`#btnBack` 与 `DSHHandleBack` 都不认 `state.teamView`，直接 `go("sessions")` —— 成员轮询与导航条全挂着，回到列表再点任何一场又被 `openSession` 顺手清掉，用户看到的就是「按返回却回到了 lead 那场」。成员视图是**一层视图**：返回先 `exitTeamView()` 干净地回到父会话，再按一次才去列表。实测：进成员视图 → 点返回 → 停在原来那场（标题不变），`teamView` 归 null。
- **插件工具报「未知工具：null（对应插件可能被禁用）」**：「名字本身不合法」（空 / `null` / `undefined`）与「名字合法但目录里没有」是两回事，混成一句会让人去翻插件清单，而问题在调用方。两层都拦：`PtcRuntime.callTool` 与 `PluginRegistry.exec` 各自回 `BAD_TOOL_NAME`，`DshPtc.call` 不再用 `String(name)` 把 `null` 洗成 `"null"`。实测：`toolCall('probe-null','null','{}')` → `{"ok":false,"code":"BAD_TOOL_NAME","error":"工具名不合法：\"null\"（调用方没取到工具名，不是插件被禁用）"}`。
- **退出应用再重进 / 息屏再亮屏，对话没结束却像被终止了**：两种情形分开治。
  - **进程还在、渲染进程被回收**（页面重载）：`agentActive()` 报出在跑的轮次 + 合帧器里「已经发给页面」的快照（`StreamCoalescer.snapshot()`，它才是页面见过什么的真值来源），新页面认领**同一轮**：只补快照里没见过的尾巴 —— 整段灌会把重载前已落进快照的那半截再说一遍（实测虚高 367 字），并把已显示的那截挂回 `Live.parts` —— 否则回合结束时 `liveBody()` 落库的回复少了重载前那一截（实测页面 1917 字、库里只有 1125 字，下一轮模型也不知道自己说过什么）。
  - **进程真被杀**（划掉任务）：这一轮确实没了，能做的留住 + 说清。切后台/锁屏那一刻**同步**落一次快照（`persistThread(true)`；8 秒节流那次走空闲回调，页面隐藏后可能再也不跑 —— 实测杀掉前页面 442 字、库里只剩 567 字的一半不到）；重开时若库里最后一条还是用户那句（回合结束时正文一定会 commit），就在断点处补一行「这一轮没跑完 · 应用被退出或被系统回收，上面是已经产出的部分」，走 `.turn-note.is-warn` 那一族，不新造样式。
  - 实测：`python scripts/emulator/anchor_local.py resume`（重载 → 接上 → 回合收尾 `users=1 / footers=1 / 落库 1 条`、页面 1892 == 库里 1892、开头那句在最终回复里）与 `... kill`（切后台落盘 + 重开标记，各留截图）。mock 新增「慢慢写」长流档：原来那档 2 秒就结束，第一版照着它判成「内核通道看不见这一轮」是**误判** —— 回合早就跑完了，`runs` 自然是空。

上一轮审查看到的差距不在功能，在**残留**：桥方法没人调、事件推给不存在的处理器、`#id` 指向早已删掉的 DOM。这些都不炸（都带 `if (el)`），但会骗下一个读代码的人。这次把它们清干净，并且加了机制让它长不回来。

- **新守卫 `contract-alignment`**：① 每个 `@JavascriptInterface` 必须被 JS 侧（含内核自己拼的 JS 垫片，如 PTC 运行时的 `DshPtc.fsRead`）调用；② Kotlin `emit("onX")` 与 `DSHHost.onX` 两个方向都要齐；③ `app.js` 里静态 `#id` 必须能在 `index.html`、模板串或 `.id = "x"` 赋值里找到；④ `index.html` 的 id / SVG symbol 必须有人引用。首跑列出 30+ 条候选，逐条清到 0。
- **新守卫 `preview-sync`**：`preview/` 与 `assets/web/` 逐字节一致。README 一直写「与真机一致」，实际这份手抄副本落后了 1599 行 —— 现在改完前端跑 `node scripts/sync-web.mjs`，忘了就跑红。静态守卫从 21 条到 **23 条**。
- **删掉的死表面**：`missionGet` / `missionEvidence` 两个桥方法（UI 走 `missionList` + `missionDetail`，一次取全）、`notifyDoneEnabled`（前端从不对齐，状态由 JS 自己存）、`DSHHost.onGlassInfo`（Kotlin 往不存在的处理器推事件）、`onSheetAction` / `onHostChanged`（DSHHost 上的键，Kotlin 从不发射）、`DocWriter.zosPut`（只定义、函数体是 `throw UnsupportedOperationException`）。
- **删掉的死分支**：`turnRail` 一族的 `buildRail`/`syncRail`（DOM 早没了，里面还留着 `scrollIntoView` —— 正是 rc.193 那个坑）、`#linkStop`、`#statSessions/statRunning/statTokens`、`#hostCard/hostBadge/hostName`、`#accountValue`、`#voicePluginState`、`#ctxPerm/#ctxEffort/#ctxContext/#ctxOut/#chipModel/#chipEffort/#chipEffortBar/#ctxModel`；`index.html` 里四个没人引用的 id 一并去掉。
- **旧中继彻底退场**：`relay/`（旧协议那份，仓内零引用）删除；前端 `state.relayBase/relayRoom/relayToken` 三个只读不写的字段与 `Host.auth()` 的 `?rt=` 一层随之拆掉 —— 老安装里残留的 localStorage 值再也不会把宿主机入口判成「中继模式」而拒绝打开。
- **常量回到单一真源**：`StorageAudit.SPILL_SUB` 改为引用 `ToolPipeline.SPILL_DIR`、`VOICE_CACHE_BYTES` 引用 `VoiceCache.MAX_BYTES`（顺带把 `VoiceCache.DIR/MAX_BYTES` 暴露出来），语音缓存目录名与上限不再两处手抄；改上限不会再出现「面板数字与真实清理口径分叉」。
- **发送只剩一个桥入口**：`linkSend` / `linkSendImages` 合并成 `linkSend(id, sessionId, text, imagesJson)`（`@JavascriptInterface` 的重载在 JS 侧选不出档位，两份 prompt 构造还各自漂移），无图时 JS 传 `"[]"`。
- **工作区**：`scripts/` 顶层 85 个文件里 66 个零引用，删掉 64 个一次性探针 / mock 服务 / `.log`（清单与原因留在 `D:/1/archive/2026-11-02/`，内容在 git 历史里），只留 `capture.py`（WebView 截图）与 `tts_audition.py`（能重生 `voice-audition/` 样本）两个无引用但在用的工具；插件目录里的历史 `*.tgz` 发布产物删除，打包配方写进插件 README「方式 C」。

### rc.196（versionCode 196）· 2026-11-02 · 电脑会话把「画出来的入口」接上

审查电脑会话时发现：几个入口画出来了、后端也做好了，前端却没接线；顺手挖到一个每秒改写已定稿节点的 bug。

- **「添加图片」以前点了没用**：弹层里那行写着「从手机选图，随这条消息发给电脑」，处理函数却调一个**全文件不存在**的 `pickPcImages()` —— 点了只关弹层。现在：隐藏 `#pcImageInput`（用户手势直接触发）→ 手机内压缩 → 附件托盘预览 → `linkSendImages` 内联进 prompt。
- **压缩预算是按链路算的**：长边 1600 起、质量逐档降（0.82→0.45），单张 base64 ≤ 900k、整条 ≤ 3.2M、最多 4 张（后两个与桌面端 `too-many-images` / `image-too-large` 对齐）。实测 3.29MB 的随机噪声 PNG → 636KB JPEG / 848k base64，桌面会话事件里落到 `PromptContentPart.image`（attachmentId `sha256:…`、mediaType `image/jpeg`）。
- **只发图也能发**：桌面端 prompt 允许 `text` 为空 + 图片；以前 `handleSend` 第一行就把空文字挡掉了，发送键也是灰的。现在有附件就点亮，乐观气泡带缩略图，回显用哨兵对掉（电脑把「只有图」回显成 `[图片]`，也算同一个哨兵）。
- **非图片附件不再假装发出去**：电脑这条链路只带图片，带了文档就明说「没发出去」并保留在托盘里。
- **第二个空入口收掉**：`sheetPcActions()` 被调用两处、从未定义（点了 ReferenceError）。＋ 现在只保留真能做的：图片 / 权限 / 调用指令；README 里「查看电脑端文件与任务」改成实话 —— 只能看到交付卡上的文件名，文件在电脑上。
- **每秒改写已定稿的节点**（本轮最实的 bug）：`「深度思考中 · N 秒」` 的秒表用 `#messages [data-live-secs]` 取元素，拿到的是**全对话第一条** —— 于是新一轮开始时，上一轮那条已经完成的思考行被每秒改写一次（封条重写），旧回合的秒数还在涨。现在秒表按本轮 uid 定位，回合结束把活标题收口成「思考」并摘掉 `data-live-secs`。修完之后 `run` 的封条命中才真正是 0（此前每轮 2~5 次）。
- **会话列表读失败不再显示「暂无会话」**：真实原因 + 「重试」。以前断网/接口报错时，用户会以为会话被删了。
- **中继单包上限 512KB → 6MB**（桌面插件 v1.3.3）：带图信封过不了 512KB，局域网这条路上发图永远是 413；另加「单房间排队 ≤24MB」兜底，超限请求读完再回 413（读到一半就断会把客户端连接池弄脏，e2e 里真踩到过一次 `fetch failed`）。
- **实测（模拟器 ↔ 本机 harness，内置中继）**：`image` 一条命令跑通「选图 → 压缩 → 发送 → 电脑事件里出现 image part」；`run` 1788 帧——封条 0 重写、硬回退 0（内容变高时从没丢底）、思考行钉尾 76 帧 / 624px、交付卡贴尾；静态守卫 21/21（新增 7 条），插件 e2e 39/39（新增 2 条：1.5MB 放行 / 6MB 拒绝）。

### 桌面插件 v1.3.2（2026-11-02）· 被移除过的手机能重新配对回来 · 电脑会话补测

- **症状**：手机粘配对串 → 提示「已连接」→ 几秒后回到「未连接」，面板里设备数还是 0；同一台手机再怎么重配都一样。
- **根因**（在插件侧，不在手机）：`saveState()` 落盘前先重读磁盘再合并，墓碑（`removed`）按 **id 取并集**。在面板上移除过某台手机之后，它的 id 就永久躺在墓碑里；那台手机重新 `/pair/key` 时 `mintDevice()` 虽然签了新令牌、内存里也有记录，合并时却被磁盘上那份旧墓碑判定成「已删除」再剔掉 —— 令牌发出去了，设备表里没有。手机下一个请求就是 401，`LinkBridge` 的 401 分支会清掉本地令牌（那是它该做的），于是表现为「刚连上就掉线」，而且**这个设备 id 永远配不回来**。
- **修法**：墓碑从「id 集合」改成「id → 删除时刻」，合并时同一把尺子比时间：`removedAt >= pairedAt` 才算删过。删除与重新配对变成两个可比的事件，晚的那个说话；多进程（桌面端 + `dsh web`）也不会让删除被旧记录合并回来。旧文件里的数组墓碑按 `0` 迁移（比任何一次配对都早）。写墓碑的键用 `Object.create(null)`：设备 id 是手机自报的，不给它碰 `Object.prototype` 的机会。
- **测试**：`.test/e2e-relay.mjs` 加 4 条（被移除的手机能重新配对 / 重新配对后第一个请求就认 / 重新配对的设备落盘 / 旧令牌仍然无效）。**负对照**：把判定退回「只看 id」，新加的 2 条立刻红（`status 401`、磁盘设备 `[]`），改回来 37/37 全绿。`cross.mjs` 26/26、`panel-scroll.mjs` 全绿。
- **电脑会话补测（模拟器 ↔ 本机 harness，走内置中继 `http://10.0.2.2:8787`）**：真实一轮（思考 → 工具 → 正文 → `present` 交付）1165 帧采样 —— 封条节点重写 0（`removed/text/child/attrs` 全 0，只有 1 次思考行 `is-tail` 让位的 class 翻转）；**硬回退 0**（内容变高时从没丢过底），最大距底 52px、末帧贴底；思考行钉尾生效（58 个采样帧被钉住，`scrollLeft` 最大 1037px = 跟着输出走）；交付卡落在自己那一轮末尾，重进会话后 DOM 顺序 == 线程顺序（`[3,4,5,6,7,8]`）、尾指针 `r==n==38`。
- **口径说清楚**：上面这条跑的是**中继（同一局域网）**链路 —— 模拟器的 SLIRP 只把 `10.0.2.2` 映射到宿主，DNS 与出网全封，隧道配对串贴进去实测报「解析不了这个地址，检查手机网络」（这是环境限制，不是产品缺陷）。隧道这一条本轮核到的是：公网 `GET /mobile-link/hello` 实测 200、配对/签发与中继共用同一个 `handle()` 与同一段 `mintDevice()`（即上面 37/37 的那条路径），真机跨网复测留给下次连手机时做。
- `pc_link.py` 配套改进：`pair` 默认走中继（`pair tunnel` 保留），已配对时直接进会话；回合结束改看 `Link.running`（节点数不变 ≠ 回合结束，正文还在灌）；回退分成「硬回退 / 软回退（上面某段塌了）」并逐条列出变矮的是哪一条。
- **发布**：安装包本轮不重打（rc.195 那份照旧，App 侧只有 `__dsh.Link` 这一个调试取引用，改了行为等于没改）。插件资产 `dsh-mobile-link-1.3.2.tgz`（58,381 B，sha256 `137fdb7b23cdc7424b86697e7f1cb4fdadac176c798eb666d1def5175078aa96`，与 GitHub 服务端回读的 digest 一致）挂在 rc.195 这条 release 下；装法是解压覆盖 `~/.dsh/plugins/dsh-mobile-link`，重启桌面端生效。

### rc.195（versionCode 195）· 2026-11-02 · 思考那一行跟着输出走（换掉 rc.194 的跑马灯）

- **收起态也要看得见内容**：思考在跑的时候，用户看到的是组头那一行 —— 以前它只写「正在分析请求」，摘要算出来了却没挂上去。现在摘要挂进 `running.detail` 并写进组头标题，这一行随输出往前滚。
- **滚动速度 = 输出速度**：不做补间、不做跑马灯节拍。每次 token 改完文字就地钉一次（`paintGroupHead` 直写路径也钉），输出多长就往前挪多长。
- **不再用负 `text-indent`**（rc.194 那版）：负缩进会被 `scrollWidth` 再算一遍，每量一次更负一点（实测 -131 → -411 → -1139 → -1339），最后整行字滚出可视区 —— 用户看到的「只剩思考图标，字不见了」就是它。改成 `scrollLeft` 钉尾：浏览器自己钳位，量出来永远不超过可滚范围。
- **只钉最后一条**：其余行清零，不让满屏都在动；工具行不参与（保持省略号）。
- **展开后不再重复那一行摘要**：正文就在下面，重复一行像半句话。收起才显示摘要（本机行、组头、电脑会话的 brief 同一条规则）。
- **摘要取「正在写的这一段」**：以前运行中取的是最早一段的首行，于是这一行从头到尾都是老内容；现在取当前段（含没写完的部分），配合钉尾就是最新那几个字。
- **实测（模拟器 + 分片流式的 mock 思考）**：组头文字长度 37 → 67 → 123 →（换段）26 → 97，`scrollLeft` 与溢出量逐帧相等（128/129、409/409、1137/1137、829/829）= 钉在末尾且没滚过头；工具行被钉数 0；`scroll` / `sealed` 两项照旧全绿（最大距底 0px、封条 0 重写）。守卫 21/21，新增「不用负缩进」「展开不重复摘要」两条。

### rc.194（versionCode 194）· 2026-11-02 · 顺序审计：中段插入不再触发整表重建 · 思考行默认滚动

用户提的要求是「不只是视觉好，输出顺序也要对」。这轮把对话流的落位规则逐条过了一遍。

- **中段插入会把整张对话推倒重来**（真隐患，不是观感问题）：往流中间插一枚已渲染的节点（交付卡、表情/图片、迟到的上一轮内容、压缩检查点）后，`thread` 长了一个但「尾部队下一个要灌的下标」`renderTailFrom` 没跟着走 —— `paintLiveNode` 的兜底条件是 `renderTailFrom !== thread.length`，**差 1 也算差**，于是下一次流式 paint 把整张对话清空重灌。`placeBeforeTurn` 里的判定条件还写反了（`renderTailFrom <= at`），只在插入点位于队尾之后才 +1，恰好漏掉最常见的「插在前面」。现在统一成 `keepTailSync(at)`，7 处插入全部接线；负对照（摘掉）实测指针 19/20 脱节。
- **交付卡不许落到别的会话里**：落卡是延时补投的，定时器可能在用户切走之后才响 —— 那时 `#messages` 已经是本机桶，卡就会插进本机对话。现在落卡前核对 `thread.__sid === "pc:" + sessionId`，不匹配就丢弃（重进时由历史重放重新生成）。
- **同一条 `present` 重复下发只落一张卡**：去重键从「seq + 文件」扩到「seq + 本轮锚点 + 文件」，seq 缺失（老投影补发）时也能挡住重复。
- **一轮还在产出时贴底不补间**：`scrollToBottom` 以前对 28px 以上的差距一律走 380~460ms 缓动，而补间追的是「出发那一刻的目标」，内容每帧在长 → 实测视口落后 2000px 才慢慢追平。现在 `state.busy || Link.running` 时直接瞬时贴底，缓动只留给用户主动的跳转（回到底部、搜索命中）。
- **键盘弹出后重新贴底**：`--kb` 由原生注入，既不改 `#messages` 也不改 dock 高度，两种 ResizeObserver 都不响 —— 结果就是键盘弹起后最后一条离底部差 310px 不动。现在盯 `documentElement` 的 style 变化，跟随态下立刻补贴。
- **思考行的一行摘要默认横向滚动**（只此一处，工具行保持省略号）：思考越往后越说到点上，截断等于把开头藏起来。量出真实溢出距离才滚（`--mq` / 定速 ≈34px/s），收起没宽度时不缓存结果，组展开时由 `#messages` 的尺寸观察补测；**只滚最新一条**，不让满屏都在跑字。减弱动效下退回省略号。
- **实测（模拟器 + 本地 mock）**：`marquee` 思考行 `is-mq` 生效（179px 溢出 → 7.0s）、工具行 0；`scroll` 最大距底 0px、回退 0、follow 未关；`sealed` 两个场景封条节点 0 重写。脚本收进 `scripts/emulator/`（`anchor_local.py` / `pc_link.py` / `mock_anchor.py`），一条命令可复跑。
- **桌面插件 v1.3.1**：面板自己滚（`.ml-root` 补 `flex:1 + min-height:0 + overflow-y:auto`）—— 宿主中栏是 `overflow:hidden`，插件不自己开滚动容器就会被裁掉且谁也滚不动。新增 `.test/panel-scroll.mjs` 守卫。**需要重启桌面端生效**。

### rc.193（versionCode 193）· 2026-11-02 · 点「进行中」带不再把整个界面上移卡死

- **根因**：点输入框上沿的「进行中」带时，代码用 `card.scrollIntoView({block:"center"})` 定位本轮 Mission 卡 —— 浏览器会把**所有可滚祖先**一起滚，其中 `#device`（`overflow:hidden` 的外壳，内容比视口高 4px）被滚了 20px，滚完没有任何代码把它归零。表现就是整屏上移 ~20px，退不出来也回不去。
- **修法**：① 定位 Mission 卡改成只滚 `#chatScroll`（`scrollChatTo`，按矩形算居中位置走 `easedScrollTo`），不碰任何祖先；② 给 `#device` 加兜底：一旦被任何来路（`scrollIntoView`、焦点滚动）滚过，立刻拉回 0。
- **实测（模拟器）**：修复前点击后 `#device.scrollTop=20` / `#screen-chat top=-20` 并保持；修复后点击 `#screen-chat top` 恒为 0，卡片在对话内居中，`回到底部` 正常回到底（3222/3223）。
- 守卫：`mission-card` 新增 5 条断言（禁止 `scrollIntoView`、`scrollChatTo` 只动 `#chatScroll`、`#device` 兜底必须定义且接线）。

### rc.192（versionCode 192）· 2026-11-01 · 交付卡不再甩开底部 · 对话流只做增量 · 电脑会话补上交付卡

三件事同一个病根：对话框里「已经画好的东西又被推倒重来」，以及两套滚动机制在抢写。

- **交付卡「滚进历史再滚回来」**：动效块把 `scroll-behavior: smooth` 重新加到了 `.chat-scroll`，而流式跟手是**每帧写一次 scrollTop** —— 每帧写入都变成「从头重启的补间」，视口永远追不上内容，写入一停才滑回来。隔离对比：同样的写入在普通容器立即到位，在 `.chat-scroll` 上写 400 读回 0。对话流容器不再吃 CSS smooth，程序化滚动统一交给 JS。
- **跟手原语裸写**：`streamFollow` / `settleFollow` / 分帧补历史的两处视口补偿都在直接写 `sc.scrollTop`，绕过了 `setScrollTop` 的 `behavior:"instant"`；现在一律走 instant 写入。缓动补间若发现别的写入者已经到位就立刻退场，不再把贴底的画面拽回半空。
- **只做增量**：发送、目标轮次分隔行、陪伴主动消息、电脑会话错误提示的增删、宿主机分支 —— 以前每一条都调 `renderThread()`（清空后重灌整张对话），已生成的正文/工具行全部销毁重建，就是「闪」。现在只追加/只摘那一条；只有「换桶」（新建或接管会话）才整表重绘一次。上下文压缩检查点插在流中间，改走锚定插入器。
- **电脑会话补上交付卡**：电脑上 `present` 跑成功了，手机端以前只有过程组里多一行「present / 完成」，卡片整块缺失。现在按本机同一套画法落卡片；文件在电脑那侧，所以不给缩略图、也不做「点开预览」的假入口，卡头写明「在电脑上」。
- **交付卡的归属按「轮」算，不按「落地那一刻」算**：以前卡片落点是「当前流的末尾」，而回放是分几批到的 —— 落卡时下一轮还没渲染出来，就接在了末尾，后面几批再追加，于是「重进后前几轮的交付全跑到最新一轮结尾」。现在每张卡记住自己那条 `present` 的序号，落点固定为**它那一轮之后、下一条用户消息之前**（本轮后面再来收尾正文会跟着下移，不越过下一条用户气泡）；那一轮还没渲染就先留在队列，等下一批再落。落卡前还会把还在转圈的工具行收口，卡片不会压在没跑完的工具行前面。
- **实测（模拟器 + 真实电脑隧道，CDP 逐帧）**：本机交付卡那一轮最大距底 758px → **0px**，距底>40 的采样 43/46 → 0/46，向上回退 1 次 → 0，跟随被关掉 41 次 → 0；给回合开始前已在流的节点打封条，修复前 12/12 全被摘掉重建，修复后 **0 命中**。电脑会话（真隧道）两轮：封条 0 重写，最大距底 92px、末帧贴底，交付卡 live 与重进重放都在。
- **负对照**：把上面几处退回修复前重打包，267px 甩底 + 整表重建照旧复现，守卫变红 —— 结论不是采样偏差。
- **测试**：新增 `incremental-render` 守卫 12 项、`insert-anchor` 补 4 项、`link-cross` 补 4 项（含电脑交付卡），web 守卫 21/21；lint 与 static 门禁全过。

### rc.191（versionCode 191）· 2026-11-01 · 电脑会话对齐桌面（信息流 / 圆环 / 字形 / 列表）

电脑会话不再是「另一套界面」：信息流怎么长、节点怎么收口、图标与列表长什么样，都跟本机同一套。

- **上下文圆环回到输入框里**：紧挨模型胶囊显示占用百分比；点开是贴着圆环的浮层 —— 总用量 + 系统提示词 / 工具 / 对话三段构成。根因是历史接口把 `context` 算出来却没转发，已补；投影里缺这段时读 harness 自己的投影缓存兜底，不编造 0%。
- **思考行与工具行换成桌面同款字形**（`ui-primitives`，16 视框 / 1px 描边）：思考、浏览、搜索、编辑、终端、代码、联网、子代理、计划、提问按工具名逐一对应，本机与电脑会话一致。
- **信息流与本机同一套画法**：同一枚气泡里增量画字，定稿时原地转正（`promoteLive`），滚动只走 rAF 贴底；不再整表重建。
- **四个真机抓到的 bug**：① 上一轮在途的流式帧串进下一轮（每轮加代际号，旧帧丢弃）；② 上一轮的思考 / 工具 / 正文迟到后被追加到本轮提问下面（按 `seq` 插回本轮用户气泡之前）；③ 展开思考组 / 工具组 / 单条工具时整表重建导致闪烁（只 patch 那一组）；④ 新一轮开始时删掉上一轮草稿节点，正文「出现又消失」（改为冻结，终稿回来时就地认领）。
- **会话列表与电脑会话面板**：电脑分区改用「工作区」卡片的同一套结构（头像 + 标题/时间 + 目录，按工作区成组），行距与手机端一致；面板里也不再是稀疏的大标题 + 路径段落。
- **搜索框不再跳背景**：改成实心卡片色、去掉背景模糊 —— 进出会话时背后列表整块重排，半透明/模糊取到的底色会跟着变。
- **插件 `dsh-mobile-link` v1.3.0**：跨网开关跨重启保持（插件卸载/热重载只收进程，不再把「开着隧道」写成关）；cloudflared 下载支持镜像回退；投影缓存兜底；历史应答补发 `context` / `breakdown`。
- 测试：19 个 web 守卫、JVM 单测、lint、static 门禁全绿；真机（Honor BKQ-AN00，公网隧道）逐项复验连发两条、展开工具行、退出重进。

### rc.190（versionCode 190）· 2026-11-01 · 跨网连电脑 + 唤醒诚实（Step 6 / Step 7）

「必须有人给一台公网中继」这个死结解开了：中继那一跳换成插件自己拉起的隧道，同时保留不经过任何第三方的直连。**界面仍然是手机端这一套，不做双前端。**

- **电脑端（`dsh-mobile-link` v1.2.0）**：新增 `tunnel.mjs` / `direct.mjs` / `rpc.mjs` / `e2e.mjs`。隧道用 Cloudflare quick tunnel —— 插件**自己从官方地址下载 cloudflared、`--version` 自检通过才执行**，用户不跑任何命令；下载物与自签证书一律写在插件自己目录（`<插件>/bin`、`<插件>/data`），**卸载插件连带消失**，面板另有「清除已下载组件」兜底。RPC 只监听 127.0.0.1；直连是公网 HTTPS + 自签证书（DER 自己编，与手机端 `SelfSignedKey` 同一套），口令现取，面板重置后旧配对串立刻失效。
- **端到端信封**：房间口令经 HKDF-SHA256 派生 AES-256-GCM 会话密钥，手机↔电脑的请求与应答都是密文 —— 中间那一跳（隧道或任何中继）只看得到密文与长度。口令错、包损坏、明文请求三者在服务端不可区分（都是同一个 401），不给探测者区分信号。
- **手机端**：`kernel/link/LinkCrypto.kt`（信封 + 配对串解析）与 `kernel/link/LinkTransport.kt`（relay / tunnel / direct 三种走法一套请求语义）。直连按证书 SHA-256 **指纹固定**：配对串带指纹就首连即钉，不带则先取证、用户在界面上核对过才落盘；隧道走系统默认信任链（拿自签那套去连公共 CA 等于放弃校验）。设置「连接电脑」加**粘贴配对串**一行入口（读不到剪贴板就明说，改用长按粘贴），诊断按 TCP / TLS / 指纹 / 认证 / 应答逐步给结论。
- **连上即落到电脑会话**：配对成功后不再多点一次 —— 自动打开电脑上「正在跑 / 最近用过」的那一场；标题那行老实写出走的是哪条路（电脑（局域网）/（中继）/（隧道）/（直连））。
- **唤醒的后台残余补上**：判定从 `eventSink == null` 改成「没有出口 **或** App 不在前台」（`RunService.isAppVisible()`，Activity 维护，不另造第二份状态）。以前进程活着、人退到后台时任务结算只更新了看不见的界面，用户在外面什么都不知道。
- **旧 notices 基础设施整块删除**：`JobRegistry` 的 `noticesFile` / `pendingNotices` / `drainNotices` / `enqueueNotice` / `MAX_NOTICES_PER_OWNER` 与 `Job.noticeQueued` 全部去掉（rc.186 之后它们已经是 inert 的，留着只会被下一个人「顺手接上」，于是同一件事出现两条唤醒路径）。
- 新文档 `docs/mission-ledger.md`：账本模型、状态机、四种唤醒策略、权限只收窄、证据只存引用、落点与体积上限一张表。
- **大会话的历史读得出来了**：手机端改为「投影 + 翻页」——`projections()` 拿当前切点与标题/运行态/当前模型，`page()` 只从切点往回翻一页消息；不再要一份完整快照。实测一条 **43 MB（压缩后）** 的会话：原来 `follow()` 整份快照 30 秒出不来、被中继掐成 504（手机看到的就是「电脑端会话记录没有」），现在 **49 ms、167 条消息**；没有 `page()` 的旧控制端自动退回快照路径。
- **重进电脑会话不再翻倍**：`Link.open()` 以前保留旧桶、又把 `cursor` 归零，整段历史被再灌一遍（真机复现 7 → 14 个节点）。现在进门先清空桶（真相以电脑历史为准），复验 51 → 51。
- **电脑会话读失败时不再是一片空白**：首次读取失败会在流里留一句「读取电脑会话失败：<原因>（会自动重试）」，读通后自动撤掉。
- **电脑会话里的模型切换修好了（真机实锤）**：四个叠在一起的原因 —— ① 手机只等 12 秒就放弃读目录，而电脑端 `modelCatalog()` 要逐个 provider 走网络（冷读实测约 30 秒），面板于是渲染成「一行可点都没有」；② 电脑端取活循环是串行的，一个慢请求把后面所有请求堵住（追踪：`/models` 4.6s 开始、`/sessions` 10.6s 才被取走；快请求白等 30015ms，改成常驻 worker 池后 **2ms**）；③ 目录每次都现问 —— 现在**落盘**，有旧的就先回旧的、后台再刷新，冷读走 50 秒单独帧预算，上游某个 provider 的流断了会重试一次、仍失败就退到落盘那份；④ 电脑回的是 `{lastUsed, next}`（还是内部 provider 名 `dsh-provider-qoder`），手机只认扁平 `{provider, model}` —— 电脑端现在统一归一成扁平形状，手机端两种都认。实测：51 个模型 / 9 个 provider 组，当前那条带勾、标题显示「Qwen3.8-Flash · 免费 · medium」。
- **一条只能出现一条**：发送时 push 的乐观气泡与电脑回传的同一句（带真实 seq）会叠成两条 —— `seen` 只认 seq、认不出「同一句话」。现在发送时登记 `expectEcho`，电脑回显命中就咽掉一次（空白归一后比对，只记最近 8 句，切会话清空）。真机实测：手机 1 个气泡、电脑侧恰好 1 条记录。
- **设置「连接电脑」这一行走 `Link.enter()`**：此前那个混合面板的构造函数被同名局部变量 `sheetHost` 盖掉，点击只抛 `TypeError`，什么都不弹（真机实锤）。「运行方式 → 填写宿主机地址」与「同一局域网 · 直连宿主机 Web UI」拆成独立面板（地址 + Launch Token，拿到的是整台机器的界面，和手机联动不是一条路）。
- **「存储与落点」图标不再和「内核插件」撞**：两行原本都用 `#i-layers`，存储改用新增的 `#i-disk`（同一套 1.8 描边与圆角）。
- 测试：`LinkCryptoTest` 新增 6 条（跨语言向量、配对串边界）、插件侧 `.test/cross.mjs` 26 条 + `.test/e2e-relay.mjs` 33 条（含「慢请求排队时快请求照样回来 2ms」「目录落盘」）；回归守卫 `scripts/regress/link-cross.test.mjs` 等 19 个全绿；`background-wake.test.mjs` 改成断言旧 notices 基础设施**已不存在**。

### rc.189（versionCode 189）· 2026-11-01 · 团队合流（Step 5）

智能体团队的任务板进 Mission 账本 —— 派出去的活与自己的活是同一本账。

- **任务板 → Mission**：`team_task_create` / `team_task_update`（claim / release / complete / reopen / reassign / delete）每一次变更都同步到账本，`kind=team`，**归属会话是 Lead 的会话**（用户在对话里派出去的活，追踪点就在那里；成员自己的日志留给成员视图）。
- **状态诚实映射**：`pending`+就绪→待认领（queued）、被依赖挡住→等待中（waiting）、`in_progress`→成员进行中、`completed`→已结束·完成；任务被撤下时**从账本移除**，不留一条「已取消」假装它存在过。
- **完成走同一唤醒路由**：`enqueueTeam` 策略是 `queue`（不抢当前回合，等空闲补一轮），去重键带 `revision` —— 同一个任务 reopen 后再完成还能再提醒，重复 complete 不会刷屏。
- **证据与抽屉**：完成时落一条「成员汇报：<成员> 完成：<标题>」；抽屉里来路显示「任务板 · 成员 X」，来源标签「团队任务」。
- **界面**：任务页来源筛选新增「团队」；进行中带、Mission 卡、抽屉都不需要新组件 —— 团队任务复用 Step 1–3 那一套表面。
- 测试：`MissionRegistryTest` 增 2 条（状态迁移/删除与无归属会话）、`WakeRouterTest` 增 1 条（revision 去重）；前端守卫新增 `scripts/regress/team-mission.test.mjs`（含「团队 kind 不许被压成 job」「归属必须是 Lead 会话」）。

### rc.188（versionCode 188）· 2026-11-01 · 工作站底座（Step 4）

把「手机自己就是工作站」做实：不连电脑、不在局域网，也要能把一件重活做完、做完能查、断电不丢。

- **溢出落点回工作区**：工具长输出的完整落盘从应用私有目录 `files/spill` 改到工作区 `.dsh/spill/session-<hash>/`（收掉 rc 早期留的 `TODO(spill)`）。以前那条路径标准权限的 `read` 读不到，等于产出物对用户和模型都半隐藏；现在 `read` 能直接分页读回，`glob/grep` 仍默认跳过 `.dsh` 不污染搜索。
- **溢出有字节预算**：原来只有 30 天龄期 —— 手机存储是按 MB 计较的，只按龄期清等于「能写满就写满」。现在 64 MB 上限，每批落盘前按最旧会话目录先走，最近一轮的结果永远留得住。
- **设置 → 存储与落点**：`StorageAudit` 现场遍历报告每一项占多少、上限多少、超了怎么办（工作区 / 溢出 / 改动存档 / Mission 导出 / 会话日志 / 账本 / 唤醒队列 / 语音缓存 / 本地运行时）。**唯一的清理动作是溢出缓存**（可再生）；会话日志不自动删，超过 500 MB 只提醒 —— 悄悄裁历史比占空间更伤。
- **后台任务可重跑**：`JobRegistry.start` 接受 `spec`，Mission 的 `origin` 从字符串升级为对象并留下当时的 `command/workdir`；`missionRerun` 复用 ShellPlugin 的 `job.exec` 服务（桥不自己拼一份执行逻辑）。没留参数的老记录**不给重跑按钮、直接拒绝** —— 凭标题猜一条命令去跑是拿用户的东西冒险。重跑在那件事的账上记一条「重新运行」证据，正文指向新任务。
- **长任务保住唤醒**：任务在跑时前台服务跟着在（`RunService.begin/end` 按归属会话记账，同会话还有别的活就不会真的停），回合结束不再等于事情结束；`end` 只撤保活不发通知，避免和唤醒提醒弹两条。
- **唤醒失败不再被吃掉**：补的那一轮如果失败（端点坏 / 断网 / 额度耗尽），`wakeRequeue` 把唤醒退回队列并记一条「唤醒续轮失败：<原因>」证据，下次进会话再试；连续重投到第 3 次为止，不无限循环。用户主动停止本轮则不回滚 —— 不跟用户对着干。
- `origin` 形状变了但**兼容旧账本**：前端 `missionOriginType()` 同时认字符串与对象。
- 测试：`StorageAuditTest`（8）、`WakeRouterTest` 增 4 条（回滚/上限/幂等/跨进程）、`MissionRegistryTest` 增 2 条（参数留存/不编命令）、`MissionEvidenceTest` 增 1 条（重跑证据）、`JobCompletionTest` 增 1 条（spec）；前端守卫新增 `scripts/regress/workstation.test.mjs`（含「跨网中继/委托算力」话术不得回归）。

### rc.187（versionCode 187）· 2026-11-01 · Mission 级信任与证据（Step 3）

对话里的 Mission 卡从「跳到任务页」改成**就地开详情抽屉**，并把权限与审计下沉到「这一件事」：

- **抽屉**：来源与发起轮次、状态条、唤醒策略、权限范围、时间线、证据正文；「在任务页定位」降为次要入口，跳过去会先放开筛选、滚到那一行并闪一下落点。卡片与抽屉都只渲染内核账本，前端不再自己推导状态。
- **证据只存引用**：账本里是 `{type, ref, at, title}`，正文由 `kernel/mission/MissionEvidence` 按引用现取 —— 活体任务读输出环，重启后回会话日志的 `job/settled` 记账，投递回 `user/message`，唤醒回唤醒队列；取不到就写「取不到正文」，不编摘要。单条 Mission 最多 12 条证据。
- **状态迁移不再抹掉证据**：`onJobSettled/onScheduleChanged` 改为按 `type+ref` 合并追加；追加证据不动 `updatedAt`（那是状态迁移时间，被一次审批顶掉会让卡片的排序说谎）。
- **Mission 级权限**：`permissionScope {mode, grants}`，`effectivePermission(session, mission)` **只收窄不放宽**；界面档位叫 `default`（内核旧名 `ask`），两个都认，否则收窄会被静默忽略。沙箱与工具 Gate 都读合档结果，只读的事点批准也绕不过去。
- **审批的作用域**：审批卡显示「属于这件事：…」，按钮仍是「拒绝 / 允许一次 / 始终允许」三个，回执写成「已允许并记住这件事」；Mission 轮的「始终允许」落在那条 Mission 的 `grants` 里，**不写会话级免问表** —— 用户批准的是这件事以后不用再问，不是这个工具在本会话从此免问。决定同时落会话日志 `approval/decided` 与 Mission 证据。
- **唤醒不再冒充用户**：补唤醒的一轮带 `missionId / wake / wakeId`，会话日志的 `source` 从 `human` 改为 `wake`，并往那条 Mission 追加「唤醒记录」证据；忙碌时由 pre-step 注入的同样落账（`drainForAgent` 返回完整记录而不只是文本）。被权限拦下的调用、本轮交付物也进证据。
- **导出**：`missionExport` 把这件事的完整记录写成 `.dsh/missions/<id>.md|json`（文件名只保留安全字符，不把路径分隔符带出工作区）。
- **数据卫生**：`bash run_in_background` 不再把 exec 的 `exit=N` 头存进输出环 —— 通知卡与 `job_output` 不再显示两遍 exit。
- 测试：`MissionRegistryTest` 追加 8 条（合并/去重/上限/档位/持久化），新增 `MissionEvidenceTest`（9）、`MissionTurnConfigTest`（3），`ToolPipelineTimeoutTest` 加「只读 Mission 硬拒且不被批准改写」，`ExitCodePlumbingTest` 加 `stripExitHeader`；前端守卫新增 `scripts/regress/mission-drawer.test.mjs`。

### rc.186（versionCode 186）· 2026-10-31 · 统一唤醒层（Wake Router）

job 完成与定时到点不再各自维护通知队列，统一收进 `kernel/mission/WakeStore + WakeRouter`：

- 记录带 `missionId / sessionId / policy / text / display`，用 `missionId + transition` 去重；定时 `delivered=true` 用 nudge（提醒已在日志里），否则用 prompt。
- agent pre-step 与前端认领**同一队列**，谁先拿到谁负责；`defer` 不参与自动注入。
- WebView 不在时发系统通知，记录保留；回到 App 仍能补一轮。旧 `jobDrainNotices/scheduleDeferWake` 分支退出。
- 前端 `wakeMissions`：只有空闲且正停在对话页才认领；忙碌/切走/输入框有草稿/后台时留在队列；本轮结束、进入会话、回前台自动补。一次只开一轮，job 通知合并成一轮。

### rc.185（versionCode 185）· 2026-10-31 · 长按语音只对空输入框 + 工作区堆叠收起阴影

- **长按输入框**：有字时长按不再唤出语音，恢复系统的选词 / 复制 / 粘贴；空输入框长按仍是「按住说话」。麦克风按钮不受影响，仍可对草稿识别并追加。
- **工作区堆叠会话**：收起动画期间不画叠层（`is-closing` 隐藏），叠层改为四角圆角；顶部圆角处不再露出一块直角阴影。

### rc.184（versionCode 184）· 2026-10-31 · Mission Ledger v1（jobs + schedules）

任务与定时任务第一次有了内核侧的统一账本，不再由前端各自推导：

- 新增 `kernel/mission/`：`MissionStore`（`missions.json`，原子写、损坏留档）+ `MissionRegistry`（状态机、来源、唤醒策略、证据计数）。重启后未结算的 job 一律标 `settled/interrupted`，不假装还在跑。
- `JobRegistry.onStart/onDone`、`ScheduleRegistry` 的创建/修改/删除/到点推进/失败重排/启动装载全部同步账本；`KernelBridge` 新增 `missionList/missionGet/missionEvidence/missionCancel`。
- 前端 `missionRows` 与任务页改为「账本优先、旧投影回退」；Mission 卡、进行中带、任务页读同一份状态；远期定时任务仍不进「进行中」。

### rc.183（versionCode 183）· 2026-10-31 · 输入框不再显示原生上下箭头

有字/聚焦时 Android WebView 会在 textarea 右侧画一条带 ▲▼ 的原生滚动条，看起来像我们加了「上下切换」。
现在保留滚动能力，只隐藏原生滚动条外观（`#input::-webkit-scrollbar` + `scrollbar-width: none`）。

### rc.182（versionCode 182）· 2026-10-31 · 对话里的 Mission 卡与进行中带

异步工作第一次在对话里有可见实体——工具行仍是扁平行，任务页仍是同一张 list，这一版只新增两处表面：

- **Mission 卡**：后台任务一开始（内核新增 `job_start`）就出现，不再等 `job_done`；数据先按 `sessionId` 从 jobs / schedules 投影，等内核 Mission Ledger 落地只换数据源。
- **卡片形态**：玻璃面（与输入框/导航同一材质）+ 抠图毛绒本体（浅色主题黑白款、深色主题雾蓝款，42px，不做圆形底盘，轻微呼吸摇摆）；进度条只表示「在跑」，不编造百分比；完成后转绿并保留记录。
- **进行中带**：输入框上沿一行安静的状态行；点击定位到卡片，没有卡就回任务页。
- **任务页筛选**：新增状态（全部 / 进行中 / 等待 / 已结束）与来源（全部 / 后台 / 定时 / 本地记录）；沿用原来的 list / job-row，不做卡片墙。
- 远期定时任务不占「进行中」；只有到点或半小时内要到点的才进卡与带。

### rc.181（versionCode 181）· 2026-10-31 · 定时任务到点真正发起一轮 + 更新源替换

**任务到点对话没反应**：提醒的投递只把消息写进内核会话日志，`schedule_due` 反而不再发 ——
投递器接上后 `onDue` 被绕开，界面既不知道到点，也不会拉起新一轮；应用不在时连通知都没有。
现在投递成功后仍然发 `schedule_due`（带 `delivered=true`），并补齐四种场景：

- **当前会话空闲**：立即把提醒原文显示进对话并发起一轮。提醒已经在内核日志里，
  触发用 nudge，不再把 prompt 当「新的用户消息」重发一遍；
- **当前正在生成**：排到本轮结束后再唤醒，不打断正在生成的回复；
- **另一个会话**：写进该会话的前端缓存（列表可见）并落持久唤醒队列，进入时补一轮；
- **应用不在 / WebView 被回收**：落持久唤醒队列 + 系统通知，下次进入会话自动继续。

**更新源替换**：`ghfast.top` 在 2026-10-31 实测超时不可用；按实测速度换为
`gh-proxy.org`（≈233 KB/s）→ `gh-proxy.com`（≈215 KB/s）→ `ghfile.geekertao.top`（≈178 KB/s），
官方地址兜底。

### rc.180（versionCode 180）· 2026-10-31 · 顶部按钮材质统一 + 有草稿时长按语音

对话页顶部返回/团队/更多三颗圆形按钮，在深色模式下下沿会聚出一小块白色高光。
根因是它们单独叠了一层渐变、描边与内高光，和其它圆形按钮不是同一套材质；现在直接复用
`.glass-btn`（新建会话 / 新建任务 / 文件搜索同一配方），按钮自己不再叠边光，深色下沿恢复干净。

输入框里有字时长按不出语音：有草稿时 Android 会先启动原生文字选择，DOM 的长按计时和
`pointerup` 都可能被吞掉。现在由 Activity 只接管「按在聊天输入框上」的长按（抑制系统选择），
JS 侧补 contextmenu / selectionchange 两条兜底入口；松手由原生 Touch 监听补发，
不再依赖可能被吞掉的 DOM 事件。

> **※ 现状（rc.185）**：产品规则改为「有字时长按保留系统选词/复制粘贴」，长按语音只对空输入框生效；麦克风按钮仍可带草稿。

### rc.179（versionCode 179）· 2026-10-31 · 生成模型设置行去掉冗余文案与对号

设置页「生成模型」分组里的行不再显示「图片 / 视频模型」和「图片 ✓ · 视频 ✓」——
状态对号在小字号下视觉噪音大，分组标题已经说明这是什么。行标签收敛为「模型配置」，
右侧只留一句极简状态：未配置 / 部分配置 / 已配置；模型详情仍在点开后的浮层里。

### rc.178（versionCode 178）· 2026-10-31 · 局域网 HTTP 模型端点放行 + 公网明文拦截

**问题**：添加自定义模型时填 `http://192.168.0.99:8090/v1`，被系统报
`Cleartext HTTP traffic not permitted` —— 本地/局域网模型几乎都是明文 HTTP，
而 release 的网络安全配置之前一刀切禁止明文。

**修复**：系统层放行明文（`network_security_config` base=true），真正的边界移到应用层
`kernel/NetPolicy`：只允许本机/局域网/单标签主机名走 `http`（localhost、10.x、
172.16–31.x、192.168.x、169.254.x、100.64/10、`.local/.lan/.home/.internal`、单标签名），
公网 `http` 在模型端点、模型拉取、探针、裸调接口、搜索、中继等入口一律拒绝并要求 https。
这样本地模型开箱即用，API Key/token 不会因误填公网 http 明文出网。模型表单也补了提示。

单测 515 → **518 全绿**（+3 局域网/公网/非 http 协议策略）。

### rc.177（versionCode 177）· 2026-10-31 · 八个可靠性 / 安全洞收口

按复审清单逐项堵上：

- **停止键能打断长等待**：取消时主动释放计划评审 / 提问 / 危险确认闸门；
  `wait_agent` 改为 250ms 分片等待并读取活体取消信号，不再只能靠线程中断。
- **团队提交竞态**：`FutureTask` 先登记 `active/running` 再派发，工作线程跑完时
  不会出现主线程把「运行中」写回去 —— 成员不再永久 running、`wait_agent` 不再白等。
- **预览嵌套 iframe 桥隔离**：WebView 级 document-start 脚本对所有子 frame 生效，
  主 frame 保留桥；运行时新建的 `data:`/`blob:` iframe 也拿不到 `DSHNative*`/`DshPtc`。
- **备份不再带走凭据**：`backup_rules` / `data_extraction_rules` 排除 SharedPreferences
  （中继口令、账号 token、宿主 token）。
- **门禁可信**：CI 改 `lintStandardDebug`、补跑 web-regress、新增 complete flavor 构建；
  修掉 8 个 lint error；facts 不再记录本机 APK 的 size/sha（由 release-manifest 负责），
  干净检出可逐字节复现。
- **会话状态归属**：进成员视图 / 电脑会话 / 新建会话统一收尾并清队列；媒体/表情/交付
  事件携带并校验 `sessionId`。
- **长任务后台化**：`video_generate` 支持 `run_in_background`；`RunService` 改为多会话
  引用计数（先结束的会话不再撤掉仍在跑的服务），WakeLock 6 小时并按需续期；后台完成
  通知落盘，进程重启后进入会话可补唤醒。
- **记忆打通**：kernel `memory_save` 写入的全局/会话记忆接入 runtime-context（与前端
  LocalDB 记忆去重），模型不会「刚记住下一轮就忘」。

单测 514 → **515 全绿**（+通知落盘恢复、+内核记忆入 prompt）；`lintStandardDebug` 0 error。

### rc.176（versionCode 176）· 2026-10-31 · 输入框有草稿时长按仍能语音输入

**问题**：输入框已经有文字时，长按不再唤起语音输入。根因是 Android 的原生文字选择
会先接管长按并发 `pointercancel`，旧代码把它当成「松手」清掉了 420ms 长按计时器。

**修复**：长按计时只认 `pointerup`，不再被 `pointercancel` 取消；判定窗口内给输入框
临时加 `is-voice-arming`（`user-select:none`）压住原生选择手柄，并吞掉
`contextmenu`；触发时清掉已存在的选择。识别结果不再覆盖草稿——输入框有内容时把
语音文字追加到草稿末尾，由用户确认后发送（避免把「草稿 + 语音」当成一条对不上录音
的语音消息发出去）；无草稿时保持「说完即发语音条」的原行为。

单测 513 全绿（纯 Web 改动）；新增 `input-longpress-voice` 回归守卫。

### rc.175（versionCode 175）· 2026-10-31 · 裸调 HTTP 逃生通道 + 快捷面板不再闪

**新增 `http_request`：工具 schema 与端点方言不匹配时的逃生通道**。此前只有
`web_fetch`（GET + 正文抽取），JSON POST、自定义请求头、非文本响应都没有入口，
模型只能干等工具发版。现在可以按接口文档原样发请求：方法（GET/POST/PUT/PATCH/
DELETE/HEAD/OPTIONS）、请求头、请求体（JSON 对象可直接传）、Content-Type、超时、
是否跟随重定向都由模型指定；返回状态码、响应头与响应体（文本按 `max_chars` 截断，
二进制只回元信息）。请求体上限 1MB；跨 origin 重定向自动摘掉 Authorization/Cookie，
避免 token 跟着 302 泄漏。工具按写操作登记：只读/计划模式禁用，POST/PUT/PATCH/DELETE
在「危险操作前询问」开启时需要确认。注意 release 构建仍禁止明文 HTTP（网络安全配置），
`http://` 目标会被系统拦截；云 API 走 https，调试本地服务用 debug 包或 https 隧道。

**video_generate 的 mode 枚举改为纯探测来源**。此前没有契约时 schema 兜底写死
`auto / text2video / image2video`（工具描述也写死「两种模式」），与端点方言无关；
`probe_gen_endpoint` 虽然把契约写进了 gen.json，但没有刷新注册表缓存，而且 AgentDriver
只按工具名判断目录是否变化，枚举更新传不到模型。现在：无契约时**不给 enum**（mode
保持自由字符串，按端点文档传值或先探测）；有契约时枚举只来自 `capabilities.modes`；
探测会读取端点错误里的 `valid_modes / supported_modes / modes` 或 message 中的
「valid modes: …」列表，不再只靠固定候选瞎试；探测后立即 `refreshTools`，AgentDriver
每步按完整 schema 比较（不再只看工具名），同轮下一步就能看到新枚举；`auto` 只在
有参考图时从契约里挑图生模式（image/reference/i2v），不会把 auto 发给端点。

**后台任务完成通知进入 agent 队列 + 空闲自动唤醒**。此前 `job_done` 只往界面推一张
notice 卡片，模型并不知道后台任务结束了，只能手动 `job_output` 轮询；空闲会话更等不到
结果。现在 JobRegistry 按 owner 维护完成通知队列：`job_output(wait=true)` 活体收走的
结果不再重复通知，等待超时不吞后续结算，模型自己 `job_kill` 不回通知；忙碌会话由
`agent/pre-step` 在下一步把通知注入上下文，空闲且停在对话页时前端 drain 同一队列并
自动发起一轮继续处理（通知属于别的会话、输入框有草稿、面板打开时不打扰，留待下次进入）。
队列是进程本地的（与任务执行一致），不承诺跨重启。

**快捷操作浮窗切换权限不再闪**。原本切换权限/预设/计划模式都调用
`openSheet(sheetQuickActions())` 整块重画，已打开的面板会被做一次 120ms 透明度淡入，
表现为整个浮窗闪一下。改为 `syncQuickActionsUI()` 就地更新类名与文案，分段滑块在
原 DOM 上过渡，不再重建面板；预设与计划模式切换同样受益。

单测 494 → **513 全绿**（+8 http_request：方法/头/体、危险输入拒绝、截断、二进制、
重定向、gzip、对象 body、跨源脱敏；+2 端点 valid_modes 学习；+3 video schema
无契约不编造枚举 / 枚举来自契约 / auto 图生推断；+6 后台完成通知：入队、活体等待
抑制、超时等待不吞通知、模型 kill 不通知、无主不通知、队列上限淘汰）。

### rc.174（versionCode 174）· 2026-10-31 · 安全边界收口 + 状态一致性 + 发布链路修正

**预览页不再暴露原生桥**。`addJavascriptInterface` 会注入所有 frame，`sandbox` 只隔离
同源/DOM/存储、不隔离注入对象——模型生成的 HTML 据此可调用 127 个 `@JavascriptInterface`
方法。现在预览 srcdoc 文档最前面注入 shim：枚举 `window` 里 `^DSHNative` / `DshPtc`
并置 undefined + `defineProperty` 锁死，另加 CSP（`connect-src 'none'` / `form-action 'none'`），
主文档与内联图表脚本不受影响；生成类预览再走一道 `sanitizeGenerated`（去 `<script>` 与
标签内 `on*`，保留文本内容），xlsx 工作表名补 `esc()`。

**宿主导航按 origin 精确比对**。`startsWith(host)` 换成 scheme + host + 端口（默认端口折叠）
逐项相等；`currentPageUrl` 随 pageStarted/Finished 记录，`isLocalPage()` 只在「非远端 +
桥已挂 + 当前 URL 是本地 origin」三者同时成立时为真；子框架导航一律拦截，不整页劫持。
markdown 链接改为白名单（`http(s)://` / `mailto:` / `#`）。

**电脑会话状态收口**。返回键先 `Link.leave()`；切换会话清空排队队列并重绘；历史/增量
轮询按 `id + sessionId` 对账，迟到回包丢弃并为当前会话补拉，不再把 A 的响应写进 B。

**发布链路按 flavor + ABI 现实修正**。门禁识别 `app/build/outputs/apk/<flavor>/release/`
全部 APK，签名逐个校验、预算分档（standard 100 / complete 260 MiB）；CI 单测任务名改
`testStandardDebugUnitTest`；`publish-release.ps1` 支持 standard/complete 双产物 + badging/
签名校验 + manifest 记录 standard 摘要，README 构建命令同步为实际产物路径。

**代码卫生**。`--label-1`（未定义）全部改回 `--label`；删除重复的 `case "toolrow"` 与
失效的 `[data-toggle-tool]` 分支；移除约 100 行零引用 CSS（旧 tool-card/chat-context/
tt-meta 等，`.spinner` 保留）；剔除未使用的 CameraX 四个依赖；宿主会话列表补 `letter`/
`tint`（此前头像显示空字符）；删除 README 里误重复的 rc.169 条目。

单测 491 → **494 全绿**（+1 origin 精确比对、+2 生成预览消毒）。

### rc.173（versionCode 173）· 2026-10-31 · 深度调研一次成型 + 子代理模型分档 + PPT 页切换

三个「扣分项」的针对性改进（早期审查结论，文档已清理）。

**web_search 支持深度调研（fetch_top）**。此前深研要模型手动串 3–6 次
web_search → web_fetch。现在给 `fetch_top`（0–3）就自动抓前 N 条结果的正文并合并返回
（每页 chars_per_page 默认 6000、单页失败只记一行不中断）；
`RuntimeTools.search` 同步扩参，teammate 侧不支持 fetch 时如实降级为搜索清单。

**子代理模型分档**。`AgentConfig` 新增 `subagentModel / subagentUrl / subagentKey`：
Lead 用强模型、teammate/子代理用便宜模型（并发场景成本与延迟显著下降）。
子代理侧 `SubagentRunner` 与 teammate 侧 `TeamRuntime` 都按「成员显式模型 > 子代理档 > Lead 模型」
取；三项全空时与以前逐字节等价（升级不回归，JVM 测试钉住）。

**PPT 页切换**。write_pptx 每页可给 `transition`（fade 默认 / push / wipe / cover / none），
生成 `<p:transition>`；**元素动画明确不做**（要写 timing 树几百行，而 agent 产出的 PPT
主要被阅读/编辑而非演讲）。设备实测：slide1 fade、slide2 push 均正确落包。
工具描述同步告知模型该字段（此前模型看不到所以不敢用）。

单测 488 → **491 全绿**（+2 PPT 转场、+2 子代理模型档）。

### rc.172（versionCode 172）· 2026-10-31 · 参考图 wire 通用化（JSON base64 / multipart 双形态）+ PPT 图片嵌入 + 文本可部分复制

**参考图 wire 通用化**。此前图生视频只有 multipart `input_reference`（OpenAI sora-2 形态），
agnes 等国内厂商要的是 **JSON body 里的 base64**（`images: ["<b64>"]`）。现在：
① GenProbe 探测参考图 wire（字段候选 images/image/image_url，把极小合法 PNG 的 base64 连同
非法 size 发过去——size 校验必拒，永不误创建任务），学出 `imageWire` / `imageField` 存进契约；
② `video_generate` **按契约执行**：json-base64 走 JSON body、multipart 走文件上传；
③ **未探测时两种都试**（先 JSON base64，被端点明确拒图后再 multipart）——两种厂商都不破。
实测 agnes：`mode=reference` + `images:[base64]` + `size=720P` 通过全部校验，返回
`video_queue_full`（端点队列满，参数正确）。队列满现在给的是「等 1–2 分钟重试，不要改参数」，
不再误报成配置问题。

**PPT 图片嵌入**。write_pptx 每页可给 `image`（工作区 png/jpg）+ `image_side`
（right 右半 / left 左半 / full 整页铺满），生成真图片：`ppt/media/imageN.ext`（二进制
zip 条目）+ slide rels 的 image 关系 + `<p:pic>`（blipFill 指向 rIdImg1）。配图缺失只丢该页
配图、不阻断整份 PPT。JVM 测试 2 项（嵌图齐全 / 缺图降级）。
设备实测：两页各一份 media part + slide1 含 p:pic + rels 指向正确。

**文本可部分复制**。消息正文此前无法选择任意片段（长按自定义面板抢走手势）。
`.assistant-text` / `.bubble-user` 加 `user-select: text`；长按处理里正文区域直接放行
（`.assistant-text, .bubble-user, pre, code` 不弹自定义面板），交给系统原生文字选择。
实测两个元素 computed `user-select` 均为 `text`。

单测 486 → **488 全绿**。

### rc.171（versionCode 171）· 2026-10-31 · probe_gen_endpoint 稳定化 + 探测结果全链路闭环

上一版 probe_gen_endpoint 在设备上崩了（JSONException: Not a primitive array）——根因是
Android 的 JSONArray(List) 走了 JSONArray(Object) 重载。修复三处：① Contract.toJson() 里
JSONArray(list) 改为逐条 put；② probe_gen_endpoint/image_generate 返回值里的 JSONArray(list)
同理；③ GenProbe 的 probeImage 网络异常从"抛出"改为"安全降级为空契约"。

修复后设备实测：探测→modes=[text, reference] / sizes=[720P]→写 gen.json→
video_generate schema 枚举即时更新为端点方言→按正确 mode 生成。

单测 476 → **486 全绿**。

### rc.170（versionCode 170）· 2026-10-31 · 生成端点能力探测（方言运行时习得，不写死）+ 完整收口

**核心思路转变**：之前的 mode/size 枚举是硬编码的猜测值（text2video/image2video/1280x720），
换厂商就废。现在把探测能力做进 harness 本体——端点的校验错误就是说明书，探针逐候选发
**带非法 size 的请求**（size 校验必然拒绝，永不误创建真实任务），从错误流学出端点方言。

**GenProbe**（纯 JVM 学习器 + HTTP 驱动分离）：baseline 错误暴露最严格前置条件（mode 必填、
size 白名单直给）；逐候选试 mode（text/reference/text2video/…12 个候选的搜索空间）；
valid_sizes 从任何一步的 valid_sizes 字段收集。JVM 测试用 agnes 真实错误原文钉住。

**video_generate / image_generate 动态 schema**。工具定义从契约动态生成：探测后 mode/size
的枚举即端点合法值（实测 agnes: mode=[text,reference], size=[720P]）；探测工具
probe_gen_endpoint / probe_image_endpoint 让 agent 换厂商后自己探测；生成失败 400 时自愈
（重新探测 → refreshTools → 同轮下一步枚举已刷新）。设备实测：探测 → 契约存入 →
schema 枚举变为端点方言 [text, reference] / [720P]。

**队友历史结构化**（M0 遗留 #4 清零）：assistantTurn 带 tool_calls wire、toolExec 全量落
id/args/output、inbox 补充落日志；memberHistory 重建结构化消息（旧格式兼容）。
JVM 测试 4 项 + 设备实测。

**write_docx 富文本**：超链接/斜体/删除线/嵌套列表/图片嵌入（设备实测五特征齐备）。
**schemas 缓存**：每步重算 → 结构变更失效（4 失效点），JVM 断言同实例命中。
**流式光标移除**（对齐桌面）：attachCaret/removeCaret/样式全删，流式期间 .caret = 0。
**玻璃对齐**：回到底部按钮 glass-strong → glass-a/b 渐变 + blur 38px（与 .composer 同配方）。

单测 474 → **486 全绿**。审查文档已清理，历史结论以本条为准。

### rc.169（versionCode 169）· 2026-10-31 · 队友历史结构化（冷恢复不失忆）+ workflow fan-out 实证 + 玻璃对齐

**队友历史结构化（文本级 → 与主会话 messages 同构）**。此前成员轮循环只往日志写
assistant 最终文本与 400 字符工具摘要——冷恢复的队友不知道自己上轮调了什么工具、用了什么
参数、看不到真实输出，工具结果还被伪装成 user 消息（对话结构无效）。修复三处：
① `assistantTurn` 带上 tool_calls wire（与主会话日志同构）；
② `toolResult` → `toolExec`：id/参数/输出全量落日志（输出截 2000 字，对齐工具输出约定）；
③ **inbox 补充消息落日志**——此前只进内存，重启即失忆。
memberHistory 重建：新日志输出 role=assistant(带 tool_calls) / role=tool(tool_call_id 配对)
的结构化消息；旧格式日志保持文本近似兼容。JVM 测试 4 项钉住（配对/补充落日志/旧格式/limit）。

**workflow fan-out 设备实证**。Lead 一轮内两次 spawn_teammate（alpha/beta）→ 两成员并行激活
→ wait_agent 等待。两个成员的失败均为测试端点 429 限流（如实记 failed 而非假装成功）。
结论：手机端的 workflow 形态 = **异步团队 fan-out**（spawn 并行 + 任务板聚合 + wait_agent），
桌面式「模型写同步编排脚本」因 run_code 30 秒超时与子代理分钟级耗时冲突，不照搬。

**回到底部按钮材质对齐输入框**。glass-strong(0.78 纯色)+blur30 → glass-a/b 渐变+blur38
（与 .composer 同配方）；材质模拟器断言：按钮与 .composer 的 backgroundImage/backdropFilter
计算值完全一致。

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
内核日志逐 step 分析）。

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
设计规范一致性 + 结构清理清单）。

### rc.163（versionCode 163）· 2026-10-31 · 计划类卡片身份色改回

- `.todo-card`（执行计划）右上角绿色径向渐变、`.plan-card`（计划评审）整块靛蓝渐变（含深色档位）**改回** —— 这两块是用户点名要保留的身份色，rc.162 里为统一材质抹掉是过度改动。
- 回归用例 `surface-material` 第 5 组断言随之反转为「身份色必须还在」，防止再次被统一掉。

### rc.162（versionCode 162）· 2026-10-30 · 表面材质统一（排队队列 / 目标胶囊）

- **排队队列**：原先每条排队消息各自铺不透明卡片（`--card` + `--sep` 边框），而下方输入框是玻璃 —— 一屏两种材质。改为对齐桌面端 `QueueDock`：队列面板是输入框表面的向上延伸（玻璃渐变 + 背景模糊 + 上圆下方、底边不画线），行本身无背景无边框、只用 0.5px 分隔线；队列在场时输入框上沿圆角改直（`has-queue`），两块并成一整块表面。
- **目标胶囊**：`.mode-chip` 由「灰填充、无描边」改为与输入框同一套玻璃；状态色只落在图标与阶段文字上，不再铺彩色底块。
- **无背景模糊机型**：`@supports not (backdrop-filter)` 退色名单补上 `queue-bar` / `mode-chip`，否则玻璃下会透出正文。
- 清掉两条死样式（`.qi-act.ok`、`.queue-item.is-editing` —— 编辑是把文本取回输入框，不会就地展开）。
- 注：rc.162 曾顺手把 `.todo-card` / `.plan-card` 的专属渐变也改成中性，rc.163 按用户要求改回。

## 0.2.1-rc.161（versionCode 161）· 2026-10-30

### 改：对话内搜索只高亮「当前这一处」命中

上一版把命中一律改成红色，整段正文一起变红反而看不出跳到哪。现在改成只标当前。

- 全部命中只做**无样式**包裹：`.hl { color: inherit; background: none }` —— 保留 `<mark>` 是为了
  盖掉 UA 默认黄底，但不上色；红色只挂在当前命中 `.hl-on` 上（浅色 `#d13a30` / 暗色 `#ff8f85` /
  用户蓝气泡内 `#ffcdc7`）。
- 「哪一处是当前」只有一个写入口：`syncCurMark()` 按 `__midx === hitIndex` 搬类，`applySearch`
  末尾调一次、`jump()` 每次切换调一次 —— 旧的立刻褪色，不会残留。
- 切换即 `scrollIntoView({ block: "center" })` 滚到对话中部；**只改颜色不改字重**
  （加粗会改字符宽度，切换时整段文本回跳）。

### 工程：前端回归守卫入仓并接入门禁

`scripts/regress/` 新增三个纯 Node 用例（抽出 `assets/web` 的真实源码片段跑断言，秒级、不需设备），
接线到 `node scripts/gates/run-gates.mjs static` 的 `web-regress` gate，CI 的 static lane 自动覆盖：
`chat-live-order`（等待行顺序 / PcRun 残留）、`search-highlight`（搜索范围 / 单点高亮 / 浮窗兜底）、
`session-bucket`（会话分桶串号）。

---

## 0.2.1-rc.160（versionCode 160）· 2026-10-30

### 修：搜索范围错、命中整片红、屏底露出浮窗顶边

- **搜索只该搜正文**。原先扫的是 `#messages .msg` 的整段 `textContent`，于是「已完成，用时 39 秒」
  「思考」摘要、甚至「复制 / 朗读 / 20.8k tokens」都算命中（出现过 7/7 全是界面文字）。现在只扫
  `.assistant-text`（助手正文）与 `.bubble-user`（用户气泡）。
- **命中改红**。按用户要求由绿改红：普通命中 `#d13a30`、当前命中更深更粗；蓝气泡内用浅红保证可读。
- **屏底那条「浮窗顶边」**。`#sheet`（本轮用量就是它）收起只靠 `transform: translateY(104%)` 藏到屏外，
  没有任何「不可见」兜底；而下拉关闭手势的 `onEnd` 在「面板已在关」时直接 `return` ——
  手指刚才写下的内联 `y` 位移没人清，面板半开冻在屏底，只露出顶边和那把 5px 把手。
  修复：新增 `sheetHideHard()`（`Motion.clear` + 摘状态类 + 复位 `pointer-events` 与状态位），
  `onEnd` 早退改走它，`openSearch()` 进入前先清一次；CSS 再加一道
  `.sheet:not(.is-on):not(.is-closing){visibility:hidden;pointer-events:none}` 兜底
  （收起动画期间是 `is-closing`，所以退场动画不被打断）。

---

## 0.2.1-rc.159（versionCode 159）· 2026-10-30

### 修：搜索命中带一层浅绿底

命中字符是用 `<mark>` 包住的，而浏览器对 `<mark>` 自带 `background: yellow`。`.hl` 当时只写了字体颜色
（注释写着「无背景」但实际没写 `background`），那层浅黄绿底就是 UA 默认样式漏出来的。
`.hl` 补 `background: none; padding: 0; border-radius: 0`，只保留字体变色。

---

## 0.2.1-rc.158（versionCode 158）· 2026-10-30

### 调：底部悬浮导航栏再下移 6px

rc.157 真机复测通过（等待行回到用户气泡下方）后按视觉要求继续下移：无手势区机型离屏底 20px → 14px
（`bottom: calc(6px + max(var(--safe-bottom), 8px))`），有 `safe-bottom` 的机型仍按系统手势区自动让位；
语音输入浮层让位高度同步收到 90px 保持对齐。纯 CSS，JS 侧只做显隐/拖拽 transform，无位置硬编码。

---

## 0.2.1-rc.157（versionCode 157）· 2026-10-30

### 修：「深度求索中」跑到用户消息**上面**

rc.156 真机复测抓到的尾巴。根因不在等待行本身，而在两套渲染的时序：

- `renderThread()` 首屏是 `requestAnimationFrame` **分帧灌入**（每帧 12 条防卡顿）；
- 发消息的同一个 JS 任务里：`push(用户消息)` → `renderThread()`（只排了 rAF，一帧未执行，
  `#messages` 还是空的）→ `beginLive → push(等待节点)` 同步插进这个**空列表**；
- 下一帧历史才灌进来，落在等待行**后面**；且 `fillHead` 按当时的 `thread.length` 灌，
  同一个节点还会被**灌两遍**。

修复：新增 `appendTail(n)` 统一收口所有尾部插入（`push` 与 `flowAction` 兜底分支共用）——
分帧灌未完成时先**同步补灌**剩余历史再插新节点，`renderTailFrom` 跟踪灌入进度，
DOM 顺序永远等于 `thread` 顺序，重复渲染的隐患一并消灭。

---

## 0.2.1-rc.156（versionCode 156）· 2026-10-30

### 修：「深度求索中」钉在回复顶部 + 电脑会话等待行残留

- **钉顶**。桌面端 `RunningStatus` 是独立一行、拼在消息流最末尾、`running` 结束整体卸载
  （`ChatFlow.tsx:60`）；手机端却把等待行 `innerHTML` 注入**流式气泡内部**，而 `paintLiveText`
  的增量路径只往后 append、从不重写这段 innerHTML —— 正文开始输出后没有任何代码摘掉它。
  修复：`livePaint` 的正文分支在画第一帧前先 `querySelector(".runstat").remove()`
  （`beginLive` / `Flow.newText` 两个注入点全覆盖）。
- **PC 会话残留**。`PcRun.stop()` 只从数据里删节点、不重绘，发送失败 catch、`onHistory` 静默收摊
  等无重绘调用点会让等待气泡一直挂屏；现按 `data-uid` 连 DOM 一起删。
- **清理与调整**。鲸尾 SVG 路径（`WHALE_PATH`）两处各写一遍，抽成共用 `whaleStatHTML(label)`；
  删掉旧「三点跳动」死样式 `@keyframes typingBounce`（全仓无引用）；底部悬浮导航栏下移 8px
  （无手势区机型离屏底 28px → 20px），语音浮层让位同步。

---

## 0.2.1-rc.155（versionCode 155）· 2026-10-30

### 修：意图路由把「点名工具」的请求误判成闲聊（P0）

实测『请同时调用三个 bash 工具，分别读取 /proc/version…』被判成 `chat(conf 0.35)`，策略段落随之注入
「看起来像闲聊」，直接压制模型动手。修复四件事：动作词表补 29 个常用祈使动词（旧表连「读取」都没有）；
新增**点名工具**信号（工具名与「调用 / 同时…工具」句式，task +2.2）；CHAT 低分兜底加逃逸
（点名工具或足量任务信号在场时不落闲聊帽）；CHAT 策略措辞改为「如果用户其实提出了具体操作，按操作照做」。
新增 `IntentRouterTest` 7 项钉住（含修复前那条原句），复测同一请求 `task conf=1.0`。

### 改：经典男声线换「指挥老者」+ 峰值响度归一

内置男声从 `fanchen-C(sid 69)` 换为 `fanchen-ZhiHuiLaoZhe`（单角色，116Hz，比旧包透亮），
int8 量化 32.6MB 不变。伴随两项管线修复：`NeuralTts.toWav` 新增**峰值响度归一**（目标 -1dBFS、增益上限 12×）
—— 该角色原始输出峰值波动 0.09~0.5，轻的句子外放≈无声，这是此前「男声语音生成不出来」体感的真凶；
语音缓存键加代次（v3），升级后旧响度缓存自动失效；`bazong` 等历史 id 走 LEGACY 表迁移。

### 修：回到底部按钮与输入框重叠 / 发消息时输入框弹跳

- 重叠：`.composer-dock` 长高常来自 padding（安全区晚到、键盘收窄），而 ResizeObserver 默认只观察
  content-box，padding 变化**不触发回调**，`--dock-h` 停在旧值（实测停 78px、真实 88px）。
  改为 `{box:"border-box"}` + 观察器实例强引用 + `fonts.ready` 与按钮出现瞬间各补量一次。
- 弹跳：发送后 `updateSendState()` 把空输入的发送键 disable，被点过的按钮正持有焦点 ——
  焦点丢回 body，Android 立即无动画收起键盘（`--kb` 一帧 336→0）。修复：`keepInputFocus()` 在键盘
  开着时发完把焦点还给输入框，`handleSend` 三分支 + 排队入队分支都覆盖。

单测 461 → 468 全绿。

---

## 0.2.1-rc.154（versionCode 154）· 2026-10-29

### 加：数学公式渲染（本地懒加载 KaTeX）

行内 `\(…\)`、`$…$` 与块级 `\[…\]`、`$$…$$` 此前原样漏成文字。现在内置 `assets/web/katex/`
（`katex.min.js` + CSS + 20 个 WOFF2，约 596K），与桌面同引擎、完全离线。
体积敏感的处理是「没有公式就零开销」：`MutationObserver` 只在出现 `.math` 节点时才注入 CSS/JS；
解析用 `\u0000M{n}\u0000` 哨兵保护公式原文，避免加粗/斜体/链接规则改写公式内部；
流式里没闭合的定界符保留原文、不闪红。解析逻辑跑 Node 单测 19 项。

### 修：「检查更新」在英文语言下仍显示中文

设置里的静态标签 `检查更新` 没进 `I18N` 词典，更新浮窗（`updateBody` / `sheetUpdate` / 不支持提示）
整段硬编码中文。现在标签补进词典随整树翻译，浮窗按 `EN()` 双语分支，六个状态英文模式不再残留中文。

### 删：对话界面侧边轮次导航（turn-rail）

右缘那列细刻度（对齐桌面 TurnNavigator）在窄屏上只会压住正文边缘，而且**从未接线**
（`app.js` 无任何 `turnRail` 引用，元素一直 `hidden`），属纯死代码，连同 HTML / CSS / 验证脚本一并清掉。

---

## 0.2.1-rc.153（versionCode 153）· 2026-10-29

### 改：对话内搜索改字符高亮 + 搜索态自动避让

- 命中从「整条消息套蓝色描边」改为字符级 `<mark>`：只包裹文本节点、不动外层 DOM，
  不打断 markdown / 代码块结构，退出搜索整体 `unwrap` 还原。
- 修复「搜索时按钮不避让」：CSS 早有一条依赖 `html.search-on` 的上抬规则，但该类**从没被 JS 加上过**
  —— 规则形同虚设。现在 `openSearch` / `closeSearch` 正确切换，实测间隔 48px。
- 搜索态 `modeBar` 只渲染搜索签，预设 / 计划 / 目标签不再挤在同一行（搜索是专注模式）。

---

## 0.2.1-rc.152（versionCode 152）· 2026-10-29

### 加：前台命令的退出码徽标

终端 / 后台任务类工具的结果 JSON 本就带 `exit_code`，但前台一次性命令（`bash` / `python` / `node` /
`run` / `java` / `rustc` / `pkg` / `compile`）的结果是纯文本，退出码没地方承载，界面只有糊成一片的
「成功 / 失败」。

- 走旁路不改正文：`ToolSpec` 新增 `executeResult(args, ctx): ToolResult(text, exitCode)` 作为**唯一**
  派发入口（默认包裹旧的 `execute`，几百个工具零改动）；shell 类工具用 `exitHeader` 声明「正文首行是
  exit=N」，注册表把退出码放进信封**同级字段**（模型看到的内容一字不动），`Outcome.exitCode` 只认该字段。
- 退出码跟着单次调用走，没有「全局最后一次」旁路 —— 同批并发不串号。
- 界面：`exit 0` 灰徽标、非 0 红徽标，随 `tool_end` 实时出现，重载会话后仍在。
  （Android toybox 的 `ls /nope` 退出码是 1，不是 GNU ls 的 2。）

### 修：上下文压缩**从未真正生效**

轮首压缩的「可压缩边界」参数默认值把整段历史都标记成本轮，压缩器每次都原样返回 —— 自引入以来
压缩从未压缩过任何东西。删掉该参数（历史整段可压缩），「本轮」语义只归轮内压缩。
剪枝（折叠早期工具输出）不再折**最后一轮**的工具段（最后一条用户消息之后是模型眼下的工作记忆，
折掉就失忆），保留条数约束只作用于更早的轮次。

配套：压缩账目全链上屏（`folded` 计数 → `compacted` 事件 → 轮末「用量」面板「上下文压缩」行；
检查点展开时正文前补账目行「压缩 N 条 · X → Y tokens · 省 Z%」）；剪枝文案从「省略 0 条较早消息」
改为「折叠 N 处早期工具输出」。

### 修：轮末「本轮用量」面板自上线以来打不开

footer 的用量按钮先渲染后赋节点 id，导致 `data-turn-usage` 永远是空串 —— 面板从没被打开过。
先赋 id 再渲染。真机验收（桩模型 + 4k 小窗口）：摘要 8602 → 3113 tokens（省 64%）。
单测 461 项全绿（新增「最后一轮工具段不折叠」「退出码并发不串号」等 10 项）。

---

---

## 0.2.1-rc.151（versionCode 151）· 2026-10-29

### 修：浮窗上拖时底部撕开一条灰色台阶

抓面板顶部小横条往上拖，底边会露出一条约 12px 的灰带（浅色主题尤其明显）——
那不是面板在延伸，是把遮罩露出来了。

- **根因**：`.sheet` 是 `bottom:0` 的定高盒子，上拖那段橡皮筋做的是 `translateY(-12px)`，
  把整块连同底边一起抬走，底边离开屏幕底，下面露出的是 `backdrop-filter` 遮罩。
- **修法：让材质多铺一截到屏外**。面板整体下沉 14px（`--sheet-skirt`），同时等量加大
  `padding-bottom` —— 内容盒子、可见高度、按钮位置全部不变；多出来的 14px 躺在屏幕外，
  专门给上拖吃掉（拖 12px 后底边仍在屏外 2px，缝就没了）。
- 带固定底部按钮的面板（`:has(.sheet-footer)`，如「额度与用量」）与键盘弹起态
  （`html.kb-open .sheet.is-on`）的 `bottom` / `max-height` 同步补上这 14px，可见下沿位置一律不变。
- 纪律：JS 的 `Math.max(-12, dy)` 与 CSS 的 `--sheet-skirt` 必须成对维护，两处注释互相点名。
- 验证：上拖保持时面板底边 917 > 视口 915；底部像素从「34,37,42 → 22,23,24 → 11,11,13」
  变成整条一致；松手回落 top 与拖动前一致；静止态截图与改前**逐像素 0 差异**。

### 性能：只砍「同一帧里本来不需要做的活」

不动样式、动画时长、缓动与 DOM 结构，改的都是「同样一帧，少干点活」。

- **`applyLang()` 的全树空转**：它每次切页 / 每次列表重绘都会把**全部文本节点重写一遍同值**，
  每个节点一次 CharacterData 变更 → 父节点样式失效重算，还会给 MutationObserver 记一条。
  现在值没变就不写；中文模式（没有可翻译文案）整树扫描直接跳过，只有首次与「英文切回」才全量还原。
- **文本查表缓存**：按节点记「原文 / 译文 / 上次写出值」三态，英文模式反复渲染不再逐节点跑正则。
- **桥方法缓存**：`Native.xxx` 以前每次调用都要对十几个 `@JavascriptInterface` 对象做 `typeof`
  线性扫描。缓存**必须懒建** —— 试过启动时预热反而把冷启动拖慢（每次取值都是跨语言），已回退。
- **原生**：表情包仓库不再经 `kernel` 懒加载 —— 装配内核要拉起插件注册表、工具目录、会话日志、
  钩子链，而这里只要一个文件路径。新增 `ToolKernel.stickerFile()` 供桥接层直接建 store，
  内核仍按需初始化；顺手把 `provideService("sticker.store")` 里重复 new 的第二个实例改成同一个。
- **死代码**：删掉长按入口撤掉后没人再走的 `sheetSessionActions` / `sessLongPress` / 面板置顶分支 /
  `TEAM_STATUS` / `VOICE_GENDERS` / `DIFF_TOOLS`。

实测（模拟器 x86_64，同构 debug 包交替安装 A/B）：400 条消息挂在页面上时，搜索框输入 4 个字的
主线程占用 610 → 529ms，连续切 4 页 502 → 466ms；冷启动在噪声内（本次没动启动路径）。
四屏截图逐像素比对：对话中部 / 设置 / 语言浮层 0 像素差异。单元测试 451 项全绿，R8 构建通过。

---

## 0.2.1-rc.150（versionCode 150）· 2026-10-29

### 修：会话页冷启动闪一下空的「置顶 / 工作区」

零会话冷启动时，会话页会先闪出「置顶」「工作区」两个空分组再消失。

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

---

## 0.2.1-rc.149（versionCode 149）· 2026-10-29

### 修：检查更新点下去只弹「当前版本不支持检查更新」

功能本身是好的 —— **前端没有登记这个原生网关**。

- 原生在 `NativeBridge.domains` 里注册了 `DSHNativeUpdate`，但网页的 `NATIVE_DOMAINS`
  白名单是手写数组，rc.146 加桥时漏了一行，于是 `Native.updateState` 恒为 `undefined`，
  `openUpdateSheet` 第一句判空就把用户挡在门外（一块功能整块哑掉，还没有任何报错）。
- 修法不是「补一行」：白名单现在只表示**优先级**，脚本启动时把任何没列到的 `DSHNative*`
  注入对象自动追加在后面 —— 同名方法仍以先列者为准，但**新增桥不必再改这里**，
  不会再因为漏登记让一块功能静默消失。
- 前车之鉴同 rc.119（清单里的 `android:name` 写错同样静默失败）：凡是「手写清单 + 静默降级」
  的组合，都要么加断言、要么改成自动发现。

### 修：「完成后通知」开关之前是装饰品

它只写了 `localStorage`，原生侧（`RunService.finish`）从来没读过 —— 无论开关怎么拨，
「已完成」通知都照发。

- 偏好收口到顶层 `AppPrefs`（文件 `dsh`）：`bridge` 与 `notify` 都要读它，挂在任何一边都会让包
  依赖成环；顺手把原 `BridgePrefs` 并进去，全进程只留一个 `SharedPreferences` 实例
  （Activity context 与 application context 各拿一份会互不同步，这条坑以前踩过）。
- `NotifyBridge.setNotifyDone/notifyDoneEnabled` + `RunService.finish` 三个条件同时判定：
  不在前台、不是用户主动停止、**开关为开**。「执行失败」与「需要你确认」不受开关约束 ——
  它们属于待处理事项，关掉完成提醒的人也不希望任务悄悄挂掉。
- 打开开关时当场核对系统通知是否被关掉（`notifyInfo().notificationsEnabled`），没授权就直说
  发不出来 —— 否则又是一个「开了却没反应」。

### 「危险操作前询问」判定收口

链路本身是通的（`askDanger → needConfirm → Gate.confirmDanger → approval_request` 卡片），
但判定逻辑埋在 pipeline 的 waterfall 里，只能靠跑真模型回合验证。现在抽成纯函数
`DangerGuard.reason(name, args)`：

- 破坏性动词按 POSIX / Windows 两套正则分开（原来漏了 Windows 侧的 `Remove-Item` 一族）；
- **有意不剥离引号内容**：`sh -c "rm -rf /"` 是最危险的一类，剥引号会把它放过去；
- 新增 `DangerGuardTest`（6 个用例）钉住「开关关 = 判都不判」「完全授权下开关不生效」
  「日常命令不打扰」，不必再靠真机跑一轮对话验证。

**顺手修红灯**：`CompanionEngine` 在 `object` 初始化里就 `Handler(Looper.getMainLooper())`，
JVM 单测（无 Looper）一碰这个类就 `ExceptionInInitializerError`，整份 `CompanionEngineTest`
11 个用例常年全红 —— 门禁一红就没人看。改成 `by lazy` 后全量单测 451 项转绿。

---

## 0.2.1-rc.148（versionCode 148）· 2026-10-29

### 更新下载改为后台进行（前台服务 + 完成即进安装页）

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

---

## 0.2.1-rc.147（versionCode 147）· 2026-10-29

### 更新源实测校正：镜像按速度排序 + 修 API 回退失效

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

---

## 0.2.1-rc.146（versionCode 146）· 2026-10-29

### 设置页新增「检查更新」：镜像优先、GitHub 保底

没有变化时一个浮窗告知「已是最新版」；有新版显示版本号、包大小与更新说明，
点「立即更新」开始下载并显示进度，下完自动拉起系统安装器。

- **数据保留**（覆盖安装的前提，两条缺一不可）：
  · 同 `applicationId` + 同签名原地升级 —— 系统保留 `/data/data/<pkg>`，会话、记忆、设置全在；
  · 装之前先 `PackageManager` 比对**包名 + 签名**，不一致直接拒绝并说明原因。
    否则用户会等完几百 MB 才在系统那一步被拒（或者更糟：装成另一个应用、旧数据读不到）。
- **下载源：镜像优先，GitHub 保底**。直连 `github.com` / `objects.githubusercontent.com`
  国内常常只有几 KB/s，200 多 MB 的包基本下不完。候选源逐个尝试，浮窗上会显示当前用的是哪个源。
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

---

## 0.2.1-rc.145（versionCode 145）· 2026-10-29

### 修：输入框聚焦时冒出「一圈黄边」

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

---

## 0.2.1-rc.144（versionCode 144）· 2026-10-29

### 设置项改名：「查看系统提示词」→「查看用户提示词」

用户指出命名不准：那个入口里显示的是**自己写的角色设定**（会拼进 system prompt 的那一段），
不是完整的系统提示词 —— 叫「系统提示词」会让人以为能看到身份、环境、工具清单、工作区规则。

- 设置行文案：`查看系统提示词` → **`查看用户提示词`**（`index.html`）。
- 查看器标题：`系统提示词` → **`用户提示词`**；副标题从「只显示你的角色设定」改为
  「你写的角色设定，会拼进系统提示词一起发给模型」，把关系说清楚。
- i18n 词条与代码注释同步（`View user prompt` / `User prompt`），避免中英混用。
- 未采用「回放完整 system prompt」的方案：那需要新增原生接口读会话日志里的
  `system/message`，与「用户提示词」这个定位不是一回事，先不做。

---

## 0.2.1-rc.143（versionCode 143）· 2026-10-29

### 修：设置页「系统提示词」一直显示「未设置」

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

---

## 0.2.1-rc.142（versionCode 142）· 2026-10-29

### 去掉网页里那套模拟状态栏（冷启动会露出来）

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

---

## 0.2.1-rc.141（versionCode 141）· 2026-10-29

### 修：「需要你确认」通知在应用内处理后不消失

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

---

## 0.2.1-rc.140（versionCode 140）· 2026-10-29

### 团队：成员会话按桌面语义补齐

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

---

## 0.2.1-rc.139（versionCode 139）· 2026-10-29

### 修复：从成员会话退出后回不到原对话、历史显示错内容

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

---

## 0.2.1-rc.138（versionCode 138）· 2026-10-29

### 删除会话弹层误弹模型配置 + 深色下回前台闪白

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

---

## 0.2.1-rc.137（versionCode 137）· 2026-10-29

### 按压高亮：贴边圆角 + 满宽无缝（深色下无灰边）

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

---

## 0.2.1-rc.136（versionCode 136）· 2026-10-29

### 按压态形状与元素形状严格一致

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

---

## 0.2.1-rc.135（versionCode 135）· 2026-10-29

### 按压态修正：不再变透明、不再变矩形

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


用户反馈：会话列表是对的，但点进某个会话，对话页显示的是**另一个会话**的内容。

- **根因**：`persistThread()` 为了不卡流式渲染，把 `shotNode(thread)`（深拷贝快照）放进了
  `requestIdleCallback` 里**延迟执行**。但 `thread` 始终是**同一个数组引用** —— 切会话时
  `openSession()` 会先 `thread.length = 0` 再灌入新会话，空闲回调若在这之后才跑，
  拷到的就是「新会话内容」，却写进**旧会话的 sid** → 会话串号。列表读的是 title/摘要，
  所以看起来正常。
- **修法**：`persistThread()` 里**同步深拷贝**快照（`shotNode`），再把 stringify + 落盘交给空闲回调。
  深拷贝是 O(整段对话)，但只在切片/轮末/每 8 秒发生，换正确性值得。
- **注意**：已经被写坏的历史快照无法自动还原（数据里没有来源标记）；重新聊过或新建的会话写入正确。

---

## 0.2.1-rc.134（versionCode 134）· 2026-10-28

### 会话串号根治：对话流按会话分桶（对齐电脑端 per-session 语义）

- **现象**：在对话页看完答案、退回会话列表、再点进该对话，看到的却是**另一个会话**的内容；
  列表本身是对的（它读的是标题/摘要）。且已经被写坏的会话不会自愈。
- **根因（结构层面，不是某一行写错）**：`persistThread()` 是
  `LocalDB.saveShot(state.sessionId, shotNode(thread))` —— 用「当前渲染的**全局** `thread`」
  覆盖写「当前 sessionId 的槽位」。只要两者有一瞬间不同步就会串：切会话间隙、异步回调、
  `handleSend` 里刚 `LocalDB.create` 出新 sid 却没换数组、目标模式新建会话……
  rc.133 只把 `shotNode` 从 `requestIdleCallback` 挪出来做同步深拷贝，堵住一处，其余照旧。
  电脑端从来没有「把当前窗口内容写回某个会话 id」这个动作：每会话一份日志、只追加，
  由内核按会话身份落盘，前端只是读者 —— 结构上不可能串。
- **修法：对话流按会话分桶**。`thread` 从全局唯一的数组改成「当前会话那一份的**引用**」，
  `bucketOf` 按 sid 分桶，切会话只换指针、各会话数组物理隔离。一组语义化入口统一管理
  （切会话只允许走这些）：`attachThread` 切过去并返回桶、`attachBlank` 开一份空白新流、
  `adoptThread` 接管刚建好的会话、`hydrateThread` 幂等从库灌历史。全文只有一处
  `thread = …`（在 `attachThread` 内）。
  · 覆盖全部入口：`openSession`（含 sameRunning 重载恢复）、首次建会话、目标模式新建/续跑、
    `ensureSession`、`startNewSession`、删除/归档、成员会话视图、中继会话、宿主机会话。
  · 已加载过的会话**直接复用内存里那份**（思考展开、工具行开合、正在跑的 Live 节点都在），
    不再「清空 + 从库重建」。
  · LRU 上限 8 份，淘汰前先落一次快照；**正在跑的那份永不淘汰**（否则 Live 指向游离节点，
    切回来就是「只有终止按钮、正文全空」）。
- **落盘身份自检**：`persistThread()` 要求 `thread.__sid === state.sessionId`，不符就跳过并告警 ——
  **宁可这一轮漏存，也绝不写错会话**。将来新增任何路径忘了换桶，最坏是漏存。
- **事件归属校验**：`AgentBridge` 给每条 `onAgent` 事件注入 `sessionId`（delta/reasoning 走
  聚合器同样带）；前端 `NativeAgent.on()` 只渲染 `thread.__sid` 匹配的事件 —— 用户切走后
  旧会话的正文/思考继续到达时直接丢弃。另修 `finally` 顺序：先冲刷残留聚合内容再清
  `roundSession`，否则最后一批 delta 缺身份。
- **异步写全部带归属检查**：宿主机历史 `Host.call(...).then`、电脑会话轮询 `PcRun.append`、
  成员会话轮询 `refreshTeamViewMessages` —— 回来时用户可能已切走，身份不符直接丢弃。
- **验证**：从 `app.js` 抽取**真实源码片段**跑 Node 单测（不是复制一份逻辑），13 项全通过：
  切会话互不影响、身份不符拒写、LRU 不淘汰在跑的/当前的、三种 attach 语义、幂等。
- **注意**：已被旧版本写坏的历史快照无法自动还原（数据里没有「这段属于谁」的标记）；
  个别仍显示别人内容的旧会话删掉重开即可。

---

## 0.2.1-rc.133（versionCode 133）· 2026-10-28

### 修复会话串号（止血）：点 A 进去看到 B 的内容

- **现象**：会话列表正确，但点进某个会话，对话页显示的是另一个会话的内容。
- **根因**：`persistThread()` 为了不卡流式渲染，把 `shotNode(thread)`（深拷贝快照）放进了
  `requestIdleCallback` 里**延迟执行**。但 `thread` 始终是同一个数组引用 —— 切会话时
  `openSession()` 先 `thread.length = 0` 再灌入新会话，空闲回调若在这之后才跑，
  拷到的就是「新会话内容」，却写进**旧会话的 sid**，于是会话串号。
- **修法**：`persistThread()` 里**同步深拷贝**快照，再把 stringify + 落盘交给空闲回调。
  深拷贝是 O(整段对话)，但只在切会话/轮末/每 8 秒发生，换正确性值得。
- 这是止血补丁，结构问题由 rc.134 统一根治（对话流按会话分桶）。

---

## 0.2.1-rc.132（versionCode 132）· 2026-10-28

### 会话堆叠：浅色下发灰 + 层次颠倒修正

- **现象**：浅色模式下堆叠卡片底下的叠层像两条灰台阶/脏块，而且「第二层看着最往下」。
- **根因（两条）**：① 叠层用 `brightness(.93/.86)` 压暗白卡 —— 浅色背景 `#f2f2f7` 下比背景
  更暗，必然读成阴影；② 两个伪元素都沿用 `z-index: -1`，而 `::after` 后渲染跑到**上层**，
  更窄的第三层压在了第二层上面，在卡片正下方中间露出一条「更窄、更往下」的条，层次整个颠倒。
- **修法**：叠层改「白底 + 0.5px 细边（`--sep`）」表达纸边，亮度只留 `.98/.96`；
  显式分层 `::before → z-index:-1`（宽的在上一）、`::after → z-index:-2`（窄的在下）；
  几何保持「越往下越窄」（左右缩进 14/28px、露出 4/8px）。
- 注：堆叠卡片是手机端独有，电脑端没有对应实现。

---

## 0.2.1-rc.131（versionCode 131）· 2026-10-28

### 陪伴保活通知改有声，去掉「只是保活，不响铃」

- **现象**：陪伴式畅聊的通知没有声音，通知上还写着「这里只是保活，不响铃」。
- **根因**：保活前台通知走 `dsh_companion_keep` 通道，`IMPORTANCE_MIN` + `setSound(null)` +
  `enableVibration(false)` + 通知 `setSilent(true)` + `PRIORITY_MIN`，被系统收进「静默」区。
  （「陪伴开口」的通知走另一条 `IMPORTANCE_HIGH` 通道，本来有声。）
- **修法**：通道换新 ID `dsh_companion_keep_v2`（**Android 不允许修改已创建通道的重要性**，
  旧 MIN 通道改不动，只能换新 ID）→ `IMPORTANCE_DEFAULT`，去掉 `setSound(null)` /
  `enableVibration(false)`；通知去掉 `setSilent(true)`、`PRIORITY_MIN` → `PRIORITY_DEFAULT`；
  文案改为「到点它会主动开口，陪你聊两句」；另加 `setOnlyAlertOnce(true)`，常驻通知随在跑
  名单更新时不反复响。

---

## 0.2.1-rc.130（versionCode 130）· 2026-10-28

### 会话堆叠「中间层又长又厚」修正

- **现象**：工作区堆叠卡片底下那层几乎和主卡同宽、露出很厚，像一条白带。
- **根因**：`.ws-group.is-stacked::before` 只缩进 6px（宽度 ≈ 主卡），并沿用 16px 大圆角；
  再叠上 `brightness(.96)` 的偏亮白 → 浅色页面上就是一条又长又厚的弧带，读不出「纸边」。
- **修法**：缩进 6px → 12px（第二层 16 → 24px），圆角 16 → 12px，亮度 .96/.90 → .93/.86，
  露出高度 6/11px → 5/9px，阴影同步减轻。叠层收窄变薄后是清楚的「还压着一张」。
  （注：堆叠卡片是手机端独有，电脑端没有对应实现。）

---

## 0.2.1-rc.129（versionCode 129）· 2026-10-28

### 修复流式输出截断 / 顺序错乱 / 字面量 null

- **现象**：Agent 回复与分析都被截断、思考和正文穿插顺序错乱，偶尔整段只输出 `null`。
- **根因（对照电脑端定位）**：
  1. `StreamFlusher` 用两个 `StringBuilder` 分别攒 text / think，flush 时固定「先 think 后
     text」→ 交替序列 `思考A→正文B→思考C` 被重排成 `思考A+C→正文B`，前端看起来就是穿插被截断。
     （电脑端传输层是**逐条保序**、合帧只在渲染侧。）
  2. 桥侧 `StreamCoalescer.flushAll` 的 `send` 在锁外，agent 线程与主线程 tick 并发 flush 时
     `webView.post` 投递乱序。
- **修法（对齐电脑端「传输层严格保序」）**：`StreamFlusher` 重写为**单段队列**（同类型连续合并、
  类型切换新开段），flush **按入队序回放**；`StreamCoalescer.flushAll` 的 `send` 移入同步块串行；
  前端 `paintLiveText` 补 `generation` 自愈（非追加输入全量重建，对齐电脑端 `IncrementalMarkdownParser`）。
- **`null`**：部分端点把 JSON null 序列化成**字符串 `"null"`**，原 `isNull()` 检查放不过它；
  `LlmClient` 与 `MessagesApi` 对 `content`/`reasoning_content` 值为 `"null"` 一律跳过。
- **验证**：本地 mock SSE 按「思考→正文→思考→正文→思考」吐块，界面渲染顺序与到达顺序一致
  （逐段穿插），不再聚集/错位。

---

## 0.2.1-rc.128（versionCode 128）· 2026-10-28

### 修复新建会话后对话页透出会话页（rc.127 回归）

- **现象**：从会话页新建会话后，对话页中间大块灰色、露出会话页的搜索框与「最近 3 条」。
- **根因**：rc.127 为保留压暗层，`settleScreenTween` 对底层会话页整块 `return` 跳过清理，
  `is-leaving` / `zIndex` 未复位 —— `.screen` 非 active 默认 `visibility:hidden`，唯一让
  会话页仍可见的正是残留 `is-leaving`；同时对话页 `tween-shadow`（`background:var(--bg)`
  不透明底）被清掉而透明 → 直接透出下层。
- **修法**：改为 `keepDim` 分支——保留底层 `tween-under` 与 `--under-dim`（供 pop 连续淡出），
  其余复位照做（移除 `is-leaving` 隐藏底层、复位 `zIndex`/`visibility`/`transform`/`opacity`）。

---

## 0.2.1-rc.127（versionCode 127）· 2026-10-28

### pop 返回「闪暗、变化太直接」根治：压暗层连续对称过渡

- **根因**：rc.126 只在 pop 时让压暗层淡出；进入对话页（push）后 `settle` 把底层会话页的
  压暗层清掉，返回（pop）时又给会话页重新加类，`::after` 以 `.14` 瞬间出现 —— 等于
  「先啪地变暗、再淡亮」；进入那一下也没有淡入。
- **修法**：压暗层跨 push→pop 持续保留、两端对称驱动 —— 进入 `0→.14` 淡入（先置
  `--under-dim:0` 再加类，下一帧才升到 `.14`），返回 `.14→0` 连续淡出；CSS 过渡与滑动
  同拍对齐 360ms，不再有「先暗后亮」的硬跳。

---

## 0.2.1-rc.126（versionCode 126）· 2026-10-28

### 修复 pop 返回时会话页「从暗突变正常」

- **根因**：压暗层 `.tween-under::after` 原为固定 `opacity:.14` 且无过渡，靠动画收尾摘类
  那一刻才消失 → pop 时对话页滑出、会话页露出来，压暗层在收尾帧被瞬摘，会话页啪地亮起。
- **修法**：改用变量 `opacity: var(--under-dim, .14)` + 过渡；pop 启动的下一帧把底层
  `--under-dim` 设 `0`，压暗随对话页滑出同步淡出（而非等收尾帧）。

---

## 0.2.1-rc.125（versionCode 125）· 2026-10-28

### 切页动画换主流方案（合成器驱动）

- **Tab 之间 = Material 3 fade-through**：旧页 140ms 淡出并微缩到 .98，新页延迟 80ms 从
  .96 用 emphasized 曲线缩放淡入（260ms），无横移，方向感交给底部导航滑块。
- **会话 ↔ 对话 = iOS 式全幅推入/推出**：对话页整页滑入/滑出，底层会话页视差退让 24% 并
  压暗，滑动页带投影；顶栏/输入框随页面一起滑，不再单独编排。
- **改用内联 CSS transition 驱动**：transform/opacity 的插值跑在合成器线程，主线程只在
  起、止各写一次值；滑动页补 `background:var(--bg)` 不透明底防透出；收尾统一摘类清内联。

---

## 0.2.1-rc.124（versionCode 124）· 2026-10-28

### 切页卡顿根治：弹簧驱动换成解析解

- **主因在主线程算法，不在 CSS**：弹簧是「半隐式欧拉 + 240Hz 子步」，每帧给每根弹簧
  `Object.assign` 两份快照写回 mem —— 切页时并发 6~8 根 ≈ 每秒上千次分配，GC 停顿即坏帧。
- **改闭式解**：阻尼弹簧 `x(t)/v(t)` 一次算出，无积分、无子步、无漂移；retarget 以
  「当前值 + 当前速度」为新初值；mem 复用同一对象（零每帧分配）；尾段位移 <0.05px 跳写。
- **进页刷新错开到 430ms**，不再和收尾帧同帧抢主线程。
- **模拟器实测**：热身后坏帧中位数 18 → 10、最差帧 99.9 → 33.4ms。

---

## 0.2.1-rc.123（versionCode 123）· 2026-10-28

### 正在运行的工具行也扫光

- 之前扫光只落在组头标签与运行中那行的摘要；摘要为空或只有路径时，运行中的行看起来
  和别的行没区别。现在工具自身的**名字**在运行中也走 `is-shimmer`（负延迟接相位）；
- 电脑端工具卡同步：运行中的工具名、卡片头「N 个工具 · 运行中」同样扫光。

---

## 0.2.1-rc.122（versionCode 122）· 2026-10-28

### 任务页可编辑可删除 + 列表不再「消失」

- **「记录会消失」**：列表原只在启动渲染一次、切页不刷新；现每次进页现读（等切换动画收尾）。
- **「删不掉也改不了」**：唯一入口是 520ms 长按且无提示；现在点按任务行即弹操作面板。
- **新增编辑**：定时任务可改名称/内容/触发方式，走 `KernelBridge.scheduleUpdate` →
  `ScheduleRegistry.update`（规则选择器在 patch 顶层，桥接需拍平）。
- **「立即触发一次」不再误删周期任务**：原实现无条件 `scheduleDelete`，现在只有一次性任务
  （after/at）触发后移除；「下次执行」字段由 `next_at` 修正为 `scheduledAt`，结束态按 `state` 判断。

---

## 0.2.1-rc.121（versionCode 121）· 2026-10-28

### 提示卡文字溢出卡片修复

- **根因**：`.turn-note` 是 flex，文本列 `> span` 没写 `min-width:0`（flex 子项默认
  `min-width:auto` = 内容最小宽度），一个不可断的长 token 就把整列最小宽度顶到几百 px，
  每行都在卡片圆角外换行、被屏幕右缘裁掉。
- **修法**：文本列加 `min-width:0` + `overflow-wrap:anywhere`；`.messages` 兜底
  `overflow-wrap:anywhere`（它参与最小宽度计算，`break-word` 不参与）；`job_done` 的 tail
  先压单行、超长保留末尾 140 字。

---

## 0.2.1-rc.120（versionCode 120）· 2026-10-28

### 思考内容默认回缩

- 过程组里的思考行不再「一出现就展开」：进行中只显示组头一行「正在分析请求」（扫光 + 摘要），
  正文点开才看；每 token 只更新摘要一行，不再整段重排、不再把回答顶走。
- 顺带删掉只为「自动展开再收回」服务的 `autoOpen` 状态，`markThinksDone` 只剩状态切换。

---

## 0.2.1-rc.119（versionCode 119）· 2026-10-28

### 陪伴式畅聊「开了像没开」根治：清单类名 + 通知权限 + 兜底心跳

- **根因一（致命）**：`AndroidManifest` 把保活服务写成 `.kernel.plugin.builtin.CompanionKeepService`
  （真身在 `.builtin.device`），`startForegroundService()` 找不到类 → 异常被 `runCatching{}`
  静默吞掉 → **保活从未启动、心跳一拍都没跑**；同一处 `InstallReceiver` 也少了 `.app`，一并修好。
- **根因二**：Android 13+ 未申请 `POST_NOTIFICATIONS`，`notify()` 被系统静默丢弃 —— 引擎照常
  开口、消息也落 outbox，用户外面什么都看不到。现补弹窗 + `areNotificationsEnabled()` 检查，
  发不出去写进 `lastWarn`，状态面板新增「通知」一行。
- **不再装作没事**：`ensure()` / `startForeground()` 失败都记 `lastError` + logcat，状态页显示原因。
- **兜底心跳**：服务缺席时由应用内每分钟补一拍（服务在跑时空转，不双倍）。
- **编译期防线**：新增 Gradle 任务 `verifyManifestComponents`（挂 `preBuild`），逐个核对清单里
  每个相对类名能在源码找到同包同名类，找不到直接构建失败。

---

## 0.2.1-rc.118（versionCode 117）· 2026-10-27



### 悬浮导航：只有玻璃滑块盖到的字符才变蓝



- **现象**：切页时新页整颗先变蓝、旧页也还蓝着，滑块外面能看到蓝字；静止态的蓝色

  也不受滑块控制。

- **根因**：`go()` 里 `is-on` 类**立刻**切到新 tab（整颗蓝 + 图标蓝色投影），而滑块要

  弹簧滑 ~460ms 才到位；另外覆盖裁剪里有 `is-on → clip-path:none` 的短路，整颗直接

  绕过逐帧计算。

- **修法**：蓝色只由 `.tab-blue` 克隆层按玻璃滑块的**真实矩形**逐帧裁剪

  （`.tabbar.cover-live`）；`is-on` 不再上蓝色，图标投影挪进裁剪层（一起被裁）；

  切页/松手后各起一个 rAF 泵（620/720ms）跟到落位，静止态也按实际位置重算；

  语言切换时重建克隆层（否则蓝层还是旧语言的字符）。

- **顺带的性能**：裁剪绘制改成「先量完所有矩形、再批量写 clip-path」（原来读写交错，

  每帧 4 次强制布局）；导航条 scaleX 用写入值缓存，不再每帧 `getComputedStyle`。



### 页面切换流畅性



- `go()` 不再每次调用 `applyLang()`：它会用 TreeWalker 全量扫 body 做翻译，语言没变

  也照扫，正好压在切换动画首帧上。

- 会话列表重建从「下一帧」改为「切换动画收尾后 340ms」——整列表 DOM 重建 + 布局不再

  和入场动画抢同一帧。

- 切换期间额外关掉悬浮导航的 `backdrop-filter`（blur 44px，背后一切都在动时每帧都要

  重新采样大半径模糊，是掉帧大头之一），动画结束自动恢复。



### 会话堆叠的三个细节



- **单个会话不再画两层叠边**：之前不管几条都固定画两张「下面还压着一摞」的卡边，

  只有 1 条会话时语义是假的。现在按条数加 `is-single`，收起/展开两条路径都同步。

- **叠层不再单独发亮**：两层原来与卡片同一个纯白 `--card`，在浅色页面上就是「底下

  两条白光带」，还带一条 0.5px 的 `--sep` 高光亮边。改为越往下越暗（brightness

  .96 / .90）+ 极轻投影，读作纸的侧边而不是发光。

- **长按「选中」按压动画**：按住堆叠头时整摞（含底下两层）一起下压 1.5% 再回弹，

  不再是只有头部浮起来；会话行按住同样微缩 1.5%（左滑状态下不叠缩，避免覆盖位移动画）。



### 陪伴式畅聊：最强档真的会开口了



- **现象**：开着「话多」档一整天几乎收不到一句。

- **两个原因一起修**：

  1. 窗口太长：`话多` 10–30 分钟 → **6–18 分钟**（Kotlin 心跳与前端 `CADENCE` 两份

     同值副本同步改）。

  2. 提示词不分档：「没有真实由头就回 SILENT」对所有档位一视同仁，窗口再密也句句沉默。

     现在按档位分级——话多档只要有一点由头就聊，**连续 2 次沉默后强制开口**（新增

     `silentStreak` 计数，真正传进提示词）；安静档维持严格；适中档居中。

- 发过一句后 `silentStreak` 归零。



---



## 0.2.1-rc.117（versionCode 116）· 2026-10-27



> 注：本版推翻 rc.115 对「PaX/grsecurity」的判断——真机复核证明内核是标准

> Android 6.12（无 PaX），报错里的 grsecurity/PaX 只是 HotSpot 对「拿不到可执行

> 内存」的通用提示。真正的机制见下。



### 手机内造 App 的 JVM 启动失败（执行内存拒绝）根治



- **现象**：app_build 守护进程连续 5 次同一报错

  `Error occurred during initialization of VM` +

  `Failed to mark memory page as executable - check if grsecurity/PaX is enabled`。

  paxctl 豁免、setarch -R、压代码缓存、`-Xint` 全部无效。

- **定位（真机实测，非猜测）**：

  - 排除 seccomp：app 策略里没有 mprotect 条目，同进程 ART JIT 一直正常工作；

  - 排除 SELinux：`untrusted_app_27` 明文 allow execmem/execmod（targetSdk 28 的选型原因）；

  - 用 LD_PRELOAD 钩子抓到现场：`mprotect(4096, prot=7) = -1 errno=13`，目标是

    一段 **rw-p（已写过）** 的匿名映射。判别实验定出该内核的规则：

    **mmap 时带 X 放行、未写过的页加 X 放行、已写过的页加 X 拒绝**。HotSpot 提交

    代码缓存恰好踩第三条，所以 100% 确定性失败。

- **修法（execfix shim）**：mprotect 失败且目标含 `PROT_EXEC` 时，用

  `mmap(addr, len, prot, MAP_FIXED|ANON|NORESERVE)` 在同一地址重新映射——属于

  「mmap 时带 X」，策略放行；目标页是空的新提交页，清零无损。普通设备 mprotect

  从不失败，零副作用。

- **判据不按 errno 硬编码**：同一条拒绝，本机报 `EACCES(13)`，别的内核可能报

  `EPERM(1)`；只判「失败 + 目标含 PROT_EXEC」，errno 仅用于日志与失败时回填。

- **落地细节（几处坑都踩过并修掉）**：

  - C 源码随包内置（自包含、零 `#include`）——rootfs 镜像只有 gcc 与 crt/libc.so，

    **没有 musl 的 C 头文件**，带 include 的版本在干净设备上编译必败；

  - **rootfs 就绪即预热编译**（`/usr/lib/libdshexecfix.so`）：终端会话入口是

    `/bin/sh`，靠「java 入口」触发的懒编译在终端里永远不会发生；

  - **LD_PRELOAD 只走 guest 侧**（`sh -c 'export LD_PRELOAD=…; exec "$@"'`）：

    放进宿主环境会让 proot 本体（bionic）找不到 rootfs 内路径，proot 直接起不来；

  - 顺带安装 `/usr/local/bin/{java,javac}` 包装，让终端里敲 `java` 也走 shim

    （app 内部用绝对路径，不受影响）；

  - **shim 版本戳**（`usr/lib/.libdshexecfix.stamp`）：shim 编在 rootfs 里跨升级

    保留，版本号变了就删旧重编，避免复用坏 .so。

- **诊断能力**：新增「执行内存探针」（python3 + ctypes，经与 JVM 同一条 proot 管线

  执行，同 seccomp/SELinux 上下文），JVM 确定性失败时自动给出判决——只禁 mprotect

  翻转（OEM W^X）/ 可执行内存整体禁掉 / 执行内存没问题（另有原因）；结果按实例

  缓存，并随 build 失败文案一起回给用户，不再让人猜。



### 自动交付不再把工程内资源当交付物



- **现象**：用 app_new 建 Android 工程后，弹出一张「5 个 png」的交付卡（`auto:true`），

  内容是脚手架自动生成的 `res/mipmap-*` 各密度 `ic_launcher.png`——用户并没有要求

  交付这些东西，看起来像 agent 交付错了。

- **机制**：本轮没有任何显式 `present` 时，平台会按扩展名扫工作区本轮新写的文件做

  兜底交付（照顾小参数模型忘记 present），工程资源因此被误捞。

- **修法**：新增「工程内文件」判定——文件祖先目录里出现项目清单

  （`AndroidManifest.xml` / `build.gradle(.kts)` / `package.json` / `Cargo.toml` /

  `pom.xml` / `go.mod` / `pyproject.toml` / `Makefile` …）即视为工程源/资源，排除出

  兜底扫描。显式 `present` 完全不受影响。



### 测试



- 单测 410 → **432** 全绿（探针解析/判词、execfix 源码完整性、零 include 断言、

  禁止 errno 硬编码断言、工程内文件判定）。



---



## 0.2.1-rc.116（versionCode 115）· 2026-10-27



### 英语界面残留中文补齐（i18n 全量修复）



- **现象**：设置切到 English 后，设置面板的按钮、说明文字与首页 chrome 仍有

  大量中文残留——静态 index.html 的分组标题、面板内动态生成的按钮行、

  占位符（placeholder）与无障碍标签（aria-label）各漏一片。

- **字典补齐**：翻译字典新增约 230 条，覆盖 17 个设置面板、插件清单与

  index.html 静态分组；新增 `I18N_RX` 正则处理动态组合文案

  （「N 条」「X 并行 · 深度 Y」「自动 · N%」「本地 · 模型名」等），

  多行段落按空白折叠匹配。

- **观测补全**：MutationObserver 扩展到 `characterData` 与 `attributes`——

  之前只盯节点增删，纯文本改动与属性改动永远漏翻。属性翻译用 attrStore 记

  「原始值 + 上次写出值」双值缓存，防止动态回写把译文顶回中文。

- **验收**：CDP 实测逐面板扫描（文本节点 + placeholder + aria-label），

  英语模式下残留 0 条；单测 403 → **410** 全绿。



---



## 0.2.1-rc.115（versionCode 114）· 2026-10-27



> 注：本版合并了原 rc.114 的全部修复。对 PaX 的判断在 rc.115 内被进一步修正——

> 真机上是内核 W^X 策略的**确定性拒绝**，setarch 补丁保留为抖动成分的防御层。



### PaX W^X 拒绝根治（paxctl 豁免补丁 + setarch 双层防御）



- **根因修正**：部分机型的 app_build 守护进程报「连续 5 次同一拒绝

  （Failed to mark memory page as executable）」——这是内核 grsecurity/PaX 的

  MPROTECT（W^X）策略**确定性拒绝**：普通进程不允许把「先写后执行」的内存页改成

  可执行，JVM 初始化必经的 `mprotect(PROT_EXEC)` 被内核直接拒绝。proot 只拦

  syscall、`setarch -R` 只去随机化，都动不了内核策略。

- **根治：paxctl 豁免补丁**（`paxctl -c -m -r` 的等价 ELF64 实现，位运算逐位对齐

  paxctl 0.9）：给 JVM 启动器的 `PT_PAX_FLAGS` 段清除 MPROTECT / RANDMMAP 限制

  （二进制没有该段时由 `PT_GNU_STACK` 转换而来）——这是 Debian 时代在 grsec 内核上

  跑 OpenJDK 的同一官方做法。启动器文件在我们自己的 rootfs 里，宿主进程可直接改写，

  **无需 root**。rootfs 就绪时自动幂等应用，headless JDK 全部 6 个启动器覆盖；

  app_build 守护进程、编译、终端裸 java 全走补丁后的启动器。

- **setarch 增量补丁（抖动成分）**：proot 转译下 `mprotect(PROT_EXEC)` 在地址

  随机化下仍会间歇性失败（模拟器 A/B 实证：无 -R 时 8/10 过、加 -R 后 10/10），

  消除 ASLR 布局竞态。把 util-linux setarch（约 19KB，musl 动态链接）做成 rootfs

  增量补丁（jniLibs `libdshsetarch.so`，按 ABI 双份，与 git 补丁同一套幂等解包

  机制）。镜像自带的 setarch 是 busybox 链接而 busybox 未编译该 applet（实测

  "setarch: applet not found"）。接入点：`openGuest` / `guestExec` / `exec` 的

  JVM 入口统一加 `-R` 前缀。补丁安全性已验证：位级单测 7 例 + 补丁后真二进制在

  proot 下 10/10 正常启动。

- **若补丁后仍报同样错误**：说明该内核是 grsec **硬模式**（不读 PT_PAX_FLAGS，

  按文件豁免被忽略），用户态无解——只能 root 豁免或换非 PaX 内核。

  错误指引文案已同步更新，会把这一点直接说明给模型与用户。



### 对话流滚动定位三处修复



- 新增 `pinBottom()`：逐帧校验直到贴底稳住，扛住页面切换动画 / 键盘 / 图片晚加载

  导致的「写入时刻 scrollHeight 已过时」。

- 发送消息强制回底：跟随标记在重建前置位——此前可能为 false，重建走「还原 prevTop」

  分支把视口拉回历史位置，即「一发消息就跳回历史」。

- 重进 / 切换会话统一走 `pinBottom(1200)`：进入对话页直接停在最新消息处。



### 完全访问立即生效 + 授权档位真实化



- 权限档位热更新：设置页改动即时下发运行中的轮次，门禁每批读 live 值，不再等下一轮；

  完全访问下危险操作确认直接跳过。

- 「始终允许」改为真实档位（once / always / deny）：always 记会话级授权，同会话同名

  工具不再重复弹框——此前「始终允许」只回传布尔，与允许一次完全等价。

- 终止对话后未决授权框立即结算：按钮隐藏 + 「已终止 · 本次确认无效」，点击侧也拦截

  已结束轮次的确认。



### phone_list_apps 只返回自身包名



- 真因是 Android 11+ 包可见性过滤（manifest 缺 `QUERY_ALL_PACKAGES`，

  `getInstalledApplications` 只剩自己），不是 proot——PhoneControlService 跑在宿主

  AccessibilityService 里从未进过沙箱。补权限后恢复正常。



---



## 0.2.1-rc.113（versionCode 112）· 2026-10-26



本版修复五类问题，全部附实测。签名体系有**一次不兼容变更**，见最后一条。



### 签名根除 keytool / PaX 拦截（速度 + 可靠性）



- 旧链路：签名用 rootfs 里的 keytool 起一个 guest JVM——而 proot 下 JVM 启动的

  `mprotect(PROT_EXEC)` 会被 PaX 风格 W^X 策略**随机拦截**（实测失败率 20~35%；

  `-Xint` 也躲不掉，解释器启动同样要生成 stub 代码），只能靠 5 次重试撞运气。

- 新链路：生成 RSA-2048 密钥对与自签 X.509 证书是纯密码学操作，改在**宿主进程内**

  用系统 JCA 直接完成（手写 DER 编码，X.509 v1 最短编码 + PKCS#8），

  `apksigner sign --key/--cert` 原生支持这对参数，keystore 与口令全部省掉。

- 实测：签名段 15s → **1.4s**、零失败；证书主体仍为 `CN=DeepSeek Harness Mobile`；

  二次构建全程 2.2s。

- **不兼容变更**：密钥文件从 `.dsh-keys/release.keystore` 改为

  `.dsh-keys/signing.pkcs8.der` + `signing.cert.der`。升级后首次构建会生成新密钥——

  **用它打出的包无法覆盖安装 rc.112 及更早版本用旧密钥签的应用**（签名不同），

  卸载重装即可。新密钥一旦生成，请继续保留 `.dsh-keys/` 目录（删掉就无法覆盖升级）。



### 语音消息被静默丢弃



- 现象：对 agent 发语音经常「一直不回复」，打字就秒回。

- 根因：识别完成后的自动发送会撞上「上一轮还在生成」——文字发送的按钮专门处理了

  这种情况（排队），语音这条入口却什么都没做，消息无声消失。

- 修复：语音与按钮同款——忙碌时入队并提示「这句话已排队」。



### 退出对话页再进入，流式输出卡住



- 根因：WebView 渲染进程在内存压力下被系统回收后会自动重载；内核轮次在原生侧

  继续跑，但新页面已丢失轮次 id，后续事件全部被丢弃——回复凭空消失。

- 修复：页面就绪时向原生查询正在运行的轮次并自动重新接入（toast「已重新接入」），

  之后的流式内容继续渲染；重进同一会话时立即全量重绘一次，头一秒不再空白。



### 发送新消息后视口跳到历史对话



- 根因一：重建对话流的中间帧滚动高度塌陷，浏览器把滚动位置钳到顶部；

- 根因二：用户正在读历史（非跟随态）时，发送后的贴底被直接跳过。

- 修复：重建**同帧**写死贴底（非跟随态恢复原位置）；发送一律强制贴底。



### 界面切换视觉卡顿



- 切换的 200~360ms 里，进出两屏互为背景重绘，且层内 10 处毛玻璃（backdrop-filter）

  逐帧重新采样。修复：动画期把两屏提升为合成层并暂停玻璃模糊（结束即恢复），

  会话列表的整表重建挪出动画首帧。



### 其他



- 单测 395 → **403**；端到端验证改用本地模型（llama.cpp + MiniCPM 1B），

  不再依赖不稳定的第三方中继。



---





## 0.2.1-rc.112（versionCode 111）· 2026-10-26



本轮按「8 分以下逐域找根因」推进，六维全局 **7.4 → 7.8**。功能只增不减。



### 终端与代码执行 7.0 → 8.6



- 会话后端从只有安卓宿主 shell 换成可注入双后端：`workspace`（rootfs 完整环境，

  java / python3 / gcc / node / keytool / **git** 都可用）与 `device`（安卓宿主 shell，

  可访问 /sdcard、pm、am）。

- 命令结束判定从「输出静默 700ms 猜一次」换成 **shell 自己打印的结束标记**：

  - 一条 `which` 命令 **1092ms → 269ms**（不再固定等静默窗口）；

  - `sleep 3 && echo done` 从「提前报已结束、返回空输出」变成等到真实输出；

  - 首次回传 `exit_code`，失败不再与成功长得一样。

- 修掉 rootfs 里 `/bin/sh -> /bin/busybox` 绝对符号链接被误判为「运行环境缺失」的问题；

  proot 下 JVM 启动抖动按严格判据自动重试一次。



### 造 App 8.3 → 8.5



- 产物签名从公共 debug 密钥（密码固定 `android`，任何人可伪造、商店拒收）改为

  **首次构建自动生成专属 RSA-2048 密钥**（有效期 100 年，口令随机、仅本应用可读）。

  同一密钥才能覆盖升级，密钥文件 `.dsh-keys/` 勿删。



### 手机操控 7.3 → 7.8



- 修掉元素选择不去重导致 `ordinal` 数错、**点到隔壁元素**的真 bug。

- 找不到元素时不再无条件重试 6×250ms（界面已静默即停），最坏 1.6s → 约 0.25s。

- 四条匹配优先级（可见优先 / 自身文本优先于聚合标签 / 树序即 ordinal / 空查询不命中）

  抽成纯函数并以 11 个用例锁住。



### 文件制作与交付 7.3 → 7.6



- docx 解析去正则化：每行 6 个 `Regex.matches` 改为首字符分派，

  同机新旧对照 **1674 段 26ms → 10ms**；新增量级回归门禁。



### 媒体与设备能力 7.0 → 7.5



- 该域首个测试文件（12 例）；名字清洗从 5 处两套规则收敛为一处，

  补上路径段长度上限（Android 单段 255 字节）与全非法字符回退默认名。



### 桌面兼容与插件自造 6.5 → 7.2



- `plugin_market` 从「配置了就报『暂未实现』」变成按桌面 format 1 协议真实现：

  索引校验（违规报 JSON 路径）、关键词检索、分页、npm/git 两种 install spec。

- rootfs 增量补 **git 2.47.3**（按 ABI 4MB，首次需要时自动解包进运行环境）。

- `create_worktree` 重写：旧实现在宿主进程直接执行 git（必然失败），改为走 rootfs，

  **首次真正跑通**；终端里 `git config/init/commit/log` 全链可用。



### 其它



- 流式输出合批统一为单一实现（40ms 固定节拍 + 64 字阈值，三条流式链路共用），

  前端绘制改为按帧（rAF）+ 超时兜底。

- 会话列表工作区分组展开 / 回收不再闪白。

- 内置插件按能力域分为五个子包（fs / doc / device / agent / app），新增架构文档。

- 单元测试 **327 → 395**，全部通过。



---



## 0.2.1-rc.111（versionCode 110）· 2026-10-26



本轮把「手机上造一个 App」从演示推到可用，并把构建耗时压掉一个量级。全局六维 7.3 → 7.4。



- **造 App 三段闭环**：`app_new` 生成可编译工程（清单 + 文案 + 五档图标 + 1–3 页 Activity，

  图标由自研 PNG 编码器按主色现画，零素材）→ `app_build` 手机内完整打包

  （aapt2 compile/link → ecj → d8 → 注入 dex → apksigner）→ `app_install` 交给系统安装器。

  唯一的人工闸门是系统安装弹窗。

- **构建提速（实测）**：同一工程连续构建 12.3~13.9s → **2.1~2.6s**。根因是 ecj / d8 /

  apksigner 各自把类加载一遍再被 proot 放大；解法对齐桌面（进程跨调用存活）：

  一个常驻 JVM 守护进程，四阶段同进程执行，空闲 120s 自动回收（实测内存全额归还）。

- **ABI 拆包**：单包通用版 345.9MB 里有 110MB 是「另一台设备的运行环境」；

  拆分后按架构出包，每台设备只下自己那份（arm64 222.3MB）。

- **工具行回归桌面式渲染**：轮末过程折叠时工具调用不再消失，也不会变成卡片 ——

  一行一次调用（图标 + 标题 + 摘要 + 耗时），点开才看参数与输出。

- **插件按域模块化**：34 个文件平铺改为 fs / doc / device / agent / app 五个域子包，

  与桌面 `packages/` 的能力域同名同义；新增 `ARCHITECTURE.md`。

- **工具目录补登记**：`app_new` / `app_build` / `app_install` 此前从未进入工具目录

  （落在 fallback 里），补齐后工具数 151 → **154**；六维评分新增「造 App」域 8.3

  （9 域均值 7.4；同口径 8 域仍 7.3）。

- 验收脚本：构建分段耗时、流式三串时间戳（delta/上屏/帧率）、造 App 全链路等。

