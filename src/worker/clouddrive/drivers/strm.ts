/**
 * STRM driver — exposes another mount's media files as virtual `.strm` files whose body is a
 * playable URL.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/strm`: `paths` is a newline-separated list of
 * mappings (`alias:/mount` or `/mount`), a single mapping is flattened into the mount root, media
 * extensions become `.strm` entries while download-only extensions pass through, and a path that
 * escapes the mount is refused by the shared path normaliser. Mounts are resolved through
 * `ctx.resolveMount`, so the factory keeps the ownership, enabled-status and cycle checks.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
  type ResolvedMount,
} from './contract'
import { driverChildPath, driverFileName, driverParentPath, driverPath } from './http'

const DEFAULT_PATH_PREFIX = '/d'
const DEFAULT_MEDIA_TYPES = 'mp4,mkv,flv,avi,wmv,ts,rmvb,webm,mp3,flac,aac,wav,ogg,m4a,wma,alac'
const DEFAULT_DOWNLOAD_TYPES = 'ass,srt,vtt,sub,strm'

interface StrmMapping {
  alias: string
  /** A mount path, a mount id, or a mount path followed by a sub path. */
  reference: string
}

interface ResolvedMapping {
  mount: ResolvedMount
  /** The reference part past the mount root: `/media/shows` on mount `/media` is `shows`. */
  subPath: string
}

interface ByteRange {
  start: number
  end: number
}

function joinPath(base: string, next: string): string {
  const left = String(base || '').replace(/\/+$/, '')
  const right = String(next || '').replace(/^\/+/, '')
  if (!left) return `/${right}`
  if (!right) return left
  return `${left}/${right}`
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

function parseMappings(raw: string): Map<string, StrmMapping[]> {
  const map = new Map<string, StrmMapping[]>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    let alias: string
    let reference: string
    if (colon > 0 && !trimmed.slice(0, colon).includes('/')) {
      alias = trimmed.slice(0, colon).trim()
      reference = trimmed.slice(colon + 1).trim()
    } else {
      reference = trimmed
      alias = reference.split('/').filter(Boolean).pop() ?? 'root'
    }
    if (!alias || alias.includes('/')) throw DriverError.invalid(`The STRM alias is invalid: ${trimmed}`)
    if (!reference) throw DriverError.invalid(`The STRM mount reference is missing: ${trimmed}`)
    const mappings = map.get(alias) ?? []
    mappings.push({ alias, reference })
    map.set(alias, mappings)
  }
  return map
}

function parseRangeHeader(value: string | null | undefined, size: number): ByteRange | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const first = match[1] ?? ''
  const second = match[2] ?? ''
  if (!first && !second) return null
  if (!first) {
    const suffix = Number(second)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isFinite(start) || start >= size) return null
  const end = second ? Math.min(Number(second), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}

class StrmDriver implements MountDriver {
  readonly definition = findCloudDriveDriver('strm')!
  readonly capabilities = this.definition.capabilities
  private readonly targets = new Map<string, ResolvedMapping>()
  private mappingsCache: Map<string, StrmMapping[]> | null = null
  private mediaTypesCache: Set<string> | null = null
  private downloadTypesCache: Set<string> | null = null

  constructor(private readonly ctx: DriverContext) {}

  private text(key: string, fallback = ''): string {
    const value = this.ctx.config[key]
    return typeof value === 'string' ? value : fallback
  }

  private flag(key: string): boolean {
    const value = this.ctx.config[key]
    return value === true || value === 'true' || value === 1 || value === '1'
  }

  private mappings(): Map<string, StrmMapping[]> {
    if (this.mappingsCache) return this.mappingsCache
    const raw = this.text('paths')
    if (!raw.trim()) throw DriverError.invalid('STRM needs at least one path mapping')
    const map = parseMappings(raw)
    if (map.size === 0) throw DriverError.invalid('STRM needs at least one path mapping')
    this.mappingsCache = map
    return map
  }

