/**
 * Finding a word in a book.
 *
 * The index is the prose of every chapter, read once and kept for the session. That is a real cost —
 * a thousand-page book takes a second or two to walk — so it is paid lazily: the first query builds it
 * in the background and reports progress, and every later query is instant. A reader searching for a
 * name in a novel is asking a question the whole book has to answer, so there is no useful partial
 * index.
 */
import type { EpubHandle } from '../reader/useEpubHandle'

export interface SearchHit {
  chapter: number
  /** Offset into that chapter's text, which is what a jump needs. */
  offset: number
  length: number
  before: string
  match: string
  after: string
}

export interface SearchProgress {
  done: number
  total: number
}

const caches = new WeakMap<EpubHandle, Map<number, string>>()

function textCache(handle: EpubHandle): Map<number, string> {
  let cached = caches.get(handle)
  if (!cached) {
    cached = new Map()
    caches.set(handle, cached)
  }
  return cached
}

/** The plain prose of one chapter, without markup, styles or the image references a page needs. */
export async function chapterText(handle: EpubHandle, slot: number): Promise<string> {
  const cache = textCache(handle)
  const known = cache.get(slot)
  if (known !== undefined) return known
  const item = handle.pkg.spine[slot]
  if (!item) return ''
  let raw = ''
  try {
    raw = await handle.archive.readText(item.item.href)
  } catch {
    cache.set(slot, '')
    return ''
  }
  const parsed = new DOMParser().parseFromString(raw, 'text/html')
  for (const node of Array.from(parsed.querySelectorAll('script,style'))) node.remove()
  const text = parsed.body?.textContent ?? ''
  cache.set(slot, text)
  return text
}

export function normalizeForSearch(value: string): string {
  return value.toLowerCase()
}

/**
 * Every occurrence of a phrase, in reading order, capped so a one-character query cannot lock the tab.
 *
 * Matching is case-folded but otherwise literal. Unsegmented scripts are the reason: a reader typing a
 * few characters of a name expects the substring, not a word boundary.
 */
export async function searchBook(
  handle: EpubHandle,
  query: string,
  limit = 400,
  onProgress?: (progress: SearchProgress) => void,
): Promise<SearchHit[]> {
  const needle = normalizeForSearch(query.trim())
  if (!needle) return []
  const hits: SearchHit[] = []
  const total = handle.pkg.spine.length
  for (let slot = 0; slot < total; slot++) {
    const text = await chapterText(handle, slot)
    const folded = normalizeForSearch(text)
    let at = folded.indexOf(needle)
    while (at >= 0) {
      hits.push({
        chapter: slot,
        offset: at,
        length: needle.length,
        before: text.slice(Math.max(0, at - 24), at),
        match: text.slice(at, at + needle.length),
        after: text.slice(at + needle.length, at + needle.length + 32),
      })
      if (hits.length >= limit) return hits
      at = folded.indexOf(needle, at + needle.length)
    }
    onProgress?.({ done: slot + 1, total })
    // The walk yields every chapter so a long book leaves the main thread free to paint the page the
    // reader is still looking at.
    if (slot % 4 === 3) await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
  return hits
}
