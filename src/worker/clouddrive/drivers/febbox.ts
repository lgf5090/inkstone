/**
 * FebBox driver.
 *
 * FebBox uses an OAuth token endpoint (`client_credentials` or `refresh_token` grant) and a single
 * form-based API host. A `-10001` response means the access token expired: the driver refreshes once
 * and retries; a second one is an authorization failure. Mutations (create/move/rename/copy/delete)
 * use the same form API; uploads stay unsupported because the reference client has no upload path.
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
import { singleFlightRefresh } from './token'

const TOKEN_URL = 'https://api.febbox.com/oauth/token'
const API_URL = 'https://api.febbox.com/oauth'
const PAGE_LIMIT = 100
const MAX_LIST_PAGES = 50
const REFRESH_LEAD_MS = 60_000

interface FebBoxFile {
  fid: number | string
  file_name: string
  file_size: number | string
  is_dir: number
  file_update_time?: number
  thumb?: string
}

interface FebBoxList {
  code?: number
  msg?: string
  data?: { file_list?: FebBoxFile[] }
}

interface FebBoxDownload {
  code?: number
  msg?: string
  data?: Array<{ download_url?: string }>
}

interface FebBoxToken {
  code?: number
  msg?: string
  data?: { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string }
}

function fileEntry(file: FebBoxFile): DriverEntry {
  const folder = file.is_dir === 1
  return {
    name: file.file_name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.file_size) || 0,
    modifiedAt: file.file_update_time ? file.file_update_time * 1000 : 0,
    ref: String(file.fid),
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.file_name),
  }
}

function downloadError(response: Response): DriverError {
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'))
    return DriverError.rateLimited('FebBox is rate limiting the download', Number.isFinite(retry) ? retry * 1000 : undefined)
  }
  if (response.status === 404) return DriverError.notFound('FebBox could not find the download')
  if (response.status === 401 || response.status === 403) return DriverError.auth('FebBox refused the download')
  return DriverError.upstream(`FebBox download failed (HTTP ${response.status})`)
}

export class FebBoxDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('febbox')!
  readonly capabilities = this.definition.capabilities
  private accessToken = ''
  private refreshToken = ''
  private tokenType = 'Bearer'
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.accessToken = String(ctx.credentials.accessToken ?? '')
    this.refreshToken = String(ctx.credentials.refreshToken ?? '')
  }

  protected async login(force: boolean): Promise<void> {
    this.accessToken = String(this.ctx.credentials.accessToken ?? '')
    this.refreshToken = String(this.ctx.credentials.refreshToken ?? '')
    if (!force && this.tokenUsable()) return
    try {
      await this.ensureToken()
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message).catch(() => undefined)
      }
      throw error
    }
  }

  private tokenUsable(): boolean {
    if (!this.accessToken) return false
    const expiresAt = Number(this.ctx.credentials.expiresAt) || 0
    return !expiresAt || expiresAt - Date.now() > REFRESH_LEAD_MS
  }

  private async ensureToken(): Promise<void> {
    const before = { accessToken: this.accessToken, refreshToken: this.refreshToken }
    const token = await singleFlightRefresh(
      this.ctx,
      async () => await this.fetchToken(before),
      async () => {
        await this.ctx.reloadCredentials?.()
        const currentAccess = String(this.ctx.credentials.accessToken ?? '')
        const currentRefresh = String(this.ctx.credentials.refreshToken ?? '')
        if (currentRefresh && currentRefresh !== before.refreshToken) {
          this.accessToken = currentAccess
          this.refreshToken = currentRefresh
          return currentAccess || null
        }
        if (currentAccess && currentAccess !== before.accessToken) {
          this.accessToken = currentAccess
          return currentAccess
        }
        return null
      },
    )
    this.accessToken = token
  }

  private async fetchToken(before: Record<string, string>): Promise<string> {
    const clientId = String(this.ctx.credentials.clientId ?? '')
    const clientSecret = String(this.ctx.credentials.clientSecret ?? '')
    if (!clientId || !clientSecret) throw DriverError.auth('FebBox needs an application client id and secret')
    const form = new URLSearchParams({
      grant_type: before.refreshToken ? 'refresh_token' : 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      ...(before.refreshToken ? { refresh_token: before.refreshToken } : {}),
    })
    const response = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    })
    const payload = await response.json().catch(() => null) as FebBoxToken | null
    const data = payload?.data
    if (!data?.access_token || (payload?.code !== undefined && payload.code !== 1)) {
      throw DriverError.auth(`FebBox token fetch failed: ${payload?.msg || 'no access token'}`)
    }
    this.tokenType = data.token_type || 'Bearer'
    const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 3600_000
    const effective = await this.saveCredential({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || before.refreshToken,
      expiresAt: String(expiresAt),
    }, before)
    this.accessToken = String(effective.accessToken ?? data.access_token)
    this.refreshToken = String(effective.refreshToken ?? before.refreshToken)
    return this.accessToken
  }

  private async api<T>(params: Record<string, string>): Promise<T> {
    return await this.withAuth(async () => {
      const form = new FormData()
      for (const [key, value] of Object.entries(params)) form.append(key, value)
      const response = await this.request(API_URL, {
        method: 'POST',
        headers: { Authorization: `${this.tokenType} ${this.accessToken}`, Accept: 'application/json' },
        body: form,
      })
      const text = await response.text()
      let payload: (T & { code?: number; msg?: string }) | null = null
      if (text) {
        try {
          payload = JSON.parse(text) as T & { code?: number; msg?: string }
        } catch {
          throw DriverError.upstream('FebBox returned an unexpected body')
        }
      }
      if (!payload) throw DriverError.upstream('FebBox returned no body')
      const code = Number(payload.code)
      if (code === 0 || code === 1) return payload
      if (code === -10001) throw DriverError.auth('FebBox access token expired')
      if (code === 401 || code === 403) throw DriverError.auth(`FebBox refused the request (${code})`)
      if (code === 404) throw DriverError.notFound('FebBox could not find the item')
      if (code === 429) throw DriverError.rateLimited('FebBox is rate limiting requests')
      throw DriverError.upstream(`FebBox answered code ${code}: ${payload.msg || ''}`)
    })
  }

  private async fileListPage(parentId: string, page: number, pageSize: number): Promise<{ files: FebBoxFile[]; next: string | null }> {
    const payload = await this.api<FebBoxList>({
      module: 'file_list',
      parent_id: parentId,
      page: String(Math.max(1, page)),
      pagelimit: String(Math.max(1, pageSize)),
      order: this.configText('sortRule', 'name_asc'),
    })
    const files = payload.data?.file_list ?? []
    return { files, next: files.length >= pageSize ? String(Math.max(1, page) + 1) : null }
  }

  private async fileListAll(parentId: string): Promise<FebBoxFile[]> {
    const files: FebBoxFile[] = []
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const result = await this.fileListPage(parentId, page, PAGE_LIMIT)
      files.push(...result.files)
      if (result.next === null) return files
    }
    return files
  }

  private rootId(): string {
    return this.configText('rootFolderId', '0').trim() || '0'
  }

  private async resolveFolder(path: string): Promise<string> {
    const clean = driverPath(path)
    const root = this.rootId()
    if (clean === '/') return root
    let current = root
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        current = cached
        continue
      }
      const files = await this.fileListAll(current)
      const found = files.find((file) => file.is_dir === 1 && file.file_name === segment)
      if (!found) throw DriverError.notFound(`FebBox could not find the folder ${prefix}`)
      current = String(found.fid)
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveEntry(path: string): Promise<FebBoxFile> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolder(driverParentPath(clean))
    const files = await this.fileListAll(parentId)
    const found = files.find((file) => file.file_name === driverFileName(clean))
    if (!found) throw DriverError.notFound(`FebBox could not find ${clean}`)
    return found
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const parentId = await this.resolveFolder(clean)
    const pageSize = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? PAGE_LIMIT))
    if (options.page !== undefined) {
      const page = await this.fileListPage(parentId, Math.max(1, options.page), pageSize)
      return { entries: page.files.map(fileEntry), cursor: page.next, truncated: page.next !== null }
    }
    const collected = await collectPages(async ({ page }) => {
      const result = await this.fileListPage(parentId, page, pageSize)
      return { items: result.files, next: result.next }
    }, { mode: 'page', maxPages: MAX_LIST_PAGES })
    return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
    }
    return fileEntry(await this.resolveEntry(clean))
  }

  private async downloadLink(id: string): Promise<string> {
    const payload = await this.api<FebBoxDownload>({
      module: 'file_get_download_url',
      'fids[]': id,
      ip: this.configText('userIp'),
    })
    const url = payload.data?.[0]?.download_url ?? ''
    if (!url) throw DriverError.notFound('FebBox returned no download address')
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const url = await this.downloadLink(String((await this.resolveEntry(clean)).fid))
    const response = await fetch(url, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw downloadError(response)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') return null
    return await this.downloadLink(String((await this.resolveEntry(clean)).fid))
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('FebBox upload is not supported: the reference client throws upload not supported')
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveFolder(driverParentPath(clean))
    await this.api<unknown>({
      module: 'create_dir',
      parent_id: parentId,
      name: driverFileName(clean),
    })
    this.pathIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The root cannot be renamed')
    const entry = await this.resolveEntry(clean)
    await this.api<unknown>({
      module: 'file_rename',
      fid: String(entry.fid),
      name: newName,
    })
    this.pathIds.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/') throw DriverError.invalid('The root cannot be moved')
    const entry = await this.resolveEntry(from)
    const destinationId = await this.resolveFolder(driverParentPath(to))
    await this.api<unknown>({
      module: 'file_move',
      'fids[]': String(entry.fid),
      to: destinationId,
    })
    this.pathIds.clear()
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/') throw DriverError.invalid('The root cannot be copied')
    const entry = await this.resolveEntry(from)
    const destinationId = await this.resolveFolder(driverParentPath(to))
    await this.api<unknown>({
      module: 'file_copy',
      'fids[]': String(entry.fid),
      to: destinationId,
    })
    this.pathIds.clear()
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The root cannot be removed')
    const entry = await this.resolveEntry(clean)
    await this.api<unknown>({
      module: 'file_delete',
      'fids[]': String(entry.fid),
    })
    this.pathIds.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const payload = await this.api<FebBoxList>({
        module: 'file_list',
        parent_id: this.rootId(),
        page: '1',
        pagelimit: '1',
        order: 'name_asc',
      })
      const count = payload.data?.file_list?.length ?? 0
      return { ok: true, message: `FebBox is reachable · ${count} item(s)` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'FebBox is unavailable' }
    }
  }
}

export function createFebBoxDriver(ctx: DriverContext): MountDriver {
  return new FebBoxDriver(ctx)
}