  private types(key: string, fallback: string): Set<string> {
    const raw = this.text(key, fallback).trim() || fallback
    return new Set(raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
  }

  private mediaTypes(): Set<string> {
    this.mediaTypesCache ??= this.types('filterFileTypes', DEFAULT_MEDIA_TYPES)
    return this.mediaTypesCache
  }

  private downloadTypes(): Set<string> {
    this.downloadTypesCache ??= this.types('downloadFileTypes', DEFAULT_DOWNLOAD_TYPES)
    return this.downloadTypesCache
  }

  private root(): string {
    const raw = this.text('rootPath', '/').trim() || '/'
    try {
      return driverPath(raw)
    } catch {
      throw DriverError.invalid('The configured root path is invalid')
    }
  }

  private siteUrl(): string {
    return this.text('siteUrl').trim().replace(/\/+$/, '')
  }

  private linkFor(originalPath: string): string {
    let target = originalPath
    if (this.flag('encodePath')) {
      target = target.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    }
    const prefix = this.text('pathPrefix').trim() || this.text('PathPrefix').trim() || DEFAULT_PATH_PREFIX
    const joined = joinPath(prefix, target)
    const absolute = joined.startsWith('/') ? joined : `/${joined}`
    if (this.flag('withoutUrl')) return absolute
    return `${this.siteUrl()}${absolute}`
  }

  private requireResolver(): (reference: string) => Promise<ResolvedMount> {
    const resolve = this.ctx.resolveMount
    if (!resolve) {
      throw DriverError.unsupported('STRM needs cross-mount resolution, which this storage context does not provide')
    }
    return resolve
  }

  /**
   * Resolves a reference to an enabled mount plus an optional sub path. The longest prefix wins,
   * so `/mount/shows` is mount `/mount` with `shows` beneath it. Cycle and authorization errors
   * raised by the resolver are never swallowed.
   */
  private async resolveReference(reference: string): Promise<ResolvedMapping> {
    const resolve = this.requireResolver()
    const clean = reference.trim()
    if (!clean) throw DriverError.invalid('A STRM path mapping needs a mount path')
    const candidates: string[] = []
    let current = clean
    for (;;) {
      candidates.push(current)
      const index = current.lastIndexOf('/')
      if (index <= 0) break
      current = current.slice(0, index)
    }
    let missing: DriverError | null = null
    for (const candidate of candidates) {
      try {
        const mount = await resolve(candidate)
        const tail = candidate === clean ? '' : clean.slice(candidate.length).replace(/^\/+/, '')
        return { mount, subPath: tail }
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'not_found') {
          missing = error
          continue
        }
        throw error
      }
    }
    throw missing ?? DriverError.notFound(`No enabled mount named ${clean} belongs to this user`)
  }

  private async targetFor(reference: string): Promise<ResolvedMapping> {
    const cached = this.targets.get(reference)
    if (cached) return cached
    const resolved = await this.resolveReference(reference)
    this.targets.set(reference, resolved)
    return resolved
  }

  private remotePath(mapping: ResolvedMapping, sub: string): string {
    return joinPath(joinPath(this.root(), mapping.subPath), sub)
  }

  /** The alias and the path below it; the flattened form has one implicit alias. */
  private layout(path: string): { alias: string; sub: string } {
    const clean = driverPath(path)
    const aliases = this.mappings()
    if (aliases.size === 1) {
      const alias = aliases.keys().next().value as string
      return { alias, sub: clean === '/' ? '' : clean.slice(1) }
    }
    const trimmed = clean.slice(1)
    const index = trimmed.indexOf('/')
    if (index < 0) return { alias: trimmed, sub: '' }
    return { alias: trimmed.slice(0, index), sub: trimmed.slice(index + 1) }
  }

  private convert(entry: DriverEntry, virtualDir: string): DriverEntry | null {
    if (entry.kind === 'folder') return entry
    const extension = extensionOf(entry.name)
    if (this.downloadTypes().has(extension)) {
      return { ...entry, mime: entry.mime ?? driverEntryMime(entry.name) }
    }
    if (!this.mediaTypes().has(extension)) return null
    const originalPath = driverChildPath(virtualDir, entry.name)
    const name = entry.name.replace(/\.[^.]+$/, '') + '.strm'
    return {
      name,
      kind: 'file',
      size: new TextEncoder().encode(this.linkFor(originalPath)).byteLength,
      modifiedAt: entry.modifiedAt,
      ref: originalPath,
      mime: 'text/plain',
    }
  }

  private async findVirtualStrm(path: string): Promise<DriverEntry | null> {
    const name = driverFileName(path)
    const listing = await this.list(driverParentPath(path))
    const entry = listing.entries.find((item) => item.name === name && item.kind === 'file')
    return entry?.ref ? entry : null
  }

