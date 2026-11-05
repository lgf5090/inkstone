/**
 * 115 Cloud Drive open-platform driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/115open` and the upstream 115 SDK. Listings
 * page by offset, paths are resolved by walking directories, downloads resolve a `pick_code` into
 * a short-lived URL, and writes use the open platform's instant-upload handshake followed by a
 * single signed OSS PUT.
 */
import { createHash, createHmac } from 'node:crypto'
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

const API = 'https://proapi.115.com'
const AUTH = 'https://passportapi.115.com'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const PAGE_LIMIT = 1150
const MAX_LIST_PAGES = 50

interface Pan115File {
  fid: string
  pid?: string
  fc: string
  fn: string
  pc?: string
  fs?: number
  upt?: number
  thumbnail?: string
}

interface Pan115Envelope<T> {
  state?: boolean
  code?: number
  message?: string
  data?: T
  count?: number
}

interface Pan115UploadInit {
  status?: number
  sign_key?: string
  sign_check?: string
  file_id?: string
  target?: string
  bucket?: string
  object?: string
  callback?: {
    callback?: string
    callback_var?: string
  }
}

interface Pan115UploadToken {
  endpoint?: string
  AccessKeyId?: string
  AccessKeySecret?: string
  SecurityToken?: string
}

function sha1Upper(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex').toUpperCase()
}

function hmacSha1Base64(text: string, secret: string): string {
  return createHmac('sha1', secret).update(text).digest('base64')
}

function base64Text(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function isAuthCode(code: number): boolean {
  return code === 99 || String(code).startsWith('401')
}

function mapCode(code: number, message?: string): DriverError {
  const suffix = message ? `: ${message}` : ''
  if (isAuthCode(code)) return DriverError.auth(`115 Open refused the credentials (code ${code}${suffix})`)
  if (code === 430004 || code === 404) return DriverError.notFound(`115 Open could not find the item${suffix}`)
  if (code === 429) return DriverError.rateLimited(`115 Open is rate limiting requests${suffix}`)
  return DriverError.upstream(`115 Open answered code ${code}${suffix}`)
}

function entryOf(file: Pan115File): DriverEntry {
  const folder = file.fc === '0'
  return {
    name: file.fn,
    kind: folder ? 'folder' : 'file',
    size: Number(file.fs) || 0,
    modifiedAt: Number(file.upt) ? Number(file.upt) * 1000 : 0,
    ref: file.fid,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.fn),
  }
}

