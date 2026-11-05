/**
 * China Mobile Cloud (139) account driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/139`: the signed request envelope,
 * the routed personal cloud host, the four storage flavours (personal_new / personal /
 * family / group), the cursor pagination of the new personal cloud and the SHA256
 * multipart upload contract follow the reference. The reference's mail sign-in fallback is
 * reproduced here with WebCrypto/BigInt primitives only; when 139 Mail raises a slider or
 * SMS challenge the driver stops and asks for a browser Authorization token.
 */
import { cbc, ecb } from '@noble/ciphers/aes.js'
import { md5, sha1 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
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
  driverChildPath,
  driverFileName,
  driverParentPath,
  driverPath,
  uploadInParts,
} from './http'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const ROUTE_URL = 'https://user-njs.yun.139.com/user/route/qryRoutePolicy'
const REFRESH_URL = 'https://user-njs.yun.139.com/user/auth/refreshToken'
const MAIL_LOGIN_URL = 'https://mail.10086.cn/Login/Login.ashx'
const MAIL_ARTIFACT_URL = 'https://smsrebuild1.mail.10086.cn/setting/s'
const MAIL_SSO_URL = 'https://user-njs.yun.139.com/user/thirdlogin'
const MAIL_KEY_1 = '73634235495062495331515373756c734e7253306c673d3d'
const MAIL_KEY_2 = '7150714477323633586746674c337538'
const DEFAULT_HOST = 'https://yun.139.com'
const ROOT_PARENT_IDS = new Set(['/', '0', 'root', 'cloud139_root'])
const ROUTE_RETRY_CODES = new Set(['9000', '9008', '9100'])
const PAGE_LIMIT = 100
const MAX_PAGES = 50

type Yun139Type = 'personal_new' | 'personal' | 'family' | 'group'

interface PersonalItem {
  fileId?: string
  catalogId?: string
  catalogID?: string
  name: string
  size?: number | string
  type: string
  createdAt?: string
  updatedAt?: string
  thumbnailUrls?: Array<{ style?: string; url?: string }>
}

interface RawItem {
  ref: string
  name: string
  size: number
  modified: number
  folder: boolean
}

interface ApiPayload {
  success?: boolean
  code?: string | number
  message?: string
  msg?: string
  data?: Record<string, unknown>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '')
  const out = new Uint8Array(clean.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
  }
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

function base64ToText(value: string): string {
  return decoder.decode(base64ToBytes(value))
}

function md5Hex(value: string | Uint8Array): string {
  return bytesToHex(md5(typeof value === 'string' ? utf8(value) : value))
}

function sha1Hex(value: string): string {
  return bytesToHex(sha1(utf8(value)))
}

function aesCbcEncryptBase64(text: string, keyHex: string): string {
  const iv = new Uint8Array(16)
  crypto.getRandomValues(iv)
  const ciphertext = cbc(hexToBytes(keyHex), iv).encrypt(utf8(text))
  const combined = new Uint8Array(iv.length + ciphertext.length)
  combined.set(iv, 0)
  combined.set(ciphertext, iv.length)
  return bytesToBase64(combined)
}

