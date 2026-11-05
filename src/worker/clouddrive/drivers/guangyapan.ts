/**
 * GuangYaPan driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/guangyapan`.
 * A stored access token wins; otherwise a refresh token is rotated through the account endpoint.
 * When the owner has neither token, the SMS verification handshake (`captcha init` → send code →
 * verify code → sign in) completes the login. Writes use the resource API and uploads go through
 * the instant-upload handshake followed by signed OSS requests.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
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
} from './http'
import { singleFlightRefresh } from './token'

const ACCOUNT = 'https://account.guangyapan.com'
const API = 'https://api.guangyapan.com'
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50
const ORDER_BY = 3
const SORT_TYPE = 1
const UPLOAD_PART_SIZE = 5 * 1024 * 1024
const MAX_CAPTCHA_REFRESHES = 2

interface GypFile {
  fileId: string
  parentId?: string
  fileName: string
  fileSize?: number
  resType: number
  ctime?: number
  utime?: number
}

interface GypToken {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface GypCommon<T> {
  code?: number
  msg?: string
  error?: string
  data?: T
}

interface GypUploadCreds {
  accessKeyID?: string
  secretAccessKey?: string
  sessionToken?: string
}

interface GypUploadToken {
  taskId?: string
  objectPath?: string
  bucketName?: string
  endPoint?: string
  fullEndPoint?: string
  creds?: GypUploadCreds
  accessKeyID?: string
  secretAccessKey?: string
  sessionToken?: string
}

interface GypIdentity {
  clientId: string
  deviceId: string
  deviceSign: string
  phone: string
}

function normalizeDeviceId(value: string): string {
  const normalized = value.toLowerCase().replace(/-/g, '')
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : ''
}

function md5(value: string | Uint8Array): string {
  return createHash('md5').update(value).digest('hex')
}

function normalizePhoneE164(value: string): string {
  const phone = value.trim().replace(/\s/g, '')
  if (!phone) return ''
  if (phone.startsWith('+')) {
    if (phone.startsWith('+86') && phone.length > 3) return `+86 ${phone.slice(3)}`
    return phone
  }
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11) return `+86 ${digits}`
  return phone
}

function identityOf(ctx: DriverContext): GypIdentity {
  const clientId = String(ctx.credentials.clientId ?? '')
  const phone = normalizePhoneE164(
    typeof ctx.config.phoneNumber === 'string' ? ctx.config.phoneNumber : String(ctx.credentials.phoneNumber ?? ''),
  )
  const seed = `${clientId}${phone}`
  const deviceId = normalizeDeviceId(String(ctx.credentials.deviceId ?? ''))
    || (seed ? md5(seed) : randomUUID().replace(/-/g, ''))
  return { clientId, deviceId, deviceSign: `wdi10.${deviceId}`, phone }
}

function buildAccountHeaders(identity: GypIdentity, captchaToken = ''): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Device-Model': 'chrome%2F147.0.0.0',
    'X-Device-Name': 'PC-Chrome',
    'X-Device-Sign': identity.deviceSign,
    'X-Net-Work-Type': 'NONE',
    'X-OS-Version': 'MacIntel',
    'X-Platform-Version': '1',
    'X-Protocol-Version': '301',
    'X-Provider-Name': 'NONE',
    'X-SDK-Version': '9.0.2',
    'X-Client-Id': identity.clientId,
    'X-Client-Version': '0.0.1',
    'X-Device-Id': identity.deviceId,
  }
  if (captchaToken) headers['X-Captcha-Token'] = captchaToken
  return headers
}

function accountError(status: number, payload: { error?: string; error_description?: string } | null): DriverError {
  const detail = String(payload?.error_description || payload?.error || '').trim()
  const suffix = detail ? `: ${detail}` : ''
  if (status === 429) return DriverError.rateLimited('GuangYaPan is rate limiting account requests')
  if (status === 404) return DriverError.notFound(`GuangYaPan account endpoint is missing (HTTP 404${suffix})`)
  if (status >= 500) return DriverError.upstream(`GuangYaPan account request failed (HTTP ${status}${suffix})`)
  return DriverError.auth(`GuangYaPan refused the account request (HTTP ${status}${suffix})`)
}

async function accountRequest<T>(
  identity: GypIdentity,
  path: string,
  body: Record<string, unknown>,
  captchaToken = '',
): Promise<{ status: number; payload: (T & { error?: string; error_description?: string }) | null }> {
  let response: Response
  try {
    response = await fetch(`${ACCOUNT}${path}`, {
      method: 'POST',
      headers: buildAccountHeaders(identity, captchaToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw DriverError.upstream(`GuangYaPan account endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }
  const payload = await response.json().catch(() => null) as (T & { error?: string; error_description?: string }) | null
  return { status: response.status, payload }
}

function isCaptchaInvalid(payload: { error?: string; error_description?: string } | null): boolean {
  const text = `${payload?.error || ''} ${payload?.error_description || ''}`
  return text.includes('captcha_invalid') || text.includes('captcha_token expired')
}

async function ensureCaptchaToken(ctx: DriverContext, identity: GypIdentity, force: boolean): Promise<string> {
  const cached = String(ctx.credentials.captchaToken ?? '').trim()
  if (!force && cached) return cached
  const result = await accountRequest<{ captcha_token?: string; expires_in?: number }>(
    identity,
    '/v1/shield/captcha/init',
    {
      client_id: identity.clientId,
      action: 'POST:/v1/auth/verification',
      device_id: identity.deviceId,
      meta: {
        username: identity.phone,
        phone_number: identity.phone,
        VERIFICATION_PHONE: identity.phone,
      },
    },
    cached,
  )
  if (result.status >= 400 || result.payload?.error) throw accountError(result.status, result.payload)
  const token = String(result.payload?.captcha_token ?? '').trim()
  if (!token) throw DriverError.auth('GuangYaPan returned no captcha token')
  await ctx.saveCredentials({ captchaToken: token })
  ctx.credentials.captchaToken = token
  return token
}

/**
 * Sends an SMS verification code and returns the `verification_id` needed to finish signing in.
 * The captcha token and the verification id are persisted so a later `completeGuangYaPanLogin`
 * call does not have to resend the code.
 */
