/**
 * OpenList share driver: read-only mount of an OpenList share link.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/openlist_share`: the share root is addressed as
 * `/@s/{sid}` and the download link is `/sd/{sid}{path}?pwd=…`. The share is read-only, so no write
 * method exists at all.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type MountDriver,
} from './contract'
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const DEFAULT_PAGE_SIZE = 100
const MAX_LIST_PAGES = 50

interface ShareFile {
  name: string
  size?: number
  is_dir?: boolean
  modified?: string
  sign?: string
  thumb?: string
}

interface ShareListData {
  content?: ShareFile[]
  total?: number
}

interface ShareResponse<T> {
  code?: number
  message?: string
  data?: T
}

function fileEntry(file: ShareFile): DriverEntry {
  const folder = Boolean(file.is_dir)
  return {
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: Date.parse(file.modified ?? '') || 0,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.name),
  }
}

class OpenListShareDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('openlist_share')!
  readonly capabilities = this.definition.capabilities

  private baseUrl(): string {
    const raw = this.configText('url').trim()
    if (!raw) throw DriverError.invalid('OpenList share needs the URL of the instance')
    return raw.replace(/\/+$/, '')
  }

  private sid(): string {
    const raw = this.configText('sid').trim()
    if (!raw) throw DriverError.invalid('OpenList share needs a share id')
    return raw
  }

  private pwd(): string {
    return this.ctx.credentials.pwd ?? this.configText('pwd')
  }

  private root(): string {
    const raw = this.configText('rootPath', '/').trim() || '/'
    try {
      return driverPath(raw)
    } catch {
      throw DriverError.invalid('The configured root path is invalid')
    }
  }

  private physical(path: string): string {
    const clean = driverPath(path)
    const root = this.root()
    if (root === '/') return clean
    return clean === '/' ? root : `${root}${clean}`
  }

  private sharePath(logical: string): string {
    const physical = this.physical(logical)
    const sid = this.sid()
    return `/@s/${sid}${physical === '/' ? '' : physical}`
  }

  /** The download address uses `/sd/{sid}` rather than the `/@s/{sid}` API prefix. */
  private downloadUrl(physical: string): string {
    const encoded = physical.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    const url = new URL(`${this.baseUrl()}/sd/${encodeURIComponent(this.sid())}${encoded}`)
    url.searchParams.set('pwd', this.pwd())
    return url.toString()
  }

  protected async login(): Promise<void> {
    // A share link has no login; the call still validates the two required configuration values.
    this.baseUrl()
    this.sid()
  }

  private assertCode(code: number, message?: string): void {
    if (code === 200) return
    const text = message || `OpenList share answered code ${code}`
    if (code === 401 || code === 403) throw DriverError.auth(text)
    if (code === 404) throw DriverError.notFound(text)
    if (code === 429) throw DriverError.rateLimited(text)
    throw DriverError.upstream(text)
  }

  private async api<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(`${this.baseUrl()}/api${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null) as ShareResponse<T> | null
    if (!payload || typeof payload.code !== 'number') {
      throw DriverError.upstream('OpenList share returned an unexpected body')
    }
    this.assertCode(payload.code, payload.message)
    return payload.data as T
  }

  private async listPage(sharePath: string, page: number, pageSize: number): Promise<ShareListData> {
    return await this.api<ShareListData>('/fs/list', {
      path: sharePath,
      password: this.pwd(),
      refresh: false,
      page,
      per_page: pageSize,
    })
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const sharePath = this.sharePath(path)
    const pageSize = Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE)))
    if (options.page !== undefined) {
      const page = Math.max(1, Math.trunc(options.page))
      const data = await this.withAuth(async () => await this.listPage(sharePath, page, pageSize))
      const content = data.content ?? []
      const total = Number(data.total) || 0
      const next = total > page * pageSize ? String(page + 1) : null
      return { entries: content.map(fileEntry), cursor: next, truncated: next !== null }
    }
    const collected = await this.withAuth(async () => {
      return await collectPages(async ({ page }) => {
        const data = await this.listPage(sharePath, page, pageSize)
        const content = data.content ?? []
        const total = Number(data.total) || 0
        const next = total > page * pageSize && content.length > 0 ? String(page + 1) : null
        return { items: content, next }
      }, { maxPages: MAX_LIST_PAGES })
    })
    return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
  }

  private async findEntry(parentLogical: string, name: string): Promise<DriverEntry | null> {
    const sharePath = this.sharePath(parentLogical)
    return await this.withAuth(async () => {
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const data = await this.listPage(sharePath, page, DEFAULT_PAGE_SIZE)
        const content = data.content ?? []
        const hit = content.find((item) => item.name === name)
        if (hit) return fileEntry(hit)
        const total = Number(data.total) || 0
        if (content.length === 0 || total <= page * DEFAULT_PAGE_SIZE) return null
      }
      return null
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const logical = driverPath(path)
    const physical = this.physical(logical)
    if (logical === '/') {
      return {
        name: physical === '/' ? '/' : driverFileName(physical),
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
        ref: physical === '/' ? undefined : physical,
      }
    }
    const entry = await this.findEntry(driverParentPath(logical), driverFileName(logical))
    if (!entry) throw DriverError.notFound(`The share does not contain ${driverFileName(logical)}`)
    return entry
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const link = this.downloadUrl(this.physical(path))
    return await this.request(link, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      retries: 0,
      timeoutMs: 30_000,
    })
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') return null
    return this.downloadUrl(this.physical(path))
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.list('/', { page: 1, pageSize: 10 })
      return { ok: true, message: 'The OpenList share is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The OpenList share is unavailable' }
    }
  }

  // A share link is read-only; these operations are intentionally absent (undefined at runtime).
  declare readonly upload: MountDriver['upload']
  declare readonly mkdir: MountDriver['mkdir']
  declare readonly rename: MountDriver['rename']
  declare readonly move: MountDriver['move']
  declare readonly remove: MountDriver['remove']
}

export function createOpenListShareDriver(ctx: DriverContext): MountDriver {
  return new OpenListShareDriver(ctx)
}