export class Pan115OpenDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('115open')!
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
    return this.configText('rootId', '0').trim() || '0'
  }

  protected async login(force: boolean): Promise<void> {
    this.token = await this.accessToken(force)
  }

  private async accessToken(force: boolean): Promise<string> {
    const existing = this.credential('accessToken')
    if (!force && existing) return existing
    const refreshToken = this.credential('refreshToken')
    if (!refreshToken) {
      const message = '115 Open needs a refresh token; authorize the storage again'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    return await this.refreshToken(refreshToken)
  }

  private async refreshToken(refreshToken: string): Promise<string> {
    const previous = {
      accessToken: this.credential('accessToken'),
      refreshToken: this.credential('refreshToken'),
    }
    try {
      return await singleFlightRefresh(
        this.ctx,
        async () => {
          const form = new URLSearchParams({ refresh_token: refreshToken })
          const response = await fetch(`${AUTH}/open/refreshToken`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: form.toString(),
            signal: AbortSignal.timeout(20_000),
          })
          if (response.status === 429) throw DriverError.rateLimited('The 115 token endpoint is rate limiting requests')
          if (!response.ok) throw DriverError.auth(`The 115 token endpoint refused the refresh token (HTTP ${response.status})`)
          const payload = await response.json().catch(() => null) as Pan115Envelope<{ access_token?: string; refresh_token?: string }> | null
          if (payload?.state === false || !payload?.data?.access_token || !payload.data.refresh_token) {
            throw DriverError.auth(payload?.message || 'The 115 token endpoint returned no access token')
          }
          const patch = {
            accessToken: payload.data.access_token,
            refreshToken: payload.data.refresh_token,
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
      if (error instanceof DriverError && error.kind === 'rate_limit') throw error
      const message = error instanceof Error ? error.message : '115 Open could not refresh the access token'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
  }

  private async api<T>(path: string, options: { method?: 'GET' | 'POST'; query?: Record<string, string>; form?: Record<string, string> } = {}): Promise<Pan115Envelope<T>> {
    await this.authenticate(false)
    return await this.withAuth(async () => {
      const url = new URL(`${API}${path}`)
      for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
      const form = options.form === undefined ? undefined : new URLSearchParams(
        Object.entries(options.form).filter(([, value]) => value !== ''),
      )
      const response = await this.request(url.toString(), {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: this.token ? `Bearer ${this.token}` : '',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form?.toString(),
      })
      const payload = await response.json() as Pan115Envelope<T>
      if (payload.state === false || payload.state === undefined) {
        throw mapCode(Number(payload.code), payload.message)
      }
      return payload
    })
  }

  private async listChunk(cid: string, offset: number, pageSize: number): Promise<{ files: Pan115File[]; next: string | null }> {
    const payload = await this.api<Pan115File[]>('/open/ufile/files', {
      query: {
        cid,
        limit: String(Math.min(PAGE_LIMIT, Math.max(1, pageSize))),
        offset: String(Math.max(0, offset)),
        asc: '1',
        o: 'file_name',
        show_dir: '1',
        cur: '1',
      },
    })
    const files = payload.data ?? []
    const count = Number(payload.count) || 0
    const next = files.length > 0 && offset + files.length < count ? String(offset + files.length) : null
    return { files, next }
  }

  private async findChild(parentId: string, name: string, folder: boolean | null = null): Promise<Pan115File | null> {
    let offset = 0
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const result = await this.listChunk(parentId, offset, PAGE_LIMIT)
      const hit = result.files.find((file) => {
        if (file.fn !== name && file.fid !== name) return false
        return folder === null || file.fc === (folder ? '0' : '1')
      })
      if (hit) return hit
      if (result.next === null) return null
      offset = Number(result.next)
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
      parent = folder.fid
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveEntry(path: string): Promise<Pan115File> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveDir(driverParentPath(clean))
    const entry = await this.findChild(parentId, driverFileName(clean), null)
    if (!entry) throw DriverError.notFound(`File not found: ${driverFileName(clean)}`)
    return entry
  }

  private async listPage(parentId: string, pageNumber: number, pageSize: number): Promise<{ files: Pan115File[]; next: string | null }> {
    let offset = 0
    for (let current = 1; current <= Math.max(1, pageNumber); current++) {
      const result = await this.listChunk(parentId, offset, pageSize)
      if (current === pageNumber) return result
      if (result.next === null) return { files: [], next: null }
      offset = Number(result.next)
      if (current >= MAX_LIST_PAGES) break
    }
    return { files: [], next: null }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const parentId = await this.resolveDir(path)
    const pageSize = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? 200))
    if (options.page !== undefined) {
      const page = await this.listPage(parentId, Math.max(1, options.page), pageSize)
      let entries = page.files.map(entryOf)
      if (options.search) entries = filterBySearch(entries, options.search)
      return { entries, cursor: page.next, truncated: page.next !== null }
    }
    const collected = await collectPages(async ({ cursor }) => {
      const chunk = await this.listChunk(parentId, cursor === null ? 0 : Number(cursor), pageSize)
      return { items: chunk.files, next: chunk.next }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    let entries = collected.items.map(entryOf)
    if (options.search) entries = filterBySearch(entries, options.search)
    return { entries, cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') return { name: this.rootId(), kind: 'folder', size: 0, modifiedAt: 0, ref: this.rootId() }
    return entryOf(await this.resolveEntry(clean))
  }

  private async downloadUrl(file: Pan115File): Promise<string> {
    if (!file.pc) throw DriverError.upstream('115 Open returned no pick code for the file')
    const payload = await this.api<Record<string, { url?: { url?: string } }>>('/open/ufile/downurl', {
      method: 'POST',
      form: { pick_code: file.pc },
    })
    const entry = payload.data?.[file.fid]
    const url = entry?.url?.url ?? ''
    if (!url) throw DriverError.upstream('115 Open returned no download address')
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const entry = await this.stat(clean)
    if (entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
    const url = await this.downloadUrl(await this.resolveEntry(clean))
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...(range ? { Range: range } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw DriverError.upstream(`115 Open download failed (HTTP ${response.status})`)
    }
    return response
  }

  async directLink(path: string): Promise<string | null> {
    const entry = await this.stat(path)
    if (entry.kind === 'folder') return null
    return await this.downloadUrl(await this.resolveEntry(path))
  }

  private async uploadInit(input: {
    fileName: string
    fileSize: number
    parentId: string
    fileId: string
    preId: string
    signKey?: string
    signVal?: string
  }): Promise<Pan115UploadInit> {
    const payload = await this.api<Pan115UploadInit>('/open/upload/init', {
      method: 'POST',
      form: {
        file_name: input.fileName,
        file_size: String(input.fileSize),
        target: `U_1_${input.parentId}`,
        fileid: input.fileId,
        preid: input.preId,
        sign_key: input.signKey ?? '',
        sign_val: input.signVal ?? '',
      },
    })
    return payload.data ?? {}
  }

  private async putObject(token: Pan115UploadToken, init: Pan115UploadInit, bytes: Uint8Array): Promise<void> {
    const endpoint = String(token.endpoint ?? '')
    const bucket = String(init.bucket ?? '')
    const object = String(init.object ?? '')
    const accessKeyId = String(token.AccessKeyId ?? '')
    const accessKeySecret = String(token.AccessKeySecret ?? '')
    const securityToken = String(token.SecurityToken ?? '')
    const base = endpoint.startsWith('http') ? endpoint : `https://${endpoint}`
    const url = `${base.replace(/\/$/, '')}/${object}`

    const callback = base64Text(String(init.callback?.callback ?? ''))
    const callbackVar = base64Text(String(init.callback?.callback_var ?? ''))
    const date = new Date().toUTCString()
    const contentType = 'application/octet-stream'
    const ossHeaders = `x-oss-callback:${callback}\nx-oss-callback-var:${callbackVar}\nx-oss-security-token:${securityToken}\n`
    const canonicalResource = `/${bucket}/${object}`
    const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossHeaders}${canonicalResource}`
    const signature = hmacSha1Base64(stringToSign, accessKeySecret)

    const response = await this.request(url, {
      method: 'PUT',
      timeoutMs: 120_000,
      headers: {
        'Content-Type': contentType,
        Date: date,
        Authorization: `OSS ${accessKeyId}:${signature}`,
        'x-oss-security-token': securityToken,
        'x-oss-callback': callback,
        'x-oss-callback-var': callbackVar,
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes,
    })
    await response.body?.cancel().catch(() => undefined)
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength < 1) throw DriverError.invalid('115 Open does not accept empty files')
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const name = driverFileName(clean)
    const parentId = await this.resolveDir(driverParentPath(clean))
    const fileSize = bytes.byteLength
    const fileId = sha1Upper(bytes)
    const preSize = Math.min(128 * 1024, fileSize)
    const preId = sha1Upper(bytes.subarray(0, preSize))

    let init = await this.uploadInit({ fileName: name, fileSize, parentId, fileId, preId })
    if (Number(init.status) === 2) {
      options.onProgress?.(fileSize, fileSize)
      return
    }
    if ([6, 7, 8].includes(Number(init.status)) && init.sign_check) {
      const [start, end] = init.sign_check.split('-').map((value) => parseInt(value, 10))
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const signVal = sha1Upper(bytes.subarray(start, end + 1))
        init = await this.uploadInit({ fileName: name, fileSize, parentId, fileId, preId, signKey: init.sign_key, signVal })
        if (Number(init.status) === 2) {
          options.onProgress?.(fileSize, fileSize)
          return
        }
      }
    }

    const tokenPayload = await this.api<Pan115UploadToken>('/open/upload/get_token')
    const token = tokenPayload.data ?? {}
    if (!init.bucket || !init.object || !token.endpoint) {
      throw DriverError.upstream('115 Open returned incomplete OSS upload information')
    }
    await this.putObject(token, init, bytes)
    options.onProgress?.(fileSize, fileSize)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveDir(driverParentPath(clean))
    await this.api('/open/folder/add', {
      method: 'POST',
      form: { pid: parentId, file_name: driverFileName(clean) },
    })
    this.pathIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const entry = await this.resolveEntry(path)
    await this.api('/open/ufile/update', {
      method: 'POST',
      form: { file_id: entry.fid, file_name: newName },
    })
    this.pathIds.clear()
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const entry = await this.resolveEntry(from)
    const targetName = driverFileName(to)
    if (targetName !== entry.fn) await this.rename(from, targetName)
    const parentId = await this.resolveDir(driverParentPath(to))
    await this.api('/open/ufile/move', {
      method: 'POST',
      form: { file_ids: entry.fid, to_cid: parentId },
    })
    this.pathIds.clear()
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const entry = await this.resolveEntry(from)
    const parentId = await this.resolveDir(driverParentPath(to))
    await this.api('/open/ufile/copy', {
      method: 'POST',
      form: { pid: parentId, file_id: entry.fid, no_dupli: '1' },
    })
    this.pathIds.clear()
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    const entry = await this.resolveEntry(clean)
    const parentId = entry.pid || await this.resolveDir(driverParentPath(clean))
    await this.api('/open/ufile/delete', {
      method: 'POST',
      form: { file_ids: entry.fid, parent_id: parentId },
    })
    this.pathIds.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const payload = await this.api<{ user_name?: string }>('/open/user/info')
      return { ok: true, message: `115 Open is reachable${payload.data?.user_name ? ` · ${payload.data.user_name}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '115 Open is unavailable' }
    }
  }
}

function filterBySearch(entries: DriverEntry[], search: string): DriverEntry[] {
  const needle = search.toLowerCase()
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
}

export function create115OpenDriver(ctx: DriverContext): MountDriver {
  return new Pan115OpenDriver(ctx)
}