export async function requestGuangYaPanVerification(ctx: DriverContext): Promise<string> {
  const identity = identityOf(ctx)
  if (!identity.clientId) throw DriverError.auth('GuangYaPan needs a client id before sending an SMS code')
  if (!identity.phone) throw DriverError.auth('GuangYaPan needs a phone number before sending an SMS code')
  let captchaToken = await ensureCaptchaToken(ctx, identity, false)
  for (let attempt = 0; attempt <= MAX_CAPTCHA_REFRESHES; attempt++) {
    const result = await accountRequest<{ verification_id?: string }>(
      identity,
      '/v1/auth/verification',
      { phone_number: identity.phone, target: 'ANY', client_id: identity.clientId },
      captchaToken,
    )
    if (!isCaptchaInvalid(result.payload)) {
      if (result.status >= 400 || result.payload?.error) throw accountError(result.status, result.payload)
      const verificationId = String(result.payload?.verification_id ?? '').trim()
      if (!verificationId) throw DriverError.auth('GuangYaPan returned no verification id')
      await ctx.saveCredentials({ verificationId })
      ctx.credentials.verificationId = verificationId
      return verificationId
    }
    if (attempt === MAX_CAPTCHA_REFRESHES) {
      throw accountError(result.status, result.payload)
    }
    captchaToken = await ensureCaptchaToken(ctx, identity, true)
  }
  throw DriverError.auth('GuangYaPan did not accept the captcha token')
}

/**
 * Verifies the SMS code, signs in and persists the access/refresh token pair. The verification id
 * comes from `ctx.credentials`, which `requestGuangYaPanVerification` just wrote.
 */
