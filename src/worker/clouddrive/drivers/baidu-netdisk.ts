/**
 * Baidu Netdisk driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/baidu_netdisk`.
 * The account is read-only: listing uses the web folder endpoint, a download is resolved from
 * `filemetas` and either follows the official redirect or uses the third-party dlink. Every path is
 * mapped to the account root; Baidu has no path lookup, so a stat walks the parent listing.
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
import { OAuthSession } from './token'

const PAN_API = 'https://pan.baidu.com'
const LIST_API = `${PAN_API}/api/list`
const FILE_METAS_API = `${PAN_API}/rest/2.0/xpan/multimedia`
const CRACK_FILE_METAS_API = `${PAN_API}/api/filemetas`
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50
const DEFAULT_CRACK_UA = 'netdisk'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

/** errno values that mean the access token is missing, expired or refused. */
const TOKEN_ERRORS = new Set([-6, 111, 31066, 20016])

interface BaiduFile {
  fs_id?: number
  path?: string
  server_filename?: string
  filename?: string
  size?: number
  isdir?: number
  server_ctime?: number
  server_mtime?: number
  ctime?: number
  mtime?: number
  category?: number
}

interface BaiduListBody {
  errno?: number
  errmsg?: string
  list?: BaiduFile[]
}

interface BaiduDownloadBody {
  errno?: number
  errmsg?: string
  /** `filemetas` answers under `list`, the third-party endpoint under `info`. */
  list?: Array<{ dlink?: string }>
  info?: Array<{ dlink?: string }>
}

function basename(path: string | undefined): string {
  const value = String(path ?? '')
  return value.slice(value.lastIndexOf('/') + 1)
}

function decodedName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function entryOf(file: BaiduFile, fallbackName = ''): DriverEntry {
  const name = file.server_filename || file.filename || fallbackName || basename(file.path)
  const folder = file.isdir === 1
  const seconds = Number(file.server_mtime || file.mtime || file.server_ctime || file.ctime) || 0
  return {
    name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: seconds > 0 ? seconds * 1000 : 0,
    ref: file.fs_id === undefined ? undefined : String(file.fs_id),
    mime: folder ? 'application/octet-stream' : driverEntryMime(name),
  }
}

/** The dlink is forwarded without the bearer token; the resolved address is already signed. */
function sanitizeDlink(dlink: string): string {
  if (!dlink) return dlink
  try {
    const url = new URL(dlink)
    url.searchParams.delete('access_token')
    return url.toString()
  } catch {
    return dlink
  }
}

