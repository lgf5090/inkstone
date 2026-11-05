/**
 * OpenList driver: mounts another OpenList instance through its HTTP API.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/openlist`. It is a separate implementation from
 * the AList V3 driver on purpose: the reference keeps the two clients apart, and the OpenList client
 * sends the meta password as a `Meta-Password` header. `raw_url` from `/api/fs/get` is passed through
 * to `directLink`.
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
  driverChildPath,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const DEFAULT_PAGE_SIZE = 100
const MAX_LIST_PAGES = 50

interface OpenListFile {
  name: string
  size?: number
  is_dir?: boolean
  modified?: string
  sign?: string
  thumb?: string
  raw_url?: string
}

interface OpenListListData {
  content?: OpenListFile[]
  total?: number
}

interface OpenListResponse<T> {
  code?: number
  message?: string
  data?: T
}

function fileEntry(file: OpenListFile): DriverEntry {
  const folder = Boolean(file.is_dir)
  return {
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: Date.parse(file.modified ?? '') || 0,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.name),
  }
}

class OpenListDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('openlist')!
  readonly capabilities = this.definition.capabilities
  private token: string

  constructor(ctx: DriverContext) {
    super(ctx)
    this.token = ctx.credentials.token ?? ''
  }

  private baseUrl(): string {
    const raw = this.configText('url').trim()
    if (!raw) throw DriverError.invalid('OpenList needs the URL of the other instance')
    return raw.replace(/\/+$/, '')
  }

  private username(): string {
    return this.configText('username').trim()
  }

  private password(): string {
    return this.ctx.credentials.password ?? ''
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

  private headers(json = true): Record<string, string> {
    const headers: Record<string, string> = {}
    if (json) {
      headers.Accept = 'application/json'
      headers['Content-Type'] = 'application/json'
    }
    if (this.token) headers.Authorization = this.token
    const meta = this.configText('metaPassword')
    if (meta) headers['Meta-Password'] = meta
    return headers
  }

  protected async login(force: boolean): Promise<void> {
    const username = this.username()
    const password = this.password()
    if (!force) {
      if (this.token) {
        try {
          const me = await this.me()
          if (!username || me.username === username) return
        } catch (error) {
          if (!(error instanceof DriverError)) throw error
          // The token could not be verified; a configured account can still sign in below.
        }
      }
      if (!username || !password) {
        if (this.token) return
        throw DriverError.auth('OpenList needs a token, or a username and a password')
      }
    } else if (!username || !password) {
      throw DriverError.auth('OpenList needs a username and a password to refresh its token')
    }
    const data = await this.api<{ token?: string }>('/auth/login', { username, password })
    if (!data?.token) throw DriverError.auth('OpenList did not return an access token')
    this.token = data.token
    await this.saveCredential({ token: data.token })
  }

  private async me(): Promise<{ username?: string }> {
    return await this.api<{ username?: string }>('/me', undefined, 'GET')
  }

  private assertCode(code: number, message?: string): void {
    if (code === 200) return
    const text = message || `OpenList answered code ${code}`
    if (code === 401 || code === 403) throw DriverError.auth(text)
    if (code === 404) throw DriverError.notFound(text)
    if (code === 429) throw DriverError.rateLimited(text)
    throw DriverError.upstream(text)
  }

  private async api<T>(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
    const response = await this.request(`${this.baseUrl()}/api${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null) as OpenListResponse<T> | null
    if (!payload || typeof payload.code !== 'number') {
      throw DriverError.upstream('OpenList returned an unexpected body')
    }
    this.assertCode(payload.code, payload.message)
    return payload.data as T
  }

  private async listPage(physical: string, page: number, pageSize: number): Promise<OpenListListData> {
    return await this.api<OpenListListData>('/fs/list', { path: physical, page, per_page: pageSize })
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const physical = this.physical(path)
    const pageSize = Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE)))
    if (options.page !== undefined) {
      const page = Math.max(1, Math.trunc(options.page))
      const data = await this.withAuth(async () => await this.listPage(physical, page, pageSize))
      const content = data.content ?? []
      const total = Number(data.total) || 0
      const next = total > page * pageSize ? String(page + 1) : null
      return { entries: content.map(fileEntry), cursor: next, truncated: next !== null }
    }
    const collected = await this.withAuth(async () => {
      return await collectPages(async ({ page }) => {
        const data = await this.listPage(physical, page, pageSize)
        const content = data.content ?? []
        const total = Number(data.total) || 0
        const next = total > page * pageSize && content.length > 0 ? String(page + 1) : null
        return { items: content, next }
      }, { maxPages: MAX_LIST_PAGES })
    })
    return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
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
    try {
      const data = await this.withAuth(async () => {
        return await this.api<OpenListFile & { raw_url?: string }>('/fs/get', { path: physical })
      })
      if (!data || typeof data.name !== 'string') throw DriverError.upstream('OpenList returned no entry')
      return fileEntry(data)
    } catch (error) {
      if (!(error instanceof DriverError) || (error.kind !== 'not_found' && error.kind !== 'upstream')) throw error
      // The reference treats a directory as an entry even when `/fs/get` cannot answer for it.
      try {
        await this.withAuth(async () => {
          await this.api<OpenListListData>('/fs/list', { path: physical, page: 1, per_page: 0 })
        })
      } catch {
        throw error
      }
      return {
        name: driverFileName(physical),
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
        ref: physical,
      }
    }
  }

  private async fileTarget(physical: string): Promise<OpenListFile & { raw_url?: string }> {
    const data = await this.withAuth(async () => {
      return await this.api<OpenListFile & { raw_url?: string }>('/fs/get', { path: physical })
    })
    if (!data || typeof data.name !== 'string') throw DriverError.upstream('OpenList returned no entry')
    return data
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const data = await this.fileTarget(this.physical(path))
    if (data.is_dir) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = (data.raw_url ?? '').trim()
    if (!link) throw DriverError.upstream('OpenList returned no download address')
    return await this.request(link, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      retries: 0,
      timeoutMs: 30_000,
    })
  }

  async directLink(path: string): Promise<string | null> {
    const data = await this.fileTarget(this.physical(path))
    if (data.is_dir) return null
    return (data.raw_url ?? '').trim() || null
  }

  async upload(
    _path: string,
    _body: Uint8Array | ReadableStream,
    _options: DriverUploadOptions,
  ): Promise<void> {
    throw DriverError.unsupported('OpenList does not support a direct upload in a stateless environment')
  }

  async mkdir(path: string): Promise<void> {
    const logical = driverPath(path)
    if (logical === '/') return
    const physical = this.physical(logical)
    await this.withAuth(async () => {
      await this.api('/fs/mkdir', { path: physical })
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const logical = driverPath(path)
    if (logical === '/') throw DriverError.invalid('The mount root cannot be renamed')
    if (!newName || newName.includes('/') || newName.includes('\\')) {
      throw DriverError.invalid('The new name is invalid')
    }
    const physical = this.physical(logical)
    await this.withAuth(async () => {
      await this.api('/fs/rename', { path: physical, name: newName })
    })
  }

  async remove(path: string): Promise<void> {
    const logical = driverPath(path)
    if (logical === '/') throw DriverError.invalid('The mount root cannot be removed')
    const physical = this.physical(logical)
    await this.withAuth(async () => {
      await this.api('/fs/remove', {
        dir: driverParentPath(physical),
        names: [driverFileName(physical)],
      })
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const fromLogical = driverPath(fromPath)
    const toLogical = driverPath(toPath)
    if (fromLogical === '/' || toLogical === '/') {
      throw DriverError.invalid('The mount root cannot be moved')
    }
    const fromPhysical = this.physical(fromLogical)
    const toPhysical = this.physical(toLogical)
    const sourceName = driverFileName(fromPhysical)
    const targetName = driverFileName(toPhysical)
    if (targetName !== sourceName) await this.rename(fromLogical, targetName)
    await this.withAuth(async () => {
      await this.api('/fs/move', {
        src_dir: driverParentPath(fromPhysical),
        dst_dir: driverParentPath(toPhysical),
        names: [targetName],
      })
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const fromLogical = driverPath(fromPath)
    const toLogical = driverPath(toPath)
    if (fromLogical === '/' || toLogical === '/') {
      throw DriverError.invalid('The mount root cannot be copied')
    }
    const fromPhysical = this.physical(fromLogical)
    const toPhysical = this.physical(toLogical)
    const sourceName = driverFileName(fromPhysical)
    const targetName = driverFileName(toPhysical)
    await this.withAuth(async () => {
      await this.api('/fs/copy', {
        src_dir: driverParentPath(fromPhysical),
        dst_dir: driverParentPath(toPhysical),
        names: [sourceName],
      })
    })
    if (targetName !== sourceName) {
      const created = driverChildPath(driverParentPath(toPhysical), sourceName)
      await this.withAuth(async () => {
        await this.api('/fs/rename', { path: created, name: targetName })
      })
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const me = await this.withAuth(async () => await this.me())
      return {
        ok: true,
        message: `OpenList is reachable${me.username ? ` · ${me.username}` : ''}`,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'OpenList is unavailable' }
    }
  }
}

export function createOpenListDriver(ctx: DriverContext): MountDriver {
  return new OpenListDriver(ctx)
}
