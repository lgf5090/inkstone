/**
 * Quark / UC TV Cloud Drive driver (read-only).
 *
 * Ported from `OpenList-Worker/src/backend/drivers/quark_uc_tv`: the TV API signs every request
 * (`x-pan-tm`, `x-pan-token`, `x-pan-client-id`), exchanges a long-lived refresh token for a short
 * access token at `codeApi/token`, and resolves a file either through `method=download` or
 * `method=streaming`. It never exposes write endpoints.
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

const USER_AGENT =
  'Mozilla/5.0 (Linux; U; Android 13; zh-cn; M2004J7AC Build/UKQ1.231108.001) AppleWebKit/533.1 (KHTML, like Gecko) Mobile Safari/533.1'
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50
const DEVICE_BRAND = 'Xiaomi'
const PLATFORM = 'tv'
const DEVICE_NAME = 'M2004J7AC'
const DEVICE_MODEL = 'M2004J7AC'
const BUILD_DEVICE = 'M2004J7AC'
const BUILD_PRODUCT = 'M2004J7AC'
const DEVICE_GPU = 'Adreno (TM) 550'
const ACTIVITY_RECT = '{}'

interface TvConf {
  api: string
  clientId: string
  signKey: string
  appVer: string
  channel: string
  codeApi: string
}

const CONFS: Record<'quark' | 'uc', TvConf> = {
  quark: {
    api: 'https://open-api-drive.quark.cn',
    clientId: 'd3194e61504e493eb6222857bccfed94',
    signKey: 'kw2dvtd7p4t3pjl2d9ed9yc8yej8kw2d',
    appVer: '1.8.2.2',
    channel: 'GENERAL',
    codeApi: 'http://api.extscreen.com/quarkdrive',
  },
  uc: {
    api: 'https://open-api-drive.uc.cn',
    clientId: '5acf882d27b74502b7040b0c65519aa7',
    signKey: 'l3srvtd7p42l0d0x1u8d7yc8ye9kki4d',
    appVer: '1.7.2.2',
    channel: 'UCTVOFFICIALWEB',
    codeApi: 'http://api.extscreen.com/ucdrive',
  },
}

interface TvFile {
  fid: string
  filename: string
  size?: number
  isdir?: number
  updated_at?: number
  thumbnail_url?: string
}

interface TvCommonResponse {
  status?: number
  errno?: number
  error_info?: string
  data?: unknown
}

interface TvFilesData {
  total_count?: number
  files?: TvFile[]
}

interface TvDownloadData {
  download_url?: string
}

interface TvStreamingData {
  video_info?: { url?: string }[]
}

function hash(algo: 'md5' | 'sha256', value: string): string {
  return createHash(algo).update(value).digest('hex')
}

function modifiedAt(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 0
  return value < 1e12 ? value * 1000 : value
}

function fileEntry(file: TvFile): DriverEntry {
  const folder = file.isdir === 1
  return {
    name: file.filename,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: modifiedAt(file.updated_at),
    ref: file.fid,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.filename),
  }
}

class QuarkUcTvDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('quark_uc_tv')!
  readonly capabilities = this.definition.capabilities
  private readonly conf: TvConf
  private readonly deviceId: string
  private readonly linkMethod: string
  private accessToken = ''
  private refreshTokenValue = ''
  private pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    const variant = this.configText('variant', 'quark').trim().toLowerCase()
    this.conf = variant === 'uc' ? CONFS.uc : CONFS.quark
    this.deviceId = this.configText('deviceId', '').trim() || hash('md5', String(Date.now()))
    this.linkMethod = this.configText('linkMethod', 'download').trim() || 'download'
  }

  protected async login(): Promise<void> {
    const refreshToken = this.ctx.credentials.refreshToken ?? ''
    if (!refreshToken.trim()) {
      const message = 'Quark TV needs a refresh token'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    this.refreshTokenValue = refreshToken
    try {
      await this.refreshAccessToken()
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      throw error
    }
  }

  private deviceQuery(): Record<string, string> {
    return {
      app_ver: this.conf.appVer,
      device_id: this.deviceId,
      device_brand: DEVICE_BRAND,
      platform: PLATFORM,
      device_name: DEVICE_NAME,
      device_model: DEVICE_MODEL,
      build_device: BUILD_DEVICE,
      build_product: BUILD_PRODUCT,
      device_gpu: DEVICE_GPU,
      activity_rect: ACTIVITY_RECT,
      channel: this.conf.channel,
    }
  }

  private sign(method: string): { tm: string; token: string; reqId: string } {
    const tm = String(Date.now())
    return {
      tm,
      token: hash('sha256', `${method}&/token&${tm}&${this.conf.signKey}`),
      reqId: hash('md5', this.deviceId + tm),
    }
  }

  private requestSign(method: string, pathname: string): { tm: string; token: string; reqId: string } {
    const tm = String(Date.now())
    return {
      tm,
      token: hash('sha256', `${method}&${pathname}&${tm}&${this.conf.signKey}`),
      reqId: hash('md5', this.deviceId + tm),
    }
  }

  private async refreshAccessToken(): Promise<void> {
    const { reqId } = this.sign('POST')
    let response: Response
    try {
      response = await fetch(`${this.conf.codeApi}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ req_id: reqId, ...this.deviceQuery(), refresh_token: this.refreshTokenValue }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw DriverError.upstream(`Quark TV token refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const payload = await response.json().catch(() => null) as {
      code?: number
      message?: string
      data?: { access_token?: string; refresh_token?: string }
    } | null
    if (!response.ok || !payload || payload.code !== 200 || !payload.data?.access_token) {
      throw DriverError.auth(
        `Quark TV token refresh failed (${payload?.message ?? `HTTP ${response.status}`})`,
      )
    }
    this.accessToken = payload.data.access_token
    if (payload.data.refresh_token && payload.data.refresh_token !== this.refreshTokenValue) {
      this.refreshTokenValue = payload.data.refresh_token
      await this.saveCredential({ refreshToken: this.refreshTokenValue })
    }
  }

  /**
   * One signed TV call. The body can invalidate the access token (`errno 10001/11001`); that is
   * retried exactly once after a refresh, and a second failure is handed to `withAuth`.
   */
  private async api<T>(
    pathname: string,
    method: string,
    extraQuery: Record<string, string> = {},
    retryOnToken = true,
  ): Promise<T> {
    const { tm, token, reqId } = this.requestSign(method, pathname)
    const query = new URLSearchParams({
      req_id: reqId,
      access_token: this.accessToken,
      ...this.deviceQuery(),
      ...extraQuery,
    })
    let response: Response
    try {
      response = await fetch(`${this.conf.api}${pathname}?${query.toString()}`, {
        method,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': USER_AGENT,
          'x-pan-tm': tm,
          'x-pan-token': token,
          'x-pan-client-id': this.conf.clientId,
        },
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw DriverError.upstream(`Quark TV could not be reached: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      if ((response.status === 401 || response.status === 403) && retryOnToken) {
        await this.refreshAccessToken()
        return await this.api<T>(pathname, method, extraQuery, false)
      }
      if (response.status === 401 || response.status === 403) throw DriverError.auth('Quark TV refused the access token')
      if (response.status === 404) throw DriverError.notFound('Not found upstream (HTTP 404)')
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after'))
        throw DriverError.rateLimited('Quark TV is rate limiting requests', Number.isFinite(retry) ? retry * 1000 : undefined)
      }
      throw DriverError.upstream(`Quark TV answered HTTP ${response.status}`)
    }
    const payload = await response.json().catch(() => null) as TvCommonResponse | null
    if (!payload) throw DriverError.upstream('Quark TV returned a body that is not JSON')
    const status = Number(payload.status ?? 0)
    const errno = Number(payload.errno ?? 0)
    const info = payload.error_info ?? ''
    const lower = info.toLocaleLowerCase()
    const tokenInvalid = (status === -1 && (errno === 10001 || errno === 11001))
      || lower.includes('access token')
      || lower.includes('access_token')
      || lower.includes('token\u65e0\u6548')
      || lower.includes('token \u65e0\u6548')
    if (tokenInvalid) {
      if (!retryOnToken) throw DriverError.auth(info || 'Quark TV authorization expired')
      await this.refreshAccessToken()
      return await this.api<T>(pathname, method, extraQuery, false)
    }
    if (status >= 400 || errno !== 0) {
      const message = info || `Quark TV answered errno ${errno}`
      if (status === 401 || status === 403 || errno === 401 || errno === 403) throw DriverError.auth(message)
      if (status === 429 || errno === 429) throw DriverError.rateLimited(message)
      if (status === 404 || errno === 404) throw DriverError.notFound(message)
      throw DriverError.upstream(message)
    }
    return payload as T
  }

  private async listPage(
    folderId: string,
    pageIndex: number,
    pageSize: number,
  ): Promise<{ files: TvFile[]; next: string | null }> {
    const response = await this.api<TvCommonResponse>('/file', 'GET', {
      method: 'list',
      parent_fid: folderId,
      order_by: '3',
      desc: '1',
      category: '',
      source: '',
      ex_source: '',
      list_all: '0',
      page_size: String(pageSize),
      page_index: String(pageIndex),
    })
    const data = response.data as TvFilesData | undefined
    const files = data?.files ?? []
    const total = Number(data?.total_count) || 0
    const hasMore = files.length >= pageSize && (total === 0 || (pageIndex + 1) * pageSize < total)
    return { files, next: hasMore ? String(pageIndex + 2) : null }
  }

  private async listAll(folderId: string): Promise<{ files: TvFile[]; truncated: boolean }> {
    const files: TvFile[] = []
    for (let pageIndex = 0; pageIndex < MAX_LIST_PAGES; pageIndex++) {
      const result = await this.listPage(folderId, pageIndex, PAGE_SIZE)
      files.push(...result.files)
      if (result.next === null) return { files, truncated: false }
    }
    return { files, truncated: true }
  }

  private async resolveFolderId(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return '0'
    const segments = clean.split('/').filter(Boolean)
    let parent = '0'
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        parent = cached
        continue
      }
      const listed = await this.listAll(parent)
      const found = listed.files.find((file) => file.isdir === 1 && file.filename === segment)
      if (!found) throw DriverError.notFound(`Folder not found: ${segment}`)
      parent = found.fid
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async findChild(parentId: string, name: string): Promise<TvFile | null> {
    const listed = await this.listAll(parentId)
    return listed.files.find((file) => file.filename === name) ?? null
  }

  private async resolveEntry(path: string): Promise<{ entry: DriverEntry; fid: string; folder: boolean }> {
    const clean = driverPath(path)
    if (clean === '/') {
      return {
        entry: { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '0' },
        fid: '0',
        folder: true,
      }
    }
    const name = driverFileName(clean)
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const found = await this.findChild(parentId, name)
    if (found) return { entry: fileEntry(found), fid: found.fid, folder: found.isdir === 1 }
    const folderId = await this.resolveFolderId(clean)
    return { entry: { name, kind: 'folder', size: 0, modifiedAt: 0, ref: folderId }, fid: folderId, folder: true }
  }

  private async downloadUrl(fid: string): Promise<string> {
    if (this.linkMethod === 'streaming') {
      const response = await this.api<TvCommonResponse>('/file', 'GET', {
        method: 'streaming',
        group_by: 'source',
        fid,
        resolution: 'low,normal,high,super,2k,4k',
        support: 'dolby_vision',
      })
      const data = response.data as TvStreamingData | undefined
      const url = data?.video_info?.find((video) => video.url)?.url ?? ''
      if (!url) throw DriverError.upstream('Quark TV returned no streaming link')
      return url
    }
    const response = await this.api<TvCommonResponse>('/file', 'GET', {
      method: 'download',
      group_by: 'source',
      fid,
      resolution: 'low,normal,high,super,2k,4k',
      support: 'dolby_vision',
    })
    const data = response.data as TvDownloadData | undefined
    if (!data?.download_url) throw DriverError.upstream('Quark TV returned no download address')
    return data.download_url
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const folderId = await this.resolveFolderId(clean)
      const pageSize = Math.min(PAGE_SIZE, Math.max(1, options.pageSize ?? PAGE_SIZE))
      if (options.search) {
        const listed = await this.listAll(folderId)
        const needle = options.search.toLocaleLowerCase()
        const filtered = listed.files.filter((file) => file.filename.toLocaleLowerCase().includes(needle))
        const page = Math.max(1, options.page ?? 1)
        const entries = filtered.slice((page - 1) * pageSize, page * pageSize).map(fileEntry)
        const cursor = page * pageSize < filtered.length ? String(page + 1) : null
        return { entries, cursor, truncated: cursor !== null || listed.truncated }
      }
      if (options.page !== undefined) {
        const page = Math.max(1, options.page)
        const result = await this.listPage(folderId, page - 1, pageSize)
        return { entries: result.files.map(fileEntry), cursor: result.next, truncated: result.next !== null }
      }
      const collected = await collectPages(async ({ page }) => {
        const result = await this.listPage(folderId, page - 1, pageSize)
        return { items: result.files, next: result.next === null ? null : 'more' }
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
          'User-Agent': USER_AGENT,
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        if (response.status === 401 || response.status === 403) throw DriverError.auth('Quark TV refused the download')
        throw DriverError.upstream(`Quark TV download failed (HTTP ${response.status})`)
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
    throw DriverError.unsupported('Quark TV is a read-only storage')
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Quark TV is a read-only storage')
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Quark TV is a read-only storage')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('Quark TV is a read-only storage')
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Quark TV is a read-only storage')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.listPage('0', 0, 1)
      return { ok: true, message: 'Quark TV Drive is reachable' }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      return { ok: false, message: error instanceof Error ? error.message : 'Quark TV is unavailable' }
    }
  }
}

export function createQuarkUcTvDriver(ctx: DriverContext): MountDriver {
  return new QuarkUcTvDriver(ctx)
}
