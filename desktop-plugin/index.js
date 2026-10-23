/**
 * Host half of `@local/dsh-mobile-link`.
 *
 * Turns this desktop harness into something a phone can pair with by scanning
 * one QR code, then read and continue the desktop's own sessions from anywhere.
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
 * @module @local/dsh-mobile-link
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, networkInterfaces, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { startRelay } from './relay/server.mjs'

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
/** History window handed to the phone per read. */
const HISTORY_LIMIT = 300

/* ---------------- persisted state ---------------- */

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
      // Deletion has to survive the read-merge-write in saveState(): a removed
      // id is a tombstone, and everything paired at or before resetAt is dead.
      resetAt: Number(raw.resetAt) || 0,
      removed: Array.isArray(raw.removed) ? raw.removed.filter((id) => typeof id === 'string') : [],
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
      resetAt: 0,
      removed: [],
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
 * 并集只该让「新增」活下来，不该让「删除」复活：删除记成墓碑（removed），
 * 重置记成 resetAt，两边合并时先按这两条把该没的剔掉，再把并集补上。
 * 否则移除设备/重置配对写完就被磁盘上的旧记录合并回来，面板永远显示那一台。
 */
function saveState() {
  const before = JSON.stringify(state)
  try {
    const disk = loadState()
    if (disk !== null && Array.isArray(disk.devices)) {
      // 墓碑取并集：任一进程删过的，就是删了。
      const removed = new Set([...(state.removed ?? []), ...(disk.removed ?? [])])
      // 重置时间取较晚的：任一进程重置过，早于它的配对都不算数。
      const resetAt = Math.max(Number(state.resetAt) || 0, Number(disk.resetAt) || 0)
      const alive = (item) =>
        item &&
        typeof item.id === 'string' &&
        !removed.has(item.id) &&
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
      state.removed = [...removed]
      state.resetAt = resetAt
    }
  } catch {
    // 读不到就按自己这份写，总比丢数据好
  }
  if (JSON.stringify(state) === before) return
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // A read-only home directory must not take the panel down; pairing then
    // simply does not survive a restart.
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
  // 重新配对等于把这台手机重新认回来：墓碑必须撤销，否则 saveState() 的
  // 合并会把它当成「已删除」再剔一次，表现为刚配对成功却不在列表里。
  if (Array.isArray(state.removed) && state.removed.includes(record.id)) {
    state.removed = state.removed.filter((id) => id !== record.id)
  }
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
      const text = textOf(event.data?.message ?? event.data)
      if (text) out.push({ seq, time, role: 'user', text })
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
    if (route === '/mobile-link/device/remove' && method === 'POST') {
      const id = typeof body?.id === 'string' ? body.id : ''
      state.devices = state.devices.filter((d) => d.id !== id)
      // 墓碑：saveState() 的并集合并会把磁盘上的旧记录补回来，除非这里明确
      // 记下「这个 id 已经删了」。手机下次带旧令牌来就是 401。
      if (id.length > 0) state.removed = [...new Set([...(state.removed ?? []), id])]
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
      state.removed = []
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

  /* 电脑这一侧的模型目录：手机上要能选真正的模型，而不是摆设。
     catalog 本身就是给选择器用的（provider 分组 + 每个模型的思考档位）。 */
  if (route === '/models' && method === 'GET') {
    if (typeof controller.modelCatalog !== 'function') throw new ApiError(501, 'no-model-catalog')
    const catalog = await controller.modelCatalog()
    return { ok: true, catalog }
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
      const snapshot = await readSnapshot(controller, sessionId)
      const messages = normalizeRecords(snapshot.records).filter((m) => m.seq > (Number.isFinite(after) ? after : 0))
      return {
        ok: true,
        sessionId,
        cursor: snapshot.cursor,
        hasMore: snapshot.hasMore,
        messages,
        running: snapshot.running,
        title: snapshot.title,
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
      if (text.trim().length === 0) throw new ApiError(400, 'empty-prompt')
      if (text.length > 32_000) throw new ApiError(413, 'prompt-too-long')
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
          content: [{ type: 'text', text }],
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

    throw new ApiError(404, 'unknown-session-verb')
  }

  throw new ApiError(404, 'not-found')
}

/**
 * Read one session's recent history plus its current live state.
 *
 * `follow()` opens with a snapshot that already carries the newest window and
 * the authoritative cursor, which is exactly the shape the phone polls for.
 * The iterator is closed immediately: a parked follower per poll would keep a
 * writer-adjacent resource open for nothing.
 */
async function readSnapshot(controller, sessionId) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 20_000)
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
    return {
      records: frame.records ?? [],
      cursor: Number(frame.cursor) || 0,
      hasMore: Boolean(frame.hasMore),
      running: Boolean(values.sessionStats?.running) || false,
      title: titleOf({ projections: { values } }),
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
 * dead URL inside the QR code. Private ranges first — that is what a home or
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

async function answerFrame(frame, ctx) {
  if (!relayState.running) return
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
        const timer = setTimeout(() => reject(new Error('host-frame-timeout')), FRAME_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
    relayState.lastOkAt = Date.now()
  } catch (error) {
    status = typeof error?.status === 'number' ? error.status : 504
    payload = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    await relayRequest('POST', `${state.relay}/link/${state.room}/result`, {
      headers: { 'x-link-key': state.key },
      body: { id: frame.id, status, body: payload },
      timeoutMs: 10_000,
    })
  } catch {
    // The phone gives up on its own timeout; nothing to retry here.
  }
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
          try {
            await answerFrame(frame, ctx)
          } catch (error) {
            relayState.lastError = error instanceof Error ? error.message : String(error)
          }
          // 无论这一帧成没成，游标都必须前进：否则同一帧会被反复重取
          since = Math.max(since, Number(frame.id) || 0)
        }
      } catch (error) {
        if (!relayState.running || relayState.generation !== generation) break
        relayState.lastError = error instanceof Error ? error.message : String(error)
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
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

  // 看门狗：循环停滞时自动换一个新的（见 startRelayWatchdog 注释）
  let stopWatchdog = startRelayWatchdog()
  ctx.effect(() => () => {
    stopWatchdog()
    stopWatchdog = () => {}
  }, 'mobile-link: watchdog')
}

export { handle as handleLinkRequest, STATE_FILE as LINK_STATE_FILE }
