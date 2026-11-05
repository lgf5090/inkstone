/**
 * Tencent Weiyun driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/weiyun`: the API is a JSON envelope posted to
 * `weiyunQdisk`/`weiyunQdiskClient` endpoints, folders are listed with `start`/`count` offsets,
 * download URLs come with their own cookie pair, and uploads use the FTN protocol (pre-upload with
 * SHA-1 block state, `UploadPiece` chunks, and the server's own completion state).
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

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://www.weiyun.com'
const PAGE_SIZE = 500
const MAX_PAGES = 50
const UPLOAD_CHUNK_SIZE = 1024 * 1024

type Protocol = 'weiyunQdisk' | 'weiyunQdiskClient' | 'weiyunFileLibClient' | 'preUpload' | 'upload'

interface WeiyunFile {
  file_id: string
  filename: string
  file_size?: number
  file_mtime?: number | string
  file_ctime?: number | string
  pdir_key?: string
}

interface WeiyunFolder {
  dir_key: string
  dir_name: string
  dir_mtime?: number | string
  dir_ctime?: number | string
  pdir_key?: string
}

interface WeiyunFolderPath extends WeiyunFolder {
  pdir_key: string
}

interface WeiyunListData {
  dir_list?: WeiyunFolder[]
  file_list?: WeiyunFile[]
  finish_flag?: boolean
}

interface WeiyunDownload {
  download_url: string
  cookie_name?: string
  cookie_value?: string
}

interface WeiyunUploadChannel {
  id: number
  offset: number
  len: number
}

interface WeiyunPreUpload {
  file_exist?: boolean
  upload_key?: string
  ex?: string
  channel_list?: WeiyunUploadChannel[]
}

interface WeiyunPieceResult {
  upload_state?: number
  channel?: WeiyunUploadChannel
}

interface ResolvedFolder {
  dirKey: string
  pdirKey: string
  dirName: string
}

interface WeiyunEnvelope {
  ret?: number
  msg?: string
  data?: unknown
  result?: unknown
}

function modifiedAt(value?: number | string): number {
  const raw = typeof value === 'string' ? Number.parseInt(value, 10) : value
  if (!raw || !Number.isFinite(raw)) return 0
  return raw < 1e10 ? raw * 1000 : raw
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!)
  }
  return btoa(binary)
}

/** A pure-TS SHA-1 whose intermediate state is exposed for the FTN block manifest. */
class IncrementalSha1 {
  private h0 = 0x67452301
  private h1 = 0xefcdab89
  private h2 = 0x98badcfe
  private h3 = 0x10325476
  private h4 = 0xc3d2e1f0
  private readonly block = new Uint8Array(64)
  private blockLength = 0
  private totalBytes = 0
  private readonly words = new Int32Array(80)

  update(data: Uint8Array): this {
    this.totalBytes += data.length
    let offset = 0
    while (offset < data.length) {
      const needed = 64 - this.blockLength
      const copy = Math.min(needed, data.length - offset)
      this.block.set(data.subarray(offset, offset + copy), this.blockLength)
      this.blockLength += copy
      offset += copy
      if (this.blockLength === 64) {
        this.process(this.block)
        this.blockLength = 0
      }
    }
    return this
  }

