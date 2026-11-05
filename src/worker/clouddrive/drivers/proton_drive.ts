/**
 * Proton Drive account driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/proton_drive`, but without the `openpgp`
 * dependency: Proton's trust chain is implemented with WebCrypto and the pure-JS primitives that
 * this application already ships (`@noble/ciphers`, `@noble/hashes`, `bcryptjs`).
 *
 * Trust chain:
 *   user private key  <- bcrypt(password, KeySalt) passphrase
 *     -> address private keys (Token is an OpenPGP message encrypted to the user keys)
 *       -> share private key (Passphrase is an OpenPGP message encrypted to the address keys)
 *         -> root node key (NodePassphrase encrypted to the share keys)
 *           -> child node keys (NodePassphrase encrypted to the parent node keys)
 *             -> file name / ContentKeyPacket / block payloads
 *
 * Supported: SRP-6a sign-in, 2FA, reusable credential + refresh-token rotation, listing, stat,
 * decrypted downloads, and trashing. Node creation (mkdir/rename) needs OpenPGP *encryption* and
 * a fresh Curve25519 node key; that is reported as unsupported instead of faking a result.
 */
import { aeskw, cfb, gcm } from '@noble/ciphers/aes.js'
import bcrypt from 'bcryptjs'
import { inflateSync, unzlibSync } from 'fflate'
import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
} from './contract'
import { HttpDriverBase, driverPath } from './http'

const ACCOUNT_API = 'https://account.proton.me/api'
const DRIVE_API = 'https://drive.proton.me/api'
const APP_VERSION = 'web-drive@5.2.0+0f69f7a8'
const SDK_VERSION = 'js@0.3.0'
const USER_AGENT = 'ProtonDrive/v1.70.0 (Windows NT 10.0; Win64; x64)'
const JSON_MIME = 'application/vnd.protonmail.v1+json'
const LIST_PAGE_SIZE = 150
const MAX_LIST_PAGES = 60
const SHARE_TYPE_MAIN = 1
const LINK_TYPE_FILE = 1
const LINK_TYPE_FOLDER = 2
const ANONYMOUS_SENDER = 'Anonymous Sender    '

const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder()

interface ProtonSalt {
  ID: string
  KeySalt: string
}

interface ProtonRawKey {
  ID: string
  PrivateKey: string
  Token?: string | null
  Primary?: number
}

interface ProtonUser {
  ID: string
  Name?: string
  Email?: string
  Keys: ProtonRawKey[]
}

interface ProtonAddress {
  ID: string
  Email: string
  Keys: ProtonRawKey[]
}

interface ProtonShare {
  ShareID: string
  VolumeID: string
  RootLinkID: string
  Type: number
  AddressID: string
  Key: string
  Passphrase: string
}

interface ProtonFileProperties {
  ContentKeyPacket?: string
}

interface ProtonLink {
  LinkID: string
  ParentLinkID?: string
  Type: number
  Name: string
  Size: number
  ModifyTime: number
  CreateTime: number
  NodeKey: string
  NodePassphrase: string
  XAttr?: string
  FileProperties?: ProtonFileProperties
}

interface ProtonBlock {
  Index: number
  BareURL: string
  Token: string
}

interface ProtonRevision {
  ID: string
  Size: number
  State: number
  Blocks?: ProtonBlock[]
}

interface ProtonSessionKey {
  algorithm: number
  key: Uint8Array
}

interface ProtonReusable {
  UID: string
  AccessToken: string
  RefreshToken: string
  SaltedKeyPass: string
}

interface ParsedPrivateKey {
  algorithm: number
  fingerprint: Uint8Array
  keyId: Uint8Array
  publicBody: Uint8Array
  oid: Uint8Array | null
  oidParams: { hash: number; cipher: number; reserved: number } | null
  point: Uint8Array | null
  scalar: Uint8Array | null
  rsa: { n: bigint; e: bigint; d: bigint; p: bigint; q: bigint; u: bigint } | null
}

interface PgpPacket {
  tag: number
  body: Uint8Array
}

class PgpError extends Error {}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = '0x0'
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return BigInt(hex)
}

function bigIntToBytes(value: bigint, length?: number): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  if (length === undefined || bytes.length >= length) return bytes
  const padded = new Uint8Array(length)
  padded.set(bytes, length - bytes.length)
  return padded
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

function base64Decode(value: string): Uint8Array {
  const text = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  const binary = atob(text.padEnd(Math.ceil(text.length / 4) * 4, '='))
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function xorBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const length = Math.max(left.length, right.length)
  const out = new Uint8Array(length)
  for (let index = 0; index < length; index++) out[index] = (left[index] ?? 0) ^ (right[index] ?? 0)
  return out
}

function trimLeadingZero(bytes: Uint8Array): Uint8Array {
  return bytes.length > 1 && bytes[0] === 0 ? bytes.subarray(1) : bytes
}

// ---------- SRP-6a (Proton variant) ----------

const BCRYPT_ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const BCRYPT_SALT_BASE = '$2a$10$'

function bytesToBcryptBase64(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let accumulator = 0
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += BCRYPT_ALPHABET[(accumulator >> bits) & 0x3f]
    }
  }
  if (bits > 0) out += BCRYPT_ALPHABET[(accumulator << (6 - bits)) & 0x3f]
  return out
}

