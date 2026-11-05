/**
 * PikPak account driver.
 *
 * Ported from the reference implementation (`OpenList-Worker/src/backend/drivers/pikpak`). PikPak
 * rotates a refresh token on every refresh, so refreshes run through the shared single flight and a
 * compare-and-swap write-back; the device header set and captcha sign match the reference client.
 */
import { createHash } from 'node:crypto'
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

const API = 'https://api-drive.mypikpak.net/drive/v1'
const USER = 'https://user.mypikpak.net/v1'
const DEFAULT_CLIENT_ID = 'YUMx5nI8ZU8Ap8pm'
const CLIENT_VERSION = '2.0.0'
const PACKAGE_NAME = 'mypikpak.com'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PAGE_LIMIT = 100
const MAX_LIST_PAGES = 50

// The MD5 chain the PikPak web client uses to sign its captcha request.
const CAPTCHA_ALGORITHMS = [
  'C9qPpZLN8ucRTaTiUMWYS9cQvWOE',
  '+r6CQVxjzJV6LCV',
  'F',
  'pFJRC',
  '9WXYIDGrwTCz2OiVlgZa90qpECPD6olt',
  '/750aCr4lm/Sly/c',
  'RB+DT/gZCrbV',
  '',
  'CyLsf7hdkIRxRm215hl',
  '7xHvLi2tOYP0Y92b',
  'ZGTXXxu8E/MIWaEDB+Sm/',
  '1UI3',
  'E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO',
  'ihtqpG6FMt65+Xk+tWUH2',
  'NhXXU9rg4XXdzo7u5o',
]

interface PikPakFile {
  id: string
  kind?: string
  name: string
  size?: string | number
  modified_time?: string
  created_time?: string
  web_content_link?: string
  thumbnail_link?: string
  medias?: Array<{ link?: { url?: string; expire?: string } }>
}

interface PikPakList {
  files?: PikPakFile[]
  next_page_token?: string
  error_code?: number
  error?: string
  error_description?: string
}

interface PikPakToken {
  access_token?: string
  refresh_token?: string
  sub?: string
  expires_in?: number
  error_code?: number
  error?: string
  error_description?: string
}

interface PikPakUploadTask {
  resumable?: {
    params?: {
      bucket?: string
      key?: string
      endpoint?: string
      security_token?: string
      part_size?: string | number
      upload_id?: string
      uploadId?: string
    }
  }
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex').toUpperCase()
}

function fileEntry(file: PikPakFile): DriverEntry {
  const folder = file.kind === 'drive#folder'
  return {
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: file.modified_time ? Date.parse(file.modified_time) || 0 : 0,
    ref: file.id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.name),
  }
}

function downloadUrlOf(file: PikPakFile): string {
  const media = file.medias?.[0]?.link?.url
  return media || file.web_content_link || ''
}

function downloadError(response: Response): DriverError {
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'))
    return DriverError.rateLimited('PikPak is rate limiting the download', Number.isFinite(retry) ? retry * 1000 : undefined)
  }
  if (response.status === 404) return DriverError.notFound('PikPak could not find the download')
  if (response.status === 401 || response.status === 403) return DriverError.auth('PikPak refused the download')
  return DriverError.upstream(`PikPak download failed (HTTP ${response.status})`)
}

