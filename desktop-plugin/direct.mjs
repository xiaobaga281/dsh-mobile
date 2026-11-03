/**
 * 广域网直连（无中继）—— 电脑端这一半。
 *
 * 为什么需要它：内置中继只监听本机，所以开箱范围是「同一局域网」；跨网原本要求用户
 * 自己部署一台公网中继，而多数用户给不了这个便利。IPv6 没有 NAT，手机流量侧与家宽的
 * IPv6 覆盖率都很高 —— 只要这台机器有全局 IPv6（或用户本来就有公网 IPv4 / 做了端口映射），
 * 手机就能直接连它，不需要任何第三方。
 *
 * 信任模型：端口是**开在公网上**的，所以
 *   - 只走 HTTPS，证书自签并把 SHA-256 指纹显示在面板上；手机首次连接要用户核对指纹（TOFU），
 *     之后按指纹固定，不接受任何别的证书；
 *   - 每个请求都要带房间口令（timing-safe 比较），口令错就等于没这个接口；
 *   - 处理函数与中继走的是同一个 `handle()`，权限口径不可能两边分叉。
 *
 * 证书在这里自己编 DER（Node 没有内置的证书生成器）。X.509 v1 + SHA256withRSA，
 * 与手机端 `SelfSignedKey` 同一思路：既然要按指纹信任，就不需要 CA 链，也不需要 SAN。
 */

import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { networkInterfaces } from 'node:os'
import https from 'node:https'

import { createRpcHandler } from './rpc.mjs'

const OID = {
  sha256Rsa: '1.2.840.113549.1.1.11',
  rsa: '1.2.840.113549.1.1.1',
  cn: '2.5.4.3',
  org: '2.5.4.10',
  country: '2.5.4.6',
}

/* ---------------- DER 原语（与手机端 SelfSignedKey 同构） ---------------- */

function tlv(tag, content) {
  const len = content.length
  let head
  if (len < 0x80) head = Buffer.from([tag, len])
  else if (len < 0x100) head = Buffer.from([tag, 0x81, len])
  else head = Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff])
  return Buffer.concat([head, content])
}

const seq = (...parts) => tlv(0x30, Buffer.concat(parts))
const set = (...parts) => tlv(0x31, Buffer.concat(parts))
const octet = (v) => tlv(0x04, v)
const bitString = (v) => tlv(0x03, Buffer.concat([Buffer.from([0]), v]))
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))
const printable = (s) => tlv(0x13, Buffer.from(s, 'ascii'))
const nullDer = () => Buffer.from([0x05, 0x00])

function oid(dotted) {
  const parts = dotted.split('.').map(Number)
  const bytes = [parts[0] * 40 + parts[1]]
  for (const p of parts.slice(2)) {
    // base-128：除了最低位那一字节，其余都要带续接位 —— 生成顺序是从低到高，
    // 所以「栈里已有字节」才意味着这一字节后面还有内容，需要 0x80
    const stack = []
    let v = p
    do {
      let b = v & 0x7f
      v = Math.floor(v / 128)
      if (stack.length > 0) b |= 0x80
      stack.unshift(b)
    } while (v > 0)
    bytes.push(...stack)
  }
  return tlv(0x06, Buffer.from(bytes))
}

/** DER INTEGER：Node 的 BigInt 字节自己处理符号位（正数最高位为 1 时要补 0x00） */
function derInt(value) {
  let bytes = value instanceof Buffer ? [...value] : [...BigInt.asUintN(128, BigInt(value)).toString(16).match(/.{2}/g).map((h) => parseInt(h, 16))]
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1)
  if (bytes[0] & 0x80) bytes = [0, ...bytes]
  return tlv(0x02, Buffer.from(bytes))
}

function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0')
  const s = p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate())
    + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z'
  return tlv(0x17, Buffer.from(s, 'ascii'))
}

/* ---------------- 证书 ---------------- */

/**
 * 自签 X.509（v1）。返回 { keyPem, certPem, certDer, fingerprint }。
 * fingerprint 是证书 DER 的 SHA-256 十六进制小写 —— 面板显示它，手机按它固定。
 */
export function makeSelfSigned({ commonName = 'dsh-mobile-link', organization = 'DeepSeek Harness', country = 'CN', validityDays = 3650 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  // Node 直接给出 DER 的 SPKI / PKCS#8，正好是证书里要放的那段，不必自己编 RSA 参数
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const algId = seq(oid(OID.sha256Rsa), nullDer())
  const name = seq(set(seq(oid(OID.cn), utf8(commonName))), set(seq(oid(OID.org), utf8(organization))), set(seq(oid(OID.country), printable(country))))
  const notBefore = new Date(Date.now() - 5 * 60_000)
  const notAfter = new Date(notBefore.getTime() + validityDays * 86_400_000)
  const serial = derInt(createHash('sha256').update(spki).digest().subarray(0, 16))

  const tbs = seq(
    serial,
    algId,
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
  )
  const signature = Buffer.from(edSign('sha256', tbs, privateKey))
  const certDer = seq(tbs, algId, bitString(signature))
  const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certPem: pem('CERTIFICATE', certDer),
    certDer,
    fingerprint: createHash('sha256').update(certDer).digest('hex'),
  }
}

