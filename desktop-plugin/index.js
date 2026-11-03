/**
 * Host half of `dsh-mobile-link`.
 *
 * Turns this desktop harness into something a phone can pair with by typing
 * three values (relay / room / key), then read and continue the desktop's own
 * sessions from anywhere.
 *
 * Why a relay instead of "just listen on the LAN": a phone on mobile data and a
 * desktop behind home NAT cannot reach each other, and opening a port is not a
 * thing a person should have to do. Both ends therefore dial OUT to a relay and
 * the desktop answers requests that arrive through it. Nothing here binds a
 * socket, and the relay only forwards opaque request/response pairs.
 *
 * Trust model — two locks, neither of them DSH's own browser cookie:
 *   - a 128-bit room key; the relay refuses any caller that cannot present it,
 *     and the desktop refuses any request without a device token;
 *   - the device token is minted only for someone who presented the room key,
 *     and can be revoked from the panel. The key is shown in the panel and
 *     typed into the phone — there is no QR code and no one-time secret.
 *
 * @module dsh-mobile-link
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, networkInterfaces, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { startRelay } from './relay/server.mjs'
import { startRpc, pairingString } from './rpc.mjs'
import { createTunnel, locateBinary, ensureBinary, purgeDownloaded, DATA_DIR } from './tunnel.mjs'
import { startDirect, loadOrCreateCert, candidateAddresses, urlFor } from './direct.mjs'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))

/** Where the room key, devices and relay choice live between restarts. */
const STATE_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'mobile-link.json')

/**
 * Relay baked into this build, so a fresh install shows an address already
 * filled in and one click on "start" is enough. A packager sets
 * `dsh.mobileLink.defaultRelay` in package.json; `DSH_MOBILE_LINK_RELAY`
 * overrides it for a single machine.
 */
function packagedRelay() {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    const value = pkg?.dsh?.mobileLink?.defaultRelay
    return typeof value === 'string' ? value.replace(/\/+$/, '') : ''
  } catch {
    return ''
  }
}

const DEFAULT_RELAY = (process.env.DSH_MOBILE_LINK_RELAY ?? packagedRelay()).replace(/\/+$/, '')

/** Long-poll window used against the relay; slightly under its own 25 s timeout. */
/** 必须**大于**中继的 25 秒长轮询：小了就会每次都在中继应答前自己超时，
 *  hostSeenAt 永远不更新，面板一直显示「未连接」（实测踩过）。 */
const PULL_TIMEOUT_MS = 30_000
/** History window handed to the phone per read.
 *  手机是聊天视图，看的是尾巴：窗口开得越大，快照越慢 —— 实测 300 条时大会话
 *  20 秒都出不来（中继 30 秒就回 504，手机看到的是「电脑端会话记录没有」）。
 *  80 条足够铺满一屏，更早的留给 hasMore。 */
const HISTORY_LIMIT = 80

/* ---------------- persisted state ---------------- */

/**
 * 墓碑统一成 id → 删除时刻。
 *
 * 旧版本（≤1.3.1）把墓碑写成 id 数组，没有时间。读进来时按 0 处理：0 比任何一次配对都早，
 * 于是「删过但后来重新配上的手机」会正常活着 —— 那正是旧版本亏欠用户的行为，
 * 而不是反过来把人家已经配好的手机再删一次。
 */
function tombstones(raw) {
  // 空原型：设备 id 是手机自己报的（截断到 64 字符），不能让它写进 Object.prototype
  const out = Object.create(null)
  if (Array.isArray(raw)) {
    for (const id of raw) if (typeof id === 'string' && id.length > 0) out[id] = 0
  } else if (raw && typeof raw === 'object') {
    for (const [id, at] of Object.entries(raw)) {
      if (typeof id === 'string' && id.length > 0) out[id] = Number(at) || 0
    }
  }
  return out
}

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return {
      room: typeof raw.room === 'string' && /^[a-f0-9]{16,64}$/.test(raw.room) ? raw.room : randomBytes(12).toString('hex'),
      key: typeof raw.key === 'string' && raw.key.length >= 32 ? raw.key : randomBytes(16).toString('hex'),
      relay: typeof raw.relay === 'string' && raw.relay.length > 0 ? raw.relay : DEFAULT_RELAY,
      // Linking is a deliberate act: a fresh install stays off until the person
      // presses "start", and a restart resumes only what they had already started.
      enabled: raw.enabled === true,
      // 跨网开关是「用户主动打开的一个入口」，重启后保持他上次的选择
      cross: raw.cross && typeof raw.cross === 'object'
        ? { tunnel: raw.cross.tunnel === true, direct: raw.cross.direct === true }
        : { tunnel: false, direct: false },
      // Deletion has to survive the read-merge-write in saveState(): a removed
      // id is a tombstone, and everything paired at or before resetAt is dead.
      // 墓碑带时间：它记的是「什么时候删的」，重新配对记的是「什么时候配的」，
      // 谁晚谁说话 —— 只有 id 一份的话，删过一次就再也配不回来了（踩过）。
      resetAt: Number(raw.resetAt) || 0,
      removed: tombstones(raw.removed),
      // 上次成功拉到的模型目录：落盘是为了「打开选择器秒出」。
      // 每次现问要逐个 provider 走网络，实测冷读 ~30 秒 —— 用户点开面板就像点不动。
      catalog: raw.catalog && typeof raw.catalog === 'object' ? raw.catalog : null,
      // 上次成功起来的隧道地址（地址每次都变，面板与手机都要能看到「现在的」）
      crossTunnelUrl: typeof raw.crossTunnelUrl === 'string' ? raw.crossTunnelUrl : '',
      catalogAt: Number(raw.catalogAt) || 0,
      devices: Array.isArray(raw.devices)
        ? raw.devices
          .filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string')
          .map((d) => ({
            id: d.id,
            name: typeof d.name === 'string' ? d.name : '手机',
            platform: typeof d.platform === 'string' ? d.platform : '',
            tokenHash: d.tokenHash,
            pairedAt: Number(d.pairedAt) || Date.now(),
            lastSeenAt: Number(d.lastSeenAt) || 0,
          }))
        : [],
    }
  } catch {
    return {
      room: randomBytes(12).toString('hex'),
      key: randomBytes(16).toString('hex'),
      relay: DEFAULT_RELAY,
      enabled: false,
      cross: { tunnel: false, direct: false },
      resetAt: 0,
      removed: tombstones([]),
      devices: [],
    }
  }
}

const state = loadState()

/**
 * 写入前先重读合并。
 *
 * 桌面端和 `dsh web` 可以同时开着，两个进程共享这一份文件。各写各的会把对方
 * 刚写入的设备覆盖掉 —— 表现为「手机明明配对成功了，面板里已配对设备还是 0」。
 * 设备按 id 取并集（lastSeenAt 取较新）；房间与口令以自己这份为准 ——
 * 它们决定手机连到哪里，不能被另一个进程改掉。
 *
 * 并集只该让「新增」活下来，不该让「删除」复活：删除记成墓碑（removed：id → 删除时刻），
 * 重置记成 resetAt，两边合并时先按这两条把该没的剔掉，再把并集补上。
 * 否则移除设备/重置配对写完就被磁盘上的旧记录合并回来，面板永远显示那一台。
 *
 * 墓碑必须带时刻，光有 id 不够：那样「先移除、之后重新配对」的那台手机会被合并再剔一次
 * —— 表现为手机上刚显示「已连接」，下一个请求就 401、令牌被清、而且这个设备 id 永远配不回来
 * （1.3.1 及以前踩过）。有了时刻，删除与配对就是同一把尺子上的两个事件，较晚的那个说话。
 */