function bcryptBase64ToBytes(text: string): Uint8Array {
  const out: number[] = []
  let accumulator = 0
  let bits = 0
  for (const character of text) {
    const value = BCRYPT_ALPHABET.indexOf(character)
    if (value < 0) continue
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((accumulator >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

function protonBcrypt(password: string, salt: Uint8Array): string {
  const saltChars = bytesToBcryptBase64(salt).padEnd(22, '.')
  return bcrypt.hashSync(password, `${BCRYPT_SALT_BASE}${saltChars}`)
}

/** The printable bcrypt digest Proton uses as the OpenPGP key passphrase. */
function deriveSaltedKeyPass(password: string, keySaltBase64: string): string {
  const full = protonBcrypt(password, base64Decode(keySaltBase64))
  return full.slice(BCRYPT_SALT_BASE.length)
}

function deriveSrpPasswordHash(password: string, salt: Uint8Array): Uint8Array {
  return bcryptBase64ToBytes(protonBcrypt(password, salt))
}

interface SrpProof {
  clientEphemeral: string
  clientProof: string
  srpSession: string
}

async function computeSrpProof(
  username: string,
  password: string,
  info: { Modulus: string; ServerEphemeral: string; Salt: string; Version?: number; SRPSession: string },
): Promise<SrpProof> {
  const version = Number(info.Version) || 4
  const modulusBytes = trimLeadingZero(base64Decode(info.Modulus))
  const N = bytesToBigInt(modulusBytes)
  const B = bytesToBigInt(base64Decode(info.ServerEphemeral))
  const salt = base64Decode(info.Salt)
  if (B % N === 0n) throw new PgpError('The SRP server ephemeral is invalid')

  const hashedPassword = version >= 2
    ? deriveSrpPasswordHash(password, salt)
    : utf8.encode(password)
  const xHash = sha256(concatBytes(salt, hashedPassword))
  const x = bytesToBigInt(xHash)

  const secret = crypto.getRandomValues(new Uint8Array(32))
  const a = bytesToBigInt(secret)
  const A = modPow(2n, a, N)
  const aBytes = bigIntToBytes(A, modulusBytes.length)

  let multiplier = 0n
  if (version >= 2) {
    const gBytes = new Uint8Array(modulusBytes.length)
    gBytes[gBytes.length - 1] = 2
    multiplier = bytesToBigInt(sha256(concatBytes(modulusBytes, gBytes)))
  }
  const bBytes = bigIntToBytes(B, modulusBytes.length)
  const u = bytesToBigInt(sha256(concatBytes(aBytes, bBytes)))
  const gx = modPow(2n, x, N)
  let base = (B - ((multiplier * gx) % N)) % N
  if (base < 0n) base += N
  const S = modPow(base, a + u * x, N)
  const sBytes = bigIntToBytes(S, modulusBytes.length)

  const hN = sha256(modulusBytes)
  const hG = sha256(new Uint8Array([2]))
  const hU = sha256(utf8.encode(username))
  const leading = xorBytes(hN, hG)
  const proof = sha256(concatBytes(leading, hU, salt, aBytes, bBytes, sBytes))
  return {
    clientEphemeral: base64Encode(aBytes),
    clientProof: base64Encode(proof),
    srpSession: info.SRPSession,
  }
}

// ---------- base32 / TOTP ----------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(value: string): Uint8Array {
  const text = value.replace(/=+/g, '').replace(/\s+/g, '').toUpperCase()
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of text) {
    const index = BASE32.indexOf(character)
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

function totpCode(secret: string): string {
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

// ---------- X25519 (RFC 7748, pure BigInt) ----------

const P25519 = (1n << 255n) - 19n

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (let index = bytes.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index]!)
  return value
}

function bigIntToLittleEndian(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let current = value
  for (let index = 0; index < length; index++) {
    out[index] = Number(current & 0xffn)
    current >>= 8n
  }
  return out
}

function x25519(scalarBytes: Uint8Array, pointBytes: Uint8Array): Uint8Array {
  const scalar = new Uint8Array(scalarBytes.subarray(0, 32))
  scalar[0] = scalar[0]! & 248
  scalar[31] = (scalar[31]! & 127) | 64
  const k = littleEndianToBigInt(scalar)

  const point = new Uint8Array(pointBytes.subarray(0, 32))
  point[31] = point[31]! & 127
  const x1 = littleEndianToBigInt(point)

  let x2 = 1n
  let z2 = 0n
  let x3 = x1
  let z3 = 1n
  let swap = 0n
  for (let bit = 254; bit >= 0; bit--) {
    const bitValue = (k >> BigInt(bit)) & 1n
    swap ^= bitValue
    if (swap === 1n) {
      ;[x2, x3] = [x3, x2]
      ;[z2, z3] = [z3, z2]
    }
    swap = bitValue
    const a = (x2 + z2) % P25519
    const aa = (a * a) % P25519
    const b = (x2 - z2 + P25519) % P25519
    const bb = (b * b) % P25519
    const e = (aa - bb + P25519) % P25519
    const c = (x3 + z3) % P25519
    const d = (x3 - z3 + P25519) % P25519
    const da = (d * a) % P25519
    const cb = (c * b) % P25519
    x3 = (((da + cb) % P25519) * ((da + cb) % P25519)) % P25519
    z3 = (x1 * ((da - cb + P25519) % P25519) * ((da - cb + P25519) % P25519)) % P25519
    x2 = (aa * bb) % P25519
    z2 = (e * ((aa + (121665n * e) % P25519) % P25519)) % P25519
  }
  if (swap === 1n) {
    ;[x2, x3] = [x3, x2]
    ;[z2, z3] = [z3, z2]
  }
  const result = (x2 * modPow(z2, P25519 - 2n, P25519)) % P25519
  return bigIntToLittleEndian(result, 32)
}

// ---------- OpenPGP subset ----------

function dearmor(value: string): Uint8Array {
  const text = value.trim()
  if (!text.includes('-----BEGIN PGP')) {
    return base64Decode(text)
  }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith('-----BEGIN PGP'))
  if (start < 0) throw new PgpError('The OpenPGP armor header is missing')
  let index = start + 1
  while (index < lines.length && lines[index]!.trim() !== '') index++
  if (index >= lines.length) throw new PgpError('The OpenPGP armor body is missing')
  index++
  const body: string[] = []
  for (; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (!line || line.startsWith('=') || line.startsWith('-----END PGP')) break
    body.push(line)
  }
  return base64Decode(body.join(''))
}

function readLength(data: Uint8Array, offset: { value: number }, first: number): { length: number; partial: boolean } {
  if (first < 192) return { length: first, partial: false }
  if (first < 224) {
    const next = data[offset.value++]!
    return { length: ((first - 192) << 8) + next + 192, partial: false }
  }
  if (first < 255) return { length: 1 << (first & 0x1f), partial: true }
  const length = (data[offset.value]! << 24) | (data[offset.value + 1]! << 16) | (data[offset.value + 2]! << 8) | data[offset.value + 3]!
  offset.value += 4
  return { length, partial: false }
}

function parsePackets(data: Uint8Array): PgpPacket[] {
  const packets: PgpPacket[] = []
  let offset = 0
  while (offset < data.length) {
    const octet = data[offset++]!
    if (!(octet & 0x80)) throw new PgpError('Malformed OpenPGP packet header')
    if (octet & 0x40) {
      const tag = octet & 0x3f
      const state = { value: offset }
      let decoded = readLength(data, state, data[state.value++]!)
      offset = state.value
      if (decoded.partial) {
        const parts: Uint8Array[] = []
        while (true) {
          parts.push(data.subarray(offset, offset + decoded.length))
          offset += decoded.length
          const next = data[offset++]!
          if (next === undefined) throw new PgpError('Truncated partial-length packet')
          if (next >= 224 && next < 255) {
            decoded = { length: 1 << (next & 0x1f), partial: true }
            continue
          }
          const finalState = { value: offset }
          const final = readLength(data, finalState, next)
          offset = finalState.value
          if (final.partial) throw new PgpError('Nested partial-length packet is invalid')
          parts.push(data.subarray(offset, offset + final.length))
          offset += final.length
          break
        }
        packets.push({ tag, body: concatBytes(...parts) })
        continue
      }
      packets.push({ tag, body: data.subarray(offset, offset + decoded.length) })
      offset += decoded.length
      continue
    }
    const tag = (octet >> 2) & 0x0f
    const lengthType = octet & 3
    let length: number
    if (lengthType === 0) length = data[offset++]!
    else if (lengthType === 1) {
      length = (data[offset]! << 8) | data[offset + 1]!
      offset += 2
    } else if (lengthType === 2) {
      length = (data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!
      offset += 4
    } else {
      length = data.length - offset
    }
    packets.push({ tag, body: data.subarray(offset, offset + length) })
    offset += length
  }
  return packets
}

function hashFor(id: number, input: Uint8Array): Uint8Array {
  if (id === 2) return new Uint8Array(sha1(input))
  if (id === 8) return new Uint8Array(sha256(input))
  if (id === 10) return new Uint8Array(sha512(input))
  throw new PgpError(`Unsupported OpenPGP hash algorithm ${id}`)
}

interface S2kSpec {
  type: number
  hash: number
  salt: Uint8Array
  count: number
}

function readS2k(data: Uint8Array, offset: { value: number }): S2kSpec {
  const type = data[offset.value++]!
  const hash = data[offset.value++]!
  if (type !== 0 && type !== 1 && type !== 3) throw new PgpError(`Unsupported OpenPGP S2K type ${type}`)
  let salt: Uint8Array = new Uint8Array(0)
  let count = 0
  if (type === 1 || type === 3) {
    salt = data.subarray(offset.value, offset.value + 8)
    offset.value += 8
  }
  if (type === 3) count = data[offset.value++]!
  return { type, hash, salt, count }
}

function deriveS2kKey(spec: S2kSpec, hash: number, passphrase: string, length: number): Uint8Array {
  const pass = utf8.encode(passphrase)
  const chunks: Uint8Array[] = []
  const hashLength = hashFor(hash, new Uint8Array(0)).length
  let produced = 0
  let prefixLength = 0
  while (produced < length) {
    let input: Uint8Array
    if (spec.type === 0) {
      input = concatBytes(new Uint8Array(prefixLength), pass)
    } else if (spec.type === 1) {
      input = concatBytes(new Uint8Array(prefixLength), spec.salt, pass)
    } else {
      const data = concatBytes(spec.salt, pass)
      const count = Math.max((16 + (spec.count & 15)) << ((spec.count >> 4) + 6), data.length)
      const buffer = new Uint8Array(prefixLength + count)
      buffer.set(data, prefixLength)
      let position = prefixLength + data.length
      let datalen = data.length
      for (; position < count; position += datalen, datalen *= 2) buffer.copyWithin(position, prefixLength, position)
      input = buffer
    }
    const digest = hashFor(hash, input)
    chunks.push(digest)
    produced += digest.length
    prefixLength++
    if (hashLength === 0) break
  }
  return concatBytes(...chunks).subarray(0, length)
}

function cipherInfo(algorithm: number): { keySize: number; blockSize: number } {
  if (algorithm === 7) return { keySize: 16, blockSize: 16 }
  if (algorithm === 8) return { keySize: 24, blockSize: 16 }
  if (algorithm === 9) return { keySize: 32, blockSize: 16 }
  throw new PgpError(`Unsupported OpenPGP cipher ${algorithm}`)
}

function readMpi(data: Uint8Array, offset: { value: number }): Uint8Array | null {
  if (offset.value + 2 > data.length) return null
  const bits = (data[offset.value]! * 256) + data[offset.value + 1]!
  const length = Math.ceil(bits / 8)
  offset.value += 2
  if (offset.value + length > data.length) return null
  const value = data.subarray(offset.value, offset.value + length)
  offset.value += length
  return value
}

function parseSecretKey(body: Uint8Array, passphrase: string): ParsedPrivateKey | null {
  if (body.length < 6 || body[0] !== 4) return null
  const algorithm = body[5]!
  const state = { value: 6 }
  const rsa: ParsedPrivateKey['rsa'] = algorithm === 1 || algorithm === 2 || algorithm === 3
    ? { n: 0n, e: 0n, d: 0n, p: 0n, q: 0n, u: 0n }
    : null
  let oid: Uint8Array | null = null
  let oidParams: ParsedPrivateKey['oidParams'] = null
  let point: Uint8Array | null = null

  if (rsa) {
    const n = readMpi(body, state)
    const e = readMpi(body, state)
    if (!n || !e) return null
    rsa.n = bytesToBigInt(n)
    rsa.e = bytesToBigInt(e)
  } else if (algorithm === 18) {
    const oidLength = body[state.value++]!
    oid = body.subarray(state.value, state.value + oidLength)
    state.value += oidLength
    const q = readMpi(body, state)
    if (!q) return null
    point = q
    const paramLength = body[state.value++]!
    const reserved = body[state.value++]!
    const hash = body[state.value++]!
    const cipher = body[state.value++]!
    if (paramLength < 3) throw new PgpError('Malformed ECDH KDF parameters')
    state.value += Math.max(0, paramLength - 3)
    oidParams = { hash, cipher, reserved }
  } else if (algorithm === 19 || algorithm === 22) {
    const oidLength = body[state.value++]!
    oid = body.subarray(state.value, state.value + oidLength)
    state.value += oidLength
    const q = readMpi(body, state)
    if (!q) return null
    point = q
  } else {
    return null
  }

  const publicBody = body.subarray(0, state.value)
  // V4 fingerprints include the canonical old-format packet header (0x99 + 2-byte length), which
  // is what GnuPG and OpenPGP.js hash.
  const fingerprintInput = concatBytes(new Uint8Array([0x99, (publicBody.length >> 8) & 0xff, publicBody.length & 0xff]), publicBody)
  const fingerprint = new Uint8Array(sha1(fingerprintInput))
  const usage = body[state.value++]!
  let secret: Uint8Array
  if (usage === 0) {
    secret = body.subarray(state.value)
  } else {
    if (usage !== 254 && usage !== 255) throw new PgpError(`Unsupported secret-key protection ${usage}`)
    const cipherAlgorithm = body[state.value++]!
    const spec = readS2k(body, state)
    const { keySize } = cipherInfo(cipherAlgorithm)
    const key = deriveS2kKey(spec, spec.hash, passphrase, keySize)
    const iv = body.subarray(state.value, state.value + 16)
    state.value += 16
    const encrypted = body.subarray(state.value)
    const decrypted = cfb(key, iv).decrypt(encrypted)
    if (usage === 254) {
      const check = decrypted.subarray(decrypted.length - 20)
      const payload = decrypted.subarray(0, decrypted.length - 20)
      if (!equalBytes(check, new Uint8Array(sha1(payload)))) throw new PgpError('The secret key checksum is invalid')
      secret = payload
    } else {
      const payload = decrypted.subarray(0, decrypted.length - 2)
      let sum = 0
      for (const byte of payload) sum = (sum + byte) & 0xffff
      const expected = (decrypted[decrypted.length - 2]! << 8) | decrypted[decrypted.length - 1]!
      if (sum !== expected) throw new PgpError('The secret key checksum is invalid')
      secret = payload
    }
  }

  const secretState = { value: 0 }
  if (rsa) {
    const [d, p, q, u] = [readMpi(secret, secretState), readMpi(secret, secretState), readMpi(secret, secretState), readMpi(secret, secretState)]
    if (!d || !p || !q || !u) return null
    rsa.d = bytesToBigInt(d)
    rsa.p = bytesToBigInt(p)
    rsa.q = bytesToBigInt(q)
    rsa.u = bytesToBigInt(u)
    if (rsa.p === 0n || rsa.q === 0n) return null
  } else {
    const scalar = readMpi(secret, secretState)
    if (!scalar) return null
    return {
      algorithm,
      fingerprint,
      keyId: fingerprint.subarray(12, 20),
      publicBody,
      oid,
      oidParams,
      point,
      scalar,
      rsa: null,
    }
  }
  return {
    algorithm,
    fingerprint,
    keyId: fingerprint.subarray(12, 20),
    publicBody,
    oid,
    oidParams,
    point,
    scalar: null,
    rsa,
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let result = 0
  for (let index = 0; index < left.length; index++) result |= left[index]! ^ right[index]!
  return result === 0
}

function unlockArmoredKey(armored: string, passphrase: string): ParsedPrivateKey[] {
  const packets = parsePackets(dearmor(armored))
  const keys: ParsedPrivateKey[] = []
  for (const packet of packets) {
    if (packet.tag !== 5 && packet.tag !== 7) continue
    try {
      const key = parseSecretKey(packet.body, passphrase)
      if (key) keys.push(key)
    } catch {
      // A keyring may carry signing keys we cannot unlock; the decrypt path only needs the
      // encryption-capable ones, and an empty result is reported by the caller.
    }
  }
  if (keys.length === 0) throw new PgpError('No OpenPGP private key could be unlocked')
  return keys
}

function rsaDecryptBytes(ciphertext: Uint8Array, key: NonNullable<ParsedPrivateKey['rsa']>): Uint8Array {
  const c = bytesToBigInt(ciphertext)
  const xp = modPow(c % key.p, key.d % (key.p - 1n), key.p)
  const xq = modPow(c % key.q, key.d % (key.q - 1n), key.q)
  const t = ((((xq - xp) % key.q) + key.q) % key.q * key.u) % key.q
  const modulusLength = Math.ceil(key.n.toString(16).length / 2)
  const plain = bigIntToBytes(t * key.p + xp)
  if (plain.length >= modulusLength) return plain
  const padded = new Uint8Array(modulusLength)
  padded.set(plain, modulusLength - plain.length)
  return padded
}

function parseSessionKeyPayload(payload: Uint8Array): ProtonSessionKey | null {
  if (payload.length < 3) return null
  const algorithm = payload[0]!
  let keySize: number
  try {
    ({ keySize } = cipherInfo(algorithm))
  } catch {
    return null
  }
  if (payload.length < keySize + 3) return null
  let sum = 0
  for (let index = 1; index <= keySize; index++) sum = (sum + payload[index]!) & 0xffff
  const expected = (payload[keySize + 1]! << 8) | payload[keySize + 2]!
  if (sum !== expected) return null
  return { algorithm, key: payload.subarray(1, 1 + keySize) }
}

function pkcs1SessionKey(block: Uint8Array): ProtonSessionKey | null {
  if (block[0] !== 0 || block[1] !== 2) return null
  let index = 2
  while (index < block.length && block[index] !== 0) index++
  if (index + 3 >= block.length) return null
  return parseSessionKeyPayload(block.subarray(index + 1))
}

function ecdhUnwrapSessionKey(data: Uint8Array, key: ParsedPrivateKey): ProtonSessionKey | null {
  if (!key.point || !key.scalar || !key.oid || !key.oidParams) return null
  const state = { value: 0 }
  const ephemeral = readMpi(data, state)
  if (!ephemeral) return null
  const length = data[state.value++]!
  const wrapped = data.subarray(state.value, state.value + length)
  if (wrapped.length === 0) return null

  const ephemeralX = ephemeral.subarray(1)
  const scalar = new Uint8Array(key.scalar)
  scalar.reverse()
  const shared = x25519(scalar, ephemeralX)
  if (shared.every((byte) => byte === 0)) return null

  const oidWrite = concatBytes(new Uint8Array([key.oid.length]), key.oid)
  const kdfWrite = new Uint8Array([3, key.oidParams.reserved, key.oidParams.hash, key.oidParams.cipher])
  const param = concatBytes(
    oidWrite,
    new Uint8Array([18]),
    kdfWrite,
    utf8.encode(ANONYMOUS_SENDER),
    key.fingerprint,
  )
  const pepper = new Uint8Array([0, 0, 0, 1])
  const { keySize } = cipherInfo(key.oidParams.cipher)

  const variants: Uint8Array[] = [shared]
  let first = 0
  while (first < shared.length && shared[first] === 0) first++
  if (first > 0) variants.push(shared.subarray(first))
  let last = shared.length
  while (last > 0 && shared[last - 1] === 0) last--
  if (last < shared.length) variants.push(shared.subarray(0, last))

  for (const candidate of variants) {
    try {
      const derived = sha256(concatBytes(pepper, candidate, param)).subarray(0, keySize)
      const unwrapped = aeskw(derived).decrypt(wrapped)
      let end = unwrapped.length
      while (end > 0 && unwrapped[end - 1] === 0) end--
      const session = parseSessionKeyPayload(unwrapped.subarray(0, end))
      if (session) return session
    } catch {
      // Try the next compatibility variant.
    }
  }
  return null
}

function decryptPkesk(body: Uint8Array, keys: ParsedPrivateKey[]): ProtonSessionKey | null {
  if (body.length < 10 || body[0] !== 3) return null
  const algorithm = body[9]!
  const data = body.subarray(10)
  for (const key of keys) {
    if (key.algorithm !== algorithm) continue
    try {
      if (algorithm === 1 || algorithm === 2 || algorithm === 3) {
        if (!key.rsa) continue
        const state = { value: 0 }
        const encrypted = readMpi(data, state)
        if (!encrypted) continue
        const plain = rsaDecryptBytes(encrypted, key.rsa)
        const session = pkcs1SessionKey(plain)
        if (session) return session
      } else if (algorithm === 18) {
        const session = ecdhUnwrapSessionKey(data, key)
        if (session) return session
      }
    } catch {
      // A different key in the ring can still decrypt the packet.
    }
  }
  return null
}

function decryptSkesk(body: Uint8Array, passphrase: string): ProtonSessionKey | null {
  if (body.length < 4 || body[0] !== 4) return null
  const algorithm = body[1]!
  const state = { value: 2 }
  const spec = readS2k(body, state)
  const { keySize } = cipherInfo(algorithm)
  const kek = deriveS2kKey(spec, spec.hash, passphrase, keySize)
  const encrypted = body.subarray(state.value)
  if (encrypted.length === 0) return { algorithm, key: kek }
  const decrypted = cfb(kek, new Uint8Array(16)).decrypt(encrypted)
  return parseSessionKeyPayload(decrypted) ?? { algorithm, key: decrypted.subarray(0, keySize) }
}

function extractLiteral(packets: PgpPacket[]): Uint8Array | null {
  for (const packet of packets) {
    if (packet.tag === 11) {
      if (packet.body.length < 6) continue
      const filenameLength = packet.body[1]!
      const start = 2 + filenameLength + 4
      return packet.body.subarray(start)
    }
    if (packet.tag === 8) {
      const algorithm = packet.body[0]!
      const inner = packet.body.subarray(1)
      if (algorithm === 0) {
        const result = extractLiteral(parsePackets(inner))
        if (result) return result
      } else if (algorithm === 1 || algorithm === 2) {
        try {
          const inflated = algorithm === 1 ? inflateSync(inner) : unzlibSync(inner)
          const result = extractLiteral(parsePackets(inflated))
          if (result) return result
        } catch {
          // Keep looking for a literal packet.
        }
      }
    }
  }
  return null
}

function decryptAeadPacket(packet: Uint8Array, session: ProtonSessionKey): Uint8Array | null {
  if (packet.length < 4 || packet[0] !== 1) return null
  const cipherAlgorithm = packet[1]!
  const aeadAlgorithm = packet[2]!
  const chunkSizeByte = packet[3]!
  if (cipherAlgorithm !== session.algorithm) return null
  if (aeadAlgorithm !== 3) throw new PgpError('Proton used an OpenPGP AEAD mode other than GCM; this driver cannot decrypt it')
  const { keySize } = cipherInfo(cipherAlgorithm)
  if (session.key.length !== keySize) return null
  const iv = packet.subarray(4, 16)
  const payload = packet.subarray(16)
  const chunkSize = (2 ** (chunkSizeByte + 6)) + 16
  const header = new Uint8Array([0xc0 | 20, 1, cipherAlgorithm, aeadAlgorithm, chunkSizeByte])
  const output: Uint8Array[] = []
  let offset = 0
  let chunkIndex = 0n
  let total = 0
  while (offset < payload.length) {
    const chunk = payload.subarray(offset, Math.min(offset + chunkSize, payload.length))
    offset += chunk.length
    const nonce = new Uint8Array(iv)
    const chunkBytes = bigIntToLittleEndian(chunkIndex, 8).reverse()
    for (let index = 0; index < 8; index++) nonce[nonce.length - 8 + index] = nonce[nonce.length - 8 + index]! ^ chunkBytes[index]!
    const aad = concatBytes(header, chunkBytes)
    const isFinal = offset >= payload.length && chunk.length === 16
    try {
      if (isFinal) {
        const finalAad = concatBytes(aad, bigIntToLittleEndian(BigInt(total), 8).reverse())
        const empty = gcm(session.key, nonce, finalAad).decrypt(chunk)
        if (empty.length !== 0) return null
      } else {
        const plain = gcm(session.key, nonce, aad).decrypt(chunk)
        total += plain.length
        output.push(plain)
      }
    } catch {
      return null
    }
    chunkIndex++
  }
  return concatBytes(...output)
}

function decryptSeipd(packet: Uint8Array, session: ProtonSessionKey): Uint8Array | null {
  if (packet.length < 1) return null
  if (packet[0] === 2) throw new PgpError('Proton used SEIPD v2; this driver only decrypts SEIPD v1 blocks')
  if (packet[0] !== 1) return null
  const cipherAlgorithm = session.algorithm
  const { keySize, blockSize } = cipherInfo(cipherAlgorithm)
  if (session.key.length !== keySize) return null
  const plain = cfb(session.key, new Uint8Array(blockSize)).decrypt(packet.subarray(1))
  if (plain.length < blockSize + 2 + 22) return null
  const mdcStart = plain.length - 22
  if (plain[mdcStart] !== 0xd3 || plain[mdcStart + 1] !== 0x14) return null
  const expected = new Uint8Array(sha1(plain.subarray(0, plain.length - 20)))
  if (!equalBytes(expected, plain.subarray(plain.length - 20))) return null
  return plain.subarray(blockSize + 2, mdcStart)
}

function decryptMessage(data: Uint8Array, keys: ParsedPrivateKey[], passphrase?: string): Uint8Array {
  const packets = parsePackets(data)
  let session: ProtonSessionKey | null = null
  for (const packet of packets) {
    if (packet.tag === 1) {
      session = decryptPkesk(packet.body, keys)
      if (session) break
    }
    if (packet.tag === 3 && passphrase) {
      session = decryptSkesk(packet.body, passphrase)
      if (session) break
    }
  }
  if (!session) throw new PgpError('No OpenPGP session key could be recovered')
  for (const packet of packets) {
    if (packet.tag === 18) {
      const inner = decryptSeipd(packet.body, session)
      if (inner) {
        const literal = extractLiteral(parsePackets(inner))
        if (literal) return literal
      }
    }
    if (packet.tag === 20) {
      const inner = decryptAeadPacket(packet.body, session)
      if (inner) {
        const literal = extractLiteral(parsePackets(inner))
        if (literal) return literal
      }
    }
  }
  throw new PgpError('No decryptable OpenPGP data packet was found')
}

function decryptArmoredMessage(armored: string, keys: ParsedPrivateKey[], passphrase?: string): Uint8Array {
  return decryptMessage(dearmor(armored), keys, passphrase)
}

function decryptName(armored: string, keys: ParsedPrivateKey[]): string {
  return utf8Decoder.decode(decryptArmoredMessage(armored, keys))
}

function parseXattrSize(bytes: Uint8Array): number {
  let offset = 0
  while (offset < bytes.length) {
    const tag = bytes[offset++]!
    const field = tag >> 3
    const wire = tag & 0x07
    if (wire === 0) {
      let value = 0n
      let shift = 0n
      while (offset < bytes.length) {
        const byte = bytes[offset++]!
        value |= BigInt(byte & 0x7f) << shift
        if ((byte & 0x80) === 0) break
        shift += 7n
      }
      if (field === 1) return Number(value)
    } else if (wire === 2) {
      let length = 0
      let shift = 0
      while (offset < bytes.length) {
        const byte = bytes[offset++]!
        length |= (byte & 0x7f) << shift
        if ((byte & 0x80) === 0) break
        shift += 7
      }
      offset += length
    } else if (wire === 1) {
      offset += 8
    } else if (wire === 5) {
      offset += 4
    } else {
      break
    }
  }
  return 0
}

// ---------- driver ----------

class ProtonDriveDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('proton_drive')!
  readonly capabilities = this.definition.capabilities

  private accessToken = ''
  private refreshToken = ''
  private uid = ''
  private saltedKeyPass = ''
  private userKeys: ParsedPrivateKey[] = []
  private readonly addressKeyrings = new Map<string, ParsedPrivateKey[]>()
  private defaultAddressId = ''
  private share: ProtonShare | null = null
  private shareKeys: ParsedPrivateKey[] = []
  private rootLinkId = ''
  private keysReady = false

  private readonly linkCache = new Map<string, ProtonLink>()
  private readonly linkKeyCache = new Map<string, ParsedPrivateKey[]>()
  private readonly childrenCache = new Map<string, ProtonLink[]>()
  private readonly pathIdCache = new Map<string, string>()

  private credential(key: string): string {
    return this.ctx.credentials[key] ?? ''
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: JSON_MIME,
      'Content-Type': 'application/json',
      'X-Pm-Appversion': APP_VERSION,
      'X-Pm-Drive-Sdk-Version': SDK_VERSION,
      'User-Agent': USER_AGENT,
    }
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`
      if (this.uid) headers['X-Pm-Uid'] = this.uid
    }
    return headers
  }

  private async api<T>(
    path: string,
    options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; auth?: boolean; params?: Record<string, string | number> } = {},
  ): Promise<T> {
    let url = path.startsWith('http') ? path : `${DRIVE_API}${path}`
    if (options.params) {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(options.params)) query.set(key, String(value))
      url += `${url.includes('?') ? '&' : '?'}${query.toString()}`
    }
    const response = await this.json<T>(url, {
      method: options.method ?? 'GET',
      headers: this.authHeaders(),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    return response
  }

  private async account<T>(path: string, body: unknown): Promise<T> {
    try {
      return await this.json<T>(`${ACCOUNT_API}${path}`, {
        method: 'POST',
        headers: {
          Accept: JSON_MIME,
          'Content-Type': 'application/json',
          'X-Pm-Appversion': APP_VERSION,
          'X-Pm-Drive-Sdk-Version': SDK_VERSION,
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      // Proton answers bad credentials with a 4xx status other than 401, which the HTTP base
      // class reports as `upstream`; for the auth endpoints that means "authorize again".
      if (error instanceof DriverError && error.kind === 'upstream' && /HTTP 4\d\d/.test(error.message)) {
        throw DriverError.auth(`Proton Drive sign-in was refused: ${error.message}`)
      }
      throw error
    }
  }

  private reusable(): ProtonReusable | null {
    const raw = this.credential('reusableCredential').trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw.includes('{') ? raw : utf8Decoder.decode(base64Decode(raw))) as ProtonReusable
      if (!parsed || typeof parsed !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  private async persistReusable(): Promise<void> {
    if (!this.accessToken || !this.refreshToken || !this.uid || !this.saltedKeyPass) return
    const payload: ProtonReusable = {
      UID: this.uid,
      AccessToken: this.accessToken,
      RefreshToken: this.refreshToken,
      SaltedKeyPass: base64Encode(utf8.encode(this.saltedKeyPass)),
    }
    await this.saveCredential({ reusableCredential: base64Encode(utf8.encode(JSON.stringify(payload))) })
  }

  private async refreshSession(): Promise<boolean> {
    if (!this.refreshToken) return false
    const result = await this.account<{ AccessToken?: string; RefreshToken?: string; UID?: string; Code?: number }>(
      '/auth/v4/refresh',
      { RefreshToken: this.refreshToken, ResponseType: 'token', GrantType: 'refresh_token', RedirectURI: 'https://drive.proton.me' },
    )
    if (!result.AccessToken) return false
    this.accessToken = result.AccessToken
    this.refreshToken = result.RefreshToken || this.refreshToken
    this.uid = result.UID || this.uid
    await this.persistReusable()
    return true
  }

  private async passwordLogin(): Promise<void> {
    const email = this.configText('email').trim()
    const password = this.credential('password')
    if (!email) throw DriverError.auth('Proton Drive needs the email config field')
    if (!password) throw DriverError.auth('Proton Drive needs the password credential or a reusableCredential')
    const info = await this.account<{
      Modulus: string
      ServerEphemeral: string
      Salt: string
      Version?: number
      SRPSession: string
    }>('/auth/info', { Username: email })
    if (!info.Modulus || !info.ServerEphemeral || !info.SRPSession) {
      throw DriverError.upstream('Proton Drive returned an invalid SRP challenge')
    }
    const proof = await computeSrpProof(email, password, info)
    let result = await this.account<{
      Code?: number
      AccessToken?: string
      RefreshToken?: string
      UID?: string
      TwoFactor?: { Enabled?: number }
    }>('/auth/v4', {
      Username: email,
      ClientEphemeral: proof.clientEphemeral,
      ClientProof: proof.clientProof,
      SRPSession: proof.srpSession,
    })
    if (result.Code === 1001 || result.TwoFactor?.Enabled) {
      const code = this.credential('twoFaCode').trim() || totpCode(this.credential('twoFaSecret').trim())
      if (!code) {
        throw DriverError.auth('Proton Drive requires a second factor: provide the twoFaCode credential (or twoFaSecret)')
      }
      result = await this.account<typeof result>('/auth/v4/2fa', { TwoFactorCode: code, SRPSession: proof.srpSession })
    }
    if (!result.AccessToken || !result.UID) {
      throw DriverError.auth('Proton Drive sign-in failed; check the email and password')
    }
    this.accessToken = result.AccessToken
    this.refreshToken = result.RefreshToken ?? ''
    this.uid = result.UID
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.accessToken) return
    if (!force) {
      const reusable = this.reusable()
      if (reusable) {
        this.accessToken = reusable.AccessToken || ''
        this.refreshToken = reusable.RefreshToken || ''
        this.uid = reusable.UID || ''
        this.saltedKeyPass = reusable.SaltedKeyPass ? utf8Decoder.decode(base64Decode(reusable.SaltedKeyPass)) : ''
        if (this.accessToken) return
      }
    } else {
      const reusable = this.reusable()
      if (reusable) {
        this.refreshToken = reusable.RefreshToken || this.refreshToken
        this.uid = reusable.UID || this.uid
        if (!this.saltedKeyPass && reusable.SaltedKeyPass) this.saltedKeyPass = utf8Decoder.decode(base64Decode(reusable.SaltedKeyPass))
      }
    }
    if (this.refreshToken) {
      try {
        if (await this.refreshSession()) return
      } catch {
        // A revoked refresh token falls back to the password flow below.
      }
    }
    await this.passwordLogin()
    await this.persistReusable()
  }

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

  private async ensureKeys(): Promise<void> {
    if (this.keysReady && this.share) return
    const salts = await this.api<{ KeySalts?: ProtonSalt[] }>('/core/v4/keys/salts')
    const user = await this.api<{ User?: ProtonUser }>('/core/v4/users')
    const addresses = await this.api<{ Addresses?: ProtonAddress[] }>('/core/v4/addresses')
    if (!user.User || !Array.isArray(user.User.Keys)) throw DriverError.upstream('Proton Drive returned no user keys')

    if (!this.saltedKeyPass) {
      const primary = user.User.Keys.find((key) => key.Primary === 1) ?? user.User.Keys[0]
      const salt = (salts.KeySalts ?? []).find((entry) => entry.ID === primary?.ID)
      const password = this.credential('password')
      if (!salt || !password) {
        throw DriverError.auth('Proton Drive needs the password credential to unlock the account keys, or a reusableCredential carrying SaltedKeyPass')
      }
      this.saltedKeyPass = deriveSaltedKeyPass(password, salt.KeySalt)
      await this.persistReusable()
    }

    this.userKeys = []
    for (const key of user.User.Keys) {
      try {
        this.userKeys.push(...unlockArmoredKey(key.PrivateKey, this.saltedKeyPass))
      } catch {
        // Signing-only keys may not unlock; the encryption keys below still matter.
      }
    }
    if (this.userKeys.length === 0) {
      throw DriverError.auth('Proton Drive could not unlock the user keys; the password or reusable credential is wrong')
    }

    this.addressKeyrings.clear()
    const addressList = addresses.Addresses ?? []
    for (const address of addressList) {
      const ring: ParsedPrivateKey[] = []
      for (const key of address.Keys) {
        try {
          let passphrase = this.saltedKeyPass
          if (key.Token) {
            passphrase = utf8Decoder.decode(decryptArmoredMessage(key.Token, this.userKeys))
          }
          ring.push(...unlockArmoredKey(key.PrivateKey, passphrase))
        } catch {
          // Skip keys this client cannot open.
        }
      }
      if (ring.length > 0) this.addressKeyrings.set(address.ID, ring)
    }
    if (this.addressKeyrings.size === 0) throw DriverError.auth('Proton Drive could not unlock any address key')
    this.defaultAddressId = addressList[0]?.ID ?? ''

    const shares = await this.api<{ Shares?: ProtonShare[] }>('/drive/shares')
    const list = shares.Shares ?? []
    this.share = list.find((entry) => entry.Type === SHARE_TYPE_MAIN && entry.AddressID === this.defaultAddressId)
      ?? list.find((entry) => entry.Type === SHARE_TYPE_MAIN)
      ?? list[0]
      ?? null
    if (!this.share) throw DriverError.upstream('Proton Drive returned no main share')

    const addressRing = this.addressKeyrings.get(this.share.AddressID) ?? this.addressKeyrings.get(this.defaultAddressId)
    if (!addressRing) throw DriverError.auth('Proton Drive has no address key for the main share')
    try {
      const sharePassphrase = utf8Decoder.decode(decryptArmoredMessage(this.share.Passphrase, addressRing))
      const shareKey = unlockArmoredKey(this.share.Key, sharePassphrase)
      this.shareKeys = [...addressRing, ...shareKey]
    } catch {
      throw DriverError.upstream('Proton Drive could not unlock the main share keys')
    }

    const configured = this.configText('rootFolderId').trim()
    this.rootLinkId = configured || this.share.RootLinkID
    this.keysReady = true
    await this.linkKeyring(this.rootLinkId)
  }

  private async fetchLink(linkId: string): Promise<ProtonLink> {
    const cached = this.linkCache.get(linkId)
    if (cached) return cached
    if (!this.share) throw DriverError.upstream('Proton Drive share is not ready')
    const response = await this.api<{ Link?: ProtonLink }>(`/drive/volumes/${this.share.VolumeID}/links/${linkId}`)
    if (!response.Link) throw DriverError.notFound(`Proton link not found: ${linkId}`)
    this.linkCache.set(linkId, response.Link)
    return response.Link
  }

  private async linkKeyring(linkId: string): Promise<ParsedPrivateKey[]> {
    const cached = this.linkKeyCache.get(linkId)
    if (cached) return cached
    const link = await this.fetchLink(linkId)
    const parentRing = link.ParentLinkID ? await this.linkKeyring(link.ParentLinkID) : this.shareKeys
    let ring: ParsedPrivateKey[]
    try {
      const passphrase = utf8Decoder.decode(decryptArmoredMessage(link.NodePassphrase, parentRing))
      const nodeKeys = unlockArmoredKey(link.NodeKey, passphrase)
      ring = [...parentRing, ...nodeKeys]
    } catch {
      throw DriverError.upstream(`Proton Drive could not unlock the node keys of link ${linkId}`)
    }
    this.linkKeyCache.set(linkId, ring)
    return ring
  }

  private async decryptLinkName(link: ProtonLink, ring?: ParsedPrivateKey[]): Promise<string> {
    const keyring = ring ?? await this.linkKeyring(link.LinkID)
    try {
      return decryptName(link.Name, keyring)
    } catch {
      throw DriverError.upstream(`Proton Drive could not decrypt the name of link ${link.LinkID}`)
    }
  }

  private async listAllChildren(linkId: string): Promise<ProtonLink[]> {
    const cached = this.childrenCache.get(linkId)
    if (cached) return cached
    if (!this.share) throw DriverError.upstream('Proton Drive share is not ready')
    const all: ProtonLink[] = []
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = await this.api<{ Links?: ProtonLink[] }>(
        `/drive/volumes/${this.share.VolumeID}/links/${linkId}`,
        { params: { Children: 1, Page: page, PageSize: LIST_PAGE_SIZE, Thumbnail: 0 } },
      )
      const links = response.Links ?? []
      all.push(...links)
      if (links.length < LIST_PAGE_SIZE) break
    }
    this.childrenCache.set(linkId, all)
    return all
  }

  private async listPage(linkId: string, page: number, pageSize: number): Promise<ProtonLink[]> {
    if (!this.share) throw DriverError.upstream('Proton Drive share is not ready')
    const response = await this.api<{ Links?: ProtonLink[] }>(
      `/drive/volumes/${this.share.VolumeID}/links/${linkId}`,
      { params: { Children: 1, Page: Math.max(0, page - 1), PageSize: pageSize, Thumbnail: 0 } },
    )
    return response.Links ?? []
  }

  private async resolveLink(path: string): Promise<ProtonLink> {
    const clean = driverPath(path)
    if (clean === '/') return await this.fetchLink(this.rootLinkId)
    const cached = this.pathIdCache.get(clean)
    if (cached) {
      const link = await this.fetchLink(cached)
      if (link) return link
    }
    const segments = clean.split('/').filter(Boolean)
    let currentId = this.rootLinkId
    let currentPath = '/'
    for (const segment of segments) {
      const children = await this.listAllChildren(currentId)
      let found: ProtonLink | null = null
      for (const child of children) {
        const name = await this.decryptLinkName(child)
        if (name === segment) {
          found = child
          break
        }
      }
      if (!found) throw DriverError.notFound(`Proton Drive node not found: ${segment}`)
      currentId = found.LinkID
      currentPath = currentPath === '/' ? `/${segment}` : `${currentPath}/${segment}`
      this.pathIdCache.set(currentPath, currentId)
    }
    return await this.fetchLink(currentId)
  }

  private linkEntry(link: ProtonLink, name: string, size?: number): DriverEntry {
    const folder = link.Type === LINK_TYPE_FOLDER
    return {
      name,
      kind: folder ? 'folder' : 'file',
      size: folder ? 0 : Math.max(0, size ?? link.Size ?? 0),
      modifiedAt: (link.ModifyTime || link.CreateTime || 0) * 1000,
      ref: link.LinkID,
      mime: folder ? 'application/octet-stream' : driverEntryMime(name),
    }
  }

  private async decryptedSize(link: ProtonLink, ring: ParsedPrivateKey[]): Promise<number> {
    let size = 0
    if (link.XAttr) {
      try {
        const bytes = decryptArmoredMessage(link.XAttr, ring)
        size = parseXattrSize(bytes)
      } catch {
        size = 0
      }
    }
    return size || link.Size || 0
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.ensureKeys()
      const folder = await this.resolveLink(clean)
      if (folder.Type !== LINK_TYPE_FOLDER) throw DriverError.notFound('The Proton Drive path is not a folder')
      const pageSize = Math.min(LIST_PAGE_SIZE, Math.max(1, options.pageSize ?? LIST_PAGE_SIZE))
      const page = options.page === undefined ? 1 : Math.max(1, options.page)
      const requested = options.page === undefined ? await this.listAllChildren(folder.LinkID) : await this.listPage(folder.LinkID, page, pageSize)
      const entries: DriverEntry[] = []
      const search = options.search?.trim().toLowerCase()
      for (const link of requested) {
        const name = await this.decryptLinkName(link)
        if (search && !name.toLowerCase().includes(search)) continue
        entries.push(this.linkEntry(link, name))
      }
      const cursor = options.page !== undefined && requested.length >= pageSize ? String(page + 1) : null
      return { entries, cursor, truncated: cursor !== null }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.ensureKeys()
      if (clean === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: this.rootLinkId }
      }
      const link = await this.resolveLink(clean)
      const ring = await this.linkKeyring(link.LinkID)
      const name = await this.decryptLinkName(link, ring)
      const size = link.Type === LINK_TYPE_FILE ? await this.decryptedSize(link, ring) : 0
      return this.linkEntry(link, name, size)
    })
  }

  private async contentSessionKey(link: ProtonLink, ring: ParsedPrivateKey[]): Promise<ProtonSessionKey> {
    const packet = link.FileProperties?.ContentKeyPacket
    if (!packet) throw DriverError.upstream(`Proton Drive link ${link.LinkID} has no content key packet`)
    try {
      const packets = parsePackets(dearmor(packet))
      for (const entry of packets) {
        if (entry.tag !== 1) continue
        const session = decryptPkesk(entry.body, ring)
        if (session) return session
      }
    } catch {
      throw DriverError.upstream(`Proton Drive could not read the content key packet of link ${link.LinkID}`)
    }
    throw DriverError.upstream(`Proton Drive could not decrypt the content key of link ${link.LinkID}`)
  }

  private async revision(linkId: string): Promise<ProtonRevision> {
    if (!this.share) throw DriverError.upstream('Proton Drive share is not ready')
    const response = await this.api<{ Revisions?: ProtonRevision[] }>(
      `/drive/volumes/${this.share.VolumeID}/links/${linkId}/revisions`,
    )
    const revisions = response.Revisions ?? []
    const revision = revisions.find((entry) => entry.State === 1) ?? revisions[0]
    if (!revision || !revision.Blocks?.length) throw DriverError.upstream(`Proton Drive link ${linkId} has no blocks`)
    return revision
  }

  private async downloadBlock(block: ProtonBlock, session: ProtonSessionKey): Promise<Uint8Array> {
    const response = await this.request(block.BareURL, {
      headers: { Authorization: `Bearer ${block.Token}` },
      retries: 1,
      timeoutMs: 60_000,
      redirect: 'follow',
    })
    const encrypted = new Uint8Array(await response.arrayBuffer())
    const packets = parsePackets(encrypted)
    const dataPacket = packets.find((packet) => packet.tag === 18 || packet.tag === 20)
    if (!dataPacket) throw DriverError.upstream('Proton Drive returned a block without an OpenPGP data packet')
    let plain: Uint8Array | null
    try {
      plain = dataPacket.tag === 18
        ? decryptSeipd(dataPacket.body, session)
        : decryptAeadPacket(dataPacket.body, session)
    } catch (error) {
      throw DriverError.upstream(error instanceof Error ? error.message : 'Proton Drive could not decrypt a file block')
    }
    if (!plain) throw DriverError.upstream('Proton Drive could not decrypt a file block')
    const literal = extractLiteral(parsePackets(plain))
    if (!literal) throw DriverError.upstream('Proton Drive returned a block without literal data')
    return literal
  }

  async read(path: string, _range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.ensureKeys()
      const link = await this.resolveLink(clean)
      if (link.Type !== LINK_TYPE_FILE) throw DriverError.unsupported('A Proton Drive folder cannot be read as a file')
      const ring = await this.linkKeyring(link.LinkID)
      const session = await this.contentSessionKey(link, ring)
      const revision = await this.revision(link.LinkID)
      const size = await this.decryptedSize(link, ring)
      const name = await this.decryptLinkName(link, ring)
      const mime = driverEntryMime(name)
      const blocks = [...(revision.Blocks ?? [])].sort((left, right) => left.Index - right.Index)
      const driver = this
      let blockIndex = 0
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (blockIndex >= blocks.length) {
            controller.close()
            return
          }
          try {
            controller.enqueue(await driver.downloadBlock(blocks[blockIndex++]!, session))
          } catch (error) {
            controller.error(error)
          }
        },
      })
      const headers: Record<string, string> = { 'content-type': mime }
      if (size > 0) headers['content-length'] = String(size)
      return new Response(stream, { headers })
    })
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Proton Drive uploads need the draft/revision block encryption protocol, which this driver does not implement')
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported(
      'Proton Drive mkdir needs OpenPGP encryption and a fresh Curve25519 node key; this driver only decrypts existing nodes',
    )
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported(
      'Proton Drive rename needs OpenPGP encryption for the new name and its hash; this driver only decrypts existing nodes',
    )
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('Proton Drive move needs cross-node passphrase re-encryption')
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    return await this.run(async () => {
      await this.ensureKeys()
      const link = await this.resolveLink(clean)
      if (link.LinkID === this.rootLinkId) throw DriverError.invalid('The Proton Drive root folder cannot be removed')
      if (!this.share) throw DriverError.upstream('Proton Drive share is not ready')
      await this.api(`/drive/volumes/${this.share.VolumeID}/links/${link.LinkID}/trash`, { method: 'POST' })
      this.cacheInvalidate(link.LinkID)
    })
  }

  private cacheInvalidate(linkId: string): void {
    this.linkCache.delete(linkId)
    this.linkKeyCache.delete(linkId)
    this.childrenCache.clear()
    this.pathIdCache.clear()
  }

  async directLink(_path: string): Promise<string | null> {
    // Proton Drive has no unauthenticated direct download URL; content always requires the
    // account session and client-side block decryption.
    return null
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const user = await this.run(async () => {
        await this.ensureKeys()
        return await this.api<{ User?: ProtonUser }>('/core/v4/users')
      })
      return { ok: true, message: `Proton Drive is reachable${user.User?.Name ? ` · ${user.User.Name}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Proton Drive is unavailable' }
    }
  }
}

export function createProtonDriveDriver(ctx: DriverContext): MountDriver {
  return new ProtonDriveDriver(ctx)
}
