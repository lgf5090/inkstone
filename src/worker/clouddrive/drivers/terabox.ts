/**
 * TeraBox driver (official endpoints only).
 *
 * Ported from `OpenList-Worker/src/backend/drivers/terabox`: requests carry the browser cookie and
 * the `app_id`/`web`/`channel` query envelope, listings page by `page`/`num`, download links are
 * signed from `home/info` (`sign` + `timestamp`) and resolved through their first redirect, and
 * uploads use `precreate` → `superfile2` parts → `create`. The reference's `crack` channel is
 * deliberately not ported because the registry declares `downloadApi=official` only.
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
import { cookieHeader, mergeResponseCookies, parseCookies, type CookieJar } from './cookies'
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
  uploadInParts,
} from './http'

const DEFAULT_BASE = 'https://www.terabox.com'
const UA = 'terabox;1.37.0.7;PC;PC-Windows;10.0.22631;WindowsTeraBox'
const DOWNLOAD_UA = UA
const PAGE_SIZE = 100
const MAX_PAGES = 50
const UPLOAD_PART_SIZE = 4 * 1024 * 1024

interface TeraboxFile {
  fs_id: number
  server_mtime?: number
  size?: number
  server_filename: string
  isdir?: number
  thumbs?: { url3?: string }
}

interface TeraboxList {
  errno?: number
  list?: TeraboxFile[]
}

interface TeraboxHome {
  errno?: number
  data?: { sign1?: string; sign3?: string }
}

interface TeraboxDownload {
  errno?: number
  dlink?: Array<{ dlink?: string }>
}

interface TeraboxPrecreate {
  errno?: number
  uploadid?: string
  return_type?: number
}

interface TeraboxRequestOptions {
  method?: 'GET' | 'POST'
  params?: Record<string, string>
  form?: boolean
  body?: Record<string, string>
  retryCount?: number
}

function modifiedAt(seconds?: number): number {
  return seconds && Number.isFinite(seconds) ? seconds * 1000 : 0
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!)
  }
  return btoa(binary)
}

/** RFC 1321 MD5; SubtleCrypto has no MD5 and the upload manifest requires it. */
function md5Hex(input: Uint8Array): string {
  const message = input
  const bitLength = message.length * 8
  const padLength = (56 - ((message.length + 1) % 64) + 64) % 64
  const padded = new Uint8Array(message.length + 1 + padLength + 8)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLength >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000), true)

  const shift = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ] as const
  const table = new Int32Array(64)
  for (let index = 0; index < 64; index += 1) {
    table[index] = (Math.abs(Math.sin(index + 1)) * 0x100000000) | 0
  }

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  for (let offset = 0; offset < padded.length; offset += 64) {
    const chunk = new DataView(padded.buffer, offset, 64)
    const words = Array.from({ length: 16 }, (_, index) => chunk.getInt32(index * 4, true))
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let index = 0; index < 64; index += 1) {
      let f: number
      let g: number
      if (index < 16) {
        f = (b & c) | (~b & d)
        g = index
      } else if (index < 32) {
        f = (d & b) | (~d & c)
        g = (5 * index + 1) % 16
      } else if (index < 48) {
        f = b ^ c ^ d
        g = (3 * index + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * index) % 16
      }
      const previous = d
      d = c
      c = b
      const sum = (a + f + table[index]! + words[g]!) | 0
      b = (b + ((sum << shift[index]!) | (sum >>> (32 - shift[index]!)))) | 0
      a = previous
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }

  const result = new DataView(new ArrayBuffer(16))
  result.setInt32(0, a0, true)
  result.setInt32(4, b0, true)
  result.setInt32(8, c0, true)
  result.setInt32(12, d0, true)
  return Array.from(new Uint8Array(result.buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The RC4-shaped obfuscation TeraBox uses for its download signature. */
function teraboxSign(key: string, data: string): string {
  const state = new Array<number>(256)
  const permutation = new Array<number>(256)
  const output: number[] = []
  for (let index = 0; index < 256; index += 1) {
    state[index] = key.charCodeAt(index % key.length)
    permutation[index] = index
  }
  let swap = 0
  for (let index = 0; index < 256; index += 1) {
    swap = (swap + permutation[index]! + state[index]!) % 256
    const temporary = permutation[index]!
    permutation[index] = permutation[swap]!
    permutation[swap] = temporary
  }
  let i = 0
  let j = 0
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) % 256
    j = (j + permutation[i]!) % 256
    const temporary = permutation[i]!
    permutation[i] = permutation[j]!
    permutation[j] = temporary
    const keyByte = permutation[(permutation[i]! + permutation[j]!) % 256]!
    output.push(data.charCodeAt(index) ^ keyByte)
  }
  return bytesToBase64(new Uint8Array(output))
}