function saveState() {
  try {
    const disk = loadState()
    if (disk !== null && Array.isArray(disk.devices)) {
      // 墓碑按 id 取「较晚的那次删除」：任一进程删过的时间都算数。
      const removed = Object.assign(Object.create(null), disk.removed)
      for (const [id, at] of Object.entries(state.removed ?? {})) {
        if (!(id in removed) || Number(at) >= Number(removed[id])) removed[id] = Number(at) || 0
      }
      // 重置时间取较晚的：任一进程重置过，早于它的配对都不算数。
      const resetAt = Math.max(Number(state.resetAt) || 0, Number(disk.resetAt) || 0)
      // 删除与重新配对会落在两个进程里，谁的时间晚就听谁的：
      // 墓碑晚于 pairedAt 才算删过，早于它的那次删除已经被后来的重新配对推翻。
      const alive = (item) =>
        item &&
        typeof item.id === 'string' &&
        !(item.id in removed && Number(removed[item.id]) >= (Number(item.pairedAt) || 0)) &&
        !(resetAt > 0 && (Number(item.pairedAt) || 0) <= resetAt)

      const byId = new Map()
      for (const item of disk.devices) if (alive(item)) byId.set(item.id, item)
      for (const item of state.devices) {
        if (!alive(item)) continue
        const prev = byId.get(item.id)
        byId.set(
          item.id,
          prev === undefined
            ? item
            : { ...item, lastSeenAt: Math.max(Number(item.lastSeenAt) || 0, Number(prev.lastSeenAt) || 0) },
        )
      }
      state.devices = [...byId.values()]
      state.removed = removed
      state.resetAt = resetAt
    }
  } catch {
    // 读不到就按自己这份写，总比丢数据好
  }
  // 和**磁盘上那一份**比，而不是和进函数前的内存比：调用方（mintDevice）通常已经先改过
  // state 才进来，比内存等于「什么都没变」——结果刚配对的手机只活在内存里，
  // 电脑一重启手机就「还未配对」，README 里那句「重启两端都不用重新配对」就成了空话。
  const next = JSON.stringify(state, null, 2)
  if (existsSync(STATE_FILE) && runCatchingRead(STATE_FILE) === next) return
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, next, 'utf8')
  } catch {
    // A read-only home directory must not take the panel down; pairing then
    // simply does not survive a restart.
  }
}

