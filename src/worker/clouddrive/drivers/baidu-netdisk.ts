/**
 * Baidu Netdisk driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/baidu_netdisk`.
 * Listing uses the web folder endpoint, a download is resolved from `filemetas` and either follows
 * the official redirect or uses the third-party dlink. Writes go through the documented xpan
 * `create`/`filemanager` methods, and uploads follow the reference flow: an md5 rapid-upload probe,
 * `precreate`, one multipart POST per slice to `superfile2`, then `create` to merge. Every path is
 * mapped to the account root; Baidu has no path lookup, so a stat walks the parent listing.
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
import { OAuthSession } from './token'

const PAN_API = 'https://pan.baidu.com'
const LIST_API = `${PAN_API}/api/list`
const FILE_METAS_API = `${PAN_API}/rest/2.0/xpan/multimedia`
const CRACK_FILE_METAS_API = `${PAN_API}/api/filemetas`
const XPAN_FILE_API = `${PAN_API}/rest/2.0/xpan/file`
const UPLOAD_API = 'https://d.pcs.baidu.com'
const SUPERFILE_API = `${UPLOAD_API}/rest/2.0/pcs/superfile2`
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50
const DEFAULT_CRACK_UA = 'netdisk'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

/** Reference defaults: a non-VIP account uploads 4 MiB slices with three workers. */
const SLICE_SIZE = 4 * 1024 * 1024
const SLICE_MD5_BYTES = 256 * 1024
const UPLOAD_CONCURRENCY = 3
const UPLOAD_SLICE_ATTEMPTS = 3
const UPLOAD_RETRY_BASE_MS = 1_000
const UPLOAD_RETRY_MAX_MS = 5_000
const UPLOAD_ROUNDS = 2
const UPLOAD_TIMEOUT_MS = 60_000

/** errno values that mean the access token is missing, expired or refused. */
const TOKEN_ERRORS = new Set([-6, 111, 31066, 20016])

interface BaiduFile {
  fs_id?: number
  path?: string
  server_filename?: string
  filename?: string
  size?: number
  isdir?: number
  server_ctime?: number
  server_mtime?: number
  ctime?: number
  mtime?: number
  category?: number
}

interface BaiduListBody {
  errno?: number
  errmsg?: string
  list?: BaiduFile[]
}

interface BaiduDownloadBody {
  errno?: number
  errmsg?: string
  /** `filemetas` answers under `list`, the third-party endpoint under `info`. */
  list?: Array<{ dlink?: string }>
  info?: Array<{ dlink?: string }>
}

/** `create` also answers `precreate`; `return_type` 2 means the content already exists. */
interface BaiduCreateBody {
  errno?: number
  return_type?: number
  uploadid?: string
  block_list?: number[]
  info?: unknown
}

interface BaiduManageBody {
  errno?: number
  /** A non-zero id means the server queued the operation despite `async=0`. */
  taskid?: number
  info?: Array<{ errno?: number; path?: string }>
}

interface BaiduSliceBody {
  error_code?: number
  errno?: number
}

/** The upload id expired, so the whole slice set must be prepared again. */
class UploadIdExpired extends Error {}

