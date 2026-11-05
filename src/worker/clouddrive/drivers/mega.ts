/**
 * MEGA account driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/mega` plus the public MEGA protocol as
 * implemented by megajs. The upstream reference only listed nodes with the server-provided
 * (still encrypted) names and had no crypto; this driver performs the real client-side crypto:
 *
 *   login:  PBKDF2-SHA512 (v2) or the 65536-round AES-ECB key loop (v1)
 *           -> user hash / session id (RSA-1024 PKCS#1 block) / master key
 *   nodes:  master key -> folder key -> file key chain (AES-ECB key wrapping)
 *           -> AES-CBC attributes ("MEGA{...json}")
 *   read:   AES-CTR (key = k[0..16] XOR k[16..32], nonce = k[16..24]) over the `g` URL
 *   write:  AES-CTR + MEGA MAC, node key wrapped with the parent folder key
 *
 * Only WebCrypto and the pure-JS `@noble/ciphers` / `@noble/hashes` primitives are used; no
 * Node-only APIs (no `node:crypto`, no Buffer).
 */
import { ctr, ecb } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  asBytes,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
} from './contract'
import {
  HttpDriverBase,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const API_BASE = 'https://g.api.mega.co.nz/cs'
const DEFAULT_NODE_TYPE_DRIVE = 2
const NODE_TYPE_FILE = 0
const NODE_TYPE_FOLDER = 1
const NODE_TYPE_TRASH = 4
const SNAPSHOT_TTL_MS = 30_000
const ENCRYPT_CHUNK = 4 * 1024 * 1024

interface MegaRawNode {
  h: string
  p?: string
  t: number
  a?: string
  k?: string
  s?: number
  ts?: number
  u?: string
}

interface MegaNode {
  handle: string
  parent?: string
  name: string
  size: number
  modifiedAt: number
  folder: boolean
  type: number
  /** Raw (decrypted) MEGA node key: 16 bytes for folders, 32 bytes for files. */
  key: Uint8Array | null
  attributes: Record<string, unknown>
}

interface MegaSessionUser {
  u?: string
  name?: string
}

interface MegaGResponse {
  g?: string
  s?: number
}

interface MegaUploadSlot {
  p?: string
}

interface MegaListResponse {
  f?: MegaRawNode[]
  ph?: Array<{ h: string; ph: string }>
}

interface RsaPrivateKey {
  p: bigint
  q: bigint
  d: bigint
  u: bigint
  n: bigint
  bytes: number
}

const KEY_INITIAL = new Uint8Array([147, 196, 103, 227, 125, 176, 199, 164, 209, 190, 63, 129, 1, 82, 203, 86])
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder()

function zeroPadTo(value: Uint8Array, block: number): Uint8Array {
  const length = Math.ceil(value.length / block) * block
  if (length === value.length) return value
  const out = new Uint8Array(length)
  out.set(value)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function base64UrlEncode(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += BASE64URL_ALPHABET[(value >> bits) & 0x3f]
    }
  }
  if (bits > 0) out += BASE64URL_ALPHABET[(value << (6 - bits)) & 0x3f]
  return out
}

function base64UrlDecode(value: string): Uint8Array {
  const text = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/g, '')
  const binary = atob(text.padEnd(Math.ceil(text.length / 4) * 4, '='))
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = '0x0'
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return BigInt(hex)
}

function bigIntToBytes(value: bigint): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index++) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return out
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n
  let result = 1n
  let current = base % modulus
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * current) % modulus
    current = (current * current) % modulus
    power >>= 1n
  }
  return result
}

/** AES-128 ECB, one block, no padding. */
function aesBlockEncrypt(key: Uint8Array, block: Uint8Array): Uint8Array {
  return ecb(key, { disablePadding: true }).encrypt(block)
}

function aesBlockDecrypt(key: Uint8Array, block: Uint8Array): Uint8Array {
  return ecb(key, { disablePadding: true }).decrypt(block)
}

/** MEGA wraps keys with AES-128 ECB; the payload is always block aligned. */
function aesEcbEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const padded = zeroPadTo(data, 16)
  const out = new Uint8Array(padded.length)
  for (let offset = 0; offset < padded.length; offset += 16) {
    out.set(aesBlockEncrypt(key, padded.subarray(offset, offset + 16)), offset)
  }
  return out
}

function aesEcbDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const padded = zeroPadTo(data, 16)
  const out = new Uint8Array(padded.length)
  for (let offset = 0; offset < padded.length; offset += 16) {
    out.set(aesBlockDecrypt(key, padded.subarray(offset, offset + 16)), offset)
  }
  return out
}