function runCatchingRead(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/* ---------------- devices ---------------- */

function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

function sameDigest(a, b) {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Mint (or re-mint) a device token. Shared by scanning and by typing the key. */
function mintDevice(device) {
  const deviceToken = randomBytes(24).toString('hex')
  const record = {
    id: typeof device?.id === 'string' && device.id.length > 0 ? device.id.slice(0, 64) : randomUUID(),
    name: typeof device?.name === 'string' && device.name.trim().length > 0 ? device.name.trim().slice(0, 60) : '手机',
    platform: typeof device?.platform === 'string' ? device.platform.slice(0, 40) : '',
    tokenHash: digest(deviceToken),
    pairedAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  state.devices = [...state.devices.filter((d) => d.id !== record.id), record]
  // 墓碑不用删：它记的是删除时刻，而这次配对的 pairedAt 一定更晚，
  // saveState() 的「较晚事件获胜」已经把它推翻了。
  saveState()
  return { deviceToken, device: publicDevice(record) }
}

function publicDevice(record) {
  return {
    id: record.id,
    name: record.name,
    platform: record.platform,
    pairedAt: record.pairedAt,
    lastSeenAt: record.lastSeenAt,
  }
}

let deviceSeenSavedAt = 0

function deviceForToken(token) {
  if (typeof token !== 'string' || token.length < 32) return null
  const hash = digest(token)
  const record = state.devices.find((d) => sameDigest(d.tokenHash, hash))
  if (record === undefined) return null
  record.lastSeenAt = Date.now()
  // 落盘要节流：手机每发一句话都会走到这里，实时写盘会把磁盘和
  // 另一个进程的写入搅成一团。30 秒一次足够让「手机在线」在重启后还对。
  if (Date.now() - deviceSeenSavedAt > 30_000) {
    deviceSeenSavedAt = Date.now()
    saveState()
  }
  return record
}

/* ---------------- session formatting ---------------- */

/** Pull the first text block out of a message body, whatever else it carries. */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 同一条消息里的思考段（thinking / reasoning），手机端单独折叠显示 */
function reasoningOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    const type = String(block?.type ?? '')
    if (type !== 'thinking' && type !== 'reasoning') continue
    const text = block.text ?? block.thinking ?? block.reasoning
    if (typeof text === 'string' && text.trim().length > 0) parts.push(text)
  }
  return parts.join('\n').trim()
}

/** Titles come from whichever projection the deployment installed; absence is fine. */
/**
 * 会话的模型选择：电脑投影给的是 { lastUsed, next }，下一轮用的是 next。
 * 手机只认扁平的 { provider, model, reasoningEffort }，在这里一次性归好，
 * 免得每个调用点各猜一套形状。
 */
function selectionOf(raw) {
  const pick = (one) => {
    if (!one || typeof one !== 'object') return null
    const provider = typeof one.provider === 'string' ? one.provider : ''
    const model = typeof one.model === 'string' ? one.model : ''
    if (!provider || !model) return null
    return {
      provider,
      model,
      ...(typeof one.reasoningEffort === 'string' && one.reasoningEffort !== ''
        ? { reasoningEffort: one.reasoningEffort }
        : {}),
    }
  }
  if (!raw || typeof raw !== 'object') return null
  return pick(raw.next) ?? pick(raw.lastUsed) ?? pick(raw)
}

/**
 * 上下文占用：电脑端的 contextPressure 投影（投影随快照一起回来，不用另发请求）。
 * 拿不到就返回 null —— 手机那边不显示这一行，而不是画个 0%。
 */
function contextOf(values) {
  const pressure = values?.contextPressure
  const used = Number(pressure?.projectedTokens ?? pressure?.pressureTokens)
  const window = Number(pressure?.contextWindow)
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return null
  return { usedTokens: used, contextWindow: window, percent: Math.min(100, Math.round((used / window) * 100)) }
}

/**
 * 上下文用量明细（系统提示词 / 工具 / 对话）：电脑端点开那个圆环看的就是这份。
 * 拿不到就不显示面板，只留一个百分比。
 */
function breakdownOf(values) {
  const state = values?.contextBreakdown
  const parts = state?.breakdown
  if (!parts) return null
  const systemTokens = Number(parts.systemTokens) || 0
  const toolsTokens = Number(parts.toolsTokens) || 0
  const messageTokens = Number(parts.messageTokens) || 0
  if (systemTokens + toolsTokens + messageTokens <= 0) return null
  return { systemTokens, toolsTokens, messageTokens }
}

/**
 * 投影里没有 contextPressure 时的兜底读法。
 *
 * 有的部署里 controller.projections() / follow 快照只回一份“提示级”投影
 * （标题、模型、运行态），token-meter 的两个键不在其中 —— 电脑端自己的
 * 输入框下面却能看到占用。这时直接问 sessionQuery 要一份完整投影。
 * 结果按会话缓存 30 秒，别让每次轮询都重放一遍日志。
 */
const contextCache = new Map()
async function contextFallback(ctx, sessionId) {
  const cached = contextCache.get(sessionId)
  if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.values
  const query = ctx.get?.('sessionQuery')
  if (query === undefined || typeof query.observeSession !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6_000)
  try {
    const observation = await query.observeSession(sessionId, { signal: controller.signal })
    try {
      const values = observation?.projections?.values ?? null
      if (values !== null) contextCache.set(sessionId, { at: Date.now(), values })
      return values
    } finally {
      observation?.[Symbol.dispose]?.()
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 补齐投影：压力与构成任缺一项就多读一次。
 *
 * 实测这两种键会分开缺席（contextPressure 有、contextBreakdown 没有）：
 * 只按压力判断，浮层里就永远只有一条「没有上报构成」。
 */
/**
 * 最后一条兜底：直接读 harness 自己的投影缓存。
 *
 * 实测有的部署里 follow/projections/observeSession 三条路都只回“提示级”投影，
 * contextBreakdown 不在其中；而桌面 UI 面板里是有的 —— 它读的就是这份缓存
 * （storages/session_projcache/sessions/<id>.json 的 record.rows.<key>.val）。
 * 只读、不改；读不到就当没有，绝不编造。
 */
function cachedProjection(sessionId, key) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const file = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data?.record?.rows?.[key]?.val ?? null
  } catch {
    return null
  }
}

async function withContext(ctx, sessionId, values) {
  if (contextOf(values) !== null && breakdownOf(values) !== null) return values
  const more = await contextFallback(ctx, sessionId)
  const merged = more === null ? values : { ...values, ...more }
  const fixed = {
    ...merged,
    ...(contextOf(merged) === null ? { contextPressure: values.contextPressure } : {}),
    ...(breakdownOf(merged) === null ? { contextBreakdown: values.contextBreakdown } : {}),
  }
  if (contextOf(fixed) !== null && breakdownOf(fixed) !== null) return fixed
  // 三条投影路都缺构成时，直接照缓存补（桌面 UI 用的就是这一份）
  return {
    ...fixed,
    ...(contextOf(fixed) === null ? (() => { const v = cachedProjection(sessionId, 'contextPressure'); return v === null ? {} : { contextPressure: v } })() : {}),
    ...(breakdownOf(fixed) === null ? (() => { const v = cachedProjection(sessionId, 'contextBreakdown'); return v === null ? {} : { contextBreakdown: v } })() : {}),
  }
}

function titleOf(summary) {
  const values = summary?.projections?.values ?? {}
  for (const [key, value] of Object.entries(values)) {
    if (!/title/i.test(key)) continue
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (value && typeof value === 'object' && typeof value.title === 'string') return value.title.trim()
  }
  return ''
}

/**
 * Reduce DSH's durable event stream to the handful of shapes a phone renders.
 * Everything else (steps, usage, retries, steering) is deliberately dropped:
 * the phone is a reader and a keyboard, not a second full client.
 */
function normalizeRecords(records) {
  const out = []
  for (const record of records ?? []) {
    const event = record?.event ?? record
    if (!event || typeof event.type !== 'string') continue
    const seq = Number(event.seq) || 0
    const time = Number(event.time) || 0
    if (event.type === 'user/message') {
      const message = event.data?.message ?? event.data
      const text = textOf(message)
      // 只带图没有文字的消息：给个占位，否则手机那边这条会凭空消失
      const parts = Array.isArray(message?.content) ? message.content : []
      const hasImage = parts.some((p) => p?.type === 'image')
      if (text) out.push({ seq, time, role: 'user', text })
      else if (hasImage) out.push({ seq, time, role: 'user', text: '[图片]' })
    } else if (event.type === 'assistant/message') {
      const message = event.data?.message ?? event.data
      const text = textOf(message)
      const thinking = reasoningOf(message)
      // 思考先于正文：手机端按「先想再说」的顺序铺开
      if (thinking) out.push({ seq: seq - 0.5, time, role: 'reasoning', text: thinking })
      if (text) out.push({ seq, time, role: 'assistant', text })
    } else if (event.type === 'tool/call') {
      // 参数要带上：手机端要显示成和桌面一样的一行（图标 + 工具名 + 参数摘要），
      // 只给一个名字，用户就分不清这两次 glob 查的是不是同一个目录。
      const data = event.data ?? {}
      out.push({
        seq,
        time,
        role: 'tool',
        // 桌面端把这次调用的身份放在 callId 上（不是 toolCallId）
        id: String(data.callId ?? ''),
        name: String(data.name ?? 'tool'),
        args: data.arguments ?? data.args ?? null,
      })
    } else if (event.type === 'tool/result') {
      const message = event.data?.message ?? event.data
      const text = textOf(message)
      out.push({
        seq,
        time,
        role: 'tool-result',
        // 结果的 callId 挂在 message.source 上，和 tool/call 的 data.callId 是同一个
        id: String(message?.source?.callId ?? event.data?.callId ?? ''),
        name: String(event.data?.name ?? ''),
        isError: message?.isError === true,
        text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
      })
    }
  }
  return out
}

/* ---------------- request handling ---------------- */

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * One request, transport-independent. Both the relay loop and the local panel
 * routes call this, so the phone and the desktop panel can never diverge in
 * what they are allowed to ask for.
 * @param {object} input
 * @param {string} input.method - HTTP verb.
 * @param {string} input.path - path plus optional query string.
 * @param {object} [input.headers] - lower-cased headers.
 * @param {any} [input.body] - parsed JSON body.
 * @param {boolean} [input.local] - true when the caller is the desktop panel.
 * @param {object} ctx - Cordis host context.
 */
async function handle({ method, path, headers = {}, body = null, local = false }, ctx) {
  const url = new URL(path, 'http://link')
  const route = url.pathname
  const query = url.searchParams

  /* Desktop-only surface: only reachable through the harness's own loopback-fenced routes. */
  if (local) {
    if (route === '/mobile-link/payload' && method === 'GET') {
      return {
        ok: true,
        enabled: state.enabled,
        relay: state.relay,
        // What the phone's "connect host" form asks for, verbatim.
        key: state.key,
        relayMode: embedded.base !== '' && embedded.base === state.relay ? 'embedded' : 'external',
        relayHealth: await relayHealth(),
        devices: state.devices.map(publicDevice),
        room: state.room,
        host: hostname(),
        // 桌面端自己的轮询是否新鲜（排查用）：它跟手机在不在线没有关系，
        // 以前徽章直接用它，于是「已配对设备 0」也能亮着「手机在线」。
        connected: Date.now() - relayState.hostSeenAt < 40_000,
        // 手机在线 = 有配对设备、且它最近一分钟内真的发过请求
        phoneLastSeenAt: state.devices.reduce((latest, d) => Math.max(latest, Number(d.lastSeenAt) || 0), 0),
        // 轮询循环的实况：卡死时这里一眼能看出来（lastOkAt 停住 / lastError 有值）
        phoneOnline: Date.now() - (state.devices.reduce((latest, d) => Math.max(latest, Number(d.lastSeenAt) || 0), 0)) < 60_000,
        relayDebug: {
          running: relayState.running,
          hostSeenAt: relayState.hostSeenAt,
          lastOkAt: relayState.lastOkAt,
          lastError: relayState.lastError,
        },
        // 跨网那一块的实况：面板一次读取就能同时显示局域网与隧道/直连
        cross: crossStatus().cross,
      }
    }
    if (route === '/mobile-link/start' && method === 'POST') {
      // An empty address is not an error: this process can host the relay and
      // advertise whatever address the machine currently has.
      const resolved = await resolveRelay()
      state.enabled = true
      saveState()
      restartRelayLoop()
      return {
        ok: true,
        enabled: true,
        relay: state.relay,
        relayMode: resolved.mode,
        switchedFrom: resolved.switchedFrom,
        relayHealth: await relayHealth(),
      }
    }
    if (route === '/mobile-link/stop' && method === 'POST') {
      state.enabled = false
      saveState()
      stopRelayLoop()
      // 「关闭连接」必须把公网那一侧的门一起关上：隧道/直连留着就等于没关
      crossStop(undefined)
      // A relay this process hosts is left running so the next start reuses
      // the same port and address.
      return { ok: true, enabled: false }
    }
    if (route === '/mobile-link/relay' && method === 'POST') {
      state.relay = typeof body?.relay === 'string' ? body.relay.trim().replace(/\/+$/, '') : ''
      saveState()
      // An explicit address means the person wants their own relay, so the one
      // hosted here can go — unless they cleared the field on purpose, which
      // asks for the opposite.
      if (state.relay.length > 0 && embedded.base !== state.relay) await dropEmbeddedRelay()
      // Saving while linked must leave a dialable address behind, not a dead one.
      if (state.enabled) {
        const resolved = await resolveRelay()
        restartRelayLoop()
        return {
          ok: true,
          relay: state.relay,
          relayMode: resolved.mode,
          switchedFrom: resolved.switchedFrom,
          relayHealth: await relayHealth(),
        }
      }
      return { ok: true, relay: state.relay, relayHealth: await relayHealth() }
    }
    if (route === '/mobile-link/cross' && method === 'GET') {
      return crossStatus()
    }
    if (route === '/mobile-link/cross/start' && method === 'POST') {
      return await crossStart(body?.mode === 'direct' ? 'direct' : 'tunnel')
    }
    if (route === '/mobile-link/cross/stop' && method === 'POST') {
      return crossStop(typeof body?.mode === 'string' ? body.mode : undefined)
    }
    if (route === '/mobile-link/cross/purge' && method === 'POST') {
      // 卸载前的手动清理：停掉一切、删掉下载来的二进制与自签证书
      crossStop(undefined)
      const removed = purgeDownloaded()
      return { ok: true, removed, purged: removed.length }
    }
    if (route === '/mobile-link/device/remove' && method === 'POST') {
      const id = typeof body?.id === 'string' ? body.id : ''
      state.devices = state.devices.filter((d) => d.id !== id)
      // 墓碑：saveState() 的合并会把磁盘上的旧记录补回来，除非这里明确
      // 记下「这个 id 在什么时候删的」。手机下次带旧令牌来就是 401；
      // 而它之后重新配对（pairedAt 更晚）就把这次删除推翻了。
      if (id.length > 0) state.removed[id] = Date.now()
      saveState()
      return { ok: true, devices: state.devices.map(publicDevice) }
    }
    if (route === '/mobile-link/reset' && method === 'POST') {
      // New room and key: every phone has to be filled in again.
      state.room = randomBytes(12).toString('hex')
      state.key = randomBytes(16).toString('hex')
      state.devices = []
      // 重置时间戳同样要落盘：否则并集合并会把旧设备原样补回来，表现为
      // 「房间号和口令都变了，已配对设备还是原来那一台」。
      state.resetAt = Date.now()
      state.removed = tombstones([])
      saveState()
      if (state.enabled) restartRelayLoop()
      return { ok: true }
    }
    throw new ApiError(404, 'not-found')
  }

  /* Phone surface: needs a paired device token on every call except claiming. */

  // Typed-in pairing. The room key is the room's secret, so anyone who can type
  // the three fields off the panel is as trusted as a scanner — and unlike the
  // one-time code this does not expire, which is the whole point of showing it.
  if (route === '/pair/key' && method === 'POST') {
    if (!state.enabled) throw new ApiError(409, 'link-off')
    const presented = String(headers['x-link-key'] ?? headers['X-Link-Key'] ?? body?.key ?? '')
    if (presented.length === 0 || !sameDigest(digest(presented), digest(state.key))) {
      throw new ApiError(401, 'bad-key')
    }
    const minted = mintDevice(body?.device)
    return {
      ok: true,
      deviceToken: minted.deviceToken,
      device: minted.device,
      host: { name: hostname(), platform: platform() },
    }
  }

  const device = deviceForToken(headers['x-device-token'] ?? query.get('dt'))
  if (device === null) throw new ApiError(401, 'unauthorized')

  if (route === '/ping' && method === 'GET') {
    return { ok: true, host: { name: hostname(), platform: platform() }, device: publicDevice(device) }
  }

  const controller = ctx.get?.('sessionController')
  if (controller === undefined) throw new ApiError(503, 'session-controller-unavailable')

  /* 新建工作区：注册电脑上一个**已存在**的目录（桌面端也是如此，不在这里替你造目录） */
  if (route === '/workspace' && method === 'POST') {
    const dir = typeof body?.path === 'string' ? body.path.trim() : ''
    if (dir === '') throw new ApiError(400, 'path-required')
    const controller = ctx.get?.('workspaceController')
    if (controller === undefined || typeof controller.create !== 'function') throw new ApiError(501, 'no-workspace-controller')
    const value = await controller.create({ path: dir })
    return {
      ok: true,
      created: Boolean(value?.created),
      workspace: { workspaceId: String(value?.workspace?.workspaceId ?? ''), title: String(value?.workspace?.title ?? ''), path: String(value?.workspace?.path ?? dir) },
    }
  }

  /* 新建会话：和电脑端同一个入口 —— 指定工作区就传 cwd，不指定就用电脑的默认工作区 */
  if (route === '/session' && method === 'POST') {
    if (typeof controller.create !== 'function') throw new ApiError(501, 'no-create')
    const cwd = typeof body?.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd.trim() : ''
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : ''
    const created = await controller.create({
      ...(workspaceId === '' ? {} : { workspaceId }),
      ...(workspaceId === '' && cwd !== '' ? { cwd } : {}),
    })
    const sessionId = String(created?.sessionId ?? '')
    if (sessionId === '') throw new ApiError(502, 'create-no-id')
    return { ok: true, sessionId, cwd }
  }

  /* 电脑上的工作区列表：新建会话前先选一个（和桌面端的 Workspace 同一个来源） */
  if (route === '/workspaces' && method === 'GET') {
    const registry = ctx.get?.('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return { ok: true, workspaces: [] }
    const rows = (registry.list() ?? []).map((w) => ({
      workspaceId: String(w?.workspaceId ?? ''),
      title: String(w?.title ?? ''),
      path: String(w?.path ?? ''),
      sessions: Array.isArray(w?.sessionIds) ? w.sessionIds.length : 0,
    })).filter((w) => w.workspaceId !== '')
    return { ok: true, workspaces: rows }
  }

  /* 电脑端可用的斜杠命令：手机 ＋ 菜单照它摆（和电脑端同一个 commands 服务）。
     拿不到就回空列表 —— 菜单里就不显示那一组，而不是画一个点了没反应的入口。 */
  if (route === '/commands' && method === 'GET') {
    const sessionId = String(query.get('session') ?? '')
    const agent = sessionId === '' ? undefined : ctx.get?.('agents')?.get?.(sessionId)
    const commands = ctx.get?.('commands')
    if (agent === undefined || commands === undefined || typeof commands.list !== 'function') {
      return { ok: true, commands: [] }
    }
    const rows = commands.list(agent)
      .map((c) => ({ name: String(c.name ?? ''), description: String(c.description ?? '') }))
      .filter((r) => r.name !== '')
    return { ok: true, commands: rows }
  }

  /* 电脑这一侧的模型目录：手机上要能选真正的模型，而不是摆设。
     逐个 provider 走网络，冷读实测 ~30 秒 —— 每开一次选择器等半分钟，用户看到的就是
     「模型切换点不动」。所以目录**落盘**：有旧的就先回旧的，同时在后台刷新；
     只有从来没有过，才让调用方等这一次（并且给这一路更长的帧超时）。 */
  if (route === '/models' && method === 'GET') {
    if (typeof controller.modelCatalog !== 'function') throw new ApiError(501, 'no-model-catalog')
    const cached = state.catalog && typeof state.catalog === 'object' ? state.catalog : null
    const age = Date.now() - (Number(state.catalogAt) || 0)
    if (cached && age < CATALOG_TTL_MS) return { ok: true, catalog: cached, cached: true }
    if (cached) {
      void refreshCatalog(controller)
      return { ok: true, catalog: cached, cached: true, stale: true }
    }
    // 第一次构建目录要逐个 provider 走网络，任何一个的流断了（"unexpected end of stream"）
    // 都会把整份目录打掉。重试一次；仍失败就明确说「目录不可用」，让手机显示重试，
    // 别把 Node 的原始异常原样丢给用户。
    let fresh = null
    let lastError = ''
    for (let attempt = 0; attempt < 2 && fresh === null; attempt += 1) {
      try {
        fresh = await controller.modelCatalog()
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    if (fresh === null) throw new ApiError(502, 'catalog-unavailable: ' + (lastError || 'unknown'))
    state.catalog = fresh
    state.catalogAt = Date.now()
    saveState()
    return { ok: true, catalog: fresh }
  }

  if (route === '/sessions' && method === 'GET') {
    const value = await controller.list({}, AbortSignal.timeout(20_000))
    const items = (value?.items ?? [])
      .filter((item) => !item.parentSessionId && item.origin !== 'subagent')
      .map((item) => ({
        id: item.sessionId,
        title: titleOf(item),
        cwd: item.cwd ?? '',
        running: Boolean(item.running),
        updatedAt: Number(item.updatedAt) || 0,
        blank: Boolean(item.blank),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return { ok: true, sessions: items }
  }

  const sessionMatch = /^\/session\/([^/]+)(\/[a-z]+)?$/.exec(route)
  if (sessionMatch !== null) {
    const sessionId = decodeURIComponent(sessionMatch[1])
    const verb = sessionMatch[2] ?? ''

    if (verb === '' && method === 'GET') {
      const after = Number(query.get('after') ?? '0')
      const snapshot = await readSnapshot(controller, sessionId, ctx)
      const messages = normalizeRecords(snapshot.records).filter((m) => m.seq > (Number.isFinite(after) ? after : 0))
      return {
        ok: true,
        sessionId,
        cursor: snapshot.cursor,
        hasMore: snapshot.hasMore,
        messages,
        running: snapshot.running,
        title: snapshot.title,
        selected: snapshot.selected,
        // 输入框下面那个占用圆环要的两份：总量与构成。以前这里没转发，
        // 手机侧再怎么画都只能显示「没有数据」。
        context: snapshot.context,
        breakdown: snapshot.breakdown,
        via: snapshot.via,
      }
    }

    /* 切这一场会话用的模型与思考档位（下一次请求生效，和桌面端同一个入口） */
    if (verb === '/model' && method === 'POST') {
      if (typeof controller.selectModel !== 'function') throw new ApiError(501, 'no-select-model')
      const provider = typeof body?.provider === 'string' ? body.provider : ''
      const model = typeof body?.model === 'string' ? body.model : ''
      if (provider === '' || model === '') throw new ApiError(400, 'model-required')
      const effort = typeof body?.reasoningEffort === 'string' && body.reasoningEffort !== ''
        ? body.reasoningEffort
        : undefined
      const value = await controller.selectModel({
        sessionId,
        provider,
        model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      })
      return { ok: true, selected: value?.selected ?? { provider, model, ...(effort ? { reasoningEffort: effort } : {}) } }
    }

    /* 增量帧：手机带着游标来取，只拿新的，拼出来就是流式 */
    if (verb === '/live' && method === 'GET') {
      const since = Number(query.get('since') ?? '0')
      const from = Number.isFinite(since) ? since : 0
      const entry = liveFor(ctx, sessionId)
      const deltas = entry.deltas.filter((item) => item.n > from)
      return { ok: true, cursor: entry.next, deltas }
    }

    if (verb === '/prompt' && method === 'POST') {
      const text = typeof body?.text === 'string' ? body.text : ''
      if (text.length > 32_000) throw new ApiError(413, 'prompt-too-long')
      // 随消息带的图片：桌面端的 PromptContentPart.image（host 会把字节转成持久附件）。
      // 只收浏览器能直接显示的几种格式，并且限张数/体积 —— 这条链路是中继，别拿它当网盘。
      const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
      const images = Array.isArray(body?.images) ? body.images : []
      if (images.length > 4) throw new ApiError(413, 'too-many-images')
      const parts = []
      for (const one of images) {
        const mediaType = String(one?.mediaType ?? '')
        if (!IMAGE_TYPES.includes(mediaType)) continue
        const data = typeof one?.data === 'string' ? one.data : ''
        if (data.length === 0 || data.length > 8_000_000) throw new ApiError(413, 'image-too-large')
        parts.push({ type: 'image', mediaType, data, ...(typeof one?.name === 'string' && one.name !== '' ? { name: one.name.slice(0, 80) } : {}) })
      }
      if (text.trim().length === 0 && parts.length === 0) throw new ApiError(400, 'empty-prompt')
      // 手机给的时区不一定合规（安卓上常常是 "GMT+08:00"），桌面端只收 UTC /Area/Location。
      // 不合规就干脆不传，让它用自己那份 —— 总比整条消息被拒好。
      const zone = typeof body?.timeZone === 'string' ? body.timeZone.trim() : ''
      const clientTimeZone = zone === 'UTC' || /^[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+\-/]+$/.test(zone)
        ? zone
        : undefined
      await controller.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [
            ...(text.trim().length === 0 ? [] : [{ type: 'text', text }]),
            ...parts,
          ],
          ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
        },
        AbortSignal.timeout(20_000),
      )
      return { ok: true, accepted: true }
    }

    if (verb === '/cancel' && method === 'POST') {
      controller.cancel({ sessionId })
      return { ok: true, accepted: true }
    }

    /* 斜杠命令：和电脑端输入框里敲 / 是同一个入口（host 的 commands 服务）。
       手机这边没有「插入草稿」这一步，直接把整行交上去。 */
    if (verb === '/command' && method === 'POST') {
      const line = typeof body?.line === 'string' ? body.line.trim() : ''
      if (!line.startsWith('/')) throw new ApiError(400, 'bad-command')
      const agent = ctx.get?.('agents')?.get?.(sessionId)
      const commands = ctx.get?.('commands')
      if (agent === undefined || commands === undefined || typeof commands.execute !== 'function') {
        throw new ApiError(501, 'no-commands')
      }
      const outcome = await commands.execute(agent, line, [], AbortSignal.timeout(30_000))
      return { ok: true, matched: outcome !== undefined }
    }

    throw new ApiError(404, 'unknown-session-verb')
  }

  throw new ApiError(404, 'not-found')
}

/**
 * Read one session's recent history plus its current live state.
 *
 * 两条路：能 `page()` 的走「投影 + 翻一页」（大日志也只读一页）；
 * 否则退回 `follow()` 的完整快照（老会话/迁移中）。两条都返回同一形状，
 * 调用方不需要知道走的是哪条。
 */
async function readSnapshot(controller, sessionId, ctx) {
  // 优先走「投影 + 翻页」：大日志（实测有一条 43 MB 压缩的会话）整份快照 30 秒都出不来，
  // 中继会在 30 秒回 504，手机看到的就是「电脑端会话记录没有」。
  // page() 只从当前切点往回读一页消息，projections() 只读投影，两个都是轻量的。
  if (typeof controller.page === 'function') {
    const signal = AbortSignal.timeout(25_000)
    let meta = null
    if (typeof controller.projections === 'function') {
      try {
        meta = await controller.projections({ sessionId }, signal)
      } catch {
        meta = null
      }
    }
    const values = meta?.values ?? {}
    const cut = Number(meta?.asOfSeq) || 0
    if (cut > 0) {
      // 超大日志（压缩存储）偶尔会在读取流上抛 "unexpected end of stream"：
      // 重试一次；两次都不成就落下去走完整快照 —— 宁可慢，也别让用户看到「没有记录」。
      let page = null
      for (let attempt = 0; attempt < 2 && page === null; attempt += 1) {
        try {
          page = await controller.page(
            { address: { kind: 'session', sessionId }, throughSeq: cut, maxMessages: HISTORY_LIMIT },
            signal,
          )
        } catch {
          page = null
        }
      }
      if (page !== null) {
        const records = page.records ?? []
        const lastSeq = records.reduce((max, record) => Math.max(max, Number(record?.event?.seq) || 0), 0)
        const merged = await withContext(ctx, sessionId, values)
        return {
          records,
          cursor: lastSeq || cut,
          hasMore: Boolean(page.hasMore),
          running: Boolean(merged.sessionStats?.running) || false,
          title: titleOf({ projections: { values: merged } }),
          selected: selectionOf(merged.modelSelection),
          context: contextOf(merged),
          breakdown: breakdownOf(merged),
          via: 'page',
        }
      }
    }
    // 投影拿不到（迁移中/老会话）：退回 follow，慢但至少有结果
  }

  const abort = new AbortController()
  // 25 秒：中继等电脑 30 秒，留出 5 秒余量让它先回一个「超时」而不是被中继掐断，
  // 手机那边就能拿到明确的错误，而不是「记录没了」
  const timer = setTimeout(() => abort.abort(), 25_000)
  const iterable = controller.follow(
    { address: { kind: 'session', sessionId }, maxMessages: HISTORY_LIMIT },
    abort.signal,
  )
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    const frame = first?.value
    if (!frame || frame.type !== 'snapshot') throw new ApiError(502, 'no-snapshot')
    const values = frame.projections?.values ?? {}
    const merged = await withContext(ctx, sessionId, values)
    return {
      records: frame.records ?? [],
      cursor: Number(frame.cursor) || 0,
      hasMore: Boolean(frame.hasMore),
      running: Boolean(merged.sessionStats?.running) || false,
      title: titleOf({ projections: { values: merged } }),
      // 这场会话现在用哪个模型：手机的选择器要靠它标出「当前」，
      // 不然只能显示电脑默认档，看着像没生效。
      // 电脑的投影是 { lastUsed, next }（内部 provider 名，如 dsh-provider-qoder），
      // 手机只认扁平的 { provider, model, reasoningEffort } —— 在这里归一，
      // 别让两端各猜一套形状。
      selected: selectionOf(merged.modelSelection),
      context: contextOf(merged),
      breakdown: breakdownOf(merged),
      via: 'follow',
    }
  } finally {
    clearTimeout(timer)
    try {
      await iterator.return?.()
    } catch {
      // Closing a snapshot early is best-effort.
    }
  }
}

/* ---------------- live stream (assistant deltas) ----------------
 * 手机不能等整条消息落库才看到内容：桌面把模型的增量帧存在内存里，
 * 手机按序号来取，正文/思考边生成边显示。订阅是长驻的（否则每次请求都会丢帧），
 * 没人取就自动退订，不在桌面进程里留垃圾。
 */
const liveStreams = new Map()
const LIVE_IDLE_MS = 5 * 60 * 1000

/** 一帧模型增量 → 手机能直接追加的片段 */
function liveDeltaOf(frame) {
  if (!frame || frame.type !== 'chunk') return null
  const chunk = frame.chunk ?? {}
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return { kind: 'text', text: chunk.text }
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') return { kind: 'think', text: chunk.text }
  return null
}

function liveFor(ctx, sessionId) {
  const existing = liveStreams.get(sessionId)
  if (existing !== undefined) {
    existing.seenAt = Date.now()
    return existing
  }
  const controller = ctx.get?.('sessionController')
  if (controller === undefined) throw new ApiError(503, 'session-controller-unavailable')

  const entry = {
    deltas: [],
    next: 0,
    seenAt: Date.now(),
    abort: new AbortController(),
  }
  liveStreams.set(sessionId, entry)

  ;(async () => {
    try {
      const iterable = controller.follow(
        { address: { kind: 'session', sessionId }, maxMessages: 1, assistantStream: true },
        entry.abort.signal,
      )
      for await (const frame of iterable) {
        if (frame?.type !== 'assistant-stream') continue
        const delta = liveDeltaOf(frame.frame)
        if (delta === null) continue
        entry.next += 1
        entry.deltas.push({ n: entry.next, ...delta })
        if (entry.deltas.length > 600) entry.deltas.splice(0, entry.deltas.length - 600)
      }
    } catch {
      // 退订 / 会话结束都走这里
    } finally {
      if (liveStreams.get(sessionId) === entry) liveStreams.delete(sessionId)
    }
  })()

  return entry
}

setInterval(() => {
  const cutoff = Date.now() - LIVE_IDLE_MS
  for (const [sessionId, entry] of liveStreams) {
    if (entry.seenAt < cutoff) {
      entry.abort.abort()
      liveStreams.delete(sessionId)
    }
  }
}, 60 * 1000).unref?.()

/* ---------------- relay client ---------------- */

const relayState = {
  running: false,
  hostSeenAt: 0,
  lastError: '',
  lastOkAt: 0,
  generation: 0,
}

let relayLoop = null

/**
 * 直连中继的 HTTP 请求。
 *
 * 为什么不用 fetch：桌面进程普遍带着 HTTP_PROXY（企业代理、抓包工具），
 * 而 undici/Electron 会把它套到**内网**请求上 —— 于是桌面端「连得上」的是代理，
 * 真正的中继看不到 host，手机侧每个请求都超时。node:http 默认不走代理。
 */
function relayRequest(method, url, { headers = {}, body = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const request = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method,
        setHost: false,
        headers: {
          host: target.host,
          ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...headers,
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text.length > 0 ? JSON.parse(text) : null
          } catch {
            json = null
          }
          resolve({ status: response.statusCode ?? 0, text, json })
        })
      },
    )
    request.setTimeout(timeoutMs, () => request.destroy(new Error('relay-timeout')))
    request.on('error', reject)
    if (payload !== null) request.write(payload)
    request.end()
  })
}

