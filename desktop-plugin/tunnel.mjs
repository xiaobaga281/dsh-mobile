/**
 * 跨网隧道（Cloudflare quick tunnel）接入 —— 让用户不必有公网 IP、不必做端口映射、
 * 不必自己部署中继，也能在外面连上家里的电脑。
 *
 * 原理：本机起一个**只监听 127.0.0.1** 的 RPC 服务，再拉起 `cloudflared` 把它映射成一个
 * 随机公网 HTTPS 地址。手机只需要知道那个地址。cloudflared 与我们之间是它的隧道，
 * 隧道另一头到本机是 loopback；手机与电脑之间再叠一层 e2e.mjs 的端到端加密，
 * 所以 Cloudflare 看到的是「一段 TLS 连接的两侧 + 密文长度」。
 *
 * 诚实的边界：
 *   - quick tunnel 的地址是随机的，**进程重启就会变** —— 面板与手机都要能看出"地址变了，重新配一次"；
 *   - 需要本机装有 cloudflared（我们只探测与拉起，不偷偷下载执行别人的二进制）；
 *   - 它把这台机器的一个接口暴露到公网，所以只暴露 RPC 这一个端口、只接受带正确口令且能解密的请求。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, chmodSync, unlinkSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/** 自动下载失败时才用到的兜底指引（面板原文显示；正常路径不需要用户碰命令行） */
export const INSTALL_HINTS = {
  win32: 'winget install --id Cloudflare.cloudflared  或到 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载 cloudflared.exe',
  darwin: 'brew install cloudflared',
  linux: 'sudo apt install cloudflared（或到 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载对应架构）',
}

/**
 * 下载物与证书都放插件自己目录里：卸载插件 = 一起消失，不在 ~/.dsh 留残留。
 * `DSH_MOBILE_LINK_STORE` 只给测试与便携安装用 —— 不设就是插件目录本身。
 */
const STORE_ROOT = process.env.DSH_MOBILE_LINK_STORE || PLUGIN_ROOT
export const BIN_DIR = join(STORE_ROOT, 'bin')
export const DATA_DIR = join(STORE_ROOT, 'data')

/** 找 cloudflared：环境变量 → 插件自带 bin/ → PATH。找不到就返回 null，让面板说实话。 */
export function locateBinary(env = process.env, platform = process.platform) {
  const exe = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const fromEnv = env.DSH_MOBILE_LINK_CLOUDFLARED
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const bundled = join(BIN_DIR, exe)
  if (existsSync(bundled)) return bundled
  return null
}

/** 官方发布地址（latest 由 Cloudflare 自己维护） */
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'

/**
 * 官方地址在部分网络下不可达（实测 github.com 直接连不上，而 GitHub 的 CDN 是通的）。
 * 这时按顺序换下面这些公开中转 —— 它们只负责「把官方 release 的文件搬运过来」，
 * 拿到的东西仍要过 --version 自检；来源会写进状态，面板上看得见。
 * 想禁用中转：环境变量 DSH_MOBILE_LINK_NO_MIRROR=1。
 */
/** 最近一次下载实际用的地址（面板与诊断用）：空表示还没下载过 */
let lastSource = ''
export function lastDownloadSource() { return lastSource }

const MIRROR_BASES = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
]

/** 按顺序给出候选地址：官方在前，中转在后（可用环境变量关掉中转） */
export function downloadUrls(file, env = process.env) {
  const official = RELEASE_BASE + file
  if (env.DSH_MOBILE_LINK_NO_MIRROR === '1') return [official]
  return [official, ...MIRROR_BASES.map((base) => base + official)]
}