/** AES-CBC with a zero IV, no padding; inputs are already 16-byte multiples. */
function aesCbcEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const padded = zeroPadTo(data, 16)
  const out = new Uint8Array(padded.length)
  let previous: Uint8Array = new Uint8Array(16)
  for (let offset = 0; offset < padded.length; offset += 16) {
    const block = new Uint8Array(16)
    for (let index = 0; index < 16; index++) block[index] = padded[offset + index]! ^ previous[index]!
    const encrypted = aesBlockEncrypt(key, block)
    out.set(encrypted, offset)
    previous = encrypted
  }
  return out
}

function aesCbcDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const padded = zeroPadTo(data, 16)
  const out = new Uint8Array(padded.length)
  let previous: Uint8Array = new Uint8Array(16)
  for (let offset = 0; offset < padded.length; offset += 16) {
    const cipher = padded.subarray(offset, offset + 16)
    const decrypted = aesBlockDecrypt(key, cipher)
    for (let index = 0; index < 16; index++) out[offset + index] = decrypted[index]! ^ previous[index]!
    previous = new Uint8Array(cipher)
  }
  return out
}

/** MEGA's legacy `prepareKey`: 65536 rounds of four AES-ECB passes over the password words. */
function prepareKey(password: string): Uint8Array {
  const passwordBytes = utf8.encode(password)
  let key: Uint8Array = new Uint8Array(KEY_INITIAL)
  for (let round = 0; round < 65536; round++) {
    for (let offset = 0; offset < passwordBytes.length; offset += 16) {
      const blockKey = new Uint8Array(16)
      for (let index = 0; index < 16; index += 4) {
        if (index + offset < passwordBytes.length) {
          blockKey.set(passwordBytes.subarray(index + offset, Math.min(index + offset + 4, passwordBytes.length)), index)
        }
      }
      key = aesEcbEncrypt(blockKey, key)
    }
  }
  return key
}

/** MEGA's v1 `stringhash`: an AES-ECB based 64-bit hash over the (lowercased) email. */
function stringHash(key: Uint8Array, text: string): Uint8Array {
  const bytes = utf8.encode(text)
  const words = new Uint32Array(4)
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const remaining = Math.min(4, bytes.length - offset)
    let word = 0
    for (let index = 0; index < remaining; index++) word = (word << 8) | bytes[offset + index]!
    if (remaining < 4) word <<= (4 - remaining) * 8
    words[(offset / 4) & 3] ^= word >>> 0
  }
  let hash: Uint8Array = new Uint8Array(16)
  for (let index = 0; index < 4; index++) {
    hash[index * 4] = (words[index]! >>> 24) & 0xff
    hash[index * 4 + 1] = (words[index]! >>> 16) & 0xff
    hash[index * 4 + 2] = (words[index]! >>> 8) & 0xff
    hash[index * 4 + 3] = words[index]! & 0xff
  }
  for (let round = 0; round < 16384; round++) hash = aesBlockEncrypt(key, hash)
  return new Uint8Array([hash[0]!, hash[1]!, hash[2]!, hash[3]!, hash[8]!, hash[9]!, hash[10]!, hash[11]!])
}

/** MEGA's node MAC: AES-ECB over the XOR-chain, condensed to eight bytes. */
class MegaMac {
  private readonly key: Uint8Array
  private mac: Uint8Array
  private readonly blocks: Uint8Array[] = []

  constructor(key: Uint8Array, nonce: Uint8Array) {
    this.key = key
    this.mac = concat(nonce, nonce)
  }

  update(data: Uint8Array): void {
    const padded = zeroPadTo(data, 16)
    for (let offset = 0; offset < padded.length; offset += 16) {
      for (let index = 0; index < 16; index++) this.mac[index] = this.mac[index]! ^ padded[offset + index]!
      this.mac = aesBlockEncrypt(this.key, this.mac)
    }
  }

  condense(): Uint8Array {
    this.blocks.push(this.mac)
    let folded: Uint8Array = new Uint8Array(16)
    for (const block of this.blocks) {
      for (let index = 0; index < 16; index++) folded[index] = folded[index]! ^ block[index]!
      folded = aesBlockEncrypt(this.key, folded)
    }
    return new Uint8Array([
      folded[0]! ^ folded[4]!,
      folded[1]! ^ folded[5]!,
      folded[2]! ^ folded[6]!,
      folded[3]! ^ folded[7]!,
      folded[8]! ^ folded[12]!,
      folded[9]! ^ folded[13]!,
      folded[10]! ^ folded[14]!,
      folded[11]! ^ folded[15]!,
    ])
  }
}