  private textResponse(text: string, range?: string | null): Response {
    const bytes = new TextEncoder().encode(text)
    const total = bytes.byteLength
    const slice = parseRangeHeader(range, total)
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'accept-ranges': 'bytes' })
    if (!slice) {
      headers.set('content-length', String(total))
      return new Response(bytes, { status: 200, headers })
    }
    const length = slice.end - slice.start + 1
    headers.set('content-length', String(length))
    headers.set('content-range', `bytes ${slice.start}-${slice.end}/${total}`)
    return new Response(bytes.subarray(slice.start, slice.end + 1), { status: 206, headers })
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    const aliases = this.mappings()
    if (clean === '/' && aliases.size > 1) {
      const entries: DriverEntry[] = [...aliases.keys()].map((alias) => ({
        name: alias,
        kind: 'folder' as const,
        size: 0,
        modifiedAt: 0,
      }))
      return { entries, cursor: null, truncated: false }
    }

    const { alias, sub } = this.layout(clean)
    const mappings = aliases.get(alias)
    if (!mappings) throw DriverError.notFound(`The STRM mapping ${alias} is not configured`)

    const merged = new Map<string, DriverEntry>()
    let truncated = false
    for (const mapping of mappings) {
      const target = await this.targetFor(mapping.reference)
      let entries: DriverEntry[]
      try {
        const result = await target.mount.driver.list(this.remotePath(target, sub))
        entries = result.entries
        truncated = truncated || result.truncated
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'not_found') continue
        throw error
      }
      for (const entry of entries) {
        const converted = this.convert(entry, clean)
        if (converted && !merged.has(converted.name)) merged.set(converted.name, converted)
      }
    }
    return {
      entries: [...merged.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
      cursor: null,
      truncated,
    }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    const aliases = this.mappings()
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0 }

    const { alias, sub } = this.layout(clean)
    const mappings = aliases.get(alias)
    if (!mappings) throw DriverError.notFound(`The STRM mapping ${alias} is not configured`)
    if (sub === '' && aliases.size > 1) return { name: alias, kind: 'folder', size: 0, modifiedAt: 0 }

    if (clean.endsWith('.strm')) {
      const virtual = await this.findVirtualStrm(clean)
      if (virtual) return virtual
    }

    for (const mapping of mappings) {
      const target = await this.targetFor(mapping.reference)
      try {
        return await target.mount.driver.stat(this.remotePath(target, sub))
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'not_found') continue
        throw error
      }
    }
    throw DriverError.notFound(`Not found: ${clean}`)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    const aliases = this.mappings()
    if (clean.endsWith('.strm')) {
      const virtual = await this.findVirtualStrm(clean)
      if (virtual?.ref) return this.textResponse(this.linkFor(virtual.ref), range)
    }

    const { alias, sub } = this.layout(clean)
    const mappings = aliases.get(alias)
    if (!mappings) throw DriverError.notFound(`The STRM mapping ${alias} is not configured`)
    for (const mapping of mappings) {
      const target = await this.targetFor(mapping.reference)
      try {
        return await target.mount.driver.read(this.remotePath(target, sub), range)
      } catch (error) {
        if (error instanceof DriverError && error.kind === 'not_found') continue
        throw error
      }
    }
    throw DriverError.notFound(`Not found: ${clean}`)
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('STRM storage is read-only')
  }

  async mkdir(_path: string): Promise<void> {
    throw DriverError.unsupported('STRM storage is read-only')
  }

  async rename(_path: string, _newName: string): Promise<void> {
    throw DriverError.unsupported('STRM storage is read-only')
  }

  async move(_fromPath: string, _toPath: string): Promise<void> {
    throw DriverError.unsupported('STRM storage is read-only')
  }

  async copy(_fromPath: string, _toPath: string): Promise<void> {
    throw DriverError.unsupported('STRM storage is read-only')
  }

  async remove(_path: string): Promise<void> {
    throw DriverError.unsupported('STRM storage is read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const aliases = this.mappings()
      this.requireResolver()
      let count = 0
      for (const mappings of aliases.values()) {
        for (const mapping of mappings) {
          const target = await this.targetFor(mapping.reference)
          await target.mount.driver.list(this.remotePath(target, ''))
          count++
        }
      }
      return {
        ok: true,
        message: `STRM resolved ${count} mapping${count === 1 ? '' : 's'} across ${aliases.size} alias${aliases.size === 1 ? '' : 'es'}`,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'STRM is misconfigured' }
    }
  }
}

export function createStrmDriver(ctx: DriverContext): MountDriver {
  return new StrmDriver(ctx)
}
