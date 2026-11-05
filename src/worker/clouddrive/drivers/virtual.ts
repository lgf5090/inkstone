/**
 * Virtual driver — a placeholder storage used to exercise the CloudDrive surface.
 *
 * Ported from `OpenList-Worker/src/backend/drivers/virtual`. It has no upstream: listings are
 * synthesised from `numFile` / `numFolder`, and each read streams random bytes. Sizes are derived
 * deterministically from the path so a `stat` and the following `read` agree on the length.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import {
  DriverError,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type MountDriver,
} from './contract'
import {
  HttpDriverBase,
  driverFileName,
  driverPath,
} from './http'

const BASE_MODIFIED = 1_700_000_000_000
const FOLDER_PATTERN = /^folder_(\d+)$/

function hash(value: string): number {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193) >>> 0
  }
  return result >>> 0
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(0, length))
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 65_536))
    crypto.getRandomValues(chunk)
  }
  return bytes
}

interface ByteRange {
  start: number
  end: number
}

function parseRange(value: string | null | undefined, size: number): ByteRange | null {
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

class VirtualDriver extends HttpDriverBase implements MountDriver {
  readonly definition = findCloudDriveDriver('virtual')!
  readonly capabilities = this.definition.capabilities

  constructor(ctx: DriverContext) {
    super(ctx)
  }

  protected async login(_force: boolean): Promise<void> {
    driverPath(this.configText('rootPath', '/'))
    if (this.number('numFile') < 0 || this.number('numFolder') < 0) {
      throw DriverError.invalid('Virtual storage needs a non-negative numFile and numFolder.')
    }
    if (this.maxSize() < this.minSize()) {
      throw DriverError.invalid('Virtual minFileSize cannot be larger than maxFileSize.')
    }
  }

  private number(key: string): number {
    const raw = this.ctx.config[key]
    const value = typeof raw === 'number' ? raw : Number(raw ?? 0)
    return Number.isFinite(value) ? Math.floor(value) : 0
  }

  private minSize(): number {
    return Math.max(0, this.number('minFileSize'))
  }

  private maxSize(): number {
    return Math.max(0, this.number('maxFileSize'))
  }

  private sizeFor(key: string): number {
    const min = this.minSize()
    const max = this.maxSize()
    if (max <= min) return min
    return min + (hash(key) % (max - min + 1))
  }

  private modifiedFor(key: string): number {
    return BASE_MODIFIED + (hash(`modified:${key}`) % 86_400_000)
  }

  private folderNameFor(key: string): boolean {
    const match = FOLDER_PATTERN.exec(driverFileName(driverPath(key)))
    if (!match) return false
    return Number(match[1]) < this.number('numFolder')
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    driverPath(path)
    await this.authenticate(false)
    const entries: DriverEntry[] = []
    for (let index = 0; index < this.number('numFile'); index++) {
      const name = `file_${index}.bin`
      entries.push({
        name,
        kind: 'file',
        size: this.sizeFor(name),
        modifiedAt: this.modifiedFor(name),
        mime: driverEntryMime(name),
      })
    }
    for (let index = 0; index < this.number('numFolder'); index++) {
      const name = `folder_${index}`
      entries.push({
        name,
        kind: 'folder',
        size: 0,
        modifiedAt: this.modifiedFor(name),
      })
    }
    return { entries, cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = driverPath(path)
    await this.authenticate(false)
    if (clean === '/') {
      return { name: 'root', kind: 'folder', size: 0, modifiedAt: this.modifiedFor('/') }
    }
    const name = driverFileName(clean)
    if (this.folderNameFor(clean)) {
      return { name, kind: 'folder', size: 0, modifiedAt: this.modifiedFor(name) }
    }
    return {
      name,
      kind: 'file',
      size: this.sizeFor(name),
      modifiedAt: this.modifiedFor(name),
      mime: driverEntryMime(name),
    }
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = driverPath(path)
    await this.authenticate(false)
    const name = driverFileName(clean)
    if (clean === '/' || this.folderNameFor(clean)) {
      throw DriverError.unsupported('A folder cannot be read as a file')
    }
    const size = this.sizeFor(name)
    const slice = parseRange(range, size)
    const headers = new Headers({
      'content-type': driverEntryMime(name),
      'accept-ranges': 'bytes',
    })
    if (!slice) {
      headers.set('content-length', String(size))
      return new Response(randomBytes(size), { status: 200, headers })
    }
    const length = slice.end - slice.start + 1
    headers.set('content-length', String(length))
    headers.set('content-range', `bytes ${slice.start}-${slice.end}/${size}`)
    return new Response(randomBytes(length), { status: 206, headers })
  }

  async upload(): Promise<void> {
    throw DriverError.unsupported('Virtual storage is a read-only placeholder')
  }

  async mkdir(): Promise<void> {
    throw DriverError.unsupported('Virtual storage is a read-only placeholder')
  }

  async rename(): Promise<void> {
    throw DriverError.unsupported('Virtual storage is a read-only placeholder')
  }

  async move(): Promise<void> {
    throw DriverError.unsupported('Virtual storage is a read-only placeholder')
  }

  async remove(): Promise<void> {
    throw DriverError.unsupported('Virtual storage is a read-only placeholder')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.authenticate(false)
      return {
        ok: true,
        message: `Virtual storage is ready · ${this.number('numFile')} files and ${this.number('numFolder')} folders`,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Virtual storage is misconfigured' }
    }
  }
}

export function createVirtualDriver(ctx: DriverContext): MountDriver {
  return new VirtualDriver(ctx)
}