export class BaiduNetdiskDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('baidu_netdisk')!
  readonly capabilities = this.definition.capabilities
  private readonly session = new OAuthSession(this.ctx, 'baidu_netdisk')
  private readonly downloadApi: string

  constructor(ctx: DriverContext) {
    super(ctx)
    this.downloadApi = this.configText('downloadApi', 'official') || 'official'
  }

  protected async login(force: boolean): Promise<void> {
    await this.session.token(force)
  }

  private async api<T extends { errno?: number }>(
    url: string,
    params: Record<string, string>,
  ): Promise<T> {
    return await this.session.withToken(async (token) => {
      const target = new URL(url)
      target.searchParams.set('access_token', token)
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
      const response = await this.request(target.toString(), {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      })
      const text = await response.text()
      let payload: T
      try {
        payload = JSON.parse(text) as T
      } catch {
        throw DriverError.upstream('Baidu Netdisk returned an unexpected body')
      }
      const errno = Number(payload.errno) || 0
      if (TOKEN_ERRORS.has(errno)) {
        throw DriverError.auth(`Baidu Netdisk refused the access token (errno ${errno})`)
      }
      if (errno !== 0) throw DriverError.upstream(`Baidu Netdisk answered errno ${errno}`)
      return payload
    })
  }

  private async listPage(
    dir: string,
    start: number,
    limit: number,
  ): Promise<{ items: BaiduFile[]; next: string | null }> {
    const params: Record<string, string> = {
      dir,
      start: String(start),
      limit: String(limit),
      web: '1',
    }
    if (dir === '/') params.root = '1'
    const payload = await this.api<BaiduListBody>(LIST_API, params)
    const items = payload.list ?? []
    return {
      items,
      next: items.length >= limit ? String(start + items.length) : null,
    }
  }

  private async listAll(dir: string): Promise<BaiduFile[]> {
    const collected = await collectPages(async ({ cursor }) => {
      const start = cursor ? Number(cursor) || 0 : 0
      return await this.listPage(dir, start, PAGE_SIZE)
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    return collected.items
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE)
    const needle = options.search?.toLowerCase()
    if (options.page !== undefined) {
      const page = Math.max(1, options.page)
      const result = await this.listPage(clean, (page - 1) * pageSize, pageSize)
      let entries = result.items.map((file) => entryOf(file))
      if (needle) entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      return { entries, cursor: result.next, truncated: result.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const start = cursor ? Number(cursor) || 0 : 0
      return await this.listPage(clean, start, pageSize)
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    let entries = collected.items.map((file) => entryOf(file))
    if (needle) entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    return { entries, cursor: null, truncated: collected.truncated }
  }

  /** Baidu has no path lookup, so the parent listing decides whether the path exists. */
  private async resolve(clean: string): Promise<BaiduFile> {
    if (clean === '/') return { path: '/', server_filename: 'root', isdir: 1, size: 0 }
    const parent = driverParentPath(clean)
    const name = driverFileName(clean)
    const files = await this.listAll(parent)
    const found = files.find((file) =>
      file.path === clean
      || file.server_filename === name
      || file.server_filename === decodedName(name),
    )
    if (!found) throw DriverError.notFound(`Baidu Netdisk could not resolve ${clean}`)
    return found
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const file = await this.resolve(clean)
    return entryOf(file, clean === '/' ? 'root' : driverFileName(clean))
  }

  private async downloadDlink(clean: string, file: BaiduFile): Promise<{ url: string; headers: Record<string, string> }> {
    if (this.downloadApi === 'crack') {
      const payload = await this.api<BaiduDownloadBody>(CRACK_FILE_METAS_API, {
        target: JSON.stringify([clean]),
        dlink: '1',
        web: '5',
        origin: 'dlna',
      })
      const dlink = payload.info?.[0]?.dlink
      if (!dlink) throw DriverError.notFound(`Baidu Netdisk returned no dlink for ${clean}`)
      return {
        url: sanitizeDlink(dlink),
        headers: { 'User-Agent': this.configText('customCrackUa', DEFAULT_CRACK_UA) || DEFAULT_CRACK_UA },
      }
    }
    if (file.fs_id === undefined) throw DriverError.notFound(`Baidu Netdisk returned no fs_id for ${clean}`)
    const payload = await this.api<BaiduDownloadBody>(FILE_METAS_API, {
      method: 'filemetas',
      fsids: JSON.stringify([file.fs_id]),
      dlink: '1',
    })
    const dlink = payload.list?.[0]?.dlink
    if (!dlink) throw DriverError.notFound(`Baidu Netdisk returned no dlink for ${clean}`)
    return { url: dlink, headers: { 'User-Agent': 'pan.baidu.com' } }
  }

  private withToken(url: string, token: string): string {
    const target = new URL(url)
    target.searchParams.set('access_token', token)
    return target.toString()
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const file = await this.resolve(clean)
    if (file.isdir === 1) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadDlink(clean, file)
    const url = this.downloadApi === 'crack'
      ? link.url
      : this.withToken(link.url, await this.session.token())
    const response = await fetch(url, {
      headers: { ...link.headers, ...(range ? { Range: range } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined)
      const message = `Baidu Netdisk refused the download (HTTP ${response.status})`
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.notFound('The upstream download address was not found')
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined)
      const retry = Number(response.headers.get('retry-after'))
      throw DriverError.rateLimited(
        'Baidu Netdisk is rate limiting the download',
        Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
      )
    }
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`Baidu Netdisk download failed (HTTP ${response.status})`)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    const file = await this.resolve(clean)
    if (file.isdir === 1) return null
    const link = await this.downloadDlink(clean, file)
    if (this.downloadApi === 'crack') return link.url || null
    const response = await fetch(this.withToken(link.url, await this.session.token()), {
      method: 'HEAD',
      redirect: 'manual',
      headers: link.headers,
      signal: AbortSignal.timeout(20_000),
    })
    const location = response.headers.get('location') || link.url
    return sanitizeDlink(location) || null
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported()
  }

  async mkdir(_path: string): Promise<void> {
    throw DriverError.unsupported()
  }

  async rename(_path: string, _newName: string): Promise<void> {
    throw DriverError.unsupported()
  }

  async move(_fromPath: string, _toPath: string): Promise<void> {
    throw DriverError.unsupported()
  }

  async remove(_path: string): Promise<void> {
    throw DriverError.unsupported()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.list('/', { page: 1, pageSize: 1 })
      return { ok: true, message: 'Baidu Netdisk is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Baidu Netdisk is unavailable' }
    }
  }
}

export function createBaiduNetdiskDriver(ctx: DriverContext): MountDriver {
  return new BaiduNetdiskDriver(ctx)
}
