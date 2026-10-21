import { MEMO_LINK_METADATA_BATCH_MAX, MEMO_LINK_METADATA_TTL_MS } from '@shared/memos/constants'
import type { MemoLinkMetadata } from '@shared/memos/types'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { outbound } from '../lib/outbound'

const FETCH_TIMEOUT_MS = 8_000
const FETCH_MAX_BYTES = 256 * 1024
const FETCH_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
const TITLE_MAX_LENGTH = 300
const DESCRIPTION_MAX_LENGTH = 1_000

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  minus: '\u2212',
  deg: '\u00b0',
  micro: '\u00b5',
  middot: '\u00b7',
  bull: '\u2022',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
}

interface CachedMetadataRow {
  url_hash: string
  title: string
  description: string
  image: string
  fetched_at: number
}

function decodeCodePoint(value: number, source: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return source
  if (value >= 0xd800 && value <= 0xdfff) return source
  return String.fromCodePoint(value)
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g,
    (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal) return decodeCodePoint(Number(decimal), match)
      if (hex) return decodeCodePoint(Number.parseInt(hex, 16), match)
      return NAMED_ENTITIES[(name ?? '').toLowerCase()] ?? match
    },
  )
}

function cleanText(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeHttpUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  url.hash = ''
  return url.toString()
}

export function parseMemoLinkUrls(value: unknown): string[] {
  if (!Array.isArray(value)) throw ApiError.badRequest('urls must be an array')
  if (value.length > MEMO_LINK_METADATA_BATCH_MAX) {
    throw ApiError.badRequest(`urls cannot contain more than ${MEMO_LINK_METADATA_BATCH_MAX} entries`)
  }
  const seen = new Set<string>()
  const urls: string[] = []
  value.forEach((entry, index) => {
    if (typeof entry !== 'string') throw ApiError.badRequest(`urls[${index}] must be a string`)
    const url = normalizeHttpUrl(entry)
    if (!url) {
      throw ApiError.badRequest(`urls[${index}] must be an absolute http or https URL without credentials`)
    }
    if (seen.has(url)) return
    seen.add(url)
    urls.push(url)
  })
  return urls
}

function readAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  for (const match of tag.matchAll(pattern)) {
    const name = match[1]?.toLowerCase()
    if (!name || attributes.has(name)) continue
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attributes
}

function readMetaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const match of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = readAttributes(match[0])
    const key = (attributes.get('property') ?? attributes.get('name') ?? '').trim().toLowerCase()
    const content = attributes.get('content')
    if (!key || content === undefined || tags.has(key)) continue
    tags.set(key, content)
  }
  return tags
}

function readableHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
}

function resolveImage(raw: string, base: string): string {
  const value = decodeEntities(raw).trim()
  if (!value) return ''
  let image: URL
  try {
    image = new URL(value, base)
  } catch {
    return ''
  }
  if (image.protocol !== 'http:' && image.protocol !== 'https:') return ''
  if (image.username || image.password) return ''
  image.hash = ''
  return image.toString()
}

function parseLinkMetadata(html: string, url: string): MemoLinkMetadata {
  const document = readableHtml(html)
  const tags = readMetaTags(document)
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(document)?.[1] ?? ''
  return {
    url,
    title: (cleanText(tags.get('og:title') ?? '') || cleanText(titleTag)).slice(0, TITLE_MAX_LENGTH),
    description: (
      cleanText(tags.get('og:description') ?? '') || cleanText(tags.get('description') ?? '')
    ).slice(0, DESCRIPTION_MAX_LENGTH),
    image: resolveImage(tags.get('og:image') ?? '', url),
  }
}

async function readPageMetadata(url: string): Promise<MemoLinkMetadata | null> {
  const response = await outbound(url, {
    method: 'GET',
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: FETCH_MAX_BYTES,
    headers: { Accept: FETCH_ACCEPT },
  })
  if (!response.ok) return null
  return parseLinkMetadata(response.text, url)
}

function isFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt * 1000 < MEMO_LINK_METADATA_TTL_MS
}

async function readCache(
  db: D1Database,
  hashes: readonly string[],
): Promise<Map<string, CachedMetadataRow>> {
  const placeholders = hashes.map((_, index) => `?${index + 1}`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT url_hash, title, description, image, fetched_at
         FROM memos_link_metadata
        WHERE url_hash IN (${placeholders})`,
    )
    .bind(...hashes)
    .all<CachedMetadataRow>()
  return new Map(results.map((row) => [row.url_hash, row]))
}

async function writeCache(
  db: D1Database,
  hash: string,
  metadata: MemoLinkMetadata,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memos_link_metadata (url_hash, url, title, description, image, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(url_hash) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         description = excluded.description,
         image = excluded.image,
         fetched_at = excluded.fetched_at`,
    )
    .bind(
      hash,
      metadata.url,
      metadata.title,
      metadata.description,
      metadata.image,
      Math.floor(now / 1000),
    )
    .run()
}

export async function fetchMemoLinkMetadata(
  db: D1Database,
  urls: readonly string[],
): Promise<MemoLinkMetadata[]> {
  const unique = [...new Set(urls)]
  if (unique.length === 0) return []
  const hashes = await Promise.all(unique.map((url) => sha256Hex(url)))
  const cached = await readCache(db, hashes)
  const now = Date.now()
  const results: MemoLinkMetadata[] = new Array(unique.length)
  const pending: Array<{ index: number; url: string; hash: string }> = []

  unique.forEach((url, index) => {
    const hash = hashes[index]
    const row = hash ? cached.get(hash) : undefined
    if (row && isFresh(row.fetched_at, now)) {
      results[index] = { url, title: row.title, description: row.description, image: row.image }
      return
    }
    pending.push({ index, url, hash: hash ?? '' })
  })

  const pages = await Promise.all(pending.map((entry) => readPageMetadata(entry.url)))
  for (const [position, page] of pages.entries()) {
    const entry = pending[position]
    if (!entry) continue
    results[entry.index] = page ?? { url: entry.url, title: '', description: '', image: '' }
    if (page) await writeCache(db, entry.hash, page, now)
  }
  return results
}
