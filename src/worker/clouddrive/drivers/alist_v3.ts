/**
 * AList V3 driver: mounts another AList / OpenList instance through its HTTP API.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/alist_v3`:
 * `/api/me` token validation (and the username mismatch re-login), `/auth/login`, the `/api/fs/*`
 * endpoints and the `File-Path` PUT upload all follow it. Pagination uses the real `page`/`per_page`
 * fields of `/api/fs/list`.
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

interface AlistFile {
  name: string
  size?: number
  is_dir?: boolean
  modified?: string
  sign?: string
  thumb?: string
  type?: number
  raw_url?: string
}

interface AlistListData {
  content?: AlistFile[]
  total?: number
}

interface AlistResponse<T> {
  code?: number
  message?: string
  data?: T
}

function fileEntry(file: AlistFile): DriverEntry {
  const folder = Boolean(file.is_dir)
  return {
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: Date.parse(file.modified ?? '') || 0,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.name),
  }
}

class AlistV3Driver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('alist_v3')!
  readonly capabilities = this.definition.capabilities
  private token: string

  constructor(ctx: DriverContext) {
    super(ctx)
    this.token = ctx.credentials.token ?? ''
  }

  private baseUrl(): string {
    const raw = this.configText('url').trim()
    if (!raw) throw DriverError.invalid('AList needs the URL of the other instance')
    return raw.replace(/\/+$/, '')
  }

  private username(): string {
    return this.configText('username').trim()
  }

  private password(): string {
    return this.ctx.credentials.password ?? ''
  }

  private metaPassword(): string {
    return this.configText('metaPassword')
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
        throw DriverError.auth('AList needs a token, or a username and a password')
      }
    } else if (!username || !password) {
      throw DriverError.auth('AList needs a username and a password to refresh its token')
    }
    const data = await this.api<{ token?: string }>('/auth/login', { username, password })
    if (!data?.token) throw DriverError.auth('AList did not return an access token')
    this.token = data.token
    await this.saveCredential({ token: data.token })
  }

  private async me(): Promise<{ username?: string }> {
    return await this.api<{ username?: string }>('/me', undefined, 'GET')
  }

  private assertCode(code: number, message?: string): void {
    if (code === 200) return
    const text = message || `AList answered code ${code}`
    if (code === 401 || code === 403) throw DriverError.auth(text)
    if (code === 404) throw DriverError.notFound(text)
    if (code === 429) throw DriverError.rateLimited(text)
    throw DriverError.upstream(text)
  }

  private async api<T>(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.token) headers.Authorization = this.token
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await this.request(`${this.baseUrl()}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null) as AlistResponse<T> | null
    if (!payload || typeof payload.code !== 'number') {
      throw DriverError.upstream('AList returned an unexpected body')
    }
    this.assertCode(payload.code, payload.message)
    return payload.data as T
  }

  private async listPage(physical: string, page: number, pageSize: number): Promise<AlistListData> {
    return await this.api<AlistListData>('/fs/list', {
      path: physical,
      password: this.metaPassword(),
      page,
      per_page: pageSize,
      refresh: false,
    })
  }

  private async getEntry(physical: string): Promise<AlistFile & { raw_url?: string }> {
    const data = await this.api<AlistFile & { raw_url?: string }>('/fs/get', {
      path: physical,
      password: this.metaPassword(),
    })
    if (!data || typeof data.name !== 'string') throw DriverError.upstream('AList returned no entry')
    return data
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
    const data = await this.withAuth(async () => await this.getEntry(physical))
    return fileEntry(data)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const physical = this.physical(path)
    const data = await this.withAuth(async () => await this.getEntry(physical))
    if (data.is_dir) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = (data.raw_url ?? '').trim()
    if (!link) throw DriverError.upstream('AList returned no download address')
    return await this.request(link, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      retries: 0,
      timeoutMs: 30_000,
    })
  }

  async directLink(path: string): Promise<string | null> {
    const physical = this.physical(path)
    const data = await this.withAuth(async () => await this.getEntry(physical))
    if (data.is_dir) return null
    return (data.raw_url ?? '').trim() || null
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const physical = this.physical(path)
    await this.withAuth(async () => {
      const headers: Record<string, string> = {
        Authorization: this.token,
        'File-Path': encodeURIComponent(physical),
        'Content-Type': options.contentType ?? 'application/octet-stream',
      }
      let payload = body
      let retries = 2
      let uploaded = 0
      if (body instanceof Uint8Array) {
        if (body.byteLength !== options.size) {
          throw DriverError.invalid('The upload body does not match the declared size')
        }
      } else {
        // A stream cannot be replayed, so a retry would send a partially consumed body.
        retries = 0
        payload = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) => {
            uploaded += chunk.byteLength
            options.onProgress?.(uploaded, options.size)
            controller.enqueue(chunk)
          },
        }))
      }
      const response = await this.request(`${this.baseUrl()}/api/fs/put`, {
        method: 'PUT',
        headers,
        body: payload,
        retries,
        timeoutMs: 120_000,
      })
      const result = await response.json().catch(() => null) as AlistResponse<unknown> | null
      if (result && typeof result.code === 'number') this.assertCode(result.code, result.message)
      if (body instanceof Uint8Array) options.onProgress?.(body.byteLength, options.size)
    })
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
        message: `AList is reachable${me.username ? ` · ${me.username}` : ''}`,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'AList is unavailable' }
    }
  }
}

export function createAlistV3Driver(ctx: DriverContext): MountDriver {
  return new AlistV3Driver(ctx)
}