export async function completeGuangYaPanLogin(
  ctx: DriverContext,
  code: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const identity = identityOf(ctx)
  const verificationId = String(ctx.credentials.verificationId ?? '').trim()
  const verifyCode = String(code ?? '').trim()
  if (!identity.clientId) throw DriverError.auth('GuangYaPan needs a client id before signing in')
  if (!identity.phone) throw DriverError.auth('GuangYaPan needs a phone number before signing in')
  if (!verificationId) throw DriverError.auth('GuangYaPan needs a verification id; request an SMS code first')
  if (!verifyCode) throw DriverError.auth('GuangYaPan needs the SMS verification code')

  const verify = await accountRequest<{ verification_token?: string }>(
    identity,
    '/v1/auth/verification/verify',
    { verification_id: verificationId, verification_code: verifyCode, client_id: identity.clientId },
  )
  if (verify.status >= 400 || verify.payload?.error) throw accountError(verify.status, verify.payload)
  const verificationToken = String(verify.payload?.verification_token ?? '').trim()
  if (!verificationToken) throw DriverError.auth('GuangYaPan returned no verification token')

  const signin = await accountRequest<{ access_token?: string; refresh_token?: string; expires_in?: number }>(
    identity,
    '/v1/auth/signin',
    {
      verification_code: verifyCode,
      verification_token: verificationToken,
      username: identity.phone,
      client_id: identity.clientId,
    },
  )
  if (signin.status >= 400 || signin.payload?.error) throw accountError(signin.status, signin.payload)
  const accessToken = String(signin.payload?.access_token ?? '').trim()
  if (!accessToken) throw DriverError.auth('GuangYaPan returned no access token')
  const refreshToken = String(signin.payload?.refresh_token ?? '').trim()

  const patch: Record<string, string> = {
    accessToken,
    refreshToken,
    expiresAt: String(Date.now() + (Number(signin.payload?.expires_in) || 3600) * 1000),
    verificationId: '',
  }
  await ctx.saveCredentials(patch)
  Object.assign(ctx.credentials, patch)
  return { accessToken, refreshToken }
}

function parseGypTime(value: number | undefined): number {
  return Number(value) > 0 ? Number(value) * 1000 : 0
}

function fileEntry(file: GypFile): DriverEntry {
  const folder = file.resType === 2
  return {
    name: file.fileName,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : (Number(file.fileSize) || 0),
    modifiedAt: parseGypTime(file.utime || file.ctime),
    ref: file.fileId,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.fileName),
  }
}

function downloadError(status: number): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`GuangYaPan refused the download (HTTP ${status})`)
  if (status === 404) return DriverError.notFound('GuangYaPan returned no download resource (HTTP 404)')
  if (status === 429) return DriverError.rateLimited('GuangYaPan is rate limiting downloads')
  return DriverError.upstream(`GuangYaPan download failed (HTTP ${status})`)
}

function isSuccessMessage(message: string): boolean {
  const value = message.trim().toLowerCase()
  return !value || value === 'success' || value === 'ok' || value.includes('\u6210\u529f')
}

function isUploadDoneMessage(message: string): boolean {
  const value = message.trim().toLowerCase()
  if (!value) return false
  return value === '\u4e0a\u4f20\u5df2\u5b8c\u6210'
    || value === 'upload completed'
    || value === 'already uploaded'
    || value === '\u79d2\u4f20\u6210\u529f'
}

function normalizeOssEndpoint(endpoint: string, bucket: string): string {
  let value = endpoint.trim()
  if (!value) return ''
  if (!value.startsWith('http://') && !value.startsWith('https://')) value = `https://${value}`
  try {
    const parsed = new URL(value)
    if (bucket && parsed.host.startsWith(`${bucket}.`)) parsed.host = parsed.host.slice(bucket.length + 1)
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return value
  }
}

function ossAuthorization(input: {
  method: string
  contentType: string
  date: string
  securityToken: string
  resource: string
  accessKeyID: string
  secretAccessKey: string
}): string {
  const tokenHeader = input.securityToken ? `x-oss-security-token:${input.securityToken}\n` : ''
  const stringToSign = `${input.method}\n\n${input.contentType}\n${input.date}\n${tokenHeader}${input.resource}`
  const signature = createHmac('sha1', input.secretAccessKey).update(stringToSign).digest('base64')
  return `OSS ${input.accessKeyID}:${signature}`
}

async function ossRequest(input: {
  method: 'POST' | 'PUT'
  url: string
  contentType: string
  body?: BodyInit
  securityToken: string
  resource: string
  accessKeyID: string
  secretAccessKey: string
}): Promise<Response> {
  const date = new Date().toUTCString()
  const headers: Record<string, string> = {
    Date: date,
    'Content-Type': input.contentType,
    Authorization: ossAuthorization({ ...input, date }),
  }
  if (input.securityToken) headers['x-oss-security-token'] = input.securityToken
  return await fetch(input.url, {
    method: input.method,
    headers,
    body: input.body,
    signal: AbortSignal.timeout(120_000),
  })
}