async function relayHealth() {
  if (!state.relay) return { reachable: false, reason: 'no-relay' }
  try {
    const response = await relayRequest('GET', `${state.relay}/link/${state.room}/health`, {
      headers: { 'x-link-key': state.key },
      timeoutMs: 3000,
    })
    if (response.status < 200 || response.status >= 300) {
      return { reachable: false, reason: `http-${response.status}` }
    }
    return { reachable: true, ...(response.json ?? {}) }
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/* ---------------- relay hosted by this process ---------------- */

/**
 * The address a phone on the same network can dial back to.
 *
 * Read from the interfaces at the moment it is needed, never configured: a
 * laptop moves between networks and a DHCP lease that changed must not leave a
 * dead address on the panel. Private ranges first — that is what a home or
 * office LAN hands out.
 */
function lanAddress() {
  const found = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.internal) continue
      if (net.family !== 'IPv4' && net.family !== 4) continue
      found.push(net.address)
    }
  }
  const isPrivate = (ip) =>
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  return found.find(isPrivate) ?? found[0] ?? ''
}

/** Relay hosted by this process; `base` is empty while an external one is used. */
const embedded = { relay: null, base: '', pending: null }

async function embeddedBase() {
  if (embedded.relay !== null) {
    // The machine may have moved networks while linking was off: the port is
    // ours, the address is whatever the interfaces say now.
    const address = lanAddress()
    if (address.length > 0) embedded.base = `http://${address}:${embedded.relay.port}`
    return embedded.base
  }
  if (embedded.pending !== null) return embedded.pending
  embedded.pending = (async () => {
    const address = lanAddress()
    if (address.length === 0) throw new ApiError(409, 'no-lan-address')
    // 8787 first so a phone that remembers the address keeps working; when
    // something else owns that port the OS picks a free one instead.
    let relay
    try {
      relay = await startRelay({ port: 8787 })
    } catch {
      relay = await startRelay({ port: 0 })
    }
    embedded.relay = relay
    embedded.base = `http://${address}:${relay.port}`
    return embedded.base
  })().finally(() => {
    embedded.pending = null
  })
  return embedded.pending
}

