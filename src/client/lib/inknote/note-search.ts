/** Page-text search, replace, highlight, outline and counts for the note tool dialogs. */
import type { InknotePage, InknotePageContent } from '@shared/inknote/types'

export interface PageTextMatch {
  pageId: string
  pageIndex: number
  textId: string
  start: number
  end: number
  snippet: string
}

export interface OutlineEntry {
  pageId: string
  pageIndex: number
  textId: string
  text: string
  /** 1 for a heading (34px and up), 2 for the 26px tier. */
  level: 1 | 2
}

export interface PageTextCounts {
  pages: number
  strokes: number
  texts: number
  images: number
}

const OUTLINE_MIN_SIZE = 26
const OUTLINE_HEADING_SIZE = 34
const OUTLINE_TEXT_MAX = 40
const SNIPPET_RADIUS = 24

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchPattern(query: string): RegExp {
  return new RegExp(escapeRegExp(query), 'gi')
}

function snippetAround(text: string, start: number, end: number): string {
  const from = Math.max(0, start - SNIPPET_RADIUS)
  const to = Math.min(text.length, end + SNIPPET_RADIUS)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

export function findPageText(pages: readonly InknotePage[], query: string): PageTextMatch[] {
  const needle = query.trim()
  if (!needle) return []
  const matches: PageTextMatch[] = []
  pages.forEach((page, pageIndex) => {
    for (const item of page.content.texts) {
      for (const match of item.text.matchAll(matchPattern(needle))) {
        const start = match.index ?? 0
        const end = start + match[0].length
        matches.push({ pageId: page.id, pageIndex, textId: item.id, start, end, snippet: snippetAround(item.text, start, end) })
      }
    }
  })
  return matches
}

export interface ReplaceResult {
  pages: InknotePage[]
  count: number
  changedPageIds: string[]
}

/** Literal, case-insensitive replacement across every text box, one new page object per changed page. */
export function replacePageText(pages: readonly InknotePage[], query: string, replacement: string): ReplaceResult {
  const needle = query.trim()
  if (!needle) return { pages: [...pages], count: 0, changedPageIds: [] }
  const pattern = matchPattern(needle)
  let count = 0
  const changedPageIds: string[] = []
  const next = pages.map((page) => {
    let changed = false
    const texts = page.content.texts.map((item) => {
      const replaced = item.text.replace(pattern, () => { count += 1; return replacement })
      if (replaced === item.text) return item
      changed = true
      return { ...item, text: replaced }
    })
    if (!changed) return page
    changedPageIds.push(page.id)
    return { ...page, content: { ...page.content, texts } }
  })
  return { pages: next, count, changedPageIds }
}

export interface HighlightResult {
  pages: InknotePage[]
  count: number
  changedPageIds: string[]
}

/** Paints every matching text box, or clears every highlight when `color` is null. */
export function highlightPageText(pages: readonly InknotePage[], query: string, color: string | null): HighlightResult {
  const needle = query.trim()
  if (color !== null && !needle) return { pages: [...pages], count: 0, changedPageIds: [] }
  const pattern = color !== null ? matchPattern(needle) : null
  let count = 0
  const changedPageIds: string[] = []
  const next = pages.map((page) => {
    let changed = false
    const texts = page.content.texts.map((item) => {
      const hit = pattern ? new RegExp(pattern.source, pattern.flags).test(item.text) : item.hl !== null
      if (!hit) return item
      changed = true
      count += 1
      return { ...item, hl: color }
    })
    if (!changed) return page
    changedPageIds.push(page.id)
    return { ...page, content: { ...page.content, texts } }
  })
  return { pages: next, count, changedPageIds }
}

export function outlineOfPages(pages: readonly InknotePage[]): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  pages.forEach((page, pageIndex) => {
    for (const item of page.content.texts) {
      if (item.fontSize < OUTLINE_MIN_SIZE) continue
      const text = item.text.trim()
      if (!text) continue
      entries.push({
        pageId: page.id,
        pageIndex,
        textId: item.id,
        text: text.length > OUTLINE_TEXT_MAX ? `${text.slice(0, OUTLINE_TEXT_MAX)}…` : text,
        level: item.fontSize >= OUTLINE_HEADING_SIZE ? 1 : 2,
      })
    }
  })
  return entries
}

export function countsOfPages(pages: readonly InknotePage[]): PageTextCounts {
  return pages.reduce<PageTextCounts>((counts, page) => ({
    pages: counts.pages + 1,
    strokes: counts.strokes + page.content.strokes.length,
    texts: counts.texts + page.content.texts.length,
    images: counts.images + page.content.images.length,
  }), { pages: 0, strokes: 0, texts: 0, images: 0 })
}

/** A page with nothing on it: no strokes, no text, no image and no background. */
export function isEmptyPage(content: InknotePageContent): boolean {
  return content.strokes.length === 0 && content.texts.length === 0 && content.images.length === 0 && content.bg === null
}
