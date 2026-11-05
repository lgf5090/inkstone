/**
 * 123Pan share-link driver (read-only).
 *
 * Ported from `OpenList-Worker/src/backend/drivers/123_share`: every request carries the CRC32 path
 * signature the web client adds, listings walk `Page` while watching the `Next` cursor, and a
 * download address is requested with the share key, the share password and the file's S3 metadata.
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
import { HttpDriverBase, driverFileName, driverParentPath, driverPath } from './http'

const MAIN_API = 'https://yun.123pan.com/b/api'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) inkstone-clouddrive'
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50
const SIGN_TABLE = [
  'a', 'd', 'e', 'f', 'g', 'h', 'l', 'm', 'y', 'i', 'j', 'n', 'o', 'p',
  'k', 'q', 'r', 's', 't', 'u', 'b', 'c', 'v', 'w', 's', 'z',
] as const

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

interface ShareFile {
  FileId: number | string
  FileName: string
  Size: number
  Etag?: string
  S3KeyFlag?: string
  Type: number
  UpdateAt?: string
  CreateAt?: string
}

interface ShareFilesData {
  InfoList?: ShareFile[]
  Next?: string | number
  Total?: number
}

interface ShareResponse {
  code?: number
  message?: string
  data?: unknown
}

function crc32(text: string): number {
  const bytes = new TextEncoder().encode(text)
  let value = 0xffffffff
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff]!
  }
  return (value ^ 0xffffffff) >>> 0
}

/** The query signature 123Pan's web client adds to every API path. */
function signPath(path: string): [string, string] {
  const random = String(Math.round(1e7 * Math.random()))
  const now = new Date()
  // The web client signs Beijing time; Workers run in UTC, so shift explicitly like the account
  // driver does instead of relying on the process timezone.
  const timestamp = String(Math.round((now.getTime() + 8 * 3600000) / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours() + 8)}${pad(now.getUTCMinutes())}`
  const mapped = stamp.split('').map((digit) => SIGN_TABLE[Number(digit)] ?? 'a').join('')
  const timeSign = String(crc32(mapped))
  const data = [timestamp, random, path, 'web', '3', timeSign].join('|')
  return [timeSign, `${timestamp}-${random}-${crc32(data)}`]
}

function signedApi(raw: string): string {
  const url = new URL(raw)
  const [key, value] = signPath(url.pathname)
  url.searchParams.set(key, value)
  return url.toString()
}

function fileEntry(file: ShareFile): DriverEntry {
  const folder = file.Type === 1
  return {
    name: file.FileName,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.Size) || 0,
    modifiedAt: Date.parse(file.UpdateAt ?? file.CreateAt ?? '') || 0,
    ref: String(file.FileId),
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.FileName),
  }
}

class Share123Driver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('123_share')!
  readonly capabilities = this.definition.capabilities
  private token = ''

  private shareKey(): string {
    return this.configText('shareKey', '').trim()
  }

  private sharePassword(): string {
    return this.ctx.credentials.sharePassword ?? ''
  }

  private rootId(): string {
    return this.configText('rootFolderId', '').trim() || '0'
  }

  protected async login(): Promise<void> {
    const shareKey = this.shareKey()
    if (!shareKey) {
      const message = '123Pan share needs a share key'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    this.token = this.ctx.credentials.accessToken ?? ''
  }

  private async api<T>(
    rawUrl: string,
    method: 'GET' | 'POST',
    params?: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const target = new URL(rawUrl)
    for (const [key, value] of Object.entries(params ?? {})) target.searchParams.set(key, value)
    const signed = signedApi(target.toString())
    const response = await this.request(signed, {
      method,
      headers: {
        Origin: 'https://yun.123pan.com',
        Referer: 'https://yun.123pan.com/',
        'User-Agent': USER_AGENT,
        Platform: 'web',
        'App-Version': '3',
        Accept: 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let payload: T & ShareResponse
    try {
      payload = await response.json() as T & ShareResponse
    } catch {
      throw DriverError.upstream('123Pan share returned a body that is not JSON')
    }
    const code = typeof payload.code === 'number' ? payload.code : 0
    if (code !== 0 && code !== 200) {
      const message = payload.message || `123Pan share answered code ${code}`
      if (code === 401 || code === 403) throw DriverError.auth(message)
      if (code === 429) throw DriverError.rateLimited(message)
      if (code === 404) throw DriverError.notFound(message)
      throw DriverError.upstream(message)
    }
    return payload as T
  }

  private async listPage(
    parentId: string,
    page: number,
    pageSize: number,
  ): Promise<{ files: ShareFile[]; next: string | null }> {
    const result = await this.api<ShareResponse & { data?: ShareFilesData }>(`${MAIN_API}/share/get`, 'GET', {
      limit: String(pageSize),
      next: '0',
      orderBy: 'file_id',
      orderDirection: 'desc',
      parentFileId: parentId || '0',
      Page: String(page),
      shareKey: this.shareKey(),
      SharePwd: this.sharePassword(),
    })
    const data = result.data
    const files = data?.InfoList ?? []
    const rawNext = data?.Next
    const next = rawNext === undefined || rawNext === null || String(rawNext) === '-1' ? null : String(rawNext)
    return { files, next }
  }

  private async listAll(parentId: string): Promise<{ files: ShareFile[]; truncated: boolean }> {
    const files: ShareFile[] = []
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const result = await this.listPage(parentId, page, PAGE_SIZE)
      files.push(...result.files)
      if (result.next === null || result.files.length === 0) return { files, truncated: false }
    }
    return { files, truncated: true }
  }

  private async resolveFolderId(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return this.rootId()
    let current = this.rootId()
    for (const segment of clean.split('/').filter(Boolean)) {
      const listed = await this.listAll(current)
      const found = listed.files.find((file) => file.Type === 1 && file.FileName === segment)
      if (!found) throw DriverError.notFound(`Folder not found: ${segment}`)
      current = String(found.FileId)
    }
    return current
  }

  private async findChild(parentId: string, name: string): Promise<ShareFile | null> {
    const listed = await this.listAll(parentId)
    return listed.files.find((file) => file.FileName === name) ?? null
  }

  private async resolveEntry(path: string): Promise<{ entry: DriverEntry; file: ShareFile | null }> {
    const clean = driverPath(path)
    if (clean === '/') {
      return {
        entry: { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: this.rootId() },
        file: null,
      }
    }
    const name = driverFileName(clean)
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const found = await this.findChild(parentId, name)
    if (found) return { entry: fileEntry(found), file: found }
    const folderId = await this.resolveFolderId(clean)
    return { entry: { name, kind: 'folder', size: 0, modifiedAt: 0, ref: folderId }, file: null }
  }

  private async downloadUrl(file: ShareFile): Promise<string> {
    const result = await this.api<ShareResponse & { data?: { DownloadURL?: string } }>(
      `${MAIN_API}/share/download/info`,
      'POST',
      undefined,
      {
        shareKey: this.shareKey(),
        SharePwd: this.sharePassword(),
        etag: file.Etag ?? '',
        fileId: file.FileId,
        s3keyFlag: file.S3KeyFlag ?? '',
        size: file.Size,
      },
    )
    let url = result.data?.DownloadURL ?? ''
    if (!url) throw DriverError.upstream('123Pan share returned no download address')
    try {
      const parsed = new URL(url)
      const encoded = parsed.searchParams.get('params')
      if (encoded) url = new URL(atob(encoded)).toString()
    } catch {
      // A URL without the params wrapper is already the real address.
    }
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
        const filtered = listed.files.filter((file) => file.FileName.toLocaleLowerCase().includes(needle))
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
      const listed = await this.listAll(folderId)
      return { entries: listed.files.map(fileEntry), cursor: null, truncated: listed.truncated }
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
      const { entry, file } = await this.resolveEntry(clean)
      if (entry.kind === 'folder' || !file) throw DriverError.unsupported('A folder cannot be read as a file')
      const link = await this.downloadUrl(file)
      const response = await fetch(link, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Referer: 'https://yun.123pan.com/',
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        if (response.status === 401 || response.status === 403) throw DriverError.auth('123Pan share refused the download')
        throw DriverError.upstream(`123Pan share download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const { entry, file } = await this.resolveEntry(clean)
      if (entry.kind === 'folder' || !file) return null
      return await this.downloadUrl(file)
    })
  }

  async upload(path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('123Pan share links are read-only')
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('123Pan share links are read-only')
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('123Pan share links are read-only')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    throw DriverError.unsupported('123Pan share links are read-only')
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('123Pan share links are read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.listPage(this.rootId(), 1, 1)
      return { ok: true, message: 'The 123Pan share is reachable' }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      return { ok: false, message: error instanceof Error ? error.message : 'The 123Pan share is unavailable' }
    }
  }
}

export function create123ShareDriver(ctx: DriverContext): MountDriver {
  return new Share123Driver(ctx)
}
