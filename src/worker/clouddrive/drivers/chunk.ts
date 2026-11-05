/**
 * Chunk driver — stores a large file as numbered parts inside a `<chunkPrefix><name>/` directory
 * under another mount, and presents the directory back as one virtual file.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/chunk`: `remotePath` is resolved through
 * `ctx.resolveMount` (so the factory still enforces ownership, enabled status and cycles), the
 * virtual path is mirrored below `rootPath`, listings fold part directories into files, reads join
 * the parts in order while honouring Range, and uploads beyond `partSize` are split part by part.
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
  type ResolvedMount,
} from './contract'
import { driverChildPath, driverFileName, driverParentPath, driverPath } from './http'

const DEFAULT_CHUNK_PREFIX = '[openlist_chunk]'

interface ChunkPart {
  index: number
  name: string
  size: number
  modifiedAt: number
}

interface LocatedEntry {
  entry: DriverEntry
  remotePath: string
}

interface ByteRange {
  start: number
  end: number
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

function upstreamError(error: unknown, action: string): DriverError {
  if (error instanceof DriverError) return error
  const message = error instanceof Error ? error.message : String(error)
  return DriverError.upstream(`${action}: ${message}`)
}

class ChunkDriver implements MountDriver {
  readonly definition = findCloudDriveDriver('chunk')!
  readonly capabilities = this.definition.capabilities
  private remote: ResolvedMount | null = null

  constructor(private readonly ctx: DriverContext) {}

  private text(key: string, fallback = ''): string {
    const value = this.ctx.config[key]
    return typeof value === 'string' ? value : fallback
  }

  private flag(key: string): boolean {
    const value = this.ctx.config[key]
    return value === true || value === 'true' || value === 1 || value === '1'
  }

  private partSize(): number {
    const raw = this.ctx.config.partSize
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
      throw DriverError.invalid('Chunk partSize must be a positive number of bytes')
    }
    return Math.floor(value)
  }

  private prefix(): string {
    return this.text('chunkPrefix', DEFAULT_CHUNK_PREFIX).trim() || DEFAULT_CHUNK_PREFIX
  }

  private customExt(): string {
    return this.text('customExt', '').trim()
  }

  private root(): string {
    const raw = this.text('rootPath', '/').trim() || '/'
    try {
      return driverPath(raw)
    } catch {
      throw DriverError.invalid('The configured root path is invalid')
    }
  }

  private async remoteMount(): Promise<ResolvedMount> {
    if (this.remote) return this.remote
    const reference = this.text('remotePath').trim()
    if (!reference) throw DriverError.invalid('Chunk storage needs the mount path of the storage that holds its parts')
    const resolve = this.ctx.resolveMount
    if (!resolve) {
      throw DriverError.unsupported('Chunk needs cross-mount resolution, which this storage context does not provide')
    }
    const mount = await resolve(reference)
    this.remote = mount
    return mount
  }

  /** The same path inside the resolved mount: local path → remote mount-relative path. */
  private joinRemote(path: string): string {
    const clean = driverPath(path)
    const root = this.root()
    if (root === '/') return clean
    return clean === '/' ? root : `${root}${clean}`
  }

  private chunkDirRemote(path: string): string {
    const remote = this.joinRemote(path)
    const name = driverFileName(path)
    return driverChildPath(driverParentPath(remote), this.prefix() + name)
  }

  private partName(index: number): string {
    return `${index}${this.customExt()}`
  }

  private async listParts(path: string): Promise<ChunkPart[]> {
    const mount = await this.remoteMount()
    let entries: DriverEntry[]
    try {
      const result = await mount.driver.list(this.chunkDirRemote(path))
      entries = result.entries
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'not_found') return []
      throw upstreamError(error, 'Chunk could not list its parts')
    }
    const extension = this.customExt()
    const seen = new Set<number>()
    const parts: ChunkPart[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file') continue
      let stem = entry.name
      if (extension && stem.endsWith(extension)) stem = stem.slice(0, -extension.length)
      if (!/^\d+$/.test(stem)) continue
      const index = Number(stem)
      if (seen.has(index)) continue
      seen.add(index)
      parts.push({ index, name: entry.name, size: Math.max(0, entry.size), modifiedAt: entry.modifiedAt })
    }
    parts.sort((left, right) => left.index - right.index)
    return parts
  }

  private totalSize(parts: ChunkPart[]): number {
    return parts.reduce((sum, part) => sum + part.size, 0)
  }

  /** A real entry at the same path always shadows a chunk directory, as in the reference. */
  private async locate(path: string): Promise<LocatedEntry | null> {
    const mount = await this.remoteMount()
    const remotePath = this.joinRemote(path)
    try {
      const entry = await mount.driver.stat(remotePath)
      return { entry, remotePath }
    } catch (error) {
      if (error instanceof DriverError && error.kind === 'not_found') return null
      throw upstreamError(error, 'Chunk could not stat the remote path')
    }
  }

  private entryFor(path: string, parts: ChunkPart[]): DriverEntry {
    const name = driverFileName(path)
    return {
      name,
      kind: 'file',
      size: this.totalSize(parts),
      modifiedAt: parts[0]?.modifiedAt ?? 0,
      mime: driverEntryMime(name),
    }
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    const clean = driverPath(path)
    this.partSize()
    const mount = await this.remoteMount()
    const prefix = this.prefix()
    let result: DriverListResult
    try {
      result = await mount.driver.list(this.joinRemote(clean))
    } catch (error) {
      throw upstreamError(error, 'Chunk could not list the remote path')
    }

    const entries: DriverEntry[] = []
    const pending: Array<Promise<void>> = []
    for (const item of result.entries) {
      if (item.kind === 'folder' && item.name.startsWith(prefix)) {
        const name = item.name.slice(prefix.length)
        if (!name) continue
        if (!this.flag('showHidden') && name.startsWith('.')) continue
        const virtualPath = driverChildPath(clean, name)
        entries.push({
          name,
          kind: 'file',
          size: 0,
          modifiedAt: item.modifiedAt,
          mime: driverEntryMime(name),
        })
        const slot = entries.length - 1
        pending.push(this.listParts(virtualPath).then((parts) => {
          entries[slot] = this.entryFor(virtualPath, parts)
        }))
        continue
      }
      if (!this.flag('showHidden') && item.name.startsWith('.')) continue
      entries.push(item)
    }
    await Promise.all(pending)
    return { entries, cursor: null, truncated: result.truncated }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0 }
    this.partSize()
    const located = await this.locate(clean)
    if (located) return located.entry
    const parts = await this.listParts(clean)
    if (parts.length === 0) throw DriverError.notFound(`Not found: ${clean}`)
    return this.entryFor(clean, parts)
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    this.partSize()
    const mount = await this.remoteMount()
    const located = await this.locate(clean)
    if (located) {
      if (located.entry.kind === 'folder') throw DriverError.unsupported('A folder cannot be read as a file')
      try {
        return await mount.driver.read(located.remotePath, range)
      } catch (error) {
        throw upstreamError(error, 'Chunk could not read the remote file')
      }
    }

    const parts = await this.listParts(clean)
    if (parts.length === 0) throw DriverError.notFound(`Not found: ${clean}`)
    const total = this.totalSize(parts)
    const slice = parseRangeHeader(range, total)
    const name = driverFileName(clean)
    const headers = new Headers({ 'content-type': driverEntryMime(name), 'accept-ranges': 'bytes' })
    if (!slice) {
      headers.set('content-length', String(total))
      return new Response(this.mergeParts(clean, parts, { start: 0, end: total - 1 }), { status: 200, headers })
    }
    const length = slice.end - slice.start + 1
    headers.set('content-length', String(length))
    headers.set('content-range', `bytes ${slice.start}-${slice.end}/${total}`)
    return new Response(this.mergeParts(clean, parts, slice), { status: 206, headers })
  }

  private mergeParts(path: string, parts: ChunkPart[], range: ByteRange): ReadableStream<Uint8Array> {
    const chunkDir = this.chunkDirRemote(path)
    let position = 0
    let offset = range.start
    let remaining = Math.max(0, range.end - range.start + 1)
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          for (const part of parts) {
            const partStart = position
            position += part.size
            if (remaining <= 0) break
            if (part.size <= 0 || offset >= position) continue
            const startInPart = Math.max(0, offset - partStart)
            const endInPart = Math.min(part.size - 1, startInPart + remaining - 1)
            const mount = await this.remoteMount()
            const partPath = driverChildPath(chunkDir, part.name)
            let response: Response
            try {
              response = await mount.driver.read(partPath, `bytes=${startInPart}-${endInPart}`)
            } catch (error) {
              throw upstreamError(error, `Chunk could not read part ${part.name}`)
            }
            if (!response.ok && response.status !== 206) {
              await response.body?.cancel().catch(() => undefined)
              throw DriverError.upstream(`Chunk part ${part.name} failed (HTTP ${response.status})`)
            }
            let bytes = new Uint8Array(await response.arrayBuffer())
            if (response.status !== 206 && startInPart > 0) bytes = bytes.subarray(startInPart)
            const wanted = endInPart - startInPart + 1
            if (bytes.byteLength > wanted) bytes = bytes.subarray(0, wanted)
            if (bytes.byteLength > 0) controller.enqueue(bytes)
            offset += bytes.byteLength
            remaining -= bytes.byteLength
          }
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      },
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The mount root cannot be written as a file')
    const partSize = this.partSize()
    const mount = await this.remoteMount()
    const bytes = await asBytes(body)
    if (bytes.byteLength !== options.size) {
      throw DriverError.invalid('The upload body does not match the declared size')
    }
    const remotePath = this.joinRemote(clean)
    if (bytes.byteLength <= partSize) {
      try {
        await mount.driver.upload(remotePath, bytes, options)
      } catch (error) {
        throw upstreamError(error, 'Chunk could not upload the remote file')
      }
      return
    }

    const chunkDir = this.chunkDirRemote(clean)
    try {
      await mount.driver.mkdir(chunkDir)
    } catch (error) {
      let exists = false
      try {
        exists = (await mount.driver.stat(chunkDir)).kind === 'folder'
      } catch {
        exists = false
      }
      if (!exists) throw upstreamError(error, 'Chunk could not create the part directory')
    }

    const total = bytes.byteLength
    let offset = 0
    let index = 0
    while (offset < total) {
      const end = Math.min(offset + partSize, total)
      const partPath = driverChildPath(chunkDir, this.partName(index))
      try {
        await mount.driver.upload(partPath, bytes.subarray(offset, end), {
          size: end - offset,
          contentType: options.contentType,
        })
      } catch (error) {
        throw upstreamError(error, `Chunk could not upload part ${index}`)
      }
      offset = end
      index++
      options.onProgress?.(offset, total)
    }
  }

  async mkdir(path: string): Promise<void> {
    const clean = driverPath(path)
    const mount = await this.remoteMount()
    try {
      await mount.driver.mkdir(this.joinRemote(clean))
    } catch (error) {
      throw upstreamError(error, 'Chunk could not create the remote directory')
    }
  }

  async rename(path: string, newName: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The mount root cannot be renamed')
    if (!newName || newName.includes('/') || newName.includes('\\')) {
      throw DriverError.invalid('The new name is invalid')
    }
    const mount = await this.remoteMount()
    const located = await this.locate(clean)
    try {
      if (located) {
        await mount.driver.rename(located.remotePath, newName)
      } else {
        await mount.driver.rename(this.chunkDirRemote(clean), this.prefix() + newName)
      }
    } catch (error) {
      throw upstreamError(error, 'Chunk could not rename the remote entry')
    }
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/' || to === '/') throw DriverError.invalid('The mount root cannot be moved')
    const mount = await this.remoteMount()
    const located = await this.locate(from)
    try {
      if (located) {
        await mount.driver.move(located.remotePath, this.joinRemote(to))
      } else {
        await mount.driver.move(this.chunkDirRemote(from), this.chunkDirRemote(to))
      }
    } catch (error) {
      throw upstreamError(error, 'Chunk could not move the remote entry')
    }
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = driverPath(fromPath)
    const to = driverPath(toPath)
    if (from === '/' || to === '/') throw DriverError.invalid('The mount root cannot be copied')
    const mount = await this.remoteMount()
    if (!mount.driver.copy) throw DriverError.unsupported('The underlying storage cannot copy entries')
    const located = await this.locate(from)
    try {
      if (located) {
        await mount.driver.copy(located.remotePath, this.joinRemote(to))
      } else {
        await mount.driver.copy(this.chunkDirRemote(from), this.chunkDirRemote(to))
      }
    } catch (error) {
      throw upstreamError(error, 'Chunk could not copy the remote entry')
    }
  }

  async remove(path: string): Promise<void> {
    const clean = driverPath(path)
    if (clean === '/') throw DriverError.invalid('The mount root cannot be removed')
    const mount = await this.remoteMount()
    const located = await this.locate(clean)
    try {
      if (located) {
        await mount.driver.remove(located.remotePath)
      } else {
        await mount.driver.remove(this.chunkDirRemote(clean))
      }
    } catch (error) {
      throw upstreamError(error, 'Chunk could not remove the remote entry')
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      this.partSize()
      if (!this.ctx.resolveMount) {
        return { ok: false, message: 'Chunk needs cross-mount resolution, which this storage context does not provide' }
      }
      const mount = await this.remoteMount()
      await mount.driver.list(this.joinRemote('/'))
      return { ok: true, message: `Chunk storage is ready · ${mount.mountPath} in ${this.partSize()}-byte parts` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Chunk storage is misconfigured' }
    }
  }
}

export function createChunkDriver(ctx: DriverContext): MountDriver {
  return new ChunkDriver(ctx)
}
