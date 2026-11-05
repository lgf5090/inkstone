/**
 * Bunny Storage driver.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/bunny_storage`: a storage zone is addressed over
 * the Bunny Storage API (`storage.bunnycdn.com`) with the zone's `AccessKey`. Listing is one flat
 * `GET /<zone>/<path>/` request; directories are virtual and marked by a zero-byte placeholder.
 * MOVE/COPY are implemented by streaming the object from the storage endpoint to its destination.
 */
import { findCloudDriveDriver, type CloudDriveDriverDefinition } from '@shared/clouddrive/drivers'
import {
  DriverError,
  asBytes,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
} from './contract'
import {
  HttpDriverBase,
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'

const DEFAULT_ENDPOINT = 'https://storage.bunnycdn.com'
const PLACEHOLDER = '.openlist'

interface BunnyObject {
  ObjectName?: string
  Length?: number
  LastChanged?: string
  IsDirectory?: boolean
  Guid?: string
}

function normalizeRootPath(raw: string): string {
  const value = (raw || '/').trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return value ? `/${value}` : '/'
}

function encodeKey(key: string): string {
  return key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Bytes(value: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
}

function parseTime(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function objectEntry(item: BunnyObject): DriverEntry | null {
  const raw = String(item.ObjectName ?? '').trim()
  if (!raw) return null
  const folder = item.IsDirectory === true
  const name = driverFileName(raw.replace(/\/+$/, ''))
  if (!name) return null
  return {
    name,
    kind: folder ? 'folder' : 'file',
    size: folder ? 0 : Number(item.Length) || 0,
    modifiedAt: parseTime(item.LastChanged),
    ref: item.Guid || raw,
    mime: folder ? 'application/octet-stream' : driverEntryMime(name),
  }
}

export class BunnyStorageDriver extends HttpDriverBase implements MountDriver {
  readonly definition: CloudDriveDriverDefinition
  readonly capabilities: CloudDriveDriverDefinition['capabilities']

  constructor(ctx: DriverContext) {
    super(ctx)
    this.definition = findCloudDriveDriver('bunny_storage')!
    this.capabilities = this.definition.capabilities
  }

  private storageZone(): string {
    return this.configText('storageZoneName').trim().replace(/^\/+|\/+$/g, '')
  }

  private accessKey(): string {
    return this.ctx.credentials.accessKey ?? ''
  }

  private endpoint(): string {
    const raw = this.configText('endpoint').trim() || DEFAULT_ENDPOINT
    const withScheme = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
    return withScheme.replace(/\/+$/, '')
  }

  private cdnBaseUrl(): string {
    const raw = this.configText('cdnBaseUrl').trim()
    if (!raw) return ''
    return raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
  }

  private cdnTokenKey(): string {
    return this.configText('cdnTokenKey').trim() || (this.ctx.credentials.cdnTokenKey ?? '')
  }

  private rootPrefix(): string {
    return normalizeRootPath(this.configText('rootPath', '/'))
  }

  protected async login(): Promise<void> {
    if (!this.storageZone()) throw DriverError.auth('Bunny Storage needs a storage zone name')
    if (!this.accessKey()) throw DriverError.auth('Bunny Storage needs an access key')
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

  private storageUrl(key: string, directory = false): string {
    const url = new URL(this.endpoint())
    const base = url.pathname.replace(/\/+$/, '')
    url.pathname = `${base}/${this.storageZone()}/${encodeKey(key)}`
    if (directory && !url.pathname.endsWith('/')) url.pathname += '/'
    return url.toString()
  }

  private async send(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    options: {
      directory?: boolean
      body?: BodyInit
      headers?: Record<string, string>
    } = {},
  ): Promise<Response> {
    return await this.request(this.storageUrl(key, options.directory), {
      method,
      headers: { AccessKey: this.accessKey(), ...(options.headers ?? {}) },
      body: options.body,
    })
  }

  private async listDirectory(prefix: string): Promise<BunnyObject[]> {
    const response = await this.send('GET', prefix, { directory: true, headers: { Accept: 'application/json' } })
    const payload = await response.json() as unknown
    return Array.isArray(payload) ? payload as BunnyObject[] : []
  }

  private async lookup(path: string): Promise<BunnyObject | null> {
    const clean = driverPath(path)
    if (clean === '/') return null
    const name = driverFileName(clean)
    const parent = driverParentPath(clean)
    const items = await this.listDirectory(this.objectKey(parent, true))
    return items.find((item) => String(item.ObjectName ?? '') === name) ?? null
  }

  async list(path: string): Promise<DriverListResult> {
    const clean = driverPath(path)
    await this.authenticate()
    const prefix = this.objectKey(clean, true)
    const items = await this.listDirectory(prefix)
    const entries: DriverEntry[] = []
    for (const item of items) {
      if ((item.ObjectName ?? '') === PLACEHOLDER) continue
      const entry = objectEntry(item)
      if (entry) entries.push(entry)
    }
    return { entries, cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0, ref: '' }
    const item = await this.lookup(clean)
    if (!item) throw DriverError.notFound(`Object not found: ${clean}`)
    const entry = objectEntry(item)
    if (!entry) throw DriverError.notFound(`Object not found: ${clean}`)
    return entry
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') throw DriverError.unsupported('A folder cannot be read as a file')
    return await this.send('GET', this.objectKey(clean), {
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
    await this.send('PUT', this.objectKey(clean), {
      body: bytes,
      headers: {
        'Content-Type': options.contentType || driverEntryMime(driverFileName(clean)),
        'Content-Length': String(bytes.byteLength),
      },
    })
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') return
    const key = `${this.objectKey(clean)}/${PLACEHOLDER}`
    await this.send('PUT', key, {
      body: new Uint8Array(0),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' },
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const target = driverPath(`${driverParentPath(clean) === '/' ? '' : driverParentPath(clean)}/${newName}`)
    await this.authenticate()
    await this.moveObject(this.objectKey(clean), this.objectKey(target))
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.authenticate()
    await this.moveObject(this.objectKey(from), this.objectKey(to))
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    await this.authenticate()
    const item = await this.lookup(from)
    if (!item) throw DriverError.notFound(`Object not found: ${from}`)
    if (item.IsDirectory === true) throw DriverError.unsupported('Bunny Storage cannot copy a folder')
    await this.copyObject(this.objectKey(from), this.objectKey(to))
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') throw DriverError.unsupported('The mount root cannot be removed')
    await this.send('DELETE', this.objectKey(clean))
  }

  async directLink(path: string): Promise<string | null> {
    const clean = driverPath(path)
    await this.authenticate()
    if (clean === '/') return null
    const cdn = this.cdnBaseUrl()
    if (!cdn) return null
    const key = this.objectKey(clean)
    const url = new URL(cdn)
    const base = url.pathname.replace(/\/+$/, '')
    url.pathname = `${base}/${encodeKey(key)}`
    const tokenKey = this.cdnTokenKey()
    if (!tokenKey) return url.toString()
    const expires = Math.floor(Date.now() / 1000) + 4 * 3600
    const query = Array.from(url.searchParams.entries())
      .filter(([name]) => name !== 'token' && name !== 'expires')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('&')
    const signaturePath = decodeURIComponent(url.pathname)
    const signature = base64Url(await sha256Bytes(`${tokenKey}${signaturePath}${expires}${query}`))
    url.searchParams.set('token', signature)
    url.searchParams.set('expires', String(expires))
    return url.toString()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate()
      await this.send('GET', this.objectKey('/', true), { directory: true, headers: { Accept: 'application/json' } })
      return { ok: true, message: 'Bunny Storage is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Bunny Storage is unavailable' }
    }
  }

  private async copyObject(source: string, target: string): Promise<void> {
    const upstream = await this.send('GET', source)
    const contentType = upstream.headers.get('content-type')
    const contentLength = upstream.headers.get('content-length')
    await this.send('PUT', target, {
      body: upstream.body ?? undefined,
      headers: {
        ...(contentType ? { 'Content-Type': contentType } : {}),
        ...(contentLength ? { 'Content-Length': contentLength } : {}),
      },
    })
  }

  private async moveObject(source: string, target: string): Promise<void> {
    const item = await this.lookup(source)
    if (!item) throw DriverError.notFound(`Object not found: ${source}`)
    if (item.IsDirectory === true) throw DriverError.unsupported('Bunny Storage cannot move a folder')
    await this.copyObject(source, target)
    await this.send('DELETE', source)
  }
}

export function createBunnyStorageDriver(ctx: DriverContext): MountDriver {
  return new BunnyStorageDriver(ctx)
}
