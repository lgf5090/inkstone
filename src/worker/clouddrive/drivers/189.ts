/**
 * Tianyi Cloud Drive (189) account driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/189`: the Cookie-first sign-in, the
 * open.e.189.cn OAuth password flow (with the slider CAPTCHA fallback), the page based
 * `fileListAO` listing, the `upload.cloud.189.cn` encrypted multipart protocol and the
 * `createBatchTask` move/copy/delete contract follow the reference.
 */
import { ecb } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { md5, sha1 } from '@noble/hashes/legacy.js'
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
import { cookieHeader, mergeResponseCookies, parseCookies } from './cookies'
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
  uploadInParts,
} from './http'

const API = 'https://cloud.189.cn/api'
const LOGIN_URL = `${API}/portal/loginUrl.action?redirectURL=https%3A%2F%2Fcloud.189.cn%2Fmain.action`
const OAUTH = 'https://open.e.189.cn'
const UPLOAD_API = 'https://upload.cloud.189.cn'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const DEFAULT_PAGE_SIZE = 60
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024
const MAX_PAGES = 45
const TRUSTED_REDIRECT_HOSTS = new Set(['cloud.189.cn', 'open.e.189.cn'])

interface File189 {
  id: number | string
  name: string
  size?: number
  lastOpTime?: string
  icon?: { smallUrl?: string; largeUrl?: string }
}

interface Folder189 {
  id: number | string
  name: string
  lastOpTime?: string
}

interface ListData189 {
  [key: string]: unknown
  res_code?: number | string
  res_message?: string
  errorCode?: string
  errorMsg?: string
  fileListAO?: {
    count?: number | string
    fileList?: File189[]
    folderList?: Folder189[]
  }
}

interface Item189 {
  ref: string
  name: string
  size: number
  modified: number
  folder: boolean
}

interface UploadSession189 {
  uploadFileId: string
  sessionKey: string
  fileMd5: string
  partCount: number
  chunkSize: number
}

interface Api189 {
  res_code?: number | string
  res_message?: string
  errorCode?: string
  errorMsg?: string
  [key: string]: unknown
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''))
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

function md5Hex(value: string | Uint8Array): string {
  return bytesToHex(md5(typeof value === 'string' ? utf8(value) : value))
}

function md5Base64(value: Uint8Array): string {
  return bytesToBase64(md5(value))
}

function aesEcbHex(text: string, key: string): string {
  return bytesToHex(ecb(utf8(key.slice(0, 16))).encrypt(utf8(text))).toUpperCase()
}