/* ---------------- 地址探测 ---------------- */

/**
 * 这台机器上「手机可能连得到」的地址：全局 IPv6 优先（IPv6 没有 NAT），其次 IPv4。
 * 链路本地 IPv6（fe80::）与内网 IPv4 仍然列出，但标出 scope，让界面能说实话：
 * 内网地址只在同一局域网有用。
 */
export function candidateAddresses() {
  const out = []
  const ifs = networkInterfaces()
  for (const [name, list] of Object.entries(ifs)) {
    for (const i of list || []) {
      if (i.internal) continue
      if (i.family === 'IPv6' || i.family === 6) {
        const ip = i.address
        const global = !ip.startsWith('fe80') && !ip.startsWith('fc') && !ip.startsWith('fd')
        out.push({ name, family: 6, address: ip, reachable: global, note: global ? '全局 IPv6（跨网可直连）' : '本地/内网 IPv6（仅同网）' })
      } else if (i.family === 'IPv4' || i.family === 4) {
        const ip = i.address
        const priv = ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith('127.')
        out.push({ name, family: 4, address: ip, reachable: !priv, note: priv ? '内网 IPv4（仅同一局域网）' : '公网 IPv4（可直连）' })
      }
    }
  }
  // 全局 IPv6 排在前面：那是「不需要任何中继也不需要公网 IPv4」的那条路
  return out.sort((a, b) => (b.reachable - a.reachable) || (b.family - a.family))
}

/** 面板与连接串用的 URL 字面量：IPv6 必须带方括号，否则手机解析不了 */
export function urlFor(address, port) {
  const host = address.includes(':') ? `[${address}]` : address
  return `https://${host}:${port}`
}

/* ---------------- 服务 ---------------- */

/**
 * 起直连 HTTPS 服务。
 *
 * 请求体同样是 e2e 信封：直连时 TLS 已经是端到端（自签 + 指纹固定），
 * 但仍走与隧道完全一致的 `createRpcHandler`，手机只需要一种客户端实现。
 *
 * @param {object} o
 * @param {number} o.port 监听端口
 * @param {string|(() => string)} o.key 房间口令（给配对串用；重置后要能生效）
 * @param {(input: object) => Promise<any>} o.handle 与中继同一个请求处理函数
 * @param {string} o.hostName 面板显示用的机器名
 * @param {{keyPem:string,certPem:string,fingerprint:string}} [o.cert] 复用已落盘证书，重启不换指纹
 * @param {(string)=>void} [o.log]
 */
export function startDirect({ port, key, handle, hostName = '', cert = null, log = () => {} }) {
  const material = cert && cert.certPem ? cert : makeSelfSigned()
  const roomKey = typeof key === 'function' ? key : () => key

  const server = https.createServer(
    { key: material.keyPem, cert: material.certPem },
    createRpcHandler({
      roomKey,
      handle,
      hostName,
      // 指纹要在握手前就能看到，否则手机无从核对「这台机器是不是我以为的那台」
      helloExtra: () => ({ fingerprint: material.fingerprint }),
      log,
    }),
  )
  server.on('error', (e) => {
    // '::' 监听不了（容器/禁用 IPv6 的主机）就退回 IPv4 —— 直连这一路不该因为栈缺失而起不来
    if (e?.code === 'EADDRINUSE' || e?.code === 'EACCES') { log(`direct: 端口不可用 ${e.code}`); return }
    if (bound === 'ipv6') {
      bound = 'ipv4'
      try {
        server.listen(port, '0.0.0.0')
        log('direct: 本机没有 IPv6 栈，改用 IPv4 监听')
      } catch (e2) {
        log(`direct: 监听失败 ${e2?.message || e2}`)
      }
      return
    }
    log(`direct: 监听失败 ${e.message || e}`)
  })
  // 先试双栈：有 IPv6 的机器同时收 IPv4，用户不必二选一
  let bound = 'ipv6'
  server.listen(port, '::')

  return {
    fingerprint: material.fingerprint,
    cert: material,
    port,
    server,
    /** 实际监听端口：测试与端口映射要看它，用户配的可能是 0 */
    get boundPort() { return server.address()?.port ?? port },
    get addresses() { return candidateAddresses().map((a) => ({ ...a, url: urlFor(a.address, port) })) },
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}

/* ---------------- 证书落盘（重启不换指纹，否则手机每次都要重新核对） ---------------- */

export function loadOrCreateCert(file) {
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (saved?.certPem && saved?.keyPem && saved?.fingerprint) {
        return { keyPem: saved.keyPem, certPem: saved.certPem, certDer: Buffer.from(saved.certDer || '', 'base64'), fingerprint: saved.fingerprint }
      }
    } catch {
      /* 读坏了就重新生成，不假装还能用 */
    }
  }
  const fresh = makeSelfSigned()
  const dir = dirname(file)
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify({
    certPem: fresh.certPem, keyPem: fresh.keyPem,
    certDer: fresh.certDer.toString('base64'), fingerprint: fresh.fingerprint,
    createdAt: Date.now(),
  }, null, 2))
  return fresh
}