/** 平台 → 发布文件名。macOS 是 tgz，需要解一层包。 */
export function artifactFor(platform = process.platform, arch = process.arch) {
  const arm = arch === 'arm64'
  if (platform === 'win32') return { file: arm ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe', packed: false }
  if (platform === 'darwin') return { file: arm ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz', packed: true }
  return { file: arm ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64', packed: false }
}

/**
 * 找到 cloudflared；没有就**自己下载官方的那一份**。
 *
 * 为什么不要求用户手动安装：跨网这件事对用户的正确预期是「面板上开一个开关」，
 * 让他去 winget/brew 装二进制，等于把功能藏在安装步骤里 —— 大部分人就在这里放弃。
 * 代价是我们替他执行了一次下载，所以边界要写死：
 *   - 只从 RELEASE_BASE 这一个官方地址走 HTTPS 下载；
 *   - 落盘后先 `--version` 跑一次，输出里没有 cloudflared 就当失败删掉（不执行不认识的东西）；
 *   - 落在 `<插件>/bin` 下：卸载插件连带删掉，不需要用户再做清理，也不需要管理员权限。
 */
export async function ensureBinary({ dir = BIN_DIR, platform = process.platform, arch = process.arch, log = () => {}, fetchImpl = fetch } = {}) {
  const found = locateBinary(process.env, platform)
  if (found) return found
  const exe = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const target = join(dir, exe)
  if (existsSync(target) && await looksLikeCloudflared(target)) return target

  const { file, packed } = artifactFor(platform, arch)
  mkdirSync(dir, { recursive: true })
  const candidates = downloadUrls(file)
  log(`tunnel: 本机没有 cloudflared，开始下载 ${file}`)
  let buf = null
  let usedUrl = ''
  for (const url of candidates) {
    const via = url === RELEASE_BASE + file ? '官方' : '中转 ' + url.slice(0, url.indexOf('/https://'))
    try {
      const res = await fetchImpl(url, { redirect: 'follow' })
      if (!res?.ok) {
        log(`tunnel: ${via}下载失败 HTTP ${res?.status}，换下一个`)
        continue
      }
      const candidate = Buffer.from(await res.arrayBuffer())
      // 官方二进制至少十几 MB；几百字节的 HTML 错误页不能当程序用
      if (candidate.length < 4_000_000) {
        log(`tunnel: ${via}内容过小（${candidate.length} 字节），换下一个`)
        continue
      }
      buf = candidate
      usedUrl = url
      log(`tunnel: 下载成功（${via}，${candidate.length} 字节）`)
      break
    } catch (e) {
      log(`tunnel: ${via}下载失败 ${(e && e.message) || e}，换下一个`)
    }
  }
  if (buf === null) {
    log('tunnel: 所有来源都拿不到 cloudflared')
    return null
  }
  lastSource = usedUrl
  const stage = packed ? join(dir, file) : target
  writeFileSync(stage, buf)
  if (packed) {
    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('tar', ['-xzf', stage, '-C', dir, exe])
    } catch (e) {
      log(`tunnel: 解包失败 ${e?.message || e}`)
      return null
    } finally {
      try { unlinkSync(stage) } catch { /* 解包失败也别留半个压缩包 */ }
    }
  }
  if (platform !== 'win32') {
    try { chmodSync(target, 0o755) } catch { /* 有些文件系统不认 exec 位，靠 --version 兜底 */ }
  }
  if (!(await looksLikeCloudflared(target))) {
    log('tunnel: 下载下来的程序不自称 cloudflared，删掉且不执行')
    try { unlinkSync(target) } catch { /* 已经不在就算了 */ }
    return null
  }
  log(`tunnel: cloudflared 就绪 ${target}`)
  return target
}

/**
 * 清掉插件替用户下载/生成的一切：cloudflared 二进制、隧道日志、自签证书。
 *
 * 自动下载等于替用户占了一份磁盘与一份"你机器上有个陌生可执行文件"的事实，
 * 所以卸载/关闭跨网时必须能一句话还原。只动插件自己目录，不碰 ~/.dsh。
 */
export function purgeDownloaded({ dirs = [BIN_DIR, DATA_DIR] } = {}) {
  const removed = []
  for (const d of dirs) {
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      // 只删我们放进去的东西；目录里若有别人的文件不动
      if (!/^(cloudflared.*|tls\.json|tunnel.*\.log)$/i.test(f)) continue
      const full = join(d, f)
      try {
        rmSync(full, { recursive: true, force: true })
        removed.push(full)
      } catch { /* 占用中（Windows 上进程还没退）：留到下次 */ }
    }
  }
  return removed
}

/** 运行一次 `--version`：这是"我确实下载到了它说的东西"最便宜的证据 */
async function looksLikeCloudflared(path) {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 8000 }, (err, stdout) => {
      resolve(!err && /cloudflared/i.test(String(stdout)))
    })
  })
}

/**
 * 隧道生命周期。
 * @param {object} o
 * @param {number} o.port 本地 RPC 端口（隧道指向它）
 * @param {string|null} [o.binary] cloudflared 路径；null 表示没装
 * @param {Function} [o.onState] 状态变化回调（面板刷新用）
 * @param {(string)=>void} [o.log]
 */
export function createTunnel({ port, binary = locateBinary(), onState = () => {}, log = () => {} } = {}) {
  let child = null
  let url = ''
  let state = 'idle'          // idle | starting | ready | stopped | failed
  let detail = ''
  let stopping = false
  let restartTimer = null

  const emit = () => onState(status())

  function status() {
    return {
      state, url, detail, port,
      installed: Boolean(binary),
      installHint: binary ? '' : (INSTALL_HINTS[process.platform] || INSTALL_HINTS.linux),
      // 地址会变这件事必须让用户看得见：面板据此提示"重扫/重填"
      volatile: true,
    }
  }

  function reset(nextState, why) {
    url = ''
    state = nextState
    detail = why || ''
    emit()
  }

  function spawnOnce() {
    if (!binary) {
      reset('failed', '本机没有找到 cloudflared')
      return
    }
    stopping = false
    reset('starting', '')
    try {
      child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      reset('failed', e?.message || '启动失败')
      return
    }
    const onData = (buf) => {
      const text = String(buf)
      const hit = text.match(URL_RE)
      if (hit && hit[0] !== url) {
        url = hit[0].replace(/\/+$/, '')
        state = 'ready'
        detail = ''
        emit()
        log(`tunnel: 公网地址 ${url}`)
      }
      // cloudflared 的日志很啰嗦，只留真正的错误行
      for (const line of text.split('\n')) {
        if (/error|failed|denied|not found/i.test(line) && !/error=none/i.test(line)) log(`tunnel: ${line.trim().slice(0, 200)}`)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => {
      reset('failed', e?.message || 'cloudflared 无法启动')
      child = null
    })
    child.on('exit', (code) => {
      child = null
      if (stopping) { reset('stopped', ''); return }
      // 断线很常见（本地网络抖一下），自动重拉；但地址会变，所以状态里要写清楚
      reset('failed', `cloudflared 退出（code=${code}），3 秒后重试`)
      restartTimer = setTimeout(() => { if (!stopping) spawnOnce() }, 3000)
    })
  }

  return {
    start: spawnOnce,
    status,
    stop() {
      stopping = true
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
      const c = child
      child = null
      if (c) { try { c.kill() } catch { /* 已经退了 */ } }
      reset('stopped', '')
    },
  }
}
