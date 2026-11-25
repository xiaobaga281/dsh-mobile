# Mission Ledger · 账本模型、状态机、唤醒策略、证据

> 代码：`app/src/main/java/ai/deepseek/harness/mobile/kernel/mission/`
> 版本：rc.184（Ledger v1）· rc.186（Wake Router）· rc.187（信任与证据）· rc.188（工作站底座）· rc.189（团队合流）· rc.190（跨网连接）
> 这份文档回答一件事：**一件异步的事，在这台手机上以什么形式存在、怎么被叫回来、怎么被回看。**

## 1. 为什么要有它

聊天里的一句「我帮你跑一下」不是一个可交付的工作：它没有状态、不会被唤醒、断了就没了。
把异步工作变成有实体的东西，就必须回答四个问题，而这四个问题只能有一个答案来源：

| 问题 | 答案在 |
|---|---|
| 这件事现在怎么样？ | Mission 的 `state` / `outcome` |
| 它是怎么来的？ | `origin`（触发类型、轮次、工具调用、参数） |
| 做完要不要打扰我？ | `wakePolicy` |
| 它到底做了什么？ | `evidence[]`（引用，正文现取） |

**不变量**：状态只在账本里；前端不自己推导状态，也不各自维护通知队列。任何异步事件要么变成一次状态迁移，要么显式进唤醒队列 —— 不允许「系统里有、界面没有」。

## 2. 数据模型

一条 Mission（`MissionRegistry` 落盘为单一 JSON 快照，tmp + rename 原子替换）：

```
id, kind(job|schedule|team|pc), sourceId, sessionId
title, state, outcome, origin{}, wakePolicy, permissionScope{}, evidence[]
createdAt, updatedAt, startedAt, endedAt, nextAt, dedupeKey
```

- `kind` 决定正文从哪来：job 找 `JobRegistry`、schedule 找投递记录、team 找任务板与成员汇报、pc 找电脑会话。
- `sourceId` 指向真实执行体；`id` 是账本自己的主键（`job:$sourceId`、`sched:$sourceId:$fireAt`、`team:$taskId:$state`）。
- `origin` 记「怎么来的」。后台任务的 `origin.spec` 留下当时的命令与工作目录 —— 没有它就没有「重新跑一次」，**不凭标题猜命令**。

### 状态机

```
queued ──▶ running ──▶ waiting ──▶ settled
              │                      ▲
              └──────────────────────┘
```

| state | 含义 |
|---|---|
| `queued` | 已记账，还没开跑 |
| `running` | 正在跑 |
| `waiting` | 被闸门挡住：等权限、等用户回话 |
| `settled` | 结束了，`outcome` 说明怎么结束的 |

`outcome` ∈ `done` / `failed` / `cancelled` / `interrupted`。

**`interrupted` 是诚实位**：进程死亡恢复时，账本里 `running` 但没有对应执行体的，一律标 `interrupted`（`outcome=interrupted`），不假装还在跑。界面因此不会留下「进行中」的假象 —— 拔网、杀进程、换网之后，看到的必须是「被打断」。

## 3. 唤醒策略（Wake Router）

策略声明在 Mission 上，路由在 `WakeRouter`：

| 策略 | 行为 | 用在 |
|---|---|---|
| `idle-auto` | 当前会话且空闲 → 直接发起一轮 | 用户正看着这一场 |
| `queue` | 进持久队列，回到会话 / pre-step 时补 | 会话忙、或不是当前会话 |
| `notify` | 系统通知 + 持久记录 | WebView 不在，**或 App 在后台但进程还活着** |
| `defer` | 不自动，只记账 | 远期定时、用户明确不要打扰 |

判定「要不要发系统通知」不能只看 `eventSink == null`：退到后台时 WebView 与 sink 都还在，事件发得出去但没人看。所以条件是 `eventSink == null || !RunService.isAppVisible()` —— 前后台那一份状态由 Activity 的 `onStart/onPause` 维护，内核不再造第二个事实源。

三条硬规则，各有回归守卫：

1. **恰好一次**：去重键 = `missionId + transition`。同一件事重启后补唤醒，只补一轮。
2. **不丢**：唤醒记录持久落盘（`WakeStore`），杀进程重开仍能消费；`MAX_CONSUMED = 100` 只裁剪已消费的。
3. **不无限重试**：补的那一轮失败时回滚重投，`MAX_ATTEMPTS = 3` 之后停下来明说，不静默吃掉。

## 4. 权限与证据

- `permissionScope.mode` ∈ `inherit` / `readonly` / `ask` / `default` / `full`；**只能收窄，不能扩权**（`effectivePermission(session, mission)`）。
- 审批作用域到「这一件事」：批准一次危险操作只对该 Mission 生效，不泄漏到同会话的下一件事。
- `evidence[]` 是追加式的：`{type, ref, title, at}`，类型有 `job-output` / `schedule-delivery` / `deliverable` / `tool-log` / `approval` / `wake` / `rerun` / `team-report`。
- **只存引用，正文现取**（`MissionEvidence.view/detail/markdown`）。任务输出被轮换掉、成员会话已经不在了，就照实说「取不到正文」，不造一份看起来完整的假证据。
- 抽屉可导出 JSON / Markdown 到工作区 `.dsh/missions/`。

## 5. 落点与体积上限（工作站底座）

所有可再生与不可再生的数据都在模型可读的工作区里，一处看全（设置 → 本地数据）：

| 存的是什么 | 位置 | 上限 |
|---|---|---|
| 溢出缓存（工具输出超长部分） | 工作区 `.dsh/spill` | `SpillPolicy.MAX_BYTES = 64MB`，超出按龄淘汰 |
| Mission 账本 | `kernel/missions.json` | `MAX_SETTLED = 200` 条已结算；每条 `MAX_EVIDENCE = 12` 项 |
| 唤醒记录 | `kernel/wakes.json` | 已消费 `MAX_CONSUMED = 100` |
| 后台任务 | 每 owner `MAX_JOBS_PER_OWNER = 10` | 单次等待上限 10 分钟 |
| 会话日志 | `kernel/sessions/` | 500MB 起提示（只提示，不自动删） |
| Mission 导出 | 工作区 `.dsh/missions/` | 用户主动导出，不自动清理 |

`StorageAudit.stat()` 是这份表的唯一来源；**只有可再生的溢出缓存能一键清**，其它项一律不假装能安全删除。

## 6. 连电脑（跨网）在账本里的位置

电脑上的会话是同一个账本里 `kind=pc` 的一条，来源标签老实写出走的是哪条路：
`电脑（局域网）` / `电脑（中继）` / `电脑（隧道）` / `电脑（直连）`。
传输细节与信任边界在 `docs/` 之外的 `dsh-mobile-link/README.md`；这里只强调一点：**断连时正文取不到就说取不到**，pc 类 Mission 不因连接丢失而改变本地账本已经记录的事实。

## 7. 前端只是投影

- 对话里的 Mission 卡、顶部「进行中」带、任务页列表，全部读同一份 `missionList`。
- 卡片只更新自己的节点，不整表重建（重绘抖动曾让玻璃背景肉眼可见地闪）。
- 远期定时任务不进「进行中」；未连接就显示「未连接」，不显示「等待电脑」。
