# rc.114 / rc.115 修复清单（附实测）

- rc.114：滚动定位 + 授权档位 + PaX 抖动层防御（setarch）
- rc.115：PaX W^X 确定性拒绝根治（paxctl 豁免补丁）

版本：0.2.1-rc.114（versionCode 113）、0.2.1-rc.115（versionCode 114）· 2026-10-27

---

## PaX / W^X 内核兼容（rc.114 + rc.115，两层防御）

**现象**：部分机型的 app_build 守护进程反复报
`Error occurred during initialization of VM / Failed to mark memory page as executable - check if grsecurity/PaX is enabled`。

**两层根因、两层解法**：

| 层 | 现象 | 机制 | 解法（实测） |
|---|---|---|---|
| 抖动层（rc.114） | 间歇失败（~20–35%） | proot 转译下 `mprotect(PROT_EXEC)` 在地址随机化下间歇失败 | `setarch -R`（ADDR_NO_RANDOMIZE）禁随机化。模拟器 A/B：无 -R 8/10 过 → 加 -R **10/10** |
| 策略层（rc.115） | **连续多次同一拒绝**（确定性） | 内核 grsecurity/PaX MPROTECT（W^X）：普通进程不允许把「先写后执行」的页改成可执行，JVM 初始化必经 `mprotect(PROT_EXEC)` 被内核直接拒绝 | **paxctl 豁免**：给 JVM 启动器 ELF 的 `PT_PAX_FLAGS` 段清除 MPROTECT/RANDMMAP（无段时由 `PT_GNU_STACK` 转换），与 Debian 在 grsec 内核跑 OpenJDK 的官方做法同源 |

**rc.115 关键点**：

- paxctl 语义逐位对齐 paxctl 0.9 源码（`paxctl.h` 权威位定义 + `paxctl-elf.c` 转换逻辑）；
- 启动器在我们自己的 rootfs 里，宿主进程直接改写 ELF 头，**无需 root**；
- rootfs 就绪时自动幂等应用，headless JDK 全部 6 个启动器覆盖；app_build 守护进程、
  编译、终端裸 java 全走补丁后的启动器；
- 补丁安全性：位级单测 7 例 + 补丁后真二进制在 proot 下 10/10 正常启动；
- 若补丁后仍报同样错误 → 内核是 grsec **硬模式**（不读 PT_PAX_FLAGS），用户态无解，
  需 root 豁免或换非 PaX 内核（错误指引文案已同步）。

**前置修复（rc.113）**：签名链路的 keytool 不再起 guest JVM——密钥生成与自签证书改在
宿主进程内用 JCA 完成（手写 DER：X.509 v1 + PKCS#8），签名段 15s → 1.4s、零失败。

## 对话流滚动定位（rc.114）

- **发送后跳回历史**：跟随标记在对话流重建前置位（此前可能为 false，重建走
  「还原 prevTop」分支把视口拉回历史位置）；发送一律强制贴底。
- **重进 / 切换会话不在底部**：新增 `pinBottom()` 逐帧校验直到贴底稳住，扛住页面切换
  动画 / 键盘 / 图片晚加载导致的「写入时刻 scrollHeight 已过时」。
- 重进对话页直接停在最新消息处。

## 授权与权限（rc.114）

- **完全访问立即生效**：权限档位热更新，设置页改动即时下发运行中的轮次（门禁每批读
  live 值）；完全访问下危险操作确认直接跳过。
- **「始终允许」真实化**：once / always / deny 三档，always 记会话级授权，同会话同名
  工具不再重复弹框（此前与「允许一次」完全等价）。
- **终止后授权框禁点**：终止对话时未决授权框立即结算（按钮隐藏 + 「已终止 · 本次确认
  无效」），点击侧也拦截已结束轮次的确认。

## phone_list_apps 只返回自身包名（rc.114）

真因是 **Android 11+ 包可见性过滤**：manifest 缺 `QUERY_ALL_PACKAGES` 时
`getInstalledApplications` 只看得见自己——不是 proot（PhoneControlService 跑在宿主
AccessibilityService 里，从未进过沙箱）。补权限后恢复正常。

---

单测规模：403（rc.113）→ **410**（rc.115 全绿）。
