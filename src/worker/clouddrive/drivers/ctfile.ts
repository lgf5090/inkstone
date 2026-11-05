/**
 * CtFile cloud drive driver.
 *
 * Ported from the reference implementation at `OpenList-Worker/src/backend/drivers/ctfile`: the
 * single POST-JSON OpenAPI surface, the `d`/`f` id-prefix fallback (400/404), the `start`-offset
 * file pagination with a hard page cap, and the `md5-size` checksum that turns an upload into an
 * instant-transfer hit all follow it.
 *
 * The open-api session is a long-lived token pasted from the CtFile console; a 401 means the owner
 * has to regenerate it, so the driver marks the storage for review instead of logging in again.
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
import {
  HttpDriverBase,
  collectPages,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const ROOT_FOLDER_ID = 'd0'
const DEFAULT_BASE_URL = 'https://rest.ctfile.com/v1'
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const MAX_LIST_PAGES = 500
const SESSION_EXPIRED_MSG =
  'The CtFile open-api session is expired. Regenerate it in the CtFile console (Open API login key management) and update the storage.'

interface CtFilePayload {
  code?: number
  message?: string
  results?: unknown
  [key: string]: unknown
}

interface CtFileFolderItem {
  key?: string
  folder_id?: string | number
  name?: string
  date?: number | string
}

interface CtFileFileItem {
  key?: string
  file_id?: string | number
  name?: string
  size?: number
  date?: number | string
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const

const MD5_K = (() => {
  const table = new Uint32Array(64)
  for (let index = 0; index < 64; index++) {
    table[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296) >>> 0
  }
  return table
})()

function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift))
}

/** A small pure-JS MD5; WebCrypto deliberately does not offer MD5 and the worker cannot rely on Node. */
function md5Hex(data: Uint8Array): string {
  const length = data.length
  const blockLength = (((length + 8) >>> 6) + 1) << 6
  const padded = new Uint8Array(blockLength)
  padded.set(data)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  const bitLength = BigInt(length) * 8n
  view.setUint32(blockLength - 8, Number(bitLength & 0xffffffffn), true)
  view.setUint32(blockLength - 4, Number((bitLength >> 32n) & 0xffffffffn), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const words = new Uint32Array(16)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4, true)
    }
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let index = 0; index < 64; index++) {
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
      const sum = (f + a + MD5_K[index]! + words[g]!) >>> 0
      a = d
      d = c
      c = b
      b = (b + rotateLeft(sum, MD5_SHIFTS[index]!)) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const wordHex = (word: number): string => {
    let text = ''
    for (let index = 0; index < 4; index++) {
      text += ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, '0')
    }
    return text
  }
  return `${wordHex(a0)}${wordHex(b0)}${wordHex(c0)}${wordHex(d0)}`
}

