/**
 * Taking a file a reader hands over and turning it into a book on the shelf.
 *
 * The format is decided by what the bytes say, never by the extension: a `.zip` renamed to `.epub`
 * and a `.cbz` that is really an EPUB are both things people do, and the reader's job is to sort them
 * out rather than to complain. Everything the shelf will show — title, author, cover, chapter list —
 * is read here once, at import, so the shelf never has to open a 40 MB archive to paint a grid.
 */
import type { ZipArchive } from './zip'
import { openZip } from './zip'
import { parseEpubPackage, spineIndexFor, type EpubPackage } from './epub-package'
import type { BookRecord, TocEntry } from '../types'
import { MAX_BOOK_BYTES } from '../types'
import { randomLocalId } from '../../../lib/random-id'

export class ImportRejected extends Error {
  constructor(readonly reason: 'format' | 'size' | 'corrupt', message?: string) {
    super(message ?? `This file could not be read as a book (${reason})`)
  }
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]
const IMAGE_TYPE = /^image\//

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((value, index) => bytes[index] === value)
}

const IMAGE_EXTENSION_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
}

function pkgMediaType(name: string): string {
  return IMAGE_EXTENSION_MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? ''
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]
const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38]
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50]

/**
 * What a cover actually is, read off its bytes.
 *
 * The shelf hands this to R2 as the stored content type, so guessing it from a name would put JPEG bytes
 * behind a `.png` key and a second device would fetch an image whose header contradicts its own type.
 * An EPUB's cover href is often extensionless anyway, so the name is only the fallback.
 */
export function coverMediaType(cover: Uint8Array | null, name: string | null): string {
  if (!cover) return ''
  if (startsWith(cover, PNG_MAGIC)) return 'image/png'
  if (startsWith(cover, JPEG_MAGIC)) return 'image/jpeg'
  if (startsWith(cover, GIF_MAGIC)) return 'image/gif'
  if (startsWith(cover, RIFF_MAGIC) && startsWith(cover.subarray(8), WEBP_TAG)) return 'image/webp'
  return name ? pkgMediaType(name) : ''
}

/** Cheap enough to run on every dropped file before the bytes are read. */
export function hasBookExtension(filename: string): boolean {
  return /\.(epub|pdf|cbz)$/i.test(filename)
}

/** Strip the extension a reader named a file with, which is the fallback title's only source. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/[.][a-z0-9]{1,8}$/i, '')
  return base.replace(/[_]+/g, ' ').trim() || filename
}

function tocFromPackage(pkg: EpubPackage): TocEntry[] {
  return pkg.toc.map((entry) => {
    const slot = spineIndexFor(pkg, entry.href)
    if (slot < 0) return { label: entry.label, position: null, level: entry.level }
    return {
      label: entry.label,
      position: { kind: 'epub' as const, chapter: slot, offset: 0 },
      level: entry.level,
    }
  })
}

async function readEpub(file: File, archive: ZipArchive): Promise<{ record: BookRecord; cover: Uint8Array | null; coverType: string }> {
  let pkg: EpubPackage
  try {
    pkg = await parseEpubPackage(archive)
  } catch (err) {
    throw new ImportRejected('format', err instanceof Error ? err.message : undefined)
  }
  const fallback = titleFromFilename(file.name)
  let cover: Uint8Array | null = null
  if (pkg.coverHref) {
    cover = await archive.read(pkg.coverHref).catch(() => null)
  }
  return {
    record: {
      id: randomLocalId('book'),
      format: 'epub',
      title: pkg.metadata.title.trim() || fallback,
      author: pkg.metadata.creator.trim(),
      language: pkg.metadata.language.trim(),
      publisher: pkg.metadata.publisher.trim(),
      filename: file.name,
      size: file.size,
      addedAt: Date.now(),
      unitCount: pkg.spine.length,
      coverPath: pkg.coverHref,
      toc: tocFromPackage(pkg),
    },
    cover,
    coverType: coverMediaType(cover, pkg.coverHref),
  }
}

/** A ZIP of pictures is a comic; a ZIP of anything else is not a book this reader can open. */
async function readCbz(file: File, archive: ZipArchive): Promise<{ record: BookRecord; cover: Uint8Array | null; coverType: string }> {
  const pages = archive.entries.filter((member) => !member.name.endsWith('/') && (
    IMAGE_TYPE.test(pkgMediaType(member.name)) || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(member.name)
  ))
  if (!pages.length) throw new ImportRejected('format')
  const sorted = pages.slice().sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  const first = sorted[0]
  const cover = first ? await archive.read(first.name).catch(() => null) : null
  return {
    record: {
      id: randomLocalId('book'),
      format: 'cbz',
      title: titleFromFilename(file.name),
      author: '',
      language: '',
      publisher: '',
      filename: file.name,
      size: file.size,
      addedAt: Date.now(),
      unitCount: sorted.length,
      coverPath: first?.name ?? null,
      // A comic has no table of contents, but its frame names are the only labels that tell two pages
      // apart, so the page list doubles as one.
      toc: sorted.map((member, index) => ({
        label: member.name.split('/').pop() ?? `${index + 1}`,
        position: { kind: 'fixed' as const, page: index + 1 },
        level: 0,
      })),
    },
    cover,
    coverType: coverMediaType(cover, first?.name ?? null),
  }
}

