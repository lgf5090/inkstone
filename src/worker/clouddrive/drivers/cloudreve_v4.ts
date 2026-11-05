/**
 * Cloudreve V4 storage driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/cloudreve_v4`: bearer-token session login,
 * cursor-paginated `/api/v4/file` listings, `/api/v4/file/url` download resolution, and the
 * `/api/v4/file/*` mutation endpoints. Cloudreve V4 has no stateless upload endpoint, so uploading
 * is reported as unsupported.
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
  driverChildPath,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const TIMEOUT_MS = 20_000
const PAGE_SIZE = 100
const MAX_PAGES = 50

interface CloudreveFile {
  id: string
  path?: string
  name: string
  size?: number
  type?: number | string
  created_at?: string
  updated_at?: string
}

interface CloudrevePage {
  files?: CloudreveFile[]
  pagination?: { next_token?: string }
}

interface CloudreveUrlAnswer {
  urls?: Array<{ url?: string }>
}

interface CloudreveSession {
  token?: string
  data?: { token?: string }
}

async function responseFailure(response: Response, service: string): Promise<DriverError> {
  const body = await response.text().catch(() => '')
  let message = ''
  try {
    const parsed = JSON.parse(body) as { message?: unknown; msg?: unknown; error?: unknown }
    const candidate = parsed.message ?? parsed.msg ?? parsed.error
    if (typeof candidate === 'string') message = candidate
  } catch {
    message = body.slice(0, 200)
  }
  const suffix = message ? `: ${message}` : ''
  if (response.status === 401 || response.status === 403) {
    return DriverError.auth(`The storage refused the credentials (HTTP ${response.status}${suffix})`)
  }
  if (response.status === 404) return DriverError.notFound(`Not found upstream (HTTP 404${suffix})`)
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'))
    return DriverError.rateLimited(
      `The upstream service is rate limiting requests${suffix}`,
      Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    )
  }
  return DriverError.upstream(`${service} answered HTTP ${response.status}${suffix}`)
}

function entryOf(file: CloudreveFile): DriverEntry {
  const folder = file.type === 1 || file.type === 'dir'
  const stamp = file.updated_at || file.created_at
  return {
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: stamp ? Date.parse(stamp) || 0 : 0,
    ref: file.id,
    ...(folder ? {} : { mime: driverEntryMime(file.name) }),
  }
}

class CloudreveV4Driver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('cloudreve_v4')!
  readonly capabilities = this.definition.capabilities
  private readonly address: string
  private readonly root: string
  private accessToken = ''

  constructor(ctx: DriverContext) {
    super(ctx)
    this.address = this.configText('address').trim().replace(/\/+$/, '')
    try {
      this.root = driverPath(this.configText('rootPath', '/').trim() || '/')
    } catch {
      throw DriverError.invalid('The Cloudreve root path is invalid')
    }
  }

  private credential(key: string): string {
    return this.ctx.credentials[key] || this.configText(key)
  }

  protected async login(force: boolean): Promise<void> {
    const stored = this.credential('token').trim()
    const username = this.credential('username').trim()
    const password = this.credential('password')
    if (stored && !(force && username && password)) {
      this.accessToken = stored
      return
    }
    if (!username || !password) {
      if (stored) {
        this.accessToken = stored
        return
      }
      throw DriverError.auth('Cloudreve V4 needs an access token or a username and password')
    }
    if (!this.address) throw DriverError.invalid('Cloudreve needs a server address')

    const response = await this.request(`${this.address}/api/v4/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const payload = await response.json().catch(() => null) as CloudreveSession | null
    const token = payload?.token || payload?.data?.token || ''
    if (!token) throw DriverError.auth('Cloudreve sign-in returned no access token')
    this.accessToken = token
    await this.saveCredential({ token })
  }

  private physical(path: string): string {
    const clean = driverPath(path)
    if (this.root === '/') return clean
    return clean === '/' ? this.root : `${this.root}${clean}`
  }

  private async api<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return await this.withAuth(async () => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await this.request(`${this.address}/api/v4${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (response.status === 204) return {} as T
      const payload = await response.json().catch(() => null)
      return (payload ?? {}) as T
    })
  }

  private pageUrl(uri: string, pageSize: number, token: string): string {
    const params = new URLSearchParams({
      page_size: String(pageSize),
      uri,
      order_by: 'name',
      order_direction: 'asc',
      page: '0',
    })
    if (token) params.set('next_page_token', token)
    return `/file?${params.toString()}`
  }

  private nextToken(page: CloudrevePage): string | null {
    const token = page.pagination?.next_token
    return token ? token : null
  }

  private async fetchPage(uri: string, pageSize: number, token: string): Promise<CloudrevePage> {
    return await this.api<CloudrevePage>('GET', this.pageUrl(uri, pageSize, token))
  }

  /**
   * Walks the cursor until the requested one-based page (or the end) is reached. A request without
   * a page collects the whole listing, which is what folder-size and stat use.
   */
  private async walk(uri: string, pageSize: number, targetPage?: number): Promise<{
    files: CloudreveFile[]
    next: string | null
    truncated: boolean
  }> {
    const collected: CloudreveFile[] = []
    let cursor = ''
    let page = 1
    while (page <= MAX_PAGES) {
      const data = await this.fetchPage(uri, pageSize, cursor)
      const files = data.files ?? []
      const next = this.nextToken(data)
      if (targetPage !== undefined && page === targetPage) {
        return { files, next, truncated: next !== null }
      }
      collected.push(...files)
      if (!next) {
        if (targetPage !== undefined && page < targetPage) {
          return { files: [], next: null, truncated: false }
        }
        return { files: collected, next: null, truncated: false }
      }
      cursor = next
      page++
    }
    return { files: collected, next: cursor || null, truncated: true }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const uri = this.physical(path)
    const pageSize = Math.min(PAGE_SIZE, Math.max(1, options.pageSize ?? PAGE_SIZE))
    const targetPage = options.page === undefined ? undefined : Math.max(1, options.page)
    const result = await this.walk(uri, pageSize, targetPage)
    return {
      entries: result.files.map(entryOf),
      cursor: result.next,
      truncated: result.truncated,
    }
  }

  private async findObject(uri: string): Promise<CloudreveFile> {
    if (uri === '/') throw DriverError.invalid('The root has no directory entry')
    const parent = driverParentPath(uri)
    const name = driverFileName(uri)
    const listing = await this.walk(parent, PAGE_SIZE)
    const found = listing.files.find((file) => file.name === name)
    if (!found) throw DriverError.notFound(`Cloudreve object not found: ${name}`)
    return found
  }

  async stat(path: string): Promise<DriverEntry> {
    const uri = this.physical(path)
    if (uri === '/') return { name: '/', kind: 'folder', size: 0, modifiedAt: 0, ref: '/' }
    return entryOf(await this.findObject(uri))
  }

  private async downloadUrl(uri: string): Promise<string> {
    const answer = await this.api<CloudreveUrlAnswer>('POST', '/file/url', {
      uris: [uri],
      download: true,
    })
    const link = answer?.urls?.[0]?.url?.trim() ?? ''
    if (!link) throw DriverError.upstream('Cloudreve returned an empty download address')
    if (link.startsWith('/')) return `${this.address}${link}`
    if (!/^https?:/i.test(link)) return new URL(link, `${this.address}/`).toString()
    return link
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const uri = this.physical(path)
    const object = await this.findObject(uri)
    if (object.type === 1 || object.type === 'dir') throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadUrl(uri)
    let response: Response
    try {
      response = await fetch(link, {
        method: 'GET',
        redirect: 'follow',
        headers: range ? { Range: range } : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw DriverError.upstream(
        `The Cloudreve download could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status === 200 || response.status === 206) return response
    throw await responseFailure(response, 'Cloudreve download')
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('Direct put not supported')
  }

  async mkdir(path: string): Promise<void> {
    const uri = this.physical(path)
    if (uri === '/') return
    await this.api('POST', '/file/create', { type: 'folder', uri, error_on_conflict: true })
  }

  private async renameUri(uri: string, target: string): Promise<void> {
    await this.api('POST', '/file/rename', { uris: [uri], new_uri: target })
  }

  async rename(path: string, newName: string): Promise<void> {
    const uri = this.physical(path)
    if (uri === '/') throw DriverError.invalid('The mount root cannot be renamed')
    const target = driverPath(driverChildPath(driverParentPath(uri), newName))
    if (target === uri) return
    await this.renameUri(uri, target)
  }

  private async relocate(path: string, destination: string, copy: boolean): Promise<void> {
    const uri = this.physical(path)
    const target = this.physical(destination)
    if (uri === '/' || target === '/') throw DriverError.invalid('The mount root cannot be transferred')
    if (uri === target) return
    const targetDir = driverParentPath(target)
    await this.api('POST', '/file/move', { uris: [uri], dst: targetDir, copy })
    if (driverFileName(uri) !== driverFileName(target)) {
      const movedUri = targetDir === '/' ? `/${driverFileName(uri)}` : `${targetDir}/${driverFileName(uri)}`
      await this.renameUri(movedUri, target)
    }
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    await this.relocate(fromPath, toPath, false)
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    await this.relocate(fromPath, toPath, true)
  }

  async remove(path: string): Promise<void> {
    const uri = this.physical(path)
    if (uri === '/') throw DriverError.invalid('The mount root cannot be deleted')
    await this.api('DELETE', '/file', { uris: [uri], unlink: false, skip_soft_delete: true })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.fetchPage('/', PAGE_SIZE, '')
      return { ok: true, message: 'Cloudreve V4 is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Cloudreve V4 is unavailable' }
    }
  }
}

export function createCloudreveV4Driver(ctx: DriverContext): MountDriver {
  return new CloudreveV4Driver(ctx)
}
