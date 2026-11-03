#!/usr/bin/env node
/**
 * dsh-mobile-link relay — the rendezvous both ends dial OUT to.
 *
 * Neither the desktop nor the phone ever accepts an inbound connection here, so
 * this works from home NAT, CGNAT, hotel Wi-Fi and mobile data alike: no port
 * forwarding, no public IP, no same-LAN requirement. The relay understands one
 * thing only — "carry this opaque request to the desktop, carry the answer
 * back" — and never parses session content.
 *
 * Protocol (all bodies JSON, all paths under /link):
 *
 *   Desktop, long-poll for work      GET  /link/:room/pull?since=N     (≤25 s)
 *   Desktop, deliver one answer      POST /link/:room/result
 *   Phone, one request/response      POST /link/:room/call             (≤30 s)
 *   Either side, liveness            GET  /link/:room/health
 *
 * Both ends authenticate with the same 128-bit room key, which only exists
 * inside the QR code the desktop shows and the phone scans. The room id alone
 * is never sufficient. Rooms live in memory: restarting the relay drops the
 * rendezvous, and both ends simply re-register.
 *
 * Run:  node server.mjs [--port 8787] [--host 0.0.0.0]
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'

const PULL_TIMEOUT_MS = 25_000
const CALL_TIMEOUT_MS = 30_000
// 一封「带图 prompt」的信封：手机端把 base64 图片塞进正文，再 AES-GCM + base64 套一层，
// 4 张 1600px 的图大约 4~5 MB。512 KB 的时代只能传输纯文字，图片一律 413。
const MAX_BODY_BYTES = 6 * 1024 * 1024
const MAX_QUEUE = 100
// 单个房间排队帧的字节总量上限：MAX_QUEUE 帧 × 6 MB 会是 600 MB，绝不能只靠条数兜底
const MAX_ROOM_QUEUE_BYTES = 24 * 1024 * 1024
const MAX_ROOMS = 2_000
/** How long an unused room is kept before its state is dropped. */
const ROOM_IDLE_MS = 12 * 60 * 60 * 1000

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const PORT = Number(argOf('port', process.env.PORT ?? 8787))
const HOST = argOf('host', process.env.HOST ?? '0.0.0.0')

/** room id → room state */
const rooms = new Map()

function roomFor(id, keyHash) {
  let room = rooms.get(id)
  if (room === undefined) {
    if (rooms.size >= MAX_ROOMS) evictOldest()
    room = {
      id,
      keyHash,
      createdAt: Date.now(),
      touchedAt: Date.now(),
      queue: [],
      queueBytes: 0,               // 排队帧的正文总量（见 MAX_ROOM_QUEUE_BYTES）
      waiters: new Set(),          // pending pull() responders
      pending: new Map(),          // request id → resolve(call)
      nextId: 1,
      hostSeenAt: 0,
      clientSeenAt: 0,
    }
    rooms.set(id, room)
  }
  return room
}

function evictOldest() {
  let oldest = null
  for (const room of rooms.values()) {
    if (oldest === null || room.touchedAt < oldest.touchedAt) oldest = room
  }
  if (oldest !== null) rooms.delete(oldest.id)
}

function digest(text) {
  return createHash('sha256').update(text).digest()
}

function keyMatches(room, presented) {
  if (typeof presented !== 'string' || presented.length < 16 || presented.length > 128) return false
  const a = digest(presented)
  return a.length === room.keyHash.length && timingSafeEqual(a, room.keyHash)
}

function json(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function readBody(request) {
  if (typeof request?.[Symbol.asyncIterator] !== 'function') return {}
  const chunks = []
  let size = 0
  let over = false
  for await (const chunk of request) {
    size += chunk.length
    // 超限也要把请求体读干净再回 413：读到一半就断，会把客户端的连接池弄脏，
    // 下一次普通请求会莫名 "fetch failed"（e2e 里真踩过）。
    if (size > MAX_BODY_BYTES) { over = true; continue }
    chunks.push(chunk)
  }
  if (over) throw Object.assign(new Error('body-too-large'), { status: 413 })
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid-json'), { status: 400 })
  }
}