function hmacSha1Hex(text: string, key: string): string {
  return bytesToHex(hmac(sha1, utf8(key), utf8(text)))
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

/** RSA PKCS#1 v1.5 encryption, used by the 189 OAuth form. */
function rsaEncode(data: string, publicKey: string, asHex: boolean): string {
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
  const cipher = bigIntToBytes(modPow(bytesToBigInt(block), e, n), length)
  return asHex ? bytesToHex(cipher) : bytesToBase64(cipher)
}

function randomUUID(pattern = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'): string {
  return pattern.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16)
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

function randomNoCache(): string {
  return `0.${Math.floor(Math.random() * 1e17).toString().padStart(17, '0')}`
}

/** Keeps 189's 16+ digit ids as strings; JSON would round them. */
function parseJsonPreservingIds(text: string): Api189 {
  const protectedText = text.replace(/("id"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"')
  return JSON.parse(protectedText) as Api189
}

function parseHeaderString(value: string): Record<string, string> {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    decoded = value
  }
  const headers: Record<string, string> = {}
  for (const part of decoded.split('&')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    headers[part.slice(0, index)] = part.slice(index + 1)
  }
  return headers
}

function decodeTime(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isAuthMessage(message: string): boolean {
  return /InvalidSessionKey|\u767b\u5f55|\u767b\u9646|\u6388\u6743|\u8fc7\u671f|\u5931\u6548|\u672a\u767b\u5f55|session/i.test(message)
}

function isTrustedUrl(url: URL): boolean {
  return url.protocol === 'https:' && TRUSTED_REDIRECT_HOSTS.has(url.hostname)
}

function hasOAuthParams(value: string): boolean {
  try {
    const url = new URL(value, OAUTH)
    return Boolean(url.searchParams.get('lt')) && Boolean(url.searchParams.get('reqId'))
  } catch {
    return false
  }
}

function isLoggedInUrl(value: string): boolean {
  try {
    const url = new URL(value, OAUTH)
    return url.hostname === 'cloud.189.cn' && (url.pathname === '/web/main' || url.pathname === '/main.action')
  } catch {
    return false
  }
}

class Yun189Driver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('189')!
  readonly capabilities = this.definition.capabilities
  private cookie = ''
  private sessionKey = ''
  private rsaKey: { pubKey: string; pkId: string; expire: number } | null = null
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private rootId(): string {
    return this.configText('rootFolderId', '-11').trim() || '-11'
  }

  private pageSize(): number {
    const configured = Number(this.configText('pageSize', String(DEFAULT_PAGE_SIZE)))
    return Number.isFinite(configured) && configured > 0 ? Math.min(100, Math.floor(configured)) : DEFAULT_PAGE_SIZE
  }

  private partSize(): number {
    const configured = Number(this.configText('uploadPartSize'))
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_CHUNK_SIZE
  }

  private loginHeaders(): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      Referer: 'https://cloud.189.cn/',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    }
  }

  private async syncCookie(response: Response): Promise<void> {
    const previous = this.cookie
    this.cookie = cookieHeader(mergeResponseCookies(parseCookies(this.cookie), response))
    if (this.cookie !== previous) await this.saveCredential({ cookie: this.cookie })
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
    this.cookie = this.ctx.credentials.cookie ?? ''
    const username = this.configText('username').trim()
    const password = this.ctx.credentials.password ?? ''
    if (this.cookie && !(force && username && password)) {
      const valid = await this.validateCookie()
      if (valid) return
    }

    if (!username || !password) {
      throw DriverError.auth(
        '189 needs a browser Cookie. Password sign-in often hits a slider CAPTCHA; when that happens, ' +
          'open https://cloud.189.cn in a browser, copy the Cookie and paste it into the storage settings.',
      )
    }
    await this.signIn(username, password)
  }

  private async validateCookie(): Promise<boolean> {
    try {
      await this.getFilesPage(this.rootId(), 1, 1)
      await this.saveCredential({ cookie: this.cookie })
      return true
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'rate_limit') throw error
      return false
    }
  }

  // ---- Request plumbing -------------------------------------------------------------------

  private errorFromPayload(payload: { res_code?: unknown; res_message?: unknown; errorCode?: unknown; errorMsg?: unknown }): DriverError {
    const message = String(payload.errorMsg ?? payload.res_message ?? payload.errorCode ?? payload.res_code ?? '189 API error')
    if (isAuthMessage(message)) return DriverError.auth(message)
    return DriverError.upstream(message)
  }

  private async api<T extends Api189 = Api189>(
    url: string,
    options: { method?: 'GET' | 'POST'; params?: Record<string, string>; body?: Record<string, string> } = {},
  ): Promise<T> {
    const target = new URL(url)
    target.searchParams.set('noCache', randomNoCache())
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) target.searchParams.set(key, value)
    }
    const headers = this.loginHeaders()
    let body: string | undefined
    if (options.body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
      body = new URLSearchParams(options.body).toString()
    }
    const response = await this.request(target.toString(), {
      method: options.method ?? 'GET',
      headers,
      body,
    })
    await this.syncCookie(response)
    const text = await response.text()
    let payload: T
    try {
      payload = parseJsonPreservingIds(text) as T
    } catch {
      throw DriverError.upstream('189 Cloud answered with a non-JSON body')
    }
    const invalidSession = String(payload.errorCode ?? '') === 'InvalidSessionKey' ||
      String(payload.res_code ?? '') === 'InvalidSessionKey' ||
      String(payload.res_code ?? '') === '1010'
    if (invalidSession) throw DriverError.auth('189 Cloud rejected the session key')
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

  // ---- OAuth sign-in ----------------------------------------------------------------------

  private async followRedirects(initialUrl: string, headers: Record<string, string>): Promise<{ response: Response; url: string; urls: string[] }> {
    let current = initialUrl
    const visited: string[] = [current]
    for (let count = 0; count <= 8; count += 1) {
      const target = new URL(current)
      if (!isTrustedUrl(target)) throw DriverError.auth(`189 refused an untrusted login redirect: ${target.origin}`)
      const requestHeaders: Record<string, string> = { ...headers }
      if (count > 0) requestHeaders.Referer = current
      if (this.cookie) requestHeaders.Cookie = this.cookie
      const response = await fetch(current, {
        method: 'GET',
        headers: requestHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      })
      await this.syncCookie(response)
      const location = response.headers.get('location')
      if (!location || response.status < 300 || response.status >= 400) {
        return { response, url: current, urls: visited }
      }
      const next = new URL(location, current)
      if (!isTrustedUrl(next)) throw DriverError.auth(`189 refused an untrusted login redirect: ${next.origin}`)
      current = next.toString()
      visited.push(current)
    }
    throw DriverError.auth('189 login followed too many redirects')
  }

  private async resolveLoginUrl(): Promise<string> {
    let last = LOGIN_URL
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = new URL(LOGIN_URL)
      target.searchParams.set('noCache', randomNoCache())
      const result = await this.followRedirects(target.toString(), { 'User-Agent': USER_AGENT, Referer: 'https://cloud.189.cn/' })
      last = result.url
      if (hasOAuthParams(result.url) || isLoggedInUrl(result.url)) return result.url
      const fromHistory = result.urls.find((value) => hasOAuthParams(value))
      if (fromHistory) return fromHistory
    }
    return last
  }

  private async signIn(username: string, password: string): Promise<void> {
    const redirectUrl = await this.resolveLoginUrl()
    if (isLoggedInUrl(redirectUrl)) return

    let target: URL
    try {
      target = new URL(redirectUrl, OAUTH)
    } catch {
      target = new URL(`${OAUTH}${redirectUrl}`)
    }
    const lt = target.searchParams.get('lt') ?? ''
    const reqId = target.searchParams.get('reqId') ?? ''
    const appId = target.searchParams.get('appId') ?? 'cloud'
    if (!lt || !reqId) throw DriverError.auth('189 login did not return the OAuth parameters; paste a browser Cookie instead.')

    const authHeaders = (): Record<string, string> => ({
      'User-Agent': USER_AGENT,
      lt,
      reqid: reqId,
      referer: redirectUrl,
      origin: OAUTH,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json;charset=UTF-8',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    })

    const appConfResponse = await fetch(`${OAUTH}/api/logbox/oauth2/appConf.do`, {
      method: 'POST',
      headers: authHeaders(),
      body: new URLSearchParams({ version: '2.0', appKey: appId }),
      signal: AbortSignal.timeout(30_000),
    })
    await this.syncCookie(appConfResponse)
    const appConf = await appConfResponse.json() as {
      result?: string
      msg?: string
      data?: { accountType?: string; clientType?: number; isOauth2?: boolean; mailSuffix?: string; paramId?: string; returnUrl?: string }
    }
    if (appConf.result !== '0' || !appConf.data) {
      throw DriverError.auth(`189 app configuration failed: ${appConf.msg ?? 'unknown error'}`)
    }

    const encryptResponse = await fetch(`${OAUTH}/api/logbox/config/encryptConf.do`, {
      method: 'POST',
      headers: authHeaders(),
      body: new URLSearchParams({ appId }),
      signal: AbortSignal.timeout(30_000),
    })
    await this.syncCookie(encryptResponse)
    const encrypt = await encryptResponse.json() as { result?: number; data?: { pre?: string; pubKey?: string } }
    if (encrypt.result !== 0 || !encrypt.data?.pubKey) {
      throw DriverError.auth('189 did not return the login encryption key; paste a browser Cookie instead.')
    }
    const prefix = encrypt.data.pre ?? ''
    const encryptedUser = prefix + rsaEncode(username, encrypt.data.pubKey, true)
    const encryptedPassword = prefix + rsaEncode(password, encrypt.data.pubKey, true)

    const loginResponse = await fetch(`${OAUTH}/api/logbox/oauth2/loginSubmit.do`, {
      method: 'POST',
      headers: authHeaders(),
      body: new URLSearchParams({
        version: 'v2.0',
        apToken: '',
        appKey: appId,
        accountType: appConf.data.accountType || '01',
        userName: encryptedUser,
        epd: encryptedPassword,
        captchaType: '',
        validateCode: '',
        smsValidateCode: '',
        captchaToken: '',
        returnUrl: appConf.data.returnUrl || 'https://cloud.189.cn/main.action',
        mailSuffix: appConf.data.mailSuffix || '@189.cn',
        dynamicCheck: 'FALSE',
        clientType: String(appConf.data.clientType ?? '10010'),
        cb_SaveName: '3',
        isOauth2: String(appConf.data.isOauth2 ?? false),
        state: '',
        paramId: appConf.data.paramId || '',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    await this.syncCookie(loginResponse)
    const loginResult = await loginResponse.json() as { result?: number; msg?: string; toUrl?: string }
    if (loginResult.result !== 0) {
      const message = loginResult.msg ?? '189 sign-in failed'
      if (/\u9a8c\u8bc1\u7801|\u6ed1\u5757|\u8bbe\u5907\u9501|\u5b89\u5168/i.test(message)) {
        throw DriverError.auth(
          `189 sign-in was challenged by a slider/CAPTCHA (${message}). Open https://cloud.189.cn in a browser, ` +
            'copy the Cookie and paste it into the storage settings.',
        )
      }
      throw DriverError.auth(message)
    }
    if (loginResult.toUrl) {
      await this.followRedirects(loginResult.toUrl, { 'User-Agent': USER_AGENT })
    }
    await this.saveCredential({ cookie: this.cookie })
  }

  // ---- Listing ---------------------------------------------------------------------------

  private async getFilesPage(folderId: string, pageNum: number, pageSize: number): Promise<ListData189> {
    const payload = await this.api<ListData189>(`${API}/open/file/listFiles.action`, {
      method: 'GET',
      params: {
        pageSize: String(pageSize),
        pageNum: String(pageNum),
        mediaType: '0',
        folderId: folderId || this.rootId(),
        iconOption: '5',
        orderBy: 'lastOpTime',
        descending: 'true',
      },
    })
    const list = payload.fileListAO
    if (!list || typeof list.count === 'undefined' || !Array.isArray(list.fileList) || !Array.isArray(list.folderList)) {
      throw DriverError.upstream('189 list response is missing fileListAO')
    }
    return payload
  }

  private async listPage(folderId: string, pageNum: number, pageSize: number): Promise<{ files: File189[]; folders: Folder189[]; count: number }> {
    const payload = await this.getFilesPage(folderId, pageNum, pageSize)
    const list = payload.fileListAO!
    return {
      files: list.fileList ?? [],
      folders: list.folderList ?? [],
      count: Number(list.count ?? 0),
    }
  }

  private async allItems(folderId: string, findName?: string): Promise<Item189[]> {
    const items: Item189[] = []
    const pageSize = this.pageSize()
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.listPage(folderId, page, pageSize)
      const folders = result.folders.map((folder) => this.folderOf(folder))
      const files = result.files.map((file) => this.fileOf(file))
      items.push(...folders, ...files)
      if (findName && items.some((item) => item.name === findName)) break
      if (result.files.length + result.folders.length < pageSize) break
      if (items.length >= result.count) break
    }
    return items
  }

  private folderOf(folder: Folder189): Item189 {
    return { ref: String(folder.id), name: folder.name, size: 0, modified: decodeTime(folder.lastOpTime), folder: true }
  }

  private fileOf(file: File189): Item189 {
    return {
      ref: String(file.id),
      name: file.name,
      size: Math.max(0, Number(file.size ?? 0)),
      modified: decodeTime(file.lastOpTime),
      folder: false,
    }
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
      if (!create) throw DriverError.notFound(`189 folder not found: ${segment}`)
      await this.api(`${API}/open/file/createFolder.action`, {
        method: 'POST',
        body: { parentFolderId: parent, folderName: segment },
      })
      const again = await this.allItems(parent, segment)
      const created = again.find((item) => item.folder && item.name === segment)
      if (!created) throw DriverError.upstream(`189 could not create the folder: ${segment}`)
      parent = created.ref
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveItem(path: string): Promise<Item189> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parent = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    const items = await this.allItems(parent, name)
    const found = items.find((item) => item.name === name)
    if (!found) throw DriverError.notFound(`189 item not found: ${name}`)
    return found
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return this.run(async () => {
      const folderId = await this.resolveFolderId(clean)
      const pageSize = Math.min(100, Math.max(1, options.pageSize ?? this.pageSize()))
      const search = options.search?.trim().toLocaleLowerCase() ?? ''

      if (options.page !== undefined) {
        const page = Math.max(1, options.page)
        const result = await this.listPage(folderId, page, pageSize)
        const entries = [
          ...result.folders.map((folder) => this.entryOf(this.folderOf(folder))),
          ...result.files.map((file) => this.entryOf(this.fileOf(file))),
        ]
        const next = page * pageSize < result.count ? String(page + 1) : null
        const filtered = search ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(search)) : entries
        return { entries: filtered, cursor: next, truncated: next !== null }
      }

      const collected = await collectPages(async ({ page }) => {
        const result = await this.listPage(folderId, page, pageSize)
        const entries = [
          ...result.folders.map((folder) => this.entryOf(this.folderOf(folder))),
          ...result.files.map((file) => this.entryOf(this.fileOf(file))),
        ]
        return { items: entries, next: page * pageSize < result.count ? String(page + 1) : null }
      }, { maxPages: MAX_PAGES })
      const filtered = search ? collected.items.filter((entry) => entry.name.toLocaleLowerCase().includes(search)) : collected.items
      return { entries: filtered, cursor: null, truncated: collected.truncated }
    })
  }

  private entryOf(item: Item189): DriverEntry {
    return {
      name: item.name,
      kind: item.folder ? 'folder' : 'file',
      size: item.folder ? 0 : item.size,
      modifiedAt: item.modified,
      ref: item.ref,
      mime: item.folder ? 'application/octet-stream' : driverEntryMime(item.name),
    }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return this.run(async () => {
      if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
      return this.entryOf(await this.resolveItem(clean))
    })
  }

  // ---- Reading ---------------------------------------------------------------------------

  private downloadHeaders(range?: string | null): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      Referer: 'https://cloud.189.cn/',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(range ? { Range: range } : {}),
    }
  }

  private async downloadUrl(fileId: string): Promise<string> {
    const payload = await this.api<{ fileDownloadUrl?: string; downloadUrl?: string }>(`${API}/portal/getFileInfo.action`, {
      method: 'GET',
      params: { fileId },
    })
    const raw = payload.fileDownloadUrl ?? payload.downloadUrl ?? ''
    if (!raw) throw DriverError.upstream(`189 returned no download address for ${fileId}`)
    return raw.startsWith('//') ? `https:${raw}` : raw.replace(/^http:\/\//i, 'https://')
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
        headers: this.downloadHeaders(range),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw this.responseError(response.status, '189 download failed')
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return this.run(async () => {
      const item = await this.resolveItem(clean)
      if (item.folder) return null
      let url = await this.downloadUrl(item.ref)
      try {
        const probe = await fetch(url, { method: 'GET', redirect: 'manual', headers: this.downloadHeaders() })
        await probe.body?.cancel().catch(() => undefined)
        const location = probe.headers.get('location')
        if (probe.status === 302 && location) url = location.replace(/^http:\/\//i, 'https://')
      } catch {
        // The original address is still a usable direct link.
      }
      return url
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
      await this.api(`${API}/open/file/createFolder.action`, {
        method: 'POST',
        body: { parentFolderId: parent, folderName: driverFileName(clean) },
      })
      this.pathIds.clear()
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    if (!newName || newName.includes('/') || newName.includes('\\')) throw DriverError.invalid('The new name is invalid')
    await this.run(async () => {
      const item = await this.resolveItem(clean)
      const url = item.folder ? `${API}/open/file/renameFolder.action` : `${API}/open/file/renameFile.action`
      await this.api(url, {
        method: 'POST',
        body: item.folder
          ? { folderId: item.ref, destFolderName: newName }
          : { fileId: item.ref, destFileName: newName },
      })
      this.pathIds.clear()
    })
  }

  private async batchTask(type: 'MOVE' | 'COPY' | 'DELETE', item: Item189, targetFolderId = ''): Promise<void> {
    const target = targetFolderId || this.rootId()
    await this.api(`${API}/open/batch/createBatchTask.action`, {
      method: 'POST',
      body: {
        type,
        targetFolderId: target,
        taskInfos: JSON.stringify([{ fileId: item.ref, fileName: item.name, isFolder: item.folder ? 1 : 0 }]),
      },
    })
  }

  private async renameCopiedItem(parentId: string, oldName: string, newName: string): Promise<void> {
    const items = await this.allItems(parentId, oldName)
    const copied = items.find((item) => item.name === oldName)
    if (!copied) throw DriverError.upstream(`189 copied "${oldName}" but the copy cannot be found`)
    const url = copied.folder ? `${API}/open/file/renameFolder.action` : `${API}/open/file/renameFile.action`
    await this.api(url, {
      method: 'POST',
      body: copied.folder
        ? { folderId: copied.ref, destFolderName: newName }
        : { fileId: copied.ref, destFileName: newName },
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.run(async () => {
      const item = await this.resolveItem(from)
      const targetName = driverFileName(to)
      const targetParent = await this.resolveFolderId(driverParentPath(to), true)
      if (item.name !== targetName) {
        const url = item.folder ? `${API}/open/file/renameFolder.action` : `${API}/open/file/renameFile.action`
        await this.api(url, {
          method: 'POST',
          body: item.folder
            ? { folderId: item.ref, destFolderName: targetName }
            : { fileId: item.ref, destFileName: targetName },
        })
      }
      await this.batchTask('MOVE', { ...item, name: targetName }, targetParent)
      this.pathIds.clear()
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.run(async () => {
      const item = await this.resolveItem(from)
      const targetName = driverFileName(to)
      const targetParent = await this.resolveFolderId(driverParentPath(to), true)
      await this.batchTask('COPY', item, targetParent)
      if (item.name !== targetName) await this.renameCopiedItem(targetParent, item.name, targetName)
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.run(async () => {
      const item = await this.resolveItem(clean)
      await this.batchTask('DELETE', item)
      this.pathIds.clear()
    })
  }

  // ---- Upload ----------------------------------------------------------------------------

  private async getSessionKey(): Promise<string> {
    const payload = await this.api<{ sessionKey?: string }>(`${API}/v2/getUserBriefInfo.action`)
    const key = String(payload.sessionKey ?? '')
    if (!key) throw DriverError.upstream('189 did not return an upload session key')
    this.sessionKey = key
    return key
  }

  private async getResKey(): Promise<{ pubKey: string; pkId: string }> {
    if (this.rsaKey && this.rsaKey.expire > Date.now()) return this.rsaKey
    const payload = await this.api<{ pubKey?: string; pkId?: string; expire?: number }>(`${API}/security/generateRsaKey.action`)
    const pubKey = String(payload.pubKey ?? '')
    const pkId = String(payload.pkId ?? '')
    if (!pubKey || !pkId) throw DriverError.upstream('189 did not return an upload RSA key')
    this.rsaKey = { pubKey, pkId, expire: Number(payload.expire ?? 0) || Date.now() + 5 * 60_000 }
    return this.rsaKey
  }

  private async uploadRequest<T = Api189>(uri: string, form: Record<string, string>): Promise<T> {
    if (!this.sessionKey) await this.getSessionKey()
    const requestDate = String(Date.now())
    const requestId = randomUUID()
    const randomKey = randomUUID('xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx').slice(0, 16 + Math.floor(Math.random() * 17))
    const params = Object.keys(form).sort().map((key) => `${key}=${form[key]}`).join('&')
    const encryptedParams = aesEcbHex(params, randomKey.slice(0, 16))
    const signature = hmacSha1Hex(
      `SessionKey=${this.sessionKey}&Operate=GET&RequestURI=${uri}&Date=${requestDate}&params=${encryptedParams}`,
      randomKey,
    )
    const { pubKey, pkId } = await this.getResKey()
    const headers: Record<string, string> = {
      accept: 'application/json;charset=UTF-8',
      SessionKey: this.sessionKey,
      Signature: signature,
      'X-Request-Date': requestDate,
      'X-Request-ID': requestId,
      EncryptionText: rsaEncode(randomKey, pubKey, false),
      PkId: pkId,
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    }
    const target = new URL(`${UPLOAD_API}${uri}`)
    target.searchParams.set('params', encryptedParams)
    const response = await fetch(target.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(30_000) })
    await this.syncCookie(response)
    const text = await response.text()
    let payload: Api189
    try {
      payload = parseJsonPreservingIds(text)
    } catch {
      throw DriverError.upstream('189 upload API answered with a non-JSON body')
    }
    if (String(payload.errorCode ?? '') === 'InvalidSessionKey') {
      throw DriverError.auth('189 rejected the upload session key')
    }
    if (payload.code !== 'SUCCESS') {
      const message = String(payload.msg ?? payload.message ?? `189 upload API failed: ${uri}`)
      if (isAuthMessage(message)) throw DriverError.auth(message)
      throw DriverError.upstream(message)
    }
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
      const fileMd5 = md5Hex(bytes)
      if (!/^[a-f0-9]{32}$/.test(fileMd5)) throw DriverError.invalid('189 upload needs a valid MD5')
      const sessionKey = await this.getSessionKey()
      let init: { data?: { uploadFileId?: string | number; fileDataExists?: number | string } }
      try {
        init = await this.uploadRequest('/person/initMultiUpload', {
          parentFolderId: parent,
          fileName: encodeURIComponent(name).replace(/%20/g, '+'),
          fileSize: String(size),
          sliceSize: String(chunkSize),
          fileMd5,
          sliceMd5: fileMd5,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/InfoSecurityErrorCode|file md5 is in black list|security check not pass/i.test(message)) throw error
        init = await this.uploadRequest('/person/initMultiUpload', {
          parentFolderId: parent,
          fileName: encodeURIComponent(name).replace(/%20/g, '+'),
          fileSize: String(size),
          sliceSize: String(chunkSize),
          lazyCheck: '1',
        })
      }
      const uploadFileId = String(init.data?.uploadFileId ?? '')
      if (!uploadFileId) throw DriverError.upstream('189 did not create an upload session')
      if (String(init.data?.fileDataExists ?? '0') === '1') {
        options.onProgress?.(size, size)
        this.pathIds.clear()
        return
      }

      const session: UploadSession189 = { uploadFileId, sessionKey, fileMd5, partCount, chunkSize }
      const partMd5s = new Array<string>(partCount)
      await uploadInParts({
        size,
        partSize: chunkSize,
        concurrency: Math.min(8, partCount),
        uploadPart: async (partNumber, start, end) => {
          const chunk = bytes.subarray(start, end)
          const part = await this.uploadRequest<{ uploadUrls?: Record<string, { requestURL?: string; requestHeader?: string }> }>(
            '/person/getMultiUploadUrls',
            { uploadFileId: session.uploadFileId, partInfo: `${partNumber}-${md5Base64(chunk)}` },
          )
          const entry = part.uploadUrls?.[`partNumber_${partNumber}`]
          if (!entry?.requestURL) throw DriverError.upstream(`189 returned no upload URL for part ${partNumber}`)
          partMd5s[partNumber - 1] = md5Hex(chunk)
          const response = await fetch(entry.requestURL, {
            method: 'PUT',
            headers: parseHeaderString(entry.requestHeader ?? ''),
            body: chunk,
            signal: AbortSignal.timeout(60_000),
          })
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            throw DriverError.upstream(`189 upload part ${partNumber}/${partCount} failed (HTTP ${response.status})`)
          }
          options.onProgress?.(end, size)
        },
        complete: async () => {
          const sliceMd5 = partCount === 1 ? session.fileMd5 : md5Hex(partMd5s.join('\n')).toUpperCase()
          await this.uploadRequest('/person/commitMultiUploadFile', {
            uploadFileId: session.uploadFileId,
            fileMd5: session.fileMd5,
            sliceMd5,
            lazyCheck: '1',
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
      const page = await this.getFilesPage(this.rootId(), 1, 1)
      return { ok: true, message: `189 Cloud is reachable (${page.fileListAO?.count ?? 0} items)` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '189 Cloud is unavailable' }
    }
  }
}

export function create189Driver(ctx: DriverContext): MountDriver {
  return new Yun189Driver(ctx)
}
