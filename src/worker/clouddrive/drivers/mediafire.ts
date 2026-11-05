/**
 * MediaFire driver.
 *
 * MediaFire authenticates with a login cookie: the cookie is exchanged once for a `session_token`
 * that every API call carries in its form body. Folder listings page by `chunk`, which this driver
 * exposes as the mount page. Downloads are two-step (ask `file/get_links.php` for a direct URL, then
 * stream against it), so `directLink` returns that URL.
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

const API = 'https://www.mediafire.com/api/1.5'
const HOST = 'https://www.mediafire.com'
const SESSION_URL = `${HOST}/application/get_session_token.php`
const PAGE_SIZE = 200
const MAX_LIST_PAGES = 50

interface MediaFireEntry {
  id: string
  name: string
  size: number
  isDir: boolean
  created: string
}

interface MediaFireFolderContent {
  folders?: { folderkey: string; name: string; created: string }[]
  files?: { quickkey: string; filename: string; size: string; created: string }[]
  more_chunks?: string
}

interface MediaFireResponse {
  response?: {
    result?: string
    folder_content?: MediaFireFolderContent
    links?: { direct_download?: string; normal_download?: string }[]
    session_token?: string
    message?: string
  }
}

function entryOf(entry: MediaFireEntry): DriverEntry {
  return {
    name: entry.name,
    kind: entry.isDir ? 'folder' : 'file',
    size: entry.size,
    modifiedAt: entry.created ? Date.parse(entry.created) : 0,
    ref: entry.id,
    mime: entry.isDir ? 'application/octet-stream' : driverEntryMime(entry.name),
  }
}

export class MediaFireDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('mediafire')!
  readonly capabilities = this.definition.capabilities
  private readonly chunkSize: number
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.chunkSize = Math.max(1, Number(ctx.config.chunkSize) || PAGE_SIZE)
  }

  protected async login(force: boolean): Promise<void> {
    const existing = String(this.ctx.credentials.sessionToken ?? '')
    if (!force && existing) return
    const cookie = String(this.ctx.credentials.cookie ?? '')
    if (!cookie) throw DriverError.auth('MediaFire needs a login cookie or a stored session token')
    try {
      const response = await this.request(SESSION_URL, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: HOST,
          Referer: `${HOST}/`,
          'Content-Length': '0',
        },
      })
      const payload = await response.json().catch(() => null) as MediaFireResponse | null
      const token = payload?.response?.session_token
      if (!token) throw DriverError.auth('MediaFire did not return a session token from the cookie')
      await this.saveCredential({ sessionToken: token })
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') await this.ctx.markNeedsReauth(error.message)
      throw error
    }
  }

  private cookieHeader(): Record<string, string> {
    const cookie = String(this.ctx.credentials.cookie ?? '')
    return cookie ? { Cookie: cookie } : {}
  }

  private async post<T>(endpoint: string, data: Record<string, string>): Promise<T> {
    const form = new URLSearchParams({
      session_token: String(this.ctx.credentials.sessionToken ?? ''),
      response_format: 'json',
      ...data,
    })
    const response = await this.request(`${API}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Origin: HOST,
        Referer: `${HOST}/`,
        ...this.cookieHeader(),
      },
      body: form.toString(),
    })
    try {
      return await response.json() as T
    } catch {
      throw DriverError.upstream('MediaFire returned an unexpected body')
    }
  }

  private checkResult(result?: string): void {
    if (!result || result === 'Success') return
    const lower = result.toLowerCase()
    if (lower.includes('session') || lower.includes('token') || lower.includes('cookie')) {
      throw DriverError.auth(`MediaFire rejected the session: ${result}`)
    }
    throw DriverError.upstream(`MediaFire API error: ${result}`)
  }

  private async chunk(folderKey: string, chunkNumber: number, pageSize: number): Promise<{ items: MediaFireEntry[]; next: string | null }> {
    const shared: Record<string, string> = {
      folder_key: folderKey,
      chunk: String(chunkNumber),
      chunk_size: String(pageSize),
      details: 'yes',
      order_by: 'name',
      order_direction: 'asc',
      filter: '',
    }
    const foldersPayload = await this.post<MediaFireResponse>('/folder/get_content.php', {
      ...shared,
      content_type: 'folders',
    })
    this.checkResult(foldersPayload.response?.result)
    const filesPayload = await this.post<MediaFireResponse>('/folder/get_content.php', {
      ...shared,
      content_type: 'files',
    })
    this.checkResult(filesPayload.response?.result)

    const folders = foldersPayload.response?.folder_content
    const files = filesPayload.response?.folder_content
    const items: MediaFireEntry[] = [
      ...(folders?.folders ?? []).map((folder) => ({
        id: folder.folderkey,
        name: folder.name,
        size: 0,
        isDir: true,
        created: folder.created,
      })),
      ...(files?.files ?? []).map((file) => ({
        id: file.quickkey,
        name: file.filename,
        size: Number(file.size) || 0,
        isDir: false,
        created: file.created,
      })),
    ]
    const more = folders?.more_chunks === 'yes' || files?.more_chunks === 'yes'
    return { items, next: more ? String(chunkNumber + 1) : null }
  }

  private async collectFolder(folderKey: string): Promise<MediaFireEntry[]> {
    const collected = await collectPages(async ({ page }) => await this.chunk(folderKey, page, this.chunkSize), {
      maxPages: MAX_LIST_PAGES,
    })
    return collected.items
  }

  /** Walks the path segments, listing each parent folder until the child is found. */
  private async resolveFolder(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return ''
    const segments = clean.split('/').filter(Boolean)
    let current = ''
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        current = cached
        continue
      }
      const entries = await this.collectFolder(current)
      const folder = entries.find((entry) => entry.isDir && entry.name === segment)
      if (!folder) throw DriverError.notFound(`MediaFire folder not found: ${segment}`)
      current = folder.id
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveEntry(path: string): Promise<MediaFireEntry> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentKey = await this.resolveFolder(driverParentPath(clean))
    const name = driverFileName(clean)
    const entries = await this.collectFolder(parentKey)
    const entry = entries.find((candidate) => candidate.name === name)
    if (!entry) throw DriverError.notFound(`MediaFire item not found: ${clean}`)
    return entry
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const folderKey = await this.resolveFolder(clean)
      const pageSize = Math.max(1, options.pageSize ?? this.chunkSize)
      if (options.page !== undefined) {
        const result = await this.chunk(folderKey, Math.max(1, options.page), pageSize)
        return { entries: result.items.map(entryOf), cursor: result.next, truncated: result.next !== null }
      }
      const collected = await collectPages(async ({ page }) => await this.chunk(folderKey, page, pageSize), {
        maxPages: MAX_LIST_PAGES,
      })
      let entries = collected.items.map(entryOf)
      if (options.search) {
        const needle = options.search.toLowerCase()
        entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      }
      return { entries, cursor: null, truncated: collected.truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '' }
    return await this.withAuth(async () => entryOf(await this.resolveEntry(clean)))
  }

  private async downloadUrl(quickKey: string): Promise<string> {
    const payload = await this.post<MediaFireResponse>('/file/get_links.php', {
      quick_key: quickKey,
      link_type: 'direct_download',
    })
    this.checkResult(payload.response?.result)
    const link = payload.response?.links?.[0]
    const url = link?.direct_download || link?.normal_download
    if (!url) throw DriverError.notFound('MediaFire returned no download link')
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const entry = await this.resolveEntry(clean)
      if (entry.isDir) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = await this.downloadUrl(entry.id)
      const response = await fetch(url, {
        headers: range ? { Range: range } : {},
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`MediaFire download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const entry = await this.resolveEntry(clean)
      if (entry.isDir) return null
      return await this.downloadUrl(entry.id)
    })
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('MediaFire is read only')
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('MediaFire is read only')
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('MediaFire is read only')
  }

  async move(fromPath: string, _toPath: string): Promise<void> {
    driverPath(fromPath)
    throw DriverError.unsupported('MediaFire is read only')
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('MediaFire is read only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      return { ok: true, message: 'MediaFire is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'MediaFire is unavailable' }
    }
  }
}

export function createMediaFireDriver(ctx: DriverContext): MountDriver {
  return new MediaFireDriver(ctx)
}
