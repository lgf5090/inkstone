/**
 * GuangYaPan driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/guangyapan`.
 * A stored access token wins; when the owner also stored a phone number and a refresh token the
 * token is rotated through the account endpoint. The SMS verification flow is deliberately absent:
 * an owner who has neither token has to supply one out of band.
 */
import { createHash, randomUUID } from 'node:crypto'
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

const ACCOUNT = 'https://account.guangyapan.com'
const API = 'https://api.guangyapan.com'
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50
const ORDER_BY = 3
const SORT_TYPE = 1

interface GypFile {
  fileId: string
  parentId?: string
  fileName: string
  fileSize?: number
  resType: number
  ctime?: number
  utime?: number
}

interface GypToken {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface GypCommon<T> {
  code?: number
  msg?: string
  error?: string
  data?: T
}

function normalizeDeviceId(value: string): string {
  const normalized = value.toLowerCase().replace(/-/g, '')
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : ''
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function parseGypTime(value: number | undefined): number {
  return Number(value) > 0 ? Number(value) * 1000 : 0
}

function fileEntry(file: GypFile): DriverEntry {
  const folder = file.resType === 2
  return {
    name: file.fileName,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : (Number(file.fileSize) || 0),
    modifiedAt: parseGypTime(file.utime || file.ctime),
    ref: file.fileId,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.fileName),
  }
}

function downloadError(status: number): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`GuangYaPan refused the download (HTTP ${status})`)
  if (status === 404) return DriverError.notFound('GuangYaPan returned no download resource (HTTP 404)')
  if (status === 429) return DriverError.rateLimited('GuangYaPan is rate limiting downloads')
  return DriverError.upstream(`GuangYaPan download failed (HTTP ${status})`)
}

