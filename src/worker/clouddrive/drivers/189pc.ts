/**
 * Tianyi Cloud PC protocol (189PC) account driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/189pc`: the RSA password login, the
 * signed bucket-api requests, the page based listing, the copy+delete move and the
 * `upload.cloud.189.cn/v1/file` multipart upload follow the reference. RSA/PKCS#1 v1.5 is
 * implemented with BigInt modPow so the worker never reaches for node:crypto's
 * `publicEncrypt`/`createCipheriv`.
 */
import { md5 } from '@noble/hashes/legacy.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
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
  uploadInParts,
} from './http'

const API = 'https://api.cloud.189.cn'
const UPLOAD_API = 'https://upload.cloud.189.cn'
const LOGIN_URL = `${API}/open/oauth2/loginSubmit.action`
const APP_ID = '600002434'
const CLIENT_TYPE = '10020'
const RETURN_URL = 'https://m.cloud.189.cn/zhuanti/2020/loginSuccess/index.html'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024
const MAX_PAGES = 50
const RSA_PUBLIC_KEY =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDY7mpaUysvgQkIiL9M6PxYcKGOXe0elNAk' +
  'kkh/v0fzfx6cGrJnLlh5G0H8qPUvhLHh+U4xqRMN8C7KKKHmCQ1Xq5KLJCBM6pq9W2KU2R1q' +
  'g5SrCAqHq5KXJHM7TpjD/yH0u8KpY2H5U3WwR5N9LCdTw2XP6YqOvAx8kKqM3N8mKQIDAQAB'

interface File189PC {
  id: number | string
  name: string
  size?: number
  lastOpTime?: string
  createDate?: string
  isFolder?: boolean
  md5?: string
  icon?: { smallUrl?: string; largeUrl?: string }
}

interface List189PC {
  [key: string]: unknown
  fileList?: File189PC[]
  folderList?: File189PC[]
  fileListSize?: number
  recordCount?: number
  res_code?: number | string
  res_message?: string
  errorCode?: string
  errorMsg?: string
}

interface Item189PC {
  ref: string
  name: string
  size: number
  modified: number
  folder: boolean
}

interface Api189PC {
  [key: string]: unknown
  res_code?: number | string
  res_message?: string
  errorCode?: string
  errorMsg?: string
}

const encoder = new TextEncoder()

function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''))
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

function md5Hex(bytes: Uint8Array): string {
  return bytesToHex(md5(bytes)).toUpperCase()
}

function hmacSha1Hex(text: string, key: string): string {
  return bytesToHex(hmac(sha1, utf8(key), utf8(text))).toUpperCase()
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n
  for (const byte of bytes) result = (result << 8n) | BigInt(byte)
  return result
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let rest = value
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = base % modulus
  let power = exponent
  while (power > 0n) {
    if (power % 2n === 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    power /= 2n
  }
  return result
}

function parseRsaPublicKey(pemOrBase64: string): { n: bigint; e: bigint; length: number } {
  const der = base64ToBytes(pemOrBase64.replace(/-----BEGIN[^-]+-----/g, '').replace(/-----END[^-]+-----/g, ''))
  const integers: Uint8Array[] = []
  const scan = (start: number, end: number): void => {
    let offset = start
    while (offset < end) {
      const tag = der[offset++]!
      let length = der[offset++]!
      if (length & 0x80) {
        const count = length & 0x7f
        length = 0
        for (let index = 0; index < count; index += 1) length = (length << 8) | der[offset++]!
      }
      const bodyStart = offset
      offset += length
      if (tag === 0x02) {
        let body = der.subarray(bodyStart, bodyStart + length)
        if (body.length > 1 && body[0] === 0x00) body = body.subarray(1)
        integers.push(body)
      } else if (tag === 0x30 || (tag & 0x20) !== 0) {
        scan(bodyStart, bodyStart + length)
      } else if (tag === 0x03 && der[bodyStart] === 0x00) {
        scan(bodyStart + 1, bodyStart + length)
      }
    }
  }
  scan(0, der.length)
  if (integers.length < 2) throw new Error('The RSA public key has no modulus')
  let modulus = integers[0]!
  let exponent = integers[1]!
  if (modulus.length < exponent.length) {
    const swap = modulus
    modulus = exponent
    exponent = swap
  }
  return { n: bytesToBigInt(modulus), e: bytesToBigInt(exponent), length: modulus.length }
}

function rsaEncode(data: string, publicKey: string): string {
  const { n, e, length } = parseRsaPublicKey(publicKey)
  const message = utf8(data)
  if (message.length > length - 11) throw new Error('The password does not fit the RSA key')
  const paddingLength = length - message.length - 3
  const padding = new Uint8Array(paddingLength)
  const random = new Uint8Array(paddingLength * 2)
  crypto.getRandomValues(random)
  let cursor = 0
  for (let index = 0; index < paddingLength; index += 1) {
    let byte = random[cursor++]!
    while (byte === 0) {
      if (cursor >= random.length) {
        crypto.getRandomValues(random)
        cursor = 0
      }
      byte = random[cursor++]!
    }
    padding[index] = byte
  }
  const block = new Uint8Array(length)
  block[0] = 0x00
  block[1] = 0x02
  block.set(padding, 2)
  block[2 + paddingLength] = 0x00
  block.set(message, 3 + paddingLength)
  return bytesToHex(bigIntToBytes(modPow(bytesToBigInt(block), e, n), length))
}

function generateDeviceId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes).toUpperCase()
}

