# dsh-mobile-link

用三行字，把手机接到 DeepSeek Harness 桌面端：手机可以看电脑上的会话、接着往下聊，**不在同一局域网也能用**。

- 桌面面板显示中继地址、房间号、中继口令，手机端「设置 → 连接宿主机」里填进去即绑定——没有二维码，也没有会过期的配对码。
- 手机读的是电脑上真实的会话（同一个 session，不是镜像副本），发出去的消息进入桌面端 agent 的收件箱。
- 两端都只做出站连接，所以 NAT、公司网络、手机流量下都能连，**不需要公网 IP，也不需要端口映射**。
- 中继只转发不透明的请求/响应，看不到你在聊什么（自托管时连元数据都在自己手里）。

## 组成

```
桌面端插件（index.js + client.js）─── 出站长轮询 ───┐
                                                  ├── relay/server.mjs（你部署的，或公共的）
手机端 App（手填地址 + HTTP）────── 出站请求 ────┘
```

三段都可替换：中继可以自托管在任意 VPS、Docker、群晖、树莓派上。

## 一、中继（默认不用部署）

中继是唯一需要「两端都能访问」的东西，它不存任何数据。有两条路：

**默认：桌面端自己起一个。**「中继地址」留空即可——插件会在桌面端进程内启动中继，监听本机 8787（被占用时自动换空闲端口），并把**当前网卡地址**显示在面板上。地址在每次启动时重新探测，换了 Wi-Fi、DHCP 续了新 IP 都不会留下一个打不开的地址。手机与电脑在同一局域网时，照面板填一次即连，零部署。

**跨网络：自己部署一个。** 手机走流量、或两端不在同一网段时，才需要下面这种方式，填到面板的「中继地址」里（或 `DSH_MOBILE_LINK_RELAY`）。

### 方式 A：Docker

```bash
docker build -t dsh-mobile-link-relay .
docker run -d --restart unless-stopped -p 8787:8787 --name dsh-link-relay dsh-mobile-link-relay
```

### 方式 B：直接跑（Node 20+，零依赖）

```bash
node relay/server.mjs --port 8787 --host 0.0.0.0
```

### 方式 C：HTTPS（推荐，手机端从公网连时必须）

Caddy 一行搞定自动证书：

```
link.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

> Android 9 起默认禁止明文 HTTP。若手机 App 的 `usesCleartextTraffic` 未开启，公网必须用 `https://`；局域网内 `http://` 可用。

自检：`curl https://link.example.com/health` 返回 `{"ok":true,...}` 即可。

> 已填的地址连不上、且是内网/本机地址时，启动会自动改用本机中继，并在面板上说明换过地址；填的是公网地址则只报错不改写，因为那属于运营方的问题。

## 二、安装桌面端插件

插件是一个标准 DSH 插件包（`package.json` 的 `dsh.bundle.patch` + `dsh.client`），放进任意 profile 都能用。

### 方式 A：官方命令直装（推荐）

`dsh` CLI 的 `plugin` 子命令把安装转发给 profile 内的 pnpm，支持从 GitHub 直装：

```bash
# 从 GitHub 仓库的 desktop-plugin 子目录安装（本插件的发布位置）
dsh plugin --profile <profile名> add "github:xiaobaga281/dsh-mobile#path:desktop-plugin"

# 或从本地目录安装（先 git clone 或下载本目录）
dsh plugin --profile <profile名> add "link:/路径/dsh-mobile-link"
```

安装后重启桌面端，侧边栏会出现「手机联动」。

### 方式 B：放进插件目录（Desktop 桌面客户端）

把本目录复制/链接到 `%USERPROFILE%\.dsh\plugins\dsh-mobile-link`，然后在 profile 的 `package.json`（`~/.dsh/profiles/desktop/package.json`）：

```jsonc
{
  "dependencies": {
    "dsh-mobile-link": "link:C:/Users/you/.dsh/plugins/dsh-mobile-link"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …已有条目…
        "dsh-mobile-link"
      ]
    }
  }
}
```

再让包管理器建好链接（profile 目录下执行）：

```bash
pnpm install
```

重启桌面端。侧边栏会出现「手机联动」。

### 或者手动建链接（不想跑 pnpm 时）

```bash
# profile 目录：~/.dsh/profiles/desktop
ln -s /path/to/dsh-mobile-link node_modules/dsh-mobile-link
```

并在 `bundles` 里加上 `"dsh-mobile-link"`。

### 配置中继地址

三种方式，任选：

- 留空（默认）：桌面端自己起中继，同一局域网照着面板填即可。
- 面板里填：侧边栏「手机联动」→ 底部「中继地址」→ 保存。跨网络时填公网地址。
- 环境变量：启动桌面端前 `export DSH_MOBILE_LINK_RELAY=https://link.example.com`。

## 三、配对（手填三行字）

1. 桌面端侧边栏 →「手机联动」→ 点「启动联动」（默认关闭，状态重启后保留），面板随即显示三行内容：**中继地址 / 房间号 / 中继口令**，每行带「复制」。
2. 手机端 →「设置 → 连接宿主机」→ 把这三项粘进「中继地址 / 房间名 / 中继口令」→ 连接。
3. 连上后面板里会出现这台手机，可随时「移除」；移除后它下次调用直接 401。

这三项都是持久的：重启桌面端、重启 App 都不用重新配对。口令（128 位房间密钥）就是这把锁的钥匙——谁拿到它，谁就能连上这台电脑，所以别截图发群。想让它失效就点面板上的「重置配对」，房间号和口令一起换新。

## 安全模型

| 环节 | 保护 |
|---|---|
| 中继 | 必须出示房间密钥（`x-link-key`），房间号单独泄露无用 |
| 配对 | 手填的房间密钥即凭据，错误密钥返回 `401`；面板可随时重置房间与密钥 |
| 手机调用 | 每次都要配对时下发的设备令牌（`x-device-token`），移除设备即失效 |
| 桌面面板 | 复用 harness 自己的 loopback 围栏，局域网内他人拿不到房间密钥 |
| 权限范围 | 只能：列会话、读历史、发消息、取消当前轮次；不能执行工具、不能读写文件 |

已知边界（有意为之，写清楚比藏起来好）：

- 中继转发的是明文 HTTP 请求体。自托管时没有第三方；用公共中继请确认你信任运营者，或在中继前加 TLS 终止即可保护传输段。
- 桌面端开关机状态会体现在「手机在线 / 离线」上。
- 目前手机端只渲染文本与工具调用摘要，图片/附件、队列编辑、多轮 steer 不在范围内。

## 开发

仓库不含开发测试目录（`.test/` 内含作者本机路径，未随插件分发）。插件本体只用 Node 内置模块，无任何运行时依赖：

```bash
npm run check                       # 三个 JS 文件语法自检
npm run relay                       # 起中继
```
