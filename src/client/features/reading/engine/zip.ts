/**
 * A read-only ZIP container.
 *
 * The books this app opens (EPUB, CBZ) are ZIP archives, and the whole reason to hold the file in
 * IndexedDB rather than on a server is that a reader's library never leaves the device — so the
 * archive has to be walked here. The central directory is the only thing parsed eagerly: a 40 MB
 * illustrated EPUB should cost a few hundred microseconds to open, not a pass over every member.
 *
 * `DecompressionStream('deflate-raw')` does the inflating. It is the platform's own copy of zlib,
 * available in every browser this app supports, which keeps a ~30 KB decompressor out of the
 * reader's bundle.
 */

const EOCD_SIGNATURE = 0x06054b50
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50
const EOCD64_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
const MAX_COMMENT_BYTES = 0xffff
const FLAG_ENCRYPTED = 0x0001
/**
 * A ceiling on one member's decompressed size. A book that legitimately needs more does not exist —
 * the whole file is capped at import — while a crafted archive can claim a few bytes and inflate to
 * gigabytes, which would take the tab down rather than the book.
 */
const MAX_INFLATED_BYTES = 96 * 1024 * 1024
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

export class ZipFormatError extends Error {}

export interface ZipEntry {
  /** The member's path exactly as the archive spells it. */
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  encrypted: boolean
}

export interface ZipArchive {
  entries: readonly ZipEntry[]
  has(path: string): boolean
  /** The member's bytes, inflated. Rejects for a missing, encrypted or corrupt member. */
  read(path: string): Promise<Uint8Array>
  readText(path: string): Promise<string>
}

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true)
}

function u32(view: DataView, at: number): number {
  return view.getUint32(at, true)
}

function u64(view: DataView, at: number): number {
  const low = u32(view, at)
  const high = u32(view, at + 4)
  return high * 0x1_0000_0000 + low
}

function findEocd(view: DataView): number {
  const floor = Math.max(0, view.byteLength - EOCD_MIN_SIZE - MAX_COMMENT_BYTES)
  for (let at = view.byteLength - EOCD_MIN_SIZE; at >= floor; at--) {
    if (u32(view, at) === EOCD_SIGNATURE) return at
  }
  return -1
}

/**
 * A member's 64-bit sizes and header offset come from the ZIP64 extra field (header 0x0001), whose
 * present-but-zero 32-bit counterparts decide which fields the extra block carries. Order matters
 * more than length here: the spec fixes the sequence, so reading it positionally is correct.
 */
function applyZip64Extra(entry: ZipEntry, extra: Uint8Array): void {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  let at = 0
  while (at + 4 <= extra.byteLength) {
    const headerId = u16(view, at)
    const size = u16(view, at + 2)
    const body = at + 4
    if (body + size > extra.byteLength) break
    if (headerId === 0x0001) {
      let cursor = body
      if (entry.uncompressedSize === 0xffffffff) {
        entry.uncompressedSize = u64(view, cursor)
        cursor += 8
      }
      if (entry.compressedSize === 0xffffffff) {
        entry.compressedSize = u64(view, cursor)
        cursor += 8
      }
      if (entry.localHeaderOffset === 0xffffffff) {
        entry.localHeaderOffset = u64(view, cursor)
      }
    }
    at = body + size
  }
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function parseCentralDirectory(view: DataView, start: number, count: number): ZipEntry[] {
  const entries: ZipEntry[] = []
  let at = start
  for (let index = 0; index < count; index++) {
    if (at + 46 > view.byteLength || u32(view, at) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError('The archive’s central directory is truncated')
    }
    const flags = u16(view, at + 8)
    const nameLength = u16(view, at + 28)
    const extraLength = u16(view, at + 30)
    const commentLength = u16(view, at + 32)
    const entry: ZipEntry = {
      name: decodeName(new Uint8Array(view.buffer, view.byteOffset + at + 46, nameLength)),
      method: u16(view, at + 10),
      compressedSize: u32(view, at + 20),
      uncompressedSize: u32(view, at + 24),
      localHeaderOffset: u32(view, at + 42),
      encrypted: (flags & FLAG_ENCRYPTED) !== 0,
    }
    if (extraLength > 0) {
      applyZip64Extra(entry, new Uint8Array(view.buffer, view.byteOffset + at + 46 + nameLength, extraLength))
    }
    entries.push(entry)
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function inflate(bytes: Uint8Array, expected: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipFormatError('This browser cannot decompress the archive')
  }
  const decompressor = new DecompressionStream('deflate-raw')
  const writer = decompressor.writable.getWriter()
  // A member that fails to inflate leaves the readable side erroring, which the loop below surfaces.
  // The slice above always sits over a plain ArrayBuffer; the type only knows it is "ArrayBufferLike".
  void writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {})
  void writer.close().catch(() => {})
  const reader = decompressor.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_INFLATED_BYTES) {
      reader.cancel().catch(() => {})
      throw new ZipFormatError('A member of the archive expands past what the reader will hold')
    }
    parts.push(value)
  }
  const body = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    body.set(part, at)
    at += part.byteLength
  }
  if (expected >= 0 && expected !== body.byteLength) {
    // A member whose real size disagrees with the directory is a truncated download far more often
    // than it is a book that happens to compress oddly, and rendering half a chapter is worse than
    // refusing the file.
    throw new ZipFormatError('A member of the archive is smaller than its directory claims')
  }
  return body
}

