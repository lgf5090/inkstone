/**
 * Aliyundrive open-platform driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/aliyundrive_open` and the upstream OpenList
 * driver. OAuth tokens rotate through the registered `aliyundrive_open` provider; files are
 * addressed by `file_id`; uploads create a multipart session, PUT each 20 MiB part and complete it.
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
  uploadInParts,
} from './http'
import { OAuthSession } from './token'

const API = 'https://openapi.aliyundrive.com/adrive/v1.0'
const PAGE_LIMIT = 200
const MAX_LIST_PAGES = 50
const PART_SIZE = 20 * 1024 * 1024

interface AliyunFile {
  file_id: string
  name?: string
  file_name?: string
  type?: 'file' | 'folder'
  size?: number
  created_at?: string
  updated_at?: string
  thumbnail?: string
}

interface AliyunEnvelope {
  code?: unknown
  message?: string
  items?: AliyunFile[]
  next_marker?: string
  [key: string]: unknown
}

function authCode(code: unknown): boolean {
  return ['AccessTokenInvalid', 'AccessTokenExpired', 'I400JD'].includes(String(code))
}

function mapCode(code: unknown, message?: string): DriverError {
  const text = String(code)
  const suffix = message ? `: ${message}` : ''
  if (authCode(code)) return DriverError.auth(`Aliyundrive refused the credentials (${text}${suffix})`)
  if (text === 'NotFound.File' || text === 'NotFound.FileId' || text === 'NotFound') {
    return DriverError.notFound(`Aliyundrive could not find the item${suffix}`)
  }
  if (text === 'TooManyRequests' || text === 'Throttling') {
    return DriverError.rateLimited(`Aliyundrive is rate limiting requests${suffix}`)
  }
  return DriverError.upstream(`Aliyundrive answered ${text}${suffix}`)
}

function entryOf(file: AliyunFile): DriverEntry {
  const folder = file.type === 'folder'
  const name = file.name ?? file.file_name ?? ''
  return {
    name,
    kind: folder ? 'folder' : 'file',
    size: Number(file.size) || 0,
    modifiedAt: Date.parse(file.updated_at ?? file.created_at ?? '') || 0,
    ref: file.file_id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(name),
  }
}

export class AliyunDriveOpenDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('aliyundrive_open')!
  readonly capabilities = this.definition.capabilities
  private readonly session: OAuthSession
  private driveId: string
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.session = new OAuthSession(ctx, 'aliyundrive_open')
    this.driveId = String(ctx.config.driveId ?? '').trim()
  }

  protected async login(force: boolean): Promise<void> {
    await this.session.token(force)
  }

  private rootId(): string {
    return this.configText('rootFolderId', 'root').trim() || 'root'
  }

  private async drive(): Promise<string> {
    if (this.driveId) return this.driveId
    return await this.withAuth(async () => {
      const token = await this.session.token()
      const response = await this.request(`${API}/user/getDriveInfo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      const payload = await response.json() as AliyunEnvelope
      const type = this.configText('driveType', 'default')
      const picked = String(
        payload[`${type}_drive_id`] ?? payload.resource_drive_id ?? payload.default_drive_id ?? payload.backup_drive_id ?? '',
      )
      if (!picked) throw DriverError.upstream('Aliyundrive did not return a drive id')
      this.driveId = picked
      return picked
    })
  }

  private async api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return await this.withAuth(async () => {
      const token = await this.session.token()
      const response = await this.request(`${API}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json() as AliyunEnvelope
      if (payload.code !== undefined && payload.code !== null && String(payload.code) !== '') {
        throw mapCode(payload.code, payload.message)
      }
      return payload as T
    })
  }

  private async listChunk(parentId: string, marker: string | null, pageSize: number): Promise<{ files: AliyunFile[]; next: string | null }> {
    const driveId = await this.drive()
    const payload = await this.api<AliyunEnvelope>('/openFile/list', {
      drive_id: driveId,
      parent_file_id: parentId,
      limit: Math.min(PAGE_LIMIT, Math.max(1, pageSize)),
      order_by: 'updated_at',
      order_direction: 'DESC',
      ...(marker ? { marker } : {}),
    })
    return { files: payload.items ?? [], next: payload.next_marker || null }
  }

  private async listPage(parentId: string, pageNumber: number, pageSize: number): Promise<{ files: AliyunFile[]; next: string | null }> {
    let marker: string | null = null
    for (let current = 1; current <= Math.max(1, pageNumber); current++) {
      const result = await this.listChunk(parentId, marker, pageSize)
      if (current === pageNumber) return result
      if (result.next === null) return { files: [], next: null }
      marker = result.next
      if (current >= MAX_LIST_PAGES) break
    }
    return { files: [], next: null }
  }

  private async findChild(parentId: string, name: string, folder: boolean | null = null): Promise<AliyunFile | null> {
    let marker: string | null = null
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const result = await this.listChunk(parentId, marker, PAGE_LIMIT)
      const hit = result.files.find((file) => {
        if ((file.name ?? file.file_name) !== name) return false
        return folder === null || file.type === (folder ? 'folder' : 'file')
      })
      if (hit) return hit
      if (result.next === null) return null
      marker = result.next
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
      parent = folder.file_id
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveEntry(path: string): Promise<AliyunFile> {
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
      return { entries: page.files.map(entryOf), cursor: page.next, truncated: page.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const chunk = await this.listChunk(parentId, cursor ?? null, pageSize)
      return { items: chunk.files, next: chunk.next }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    let entries = collected.items.map(entryOf)
    if (options.search) {
      const needle = options.search.toLowerCase()
      entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    }
    return { entries, cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: this.rootId() }
    return entryOf(await this.resolveEntry(clean))
  }

  private async downloadUrl(file: AliyunFile): Promise<string> {
    const driveId = await this.drive()
    const payload = await this.api<{ url?: string; download_url?: string }>('/openFile/getDownloadUrl', {
      drive_id: driveId,
      file_id: file.file_id,
      expire_sec: 14400,
    })
    const url = payload.url ?? payload.download_url ?? ''
    if (!url) throw DriverError.upstream('Aliyundrive returned no download address')
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const file = await this.resolveEntry(clean)
    const url = await this.downloadUrl(file)
    const response = await fetch(url, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`Aliyundrive download failed (HTTP ${response.status})`)
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
    const driveId = await this.drive()
    const total = Math.max(1, Math.ceil(bytes.byteLength / PART_SIZE))
    const create = await this.api<{
      file_id?: string
      upload_id?: string
      rapid_upload?: boolean
      part_info_list?: Array<{ part_number: number; upload_url: string }>
    }>('/openFile/create', {
      drive_id: driveId,
      parent_file_id: parentId,
      name,
      type: 'file',
      check_name_mode: 'ignore',
      part_info_list: Array.from({ length: total }, (_, index) => ({ part_number: index + 1 })),
    })
    if (create.rapid_upload) {
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    if (!create.file_id || !create.upload_id) throw DriverError.upstream('Aliyundrive returned no upload session')
    let urls = create.part_info_list ?? []
    if (urls.length < total) {
      const refreshed = await this.api<{ part_info_list?: Array<{ part_number: number; upload_url: string }> }>('/openFile/getUploadUrl', {
        drive_id: driveId,
        file_id: create.file_id,
        upload_id: create.upload_id,
        part_info_list: Array.from({ length: total }, (_, index) => ({ part_number: index + 1 })),
      })
      urls = refreshed.part_info_list ?? []
    }
    await uploadInParts({
      size: bytes.byteLength,
      partSize: PART_SIZE,
      uploadPart: async (partNumber, start, end) => {
        const info = urls.find((item) => Number(item.part_number) === partNumber)
        if (!info?.upload_url) throw DriverError.upstream(`Aliyundrive returned no upload url for part ${partNumber}`)
        const response = await fetch(info.upload_url, { method: 'PUT', body: bytes.subarray(start, end) })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw DriverError.upstream(`Aliyundrive upload part ${partNumber}/${total} failed (HTTP ${response.status})`)
        }
        await response.body?.cancel().catch(() => undefined)
        options.onProgress?.(end, bytes.byteLength)
      },
      complete: async () => {
        await this.api('/openFile/complete', {
          drive_id: driveId,
          file_id: create.file_id,
          upload_id: create.upload_id,
        })
      },
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveDir(driverParentPath(clean))
    const driveId = await this.drive()
    await this.api('/openFile/create', {
      drive_id: driveId,
      parent_file_id: parentId,
      name: driverFileName(clean),
      type: 'folder',
      check_name_mode: 'refuse',
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const entry = await this.resolveEntry(path)
    const driveId = await this.drive()
    await this.api('/openFile/update', { drive_id: driveId, file_id: entry.file_id, name: newName })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const entry = await this.resolveEntry(from)
    const targetName = driverFileName(to)
    if (targetName !== driverFileName(from)) await this.rename(from, targetName)
    const parentId = await this.resolveDir(driverParentPath(to))
    const driveId = await this.drive()
    await this.api('/openFile/move', {
      drive_id: driveId,
      file_id: entry.file_id,
      to_parent_file_id: parentId,
      check_name_mode: 'refuse',
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const entry = await this.resolveEntry(from)
    const parentId = await this.resolveDir(driverParentPath(to))
    const driveId = await this.drive()
    await this.api('/openFile/copy', {
      drive_id: driveId,
      file_id: entry.file_id,
      to_parent_file_id: parentId,
      auto_rename: true,
    })
  }

  async remove(path: string): Promise<void> {
    const entry = await this.resolveEntry(path)
    const driveId = await this.drive()
    await this.api('/openFile/recyclebin', { drive_id: driveId, file_id: entry.file_id })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const info = await this.api<{ user_id?: string }>('/user/getDriveInfo')
      return { ok: true, message: `Aliyundrive is reachable${info.user_id ? ` · ${info.user_id}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Aliyundrive is unavailable' }
    }
  }
}

export function createAliyunDriveOpenDriver(ctx: DriverContext): MountDriver {
  return new AliyunDriveOpenDriver(ctx)
}
