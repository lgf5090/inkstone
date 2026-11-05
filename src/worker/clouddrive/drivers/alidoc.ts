/**
 * AliDoc (DingTalk Docs) driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/alidoc`.
 * Directories are `dentryUuid` values, listing answers up to 1000 children per call, and a
 * pre-signed `raw_url` only works when it is fetched with the browser Cookie, Referer and Origin.
 * The reference exposes no upload endpoint, so upload is reported as unsupported instead of
 * pretending a write exists.
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
import { cookieHeader } from './cookies'
import {
  HttpDriverBase,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const API_BASE = 'https://alidocs.dingtalk.com'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const LIST_PAGE_SIZE = 1000
const MAX_PAGE_SIZE = 1000

interface AliDocApiResponse {
  status?: number
  isSuccess?: boolean
  message?: string
  msg?: string
}

interface AliDocDentry {
  dentryType?: string
  dentryUuid?: string
  parentDentryUuid?: string
  name?: string
  path?: string
  fileSize?: number
  createdTime?: number
  updatedTime?: number
  contentType?: string
  extension?: string
}

interface AliDocListResponse extends AliDocApiResponse {
  data?: { children?: AliDocDentry[] }
}

interface AliDocDownloadResponse extends AliDocApiResponse {
  data?: { ossUrlPreSignatureInfo?: { preSignUrls?: string[] } }
}

class AliDocDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('alidoc')!
  readonly capabilities = this.definition.capabilities
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private cookie(): string {
    return cookieHeader((this.ctx.credentials.cookie ?? '').trim())
  }

  private rootId(): string {
    return this.configText('rootFolderId').trim()
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json, text/plain, */*',
      cookie: this.cookie(),
      referer: `${API_BASE}/`,
      origin: API_BASE,
      'user-agent': USER_AGENT,
    }
  }

  protected async login(force: boolean): Promise<void> {
    if (force) this.pathIds.clear()
  }

  private apiError(payload: AliDocApiResponse | null, status: number): DriverError {
    const message = payload?.message || payload?.msg || `AliDoc answered HTTP ${status}`
    const code = payload?.status
    if (status === 401 || status === 403 || code === 401 || code === 403) return DriverError.auth(message)
    if (/\u672a\u767b\u5f55|\u767b\u5f55|login|cookie|\u6388\u6743|\u8fc7\u671f|unauthor|forbidden|token/i.test(message)) return DriverError.auth(message)
    if (/\u4e0d\u5b58\u5728|not found|not exist|\u5df2\u5220\u9664/i.test(message)) return DriverError.notFound(message)
    if (/\u9891\u7e41|\u9650|rate|too many/i.test(message)) return DriverError.rateLimited(message)
    return DriverError.upstream(message)
  }

  private async api<T extends AliDocApiResponse>(
    url: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<T> {
    return await this.withAuth(async () => {
      const cookie = this.cookie()
      if (!cookie) throw DriverError.auth('AliDoc needs a browser Cookie')
      const response = await this.request(url, {
        method,
        headers: {
          ...this.headers(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null) as T | null
      if (!payload || payload.isSuccess === false || (payload.status !== undefined && payload.status !== 200)) {
        throw this.apiError(payload, response.status)
      }
      return payload
    })
  }

  private async listChildren(dentryUuid: string): Promise<AliDocDentry[]> {
    const query = new URLSearchParams({
      dentryUuid,
      withParentAncestors: 'true',
      orderType: 'SORT_KEY',
      sortType: 'desc',
      listDentrySource: '2',
      pageSize: String(LIST_PAGE_SIZE),
    })
    const payload = await this.api<AliDocListResponse>(`${API_BASE}/box/api/v2/dentry/list?${query.toString()}`, 'GET')
    return payload.data?.children ?? []
  }

  private async resolveFolderId(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return this.rootId()
    const cached = this.pathIds.get(clean)
    if (cached) return cached
    let id = this.rootId()
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      prefix = `${prefix}/${segment}`
      const cachedId = this.pathIds.get(prefix)
      if (cachedId) {
        id = cachedId
        continue
      }
      const children = await this.listChildren(id)
      const found = children.find((child) => child.dentryType === 'folder' && child.name === segment)
      if (!found?.dentryUuid) throw DriverError.notFound(`The AliDoc folder does not exist: ${segment}`)
      id = found.dentryUuid
      this.pathIds.set(prefix, id)
    }
    return id
  }

  private async resolveEntryId(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is a folder, not an item')
    const cached = this.pathIds.get(clean)
    if (cached) return cached
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    const children = await this.listChildren(parentId)
    const found = children.find((child) => child.name === name)
    if (!found?.dentryUuid) throw DriverError.notFound(`The AliDoc item does not exist: ${name}`)
    this.pathIds.set(clean, found.dentryUuid)
    return found.dentryUuid
  }

  private async resolveEntry(path: string): Promise<AliDocDentry> {
    const clean = driverPath(path)
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    const children = await this.listChildren(parentId)
    const found = children.find((child) => child.name === name)
    if (!found?.dentryUuid) throw DriverError.notFound(`The AliDoc item does not exist: ${name}`)
    this.pathIds.set(clean, found.dentryUuid)
    return found
  }

  private entryOf(dentry: AliDocDentry): DriverEntry {
    const folder = dentry.dentryType === 'folder'
    const name = dentry.name || 'file'
    return {
      name,
      kind: folder ? 'folder' : 'file',
      size: folder ? 0 : Number(dentry.fileSize) || 0,
      modifiedAt: Number(dentry.updatedTime) || 0,
      ref: dentry.dentryUuid,
      mime: folder ? 'application/octet-stream' : driverEntryMime(name),
    }
  }

  private async downloadUrl(dentryUuid: string): Promise<string> {
    const query = new URLSearchParams({
      dentryUuid,
      version: '1',
      supportDownloadTypes: 'URL_PRE_SIGNATURE,HTTP_TO_CENTER',
      downloadType: 'URL_PRE_SIGNATURE',
    })
    const payload = await this.api<AliDocDownloadResponse>(
      `${API_BASE}/box/api/v2/file/download?${query.toString()}`,
      'GET',
    )
    const url = payload.data?.ossUrlPreSignatureInfo?.preSignUrls?.[0] ?? ''
    if (!url) throw DriverError.upstream('AliDoc returned no download address')
    return url
  }

  private async downloadResult(response: Response, label: string): Promise<Response> {
    if (response.status >= 200 && response.status < 300) return response
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) {
      const message = `${label} refused the download link (HTTP ${response.status})`
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    if (response.status === 404) throw DriverError.notFound(`${label} download failed (HTTP 404)`)
    if (response.status === 429) throw DriverError.rateLimited(`${label} is rate limiting downloads`)
    throw DriverError.upstream(`${label} download failed (HTTP ${response.status})`)
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const id = await this.resolveFolderId(clean)
    const children = await this.listChildren(id)
    let entries = children
      .filter((child) => child.dentryUuid && child.name)
      .map((child) => {
        if (child.dentryUuid && child.name) {
          this.pathIds.set(clean === '/' ? `/${child.name}` : `${clean}/${child.name}`, child.dentryUuid)
        }
        return this.entryOf(child)
      })
    if (options.search) {
      const search = options.search.toLocaleLowerCase()
      entries = entries.filter((entry) => entry.name.toLocaleLowerCase().includes(search))
    }
    // The upstream list answers at most 1000 children, so the driver paginates its single answer.
    const truncated = children.length >= LIST_PAGE_SIZE
    const pageSize = options.pageSize
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize))
      : entries.length
    if (options.page !== undefined && pageSize > 0) {
      const page = Math.max(1, options.page)
      const offset = (page - 1) * pageSize
      const slice = entries.slice(offset, offset + pageSize)
      const more = offset + slice.length < entries.length
      return { entries: slice, cursor: more ? String(offset + slice.length) : null, truncated: truncated || more }
    }
    return { entries, cursor: null, truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
    }
    return this.entryOf(await this.resolveEntry(clean))
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const dentry = await this.resolveEntry(clean)
    if (dentry.dentryType === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    if (!dentry.dentryUuid) throw DriverError.notFound('The AliDoc item has no dentry id')
    const link = await this.downloadUrl(dentry.dentryUuid)
    const headers: Record<string, string> = {
      cookie: this.cookie(),
      referer: `${API_BASE}/`,
      origin: API_BASE,
      'user-agent': USER_AGENT,
    }
    if (range) headers.Range = range
    const response = await fetch(link, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    return await this.downloadResult(response, 'AliDoc')
  }

  async directLink(path: string): Promise<string | null> {
    const dentry = await this.resolveEntry(driverPath(path))
    if (dentry.dentryType === 'folder' || !dentry.dentryUuid) return null
    return await this.downloadUrl(dentry.dentryUuid)
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('AliDoc does not expose a file upload endpoint')
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    await this.api(`${API_BASE}/box/api/v2/dentry/createfolder`, 'POST', {
      dentryType: 'folder',
      name,
      parentDentryUuid: parentId,
      conflictHandleStrategy: 'auto_rename',
    })
    this.pathIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const id = await this.resolveEntryId(clean)
    await this.api(`${API_BASE}/box/api/v2/dentry/rename`, 'POST', {
      dentryUuid: id,
      name: newName,
    })
    this.pathIds.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    if (from === '/') throw DriverError.invalid('The mount root cannot be moved')
    const to = driverPath(toPath)
    const sourceId = await this.resolveEntryId(from)
    const targetName = driverFileName(to)
    const sourceName = driverFileName(from)
    // AliDoc's move keeps the name; a move that changes the name renames first.
    if (targetName !== sourceName) await this.rename(from, targetName)
    const targetParentId = await this.resolveFolderId(driverParentPath(to))
    await this.api(`${API_BASE}/box/api/v2/dentry/move`, 'POST', {
      targetParentDentryUuid: targetParentId,
      sourceDentryUuid: sourceId,
      operateFrom: 1,
    })
    this.pathIds.clear()
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    if (from === '/') throw DriverError.invalid('The mount root cannot be copied')
    const to = driverPath(toPath)
    if (driverFileName(to) !== driverFileName(from)) {
      throw DriverError.unsupported('AliDoc cannot rename an item while copying it')
    }
    const sourceId = await this.resolveEntryId(from)
    const targetParentId = await this.resolveFolderId(driverParentPath(to))
    await this.api(`${API_BASE}/box/api/v2/dentry/copy`, 'POST', {
      sourceDentryUuid: sourceId,
      targetParentDentryUuid: targetParentId,
      operateFrom: 1,
      onlyCopyMeta: false,
    })
    this.pathIds.clear()
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The mount root cannot be removed')
    const id = await this.resolveEntryId(clean)
    await this.api(`${API_BASE}/box/api/v1/dentry/recycle`, 'POST', { dentryUuid: id })
    this.pathIds.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.api<AliDocApiResponse>(`${API_BASE}/portal/api/v1/mine/info`, 'GET')
      return { ok: true, message: 'AliDoc is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'AliDoc is unavailable' }
    }
  }
}

export function createAlidocDriver(ctx: DriverContext): MountDriver {
  return new AliDocDriver(ctx)
}
