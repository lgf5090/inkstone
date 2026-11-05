/**
 * PikPak share driver (read-only).
 *
 * A share is addressed by `share_id` plus an optional pass code. The first listing may return a
 * `pass_code_token`, which every later request carries as `X-Share-Token`; no token ever rotates,
 * so there is no refresh path.
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

const SHARE_API = 'https://api-drive.mypikpak.com/drive/v1/share'
const CLIENT_ID = 'YUMx5nI8ZU8Ap8pm'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const PAGE_LIMIT = 100
const MAX_LIST_PAGES = 50

interface PikPakShareFile {
  id: string
  kind?: string
  name: string
  size?: string | number
  modified_time?: string
  web_content_link?: string
  thumbnail_link?: string
  medias?: Array<{ link?: { url?: string } }>
}

interface PikPakShareList {
  files?: PikPakShareFile[]
  file_info?: PikPakShareFile
  next_page_token?: string
  pass_code_token?: string
  share_status?: string
  share_status_text?: string
}

function fileEntry(file: PikPakShareFile): DriverEntry {
  const folder = file.kind === 'drive#folder'
  return {
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: file.modified_time ? Date.parse(file.modified_time) || 0 : 0,
    ref: file.id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.name),
  }
}

function downloadUrlOf(file: PikPakShareFile): string {
  return file.medias?.[0]?.link?.url || file.web_content_link || ''
}

function downloadError(response: Response): DriverError {
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'))
    return DriverError.rateLimited('PikPak Share is rate limiting the download', Number.isFinite(retry) ? retry * 1000 : undefined)
  }
  if (response.status === 404) return DriverError.notFound('PikPak Share could not find the download')
  if (response.status === 401 || response.status === 403) return DriverError.auth('PikPak Share refused the download')
  return DriverError.upstream(`PikPak Share download failed (HTTP ${response.status})`)
}

export class PikPakShareDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('pikpak_share')!
  readonly capabilities = this.definition.capabilities
  private passCodeToken = ''
  private readonly deviceId: string
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
    this.deviceId = `web_${Math.random().toString(36).slice(2, 15)}`
  }

  private shareId(): string {
    return this.configText('shareId').trim() || String(this.ctx.credentials.shareId ?? '')
  }

  private sharePassword(): string {
    return String(this.ctx.credentials.sharePwd ?? '')
  }

  private rootId(): string {
    return this.configText('rootFolderId').trim()
  }

  protected async login(): Promise<void> {
    if (!this.shareId()) throw DriverError.auth('PikPak Share needs a share id')
  }

  private shareHeaders(): Record<string, string> {
    return {
      'X-Client-ID': CLIENT_ID,
      'X-Device-ID': this.deviceId,
      'User-Agent': USER_AGENT,
      ...(this.passCodeToken ? { 'X-Share-Token': this.passCodeToken } : {}),
    }
  }

  private async filesPage(parentId: string, token: string, limit: number): Promise<PikPakShareList> {
    const query = new URLSearchParams({
      share_id: this.shareId(),
      thumbnail_size: 'SIZE_LARGE',
      limit: String(Math.min(PAGE_LIMIT, Math.max(1, limit))),
    })
    const password = this.sharePassword()
    if (password) query.set('pass_code', password)
    if (parentId) query.set('parent_id', parentId)
    if (token) query.set('page_token', token)

    let response: Response
    try {
      response = await fetch(`${SHARE_API}?${query.toString()}`, {
        headers: this.shareHeaders(),
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw DriverError.upstream(`PikPak Share could not be reached: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 429) throw DriverError.rateLimited('PikPak Share is rate limiting requests')
    if (response.status === 401 || response.status === 403) {
      const message = 'PikPak Share refused the share'
      await this.ctx.markNeedsReauth(message).catch(() => undefined)
      throw DriverError.auth(message)
    }
    if (response.status === 404) throw DriverError.notFound('PikPak Share could not find the share')
    if (!response.ok) throw DriverError.upstream(`PikPak Share answered HTTP ${response.status}`)

    const payload = await response.json().catch(() => null) as PikPakShareList | null
    if (!payload) throw DriverError.upstream('PikPak Share returned an unexpected body')
    if (payload.pass_code_token) this.passCodeToken = payload.pass_code_token
    return payload
  }

  private async listAll(parentId: string): Promise<PikPakShareFile[]> {
    const files: PikPakShareFile[] = []
    let token = ''
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const data = await this.filesPage(parentId, token, PAGE_LIMIT)
      files.push(...(data.files ?? []))
      const next = data.next_page_token ?? ''
      if (!next || next === token) return files
      token = next
    }
    return files
  }

  private async listPage(parentId: string, pageNumber: number, pageSize: number): Promise<{ files: PikPakShareFile[]; next: string | null }> {
    let token = ''
    for (let current = 1; current <= Math.max(1, pageNumber); current++) {
      const data = await this.filesPage(parentId, token, pageSize)
      if (current === pageNumber) return { files: data.files ?? [], next: data.next_page_token || null }
      const next = data.next_page_token ?? ''
      if (!next || next === token) break
      token = next
    }
    return { files: [], next: null }
  }

  private async resolveFolder(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return this.rootId()
    let current = this.rootId()
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        current = cached
        continue
      }
      const files = await this.listAll(current)
      const found = files.find((file) => file.kind === 'drive#folder' && file.name === segment)
      if (!found) throw DriverError.notFound(`PikPak Share could not find the folder ${prefix}`)
      current = found.id
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveEntry(path: string): Promise<PikPakShareFile> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolder(driverParentPath(clean))
    const files = await this.listAll(parentId)
    const found = files.find((file) => file.name === driverFileName(clean))
    if (!found) throw DriverError.notFound(`PikPak Share could not find ${clean}`)
    return found
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const parentId = await this.resolveFolder(clean)
    const pageSize = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? PAGE_LIMIT))
    if (options.page !== undefined) {
      const page = await this.listPage(parentId, Math.max(1, options.page), pageSize)
      return { entries: page.files.map(fileEntry), cursor: page.next, truncated: page.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const data = await this.filesPage(parentId, cursor ?? '', pageSize)
      return { items: data.files ?? [], next: data.next_page_token || null }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
    }
    return fileEntry(await this.resolveEntry(clean))
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const url = downloadUrlOf(await this.resolveEntry(clean))
    if (!url) throw DriverError.notFound('PikPak Share returned no download address')
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
    const url = downloadUrlOf(await this.resolveEntry(clean))
    return url || null
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('PikPak Share is read-only')
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('PikPak Share is read-only')
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('PikPak Share is read-only')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('PikPak Share is read-only')
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('PikPak Share is read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.filesPage(this.rootId(), '', 1)
      return { ok: true, message: 'PikPak Share is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'PikPak Share is unavailable' }
    }
  }
}

export function createPikPakShareDriver(ctx: DriverContext): MountDriver {
  return new PikPakShareDriver(ctx)
}