async function readPdf(file: File, bytes: Uint8Array): Promise<{ record: BookRecord; cover: Uint8Array | null; coverType: string }> {
  const { openPdfDocument, readPdfSummary, renderPdfThumbnail } = await import('./pdf')
  let opened: Awaited<ReturnType<typeof openPdfDocument>>
  try {
    // PDF.js hands the buffer to its worker, which detaches it from this thread. The caller still has
    // to store those bytes, so it gets a copy to give away.
    opened = await openPdfDocument(bytes.slice())
  } catch (err) {
    throw new ImportRejected('corrupt', err instanceof Error ? err.message : undefined)
  }
  try {
    const summary = await readPdfSummary(opened.document, titleFromFilename(file.name))
    const cover = await renderPdfThumbnail(opened.document)
    return {
      record: {
        id: randomLocalId('book'),
        format: 'pdf',
        title: summary.title,
        author: summary.author,
        language: '',
        publisher: '',
        filename: file.name,
        size: file.size,
        addedAt: Date.now(),
        unitCount: summary.pages,
        coverPath: null,
        toc: summary.outline.map((entry) => ({
          label: entry.title,
          position: entry.page ? { kind: 'fixed' as const, page: entry.page } : null,
          level: entry.level,
        })),
      },
      cover,
      coverType: coverMediaType(cover, null),
    }
  } finally {
    await opened.destroy()
  }
}

export interface ImportedImage {
  record: BookRecord
  cover: Uint8Array | null
  /** What the cover bytes really are, which is the type the shelf keeps and uploads them as. */
  coverType: string
  bytes: Uint8Array
}

/** Read one file into a shelf record, a cover and the bytes to keep. */
export async function importBook(file: File): Promise<ImportedImage> {
  if (file.size > MAX_BOOK_BYTES) throw new ImportRejected('size')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!bytes.byteLength) throw new ImportRejected('corrupt')
  if (startsWith(bytes, PDF_MAGIC)) {
    const read = await readPdf(file, bytes)
    return { ...read, bytes }
  }
  if (!startsWith(bytes, ZIP_MAGIC)) throw new ImportRejected('format')
  let archive: ZipArchive
  try {
    archive = await openZip(bytes)
  } catch {
    throw new ImportRejected('corrupt')
  }
  const read = archive.has('META-INF/container.xml')
    ? await readEpub(file, archive)
    : await readCbz(file, archive)
  return { ...read, bytes }
}