function md5Hex(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function basename(path: string | undefined): string {
  const value = String(path ?? '')
  return value.slice(value.lastIndexOf('/') + 1)
}

function decodedName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function entryOf(file: BaiduFile, fallbackName = ''): DriverEntry {
  const name = file.server_filename || file.filename || fallbackName || basename(file.path)
  const folder = file.isdir === 1
  const seconds = Number(file.server_mtime || file.mtime || file.server_ctime || file.ctime) || 0
  return {
    name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: seconds > 0 ? seconds * 1000 : 0,
    ref: file.fs_id === undefined ? undefined : String(file.fs_id),
    mime: folder ? 'application/octet-stream' : driverEntryMime(name),
  }
}

/** The dlink is forwarded without the bearer token; the resolved address is already signed. */
function sanitizeDlink(dlink: string): string {
  if (!dlink) return dlink
  try {
    const url = new URL(dlink)
    url.searchParams.delete('access_token')
    return url.toString()
  } catch {
    return dlink
  }
}

export class BaiduNetdiskDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('baidu_netdisk')!
  readonly capabilities = this.definition.capabilities
  private readonly session = new OAuthSession(this.ctx, 'baidu_netdisk')
  private readonly downloadApi: string

  constructor(ctx: DriverContext) {
    super(ctx)
    this.downloadApi = this.configText('downloadApi', 'official') || 'official'
  }

  protected async login(force: boolean): Promise<void> {
    await this.session.token(force)
  }

  /** Maps an API errno to the driver contract; HTTP statuses are already mapped by `request`. */
  private assertErrno(errno: number, operation: string): void {
    if (errno === 0) return
    if (TOKEN_ERRORS.has(errno) || errno === 401 || errno === 403) {
      throw DriverError.auth(`Baidu Netdisk refused the access token (errno ${errno})`)
    }
    if (errno === 404) throw DriverError.notFound(`Baidu Netdisk could not find ${operation}`)
    if (errno === 429) throw DriverError.rateLimited('Baidu Netdisk is rate limiting requests')
    throw DriverError.upstream(`Baidu Netdisk answered errno ${errno} for ${operation}`)
  }

  private parseJson<T>(text: string): T {
    try {
      return JSON.parse(text) as T
    } catch {
      throw DriverError.upstream('Baidu Netdisk returned an unexpected body')
    }
  }

  private async api<T extends { errno?: number }>(
    url: string,
    params: Record<string, string>,
  ): Promise<T> {
    return await this.session.withToken(async (token) => {
      const target = new URL(url)
      target.searchParams.set('access_token', token)
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
      const response = await this.request(target.toString(), {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      })
      const payload = this.parseJson<T>(await response.text())
      this.assertErrno(Number(payload.errno) || 0, url)
      return payload
    })
  }

  /** One form-encoded POST with an explicit token, parsed but not errno-checked. */
  private async formCall<T extends { errno?: number }>(
    url: string,
    params: Record<string, string>,
    form: Record<string, string>,
    token: string,
  ): Promise<T> {
    const target = new URL(url)
    target.searchParams.set('access_token', token)
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
    const response = await this.request(target.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams(form).toString(),
    })
    return this.parseJson<T>(await response.text())
  }

  private async post<T extends { errno?: number }>(
    url: string,
    params: Record<string, string>,
    form: Record<string, string>,
  ): Promise<T> {
    return await this.session.withToken(async (token) => {
      const payload = await this.formCall<T>(url, params, form, token)
      this.assertErrno(Number(payload.errno) || 0, url)
      return payload
    })
  }

  /** `filemanager` with `async=0`; a task id still counts as accepted by the server. */
  private async manage(
    opera: 'rename' | 'move' | 'copy' | 'delete',
    filelist: unknown,
  ): Promise<void> {
    const payload = await this.post<BaiduManageBody>(
      XPAN_FILE_API,
      { method: 'filemanager', opera },
      { async: '0', filelist: JSON.stringify(filelist), ondup: 'fail' },
    )
    if ((Number(payload.taskid) || 0) > 0) return
    for (const item of payload.info ?? []) {
      this.assertErrno(Number(item?.errno) || 0, `${opera} ${item?.path ?? ''}`)
    }
  }

  private async listPage(
    dir: string,
    start: number,
    limit: number,
  ): Promise<{ items: BaiduFile[]; next: string | null }> {
    const params: Record<string, string> = {
      dir,
      start: String(start),
      limit: String(limit),
      web: '1',
    }
    if (dir === '/') params.root = '1'
    const payload = await this.api<BaiduListBody>(LIST_API, params)
    const items = payload.list ?? []
    return {
      items,
      next: items.length >= limit ? String(start + items.length) : null,
    }
  }

  private async listAll(dir: string): Promise<BaiduFile[]> {
    const collected = await collectPages(async ({ cursor }) => {
      const start = cursor ? Number(cursor) || 0 : 0
      return await this.listPage(dir, start, PAGE_SIZE)
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    return collected.items
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const pageSize = Math.max(1, options.pageSize ?? PAGE_SIZE)
    const needle = options.search?.toLowerCase()
    if (options.page !== undefined) {
      const page = Math.max(1, options.page)
      const result = await this.listPage(clean, (page - 1) * pageSize, pageSize)
      let entries = result.items.map((file) => entryOf(file))
      if (needle) entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      return { entries, cursor: result.next, truncated: result.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const start = cursor ? Number(cursor) || 0 : 0
      return await this.listPage(clean, start, pageSize)
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    let entries = collected.items.map((file) => entryOf(file))
    if (needle) entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    return { entries, cursor: null, truncated: collected.truncated }
  }

  /** Baidu has no path lookup, so the parent listing decides whether the path exists. */
  private async resolve(clean: string): Promise<BaiduFile> {
    if (clean === '/') return { path: '/', server_filename: 'root', isdir: 1, size: 0 }
    const parent = driverParentPath(clean)
    const name = driverFileName(clean)
    const files = await this.listAll(parent)
    const found = files.find((file) =>
      file.path === clean
      || file.server_filename === name
      || file.server_filename === decodedName(name),
    )
    if (!found) throw DriverError.notFound(`Baidu Netdisk could not resolve ${clean}`)
    return found
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const file = await this.resolve(clean)
    return entryOf(file, clean === '/' ? 'root' : driverFileName(clean))
  }

  private async downloadDlink(clean: string, file: BaiduFile): Promise<{ url: string; headers: Record<string, string> }> {
    if (this.downloadApi === 'crack') {
      const payload = await this.api<BaiduDownloadBody>(CRACK_FILE_METAS_API, {
        target: JSON.stringify([clean]),
        dlink: '1',
        web: '5',
        origin: 'dlna',
      })
      const dlink = payload.info?.[0]?.dlink
      if (!dlink) throw DriverError.notFound(`Baidu Netdisk returned no dlink for ${clean}`)
      return {
        url: sanitizeDlink(dlink),
        headers: { 'User-Agent': this.configText('customCrackUa', DEFAULT_CRACK_UA) || DEFAULT_CRACK_UA },
      }
    }
    if (file.fs_id === undefined) throw DriverError.notFound(`Baidu Netdisk returned no fs_id for ${clean}`)
    const payload = await this.api<BaiduDownloadBody>(FILE_METAS_API, {
      method: 'filemetas',
      fsids: JSON.stringify([file.fs_id]),
      dlink: '1',
    })
    const dlink = payload.list?.[0]?.dlink
    if (!dlink) throw DriverError.notFound(`Baidu Netdisk returned no dlink for ${clean}`)
    return { url: dlink, headers: { 'User-Agent': 'pan.baidu.com' } }
  }

  private withToken(url: string, token: string): string {
    const target = new URL(url)
    target.searchParams.set('access_token', token)
    return target.toString()
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const file = await this.resolve(clean)
    if (file.isdir === 1) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadDlink(clean, file)
    const url = this.downloadApi === 'crack'
      ? link.url
      : this.withToken(link.url, await this.session.token())
    const response = await fetch(url, {
      headers: { ...link.headers, ...(range ? { Range: range } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined)
      const message = `Baidu Netdisk refused the download (HTTP ${response.status})`
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.notFound('The upstream download address was not found')
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined)
      const retry = Number(response.headers.get('retry-after'))
      throw DriverError.rateLimited(
        'Baidu Netdisk is rate limiting the download',
        Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
      )
    }
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`Baidu Netdisk download failed (HTTP ${response.status})`)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    const file = await this.resolve(clean)
    if (file.isdir === 1) return null
    const link = await this.downloadDlink(clean, file)
    if (this.downloadApi === 'crack') return link.url || null
    const response = await fetch(this.withToken(link.url, await this.session.token()), {
      method: 'HEAD',
      redirect: 'manual',
      headers: link.headers,
      signal: AbortSignal.timeout(20_000),
    })
    const location = response.headers.get('location') || link.url
    return sanitizeDlink(location) || null
  }

  /** Uploads through the reference flow: rapid md5 probe, precreate, slices, create. */
  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('A folder cannot be replaced by an upload')
    const bytes = await asBytes(body)
    if (bytes.byteLength < 1) throw DriverError.invalid('Baidu Netdisk does not allow empty files')
    if (bytes.byteLength !== options.size) {
      throw DriverError.invalid('The upload body does not match the declared size')
    }
    await this.session.withToken(async (token) => {
      await this.uploadBytes(clean, bytes, options, token)
    })
  }

  private async uploadBytes(
    path: string,
    bytes: Uint8Array,
    options: DriverUploadOptions,
    token: string,
  ): Promise<void> {
    const size = bytes.byteLength
    const now = Math.floor(Date.now() / 1000)
    const times = { local_mtime: String(now), local_ctime: String(now) }
    const contentMd5 = md5Hex(bytes)
    const sliceCount = Math.max(1, Math.ceil(size / SLICE_SIZE))
    const blockList: string[] = []
    for (let part = 0; part < sliceCount; part++) {
      const start = part * SLICE_SIZE
      blockList.push(md5Hex(bytes.subarray(start, Math.min(start + SLICE_SIZE, size))))
    }
    const blockListJson = JSON.stringify(blockList)
    const sliceMd5 = md5Hex(bytes.subarray(0, Math.min(SLICE_MD5_BYTES, size)))

    // Step 0: rapid upload. A successful `create` with the content md5 means the file already exists
    // on the server, so no slice is uploaded at all.
    const rapid = await this.formCall<BaiduCreateBody>(
      XPAN_FILE_API,
      { method: 'create' },
      { path, size: String(size), isdir: '0', rtype: '3', block_list: JSON.stringify([contentMd5]), ...times },
      token,
    )
    const rapidErrno = Number(rapid.errno) || 0
    if (rapidErrno === 0) {
      options.onProgress?.(size, size)
      return
    }
    if (TOKEN_ERRORS.has(rapidErrno) || rapidErrno === 401 || rapidErrno === 403) {
      throw DriverError.auth(`Baidu Netdisk refused the access token (errno ${rapidErrno})`)
    }
    if (rapidErrno === 404) throw DriverError.notFound(`Baidu Netdisk could not find ${path}`)
    if (rapidErrno === 429) throw DriverError.rateLimited('Baidu Netdisk is rate limiting requests')
    // Any other errno means "no matching content"; fall through to the chunked upload.

    // Step 1: precreate. The server answers the parts that are still missing.
    let pre = await this.post<BaiduCreateBody>(
      XPAN_FILE_API,
      { method: 'precreate' },
      {
        path,
        size: String(size),
        isdir: '0',
        autoinit: '1',
        rtype: '3',
        block_list: blockListJson,
        'content-md5': contentMd5,
        'slice-md5': sliceMd5,
        ...times,
      },
    )
    if (pre.return_type === 2 && pre.info) {
      options.onProgress?.(size, size)
      return
    }

    for (let round = 0; round < UPLOAD_ROUNDS; round++) {
      const uploadId = String(pre.uploadid ?? '')
      if (!uploadId) throw DriverError.upstream('Baidu Netdisk returned no upload id')
      const parts = Array.isArray(pre.block_list) && pre.block_list.length > 0
        ? pre.block_list.map(Number)
        : Array.from({ length: sliceCount }, (_, part) => part)
      try {
        await this.uploadSlices(path, bytes, parts, uploadId, token, options)
      } catch (error) {
        if (error instanceof UploadIdExpired && round < UPLOAD_ROUNDS - 1) {
          // The reference restarts precreate without the md5 hints when the upload id expires.
          pre = await this.post<BaiduCreateBody>(
            XPAN_FILE_API,
            { method: 'precreate' },
            { path, size: String(size), isdir: '0', autoinit: '1', rtype: '3', block_list: blockListJson, ...times },
          )
          if (pre.return_type === 2 && pre.info) {
            options.onProgress?.(size, size)
            return
          }
          continue
        }
        throw error
      }

      // Step 3: merge the uploaded slices into the final file.
      await this.post<BaiduCreateBody>(
        XPAN_FILE_API,
        { method: 'create' },
        { path, size: String(size), isdir: '0', rtype: '3', uploadid: uploadId, block_list: blockListJson, ...times },
      )
      options.onProgress?.(size, size)
      return
    }
    throw DriverError.upstream('Baidu Netdisk upload failed after retries')
  }

  private async uploadSlices(
    path: string,
    bytes: Uint8Array,
    parts: number[],
    uploadId: string,
    token: string,
    options: DriverUploadOptions,
  ): Promise<void> {
    if (parts.length === 0) return
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= parts.length) return
        const partseq = parts[index]!
        if (partseq < 0) continue
        const start = partseq * SLICE_SIZE
        const end = Math.min(start + SLICE_SIZE, bytes.byteLength)
        const slice = new Uint8Array(bytes.subarray(start, end))
        await this.uploadSlice(path, uploadId, partseq, slice, token)
        options.onProgress?.(end, bytes.byteLength)
      }
    }
    const workers = Math.max(1, Math.min(UPLOAD_CONCURRENCY, parts.length))
    await Promise.all(Array.from({ length: workers }, () => worker()))
  }

  /** A slice is retried three times with the reference's exponential backoff. */
  private async uploadSlice(
    path: string,
    uploadId: string,
    partseq: number,
    slice: Uint8Array,
    token: string,
  ): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < UPLOAD_SLICE_ATTEMPTS; attempt++) {
      try {
        await this.putSlice(path, uploadId, partseq, slice, token)
        return
      } catch (error) {
        if (error instanceof UploadIdExpired) throw error
        lastError = error
        if (attempt < UPLOAD_SLICE_ATTEMPTS - 1) {
          await sleep(Math.min(UPLOAD_RETRY_BASE_MS * 2 ** attempt, UPLOAD_RETRY_MAX_MS))
        }
      }
    }
    throw lastError
  }

  private async putSlice(
    path: string,
    uploadId: string,
    partseq: number,
    slice: Uint8Array,
    token: string,
  ): Promise<void> {
    const target = new URL(SUPERFILE_API)
    target.searchParams.set('method', 'upload')
    target.searchParams.set('access_token', token)
    target.searchParams.set('type', 'tmpfile')
    target.searchParams.set('path', path)
    target.searchParams.set('uploadid', uploadId)
    target.searchParams.set('partseq', String(partseq))
    const form = new FormData()
    form.append('file', new Blob([slice]), basename(path))

    let response: Response
    try {
      response = await fetch(target.toString(), {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      })
    } catch (error) {
      throw DriverError.upstream(
        `Baidu Netdisk could not upload slice ${partseq}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const text = await response.text()
    if (response.status === 401 || response.status === 403) {
      throw DriverError.auth(`Baidu Netdisk refused the upload token (HTTP ${response.status})`)
    }
    if (response.status === 404) throw DriverError.notFound(`Baidu Netdisk did not accept slice ${partseq}`)
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'))
      throw DriverError.rateLimited(
        'Baidu Netdisk is rate limiting the upload',
        Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
      )
    }
    if (!response.ok) {
      throw DriverError.upstream(`Baidu Netdisk rejected slice ${partseq} (HTTP ${response.status})`)
    }
    const lower = text.toLowerCase()
    if (lower.includes('uploadid') && (lower.includes('invalid') || lower.includes('expired') || lower.includes('not found'))) {
      throw new UploadIdExpired()
    }
    const payload = (() => {
      try {
        return JSON.parse(text) as BaiduSliceBody
      } catch {
        return {} as BaiduSliceBody
      }
    })()
    const errno = Number(payload.errno) || 0
    if (TOKEN_ERRORS.has(errno) || errno === 401 || errno === 403) {
      throw DriverError.auth(`Baidu Netdisk refused the upload token (errno ${errno})`)
    }
    if ((Number(payload.error_code) || 0) !== 0 || errno !== 0) {
      throw DriverError.upstream(`Baidu Netdisk rejected slice ${partseq}: ${text.slice(0, 200)}`)
    }
  }

  /** The new file name must stay a single path segment. */
  private validName(input: string): string {
    const name = String(input ?? '').trim()
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw DriverError.invalid('The new name is invalid')
    }
    return name
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    await this.post<BaiduCreateBody>(
      XPAN_FILE_API,
      { method: 'create' },
      { path: clean, size: '0', isdir: '1', rtype: '3' },
    )
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const name = this.validName(newName)
    await this.manage('rename', [{ path: clean, newname: name }])
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/' || to === '/') throw DriverError.invalid('The root folder cannot be moved')
    await this.manage('move', [
      { path: from, dest: driverParentPath(to), newname: driverFileName(to) },
    ])
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/' || to === '/') throw DriverError.invalid('The root folder cannot be copied')
    await this.manage('copy', [
      { path: from, dest: driverParentPath(to), newname: driverFileName(to) },
    ])
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The root folder cannot be removed')
    await this.manage('delete', [clean])
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.list('/', { page: 1, pageSize: 1 })
      return { ok: true, message: 'Baidu Netdisk is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Baidu Netdisk is unavailable' }
    }
  }
}

export function createBaiduNetdiskDriver(ctx: DriverContext): MountDriver {
  return new BaiduNetdiskDriver(ctx)
}
