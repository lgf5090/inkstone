/**
 * Quark / UC Cloud Drive driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/quark`: the two variants share one API shape but
 * differ in host, cookie/session headers and Referer. Listing is a page-based `/file/sort` walk,
 * download links are short-lived and require the same Cookie/UA/Referer pair, and the upstream API
 * refreshes `__puus`/`__pus` through `Set-Cookie` while the session is in use.
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
import { cookieHeader, mergeResponseCookies, parseCookies, type CookieJar } from './cookies'
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50

interface QuarkConf {
  userAgent: string
  referer: string
  api: string
  pr: string
}

const QUARK_CONF: QuarkConf = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
  referer: 'https://pan.quark.cn',
  api: 'https://drive-m.quark.cn/1/clouddrive',
  pr: 'ucpro',
}

const UC_CONF: QuarkConf = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
  referer: 'https://drive.uc.cn',
  api: 'https://pc-api.uc.cn/1/clouddrive',
  pr: 'UCBrowser',
}

interface QuarkFile {
  fid: string
  file_name: string
  pdir_fid?: string
  category?: number
  file: boolean
  size?: number
  updated_at?: number
  thumbnail?: string
}

interface QuarkSortData {
  list?: QuarkFile[]
}

interface QuarkSortResponse {
  status?: number
  code?: number
  message?: string
  msg?: string
  data?: QuarkSortData
  metadata?: { total?: number; page?: number; size?: number }
}

interface QuarkDownloadResponse {
  status?: number
  code?: number
  message?: string
  msg?: string
  data?: { download_url?: string }[]
}

interface QuarkMkdirResponse {
  status?: number
  code?: number
  message?: string
  msg?: string
  data?: { fid?: string }[]
}

function confFor(variant: string): QuarkConf {
  return variant.trim().toLowerCase() === 'uc' ? UC_CONF : QUARK_CONF
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
}

/** Quark reports timestamps in seconds; a few endpoints answer in milliseconds. */
function modifiedAt(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 0
  return value < 1e12 ? value * 1000 : value
}

function fileEntry(file: QuarkFile): DriverEntry {
  const folder = !file.file
  const name = unescapeHtml(file.file_name)
  return {
    name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: modifiedAt(file.updated_at),
    ref: file.fid,
    mime: folder ? 'application/octet-stream' : driverEntryMime(name),
  }
}

class QuarkDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('quark')!
  readonly capabilities = this.definition.capabilities
  private readonly conf: QuarkConf
  private jar: CookieJar = {}
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.conf = confFor(this.configText('variant', 'Quark'))
  }

  private rootId(): string {
    return this.configText('rootFolderId', '0').trim() || '0'
  }

  protected async login(): Promise<void> {
    const raw = this.ctx.credentials.cookie ?? ''
    if (!raw.trim()) {
      const message = 'Quark needs a browser Cookie for this account'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    this.jar = parseCookies(raw)
  }

  private headers(body: boolean): Record<string, string> {
    return {
      Cookie: cookieHeader(this.jar),
      Accept: 'application/json, text/plain, */*',
      Referer: this.conf.referer,
      'User-Agent': this.conf.userAgent,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private async absorbCookies(response: Response): Promise<void> {
    const before = cookieHeader(this.jar)
    mergeResponseCookies(this.jar, response)
    const after = cookieHeader(this.jar)
    if (after !== before) await this.saveCredential({ cookie: after })
  }

  /**
   * One API call. HTTP failures are mapped by the base class; the Quark envelope can also carry a
   * `status`/`code` failure with a 200 response, so those are translated here.
   */
  private async api<T>(
    pathname: string,
    method: 'GET' | 'POST',
    query?: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(this.conf.api + pathname)
    url.searchParams.set('pr', this.conf.pr)
    url.searchParams.set('fr', 'pc')
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
    const response = await this.request(url.toString(), {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    await this.absorbCookies(response)
    let payload: T & { status?: number; code?: number; message?: string; msg?: string }
    try {
      payload = await response.json() as typeof payload
    } catch {
      throw DriverError.upstream('Quark returned a body that is not JSON')
    }
    const status = typeof payload.status === 'number' ? payload.status : 0
    const code = typeof payload.code === 'number' ? payload.code : 0
    if (status >= 400 || code !== 0) {
      const message = payload.message || payload.msg || `Quark answered status ${status}`
      if (status === 401 || status === 403 || code === 401 || code === 403) {
        throw DriverError.auth(message)
      }
      if (status === 429 || code === 429) throw DriverError.rateLimited(message)
      if (status === 404 || code === 404) throw DriverError.notFound(message)
      throw DriverError.upstream(message)
    }
    return payload as T
  }

  private async listPage(
    folderId: string,
    page: number,
    pageSize: number,
  ): Promise<{ files: QuarkFile[]; next: string | null }> {
    const result = await this.api<QuarkSortResponse>('/file/sort', 'GET', {
      pdir_fid: folderId,
      _size: String(pageSize),
      _fetch_total: '1',
      fetch_all_file: '1',
      fetch_risk_file_name: '1',
      _page: String(page),
    })
    const files = (result.data?.list ?? []).map((file) => ({
      ...file,
      file_name: unescapeHtml(file.file_name),
    }))
    const total = Number(result.metadata?.total) || 0
    const hasMore = files.length >= pageSize && (total === 0 || page * pageSize < total)
    return { files, next: hasMore ? String(page + 1) : null }
  }

  private async listAll(folderId: string): Promise<{ files: QuarkFile[]; truncated: boolean }> {
    const collected = await collectPages(async ({ page }) => {
      const result = await this.listPage(folderId, page, PAGE_SIZE)
      return { items: result.files, next: result.next }
    }, { maxPages: MAX_LIST_PAGES })
    return { files: collected.items, truncated: collected.truncated }
  }

  private async resolveFolderId(path: string): Promise<string> {
    const clean = driverPath(path)
    const root = this.rootId()
    if (clean === '/') return root
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
      const listed = await this.listAll(parent)
      const found = listed.files.find((file) => !file.file && file.file_name === segment)
      if (!found) throw DriverError.notFound(`Folder not found: ${segment}`)
      parent = found.fid
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async findChild(parentId: string, name: string): Promise<QuarkFile | null> {
    const listed = await this.listAll(parentId)
    return listed.files.find((file) => file.file_name === name) ?? null
  }

  /** A file by name, or a folder when the name resolves through the path walk. */
  private async resolveEntry(path: string): Promise<{ entry: DriverEntry; fid: string; folder: boolean }> {
    const clean = driverPath(path)
    if (clean === '/') {
      return {
        entry: { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: this.rootId() },
        fid: this.rootId(),
        folder: true,
      }
    }
    const name = driverFileName(clean)
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const found = await this.findChild(parentId, name)
    if (found) return { entry: fileEntry(found), fid: found.fid, folder: !found.file }
    const folderId = await this.resolveFolderId(clean)
    return {
      entry: { name, kind: 'folder', size: 0, modifiedAt: 0, ref: folderId },
      fid: folderId,
      folder: true,
    }
  }

  private async downloadUrl(fid: string): Promise<string> {
    const result = await this.api<QuarkDownloadResponse>('/file/download', 'POST', undefined, {
      fids: [fid],
    })
    const url = result.data?.[0]?.download_url ?? ''
    if (!url) throw DriverError.upstream('Quark returned no download address')
    return url
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const folderId = await this.resolveFolderId(clean)
      const pageSize = Math.min(PAGE_SIZE, Math.max(1, options.pageSize ?? PAGE_SIZE))
      if (options.search) {
        const listed = await this.listAll(folderId)
        const needle = options.search.toLocaleLowerCase()
        const filtered = listed.files.filter((file) => file.file_name.toLocaleLowerCase().includes(needle))
        const page = Math.max(1, options.page ?? 1)
        const entries = filtered.slice((page - 1) * pageSize, page * pageSize).map(fileEntry)
        const cursor = page * pageSize < filtered.length ? String(page + 1) : null
        return { entries, cursor, truncated: cursor !== null || listed.truncated }
      }
      if (options.page !== undefined) {
        const page = Math.max(1, options.page)
        const result = await this.listPage(folderId, page, pageSize)
        return { entries: result.files.map(fileEntry), cursor: result.next, truncated: result.next !== null }
      }
      const collected = await collectPages(async ({ page }) => {
        const result = await this.listPage(folderId, page, pageSize)
        return { items: result.files, next: result.next }
      }, { maxPages: MAX_LIST_PAGES })
      return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const resolved = await this.resolveEntry(clean)
      return resolved.entry
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const { entry, fid } = await this.resolveEntry(clean)
      if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
      const link = await this.downloadUrl(fid)
      const response = await fetch(link, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Cookie: cookieHeader(this.jar),
          Referer: this.conf.referer,
          'User-Agent': this.conf.userAgent,
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        if (response.status === 401 || response.status === 403) throw DriverError.auth('Quark refused the download')
        throw DriverError.upstream(`Quark download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const { entry, fid } = await this.resolveEntry(clean)
      if (entry.kind === 'folder') return null
      return await this.downloadUrl(fid)
    })
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Quark does not expose a direct upload API to this driver')
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    await this.withAuth(async () => {
      const parentId = await this.resolveFolderId(driverParentPath(clean))
      await this.api<QuarkMkdirResponse>('/file', 'POST', undefined, {
        dir_init_lock: false,
        dir_path: '',
        file_name: driverFileName(clean),
        pdir_fid: parentId,
      })
      this.pathIds.clear()
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    await this.withAuth(async () => {
      const { fid } = await this.resolveEntry(clean)
      await this.api('/file/rename', 'POST', undefined, { fid, file_name: newName })
      this.pathIds.clear()
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === to) return
    await this.withAuth(async () => {
      const { entry, fid } = await this.resolveEntry(from)
      const targetName = driverFileName(to)
      if (entry.name !== targetName) {
        await this.api('/file/rename', 'POST', undefined, { fid, file_name: targetName })
      }
      const targetParent = await this.resolveFolderId(driverParentPath(to))
      await this.api('/file/move', 'POST', undefined, { filelist: [fid], to_pdir_fid: targetParent })
      this.pathIds.clear()
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === to) return
    await this.withAuth(async () => {
      const { entry, fid } = await this.resolveEntry(from)
      const targetName = driverFileName(to)
      const targetParent = await this.resolveFolderId(driverParentPath(to))
      await this.api('/file/copy', 'POST', undefined, { filelist: [fid], to_pdir_fid: targetParent })
      if (entry.name !== targetName) {
        const copied = await this.findChild(targetParent, entry.name)
        if (!copied) throw DriverError.upstream('Quark copied the file but the copy could not be found to rename')
        await this.api('/file/rename', 'POST', undefined, { fid: copied.fid, file_name: targetName })
      }
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.withAuth(async () => {
      const { fid } = await this.resolveEntry(clean)
      await this.api('/file/delete', 'POST', undefined, {
        action_type: 2,
        filelist: [fid],
        exclude_fids: [],
      })
      this.pathIds.clear()
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.api('/config', 'GET')
      return { ok: true, message: `${this.conf === UC_CONF ? 'UC' : 'Quark'} Drive is reachable` }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      return { ok: false, message: error instanceof Error ? error.message : 'Quark is unavailable' }
    }
  }
}

export function createQuarkDriver(ctx: DriverContext): MountDriver {
  return new QuarkDriver(ctx)
}
