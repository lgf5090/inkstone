/**
 * CloudFlare-ImgBed driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/cloudflare_imgbed`: uploads go through
 * `POST /upload` (channel + folder query, Bearer) and the public link is `/file/<id>`; the manage
 * list endpoint (`/api/manage/list?dir=&start=&count=`) is the only way to learn what a directory
 * holds, so `stat` resolves the parent listing instead of assuming every path is a file.
 */
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
} from './http'

const PAGE_SIZE = 1000
const MAX_PAGES = 50
const LARGE_CHANNEL_THRESHOLD = 20 * 1024 * 1024

interface ImgBedFile {
  name?: string
  metadata?: Record<string, unknown>
}

interface ImgBedList {
  files?: ImgBedFile[]
  directories?: string[]
  totalCount?: number
  returnedCount?: number
  error?: string
  message?: string
}

interface ImgBedUpload {
  src?: string
  publicUrl?: string
}

interface ImgBedDelete {
  success?: boolean
  deleted?: string[]
  failed?: string[]
  error?: string
  message?: string
}

function encodePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function metadataNumber(metadata: Record<string, unknown> | undefined, keys: readonly string[]): number {
  if (!metadata) return 0
  for (const key of keys) {
    const value = metadata[key]
    if (value === undefined || value === null) continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function metadataTimestamp(metadata: Record<string, unknown> | undefined): number {
  const value = metadataNumber(metadata, ['TimeStamp', 'timestamp', 'modified', 'Modified'])
  if (value <= 0) return 0
  return value < 1e12 ? value * 1000 : value
}

function statusError(status: number): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`The image bed refused the credentials (HTTP ${status})`)
  if (status === 404) return DriverError.notFound('Not found upstream (HTTP 404)')
  if (status === 429) return DriverError.rateLimited('The image bed is rate limiting requests')
  return DriverError.upstream(`The image bed answered HTTP ${status}`)
}

class CloudflareImgbedDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('cloudflare_imgbed')!
  readonly capabilities = this.definition.capabilities
  private token = ''
  private publicBase = ''

  private address(): string {
    return this.configText('address').trim().replace(/\/+$/, '')
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` }
  }

  private rootPath(): string {
    return driverPath(this.configText('rootFolderPath', '/') || '/')
  }

  /** The user path mapped into the image bed's own folder tree. */
  private upstreamPath(path: string): string {
    const clean = driverPath(path)
    const root = this.rootPath()
    if (clean === '/') return root
    return root === '/' ? clean : `${root}${clean}`
  }

  private listUrl(dir: string, start: number, size: number, search: string): string {
    const query = new URLSearchParams({ dir, start: String(start), count: String(size) })
    if (search) query.set('search', search)
    return `${this.address()}/api/manage/list?${query.toString()}`
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.token) return
    if (!this.address()) throw DriverError.invalid('CloudFlare-ImgBed needs the service address')
    const token = (this.ctx.credentials.token ?? '').trim()
    if (!token) throw DriverError.auth('CloudFlare-ImgBed needs an API token')
    this.token = token
  }

  private async listPage(dir: string, start: number, size: number, search = ''): Promise<ImgBedList> {
    const payload = await this.withAuth(() => this.json<ImgBedList>(this.listUrl(dir, start, size, search), {
      headers: this.authHeaders(),
    }))
    if (payload.error || payload.message) {
      throw DriverError.upstream(payload.error || payload.message || 'The image bed rejected the listing')
    }
    return payload
  }

  private entriesOf(payload: ImgBedList): DriverEntry[] {
    const entries: DriverEntry[] = []
    const dirSeen = new Set<string>()
    const fileSeen = new Set<string>()
    for (const raw of payload.directories ?? []) {
      const clean = `/${raw.replace(/^\/+|\/+$/g, '')}`
      if (clean === '/' || dirSeen.has(clean)) continue
      dirSeen.add(clean)
      entries.push({
        name: driverFileName(clean),
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
        ref: clean,
        mime: 'application/octet-stream',
      })
    }
    for (const file of payload.files ?? []) {
      const name = file.name ?? ''
      const fileName = driverFileName(`/${name.replace(/^\/+/, '')}`)
      if (!fileName || fileSeen.has(fileName)) continue
      fileSeen.add(fileName)
      entries.push({
        name: fileName,
        kind: 'file',
        size: metadataNumber(file.metadata, ['FileSizeBytes', 'File-Size', 'fileSize', 'size']),
        modifiedAt: metadataTimestamp(file.metadata),
        ref: name,
        mime: driverEntryMime(fileName),
      })
    }
    return entries
  }

  private async walkDirectory(dir: string, search = ''): Promise<{ entries: DriverEntry[]; truncated: boolean }> {
    const collected = await collectPages(async ({ page }) => {
      const start = (page - 1) * PAGE_SIZE
      const payload = await this.listPage(dir, start, PAGE_SIZE, search)
      const returned = (payload.directories?.length ?? 0) + (payload.files?.length ?? 0)
      return { items: this.entriesOf(payload), next: returned >= PAGE_SIZE ? String(start + PAGE_SIZE) : null }
    }, { maxPages: MAX_PAGES })
    return { entries: collected.items, truncated: collected.truncated }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const dir = this.upstreamPath(path)
    const pageSize = Math.min(PAGE_SIZE, Math.max(1, options.pageSize ?? PAGE_SIZE))
    if (options.page !== undefined) {
      const start = (Math.max(1, options.page) - 1) * pageSize
      const payload = await this.listPage(dir, start, pageSize, options.search ?? '')
      const returned = (payload.directories?.length ?? 0) + (payload.files?.length ?? 0)
      return {
        entries: this.entriesOf(payload),
        cursor: returned >= pageSize ? String(start + pageSize) : null,
        truncated: returned >= pageSize,
      }
    }
    const walked = await this.walkDirectory(dir, options.search ?? '')
    return { entries: walked.entries, cursor: null, truncated: walked.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const upstream = this.upstreamPath(clean)
    if (clean === '/') {
      return { name: '/', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootPath(), mime: 'application/octet-stream' }
    }
    const name = driverFileName(clean)
    const parent = driverParentPath(upstream)
    const walked = await this.walkDirectory(parent)
    const found = walked.entries.find((entry) => entry.name === name)
    if (!found) throw DriverError.notFound(`Not found: ${name}`)
    return found
  }

  private publicLink(upstream: string): string {
    const base = this.publicBase || `${this.address()}/file`
    return `${base}${encodePath(upstream)}`
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const link = this.publicLink(this.upstreamPath(path))
    const response = await fetch(link, {
      method: 'GET',
      redirect: 'follow',
      headers: range ? { Range: range } : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw statusError(response.status)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') return null
    return this.publicLink(this.upstreamPath(path))
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const upstream = this.upstreamPath(clean)
    const fileName = driverFileName(clean)
    if (!fileName) throw DriverError.invalid('A file name is required')
    const small = this.configText('smallChannelName').trim()
    if (!small) throw DriverError.invalid('CloudFlare-ImgBed needs a small channel name')
    const large = this.configText('largeChannelName').trim()
    const channel = large && options.size >= LARGE_CHANNEL_THRESHOLD ? large : small
    const query = new URLSearchParams({
      returnFormat: 'default',
      channelName: channel,
      uploadFolder: driverParentPath(upstream),
      autoRetry: 'true',
    })
    const form = new FormData()
    form.append('file', new Blob([bytes.slice()], { type: options.contentType || 'application/octet-stream' }), fileName)
    const response = await this.withAuth(() => this.request(`${this.address()}/upload?${query.toString()}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
      timeoutMs: 60_000,
    }))
    const payload = await response.json().catch(() => null) as ImgBedUpload[] | null
    const item = Array.isArray(payload) ? payload[0] : null
    if (!item?.src) throw DriverError.upstream('The image bed returned no file address')
    if (item.publicUrl) this.learnPublicBase(item.publicUrl, upstream)
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  private learnPublicBase(publicUrl: string, upstream: string): void {
    try {
      const parsed = new URL(publicUrl)
      const encodedPath = encodePath(upstream)
      const encodedName = encodePath(`/${driverFileName(upstream)}`)
      const pathname = parsed.pathname
      let basePath = ''
      if (pathname.endsWith(encodedPath)) basePath = pathname.slice(0, pathname.length - encodedPath.length)
      else if (pathname.endsWith(encodedName)) basePath = pathname.slice(0, pathname.length - encodedName.length)
      else basePath = pathname
      this.publicBase = `${parsed.origin}${basePath.replace(/\/+$/, '')}`
    } catch {
      // A malformed publicUrl keeps the default address-based link.
    }
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('CloudFlare-ImgBed creates folders implicitly on upload')
  }

  async rename(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('CloudFlare-ImgBed does not support renaming')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('CloudFlare-ImgBed does not support moving files')
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The root cannot be deleted')
    const entry = await this.stat(clean)
    const upstream = this.upstreamPath(clean)
    const folder = entry.kind === 'folder'
    const response = await this.withAuth(() => this.request(
      `${this.address()}/api/manage/delete${encodePath(upstream)}?folder=${folder}`,
      { method: 'POST', headers: this.authHeaders() },
    ))
    const payload = await response.json().catch(() => ({})) as ImgBedDelete
    if (payload.error || payload.message) {
      throw DriverError.upstream(payload.error || payload.message || 'The image bed rejected the delete')
    }
    if (payload.success === false || (payload.failed?.length ?? 0) > 0) {
      throw DriverError.upstream(`The image bed could not delete ${clean}`)
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.listPage(this.rootPath(), 0, 1)
      return { ok: true, message: `CloudFlare-ImgBed is reachable at ${this.address()}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'CloudFlare-ImgBed is unavailable' }
    }
  }
}

export function createCloudflareImgbedDriver(ctx: DriverContext): MountDriver {
  return new CloudflareImgbedDriver(ctx)
}