function parsePath(url) {
  const parsed = new URL(url ?? '/', 'http://relay')
  const parts = parsed.pathname.split('/').filter(Boolean)
  // ['link', room, verb]
  if (parts.length !== 3 || parts[0] !== 'link') return null
  return { room: decodeURIComponent(parts[1]), verb: parts[2], query: parsed.searchParams }
}

const ROOM_PATTERN = /^[a-f0-9]{8,64}$/

function keyOf(request, query, name) {
  const header = request.headers[name]
  if (typeof header === 'string' && header.length > 0) return header
  return query.get('key') ?? undefined
}

/** Drop long-poll waiters that nobody will answer, so sockets do not pile up. */
function releaseWaiters(room) {
  for (const waiter of room.waiters) waiter([])
  room.waiters.clear()
}

/** One request: the whole protocol, also reused by the in-process relay. */
async function handleRequest(request, response) {
  try {
    const parsed = parsePath(request.url)
    if (parsed === null) {
      if ((request.url ?? '').startsWith('/health')) {
        json(response, 200, { ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) })
        return
      }
      json(response, 404, { ok: false, error: 'not-found' })
      return
    }

    const { room: roomId, verb, query } = parsed
    if (!ROOM_PATTERN.test(roomId)) {
      json(response, 400, { ok: false, error: 'bad-room' })
      return
    }

    // health needs no key: it is how a panel decides whether the relay is reachable.
    if (verb === 'health' && request.method === 'GET') {
      const room = rooms.get(roomId)
      json(response, 200, {
        ok: true,
        relay: true,
        registered: room !== undefined,
        hostSeenAt: room?.hostSeenAt ?? 0,
        clientSeenAt: room?.clientSeenAt ?? 0,
        queued: room?.queue.length ?? 0,
      })
      return
    }

    // The desktop creates the room on its first pull; other verbs must match its key.
    const presented = keyOf(request, query, 'x-link-key')
    const existing = rooms.get(roomId)
    if (existing !== undefined && !keyMatches(existing, presented)) {
      json(response, 401, { ok: false, error: 'bad-key' })
      return
    }
    if (existing === undefined && (typeof presented !== 'string' || presented.length < 16)) {
      json(response, 401, { ok: false, error: 'key-required' })
      return
    }

    const room = existing ?? roomFor(roomId, digest(presented))
    room.touchedAt = Date.now()

    if (verb === 'pull' && request.method === 'GET') {
      room.hostSeenAt = Date.now()
      const since = Number(query.get('since') ?? '0')
      const onlyAfter = Number.isFinite(since) ? since : 0

      const ready = room.queue.filter((frame) => frame.id > onlyAfter)
      if (ready.length > 0) {
        json(response, 200, { ok: true, frames: ready, now: room.nextId })
        return
      }

      let settled = false
      const finish = (frames) => {
        if (settled) return
        settled = true
        room.waiters.delete(finish)
        clearTimeout(timer)
        if (!response.writableEnded) json(response, 200, { ok: true, frames, now: room.nextId })
      }
      const timer = setTimeout(() => finish([]), PULL_TIMEOUT_MS)
      room.waiters.add(finish)
      request.on('close', () => {
        if (!settled) {
          settled = true
          room.waiters.delete(finish)
          clearTimeout(timer)
        }
      })
      return
    }

    if (verb === 'result' && request.method === 'POST') {
      room.hostSeenAt = Date.now()
      const body = await readBody(request)
      const resolve = room.pending.get(body?.id)
      if (resolve === undefined) {
        json(response, 200, { ok: true, dropped: true })
        return
      }
      room.pending.delete(body.id)
      resolve({ status: Number(body.status) || 200, body: body.body ?? null })
      json(response, 200, { ok: true })
      return
    }

    if (verb === 'call' && request.method === 'POST') {
      room.clientSeenAt = Date.now()
      const body = await readBody(request)
      if (room.queue.length >= MAX_QUEUE) {
        json(response, 429, { ok: false, error: 'busy' })
        return
      }
      // 45 秒：桌面的轮询是「25 秒挂起 + ≤12 秒退避 + 抖动」，最坏 38 秒左右
      // 必然刷新一次。阈值 45 秒在真离线与「退避间隙」之间留了余量，
      // 以前是 60 秒，桌面半分钟没应答手机才开始报「电脑不在线」，体感太钝。
      if (room.hostSeenAt === 0 || Date.now() - room.hostSeenAt > 45_000) {
        json(response, 503, { ok: false, error: 'host-offline' })
        return
      }

      const id = room.nextId
      room.nextId += 1
      const frame = { id, method: String(body.method ?? 'GET'), path: String(body.path ?? '/'), body: body.body ?? null }
      // 字节记账按序列化长度算：与真正占的内存同一量级，够用来挡住「大图把队列撑爆」
      frame.bytes = frame.body === null ? 0 : Buffer.byteLength(JSON.stringify(frame.body))
      if (room.queueBytes + frame.bytes > MAX_ROOM_QUEUE_BYTES) {
        json(response, 413, { ok: false, error: 'queue-too-large' })
        return
      }
      room.queueBytes += frame.bytes
      room.queue.push(frame)
      // Waiters exist only while a pull is parked; waking one is enough.
      for (const waiter of room.waiters) {
        waiter(room.queue.filter((item) => item.id > 0))
        room.waiters.delete(waiter)
        break
      }

      const answered = await new Promise((resolve) => {
        room.pending.set(id, resolve)
        setTimeout(() => {
          if (room.pending.delete(id)) resolve({ status: 504, body: { ok: false, error: 'host-timeout' } })
        }, CALL_TIMEOUT_MS).unref?.()
      })

      // Drop every frame this call produced; the phone never re-reads history.
      for (const item of room.queue) {
        if (item.id <= id) room.queueBytes = Math.max(0, room.queueBytes - (item.bytes || 0))
      }
      room.queue = room.queue.filter((item) => item.id > id)
      json(response, answered.status, answered.body ?? { ok: false, error: 'empty' })
      return
    }

    json(response, 404, { ok: false, error: 'unknown-verb' })
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500
    json(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Start a relay and hand back its real port.
 *
 * Importable on purpose: the desktop plugin can host its own relay instead of
 * asking a fresh install to run a second process. `port: 0` lets the OS pick a
 * free one, which is what the panel does when 8787 is already taken.
 *
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<{ port: number, host: string, close: () => Promise<void> }>}
 */
export function startRelay({ port = 8787, host = '0.0.0.0' } = {}) {
  const server = createServer(handleRequest)
  return new Promise((resolve, reject) => {
    const onReady = () => {
      server.removeListener('error', onError)
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : port,
        host,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            setTimeout(done, 1500).unref?.()
          }),
      })
    }
    const onError = (error) => {
      server.removeListener('listening', onReady)
      reject(error)
    }
    server.once('error', onError)
    server.once('listening', onReady)
    server.listen(port, host)
  })
}

/** Keep the room table from growing without bound. */
setInterval(() => {
  const cutoff = Date.now() - ROOM_IDLE_MS
  for (const [id, room] of rooms) {
    if (room.touchedAt < cutoff) {
      releaseWaiters(room)
      rooms.delete(id)
    }
  }
}, 10 * 60 * 1000).unref?.()

/* Run as a standalone process only when invoked directly; importing this module
 * (the plugin does) must not bind anything. */
const SELF = fileURLToPath(import.meta.url)
const ENTRY = process.argv[1] === undefined ? '' : resolvePath(process.argv[1])

if (ENTRY === SELF) {
  startRelay({ port: PORT, host: HOST }).then(
    (relay) => {
      const shown = HOST === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : HOST
      process.stdout.write(`dsh-mobile-link relay listening on http://${shown}:${relay.port}\n`)
      process.stdout.write(`health: http://127.0.0.1:${relay.port}/health\n`)
    },
    (error) => {
      process.stderr.write(`relay failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      process.exit(0)
    })
  }
}
