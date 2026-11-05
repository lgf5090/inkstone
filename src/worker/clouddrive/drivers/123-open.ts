/**
 * 123 Cloud Drive open-platform driver.
 *
 * Ported from the reference at `OpenList-Worker/src/backend/drivers/123_open` and the upstream
 * OpenList Go driver. Authentication is a bearer token obtained from `client_id`/`client_secret`
 * (or an existing token); listings page by `lastFileId`; uploads create a session and POST every
 * slice as multipart form data before completing it.
 */
import { createHash } from 'node:crypto'
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
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
import { singleFlightRefresh } from './token'

const API = 'https://open-api.123pan.com'
const PAGE_LIMIT = 100
const MAX_LIST_PAGES = 50
const UPLOAD_COMPLETE_ATTEMPTS = 3

interface Open123File {
  fileId?: number | string
  filename?: string
  size?: number
  type?: number
  updateAt?: string
  update_at?: string
  etag?: string
  trashed?: number
}

interface Open123ListData {
  lastFileId?: number
  last_file_id?: number
  fileList?: Open123File[]
  file_list?: Open123File[]
}

interface Open123Envelope<T> {
  code?: number
  message?: string
  data?: T
}

interface Open123UploadCreate {
  fileID?: number
  preuploadID?: string
  reuse?: boolean
  sliceSize?: number
  servers?: string[]
}