/** Strips the `d`/`f` prefix only when a digit follows it, so an alphabetic id survives untouched. */
function stripIdPrefix(id: string): string {
  return String(id || '').replace(/^([df])(?=\d)/, '')
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** CtFile dates are either unix seconds/milliseconds or `YYYY-MM-DD HH:mm:ss`. */
function dateToMillis(value?: number | string): number {
  if (value === undefined || value === null || value === '') return 0
  const raw = String(value).trim()
  if (/^\d+$/.test(raw)) {
    const number = Number(raw)
    if (number > 0) return number > 1e12 ? number : number * 1000
  }
  const parsed = new Date(raw.replace(' ', 'T'))
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime()
}

function folderEntry(folder: CtFileFolderItem): DriverEntry {
  return {
    name: String(folder.name ?? ''),
    kind: 'folder',
    size: 0,
    modifiedAt: dateToMillis(folder.date),
    ref: String(folder.key ?? folder.folder_id ?? ''),
  }
}

function fileEntry(file: CtFileFileItem): DriverEntry {
  const name = String(file.name ?? '')
  return {
    name,
    kind: 'file',
    size: Number(file.size ?? 0) || 0,
    modifiedAt: dateToMillis(file.date),
    ref: String(file.key ?? file.file_id ?? ''),
    mime: driverEntryMime(name),
  }
}

class CtFileDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('ctfile')!
  readonly capabilities = this.definition.capabilities

  private readonly folderKeys = new Map<string, string>()

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private session(): string {
    return (this.ctx.credentials.session ?? '').trim()
  }

  private baseUrl(): string {
    return (this.configText('baseUrl', DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  private userAgent(): string {
    return this.configText('userAgent', '').trim() || DEFAULT_USER_AGENT
  }

  private namespace(): string {
    return this.configText('cloudType', 'private').trim() === 'public' ? 'public' : 'private'
  }

  protected async login(_force: boolean): Promise<void> {
    const session = this.session()
    if (!session) {
      throw DriverError.auth(
        'CtFile needs an open-api session. Generate one in the CtFile console and store it as a credential.',
      )
    }
    const payload = await this.postRaw('/user/info/profile', {})
    const code = Number(payload.code)
    if (code === 401 || code === 403) {
      await this.ctx.markNeedsReauth(SESSION_EXPIRED_MSG)
      throw DriverError.auth(SESSION_EXPIRED_MSG)
    }
    if (payload.code !== undefined && code !== 200) {
      throw DriverError.upstream(`CtFile rejected the session (code=${code}): ${payload.message ?? 'unknown error'}`)
    }
  }

  /** One HTTP round trip; business failures are inspected by `call` so id-prefix fallback can run. */
  private async postRaw(path: string, body: Record<string, unknown>): Promise<CtFilePayload> {
    const session = this.session()
    if (!session) throw DriverError.auth(SESSION_EXPIRED_MSG)
    const response = await this.request(`${this.baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': this.userAgent(),
      },
      body: JSON.stringify({ ...body, session }),
    })
    const text = await response.text()
    try {
      return JSON.parse(text) as CtFilePayload
    } catch {
      throw DriverError.upstream(`CtFile returned a non-JSON body for ${path}`)
    }
  }

  private businessError(path: string, payload: CtFilePayload): DriverError {
    const code = Number(payload.code)
    const suffix = payload.message ? `: ${payload.message}` : ''
    if (code === 401 || code === 403) return DriverError.auth(SESSION_EXPIRED_MSG)
    if (code === 429) return DriverError.rateLimited(`CtFile is rate limiting requests${suffix}`)
    if (code === 404) return DriverError.notFound(`CtFile does not know that id${suffix}`)
    if (code === 400) return DriverError.invalid(`CtFile rejected the request${suffix}`)
    return DriverError.upstream(`CtFile ${path} failed (code=${code})${suffix}`)
  }

  private async call(path: string, body: Record<string, unknown>): Promise<CtFilePayload> {
    const payload = await this.postRaw(path, body)
    if (payload.code === undefined || Number(payload.code) === 200) return payload
    throw this.businessError(path, payload)
  }

  /**
   * The OpenAPI documentation and the deployed service disagree on whether `folder_id`/`file_id`
   * carry the `d`/`f` prefix, so the preferred shape is tried first and the other one on 400/404.
   */
  private async callWithId(
    path: string,
    idKey: string,
    idValue: string,
    body: Record<string, unknown>,
    prefer: 'raw' | 'stripped',
  ): Promise<CtFilePayload> {
    const stripped = stripIdPrefix(idValue)
    const primary = prefer === 'stripped' ? stripped : idValue
    const secondary = prefer === 'stripped' ? idValue : stripped
    const shapes = primary === secondary ? [primary] : [primary, secondary]
    let lastError: DriverError | null = null
    for (const shape of shapes) {
      try {
        return await this.call(path, { ...body, [idKey]: shape })
      } catch (error) {
        if (
          error instanceof DriverError &&
          (error.kind === 'not_found' || (error.kind === 'invalid' && /code=400/i.test(error.message)))
        ) {
          lastError = error
          continue
        }
        throw error
      }
    }
    throw lastError ?? DriverError.notFound('CtFile does not know that id')
  }

  /** `ids` is documented as a comma separated string but the service also accepts a JSON array. */
  private async callWithIds(
    path: string,
    ids: string[],
    body: Record<string, unknown>,
  ): Promise<CtFilePayload> {
    let lastError: DriverError | null = null
    for (const value of [ids.join(','), ids] as const) {
      try {
        return await this.call(path, { ...body, ids: value })
      } catch (error) {
        if (
          error instanceof DriverError &&
          (error.kind === 'not_found' ||
            error.kind === 'invalid' ||
            (error.kind === 'upstream' && /code=405/i.test(error.message)))
        ) {
          lastError = error
          continue
        }
        throw error
      }
    }
    throw lastError ?? DriverError.upstream('CtFile rejected the id list')
  }

  private async listFolders(folderId: string): Promise<CtFileFolderItem[]> {
    const payload = await this.call(`/${this.namespace()}/folder/list`, {
      folder_id: folderId || ROOT_FOLDER_ID,
      orderby: 'az',
    })
    const list = Array.isArray(payload.results) ? payload.results : []
    return list.map((item) => {
      const raw = item as Record<string, unknown>
      return {
        key: String(raw.key ?? raw.folder_id ?? ''),
        name: String(raw.name ?? ''),
        date: raw.date as number | string | undefined,
      }
    })
  }

  private async listFilePage(folderId: string, start: number): Promise<CtFileFileItem[]> {
    const payload = await this.call(`/${this.namespace()}/file/list`, {
      folder_id: folderId || ROOT_FOLDER_ID,
      start,
      orderby: 'az',
    })
    const list = Array.isArray(payload.results) ? payload.results : []
    return list.map((item) => {
      const raw = item as Record<string, unknown>
      return {
        key: String(raw.key ?? raw.file_id ?? ''),
        name: String(raw.name ?? ''),
        size: Number(raw.size ?? 0) || 0,
        date: raw.date as number | string | undefined,
      }
    })
  }

  /** Walks `file/list` with the `start` offset, capped at 500 upstream pages. */
  private async listAllFiles(folderId: string): Promise<{ files: CtFileFileItem[]; truncated: boolean }> {
    let previousFirst = ''
    const collected = await collectPages<CtFileFileItem>(async ({ cursor }) => {
      const start = Number(cursor ?? '0') || 0
      const files = await this.listFilePage(folderId, start)
      if (files.length === 0) return { items: [], next: null }
      const first = files[0]?.key ?? ''
      if (cursor !== null && first && first === previousFirst) return { items: [], next: null }
      previousFirst = first
      return { items: files, next: String(start + files.length) }
    }, { mode: 'cursor', maxPages: MAX_LIST_PAGES })
    return { files: collected.items, truncated: collected.truncated }
  }

  private async listAllEntries(folderId: string): Promise<{
    folders: CtFileFolderItem[]
    files: CtFileFileItem[]
    truncated: boolean
  }> {
    const [folders, fileResult] = await Promise.all([this.listFolders(folderId), this.listAllFiles(folderId)])
    return { folders, files: fileResult.files, truncated: fileResult.truncated }
  }

  private async resolveFolderKey(path: string): Promise<string> {
    const clean = driverPath(path)
    if (clean === '/') return ROOT_FOLDER_ID
    const segments = clean.split('/').filter(Boolean)
    let parent = ROOT_FOLDER_ID
    let prefix = ''
    let index = 0
    for (; index < segments.length; index++) {
      prefix = `${prefix}/${segments[index]}`
      const cached = this.folderKeys.get(prefix)
      if (!cached) break
      parent = cached
    }
    for (; index < segments.length; index++) {
      const segment = segments[index]!
      prefix = `${prefix}/${segment}`
      const decoded = decodeSegment(segment)
      const folders = await this.listFolders(parent)
      const match = folders.find((folder) => {
        const key = String(folder.key ?? '')
        return folder.name === segment || folder.name === decoded || key === segment || key === decoded
      })
      if (!match) throw DriverError.notFound(`CtFile folder not found: ${decoded}`)
      parent = String(match.key ?? '')
      if (!parent) throw DriverError.upstream('CtFile returned a folder without a key')
      this.folderKeys.set(prefix, parent)
    }
    return parent
  }

  private async resolveEntry(path: string): Promise<{
    folder: CtFileFolderItem | null
    file: CtFileFileItem | null
    parentKey: string
    path: string
  }> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.notFound('The root is a folder, not a file')
    const name = driverFileName(clean)
    const decoded = decodeSegment(name)
    const parentPath = driverParentPath(clean)
    const parentKey = await this.resolveFolderKey(parentPath)
    const folders = await this.listFolders(parentKey)
    const folder = folders.find((item) => {
      const key = String(item.key ?? '')
      return item.name === name || item.name === decoded || key === name || key === decoded
    }) ?? null
    if (folder) {
      this.folderKeys.set(clean, String(folder.key ?? ''))
      return { folder, file: null, parentKey, path: clean }
    }
    const { files } = await this.listAllFiles(parentKey)
    const file = files.find((item) => {
      const key = String(item.key ?? '')
      return item.name === name || item.name === decoded || key === name || key === decoded
    }) ?? null
    if (!file) throw DriverError.notFound(`CtFile entry not found: ${decoded}`)
    return { folder: null, file, parentKey, path: clean }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    driverPath(path)
    return await this.withAuth(async () => {
      const folderKey = await this.resolveFolderKey(path)
      const all = await this.listAllEntries(folderKey)
      const entries = [
        ...all.folders.map(folderEntry),
        ...all.files.map(fileEntry),
      ]
      if (options.page !== undefined) {
        const pageSize = Math.max(1, Math.min(500, options.pageSize ?? 100))
        const start = (Math.max(1, options.page) - 1) * pageSize
        const page = entries.slice(start, start + pageSize)
        const next = start + page.length
        const cursor = next < entries.length ? String(next) : null
        return { entries: page, cursor, truncated: cursor !== null }
      }
      return { entries, cursor: null, truncated: all.truncated }
    })
  }

  async stat(path: string): Promise<DriverEntry> {
    driverPath(path)
    return await this.withAuth(async () => {
      const clean = driverPath(path)
      if (clean === '/') {
        return { name: ROOT_FOLDER_ID, kind: 'folder', size: 0, modifiedAt: 0, ref: ROOT_FOLDER_ID }
      }
      const resolved = await this.resolveEntry(clean)
      return resolved.folder ? folderEntry(resolved.folder) : fileEntry(resolved.file!)
    })
  }

  private async downloadUrl(fileKey: string): Promise<string> {
    const payload = await this.callWithId(
      `/${this.namespace()}/file/fetch_url`,
      'file_id',
      fileKey,
      {},
      'stripped',
    )
    const url = String((payload as { download_url?: unknown }).download_url ?? '')
    if (!url) throw DriverError.upstream(`CtFile returned no download address: ${payload.message ?? 'empty'}`)
    return url
  }

  async read(path: string, range?: string | null): Promise<Response> {
    driverPath(path)
    return await this.withAuth(async () => {
      const resolved = await this.resolveEntry(path)
      if (resolved.folder) throw DriverError.unsupported('A folder cannot be read as a file')
      const url = await this.downloadUrl(String(resolved.file!.key ?? ''))
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': this.userAgent(),
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined)
        throw DriverError.upstream(`CtFile download failed (HTTP ${response.status})`)
      }
      return response
    })
  }

  async directLink(path: string): Promise<string | null> {
    driverPath(path)
    return await this.withAuth(async () => {
      const resolved = await this.resolveEntry(path)
      if (resolved.folder) return null
      return await this.downloadUrl(String(resolved.file!.key ?? ''))
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
      const parentKey = await this.resolveFolderKey(driverParentPath(clean))
      const checksum = `${md5Hex(bytes)}-${bytes.byteLength}`

      const ticket = await this.call(`/${this.namespace()}/file/upload`, {
        folder_id: parentKey,
        checksum,
        size: bytes.byteLength,
        name,
      })
      if (Number(ticket.exists ?? 0) > 0) {
        options.onProgress?.(bytes.byteLength, bytes.byteLength)
        return
      }
      const uploadUrl = String((ticket as { upload_url?: unknown }).upload_url ?? '')
      if (!uploadUrl) throw DriverError.upstream('CtFile did not return an upload address')

      const form = new FormData()
      form.append('name', name)
      form.append('filesize', String(bytes.byteLength))
      form.append('file', new Blob([new Uint8Array(bytes)]), name)
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'User-Agent': this.userAgent() },
        body: form,
        signal: AbortSignal.timeout(120_000),
      })
      const text = await response.text()
      let payload: CtFilePayload
      try {
        payload = JSON.parse(text) as CtFilePayload
      } catch {
        throw DriverError.upstream(`CtFile upload returned a non-JSON body (HTTP ${response.status})`)
      }
      if (Number(payload.code) !== 200) {
        throw DriverError.upstream(
          `CtFile upload failed (code=${payload.code}): ${payload.message ?? text.slice(0, 200)}`,
        )
      }
      options.onProgress?.(bytes.byteLength, bytes.byteLength)
    })
  }

  async mkdir(path: string): Promise<void> {
    driverPath(path)
    return await this.withAuth(async () => {
      const clean = driverPath(path)
      if (clean === '/') return
      const name = driverFileName(clean)
      const parentKey = await this.resolveFolderKey(driverParentPath(clean))
      const payload = await this.postRaw(`/${this.namespace()}/folder/create`, {
        name,
        folder_id: parentKey,
        description: '',
        is_hidden: false,
      })
      const code = Number(payload.code)
      if (code === 200 || payload.code === undefined) {
        this.folderKeys.delete(clean)
        return
      }
      // A duplicate name answers 403 with the existing folder id; that is a successful mkdir.
      if (code === 403 && payload.folder_id) return
      throw this.businessError(`/${this.namespace()}/folder/create`, payload)
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    driverPath(path)
    if (!newName || newName === '.' || newName === '..' || newName.includes('/')) {
      throw DriverError.invalid('The new name is invalid')
    }
    return await this.withAuth(async () => {
      const clean = driverPath(path)
      if (clean === '/') throw DriverError.invalid('The root cannot be renamed')
      if (!newName || newName === '.' || newName === '..' || newName.includes('/')) {
        throw DriverError.invalid('The new name is invalid')
      }
      const resolved = await this.resolveEntry(clean)
      const key = String((resolved.folder ?? resolved.file)!.key ?? '')
      if (resolved.folder) {
        await this.callWithId(
          `/${this.namespace()}/folder/modify_meta`,
          'folder_id',
          key,
          { name: newName, is_rename: true },
          'raw',
        )
        this.folderKeys.clear()
        return
      }
      await this.callWithId(
        `/${this.namespace()}/file/modify_meta`,
        'file_id',
        key,
        { name: newName },
        'stripped',
      )
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    driverPath(fromPath)
    driverPath(toPath)
    return await this.withAuth(async () => {
      const resolved = await this.resolveEntry(fromPath)
      const key = String((resolved.folder ?? resolved.file)!.key ?? '')
      const target = driverPath(toPath)
      if (target === '/') throw DriverError.invalid('A destination entry name is required')
      const targetName = driverFileName(target)
      const currentName = String((resolved.folder ?? resolved.file)!.name ?? '')
      if (targetName !== currentName) await this.rename(fromPath, targetName)
      const targetFolder = await this.resolveFolderKey(driverParentPath(target))
      await this.callWithIds(`/${this.namespace()}/file/move`, [key], { folder_id: targetFolder })
      this.folderKeys.delete(driverPath(fromPath))
      this.folderKeys.delete(target)
    })
  }

  async remove(path: string): Promise<void> {
    driverPath(path)
    return await this.withAuth(async () => {
      const resolved = await this.resolveEntry(path)
      const key = String((resolved.folder ?? resolved.file)!.key ?? '')
      await this.callWithIds(`/${this.namespace()}/file/delete`, [key], {})
      this.folderKeys.delete(driverPath(path))
      if (resolved.folder) this.folderKeys.clear()
    })
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      return { ok: true, message: 'CtFile is reachable and the open-api session is accepted' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'CtFile is unavailable' }
    }
  }
}

export function createCtfileDriver(ctx: DriverContext): MountDriver {
  return new CtFileDriver(ctx)
}
