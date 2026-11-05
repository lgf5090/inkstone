/**
 * Google Drive driver.
 *
 * Drive has no path API: a folder is found by querying children of its parent for the exact name.
 * Downloads stream through `files/{id}?alt=media`, and uploads use the multipart endpoint below
 * 5 MiB or a resumable session above it. Google issues no durable anonymous download address, so the
 * driver does not claim `directLink` and every read is proxied.
 */
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
import { OAuthSession } from './token'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FIELDS = 'id,name,mimeType,size,modifiedTime,parents'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FILES_PAGE = 100
const MAX_LIST_PAGES = 50
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024
const UPLOAD_CHUNK = 8 * 1024 * 1024

interface DriveFile {
  id: string
  name: string
  mimeType?: string
  size?: string
  modifiedTime?: string
  parents?: string[]
}

interface DriveList {
  files?: DriveFile[]
  nextPageToken?: string
}

function fileEntry(file: DriveFile): DriverEntry {
  const folder = file.mimeType === FOLDER_MIME
  return {
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: Number(file.size) || 0,
    modifiedAt: file.modifiedTime ? Date.parse(file.modifiedTime) : 0,
    ref: file.id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.name),
  }
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/')
}

export class GoogleDriveDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('google_drive')!
  readonly capabilities = this.definition.capabilities
  private readonly session = new OAuthSession(this.ctx, 'google_drive')
  private readonly rootId: string
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.rootId = String(ctx.config.folderId ?? '').trim() || 'root'
  }

  protected async login(force: boolean): Promise<void> {
    const token = await this.session.token(force)
    const response = await this.request(`${API}/about?fields=user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    const payload = await response.json() as { user?: { displayName?: string } }
    if (!payload.user) throw DriverError.auth('Google Drive did not confirm the account')
  }

  private async api<T>(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    return await this.session.withToken(async (token) => {
      const response = await this.request(url, {
        method: (init.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers ?? {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
      if (response.status === 204) return undefined as T
      return await response.json() as T
    })
  }

  private async findChild(parentId: string, name: string): Promise<DriveFile | null> {
    const query = `'${parentId}' in parents and name = '${escapeQuery(name)}' and trashed = false`
    const payload = await this.api<DriveList>(
      `${API}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(`files(${FIELDS})`)}&pageSize=2`,
    )
    return payload.files?.[0] ?? null
  }

  private async resolveFolderId(path: string, create = false): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return this.rootId
    const segments = clean.split('/').filter(Boolean)
    let parent = this.rootId
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        parent = cached
        continue
      }
      const found = await this.findChild(parent, segment)
      if (!found) {
        if (!create) throw DriverError.notFound(`Google Drive folder not found: ${segment}`)
        await this.mkdir(prefix)
        const created = await this.findChild(parent, segment)
        if (!created) throw DriverError.upstream(`Google Drive could not create ${segment}`)
        parent = created.id
      } else {
        parent = found.id
      }
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveFile(path: string): Promise<DriveFile> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const found = await this.findChild(parentId, driverFileName(clean))
    if (!found) throw DriverError.notFound(`Google Drive file not found: ${clean}`)
    return found
  }

  private async page(parentId: string, pageNumber: number, pageSize: number, search: string): Promise<{ files: DriveFile[]; next: string | null }> {
    let query = `'${parentId}' in parents and trashed = false`
    if (search) query += ` and name contains '${escapeQuery(search)}'`
    let token: string | null = null
    let current = 1
    for (;;) {
      const params = new URLSearchParams({
        q: query,
        fields: `nextPageToken, files(${FIELDS})`,
        pageSize: String(Math.min(FILES_PAGE, Math.max(1, pageSize))),
        orderBy: 'name',
      })
      if (token) params.set('pageToken', token)
      const payload = await this.api<DriveList>(`${API}/files?${params.toString()}`)
      if (current === pageNumber) return { files: payload.files ?? [], next: payload.nextPageToken ?? null }
      if (!payload.nextPageToken) return { files: [], next: null }
      token = payload.nextPageToken
      current++
      if (current > MAX_LIST_PAGES) break
    }
    return { files: [], next: null }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const folderId = await this.resolveFolderId(driverPath(path))
    const pageSize = options.pageSize ?? FILES_PAGE
    if (options.page !== undefined) {
      const result = await this.page(folderId, Math.max(1, options.page), pageSize, options.search ?? '')
      return { entries: result.files.map(fileEntry), cursor: result.next, truncated: result.next !== null }
    }
    const collected = await collectPages(async ({ page: pageNumber }) => {
      const result = await this.page(folderId, pageNumber, pageSize, options.search ?? '')
      return { items: result.files, next: result.next }
    }, { maxPages: MAX_LIST_PAGES })
    return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      const root = await this.api<DriveFile>(`${API}/files/${encodeURIComponent(this.rootId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`)
      return { name: root.name || 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: root.id }
    }
    return fileEntry(await this.resolveFile(clean))
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const file = await this.resolveFile(path)
    if (file.mimeType === FOLDER_MIME) throw DriverError.unsupported('A folder cannot be read as a file')
    return await this.session.withToken(async (token) => {
      const response = await fetch(`${API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(range ? { Range: range } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`Google Drive download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const clean = driverPath(path)
    const name = driverFileName(clean)
    const parentId = await this.resolveFolderId(driverParentPath(clean), true)
    const metadata = { name, parents: [parentId] }
    if (bytes.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      await this.multipartUpload(metadata, bytes, options)
      return
    }
    await this.resumableUpload(metadata, bytes, options)
  }

  private async multipartUpload(metadata: Record<string, unknown>, bytes: Uint8Array, options: DriverUploadOptions): Promise<void> {
    const boundary = 'inkstone-drive-boundary'
    const contentType = options.contentType ?? 'application/octet-stream'
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    )
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`)
    const payload = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength)
    payload.set(head, 0)
    payload.set(bytes, head.byteLength)
    payload.set(tail, head.byteLength + bytes.byteLength)
    await this.session.withToken(async (token) => {
      const response = await this.request(`${UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FIELDS)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: payload,
      })
      await response.body?.cancel().catch(() => undefined)
    })
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  private async resumableUpload(metadata: Record<string, unknown>, bytes: Uint8Array, options: DriverUploadOptions): Promise<void> {
    const location = await this.session.withToken(async (token) => {
      const response = await this.request(`${UPLOAD}/files?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': options.contentType ?? 'application/octet-stream',
          'X-Upload-Content-Length': String(bytes.byteLength),
        },
        body: JSON.stringify(metadata),
      })
      const url = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!url) throw DriverError.upstream('Google Drive returned no resumable upload location')
      return url
    })
    const total = bytes.byteLength
    let offset = 0
    while (offset < total) {
      const end = Math.min(offset + UPLOAD_CHUNK, total) - 1
      const chunk = bytes.subarray(offset, end + 1)
      const response = await fetch(location, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.byteLength),
          'Content-Range': `bytes ${offset}-${end}/${total}`,
        },
        body: chunk,
      })
      if (!response.ok && response.status !== 308) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`Google Drive rejected upload bytes ${offset}-${end} (HTTP ${response.status})`)
      }
      await response.body?.cancel().catch(() => undefined)
      offset = end + 1
      options.onProgress?.(offset, total)
    }
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const created = await this.api<DriveFile>(`${API}/files?fields=${encodeURIComponent(FIELDS)}`, {
      method: 'POST',
      body: { name: driverFileName(clean), mimeType: FOLDER_MIME, parents: [parentId] },
    })
    this.pathIds.set(clean, created.id)
  }

  async rename(path: string, newName: string): Promise<void> {
    const file = await this.resolveFile(path)
    await this.api(`${API}/files/${encodeURIComponent(file.id)}?fields=${encodeURIComponent(FIELDS)}`, {
      method: 'PATCH',
      body: { name: newName },
    })
    this.pathIds.delete(driverPath(path))
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const file = await this.resolveFile(fromPath)
    const targetParent = await this.resolveFolderId(driverParentPath(driverPath(toPath)))
    const previousParents = (file.parents ?? []).join(',')
    await this.api(
      `${API}/files/${encodeURIComponent(file.id)}?addParents=${encodeURIComponent(targetParent)}` +
      `&removeParents=${encodeURIComponent(previousParents)}&fields=${encodeURIComponent(FIELDS)}`,
      { method: 'PATCH', body: { name: driverFileName(driverPath(toPath)) } },
    )
    this.pathIds.delete(driverPath(fromPath))
    this.pathIds.delete(driverPath(toPath))
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const file = await this.resolveFile(fromPath)
    const parentId = await this.resolveFolderId(driverParentPath(driverPath(toPath)))
    await this.api(`${API}/files/${encodeURIComponent(file.id)}/copy?fields=${encodeURIComponent(FIELDS)}`, {
      method: 'POST',
      body: { name: driverFileName(driverPath(toPath)), parents: [parentId] },
    })
  }

  async remove(path: string): Promise<void> {
    const file = await this.resolveFile(path)
    const response = await this.session.withToken(async (token) => await this.request(
      `${API}/files/${encodeURIComponent(file.id)}?supportsAllDrives=true`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    ))
    await response.body?.cancel().catch(() => undefined)
    this.pathIds.delete(driverPath(path))
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const token = await this.session.token()
      const response = await this.request(`${API}/about?fields=user`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      const payload = await response.json() as { user?: { displayName?: string; emailAddress?: string } }
      return { ok: true, message: `Google Drive is reachable${payload.user?.displayName ? ` · ${payload.user.displayName}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Google Drive is unavailable' }
    }
  }
}

export function createGoogleDriveDriver(ctx: DriverContext): MountDriver {
  return new GoogleDriveDriver(ctx)
}

/** Keeps the path helper available to the shared registry tests. */
export { driverFileName, encodePath }
