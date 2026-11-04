/**
 * Reading the files a comparison is made of.
 *
 * A text side is decoded in chunks through `TextDecoderStream`, so a 20 MB file reports progress
 * instead of freezing the page while one `file.text()` resolves. The encoding is decided once from
 * a 64 KB sample; when even that cannot be settled the caller is told, rather than handed mojibake.
 */
import { detectEncoding, looksBinary, type TextEncoding } from '@shared/tools/compare/encoding'
import type { DirEntry, DirManifest } from '@shared/tools/compare/types'

export class UnreadableTextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnreadableTextError'
  }
}

export interface DecodedText {
  text: string
  encoding: TextEncoding
  bytes: number
  /** True when the file looks binary; the text side is then refused rather than guessed. */
  binary: boolean
}

/** Decides the decoder from a sample of the file itself. */
export async function detectFileEncoding(file: File): Promise<TextEncoding | null> {
  const sample = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())
  return detectEncoding(sample).encoding
}

export async function fileLooksBinary(file: File): Promise<boolean> {
  return looksBinary(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()))
}

export async function decodeFile(
  file: File,
  encoding: TextEncoding | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DecodedText> {
  const chosen = encoding ?? await detectFileEncoding(file)
  if (!chosen) throw new UnreadableTextError('unknown-encoding')
  if (await fileLooksBinary(file) && !chosen.startsWith('utf-16')) throw new UnreadableTextError('binary')

  const total = file.size
  let text = ''
  const stream = file.stream()
  const reader = stream.getReader()
  const decoder = new TextDecoder(chosen, { fatal: true })
  let loaded = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      loaded += value.byteLength
      text += decoder.decode(value, { stream: true })
      onProgress?.(loaded, total)
    }
    text += decoder.decode()
  } catch (error) {
    throw new UnreadableTextError(error instanceof Error ? error.message : 'decode-failed')
  } finally {
    reader.releaseLock()
  }
  return { text, encoding: chosen, bytes: total, binary: false }
}

export async function sha256Hex(input: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const DIRECTORY_LIMITS = {
  entries: 4_000,
  totalBytes: 200 * 1024 * 1024,
  singleFileBytes: 32 * 1024 * 1024,
} as const

export interface ManifestProgress {
  files: number
  bytes: number
  label: string
}

/** Builds a manifest from the flat file list a directory picker hands back. */
export async function manifestFromFiles(
  files: readonly File[],
  root: string,
  onProgress?: (progress: ManifestProgress) => void,
): Promise<DirManifest> {
  return buildManifest(
    files.map((file) => ({
      file,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    })),
    root,
    onProgress,
  )
}

/** Builds a manifest from a dropped directory, walking its entries. */
export async function manifestFromEntry(
  entry: FileSystemEntry,
  onProgress?: (progress: ManifestProgress) => void,
): Promise<DirManifest> {
  const files: Array<{ file: File, path: string }> = []
  const walk = async (current: FileSystemEntry, prefix: string): Promise<void> => {
    if (files.length > DIRECTORY_LIMITS.entries) throw new Error('too-many-files')
    if (current.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (current as FileSystemFileEntry).file(resolve, reject)
      })
      files.push({ file, path: `${prefix}${file.name}` })
      return
    }
    if (!current.isDirectory) return
    const reader = (current as FileSystemDirectoryEntry).createReader()
    const readBatch = (): Promise<FileSystemEntry[]> => new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    const children: FileSystemEntry[] = []
    while (true) {
      const batch = await readBatch()
      if (!batch.length) break
      children.push(...batch)
    }
    for (const child of children) await walk(child, `${prefix}${current.name}/`)
  }
  await walk(entry, '')
  return buildManifest(files, entry.name, onProgress)
}

async function buildManifest(
  files: readonly { file: File, path: string }[],
  root: string,
  onProgress?: (progress: ManifestProgress) => void,
): Promise<DirManifest> {
  if (files.length > DIRECTORY_LIMITS.entries) throw new Error('too-many-files')
  const entries: DirEntry[] = []
  let hashed = 0
  for (const item of files) {
    if (item.file.size > DIRECTORY_LIMITS.singleFileBytes) continue
    if (hashed + item.file.size > DIRECTORY_LIMITS.totalBytes) throw new Error('too-much-data')
    const bytes = new Uint8Array(await item.file.arrayBuffer())
    hashed += bytes.byteLength
    const path = item.path.replace(/\\/g, '/').replace(/^\/+/, '')
    entries.push({ path, size: item.file.size, sha256: await sha256Hex(bytes) })
    onProgress?.({ files: entries.length, bytes: hashed, label: path })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { root, entries }
}
