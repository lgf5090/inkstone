/**
 * Keeping a highlight attached to the words it was made on.
 *
 * A stored offset is only useful if the next render puts it back where the reader saw it, and that
 * fails the moment the file is replaced with a corrected edition of the same book. So a highlight also
 * carries its quote and the text on either side of it: the offsets are the fast path, the quote is the
 * recovery, and a highlight that can be recovered nowhere is shown as an orphan rather than silently
 * moved onto different words.
 */
import type { TextIndex } from './text-index'
import type { Highlight } from '../types'

/** How much context is kept on each side — enough to disambiguate a repeated sentence, small enough to not matter. */
export const CONTEXT_CHARS = 24

export interface Anchor {
  quote: string
  prefix: string
  suffix: string
}

export function anchorFrom(index: TextIndex, start: number, end: number): Anchor {
  const from = Math.max(0, Math.min(start, index.text.length))
  const to = Math.max(from, Math.min(end, index.text.length))
  return {
    quote: index.text.slice(from, to),
    prefix: index.text.slice(Math.max(0, from - CONTEXT_CHARS), from),
    suffix: index.text.slice(to, to + CONTEXT_CHARS),
  }
}

export type AnchorState = 'exact' | 'drifted' | 'orphan'

export interface ResolvedAnchor {
  start: number
  end: number
  state: AnchorState
}

/**
 * Where a highlight belongs in the text that is actually on screen.
 *
 * The order is deliberate: trust the offsets when the words agree, then look for the words and prefer
 * the candidate whose surroundings agree, and only then accept a bare match. A wrong position is worse
 * than an orphaned one, because the reader will not notice.
 */
export function resolveAnchor(index: TextIndex, highlight: Pick<Highlight, 'start' | 'end' | 'quote' | 'prefix' | 'suffix'>): ResolvedAnchor {
  const text = index.text
  const direct = { start: highlight.start, end: highlight.end }
  if (highlight.quote && text.slice(direct.start, direct.end) === highlight.quote) {
    return { ...direct, state: 'exact' }
  }
  if (!highlight.quote) return { start: direct.start, end: direct.end, state: 'orphan' }

  const candidates: number[] = []
  let at = text.indexOf(highlight.quote)
  while (at >= 0 && candidates.length < 40) {
    candidates.push(at)
    at = text.indexOf(highlight.quote, at + 1)
  }
  if (!candidates.length) {
    const trimmed = highlight.quote.trim()
    if (trimmed && trimmed !== highlight.quote) {
      const only = text.indexOf(trimmed)
      if (only >= 0) return { start: only, end: only + trimmed.length, state: 'drifted' }
    }
    return { start: direct.start, end: direct.end, state: 'orphan' }
  }
  let best = candidates[0]!
  let bestScore = -1
  for (const candidate of candidates) {
    let score = 0
    if (highlight.prefix && text.slice(Math.max(0, candidate - highlight.prefix.length), candidate) === highlight.prefix) score += 2
    if (highlight.suffix && text.slice(candidate + highlight.quote.length, candidate + highlight.quote.length + highlight.suffix.length) === highlight.suffix) score += 2
    if (candidate === direct.start) score += 3
    else if (Math.abs(candidate - direct.start) < 400) score += 1
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return { start: best, end: best + highlight.quote.length, state: 'drifted' }
}

export interface PaintedMarks {
  /** Every element one highlight produced, in document order. */
  byHighlight: Map<string, HTMLElement[]>
  /** Highlights that could not be placed at all in this chapter. */
  orphaned: string[]
}

/**
 * Wrap the marked ranges in spans.
 *
 * The work is done per text node and in two passes — first deciding the cut points, then replacing the
 * node — because splitting a node while walking the index would invalidate the very offsets being used.
 * Overlapping highlights are stacked rather than merged: the topmost one paints the background, and
 * every id the segment belongs to is recorded on it, so clicking an overlap still offers both.
 */
export function paintHighlights(
  index: TextIndex,
  highlights: readonly Highlight[],
  resolved: Map<string, ResolvedAnchor>,
  paintOf: (highlight: Highlight) => string,
): PaintedMarks {
  const byHighlight = new Map<string, HTMLElement[]>()
  const usable = highlights.flatMap((highlight) => {
    const anchor = resolved.get(highlight.id)
    if (!anchor || anchor.state === 'orphan') return []
    return [{ highlight, start: anchor.start, end: anchor.end }]
  }).filter((one) => one.end > one.start)

  const orphaned = highlights
    .filter((highlight) => {
      const anchor = resolved.get(highlight.id)
      return !anchor || anchor.state === 'orphan'
    })
    .map((highlight) => highlight.id)

  if (!usable.length) return { byHighlight, orphaned }

  for (let nodeIndex = 0; nodeIndex < index.nodes.length; nodeIndex++) {
    const node = index.nodes[nodeIndex]!
    const nodeStart = index.starts[nodeIndex]!
    const value = node.nodeValue ?? ''
    const nodeEnd = nodeStart + value.length
    const overlapping = usable.filter((one) => one.start < nodeEnd && one.end > nodeStart)
    if (!overlapping.length) continue

    const cuts = new Set<number>([nodeStart, nodeEnd])
    for (const one of overlapping) {
      if (one.start > nodeStart && one.start < nodeEnd) cuts.add(one.start)
      if (one.end > nodeStart && one.end < nodeEnd) cuts.add(one.end)
    }
    const points = [...cuts].sort((a, b) => a - b)
    const fragment = document.createDocumentFragment()

    for (let at = 0; at < points.length - 1; at++) {
      const from = points[at]!
      const to = points[at + 1]!
      const text = value.slice(from - nodeStart, to - nodeStart)
      const covering = overlapping.filter((one) => one.start <= from && one.end >= to)
      if (!covering.length) {
        fragment.appendChild(document.createTextNode(text))
        continue
      }
      const span = document.createElement('span')
      span.className = 'reader-mark'
      const top = covering[covering.length - 1]!
      span.style.setProperty('--reader-mark', paintOf(top.highlight))
      span.dataset.hl = covering.map((one) => one.highlight.id).join(' ')
      for (const one of covering) {
        if (one.highlight.comment.trim()) span.dataset.hasComment = 'true'
        const list = byHighlight.get(one.highlight.id) ?? []
        list.push(span)
        byHighlight.set(one.highlight.id, list)
      }
      span.textContent = text
      fragment.appendChild(span)
    }
    node.parentNode?.replaceChild(fragment, node)
  }

  return { byHighlight, orphaned }
}

/** The colours a note and a page both have to agree on. */
export function highlightPaint(color: string, paints: Record<string, string>): string {
  return paints[color] ?? paints.yellow!
}