function validName(value: string): string {
  const name = value.trim()
  if (!name || name.includes('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name)) {
    throw DriverError.invalid('The name is not a valid single path segment')
  }
  return name
}

export class GuangYaPanDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('guangyapan')!
  readonly capabilities = this.definition.capabilities
  private token: string
  private refreshTokenValue: string
  private readonly identity: GypIdentity
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.token = String(ctx.credentials.accessToken ?? '').trim()
    this.refreshTokenValue = String(ctx.credentials.refreshToken ?? '').trim()
    this.identity = identityOf(ctx)
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.token) return
    const phone = this.configText('phoneNumber') || String(this.ctx.credentials.phoneNumber ?? '')
    const verifyCode = String(this.ctx.credentials.verifyCode ?? '').trim()
    if (phone && this.refreshTokenValue) {
      this.token = await this.refresh()
      return
    }
    if (phone && verifyCode && String(this.ctx.credentials.verificationId ?? '').trim()) {
      const tokens = await completeGuangYaPanLogin(this.ctx, verifyCode)
      this.token = tokens.accessToken
      this.refreshTokenValue = tokens.refreshToken || this.refreshTokenValue
      return
    }
    throw DriverError.auth(
      'GuangYaPan needs an access token or a phone number with a refresh token; request an SMS code to finish signing in.',
    )
  }

  private clientId(): string {
    return String(this.ctx.credentials.clientId ?? '')
  }

  private accountHeaders(): Record<string, string> {
    return buildAccountHeaders(this.identity)
  }

  private apiHeaders(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Did: this.identity.deviceId,
      Dt: '4',
      Authorization: `Bearer ${this.token}`,
    }
  }

  private async refresh(): Promise<string> {
    const beforeAccess = String(this.ctx.credentials.accessToken ?? '')
    const beforeRefresh = this.refreshTokenValue
    if (!this.clientId()) {
      throw DriverError.auth('GuangYaPan needs a client id to refresh the access token')
    }
    return await singleFlightRefresh(
      this.ctx,
      async () => {
        let payload: GypToken
        try {
          payload = await this.accountPost<GypToken>('/v1/auth/token', {
            client_id: this.clientId(),
            grant_type: 'refresh_token',
            refresh_token: beforeRefresh,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'GuangYaPan rejected the refresh token'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        if (!payload?.access_token) {
          const message = 'GuangYaPan returned no access token while refreshing'
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
        } catch (error) {
          const message = error instanceof Error ? error.message : 'GuangYaPan could not persist the refreshed token'
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

  private async accountPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.request(`${ACCOUNT}${path}`, {
      method: 'POST',
      headers: this.accountHeaders(),
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null) as (T & { error?: string; error_description?: string }) | null
    if (!payload) throw DriverError.upstream('GuangYaPan returned an unexpected body')
    if (payload.error) {
      throw DriverError.auth(`GuangYaPan token endpoint refused: ${payload.error_description || payload.error}`)
    }
    return payload
  }

  private async api<T>(path: string, body: Record<string, unknown>): Promise<GypCommon<T>> {
    if (!this.token) throw DriverError.auth('GuangYaPan needs an access token')
    const response = await this.request(`${API}${path}`, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null) as GypCommon<T> | null
    if (!payload) throw DriverError.upstream('GuangYaPan returned an unexpected body')
    if (payload.error) throw DriverError.auth(`GuangYaPan refused the request: ${payload.error}`)
    const code = Number(payload.code)
    if (code === 401 || code === 403) throw DriverError.auth(`GuangYaPan refused the access token (code ${code})`)
    if (code === 404) throw DriverError.notFound(`GuangYaPan could not find the resource (code ${code})`)
    if (code === 429) throw DriverError.rateLimited('GuangYaPan is rate limiting requests')
    return payload
  }

  private effectivePath(clean: string): string {
    const prefix = this.configText('rootPath').trim()
    if (!prefix) return clean
    const normalized = driverPath(prefix)
    if (normalized === '/') return clean
    return clean === '/' ? normalized : `${normalized}${clean}`
  }

  private rootId(): string {
    return ''
  }

  private async fileList(parentId: string, page: number, pageSize: number): Promise<{ items: GypFile[]; next: string | null }> {
    const payload = await this.api<{ total?: number; list?: GypFile[] }>('/userres/v1/file/get_file_list', {
      parentId,
      page: page - 1,
      pageSize,
      orderBy: ORDER_BY,
      sortType: SORT_TYPE,
    })
    const items = payload.data?.list ?? []
    const total = Number(payload.data?.total)
    const more = items.length >= pageSize
      || (Number.isFinite(total) && total > 0 && page * pageSize < total)
    return { items, next: more ? String(page + 1) : null }
  }

  private async allFiles(parentId: string): Promise<GypFile[]> {
    const collected = await collectPages(
      async ({ page }) => await this.fileList(parentId, page, PAGE_SIZE),
      { maxPages: MAX_LIST_PAGES },
    )
    return collected.items
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
      const found = files.find((file) => file.resType === 2 && file.fileName === segment)
      if (!found) throw DriverError.notFound(`GuangYaPan could not find ${segment}`)
      current = found.fileId
      prefix = `${prefix}/${segment}`
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveItem(clean: string): Promise<GypFile> {
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    const files = await this.allFiles(parentId)
    const found = files.find((file) => file.fileName === name)
    if (!found) throw DriverError.notFound(`GuangYaPan could not find ${name}`)
    return found
  }

  private async downloadUrl(fileId: string): Promise<string> {
    const payload = await this.api<{ signedURL?: string; downloadUrl?: string }>(
      '/nd.bizuserres.s/v1/get_res_download_url',
      { fileId },
    )
    const url = (payload.data?.signedURL || payload.data?.downloadUrl || '').trim()
    if (!url) throw DriverError.notFound('GuangYaPan returned no download address')
    return url
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const folderId = await this.resolveFolderId(this.effectivePath(clean))
      const pageSize = Math.min(PAGE_SIZE, Math.max(1, options.pageSize ?? PAGE_SIZE))
      const filter = (entries: DriverEntry[]): DriverEntry[] => {
        if (!options.search) return entries
        const needle = options.search.toLowerCase()
        return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      }
      if (options.page !== undefined) {
        const page = await this.fileList(folderId, Math.max(1, options.page), pageSize)
        return {
          entries: filter(page.items.map(fileEntry)),
          cursor: page.next,
          truncated: page.next !== null,
        }
      }
      const collected = await collectPages(
        async ({ page }) => await this.fileList(folderId, page, pageSize),
        { maxPages: MAX_LIST_PAGES },
      )
      return { entries: filter(collected.items.map(fileEntry)), cursor: null, truncated: collected.truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const effective = this.effectivePath(clean)
      if (effective === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
      }
      return fileEntry(await this.resolveItem(effective))
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(this.effectivePath(clean))
      if (file.resType === 2) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = await this.downloadUrl(file.fileId)
      const response = await fetch(url, {
        headers: { ...(range ? { Range: range } : {}) },
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
      const file = await this.resolveItem(this.effectivePath(clean))
      if (file.resType === 2) return null
      try {
        return await this.downloadUrl(file.fileId)
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'not_found') return null
        throw error
      }
    })
  }

  private async waitTask(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const payload = await this.api<{ status?: number }>('/nd.bizuserres.s/v1/get_task_status', { taskId })
      if (!isSuccessMessage(String(payload.msg ?? ''))) {
        throw DriverError.upstream(`GuangYaPan task ${taskId} failed: ${payload.msg || 'unknown error'}`)
      }
      const status = Number(payload.data?.status)
      if (status === 2) return
      if (status === -1 || status === 3) throw DriverError.upstream(`GuangYaPan task ${taskId} failed with status ${status}`)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw DriverError.upstream(`GuangYaPan task ${taskId} timed out`)
  }

  private async waitUploadTask(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const payload = await this.api<{ fileId?: string }>('/nd.bizuserres.s/v1/file/get_info_by_task_id', { taskId })
      if (payload.data?.fileId) return
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw DriverError.upstream(`GuangYaPan upload task ${taskId} timed out`)
  }

  private async signedOssRequest(input: {
    method: 'POST' | 'PUT'
    url: string
    resource: string
    contentType: string
    body?: BodyInit
    creds: { accessKeyID: string; secretAccessKey: string; sessionToken: string }
  }): Promise<Response> {
    return await ossRequest({
      method: input.method,
      url: input.url,
      contentType: input.contentType,
      body: input.body,
      resource: input.resource,
      securityToken: input.creds.sessionToken,
      accessKeyID: input.creds.accessKeyID,
      secretAccessKey: input.creds.secretAccessKey,
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const effective = this.effectivePath(clean)
    const name = validName(driverFileName(effective))
    return await this.withAuth(async () => {
      const parentId = await this.resolveFolderId(driverParentPath(effective))
      const payload = await this.api<GypUploadToken>('/nd.bizuserres.s/v1/get_res_center_token', {
        capacity: 2,
        name,
        parentId,
        res: { fileSize: bytes.byteLength, md5: md5(bytes) },
      })
      const message = String(payload.msg ?? '')
      const alreadyDone = Number(payload.code) === 156 || isUploadDoneMessage(message)
      if (!isSuccessMessage(message) && !alreadyDone) {
        throw DriverError.upstream(`GuangYaPan rejected the upload: ${message || 'unknown error'}`)
      }
      const token = payload.data ?? {}
      const taskId = String(token.taskId ?? '')
      if (alreadyDone) {
        if (!taskId) throw DriverError.upstream('GuangYaPan reported an instant upload without a task id')
        await this.waitUploadTask(taskId)
        options.onProgress?.(bytes.byteLength, bytes.byteLength)
        return
      }

      const creds = token.creds ?? {}
      const accessKeyID = String(creds.accessKeyID || token.accessKeyID || '')
      const secretAccessKey = String(creds.secretAccessKey || token.secretAccessKey || '')
      const sessionToken = String(creds.sessionToken || token.sessionToken || '')
      if (!token.objectPath || !token.bucketName || !token.endPoint || !accessKeyID || !secretAccessKey) {
        throw DriverError.upstream('GuangYaPan returned an incomplete upload token')
      }
      const endpoint = normalizeOssEndpoint(token.endPoint, token.bucketName)
      const objectPath = token.objectPath.replace(/^\/+/, '')
      const baseUrl = `https://${token.bucketName}.${new URL(endpoint).host}/${objectPath}`
      const resource = `/${token.bucketName}/${objectPath}`
      const ossCreds = { accessKeyID, secretAccessKey, sessionToken }

      if (bytes.byteLength <= UPLOAD_PART_SIZE) {
        const response = await this.signedOssRequest({
          method: 'PUT',
          url: baseUrl,
          resource,
          contentType: 'application/octet-stream',
          body: bytes,
          creds: ossCreds,
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw DriverError.upstream(`GuangYaPan OSS upload failed (HTTP ${response.status})`)
        }
        await response.body?.cancel().catch(() => undefined)
        options.onProgress?.(bytes.byteLength, bytes.byteLength)
      } else {
        const initiate = await this.signedOssRequest({
          method: 'POST',
          url: `${baseUrl}?uploads`,
          resource: `${resource}?uploads`,
          contentType: 'application/octet-stream',
          body: '',
          creds: ossCreds,
        })
        const initBody = await initiate.text().catch(() => '')
        if (!initiate.ok) throw DriverError.upstream(`GuangYaPan could not start a multipart upload (HTTP ${initiate.status})`)
        const uploadId = /<UploadId>([^<]+)</.exec(initBody)?.[1] ?? ''
        if (!uploadId) throw DriverError.upstream('GuangYaPan returned no multipart upload id')

        const etags = new Map<number, string>()
        const partCount = Math.ceil(bytes.byteLength / UPLOAD_PART_SIZE)
        await uploadInParts({
          size: bytes.byteLength,
          partSize: UPLOAD_PART_SIZE,
          concurrency: 1,
          uploadPart: async (partNumber, start, end) => {
            const partBody = bytes.subarray(start, end)
            const suffix = `?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`
            let lastError = ''
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const response = await this.signedOssRequest({
                  method: 'PUT',
                  url: `${baseUrl}${suffix}`,
                  resource: `${resource}${suffix}`,
                  contentType: 'application/octet-stream',
                  body: partBody,
                  creds: ossCreds,
                })
                if (response.ok) {
                  const etag = response.headers.get('etag') ?? ''
                  await response.body?.cancel().catch(() => undefined)
                  if (!etag) throw DriverError.upstream('GuangYaPan returned no part ETag')
                  etags.set(partNumber, etag)
                  options.onProgress?.(end, bytes.byteLength)
                  return
                }
                lastError = `HTTP ${response.status}`
                await response.body?.cancel().catch(() => undefined)
              } catch (error) {
                lastError = error instanceof Error ? error.message : String(error)
              }
            }
            throw DriverError.upstream(`GuangYaPan OSS part ${partNumber}/${partCount} failed after one retry: ${lastError}`)
          },
          complete: async () => {
            const parts = [...etags.entries()]
              .sort(([a], [b]) => a - b)
              .map(([partNumber, etag]) => `<Part><PartNumber>${partNumber}</PartNumber><ETag>${etag}</ETag></Part>`)
              .join('')
            const suffix = `?uploadId=${encodeURIComponent(uploadId)}`
            const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`
            const response = await this.signedOssRequest({
              method: 'POST',
              url: `${baseUrl}${suffix}`,
              resource: `${resource}${suffix}`,
              contentType: 'application/xml',
              body: xml,
              creds: ossCreds,
            })
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined)
              throw DriverError.upstream(`GuangYaPan could not complete the multipart upload (HTTP ${response.status})`)
            }
            await response.body?.cancel().catch(() => undefined)
          },
        })
      }

      if (taskId) await this.waitUploadTask(taskId)
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    const effective = this.effectivePath(clean)
    if (effective === '/') return
    const name = validName(driverFileName(effective))
    return await this.withAuth(async () => {
      const parentId = await this.resolveFolderId(driverParentPath(effective))
      await this.api('/nd.bizuserres.s/v1/file/create_dir', { parentId, dirName: name })
      this.pathIds.clear()
    })
  }

  private async renameItem(fileId: string, newName: string): Promise<void> {
    await this.api('/nd.bizuserres.s/v1/file/rename', { fileId, newName })
    this.pathIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const targetName = validName(newName)
    return await this.withAuth(async () => {
      const item = await this.resolveItem(this.effectivePath(clean))
      await this.renameItem(item.fileId, targetName)
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = this.effectivePath(driverPath(toPath))
    const targetName = validName(driverFileName(to))
    return await this.withAuth(async () => {
      const item = await this.resolveItem(this.effectivePath(from))
      if (item.fileName !== targetName) await this.renameItem(item.fileId, targetName)
      const parentId = await this.resolveFolderId(driverParentPath(to))
      const payload = await this.api<{ taskId?: string }>('/nd.bizuserres.s/v1/file/move_file', {
        fileIds: [item.fileId],
        parentId,
      })
      const taskId = String(payload.data?.taskId ?? '')
      if (taskId) await this.waitTask(taskId)
      this.pathIds.clear()
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = this.effectivePath(driverPath(toPath))
    return await this.withAuth(async () => {
      const item = await this.resolveItem(this.effectivePath(from))
      const parentId = await this.resolveFolderId(driverParentPath(to))
      const payload = await this.api<{ taskId?: string }>('/nd.bizuserres.s/v1/file/copy_file', {
        fileIds: [item.fileId],
        parentId,
      })
      const taskId = String(payload.data?.taskId ?? '')
      if (taskId) await this.waitTask(taskId)
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const item = await this.resolveItem(this.effectivePath(clean))
      const payload = await this.api<{ taskId?: string }>('/nd.bizuserres.s/v1/file/delete_file', {
        fileIds: [item.fileId],
      })
      const taskId = String(payload.data?.taskId ?? '')
      if (taskId) await this.waitTask(taskId)
      this.pathIds.clear()
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.fileList(this.rootId(), 1, 1)
      return { ok: true, message: 'GuangYaPan is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'GuangYaPan is unavailable' }
    }
  }
}

export function createGuangyapanDriver(ctx: DriverContext): MountDriver {
  return new GuangYaPanDriver(ctx)
}