export class GuangYaPanDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('guangyapan')!
  readonly capabilities = this.definition.capabilities
  private token: string
  private refreshTokenValue: string
  private readonly deviceId: string
  private readonly deviceSign: string
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.token = String(ctx.credentials.accessToken ?? '').trim()
    this.refreshTokenValue = String(ctx.credentials.refreshToken ?? '').trim()
    const clientId = String(ctx.credentials.clientId ?? '')
    const phone = typeof ctx.config.phoneNumber === 'string' ? ctx.config.phoneNumber : ''
    const seed = `${clientId}${phone}`
    this.deviceId = normalizeDeviceId(String(ctx.credentials.deviceId ?? ''))
      || (seed ? md5(seed) : randomUUID().replace(/-/g, ''))
    this.deviceSign = `wdi10.${this.deviceId}`
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.token) return
    const phone = this.configText('phoneNumber')
    if (phone && this.refreshTokenValue) {
      this.token = await this.refresh()
      return
    }
    throw DriverError.auth(
      'GuangYaPan needs an access token. Add one in the storage settings; the SMS verification flow is not available in this driver.',
    )
  }

  private clientId(): string {
    return String(this.ctx.credentials.clientId ?? '')
  }

  private accountHeaders(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-Device-Model': 'chrome%2F147.0.0.0',
      'X-Device-Name': 'PC-Chrome',
      'X-Device-Sign': this.deviceSign,
      'X-Net-Work-Type': 'NONE',
      'X-OS-Version': 'MacIntel',
      'X-Platform-Version': '1',
      'X-Protocol-Version': '301',
      'X-Provider-Name': 'NONE',
      'X-SDK-Version': '9.0.2',
      'X-Client-Id': this.clientId(),
      'X-Client-Version': '0.0.1',
      'X-Device-Id': this.deviceId,
    }
  }

  private apiHeaders(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Did: this.deviceId,
      Dt: '4',
      Authorization: `Bearer ${this.token}`,
    }
  }

  private async refresh(): Promise<string> {
    const beforeAccess = String(this.ctx.credentials.accessToken ?? '')
    const beforeRefresh = this.refreshTokenValue
    if (!this.clientId()) {
      throw DriverError.auth('GuangYaPan needs a client id to refresh the access token')
    }
    return await singleFlightRefresh(
      this.ctx,
      async () => {
        let payload: GypToken
        try {
          payload = await this.accountPost<GypToken>('/v1/auth/token', {
            client_id: this.clientId(),
            grant_type: 'refresh_token',
            refresh_token: beforeRefresh,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'GuangYaPan rejected the refresh token'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        if (!payload?.access_token) {
          const message = 'GuangYaPan returned no access token while refreshing'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        const patch: Record<string, string> = {
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token || beforeRefresh,
          expiresAt: String(Date.now() + (Number(payload.expires_in) || 3600) * 1000),
        }
        try {
          const effective = await this.ctx.saveCredentials(patch, {
            expect: { accessToken: beforeAccess, refreshToken: beforeRefresh },
          })
          this.token = String(effective.accessToken ?? payload.access_token)
          this.refreshTokenValue = String(effective.refreshToken ?? patch.refreshToken)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'GuangYaPan could not persist the refreshed token'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        return this.token
      },
      async () => {
        await this.ctx.reloadCredentials?.()
        const current = String(this.ctx.credentials.accessToken ?? '')
        const currentRefresh = String(this.ctx.credentials.refreshToken ?? '')
        return current && (current !== beforeAccess || currentRefresh !== beforeRefresh) ? current : null
      },
    )
  }

  private async accountPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.request(`${ACCOUNT}${path}`, {
      method: 'POST',
      headers: this.accountHeaders(),
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null) as (T & { error?: string; error_description?: string }) | null
    if (!payload) throw DriverError.upstream('GuangYaPan returned an unexpected body')
    if (payload.error) {
      throw DriverError.auth(`GuangYaPan token endpoint refused: ${payload.error_description || payload.error}`)
    }
    return payload
  }

  private async api<T>(path: string, body: Record<string, unknown>): Promise<GypCommon<T>> {
    if (!this.token) throw DriverError.auth('GuangYaPan needs an access token')
    const response = await this.request(`${API}${path}`, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null) as GypCommon<T> | null
    if (!payload) throw DriverError.upstream('GuangYaPan returned an unexpected body')
    if (payload.error) throw DriverError.auth(`GuangYaPan refused the request: ${payload.error}`)
    const code = Number(payload.code)
    if (code === 401 || code === 403) throw DriverError.auth(`GuangYaPan refused the access token (code ${code})`)
    if (code === 404) throw DriverError.notFound(`GuangYaPan could not find the resource (code ${code})`)
    if (code === 429) throw DriverError.rateLimited('GuangYaPan is rate limiting requests')
    return payload
  }

  private effectivePath(clean: string): string {
    const prefix = this.configText('rootPath').trim()
    if (!prefix) return clean
    const normalized = driverPath(prefix)
    if (normalized === '/') return clean
    return clean === '/' ? normalized : `${normalized}${clean}`
  }

  private rootId(): string {
    return ''
  }

  private async fileList(parentId: string, page: number, pageSize: number): Promise<{ items: GypFile[]; next: string | null }> {
    const payload = await this.api<{ total?: number; list?: GypFile[] }>('/userres/v1/file/get_file_list', {
      parentId,
      page: page - 1,
      pageSize,
      orderBy: ORDER_BY,
      sortType: SORT_TYPE,
    })
    const items = payload.data?.list ?? []
    const total = Number(payload.data?.total)
    const more = items.length >= pageSize
      || (Number.isFinite(total) && total > 0 && page * pageSize < total)
    return { items, next: more ? String(page + 1) : null }
  }

  private async allFiles(parentId: string): Promise<GypFile[]> {
    const collected = await collectPages(
      async ({ page }) => await this.fileList(parentId, page, PAGE_SIZE),
      { maxPages: MAX_LIST_PAGES },
    )
    return collected.items
  }

  private async resolveFolderId(clean: string): Promise<string> {
    if (clean === '/') return this.rootId()
    const cached = this.pathIds.get(clean)
    if (cached) return cached

    const segments = clean.slice(1).split('/')
    let current = this.rootId()
    let prefix = ''
    for (const segment of segments) {
      const files = await this.allFiles(current)
      const found = files.find((file) => file.resType === 2 && file.fileName === segment)
      if (!found) throw DriverError.notFound(`GuangYaPan could not find ${segment}`)
      current = found.fileId
      prefix = `${prefix}/${segment}`
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveItem(clean: string): Promise<GypFile> {
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    const files = await this.allFiles(parentId)
    const found = files.find((file) => file.fileName === name)
    if (!found) throw DriverError.notFound(`GuangYaPan could not find ${name}`)
    return found
  }

  private async downloadUrl(fileId: string): Promise<string> {
    const payload = await this.api<{ signedURL?: string; downloadUrl?: string }>(
      '/nd.bizuserres.s/v1/get_res_download_url',
      { fileId },
    )
    const url = (payload.data?.signedURL || payload.data?.downloadUrl || '').trim()
    if (!url) throw DriverError.notFound('GuangYaPan returned no download address')
    return url
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const folderId = await this.resolveFolderId(this.effectivePath(clean))
      const pageSize = Math.min(PAGE_SIZE, Math.max(1, options.pageSize ?? PAGE_SIZE))
      const filter = (entries: DriverEntry[]): DriverEntry[] => {
        if (!options.search) return entries
        const needle = options.search.toLowerCase()
        return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      }
      if (options.page !== undefined) {
        const page = await this.fileList(folderId, Math.max(1, options.page), pageSize)
        return {
          entries: filter(page.items.map(fileEntry)),
          cursor: page.next,
          truncated: page.next !== null,
        }
      }
      const collected = await collectPages(
        async ({ page }) => await this.fileList(folderId, page, pageSize),
        { maxPages: MAX_LIST_PAGES },
      )
      return { entries: filter(collected.items.map(fileEntry)), cursor: null, truncated: collected.truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const effective = this.effectivePath(clean)
      if (effective === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
      }
      return fileEntry(await this.resolveItem(effective))
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(this.effectivePath(clean))
      if (file.resType === 2) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = await this.downloadUrl(file.fileId)
      const response = await fetch(url, {
        headers: { ...(range ? { Range: range } : {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw downloadError(response.status)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(this.effectivePath(clean))
      if (file.resType === 2) return null
      try {
        return await this.downloadUrl(file.fileId)
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'not_found') return null
        throw error
      }
    })
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('This GuangYaPan mount is read-only')
  }

  async mkdir(_path: string): Promise<void> {
    throw DriverError.unsupported('This GuangYaPan mount is read-only')
  }

  async rename(_path: string, _newName: string): Promise<void> {
    throw DriverError.unsupported('This GuangYaPan mount is read-only')
  }

  async move(_fromPath: string, _toPath: string): Promise<void> {
    throw DriverError.unsupported('This GuangYaPan mount is read-only')
  }

  async remove(_path: string): Promise<void> {
    throw DriverError.unsupported('This GuangYaPan mount is read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.fileList(this.rootId(), 1, 1)
      return { ok: true, message: 'GuangYaPan is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'GuangYaPan is unavailable' }
    }
  }
}

export function createGuangyapanDriver(ctx: DriverContext): MountDriver {
  return new GuangYaPanDriver(ctx)
}