  private process(block: Uint8Array): void {
    const words = this.words
    for (let index = 0; index < 16; index += 1) {
      const at = index * 4
      words[index] =
        (block[at]! << 24) | (block[at + 1]! << 16) | (block[at + 2]! << 8) | block[at + 3]!
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(
        words[index - 3]! ^ words[index - 8]! ^ words[index - 14]! ^ words[index - 16]!,
        1,
      )
    }

    let a = this.h0
    let b = this.h1
    let c = this.h2
    let d = this.h3
    let e = this.h4
    for (let index = 0; index < 80; index += 1) {
      let f: number
      let k: number
      if (index < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (index < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const sum = (rotateLeft(a, 5) + f + e + k + words[index]!) | 0
      e = d
      d = c
      c = rotateLeft(b, 30)
      b = a
      a = sum
    }
    this.h0 = (this.h0 + a) | 0
    this.h1 = (this.h1 + b) | 0
    this.h2 = (this.h2 + c) | 0
    this.h3 = (this.h3 + d) | 0
    this.h4 = (this.h4 + e) | 0
  }

  stateHex(): string {
    let hex = ''
    for (const word of [this.h0, this.h1, this.h2, this.h3, this.h4]) {
      hex += (word & 0xff).toString(16).padStart(2, '0')
      hex += ((word >>> 8) & 0xff).toString(16).padStart(2, '0')
      hex += ((word >>> 16) & 0xff).toString(16).padStart(2, '0')
      hex += ((word >>> 24) & 0xff).toString(16).padStart(2, '0')
    }
    return hex
  }

  digestHex(): string {
    const clone = new IncrementalSha1()
    clone.h0 = this.h0
    clone.h1 = this.h1
    clone.h2 = this.h2
    clone.h3 = this.h3
    clone.h4 = this.h4
    clone.block.set(this.block)
    clone.blockLength = this.blockLength
    clone.totalBytes = this.totalBytes

    const padLength = clone.blockLength < 56 ? 56 - clone.blockLength : 120 - clone.blockLength
    const pad = new Uint8Array(padLength + 8)
    pad[0] = 0x80
    const hi = Math.floor(clone.totalBytes / 0x20000000)
    const lo = (clone.totalBytes * 8 & 0xffffffff) >>> 0
    const view = new DataView(pad.buffer, pad.byteOffset + padLength, 8)
    view.setUint32(0, hi, false)
    view.setUint32(4, lo, false)
    clone.update(pad)

    return [clone.h0, clone.h1, clone.h2, clone.h3, clone.h4]
      .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
      .join('')
  }
}

function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift))
}

function folderEntry(folder: WeiyunFolder): DriverEntry {
  return {
    name: folder.dir_name,
    kind: 'folder',
    size: 0,
    modifiedAt: modifiedAt(folder.dir_mtime ?? folder.dir_ctime),
    ref: folder.dir_key,
    mime: 'application/octet-stream',
  }
}

function fileEntry(file: WeiyunFile): DriverEntry {
  return {
    name: file.filename,
    kind: 'file',
    size: Number(file.file_size) || 0,
    modifiedAt: modifiedAt(file.file_mtime ?? file.file_ctime),
    ref: file.file_id,
    mime: driverEntryMime(file.filename),
  }
}

function retError(code: number, message: string, fallback: string): DriverError {
  const detail = message || fallback
  if (code === 401 || code === 403) return DriverError.auth(`Weiyun refused the cookie: ${detail}`)
  if (code === 404) return DriverError.notFound(detail)
  if (code === 429) return DriverError.rateLimited(detail)
  return DriverError.upstream(detail)
}

function downloadStatusError(status: number): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`Weiyun refused the download (HTTP ${status})`)
  if (status === 404) return DriverError.notFound('The download address was not found (HTTP 404)')
  if (status === 429) return DriverError.rateLimited('The download was rate limited')
  return DriverError.upstream(`Weiyun download failed (HTTP ${status})`)
}

function bodyOf(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined
  const body = (result as { rsp_body?: { RspMsg_body?: unknown } }).rsp_body
  return body?.RspMsg_body
}

class WeiyunDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('weiyun')!
  readonly capabilities = this.definition.capabilities
  private jar: CookieJar = {}
  private rootFolderId = ''
  private rootPdirKey = ''
  private rootDirName = 'root'
  private readonly pathFolders = new Map<string, ResolvedFolder>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private uploadThreads(): number {
    const raw = this.ctx.config.uploadThread
    const value = typeof raw === 'number' ? raw : Number(raw)
    return Math.min(8, Math.max(1, Number.isFinite(value) ? Math.floor(value) : 3))
  }

  private async absorbCookies(response: Response): Promise<void> {
    const before = cookieHeader(this.jar)
    mergeResponseCookies(this.jar, response)
    const after = cookieHeader(this.jar)
    if (after !== before) await this.saveCredential({ cookies: after })
  }

  private async refreshCtoken(): Promise<void> {
    const response = await fetch('https://www.weiyun.com/disk', {
      method: 'GET',
      redirect: 'manual',
      headers: { Cookie: cookieHeader(this.jar), Referer: REFERER, 'User-Agent': UA },
      signal: AbortSignal.timeout(20_000),
    })
    await this.absorbCookies(response)
    const location = response.headers.get('location') ?? ''
    await response.body?.cancel().catch(() => undefined)
    if (response.status >= 300 && response.status < 400 && location && !location.includes('/disk')) {
      throw DriverError.auth('The Weiyun cookie has expired')
    }
    if (!response.ok && !(response.status >= 300 && response.status < 400)) {
      throw DriverError.upstream(`Weiyun token refresh failed (HTTP ${response.status})`)
    }
  }

  protected async login(force: boolean): Promise<void> {
    const raw = (this.ctx.credentials.cookies ?? '').trim()
    if (!raw) {
      const message = 'Weiyun needs a browser cookie for this account'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    this.jar = parseCookies(raw)
    const openid = this.jar.wxopenid ?? this.jar.weiyun_wx_openid ?? ''
    const uid = this.jar.uid ?? ''
    if (!openid || !uid) {
      const message = 'Weiyun needs a browser cookie that contains wxopenid and uid'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    if (!this.jar.wyctoken) await this.refreshCtoken()
    if (!force || !this.rootFolderId) {
      try {
        await this.loadRoot()
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'auth') {
          await this.ctx.markNeedsReauth(error.message)
        }
        throw error
      }
    }
  }

  private async loadRoot(): Promise<void> {
    this.rootFolderId = this.configText('rootFolderId').trim()
    if (!this.rootFolderId) {
      const info = await this.rawRequest<{ main_dir_key?: string; root_dir_key?: string }>(
        'weiyunQdiskClient',
        'DiskUserInfoGet',
        2201,
        {
          is_get_upload_flow_flag: false,
          is_get_high_speed_flow_info: false,
          is_get_weiyun_flag: false,
          is_get_space_clean_info: false,
          is_get_user_reward_info: false,
        },
      )
      this.rootFolderId = info?.main_dir_key || info?.root_dir_key || ''
      if (!this.rootFolderId) throw DriverError.upstream('Weiyun did not return a root folder')
    }
    const folders = await this.rawRequest<WeiyunFolderPath[]>('weiyunFileLibClient', 'LibDirPathGet', 26150, {
      dir_key: this.rootFolderId,
    })
    const last = folders?.[folders.length - 1]
    this.rootPdirKey = last?.pdir_key ?? ''
    this.rootDirName = last?.dir_name ?? 'root'
    this.pathFolders.clear()
  }

  private tokenInfo(): Record<string, unknown> {
    const wyUf = this.jar.wy_uf
    if (wyUf === '1') {
      return {
        token_type: 1,
        openid: this.jar.openid ?? this.jar.wxopenid ?? '',
        open_appid: this.jar.wy_appid ?? '',
        access_token: this.jar.access_token ?? '',
        login_key_type: 192,
        login_key_value: this.jar.access_token ?? '',
      }
    }
    if (wyUf === '0') {
      return {
        token_type: 0,
        login_key_type: 27,
        login_key_value: this.jar.p_skey ?? this.jar.skey ?? '',
        openid: '',
      }
    }
    return { token_type: 3, login_key_type: 1540 }
  }

  private header(cmd: number, tokenInfo: Record<string, unknown>): Record<string, unknown> {
    return {
      seq: Math.floor(Date.now() / 1000),
      cmd,
      wx_openid: String(tokenInfo.openid ?? tokenInfo.minico_openid ?? ''),
      qq_openid: String(tokenInfo.qq_openid ?? ''),
      user_flag: tokenInfo.token_type ?? 0,
      env_id: String(tokenInfo.env_id ?? ''),
      type: 1,
      appid: 30013,
      version: 3,
      major_version: 3,
      minor_version: 3,
      fix_version: 3,
    }
  }

  private body(cmdName: string, data: unknown, tokenInfo: Record<string, unknown>): Record<string, unknown> {
    return {
      ReqMsg_body: {
        ext_req_head: {
          token_info: tokenInfo,
          language_info: { language_type: 2052 },
        },
        [`.weiyun.${cmdName}MsgReq_body`]: data,
      },
    }
  }

  private uploadJson(cmdName: string, cmd: number, data: unknown): Record<string, unknown> {
    return {
      req_header: {
        cmd,
        appid: 30013,
        major_version: 3,
        minor_version: 0,
        fix_version: 0,
        version: 3,
        user_flag: 0,
      },
      req_body: { ReqMsg_body: { [`weiyun.${cmdName}MsgReq_body`]: data } },
    }
  }

  private async rawRequest<T>(
    protocol: Protocol,
    cmdName: string,
    cmd: number,
    data: unknown,
    fileBuffer?: Uint8Array,
  ): Promise<T> {
    const tokenInfo = this.tokenInfo()
    const token = this.jar.wyctoken ?? ''
    const headers: Record<string, string> = {
      Cookie: cookieHeader(this.jar),
      Referer: REFERER,
      'User-Agent': UA,
    }
    let url: string
    let body: string | Uint8Array

    if (protocol === 'preUpload') {
      url = `https://www.weiyun.com/api/v3/ftn_pre_upload?g_tk=${encodeURIComponent(token)}&cmd=${cmd}`
      body = JSON.stringify(this.uploadJson(cmdName, cmd, data))
      headers['Content-Type'] = 'application/json; charset=UTF-8'
    } else if (protocol === 'upload') {
      url = `https://upload.weiyun.com/ftnup_v2/weiyun?g_tk=${encodeURIComponent(token)}&cmd=${cmd}`
      const boundary = '----WebKitFormBoundaryIifrOqiswelC8nfe'
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
      const upload = JSON.stringify(this.uploadJson(cmdName, cmd, data))
      const part1 = `--${boundary}\r\nContent-Disposition: form-data; name="json"\r\n\r\n${upload}\r\n`
      const part2 = fileBuffer && fileBuffer.length > 0
        ? `--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`
        : ''
      const end = `\r\n--${boundary}--\r\n`
      const encoder = new TextEncoder()
      const prefix = encoder.encode(part1)
      const filePrefix = part2 ? encoder.encode(part2) : new Uint8Array(0)
      const suffix = encoder.encode(end)
      const file = fileBuffer ?? new Uint8Array(0)
      const full = new Uint8Array(prefix.length + filePrefix.length + file.length + suffix.length)
      full.set(prefix, 0)
      full.set(filePrefix, prefix.length)
      full.set(file, prefix.length + filePrefix.length)
      full.set(suffix, prefix.length + filePrefix.length + file.length)
      body = full
    } else {
      url = `https://www.weiyun.com/webapp/json/${protocol}/${cmdName}?g_tk=${encodeURIComponent(token)}&cmd=${cmd}`
      body = JSON.stringify({
        req_header: JSON.stringify(this.header(cmd, tokenInfo)),
        req_body: JSON.stringify(this.body(cmdName, data, tokenInfo)),
      })
      headers['Content-Type'] = 'application/json; charset=UTF-8'
    }

    const response = await this.request(url, { method: 'POST', headers, body })
    await this.absorbCookies(response)
    const text = await response.text()
    let raw: WeiyunEnvelope
    try {
      raw = JSON.parse(text) as WeiyunEnvelope
    } catch {
      throw DriverError.upstream('Weiyun returned a body that is not JSON')
    }
    if (!raw || typeof raw !== 'object') throw DriverError.upstream('Weiyun returned an empty answer')
    if (raw.ret !== undefined && raw.ret !== 0) throw retError(raw.ret, raw.msg ?? '', `Weiyun answered ret ${raw.ret}`)

    const result = raw.data ?? raw.result
    const header = (result as { rsp_header?: { retcode?: number; retmsg?: string; cmdName?: string } } | undefined)?.rsp_header
    if (header && header.retcode !== undefined && header.retcode !== 0) {
      throw retError(
        header.retcode,
        header.retmsg ?? '',
        `Weiyun command ${header.cmdName ?? cmdName} failed`,
      )
    }

    const messageBody = bodyOf(result)
    if (protocol === 'preUpload') {
      const nested = messageBody as { weiyunPreUploadMsgRsp_body?: WeiyunPreUpload } | undefined
      return (nested?.weiyunPreUploadMsgRsp_body ?? raw) as T
    }
    if (protocol === 'upload') {
      const nested = messageBody as Record<string, WeiyunPieceResult> | undefined
      return (nested?.[`weiyun.${cmdName}MsgRsp_body`] ?? raw) as T
    }
    if (typeof messageBody === 'string') {
      try {
        return JSON.parse(messageBody) as T
      } catch {
        return messageBody as T
      }
    }
    return (messageBody ?? result ?? raw) as T
  }

  private async api<T>(
    protocol: Protocol,
    cmdName: string,
    cmd: number,
    data: unknown,
    fileBuffer?: Uint8Array,
  ): Promise<T> {
    return await this.withAuth(async () => await this.rawRequest<T>(protocol, cmdName, cmd, data, fileBuffer))
  }

  private async diskDirFileList(
    dirKey: string,
    options: { start?: number; count?: number; getType?: number } = {},
  ): Promise<WeiyunListData> {
    return await this.api<WeiyunListData>('weiyunQdisk', 'DiskDirList', 2208, {
      dir_key: dirKey,
      start: options.start ?? 0,
      count: options.count ?? PAGE_SIZE,
      sort_field: 2,
      reverse_order: false,
      get_type: options.getType ?? 0,
      get_abstract_url: false,
      get_dir_detail_info: false,
    })
  }

  private async resolveFolder(path: string): Promise<ResolvedFolder> {
    const clean = driverPath(path)
    if (clean === '/' || clean === `/${this.rootFolderId}`) {
      return { dirKey: this.rootFolderId, pdirKey: this.rootPdirKey, dirName: this.rootDirName }
    }
    const cached = this.pathFolders.get(clean)
    if (cached) return cached

    let current: ResolvedFolder = {
      dirKey: this.rootFolderId,
      pdirKey: this.rootPdirKey,
      dirName: this.rootDirName,
    }
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      prefix = `${prefix}/${segment}`
      const hit = this.pathFolders.get(prefix)
      if (hit) {
        current = hit
        continue
      }
      let start = 0
      let found: WeiyunFolder | undefined
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const data = await this.diskDirFileList(current.dirKey, { start, count: PAGE_SIZE, getType: 1 })
        const dirs = data?.dir_list ?? []
        found = dirs.find((folder) => folder.dir_name === segment)
        if (found || data?.finish_flag || dirs.length === 0) break
        start += dirs.length
      }
      if (!found) throw DriverError.notFound(`Folder not found: ${segment}`)
      current = { dirKey: found.dir_key, pdirKey: current.dirKey, dirName: found.dir_name }
      this.pathFolders.set(prefix, current)
    }
    return current
  }

  private async resolveEntry(path: string): Promise<{
    file?: WeiyunFile
    folder?: WeiyunFolder
    parent: ResolvedFolder
    isDir: boolean
  }> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const name = driverFileName(clean)
    const parent = await this.resolveFolder(driverParentPath(clean))

    let start = 0
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await this.diskDirFileList(parent.dirKey, { start, count: PAGE_SIZE, getType: 0 })
      const files = data?.file_list ?? []
      const folders = data?.dir_list ?? []
      const file = files.find((item) => item.filename === name)
      if (file) return { file, parent, isDir: false }
      const folder = folders.find((item) => item.dir_name === name)
      if (folder) return { folder, parent, isDir: true }
      if (data?.finish_flag || files.length + folders.length === 0) break
      start += files.length + folders.length
    }
    throw DriverError.notFound(`Not found: ${name}`)
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const folder = await this.resolveFolder(clean)
    const pageSize = Math.max(1, Math.min(PAGE_SIZE, options.pageSize ?? PAGE_SIZE))

    if (options.page !== undefined) {
      const page = Math.max(1, options.page)
      const start = (page - 1) * pageSize
      const data = await this.diskDirFileList(folder.dirKey, { start, count: pageSize, getType: 0 })
      const folders = data?.dir_list ?? []
      const files = data?.file_list ?? []
      const hasMore = !data?.finish_flag && folders.length + files.length >= pageSize
      return {
        entries: [...folders.map(folderEntry), ...files.map(fileEntry)],
        cursor: hasMore ? String(page + 1) : null,
        truncated: hasMore,
      }
    }

    const collected = await collectPages(async ({ page }) => {
      const start = (page - 1) * pageSize
      const data = await this.diskDirFileList(folder.dirKey, { start, count: pageSize, getType: 0 })
      const folders = data?.dir_list ?? []
      const files = data?.file_list ?? []
      return {
        items: [...folders.map(folderEntry), ...files.map(fileEntry)],
        next: data?.finish_flag || folders.length + files.length === 0 ? null : String(page + 1),
      }
    }, { maxPages: MAX_PAGES })
    return { entries: collected.items, cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return {
        name: 'root',
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
        ref: this.rootFolderId,
        mime: 'application/octet-stream',
      }
    }
    const resolved = await this.resolveEntry(clean)
    if (resolved.isDir && resolved.folder) return folderEntry(resolved.folder)
    if (resolved.file) return fileEntry(resolved.file)
    throw DriverError.notFound(`Not found: ${clean}`)
  }

  private async downloadInfo(file: WeiyunFile, parent: ResolvedFolder): Promise<WeiyunDownload> {
    const data = await this.api<{ file_list?: WeiyunDownload[] }>(
      'weiyunQdiskClient',
      'DiskFileBatchDownload',
      2402,
      {
        file_list: [{
          ppdir_key: parent.pdirKey,
          pdir_key: parent.dirKey,
          file_id: file.file_id,
          filename: file.filename,
        }],
        download_type: 0,
      },
    )
    const download = data?.file_list?.[0]
    if (!download?.download_url) throw DriverError.upstream('Weiyun returned no download address')
    return download
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const resolved = await this.resolveEntry(clean)
    if (resolved.isDir || !resolved.file) throw DriverError.unsupported('A folder cannot be read as a file')
    const download = await this.downloadInfo(resolved.file, resolved.parent)
    const cookie = download.cookie_name && download.cookie_value
      ? `${download.cookie_name}=${download.cookie_value}`
      : ''
    const response = await fetch(download.download_url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        ...(cookie ? { Cookie: cookie } : {}),
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
    if (resolved.isDir || !resolved.file) return null
    return (await this.downloadInfo(resolved.file, resolved.parent)).download_url
  }

  private async preUpload(parent: ResolvedFolder, name: string, content: Uint8Array): Promise<WeiyunPreUpload> {
    const blockSize = UPLOAD_CHUNK_SIZE
    const fileSize = content.length
    let beforeBlockSize = 0
    let lastBlockSize = fileSize
    let checkBlockSize = 0
    if (fileSize > 0) {
      lastBlockSize = fileSize % blockSize
      if (lastBlockSize === 0) lastBlockSize = blockSize
      checkBlockSize = lastBlockSize % 128
      if (checkBlockSize === 0) checkBlockSize = 128
      beforeBlockSize = fileSize - lastBlockSize
    }

    const blocks: Array<{ sha: string; offset: number; size: number }> = []
    const sha = new IncrementalSha1()
    for (let offset = 0; offset < beforeBlockSize; offset += blockSize) {
      const slice = content.subarray(offset, offset + blockSize)
      sha.update(slice)
      blocks.push({ sha: sha.stateHex(), offset, size: blockSize })
    }
    const checkPoint = content.subarray(
      beforeBlockSize,
      beforeBlockSize + lastBlockSize - checkBlockSize,
    )
    sha.update(checkPoint)
    const checkSha = sha.stateHex()
    const checkData = content.subarray(beforeBlockSize + lastBlockSize - checkBlockSize, fileSize)
    sha.update(checkData)
    const checkBase64 = bytesToBase64(checkData)
    const fileHash = sha.digestHex()
    blocks.push({ sha: fileHash, offset: beforeBlockSize, size: lastBlockSize })

    const result = await this.api<WeiyunPreUpload>('preUpload', 'PreUpload', 247120, {
      common_upload_req: {
        ppdir_key: parent.pdirKey,
        pdir_key: parent.dirKey,
        file_size: fileSize,
        filename: name,
        file_exist_option: 1,
        use_mutil_channel: true,
      },
      upload_scr: 0,
      channel_count: this.uploadThreads(),
      block_size: blockSize,
      check_sha: checkSha,
      check_data: checkBase64,
      block_info_list: blocks,
    })
    if (!result) throw DriverError.upstream('Weiyun did not answer the pre-upload request')
    return result
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const name = driverFileName(clean)
    if (!name) throw DriverError.invalid('An upload needs a file name')
    const parent = await this.resolveFolder(driverParentPath(clean))

    const pre = await this.preUpload(parent, name, bytes)
    if (pre.file_exist) {
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    const uploadKey = pre.upload_key ?? ''
    const ex = pre.ex ?? ''
    if (!uploadKey) throw DriverError.upstream('Weiyun did not return an upload key')

    const channels: WeiyunUploadChannel[] = pre.channel_list?.length
      ? pre.channel_list
      : [{ id: 0, offset: 0, len: bytes.byteLength }]
    const parts: Array<{ channelId: number; offset: number; len: number }> = []
    for (const channel of channels) {
      const end = Math.min(bytes.byteLength, channel.offset + (channel.len || bytes.byteLength))
      let offset = channel.offset
      do {
        const len = Math.min(UPLOAD_CHUNK_SIZE, end - offset)
        parts.push({ channelId: channel.id, offset, len })
        offset += len
      } while (offset < end)
    }
    if (parts.length === 0) parts.push({ channelId: 0, offset: 0, len: 0 })

    let finished = false
    const exhausted = new Set<number>()
    await uploadInParts({
      size: bytes.byteLength,
      partSize: UPLOAD_CHUNK_SIZE,
      concurrency: this.uploadThreads(),
      uploadPart: async (partNumber, start, end) => {
        const part = parts[partNumber - 1]
        if (!part) throw DriverError.upstream(`Weiyun returned no plan for part ${partNumber}`)
        const chunk = bytes.subarray(start, end)
        const result = await this.api<WeiyunPieceResult>(
          'upload',
          'UploadPiece',
          247121,
          {
            upload_key: uploadKey,
            ex,
            channel: { id: part.channelId, offset: part.offset, len: part.len },
          },
          chunk,
        )
        if (result?.upload_state === 2) {
          finished = true
          exhausted.add(part.channelId)
        }
        if (result?.upload_state === 3) exhausted.add(part.channelId)
        options.onProgress?.(end, bytes.byteLength)
      },
      complete: async () => {
        if (!finished && exhausted.size < channels.length) {
          throw DriverError.upstream('Weiyun did not confirm that the upload completed')
        }
      },
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parent = await this.resolveFolder(driverParentPath(clean))
    await this.api('weiyunQdiskClient', 'DiskDirCreate', 2614, {
      ppdir_key: parent.pdirKey,
      pdir_key: parent.dirKey,
      dir_name: driverFileName(clean),
      file_exist_option: 2,
      create_type: 1,
    })
    this.pathFolders.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const name = newName.trim()
    const problem = cloudDriveNameProblem(name)
    if (problem) throw DriverError.invalid(problem)
    const resolved = await this.resolveEntry(clean)
    if (resolved.isDir && resolved.folder) {
      await this.api('weiyunQdiskClient', 'DiskDirAttrModify', 2615, {
        ppdir_key: resolved.parent.pdirKey,
        pdir_key: resolved.parent.dirKey,
        src_dir_name: resolved.folder.dir_name,
        dst_dir_name: name,
      })
    } else if (resolved.file) {
      await this.api('weiyunQdiskClient', 'DiskFileRename', 2605, {
        ppdir_key: resolved.parent.pdirKey,
        pdir_key: resolved.parent.dirKey,
        file_id: resolved.file.file_id,
        src_filename: resolved.file.filename,
        filename: name,
      })
    } else {
      throw DriverError.notFound(`Not found: ${clean}`)
    }
    this.pathFolders.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === to) return
    const source = await this.resolveEntry(from)
    const targetName = driverFileName(to)
    if (source.file?.filename !== targetName && source.folder?.dir_name !== targetName) {
      await this.rename(from, targetName)
      if (source.file) source.file.filename = targetName
      if (source.folder) source.folder.dir_name = targetName
    }
    const target = await this.resolveFolder(driverParentPath(to))
    if (source.isDir && source.folder) {
      await this.api('weiyunQdiskClient', 'DiskDirFileBatchMove', 2618, {
        src_ppdir_key: source.parent.pdirKey,
        src_pdir_key: source.parent.dirKey,
        dir_list: [{
          ppdir_key: source.parent.pdirKey,
          pdir_key: source.parent.dirKey,
          dir_key: source.folder.dir_key,
          dir_name: source.folder.dir_name,
        }],
        dst_ppdir_key: target.pdirKey,
        dst_pdir_key: target.dirKey,
      })
    } else if (source.file) {
      await this.api('weiyunQdiskClient', 'DiskDirFileBatchMove', 2618, {
        src_ppdir_key: source.parent.pdirKey,
        src_pdir_key: source.parent.dirKey,
        file_list: [{
          ppdir_key: source.parent.pdirKey,
          pdir_key: source.parent.dirKey,
          file_id: source.file.file_id,
          filename: source.file.filename,
        }],
        dst_ppdir_key: target.pdirKey,
        dst_pdir_key: target.dirKey,
      })
    }
    this.pathFolders.clear()
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    const resolved = await this.resolveEntry(clean)
    if (resolved.isDir && resolved.folder) {
      await this.api('weiyunQdiskClient', 'DiskDirFileBatchDeleteEx', 2509, {
        dir_list: [{
          ppdir_key: resolved.parent.pdirKey,
          pdir_key: resolved.parent.dirKey,
          dir_key: resolved.folder.dir_key,
          dir_name: resolved.folder.dir_name,
        }],
      })
    } else if (resolved.file) {
      await this.api('weiyunQdiskClient', 'DiskDirFileBatchDeleteEx', 2509, {
        file_list: [{
          ppdir_key: resolved.parent.pdirKey,
          pdir_key: resolved.parent.dirKey,
          file_id: resolved.file.file_id,
          filename: resolved.file.filename,
        }],
      })
    }
    this.pathFolders.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const info = await this.api<{ nick_name?: string }>('weiyunQdiskClient', 'DiskUserInfoGet', 2201, {
        is_get_upload_flow_flag: false,
        is_get_high_speed_flow_info: false,
        is_get_weiyun_flag: false,
        is_get_space_clean_info: false,
        is_get_user_reward_info: false,
      })
      return { ok: true, message: `Weiyun is reachable${info?.nick_name ? ` · ${info.nick_name}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Weiyun is unavailable' }
    }
  }
}

export function createWeiyunDriver(ctx: DriverContext): MountDriver {
  return new WeiyunDriver(ctx)
}
