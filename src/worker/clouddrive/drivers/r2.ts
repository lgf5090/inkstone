/**
 * Cloudflare R2 driver.
 *
 * R2 is an S3-compatible object store, so the `s3` driver core is reused for the API mode. The
 * binding mode talks to the Worker's own `R2Bucket`, which has no presigned URLs and no server-side
 * multipart session: uploads stream through `put`, and a direct link is always null.
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
  driverFileName,
  driverParentPath,
  driverPath,
} from './http'
import { S3Driver } from './s3'

const PLACEHOLDER = '.inkstone-folder'

function normalizeRoot(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') return ''
  return trimmed.replace(/^\/+|\/+$/g, '')
}

function parseRange(value: string | null | undefined, size: number): { offset: number; length: number } | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const first = match[1] ?? ''
  const second = match[2] ?? ''
  if (!first && !second) return null
  if (!first) {
    const suffix = Number(second)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    const offset = Math.max(0, size - suffix)
    return { offset, length: size - offset }
  }
  const offset = Number(first)
  const end = second ? Math.min(Number(second), size - 1) : size - 1
  if (!Number.isFinite(offset) || offset >= size || end < offset) return null
  return { offset, length: end - offset + 1 }
}

export class R2Driver extends S3Driver {
  constructor(ctx: DriverContext) {
    super(ctx, 'r2')
  }

  protected override endpoint(): string {
    const explicit = super.endpoint()
    if (explicit) return explicit
    const accountId = this.configText('accountId').trim()
    return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ''
  }

  protected override region(): string {
    return this.configText('region', 'auto').trim() || 'auto'
  }

  protected override pathStyle(): boolean {
    return true
  }
}

class R2BindingDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('r2')!
  readonly capabilities = this.definition.capabilities

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  private bucket(): R2Bucket {
    if (!this.ctx.r2) throw DriverError.auth('This deployment has no R2 binding available')
    return this.ctx.r2
  }

  private root(): string {
    return normalizeRoot(this.configText('rootPath', '/'))
  }

  private key(path: string, directory = false): string {
    const clean = driverPath(path)
    const relative = clean === '/' ? '' : clean.slice(1)
    let key = [this.root(), relative].filter(Boolean).join('/')
    if (directory && key && !key.endsWith('/')) key += '/'
    return key
  }

  private folderPrefix(path: string): string {
    const key = this.key(path, true)
    return key
  }

  protected async login(_force: boolean): Promise<void> {
    driverPath(this.configText('rootPath', '/'))
    this.bucket()
  }

  private objectEntry(name: string, size: number, modifiedAt: number): DriverEntry {
    return {
      name,
      kind: 'file',
      size,
      modifiedAt,
      mime: driverEntryMime(name),
    }
  }

  async list(path: string, options: DriverListOptions = {}): Promise<DriverListResult> {
    const prefix = this.folderPrefix(path)
    const limit = Math.max(1, Math.min(1000, options.pageSize ?? 1000))
    const listed = await this.bucket().list({ prefix, limit })
    const entries: DriverEntry[] = []
    const seen = new Set<string>()
    const add = (entry: DriverEntry): void => {
      if (seen.has(entry.name)) return
      seen.add(entry.name)
      entries.push(entry)
    }
    for (const object of listed.objects) {
      const relative = object.key.slice(prefix.length)
      if (!relative || relative === PLACEHOLDER) continue
      const slash = relative.indexOf('/')
      if (slash >= 0) {
        const name = relative.slice(0, slash)
        if (name) add({ name, kind: 'folder', size: 0, modifiedAt: 0, mime: 'application/octet-stream' })
        continue
      }
      add(this.objectEntry(relative, object.size, object.uploaded?.getTime() ?? 0))
    }
    if (options.search) {
      const search = options.search.toLowerCase()
      return {
        entries: entries.filter((entry) => entry.name.toLowerCase().includes(search)),
        cursor: null,
        truncated: listed.truncated,
      }
    }
    return { entries, cursor: null, truncated: listed.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: Date.now(), mime: 'application/octet-stream' }
    }
    const key = this.key(clean)
    const object = await this.bucket().head(key)
    if (object) {
      return this.objectEntry(driverFileName(clean), object.size, object.uploaded?.getTime() ?? 0)
    }
    const listed = await this.bucket().list({ prefix: `${key}/`, limit: 1 })
    if (listed.objects.length > 0 || (listed.delimitedPrefixes ?? []).length > 0) {
      return {
        name: driverFileName(clean),
        kind: 'folder',
        size: 0,
        modifiedAt: 0,
        mime: 'application/octet-stream',
      }
    }
    throw DriverError.notFound(`R2 has no such object: ${driverFileName(clean)}`)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.unsupported('A folder cannot be read as a file')
    const key = this.key(clean)
    const head = await this.bucket().head(key)
    if (!head) throw DriverError.notFound(`R2 has no such object: ${driverFileName(clean)}`)
    const byteRange = parseRange(range, head.size)
    if (range && !byteRange) throw DriverError.invalid('The byte range is not satisfiable')
    const object = await this.bucket().get(key, byteRange ? { range: byteRange } : undefined)
    if (!object) throw DriverError.notFound(`R2 has no such object: ${driverFileName(clean)}`)
    const headers = new Headers()
    headers.set('content-type', object.httpMetadata?.contentType ?? driverEntryMime(driverFileName(clean)))
    headers.set('content-length', String(byteRange?.length ?? object.size))
    headers.set('etag', object.httpEtag)
    if (byteRange) {
      headers.set('content-range', `bytes ${byteRange.offset}-${byteRange.offset + byteRange.length - 1}/${head.size}`)
    }
    return new Response(object.body, { status: byteRange ? 206 : 200, headers })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) throw DriverError.invalid('The upload body does not match the declared size')
    const key = this.key(path)
    await this.bucket().put(key, bytes, {
      httpMetadata: { contentType: options.contentType ?? driverEntryMime(driverFileName(path)) },
    })
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') return
    await this.bucket().put(`${this.key(clean, true)}${PLACEHOLDER}`, new Uint8Array(0))
  }

  private async copyObject(fromPath: string, toPath: string): Promise<void> {
    const fromKey = this.key(fromPath)
    const head = await this.bucket().head(fromKey)
    if (!head) throw DriverError.notFound(`R2 has no such object: ${driverFileName(fromPath)}`)
    const object = await this.bucket().get(fromKey)
    if (!object) throw DriverError.notFound(`R2 has no such object: ${driverFileName(fromPath)}`)
    await this.bucket().put(this.key(toPath), object.body, {
      httpMetadata: { contentType: object.httpMetadata?.contentType ?? driverEntryMime(driverFileName(toPath)) },
    })
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    const target = `${driverParentPath(clean)}/${newName}`.replace(/\/{2,}/g, '/')
    await this.move(clean, target)
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    const fromHead = await this.bucket().head(this.key(from))
    if (!fromHead) throw DriverError.unsupported('R2 binding mode can only move a file, not a folder')
    await this.copyObject(from, to)
    await this.bucket().delete(this.key(from))
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    await this.copyObject(fromPath, toPath)
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    const key = this.key(clean)
    const head = await this.bucket().head(key)
    if (head) {
      await this.bucket().delete(key)
      return
    }
    const prefix = `${key}/`
    const listed = await this.bucket().list({ prefix, limit: 1000 })
    if (listed.objects.length === 0) throw DriverError.notFound(`R2 has no such object: ${driverFileName(clean)}`)
    await this.bucket().delete(listed.objects.map((object) => object.key))
  }

  async directLink(): Promise<string | null> {
    return null
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.bucket().list({ prefix: this.root(), limit: 1 })
      return { ok: true, message: 'The R2 binding is reachable' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The R2 binding is unavailable' }
    }
  }
}

/** Binding mode for the built-in primary storage and for internal mount resolution. */
export function createR2BindingDriver(ctx: DriverContext): MountDriver {
  return new R2BindingDriver(ctx)
}

export function createR2Driver(ctx: DriverContext): MountDriver {
  if (String(ctx.config.mode ?? '').toLowerCase() === 'binding') return new R2BindingDriver(ctx)
  return new R2Driver(ctx)
}
