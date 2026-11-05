/**
 * 123 Cloud Drive (123Pan) account driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/123pan`:
 * the path signature, login precedence (token → cookie → password), pagination, download-link
 * resolution, trash/move/rename/mkdir and the S3-presigned multipart upload flow all follow it.
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
  driverChildPath,
  driverFileName,
  driverParentPath,
  driverPath,
  uploadInParts,
} from './http'

const MAIN_API = 'https://yun.123pan.com/b/api'
const LOGIN_API = 'https://login.123pan.com/api'
const USER_INFO = `${MAIN_API}/user/info`
const FILE_LIST = `${MAIN_API}/file/list/new`
const DOWNLOAD_INFO = `${MAIN_API}/file/download_info`
const MK_DIR = `${MAIN_API}/file/upload_request`
const MOVE = `${MAIN_API}/file/mod_pid`
const RENAME = `${MAIN_API}/file/rename`
const TRASH = `${MAIN_API}/file/trash`
const UPLOAD_REQUEST = `${MAIN_API}/file/upload_request`
const S3_AUTH = `${MAIN_API}/file/s3_upload_object/auth`
const S3_PRESIGNED = `${MAIN_API}/file/s3_repare_upload_parts_batch`
const UPLOAD_COMPLETE = `${MAIN_API}/file/upload_complete/v2`
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) inkstone-clouddrive'
const CHUNK_SIZE = 16 * 1024 * 1024
const MAX_LIST_PAGES = 45
const PAGE_LIMIT = 100

interface Pan123File {
  FileId: number
  FileName: string
  Size: number
  Type: number
  UpdateAt: string
  Etag: string
  S3KeyFlag: string
  DownloadUrl?: string
}

interface Pan123ListData {
  Next: string
  Total: number
  InfoList: Pan123File[]
}

interface Pan123Upload {
  Bucket: string
  Key: string
  UploadId: string
  FileId: number
  StorageNode: string
  Reuse: boolean
}

const CRC32_TABLE: number[] = (() => {
  const table = new Array<number>(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(text: string): number {
  let value = 0xffffffff
  for (let index = 0; index < text.length; index++) {
    value = CRC32_TABLE[(value ^ text.charCodeAt(index)) & 0xff]! ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

const SIGN_TABLE = [
  'a', 'd', 'e', 'f', 'g', 'h', 'l', 'm', 'y', 'i', 'j', 'n', 'o', 'p',
  'k', 'q', 'r', 's', 't', 'u', 'b', 'c', 'v', 'w', 's', 'z',
] as const

/** The CRC32 path signature 123Pan expects on every API request. */
function signPath(path: string): string {
  const random = Math.round(1e7 * Math.random()).toString()
  const now = new Date()
  const timestamp = Math.round((now.getTime() + 8 * 3600000) / 1000).toString()
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const day = String(now.getUTCDate()).padStart(2, '0')
  const hour = String(now.getUTCHours() + 8).padStart(2, '0')
  const minute = String(now.getUTCMinutes()).padStart(2, '0')
  const stamp = `${year}${month}${day}${hour}${minute}`
    .split('')
    .map((digit) => SIGN_TABLE[Number(digit)])
    .join('')
  const timeSign = (crc32(stamp) >>> 0).toString()
  const data = [timestamp, random, path, 'web', '3', timeSign].join('|')
  return `${timeSign}=${timestamp}-${random}-${(crc32(data) >>> 0).toString()}`
}

