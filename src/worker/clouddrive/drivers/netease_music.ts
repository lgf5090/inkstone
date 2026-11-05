/**
 * NetEase Cloud Music cloud drive driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/netease_music`: the `weapi` envelope (two
 * AES-128-CBC passes plus raw RSA), the `linuxapi` AES-ECB envelope used for the player URL, and the
 * `cloud/get` / `cloud/del` endpoints all follow it.
 *
 * The cloud is a flat song list: there are no folders, no upload and no rename. Only `read`,
 * `delete`, `directLink` and Range are advertised, and everything else is explicitly unavailable.
 */
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
import { cookieHeader, mergeResponseCookies, parseCookies, type CookieJar } from './cookies'
import { HttpDriverBase, collectPages, driverFileName, driverPath } from './http'

const PRESET_KEY = '0CoJUm6Qyw8W8jud'
const LINUXAPI_KEY = 'rFgB&h#%2?^eDg:Q'
const IV = '0102030405060708'
const STD_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const N_HEX =
  'e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
const RSA_E = 65537n
const MUSIC_API = 'https://music.163.com'
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36'
const MAX_LIST_PAGES = 50

interface NeteaseSong {
  addTime?: number
  fileName?: string
  fileSize?: number
  songId?: number
  simpleSong?: { al?: { picUrl?: string } }
}

function textEncoder(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function pkcs7Pad(source: Uint8Array, blockSize = 16): Uint8Array {
  const padLength = blockSize - (source.length % blockSize)
  const padded = new Uint8Array(source.length + padLength)
  padded.set(source)
  padded.fill(padLength, source.length)
  return padded
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function aesCbcEncrypt(source: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const cipher = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt'])
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cipher, source)
  return new Uint8Array(encrypted)
}

/**
 * WebCrypto has no ECB mode. Encrypting each padded block with AES-CBC and a zero IV yields
 * `E(block)` as the first 16 bytes, which is exactly the ECB ciphertext.
 */
async function aesEcbEncrypt(source: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const padded = pkcs7Pad(source)
  const cipher = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt'])
  const zeroIv = new Uint8Array(16)
  const result = new Uint8Array(padded.length)
  for (let offset = 0; offset < padded.length; offset += 16) {
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: zeroIv },
      cipher,
      padded.subarray(offset, offset + 16),
    )
    result.set(new Uint8Array(encrypted).subarray(0, 16), offset)
  }
  return result
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex ? BigInt(`0x${hex}`) : 0n
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  if (bytes.length < length) {
    const padded = new Uint8Array(length)
    padded.set(bytes, length - bytes.length)
    return padded
  }
  return bytes
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let value = base % modulus
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * value) % modulus
    value = (value * value) % modulus
    power >>= 1n
  }
  return result
}

/** NetEase's raw RSA: no padding, the 16-byte secret sits at the end of a 128-byte block. */
function rsaRawEncrypt(secret: Uint8Array): Uint8Array {
  const full = new Uint8Array(128)
  full.set(secret, 112)
  const modulus = BigInt(`0x${N_HEX}`)
  return bigIntToBytes(modPow(bytesToBigInt(full), RSA_E, modulus), 128)
}

function randomSecret(): { key: Uint8Array; reversed: Uint8Array } {
  const key = new Uint8Array(16)
  const reversed = new Uint8Array(16)
  for (let index = 0; index < 16; index++) {
    const candidate = STD_CHARS.charCodeAt(Math.floor(Math.random() * STD_CHARS.length))
    key[index] = candidate
    reversed[15 - index] = candidate
  }
  return { key, reversed }
}

async function weapi(data: Record<string, string>): Promise<Record<string, string>> {
  const plain = textEncoder(JSON.stringify(data))
  const { key, reversed } = randomSecret()
  const first = await aesCbcEncrypt(plain, textEncoder(PRESET_KEY), textEncoder(IV))
  const second = await aesCbcEncrypt(first, reversed, textEncoder(IV))
  return {
    params: bytesToBase64(second),
    encSecKey: bytesToHex(rsaRawEncrypt(key)),
  }
}

async function linuxapi(data: Record<string, unknown>): Promise<Record<string, string>> {
  const encrypted = await aesEcbEncrypt(textEncoder(JSON.stringify(data)), textEncoder(LINUXAPI_KEY))
  return { eparams: bytesToHex(encrypted).toUpperCase() }
}

function songName(song: NeteaseSong): string {
  return String(song.fileName ?? '')
}

function songEntry(song: NeteaseSong): DriverEntry {
  const name = songName(song)
  return {
    name,
    kind: 'file',
    size: Number(song.fileSize) || 0,
    modifiedAt: Number(song.addTime) || 0,
    ref: String(song.songId ?? ''),
    mime: driverEntryMime(name),
  }
}

class NeteaseMusicDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('netease_music')!
  readonly capabilities = this.definition.capabilities

  private jar: CookieJar = {}
  private cookie = ''

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private songLimit(): number {
    const raw = this.ctx.config.songLimit
    const value = typeof raw === 'number' ? raw : Number(this.configText('songLimit', '200'))
    return Number.isFinite(value) && value > 0 ? Math.min(1000, Math.floor(value)) : 200
  }

  protected async login(_force: boolean): Promise<void> {
    const raw = (this.ctx.credentials.cookie ?? '').trim()
    if (!raw) throw DriverError.auth('NetEase Cloud Music needs a cookie containing MUSIC_U and __csrf.')
    this.jar = parseCookies(raw)
    if (!this.jar.MUSIC_U || !this.jar.__csrf) {
      throw DriverError.auth('The NetEase cookie must contain both MUSIC_U and __csrf.')
    }
    this.cookie = cookieHeader(this.jar)
  }

  private headers(userAgent: string): Record<string, string> {
    return {
      Cookie: this.cookie ? `${this.cookie}; os=pc` : 'os=pc',
      Referer: MUSIC_API,
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
  }

  private async post(url: string, body: Record<string, string>, userAgent = WEB_UA): Promise<Record<string, unknown>> {
    const response = await this.request(url, {
      method: 'POST',
      headers: this.headers(userAgent),
      body: new URLSearchParams(body).toString(),
    })
    const before = this.cookie
    mergeResponseCookies(this.jar, response)
    const after = cookieHeader(this.jar)
    if (after !== before) {
      this.cookie = after
      await this.saveCredential({ cookie: after })
    }
    const text = await response.text()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw DriverError.upstream(`NetEase answered a non-JSON body (HTTP ${response.status})`)
    }
    const code = Number(payload.code)
    if (code === 301 || code === 401 || code === 403) {
      throw DriverError.auth(`NetEase needs a fresh cookie (code=${code}).`)
    }
    return payload
  }

  private async cloudGet(limit: number, offset: number): Promise<NeteaseSong[]> {
    const payload = await this.post(`${MUSIC_API}/weapi/v1/cloud/get`, await weapi({
      limit: String(limit),
      offset: String(offset),
    }))
    const data = payload.data
    if (Array.isArray(data)) return data as NeteaseSong[]
    return []
  }

  private async songUrl(songId: string): Promise<string> {
    const payload = await this.post(
      `${MUSIC_API}/api/linux/forward`,
      await linuxapi({
        url: `${MUSIC_API}/api/song/enhance/player/url`,
        method: 'POST',
        params: { ids: `[${songId}]`, br: '999000' },
      }),
      LINUX_UA,
    )
    const data = payload.data
    if (Array.isArray(data) && data.length > 0) {
      const url = String((data[0] as { url?: unknown }).url ?? '')
      if (url) return url
    }
    throw DriverError.upstream('NetEase returned no playable URL for that song')
  }

  private async allSongs(): Promise<NeteaseSong[]> {
    const limit = this.songLimit()
    const collected = await collectPages<NeteaseSong>(async ({ cursor }) => {
      const offset = Number(cursor ?? '0') || 0
      const songs = await this.cloudGet(limit, offset)
      return { items: songs, next: songs.length >= limit ? String(offset + songs.length) : null }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    return collected.items
  }

  async list(_path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    driverPath(_path)
    return await this.withAuth(async () => {
      const limit = Math.max(1, Math.min(1000, options.pageSize ?? this.songLimit()))
      if (options.page !== undefined) {
        const offset = (Math.max(1, options.page) - 1) * limit
        const songs = await this.cloudGet(limit, offset)
        const next = songs.length >= limit ? String(offset + songs.length) : null
        return { entries: songs.map(songEntry), cursor: next, truncated: next !== null }
      }
      const collected = await collectPages<NeteaseSong>(async ({ cursor }) => {
        const offset = Number(cursor ?? '0') || 0
        const songs = await this.cloudGet(limit, offset)
        return { items: songs, next: songs.length >= limit ? String(offset + songs.length) : null }
      }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
      return { entries: collected.items.map(songEntry), cursor: null, truncated: collected.truncated }
    })
  }

  private async findSong(path: string): Promise<NeteaseSong> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is the song list, not a song')
    const name = driverFileName(clean)
    const song = (await this.allSongs()).find((item) => songName(item) === name)
    if (!song) throw DriverError.notFound(`NetEase song not found: ${name}`)
    return song
  }

  async stat(path: string): Promise<DriverEntry> {
    driverPath(path)
    return await this.withAuth(async () => {
      const clean = driverPath(path)
      if (clean === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '' }
      }
      return songEntry(await this.findSong(clean))
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    driverPath(path)
    return await this.withAuth(async () => {
      const song = await this.findSong(path)
      const url = await this.songUrl(String(song.songId ?? ''))
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Referer: MUSIC_API,
          'User-Agent': WEB_UA,
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`NetEase media download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    driverPath(path)
    return await this.withAuth(async () => {
      const song = await this.findSong(path)
      return await this.songUrl(String(song.songId ?? ''))
    })
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('NetEase Cloud Music has no cloud-drive upload API; upload through the NetEase app.')
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('The NetEase cloud is a flat song list and cannot create folders.')
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('NetEase Cloud Music cannot rename a song.')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('The NetEase cloud is a flat song list and cannot move songs.')
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    return await this.withAuth(async () => {
      const song = await this.findSong(path)
      const id = String(song.songId ?? '')
      if (!id) throw DriverError.notFound('The song has no id')
      const payload = await this.post(`${MUSIC_API}/weapi/cloud/del`, await weapi({ songIds: `[${id}]` }))
      const code = Number(payload.code)
      if (payload.code !== undefined && code !== 200) {
        throw DriverError.upstream(`NetEase could not delete the song (code=${code})`)
      }
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const songs = await this.cloudGet(1, 0)
      return { ok: true, message: `NetEase Cloud Music is reachable (${songs.length} sampled song(s))` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'NetEase Cloud Music is unavailable' }
    }
  }
}

export function createNeteaseMusicDriver(ctx: DriverContext): MountDriver {
  return new NeteaseMusicDriver(ctx)
}
