/**
 * A small LRU of blob URLs for archive pages.
 *
 * The loader does the format-specific reading; this class only owns the URLs. Equal paths share one
 * in-flight read, and clearing the cache invalidates reads that have not finished so a late result can
 * never leave a blob URL behind.
 */
export type PageUrlLoader = (path: string) => Promise<Blob>

interface PendingPage {
  promise: Promise<string>
  cancelled: boolean
}

export class PageUrlCache {
  readonly limit: number
  private readonly urls = new Map<string, string>()
  private readonly pending = new Map<string, PendingPage>()

  constructor(private readonly loadBlob: PageUrlLoader, limit = 6) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Page URL cache limit must be a positive integer')
    this.limit = limit
  }

  load(path: string): Promise<string> {
    const cached = this.urls.get(path)
    if (cached) {
      this.urls.delete(path)
      this.urls.set(path, cached)
      return Promise.resolve(cached)
    }
    const existing = this.pending.get(path)
    if (existing) return existing.promise

    const entry: PendingPage = { cancelled: false, promise: Promise.resolve('') }
    entry.promise = this.loadBlob(path).then((blob) => {
      if (entry.cancelled) {
        const url = URL.createObjectURL(blob)
        URL.revokeObjectURL(url)
        throw new Error('Page URL cache was cleared before the page finished loading')
      }
      const url = URL.createObjectURL(blob)
      while (this.urls.size >= this.limit) {
        const oldest = this.urls.keys().next().value as string | undefined
        if (oldest === undefined) break
        const url = this.urls.get(oldest) ?? ''
        this.urls.delete(oldest)
        URL.revokeObjectURL(url)
      }
      this.urls.set(path, url)
      return url
    }).finally(() => {
      if (this.pending.get(path) === entry) this.pending.delete(path)
    })
    this.pending.set(path, entry)
    return entry.promise
  }

  /** Forget one page, including a read that has not produced its URL yet. */
  revoke(path: string): void {
    const url = this.urls.get(path)
    if (url !== undefined) {
      this.urls.delete(path)
      URL.revokeObjectURL(url)
    }
    const entry = this.pending.get(path)
    if (entry) {
      entry.cancelled = true
      this.pending.delete(path)
    }
  }

  /** Release every URL and invalidate every outstanding read. The cache remains reusable. */
  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
    for (const entry of this.pending.values()) entry.cancelled = true
    this.pending.clear()
  }
}
