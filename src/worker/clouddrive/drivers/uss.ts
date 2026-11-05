/**
 * Upyun USS driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/uss`: requests go to `v0.api.upyun.com` and are
 * authenticated with the Upyun HMAC-SHA1 signature (`UPYUN <operator>:<signature>`). The listing
 * endpoint is paginated with the `x-list-iter` / `x-list-limit` headers, and MOVE/COPY are real
 * Upyun operations (they only apply to files, matching the upstream API).
 */
import { createHash, createHmac } from 'node:crypto'
import { findCloudDriveDriver, type CloudDriveDriverDefinition } from '@shared/clouddrive/drivers'
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
  driverFileName,
  driverPath,
  type HttpOptions,
} from './http'

const API_BASE = 'https://v0.api.upyun.com'
const DEFAULT_PAGE_SIZE = 1000
const MAX_LIST_PAGES = 50
const MAX_ITER_LIMIT = 10_000

interface ParsedListing {
  entries: DriverEntry[]
  next: string | null
}

function normalizeRootPath(raw: string): string {
  const value = (raw || '/').trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return value ? `/${value}` : '/'
}

function encodeKey(key: string): string {
  return key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function md5Hex(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function parseModified(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return numeric * 1000
    return Date.parse(value) || 0
  }
  return 0
}

function entryFromRecord(record: Record<string, unknown>): DriverEntry | null {
  const raw = String(record.name ?? record.file_name ?? '').trim()
  if (!raw) return null
  const folder = record.type === 'F'
    || record.is_dir === true
    || raw.endsWith('/')
  const name = driverFileName(raw.replace(/\/+$/, ''))
  if (!name) return null
  return {
    name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(record.length ?? record.size ?? record.file_size ?? 0) || 0,
    modifiedAt: parseModified(record.last_modified ?? record.modified ?? 0),
    mime: folder ? 'application/octet-stream' : driverEntryMime(name),
  }
}

function parseListingResponse(text: string): ParsedListing {
  const entries: DriverEntry[] = []
  try {
    const parsed = JSON.parse(text) as unknown
    const records = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { files?: unknown }).files)
        ? (parsed as { files: unknown[] }).files
        : null
    if (records) {
      for (const record of records) {
        if (!record || typeof record !== 'object') continue
        const entry = entryFromRecord(record as Record<string, unknown>)
        if (entry) entries.push(entry)
      }
      return { entries, next: null }
    }
  } catch {
    // The text form below is what older Upyun endpoints return.
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    const entry = entryFromRecord({
      name: parts[0],
      type: parts[1],
      size: parts[2],
      last_modified: parts[3],
    })
    if (entry) entries.push(entry)
  }
  return { entries, next: null }
}

export class UssDriver extends HttpDriverBase implements MountDriver {
  readonly definition: CloudDriveDriverDefinition
  readonly capabilities: CloudDriveDriverDefinition['capabilities']

  constructor(ctx: DriverContext) {
    super(ctx)
    this.definition = findCloudDriveDriver('uss')!
    this.capabilities = this.definition.capabilities
  }

  private bucket(): string {
    return this.configText('bucket').trim().replace(/^\/+|\/+$/g, '')
  }

  private downloadHost(): string {
    const raw = this.configText('endpoint').trim()
    if (!raw) return ''
    return raw.startsWith('http://') || raw.startsWith('https://')
      ? raw.replace(/\/+$/, '')
      : `https://${raw.replace(/\/+$/, '')}`
  }

  private operatorName(): string {
    return this.configText('operatorName').trim()
  }

  private operatorPassword(): string {
    return this.ctx.credentials.operatorPassword ?? ''
  }

  private rootPrefix(): string {
    return normalizeRootPath(this.configText('rootPath', '/'))
  }

  private token(): string {
    return this.configText('antiTheftChainToken').trim() || this.operatorPassword()
  }

  protected async login(): Promise<void> {
    if (!this.bucket()) throw DriverError.auth('Upyun USS needs a bucket')
    if (!this.operatorName() || !this.operatorPassword()) {
      throw DriverError.auth('Upyun USS needs an operator name and password')
    }
  }

  private rootKey(): string {
    const root = this.rootPrefix()
    return root === '/' ? '' : root.slice(1)
  }

  private objectKey(path: string, directory = false): string {
    const clean = driverPath(path)
    const relative = clean === '/' ? '' : clean.slice(1)
    let key = [this.rootKey(), relative].filter(Boolean).join('/')
    if (directory && key && !key.endsWith('/')) key += '/'
    return key
  }

  private apiUrl(key: string): string {
    return `${API_BASE}/${encodeKey(this.bucket())}/${encodeKey(key)}`
  }

  private signedHeaders(method: string, key: string, bodyMd5 = ''): Record<string, string> {
    const uri = new URL(this.apiUrl(key)).pathname
    const date = new Date().toUTCString()
    const password = md5Hex(this.operatorPassword())
    const value = bodyMd5 ? `${method}&${uri}&${date}&${bodyMd5}` : `${method}&${uri}&${date}`
    const signature = createHmac('sha1', password).update(value).digest('base64')
    return {
      Authorization: `UPYUN ${this.operatorName()}:${signature}`,
      Date: date,
      ...(bodyMd5 ? { 'Content-MD5': bodyMd5 } : {}),
    }
  }