export class PikPakDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('pikpak')!
  readonly capabilities = this.definition.capabilities
  private accessToken = ''
  private refreshToken = ''
  private captchaToken = ''
  private readonly pathIds = new Map<string, string>()
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly deviceId: string

  constructor(ctx: DriverContext) {
    super(ctx)
    this.clientId = String(ctx.credentials.clientId ?? '') || DEFAULT_CLIENT_ID
    this.clientSecret = String(ctx.credentials.clientSecret ?? '')
    this.accessToken = String(ctx.credentials.accessToken ?? '')
    this.refreshToken = String(ctx.credentials.refreshToken ?? '')
    this.deviceId = md5(`${this.configText('username')}${String(ctx.credentials.password ?? '')}`)
  }

  protected async login(force: boolean): Promise<void> {
    this.accessToken = String(this.ctx.credentials.accessToken ?? '')
    this.refreshToken = String(this.ctx.credentials.refreshToken ?? '')
    if (!force && this.accessToken) return
    try {
      if (this.refreshToken) {
        await this.rotate()
      } else {
        await this.signIn()
      }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message).catch(() => undefined)
      }
      throw error
    }
  }

  private async rotate(): Promise<void> {
    const before = { accessToken: this.accessToken, refreshToken: this.refreshToken }
    const token = await singleFlightRefresh(
      this.ctx,
      async () => await this.refreshTokens(before),
      async () => {
        await this.ctx.reloadCredentials?.()
        const currentAccess = String(this.ctx.credentials.accessToken ?? '')
        const currentRefresh = String(this.ctx.credentials.refreshToken ?? '')
        if (currentRefresh && currentRefresh !== before.refreshToken) {
          this.accessToken = currentAccess
          this.refreshToken = currentRefresh
          return currentAccess || null
        }
        if (currentAccess && currentAccess !== before.accessToken) {
          this.accessToken = currentAccess
          return currentAccess
        }
        return null
      },
    )
    this.accessToken = token
  }

  private tokenHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-Device-ID': this.deviceId,
      'X-Client-ID': this.clientId,
    }
  }

  private async refreshTokens(before: Record<string, string>): Promise<string> {
    const response = await this.request(`${USER}/auth/token?client_id=${encodeURIComponent(this.clientId)}`, {
      method: 'POST',
      headers: this.tokenHeaders(),
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: before.refreshToken,
      }),
    })
    const payload = await response.json() as PikPakToken
    if (payload.error_code && payload.error_code !== 0) {
      if (payload.error_code === 4126 && this.configText('username') && String(this.ctx.credentials.password ?? '')) {
        await this.signIn()
        return this.accessToken
      }
      throw DriverError.auth(
        `PikPak token refresh failed (${payload.error_code}): ${payload.error_description || payload.error || 'unknown error'}`,
      )
    }
    if (!payload.access_token) throw DriverError.auth('PikPak returned no access token while refreshing')
    const patch: Record<string, string> = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || before.refreshToken,
      expiresAt: payload.expires_in ? String(Date.now() + payload.expires_in * 1000) : '0',
    }
    const effective = await this.saveCredential(patch, before)
    this.accessToken = String(effective.accessToken ?? patch.accessToken)
    this.refreshToken = String(effective.refreshToken ?? patch.refreshToken)
    return this.accessToken
  }

  private async signIn(): Promise<void> {
    const username = this.configText('username')
    const password = String(this.ctx.credentials.password ?? '')
    if (!username || !password) {
      throw DriverError.auth('PikPak needs an account and password, or a refresh token.')
    }
    const before = { accessToken: this.accessToken, refreshToken: this.refreshToken }
    this.captchaToken = await this.captchaInit(username)
    const response = await this.request(`${USER}/auth/signin?client_id=${encodeURIComponent(this.clientId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-Device-ID': this.deviceId,
        'X-Captcha-Token': this.captchaToken,
      },
      body: JSON.stringify({
        captcha_token: this.captchaToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        username,
        password,
      }),
    })
    const payload = await response.json() as PikPakToken
    if (payload.error_code && payload.error_code !== 0) {
      throw DriverError.auth(
        `PikPak sign-in failed (${payload.error_code}): ${payload.error_description || payload.error || 'unknown error'}`,
      )
    }
    if (!payload.access_token || !payload.refresh_token) throw DriverError.auth('PikPak sign-in returned no token pair')
    const effective = await this.saveCredential({
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: payload.expires_in ? String(Date.now() + payload.expires_in * 1000) : '0',
    }, before)
    this.accessToken = String(effective.accessToken ?? payload.access_token)
    this.refreshToken = String(effective.refreshToken ?? payload.refresh_token)
  }

  private async captchaInit(username: string): Promise<string> {
    const timestamp = String(Date.now())
    let digest = `${this.clientId}${CLIENT_VERSION}${PACKAGE_NAME}${this.deviceId}${timestamp}`
    for (const algorithm of CAPTCHA_ALGORITHMS) digest = md5(digest + algorithm)
    const metas: Record<string, string> = {}
    if (/^\w+([-+.]\w+)*@\w+([-.]\w+)*\.\w+([-.]\w+)*$/.test(username)) metas.email = username
    else if (username.length >= 11 && username.length <= 18) metas.phone_number = username
    else metas.username = username

    let response: Response
    try {
      response = await fetch(`${USER}/shield/captcha/init?client_id=${encodeURIComponent(this.clientId)}`, {
        method: 'POST',
        headers: this.tokenHeaders(),
        body: JSON.stringify({
          action: 'POST:/v1/auth/signin',
          captcha_token: this.captchaToken,
          client_id: this.clientId,
          device_id: this.deviceId,
          meta: metas,
          redirect_uri: 'xlaccsdk01://xbase.cloud/callback?state=harbor',
        }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw DriverError.upstream(`PikPak captcha endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw DriverError.upstream(`PikPak captcha init failed (HTTP ${response.status})`)
    const payload = await response.json().catch(() => null) as {
      captcha_token?: string
      url?: string
      error_code?: number
      error_description?: string
      error?: string
    } | null
    if (payload?.error_code && payload.error_code !== 0) {
      throw DriverError.auth(`PikPak captcha failed (${payload.error_code}): ${payload.error_description || payload.error}`)
    }
    if (payload?.url) throw DriverError.auth(`PikPak requires captcha verification: ${payload.url}`)
    return payload?.captcha_token ?? ''
  }

  private apiHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
      'X-Device-ID': this.deviceId,
      'X-Client-ID': this.clientId,
      ...(this.captchaToken ? { 'X-Captcha-Token': this.captchaToken } : {}),
    }
  }

  private async api<T>(
    path: string,
    init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    return await this.withAuth(async () => {
      const query = init.query ? `?${new URLSearchParams(init.query).toString()}` : ''
      const url = `${API}${path}${query}`
      const headers = {
        ...this.apiHeaders(this.accessToken),
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }
      const body = init.body === undefined ? undefined : JSON.stringify(init.body)
      const method = init.method ?? 'GET'
      let response: Response
      if (method === 'PATCH') {
        // HttpOptions has no PATCH; this one call does its own status mapping.
        try {
          response = await fetch(url, {
            method,
            headers,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(20_000),
          })
        } catch (error) {
          throw DriverError.upstream(`PikPak could not be reached: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (response.status === 429) throw DriverError.rateLimited('PikPak is rate limiting requests')
        if (response.status === 401 || response.status === 403) throw DriverError.auth('PikPak refused the request')
        if (response.status === 404) throw DriverError.notFound('PikPak could not find the item')
        if (!response.ok) throw DriverError.upstream(`PikPak answered HTTP ${response.status}`)
      } else {
        response = await this.request(url, { method, headers, body })
      }
      if (response.status === 204) return undefined as T
      const text = await response.text()
      let payload: (T & { error_code?: number; error?: string; error_description?: string }) | null = null
      if (text) {
        try {
          payload = JSON.parse(text) as T & { error_code?: number; error?: string; error_description?: string }
        } catch {
          throw DriverError.upstream('PikPak returned an unexpected body')
        }
      }
      if (!payload) return {} as T
      const code = Number(payload.error_code)
      if (code) {
        if (code === 4122 || code === 4121 || code === 16 || code === 9) {
          throw DriverError.auth(`PikPak authorization expired (${code})`)
        }
        if (code === 429) throw DriverError.rateLimited('PikPak is rate limiting requests')
        if (code === 404) throw DriverError.notFound('PikPak could not find the item')
        throw DriverError.upstream(`PikPak answered error ${code}: ${payload.error_description || payload.error || ''}`)
      }
      return payload
    })
  }

  private rootId(): string {
    return this.configText('rootFolderId').trim()
  }

  private async filesPage(parentId: string, token: string, limit: number): Promise<PikPakList> {
    return await this.api<PikPakList>('/files', {
      query: {
        parent_id: parentId,
        thumbnail_size: 'SIZE_LARGE',
        with_audit: 'true',
        limit: String(Math.min(PAGE_LIMIT, Math.max(1, limit))),
        filters: JSON.stringify({ phase: { eq: 'PHASE_TYPE_COMPLETE' }, trashed: { eq: false } }),
        ...(token ? { page_token: token } : {}),
      },
    })
  }

  private async listAll(parentId: string): Promise<PikPakFile[]> {
    const files: PikPakFile[] = []
    let token = ''
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const data = await this.filesPage(parentId, token, PAGE_LIMIT)
      files.push(...(data.files ?? []))
      const next = data.next_page_token ?? ''
      if (!next || next === token) return files
      token = next
    }
    return files
  }

  private async listPage(parentId: string, pageNumber: number, pageSize: number): Promise<{ files: PikPakFile[]; next: string | null }> {
    let token = ''
    for (let current = 1; current <= Math.max(1, pageNumber); current++) {
      const data = await this.filesPage(parentId, token, pageSize)
      if (current === pageNumber) return { files: data.files ?? [], next: data.next_page_token || null }
      const next = data.next_page_token ?? ''
      if (!next || next === token) break
      token = next
    }
    return { files: [], next: null }
  }

  private async resolveFolder(path: string): Promise<string> {
    const clean = driverPath(path)
    const root = this.rootId()
    if (clean === '/') return root
    const segments = clean.split('/').filter(Boolean)
    let current = root
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        current = cached
        continue
      }
      const files = await this.listAll(current)
      const found = files.find((file) => file.kind === 'drive#folder' && file.name === segment)
      if (!found) throw DriverError.notFound(`PikPak could not find the folder ${prefix}`)
      current = found.id
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveEntry(path: string): Promise<PikPakFile> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolder(driverParentPath(clean))
    const files = await this.listAll(parentId)
    const found = files.find((file) => file.name === driverFileName(clean))
    if (!found) throw DriverError.notFound(`PikPak could not find ${clean}`)
    return found
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const parentId = await this.resolveFolder(clean)
    const pageSize = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? PAGE_LIMIT))
    if (options.page !== undefined) {
      const page = await this.listPage(parentId, Math.max(1, options.page), pageSize)
      return { entries: page.files.map(fileEntry), cursor: page.next, truncated: page.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const data = await this.filesPage(parentId, cursor ?? '', pageSize)
      return { items: data.files ?? [], next: data.next_page_token || null }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
    }
    return fileEntry(await this.resolveEntry(clean))
  }

  private async fileDetail(id: string, usage: 'CACHE' | 'FETCH' = 'CACHE'): Promise<PikPakFile> {
    return await this.api<PikPakFile>(`/files/${encodeURIComponent(id)}`, {
      query: { _magic: '2021', usage, thumbnail_size: 'SIZE_LARGE' },
    })
  }

  private async downloadUrl(file: PikPakFile): Promise<string> {
    let detail = await this.fileDetail(file.id, 'CACHE')
    let url = downloadUrlOf(detail)
    if (!url && file.kind !== 'drive#folder') {
      detail = await this.fileDetail(file.id, 'FETCH')
      url = downloadUrlOf(detail)
    }
    if (!url) throw DriverError.notFound('PikPak returned no download address')
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const url = await this.downloadUrl(await this.resolveEntry(clean))
    const response = await fetch(url, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw downloadError(response)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') return null
    return await this.downloadUrl(await this.resolveEntry(clean))
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const parentId = await this.resolveFolder(driverParentPath(clean))
    const task = await this.api<PikPakUploadTask>('/files', {
      method: 'POST',
      body: {
        kind: 'drive#file',
        name: driverFileName(clean),
        size: String(bytes.byteLength),
        hash: sha1Hex(bytes),
        upload_type: 'UPLOAD_TYPE_RESUMABLE',
        objProvider: { provider: 'UPLOAD_TYPE_UNKNOWN' },
        parent_id: parentId,
        folder_type: 'NORMAL',
      },
    })
    const params = task.resumable?.params
    if (!params) {
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    const endpoint = params.endpoint ?? 'mypikpak.net'
    const url = `https://${params.bucket}.${endpoint}/${params.key}`
    const headers: Record<string, string> = {
      'x-oss-security-token': params.security_token ?? '',
      'Content-Length': String(bytes.byteLength),
    }
    const partSize = Number(params.part_size) || 0
    const uploadId = params.upload_id || params.uploadId || ''
    if (partSize > 0 && uploadId) {
      const parts: Array<{ number: number; etag: string }> = []
      await uploadInParts({
        size: bytes.byteLength,
        partSize,
        concurrency: 1,
        uploadPart: async (partNumber, start, end) => {
          const chunk = bytes.subarray(start, end)
          const response = await fetch(`${url}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`, {
            method: 'PUT',
            headers: { 'x-oss-security-token': params.security_token ?? '', 'Content-Length': String(chunk.byteLength) },
            body: chunk,
            signal: AbortSignal.timeout(60_000),
          })
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            throw DriverError.upstream(`PikPak rejected upload part ${partNumber} (HTTP ${response.status})`)
          }
          parts.push({ number: partNumber, etag: response.headers.get('etag') ?? '' })
          options.onProgress?.(end, bytes.byteLength)
        },
        complete: async () => {
          const xml = `<CompleteMultipartUpload>${parts
            .sort((left, right) => left.number - right.number)
            .map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${part.etag}</ETag></Part>`)
            .join('')}</CompleteMultipartUpload>`
          const response = await fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml', 'x-oss-security-token': params.security_token ?? '' },
            body: xml,
            signal: AbortSignal.timeout(30_000),
          })
          if (!response.ok) throw DriverError.upstream(`PikPak could not complete the upload (HTTP ${response.status})`)
        },
      })
      return
    }
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: bytes,
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`PikPak rejected the upload (HTTP ${response.status})`)
    }
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveFolder(driverParentPath(clean))
    await this.api('/files', {
      method: 'POST',
      body: { kind: 'drive#folder', parent_id: parentId, name: driverFileName(clean) },
    })
    this.pathIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const entry = await this.resolveEntry(clean)
    await this.api(`/files/${encodeURIComponent(entry.id)}`, { method: 'PATCH', body: { name: newName } })
    this.pathIds.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const entry = await this.resolveEntry(from)
    const parentId = await this.resolveFolder(driverParentPath(to))
    const targetName = driverFileName(to)
    if (targetName !== entry.name) await this.rename(from, targetName)
    await this.api('/files:batchMove', {
      method: 'POST',
      body: { ids: [entry.id], to: { parent_id: parentId } },
    })
    this.pathIds.clear()
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const entry = await this.resolveEntry(from)
    const parentId = await this.resolveFolder(driverParentPath(to))
    await this.api('/files:batchCopy', {
      method: 'POST',
      body: { ids: [entry.id], to: { parent_id: parentId } },
    })
    this.pathIds.clear()
  }

  async remove(path: string): Promise<void> {
    const entry = await this.resolveEntry(driverPath(path))
    await this.api('/files:batchTrash', { method: 'POST', body: { ids: [entry.id] } })
    this.pathIds.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const about = await this.api<{ quota?: { limit?: string; usage?: string } }>('/about')
      const limit = Number(about.quota?.limit ?? 0)
      return { ok: true, message: limit > 0 ? `PikPak is reachable · ${(limit / 1024 ** 3).toFixed(0)} GiB` : 'PikPak is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'PikPak is unavailable' }
    }
  }
}

export function createPikPakDriver(ctx: DriverContext): MountDriver {
  return new PikPakDriver(ctx)
}