function modifiedAt(value?: string): number {
  if (!value) return 0
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}+08:00`
  return Date.parse(iso) || 0
}

function entryOf(file: Open123File): DriverEntry {
  const folder = file.type === 1
  const name = file.filename ?? ''
  return {
    name,
    kind: folder ? 'folder' : 'file',
    size: Number(file.size) || 0,
    modifiedAt: modifiedAt(file.updateAt ?? file.update_at),
    ref: file.fileId === undefined ? undefined : String(file.fileId),
    mime: folder ? 'application/octet-stream' : driverEntryMime(name),
  }
}

function mapCode(code: number, message?: string): DriverError {
  const suffix = message ? `: ${message}` : ''
  if (code === 401 || code === 403) return DriverError.auth(`123 Open refused the credentials (code ${code}${suffix})`)
  if (code === 404) return DriverError.notFound(`123 Open could not find the item (code ${code}${suffix})`)
  if (code === 429) return DriverError.rateLimited(`123 Open is rate limiting requests${suffix}`)
  return DriverError.upstream(`123 Open answered code ${code}${suffix}`)
}

export class Open123Driver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('123_open')!
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

  protected async login(force: boolean): Promise<void> {
    this.token = await this.accessToken(force)
  }

  private async accessToken(force: boolean): Promise<string> {
    const existing = this.credential('accessToken')
    if (!force && existing) return existing
    const clientId = this.credential('clientId')
    const clientSecret = this.credential('clientSecret')
    if (!clientId || !clientSecret) {
      const message = '123 Open needs a client id and secret to obtain or refresh an access token'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    return await this.fetchToken(clientId, clientSecret)
  }

  private async fetchToken(clientId: string, clientSecret: string): Promise<string> {
    const previous = {
      accessToken: this.credential('accessToken'),
      refreshToken: this.credential('refreshToken'),
    }
    try {
      return await singleFlightRefresh(
        this.ctx,
        async () => {
          const response = await fetch(`${API}/api/v1/access_token`, {
            method: 'POST',
            headers: { platform: 'open_platform', 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientID: clientId, clientSecret }),
            signal: AbortSignal.timeout(20_000),
          })
          if (response.status === 429) throw DriverError.rateLimited('The 123 Open token endpoint is rate limiting requests')
          if (!response.ok) throw DriverError.auth(`The 123 Open token endpoint refused the credentials (HTTP ${response.status})`)
          const payload = await response.json().catch(() => null) as Open123Envelope<{ access_token?: string; expired_at?: string }> | null
          if (Number(payload?.code) !== 0 || !payload?.data?.access_token) {
            throw DriverError.auth(payload?.message || 'The 123 Open token endpoint returned no access token')
          }
          const patch: Record<string, string> = { accessToken: payload.data.access_token }
          if (payload.data.expired_at) {
            const expires = Date.parse(payload.data.expired_at)
            if (Number.isFinite(expires)) patch.expiresAt = String(expires)
          }
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
      if (error instanceof DriverError && (error.kind === 'rate_limit' || error.kind === 'upstream')) throw error
      const message = error instanceof Error ? error.message : '123 Open could not refresh the access token'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
  }

  private async api<T>(url: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
    await this.authenticate(false)
    return await this.withAuth(async () => {
      const response = await this.request(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          platform: 'open_platform',
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json() as Open123Envelope<T>
      const code = Number(payload.code)
      if (code !== 0) throw mapCode(code, payload.message)
      return payload.data as T
    })
  }

  private async listChunk(parentId: string, lastFileId: string, pageSize: number, search = ''): Promise<{ files: Open123File[]; next: string | null }> {
    const query = new URLSearchParams({
      parentFileId: parentId,
      limit: String(Math.min(PAGE_LIMIT, Math.max(1, pageSize))),
      lastFileId,
      trashed: 'false',
      searchMode: search ? '1' : '',
      searchData: search,
    })
    const data = await this.api<Open123ListData>(`${API}/api/v2/file/list?${query.toString()}`)
    const raw = data?.fileList ?? data?.file_list ?? []
    const files = raw.filter((file) => (file.trashed ?? 0) === 0)
    const nextId = Number(data?.lastFileId ?? data?.last_file_id ?? -1)
    return { files, next: nextId === -1 ? null : String(nextId) }
  }

  private async listPage(parentId: string, pageNumber: number, pageSize: number, search: string): Promise<{ files: Open123File[]; next: string | null }> {
    let cursor = '0'
    for (let current = 1; current <= Math.max(1, pageNumber); current++) {
      const result = await this.listChunk(parentId, cursor, pageSize, search)
      if (current === pageNumber) return result
      if (result.next === null) return { files: [], next: null }
      cursor = result.next
      if (current >= MAX_LIST_PAGES) break
    }
    return { files: [], next: null }
  }

  private async findChild(parentId: string, name: string, folder: boolean | null = null): Promise<Open123File | null> {
    let cursor = '0'
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const result = await this.listChunk(parentId, cursor, PAGE_LIMIT)
      const hit = result.files.find((file) => {
        if (file.filename !== name) return false
        return folder === null || file.type === (folder ? 1 : 2)
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
      parent = String(folder.fileId)
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveEntry(path: string): Promise<Open123File> {
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
      const page = await this.listPage(parentId, Math.max(1, options.page), pageSize, options.search ?? '')
      return { entries: page.files.map(entryOf), cursor: page.next, truncated: page.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const chunk = await this.listChunk(parentId, cursor ?? '0', pageSize, options.search ?? '')
      return { items: chunk.files, next: chunk.next }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    return { entries: collected.items.map(entryOf), cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: this.rootId(), kind: 'folder', size: 0, modifiedAt: 0, ref: this.rootId() }
    }
    return entryOf(await this.resolveEntry(clean))
  }

  private async downloadUrl(file: Open123File): Promise<string> {
    const data = await this.api<{ downloadUrl?: string; download_url?: string }>(
      `${API}/api/v1/file/download_info?fileId=${encodeURIComponent(String(file.fileId))}`,
    )
    const url = data?.downloadUrl ?? data?.download_url ?? ''
    if (!url) throw DriverError.upstream('123 Open returned no download address')
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const file = await this.resolveEntry(path)
    const url = await this.downloadUrl(file)
    const response = await fetch(url, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`123 Open download failed (HTTP ${response.status})`)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') return null
    return await this.downloadUrl(await this.resolveEntry(path))
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const name = driverFileName(clean)
    const parentId = await this.resolveDir(driverParentPath(clean))
    const etag = createHash('md5').update(bytes).digest('hex')
    const create = await this.api<Open123UploadCreate>(`${API}/upload/v2/file/create`, 'POST', {
      parentFileId: Number(parentId) || 0,
      filename: name,
      etag,
      size: bytes.byteLength,
      duplicate: 2,
      containDir: false,
    })
    if (create?.reuse) {
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    const preuploadID = create?.preuploadID
    if (!preuploadID) throw DriverError.upstream('123 Open returned no preupload id')
    const sliceSize = Number(create?.sliceSize) || 0
    const servers = create?.servers ?? []
    if (sliceSize <= 0) throw DriverError.upstream('123 Open returned no slice size')
    const total = Math.max(1, Math.ceil(bytes.byteLength / sliceSize))
    for (let part = 1; part <= total; part++) {
      const start = (part - 1) * sliceSize
      const end = Math.min(start + sliceSize, bytes.byteLength)
      const slice = new Uint8Array(bytes.subarray(start, end))
      const form = new FormData()
      form.set('preuploadID', preuploadID)
      form.set('sliceNo', String(part))
      form.set('sliceMD5', createHash('md5').update(slice).digest('hex'))
      form.set('slice', new Blob([slice]), `${name}.part${part}`)
      const url = `${servers[0] ?? API}/upload/v2/file/slice`
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, platform: 'open_platform' },
        body: form,
        signal: AbortSignal.timeout(120_000),
      })
      const payload = await response.json().catch(() => null) as Open123Envelope<unknown> | null
      if (!response.ok) throw DriverError.upstream(`123 Open rejected upload slice ${part}/${total} (HTTP ${response.status})`)
      if (Number(payload?.code) !== 0) throw mapCode(Number(payload?.code), payload?.message)
      options.onProgress?.(end, bytes.byteLength)
    }
    for (let attempt = 0; attempt < UPLOAD_COMPLETE_ATTEMPTS; attempt++) {
      const result = await this.api<{ completed?: boolean; fileID?: number }>(
        `${API}/upload/v2/file/upload_complete`,
        'POST',
        { preuploadID },
      )
      if (result?.completed) return
      if (attempt < UPLOAD_COMPLETE_ATTEMPTS - 1) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw DriverError.upstream('123 Open did not confirm the upload')
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveDir(driverParentPath(clean))
    await this.api(`${API}/upload/v1/file/mkdir`, 'POST', { parentID: parentId, name: driverFileName(clean) })
  }

  async rename(path: string, newName: string): Promise<void> {
    const entry = await this.resolveEntry(path)
    await this.api(`${API}/api/v1/file/name`, 'PUT', { fileId: Number(entry.fileId) || entry.fileId, fileName: newName })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const entry = await this.resolveEntry(from)
    const targetName = driverFileName(to)
    if (targetName !== driverFileName(from)) await this.rename(from, targetName)
    const parentId = await this.resolveDir(driverParentPath(to))
    await this.api(`${API}/api/v1/file/move`, 'POST', {
      fileIDs: [Number(entry.fileId) || entry.fileId],
      toParentFileID: Number(parentId) || parentId,
    })
  }

  async remove(path: string): Promise<void> {
    const entry = await this.resolveEntry(path)
    await this.api(`${API}/api/v1/file/trash`, 'POST', { fileIDs: [Number(entry.fileId) || entry.fileId] })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const info = await this.api<Record<string, unknown>>(`${API}/api/v1/user/info`)
      const name = typeof info?.nickname === 'string' ? info.nickname : ''
      return { ok: true, message: `123 Open is reachable${name ? ` · ${name}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '123 Open is unavailable' }
    }
  }
}

export function create123OpenDriver(ctx: DriverContext): MountDriver {
  return new Open123Driver(ctx)
}
