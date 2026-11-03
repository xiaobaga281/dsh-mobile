/**
 * 端到端加密的一小层 —— 让「中间那一段」看不到内容。
 *
 * 为什么要它：跨网走 Cloudflare 隧道（或任何第三方中继）时，TLS 在对方边缘终结，
 * 那一跳理论上能看到明文。我们不改架构去追求"绝对零信任"，但要做到
 * **中间层只能看到密文与长度**：手机与电脑用房间口令派生同一把 AES-256-GCM 会话密钥，
 * 隧道只搬运密文。房间口令本身不再以明文出现在任何中间层可见的位置。
 *
 * 算法（两端必须逐字节一致，手机端在 LinkCrypto.kt）：
 *   key   = HKDF-SHA256(ikm=utf8(roomKey), salt="dsh-mobile-link-v1", info="rpc-aes-256-gcm", len=32)
 *   信封  = { v:1, iv:base64(12B), ct:base64, tag:base64(16B) }   明文 = JSON 字符串的 UTF-8 字节
 */

import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

const SALT = 'dsh-mobile-link-v1'
const INFO = 'rpc-aes-256-gcm'

/** HKDF-SHA256，只取一个块（32 字节够用，省掉 counter 循环） */
export function hkdf(secret, len = 32) {
  const prk = createHmac('sha256', Buffer.from(SALT, 'utf8'))
    .update(Buffer.from(secret, 'utf8')).digest()
  const okm = createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(INFO, 'utf8'), Buffer.from([0x01])])).digest()
  return okm.subarray(0, len)
}

export function encryptJson(obj, roomKey) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', hkdf(roomKey), iv)
  const plain = Buffer.from(JSON.stringify(obj), 'utf8')
  const ct = Buffer.concat([c.update(plain), c.final()])
  const tag = c.getAuthTag()
  return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') }
}

/** 解不开就返回 null：口令错、被截断、版本不对，一律同一个结果，不给探测者区分信号 */
export function decryptJson(envelope, roomKey) {
  try {
    if (!envelope || envelope.v !== 1) return null
    const iv = Buffer.from(String(envelope.iv || ''), 'base64')
    const ct = Buffer.from(String(envelope.ct || ''), 'base64')
    const tag = Buffer.from(String(envelope.tag || ''), 'base64')
    if (iv.length !== 12 || tag.length !== 16 || ct.length === 0 || ct.length > 8_000_000) return null
    const d = createDecipheriv('aes-256-gcm', hkdf(roomKey), iv)
    d.setAuthTag(tag)
    const plain = Buffer.concat([d.update(ct), d.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    return null
  }
}

/** 口令比较：等长才走 timingSafeEqual（它不等长会抛）；空口令永远不算匹配 —— 口令没设好时不能谁都能连 */
export function keyMatches(got, want) {
  const a = Buffer.from(String(got || ''), 'utf8')
  const b = Buffer.from(String(want || ''), 'utf8')
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}