async function dropEmbeddedRelay() {
  const relay = embedded.relay
  embedded.relay = null
  embedded.base = ''
  if (relay !== null) {
    try {
      await relay.close()
    } catch {
      // Already closed with the process.
    }
  }
}

const isPrivateHost = (host) =>
  host === 'localhost' ||
  host === '::1' ||
  /^127\./.test(host) ||
  /^10\./.test(host) ||
  /^192\.168\./.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
  host.endsWith('.local') ||
  host.endsWith('.lan') ||
  /^[a-z0-9-]+$/i.test(host) // a bare name can only resolve inside the intranet

function relayIsPrivate(base) {
  try {
    return isPrivateHost(new URL(base).hostname)
  } catch {
    return false
  }
}

/**
 * Choose the relay this desktop dials, repairing a stale entry on the way.
 *
 * A configured public relay stays authoritative: if it is down the operator
 * needs to hear about it rather than being moved somewhere else silently. A
 * private address that stops answering is, in practice, a lease that moved or a
 * relay nobody started — exactly the case where hosting one here is the fix.
 */
async function resolveRelay() {
  if (!state.relay) {
    const base = await embeddedBase()
    state.relay = base
    saveState()
    return { relay: base, mode: 'embedded', switchedFrom: '' }
  }
  const health = await relayHealth()
  if (health.reachable) {
    return { relay: state.relay, mode: embedded.base === state.relay ? 'embedded' : 'external', switchedFrom: '' }
  }
  if (!relayIsPrivate(state.relay)) {
    throw new ApiError(502, `relay-unreachable (${health.reason})`)
  }
  const previous = state.relay
  const base = await embeddedBase()
  state.relay = base
  saveState()
  return { relay: base, mode: 'embedded', switchedFrom: previous }
}

