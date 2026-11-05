/**
 * OneDrive / SharePoint driver.
 *
 * Graph addresses items by id, and it also accepts a colon path (`root:/docs/a.txt`), which is what
 * this driver uses to resolve a mount path without walking every ancestor. Downloads come from the
 * short-lived `@microsoft.graph.downloadUrl` Graph returns with the item; uploads use the resumable
 * session for anything larger than the simple 4 MiB PUT.
 *
 * The `region` config selects the sovereign cloud host pair (global/cn/us/de): the same region is
 * used for Graph calls and for token rotation. A SharePoint mount uses `/sites/{siteId}/drive`
 * instead of `/me/drive` or `/drives/{driveId}`.
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
  driverChildPath,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'
import { oauthProvider } from './oauth'
import { OAuthSession } from './token'

/** The sovereign-cloud host pairs from the reference implementation's `onedriveHostMap`. */
const ONEDRIVE_HOSTS: Readonly<Record<string, { oauth: string; api: string }>> = {
  global: { oauth: 'https://login.microsoftonline.com', api: 'https://graph.microsoft.com' },
  cn: { oauth: 'https://login.partner.microsoftonline.cn', api: 'https://microsoftgraph.chinacloudapi.cn' },
  us: { oauth: 'https://login.microsoftonline.us', api: 'https://graph.microsoft.us' },
  de: { oauth: 'https://login.microsoftonline.de', api: 'https://graph.microsoft.de' },
}

const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024
const UPLOAD_CHUNK = 10 * 1024 * 1024
const PAGE_SIZE = 200
const MAX_LIST_PAGES = 40

interface GraphItem {
  id: string
  name: string
  size?: number
  folder?: Record<string, unknown>
  file?: { mimeType?: string }
  lastModifiedDateTime?: string
  parentReference?: { id?: string; driveId?: string }
  '@microsoft.graph.downloadUrl'?: string
}

interface GraphList {
  value: GraphItem[]
  '@odata.nextLink'?: string
}

function itemEntry(item: GraphItem): DriverEntry {
  const folder = Boolean(item.folder)
  return {
    name: item.name,
    kind: folder ? 'folder' : 'file',
    size: Number(item.size) || 0,
    modifiedAt: item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : 0,
    ref: item.id,
    mime: folder ? 'application/octet-stream' : (item.file?.mimeType || driverEntryMime(item.name)),
  }
}

function encodedPath(path: string): string {
  return path.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/')
}

function configBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  return Boolean(value)
}

function regionHosts(config: Record<string, unknown>): { oauth: string; api: string } {
  const region = String(config.region ?? '').trim().toLowerCase() || 'global'
  return ONEDRIVE_HOSTS[region] ?? ONEDRIVE_HOSTS.global
}

