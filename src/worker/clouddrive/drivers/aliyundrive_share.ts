/**
 * Aliyundrive (Alipan) share-link driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/aliyundrive_share`.
 * A share token (`x-share-token`) is anonymous and expires after roughly two hours; the optional
 * refresh token identifies the visitor when the share is not public, so it is exchanged for an
 * access token that accompanies the share token. Listing is marker based and the download URL still
 * requires the Alipan Referer when it is fetched.
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
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const API_BASE = 'https://api.alipan.com'
const TOKEN_API = 'https://auth.alipan.com/v2/account/token'
const SHARE_TOKEN_API = `${API_BASE}/v2/share_link/get_share_token`
const LIST_API = `${API_BASE}/adrive/v3/file/list`
const DOWNLOAD_API = `${API_BASE}/v2/file/get_share_link_download_url`
const CLIENT_ID = '25ab4837190e48718a28f80073574a4d'
const CANARY = 'client=web,app=share,version=v2.3.1'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const DOWNLOAD_REFERER = 'https://www.aliyundrive.com/'
const SHARE_TOKEN_TTL_MS = 2 * 60 * 60 * 1000
const MAX_PAGE_SIZE = 200
const DEFAULT_PAGE_SIZE = 200
const MAX_PAGES = 50

interface AliShareItem {
  drive_id?: string
  file_id?: string
  name?: string
  size?: number
  type?: string
  created_at?: string
  updated_at?: string
  thumbnail?: string
}

interface AliListResponse {
  items?: AliShareItem[]
  next_marker?: string
  code?: string
  message?: string
}

interface AliShareTokenResponse {
  share_token?: string
  expires_in?: number
  code?: string
  message?: string
}

interface AliDownloadResponse {
  download_url?: string
  url?: string
  code?: string
  message?: string
}

interface AliAccessTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  code?: string
  message?: string
}

function timestampValue(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

class AliyundriveShareDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('aliyundrive_share')!
  readonly capabilities = this.definition.capabilities
  private readonly pathIds = new Map<string, string>()
  private shareToken = ''
  private shareTokenAt = 0
  private accessToken = ''
  private accessTokenExpiresAt = 0
  private driveId = ''

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private credential(key: string): string {
    return (this.ctx.credentials[key] ?? '').trim()
  }

  private shareId(): string {
    return this.configText('shareId').trim()
  }

  private rootId(): string {
    return this.configText('rootFolderId').trim() || 'root'
  }

  protected async login(force: boolean): Promise<void> {
    // The share token is fetched lazily inside each request so a rejected token is retried once.
    if (force) {
      this.shareToken = ''
      this.shareTokenAt = 0
      this.accessToken = ''
      this.accessTokenExpiresAt = 0
    }
  }

  private codeError(code: string, message?: string): DriverError {
    const text = message || `Aliyundrive Share answered ${code}`
    if (/ShareLinkTokenInvalid|AccessTokenInvalid|AccessTokenExpired|InvalidToken|Forbidden|Unauthorized|ShareLinkExpired|ShareLinkCancelled/i.test(code)) {
      return DriverError.auth(text)
    }
    if (/TooManyRequests|Throttl|RateLimit/i.test(code)) return DriverError.rateLimited(text)
    if (/NotFound|NotExist/i.test(code)) return DriverError.notFound(text)
    return DriverError.upstream(text)
  }

  /** Exchanges the optional refresh token for the visitor access token, persisting any rotation. */
  private async ensureAccessToken(): Promise<string> {
    const refresh = this.credential('refreshToken')
    if (!refresh) return ''
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken
    const response = await this.request(TOKEN_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID }),
    })
    const payload = await response.json() as AliAccessTokenResponse
    if (payload.code) throw this.codeError(payload.code, payload.message)
    if (!payload.access_token) throw DriverError.auth('Aliyundrive Share could not refresh the visitor token')
    this.accessToken = payload.access_token
    this.accessTokenExpiresAt = Date.now() + (payload.expires_in ?? 7200) * 1000 - 60_000
    if (payload.refresh_token && payload.refresh_token !== refresh) {
      await this.saveCredential({ refreshToken: payload.refresh_token })
    }
    return this.accessToken
  }

  private async ensureShareToken(): Promise<void> {
    if (this.shareToken && Date.now() - this.shareTokenAt < SHARE_TOKEN_TTL_MS - 60_000) return
    const shareId = this.shareId()
    if (!shareId) throw DriverError.auth('Aliyundrive Share needs the share id from the share link')
    const payload = await this.shareRequest<AliShareTokenResponse>(SHARE_TOKEN_API, {
      share_id: shareId,
      ...(this.credential('sharePwd') ? { share_pwd: this.credential('sharePwd') } : {}),
    }, false)
    if (!payload.share_token) throw DriverError.auth('Aliyundrive Share refused the share id or the share password')
    this.shareToken = payload.share_token
    this.shareTokenAt = Date.now()
  }

  private async shareRequest<T>(
    url: string,
    body: Record<string, unknown>,
    includeShareToken: boolean,
  ): Promise<T> {
    // The token endpoint is anonymous; it must not call `ensureShareToken` or it would recurse.
    if (includeShareToken) await this.ensureShareToken()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-canary': CANARY,
    }
    if (includeShareToken) {
      headers['x-share-token'] = this.shareToken
      const accessToken = await this.ensureAccessToken()
      if (accessToken) headers.authorization = `Bearer ${accessToken}`
    }
    const response = await this.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const payload = await response.json() as T & { code?: string; message?: string }
    if (payload.code) throw this.codeError(payload.code, payload.message)
    return payload
  }

  private async listPage(
    parentId: string,
    marker: string | null,
    limit: number,
  ): Promise<{ items: AliShareItem[]; next: string | null }> {
    return await this.withAuth(async () => {
      const shareId = this.shareId()
      if (!shareId) throw DriverError.auth('Aliyundrive Share needs the share id from the share link')
      const body: Record<string, unknown> = {
        image_thumbnail_process: 'image/resize,w_160/format,jpeg',
        image_url_process: 'image/resize,w_1920/format,jpeg',
        video_thumbnail_process: 'video/snapshot,t_1000,f_jpg,ar_auto,w_300',
        limit,
        order_by: 'name',
        order_direction: 'ASC',
        parent_file_id: parentId || 'root',
        share_id: shareId,
      }
      if (marker) body.marker = marker
      const payload = await this.shareRequest<AliListResponse>(LIST_API, body, true)
      const items = payload.items ?? []
      if (!this.driveId) {
        const drive = items.find((item) => item.drive_id)?.drive_id
        if (drive) this.driveId = drive
      }
      return { items, next: payload.next_marker || null }
    })
  }

  private async allItems(parentId: string, limit: number): Promise<AliShareItem[]> {
    const items: AliShareItem[] = []
    let marker: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.listPage(parentId, marker, limit)
      items.push(...result.items)
      if (!result.next || result.items.length === 0) break
      marker = result.next
    }
    return items
  }

  private async resolveFolderId(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return this.rootId()
    let id = this.rootId()
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        id = cached
        continue
      }
      const children = await this.allItems(id, MAX_PAGE_SIZE)
      const found = children.find((item) => item.type === 'folder' && item.name === segment)
      if (!found?.file_id) throw DriverError.notFound(`The share folder does not exist: ${segment}`)
      id = found.file_id
      this.pathIds.set(prefix, id)
    }
    return id
  }

  private async resolveEntry(path: string): Promise<AliShareItem> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is a folder, not a file')
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    const children = await this.allItems(parentId, MAX_PAGE_SIZE)
    const found = children.find((item) => item.name === name)
    if (!found?.file_id) throw DriverError.notFound(`The share item does not exist: ${name}`)
    return found
  }

  private entryOf(item: AliShareItem): DriverEntry {
    const folder = item.type === 'folder'
    const name = item.name || 'file'
    return {
      name,
      kind: folder ? 'folder' : 'file',
      size: folder ? 0 : Number(item.size) || 0,
      modifiedAt: timestampValue(item.updated_at || item.created_at),
      ref: item.file_id,
      mime: folder ? 'application/octet-stream' : driverEntryMime(name),
    }
  }

  private async downloadUrl(fileId: string): Promise<string> {
    return await this.withAuth(async () => {
      const shareId = this.shareId()
      const body: Record<string, unknown> = {
        share_id: shareId,
        file_id: fileId,
        expire_sec: 14400,
      }
      if (this.driveId) body.drive_id = this.driveId
      const payload = await this.shareRequest<AliDownloadResponse>(DOWNLOAD_API, body, true)
      const url = payload.download_url || payload.url
      if (!url) throw DriverError.upstream('Aliyundrive Share returned no download address')
      return url
    })
  }

  private async downloadResult(response: Response, label: string): Promise<Response> {
    if (response.status >= 200 && response.status < 300) return response
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) {
      const message = `${label} refused the download link (HTTP ${response.status})`
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    if (response.status === 404) throw DriverError.notFound(`${label} download failed (HTTP 404)`)
    if (response.status === 429) throw DriverError.rateLimited(`${label} is rate limiting downloads`)
    throw DriverError.upstream(`${label} download failed (HTTP ${response.status})`)
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const parentId = await this.resolveFolderId(clean)
    const pageSize = options.pageSize
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize))
      : DEFAULT_PAGE_SIZE

    if (options.page !== undefined) {
      const page = Math.max(1, options.page)
      let marker: string | null = null
      let current = 1
      while (current < page) {
        const result = await this.listPage(parentId, marker, pageSize)
        if (!result.next) {
          return { entries: [], cursor: null, truncated: false }
        }
        marker = result.next
        current++
      }
      const result = await this.listPage(parentId, marker, pageSize)
      return {
        entries: result.items.map((item) => this.entryOf(item)),
        cursor: result.next,
        truncated: result.next !== null,
      }
    }

    const collected = await collectPages(async ({ cursor }) => {
      const result = await this.listPage(parentId, cursor, pageSize)
      return { items: result.items, next: result.next }
    }, { mode: 'cursor', maxPages: MAX_PAGES })
    return {
      entries: collected.items.map((item) => this.entryOf(item)),
      cursor: null,
      truncated: collected.truncated,
    }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
    }
    return this.entryOf(await this.resolveEntry(clean))
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const item = await this.resolveEntry(clean)
    if (item.type === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    if (!item.file_id) throw DriverError.notFound('The share item has no file id')
    const link = await this.downloadUrl(item.file_id)
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      referer: DOWNLOAD_REFERER,
    }
    if (range) headers.Range = range
    const response = await fetch(link, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    return await this.downloadResult(response, 'Aliyundrive Share')
  }

  async directLink(path: string): Promise<string | null> {
    const item = await this.resolveEntry(driverPath(path))
    if (item.type === 'folder' || !item.file_id) return null
    return await this.downloadUrl(item.file_id)
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('Aliyundrive Share is a read-only storage')
  }

  async mkdir(_path: string): Promise<void> {
    throw DriverError.unsupported('Aliyundrive Share is a read-only storage')
  }

  async rename(_path: string, _newName: string): Promise<void> {
    throw DriverError.unsupported('Aliyundrive Share is a read-only storage')
  }

  async move(_fromPath: string, _toPath: string): Promise<void> {
    throw DriverError.unsupported('Aliyundrive Share is a read-only storage')
  }

  async remove(_path: string): Promise<void> {
    throw DriverError.unsupported('Aliyundrive Share is a read-only storage')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.listPage(this.rootId(), null, 1)
      return { ok: true, message: 'Aliyundrive Share is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Aliyundrive Share is unavailable' }
    }
  }
}

export function createAliyundriveShareDriver(ctx: DriverContext): MountDriver {
  return new AliyundriveShareDriver(ctx)
}
