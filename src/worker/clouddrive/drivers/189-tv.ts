/**
 * China Telecom Cloud TV / family-cloud driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/189_tv`:
 * the TV client signs every request with the session key it obtains from the access token, and the
 * family variant uses a separate family session. The access token is issued out of band, so this
 * driver never runs a refresh flow; a rejected token marks the storage for re-authorization instead.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
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
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const API = 'https://api.cloud.189.cn'
const FAMILY_API = `${API}/family/file`
const APP_KEY = '600100885'
const APP_SIGNATURE_SECRET = 'fe5734c74c2f96a38157f420b32dc995'
const CLIENT_TYPE = 'FAMILY_TV'
const CLIENT_VERSION = '6.5.5'
const CHANNEL_ID = 'home02'
const USER_AGENT = 'EcloudTV/6.5.5 (PJX110; unknown; home02) Android/35'
const PAGE_SIZE = 130
const MAX_LIST_PAGES = 50
const PERSONAL_ROOT_ID = '-11'

interface TvFile {
  id: string
  name: string
  size?: number
  md5?: string
  lastOpTime?: string
  createDate?: string
  icon?: { smallUrl?: string; largeUrl?: string }
}

interface TvFolder {
  id: string
  parentId?: number
  name: string
  lastOpTime?: string
  createDate?: string
}

type TvItem = TvFile | TvFolder

interface TvList {
  fileListAO?: {
    count?: number
    folderList?: TvFolder[]
    fileList?: TvFile[]
  }
}

interface TvSession {
  sessionKey?: string
  sessionSecret?: string
  familySessionKey?: string
  familySessionSecret?: string
  accessToken?: string
}

interface TvUploadSession {
  uploadFileId?: number | string
  fileUploadUrl?: string
  fileCommitUrl?: string
  fileDataExists?: number
}

interface TvBatchTask {
  taskId?: number | string
}

interface TvBatchState {
  taskStatus?: number
}

interface TvBatchInfo {
  fileId: string
  fileName: string
  isFolder: number
}

interface TvPage {
  items: TvItem[]
  next: string | null
}

function isFolder(item: TvItem): item is TvFolder {
  return 'parentId' in item || !('size' in item)
}

function parseTvTime(value: string | undefined): number {
  if (!value) return 0
  const cleaned = value.trim().replace(/["']/g, '').replace(/ +08$/, '+08:00')
  const parsed = Date.parse(cleaned)
  return Number.isNaN(parsed) ? 0 : parsed
}

function itemEntry(item: TvItem): DriverEntry {
  const folder = isFolder(item)
  return {
    name: item.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : (Number(item.size) || 0),
    modifiedAt: parseTvTime(item.lastOpTime || item.createDate),
    ref: item.id,
    mime: folder ? 'application/octet-stream' : driverEntryMime(item.name),
  }
}

function protectIds(text: string): string {
  // The API returns int64 ids as bare numbers; JSON.parse would round them past 2^53.
  return text.replace(/("id"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"')
}

function payloadMessage(payload: Record<string, unknown>): string {
  for (const key of ['res_message', 'errorMsg', 'msg', 'message', 'error']) {
    const value = payload[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function hasApiError(payload: Record<string, unknown>): boolean {
  const code = payload.res_code
  if (typeof code === 'number' && code !== 0) return true
  if (typeof code === 'string' && code !== '' && code !== '0') return true
  const errorCode = payload.errorCode
  if (typeof errorCode === 'string' && errorCode && errorCode !== 'SUCCESS') return true
  const status = payload.code
  if (typeof status === 'string' && status && status !== 'SUCCESS') return true
  return typeof payload.error === 'string' && payload.error !== ''
}

const AUTH_MESSAGE = /invalid session key|usersessionbo is null|session expired|authorization|token/i

function apiError(payload: Record<string, unknown>): DriverError {
  const message = payloadMessage(payload) || '189 TV refused the request'
  const rawCode = payload.res_code ?? payload.code ?? payload.errorCode
  const code = Number(rawCode)
  const codeText = `${String(payload.errorCode ?? '')} ${String(payload.code ?? '')}`
  if (AUTH_MESSAGE.test(message) || AUTH_MESSAGE.test(codeText)) return DriverError.auth(`189 TV: ${message}`)
  if (code === 401 || code === 403) return DriverError.auth(`189 TV: ${message}`)
  if (code === 404) return DriverError.notFound(`189 TV: ${message}`)
  if (code === 429) return DriverError.rateLimited(`189 TV: ${message}`)
  return DriverError.upstream(`189 TV: ${message}`)
}

function downloadError(status: number): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`189 TV refused the download (HTTP ${status})`)
  if (status === 404) return DriverError.notFound('189 TV returned no download resource (HTTP 404)')
  if (status === 429) return DriverError.rateLimited('189 TV is rate limiting downloads')
  return DriverError.upstream(`189 TV download failed (HTTP ${status})`)
}

function clientSuffix(): Record<string, string> {
  return {
    clientType: CLIENT_TYPE,
    version: CLIENT_VERSION,
    channelId: CHANNEL_ID,
    clientSn: 'unknown',
    model: 'PJX110',
    osFamily: 'Android',
    osVersion: '35',
    networkAccessMode: 'WIFI',
    telecomsOperator: '46011',
  }
}

class Tv189Driver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('189_tv')!
  readonly capabilities = this.definition.capabilities
  private session: TvSession | null = null
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(_force: boolean): Promise<void> {
    const token = String(this.ctx.credentials.accessToken ?? '').trim()
    if (!token) {
      throw DriverError.auth('189 TV needs the access token issued by the TV login flow')
    }
    try {
      const session = await this.api<TvSession>(`${API}/family/manage/loginFamilyMerge.action`, 'GET', {
        query: { e189AccessToken: token },
        isAppKey: true,
      })
      if (!session.sessionKey && !session.familySessionKey) {
        throw DriverError.auth('189 TV returned no session key for this access token')
      }
      this.session = session
      const issued = session.accessToken?.trim()
      if (issued && issued !== token) {
        const effective = await this.ctx.saveCredentials(
          { accessToken: issued },
          { expect: { accessToken: token } },
        )
        this.ctx.credentials.accessToken = String(effective.accessToken ?? issued)
      }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      throw error
    }
  }

  private isFamily(): boolean {
    return this.configText('type', 'personal') === 'family'
  }

  private familyId(): string {
    return this.configText('familyId')
  }

  private rootId(): string {
    const configured = this.configText('rootFolderId').trim()
    if (configured) return configured
    return this.isFamily() ? '' : PERSONAL_ROOT_ID
  }

  private baseUrl(): string {
    return this.isFamily() ? FAMILY_API : API
  }

  private sessionKey(family = this.isFamily()): string {
    return (family ? this.session?.familySessionKey : this.session?.sessionKey) ?? ''
  }

  private sessionSecret(family = this.isFamily()): string {
    return (family ? this.session?.familySessionSecret : this.session?.sessionSecret) ?? ''
  }

  private sessionHeaders(url: string, method: string, family = this.isFamily()): Record<string, string> {
    const date = new Date().toUTCString()
    const key = this.sessionKey(family)
    const secret = this.sessionSecret(family)
    const data = `SessionKey=${key}&Operate=${method}&RequestURI=${new URL(url).pathname}&Date=${date}`
    return {
      Date: date,
      SessionKey: key,
      'X-Request-ID': randomUUID(),
      Signature: createHmac('sha1', secret).update(data).digest('hex').toUpperCase(),
    }
  }

  private appKeyHeaders(url: string, method: string): Record<string, string> {
    const timestamp = Date.now()
    const data = `AppKey=${APP_KEY}&Operate=${method}&RequestURI=${new URL(url).pathname}&Timestamp=${timestamp}`
    return {
      Timestamp: String(timestamp),
      'X-Request-ID': randomUUID(),
      AppKey: APP_KEY,
      AppSignature: createHmac('sha1', APP_SIGNATURE_SECRET).update(data).digest('hex').toUpperCase(),
    }
  }

  private async api<T>(
    url: string,
    method: 'GET' | 'POST',
    options: {
      query?: Record<string, string>
      form?: Record<string, string>
      isFamily?: boolean
      isAppKey?: boolean
    } = {},
  ): Promise<T> {
    const target = new URL(url)
    for (const [key, value] of Object.entries(clientSuffix())) target.searchParams.set(key, value)
    for (const [key, value] of Object.entries(options.query ?? {})) target.searchParams.set(key, value)

    const headers: Record<string, string> = {
      Accept: 'application/json;charset=UTF-8',
      'User-Agent': USER_AGENT,
      ...(options.isAppKey
        ? this.appKeyHeaders(url, method)
        : this.sessionHeaders(url, method, options.isFamily ?? this.isFamily())),
    }
    let body: string | undefined
    if (options.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
      body = new URLSearchParams(options.form).toString()
    }
    const response = await this.request(target.toString(), { method, headers, body })
    const text = await response.text()
    if (/userSessionBO is null|InvalidSessionKey/i.test(text)) {
      throw DriverError.auth('189 TV reports that the session has expired')
    }
    let payload: unknown
    try {
      payload = JSON.parse(protectIds(text))
    } catch {
      throw DriverError.upstream('189 TV returned an unexpected body')
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw DriverError.upstream('189 TV returned an unexpected body')
    }
    const record = payload as Record<string, unknown>
    if (hasApiError(record)) throw apiError(record)
    return record as T
  }

  private listUrl(): string {
    return `${this.baseUrl()}/listFiles.action`
  }

  private async fetchPage(folderId: string, pageNumber: number, pageSize: number): Promise<TvPage> {
    const query: Record<string, string> = {
      folderId,
      fileType: '0',
      mediaAttr: '0',
      iconOption: '5',
      pageNum: String(pageNumber),
      pageSize: String(pageSize),
    }
    if (this.isFamily()) {
      query.familyId = this.familyId()
      query.orderBy = '3'
      query.descending = 'false'
    } else {
      query.recursive = '0'
      query.orderBy = 'lastOpTime'
      query.descending = 'false'
    }
    const payload = await this.api<TvList>(this.listUrl(), 'GET', {
      query,
      isFamily: this.isFamily(),
    })
    const folderList = payload.fileListAO?.folderList ?? []
    const fileList = payload.fileListAO?.fileList ?? []
    const items: TvItem[] = [...folderList, ...fileList]
    const total = Number(payload.fileListAO?.count)
    const more = items.length >= pageSize
      || (Number.isFinite(total) && total > 0 && pageNumber * pageSize < total)
    return { items, next: more ? String(pageNumber + 1) : null }
  }

  private async allEntries(folderId: string): Promise<TvItem[]> {
    const collected = await collectPages(
      async ({ page }) => await this.fetchPage(folderId, page, PAGE_SIZE),
      { maxPages: MAX_LIST_PAGES },
    )
    return collected.items
  }

  private async pathToId(clean: string): Promise<string> {
    if (clean === '/') return this.rootId()
    const cached = this.pathIds.get(clean)
    if (cached) return cached

    const segments = clean.slice(1).split('/')
    let current = this.rootId()
    let prefix = ''
    for (const segment of segments) {
      const files = await this.allEntries(current)
      const found = files.find((item) => isFolder(item) && item.name === segment)
      if (!found) throw DriverError.notFound(`189 TV could not find ${segment}`)
      current = found.id
      prefix = `${prefix}/${segment}`
      this.pathIds.set(prefix, current)
    }
    return current
  }

  private async resolveItem(clean: string): Promise<TvItem> {
    if (clean === '/') {
      return { id: this.rootId(), name: 'root' }
    }
    const parentId = await this.pathToId(driverParentPath(clean))
    const name = driverFileName(clean)
    const found = (await this.allEntries(parentId)).find((item) => item.name === name)
    if (!found) throw DriverError.notFound(`189 TV could not find ${name}`)
    return found
  }

  private async downloadUrl(item: TvItem): Promise<string> {
    const query: Record<string, string> = { fileId: item.id }
    if (this.isFamily()) {
      query.familyId = this.familyId()
    } else {
      query.dt = '3'
      query.flag = '1'
    }
    const payload = await this.api<{ fileDownloadUrl?: string }>(
      `${this.baseUrl()}/getFileDownloadUrl.action`,
      'GET',
      { query, isFamily: this.isFamily() },
    )
    const url = (payload.fileDownloadUrl ?? '').replace(/&amp;/g, '&').replace(/^http:\/\//i, 'https://')
    if (!url) throw DriverError.notFound(`189 TV returned no download address for ${item.name}`)
    return url
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const folderId = await this.pathToId(clean)
      const pageSize = Math.min(PAGE_SIZE, Math.max(1, options.pageSize ?? PAGE_SIZE))
      const filter = (entries: DriverEntry[]): DriverEntry[] => {
        if (!options.search) return entries
        const needle = options.search.toLowerCase()
        return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      }
      if (options.page !== undefined) {
        const page = await this.fetchPage(folderId, Math.max(1, options.page), pageSize)
        return {
          entries: filter(page.items.map(itemEntry)),
          cursor: page.next,
          truncated: page.next !== null,
        }
      }
      const collected = await collectPages(
        async ({ page }) => await this.fetchPage(folderId, page, pageSize),
        { maxPages: MAX_LIST_PAGES },
      )
      return { entries: filter(collected.items.map(itemEntry)), cursor: null, truncated: collected.truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const item = await this.resolveItem(clean)
      if (clean === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), ref: this.rootId() }
      }
      return itemEntry(item)
    })
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    return await this.withAuth(async () => {
      const item = await this.resolveItem(clean)
      if (isFolder(item)) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = await this.downloadUrl(item)
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
      const item = await this.resolveItem(clean)
      if (isFolder(item)) return null
      try {
        return await this.downloadUrl(item)
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'not_found') return null
        throw error
      }
    })
  }

  private async createFolder(parentId: string, name: string): Promise<void> {
    const query: Record<string, string> = { folderName: name, relativePath: '' }
    if (this.isFamily()) {
      query.familyId = this.familyId()
      query.parentId = parentId
    } else {
      query.parentFolderId = parentId
    }
    await this.api(`${this.baseUrl()}/createFolder.action`, 'POST', { query, isFamily: this.isFamily() })
  }

  private async renameItem(item: TvItem, newName: string): Promise<void> {
    const folder = isFolder(item)
    const query: Record<string, string> = {}
    if (this.isFamily()) query.familyId = this.familyId()
    if (folder) {
      query.folderId = item.id
      query.destFolderName = newName
    } else {
      query.fileId = item.id
      query.destFileName = newName
    }
    // The reference uses GET for family-cloud renames and POST for the personal cloud.
    const method = this.isFamily() ? 'GET' : 'POST'
    const suffix = folder ? '/renameFolder.action' : '/renameFile.action'
    await this.api(`${this.baseUrl()}${suffix}`, method, { query, isFamily: this.isFamily() })
  }

  private async createBatchTask(type: string, targetFolderId: string, infos: TvBatchInfo[]): Promise<string> {
    const form: Record<string, string> = { type, taskInfos: JSON.stringify(infos) }
    if (targetFolderId) form.targetFolderId = targetFolderId
    const familyId = this.isFamily() ? this.familyId() : ''
    if (familyId) form.familyId = familyId
    const payload = await this.api<TvBatchTask>(`${API}/batch/createBatchTask.action`, 'POST', {
      form,
      isFamily: familyId !== '',
    })
    const taskId = payload.taskId === undefined || payload.taskId === null ? '' : String(payload.taskId)
    if (!taskId) throw DriverError.upstream('189 TV did not create the batch task')
    return taskId
  }

  private async waitBatchTask(type: string, taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      // The reference polls with the personal session key, even when the task ran in family mode.
      const payload = await this.api<TvBatchState>(`${API}/batch/checkBatchTask.action`, 'POST', {
        form: { type, taskId },
        isFamily: false,
      })
      if (payload.taskStatus === 4) return
      if (payload.taskStatus === 2) {
        throw DriverError.upstream('189 TV refused the batch task: the target already has an item with the same name')
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw DriverError.upstream('189 TV batch task timed out')
  }

  private async runBatchTask(type: string, targetFolderId: string, info: TvBatchInfo): Promise<void> {
    const taskId = await this.createBatchTask(type, targetFolderId, [info])
    await this.waitBatchTask(type, taskId)
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const name = driverFileName(clean)
    if (!name) throw DriverError.invalid('A file name is required')
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    await this.withAuth(async () => {
      const parentId = await this.pathToId(driverParentPath(clean))
      const md5 = createHash('md5').update(bytes).digest('hex')
      const fileSize = String(bytes.byteLength)
      let create: TvUploadSession
      if (this.isFamily()) {
        create = await this.api<TvUploadSession>(`${FAMILY_API}/createFamilyFile.action`, 'POST', {
          query: {
            familyId: this.familyId(),
            parentId,
            fileMd5: md5,
            fileName: name,
            fileSize,
            resumePolicy: '1',
          },
          isFamily: true,
        })
      } else {
        create = await this.api<TvUploadSession>(`${API}/createUploadFile.action`, 'POST', {
          form: {
            parentFolderId: parentId,
            fileName: name,
            size: fileSize,
            md5,
            opertype: '3',
            flag: '1',
            resumePolicy: '1',
            isLog: '0',
          },
          isFamily: false,
        })
      }
      // A matched md5 means the service already holds the bytes: the session is complete without a PUT.
      if (create.fileDataExists === 1) {
        this.pathIds.clear()
        options.onProgress?.(bytes.byteLength, bytes.byteLength)
        return
      }
      const uploadFileId = create.uploadFileId === undefined || create.uploadFileId === null
        ? ''
        : String(create.uploadFileId)
      const uploadUrl = create.fileUploadUrl ?? ''
      const commitUrl = create.fileCommitUrl ?? ''
      if (!uploadFileId || !uploadUrl || !commitUrl) {
        throw DriverError.upstream('189 TV did not create an upload session')
      }

      const putHeaders: Record<string, string> = {
        ResumePolicy: '1',
        Expect: '100-continue',
        'User-Agent': USER_AGENT,
        ...this.sessionHeaders(uploadUrl, 'PUT', this.isFamily()),
      }
      if (this.isFamily()) {
        putHeaders.FamilyId = this.familyId()
        putHeaders.UploadFileId = uploadFileId
      } else {
        putHeaders['Edrive-UploadFileId'] = uploadFileId
      }
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: putHeaders,
        body: bytes,
        signal: AbortSignal.timeout(60_000),
      })
      if (put.status !== 200) {
        await put.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`189 TV rejected the upload (HTTP ${put.status})`)
      }

      if (this.isFamily()) {
        await this.api(commitUrl, 'POST', {
          query: { ResumePolicy: '1', UploadFileId: uploadFileId, FamilyId: this.familyId() },
          isFamily: true,
        })
      } else {
        await this.api(commitUrl, 'POST', {
          form: { opertype: '3', resumePolicy: '1', uploadFileId, isLog: '0' },
          isFamily: false,
        })
      }
      this.pathIds.clear()
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    const name = driverFileName(clean)
    if (!name) throw DriverError.invalid('A folder name is required')
    await this.withAuth(async () => {
      await this.createFolder(await this.pathToId(driverParentPath(clean)), name)
      this.pathIds.clear()
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The root cannot be renamed')
    const problem = cloudDriveNameProblem(newName)
    if (problem) throw DriverError.invalid(problem)
    await this.withAuth(async () => {
      await this.renameItem(await this.resolveItem(clean), newName)
      this.pathIds.clear()
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/') throw DriverError.invalid('The root cannot be moved')
    const targetName = driverFileName(to)
    if (!targetName) throw DriverError.invalid('A destination name is required')
    await this.withAuth(async () => {
      const entry = await this.resolveItem(from)
      if (targetName !== entry.name) await this.renameItem(entry, targetName)
      await this.runBatchTask('MOVE', await this.pathToId(driverParentPath(to)), {
        fileId: entry.id,
        fileName: targetName,
        isFolder: isFolder(entry) ? 1 : 0,
      })
      this.pathIds.clear()
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/') throw DriverError.invalid('The root cannot be copied')
    const targetName = driverFileName(to)
    if (!targetName) throw DriverError.invalid('A destination name is required')
    await this.withAuth(async () => {
      const entry = await this.resolveItem(from)
      await this.runBatchTask('COPY', await this.pathToId(driverParentPath(to)), {
        fileId: entry.id,
        fileName: entry.name,
        isFolder: isFolder(entry) ? 1 : 0,
      })
      // The copy endpoint keeps the source name; a differing destination is renamed afterwards.
      if (targetName !== entry.name) {
        await this.renameItem(await this.resolveItem(to), targetName)
      }
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The root cannot be removed')
    await this.withAuth(async () => {
      const entry = await this.resolveItem(clean)
      await this.runBatchTask('DELETE', '', {
        fileId: entry.id,
        fileName: entry.name,
        isFolder: isFolder(entry) ? 1 : 0,
      })
      this.pathIds.clear()
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.fetchPage(this.rootId(), 1, 1)
      return { ok: true, message: '189 TV is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '189 TV is unavailable' }
    }
  }
}

export function create189TvDriver(ctx: DriverContext): MountDriver {
  return new Tv189Driver(ctx)
}