export class OneDriveDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('onedrive')!
  readonly capabilities = this.definition.capabilities
  private readonly session: OAuthSession
  private readonly base: string

  constructor(ctx: DriverContext, options: { definitionId?: string; base?: string; session?: OAuthSession } = {}) {
    super(ctx)
    const hosts = regionHosts(ctx.config)
    const graph = `${hosts.api}/v1.0`
    const driveId = String(ctx.config.driveId ?? '').trim()
    const sharepoint = configBool(ctx.config.isSharepoint)
    const siteId = String(ctx.config.siteId ?? '').trim()
    if (options.base) {
      this.base = options.base
    } else if (sharepoint) {
      if (!siteId) throw DriverError.auth('A SharePoint mount needs a site id')
      this.base = `${graph}/sites/${encodeURIComponent(siteId)}/drive`
    } else {
      this.base = driveId ? `${graph}/drives/${driveId}` : `${graph}/me/drive`
    }
    const provider = oauthProvider('onedrive')
    this.session = options.session ?? new OAuthSession(ctx, 'onedrive', {
      // The authorization callback still starts from the global Microsoft endpoint; only token
      // rotation follows the selected sovereign cloud.
      provider: provider ? { ...provider, tokenUrl: `${hosts.oauth}/common/oauth2/v2.0/token` } : undefined,
    })
    if (options.definitionId) {
      const definition = findCloudDriveDriver(options.definitionId)
      if (definition) Object.assign(this, { definition })
    }
  }

  protected async login(force: boolean): Promise<void> {
    await this.session.token(force)
    const probe = await this.api<GraphItem>(`${this.base}/root?$select=id,name`)
    if (!probe.id) throw DriverError.auth('OneDrive did not return the drive root')
  }

  private async api<T>(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    return await this.session.withToken(async (token) => {
      const response = await this.request(url, {
        method: (init.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers ?? {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
      if (response.status === 204) return undefined as T
      return await response.json() as T
    })
  }

  private itemUrl(path: string): string {
    if (path === '/') return `${this.base}/root`
    return `${this.base}/root:/${encodedPath(path)}`
  }

  private childrenUrl(path: string): string {
    return path === '/' ? `${this.base}/root/children` : `${this.itemUrl(path)}:/children`
  }

  private async itemInfo(path: string, select = 'id,name,size,folder,file,lastModifiedDateTime,parentReference'): Promise<GraphItem> {
    const clean = driverPath(path)
    if (clean === '/') {
      return await this.api<GraphItem>(`${this.base}/root?$select=${encodeURIComponent(select)}`)
    }
    return await this.api<GraphItem>(`${this.itemUrl(clean)}?$select=${encodeURIComponent(select)}`)
  }

  private async itemId(path: string): Promise<string> {
    const item = await this.itemInfo(path, 'id')
    if (!item.id) throw DriverError.notFound(`OneDrive could not resolve ${path}`)
    return item.id
  }

  private async page(path: string, pageNumber: number, pageSize: number): Promise<{ items: GraphItem[]; next: string | null }> {
    let pageUrl: string | null = `${this.childrenUrl(path)}?$top=${Math.min(PAGE_SIZE, Math.max(1, pageSize))}`
    let current = 1
    while (pageUrl !== null) {
      const payload: GraphList = await this.api<GraphList>(pageUrl)
      if (current === pageNumber) return { items: payload.value ?? [], next: payload['@odata.nextLink'] ?? null }
      pageUrl = payload['@odata.nextLink'] ?? null
      current++
      if (current > MAX_LIST_PAGES) break
    }
    return { items: [], next: null }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    if (options.page !== undefined) {
      const result = await this.page(clean, Math.max(1, options.page), options.pageSize ?? PAGE_SIZE)
      return { entries: result.items.map(itemEntry), cursor: result.next, truncated: result.next !== null }
    }
    const collected = await collectPages(async ({ page: pageNumber }) => {
      const result = await this.page(clean, pageNumber, options.pageSize ?? PAGE_SIZE)
      return { items: result.items, next: result.next }
    }, { maxPages: MAX_LIST_PAGES })
    const entries = collected.items.map(itemEntry)
    if (options.search) {
      // Graph's search endpoint is drive-wide; a folder listing has no upstream filter, so the
      // search runs over the pages this call already fetched.
      const needle = options.search.toLowerCase()
      return {
        entries: entries.filter((entry) => entry.name.toLowerCase().includes(needle)),
        cursor: null,
        truncated: collected.truncated,
      }
    }
    return { entries, cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const item = await this.itemInfo(clean)
    if (!item.id) throw DriverError.notFound(`OneDrive could not resolve ${path}`)
    return itemEntry({ ...item, name: clean === '/' ? 'root' : (item.name || driverFileName(clean)) })
  }

  private async downloadUrl(path: string): Promise<string> {
    const item = await this.itemInfo(path, 'id,name,@microsoft.graph.downloadUrl')
    const url = item['@microsoft.graph.downloadUrl']
    if (!url) throw DriverError.notFound(`OneDrive returned no download address for ${path}`)
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const url = await this.downloadUrl(clean)
    const response = await fetch(url, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`OneDrive download failed (HTTP ${response.status})`)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') return null
    return await this.downloadUrl(driverPath(path))
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const clean = driverPath(path)
    const name = driverFileName(clean)
    const parentId = await this.itemId(driverParentPath(clean))
    if (bytes.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      await this.session.withToken(async (token) => {
        const response = await this.request(`${this.base}/items/${parentId}/children/${encodeURIComponent(name)}/content`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': options.contentType ?? 'application/octet-stream' },
          body: bytes,
        })
        await response.body?.cancel().catch(() => undefined)
      })
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    const session = await this.api<{ uploadUrl: string }>(
      `${this.base}/items/${parentId}/children/${encodeURIComponent(name)}/createUploadSession`,
      { method: 'POST', body: { item: { '@microsoft.graph.conflictBehavior': 'rename' } } },
    )
    if (!session.uploadUrl) throw DriverError.upstream('OneDrive returned no upload session')
    const total = bytes.byteLength
    let offset = 0
    while (offset < total) {
      const end = Math.min(offset + UPLOAD_CHUNK, total) - 1
      const chunk = bytes.subarray(offset, end + 1)
      const response = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.byteLength),
          'Content-Range': `bytes ${offset}-${end}/${total}`,
        },
        body: chunk,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`OneDrive rejected upload bytes ${offset}-${end} (HTTP ${response.status})`)
      }
      await response.body?.cancel().catch(() => undefined)
      offset = end + 1
      options.onProgress?.(offset, total)
    }
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.itemId(driverParentPath(clean))
    await this.api(`${this.base}/items/${parentId}/children`, {
      method: 'POST',
      body: { name: driverFileName(clean), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const id = await this.itemId(clean)
    await this.api(`${this.base}/items/${id}`, { method: 'PATCH', body: { name: newName } })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const id = await this.itemId(from)
    const parentId = await this.itemId(driverParentPath(to))
    const body: Record<string, unknown> = { parentReference: { id: parentId } }
    if (driverFileName(to) !== driverFileName(from)) body.name = driverFileName(to)
    await this.api(`${this.base}/items/${id}`, { method: 'PATCH', body })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const id = await this.itemId(from)
    const parentId = await this.itemId(driverParentPath(to))
    const response = await this.session.withToken(async (token) => {
      const request = await this.request(`${this.base}/items/${id}/copy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentReference: { id: parentId }, name: driverFileName(to) }),
      })
      await request.body?.cancel().catch(() => undefined)
      return request
    })
    const monitor = response.headers.get('location')
    if (!monitor) return
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const status = await fetch(monitor, { signal: AbortSignal.timeout(10_000) })
      await status.body?.cancel().catch(() => undefined)
      if (status.ok) return
      if (status.status !== 202) throw DriverError.upstream(`OneDrive copy monitor answered HTTP ${status.status}`)
    }
  }

  async remove(path: string): Promise<void> {
    const id = await this.itemId(driverPath(path))
    const response = await this.session.withToken(async (token) => await this.request(`${this.base}/items/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }))
    await response.body?.cancel().catch(() => undefined)
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const info = await this.api<{ id?: string; name?: string }>(`${this.base}/root?$select=id,name`)
      return { ok: true, message: `OneDrive is reachable${info.name ? ` · ${info.name}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'OneDrive is unavailable' }
    }
  }
}

export function createOneDriveDriver(ctx: DriverContext): MountDriver {
  return new OneDriveDriver(ctx)
}

/** The child path helper stays exported so the application-identity variant can reuse it. */
export { driverChildPath }
