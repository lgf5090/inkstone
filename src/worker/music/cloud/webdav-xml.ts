/**
 * The multistatus XML a WebDAV server answers PROPFIND with.
 *
 * Kept as a small regex reader rather than a DOM or an XML dependency: the only fields the music
 * browser needs are href, collection, length, type and modification time, and a third-party server is
 * allowed to use any namespace prefix. One malformed response block is skipped; it must not fail the
 * whole listing.
 */
export interface WebdavPropfindEntry {
  href: string
  isCollection: boolean
  sizeBytes: number
  mime: string | null
  modifiedAt: number | null
}

export interface WebdavPropfindResult {
  entries: WebdavPropfindEntry[]
  truncated: boolean
}

const RESPONSE_RE = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi
const HREF_RE = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i
const COLLECTION_RE = /<(?:[\w.-]+:)?collection\b[^>]*\/?>/i
const LENGTH_RE = /<(?:[\w.-]+:)?getcontentlength\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?getcontentlength>/i
const TYPE_RE = /<(?:[\w.-]+:)?getcontenttype\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?getcontenttype>/i
const MODIFIED_RE = /<(?:[\w.-]+:)?getlastmodified\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?getlastmodified>/i
const MAX_ENTRIES = 2000
const MAX_CODE_POINT = 0x10ff_ff

function decodeNumericEntity(raw: string, code: string): string {
  const value = Number(code)
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CODE_POINT ? String.fromCodePoint(value) : raw
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, decodeNumericEntity)
    .replace(/&amp;/g, '&')
    .trim()
}

function parseModified(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseMultistatus(xml: string): WebdavPropfindResult {
  const entries: WebdavPropfindEntry[] = []
  RESPONSE_RE.lastIndex = 0
  let match = RESPONSE_RE.exec(xml)
  while (match && entries.length < MAX_ENTRIES) {
    try {
      const block = match[1] ?? ''
      const href = HREF_RE.exec(block)?.[1]
      if (href) {
        const modified = MODIFIED_RE.exec(block)?.[1]
        entries.push({
          href: decodeXmlText(href),
          isCollection: COLLECTION_RE.test(block),
          sizeBytes: Number(LENGTH_RE.exec(block)?.[1] ?? 0) || 0,
          mime: TYPE_RE.exec(block)?.[1] ? decodeXmlText(TYPE_RE.exec(block)![1]!) : null,
          modifiedAt: modified ? parseModified(decodeXmlText(modified)) : null,
        })
      }
    } catch (error) {
      console.warn('[inkstone] webdav multistatus entry skipped:', error)
    }
    match = RESPONSE_RE.exec(xml)
  }
  return { entries, truncated: match !== null }
}

export function decodeHrefPath(href: string): string {
  const withoutOrigin = href.startsWith('http://') || href.startsWith('https://')
    ? new URL(href).pathname
    : href.split(/[?#]/)[0] ?? href
  const segments = withoutOrigin.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  })
  return segments.join('/')
}

const MEDIA_EXTENSION_RE = /\.(?:mp3|m4a|mp4|flac|wav|wave|ogg|oga|opus|aac|webm|mov|m4v)$/i

export function isMediaEntry(entry: Pick<WebdavPropfindEntry, 'href' | 'isCollection' | 'mime'> & Partial<WebdavPropfindEntry>): boolean {
  if (entry.isCollection) return true
  if (entry.mime && /^(?:audio|video)\//i.test(entry.mime)) return true
  return MEDIA_EXTENSION_RE.test(entry.href)
}
