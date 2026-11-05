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
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
  uploadInParts,
  type HttpOptions,
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
const FILE = 'drive#file'
const UPLOAD_TYPE_RESUMABLE = 'UPLOAD_TYPE_RESUMABLE'
const PAGE_LIMIT = 100
const MAX_LIST_PAGES = 50
const UPLOAD_TIMEOUT_MS = 120_000
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

interface ThunderResumableParams {
  endpoint?: string
  bucket?: string
  key?: string
  security_token?: string
  part_size?: number | string
  upload_id?: string
  uploadId?: string
}

interface ThunderUploadTask {
  upload_type?: string
  file?: ThunderFile
  resumable?: {
    params?: ThunderResumableParams
  }
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

function uploadError(status: number, label: string): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`Thunder refused ${label} (HTTP ${status})`)
  if (status === 404) return DriverError.notFound(`Thunder could not find ${label} (HTTP 404)`)
  if (status === 429) return DriverError.rateLimited(`Thunder is rate limiting ${label}`)
  return DriverError.upstream(`Thunder rejected ${label} (HTTP ${status})`)
}

/**
 * The Xunlei content hash: SHA1 over the per-chunk SHA1 digests, with the chunk size doubling
 * between 256 KiB and 2 MiB so that a large file does not produce an unbounded digest list.
 */
function calcGcid(data: Uint8Array): string {
  const size = data.byteLength
  let partSize = 0x40000
  while (size / partSize > 0x200 && partSize < 0x200000) partSize <<= 1
  const digests: Buffer[] = []
  for (let offset = 0; offset < size; offset += partSize) {
    const chunk = data.subarray(offset, Math.min(offset + partSize, size))
    digests.push(createHash('sha1').update(chunk).digest())
  }
  return createHash('sha1').update(Buffer.concat(digests)).digest('hex')
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
    options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
  ): Promise<T> {
    if (!this.token) throw DriverError.auth('Thunder needs an access token')
    const response = await this.request(url, {
      method: (options.method ?? 'GET') as HttpOptions['method'],
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

  /**
   * Resolves the presigned S3 object URL the upload task hands back. Some accounts report an
   * endpoint that already carries the bucket as its first label, so that prefix is removed before
   * the bucket path is appended.
   */
  private resumableUrl(params: ThunderResumableParams): string {
    const bucket = params.bucket ?? ''
    const key = params.key ?? ''
    const raw = params.endpoint ?? ''
    if (!bucket || !key || !raw) {
      throw DriverError.upstream('Thunder returned incomplete upload information')
    }
    let endpoint = raw
    if (endpoint.startsWith(`${bucket}.`)) endpoint = endpoint.slice(bucket.length + 1)
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) endpoint = `https://${endpoint}`
    return `${endpoint.replace(/\/$/, '')}/${bucket}/${key}`
  }

  /**
   * One PUT attempt with a single retry, because a dropped connection mid-part is expected on a
   * long upload while an auth or not-found answer must surface immediately.
   */
  private async putWithRetry(
    url: string,
    bytes: Uint8Array,
    headers: Record<string, string>,
    label: string,
  ): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'PUT',
          headers: { ...headers, 'Content-Length': String(bytes.byteLength) },
          body: bytes,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
        if (!response.ok) {
          const error = uploadError(response.status, label)
          await response.body?.cancel().catch(() => undefined)
          if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
            lastError = error
            continue
          }
          throw error
        }
        return response
      } catch (error) {
        if (attempt === 0 && !(error instanceof DriverError)) {
          lastError = error
          continue
        }
        throw error
      }
    }
    throw lastError instanceof DriverError
      ? lastError
      : DriverError.upstream(`Thunder upload failed: ${lastError instanceof Error ? lastError.message : 'unknown error'}`)
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    return await this.withAuth(async () => {
      const parentId = await this.resolveFolderId(driverParentPath(clean))
      const task = await this.api<ThunderUploadTask>(FILES, {
        method: 'POST',
        body: {
          kind: FILE,
          parent_id: parentId,
          name: driverFileName(clean),
          size: String(bytes.byteLength),
          hash: calcGcid(bytes),
          upload_type: UPLOAD_TYPE_RESUMABLE,
          space: this.configText('space'),
        },
      })
      const params = task.resumable?.params
      if (!params) {
        // A create answer without a resumable session is Thunder's instant upload.
        options.onProgress?.(bytes.byteLength, bytes.byteLength)
        return
      }
      const uploadUrl = this.resumableUrl(params)
      const headers: Record<string, string> = { 'x-amz-security-token': params.security_token ?? '' }
      const partSize = Number(params.part_size) || 0
      const uploadId = params.upload_id || params.uploadId || ''
      if (partSize > 0 && uploadId) {
        const parts: Array<{ number: number; etag: string }> = []
        await uploadInParts({
          size: bytes.byteLength,
          partSize,
          concurrency: 1,
          uploadPart: async (partNumber, start, end) => {
            const response = await this.putWithRetry(
              `${uploadUrl}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
              bytes.subarray(start, end),
              headers,
              `upload part ${partNumber}`,
            )
            parts.push({ number: partNumber, etag: response.headers.get('etag') ?? '' })
            await response.body?.cancel().catch(() => undefined)
            options.onProgress?.(end, bytes.byteLength)
          },
          complete: async () => {
            const xml = `<CompleteMultipartUpload>${parts
              .sort((left, right) => left.number - right.number)
              .map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${part.etag}</ETag></Part>`)
              .join('')}</CompleteMultipartUpload>`
            const response = await fetch(`${uploadUrl}?uploadId=${encodeURIComponent(uploadId)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/xml', ...headers },
              body: xml,
              signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
            })
            if (!response.ok) {
              const error = uploadError(response.status, 'the upload commit')
              await response.body?.cancel().catch(() => undefined)
              throw error
            }
            await response.body?.cancel().catch(() => undefined)
          },
        })
        return
      }
      await this.putWithRetry(uploadUrl, bytes, headers, 'the upload')
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    return await this.withAuth(async () => {
      const parentId = await this.resolveFolderId(driverParentPath(clean))
      await this.api(FILES, {
        method: 'POST',
        body: {
          kind: FOLDER,
          name: driverFileName(clean),
          parent_id: parentId,
          space: this.configText('space'),
        },
      })
      this.pathIds.clear()
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(clean)
      await this.api(`${FILES}/${encodeURIComponent(file.id)}`, {
        method: 'PATCH',
        body: { name: newName, space: this.configText('space') },
      })
      this.pathIds.clear()
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(from)
      const targetName = driverFileName(to)
      if (targetName !== driverFileName(from)) await this.rename(from, targetName)
      const parentId = await this.resolveFolderId(driverParentPath(to))
      await this.api(`${FILES}:batchMove`, {
        method: 'POST',
        body: {
          to: { parent_id: parentId },
          ids: [file.id],
          space: this.configText('space'),
        },
      })
      this.pathIds.clear()
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(from)
      const parentId = await this.resolveFolderId(driverParentPath(to))
      await this.api(`${FILES}:batchCopy`, {
        method: 'POST',
        body: {
          to: { parent_id: parentId },
          ids: [file.id],
          space: this.configText('space'),
        },
      })
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(clean)
      const url = new URL(`${FILES}/${encodeURIComponent(file.id)}/trash`)
      url.searchParams.set('space', this.configText('space'))
      await this.api(url.toString(), { method: 'PATCH', body: {} })
      this.pathIds.clear()
    })
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
