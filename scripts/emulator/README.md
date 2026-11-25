# 模拟器动态回归（对话流 / 电脑会话）

这里是**要连模拟器跑**的回归脚本；纯静态断言在 `../regress/*.test.mjs`（已接进 static gate）。
一次性探针不要放进来 —— 见 `docs` 之外的项目约定。

## 本地模型：`anchor_local.py` + `mock_anchor.py`

```bash
cd dsh-mobile
python scripts/emulator/mock_anchor.py 8899          # 一个终端：mock 模型
adb reverse tcp:8899 tcp:8899                        # 模拟器也能到 127.0.0.1:8899
python scripts/emulator/anchor_local.py scroll       # 交付卡那一轮：不甩底、不回退
python scripts/emulator/anchor_local.py sealed       # 回合开始前已在流的节点：0 重写
python scripts/emulator/anchor_local.py rect         # 按矩形量用户看到的距底（不信 scrollTop）
python scripts/emulator/anchor_local.py tail         # 思考行钉尾：组头/组内行/收起后都跟到最新
python scripts/emulator/anchor_local.py resume       # 流式途中重载：只补没见过的尾巴，落库=页面
python scripts/emulator/anchor_local.py kill         # 回合中被杀进程：回来补「这一轮没跑完」
python scripts/emulator/anchor_local.py stop         # 正对照：自己停掉/切走 → 必须没有那行标记
python scripts/emulator/anchor_local.py tools        # 工具行：跑动中有实时输出 + 中途重载不丢行 + 轮末收口
python scripts/emulator/anchor_local.py team         # 团队端到端：两人团队调工具→汇报→合成交付；中途进成员视图返回、杀进程重开
```

`mock_anchor.py` 两种回合：普通提问回一大段正文（把对话撑到好几屏）；提问里带「交付」
会依次 `write` → `present` → 收尾正文，用来复现「交付卡插在流中间」。
其余按触发词分档：「慢慢写」27 秒长流（重载认领）、「慢慢想」80 段思考（思考行钉尾）、
「宽思考」思考正文里混代码块 / 长链接 / 行内代码 / 表格 / 超长无空格串（横向截断取证）、
「断行思考」每段以空行收尾的真实推理形态（折叠那一行被清空的取证）、
「组内再想」组展开着看：思考 → 工具 → 又一段思考落进同一个组、
「列目录」list_dir 传相对路径 `.`（工具行只剩一个蓝点的取证）、
「组建团队」+「MOCKMATE」团队端到端、「TEAMDEMO」Lead 一次派 alpha/beta 两名队友各自调工具写文件、
汇报后 Lead 合成 summary 并 present（`team` 子命令用它）、「MOCKNULLNAME」工具名被 JSON `null` 覆盖、
「慢工具」一条逐行打印 25 行的命令 + 12 秒慢正文（工具行实时输出与重载补档的两个时间窗）。

## 电脑会话：`pc_link.py`（真链路，需要桌面 harness 在跑）

```bash
python scripts/emulator/pc_link.py state             # 当前是否在电脑会话
python scripts/emulator/pc_link.py pair              # 用 ~/.dsh/mobile-link.json 现拼配对串去配对
python scripts/emulator/pc_link.py run               # 跑一轮真实电脑回合：封条 0 重写 + 不甩底
python scripts/emulator/pc_link.py image             # 只发一张图：压缩 → 中继 → 电脑事件里出现 image part
python scripts/emulator/pc_link.py card              # 重进会话：交付卡 DOM 顺序 == 线程顺序
```

## 环境

| 变量 | 默认 |
| --- | --- |
| `DSH_ADB` | `D:\1\tools\android-sdk\platform-tools\adb.exe` |
| `DSH_SERIAL` | `emulator-5554` |
| `DSH_CDP_PORT` | `9222` |
| `DSH_PLUGIN_DIR` | `D:\1\dsh-mobile-link` |

APK 默认用 `app/build/outputs/apk/standard/debug/app-standard-x86_64-debug.apk`（debug 包才有 WebView 调试口）。
