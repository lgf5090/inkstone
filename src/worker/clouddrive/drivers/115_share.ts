/**
 * 115 share-link driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/115_share`:
 * the share snapshot endpoint (`share/snap`) resolves one directory at a time by `cid`, and the
 * download endpoint (`app/share/downurl`) trades the share code, receive code and file id for a
 * short-lived URL that only works with the 115 User-Agent and Referer.
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
import { cookieHeader } from './cookies'
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const API_BASE = 'https://webapi.115.com'
const DOWNLOAD_URL_API = 'https://proapi.115.com/app/share/downurl'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://115.com/'
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 1000
const MAX_PAGES = 50

interface Pan115Item {
  file_id?: string
  category_id?: string
  file_name?: string
  file_size?: number | string
  is_file?: number
  user_utime?: number | string
  thumb_url?: string
}

interface Pan115Snap {
  state?: boolean
  msg?: string
  data?: {
    count?: number
    list?: Pan115Item[]
  }
}

interface Pan115Download {
  state?: boolean
  msg?: string
  data?: {
    url?: string | { url?: string }
  }
}

function numberValue(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

class Pan115ShareDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('115_share')!
  readonly capabilities = this.definition.capabilities
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private credential(key: string): string {
    return (this.ctx.credentials[key] ?? '').trim()
  }

  private shareCode(): string {
    return this.configText('shareCode').trim()
  }

  private receiveCode(): string {
    return this.credential('receiveCode')
  }

  private rootId(): string {
    return this.configText('rootFolderId').trim() || '0'
  }

  private pageSize(): number {
    const raw = this.ctx.config.pageSize
    const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
    return Number.isFinite(value) ? Math.min(MAX_PAGE_SIZE, Math.max(1, value)) : DEFAULT_PAGE_SIZE
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      referer: REFERER,
      'user-agent': USER_AGENT,
    }
    const cookie = cookieHeader(this.credential('cookie'))
    if (cookie) headers.cookie = cookie
    return headers
  }

  /** The share code and receive code are the login; a missing pair is an authorization problem. */
  private requireShare(): { shareCode: string; receiveCode: string } {
    const shareCode = this.shareCode()
    const receiveCode = this.receiveCode()
    if (!shareCode) throw DriverError.auth('115 Share needs the share code from the share link')
    if (!receiveCode) throw DriverError.auth('115 Share needs the receive code of the share link')
    return { shareCode, receiveCode }
  }

  protected async login(force: boolean): Promise<void> {
    // A share needs no session bootstrap; only the resolved ids are worth dropping after a forced login.
    if (force) this.pathIds.clear()
  }

  private payloadError(payload: { state?: boolean; msg?: string }, fallback: string): DriverError {
    const message = payload.msg?.trim() || fallback
    if (/\u9891\u7e41|\u9650|rate|too many/i.test(message)) return DriverError.rateLimited(message)
    if (/\u8bbf\u95ee\u7801|\u5bc6\u7801|receive|forbidden|unauthor|\u767b\u5f55|\u8fc7\u671f|token/i.test(message)) return DriverError.auth(message)
    if (/\u4e0d\u5b58\u5728|not found|not exist|\u5df2\u5220\u9664|\u5931\u6548/i.test(message)) return DriverError.notFound(message)
    return DriverError.upstream(message)
  }

  private async snap(cid: string, offset: number, limit: number): Promise<{ items: Pan115Item[]; count: number }> {
    return await this.withAuth(async () => {
      const { shareCode, receiveCode } = this.requireShare()
      const url = new URL(`${API_BASE}/share/snap`)
      url.searchParams.set('share_code', shareCode)
      url.searchParams.set('receive_code', receiveCode)
      url.searchParams.set('cid', cid || '0')
      url.searchParams.set('limit', String(limit))
      url.searchParams.set('offset', String(offset))
      const payload = await this.json<Pan115Snap>(url.toString(), { headers: this.headers() })
      if (!payload.state) throw this.payloadError(payload, '115 Share could not list this folder')
      return { items: payload.data?.list ?? [], count: numberValue(payload.data?.count) }
    })
  }

  private async allChildren(cid: string): Promise<Pan115Item[]> {
    const items: Pan115Item[] = []
    let offset = 0
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.snap(cid, offset, this.pageSize())
      items.push(...result.items)
      const next = offset + result.items.length
      // `count` is the snapshot's own total; an empty page or a short read ends the walk early.
      if (result.items.length === 0 || result.count === 0 || next >= result.count) break
      offset = next
    }
    return items
  }

  private async resolveCid(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return this.rootId()
    let cid = this.rootId()
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        cid = cached
        continue
      }
      const children = await this.allChildren(cid)
      const found = children.find((item) => item.is_file === 0 && item.file_name === segment)
      const next = found?.category_id || found?.file_id || ''
      if (!next) throw DriverError.notFound(`The shared folder does not exist: ${segment}`)
      cid = next
      this.pathIds.set(prefix, cid)
    }
    return cid
  }

  private async resolveEntry(path: string): Promise<Pan115Item> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is a folder, not a file')
    const parent = driverParentPath(clean)
    const name = driverFileName(clean)
    const cid = await this.resolveCid(parent)
    const children = await this.allChildren(cid)
    const found = children.find((item) => item.file_name === name)
    if (!found) throw DriverError.notFound(`The shared item does not exist: ${name}`)
    return found
  }

  private entryOf(item: Pan115Item): DriverEntry {
    const folder = item.is_file === 0
    const name = item.file_name || 'file'
    return {
      name,
      kind: folder ? 'folder' : 'file',
      size: folder ? 0 : numberValue(item.file_size),
      modifiedAt: numberValue(item.user_utime) * 1000,
      ref: folder ? item.category_id || item.file_id || '' : item.file_id || '',
      mime: folder ? 'application/octet-stream' : driverEntryMime(name),
    }
  }

  private async downloadUrl(file: Pan115Item): Promise<string> {
    return await this.withAuth(async () => {
      const { shareCode, receiveCode } = this.requireShare()
      const fileId = file.file_id ?? ''
      if (!fileId) throw DriverError.notFound('The shared file has no file id')
      const body = new URLSearchParams({
        share_code: shareCode,
        receive_code: receiveCode,
        file_id: fileId,
      })
      const payload = await this.json<Pan115Download>(DOWNLOAD_URL_API, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      })
      if (!payload.state) throw this.payloadError(payload, '115 Share could not build a download link')
      const raw = payload.data?.url
      const url = typeof raw === 'string' ? raw : raw?.url
      if (!url) throw DriverError.upstream('115 Share returned no download address')
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
    const cid = await this.resolveCid(clean)
    const pageSize = options.pageSize
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize))
      : this.pageSize()

    if (options.page !== undefined) {
      const page = Math.max(1, options.page)
      const offset = (page - 1) * pageSize
      const result = await this.snap(cid, offset, pageSize)
      const next = offset + result.items.length
      const more = result.items.length > 0 && next < result.count
      return {
        entries: result.items.map((item) => this.entryOf(item)),
        cursor: more ? String(next) : null,
        truncated: more,
      }
    }

    const collected = await collectPages(async ({ cursor }) => {
      const offset = cursor ? Number(cursor) : 0
      const result = await this.snap(cid, Number.isFinite(offset) ? offset : 0, pageSize)
      const next = offset + result.items.length
      const more = result.items.length > 0 && next < result.count
      return { items: result.items, next: more ? String(next) : null }
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
    if (item.is_file === 0) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadUrl(item)
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      referer: REFERER,
    }
    const cookie = cookieHeader(this.credential('cookie'))
    if (cookie) headers.cookie = cookie
    if (range) headers.Range = range
    const response = await fetch(link, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    return await this.downloadResult(response, '115 Share')
  }

  async directLink(path: string): Promise<string | null> {
    const item = await this.resolveEntry(driverPath(path))
    if (item.is_file === 0) return null
    return await this.downloadUrl(item)
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('115 Share is a read-only storage')
  }

  async mkdir(_path: string): Promise<void> {
    throw DriverError.unsupported('115 Share is a read-only storage')
  }

  async rename(_path: string, _newName: string): Promise<void> {
    throw DriverError.unsupported('115 Share is a read-only storage')
  }

  async move(_fromPath: string, _toPath: string): Promise<void> {
    throw DriverError.unsupported('115 Share is a read-only storage')
  }

  async remove(_path: string): Promise<void> {
    throw DriverError.unsupported('115 Share is a read-only storage')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.snap(this.rootId(), 0, 1)
      return { ok: true, message: '115 Share is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '115 Share is unavailable' }
    }
  }
}

export function create115ShareDriver(ctx: DriverContext): MountDriver {
  return new Pan115ShareDriver(ctx)
}