function signedApi(rawUrl: string): string {
  const parsed = new URL(rawUrl)
  return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}&${signPath(parsed.pathname)}`
}

/** A bare Bearer, a JWT, or a cookie that carries one of the three known token fields. */
function tokenFromCookie(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  if (/^Bearer\s+/i.test(text)) return text.replace(/^Bearer\s+/i, '').trim()
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return text
  const fields: Record<string, string> = {}
  for (const part of text.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    fields[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  const pick = (key: string): string => {
    const value = fields[key] ?? ''
    return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, '').trim() : value
  }
  return pick('sso-token') || pick('token') || pick('authorization')
}

function fileEntry(file: Pan123File): DriverEntry {
  const folder = file.Type === 1
  return {
    name: file.FileName,
    kind: folder ? 'folder' : 'file',
    size: Number(file.Size) || 0,
    modifiedAt: Date.parse(file.UpdateAt) || 0,
    ref: String(file.FileId),
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.FileName),
  }
}

class Pan123Driver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('123pan')!
  readonly capabilities = this.definition.capabilities
  private token = ''
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private authField(key: string): string {
    return this.ctx.credentials[key] ?? ''
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.authField('accessToken')) {
      this.token = this.authField('accessToken')
      try {
        await this.userInfo(true)
        return
      } catch {
        this.token = ''
      }
    }
    if (!force && this.authField('cookie')) {
      const fromCookie = tokenFromCookie(this.authField('cookie'))
      if (fromCookie) {
        this.token = fromCookie
        try {
          await this.userInfo(true)
          await this.ctx.saveCredentials({ accessToken: fromCookie })
          return
        } catch {
          this.token = ''
        }
      }
    }
    const username = this.configText('username')
    const password = this.authField('password')
    if (!username || !password) {
      throw DriverError.auth(
        '123Pan needs credentials: an account and password, a Cookie containing sso-token, or an access token.',
      )
    }
    await this.signIn(username, password)
  }

  private async signIn(username: string, password: string): Promise<void> {
    const email = username.includes('@')
    const body = email
      ? { mail: username, password, type: 2 }
      : { passport: username, password, remember: true }
    const response = await fetch(`${LOGIN_API}/user/sign_in`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'https://yun.123pan.com',
        referer: 'https://yun.123pan.com/',
        'user-agent': USER_AGENT,
        platform: this.configText('platform', 'web'),
        'app-version': '3',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const payload = await response.json().catch(() => null) as { code?: number; message?: string; data?: { token?: string } } | null
    if (!response.ok || !payload || payload.code !== 200 || !payload.data?.token) {
      throw DriverError.auth(
        `123Pan sign-in failed (${payload?.message ?? `HTTP ${response.status}`}). ` +
        'The egress IP may be challenged; use a browser Cookie or an access token instead.',
      )
    }
    this.token = payload.data.token
    await this.ctx.saveCredentials({ accessToken: this.token })
  }

  /**
   * One signed call. An expired token forces one re-login and a retry; a second failure marks the
   * storage as needing re-authorization instead of looping.
   */
  private async api<T>(url: string, method: 'GET' | 'POST', body?: unknown, skipAuthRetry = false): Promise<T> {
    // Login once before the first call; the reference driver does this in init().
    if (!this.token && !skipAuthRetry) {
      try {
        await this.authenticate(false)
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'auth') {
          await this.ctx.markNeedsReauth(error.message)
        }
        throw error
      }
    }
    const target = signedApi(url)
    let response: Response
    try {
      response = await this.request(target, {
        method,
        headers: {
          origin: 'https://yun.123pan.com',
          referer: 'https://yun.123pan.com/',
          authorization: this.token ? `Bearer ${this.token}` : '',
          'user-agent': USER_AGENT,
          platform: this.configText('platform', 'web'),
          'app-version': '3',
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth' && !skipAuthRetry) {
        await this.login(true)
        return await this.api<T>(url, method, body, true)
      }
      throw error
    }
    const payload = await response.json() as { code?: number; message?: string; data?: T }
    const code = Number(payload.code)
    if (code !== 0 && code !== 200) {
      if (code === 401 || code === 403) {
        if (!skipAuthRetry) {
          try {
            await this.login(true)
            return await this.api<T>(url, method, body, true)
          } catch (retryError) {
            const message = retryError instanceof Error ? retryError.message : '123Pan authorization expired'
            await this.ctx.markNeedsReauth(message)
            throw DriverError.auth(message)
          }
        }
        throw DriverError.auth(payload.message || '123Pan authorization expired')
      }
      if (code === 429) throw DriverError.rateLimited(payload.message || '123Pan is rate limiting requests')
      throw DriverError.upstream(payload.message || `123Pan answered code ${code}`)
    }
    return payload.data as T
  }

  private async userInfo(skipAuthRetry = false): Promise<Record<string, unknown>> {
    return await this.api<Record<string, unknown>>(USER_INFO, 'GET', undefined, skipAuthRetry)
  }

  private rootId(): string {
    return this.configText('rootId', '0').trim() || '0'
  }

  private clean(path: string): string {
    const normalized = driverPath(path)
    return normalized === '/' ? '/' : normalized
  }

  private async resolveFolder(path: string, create = false): Promise<string> {
    const clean = this.clean(path)
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
      const found = await this.findChild(parent, segment, true)
      if (found) {
        parent = String(found.FileId)
        this.pathIds.set(prefix, parent)
        continue
      }
      if (!create) throw DriverError.notFound(`Folder not found: ${segment}`)
      try {
        await this.mkdir(`${prefix}`)
      } catch (error) {
        // A concurrent upload may have created it; the lookup below decides either way.
        if (!(error instanceof DriverError)) throw error
      }
      const created = await this.findChild(parent, segment, true)
      if (!created) throw DriverError.upstream(`123Pan could not create the folder: ${segment}`)
      parent = String(created.FileId)
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async listPage(parentId: string, page: number, pageSize: number, search = ''): Promise<{ files: Pan123File[]; next: string | null }> {
    let next = '0'
    let current = 1
    for (;;) {
      const query = new URLSearchParams({
        driveId: '0',
        limit: String(Math.min(PAGE_LIMIT, Math.max(1, pageSize))),
        next,
        orderBy: 'file_id',
        orderDirection: 'desc',
        parentFileId: parentId,
        trashed: 'false',
        SearchData: search,
        Page: String(current),
        OnlyLookAbnormalFile: '0',
        event: 'homeListFile',
        operateType: '4',
        inDirectSpace: 'false',
      })
      const data = await this.api<Pan123ListData>(`${FILE_LIST}?${query.toString()}`, 'GET')
      const files = data?.InfoList ?? []
      const nextToken = String(data?.Next ?? '-1')
      if (current === page) return { files, next: nextToken === '-1' ? null : nextToken }
      if (!data || files.length === 0 || nextToken === '-1') return { files: [], next: null }
      next = nextToken
      current++
      if (current > MAX_LIST_PAGES) return { files: [], next: null }
    }
  }

  private async findChild(parentId: string, name: string, folder: boolean, search = ''): Promise<Pan123File | null> {
    let next = '0'
    let page = 1
    for (;;) {
      const query = new URLSearchParams({
        driveId: '0',
        limit: String(PAGE_LIMIT),
        next,
        orderBy: 'file_id',
        orderDirection: 'desc',
        parentFileId: parentId,
        trashed: 'false',
        SearchData: search,
        Page: String(page),
        OnlyLookAbnormalFile: '0',
        event: 'homeListFile',
        operateType: '4',
        inDirectSpace: 'false',
      })
      const data = await this.api<Pan123ListData>(`${FILE_LIST}?${query.toString()}`, 'GET')
      const files = data?.InfoList ?? []
      const hit = files.find((file) => file.FileName === name && (file.Type === 1) === folder)
      if (hit) return hit
      const token = String(data?.Next ?? '-1')
      if (!data || files.length === 0 || token === '-1' || page >= MAX_LIST_PAGES) return null
      next = token
      page++
    }
  }

  private async resolveFile(path: string): Promise<{ file: Pan123File; parentId: string }> {
    const clean = this.clean(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const name = driverFileName(clean)
    const parentId = await this.resolveFolder(driverParentPath(clean))
    const found = await this.findChild(parentId, name, false)
    if (!found) throw DriverError.notFound(`File not found: ${name}`)
    return { file: found, parentId }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const folderId = await this.resolveFolder(path)
    const pageSize = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? PAGE_LIMIT))
    if (options.page !== undefined) {
      const page = await this.listPage(folderId, Math.max(1, options.page), pageSize, options.search ?? '')
      return {
        entries: page.files.map(fileEntry),
        cursor: page.next,
        truncated: page.next !== null,
      }
    }
    const collected = await collectPages(async ({ page }) => {
      const result = await this.listPage(folderId, page, pageSize, options.search ?? '')
      return { items: result.files, next: result.next }
    }, { maxPages: MAX_LIST_PAGES })
    return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = this.clean(path)
    if (clean === '/') {
      return { name: this.rootId(), kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
    }
    const { file } = await this.resolveFile(clean)
    return fileEntry(file)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const { file } = await this.resolveFile(path)
    if (file.Type === 1) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadLink(file)
    const response = await fetch(link, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        referer: 'https://yun.123pan.com/',
        ...(range ? { Range: range } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`123Pan download failed (HTTP ${response.status})`)
    }
    return response
  }

  private async downloadLink(file: Pan123File): Promise<string> {
    const data = await this.api<{ DownloadUrl?: string }>(DOWNLOAD_INFO, 'POST', {
      driveId: 0,
      etag: file.Etag,
      fileId: file.FileId,
      fileName: file.FileName,
      s3keyFlag: file.S3KeyFlag,
      size: file.Size,
      type: file.Type,
    })
    let url = data?.DownloadUrl ?? ''
    if (!url) throw DriverError.upstream('123Pan returned no download address')
    try {
      const parsed = new URL(url)
      const encoded = parsed.searchParams.get('params')
      if (encoded) {
        const decoded = new URL(atob(encoded))
        url = decoded.toString()
      }
    } catch {
      // A URL without the params wrapper is already the real address.
    }
    return url
  }

  async directLink(path: string): Promise<string | null> {
    const { file } = await this.resolveFile(path)
    if (file.Type === 1) return null
    return await this.downloadLink(file)
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const clean = this.clean(path)
    const name = driverFileName(clean)
    const parentId = await this.resolveFolder(driverParentPath(clean), true)
    let etag = ''
    try {
      etag = createHash('md5').update(bytes).digest('hex')
    } catch {
      etag = ''
    }
    const upload = await this.api<Pan123Upload>(UPLOAD_REQUEST, 'POST', {
      driveId: 0, duplicate: 2, etag, fileName: name, parentFileId: parentId, size: bytes.byteLength, type: 0,
    })
    if (upload.Reuse || upload.Key === '') {
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    const partCount = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_SIZE))
    const urls = partCount === 1
      ? await this.presignedSingle(upload)
      : await this.presignedBatch(upload, partCount)
    await uploadInParts({
      size: bytes.byteLength,
      partSize: CHUNK_SIZE,
      concurrency: 1,
      uploadPart: async (partNumber, start, end) => {
        const url = urls[String(partNumber)]
        if (!url) throw DriverError.upstream(`123Pan returned no upload address for part ${partNumber}`)
        const response = await fetch(url, { method: 'PUT', body: bytes.subarray(start, end) })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw DriverError.upstream(`123Pan upload part ${partNumber}/${partCount} failed (HTTP ${response.status})`)
        }
        options.onProgress?.(end, bytes.byteLength)
      },
      complete: async () => {
        await this.api(UPLOAD_COMPLETE, 'POST', {
          StorageNode: upload.StorageNode,
          bucket: upload.Bucket,
          fileId: upload.FileId,
          fileSize: bytes.byteLength,
          isMultipart: partCount > 1,
          key: upload.Key,
          uploadId: upload.UploadId,
        })
      },
    })
  }

  private async presignedSingle(upload: Pan123Upload): Promise<Record<string, string>> {
    const data = await this.api<{ presignedUrls?: Record<string, string> }>(S3_AUTH, 'POST', {
      StorageNode: upload.StorageNode,
      bucket: upload.Bucket,
      key: upload.Key,
      partNumberEnd: 2,
      partNumberStart: 1,
      uploadId: upload.UploadId,
    })
    return data?.presignedUrls ?? {}
  }

  private async presignedBatch(upload: Pan123Upload, partCount: number): Promise<Record<string, string>> {
    const data = await this.api<{ presignedUrls?: Record<string, string> }>(S3_PRESIGNED, 'POST', {
      bucket: upload.Bucket,
      key: upload.Key,
      partNumberEnd: partCount + 1,
      partNumberStart: 1,
      uploadId: upload.UploadId,
      StorageNode: upload.StorageNode,
    })
    return data?.presignedUrls ?? {}
  }

  async mkdir(path: string): Promise<void> {
    const clean = this.clean(path)
    if (clean === '/') return
    const parentId = await this.resolveFolder(driverParentPath(clean))
    const name = driverFileName(clean)
    await this.api(MK_DIR, 'POST', {
      driveId: 0, etag: '', fileName: name, parentFileId: Number(parentId) || 0, size: 0, type: 1,
    })
    this.pathIds.delete(clean)
  }

  async rename(path: string, newName: string): Promise<void> {
    const { file, parentId } = await this.resolveFile(path)
    await this.api(RENAME, 'POST', { driveId: 0, fileId: file.FileId, fileName: newName })
    this.pathIds.delete(driverChildPath(driverParentPath(this.clean(path)), newName))
    this.pathIds.delete(this.clean(path))
    void parentId
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const { file } = await this.resolveFile(fromPath)
    const target = this.clean(toPath)
    const targetName = driverFileName(target)
    if (targetName !== file.FileName) await this.rename(fromPath, targetName)
    const parentId = await this.resolveFolder(driverParentPath(target), true)
    await this.api(MOVE, 'POST', {
      fileIdList: [{ FileId: file.FileId }],
      parentFileId: Number(parentId) || 0,
    })
    this.pathIds.delete(this.clean(fromPath))
    this.pathIds.delete(target)
  }

  async remove(path: string): Promise<void> {
    const { file } = await this.resolveFile(path)
    await this.api(TRASH, 'POST', {
      driveId: 0,
      operation: true,
      fileTrashInfoList: [file],
    })
    this.pathIds.delete(this.clean(path))
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const info = await this.userInfo()
      return { ok: true, message: `123Pan is reachable${info.Nickname ? ` · ${String(info.Nickname)}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '123Pan is unavailable' }
    }
  }
}

export function create123PanDriver(ctx: DriverContext): MountDriver {
  return new Pan123Driver(ctx)
}
