/**
 * ChaoXing group cloud drive driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/chaoxing`: the AES-CBC `fanyalogin` password
 * login, the `getResourceList` folder/file split, the `pan-yz.chaoxing.com` multipart upload with a
 * short-lived token, and the `noteyd.chaoxing.com` download-link endpoint all follow it.
 *
 * Authentication is two-factor in practice: the group (`bbsId`) plus either a pasted cookie or the
 * account/password pair. When the cookie is rejected the base re-runs `login(true)`, which falls
 * back to the password login if one is configured and otherwise marks the storage for review.
 */
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
import { cookieHeader, mergeResponseCookies } from './cookies'
import {
  HttpDriverBase,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const GROUP_API = 'https://groupweb.chaoxing.com'
const DOWNLOAD_API = 'https://noteyd.chaoxing.com'
const PASSPORT_API = 'https://passport2.chaoxing.com'
const UPLOAD_API = 'https://pan-yz.chaoxing.com'
const REFERER = 'https://chaoxing.com/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch'
const LOGIN_KEY = 'u2oh6Vu^HWe4_AES'

interface ChaoXingContent {
  folderName?: string
  name?: string
  fileId?: string
  objectId?: string
  size?: number | string
  uploadDate?: number
  download?: string
  url?: string
}

interface ChaoXingRawFile {
  id: number
  inserttime?: number
  content: ChaoXingContent
}

interface ChaoXingListResponse {
  msg?: string
  result?: number
  status?: boolean
  list?: ChaoXingRawFile[]
}

interface ChaoXingItem {
  id: string
  name: string
  isFolder: boolean
  size: number
  modifiedAt: number
  fileId: string
  download?: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** The login fields are AES-128-CBC with the key itself as IV, PKCS#7 applied by WebCrypto. */
async function encryptLoginField(value: string): Promise<string> {
  const key = new TextEncoder().encode(LOGIN_KEY)
  const cipher = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt'])
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: key },
    cipher,
    new TextEncoder().encode(value),
  )
  return bytesToBase64(new Uint8Array(encrypted))
}

function toItem(raw: ChaoXingRawFile): ChaoXingItem {
  const content = raw.content ?? {}
  if (content.folderName) {
    return {
      id: String(raw.id),
      name: content.folderName,
      isFolder: true,
      size: 0,
      modifiedAt: Number(raw.inserttime) || 0,
      fileId: '',
    }
  }
  const fileId = String(content.fileId || content.objectId || '')
  return {
    id: String(raw.id),
    name: String(content.name ?? ''),
    isFolder: false,
    size: Number(content.size) || 0,
    modifiedAt: Number(content.uploadDate) || 0,
    fileId,
    download: content.download || content.url || undefined,
  }
}

function itemEntry(item: ChaoXingItem): DriverEntry {
  return {
    name: item.name,
    kind: item.isFolder ? 'folder' : 'file',
    size: item.isFolder ? 0 : item.size,
    modifiedAt: item.modifiedAt,
    ref: item.isFolder ? item.id : `${item.id}$${item.fileId}`,
    mime: item.isFolder ? 'application/octet-stream' : driverEntryMime(item.name),
  }
}

function isAuthMessage(message: string | undefined): boolean {
  if (!message) return false
  return /\u767b\u5f55|login|\u91cd\u65b0\u767b\u5f55|\u8bf7\u5148\u767b\u5f55|session/i.test(message)
}

class ChaoXingDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('chaoxing')!
  readonly capabilities = this.definition.capabilities

  private cookie = ''
  private readonly pathIds = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private bbsId(): string {
    return this.configText('bbsId', '').trim()
  }

  private rootFolderId(): string {
    return this.configText('rootFolderId', '').trim() || '-1'
  }

  protected async login(force: boolean): Promise<void> {
    if (!this.bbsId()) throw DriverError.invalid('Chaoxing needs a group id (bbsId).')
    const stored = (this.ctx.credentials.cookie ?? '').trim()
    const userName = this.configText('userName', '').trim()
    const password = (this.ctx.credentials.password ?? '').trim()
    if (!force && stored) {
      this.cookie = stored
      return
    }
    if (userName && password) {
      await this.signIn(userName, password)
      return
    }
    if (stored) {
      this.cookie = stored
      return
    }
    throw DriverError.auth('Chaoxing needs a cookie, or a userName and password so it can sign in again.')
  }

  private async signIn(userName: string, password: string): Promise<void> {
    const form = new FormData()
    form.append('uname', await encryptLoginField(userName))
    form.append('password', await encryptLoginField(password))
    form.append('t', 'true')
    const response = await this.request(`${PASSPORT_API}/fanyalogin`, {
      method: 'POST',
      headers: { Referer: REFERER, 'User-Agent': USER_AGENT },
      body: form,
    })
    const jar = mergeResponseCookies({}, response)
    const cookie = cookieHeader(jar)
    await response.body?.cancel().catch(() => undefined)
    if (!cookie) {
      throw DriverError.auth('Chaoxing sign-in returned no cookie; check the account and password.')
    }
    this.cookie = cookie
    await this.saveCredential({ cookie })
  }

  private async api(
    path: string,
    query: Record<string, string>,
    extraHeaders: Record<string, string> = {},
  ): Promise<ChaoXingListResponse> {
    const url = `${GROUP_API}${path}?${new URLSearchParams(query).toString()}`
    const response = await this.request(url, {
      headers: {
        Cookie: this.cookie,
        Accept: 'application/json, text/plain, */*',
        Referer: REFERER,
        'User-Agent': USER_AGENT,
        ...extraHeaders,
      },
    })
    const text = await response.text()
    let payload: ChaoXingListResponse
    try {
      payload = JSON.parse(text) as ChaoXingListResponse
    } catch {
      throw DriverError.upstream(`Chaoxing answered a non-JSON body for ${path}`)
    }
    if (isAuthMessage(payload.msg)) throw DriverError.auth(payload.msg ?? 'Chaoxing needs a new login')
    return payload
  }

  private async resource(parentId: string, recType: '1' | '2', offset: number): Promise<ChaoXingRawFile[]> {
    const payload = await this.api('/pc/resource/getResourceList', {
      bbsid: this.bbsId(),
      folderId: parentId,
      recType,
      offset: String(offset),
    })
    if (Number(payload.result) !== 1) {
      throw DriverError.upstream(payload.msg || `Chaoxing rejected the list request (result=${payload.result})`)
    }
    return Array.isArray(payload.list) ? payload.list : []
  }

  private async folders(parentId: string, offset = 0): Promise<ChaoXingItem[]> {
    const list = await this.resource(parentId, '1', offset)
    return list.map(toItem)
  }

  private async files(parentId: string, offset = 0): Promise<ChaoXingItem[]> {
    const list = await this.resource(parentId, '2', offset)
    return list.map((raw) => {
      const content = raw.content ?? {}
      // Mobile uploads omit `fileId`; `objectId` is the same value.
      if (!content.fileId && content.objectId) content.fileId = content.objectId
      return toItem(raw)
    })
  }

  private async allItems(parentId: string): Promise<ChaoXingItem[]> {
    const items = [...await this.folders(parentId), ...await this.files(parentId)]
    return items
  }

  private async pathToId(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return this.rootFolderId()
    const segments = clean.split('/').filter(Boolean)
    let parentId = this.rootFolderId()
    let prefix = ''
    let index = 0
    for (; index < segments.length; index++) {
      prefix = `${prefix}/${segments[index]}`
      const cached = this.pathIds.get(prefix)
      if (!cached) break
      parentId = cached
    }
    for (; index < segments.length; index++) {
      const segment = segments[index]!
      prefix = `${prefix}/${segment}`
      const folders = await this.folders(parentId)
      const folder = folders.find((item) => item.name === segment)
      if (!folder) throw DriverError.notFound(`Chaoxing folder not found: ${segment}`)
      parentId = folder.id
      this.pathIds.set(prefix, parentId)
    }
    return parentId
  }

  private async resolveEntry(path: string): Promise<ChaoXingItem> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is a folder, not a file')
    const name = driverFileName(clean)
    const parentId = await this.pathToId(driverParentPath(clean))
    const folders = await this.folders(parentId)
    const folder = folders.find((item) => item.name === name)
    if (folder) {
      this.pathIds.set(clean, folder.id)
      return folder
    }
    const files = await this.files(parentId)
    const file = files.find((item) => item.name === name)
    if (!file) throw DriverError.notFound(`Chaoxing entry not found: ${name}`)
    return file
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    driverPath(path)
    return await this.withAuth(async () => {
      const parentId = await this.pathToId(path)
      if (options.page !== undefined) {
        const pageSize = Math.max(1, options.pageSize ?? 100)
        const offset = (Math.max(1, options.page) - 1) * pageSize
        const items = await this.allItemsAtOffset(parentId, offset)
        const entries = items.slice(0, pageSize).map(itemEntry)
        const next = items.length > pageSize ? String(offset + pageSize) : null
        return { entries, cursor: next, truncated: next !== null }
      }
      const items = await this.allItems(parentId)
      return { entries: items.map(itemEntry), cursor: null, truncated: false }
    })
  }

  /** Both resource kinds share the offset; the page is sliced after the two calls are merged. */
  private async allItemsAtOffset(parentId: string, offset: number): Promise<ChaoXingItem[]> {
    if (offset === 0) return await this.allItems(parentId)
    return [...await this.folders(parentId, offset), ...await this.files(parentId, offset)]
  }

  async stat(path: string): Promise<DriverEntry> {
    driverPath(path)
    return await this.withAuth(async () => {
      const clean = driverPath(path)
      if (clean === '/') {
        return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: this.rootFolderId() }
      }
      return itemEntry(await this.resolveEntry(clean))
    })
  }

  private async downloadLink(fileId: string): Promise<string> {
    const url = `${DOWNLOAD_API}/screen/note_note/files/status/${fileId}`
    const response = await this.request(url, {
      method: 'POST',
      headers: {
        Cookie: this.cookie,
        Accept: 'application/json, text/plain, */*',
        Referer: REFERER,
        'User-Agent': USER_AGENT,
      },
    })
    const text = await response.text()
    let payload: { download?: string; msg?: string; status?: boolean }
    try {
      payload = JSON.parse(text) as { download?: string; msg?: string; status?: boolean }
    } catch {
      throw DriverError.upstream('Chaoxing answered a non-JSON body for the download link')
    }
    if (isAuthMessage(payload.msg)) throw DriverError.auth(payload.msg ?? 'Chaoxing needs a new login')
    if (!payload.download) {
      throw DriverError.upstream(`Chaoxing returned no download address: ${payload.msg ?? 'empty'}`)
    }
    return payload.download
  }

  async read(path: string, range?: string | null): Promise<Response> {
    driverPath(path)
    return await this.withAuth(async () => {
      const item = await this.resolveEntry(path)
      if (item.isFolder) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = item.download || await this.downloadLink(item.fileId)
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Cookie: this.cookie,
          Referer: REFERER,
          'User-Agent': USER_AGENT,
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`Chaoxing download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    driverPath(path)
    return await this.withAuth(async () => {
      const item = await this.resolveEntry(path)
      if (item.isFolder) return null
      return item.download || await this.downloadLink(item.fileId)
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    driverPath(path)
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) {
      throw DriverError.invalid('The upload body does not match the declared size')
    }
    return await this.withAuth(async () => {
      const clean = driverPath(path)
      if (clean === '/') throw DriverError.invalid('A file name is required')
      const name = driverFileName(clean)
      const parentId = await this.pathToId(driverParentPath(clean))

      const configResponse = await this.request(`${DOWNLOAD_API}/pc/files/getUploadConfig`, {
        headers: { Cookie: this.cookie, Referer: REFERER, 'User-Agent': USER_AGENT },
      })
      const configText = await configResponse.text()
      let config: { result?: number; msg?: { token?: string; puid?: number } }
      try {
        config = JSON.parse(configText) as { result?: number; msg?: { token?: string; puid?: number } }
      } catch {
        throw DriverError.upstream('Chaoxing answered a non-JSON body for the upload config')
      }
      const token = config.msg?.token ?? ''
      if (Number(config.result) !== 1 || !token) {
        throw DriverError.upstream('Chaoxing did not hand back an upload token')
      }

      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(bytes)]), name)
      form.append('_token', token)
      form.append('puid', String(config.msg?.puid ?? ''))
      const uploadResponse = await fetch(`${UPLOAD_API}/upload`, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT },
        body: form,
        signal: AbortSignal.timeout(120_000),
      })
      const uploadText = await uploadResponse.text()
      let uploadPayload: { msg?: string; objectId?: string; data?: Record<string, unknown> }
      try {
        uploadPayload = JSON.parse(uploadText) as { msg?: string; objectId?: string; data?: Record<string, unknown> }
      } catch {
        throw DriverError.upstream(`Chaoxing upload returned a non-JSON body (HTTP ${uploadResponse.status})`)
      }
      if (uploadPayload.msg !== 'success' || !uploadPayload.objectId) {
        throw DriverError.upstream(`Chaoxing upload failed: ${uploadPayload.msg ?? 'no object id'}`)
      }

      const params = encodeURIComponent(`[${JSON.stringify({
        cataid: '100000019',
        key: uploadPayload.objectId,
        param: uploadPayload.data ?? {},
      })}]`)
      const registered = await this.api('/pc/resource/addResource', {
        bbsid: this.bbsId(),
        pid: parentId,
        type: 'yunpan',
        params,
      })
      if (Number(registered.result) !== 1) {
        throw DriverError.upstream(`Chaoxing could not register the uploaded file: ${registered.msg ?? ''}`)
      }
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
    })
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    return await this.withAuth(async () => {
      const clean = driverPath(path)
      if (clean === '/') throw DriverError.invalid('A folder name is required')
      const name = driverFileName(clean)
      const parentId = await this.pathToId(driverParentPath(clean))
      const payload = await this.api('/pc/resource/addResourceFolder', {
        bbsid: this.bbsId(),
        name,
        pid: parentId,
      })
      if (Number(payload.result) !== 1) {
        throw DriverError.upstream(`Chaoxing could not create the folder: ${payload.msg ?? ''}`)
      }
      this.pathIds.clear()
    })
  }

  async rename(path: string, _newName: string): Promise<void> {
    driverPath(path)
    throw DriverError.unsupported('Chaoxing does not support renaming entries.')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    return await this.withAuth(async () => {
      const item = await this.resolveEntry(fromPath)
      const target = driverPath(toPath)
      if (target === '/') throw DriverError.invalid('A destination folder is required')
      const targetId = await this.pathToId(driverParentPath(target))
      const payload = item.isFolder
        ? await this.api('/pc/resource/moveResource', { bbsid: this.bbsId(), folderIds: item.id, targetId })
        : await this.api('/pc/resource/moveResource', { bbsid: this.bbsId(), recIds: item.id, targetId })
      if (payload.status !== true) {
        throw DriverError.upstream(`Chaoxing could not move the entry: ${payload.msg ?? ''}`)
      }
      this.pathIds.clear()
    })
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    return await this.withAuth(async () => {
      const item = await this.resolveEntry(path)
      const payload = item.isFolder
        ? await this.api('/pc/resource/deleteResourceFolder', { bbsid: this.bbsId(), folderIds: item.id })
        : await this.api('/pc/resource/deleteResourceFile', { bbsid: this.bbsId(), recIds: item.id })
      if (Number(payload.result) !== 1) {
        throw DriverError.upstream(`Chaoxing could not delete the entry: ${payload.msg ?? ''}`)
      }
      this.pathIds.clear()
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      await this.folders(this.rootFolderId())
      return { ok: true, message: 'Chaoxing is reachable and the group is readable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Chaoxing is unavailable' }
    }
  }
}

export function createChaoxingDriver(ctx: DriverContext): MountDriver {
  return new ChaoXingDriver(ctx)
}