function fileEntry(file: TeraboxFile): DriverEntry {
  const folder = file.isdir === 1
  return {
    name: file.server_filename,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(file.size) || 0,
    modifiedAt: modifiedAt(file.server_mtime),
    ref: String(file.fs_id),
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.server_filename),
  }
}

function errnoError(errno: number, message = ''): DriverError {
  if (errno === 9000) return DriverError.upstream('TeraBox is not available in this area (errno 9000)')
  if (errno === 401 || errno === 403) return DriverError.auth(message || `TeraBox refused the request (errno ${errno})`)
  if (errno === 429) return DriverError.rateLimited(message || 'TeraBox is rate limiting requests')
  if (errno === -9 || errno === 404) return DriverError.notFound(message || 'Not found upstream')
  return DriverError.upstream(message || `TeraBox answered errno ${errno}`)
}

function downloadStatusError(status: number): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`TeraBox refused the download (HTTP ${status})`)
  if (status === 404) return DriverError.notFound('The download address was not found (HTTP 404)')
  if (status === 429) return DriverError.rateLimited('The download was rate limited')
  return DriverError.upstream(`TeraBox download failed (HTTP ${status})`)
}

class TeraboxDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('terabox')!
  readonly capabilities = this.definition.capabilities
  private jar: CookieJar = {}
  private baseUrl = DEFAULT_BASE
  private jsToken = ''

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private rootFolderPath(): string {
    return driverPath(this.configText('rootFolderPath', '/'))
  }

  private upstreamPath(input: string): string {
    const clean = driverPath(input)
    const root = this.rootFolderPath()
    if (root === '/') return clean
    if (clean === '/') return root
    return `${root}${clean}`
  }

  private headers(): Record<string, string> {
    return {
      Cookie: cookieHeader(this.jar),
      Accept: 'application/json, text/plain, */*',
      Referer: this.baseUrl,
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
    }
  }

  private async absorbCookies(response: Response): Promise<void> {
    const before = cookieHeader(this.jar)
    mergeResponseCookies(this.jar, response)
    const after = cookieHeader(this.jar)
    if (after !== before) await this.saveCredential({ cookie: after })
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && Object.keys(this.jar).length > 0) return
    const raw = (this.ctx.credentials.cookie ?? '').trim()
    if (!raw) {
      const message = 'TeraBox needs a browser cookie for this account'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    this.jar = parseCookies(raw)
  }

  private async resetJsToken(): Promise<void> {
    const response = await this.request(this.baseUrl, { method: 'GET', headers: this.headers() })
    await this.absorbCookies(response)
    const html = await response.text()
    const match = html.match(/jsToken\s*=\s*["']([^"']+)["']/)
      ?? html.match(/fn%28%22([^"']+?)%22%29/)
    this.jsToken = match?.[1] ?? ''
  }

  private async rawRequest<T>(pathOrUrl: string, options: TeraboxRequestOptions = {}): Promise<T> {
    const {
      method = 'GET',
      params,
      form = false,
      body,
      retryCount = 0,
    } = options
    let url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`
    const query: Record<string, string> = {
      app_id: '250528',
      web: '1',
      channel: 'dubox',
      clienttype: '0',
      ...(params ?? {}),
    }
    if (this.jsToken) query.jsToken = this.jsToken
    url += `${url.includes('?') ? '&' : '?'}${new URLSearchParams(query).toString()}`

    const headers = this.headers()
    let requestBody: string | undefined
    if (body) {
      if (form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        requestBody = new URLSearchParams(body).toString()
      } else {
        headers['Content-Type'] = 'application/json'
        requestBody = JSON.stringify(body)
      }
    }

    const response = await this.request(url, { method, headers, body: requestBody })
    await this.absorbCookies(response)
    const text = await response.text()
    let payload: T & { errno?: number }
    try {
      payload = JSON.parse(text) as T & { errno?: number }
    } catch {
      throw DriverError.upstream('TeraBox returned a body that is not JSON')
    }
    if (!payload || typeof payload !== 'object') throw DriverError.upstream('TeraBox returned an empty answer')

    const errno = Number(payload.errno)
    if ((errno === 4000023 || errno === 450016) && retryCount < 2) {
      await this.resetJsToken()
      return await this.rawRequest<T>(pathOrUrl, { ...options, retryCount: retryCount + 1 })
    }
    if (errno === -6 && retryCount < 2) {
      const prefix = response.headers.get('url-domain-prefix')
      if (prefix) {
        this.baseUrl = `https://${prefix}.terabox.com`
        return await this.rawRequest<T>(pathOrUrl, { ...options, retryCount: retryCount + 1 })
      }
    }
    return payload as T
  }

  private async api<T>(pathOrUrl: string, options: TeraboxRequestOptions = {}): Promise<T> {
    return await this.withAuth(async () => await this.rawRequest<T>(pathOrUrl, options))
  }

  private async listPage(physicalPath: string, page: number, pageSize: number): Promise<TeraboxList> {
    const data = await this.api<TeraboxList>('/api/list', {
      method: 'GET',
      params: { dir: physicalPath, page: String(page), num: String(pageSize) },
    })
    if (data?.errno !== undefined && data.errno !== 0) throw errnoError(data.errno)
    return data
  }

  private async resolveEntry(path: string): Promise<{ entry: DriverEntry; physical: string; folder: boolean }> {
    const clean = driverPath(path)
    if (clean === '/') {
      return {
        entry: { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '', mime: 'application/octet-stream' },
        physical: this.upstreamPath('/'),
        folder: true,
      }
    }
    const physical = this.upstreamPath(clean)
    const parent = driverParentPath(physical)
    const name = driverFileName(physical)
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await this.listPage(parent, page, PAGE_SIZE)
      const list = data?.list ?? []
      const hit = list.find((file) => file.server_filename === name)
      if (hit) return { entry: fileEntry(hit), physical, folder: hit.isdir === 1 }
      if (list.length < PAGE_SIZE) break
    }
    throw DriverError.notFound(`Not found: ${name}`)
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const physical = this.upstreamPath(clean)
    const pageSize = Math.max(1, Math.min(1000, options.pageSize ?? PAGE_SIZE))

    if (options.page !== undefined) {
      const page = Math.max(1, options.page)
      const data = await this.listPage(physical, page, pageSize)
      const list = data?.list ?? []
      const hasMore = list.length >= pageSize
      return {
        entries: list.map(fileEntry),
        cursor: hasMore ? String(page + 1) : null,
        truncated: hasMore,
      }
    }

    const collected = await collectPages(async ({ page }) => {
      const data = await this.listPage(physical, page, pageSize)
      const list = data?.list ?? []
      return { items: list, next: list.length < pageSize ? null : String(page + 1) }
    }, { maxPages: MAX_PAGES })
    return { entries: collected.items.map(fileEntry), cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return {
        name: 'root',
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
        ref: '',
        mime: 'application/octet-stream',
      }
    }
    const resolved = await this.resolveEntry(clean)
    return resolved.entry
  }

  private async genSign(): Promise<string> {
    const home = await this.api<TeraboxHome>('/api/home/info', { method: 'GET' })
    const sign1 = home?.data?.sign1 ?? ''
    const sign3 = home?.data?.sign3 ?? ''
    if (!sign1 || !sign3) throw DriverError.upstream('TeraBox did not return its signing keys')
    return teraboxSign(sign3, sign1)
  }

  private async linkOfficial(fsId: string | number): Promise<string> {
    const sign = await this.genSign()
    const data = await this.api<TeraboxDownload>('/api/download', {
      method: 'GET',
      params: {
        type: 'dlink',
        fidlist: `[${fsId}]`,
        sign,
        vip: '2',
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
    })
    const link = data?.dlink?.[0]?.dlink ?? ''
    if (!link) throw DriverError.upstream(`TeraBox returned no download link (errno ${data?.errno ?? 0})`)

    const response = await fetch(link, {
      method: 'GET',
      redirect: 'manual',
      headers: { Cookie: cookieHeader(this.jar), 'User-Agent': DOWNLOAD_UA },
      signal: AbortSignal.timeout(30_000),
    })
    await this.absorbCookies(response)
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    return location || link
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const resolved = await this.resolveEntry(clean)
    if (resolved.folder) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.linkOfficial(resolved.entry.ref ?? '')
    const response = await fetch(link, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': DOWNLOAD_UA,
        ...(range ? { Range: range } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw downloadStatusError(response.status)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    const resolved = await this.resolveEntry(clean)
    if (resolved.folder) return null
    return await this.linkOfficial(resolved.entry.ref ?? '')
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const physical = this.upstreamPath(clean)
    const parent = driverParentPath(physical)
    const name = driverFileName(physical)
    if (!name) throw DriverError.invalid('An upload needs a file name')

    const located = await this.json<{ host?: string }>('https://jp-data.terabox.com/rest/2.0/pcs/file?method=locateupload')
    const host = located?.host || 'd.terabox.com'

    const partSize = UPLOAD_PART_SIZE
    const partCount = Math.max(1, Math.ceil(bytes.byteLength / partSize))
    const blockList = Array.from({ length: partCount }, (_, index) => {
      const start = index * partSize
      return md5Hex(bytes.subarray(start, Math.min(start + partSize, bytes.byteLength)))
    })

    const precreate = await this.api<TeraboxPrecreate>('/api/precreate', {
      method: 'POST',
      form: true,
      body: {
        path: physical,
        autoinit: '1',
        target_path: parent,
        block_list: JSON.stringify(blockList),
        local_mtime: String(Math.floor(Date.now() / 1000)),
        file_limit_switch_v34: 'true',
      },
    })
    if (precreate?.errno !== undefined && precreate.errno !== 0) throw errnoError(precreate.errno)
    if (precreate?.return_type === 2) {
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    const uploadId = precreate?.uploadid ?? ''
    if (!uploadId) throw DriverError.upstream('TeraBox did not open an upload session')

    await uploadInParts({
      size: bytes.byteLength,
      partSize,
      concurrency: 3,
      uploadPart: async (partNumber, start, end) => {
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(bytes.subarray(start, end))]), name)
        const response = await fetch(
          `https://${host}/rest/2.0/pcs/superfile2?method=upload&path=${encodeURIComponent(physical)}` +
          `&uploadid=${encodeURIComponent(uploadId)}&partseq=${partNumber - 1}`,
          {
            method: 'POST',
            headers: { Cookie: cookieHeader(this.jar), 'User-Agent': DOWNLOAD_UA },
            body: form,
            signal: AbortSignal.timeout(60_000),
          },
        )
        await this.absorbCookies(response)
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw DriverError.upstream(`TeraBox upload part ${partNumber} failed (HTTP ${response.status})`)
        }
        options.onProgress?.(end, bytes.byteLength)
      },
      complete: async () => {
        const created = await this.api<TeraboxList>('/api/create', {
          method: 'POST',
          form: true,
          params: { isdir: '0', rtype: '1' },
          body: {
            path: physical,
            size: String(bytes.byteLength),
            uploadid: uploadId,
            target_path: parent,
            block_list: JSON.stringify(blockList),
            local_mtime: String(Math.floor(Date.now() / 1000)),
          },
        })
        if (created?.errno !== undefined && created.errno !== 0) throw errnoError(created.errno)
      },
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const physical = this.upstreamPath(clean)
    const data = await this.api<TeraboxList>('/api/create', {
      method: 'POST',
      form: true,
      params: { a: 'commit' },
      body: { path: physical, isdir: '1', block_list: '[]' },
    })
    if (data?.errno !== undefined && data.errno !== 0) throw errnoError(data.errno)
  }

  private async manage(opera: string, fileList: Array<Record<string, string> | string>): Promise<void> {
    const data = await this.api<TeraboxList>('/api/filemanager', {
      method: 'POST',
      form: true,
      params: { onnest: 'fail', opera },
      body: {
        async: '0',
        filelist: JSON.stringify(fileList),
        ondup: 'newcopy',
      },
    })
    if (data?.errno !== undefined && data.errno !== 0) throw errnoError(data.errno)
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const name = newName.trim()
    const problem = cloudDriveNameProblem(name)
    if (problem) throw DriverError.invalid(problem)
    const physical = this.upstreamPath(clean)
    await this.manage('rename', [{ path: physical, newname: name }])
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === to) return
    const source = this.upstreamPath(from)
    const target = this.upstreamPath(to)
    await this.manage('move', [{
      path: source,
      dest: driverParentPath(target),
      newname: driverFileName(target),
    }])
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === to) return
    const source = this.upstreamPath(from)
    const target = this.upstreamPath(to)
    await this.manage('copy', [{
      path: source,
      dest: driverParentPath(target),
      newname: driverFileName(target),
    }])
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.manage('delete', [this.upstreamPath(clean)])
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.listPage(this.upstreamPath('/'), 1, 1)
      return { ok: true, message: 'TeraBox is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'TeraBox is unavailable' }
    }
  }
}

export function createTeraboxDriver(ctx: DriverContext): MountDriver {
  return new TeraboxDriver(ctx)
}