function aesEcbDecryptHex(hex: string, keyHex: string): string {
  return decoder.decode(ecb(hexToBytes(keyHex)).decrypt(hexToBytes(hex)))
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => sortedJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(',')}}`
}

function randomString(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** The `mcloud-sign` value: CRC-free MD5 of the URI-encoded, sorted body. */
function calSign(body: string, timestamp: string, random: string): string {
  const encoded = encodeURIComponent(body)
  const sorted = [...encoded].sort().join('')
  const digest = md5Hex(bytesToBase64(utf8(sorted))) + md5Hex(`${timestamp}:${random}`)
  return md5Hex(digest).toUpperCase()
}

function isAuthMessage(message: string): boolean {
  return /token|\u767b\u5f55|\u767b\u9646|\u6388\u6743|\u8fc7\u671f|\u5931\u6548|\u672a\u767b\u5f55|authorization/i.test(message)
}

function decodeTime(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sizeOf(value: unknown): number {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function sameName(left: string, right: string): boolean {
  return left.trim().normalize('NFC') === right.trim().normalize('NFC')
}

class Yun139Driver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('139')!
  readonly capabilities = this.definition.capabilities
  private authorization = ''
  private account = ''
  private personalHost = ''
  private familyHost = ''
  private groupHost = ''
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private type(): Yun139Type {
    const value = this.configText('type', 'personal_new')
    return value === 'personal' || value === 'family' || value === 'group' ? value : 'personal_new'
  }

  private cloudId(): string {
    return this.configText('cloudId').trim()
  }

  private rootId(): string {
    const configured = this.configText('rootFolderId').trim()
    if (configured) return configured
    switch (this.type()) {
      case 'personal':
        return 'root'
      case 'group':
        return this.cloudId()
      case 'family':
        return '/'
      default:
        return '/'
    }
  }

  private username(): string {
    return this.configText('username').trim()
  }

  private password(): string {
    return this.ctx.credentials.password ?? ''
  }

  private mailCookies(): string {
    return this.ctx.credentials.mailCookies ?? ''
  }

  private hasPassword(): boolean {
    return Boolean(this.username() && this.password())
  }

  private authString(): string {
    return this.authorization.trim().replace(/^Basic\s+/i, '')
  }

  private extractAccount(authorization: string): string {
    const text = authorization.trim().replace(/^Basic\s+/i, '')
    if (!text) return ''
    try {
      const decoded = base64ToText(text)
      const pieces = decoded.split(':')
      return pieces.length >= 2 ? pieces[1] ?? '' : ''
    } catch {
      return ''
    }
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
    this.authorization = this.ctx.credentials.authorization ?? ''
    this.account = this.extractAccount(this.authorization)
    this.personalHost = ''
    this.familyHost = ''
    this.groupHost = ''

    if (this.authorization && !(force && this.hasPassword())) {
      try {
        await this.refreshIfNeeded()
      } catch {
        // A failed refresh is only fatal when there is no password to fall back on; the probe below
        // decides that.
      }
      if (await this.probe()) return
      if (!this.hasPassword()) {
        throw DriverError.auth(
          '139 rejected the stored Authorization. Paste a fresh Authorization or browser Cookie from ' +
            'https://yun.139.com (the browser session is the only reliable way past 139 Mail risk control).',
        )
      }
      this.authorization = ''
      this.account = ''
    }

    if (!this.hasPassword()) {
      throw DriverError.auth(
        '139 needs an Authorization token or browser Cookie captured from https://yun.139.com, or an account ' +
          'and password (mail sign-in cannot pass a slider or SMS challenge; in that case paste a browser ' +
          'Authorization/Cookie).',
      )
    }

    this.authorization = await this.passwordLogin()
    this.account = this.extractAccount(this.authorization)
    await this.loadRoutes()
  }

  /** Refreshes a near-expiry PC token when the vault has the matching userDomainId. */
  private async refreshIfNeeded(): Promise<void> {
    const auth = this.authString()
    if (!auth) return
    let decoded = ''
    try {
      decoded = base64ToText(auth)
    } catch {
      return
    }
    const pieces = decoded.split(':')
    if (pieces.length < 3) return
    const token = pieces.slice(2).join(':')
    const expiry = Number(token.split('|')[3])
    if (!Number.isFinite(expiry) || expiry <= 0) return
    if (expiry - Date.now() > 15 * 24 * 60 * 60 * 1000) return
    const userDomainId = (this.ctx.credentials.userDomainId ?? '').trim()
    if (!userDomainId) return

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      app_auth: `Basic ${auth}`,
      app_cp: '1',
      authorization: `Basic ${auth}`,
      cp_version: '8.9.1.20260929',
      'x-yun-api-version': 'v1',
      'x-yun-app-channel': '10200153',
      'x-yun-op-type': '1',
      'x-yun-svc-type': '1',
      'x-yun-module-type': '1',
      'x-yun-market-source': '1',
      'x-yun-client-info': 'PC',
    }
    const response = await this.request(REFRESH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userDomainId }),
    })
    const payload = await response.json() as { success?: boolean; code?: string; data?: { token?: string } }
    const nextToken = payload.data?.token?.trim() ?? ''
    if (!payload.success || payload.code !== '0000' || !nextToken) return
    const authorization = bytesToBase64(utf8(`${pieces[0]}:${this.account}:${nextToken}`))
    this.authorization = authorization
    await this.saveCredential({ authorization })
  }

  private async probe(): Promise<boolean> {
    try {
      await this.loadRoutes()
      if (this.type() === 'personal_new') {
        return Boolean(this.personalHost) && this.personalHost !== DEFAULT_HOST
      }
      await this.listFolderItems(this.rootId())
      return true
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'rate_limit') throw error
      return false
    }
  }

  /** Signs and sends one request without raising business-level errors. */
  private async rawPost<T extends ApiPayload = ApiPayload>(url: string, body: unknown): Promise<T> {
    const bodyText = JSON.stringify(body ?? {})
    const timestamp = formatTime(new Date())
    const random = randomString(16)
    const signature = calSign(bodyText, timestamp, random)
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'CMS-DEVICE': 'default',
      Authorization: `Basic ${this.authString()}`,
      Caller: 'web',
      'Mcloud-Channel': '1000101',
      'Mcloud-Client': '10701',
      'Mcloud-Route': '001',
      'mcloud-channel': '1000101',
      'mcloud-client': '10701',
      'mcloud-sign': `${timestamp},${random},${signature}`,
      'mcloud-version': '7.14.0',
      Origin: 'https://yun.139.com',
      Referer: 'https://yun.139.com/w/',
      'x-DeviceInfo': '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||',
      'x-huawei-channelSrc': '10000034',
      'x-inner-ntwk': '2',
      'x-m4c-caller': 'PC',
      'x-m4c-src': '10002',
      'x-SvcType': this.type() === 'family' ? '2' : '1',
      'Inner-Hcy-Router-Https': '1',
      'X-Yun-Api-Version': 'v1',
      'X-Yun-App-Channel': '10000034',
      'X-Yun-Channel-Source': '10000034',
      'X-Yun-Client-Info': '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||dW5kZWZpbmVk||',
      'X-Yun-Module-Type': '100',
      'X-Yun-Svc-Type': '1',
    }
    const response = await this.request(url, { method: 'POST', headers, body: bodyText })
    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw DriverError.upstream('139 Cloud answered with a non-JSON body')
    }
  }

  private async loadRoutes(): Promise<void> {
    const body = {
      userInfo: { userType: 1, accountType: 1, accountName: this.account },
      modAddrType: 1,
    }
    let payload: ApiPayload
    try {
      payload = await this.rawPost(ROUTE_URL, body)
    } catch (error) {
      if (this.type() === 'personal_new') throw error
      return
    }
    if (payload.success === false) {
      const message = payload.message ?? payload.msg ?? '139 route policy failed'
      if (isAuthMessage(message)) throw DriverError.auth(message)
      throw DriverError.upstream(message)
    }
    const policies = (payload.data as { routePolicyList?: Array<{ modName?: string; httpsUrl?: string }> } | undefined)
      ?.routePolicyList ?? []
    for (const policy of policies) {
      const host = (policy.httpsUrl ?? '').replace(/\/+$/, '')
      if (!host) continue
      if (policy.modName === 'personal') this.personalHost = host
      else if (policy.modName === 'family') this.familyHost = host
      else if (policy.modName === 'group') this.groupHost = host
    }
    if (this.type() === 'personal_new' && (!this.personalHost || this.personalHost === DEFAULT_HOST)) {
      throw DriverError.upstream(
        '139 personal_new needs the routed personal host from queryRoutePolicy; the default host ' +
          'silently ignores parentFileId and always lists the root.',
      )
    }
  }

  /** Candidate URLs in the same order as the reference so a healthy account makes one request. */
  private buildRequestUrls(path: string): string[] {
    if (path.startsWith('http://') || path.startsWith('https://')) return [path]
    if (path.startsWith('/orchestration/')) return [`${DEFAULT_HOST}${path}`]

    const host = this.type() === 'personal_new'
      ? this.personalHost
      : this.type() === 'family'
        ? this.familyHost
        : this.type() === 'group'
          ? this.groupHost
          : DEFAULT_HOST
    if (this.type() === 'personal_new' && (!host || host === DEFAULT_HOST)) {
      throw DriverError.upstream('139 personal_new has no routed personal host')
    }

    const bases: string[] = []
    const pushBase = (value: string): void => {
      const base = value.replace(/\/+$/, '')
      if (base && !bases.includes(base)) bases.push(base)
    }
    pushBase(host || DEFAULT_HOST)
    pushBase((host || DEFAULT_HOST)
      .replace(/\/hcy\/orchestration\/?$/i, '/orchestration')
      .replace(/\/hcy\/?$/i, ''))

    const urls: string[] = []
    const pushUrl = (value: string): void => {
      if (value && !urls.includes(value)) urls.push(value)
    }
    for (const base of bases) {
      let pathname = ''
      try {
        pathname = new URL(base).pathname.replace(/\/+$/, '')
      } catch {
        pathname = ''
      }
      if (pathname.endsWith('/orchestration')) {
        pushUrl(`${base}${path}`)
      } else if (pathname && pathname !== '/') {
        pushUrl(`${base}${path}`)
        pushUrl(`${base}/orchestration${path}`)
      } else {
        pushUrl(`${base}/orchestration${path}`)
        pushUrl(`${base}${path}`)
      }
    }
    return urls
  }

  private detectWrongListing(parentId: string, items: unknown): string | null {
    const wanted = parentId.trim()
    if (!wanted || ROOT_PARENT_IDS.has(wanted)) return null
    if (!Array.isArray(items)) return null
    for (const raw of items) {
      const item = raw as PersonalItem
      const id = String(item.fileId ?? item.catalogId ?? item.catalogID ?? '')
      if (id && id === wanted) {
        return `the listing contains the requested folder itself ("${item.name}", id=${wanted}); ` +
          'the server ignored parentFileId and returned the parent directory'
      }
    }
    return null
  }

  /** A signed API call with route-candidate fallback and the wrong-listing self check. */
  private async api<T extends ApiPayload = ApiPayload>(
    path: string,
    body: unknown,
    validate?: (payload: T) => string | null,
  ): Promise<T> {
    const candidates = this.buildRequestUrls(path)
    let lastError: DriverError | null = null
    for (const candidate of candidates) {
      try {
        const payload = await this.rawPost<T>(candidate, body)
        if (payload?.success === false) {
          const code = String(payload.code ?? '')
          const message = payload.message ?? payload.msg ?? `139 Cloud answered code ${code}`
          if (ROUTE_RETRY_CODES.has(code)) {
            lastError = DriverError.upstream(message)
            continue
          }
          if (isAuthMessage(message) || code === '401' || code === '403') throw DriverError.auth(message)
          throw DriverError.upstream(message)
        }
        const rejected = validate?.(payload) ?? null
        if (rejected) {
          lastError = DriverError.upstream(rejected)
          continue
        }
        return payload
      } catch (error) {
        if (error instanceof DriverError) {
          const routeMissing = error.kind === 'not_found' ||
            (error.kind === 'upstream' && /route not found/i.test(error.message))
          if (routeMissing) {
            lastError = error
            continue
          }
        }
        throw error
      }
    }
    throw lastError ?? DriverError.upstream(`139 Cloud did not answer ${path}`)
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

  private async personalPage(parentId: string, cursor: string, pageSize: number): Promise<{ items: PersonalItem[]; next: string }> {
    const payload = await this.api('/file/list', {
      parentFileId: parentId || this.rootId() || '/',
      pageInfo: { pageCursor: cursor, pageSize },
      orderBy: 'updated_at',
      orderDirection: 'DESC',
      imageThumbnailStyleList: ['Small', 'Large'],
    }, (result) => this.detectWrongListing(parentId, result.data?.items))
    const data = payload.data as { items?: PersonalItem[]; nextPageCursor?: string } | undefined
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      next: data?.nextPageCursor ?? '',
    }
  }

  /** The new personal cloud is cursor based; page N walks cursors N-1 times. */
  private async personalPageNumber(parentId: string, page: number, pageSize: number): Promise<{ items: PersonalItem[]; next: string }> {
    let cursor = ''
    let current = 1
    for (;;) {
      const result = await this.personalPage(parentId, cursor, pageSize)
      if (current === page) return result
      if (!result.next || result.next === cursor) return { items: [], next: '' }
      cursor = result.next
      current += 1
      if (current > MAX_PAGES) return { items: [], next: '' }
    }
  }

  private async personalAll(parentId: string, pageSize = PAGE_LIMIT): Promise<PersonalItem[]> {
    const items: PersonalItem[] = []
    let cursor = ''
    let page = 1
    for (;;) {
      const result = await this.personalPage(parentId, cursor, pageSize)
      items.push(...result.items)
      if (!result.next || result.next === cursor) return items
      cursor = result.next
      page += 1
      if (page > MAX_PAGES) return items
    }
  }

  private async listFolderItems(folderId: string): Promise<RawItem[]> {
    switch (this.type()) {
      case 'personal_new': {
        const items = await this.personalAll(folderId)
        return items.map((item) => this.personalRaw(item))
      }
      case 'personal': {
        const payload = await this.api('/orchestration/personalCloud/catalog/v1.0/getDisk', {
          catalogID: folderId,
          sortDirection: 1,
          filterType: 0,
          catalogSortType: 0,
          contentSortType: 0,
          startNumber: 1,
          endNumber: 5000,
          commonAccountInfo: this.commonAccount(),
        })
        const result = payload.data?.getDiskResult as {
          nodeCount?: number
          catalogList?: Array<{ catalogID?: string; catalogName?: string; updateTime?: string }>
          fileList?: Array<{ contentID?: string; contentName?: string; contentSize?: number | string; updateTime?: string; createTime?: string }>
          contentList?: Array<{ contentID?: string; contentName?: string; contentSize?: number | string; updateTime?: string; createTime?: string }>
        } | undefined
        const files = result?.fileList ?? result?.contentList ?? []
        const folders = result?.catalogList ?? []
        return [
          ...folders.map((folder) => ({
            ref: folder.catalogID ?? '',
            name: folder.catalogName ?? '',
            size: 0,
            modified: decodeTime(folder.updateTime),
            folder: true,
          })),
          ...files.map((file) => ({
            ref: file.contentID ?? '',
            name: file.contentName ?? '',
            size: sizeOf(file.contentSize),
            modified: decodeTime(file.updateTime || file.createTime),
            folder: false,
          })),
        ].filter((item) => item.ref && item.name)
      }
      case 'family': {
        const collected: RawItem[] = []
        let page = 1
        for (;;) {
          const payload = await this.api('/orchestration/familyCloud-rebuild/content/v1.2/queryContentList',
            this.newJson({
              catalogID: folderId,
              contentSortType: 0,
              pageInfo: { pageNum: page, pageSize: PAGE_LIMIT },
              sortDirection: 1,
            }))
          const data = payload.data as {
            path?: string
            totalCount?: number
            cloudCatalogList?: Array<{ catalogID?: string; catalogName?: string; lastUpdateTime?: string; createTime?: string }>
            cloudContentList?: Array<{ contentID?: string; contentName?: string; contentSize?: number | string; lastUpdateTime?: string; createTime?: string }>
          } | undefined
          const folders = data?.cloudCatalogList ?? []
          const files = data?.cloudContentList ?? []
          collected.push(
            ...folders.map((folder) => ({
              ref: folder.catalogID ?? '', name: folder.catalogName ?? '', size: 0,
              modified: decodeTime(folder.lastUpdateTime || folder.createTime), folder: true,
            })),
            ...files.map((file) => ({
              ref: file.contentID ?? '', name: file.contentName ?? '', size: sizeOf(file.contentSize),
              modified: decodeTime(file.lastUpdateTime || file.createTime), folder: false,
            })),
          )
          if (folders.length + files.length === 0 || Number(data?.totalCount ?? 0) === 0) break
          if (folders.length + files.length < PAGE_LIMIT) break
          page += 1
          if (page > MAX_PAGES) break
        }
        return collected.filter((item) => item.ref && item.name)
      }
      case 'group': {
        const collected: RawItem[] = []
        let page = 1
        for (;;) {
          const start = (page - 1) * PAGE_LIMIT + 1
          const payload = await this.api('/orchestration/group-rebuild/content/v1.0/queryGroupContentList',
            this.newJson({
              groupID: this.cloudId(),
              catalogID: folderId,
              contentSortType: 0,
              sortDirection: 1,
              startNumber: start,
              endNumber: start + PAGE_LIMIT - 1,
              path: folderId,
            }))
          const result = payload.data?.getGroupContentResult as {
            nodeCount?: number
            catalogList?: Array<{ catalogID?: string; catalogName?: string; updateTime?: string; path?: string }>
            contentList?: Array<{ contentID?: string; contentName?: string; contentSize?: number | string; updateTime?: string }>
          } | undefined
          const folders = result?.catalogList ?? []
          const files = result?.contentList ?? []
          collected.push(
            ...folders.map((folder) => ({
              ref: folder.catalogID ?? '', name: folder.catalogName ?? '', size: 0,
              modified: decodeTime(folder.updateTime), folder: true,
            })),
            ...files.map((file) => ({
              ref: file.contentID ?? '', name: file.contentName ?? '', size: sizeOf(file.contentSize),
              modified: decodeTime(file.updateTime), folder: false,
            })),
          )
          if (folders.length + files.length === 0) break
          if (collected.length >= Number(result?.nodeCount ?? 0)) break
          page += 1
          if (page > MAX_PAGES) break
        }
        return collected.filter((item) => item.ref && item.name)
      }
    }
  }

  private personalRaw(item: PersonalItem): RawItem {
    const ref = String(item.fileId ?? item.catalogId ?? item.catalogID ?? '')
    return {
      ref,
      name: item.name ?? '',
      size: sizeOf(item.size),
      modified: decodeTime(item.updatedAt || item.createdAt),
      folder: item.type === 'folder',
    }
  }

  private entryOf(item: RawItem): DriverEntry {
    return {
      name: item.name,
      kind: item.folder ? 'folder' : 'file',
      size: item.folder ? 0 : item.size,
      modifiedAt: item.modified,
      ref: item.ref,
      mime: item.folder ? 'application/octet-stream' : driverEntryMime(item.name),
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
      const items = await this.listFolderItems(parent)
      const found = items.find((item) => item.folder && sameName(item.name, segment))
      if (found) {
        parent = found.ref
        this.pathIds.set(prefix, parent)
        continue
      }
      if (!create) throw DriverError.notFound(`139 folder not found: ${segment}`)
      await this.createFolder(parent, segment, prefix)
      const again = await this.listFolderItems(parent)
      const created = again.find((item) => item.folder && sameName(item.name, segment))
      if (!created) throw DriverError.upstream(`139 could not create the folder: ${segment}`)
      parent = created.ref
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveFile(path: string): Promise<RawItem> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const items = await this.listFolderItems(parentId)
    const name = driverFileName(clean)
    const found = items.find((item) => !item.folder && sameName(item.name, name))
    if (!found) throw DriverError.notFound(`139 file not found: ${name}`)
    return found
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return this.run(async () => {
      const folderId = await this.resolveFolderId(clean)
      const pageSize = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? PAGE_LIMIT))
      const search = options.search?.trim().toLocaleLowerCase() ?? ''
      let items: RawItem[]
      let cursor: string | null = null
      let truncated = false

      if (this.type() === 'personal_new') {
        if (options.page !== undefined) {
          const result = await this.personalPageNumber(folderId, Math.max(1, options.page), pageSize)
          items = result.items.map((item) => this.personalRaw(item))
          cursor = result.next || null
          truncated = cursor !== null
        } else {
          const raw: PersonalItem[] = []
          let cursor = ''
          let pages = 0
          for (;;) {
            const result = await this.personalPage(folderId, cursor, pageSize)
            raw.push(...result.items)
            pages += 1
            if (!result.next || result.next === cursor) break
            cursor = result.next
            if (pages >= MAX_PAGES) {
              truncated = true
              break
            }
          }
          items = raw.map((item) => this.personalRaw(item))
        }
      } else {
        items = await this.listFolderItems(folderId)
        if (options.page !== undefined) {
          const page = Math.max(1, options.page)
          items = items.slice((page - 1) * pageSize, page * pageSize)
          cursor = page * pageSize < items.length ? String(page + 1) : null
        }
      }

      if (search) items = items.filter((item) => item.name.toLocaleLowerCase().includes(search))
      const entries = items.map((item) => this.entryOf(item)).filter((entry) => entry.name)
      return { entries, cursor, truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return this.run(async () => {
      if (clean === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
      }
      const parentId = await this.resolveFolderId(driverParentPath(clean))
      const items = await this.listFolderItems(parentId)
      const name = driverFileName(clean)
      const found = items.find((item) => sameName(item.name, name))
      if (!found) throw DriverError.notFound(`139 item not found: ${name}`)
      return this.entryOf(found)
    })
  }

  // ---- Reading ---------------------------------------------------------------------------

  private async downloadUrl(item: RawItem, path: string): Promise<string> {
    let payload: ApiPayload
    switch (this.type()) {
      case 'personal_new':
        payload = await this.api('/file/getDownloadUrl', { fileId: item.ref })
        break
      case 'family':
        payload = await this.api('/orchestration/familyCloud-rebuild/content/v1.0/getFileDownLoadURL',
          this.newJson({ contentID: item.ref, path }))
        break
      case 'group':
        payload = await this.api('/orchestration/group-rebuild/groupManage/v1.0/getGroupFileDownLoadURL',
          this.newJson({ contentID: item.ref, groupID: this.cloudId(), path }))
        break
      default:
        payload = await this.api('/orchestration/personalCloud/uploadAndDownload/v1.0/downloadRequest',
          { contentID: item.ref, commonAccountInfo: this.commonAccount() })
    }
    const data = payload.data as { cdnSwitch?: boolean; cdnUrl?: string; url?: string; downloadURL?: string } | undefined
    const url = (data?.cdnSwitch ? data?.cdnUrl : '') || data?.url || data?.cdnUrl || data?.downloadURL || ''
    if (!url) throw DriverError.upstream('139 returned no download address')
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return this.run(async () => {
      const item = await this.resolveFile(clean)
      if (item.folder) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = await this.downloadUrl(item, clean)
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Referer: 'https://yun.139.com/',
          'User-Agent': USER_AGENT,
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw this.responseError(response.status, '139 download failed')
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return this.run(async () => {
      const item = await this.resolveFile(clean)
      if (item.folder) return null
      return await this.downloadUrl(item, clean)
    })
  }

  private responseError(status: number, prefix: string): DriverError {
    if (status === 401 || status === 403) return DriverError.auth(`${prefix} (HTTP ${status})`)
    if (status === 404) return DriverError.notFound(`${prefix} (HTTP 404)`)
    if (status === 429) return DriverError.rateLimited(`${prefix} (HTTP 429)`)
    return DriverError.upstream(`${prefix} (HTTP ${status})`)
  }

  // ---- Mutations -------------------------------------------------------------------------

  private commonAccount(): { account: string; accountType: number } {
    return { account: this.account, accountType: 1 }
  }

  private newJson(data: Record<string, unknown>): Record<string, unknown> {
    return {
      catalogType: 3,
      cloudID: this.cloudId(),
      cloudType: 1,
      commonAccountInfo: this.commonAccount(),
      ...data,
    }
  }

  private async createFolder(parentId: string, name: string, path: string): Promise<void> {
    switch (this.type()) {
      case 'personal_new':
        await this.api('/file/create', {
          parentFileId: parentId,
          name,
          description: '',
          type: 'folder',
          fileRenameMode: 'force_rename',
        })
        return
      case 'personal':
        await this.api('/orchestration/personalCloud/catalog/v1.0/createCatalogExt', {
          createCatalogExtReq: {
            parentCatalogID: parentId,
            newCatalogName: name,
            commonAccountInfo: this.commonAccount(),
          },
        })
        return
      case 'family':
        await this.api('/orchestration/familyCloud-rebuild/cloudCatalog/v1.0/createCloudDoc', this.newJson({
          docLibName: name,
          path: driverParentPath(path),
        }))
        return
      case 'group':
        await this.api('/orchestration/group-rebuild/catalog/v1.0/createGroupCatalog', this.newJson({
          catalogName: name,
          parentFileId: parentId,
          path,
        }))
    }
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    await this.run(async () => {
      const parentId = await this.resolveFolderId(driverParentPath(clean))
      await this.createFolder(parentId, driverFileName(clean), clean)
      this.pathIds.delete(clean)
    })
  }

  private async renameItem(item: RawItem, path: string, newName: string): Promise<void> {
    if (!newName || newName.includes('/') || newName.includes('\\')) throw DriverError.invalid('The new name is invalid')
    switch (this.type()) {
      case 'personal_new':
        await this.api('/file/update', { fileId: item.ref, name: newName, description: '' })
        return
      case 'personal':
        if (item.folder) {
          await this.api('/orchestration/personalCloud/catalog/v1.0/updateCatalogInfo', {
            catalogID: item.ref, catalogName: newName, commonAccountInfo: this.commonAccount(),
          })
        } else {
          await this.api('/orchestration/personalCloud/content/v1.0/updateContentInfo', {
            contentID: item.ref, contentName: newName, commonAccountInfo: this.commonAccount(),
          })
        }
        return
      case 'group':
        if (item.folder) {
          await this.api('/orchestration/group-rebuild/catalog/v1.0/modifyGroupCatalog', this.newJson({
            groupID: this.cloudId(), modifyCatalogID: item.ref, modifyCatalogName: newName, path,
          }))
        } else {
          await this.api('/orchestration/group-rebuild/content/v1.0/modifyGroupContent', this.newJson({
            groupID: this.cloudId(), contentID: item.ref, contentName: newName, path,
          }))
        }
        return
      case 'family':
        if (item.folder) {
          await this.api('/modifyCloudDocV2', this.newJson({
            docLibName: newName, docLibraryID: item.ref, path,
          }))
        } else {
          await this.api('/orchestration/familyCloud-rebuild/photoContent/v1.0/modifyContentInfo', this.newJson({
            contentID: item.ref, contentName: newName, path,
          }))
        }
    }
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    await this.run(async () => {
      const item = await this.resolveFile(clean)
      await this.renameItem(item, clean, newName)
      this.pathIds.clear()
    })
  }

  private async batchOperation(item: RawItem, move: boolean, destinationId: string, destinationPath: string): Promise<void> {
    switch (this.type()) {
      case 'personal_new':
        await this.api(move ? '/file/batchMove' : '/file/batchCopy', {
          fileIds: [item.ref],
          toParentFileId: destinationId,
        })
        return
      case 'personal':
        await this.api('/orchestration/personalCloud/batchOprTask/v1.0/createBatchOprTask', {
          createBatchOprTaskReq: {
            taskType: 3,
            actionType: move ? '304' : 309,
            taskInfo: {
              contentInfoList: item.folder ? [] : [item.ref],
              catalogInfoList: item.folder ? [item.ref] : [],
              newCatalogID: destinationId,
            },
            commonAccountInfo: this.commonAccount(),
          },
        })
        return
      case 'group':
        await this.api('/orchestration/group-rebuild/task/v1.0/createBatchOprTask', this.newJson({
          taskType: 3,
          srcType: 2,
          srcGroupID: this.cloudId(),
          destType: 2,
          destGroupID: this.cloudId(),
          destPath: destinationPath,
          contentList: item.folder ? [] : [item.ref],
          catalogList: item.folder ? [item.ref] : [],
        }))
        return
      case 'family': {
        const payload = await this.api('https://group.yun.139.com/hcy/mutual/adapter/isbo/openApi/createBatchOprTask', {
          catalogList: item.folder ? [item.ref] : [],
          contentList: item.folder ? [] : [item.ref],
          accountInfo: { accountName: this.account, accountType: '1' },
          destCatalogID: destinationId,
          destGroupID: this.cloudId(),
          destPath: destinationPath,
          destType: 0,
          srcGroupID: this.cloudId(),
          srcType: 0,
          taskType: 3,
        })
        const result = payload.data?.result as { resultCode?: string; resultDesc?: string } | undefined
        if (result?.resultCode && result.resultCode !== '0') {
          throw DriverError.upstream(result.resultDesc || '139 family batch task failed')
        }
      }
    }
  }

  private async renameCopiedItem(parentId: string, destinationPath: string, oldName: string, newName: string): Promise<void> {
    const items = await this.listFolderItems(parentId)
    const copied = items.find((item) => sameName(item.name, oldName))
    if (!copied) throw DriverError.upstream(`139 copied "${oldName}" but the copy cannot be found`)
    await this.renameItem(copied, driverChildPath(destinationPath, newName), newName)
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.run(async () => {
      const item = await this.resolveFile(from)
      const targetName = driverFileName(to)
      const destinationId = await this.resolveFolderId(driverParentPath(to), true)
      if (item.name !== targetName) await this.renameItem(item, from, targetName)
      await this.batchOperation({ ...item, name: targetName }, true, destinationId, driverParentPath(to))
      this.pathIds.clear()
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.run(async () => {
      const item = await this.resolveFile(from)
      const targetName = driverFileName(to)
      const destinationId = await this.resolveFolderId(driverParentPath(to), true)
      await this.batchOperation(item, false, destinationId, driverParentPath(to))
      if (item.name !== targetName) {
        await this.renameCopiedItem(destinationId, driverParentPath(to), item.name, targetName)
      }
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.run(async () => {
      const item = await this.resolveFile(clean)
      switch (this.type()) {
        case 'personal_new':
          await this.api('/recyclebin/batchTrash', { fileIds: [item.ref] })
          break
        case 'group':
          await this.api('/orchestration/group-rebuild/task/v1.0/createBatchOprTask', this.newJson({
            taskType: 2,
            srcGroupID: this.cloudId(),
            contentList: item.folder ? [] : [`${clean}/${item.ref}`],
            catalogList: item.folder ? [clean] : [],
          }))
          break
        case 'personal':
          await this.api('/orchestration/personalCloud/batchOprTask/v1.0/createBatchOprTask', {
            createBatchOprTaskReq: {
              taskType: 2,
              actionType: 201,
              taskInfo: {
                newCatalogID: '',
                contentInfoList: item.folder ? [] : [item.ref],
                catalogInfoList: item.folder ? [item.ref] : [],
              },
              commonAccountInfo: this.commonAccount(),
            },
          })
          break
        case 'family':
          await this.api('/orchestration/familyCloud-rebuild/batchOprTask/v1.0/createBatchOprTask', {
            catalogList: item.folder ? [item.ref] : [],
            contentList: item.folder ? [] : [item.ref],
            commonAccountInfo: this.commonAccount(),
            sourceCloudID: this.cloudId(),
            sourceCatalogType: 1002,
            taskType: 2,
            path: clean,
          })
      }
      this.pathIds.clear()
    })
  }

  // ---- Upload -----------------------------------------------------------------------------

  private partSize(): number {
    const configured = Number(this.configText('uploadPartSize'))
    return Number.isFinite(configured) && configured > 0 ? configured : 100 * 1024 * 1024
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    await this.run(async () => {
      const name = driverFileName(clean)
      const parentId = await this.resolveFolderId(driverParentPath(clean), true)
      if (this.type() === 'personal') {
        await this.uploadLegacy(name, parentId, bytes, options)
      } else {
        await this.uploadPersonal(name, parentId, bytes, options)
      }
      this.pathIds.clear()
    })
  }

  /** personal_new plus the group/family `/dynamic/file` upload API. */
  private async uploadPersonal(
    name: string,
    parentId: string,
    bytes: Uint8Array,
    options: DriverUploadOptions,
  ): Promise<void> {
    const size = bytes.byteLength
    const partSize = this.partSize()
    const partCount = Math.max(1, Math.ceil(size / partSize))
    const hash = bytesToHex(sha256(bytes))
    const common = this.commonAccount()
    const group = this.type() === 'family' || this.type() === 'group'
    const createPath = group ? '/dynamic/file/create' : '/file/create'
    const uploadUrlPath = group ? '/dynamic/file/getUploadUrl' : '/file/getUploadUrl'
    const completePath = group ? '/dynamic/file/complete' : '/file/complete'

    const buildParts = (from: number, to: number): Array<Record<string, number>> => {
      const parts: Array<Record<string, number>> = []
      for (let index = from; index < to; index += 1) {
        const start = index * partSize
        parts.push({ partNumber: index + 1, partSize: Math.min(partSize, size - start), partOffset: start })
      }
      return parts
    }

    const extras = group
      ? {
          groupId: this.cloudId(),
          groupType: this.type() === 'group' ? 2 : 1,
          catalogType: 3,
          seqNo: randomString(32),
        }
      : {}

    const created = await this.api(createPath, {
      contentHash: hash,
      contentHashAlgorithm: 'SHA256',
      contentType: options.contentType ?? 'application/octet-stream',
      parallelUpload: false,
      partInfos: buildParts(0, Math.min(partCount, 100)),
      size,
      parentFileId: parentId,
      name,
      type: 'file',
      fileRenameMode: 'auto_rename',
      ...extras,
    })
    const data = created.data as {
      exist?: boolean
      fileId?: string
      uploadId?: string
      fileName?: string
      partInfos?: Array<{ partNumber?: number; uploadUrl?: string }>
    } | undefined
    if (data?.exist) {
      options.onProgress?.(size, size)
      return
    }

    const urls = new Map<number, string>()
    for (const part of data?.partInfos ?? []) {
      if (part.partNumber && part.uploadUrl) urls.set(part.partNumber, part.uploadUrl)
    }
    for (let index = 100; index < partCount; index += 100) {
      const more = await this.api(uploadUrlPath, {
        fileId: data?.fileId,
        uploadId: data?.uploadId,
        partInfos: buildParts(index, Math.min(index + 100, partCount)),
        commonAccountInfo: common,
        ...(group ? { groupId: this.cloudId() } : {}),
      })
      const partInfos = (more.data as { partInfos?: Array<{ partNumber?: number; uploadUrl?: string }> } | undefined)?.partInfos ?? []
      for (const part of partInfos) {
        if (part.partNumber && part.uploadUrl) urls.set(part.partNumber, part.uploadUrl)
      }
    }

    if (urls.size === 0) {
      options.onProgress?.(size, size)
      return
    }

    await uploadInParts({
      size,
      partSize,
      concurrency: Math.min(8, partCount),
      uploadPart: async (partNumber, start, end) => {
        const url = urls.get(partNumber)
        if (!url) throw DriverError.upstream(`139 returned no upload URL for part ${partNumber}`)
        const response = await fetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(end - start),
            Origin: 'https://yun.139.com',
            Referer: 'https://yun.139.com/',
          },
          body: bytes.subarray(start, end),
          signal: AbortSignal.timeout(60_000),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw DriverError.upstream(`139 upload part ${partNumber}/${partCount} failed (HTTP ${response.status})`)
        }
        options.onProgress?.(end, size)
      },
      complete: async () => {
        await this.api(completePath, {
          contentHash: hash,
          contentHashAlgorithm: 'SHA256',
          fileId: data?.fileId,
          uploadId: data?.uploadId,
          ...(group ? { groupId: this.cloudId() } : {}),
        })
      },
    })
  }

  private async uploadLegacy(
    name: string,
    parentId: string,
    bytes: Uint8Array,
    options: DriverUploadOptions,
  ): Promise<void> {
    const size = bytes.byteLength
    const created = await this.api('/orchestration/personalCloud/uploadAndDownload/v1.0/pcUploadFileRequest', {
      manualRename: 2,
      operation: 0,
      fileCount: 1,
      totalSize: 0,
      uploadContentList: [{ contentName: name, contentSize: 0 }],
      parentCatalogID: parentId,
      newCatalogName: '',
      commonAccountInfo: this.commonAccount(),
    })
    const data = created.data as {
      result?: { resultCode?: string; resultDesc?: string }
      uploadResult?: { redirectionURL?: string; uploadTaskID?: string }
    } | undefined
    if (data?.result?.resultCode !== '0') {
      throw DriverError.upstream(data?.result?.resultDesc || '139 upload request failed')
    }
    const redirection = data?.uploadResult?.redirectionURL ?? ''
    const taskId = data?.uploadResult?.uploadTaskID ?? ''
    if (!redirection) throw DriverError.upstream('139 returned no upload redirection URL')
    const partSize = this.partSize()
    await uploadInParts({
      size,
      partSize,
      concurrency: Math.min(8, Math.max(1, Math.ceil(size / partSize))),
      uploadPart: async (partNumber, start, end) => {
        const response = await fetch(redirection, {
          method: 'POST',
          headers: {
            'Content-Type': `text/plain;name=${encodeURIComponent(name)}`,
            contentSize: String(size),
            range: `bytes=${start}-${end - 1}`,
            uploadtaskID: taskId,
            rangeType: '0',
          },
          body: bytes.subarray(start, end),
          signal: AbortSignal.timeout(60_000),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw DriverError.upstream(`139 legacy upload part ${partNumber} failed (HTTP ${response.status})`)
        }
        options.onProgress?.(end, size)
      },
      complete: async () => undefined,
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const items = await this.listFolderItems(this.rootId())
      return { ok: true, message: `139 Cloud is reachable (${items.length} items at the root)` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '139 Cloud is unavailable' }
    }
  }

  // ---- Mail/password sign-in ----------------------------------------------------------------

  /** 139 Mail password sign-in; the result is the `pc:<account>:<token>` Authorization value. */
  private async passwordLogin(): Promise<string> {
    let mailCookies = this.mailCookies()
    const username = this.username()
    const password = this.password()
    const cguid = String(Date.now())

    const loginResponse = await fetch(MAIL_LOGIN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://mail.10086.cn',
        referer: `https://mail.10086.cn/default.html?&s=1&v=0&u=${encodeURIComponent(username)}&m=1&ec=S001&resource=indexLogin&clientid=1003&auto=on&cguid=${cguid}&mtime=45`,
        'user-agent': USER_AGENT,
        ...(mailCookies ? { Cookie: mailCookies } : {}),
      },
      body: new URLSearchParams({
        UserName: username,
        passOld: '',
        auto: 'on',
        Password: sha1Hex(`fetion.com.cn:${password}`),
        webIndexPagePwdLogin: '1',
        pwdType: '1',
        clientId: '1003',
        authType: '2',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    mailCookies = cookieHeader(mergeResponseCookies(parseCookies(mailCookies), loginResponse))

    const location = loginResponse.headers.get('location') ?? ''
    let riskCode = ''
    if (location) {
      try {
        riskCode = new URL(location, MAIL_LOGIN_URL).searchParams.get('ec') ?? ''
      } catch {
        riskCode = ''
      }
    }
    if (riskCode) {
      throw DriverError.auth(
        `139 Mail risk control triggered (${riskCode}). Complete the slider/SMS challenge in a browser and ` +
          'paste the Authorization/Cookie from https://yun.139.com.',
      )
    }

    let sid = ''
    if (location) {
      try {
        sid = new URL(location, MAIL_LOGIN_URL).searchParams.get('sid') ?? ''
      } catch {
        sid = ''
      }
    }
    if (!sid) {
      const jar = parseCookies(mailCookies)
      sid = jar.Os_SSo_Sid ?? jar.sid ?? ''
    }
    if (!sid) throw DriverError.auth('139 Mail sign-in did not return a session id; paste a browser Authorization instead.')

    const artifactResponse = await fetch(
      `${MAIL_ARTIFACT_URL}?func=${encodeURIComponent('umc:getArtifact')}&sid=${encodeURIComponent(sid)}&cguid=${cguid}`,
      {
        method: 'POST',
        headers: {
          Cookie: mailCookies,
          'Content-Type': 'text/xml; charset=utf-8',
          'Accept-Encoding': 'gzip',
          'User-Agent': 'okhttp/4.12.0',
        },
        signal: AbortSignal.timeout(30_000),
      },
    )
    const artifact = await artifactResponse.json().catch(() => null) as { var?: { artifact?: string } } | null
    const ticket = artifact?.var?.artifact ?? ''
    if (!ticket) throw DriverError.auth('139 Mail did not return the SSO artifact; paste a browser Authorization instead.')

    const request = {
      clientkey_decrypt: 'l3TryM&Q+X7@dzwk)qP',
      clienttype: '886',
      cpid: '507',
      dycpwd: ticket,
      extInfo: { ifOpenAccount: '0' },
      loginMode: '0',
      msisdn: username,
      pintype: '13',
      secinfo: sha1Hex(`fetion.com.cn:${ticket}`).toUpperCase(),
      version: '20250901',
    }
    const ssoResponse = await fetch(MAIL_SSO_URL, {
      method: 'POST',
      headers: {
        'hcy-cool-flag': '1',
        'x-huawei-channelSrc': '10246600',
        'x-sdk-channelSrc': '',
        'x-MM-Source': '0',
        'x-UserAgent': 'android|23116PN5BC|android15|1.2.6|||1440x3200|10246600',
        'x-DeviceInfo': '4|127.0.0.1|5|1.2.6|Xiaomi|23116PN5BC||02-00-00-00-00-00|android 15|1440x3200|android|||',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Accept-Encoding': 'gzip',
        'User-Agent': 'okhttp/3.12.2',
      },
      body: aesCbcEncryptBase64(sortedJson(request), MAIL_KEY_1),
      signal: AbortSignal.timeout(30_000),
    })
    const layer1 = await ssoResponse.json().catch(() => null) as { data?: string } | null
    if (!layer1?.data) throw DriverError.auth('139 SSO did not return the inner token; paste a browser Authorization instead.')
    let inner: { authToken?: string; account?: string; userDomainId?: string }
    try {
      inner = JSON.parse(aesEcbDecryptHex(layer1.data, MAIL_KEY_2)) as typeof inner
    } catch {
      throw DriverError.upstream('139 SSO returned an unreadable token')
    }
    if (!inner.authToken || !inner.account) {
      throw DriverError.auth('139 SSO did not return an authorization token; paste a browser Authorization instead.')
    }
    const authorization = bytesToBase64(utf8(`pc:${inner.account}:${inner.authToken}`))
    await this.saveCredential({
      authorization,
      mailCookies,
      ...(inner.userDomainId ? { userDomainId: inner.userDomainId } : {}),
    })
    return authorization
  }
}

export function create139Driver(ctx: DriverContext): MountDriver {
  return new Yun139Driver(ctx)
}
