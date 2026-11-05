/**
 * Xunlei / Thunder driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/thunder`. The
 * access token is renewable through the `xluser` token endpoint, or through the account/password
 * handshake when the owner supplies credentials. Refresh is single-flighted and written back with
 * the observed access/refresh pair so concurrent rotations cannot clobber each other.
 */
import { createHash, randomUUID } from 'node:crypto'
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
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'
import { singleFlightRefresh } from './token'

const API = 'https://api-pan.xunlei.com/drive/v1'
const FILES = `${API}/files`
const XLUSER = 'https://xluser-ssl.xunlei.com'
const CLIENT_VERSION = '8.31.0.9726'
const PACKAGE_NAME = 'com.xunlei.downloadprovider'
const USER_AGENT = 'ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gdfs8vbb238b) (JAVA 0)'
const DOWNLOAD_USER_AGENT = 'Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)'
const APP_ID = '40'
const APP_KEY = '34a062aaa22f906fca4fefe9fb3a3021'
const SIGN_PROVIDER = 'access_end_point_token'
const FOLDER = 'drive#folder'
const PAGE_LIMIT = 100
const MAX_LIST_PAGES = 50
const AUTH_ERROR_CODES = new Set([9, 10, 16, 4121, 4122])

interface ThunderFile {
  kind: string
  id: string
  parent_id?: string
  name: string
  size?: string
  web_content_link?: string
  created_time?: string
  modified_time?: string
  icon_link?: string
  thumbnail_link?: string
  hash?: string
  medias?: Array<{ link?: { url?: string } }>
  trashed?: boolean
}

interface ThunderFileList {
  next_page_token?: string
  files?: ThunderFile[]
}

interface ThunderToken {
  token_type?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
  user_id?: string
}

interface ThunderCoreLogin {
  sessionID?: string
  error?: string
  error_code?: number
  error_description?: string
}

interface ThunderErrorPayload {
  error?: string
  error_code?: number
  error_description?: string
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function deviceSign(deviceId: string): string {
  return `div101.${deviceId}${md5(sha1(`${deviceId}${PACKAGE_NAME}${APP_ID}${APP_KEY}`))}`
}

function parseThunderTime(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function fileEntry(file: ThunderFile): DriverEntry {
  const folder = file.kind === FOLDER
  const name = file.name || 'unknown'
  return {
    name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : (parseInt(file.size || '0', 10) || 0),
    modifiedAt: parseThunderTime(file.modified_time || file.created_time),
    ref: file.id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(name),
  }
}

function downloadLink(file: ThunderFile): string {
  if (file.web_content_link) return file.web_content_link
  for (const media of file.medias ?? []) {
    if (media.link?.url) return media.link.url
  }
  return ''
}

function downloadError(status: number): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`Thunder refused the download (HTTP ${status})`)
  if (status === 404) return DriverError.notFound('Thunder returned no download resource (HTTP 404)')
  if (status === 429) return DriverError.rateLimited('Thunder is rate limiting downloads')
  return DriverError.upstream(`Thunder download failed (HTTP ${status})`)
}