  private async call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    options: {
      body?: Uint8Array
      headers?: Record<string, string>
      contentType?: string
    } = {},
  ): Promise<Response> {
    const headers = {
      ...this.signedHeaders(method, key, options.body ? md5OfBytes(options.body) : ''),
      ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
      ...(options.body ? { 'Content-Length': String(options.body.byteLength) } : {}),
      ...(options.headers ?? {}),
    }
    return await this.request(this.apiUrl(key), {
      method: method as unknown as HttpOptions['method'],
      headers,
      body: options.body,
    })
  }

  private async listPage(prefix: string, targetPage: number, pageSize: number): Promise<ParsedListing> {
    let iter: string | null = null
    for (let page = 1; page <= Math.max(1, targetPage); page++) {
      const headers: Record<string, string> = {
        ...this.signedHeaders('GET', prefix),
        Accept: 'application/json',
        'x-list-limit': String(pageSize),
        ...(iter ? { 'x-list-iter': iter } : {}),
      }
      const response = await this.request(this.apiUrl(prefix), { method: 'GET', headers })
      const parsed = parseListingResponse(await response.text())
      const next = response.headers.get('x-upyun-list-iter')
      parsed.next = next ? next : null
      if (page === targetPage) return parsed
      if (!parsed.next) return { entries: [], next: null }
      iter = parsed.next
    }
    return { entries: [], next: null }
  }

  private async collectListing(prefix: string, pageSize: number): Promise<{ entries: DriverEntry[]; truncated: boolean }> {
    const entries: DriverEntry[] = []
    let iter: string | null = null
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const headers: Record<string, string> = {
        ...this.signedHeaders('GET', prefix),
        Accept: 'application/json',
        'x-list-limit': String(pageSize),
        ...(iter ? { 'x-list-iter': iter } : {}),
      }
      const response = await this.request(this.apiUrl(prefix), { method: 'GET', headers })
      const parsed = parseListingResponse(await response.text())
      entries.push(...parsed.entries)
      const next = response.headers.get('x-upyun-list-iter')
      if (!next) return { entries, truncated: false }
      iter = next
    }
    return { entries, truncated: true }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    await this.authenticate()
    const prefix = this.objectKey(clean, true)
    const pageSize = Math.min(MAX_ITER_LIMIT, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE))
    if (options.page !== undefined) {
      const page = await this.listPage(prefix, Math.max(1, options.page), pageSize)
      return { entries: page.entries, cursor: page.next, truncated: page.next !== null }
    }
    const collected = await this.collectListing(prefix, pageSize)
    return { entries: collected.entries, cursor: null, truncated: collected.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '' }
    const key = this.objectKey(clean)
    const response = await this.call('HEAD', key)
    const type = response.headers.get('x-upyun-file-type') ?? ''
    const folder = type.toLowerCase() === 'folder'
    const name = driverFileName(clean)
    return {
      name,
      kind: folder ? 'folder' : 'file',
      size: folder ? 0 : Number.parseInt(response.headers.get('x-upyun-file-size') ?? '0', 10) || 0,
      modifiedAt: parseModified(response.headers.get('x-upyun-file-date') ?? ''),
      ref: key,
      mime: folder ? 'application/octet-stream' : driverEntryMime(name),
    }
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') throw DriverError.unsupported('A folder cannot be read as a file')
    return await this.call('GET', this.objectKey(clean), {
      headers: range ? { Range: range } : {},
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) {
      throw DriverError.invalid('The upload body does not match the declared size')
    }
    const key = this.objectKey(clean)
    const md5 = md5OfBytes(bytes)
    const headers: Record<string, string> = {
      ...this.signedHeaders('PUT', key, md5),
      'Content-Type': options.contentType || driverEntryMime(driverFileName(clean)),
      'Content-Length': String(bytes.byteLength),
    }
    await this.request(this.apiUrl(key), { method: 'PUT', headers, body: bytes })
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') return
    const key = this.objectKey(clean, true)
    await this.request(this.apiUrl(key), {
      method: 'POST',
      headers: { ...this.signedHeaders('POST', key), Folder: 'true' },
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const parent = clean.slice(0, clean.lastIndexOf('/')) || '/'
    const target = driverPath(`${parent === '/' ? '' : parent}/${newName}`)
    await this.authenticate()
    await this.moveOrCopy(this.objectKey(clean), this.objectKey(target), 'move')
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.authenticate()
    await this.moveOrCopy(this.objectKey(from), this.objectKey(to), 'move')
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.authenticate()
    await this.moveOrCopy(this.objectKey(from), this.objectKey(to), 'copy')
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') throw DriverError.unsupported('The mount root cannot be removed')
    const key = this.objectKey(clean)
    await this.request(this.apiUrl(key), {
      method: 'DELETE',
      headers: this.signedHeaders('DELETE', key),
    })
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') return null
    const host = this.downloadHost()
    if (!host) return null
    const key = this.objectKey(clean)
    const expire = Math.floor(Date.now() / 1000) + 4 * 3600
    const token = md5Hex(`${this.token()}&${expire}&/${key}`).slice(12, 20) + expire
    return `${host}/${encodeKey(key)}?_upd=${encodeURIComponent(driverFileName(clean))}&_upt=${token}`
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate()
      const prefix = this.objectKey('/', true)
      await this.request(this.apiUrl(prefix), {
        method: 'GET',
        headers: { ...this.signedHeaders('GET', prefix), 'x-list-limit': '1', Accept: 'application/json' },
      })
      return { ok: true, message: 'Upyun USS is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Upyun USS is unavailable' }
    }
  }

  private async moveOrCopy(source: string, target: string, operation: 'move' | 'copy'): Promise<void> {
    const header = operation === 'move' ? 'X-Upyun-Move-Source' : 'X-Upyun-Copy-Source'
    await this.request(this.apiUrl(target), {
      method: 'PUT',
      headers: {
        ...this.signedHeaders('PUT', target),
        [header]: `/${this.bucket()}/${source}`,
        'Content-Length': '0',
      },
    })
  }
}

function md5OfBytes(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

export function createUssDriver(ctx: DriverContext): MountDriver {
  return new UssDriver(ctx)
}