/** Answer one frame that arrived through the relay. */
/** 单帧处理上限：一帧挂起不该拖死整条轮询循环（实测踩过：循环卡住后
 *  手机上每个请求都超时，面板还显示「中继可达」，因为 health 不走 pull）。 */
const FRAME_TIMEOUT_MS = 20_000

/** 少数请求天生慢（模型目录要逐个 provider 走网络）：给它们单独的长预算 */
const SLOW_FRAME_TIMEOUT_MS = 50_000

/**
 * 一次取回的帧并发处理几件。
 *
 * 串行 await 等于把「慢」传染给所有请求：模型目录要逐个 provider 走网络、
 * 大会话首帧快照也慢，排在后面的历史与模型切换就一起白给（手机 35 秒读超时
 * →「电脑没有应答」）。上限是为了不把一台电脑同时打爆，不是为了省内存。
 */
const FRAME_CONCURRENCY = 4

/** 模型目录缓存多久：够手机把面板点开，又不至于让你新加的 provider 等太久 */
const CATALOG_TTL_MS = 45_000

let catalogRefreshing = false

/**
 * 后台刷新目录：只跑一份，失败就继续用旧的。
 * 选择器永远拿得到东西，不会因为某个 provider 卡住而转圈。
 */
async function refreshCatalog(controller) {
  if (catalogRefreshing) return
  catalogRefreshing = true
  try {
    const fresh = await controller.modelCatalog()
    state.catalog = fresh
    state.catalogAt = Date.now()
    saveState()
  } catch {
    // 刷新失败不影响已有目录：旧的还能选，只是暂时少几个新模型
  } finally {
    catalogRefreshing = false
  }
}

/* ---------------- 幂等去重（弱网重试的保护网） ----------------
   手机侧对网络层错误会重试同一次调用。如果第一次其实已经到达并执行了
   （只是应答没走回来），没有去重就会把同一条消息发两遍 —— 对 /prompt
   来说就是「我明明只说了一句，它回了两次」。这里按手机给的 x-request-id
   缓存最近应答，重试直接回放，执行永远只发生一次。 */
const IDEM_TTL_MS = 10 * 60_000
const IDEM_MAX = 512
const idemCache = new Map() // request id → { at, status, payload }

function idemKeyOf(frame) {
  const h = frame?.body?.headers
  if (!h || typeof h !== 'object') return ''
  const id = h['x-request-id'] ?? h['X-Request-Id']
  return typeof id === 'string' && id.length >= 8 ? id : ''
}

function idemRemember(key, status, payload) {
  if (!key) return
  if (idemCache.size >= IDEM_MAX) {
    idemCache.delete(idemCache.keys().next().value)
  }
  idemCache.set(key, { at: Date.now(), status, payload })
}

/**
 * 把一帧的应答送回中继。
 *
 * 弱网下单次 POST result 也可能石沉大海：这一帧的工作已经做完，丢了应答
 * 手机侧只能拿到 504。中继会把 pending 挂 30 秒，所以短间隔重试几次基本
 * 都能补投成功；真放弃了，幂等键也保证手机重试时拿到的是缓存结果而非重复执行。
 */
async function deliverResult(frameId, status, payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt === 1 ? 1000 : 2500)
    try {
      await relayRequest('POST', `${state.relay}/link/${state.room}/result`, {
        headers: { 'x-link-key': state.key },
        body: { id: frameId, status, body: payload },
        timeoutMs: 10_000,
      })
      return
    } catch {
      // 网络层失败：退避后补投；业务失败不存在（result 不做校验）
    }
  }
}