export class ThunderDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('thunder')!
  readonly capabilities = this.definition.capabilities
  private token: string
  private tokenType: string
  private refreshTokenValue: string
  private captchaToken = ''
  private readonly deviceId: string
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.token = String(ctx.credentials.accessToken ?? '').trim()
    this.tokenType = 'Bearer'
    this.refreshTokenValue = String(ctx.credentials.refreshToken ?? '').trim()
    const username = typeof ctx.config.username === 'string' ? ctx.config.username : ''
    const password = String(ctx.credentials.password ?? '')
    const seed = `${username}${password}`
    this.deviceId = seed.trim() ? md5(seed) : randomUUID().replace(/-/g, '')
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.token) return
    if (this.refreshTokenValue) {
      this.token = await this.refresh()
      return
    }
    const username = this.configText('username')
    const password = String(this.ctx.credentials.password ?? '')
    if (username && password) {
      await this.passwordLogin(username, password)
      return
    }
    throw DriverError.auth('Thunder needs a refresh token, or an account and password')
  }

  private clientCredentials(): { clientId: string; clientSecret: string } {
    return {
      clientId: String(this.ctx.credentials.clientId ?? ''),
      clientSecret: String(this.ctx.credentials.clientSecret ?? ''),
    }
  }

  private async refresh(): Promise<string> {
    const beforeAccess = String(this.ctx.credentials.accessToken ?? '')
    const beforeRefresh = this.refreshTokenValue
    if (!beforeRefresh) throw DriverError.auth('Thunder needs a refresh token to renew the access token')
    const { clientId, clientSecret } = this.clientCredentials()
    return await singleFlightRefresh(
      this.ctx,
      async () => {
        let payload: ThunderToken
        try {
          payload = await this.raw<ThunderToken>(`${XLUSER}/v1/auth/token`, {
            method: 'POST',
            headers: this.baseHeaders(),
            body: {
              grant_type: 'refresh_token',
              refresh_token: beforeRefresh,
              client_id: clientId,
              client_secret: clientSecret,
            },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Thunder rejected the refresh token'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        if (!payload?.access_token) {
          const message = 'Thunder returned no access token while refreshing'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        const patch: Record<string, string> = {
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token || beforeRefresh,
          expiresAt: String(Date.now() + (Number(payload.expires_in) || 3600) * 1000),
        }
        try {
          const effective = await this.ctx.saveCredentials(patch, {
            expect: { accessToken: beforeAccess, refreshToken: beforeRefresh },
          })
          this.token = String(effective.accessToken ?? payload.access_token)
          this.refreshTokenValue = String(effective.refreshToken ?? patch.refreshToken)
          this.tokenType = payload.token_type || 'Bearer'
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Thunder could not persist the refreshed token'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        return this.token
      },
      async () => {
        await this.ctx.reloadCredentials?.()
        const current = String(this.ctx.credentials.accessToken ?? '')
        const currentRefresh = String(this.ctx.credentials.refreshToken ?? '')
        return current && (current !== beforeAccess || currentRefresh !== beforeRefresh) ? current : null
      },
    )
  }

  private baseHeaders(): Record<string, string> {
    return {
      'user-agent': USER_AGENT,
      accept: 'application/json;charset=UTF-8',
      'x-device-id': this.deviceId,
      'x-client-id': this.clientCredentials().clientId,
      'x-client-version': CLIENT_VERSION,
      'content-type': 'application/json;charset=UTF-8',
    }
  }

  private async raw<T>(
    url: string,
    options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown },
  ): Promise<T> {
    const response = await this.request(url, {
      method: options.method ?? 'GET',
      headers: {
        ...this.baseHeaders(),
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const payload = await response.json().catch(() => null) as T | null
    if (!payload) throw DriverError.upstream('Thunder returned an unexpected body')
    return payload
  }

  private async passwordLogin(username: string, password: string): Promise<void> {
    const { clientId, clientSecret } = this.clientCredentials()
    if (!clientId || !clientSecret) {
      throw DriverError.auth('Thunder needs a client id and secret for an account login')
    }
    const beforeAccess = String(this.ctx.credentials.accessToken ?? '')
    const beforeRefresh = this.refreshTokenValue

    const core = await this.raw<ThunderCoreLoginError>(`${XLUSER}/xluser.core.login/v3/login`, {
      method: 'POST',
      headers: {
        'user-agent': 'android-ok-http-client/xl-acc-sdk/version-5.0.12.512000',
      },
      body: {
        protocolVersion: '301',
        sequenceNo: '1000012',
        platformVersion: '10',
        isCompressed: '0',
        appid: APP_ID,
        clientVersion: CLIENT_VERSION,
        peerID: '00000000000000000000000000000000',
        appName: 'ANDROID-com.xunlei.downloadprovider',
        sdkVersion: '512000',
        devicesign: deviceSign(this.deviceId),
        netWorkType: 'WIFI',
        providerName: 'NONE',
        deviceModel: 'M2004J7AC',
        deviceName: 'Xiaomi_M2004j7ac',
        OSVersion: '12',
        creditkey: '',
        hl: 'zh-CN',
        userName: username,
        passWord: password,
        verifyKey: '',
        verifyCode: '',
        isMd5Pwd: '0',
      },
    })
    if (core.error === 'review_panel') {
      throw DriverError.auth('Thunder requires a device verification for this account login')
    }
    if (!core.sessionID) throw DriverError.auth('Thunder did not return a login session')

    const meta: Record<string, string> = {}
    if (/\w+([-+.]\w+)*@\w+([-.]\w+)*\.\w+([-.]\w+)*/.test(username)) meta.email = username
    else if (username.length >= 11 && username.length <= 18) meta.phone_number = username
    else meta.username = username
    const captcha = await this.raw<{ captcha_token?: string; url?: string; error?: string }>(
      `${XLUSER}/v1/shield/captcha/init`,
      {
        method: 'POST',
        headers: this.baseHeaders(),
        body: {
          action: 'POST:/v1/auth/signin/token',
          captcha_token: this.captchaToken,
          client_id: clientId,
          device_id: this.deviceId,
          meta,
          redirect_uri: 'xlaccsdk01://xunlei.com/callback?state=harbor',
        },
      },
    )
    if (captcha.error) throw DriverError.auth(`Thunder captcha failed: ${captcha.error}`)
    if (captcha.url) throw DriverError.auth('Thunder requires an interactive captcha verification')
    this.captchaToken = captcha.captcha_token ?? ''

    const tokens = await this.raw<ThunderToken>(`${XLUSER}/v1/auth/signin/token`, {
      method: 'POST',
      headers: this.baseHeaders(),
      body: {
        client_id: clientId,
        client_secret: clientSecret,
        provider: SIGN_PROVIDER,
        signin_token: core.sessionID,
      },
    })
    if (!tokens.access_token) throw DriverError.auth('Thunder returned no access token for the account login')

    const patch: Record<string, string> = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || beforeRefresh,
      expiresAt: String(Date.now() + (Number(tokens.expires_in) || 3600) * 1000),
    }
    const effective = await this.ctx.saveCredentials(patch, {
      expect: { accessToken: beforeAccess, refreshToken: beforeRefresh },
    })
    this.token = String(effective.accessToken ?? tokens.access_token)
    this.refreshTokenValue = String(effective.refreshToken ?? patch.refreshToken)
    this.tokenType = tokens.token_type || 'Bearer'
  }

  private async api<T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
  ): Promise<T> {
    if (!this.token) throw DriverError.auth('Thunder needs an access token')
    const response = await this.request(url, {
      method: (options.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
      headers: {
        ...this.baseHeaders(),
        Authorization: `${this.tokenType} ${this.token}`,
        'X-Captcha-Token': this.captchaToken,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!payload) throw DriverError.upstream('Thunder returned an unexpected body')
    const errorCode = Number(payload.error_code) || 0
    if (errorCode !== 0) {
      const message = `Thunder error ${errorCode}: ${String(payload.error_description ?? payload.error ?? '')}`
      if (AUTH_ERROR_CODES.has(errorCode)) throw DriverError.auth(message)
      if (errorCode === 404) throw DriverError.notFound(message)
      if (errorCode === 429) throw DriverError.rateLimited(message)
      throw DriverError.upstream(message)
    }
    const error = payload.error
    if (typeof error === 'string' && error && error !== 'success') {
      if (error === 'review_panel') throw DriverError.auth('Thunder requires a device verification')
      throw DriverError.upstream(`Thunder error: ${error}`)
    }
    return payload as T
  }

  private rootId(): string {
    return this.configText('rootFolderId').trim()
  }

  private async filesPage(parentId: string, pageToken: string, limit: number): Promise<ThunderFileList> {
    const url = new URL(FILES)
    url.searchParams.set('space', this.configText('space'))
    url.searchParams.set('__type', 'drive')
    url.searchParams.set('refresh', 'true')
    url.searchParams.set('__sync', 'true')
    url.searchParams.set('parent_id', parentId)
    url.searchParams.set('page_token', pageToken)
    url.searchParams.set('with_audit', 'true')
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('filters', JSON.stringify({
      phase: { eq: 'PHASE_TYPE_COMPLETE' },
      trashed: { eq: false },
    }))
    return await this.api<ThunderFileList>(url.toString())
  }

  private async allFiles(parentId: string): Promise<ThunderFile[]> {
    const collected = await collectPages(
      async ({ cursor }) => {
        const payload = await this.filesPage(parentId, cursor ?? '', PAGE_LIMIT)
        return { items: payload.files ?? [], next: payload.next_page_token || null }
      },
      { mode: 'cursor', maxPages: MAX_LIST_PAGES },
    )
    return collected.items
  }

  private async page(parentId: string, pageNumber: number, pageSize: number): Promise<{ items: ThunderFile[]; next: string | null }> {
    let token = ''
    for (let current = 1; current <= pageNumber; current++) {
      const payload = await this.filesPage(parentId, token, pageSize)
      if (current === pageNumber) {
        return { items: payload.files ?? [], next: payload.next_page_token || null }
      }
      token = payload.next_page_token || ''
      if (!token) return { items: [], next: null }
    }
    return { items: [], next: null }
  }

  private async resolveFolderId(clean: string): Promise<string> {
    if (clean === '/') return this.rootId()
    const cached = this.pathIds.get(clean)
    if (cached) return cached

    const segments = clean.slice(1).split('/')
    let current = this.rootId()
    let prefix = ''
    for (const segment of segments) {
      const files = await this.allFiles(current)
      const found = files.find((file) => file.kind === FOLDER && file.name === segment)
      if (!found) throw DriverError.notFound(`Thunder could not find ${segment}`)
      current = found.id
      prefix = `${prefix}/${segment}`
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveItem(clean: string): Promise<ThunderFile> {
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    const files = await this.allFiles(parentId)
    const found = files.find((file) => file.name === name || file.id === name)
    if (!found) throw DriverError.notFound(`Thunder could not find ${name}`)
    return found
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const folderId = await this.resolveFolderId(clean)
      const pageSize = Math.max(1, options.pageSize ?? PAGE_LIMIT)
      const filter = (entries: DriverEntry[]): DriverEntry[] => {
        if (!options.search) return entries
        const needle = options.search.toLowerCase()
        return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      }
      if (options.page !== undefined) {
        const result = await this.page(folderId, Math.max(1, options.page), pageSize)
        return {
          entries: filter(result.items.map(fileEntry)),
          cursor: result.next,
          truncated: result.next !== null,
        }
      }
      const collected = await collectPages(
        async ({ cursor }) => {
          const payload = await this.filesPage(folderId, cursor ?? '', pageSize)
          return { items: payload.files ?? [], next: payload.next_page_token || null }
        },
        { mode: 'cursor', maxPages: MAX_LIST_PAGES },
      )
      return { entries: filter(collected.items.map(fileEntry)), cursor: null, truncated: collected.truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      if (clean === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
      }
      return fileEntry(await this.resolveItem(clean))
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(clean)
      if (file.kind === FOLDER) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = downloadLink(file)
      if (!url) throw DriverError.notFound(`Thunder returned no download address for ${file.name}`)
      const response = await fetch(url, {
        headers: {
          'User-Agent': DOWNLOAD_USER_AGENT,
          ...(range ? { Range: range } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw downloadError(response.status)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(clean)
      if (file.kind === FOLDER) return null
      return downloadLink(file) || null
    })
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('This Thunder mount is read-only')
  }

  async mkdir(_path: string): Promise<void> {
    throw DriverError.unsupported('This Thunder mount is read-only')
  }

  async rename(_path: string, _newName: string): Promise<void> {
    throw DriverError.unsupported('This Thunder mount is read-only')
  }

  async move(_fromPath: string, _toPath: string): Promise<void> {
    throw DriverError.unsupported('This Thunder mount is read-only')
  }

  async remove(_path: string): Promise<void> {
    throw DriverError.unsupported('This Thunder mount is read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.filesPage(this.rootId(), '', 1)
      return { ok: true, message: 'Thunder is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Thunder is unavailable' }
    }
  }
}

export function createThunderDriver(ctx: DriverContext): MountDriver {
  return new ThunderDriver(ctx)
}

type ThunderCoreLoginError = ThunderCoreLogin & ThunderErrorPayload
