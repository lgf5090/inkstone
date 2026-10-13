/**
 * Opening one book.
 *
 * Parsing an archive's directory and its package document costs tens of milliseconds on a large book,
 * which is long enough to feel like a hang when a reader goes back to the shelf and returns. So the
 * parsed archive is kept for the session — the blob URLs a chapter mints are not, because those belong
 * to a mounted view and would leak the moment the reader closed the book.
 */
import { useEffect, useState } from 'react'
import type { ZipArchive } from '../engine/zip'
import { openZip } from '../engine/zip'
import type { EpubPackage } from '../engine/epub-package'
import { parseEpubPackage } from '../engine/epub-package'
import { createResourcePool, type PreparedChapter, type ResourcePool, prepareChapter } from '../engine/chapter'
import { readBookBlob } from '../store/library'
import { useSession } from '../../../store/session'
import type { BookRecord } from '../types'

export interface EpubHandle {
  kind: 'epub'
  archive: ZipArchive
  pkg: EpubPackage
  pool: ResourcePool
  prepare: (slot: number) => Promise<PreparedChapter | null>
}

const cache = new Map<string, Promise<{ archive: ZipArchive; pkg: EpubPackage }>>()

async function openEpub(bytes: Uint8Array): Promise<{ archive: ZipArchive; pkg: EpubPackage }> {
  const archive = await openZip(bytes)
  return { archive, pkg: await parseEpubPackage(archive) }
}

/**
 * The handle a reader draws pages from, or an error string to show.
 *
 * `null` while loading is deliberate: the caller renders a quiet placeholder rather than a spinner that
 * would flash for the majority of books, which open in well under a frame budget.
 */
export function useEpubHandle(book: BookRecord | null): { handle: EpubHandle | null; error: string | null } {
  const userId = useSession((state) => state.user?.id ?? null)
  const [handle, setHandle] = useState<EpubHandle | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!book) return
    if (book.format !== 'epub') {
      setError('unsupported')
      return
    }
    let cancelled = false
    let pool: ResourcePool | null = null
    setError(null)
    setHandle(null)
    void (async () => {
      const cached = cache.get(book.id)
      const opened = cached ?? (async () => {
        const blob = await readBookBlob(userId, book.id)
        if (!blob) throw new Error('missing')
        return openEpub(new Uint8Array(await blob.arrayBuffer()))
      })()
      if (!cached) cache.set(book.id, opened)
      try {
        const { archive, pkg } = await opened
        if (cancelled) return
        const created = createResourcePool(archive, pkg)
        pool = created
        setHandle({
          kind: 'epub',
          archive,
          pkg,
          pool: created,
          prepare: (slot) => prepareChapter({ pkg, archive, pool: created }, slot, READER_SCOPE),
        })
      } catch (err) {
        if (!cached) cache.delete(book.id)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
      // The archive is shared through the cache, but its blob URLs are not: leaving them would keep
      // every picture of every book this tab has opened alive until the tab closes.
      pool?.revokeAll()
    }
  }, [book, userId])

  return { handle, error }
}

/** The selector a chapter's own stylesheet is confined to. */
export const READER_SCOPE = '.reader-doc'

/** Forget a cached archive, which is what a deleted book needs so its bytes can be collected. */
export function dropBookHandle(bookId: string): void {
  cache.delete(bookId)
}