/**
 * EPUB's OPF references are URI-encoded while most archivers store decoded names (or the other way
 * around), so a lookup has to try both spellings before it calls a member missing.
 */
function candidateNames(wanted: string): string[] {
  const clean = wanted.replace(/^\/+/, '')
  const out = [clean]
  try {
    const decoded = decodeURIComponent(clean)
    if (decoded !== clean) out.push(decoded)
  } catch {
    // An unparseable escape is its own answer; the raw spelling above already covers it.
  }
  const encoded = clean.split('/').map((part) => {
    try {
      return encodeURIComponent(decodeURIComponent(part))
    } catch {
      return part
    }
  }).join('/')
  if (encoded !== clean) out.push(encoded)
  return out
}

export async function openZip(source: ArrayBuffer | Uint8Array | Blob): Promise<ZipArchive> {
  // `ArrayBuffer.isView` rather than `instanceof Uint8Array`: a typed array that crossed a realm —
  // a worker's response, a test environment's encoder — fails the instanceof and would be treated as
  // a Blob.
  const buffer = source instanceof ArrayBuffer
    ? source
    : ArrayBuffer.isView(source)
      ? source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
      : await source.arrayBuffer()
  const view = new DataView(buffer)
  const eocd = findEocd(view)
  if (eocd < 0) throw new ZipFormatError('This is not a ZIP archive')

  let entryCount = u16(view, eocd + 10)
  let directoryOffset = u32(view, eocd + 16)
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    if (eocd - 20 >= 0 && u32(view, eocd - 20) === EOCD64_LOCATOR_SIGNATURE) {
      const locatorOffset = u32(view, eocd - 20 + 8)
      if (locatorOffset < view.byteLength && u32(view, locatorOffset) === EOCD64_SIGNATURE) {
        entryCount = Number(u64(view, locatorOffset + 32))
        directoryOffset = u64(view, locatorOffset + 48)
      }
    }
  }
  if (directoryOffset > view.byteLength) throw new ZipFormatError('The archive’s central directory is out of range')

  const entries = parseCentralDirectory(view, directoryOffset, entryCount)
  const byName = new Map<string, ZipEntry>()
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry)
  }
  const lower = new Map<string, ZipEntry>()
  for (const entry of entries) {
    const key = entry.name.toLowerCase()
    if (!lower.has(key)) lower.set(key, entry)
  }

  function locate(path: string): ZipEntry | undefined {
    for (const name of candidateNames(path)) {
      const direct = byName.get(name)
      if (direct) return direct
    }
    for (const name of candidateNames(path)) {
      const folded = lower.get(name.toLowerCase())
      if (folded) return folded
    }
    return undefined
  }

  async function read(path: string): Promise<Uint8Array> {
    const entry = locate(path)
    if (!entry) throw new ZipFormatError(`The archive has no member named ${path}`)
    if (entry.encrypted) throw new ZipFormatError('This book is DRM-protected and cannot be opened')
    const at = entry.localHeaderOffset
    if (at + 30 > view.byteLength || u32(view, at) !== LOCAL_SIGNATURE) {
      throw new ZipFormatError('A member of the archive has no local header')
    }
    const dataAt = at + 30 + u16(view, at + 26) + u16(view, at + 28)
    const end = dataAt + entry.compressedSize
    if (end > view.byteLength) throw new ZipFormatError('A member of the archive runs past its end')
    const bytes = new Uint8Array(buffer, dataAt, entry.compressedSize)
    if (entry.method === METHOD_STORE) return bytes
    if (entry.method === METHOD_DEFLATE) return inflate(bytes, entry.uncompressedSize)
    throw new ZipFormatError('This archive uses a compression method the reader does not support')
  }

  return {
    entries,
    has: (path) => locate(path) !== undefined,
    read,
    readText: async (path) => new TextDecoder('utf-8', { fatal: false }).decode(await read(path)),
  }
}
