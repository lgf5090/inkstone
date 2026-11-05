/**
 * Quark Cloud Drive open-platform driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/quark_open` and the upstream OpenList driver.
 * Every call is signed with `sha256(method&path&tm&signKey)`; listings page by cursor; the mount is
 * read-only and downloads resolve a fid into a URL that needs the signed-in cookie.
 */
import { createHash } from 'node:crypto'
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
import { singleFlightRefresh } from './token'

const API = 'https://open-api-drive.quark.cn'
const RENEW_API = 'https://api.oplist.org/quarkyun/renewapi'
const USER_AGENT = 'go-resty/3.0.0-beta.1 (https://resty.dev)'
const PAGE_LIMIT = 100
const MAX_LIST_PAGES = 50

interface QuarkFile {
  fid: string
  filename: string
  size?: number
  file_type?: string
  updated_at?: number
  thumbnail_url?: string
}

interface QuarkCursor {
  version?: string
  token?: string
}

interface QuarkEnvelope<T> {
  status?: number
  errno?: number
  error_info?: string
  data?: T
}

interface QuarkListData {
  file_list?: QuarkFile[]
  last_page?: boolean
  next_query_cursor?: QuarkCursor
}

function isAuthError(status: number | undefined, errno: number | undefined, info: string | undefined): boolean {
  if (status !== -1) return false
  return errno === 11001 || (errno === 14001 && (info ?? '').includes('access_token'))
}

function mapError(status: number | undefined, errno: number | undefined, info: string | undefined): DriverError {
  const suffix = info ? `: ${info}` : ''
  if (status === 404 || errno === 404) return DriverError.notFound(`Quark could not find the item${suffix}`)
  if (status === 429 || errno === 429) return DriverError.rateLimited(`Quark is rate limiting requests${suffix}`)
  if (status === 401 || status === 403) return DriverError.auth(`Quark refused the credentials (${status}${suffix})`)
  return DriverError.upstream(`Quark answered ${status ?? errno}${suffix}`)
}

function entryOf(file: QuarkFile): DriverEntry {
  const folder = file.file_type === '0'
  return {
    name: file.filename,
    kind: folder ? 'folder' : 'file',
    size: Number(file.size) || 0,
    modifiedAt: Number(file.updated_at) ? Number(file.updated_at) * 1000 : 0,
    ref: file.fid,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.filename),
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function cursorText(cursor: QuarkCursor | null | undefined): string | null {
  if (!cursor?.token) return null
  return JSON.stringify(cursor)
}

function parseCursor(text: string | null): QuarkCursor | undefined {
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as QuarkCursor
    return parsed.token ? parsed : undefined
  } catch {
    return undefined
  }
}