function mergeKeyMac(key: Uint8Array, mac: Uint8Array): Uint8Array {
  const merged = new Uint8Array(32)
  merged.set(key, 0)
  merged.set(mac, 24)
  for (let index = 0; index < 16; index++) merged[index] = merged[index]! ^ merged[index + 16]!
  return merged
}

function unmergeKeyMac(stored: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  out.set(stored)
  for (let index = 0; index < 16; index++) out[index] = out[index]! ^ out[index + 16]!
  return out
}

/** Counter block for AES-CTR at a given block offset: 8-byte nonce + 8-byte big-endian counter. */
function counterBlock(nonce: Uint8Array, blockIndex: number): Uint8Array {
  const out = new Uint8Array(16)
  out.set(nonce.subarray(0, 8), 0)
  let index = blockIndex
  for (let position = 15; position >= 8; position--) {
    out[position] = index & 0xff
    index = Math.floor(index / 256)
  }
  return out
}

/** Stateful decryptor that keeps block alignment across arbitrarily sized stream chunks. */
class MegaCtrDecryptor {
  private readonly key: Uint8Array
  private readonly nonce: Uint8Array
  private remainder: Uint8Array = new Uint8Array(0)
  private blockIndex = 0

  constructor(key: Uint8Array, nonce: Uint8Array) {
    this.key = key
    this.nonce = nonce
  }

  process(chunk: Uint8Array): Uint8Array {
    const combined = this.remainder.length ? concat(this.remainder, chunk) : chunk
    const fullLength = Math.floor(combined.length / 16) * 16
    const out = new Uint8Array(fullLength)
    if (fullLength > 0) {
      const cipher = ctr(this.key, counterBlock(this.nonce, this.blockIndex))
      out.set(cipher.decrypt(combined.subarray(0, fullLength)))
      this.blockIndex += fullLength / 16
    }
    this.remainder = combined.subarray(fullLength)
    return out
  }

  finish(): Uint8Array {
    if (this.remainder.length === 0) return new Uint8Array(0)
    const cipher = ctr(this.key, counterBlock(this.nonce, this.blockIndex))
    const out = cipher.decrypt(this.remainder)
    this.remainder = new Uint8Array(0)
    return out
  }
}

function packAttributes(attributes: Record<string, unknown>): Uint8Array {
  return zeroPadTo(utf8.encode(`MEGA${JSON.stringify(attributes)}`), 16)
}

function unpackAttributes(data: Uint8Array): Record<string, unknown> | null {
  const text = utf8Decoder.decode(data)
  if (!text.startsWith('MEGA{')) return null
  const terminator = text.indexOf('\0')
  const payload = terminator >= 0 ? text.slice(4, terminator) : text.slice(4)
  try {
    const parsed = JSON.parse(payload) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function readMpi(data: Uint8Array, state: { offset: number }): Uint8Array | null {
  if (state.offset + 2 > data.length) return null
  const bits = (data[state.offset]! * 256) + data[state.offset + 1]!
  const length = Math.ceil(bits / 8)
  state.offset += 2
  if (state.offset + length > data.length) return null
  const value = data.subarray(state.offset, state.offset + length)
  state.offset += length
  return value
}

/**
 * MEGA stores the account RSA key as four MPIs: p, q, d and p^-1 mod q. The leading AES-ECB
 * layer has already been removed by the caller.
 */
function parseRsaPrivateKey(data: Uint8Array): RsaPrivateKey | null {
  const state = { offset: 0 }
  const parts: Uint8Array[] = []
  for (let index = 0; index < 4; index++) {
    const part = readMpi(data, state)
    if (!part) return null
    parts.push(part)
  }
  const p = bytesToBigInt(parts[0]!)
  const q = bytesToBigInt(parts[1]!)
  const d = bytesToBigInt(parts[2]!)
  const u = bytesToBigInt(parts[3]!)
  if (p === 0n || q === 0n) return null
  return { p, q, d, u, n: p * q, bytes: Math.ceil((p * q).toString(16).length / 2) }
}

function rsaDecrypt(ciphertext: Uint8Array, key: RsaPrivateKey): Uint8Array {
  const c = bytesToBigInt(ciphertext)
  const xp = modPow(c % key.p, key.d % (key.p - 1n), key.p)
  const xq = modPow(c % key.q, key.d % (key.q - 1n), key.q)
  const t = ((((xq - xp) % key.q) + key.q) % key.q * key.u) % key.q
  return bigIntToBytes(t * key.p + xp)
}

function base32Decode(value: string): Uint8Array {
  const text = value.replace(/=+/g, '').replace(/\s+/g, '').toUpperCase()
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of text) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) continue
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

async function totpFromSecret(secret: string): Promise<string> {
  const key = base32Decode(secret)
  if (key.length === 0) return ''
  const counter = Math.floor(Date.now() / 30_000)
  const message = new Uint8Array(8)
  let value = counter
  for (let index = 7; index >= 0; index--) {
    message[index] = value & 0xff
    value = Math.floor(value / 256)
  }
  const digest = hmac(sha1, key, message)
  const offset = digest[digest.length - 1]! & 0x0f
  const code = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!
  return String(code % 1_000_000).padStart(6, '0')
}

function errorForCode(code: number): DriverError {
  if (code === -4) return DriverError.rateLimited('MEGA is rate limiting requests; wait a few seconds and retry')
  if (code === -9) return DriverError.notFound('MEGA reports that the node does not exist')
  if (code === -15 || code === -16) return DriverError.auth('MEGA session is no longer valid')
  if (code === -26) return DriverError.auth('MEGA requires a second factor: provide the twoFaCode credential (or twoFaSecret)')
  if (code === -17 || code === -24) return DriverError.upstream('MEGA storage quota is exhausted')
  if (code === -3) return DriverError.upstream('MEGA is temporarily congested', 1_000)
  if (code === -8) return DriverError.upstream('MEGA upload target expired')
  return DriverError.upstream(`MEGA API answered error ${code}`)
}

function parseUploadHandle(body: string): string {
  let value = body.trim()
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (typeof parsed === 'string') value = parsed
    } catch {
      // Fall through to the raw body.
    }
  }
  if (!/^[A-Za-z0-9_-]{6,}$/.test(value)) {
    throw DriverError.upstream(`MEGA returned an invalid upload handle: ${value.slice(0, 40)}`)
  }
  return value
}

class MegaDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('mega')!
  readonly capabilities = this.definition.capabilities

  private sid = ''
  private masterKey: Uint8Array = new Uint8Array(0)
  private rsa: RsaPrivateKey | null = null
  private userHandle = ''
  private sequence = Math.floor(Math.random() * 0x0fffffff)
  private rawNodes: MegaRawNode[] = []
  private readonly rawByHandle = new Map<string, MegaRawNode>()
  private readonly rawChildren = new Map<string, MegaRawNode[]>()
  private readonly phByHandle = new Map<string, string>()
  private readonly nodeCache = new Map<string, MegaNode>()
  private readonly keyCache = new Map<string, Uint8Array | null>()
  private readonly childrenCache = new Map<string, MegaNode[]>()
  private accountRoot = ''
  private rootPathHandle = ''
  private nodesLoadedAt = 0

  private credential(key: string): string {
    return this.ctx.credentials[key] ?? ''
  }

  private nextSequence(): number {
    this.sequence = (this.sequence + 1) % 0x10000000
    return this.sequence
  }

  /** One `/cs` call. Negative MEGA result codes are part of the HTTP 200 body. */
  private async apiRaw<T>(request: Record<string, unknown>): Promise<T> {
    const query = new URLSearchParams({ id: String(this.nextSequence()) })
    if (this.sid) query.set('sid', this.sid)
    const payload = await this.json<unknown>(`${API_BASE}?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([request]),
    })
    const value = Array.isArray(payload) ? payload[0] : payload
    if (typeof value === 'number') {
      if (value < 0) throw errorForCode(value)
      throw DriverError.upstream(`MEGA API answered an unexpected value: ${value}`)
    }
    if (!value || typeof value !== 'object') {
      throw DriverError.upstream('MEGA returned an empty response')
    }
    return value as T
  }

  /**
   * Runs one authenticated unit of work. A failed initial login would otherwise bypass the base
   * class retry hook, so it is marked here too.
   */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.withAuth(work)
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      throw error
    }
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.sid && this.masterKey.length === 16) return
    this.sid = ''
    this.masterKey = new Uint8Array(0)
    this.rsa = null
    this.nodeCache.clear()
    this.keyCache.clear()
    this.childrenCache.clear()
    this.nodesLoadedAt = 0

    const email = this.configText('email').trim()
    const password = this.credential('password')
    if (!email) throw DriverError.auth('MEGA needs the email config field')
    if (!password) throw DriverError.auth('MEGA needs the password credential')

    const normalizedEmail = email.toLowerCase()
    let aesKey: Uint8Array
    let userHash: string

    const account = await this.apiRaw<{ v?: number; s?: string }>({ a: 'us0', user: normalizedEmail })
    if (account.v === 2) {
      if (typeof account.s !== 'string' || !account.s) {
        throw DriverError.upstream('MEGA did not return the v2 login salt')
      }
      const salt = base64UrlDecode(account.s)
      const derived = pbkdf2(sha512, utf8.encode(password), salt, { c: 100000, dkLen: 32 })
      aesKey = derived.subarray(0, 16)
      userHash = base64UrlEncode(derived.subarray(16, 32))
    } else {
      aesKey = prepareKey(password)
      userHash = base64UrlEncode(stringHash(aesKey, normalizedEmail))
    }

    const request: Record<string, unknown> = { a: 'us', user: normalizedEmail, uh: userHash }
    const code = this.credential('twoFaCode').trim()
    const secret = this.credential('twoFaSecret').trim()
    const mfa = code || (secret ? await totpFromSecret(secret) : '')
    if (mfa) request.mfa = mfa

    const auth = await this.apiRaw<{ k?: string; csid?: string; privk?: string; tsid?: string }>(request)
    if (typeof auth.tsid === 'string' && auth.tsid) {
      this.sid = auth.tsid
    } else {
      if (typeof auth.k !== 'string' || typeof auth.csid !== 'string' || typeof auth.privk !== 'string') {
        throw DriverError.auth(
          'MEGA login failed. Check the password; if the account has two-factor authentication, ' +
          'provide the twoFaCode credential (or twoFaSecret).',
        )
      }
      this.masterKey = aesEcbDecrypt(aesKey, base64UrlDecode(auth.k)).subarray(0, 16)
      const privateKeyBlock = aesEcbDecrypt(aesKey, base64UrlDecode(auth.privk))
      this.rsa = parseRsaPrivateKey(privateKeyBlock)
      if (!this.rsa) throw DriverError.auth('MEGA returned an unreadable RSA private key; the password is likely wrong')
      const sessionId = rsaDecrypt(base64UrlDecode(auth.csid), this.rsa).subarray(0, 43)
      this.sid = base64UrlEncode(sessionId)
    }

    if (this.masterKey.length !== 16) {
      throw DriverError.auth('MEGA login did not yield a usable master key')
    }

    const user = await this.apiRaw<MegaSessionUser>({ a: 'ug' })
    this.userHandle = typeof user.u === 'string' ? user.u : ''
    await this.loadNodes()
  }

  private async loadNodes(force = false): Promise<void> {
    if (!force && this.nodesLoadedAt && Date.now() - this.nodesLoadedAt < SNAPSHOT_TTL_MS) return
    const snapshot = await this.apiRaw<MegaListResponse>({ a: 'f', c: 1 })
    if (!Array.isArray(snapshot.f)) throw DriverError.upstream('MEGA did not return a node snapshot')

    this.rawNodes = snapshot.f
    this.rawByHandle.clear()
    this.rawChildren.clear()
    for (const raw of this.rawNodes) {
      this.rawByHandle.set(raw.h, raw)
      if (raw.p) {
        const siblings = this.rawChildren.get(raw.p) ?? []
        siblings.push(raw)
        this.rawChildren.set(raw.p, siblings)
      }
    }
    this.phByHandle.clear()
    for (const shared of snapshot.ph ?? []) this.phByHandle.set(shared.h, shared.ph)

    this.accountRoot = ''
    const driveRoot = this.rawNodes.find((raw) => raw.t === DEFAULT_NODE_TYPE_DRIVE)
    if (driveRoot) this.accountRoot = driveRoot.h
    if (!this.accountRoot) throw DriverError.upstream('MEGA did not return the Cloud Drive root node')

    this.nodeCache.clear()
    this.keyCache.clear()
    this.childrenCache.clear()
    this.walkNode(this.accountRoot)

    const configured = this.configText('rootFolderId').trim()
    this.rootPathHandle = configured || this.accountRoot
    if (configured && !this.rawByHandle.has(configured)) {
      throw DriverError.notFound('The configured rootFolderId does not exist in this MEGA account')
    }
    this.nodesLoadedAt = Date.now()
  }

  private keyForNode(raw: MegaRawNode): Uint8Array | null {
    if (this.keyCache.has(raw.h)) return this.keyCache.get(raw.h) ?? null
    let key: Uint8Array | null = null
    try {
      let parentKey: Uint8Array
      if (raw.h === this.accountRoot) {
        parentKey = this.masterKey
      } else if (raw.p && this.rawByHandle.has(raw.p)) {
        const parent = this.keyForNode(this.rawByHandle.get(raw.p)!)
        if (!parent || parent.length < 16) {
          this.keyCache.set(raw.h, null)
          return null
        }
        parentKey = parent.subarray(0, 16)
      } else {
        this.keyCache.set(raw.h, null)
        return null
      }

      const encoded = this.pickNodeKey(raw)
      if (!encoded) {
        this.keyCache.set(raw.h, null)
        return null
      }
      if (encoded.length > 32) {
        // Shares wrap node keys with the account RSA key.
        if (!this.rsa) throw DriverError.auth('MEGA share key requires the account RSA key')
        key = rsaDecrypt(encoded, this.rsa).subarray(0, raw.t === NODE_TYPE_FILE ? 32 : 16)
      } else {
        key = aesEcbDecrypt(parentKey, encoded).subarray(0, raw.t === NODE_TYPE_FILE ? 32 : 16)
      }
    } catch {
      key = null
    }
    this.keyCache.set(raw.h, key)
    return key
  }

  private pickNodeKey(raw: MegaRawNode): Uint8Array | null {
    if (typeof raw.k !== 'string' || !raw.k) return null
    const parts = raw.k.split('/')
    let chosen = parts[0]!
    for (const part of parts) {
      const separator = part.indexOf(':')
      if (separator < 0) continue
      const id = part.slice(0, separator)
      if (id === raw.h || id === this.userHandle) {
        chosen = part
        break
      }
    }
    const value = chosen.slice(chosen.indexOf(':') + 1)
    return value ? base64UrlDecode(value) : base64UrlDecode(chosen)
  }

  private attributeKey(type: number, key: Uint8Array): Uint8Array {
    if (type === NODE_TYPE_FILE && key.length >= 32) return unmergeKeyMac(key).subarray(0, 16)
    return key.subarray(0, 16)
  }

  private walkNode(handle: string, visited = new Set<string>()): void {
    if (visited.has(handle)) return
    visited.add(handle)
    const raw = this.rawByHandle.get(handle)
    if (!raw) return

    const key = this.keyForNode(raw)
    if (raw.h === this.accountRoot && raw.a && (!key || key.length < 16)) {
      throw DriverError.upstream('MEGA could not unlock the account root key; the password may be wrong')
    }
    let name = raw.h
    let attributes: Record<string, unknown> = {}
    if (raw.a) {
      try {
        const plain = aesCbcDecrypt(this.attributeKey(raw.t, key ?? new Uint8Array(16)), base64UrlDecode(raw.a))
        const parsed = unpackAttributes(plain)
        if (parsed) {
          attributes = parsed
          if (typeof parsed.n === 'string') name = parsed.n
        }
      } catch {
        // An attribute block we cannot open stays visible under its handle instead of hiding the
        // node entirely; reads of such a node fail explicitly below.
      }
    }

    const node: MegaNode = {
      handle: raw.h,
      parent: raw.p,
      name,
      size: Number(raw.s) || 0,
      modifiedAt: (Number(raw.ts) || 0) * 1000,
      folder: raw.t !== NODE_TYPE_FILE,
      type: raw.t,
      key,
      attributes,
    }
    this.nodeCache.set(handle, node)
    this.childrenCache.set(handle, this.childrenCache.get(handle) ?? [])
    if (raw.p) {
      const siblings = this.childrenCache.get(raw.p) ?? []
      siblings.push(node)
      this.childrenCache.set(raw.p, siblings)
    }
    if (node.folder) {
      for (const candidate of this.rawChildren.get(handle) ?? []) this.walkNode(candidate.h, visited)
    }
  }

  private rootNode(): MegaNode {
    const node = this.nodeCache.get(this.rootPathHandle)
    if (!node) throw DriverError.notFound('The MEGA root folder is not available')
    return node
  }

  private resolveNode(path: string): MegaNode {
    const clean = driverPath(path)
    if (clean === '/') return this.rootNode()
    const segments = clean.split('/').filter(Boolean)
    let current = this.rootNode()
    for (const segment of segments) {
      if (!current.folder) throw DriverError.notFound(`Not a folder: ${segment}`)
      const children = this.childrenCache.get(current.handle) ?? []
      const match = children.find((child) => child.name === segment)
      if (!match) throw DriverError.notFound(`MEGA node not found: ${segment}`)
      current = match
    }
    return current
  }

  private ensureFile(node: MegaNode): Uint8Array {
    if (node.folder) throw DriverError.unsupported('A MEGA folder cannot be read as a file')
    if (!node.key || node.key.length < 24) throw DriverError.upstream(`MEGA node ${node.handle} has no usable file key`)
    return node.key
  }

  private entryFor(node: MegaNode): DriverEntry {
    return {
      name: node.name,
      kind: node.folder ? 'folder' : 'file',
      size: node.folder ? 0 : node.size,
      modifiedAt: node.modifiedAt || 0,
      ref: node.handle,
      mime: node.folder ? 'application/octet-stream' : driverEntryMime(node.name),
    }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.loadNodes()
      const node = this.resolveNode(clean)
      if (!node.folder) throw DriverError.notFound('The path is a file, not a folder')
      let children = [...(this.childrenCache.get(node.handle) ?? [])]
      const search = options.search?.trim().toLowerCase()
      if (search) children = children.filter((child) => child.name.toLowerCase().includes(search))
      children.sort((left, right) => left.name.localeCompare(right.name))

      const pageSize = Math.max(1, options.pageSize ?? children.length ?? 1)
      if (options.page !== undefined) {
        const page = Math.max(1, options.page)
        const start = (page - 1) * pageSize
        const slice = children.slice(start, start + pageSize)
        const cursor = start + pageSize < children.length ? String(page + 1) : null
        return { entries: slice.map((child) => this.entryFor(child)), cursor, truncated: cursor !== null }
      }

      const limited = children.slice(0, 5_000)
      return {
        entries: limited.map((child) => this.entryFor(child)),
        cursor: null,
        truncated: children.length > limited.length,
      }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.loadNodes()
      if (clean === '/') {
        const root = this.rootNode()
        return { name: root.name || 'root', kind: 'folder', size: 0, modifiedAt: root.modifiedAt, ref: root.handle }
      }
      return this.entryFor(this.resolveNode(clean))
    })
  }

  async read(path: string, _range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.loadNodes()
      const node = this.resolveNode(clean)
      const stored = this.ensureFile(node)
      const download = await this.apiRaw<MegaGResponse>({ a: 'g', g: 1, n: node.handle, ssl: 2 })
      if (typeof download.g !== 'string' || !download.g) {
        throw DriverError.upstream('MEGA did not return a download address (the quota or bandwidth limit may be exhausted)')
      }
      const size = node.size || Number(download.s) || 0
      const mime = driverEntryMime(node.name)
      if (size === 0) return new Response(new Uint8Array(0), { headers: { 'content-type': mime } })

      const unmasked = stored.length >= 32 ? unmergeKeyMac(stored) : stored
      const aesKey = unmasked.subarray(0, 16)
      const nonce = stored.length >= 24 ? stored.subarray(16, 24) : new Uint8Array(8)

      let response: Response
      try {
        response = await this.request(`${download.g}/0-${size - 1}`, {
          retries: 0,
          redirect: 'follow',
          timeoutMs: 60_000,
        })
      } catch (error) {
        if (error instanceof DriverError && error.message.includes('509')) {
          throw DriverError.rateLimited('MEGA download bandwidth limit reached')
        }
        throw error
      }
      if (!response.body) throw DriverError.upstream('MEGA returned an empty download body')

      const body = response.body
      const reader = body.getReader()
      const decryptor = new MegaCtrDecryptor(aesKey, nonce)
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                const tail = decryptor.finish()
                if (tail.length > 0) controller.enqueue(tail)
                controller.close()
                return
              }
              const plain = decryptor.process(new Uint8Array(value))
              if (plain.length > 0) {
                controller.enqueue(plain)
                return
              }
            }
          } catch {
            controller.error(DriverError.upstream('MEGA download stream was interrupted'))
          }
        },
        cancel() {
          return reader.cancel()
        },
      })
      return new Response(stream, {
        headers: { 'content-type': mime, 'content-length': String(size) },
      })
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.loadNodes()
      if (clean === '/') throw DriverError.invalid('The root folder is not a file path')
      const bytes = await asBytes(body)
      if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
      const parent = this.resolveNode(driverParentPath(clean))
      if (!parent.folder || !parent.key) throw DriverError.notFound('The MEGA destination folder does not exist')
      const name = driverFileName(clean)
      if (!name) throw DriverError.invalid('The upload path has no file name')

      const fileKey = crypto.getRandomValues(new Uint8Array(16))
      const nonce = crypto.getRandomValues(new Uint8Array(8))
      const mac = new MegaMac(fileKey, nonce)
      mac.update(bytes)
      const macBytes = mac.condense()
      const storedKey = mergeKeyMac(concat(fileKey, nonce), macBytes)

      const ciphertext = new Uint8Array(bytes.length)
      for (let offset = 0; offset < bytes.length; offset += ENCRYPT_CHUNK) {
        const end = Math.min(offset + ENCRYPT_CHUNK, bytes.length)
        const cipher = ctr(fileKey, counterBlock(nonce, offset / 16))
        const encrypted = cipher.encrypt(bytes.subarray(offset, end))
        ciphertext.set(encrypted, offset)
        options.onProgress?.(end, bytes.length)
      }

      const slot = await this.apiRaw<MegaUploadSlot>({ a: 'u', ssl: 2, s: bytes.length, ms: 0, r: 0, e: 0, v: 2 })
      if (typeof slot.p !== 'string' || !slot.p) throw DriverError.upstream('MEGA did not return an upload target')
      const uploaded = await this.request(`${slot.p}/0`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: ciphertext,
        redirect: 'follow',
        timeoutMs: 120_000,
      })
      const handle = parseUploadHandle(await uploaded.text())

      const attributes = packAttributes({ n: name })
      const encryptedAttributes = aesCbcEncrypt(fileKey, attributes)
      const encryptedKey = aesEcbEncrypt(parent.key.subarray(0, 16), storedKey)
      await this.apiRaw({
        a: 'p',
        t: parent.handle,
        n: [{ h: handle, t: NODE_TYPE_FILE, a: base64UrlEncode(encryptedAttributes), k: base64UrlEncode(encryptedKey) }],
      })
      await this.loadNodes(true)
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.loadNodes()
      if (clean === '/') return
      const parent = this.resolveNode(driverParentPath(clean))
      if (!parent.folder || !parent.key) throw DriverError.notFound('The MEGA destination folder does not exist')
      const name = driverFileName(clean)
      if (!name) throw DriverError.invalid('The folder path has no name')
      const folderKey = crypto.getRandomValues(new Uint8Array(16))
      const attributes = aesCbcEncrypt(folderKey, packAttributes({ n: name }))
      const encryptedKey = aesEcbEncrypt(parent.key.subarray(0, 16), folderKey)
      await this.apiRaw({
        a: 'p',
        t: parent.handle,
        n: [{ h: 'xxxxxxxx', t: NODE_TYPE_FOLDER, a: base64UrlEncode(attributes), k: base64UrlEncode(encryptedKey) }],
      })
      await this.loadNodes(true)
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    return await this.run(async () => {
      const name = newName.trim()
      if (!name || name.includes('/')) throw DriverError.invalid('The new MEGA name is invalid')
      await this.loadNodes()
      const node = this.resolveNode(clean)
      if (!node.key) throw DriverError.upstream('The MEGA node key is not available')
      const attributes = aesCbcEncrypt(this.attributeKey(node.type, node.key), packAttributes({ ...node.attributes, n: name }))
      await this.apiRaw({ a: 'a', n: node.handle, at: base64UrlEncode(attributes) })
      await this.loadNodes(true)
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const source = driverPath(fromPath)
    const target = driverPath(toPath)
    return await this.run(async () => {
      await this.loadNodes()
      const node = this.resolveNode(source)
      const targetName = driverFileName(target)
      if (!targetName) throw DriverError.invalid('The MEGA move target has no name')
      if (targetName !== node.name) await this.rename(source, targetName)
      await this.loadNodes()
      const parent = this.resolveNode(driverParentPath(target))
      if (!parent.folder) throw DriverError.notFound('The MEGA move destination is not a folder')
      await this.apiRaw({ a: 'm', n: node.handle, t: parent.handle })
      await this.loadNodes(true)
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.loadNodes()
      const node = this.resolveNode(clean)
      if (node.handle === this.accountRoot || node.type === NODE_TYPE_TRASH) {
        throw DriverError.invalid('The MEGA root or rubbish bin cannot be removed')
      }
      if (this.moveToTrash()) {
        const trash = this.rawNodes.find((raw) => raw.t === NODE_TYPE_TRASH)
        if (trash) {
          await this.apiRaw({ a: 'm', n: node.handle, t: trash.h })
          await this.loadNodes(true)
          return
        }
      }
      await this.apiRaw({ a: 'd', n: node.handle })
      await this.loadNodes(true)
    })
  }

  private moveToTrash(): boolean {
    const value = this.ctx.config.moveToTrash
    return value === undefined ? true : Boolean(value)
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.loadNodes()
      const node = this.resolveNode(clean)
      if (node.folder) return null
      const stored = this.ensureFile(node)
      let publicHandle = this.phByHandle.get(node.handle) ?? ''
      if (!publicHandle) {
        const exported = await this.apiRaw<{ ph?: string }>({ a: 'l', n: node.handle })
        if (typeof exported.ph === 'string') publicHandle = exported.ph
      }
      if (!publicHandle) throw DriverError.upstream('MEGA did not return a public link handle for this file')
      return `https://mega.nz/file/${publicHandle}#${base64UrlEncode(stored)}`
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const user = await this.run(async () => await this.apiRaw<MegaSessionUser>({ a: 'ug' }))
      return { ok: true, message: `MEGA is reachable${user.name ? ` · ${user.name}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'MEGA is unavailable' }
    }
  }
}

export function createMegaDriver(ctx: DriverContext): MountDriver {
  return new MegaDriver(ctx)
}