async function answerFrame(frame, ctx) {
  if (!relayState.running) return
  const idemKey = idemKeyOf(frame)
  const cached = idemKey ? idemCache.get(idemKey) : null
  if (cached && Date.now() - cached.at < IDEM_TTL_MS) {
    // 同一次调用被重试送到了第二次：回放缓存结果，不再执行
    await deliverResult(frame.id, cached.status, cached.payload)
    return
  }
  let status = 200
  let payload
  try {
    payload = await Promise.race([
      handle(
        {
          method: String(frame.method ?? 'GET'),
          path: String(frame.path ?? '/'),
          headers: frame.body?.headers ?? {},
          body: frame.body?.body ?? null,
          local: false,
        },
        ctx,
      ),
      new Promise((_, reject) => {
        // 天生的慢路径：模型目录要逐个 provider 走网络（冷读实测 ~30 秒）；
        // 大会话的历史快照也可能到 20 秒级。给它们单独的长预算，
        // 但都要压在中继的 30 秒之下 —— 否则中继先掐断，手机看到的就是「没记录」
        const slow = String(frame.path ?? '')
        const budget = slow.startsWith('/models') || slow.startsWith('/session/')
          ? Math.max(FRAME_TIMEOUT_MS, SLOW_FRAME_TIMEOUT_MS)
          : FRAME_TIMEOUT_MS
        const timer = setTimeout(() => reject(new Error('host-frame-timeout')), budget)
        timer.unref?.()
      }),
    ])
    relayState.lastOkAt = Date.now()
  } catch (error) {
    status = typeof error?.status === 'number' ? error.status : 504
    payload = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  idemRemember(idemKey, status, payload)
  await deliverResult(frame.id, status, payload)
}

/**
 * Long-poll the relay forever, answering whatever the phone asks for.
 *
 * One loop per desktop, restarted when the relay address changes. Failures back
 * off instead of hammering: a laptop that wakes up on a different network
 * should reconnect quietly, not spin.
 */
function startRelayLoop(ctx) {
  // Without a host context there is nothing to answer with; staying idle is
  // better than a loop that silently fails every frame.
  if (ctx === undefined || ctx === null) return
  if (!state.enabled) return
  if (relayLoop !== null) return
  const generation = ++relayState.generation
  relayState.running = true

  const loop = async () => {
    let since = 0
    let backoff = 1000
    while (relayState.running && relayState.generation === generation) {
      const base = state.relay
      if (!base) {
        await sleep(2000)
        continue
      }
      try {
        const response = await relayRequest('GET', `${base}/link/${state.room}/pull?since=${since}`, {
          headers: { 'x-link-key': state.key },
          timeoutMs: PULL_TIMEOUT_MS,
        })
        if (response.status === 401) {
          relayState.lastError = 'relay rejected the room key'
          await sleep(5000)
          continue
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`relay ${response.status}`)
        const data = response.json ?? {}
        relayState.hostSeenAt = Date.now()
        relayState.lastError = ''
        backoff = 1000
        for (const frame of data.frames ?? []) {
          // 无论这一帧成没成，游标都必须前进：否则同一帧会被反复重取
          since = Math.max(since, Number(frame.id) || 0)
          frameQueue.push(frame)
        }
        // 只入队，不等结果 —— 取活的循环必须立刻回去接着拉。
        // 以前是「一帧一帧 await」，后来改成「等一批 await」，实测都挡：
        // modelCatalog() 走网络那 6 秒里，后到的 /sessions 要等它做完才被取走
        // （追踪实锤：pulled 14 /models @4.6s → pulled 15 /sessions @10.6s）。
        // 手机 35 秒读超时之后显示「电脑没有应答」，用户看到的就是「模型切换点不动」。
        pumpFrames(ctx)
      } catch (error) {
        if (!relayState.running || relayState.generation !== generation) break
        relayState.lastError = error instanceof Error ? error.message : String(error)
        // 退避封顶 12 秒 + 抖动：中继判定「电脑离线」看的是 hostSeenAt 是否
        // 超过 45 秒没更新。以前封顶 30 秒 —— 25 秒的挂起轮询 + 30 秒退避
        // 已经贴着阈值，抖一下手机端就看到「电脑不在线」的假警报。
        await sleep(backoff + Math.round(Math.random() * 1000))
        backoff = Math.min(backoff * 2, 12_000)
      }
    }
  }

  relayLoop = loop().catch(() => {}).finally(() => {
    if (relayState.generation === generation) {
      relayState.running = false
      relayLoop = null
    }
  })
}

function stopRelayLoop() {
  relayState.running = false
  relayState.generation += 1
  relayLoop = null
  // 联动关了就是不再替手机办事：排队中的帧丢掉，手机那边按超时重试即可
  frameQueue.length = 0
}

function restartRelayLoop() {
  stopRelayLoop()
  startRelayLoop(CURRENT_CTX)
}

/* ---------------- 看门狗 ----------------
   轮询循环可能因为一帧挂起、一次未捕获的异常、或者笔记本睡眠后
   socket 半死而停止前进。它停了之后手机上每个请求都超时，而面板上的
   「中继可达」仍然成立（health 不走 pull）—— 用户完全看不出是哪一端的问题。
   所以这里不看"循环是否声称在跑"，只看它最近有没有真的拉到过东西：
   超过 90 秒没进展就整个换掉。 */
const WATCHDOG_MS = 30_000
const WATCHDOG_STALL_MS = 90_000

function startRelayWatchdog() {
  const timer = setInterval(() => {
    if (!state.enabled) return
    const seen = Math.max(relayState.hostSeenAt, relayState.lastOkAt)
    // seen === 0 表示还没成功拉过一次：给足启动时间，别反复重启
    if (seen === 0) return
    if (Date.now() - seen > WATCHDOG_STALL_MS) {
      relayState.lastError = 'watchdog: 轮询停滞，已自动重启'
      restartRelayLoop()
    }
  }, WATCHDOG_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 已取回但还没答完的帧，以及常驻的处理位。
 *
 * 上限是为了不把一台电脑同时打爆（每个请求都可能自己走一遍网络），
 * 而不是为了省内存；队列只在这次联动关掉时清空，因为没人等的应答没有意义。
 */
const frameQueue = []
const frameWorkers = new Set()

function pumpFrames(ctx) {
  while (frameWorkers.size < FRAME_CONCURRENCY && frameQueue.length > 0) {
    const frame = frameQueue.shift()
    const worker = (async () => {
      try {
        await answerFrame(frame, ctx)
      } catch (error) {
        relayState.lastError = error instanceof Error ? error.message : String(error)
      }
    })().finally(() => {
      frameWorkers.delete(worker)
      if (relayState.running) pumpFrames(ctx)
    })
    frameWorkers.add(worker)
  }
}

/* ---------------- local panel routes ---------------- */

let CURRENT_CTX = null

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function readJsonBody(request) {
  if (typeof request?.[Symbol.asyncIterator] !== 'function') return {}
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new ApiError(413, 'body-too-large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ApiError(400, 'invalid-json')
  }
}

/** Reuse the harness's own fence: loopback only, and only its own pages. */
function loopbackRejection(ctx, request) {
  try {
    const connection = ctx.get?.('connection')
    const rejection = connection?.requestRejection?.(request)
    return typeof rejection === 'number' ? rejection : undefined
  } catch {
    return 403
  }
}

const PANEL_ROUTES = [
  { method: 'GET', path: '/mobile-link/payload' },
  { method: 'POST', path: '/mobile-link/start' },
  { method: 'POST', path: '/mobile-link/stop' },
  { method: 'POST', path: '/mobile-link/relay' },
  { method: 'POST', path: '/mobile-link/device/remove' },
  { method: 'POST', path: '/mobile-link/reset' },
  { method: 'GET', path: '/mobile-link/cross' },
  { method: 'POST', path: '/mobile-link/cross/start' },
  { method: 'POST', path: '/mobile-link/cross/stop' },
  { method: 'POST', path: '/mobile-link/cross/purge' },
]

const ACTIVE_DISPOSERS = []

function mountPanelRoutes(ctx) {
  for (const dispose of ACTIVE_DISPOSERS) {
    try {
      dispose()
    } catch {
      // A previous mount may already be gone.
    }
  }
  ACTIVE_DISPOSERS.length = 0

  for (const route of PANEL_ROUTES) {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: async (request, response) => {
        const rejection = loopbackRejection(ctx, request)
        if (rejection !== undefined) {
          sendJson(response, rejection, { ok: false, error: 'forbidden' })
          return
        }
        if (request.method !== route.method) {
          sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          const body = route.method === 'POST' ? await readJsonBody(request) : null
          sendJson(response, 200, await handle({ method: request.method, path: route.path, body, local: true }, ctx))
        } catch (error) {
          const status = typeof error?.status === 'number' ? error.status : 500
          sendJson(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    if (typeof dispose === 'function') ACTIVE_DISPOSERS.push(dispose)
  }
}

/* ---------------- 跨网（隧道 / 直连） ----------------
 *
 * 中继那一跳要求「有人提供一台两边都够得着的服务器」，多数用户给不了这个便利。
 * 这里换成：本机起一个只监听 127.0.0.1 的 RPC，再让 cloudflared 把它映射成一个随机
 * 公网 HTTPS 地址；手机只要那一条地址。手机↔电脑之间再叠一层 e2e 信封，
 * 所以隧道那一跳只搬密文 —— 包括配对口令与设备令牌本身。
 *
 * 下载物与证书都落在插件自己目录（<插件>/bin、<插件>/data）：卸载插件就一起消失。
 */

const DIRECT_PORT = Number(process.env.DSH_MOBILE_LINK_DIRECT_PORT || 8788)

let crossRpc = null
let crossTunnel = null
let crossDirect = null

function crossLog(msg) {
  try { CURRENT_CTX?.log?.(`mobile-link: ${msg}`) } catch { /* 日志不该把连接带崩 */ }
}

/** RPC 服务：与中继共用同一个 handle()，权限口径不可能两边分叉 */
function ensureCrossRpc() {
  if (crossRpc) return crossRpc
  crossRpc = startRpc({
    port: 0,
    roomKey: () => state.key,
    hostName: hostname(),
    log: crossLog,
    handle: async (input) => {
      if (!CURRENT_CTX) throw new ApiError(503, 'host-not-ready')
      return handle({ method: input.method, path: input.path, headers: input.headers || {}, body: input.body ?? null, local: false }, CURRENT_CTX)
    },
  })
  return crossRpc
}

async function waitPort(rpc) {
  for (let i = 0; i < 40 && !rpc.port; i++) await new Promise((r) => setTimeout(r, 25))
  if (!rpc.port) throw new ApiError(500, 'rpc-listen-failed')
  return rpc.port
}

function ensureCrossDirect() {
  if (crossDirect) return crossDirect
  const cert = loadOrCreateCert(join(DATA_DIR, 'tls.json'))
  crossDirect = startDirect({
    port: DIRECT_PORT,
    // 现取：面板点「重置房间」以后，旧配对串必须立刻失效，而不是继续能用旧口令
    key: () => state.key,
    hostName: hostname(),
    cert,
    log: crossLog,
    handle: async (input) => {
      if (!CURRENT_CTX) throw new ApiError(503, 'host-not-ready')
      return handle({ method: input.method, path: input.path, headers: input.headers || {}, body: input.body ?? null, local: false }, CURRENT_CTX)
    },
  })
  return crossDirect
}

/** 面板要的一次性快照：状态 + 地址 + 配对串（配对串是一行可粘贴文本，省掉抄长地址与口令） */
function crossStatus() {
  const tunnel = crossTunnel?.status?.() ?? { state: state.cross.tunnel ? 'starting' : 'idle', url: '', installed: Boolean(locateBinary()), installHint: '' }
  const direct = crossDirect
    ? {
      state: 'ready', port: crossDirect.port, fingerprint: crossDirect.fingerprint,
      addresses: crossDirect.addresses,
    }
    : { state: state.cross.direct ? 'starting' : 'idle', port: DIRECT_PORT, fingerprint: '', addresses: [] }
  const pairing = {}
  if (tunnel.state === 'ready' && tunnel.url) {
    pairing.tunnel = pairingString({ mode: 'tunnel', url: tunnel.url, key: state.key, host: hostname() })
  }
  for (const a of direct.addresses || []) {
    if (!a.reachable) continue
    pairing.direct = pairingString({
      mode: 'direct', url: urlFor(a.address, direct.port), key: state.key, host: hostname(), fp: direct.fingerprint,
    })
    pairing.directUrl = a.url
    break
  }
  return { ok: true, cross: { tunnel, direct, pairing, enabled: state.cross }, room: state.room, key: state.key }
}

async function crossStart(mode) {
  if (mode !== 'tunnel' && mode !== 'direct') throw new ApiError(400, 'bad-mode')
  if (!state.enabled) throw new ApiError(409, 'link-off')
  const rpc = ensureCrossRpc()
  await waitPort(rpc)
  if (mode === 'tunnel') {
    const binary = await ensureBinary({ log: crossLog })
    if (!binary) {
      // 下载不下来就老实说，不假装"正在连接"：面板会给出兜底安装指引
      state.cross.tunnel = false
      saveState()
      return { ...crossStatus(), ok: false, error: 'cloudflared-unavailable' }
    }
    if (!crossTunnel) {
      crossTunnel = createTunnel({
        port: rpc.port,
        binary,
        // 地址一变就落盘：面板与手机都要能读到「现在的地址」，重启后也能直接复用
        onState: (st) => {
          if (st.state === 'ready' && st.url && state.crossTunnelUrl !== st.url) {
            state.crossTunnelUrl = st.url
            saveState()
          }
        },
        log: crossLog,
      })
    }
    crossTunnel.start()
    state.cross.tunnel = true
  } else {
    ensureCrossDirect()
    state.cross.direct = true
  }
  saveState()
  return crossStatus()
}

/**
 * 关掉跨网入口。
 *
 * keepState=true 只收进程、不动保存的开关 —— 插件卸载/热重载走这条路，
 * 否则「上次开着隧道，重启后自己恢复」永远不成立：dispose 先把开关写成关，
 * 下次启动读到的就是关。
 */
function crossStop(mode, keepState = false) {
  if (mode === 'tunnel' || mode === undefined) {
    crossTunnel?.stop()
    crossTunnel = null
    if (!keepState) state.cross.tunnel = false
  }
  if (mode === 'direct' || mode === undefined) {
    void crossDirect?.stop?.()
    crossDirect = null
    if (!keepState) state.cross.direct = false
  }
  if (mode === undefined) {
    void crossRpc?.stop?.()
    crossRpc = null
  }
  if (!keepState) saveState()
  return crossStatus()
}

/** 上次开着跨网，这次就不用再点一次 —— 「开关」的预期是跨重启保持 */
async function resumeCross() {
  const modes = [state.cross.tunnel && 'tunnel', state.cross.direct && 'direct'].filter(Boolean)
  for (const mode of modes) {
    try {
      await crossStart(mode)
    } catch (e) {
      crossLog(`cross: ${mode} 恢复失败 ${e?.message || e}`)
    }
  }
}

/* ---------------- plugin ---------------- */

export const name = 'mobile-link'

/** `sessionController` is read through `ctx.get` so a CLI-only host still loads. */
export const inject = ['webServer']

export function apply(ctx) {
  CURRENT_CTX = ctx

  // A build may ship a default relay; the panel is always reachable either way
  // so a person can paste an address in themselves.
  if (DEFAULT_RELAY.length > 0 && state.relay !== DEFAULT_RELAY && state.relay.length === 0) {
    state.relay = DEFAULT_RELAY
    saveState()
  }

  ctx.effect(() => {
    mountPanelRoutes(ctx)
    return () => {
      for (const dispose of ACTIVE_DISPOSERS.splice(0)) {
        try {
          dispose()
        } catch {
          // Idempotent teardown.
        }
      }
    }
  }, 'mobile-link: panel routes')

  // Only resume a link the person already switched on; a fresh install waits
  // for the start button. Resolving first repairs an address that stopped
  // answering while the harness was closed.
  if (state.enabled) {
    void resolveRelay()
      .catch(() => null)
      .then(() => {
        if (state.enabled) startRelayLoop(ctx)
      })
  }

  ctx.effect(() => () => {
    stopRelayLoop()
  }, 'mobile-link: relay loop')

  // 跨网跟着上次的开关走：上次开着隧道/直连，这次自己恢复，用户不用再点一次。
  // 下载与拉起都在 crossStart 里完成 —— 「插件开启后它自己跑」，不要求用户碰命令行。
  if (state.enabled && (state.cross.tunnel || state.cross.direct)) {
    void resumeCross()
  }

  // 插件卸载/热重载：子进程与监听端口一定要收掉，否则留下一个没人管的公网入口
  ctx.effect(() => () => {
    // 只收子进程与端口，保留「开着隧道/直连」这件事本身：下一次启动据此自动恢复
    crossStop(undefined, true)
  }, 'mobile-link: cross')

  // 看门狗：循环停滞时自动换一个新的（见 startRelayWatchdog 注释）
  let stopWatchdog = startRelayWatchdog()
  ctx.effect(() => () => {
    stopWatchdog()
    stopWatchdog = () => {}
  }, 'mobile-link: watchdog')
}

export { handle as handleLinkRequest, STATE_FILE as LINK_STATE_FILE }