export class QuarkOpenDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('quark_open')!
  readonly capabilities = this.definition.capabilities
  private token = ''
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private credential(key: string): string {
    return String(this.ctx.credentials[key] ?? '')
  }

  private rootId(): string {
    return this.configText('rootFolderId', '0').trim() || '0'
  }

  private appId(): string {
    return this.credential('appId')
  }

  private signKey(): string {
    return this.credential('signKey')
  }

  protected async login(force: boolean): Promise<void> {
    this.token = await this.accessToken(force)
  }

  private async accessToken(force: boolean): Promise<string> {
    const existing = this.credential('accessToken')
    if (!force && existing) return existing
    const refreshToken = this.credential('refreshToken')
    if (!refreshToken) {
      const message = 'Quark needs a refresh token; authorize the storage again'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    return await this.refreshToken(refreshToken)
  }

  private async refreshToken(refreshToken: string): Promise<string> {
    const previous = {
      accessToken: this.credential('accessToken'),
      refreshToken: this.credential('refreshToken'),
    }
    try {
      return await singleFlightRefresh(
        this.ctx,
        async () => {
          const query = new URLSearchParams({ refresh_ui: refreshToken, server_use: 'true', driver_txt: 'quarkyun_oa' })
          const response = await fetch(`${RENEW_API}?${query.toString()}`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(20_000),
          })
          if (response.status === 429) throw DriverError.rateLimited('The Quark token endpoint is rate limiting requests')
          if (!response.ok) throw DriverError.auth(`The Quark token endpoint refused the refresh token (HTTP ${response.status})`)
          const payload = await response.json().catch(() => null) as {
            refresh_token?: string
            access_token?: string
            app_id?: string
            sign_key?: string
            text?: string
          } | null
          if (!payload?.access_token || !payload.refresh_token) {
            throw DriverError.auth(payload?.text || 'The Quark token endpoint returned no access token')
          }
          const patch: Record<string, string> = {
            accessToken: payload.access_token,
            refreshToken: payload.refresh_token,
          }
          if (payload.app_id) patch.appId = payload.app_id
          if (payload.sign_key) patch.signKey = payload.sign_key
          const effective = await this.ctx.saveCredentials(patch, { expect: previous })
          Object.assign(this.ctx.credentials, effective ?? patch)
          return String(effective?.accessToken ?? patch.accessToken)
        },
        async () => {
          await this.ctx.reloadCredentials?.()
          const current = this.credential('accessToken')
          return current && current !== previous.accessToken ? current : null
        },
      )
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'rate_limit') throw error
      const message = error instanceof Error ? error.message : 'Quark could not refresh the access token'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
  }

  private sign(method: 'GET' | 'POST', path: string): { tm: string; token: string; reqId: string } {
    const tm = String(Date.now())
    const token = sha256(`${method}&${path}&${tm}&${this.signKey()}`)
    const reqId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    return { tm, token, reqId }
  }

  private async api<T>(path: string, method: 'GET' | 'POST' = 'POST', body?: unknown): Promise<QuarkEnvelope<T>> {
    await this.authenticate(false)
    return await this.withAuth(async () => {
      const { tm, token, reqId } = this.sign(method, path)
      const query = new URLSearchParams({ req_id: reqId, access_token: this.token })
      const response = await this.request(`${API}${path}?${query.toString()}`, {
        method,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': USER_AGENT,
          'x-pan-tm': tm,
          'x-pan-token': token,
          'x-pan-client-id': this.appId(),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json() as QuarkEnvelope<T>
      const status = Number(payload.status)
      const errno = Number(payload.errno)
      if (isAuthError(status, errno, payload.error_info)) {
        throw DriverError.auth(payload.error_info || 'Quark rejected the access token')
      }
      if (status >= 400 || errno !== 0) throw mapError(status, errno, payload.error_info)
      return payload
    })
  }

  private async listChunk(parentId: string, cursor: QuarkCursor | undefined, pageSize: number): Promise<{ files: QuarkFile[]; next: QuarkCursor | null }> {
    const payload = await this.api<QuarkListData>('/open/v1/file/list', 'POST', {
      parent_fid: parentId,
      size: Math.min(PAGE_LIMIT, Math.max(1, pageSize)),
      sort: 'file_name:asc',
      ...(cursor ? { query_cursor: cursor } : {}),
    })
    const data = payload.data
    const next = data?.last_page ? null : (data?.next_query_cursor?.token ? data.next_query_cursor : null)
    return { files: data?.file_list ?? [], next }
  }

  private async listPage(parentId: string, pageNumber: number, pageSize: number): Promise<{ files: QuarkFile[]; next: QuarkCursor | null }> {
    let cursor: QuarkCursor | undefined
    for (let current = 1; current <= Math.max(1, pageNumber); current++) {
      const result = await this.listChunk(parentId, cursor, pageSize)
      if (current === pageNumber) return result
      if (result.next === null) return { files: [], next: null }
      cursor = result.next
      if (current >= MAX_LIST_PAGES) break
    }
    return { files: [], next: null }
  }

  private async findChild(parentId: string, name: string, folder: boolean | null = null): Promise<QuarkFile | null> {
    let cursor: QuarkCursor | undefined
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const result = await this.listChunk(parentId, cursor, PAGE_LIMIT)
      const hit = result.files.find((file) => {
        if (file.filename !== name && file.fid !== name) return false
        return folder === null || file.file_type === (folder ? '0' : '1')
      })
      if (hit) return hit
      if (result.next === null) return null
      cursor = result.next
    }
    return null
  }

  private async resolveDir(path: string): Promise<string> {
    const clean = driverPath(path)
    const root = this.rootId()
    if (clean === '/' || clean === `/${root}`) return root
    const segments = clean.split('/').filter(Boolean)
    let parent = root
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        parent = cached
        continue
      }
      const folder = await this.findChild(parent, segment, true)
      if (!folder) throw DriverError.notFound(`Folder not found: ${segment}`)
      parent = folder.fid
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveEntry(path: string): Promise<QuarkFile> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveDir(driverParentPath(clean))
    const entry = await this.findChild(parentId, driverFileName(clean), null)
    if (!entry) throw DriverError.notFound(`File not found: ${driverFileName(clean)}`)
    return entry
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const parentId = await this.resolveDir(path)
    const pageSize = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? PAGE_LIMIT))
    if (options.page !== undefined) {
      const page = await this.listPage(parentId, Math.max(1, options.page), pageSize)
      let entries = page.files.map(entryOf)
      if (options.search) entries = filterBySearch(entries, options.search)
      return { entries, cursor: cursorText(page.next), truncated: page.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const chunk = await this.listChunk(parentId, parseCursor(cursor), pageSize)
      return { items: chunk.files, next: cursorText(chunk.next) }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    let entries = collected.items.map(entryOf)
    if (options.search) entries = filterBySearch(entries, options.search)
    return { entries, cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') return { name: this.rootId(), kind: 'folder', size: 0, modifiedAt: 0, ref: this.rootId() }
    return entryOf(await this.resolveEntry(clean))
  }

  private authCookie(): string {
    return `x_pan_client_id=${this.appId()}; x_pan_access_token=${this.token}`
  }

  private async downloadUrl(file: QuarkFile): Promise<string> {
    const payload = await this.api<{ download_url?: string }>('/open/v1/file/get_download_url', 'POST', { fid: file.fid })
    const url = payload.data?.download_url ?? ''
    if (!url) throw DriverError.upstream('Quark returned no download address')
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const url = await this.downloadUrl(await this.resolveEntry(clean))
    const response = await fetch(url, {
      headers: { Cookie: this.authCookie(), ...(range ? { Range: range } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`Quark download failed (HTTP ${response.status})`)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') return null
    return await this.downloadUrl(await this.resolveEntry(path))
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Quark is mounted read-only')
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Quark is mounted read-only')
  }

  async rename(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Quark is mounted read-only')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('Quark is mounted read-only')
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Quark is mounted read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const payload = await this.api<{ user_id?: string }>('/open/v1/user/info', 'GET')
      return { ok: true, message: `Quark is reachable${payload.data?.user_id ? ` · ${payload.data.user_id}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Quark is unavailable' }
    }
  }
}

function filterBySearch(entries: DriverEntry[], search: string): DriverEntry[] {
  const needle = search.toLowerCase()
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
}

export function createQuarkOpenDriver(ctx: DriverContext): MountDriver {
  return new QuarkOpenDriver(ctx)
}
