/**
 * 直连/隧道共用的 RPC 服务 —— 只监听 127.0.0.1，由隧道或本机端口映射把它露出去。
 *
 * 为什么单独一层：中继那条路是「电脑出站去拉请求」，跨网直连/隧道是「别人打进来」。
 * 打进来的这一路必须自己守住门：
 *   - 只绑 loopback，公网侧只有隧道/映射能看到；
 *   - 请求体是 e2e.mjs 的信封，解不开就等于不存在（不回具体原因，不给探测者区分信号）；
 *   - 处理函数与中继走同一个 `handle()`，权限口径不分叉。
 */

import http from 'node:http'
import { decryptJson, encryptJson } from './e2e.mjs'

const MAX_BODY = 8_000_000

/**
 * @param {object} o
 * @param {number} [o.port] 固定端口；0 表示让系统挑一个空闲端口
 * @param {() => string} o.roomKey 当前房间口令（面板重置后会变，所以要现取）
 * @param {(input: object) => Promise<any>} o.handle 与中继同一个请求处理函数
 * @param {() => string} [o.hostName] 面板/手机显示用的机器名
 */
/**
 * 一条 RPC 的请求处理函数，HTTP 与 HTTPS 两种挂载方式共用。
 *
 * 为什么要抽出来：隧道那一跳和直连那一跳面对的是同一批手机请求，任何一处实现细节
 * （信封版本、错误码、解不开时的措辞）两边不一致，手机端的诊断就会自相矛盾。
 *
 * @param {object} o
 * @param {() => string} o.roomKey 现取房间口令（面板重置后会变）
 * @param {(input: object) => Promise<any>} o.handle 与中继同一个请求处理函数
 * @param {() => string} [o.hostName]
 * @param {() => object} [o.helloExtra] 直连要在这里多报一个证书指纹
 * @param {(string) => void} [o.log]
 */
export function createRpcHandler({ roomKey, handle, hostName = '', helloExtra = null, log = () => {} }) {
  return (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === '/mobile-link/hello') {
      // 不带任何秘密：只是让手机能确认"我连到的这台机器确实是它"，并显示名字
      send(200, { ok: true, product: 'dsh-mobile-link', host: hostName, ts: Date.now(), ...(helloExtra?.() ?? {}) })
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/mobile-link/rpc') {
      send(404, { ok: false, error: 'not-found' })
      return
    }

    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > MAX_BODY) req.destroy()
    })
    req.on('error', () => send(400, { ok: false, error: 'bad-request' }))
    req.on('end', async () => {
      const key = roomKey()
      let input
      try {
        input = decryptJson(JSON.parse(raw || '{}'), key)
      } catch {
        input = null
      }
      if (!input || typeof input.path !== 'string') {
        log('rpc: 拒绝一个解不开/不合法的请求')
        send(401, { ok: false, error: 'unauthorized' })
        return
      }
      try {
        const result = await handle({
          method: String(input.method || 'GET'),
          path: input.path,
          headers: input.headers || {},
          body: input.body ?? null,
        })
        send(200, encryptJson({ ok: true, result }, key))
      } catch (e) {
        send(200, encryptJson({ ok: false, error: e?.message || 'handler-failed', code: e?.code }, key))
      }
    })
  }
}

export function startRpc({ port = 0, roomKey, handle, hostName = '', log = () => {} }) {
  const server = http.createServer(createRpcHandler({ roomKey, handle, hostName, log }))

  server.on('error', (e) => log(`rpc: 监听失败 ${e.message || e}`))
  server.listen(port, '127.0.0.1')

  return {
    get port() { return server.address()?.port ?? 0 },
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * 配对串：面板复制、手机粘贴的一行文本。
 * 为什么用整串而不是让用户抄三个字段：房间口令是 128 bit，手抄不现实；
 * 隧道地址又是随机的，抄错一位就是"连不上"。一行粘贴把这两件事都消掉。
 */
export function pairingString(o) {
  return 'dshlink1:' + Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
}

export function parsePairingString(s) {
  const text = String(s || '').trim()
  if (!text.startsWith('dshlink1:')) return null
  try {
    const o = JSON.parse(Buffer.from(text.slice('dshlink1:'.length), 'base64url').toString('utf8'))
    if (!o || typeof o.url !== 'string' || !/^https:\/\//i.test(o.url)) return null
    if (typeof o.key !== 'string' || o.key.length < 8) return null
    return { url: o.url.replace(/\/+$/, ''), key: o.key, host: String(o.host || ''), mode: o.mode === 'direct' ? 'direct' : 'tunnel', fp: String(o.fp || '') }
  } catch {
    return null
  }
}
