/**
 * MoPan (China Mobile HeCaiYun) driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/mopan`: every API call is a POST whose body and
 * device fingerprint are AES-128-CBC encrypted under a per-request secret key, listing pages by
 * `pageNum`, move/copy are batch tasks that are polled to completion, and uploads use the prefixed
 * multipart endpoints. The cipher lives in WebCrypto so the driver runs on Workers unchanged.
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
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
  uploadInParts,
} from './http'

const API = 'https://mcloud.caiyun.feixin.10086.cn/MoPanProxyFamily'
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 12) inkstone-clouddrive'
const DEFAULT_MP_VERSION = '1.1.202'
const PAGE_LIMIT = 100
const MAX_LIST_PAGES = 50
const DEFAULT_PART_SIZE = 10 * 1024 * 1024
const TASK_COPY = 1
const TASK_MOVE = 2
const TASK_STATUS_CONFLICT = 2
const TASK_STATUS_COMPLETED = 4

interface DeviceInfo {
  appVersion: string
  brand: string
  deviceId: string
  deviceName: string
  imei: string
  imsi: string
  mac: string
  mno: string
  model: string
  mpVersion: string
  networkType: string
  osVersion: string
  platform: string
}

interface MoPanLogin {
  token: string
  userCloudStorageRelations?: Array<{ folderID: string; path: string }>
}

interface MoPanUser {
  userID: string
  nickname?: string
}

interface MoPanFolder {
  id: string
  name: string
  lastOpTime?: string
}

interface MoPanFile {
  id: string
  name: string
  size?: number
  md5?: string
  lastOpTime?: string
}

interface MoPanListData {
  fileListAO?: { folderList?: MoPanFolder[]; fileList?: MoPanFile[] }
}

interface MoPanInitUpload {
  uploadFileID: string
  partInfos: string[]
  fileDataExists: boolean
  partSize: number
}

interface MoPanUploadPart {
  partNumber: number
  uploadUrl: string
}

interface MoPanBatchTask {
  taskIDList: string[]
  taskType: number
  targetFolderID: string
}

interface MoPanTaskStatus {
  taskID: string
  taskStatus: number
}

const AES_IV = new Uint8Array(16)

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2))
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length)
}

function createDefaultDeviceInfo(): DeviceInfo {
  return {
    appVersion: '8.0.0',
    brand: 'Xiaomi',
    deviceId: randomHex(16),
    deviceName: 'M2102J2SC',
    imei: randomHex(16),
    imsi: randomHex(16),
    mac: Array.from({ length: 6 }, () => randomHex(2)).join(':'),
    mno: '46000',
    model: 'M2102J2SC',
    mpVersion: DEFAULT_MP_VERSION,
    networkType: 'wifi',
    osVersion: '12',
    platform: 'android',
  }
}

function secretKey(): string {
  return randomHex(16).padEnd(16, '0')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!)
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function aesEncrypt(data: Uint8Array, key: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  )
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: AES_IV }, cryptoKey, data)
  return new Uint8Array(ciphertext)
}

async function aesDecrypt(data: Uint8Array, key: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  )
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: AES_IV }, cryptoKey, data)
  return new Uint8Array(plaintext)
}

/** RFC 1321 MD5; SubtleCrypto has no MD5 and the upload endpoints require it. */
export function md5Hex(input: Uint8Array | string): string {
  const message = typeof input === 'string' ? new TextEncoder().encode(input) : input
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

function modifiedAt(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function folderEntry(folder: MoPanFolder): DriverEntry {
  return {
    name: folder.name,
    kind: 'folder',
    size: 0,
    modifiedAt: modifiedAt(folder.lastOpTime),
    ref: folder.id,
    mime: 'application/octet-stream',
  }
}

function fileEntry(file: MoPanFile): DriverEntry {
  return {
    name: file.name,
    kind: 'file',
    size: Number(file.size) || 0,
    modifiedAt: modifiedAt(file.lastOpTime),
    ref: file.id,
    mime: driverEntryMime(file.name),
  }
}

function downloadStatusError(status: number): DriverError {
  if (status === 401 || status === 403) return DriverError.auth(`MoPan refused the download (HTTP ${status})`)
  if (status === 404) return DriverError.notFound('The download address was not found (HTTP 404)')
  if (status === 429) return DriverError.rateLimited('The download was rate limited')
  return DriverError.upstream(`MoPan download failed (HTTP ${status})`)
}

class MoPanDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('mopan')!
  readonly capabilities = this.definition.capabilities
  private token = ''
  private userId = ''
  private detectedRootId = ''
  private device: DeviceInfo | null = null
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private cloudId(): string {
    return this.configText('cloudId').trim()
  }

  private cloudPatch(): Record<string, string> {
    const cloudId = this.cloudId()
    return cloudId ? { cloudId } : {}
  }

  private rootId(): string {
    return this.configText('rootFolderId').trim() || this.detectedRootId
  }

  private uploadThreads(): number {
    const raw = this.ctx.config.uploadThread
    const value = typeof raw === 'number' ? raw : Number(raw)
    return Math.min(8, Math.max(1, Number.isFinite(value) ? Math.floor(value) : 3))
  }

  private async ensureDeviceInfo(): Promise<DeviceInfo> {
    if (this.device) return this.device
    const raw = (this.ctx.credentials.deviceInfo ?? '').trim()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object') {
          this.device = parsed as DeviceInfo
          return this.device
        }
      } catch {
        // A corrupt fingerprint is replaced below with a fresh one.
      }
    }
    const device = createDefaultDeviceInfo()
    this.device = device
    await this.saveCredential({ deviceInfo: JSON.stringify(device) })
    return device
  }

  protected async login(force: boolean): Promise<void> {
    if (!force && this.token) return
    const phone = this.configText('phone').trim()
    const password = (this.ctx.credentials.password ?? '').trim()
    const smsCode = (this.ctx.credentials.smsCode ?? '').trim()
    if (!phone || (!password && !smsCode)) {
      const message = 'MoPan needs a phone number and either a password or an SMS code'
      await this.ctx.markNeedsReauth(message)
      throw DriverError.auth(message)
    }
    await this.ensureDeviceInfo()

    if (smsCode === 'send') {
      await this.rawApi('/sendSmsCode', { phone })
      throw DriverError.auth('The MoPan SMS code was sent; enter it in the credentials to continue')
    }

    try {
      const login = smsCode
        ? await this.rawApi<MoPanLogin>('/loginBySms', { phone, smsCode })
        : await this.rawApi<MoPanLogin>('/login', { phone, password })
      if (!login?.token) throw DriverError.auth('MoPan returned no session token')
      this.token = login.token.startsWith('Bearer ') ? login.token : `Bearer ${login.token}`

      if (!this.rootId() && login.userCloudStorageRelations) {
        const relation = login.userCloudStorageRelations.find((item) => item.path === '/\u6587\u4ef6')
          ?? login.userCloudStorageRelations.find((item) => item.path.includes('\u6587\u4ef6'))
        this.detectedRootId = relation?.folderID ?? ''
      }

      const user = await this.rawApi<MoPanUser>('/getUserInfo', null)
      this.userId = user?.userID ?? ''
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'auth') {
        await this.ctx.markNeedsReauth(error.message)
      }
      throw error
    }
  }

  /**
   * One encrypted call. The body and the device fingerprint share a per-request AES key; the key
   * itself travels in the `encrypted-key` header. The reference implementation fills that header
   * with a base64 copy of the key because its bundled RSA public key is a placeholder, so the same
   * wire shape is kept here instead of silently changing the protocol.
   */
  private async rawApi<T>(endpoint: string, data: Record<string, unknown> | null): Promise<T> {
    const key = secretKey()
    const device = this.device ?? await this.ensureDeviceInfo()
    const remoteInfo = bytesToBase64(await aesEncrypt(new TextEncoder().encode(JSON.stringify(device)), key))
    const encryptedKey = bytesToBase64(new TextEncoder().encode(key))
    const body = data === null
      ? undefined
      : JSON.stringify(bytesToBase64(await aesEncrypt(new TextEncoder().encode(JSON.stringify(data)), key)))

    const response = await this.request(`${API}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: this.token,
        remoteInfo,
        version: device.mpVersion || DEFAULT_MP_VERSION,
        'encrypted-key': encryptedKey,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body,
    })

    let text = await response.text()
    if (text.startsWith('"') && text.endsWith('"')) {
      const encoded = JSON.parse(text) as string
      text = new TextDecoder().decode(await aesDecrypt(base64ToBytes(encoded), key))
    }

    let payload: { code?: number; message?: string; data?: T }
    try {
      payload = JSON.parse(text) as typeof payload
    } catch {
      throw DriverError.upstream('MoPan returned a body that is not JSON')
    }
    if (!payload || typeof payload !== 'object') throw DriverError.upstream('MoPan returned an empty answer')
    const code = Number(payload.code)
    if (code === 401 || code === 403) {
      throw DriverError.auth(payload.message || 'MoPan authorization expired')
    }
    if (code === 429) throw DriverError.rateLimited(payload.message || 'MoPan is rate limiting requests')
    if (code === 404) throw DriverError.notFound(payload.message || 'Not found upstream')
    if (code !== 200) throw DriverError.upstream(payload.message || `MoPan answered code ${code}`)
    return payload.data as T
  }

  private async api<T>(endpoint: string, data: Record<string, unknown> | null): Promise<T> {
    return await this.withAuth(async () => await this.rawApi<T>(endpoint, data))
  }

  private async queryPage(folderId: string, page: number): Promise<MoPanListData> {
    return await this.api<MoPanListData>('/queryFiles', {
      folderId,
      pageNum: page,
      orderBy: 'filename',
      descending: false,
      ...this.cloudPatch(),
    })
  }

  private async findFolder(parentId: string, name: string): Promise<MoPanFolder | null> {
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const data = await this.queryPage(parentId, page)
      const folders = data?.fileListAO?.folderList ?? []
      const files = data?.fileListAO?.fileList ?? []
      const hit = folders.find((folder) => folder.name === name)
      if (hit) return hit
      if (folders.length + files.length < PAGE_LIMIT) return null
    }
    return null
  }

  private async findFile(parentId: string, name: string): Promise<MoPanFile | null> {
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const data = await this.queryPage(parentId, page)
      const folders = data?.fileListAO?.folderList ?? []
      const files = data?.fileListAO?.fileList ?? []
      const hit = files.find((file) => file.name === name)
      if (hit) return hit
      if (folders.length + files.length < PAGE_LIMIT) return null
    }
    return null
  }

  private async resolveFolderId(path: string): Promise<string> {
    const clean = driverPath(path)
    const root = this.rootId()
    if (clean === '/') return root
    let parent = root
    let prefix = ''
    for (const segment of clean.split('/').filter(Boolean)) {
      prefix = `${prefix}/${segment}`
      const cached = this.pathIds.get(prefix)
      if (cached) {
        parent = cached
        continue
      }
      const found = await this.findFolder(parent, segment)
      if (!found) throw DriverError.notFound(`Folder not found: ${segment}`)
      parent = found.id
      this.pathIds.set(prefix, parent)
    }
    return parent
  }

  private async resolveEntry(path: string): Promise<{ entry: DriverEntry; id: string; folder: boolean }> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is not a file')
    const name = driverFileName(clean)
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    const folder = await this.findFolder(parentId, name)
    if (folder) return { entry: folderEntry(folder), id: folder.id, folder: true }
    const file = await this.findFile(parentId, name)
    if (file) return { entry: fileEntry(file), id: file.id, folder: false }
    throw DriverError.notFound(`Not found: ${name}`)
  }

  private async downloadUrl(fileId: string): Promise<string> {
    const data = await this.api<{ downloadUrl?: string }>('/getFileDownloadUrl', {
      fileId,
      ...this.cloudPatch(),
    })
    let url = data?.downloadUrl ?? ''
    if (!url) throw DriverError.upstream('MoPan returned no download address')
    url = url.replace(/&amp;/g, '&').replace(/^http:/, 'https:')
    return url
  }

  private async resolveDownloadRedirect(url: string): Promise<string> {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    })
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (response.status >= 300 && response.status < 400 && location) return location
    return url
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const folderId = await this.resolveFolderId(clean)
    const pageSize = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? PAGE_LIMIT))

    if (options.search) {
      const collected = await collectPages(async ({ page }) => {
        const data = await this.queryPage(folderId, page)
        const folders = data?.fileListAO?.folderList ?? []
        const files = data?.fileListAO?.fileList ?? []
        return {
          items: [...folders.map(folderEntry), ...files.map(fileEntry)],
          next: folders.length + files.length < PAGE_LIMIT ? null : String(page + 1),
        }
      }, { maxPages: MAX_LIST_PAGES })
      const needle = options.search.toLocaleLowerCase()
      const filtered = collected.items.filter((entry) => entry.name.toLocaleLowerCase().includes(needle))
      const page = Math.max(1, options.page ?? 1)
      const entries = filtered.slice((page - 1) * pageSize, page * pageSize)
      return {
        entries,
        cursor: page * pageSize < filtered.length ? String(page + 1) : null,
        truncated: page * pageSize < filtered.length || collected.truncated,
      }
    }

    if (options.page !== undefined) {
      const page = Math.max(1, options.page)
      const data = await this.queryPage(folderId, page)
      const folders = data?.fileListAO?.folderList ?? []
      const files = data?.fileListAO?.fileList ?? []
      const hasMore = folders.length + files.length >= pageSize
      return {
        entries: [...folders.map(folderEntry), ...files.map(fileEntry)],
        cursor: hasMore ? String(page + 1) : null,
        truncated: hasMore,
      }
    }

    const collected = await collectPages(async ({ page }) => {
      const data = await this.queryPage(folderId, page)
      const folders = data?.fileListAO?.folderList ?? []
      const files = data?.fileListAO?.fileList ?? []
      return {
        items: [...folders.map(folderEntry), ...files.map(fileEntry)],
        next: folders.length + files.length < pageSize ? null : String(page + 1),
      }
    }, { maxPages: MAX_LIST_PAGES })
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
        ref: this.rootId(),
        mime: 'application/octet-stream',
      }
    }
    const resolved = await this.resolveEntry(clean)
    return resolved.entry
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const resolved = await this.resolveEntry(clean)
    if (resolved.folder) throw DriverError.unsupported('A folder cannot be read as a file')
    const link = await this.downloadUrl(resolved.id)
    const response = await fetch(link, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
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
    return await this.resolveDownloadRedirect(await this.downloadUrl(resolved.id))
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const name = driverFileName(clean)
    if (!name) throw DriverError.invalid('An upload needs a file name')
    const parentId = await this.resolveFolderId(driverParentPath(clean))

    const init = await this.api<MoPanInitUpload>('/initMultiUpload', {
      fileMd5: md5Hex(bytes),
      fileName: name,
      fileSize: bytes.byteLength,
      parentFolderId: parentId,
      ...this.cloudPatch(),
    })
    if (!init) throw DriverError.upstream('MoPan did not open an upload session')
    if (init.fileDataExists) {
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
      return
    }
    if (!init.uploadFileID || !init.partInfos?.length) {
      throw DriverError.upstream('MoPan returned an incomplete upload session')
    }

    const urls = await this.api<MoPanUploadPart[]>('/getAllMultiUploadUrls', {
      uploadFileId: init.uploadFileID,
      partInfos: init.partInfos,
    })
    const byPart = new Map<number, string>()
    for (const part of urls ?? []) byPart.set(Number(part.partNumber), part.uploadUrl)

    const partSize = Number(init.partSize) > 0 ? Number(init.partSize) : DEFAULT_PART_SIZE
    await uploadInParts({
      size: bytes.byteLength,
      partSize,
      concurrency: this.uploadThreads(),
      uploadPart: async (partNumber, start, end) => {
        const url = byPart.get(partNumber)
        if (!url) throw DriverError.upstream(`MoPan returned no upload address for part ${partNumber}`)
        const response = await fetch(url, {
          method: 'PUT',
          body: bytes.subarray(start, end),
          headers: { 'Content-Length': String(end - start) },
          signal: AbortSignal.timeout(60_000),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw DriverError.upstream(`MoPan upload part ${partNumber} failed (HTTP ${response.status})`)
        }
        options.onProgress?.(end, bytes.byteLength)
      },
      complete: async () => {
        await this.api('/commitMultiUploadFile', { uploadFileId: init.uploadFileID })
      },
    })
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    const parentId = await this.resolveFolderId(driverParentPath(clean))
    await this.api('/createFolder', {
      name: driverFileName(clean),
      parentId,
      ...this.cloudPatch(),
    })
    this.pathIds.clear()
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const name = newName.trim()
    const problem = cloudDriveNameProblem(name)
    if (problem) throw DriverError.invalid(problem)
    const resolved = await this.resolveEntry(clean)
    if (resolved.folder) {
      await this.api('/renameFolder', { folderId: resolved.id, newName: name, ...this.cloudPatch() })
    } else {
      await this.api('/renameFile', { fileId: resolved.id, newName: name, ...this.cloudPatch() })
    }
    this.pathIds.clear()
  }

  private async performBatchTask(
    id: string,
    folder: boolean,
    fileName: string,
    targetFolderId: string,
    taskType: number,
  ): Promise<void> {
    const cloudId = this.cloudId()
    const task = await this.api<MoPanBatchTask>('/addBatchTask', {
      userOrCloudID: cloudId || this.userId,
      source: cloudId ? 2 : 1,
      taskType,
      targetSource: cloudId ? 2 : 1,
      targetUserOrCloudID: cloudId || this.userId,
      targetType: 1,
      targetFolderID: targetFolderId,
      taskStatusDetailDTOList: [{ fileID: id, isFolder: folder, fileName }],
    })
    const taskId = task?.taskIDList?.[0]
    if (!taskId) throw DriverError.upstream('MoPan accepted the task but returned no task id')

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const status = await this.api<MoPanTaskStatus>('/checkBatchTask', {
        taskId,
        taskType: task.taskType ?? taskType,
        targetType: 1,
        targetFolderID: task.targetFolderID ?? targetFolderId,
        targetSource: cloudId ? 2 : 1,
        targetUserOrCloudID: cloudId || this.userId,
      })
      if (status?.taskStatus === TASK_STATUS_CONFLICT) {
        await this.api('/cancelBatchTask', { taskId: status.taskID ?? taskId, taskType: task.taskType ?? taskType })
        throw DriverError.upstream('MoPan reported a file name conflict')
      }
      if (status?.taskStatus === TASK_STATUS_COMPLETED) {
        this.pathIds.clear()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw DriverError.upstream('MoPan did not finish the batch task in time')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === to) return
    const resolved = await this.resolveEntry(from)
    const targetName = driverFileName(to)
    if (resolved.entry.name !== targetName) await this.rename(from, targetName)
    const parentId = await this.resolveFolderId(driverParentPath(to))
    await this.performBatchTask(resolved.id, resolved.folder, targetName, parentId, TASK_MOVE)
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === to) return
    const resolved = await this.resolveEntry(from)
    const targetName = driverFileName(to)
    const parentId = await this.resolveFolderId(driverParentPath(to))
    await this.performBatchTask(resolved.id, resolved.folder, targetName, parentId, TASK_COPY)
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    const resolved = await this.resolveEntry(clean)
    await this.api('/deleteToRecycle', {
      files: [{ fileID: resolved.id, isFolder: resolved.folder, fileName: resolved.entry.name }],
      ...this.cloudPatch(),
    })
    this.pathIds.clear()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      const user = await this.rawApi<MoPanUser>('/getUserInfo', null)
      return { ok: true, message: `MoPan is reachable${user?.nickname ? ` · ${user.nickname}` : ''}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'MoPan is unavailable' }
    }
  }
}

export function createMopanDriver(ctx: DriverContext): MountDriver {
  return new MoPanDriver(ctx)
}
