/**
 * China Unicom WoPan driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/wopan`. Its API
 * is a single encrypted dispatcher: every call posts an MD5-signed header plus an AES-CBC encrypted
 * `param`, and the answer's `DATA` may itself be encrypted. The access token is rotated through the
 * `api-user` `AppRefreshToken` method; the write-back is a compare-and-swap on both tokens so two
 * concurrent rotations cannot overwrite each other.
 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
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

const BASE_URL = 'https://panservice.mail.wo.cn'
const CLIENT_ID = '1001000021'
const CLIENT_SECRET = 'XFmi9GS2hzk98jGX'
const CRYPTO_IV = 'wNSOYIB1k1DjY5lA'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.37'
const CHANNEL_USER = 'api-user'
const CHANNEL_HOME = 'wohome'
const CHANNEL_CLOUD = 'wocloud'
const APP_ID = '10000001'
const DEFAULT_ZONE_URL = 'https://tjupload.pan.wo.cn'
const PART_SIZE = 8 * 1024 * 1024
const SPACE_PERSONAL = '0'
const SPACE_FAMILY = '1'
const PAGE_SIZE = 100
const MAX_LIST_PAGES = 50
const UPLOAD_TIMEOUT_MS = 120_000

interface WoPanFile {
  fid?: string
  id: string
  name: string
  size?: number
  createTime?: string
  type: number
  thumbUrl?: string
  fileType?: string
}

interface WoPanList {
  files?: WoPanFile[]
}

interface WoPanDownload {
  list?: Array<{ fid: string; downloadUrl: string }>
}

interface WoPanRefresh {
  access_token?: string
  refresh_token?: string
}

interface WoPanZone {
  url?: string
}

interface WoPanClassifyRule {
  fileTypes?: Record<string, { type?: string }>
}

interface WoPanUploadResult {
  code?: string
  msg?: string
  data?: { fid?: string }
}

interface DispatchResponse {
  STATUS?: string | number
  MSG?: string
  RSP?: {
    RSP_CODE?: string | number
    RSP_DESC?: string
    DATA?: unknown
  }
}

function aesKey(channel: string, accessToken: string): string {
  if (channel === CHANNEL_USER) return CLIENT_SECRET
  return accessToken.length >= 16 ? accessToken.slice(0, 16) : CLIENT_SECRET
}

function encryptParam(content: string, channel: string, accessToken: string): string {
  const cipher = createCipheriv(
    'aes-128-cbc',
    Buffer.from(aesKey(channel, accessToken), 'utf8'),
    Buffer.from(CRYPTO_IV, 'utf8'),
  )
  return Buffer.concat([cipher.update(Buffer.from(content, 'utf8')), cipher.final()]).toString('base64')
}

function decryptParam(content: string, channel: string, accessToken: string): string {
  const decipher = createDecipheriv(
    'aes-128-cbc',
    Buffer.from(aesKey(channel, accessToken), 'utf8'),
    Buffer.from(CRYPTO_IV, 'utf8'),
  )
  return Buffer.concat([decipher.update(Buffer.from(content, 'base64')), decipher.final()]).toString('utf8')
}

function parseWoPanTime(value: string | undefined): number {
  if (!value) return 0
  if (value.length >= 14) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`
    const parsed = Date.parse(iso)
    if (!Number.isNaN(parsed)) return parsed
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function fileEntry(file: WoPanFile): DriverEntry {
  const folder = file.type === 0
  return {
    name: file.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : (Number(file.size) || 0),
    modifiedAt: parseWoPanTime(file.createTime),
    ref: file.fid || file.id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(file.name),
  }
}

function dispatchError(status: string, message: string): DriverError {
  if (status === '9999' || status === '401' || status === '403') {
    return DriverError.auth(`WoPan refused the credentials: ${message}`)
  }
  if (status === '404') return DriverError.notFound(`WoPan could not find the item: ${message}`)
  if (status === '429') return DriverError.rateLimited(`WoPan is rate limiting requests: ${message}`)
  return DriverError.upstream(`WoPan answered ${status}: ${message}`)
}

function downloadError(status: number): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`WoPan refused the download (HTTP ${status})`)
  if (status === 404) return DriverError.notFound('WoPan returned no download resource (HTTP 404)')
  if (status === 429) return DriverError.rateLimited('WoPan is rate limiting downloads')
  return DriverError.upstream(`WoPan download failed (HTTP ${status})`)
}

function uploadError(status: number, label: string): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`WoPan refused ${label} (HTTP ${status})`)
  if (status === 404) return DriverError.notFound(`WoPan could not find ${label} (HTTP 404)`)
  if (status === 429) return DriverError.rateLimited(`WoPan is rate limiting ${label}`)
  return DriverError.upstream(`WoPan rejected ${label} (HTTP ${status})`)
}

function randomChars(length: number): string {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  for (let index = 0; index < length; index++) {
    result += charset.charAt(Math.floor(Math.random() * charset.length))
  }
  return result
}

function uploadBatchNo(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export class WoPanDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('wopan')!
  readonly capabilities = this.definition.capabilities
  private token: string
  private refreshTokenValue: string
  private readonly pathIds = new Map<string, string>()
  private zoneURL = ''
  private classifyLoaded = false
  private classifyTypes: Record<string, { type?: string }> = {}

  constructor(ctx: DriverContext) {
    super(ctx)
    this.token = String(ctx.credentials.accessToken ?? '').trim()
    this.refreshTokenValue = String(ctx.credentials.refreshToken ?? '').trim()
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.token) return
    if (this.refreshTokenValue) {
      this.token = await this.refresh()
      return
    }
    throw DriverError.auth('WoPan needs an app access token, or a refresh token to rotate it')
  }

  private async refresh(): Promise<string> {
    const beforeAccess = String(this.ctx.credentials.accessToken ?? '')
    const beforeRefresh = this.refreshTokenValue
    if (!beforeRefresh) {
      throw DriverError.auth('WoPan needs a refresh token to renew the access token')
    }
    return await singleFlightRefresh(
      this.ctx,
      async () => {
        let payload: WoPanRefresh
        try {
          payload = await this.dispatch<WoPanRefresh>(CHANNEL_USER, 'AppRefreshToken', {
            refreshToken: beforeRefresh,
            clientSecret: CLIENT_SECRET,
          }, { clientId: CLIENT_ID, secret: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'WoPan rejected the refresh token'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        if (!payload?.access_token) {
          const message = 'WoPan returned no access token while refreshing'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        const patch: Record<string, string> = {
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token || beforeRefresh,
        }
        try {
          const effective = await this.ctx.saveCredentials(patch, {
            expect: { accessToken: beforeAccess, refreshToken: beforeRefresh },
          })
          this.token = String(effective.accessToken ?? payload.access_token)
          this.refreshTokenValue = String(effective.refreshToken ?? patch.refreshToken)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'WoPan could not persist the refreshed token'
          await this.ctx.markNeedsReauth(message)
          throw DriverError.auth(message)
        }
        return this.token
      },
      async () => {
        await this.ctx.reloadCredentials?.()
        const current = String(this.ctx.credentials.accessToken ?? '')
        const currentRefresh = String(this.ctx.credentials.refreshToken ?? '')
        return current && (current !== beforeAccess || currentRefresh !== beforeRefresh) ? current : null
      },
    )
  }

  private spaceType(): string {
    return this.configText('familyId') ? SPACE_FAMILY : SPACE_PERSONAL
  }

  private familyId(): string {
    return this.configText('familyId')
  }

  private rootId(): string {
    return this.configText('rootFolderId', '0').trim() || '0'
  }

  private async dispatch<T>(
    channel: string,
    key: string,
    param: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
  ): Promise<T> {
    const resTime = Date.now()
    const reqSeq = Math.floor(Math.random() * 8999) + 100000
    const sign = createHash('md5').update(`${key}${resTime}${reqSeq}${channel}`).digest('hex')
    const body: Record<string, unknown> = { ...extra }
    if (param) body.param = encryptParam(JSON.stringify(param), channel, this.token)

    const response = await this.request(`${BASE_URL}/${channel}/dispatcher`, {
      method: 'POST',
      headers: {
        Origin: 'https://pan.wo.cn',
        Referer: 'https://pan.wo.cn/',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json;charset=UTF-8',
        ...(this.token ? { Accesstoken: this.token } : {}),
      },
      body: JSON.stringify({
        header: { key, resTime, reqSeq, channel, sign, version: '' },
        body,
      }),
    })
    const payload = await response.json().catch(() => null) as DispatchResponse | null
    if (!payload) throw DriverError.upstream('WoPan returned an unexpected body')
    const status = String(payload.STATUS ?? '')
    if (status !== '200') throw dispatchError(status, String(payload.MSG ?? ''))
    const rsp = payload.RSP ?? {}
    const code = String(rsp.RSP_CODE ?? '')
    if (code !== '0000') {
      // 9999 is WoPan's "the access token is no longer valid" answer.
      if (code === '9999') throw DriverError.auth('WoPan rejected the access token')
      throw dispatchError(code, String(rsp.RSP_DESC ?? ''))
    }
    return this.decodeData(rsp.DATA, channel) as T
  }

  private decodeData(data: unknown, channel: string): unknown {
    if (typeof data !== 'string') return data
    let trimmed = data.trim()
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) trimmed = trimmed.slice(1, -1)
    try {
      return JSON.parse(decryptParam(trimmed, channel, this.token))
    } catch {
      try {
        return JSON.parse(trimmed)
      } catch {
        return trimmed
      }
    }
  }

  private async queryPage(folderId: string, page: number, pageSize: number): Promise<{ items: WoPanFile[]; next: string | null }> {
    const param: Record<string, unknown> = {
      spaceType: this.spaceType(),
      parentDirectoryId: folderId,
      pageNum: page - 1,
      pageSize,
      sortRule: 1,
      clientId: CLIENT_ID,
    }
    if (this.spaceType() === SPACE_FAMILY) param.familyId = this.familyId()
    const payload = await this.dispatch<WoPanList>(CHANNEL_HOME, 'QueryAllFiles', param, { secret: true })
    const items = payload?.files ?? []
    return { items, next: items.length >= pageSize ? String(page + 1) : null }
  }

  private async allFiles(folderId: string): Promise<WoPanFile[]> {
    const collected = await collectPages(
      async ({ page }) => await this.queryPage(folderId, page, PAGE_SIZE),
      { maxPages: MAX_LIST_PAGES },
    )
    return collected.items
  }

  private async resolveFolderId(clean: string): Promise<string> {
    if (clean === '/') return this.rootId()
    const cached = this.pathIds.get(clean)
    if (cached) return cached

    const segments = clean.slice(1).split('/')
    let current = this.rootId()
    let prefix = ''
    for (const segment of segments) {
      const files = await this.allFiles(current)
      const found = files.find((file) => file.type === 0 && file.name === segment)
      if (!found) throw DriverError.notFound(`WoPan could not find ${segment}`)
      current = found.id
      prefix = `${prefix}/${segment}`
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveItem(clean: string): Promise<WoPanFile> {
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const name = driverFileName(clean)
    const files = await this.allFiles(parentId)
    const found = files.find((file) => file.name === name || file.id === name || file.fid === name)
    if (!found) throw DriverError.notFound(`WoPan could not find ${name}`)
    return found
  }

  private async downloadUrl(file: WoPanFile): Promise<string> {
    const payload = await this.dispatch<WoPanDownload>(CHANNEL_HOME, 'GetDownloadUrlV2', {
      type: '1',
      fidList: [file.fid || file.id],
      clientId: CLIENT_ID,
    }, { secret: true })
    const hit = payload?.list?.find((entry) => entry.fid === (file.fid || file.id)) ?? payload?.list?.[0]
    const url = (hit?.downloadUrl ?? '').trim()
    if (!url) throw DriverError.notFound(`WoPan returned no download address for ${file.name}`)
    return url
  }

  /** The upload host is account-specific; a failed lookup falls back to the reference default. */
  private async zoneUrl(): Promise<string> {
    if (this.zoneURL) return this.zoneURL
    try {
      const zone = await this.dispatch<WoPanZone>(CHANNEL_HOME, 'GetZoneInfo', { appId: APP_ID }, { key: true })
      this.zoneURL = (zone?.url ?? '').trim() || DEFAULT_ZONE_URL
    } catch {
      this.zoneURL = DEFAULT_ZONE_URL
    }
    return this.zoneURL
  }

  /** The classification rule maps an extension to the numeric type WoPan expects on writes. */
  private async detectFileType(name: string): Promise<string> {
    if (!this.classifyLoaded) {
      this.classifyLoaded = true
      try {
        const rules = await this.dispatch<WoPanClassifyRule>(CHANNEL_HOME, 'ClassifyRule', {}, { key: true })
        this.classifyTypes = rules?.fileTypes ?? {}
      } catch {
        this.classifyTypes = {}
      }
    }
    const dot = name.lastIndexOf('.')
    if (dot < 0) return '5'
    const extension = name.slice(dot + 1).toLowerCase()
    return this.classifyTypes[extension]?.type || '5'
  }

  /** One multipart form POST with a single retry when the connection breaks mid-part. */
  private async uploadPart(
    url: string,
    fields: Record<string, string>,
    chunk: Uint8Array,
    partIndex: number,
    totalPart: number,
    fileName: string,
  ): Promise<WoPanUploadResult> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const form = new FormData()
        for (const [key, value] of Object.entries(fields)) form.append(key, value)
        form.append('file', new Blob([chunk], { type: 'application/octet-stream' }), fileName)
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Origin: 'https://pan.wo.cn',
            Referer: 'https://pan.wo.cn/',
            'User-Agent': USER_AGENT,
          },
          body: form,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
        if (!response.ok) {
          const error = uploadError(response.status, `upload part ${partIndex}/${totalPart}`)
          await response.body?.cancel().catch(() => undefined)
          if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
            lastError = error
            continue
          }
          throw error
        }
        const payload = await response.json().catch(() => ({})) as WoPanUploadResult
        if (String(payload.code) !== '0000') {
          throw DriverError.upstream(
            `WoPan rejected upload part ${partIndex}/${totalPart}: ${payload.code ?? ''} ${payload.msg ?? ''}`,
          )
        }
        return payload
      } catch (error) {
        if (attempt === 0 && !(error instanceof DriverError)) {
          lastError = error
          continue
        }
        throw error
      }
    }
    throw lastError instanceof DriverError
      ? lastError
      : DriverError.upstream(`WoPan upload failed: ${lastError instanceof Error ? lastError.message : 'unknown error'}`)
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const folderId = await this.resolveFolderId(clean)
      const pageSize = Math.min(PAGE_SIZE, Math.max(1, options.pageSize ?? PAGE_SIZE))
      const filter = (entries: DriverEntry[]): DriverEntry[] => {
        if (!options.search) return entries
        const needle = options.search.toLowerCase()
        return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      }
      if (options.page !== undefined) {
        const page = await this.queryPage(folderId, Math.max(1, options.page), pageSize)
        return {
          entries: filter(page.items.map(fileEntry)),
          cursor: page.next,
          truncated: page.next !== null,
        }
      }
      const collected = await collectPages(
        async ({ page }) => await this.queryPage(folderId, page, pageSize),
        { maxPages: MAX_LIST_PAGES },
      )
      return { entries: filter(collected.items.map(fileEntry)), cursor: null, truncated: collected.truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      if (clean === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
      }
      return fileEntry(await this.resolveItem(clean))
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(clean)
      if (file.type === 0) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = await this.downloadUrl(file)
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          ...(range ? { Range: range } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw downloadError(response.status)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(clean)
      if (file.type === 0) return null
      try {
        return await this.downloadUrl(file)
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'not_found') return null
        throw error
      }
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    return await this.withAuth(async () => {
      const name = driverFileName(clean)
      const parentId = await this.resolveFolderId(driverParentPath(clean))
      const url = `${await this.zoneUrl()}/openapi/client/upload2C`
      const fileType = await this.detectFileType(name)
      const fileInfo: Record<string, unknown> = {
        spaceType: this.spaceType(),
        directoryId: parentId,
        batchNo: uploadBatchNo(),
        fileName: name,
        fileSize: bytes.byteLength,
        fileType,
      }
      if (this.spaceType() === SPACE_FAMILY) fileInfo.familyId = this.familyId()
      const fileInfoStr = encryptParam(JSON.stringify(fileInfo), CHANNEL_CLOUD, this.token)
      const uniqueId = `${Date.now()}_${randomChars(6)}`
      const totalPart = Math.max(1, Math.ceil(bytes.byteLength / PART_SIZE))
      let finished = 0
      for (let part = 1; part <= totalPart; part++) {
        const start = (part - 1) * PART_SIZE
        const partSize = part === totalPart ? bytes.byteLength - start : PART_SIZE
        const chunk = bytes.subarray(start, start + partSize)
        const fields = {
          uniqueId,
          accessToken: this.token,
          fileName: name,
          psToken: 'undefined',
          fileSize: String(bytes.byteLength),
          totalPart: String(totalPart),
          channel: CHANNEL_CLOUD,
          directoryId: parentId,
          fileInfo: fileInfoStr,
          partSize: String(partSize),
          partIndex: String(part),
        }
        await this.uploadPart(url, fields, chunk, part, totalPart, name)
        finished += partSize
        options.onProgress?.(finished, bytes.byteLength)
      }
      this.pathIds.clear()
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    return await this.withAuth(async () => {
      const parentId = await this.resolveFolderId(driverParentPath(clean))
      await this.dispatch(CHANNEL_HOME, 'CreateDirectory', {
        spaceType: this.spaceType(),
        familyId: this.familyId(),
        parentDirectoryId: parentId,
        directoryName: driverFileName(clean),
        clientId: CLIENT_ID,
      }, { secret: true })
      this.pathIds.clear()
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(clean)
      const fileType = file.type === 0 ? '0' : await this.detectFileType(newName)
      const param: Record<string, unknown> = {
        spaceType: this.spaceType(),
        type: file.type,
        fileType,
        id: file.id,
        name: newName,
        clientId: CLIENT_ID,
      }
      if (this.spaceType() === SPACE_FAMILY) param.familyId = this.familyId()
      await this.dispatch(CHANNEL_HOME, 'RenameFileOrDirectory', param, { secret: true })
      this.pathIds.clear()
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(from)
      const targetDirId = await this.resolveFolderId(driverParentPath(to))
      const param: Record<string, unknown> = {
        targetDirId,
        sourceType: this.spaceType(),
        targetType: this.spaceType(),
        dirList: file.type === 0 ? [file.id] : [],
        fileList: file.type === 0 ? [] : [file.id],
        secret: false,
        clientId: CLIENT_ID,
      }
      if (this.spaceType() === SPACE_FAMILY) {
        param.fromFamilyId = this.familyId()
        param.familyId = this.familyId()
      }
      await this.dispatch(CHANNEL_HOME, 'MoveFile', param, { secret: true })
      this.pathIds.clear()
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(from)
      const targetDirId = await this.resolveFolderId(driverParentPath(to))
      const param: Record<string, unknown> = {
        targetDirId,
        sourceType: this.spaceType(),
        targetType: this.spaceType(),
        dirList: file.type === 0 ? [file.id] : [],
        fileList: file.type === 0 ? [] : [file.id],
        secret: false,
        clientId: CLIENT_ID,
      }
      if (this.spaceType() === SPACE_FAMILY) {
        param.fromFamilyId = this.familyId()
        param.familyId = this.familyId()
      }
      await this.dispatch(CHANNEL_HOME, 'CopyFile', param, { secret: true })
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const file = await this.resolveItem(clean)
      await this.dispatch(CHANNEL_HOME, 'DeleteFile', {
        spaceType: this.spaceType(),
        vipLevel: '0',
        dirList: file.type === 0 ? [file.id] : [],
        fileList: file.type === 0 ? [] : [file.id],
        clientId: CLIENT_ID,
      }, { secret: true })
      this.pathIds.clear()
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.queryPage(this.rootId(), 1, 1)
      return { ok: true, message: 'WoPan is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'WoPan is unavailable' }
    }
  }
}

export function createWopanDriver(ctx: DriverContext): MountDriver {
  return new WoPanDriver(ctx)
}
