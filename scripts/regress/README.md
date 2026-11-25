# 前端回归守卫（scripts/regress）

纯 Node、秒级、**不需要设备也不需要 Gradle**。每个文件对应一个真机上出过的 bug，
断言对象是 `app/src/main/assets/web/` 里的**真实源码片段**（`indexOf` 切出来跑），
不是复制一份逻辑 —— 复制品通过了说明不了线上代码对。

```bash
node scripts/regress/run-all.mjs          # 全部
node scripts/regress/run-all.mjs search   # 按名字过滤
```

惰性接入门禁：`node scripts/gates/run-gates.mjs static` 里的 `web-regress` gate 会跑全量，
CI 的 static lane 因此自动覆盖。

## 用例对照表

| 文件 | 防的是什么 | 出事版本 |
|---|---|---|
| `chat-live-order.test.mjs` | 「深度求索中」等待行钉在回复顶部 / 跑到用户消息上方；PC 会话等待气泡残留在屏 | rc.156、rc.157 |
| `selection-copy.test.mjs` | 长按圈选部分文字却复制了整条消息（甚至整块 .msg 的 textContent）；480ms 自定义面板与系统选择手势打架；execCommand 兜底清掉用户选区 | 2026-11-08 用户实测 |
| `guest-base-env.test.mjs` | guest DNS 注入又被收窄到 `pkg apk` 单分支或挪到解包之前（冷启动首次无 resolv.conf）；`PROOT_LOADER` / `_32` 漏给导致回退 Termux 路径；误删 `-b /dev`；npm 缺失提示把用户指回 `pkg manager=npm` 的自举死循环 | 2026-11-08 环境审查 |
| `proot-loader.test.mjs` | `PROOT_LOADER` 又指回 `filesDir` 的符号链接而不是 `nativeLibraryDir/libdshloader.so` 真实文件 —— 真机上 proot 报 `loader was not found`、guest 里 node/python 全部 exec 失败；`relink` 静默吞异常导致链接永久失效 | 2026-11-09 真机实测 |
| `update-install.test.mjs` | 自升级「下载完装不上」：漏 `canRequestPackageInstalls()` 门禁与设置页引导、门禁失败还把兜底通知清掉；`lastCheck` 内存态导致进程重启后已下载包找不到；`pickAsset` 靠 `contains("complete")` 猜通道挑错包/错 ABI | 2026-11-09 用户反馈 |
| `node-patch.test.mjs` | guest node 又退回 20 或换成 glibc 构建在 musl rootfs 里跑不了；补丁漏挂在某个分支、直接覆盖而非原子替换（失败会让 guest 连 node 都没有）、把官方 tar 自带的 npm 混进来覆盖 libdshnpm.so；真机验收只测 6*7 看不出版本 | 2026-11-09 用户要求升级 |
| `device-tree.test.mjs` | screen_read 又退化成 `elements: []`（活跃根为空就早退 / 只合「同包」窗口 / `isVisibleToUser` 当准入）；resource-id 丢失；`elementSnaps` 映射没人用导致 index 点错控件；缓存与批量 diff 被删 | 2026-11-09 真机实测 |
| `npm-patch.test.mjs` | npm 补丁漏挂在 `prepareProotRootfs` 的某个分支；幂等只看 `/usr/bin/npm` 链接而没看 `npm-cli.js` 本体；解包失败被静默吞掉；生成脚本/载荷校验丢失；真机验收没有 npm 断言 | 2026-11-08 真机实测 |
| `scroll-timeline.test.mjs` | 流式跟手甩底 / 回退；用户上滑被程序拽回；插中间内容把视口甩进历史；「谁滚的」又改回时间窗猜测；对话流滚动条被绕过 `setScrollTop` 直写 | rc.192、rc.194、rc.195、rc.200 |
| `sheet-route.test.mjs` | `#sheet` 上两个监听器认领同一节点 → 一次点击跑两遍；`[data-sess-del]` 抢在确认面板之前直接删；模型选择又用回 `[data-pick]` | rc.138、rc.202 |
| `surface-material.test.mjs` | 排队队列铺不透明卡片、和输入框的玻璃对不上；接缝圆角缺口；has-queue/has-attach 开关丢失；目标胶囊灰填充无描边；计划类卡片铺彩色渐变 | rc.161 及更早 |
| `search-highlight.test.mjs` | 搜索命中带 `<mark>` 黄底；把「已完成，用时」「tokens」等界面文字算进命中；命中整片红；「本轮用量」浮窗关闭后屏底露顶边 | rc.159、rc.160、rc.161 |
| `session-bucket.test.mjs` | 会话流串号（点 A 看到 B）、落盘写错槽位、LRU 把正在跑的会话淘汰掉 | rc.134 |
| `preview-bridge.test.mjs` | xlsx 表名裸拼 innerHTML；预览 iframe 脚本能拿 DSHNative*；宿主导航前缀比对；`javascript:` 链接在应用 origin 执行 | 2026-10-31 审查 |
| `pc-session-state.test.mjs` | 系统返回键离开电脑会话不 stopPoll/leave；排队消息被发进电脑会话；迟到轮询响应污染新会话 cursor | 2026-10-31 审查 |
| `quick-actions-flicker.test.mjs` | 快捷操作浮窗切换权限/预设/计划模式时整块 openSheet 重画，触发 120ms 淡入，整个面板闪一下 | 2026-10-31 反馈 |
| `background-wake.test.mjs` | 后台任务完成只弹 UI 通知、不进 agent 上下文；空闲会话等不到结果；`job_output(wait)` 与完成通知重复 | 2026-10-31 反馈 |
| `input-longpress-voice.test.mjs` | 输入框有草稿时长按被原生选择抢走、语音输入起不来；识别结果覆盖草稿 | 2026-10-31 反馈 |
| `harness-hardening.test.mjs` | 八个可靠性/安全洞的接线被拆：取消长等待、团队竞态、iframe 桥、备份凭据、CI 门禁、状态归属、后台化、内核记忆入 prompt | 2026-10-31 复审 |

## 加新用例的规矩

1. **一条 bug 一个文件**，文件名用「领域 - 症状」的英文短名，`.test.mjs` 结尾；
2. 只断言源码里**真实存在**的结构（用 `indexOf` 切片段），不要复制业务逻辑；
3. 文件头注释写清：防的是什么 bug、哪个版本出的事、修法关键点；
4. 断言失败信息要直接说「会复发什么」，不要只说 `expected true`；
5. 失败的用例**不许 skip**：要么修代码，要么删用例并在 README 写明为什么不再需要。