function parseJsonPreservingIds(text: string): Api189PC {
  const protectedText = text.replace(/("id"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"')
  return JSON.parse(protectedText) as Api189PC
}

function decodeTime(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isAuthMessage(message: string): boolean {
  return /InvalidSessionKey|\u767b\u5f55|\u767b\u9646|\u6388\u6743|\u8fc7\u671f|\u5931\u6548|\u672a\u767b\u5f55|session/i.test(message)
}

function isFolder(item: File189PC): boolean {
  return item.isFolder === true
}

class Yun189PCDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('189pc')!
  readonly capabilities = this.definition.capabilities
  private accessToken = ''
  private sessionKey = ''
  private sessionSecret = ''
  private deviceId = ''
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private rootId(): string {
    return this.configText('rootFolderId', '-11').trim() || '-11'
  }

  private partSize(): number {
    const configured = Number(this.configText('uploadPartSize'))
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_CHUNK_SIZE
  }

  protected async login(force: boolean): Promise<void> {
    try {
      await this.doLogin(force)
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      throw error
    }
  }

  private async doLogin(force: boolean): Promise<void> {
    this.pathIds.clear()
    this.accessToken = this.ctx.credentials.accessToken ?? ''
    this.sessionKey = this.ctx.credentials.sessionKey ?? ''
    this.sessionSecret = this.ctx.credentials.sessionSecret ?? ''
    this.deviceId = this.configText('deviceId').trim() || this.ctx.credentials.deviceId || generateDeviceId()

    const username = this.configText('username').trim()
    const password = this.ctx.credentials.password ?? ''

    if (this.sessionKey && this.sessionSecret) {
      if (!force) {
        if (await this.validateSession()) return
      } else if (!username || !password) {
        if (await this.validateSession()) return
      }
    }

    if (!username || !password) {
      throw DriverError.auth(
        '189PC needs username/password, or a persistent sessionKey + sessionSecret. When password sign-in ' +
          'is blocked by a slider/device check, obtain the session pair from a browser Cookie session at ' +
          'https://cloud.189.cn and paste it into the storage settings.',
      )
    }
    await this.signIn(username, password)
  }

  private async validateSession(): Promise<boolean> {
    try {
      await this.listPage(this.rootId(), 1, 1)
      return true
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'rate_limit') throw error
      return false
    }
  }

  private async signIn(username: string, password: string): Promise<void> {
    const response = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json;charset=UTF-8',
      },
      body: new URLSearchParams({
        appId: APP_ID,
        accountType: '1',
        userName: username,
        password: rsaEncode(password, RSA_PUBLIC_KEY),
        clientType: CLIENT_TYPE,
        returnUrl: RETURN_URL,
        mailSuffix: '@189.cn',
        deviceId: this.deviceId,
        ...(this.configText('captchaMode') ? { captchaType: this.configText('captchaMode') } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const payload = await response.json().catch(() => null) as {
      result?: number
      msg?: string
      accessToken?: string
      sessionKey?: string
      sessionSecret?: string
    } | null
    if (!response.ok || !payload || payload.result !== 0 || !payload.sessionKey || !payload.sessionSecret) {
      const message = payload?.msg ?? `189PC sign-in failed (HTTP ${response.status})`
      if (/\u9a8c\u8bc1\u7801|\u6ed1\u5757|\u8bbe\u5907|\u5b89\u5168|captcha/i.test(message)) {
        throw DriverError.auth(
          `189PC sign-in was challenged (${message}). Complete the browser login, obtain sessionKey/sessionSecret ` +
            'from the PC client and paste them into the storage settings.',
        )
      }
      throw DriverError.auth(message)
    }
    this.accessToken = payload.accessToken ?? ''
    this.sessionKey = payload.sessionKey
    this.sessionSecret = payload.sessionSecret
    await this.saveCredential({
      accessToken: this.accessToken,
      sessionKey: this.sessionKey,
      sessionSecret: this.sessionSecret,
      deviceId: this.deviceId,
    })
  }

  // ---- Request plumbing -------------------------------------------------------------------

  private sign(params: Record<string, string>): string {
    const sorted = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&')
    return hmacSha1Hex(sorted, this.sessionSecret)
  }

  private errorFromPayload(payload: { res_code?: unknown; res_message?: unknown; errorCode?: unknown; errorMsg?: unknown }): DriverError {
    const message = String(payload.errorMsg ?? payload.res_message ?? payload.errorCode ?? payload.res_code ?? '189PC API error')
    if (isAuthMessage(message)) return DriverError.auth(message)
    return DriverError.upstream(message)
  }

  private async api<T extends Api189PC = Api189PC>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const query: Record<string, string> = { ...params }
    if (this.accessToken) query.accessToken = this.accessToken
    query.clientType = CLIENT_TYPE
    query.appId = APP_ID
    query.timestamp = String(Date.now())
    query.Signature = this.sign(query)
    const target = `${API}${endpoint}?${new URLSearchParams(query).toString()}`
    const response = await this.request(target, {
      method: 'GET',
      headers: { Accept: 'application/json;charset=UTF-8', Referer: 'https://cloud.189.cn/' },
    })
    const text = await response.text()
    let payload: T
    try {
      payload = parseJsonPreservingIds(text) as T
    } catch {
      throw DriverError.upstream('189PC answered with a non-JSON body')
    }
    if (String(payload.errorCode ?? '') === 'InvalidSessionKey' || String(payload.res_code ?? '') === 'InvalidSessionKey') {
      throw DriverError.auth('189PC rejected the session key')
    }
    if (payload.errorCode) throw this.errorFromPayload(payload)
    if (payload.res_code !== undefined && String(payload.res_code) !== '0') throw this.errorFromPayload(payload)
    return payload
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

  // ---- Listing ---------------------------------------------------------------------------

  private async listPage(folderId: string, pageNum: number, pageSize: number): Promise<List189PC> {
    return this.api<List189PC>('/open/file/listFiles.action', {
      folderId: folderId || this.rootId(),
      pageNum: String(pageNum),
      pageSize: String(pageSize),
    })
  }

  private itemOf(raw: File189PC): Item189PC {
    return {
      ref: String(raw.id),
      name: raw.name,
      size: Math.max(0, Number(raw.size ?? 0)),
      modified: decodeTime(raw.lastOpTime || raw.createDate),
      folder: isFolder(raw),
    }
  }

  private async allItems(folderId: string, findName?: string): Promise<Item189PC[]> {
    const items: Item189PC[] = []
    const pageSize = 100
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.listPage(folderId, page, pageSize)
      const folders = (result.folderList ?? []).map((item) => this.itemOf({ ...item, isFolder: true }))
      const files = (result.fileList ?? []).map((item) => this.itemOf({ ...item, isFolder: false }))
      items.push(...folders, ...files)
      if (findName && items.some((item) => item.name === findName)) break
      if (folders.length + files.length < pageSize) break
      if (items.length >= Number(result.recordCount ?? 0)) break
    }
    return items
  }

  private async resolveFolderId(path: string, create = false): Promise<string> {
    const clean = driverPath(path)
    const root = this.rootId()
    if (clean === '/' || clean === `/${root}`) return root
    const segments = clean.split('/').filter(Boolean)
    let parent = root
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        parent = cached
        continue
      }
      const items = await this.allItems(parent, segment)
      const found = items.find((item) => item.folder && item.name === segment)
      if (found) {
        parent = found.ref
        this.pathIds.set(prefix, parent)
        continue
      }
      if (!create) throw DriverError.notFound(`189PC folder not found: ${segment}`)
      await this.api('/open/file/createFolder.action', { parentFolderId: parent, folderName: segment })
      const again = await this.allItems(parent, segment)
      const created = again.find((item) => item.folder && item.name === segment)
      if (!created) throw DriverError.upstream(`189PC could not create the folder: ${segment}`)
      parent = created.ref
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveItem(path: string): Promise<Item189PC> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parent = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    const items = await this.allItems(parent, name)
    const found = items.find((item) => item.name === name)
    if (!found) throw DriverError.notFound(`189PC item not found: ${name}`)
    return found
  }

  private entryOf(item: Item189PC): DriverEntry {
    return {
      name: item.name,
      kind: item.folder ? 'folder' : 'file',
      size: item.folder ? 0 : item.size,
      modifiedAt: item.modified,
      ref: item.ref,
      mime: item.folder ? 'application/octet-stream' : driverEntryMime(item.name),
    }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return this.run(async () => {
      const folderId = await this.resolveFolderId(clean)
      const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100))
      const search = options.search?.trim().toLocaleLowerCase() ?? ''

      if (options.page !== undefined) {
        const page = Math.max(1, options.page)
        const result = await this.listPage(folderId, page, pageSize)
        const entries = [
          ...(result.folderList ?? []).map((item) => this.entryOf(this.itemOf({ ...item, isFolder: true }))),
          ...(result.fileList ?? []).map((item) => this.entryOf(this.itemOf({ ...item, isFolder: false }))),
        ]
        const next = page * pageSize < Number(result.recordCount ?? 0) ? String(page + 1) : null
        const filtered = search ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(search)) : entries
        return { entries: filtered, cursor: next, truncated: next !== null }
      }

      const items = await this.allItems(folderId)
      const entries = items.map((item) => this.entryOf(item))
      const filtered = search ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(search)) : entries
      return { entries: filtered, cursor: null, truncated: false }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return this.run(async () => {
      if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
      return this.entryOf(await this.resolveItem(clean))
    })
  }

  // ---- Reading ---------------------------------------------------------------------------

  private async downloadUrl(fileId: string): Promise<string> {
    const payload = await this.api<{ fileDownloadUrl?: string; downloadUrl?: string }>(
      '/open/file/getFileDownloadUrl.action',
      { fileId },
    )
    const url = payload.fileDownloadUrl ?? payload.downloadUrl ?? ''
    if (!url) throw DriverError.upstream(`189PC returned no download address for ${fileId}`)
    return url.replace(/^http:\/\//i, 'https://')
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return this.run(async () => {
      const item = await this.resolveItem(clean)
      if (item.folder) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = await this.downloadUrl(item.ref)
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, ...(range ? { Range: range } : {}) },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw this.responseError(response.status, '189PC download failed')
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return this.run(async () => {
      const item = await this.resolveItem(clean)
      if (item.folder) return null
      return await this.downloadUrl(item.ref)
    })
  }

  private responseError(status: number, prefix: string): DriverError {
    if (status === 401 || status === 403) return DriverError.auth(`${prefix} (HTTP ${status})`)
    if (status === 404) return DriverError.notFound(`${prefix} (HTTP 404)`)
    if (status === 429) return DriverError.rateLimited(`${prefix} (HTTP 429)`)
    return DriverError.upstream(`${prefix} (HTTP ${status})`)
  }

  // ---- Mutations -------------------------------------------------------------------------

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    await this.run(async () => {
      const parent = await this.resolveFolderId(driverParentPath(clean))
      await this.api('/open/file/createFolder.action', {
        parentFolderId: parent,
        folderName: driverFileName(clean),
      })
      this.pathIds.clear()
    })
  }

  private async renameItem(item: Item189PC, newName: string): Promise<void> {
    const endpoint = item.folder ? '/open/file/renameFolder.action' : '/open/file/renameFile.action'
    await this.api(endpoint, item.folder
      ? { folderId: item.ref, destFolderName: newName }
      : { fileId: item.ref, destFileName: newName })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    if (!newName || newName.includes('/') || newName.includes('\\')) throw DriverError.invalid('The new name is invalid')
    await this.run(async () => {
      await this.renameItem(await this.resolveItem(clean), newName)
      this.pathIds.clear()
    })
  }

  private async copyItem(item: Item189PC, destinationId: string): Promise<void> {
    await this.api('/open/file/copyFile.action', { fileId: item.ref, destFolderId: destinationId })
  }

  private async renameCopiedItem(parentId: string, oldName: string, newName: string): Promise<void> {
    const items = await this.allItems(parentId, oldName)
    const copied = items.find((item) => item.name === oldName)
    if (!copied) throw DriverError.upstream(`189PC copied "${oldName}" but the copy cannot be found`)
    await this.renameItem(copied, newName)
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.run(async () => {
      const item = await this.resolveItem(from)
      const targetName = driverFileName(to)
      const destination = await this.resolveFolderId(driverParentPath(to), true)
      await this.copyItem(item, destination)
      if (item.name !== targetName) await this.renameCopiedItem(destination, item.name, targetName)
      await this.api('/open/file/deleteFile.action', { fileId: item.ref })
      this.pathIds.clear()
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.run(async () => {
      const item = await this.resolveItem(from)
      const targetName = driverFileName(to)
      const destination = await this.resolveFolderId(driverParentPath(to), true)
      await this.copyItem(item, destination)
      if (item.name !== targetName) await this.renameCopiedItem(destination, item.name, targetName)
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.run(async () => {
      const item = await this.resolveItem(clean)
      await this.api('/open/file/deleteFile.action', { fileId: item.ref })
      this.pathIds.clear()
    })
  }

  // ---- Upload ----------------------------------------------------------------------------

  private async uploadJson<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${UPLOAD_API}${endpoint}`, {
      method: 'POST',
      headers: {
        SessionKey: this.sessionKey,
        Accept: 'application/json;charset=UTF-8',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw this.responseError(response.status, `189PC upload ${endpoint} failed`)
    }
    const text = await response.text()
    let payload: Api189PC
    try {
      payload = parseJsonPreservingIds(text)
    } catch {
      throw DriverError.upstream('189PC upload API answered with a non-JSON body')
    }
    if (String(payload.errorCode ?? '') === 'InvalidSessionKey') throw DriverError.auth('189PC rejected the upload session key')
    return payload as T
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    await this.run(async () => {
      const name = driverFileName(clean)
      const parent = await this.resolveFolderId(driverParentPath(clean), true)
      const size = bytes.byteLength
      const chunkSize = this.partSize()
      const partCount = Math.max(1, Math.ceil(size / chunkSize))
      const init = await this.uploadJson<{ uploadFileId?: string; fileDataExists?: number }>(
        '/v1/file/initMultiUpload',
        {
          parentFolderId: parent,
          fileName: name,
          fileSize: size,
          fileMd5: md5Hex(bytes),
          sliceSize: chunkSize,
          lazyCheck: 1,
        },
      )
      const uploadFileId = String(init.uploadFileId ?? '')
      if (!uploadFileId) throw DriverError.upstream('189PC did not create an upload session')
      if (init.fileDataExists === 1) {
        options.onProgress?.(size, size)
        this.pathIds.clear()
        return
      }

      const partInfos = Array.from({ length: partCount }, (_, index) => ({ partNumber: index + 1 }))
      const urls = await this.uploadJson<{ uploadUrls?: string[] }>(
        '/v1/file/getUploadUrls',
        { uploadFileId, partInfo: JSON.stringify(partInfos) },
      )
      const uploadUrls = urls.uploadUrls ?? []
      if (uploadUrls.length < partCount) {
        throw DriverError.upstream(`189PC returned ${uploadUrls.length} upload URLs for ${partCount} parts`)
      }

      const partMd5s = new Array<string>(partCount)
      await uploadInParts({
        size,
        partSize: chunkSize,
        concurrency: Math.min(8, partCount),
        uploadPart: async (partNumber, start, end) => {
          const url = uploadUrls[partNumber - 1]
          if (!url) throw DriverError.upstream(`189PC returned no upload URL for part ${partNumber}`)
          partMd5s[partNumber - 1] = md5Hex(bytes.subarray(start, end))
          const response = await fetch(url, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'User-Agent': USER_AGENT,
            },
            body: bytes.subarray(start, end),
            signal: AbortSignal.timeout(60_000),
          })
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            throw DriverError.upstream(`189PC upload part ${partNumber}/${partCount} failed (HTTP ${response.status})`)
          }
          options.onProgress?.(end, size)
        },
        complete: async () => {
          await this.uploadJson('/v1/file/commitUploadFile', {
            uploadFileId,
            fileMd5: md5Hex(bytes),
            sliceMd5: partCount === 1 ? md5Hex(bytes) : md5Hex(utf8(partMd5s.join('\n'))).toUpperCase(),
            lazyCheck: 1,
            opertype: '3',
          })
        },
      })
      this.pathIds.clear()
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const page = await this.listPage(this.rootId(), 1, 1)
      return {
        ok: true,
        message: `189PC is reachable (${Number(page.recordCount ?? 0)} items)`,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '189PC is unavailable' }
    }
  }
}

export function create189PCDriver(ctx: DriverContext): MountDriver {
  return new Yun189PCDriver(ctx)
}
