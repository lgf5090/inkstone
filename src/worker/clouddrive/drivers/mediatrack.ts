/**
 * MediaTrack asset library driver, Bearer (`access_token`) authenticated.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/mediatrack`: assets live in a project-scoped
 * folder tree (`/v4/assets/<parent>/children`), uploads reserve a COS object through
 * `/v3/storage/tokens/asset` and then register the resulting child, and downloads are resolved
 * through a short-lived token plus its redirect.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import { cloudDriveNameProblem } from '@shared/clouddrive/model'
import {
  DriverError,
  asBytes,
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

const KAYLE = 'https://kayle.api.mediatrack.cn'
const JAYCE = 'https://jayce.api.mediatrack.cn'
const KAYN = 'https://kayn.api.mediatrack.cn'
const PAGE_SIZE = 50
const MAX_PAGES = 50

interface MediatrackAsset {
  id: string
  title: string
  size?: string | number
  created_at?: string
  updated_at?: string
  file?: {
    cover?: string
    src?: string
  }
}

interface MediatrackResponse<T = unknown> {
  status?: string
  message?: string
  data?: T
}

interface MediatrackChildren {
  total?: number
  assets?: MediatrackAsset[]
}

interface MediatrackToken {
  token?: string
  url?: string
}

function isAuthMessage(message: string): boolean {
  return /unauthor|forbidden|auth|login|expired|token|\u767b\u5f55|\u672a\u6388\u6743|\u8fc7\u671f|\u6743\u9650/i.test(message)
}

function payloadError(payload: MediatrackResponse): DriverError {
  const status = String(payload.status ?? '').toUpperCase()
  const message = payload.message || payload.status || 'MediaTrack rejected the request'
  if (['UNAUTHORIZED', 'FORBIDDEN', 'TOKEN_EXPIRED', 'INVALID_TOKEN', 'AUTH_FAILED'].includes(status) || isAuthMessage(message)) {
    return DriverError.auth(`MediaTrack refused the token: ${message}`)
  }
  if (['NOT_FOUND', 'NO_SUCH_ASSET'].includes(status) || /not.?found|\u4e0d\u5b58\u5728/i.test(message)) {
    return DriverError.notFound(message)
  }
  if (['RATE_LIMITED', 'TOO_MANY_REQUESTS'].includes(status) || /rate|too.?many|\u9891\u7e41/i.test(message)) {
    return DriverError.rateLimited(message)
  }
  return DriverError.upstream(message)
}

function throwDownloadStatus(status: number): never {
  if (status === 401 || status === 403) throw DriverError.auth(`The download was refused (HTTP ${status})`)
  if (status === 404) throw DriverError.notFound('The download address was not found (HTTP 404)')
  if (status === 429) throw DriverError.rateLimited('The download was rate limited')
  throw DriverError.upstream(`The download answered HTTP ${status}`)
}

function assetEntry(asset: MediatrackAsset): DriverEntry {
  const folder = !asset.file
  return {
    name: asset.title,
    kind: folder ? 'folder' : 'file',
    size: Number.parseInt(String(asset.size ?? '0'), 10) || 0,
    modifiedAt: Date.parse(asset.updated_at ?? '') || 0,
    ref: asset.id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(asset.title),
  }
}

class MediatrackDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('mediatrack')!
  readonly capabilities = this.definition.capabilities
  private token = ''
  private readonly idCache = new Map<string, string>()

  private projectId(): string {
    return this.configText('projectId').trim()
  }

  private rootId(): string {
    return this.configText('rootFolderId').trim()
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.token) return
    const token = (this.ctx.credentials.accessToken ?? '').trim()
    if (!token) throw DriverError.auth('MediaTrack needs an access token')
    this.token = token
  }

  private async api<T>(url: string, options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}): Promise<T> {
    return await this.withAuth(async () => {
      const response = await this.request(url, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        timeoutMs: 30_000,
      })
      const text = await response.text()
      let payload: MediatrackResponse<T>
      try {
        payload = text ? JSON.parse(text) as MediatrackResponse<T> : {}
      } catch {
        throw DriverError.upstream('MediaTrack returned an unexpected body')
      }
      if (payload.status && payload.status !== 'SUCCESS') throw payloadError(payload)
      return payload.data as T
    })
  }

  private async childrenPage(parentId: string, page: number, size: number): Promise<MediatrackAsset[]> {
    const url = `${JAYCE}/v4/assets/${encodeURIComponent(parentId)}/children`
      + `?${new URLSearchParams({ page: String(page), size: String(size) }).toString()}`
    const data = await this.api<MediatrackChildren>(url)
    return data?.assets ?? []
  }

  private async allChildren(parentId: string): Promise<MediatrackAsset[]> {
    const collected = await collectPages(async ({ page }) => {
      const items = await this.childrenPage(parentId, page, PAGE_SIZE)
      return { items, next: items.length >= PAGE_SIZE ? String(page + 1) : null }
    }, { maxPages: MAX_PAGES })
    return collected.items
  }

  private async resolveId(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return this.rootId()
    const cached = this.idCache.get(clean)
    if (cached) return cached
    let current = this.rootId()
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      const children = await this.allChildren(current)
      const hit = children.find((asset) => asset.title === segment && !asset.file)
      if (!hit) throw DriverError.notFound(`Folder not found: ${segment}`)
      current = hit.id
      prefix = `${prefix}/${segment}`
      this.idCache.set(prefix, current)
    }
    return current
  }

  private async resolveEntry(path: string): Promise<{ asset: MediatrackAsset; parentId: string }> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const name = driverFileName(clean)
    const parentId = await this.resolveId(driverParentPath(clean))
    const children = await this.allChildren(parentId)
    const asset = children.find((child) => child.title === name)
    if (!asset) throw DriverError.notFound(`Not found: ${name}`)
    return { asset, parentId }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const parentId = await this.resolveId(path)
    const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE)
    if (options.page !== undefined) {
      const assets = await this.childrenPage(parentId, Math.max(1, options.page), pageSize)
      return {
        entries: assets.map(assetEntry),
        cursor: assets.length >= pageSize ? String(Math.max(1, options.page) + 1) : null,
        truncated: assets.length >= pageSize,
      }
    }
    const collected = await collectPages(async ({ page }) => {
      const assets = await this.childrenPage(parentId, page, pageSize)
      return { items: assets.map(assetEntry), next: assets.length >= pageSize ? String(page + 1) : null }
    }, { maxPages: MAX_PAGES })
    return { entries: collected.items, cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: '/', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId(), mime: 'application/octet-stream' }
    }
    const { asset } = await this.resolveEntry(clean)
    return assetEntry(asset)
  }

  private async downloadLink(assetId: string): Promise<string> {
    const tokenUrl = `${KAYN}/v1/download_token/asset?${new URLSearchParams({
      asset_id: assetId,
      source_type: 'project',
      password: '',
      source_id: this.projectId(),
    }).toString()}`
    const data = await this.api<MediatrackToken>(tokenUrl)
    const token = data?.token
    if (!token) throw DriverError.upstream(`MediaTrack returned no download token for ${assetId}`)
    const redirectUrl = `${KAYN}/v1/download/redirect?token=${encodeURIComponent(token)}`
    const response = await fetch(redirectUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined)
      return location
    }
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) throwDownloadStatus(response.status)
    return redirectUrl
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const { asset } = await this.resolveEntry(path)
    if (!asset.file) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadLink(asset.id)
    const response = await fetch(link, {
      method: 'GET',
      redirect: 'follow',
      headers: range ? { Range: range } : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throwDownloadStatus(response.status)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const { asset } = await this.resolveEntry(path)
    if (!asset.file) return null
    return await this.downloadLink(asset.id)
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const fileName = driverFileName(clean)
    if (!fileName) throw DriverError.invalid('A file name is required')
    const parentId = await this.resolveId(driverParentPath(clean))
    const srcKey = `assets/${crypto.randomUUID()}`
    const tokenUrl = `${JAYCE}/v3/storage/tokens/asset?${new URLSearchParams({ src: srcKey }).toString()}`
    const upload = await this.api<MediatrackToken>(tokenUrl)
    const cosUrl = upload?.url
    if (!cosUrl) throw DriverError.upstream('MediaTrack returned no upload address')
    const response = await fetch(cosUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(bytes.byteLength) },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`MediaTrack upload failed (HTTP ${response.status})`)
    }
    await this.api(`${JAYCE}/v3/assets/${encodeURIComponent(parentId)}/children`, {
      method: 'POST',
      body: {
        category: 0,
        description: fileName,
        mime: options.contentType || 'application/octet-stream',
        size: String(bytes.byteLength),
        src: srcKey,
        title: fileName,
        type: 0,
      },
    })
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveId(driverParentPath(clean))
    await this.api(`${JAYCE}/v3/assets/${encodeURIComponent(parentId)}/children`, {
      method: 'POST',
      body: { type: 1, title: driverFileName(clean) },
    })
    this.idCache.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const problem = cloudDriveNameProblem(newName)
    if (problem) throw DriverError.invalid(problem)
    const { asset } = await this.resolveEntry(path)
    await this.api(`${JAYCE}/v3/assets/${encodeURIComponent(asset.id)}`, {
      method: 'PUT',
      body: { title: newName },
    })
    this.idCache.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const source = driverPath(fromPath)
    const target = driverPath(toPath)
    const { asset } = await this.resolveEntry(source)
    const targetName = driverFileName(target)
    if (targetName !== asset.title) await this.rename(source, targetName)
    const targetParentId = await this.resolveId(driverParentPath(target))
    await this.api(`${JAYCE}/v4/assets/batch/move`, {
      method: 'POST',
      body: { parent_id: targetParentId, ids: [asset.id] },
    })
    this.idCache.clear()
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const source = driverPath(fromPath)
    const target = driverPath(toPath)
    const { asset } = await this.resolveEntry(source)
    const targetParentId = await this.resolveId(driverParentPath(target))
    await this.api(`${JAYCE}/v4/assets/batch/clone`, {
      method: 'POST',
      body: { parent_id: targetParentId, ids: [asset.id] },
    })
    this.idCache.clear()
  }

  async remove(path: string): Promise<void> {
    const { asset, parentId } = await this.resolveEntry(path)
    await this.api(`${JAYCE}/v4/assets/batch/delete`, {
      method: 'DELETE',
      body: { origin_id: parentId, ids: [asset.id] },
    })
    this.idCache.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.api(`${KAYLE}/users`)
      return { ok: true, message: 'MediaTrack is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'MediaTrack is unavailable' }
    }
  }
}

export function createMediatrackDriver(ctx: DriverContext): MountDriver {
  return new MediatrackDriver(ctx)
}
