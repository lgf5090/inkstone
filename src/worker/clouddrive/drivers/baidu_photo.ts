/**
 * Baidu Photo (photo.baidu.com) driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/baidu_photo`.
 * The root shows albums and/or loose photos depending on `showType`; a configured `albumId` mounts
 * one album as the root. Album photos are deleted without touching the original (`delete_origin=0`),
 * and uploads use the superfile2 precreate/part/create flow in 4 MiB chunks.
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
import { cookieHeader } from './cookies'
import {
  HttpDriverBase,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const API_BASE = 'https://photo.baidu.com/youai'
const ALBUM_API = `${API_BASE}/album/v1`
const FILE_API_V1 = `${API_BASE}/file/v1`
const FILE_API_V2 = `${API_BASE}/file/v2`
const USER_API = `${API_BASE}/user/v1`
const BDStoken_API = 'https://pan.baidu.com/api/gettemplatevariable'
const UPLOAD_API = 'https://c3.pcs.baidu.com/rest/2.0/pcs/superfile2'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://photo.baidu.com/'
const UPLOAD_CHUNK = 4 * 1024 * 1024
const SLICE_SIZE = 256 * 1024
const MAX_PAGES = 50

interface BaiduPhotoFile {
  fsid: number
  path?: string
  size?: number
  ctime?: number
  mtime?: number
  thumburl?: string[]
}

interface BaiduPhotoAlbum {
  album_id?: string
  tid?: number
  title?: string
  mtime?: number
  create_time?: number
}

interface BaiduPhotoAlbumFile extends BaiduPhotoFile {
  album_id?: string
  tid?: number
  uk?: number
}

interface BaiduListResponse<T> {
  list?: T[]
  has_more?: number
  cursor?: string
  errno?: number
  errmsg?: string
}

interface BaiduPrecreateResponse {
  return_type?: number
  uploadid?: string
  block_list?: number[]
  data?: { fs_id?: number }
  errno?: number
  errmsg?: string
}

type PhotoEntry =
  | { kind: 'album'; album: BaiduPhotoAlbum }
  | { kind: 'file'; file: BaiduPhotoFile }
  | { kind: 'albumfile'; file: BaiduPhotoAlbumFile }

function fileNameOf(path: string | undefined): string {
  return (path ?? '').split('/').pop() ?? ''
}

function modifiedAt(seconds: number | undefined): number {
  return Number.isFinite(seconds) && seconds ? Math.max(0, Number(seconds)) * 1000 : 0
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

function fsidList(fsid: number): string {
  return `[{"fsid":${fsid}}]`
}

class BaiduPhotoDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('baidu_photo')!
  readonly capabilities = this.definition.capabilities
  private bdstoken = ''
  private uk = ''
  private albumRootCache: BaiduPhotoAlbum | null = null

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private cookie(): string {
    return cookieHeader((this.ctx.credentials.cookie ?? '').trim())
  }

  private requireCookie(): string {
    const cookie = this.cookie()
    if (!cookie) throw DriverError.auth('Baidu Photo needs a browser Cookie')
    return cookie
  }

  private showType(): string {
    const value = this.configText('showType', 'root')
    return ['root', 'root_only_album', 'root_only_file'].includes(value) ? value : 'root'
  }

  private albumId(): string {
    return this.configText('albumId').trim().split('|')[0] ?? ''
  }

  protected async login(force: boolean): Promise<void> {
    if (force) {
      this.bdstoken = ''
      this.uk = ''
      this.albumRootCache = null
    }
  }

  private errnoError(errno: number, message?: string): DriverError {
    const text = message?.trim() || `Baidu Photo answered errno ${errno}`
    if ([401, 403, -6].includes(errno) || /\u672a\u767b\u5f55|\u767b\u5f55|login|cookie|token|\u8fc7\u671f|\u6743\u9650|unauthor|forbidden/i.test(text)) {
      return DriverError.auth(text)
    }
    if (errno === 429 || /\u9891\u7e41|\u9650|rate|too many/i.test(text)) return DriverError.rateLimited(text)
    if (errno === 404 || /\u4e0d\u5b58\u5728|not found|not exist/i.test(text)) return DriverError.notFound(text)
    return DriverError.upstream(text)
  }

  private async photoApi<T>(
    method: 'GET' | 'POST',
    url: string,
    options: { query?: Record<string, string>; form?: Record<string, string> } = {},
  ): Promise<T> {
    return await this.withAuth(async () => {
      const cookie = this.requireCookie()
      const target = new URL(url)
      for (const [key, value] of Object.entries(options.query ?? {})) target.searchParams.set(key, value)
      const headers: Record<string, string> = {
        accept: 'application/json',
        referer: REFERER,
        'user-agent': USER_AGENT,
        cookie,
      }
      let body: string | undefined
      if (options.form) {
        headers['content-type'] = 'application/x-www-form-urlencoded'
        body = new URLSearchParams(options.form).toString()
      }
      const response = await this.request(target.toString(), {
        method,
        headers,
        body,
        redirect: 'follow',
      })
      const payload = await response.json().catch(() => null) as (T & { errno?: number; errmsg?: string }) | null
      if (!payload) throw DriverError.upstream('Baidu Photo returned an unexpected body')
      const errno = Number(payload.errno ?? 0)
      if (errno !== 0) throw this.errnoError(errno, payload.errmsg)
      return payload as T
    })
  }

  private async ensureSession(): Promise<{ bdstoken: string; uk: string }> {
    return await this.withAuth(async () => {
      this.requireCookie()
      if (this.bdstoken && this.uk) return { bdstoken: this.bdstoken, uk: this.uk }
      const info = await this.photoApi<{ youa_id?: string | number }>('GET', `${USER_API}/getuinfo`)
      this.uk = String(info.youa_id ?? '')
      const template = await this.photoApi<{ result?: { bdstoken?: string } }>('GET', BDStoken_API, {
        query: { fields: '["bdstoken","token","uk"]' },
      })
      this.bdstoken = template.result?.bdstoken ?? ''
      if (!this.bdstoken) throw DriverError.auth('Baidu Photo could not obtain the upload token from the Cookie')
      return { bdstoken: this.bdstoken, uk: this.uk }
    })
  }

  private async allAlbums(): Promise<{ items: BaiduPhotoAlbum[]; truncated: boolean }> {
    const items: BaiduPhotoAlbum[] = []
    let cursor = ''
    for (let page = 0; page < MAX_PAGES; page++) {
      const payload = await this.photoApi<BaiduListResponse<BaiduPhotoAlbum>>('GET', `${ALBUM_API}/list`, {
        query: { need_amount: '1', limit: '100', cursor },
      })
      items.push(...(payload.list ?? []))
      if (payload.has_more !== 1 || (payload.list ?? []).length === 0) return { items, truncated: false }
      cursor = payload.cursor ?? ''
    }
    return { items, truncated: true }
  }

  private async allFiles(): Promise<{ items: BaiduPhotoFile[]; truncated: boolean }> {
    const items: BaiduPhotoFile[] = []
    let cursor = ''
    for (let page = 0; page < MAX_PAGES; page++) {
      const payload = await this.photoApi<BaiduListResponse<BaiduPhotoFile>>('GET', `${FILE_API_V1}/list`, {
        query: { need_thumbnail: '1', need_filter_hidden: '0', cursor },
      })
      items.push(...(payload.list ?? []))
      if (payload.has_more !== 1 || (payload.list ?? []).length === 0) return { items, truncated: false }
      cursor = payload.cursor ?? ''
    }
    return { items, truncated: true }
  }

  private async allAlbumFiles(album: BaiduPhotoAlbum): Promise<{ items: BaiduPhotoAlbumFile[]; truncated: boolean }> {
    const items: BaiduPhotoAlbumFile[] = []
    let cursor = ''
    for (let page = 0; page < MAX_PAGES; page++) {
      const payload = await this.photoApi<BaiduListResponse<BaiduPhotoAlbumFile>>('GET', `${ALBUM_API}/listfile`, {
        query: { album_id: album.album_id ?? '', need_amount: '1', limit: '1000', passwd: '', cursor },
      })
      items.push(...(payload.list ?? []))
      if (payload.has_more !== 1 || (payload.list ?? []).length === 0) return { items, truncated: false }
      cursor = payload.cursor ?? ''
    }
    return { items, truncated: true }
  }

  private async albumRoot(): Promise<BaiduPhotoAlbum> {
    if (this.albumRootCache) return this.albumRootCache
    const id = this.albumId()
    if (!id) throw DriverError.notFound('Baidu Photo has no album id configured')
    const detail = await this.photoApi<BaiduPhotoAlbum>('GET', `${ALBUM_API}/detail`, {
      query: { album_id: id },
    })
    if (!detail.album_id) throw DriverError.notFound(`Baidu Photo album not found: ${id}`)
    this.albumRootCache = detail
    return detail
  }

  private async findAlbumByName(name: string): Promise<BaiduPhotoAlbum | null> {
    const albums = await this.allAlbums()
    return albums.items.find((album) => album.title === name) ?? null
  }

  private async findRootFileByName(name: string): Promise<BaiduPhotoFile | null> {
    const files = await this.allFiles()
    return files.items.find((file) => fileNameOf(file.path) === name) ?? null
  }

  private async targetAlbum(parentPath: string): Promise<BaiduPhotoAlbum | null> {
    if (parentPath === '/') return this.albumId() ? await this.albumRoot() : null
    const segments = driverPath(parentPath).split('/').filter(Boolean)
    if (segments.length !== 1) throw DriverError.notFound('Baidu Photo only has one level of albums')
    const album = await this.findAlbumByName(segments[0]!)
    if (!album) throw DriverError.notFound(`Baidu Photo album not found: ${segments[0]}`)
    return album
  }

  private async resolveEntry(path: string): Promise<PhotoEntry> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is a folder, not an item')
    const segments = clean.split('/').filter(Boolean)

    if (this.albumId()) {
      if (segments.length !== 1) throw DriverError.notFound('The configured album has no subfolders')
      const album = await this.albumRoot()
      const files = await this.allAlbumFiles(album)
      const name = segments[0]!
      const found = files.items.find((file) => fileNameOf(file.path) === name)
      if (!found) throw DriverError.notFound(`Baidu Photo item not found: ${name}`)
      return { kind: 'albumfile', file: found }
    }

    if (segments.length === 1) {
      const name = segments[0]!
      if (this.showType() !== 'root_only_file') {
        const album = await this.findAlbumByName(name)
        if (album) return { kind: 'album', album }
      }
      if (this.showType() !== 'root_only_album') {
        const file = await this.findRootFileByName(name)
        if (file) return { kind: 'file', file }
      }
      throw DriverError.notFound(`Baidu Photo item not found: ${name}`)
    }

    if (segments.length === 2) {
      const album = await this.findAlbumByName(segments[0]!)
      if (!album) throw DriverError.notFound(`Baidu Photo album not found: ${segments[0]}`)
      const files = await this.allAlbumFiles(album)
      const found = files.items.find((file) => fileNameOf(file.path) === segments[1])
      if (!found) throw DriverError.notFound(`Baidu Photo item not found: ${segments[1]}`)
      return { kind: 'albumfile', file: found }
    }

    throw DriverError.notFound('Baidu Photo has no folders below an album')
  }

  private entryOf(entry: PhotoEntry): DriverEntry {
    if (entry.kind === 'album') {
      const album = entry.album
      return {
        name: album.title || 'album',
        kind: 'folder',
        size: 0,
        modifiedAt: modifiedAt(album.mtime) || Date.now(),
        ref: `album:${album.album_id ?? ''}|${album.tid ?? 0}`,
      }
    }
    const file = entry.file
    const name = fileNameOf(file.path) || 'file'
    const ref = entry.kind === 'albumfile'
      ? `albumfile:${entry.file.fsid}|${entry.file.album_id ?? ''}|${entry.file.tid ?? 0}|${entry.file.uk ?? 0}`
      : `file:${entry.file.fsid}`
    return {
      name,
      kind: 'file',
      size: Number(file.size) || 0,
      modifiedAt: modifiedAt(file.mtime),
      ref,
      mime: driverEntryMime(name),
    }
  }

  private paginate(entries: DriverEntry[], options: DriverListOptions, truncated: boolean): DriverListResult {
    if (options.page !== undefined && options.pageSize && options.pageSize > 0) {
      const pageSize = Math.min(1000, Math.max(1, options.pageSize))
      const page = Math.max(1, options.page)
      const offset = (page - 1) * pageSize
      const slice = entries.slice(offset, offset + pageSize)
      const more = offset + slice.length < entries.length
      return { entries: slice, cursor: more ? String(offset + slice.length) : null, truncated: truncated || more }
    }
    return { entries, cursor: null, truncated }
  }

  private async linkFile(fsid: number): Promise<string> {
    const payload = await this.photoApi<{ dlink?: string }>('GET', `${FILE_API_V2}/download`, {
      query: { fsid: String(fsid) },
    })
    if (!payload.dlink) throw DriverError.upstream('Baidu Photo returned no download address')
    return payload.dlink
  }

  private async linkAlbumFile(file: BaiduPhotoAlbumFile): Promise<string> {
    const url = new URL(`${ALBUM_API}/download`)
    url.searchParams.set('fsid', String(file.fsid))
    url.searchParams.set('album_id', file.album_id ?? '')
    url.searchParams.set('tid', String(file.tid ?? 0))
    url.searchParams.set('uk', String(file.uk ?? 0))
    const response = await fetch(url.toString(), {
      method: 'HEAD',
      headers: {
        cookie: this.requireCookie(),
        referer: REFERER,
        'user-agent': USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    })
    const location = response.headers.get('location')
    if (!location) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 401 || response.status === 403) {
        const message = `Baidu Photo refused the album download (HTTP ${response.status})`
        await this.ctx.markNeedsReauth(message)
        throw DriverError.auth(message)
      }
      if (response.status === 404) throw DriverError.notFound('Baidu Photo album download is no longer available')
      if (response.status === 429) throw DriverError.rateLimited('Baidu Photo is rate limiting downloads')
      throw DriverError.upstream(`Baidu Photo did not return an album download redirect (HTTP ${response.status})`)
    }
    return new URL(location, url).toString()
  }

  private async downloadResult(response: Response, label: string): Promise<Response> {
    if (response.status >= 200 && response.status < 300) return response
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) {
      const message = `${label} refused the download link (HTTP ${response.status})`
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    if (response.status === 404) throw DriverError.notFound(`${label} download failed (HTTP 404)`)
    if (response.status === 429) throw DriverError.rateLimited(`${label} is rate limiting downloads`)
    throw DriverError.upstream(`${label} download failed (HTTP ${response.status})`)
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)

    if (this.albumId()) {
      if (clean !== '/') throw DriverError.notFound('The configured album has no subfolders')
      const album = await this.albumRoot()
      const files = await this.allAlbumFiles(album)
      return this.paginate(files.items.map((file) => this.entryOf({ kind: 'albumfile', file })), options, files.truncated)
    }

    const segments = clean.split('/').filter(Boolean)
    if (segments.length === 0) {
      const entries: DriverEntry[] = []
      let truncated = false
      if (this.showType() !== 'root_only_file') {
        const albums = await this.allAlbums()
        entries.push(...albums.items.map((album) => this.entryOf({ kind: 'album', album })))
        truncated = truncated || albums.truncated
      }
      if (this.showType() !== 'root_only_album') {
        const files = await this.allFiles()
        entries.push(...files.items.map((file) => this.entryOf({ kind: 'file', file })))
        truncated = truncated || files.truncated
      }
      return this.paginate(entries, options, truncated)
    }

    if (segments.length === 1) {
      const album = await this.findAlbumByName(segments[0]!)
      if (!album) throw DriverError.notFound(`Baidu Photo album not found: ${segments[0]}`)
      const files = await this.allAlbumFiles(album)
      return this.paginate(files.items.map((file) => this.entryOf({ kind: 'albumfile', file })), options, files.truncated)
    }

    throw DriverError.notFound('Baidu Photo has no folders below an album')
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      if (this.albumId()) {
        const album = await this.albumRoot()
        return {
          name: album.title || 'album',
          kind: 'folder',
          size: 0,
          modifiedAt: modifiedAt(album.mtime) || Date.now(),
          ref: `album:${album.album_id ?? ''}|${album.tid ?? 0}`,
        }
      }
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: 'root' }
    }
    return this.entryOf(await this.resolveEntry(clean))
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const entry = await this.resolveEntry(driverPath(path))
    if (entry.kind === 'album') throw DriverError.unsupported('A folder cannot be read as a file')
    const link = entry.kind === 'file'
      ? await this.linkFile(entry.file.fsid)
      : await this.linkAlbumFile(entry.file)
    const headers: Record<string, string> = {
      cookie: this.requireCookie(),
      referer: REFERER,
      'user-agent': USER_AGENT,
    }
    if (range) headers.Range = range
    const response = await fetch(link, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    return await this.downloadResult(response, 'Baidu Photo')
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.resolveEntry(driverPath(path))
    if (entry.kind === 'album') return null
    return entry.kind === 'file' ? await this.linkFile(entry.file.fsid) : await this.linkAlbumFile(entry.file)
  }

  private async addAlbumFile(album: BaiduPhotoAlbum, fsid: number): Promise<void> {
    await this.photoApi('GET', `${ALBUM_API}/addfile`, {
      query: {
        album_id: album.album_id ?? '',
        tid: String(album.tid ?? 0),
        list: fsidList(fsid),
      },
    })
  }

  private async copyAlbumFile(file: BaiduPhotoAlbumFile): Promise<number> {
    const payload = await this.photoApi<{ list?: { fsid?: number }[] }>('POST', `${ALBUM_API}/copyfile`, {
      form: {
        album_id: file.album_id ?? '',
        tid: String(file.tid ?? 0),
        uk: String(file.uk ?? 0),
        list: fsidList(file.fsid),
      },
    })
    const fsid = Number(payload.list?.[0]?.fsid)
    if (!Number.isFinite(fsid) || fsid <= 0) throw DriverError.upstream('Baidu Photo could not copy the album file')
    return fsid
  }

  private async deleteAlbumFile(file: BaiduPhotoAlbumFile, deleteOrigin: boolean): Promise<void> {
    await this.photoApi('POST', `${ALBUM_API}/delfile`, {
      form: {
        album_id: file.album_id ?? '',
        tid: String(file.tid ?? 0),
        list: `[{"fsid":${file.fsid},"uk":${file.uk ?? 0}}]`,
        del_origin: deleteOrigin ? '1' : '0',
      },
    })
  }

  private async deleteAlbum(album: BaiduPhotoAlbum, deleteOrigin: boolean): Promise<void> {
    await this.photoApi('POST', `${ALBUM_API}/delete`, {
      form: {
        album_id: album.album_id ?? '',
        tid: String(album.tid ?? 0),
        delete_origin_image: deleteOrigin ? '1' : '0',
      },
    })
  }

  private async deleteFile(fsid: number): Promise<void> {
    await this.photoApi('GET', `${FILE_API_V1}/delete`, { query: { fsid_list: `[${fsid}]` } })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const name = driverFileName(clean)
    if (!name) throw DriverError.invalid('The upload path has no file name')
    const bytes = await asBytes(body)
    if (bytes.byteLength === 0) throw DriverError.invalid('Baidu Photo cannot upload an empty file')
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const session = await this.ensureSession()
    const album = await this.targetAlbum(driverParentPath(clean))

    const contentMd5 = md5(bytes)
    const sliceMd5 = md5(bytes.subarray(0, Math.min(SLICE_SIZE, bytes.byteLength)))
    const blockList: string[] = []
    for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_CHUNK) {
      blockList.push(md5(bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK, bytes.byteLength))))
    }
    const params: Record<string, string> = {
      autoinit: '1',
      isdir: '0',
      rtype: '1',
      ctype: '11',
      path: `/${name}`,
      size: String(bytes.byteLength),
      'slice-md5': sliceMd5,
      'content-md5': contentMd5,
      block_list: JSON.stringify(blockList),
    }

    const precreate = await this.photoApi<BaiduPrecreateResponse>('POST', `${FILE_API_V1}/precreate`, {
      query: { bdstoken: session.bdstoken },
      form: params,
    })
    let fsid = Number(precreate.data?.fs_id) || 0

    if (Number(precreate.return_type) === 1) {
      const uploadId = precreate.uploadid ?? ''
      const count = Math.max(1, Math.ceil(bytes.byteLength / UPLOAD_CHUNK))
      const parts = precreate.block_list ?? Array.from({ length: count }, (_, index) => index)
      for (const partseq of parts) {
        const offset = partseq * UPLOAD_CHUNK
        const end = Math.min(offset + UPLOAD_CHUNK, bytes.byteLength)
        const part = bytes.subarray(offset, end)
        const form = new FormData()
        form.append('file', new Blob([part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer]), name)
        const url = new URL(UPLOAD_API)
        url.searchParams.set('method', 'upload')
        url.searchParams.set('path', params.path!)
        url.searchParams.set('partseq', String(partseq))
        url.searchParams.set('uploadid', uploadId)
        url.searchParams.set('app_id', '16051585')
        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: { cookie: this.requireCookie(), 'user-agent': USER_AGENT },
          body: form,
          signal: AbortSignal.timeout(60_000),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw DriverError.upstream(`Baidu Photo upload part ${partseq} failed (HTTP ${response.status})`)
        }
        options.onProgress?.(end, bytes.byteLength)
      }
      const created = await this.photoApi<BaiduPrecreateResponse>('POST', `${FILE_API_V1}/create`, {
        query: { bdstoken: session.bdstoken },
        form: { ...params, uploadid: uploadId },
      })
      fsid = Number(created.data?.fs_id) || fsid
    } else if (Number(precreate.return_type) !== 2 && Number(precreate.return_type) !== 3) {
      throw DriverError.upstream('Baidu Photo precreate returned an unknown return type')
    }

    if (!fsid) throw DriverError.upstream('Baidu Photo did not return a file id after uploading')
    if (album) await this.addAlbumFile(album, fsid)
  }

  async mkdir(_path: string): Promise<void> {
    throw DriverError.unsupported('Baidu Photo cannot create folders or albums from this driver')
  }

  async rename(path: string, newName: string): Promise<void> {
    const entry = await this.resolveEntry(driverPath(path))
    if (entry.kind !== 'album') throw DriverError.unsupported('Baidu Photo can only rename an album')
    await this.photoApi('POST', `${ALBUM_API}/settitle`, {
      form: {
        title: newName,
        album_id: entry.album.album_id ?? '',
        tid: String(entry.album.tid ?? 0),
      },
    })
    this.albumRootCache = null
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const entry = await this.resolveEntry(from)
    if (entry.kind !== 'albumfile') throw DriverError.unsupported('Baidu Photo can only move photos stored in an album')
    if (driverFileName(to) !== driverFileName(from)) {
      throw DriverError.unsupported('Baidu Photo cannot rename a photo while moving it')
    }
    const target = await this.targetAlbum(driverParentPath(to))
    if (target && target.album_id === entry.file.album_id && Number(target.tid) === Number(entry.file.tid)) return
    const copied = await this.copyAlbumFile(entry.file)
    if (target) await this.addAlbumFile(target, copied)
    // Moving is a copy followed by removing the album membership, never the original photo.
    await this.deleteAlbumFile(entry.file, false)
  }

  async remove(path: string): Promise<void> {
    const entry = await this.resolveEntry(driverPath(path))
    if (entry.kind === 'album') {
      await this.deleteAlbum(entry.album, false)
      this.albumRootCache = null
      return
    }
    if (entry.kind === 'file') {
      await this.deleteFile(entry.file.fsid)
      return
    }
    await this.deleteAlbumFile(entry.file, false)
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.ensureSession()
      return { ok: true, message: 'Baidu Photo is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Baidu Photo is unavailable' }
    }
  }
}

export function createBaiduPhotoDriver(ctx: DriverContext): MountDriver {
  return new BaiduPhotoDriver(ctx)
}
