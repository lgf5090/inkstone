// One slide page drawn small, shared by every surface that shows the deck at a glance: the
// sidebar list and the overview grid. It lives here because the two must not disagree about how
// a page is sliced, scaled and labelled — and because the viewport gate that keeps a long deck
// from rendering every page at once is a single observer both of them share.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from 'react'
import type { ProseFont } from '@shared/types'
import { cn } from '../../lib/cn'
import { useSession } from '../../store/session'
import type { RailEntry } from './presentation-state'
import { describeDeckPosition } from './deck-position'
import { readSlideHtml, renderSlideSource, slicePageHtml, slideMarkup, slideSettingFlags, stagedFor, subscribeSlideHtmlKey, type SlideMarkup } from './slide-html'
import type { SlidePlan } from './slide-pagination'
import type { SlideLayout } from './slides'
import { SlideProse } from './slide-prose'
import { SLIDE_PAD_X, SLIDE_PAD_Y } from './slide-stage'

const THUMB_PREFETCH_MARGIN = '320px'

export interface ThumbMetrics {
  width: number
  height: number
  scale: number
  contentWidth: number
  contentHeight: number
}

export interface ThumbView {
  thumb: ThumbMetrics
  designWidth: number
  designHeight: number
  proseFont: ProseFont
}

// The thumbnail is the design canvas at a fraction of its size, so it carries the slide's real
// layout rather than a re-typeset approximation of it; the content box has to shrink by the same
// padding the projector gives the page, or a sliced page would not match what was measured.
export function thumbMetrics(width: number, designWidth: number, designHeight: number): ThumbMetrics {
  const scale = width / designWidth
  return {
    width,
    height: designHeight * scale,
    scale,
    contentWidth: designWidth - SLIDE_PAD_X * 2,
    contentHeight: designHeight - SLIDE_PAD_Y * 2,
  }
}

// The view every card of one surface shares: the scale it draws at, the design canvas it is a
// picture of, and the typography that decides what the markup looks like. A memo because a card
// re-renders per page, and a new object each time would re-render the markup of every one of them.
export function useThumbView({ thumbWidth, designWidth, designHeight, proseFont }: {
  thumbWidth: number
  designWidth: number
  designHeight: number
  proseFont: ProseFont
}): ThumbView {
  return useMemo(
    () => ({ thumb: thumbMetrics(thumbWidth, designWidth, designHeight), designWidth, designHeight, proseFont }),
    [thumbWidth, designWidth, designHeight, proseFont],
  )
}

// A page's label has to name the slide as well: both lists are pages, and a presenter
// jumping to "page 3 of 14" still needs to know which `---` slide it belongs to. The wording is the
// one the show's own announcement uses, so the pill, the chip and this list cannot drift apart.
export function pageLabel(entry: RailEntry, deckLength: number): string {
  return describeDeckPosition({ index: entry.slide, count: deckLength, subPage: entry.sub, pageCount: entry.pageCount })
}

export function extractSlideHeading(source: string): string {
  const lines = source.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed)
    if (headingMatch?.[1]) {
      return headingMatch[1].trim()
    }
  }
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (trimmed && !trimmed.startsWith('<!--') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 30)
    }
  }
  return ''
}

// Thumbnails render from the same cached markup the canvas measured, so a page's image matches
// what the projector shows for it; the slice keeps one page's blocks per entry instead of
// mounting the whole slide once per page.
/**
 * Which markup a card actually drew, stated out loud.
 *
 * A thumbnail that shows a slide's placeholders reads exactly like a slide whose diagrams failed to
 * draw, and the only difference is where its markup came from. So the card names its own source: the
 * five states are the five things a reader could otherwise only guess at, and a red that carries them
 * says which one to go looking for.
 */
export type ThumbDraw = 'drawn' | 'undrawn' | 'uncaptured' | 'failed' | 'plain'

// `prepared` and `drawn` are two answers: the first says the enhancement chain ran over the page, the
// second says a canvas then drew its mermaid and its chart into the markup the list paints. A card on
// `undrawn` is showing exactly what a failed page shows, which is why the card has to say which it is.
export function thumbDrawOf(cached: SlideMarkup | undefined): ThumbDraw {
  if (!cached) return 'plain'
  if (cached.failed) return 'failed'
  if (!cached.prepared) return 'uncaptured'
  return cached.drawn ? 'drawn' : 'undrawn'
}

export function usePageHtml({ near, cacheKey, cached, source, plan, sub, view }: {
  near: boolean
  cacheKey: string
  cached: SlideMarkup | undefined
  source: string
  plan: SlidePlan | undefined
  sub: number
  view: ThumbView
}): { html: string; layout: SlideLayout | undefined; drawn: ThumbDraw } {
  return useMemo(() => {
    // `drawn` describes where the markup comes from, whether or not this card is close enough to
    // paint: a far-off card still holds the entry it would draw from.
    const drawn = thumbDrawOf(cached)
    if (!near) return { html: '', layout: undefined, drawn }
    const markup = cached ?? slideMarkup(renderSlideSource(source))
    const html = plan ? slicePageHtml(markup.html, plan, sub, view.thumb.contentWidth, view.thumb.contentHeight) : markup.html
    // The card draws the layout the canvas measured the page in, not the one the author asked for:
    // a column slide the projector refused to keep as columns would slice its pages out of a
    // geometry the projector never used. A measured plan answers even when it says nothing — only a
    // slide nobody has measured yet is drawn on its author's word.
    return { html, layout: plan ? plan.layout : markup.layout, drawn }
  }, [near, cacheKey, cached, source, plan, sub, view])
}

// Follows the prepared markup rather than reading it once: a theme flip or an edit replaces a
// slide's markup under a card, and a single read left that card on an un-rendered placeholder
// for the rest of the show. An entry prepared under the account's *other* settings is not this card's
// page either — the cache key cannot say, so the entry does (L-16).
export function useCachedSlideHtml(cacheKey: string): SlideMarkup | undefined {
  const flags = slideSettingFlags(useSession((s) => s.settings.preview))
  const subscribe = useCallback((cb: () => void) => subscribeSlideHtmlKey(cacheKey, cb), [cacheKey])
  return useSyncExternalStore(subscribe, () => stagedFor(readSlideHtml(cacheKey), flags), () => undefined)
}

export function SlideThumb({ thumbRef, near, html, layout, drawn, active, view, className }: {
  thumbRef: RefObject<HTMLSpanElement | null>
  near: boolean
  html: string
  layout: SlideLayout | undefined
  drawn: ThumbDraw
  active: boolean
  view: ThumbView
  className?: string
}) {
  return (
    <span
      ref={thumbRef}
      aria-hidden='true'
      // The preview is decorative: `inert` keeps the slide's own links and copy buttons out of
      // the tab order and out of the wrapping card's hit area.
      inert
      data-slide-thumb-draw={near ? drawn : undefined}
      className={cn('ink-slide-thumb relative block shrink-0 overflow-hidden rounded-[var(--r-sm)] border bg-[var(--bg-editor)]', active ? 'border-[var(--accent)]' : 'border-[var(--border-subtle)]', className)}
      style={{ width: view.thumb.width, height: view.thumb.height }}
    >
      {near && (
        <span className='ink-slide absolute top-0 left-0 block' style={{ width: view.designWidth, height: view.designHeight, transform: `scale(${view.thumb.scale})`, transformOrigin: 'top left' }}>
          <span className='absolute inset-x-0 block' style={{ top: SLIDE_PAD_Y }}>
            <SlideProse html={html} contentWidth={view.thumb.contentWidth} contentHeight={view.thumb.contentHeight} font={view.proseFont} layout={layout} />
          </span>
        </span>
      )}
    </span>
  )
}

// One observer for every card on screen, rather than one per page of the deck: a hundred-slide
// note used to register a hundred listeners whose callbacks all fired in the same task.
export type ObserverCallback = (isIntersecting: boolean) => void

interface RootObserverRecord {
  observer: IntersectionObserver
  callbacks: Map<Element, ObserverCallback>
}

const observersByRoot = new Map<Element | null, RootObserverRecord>()
let sharedObserverCreatedCount = 0

function getObserverForRoot(root: Element | null): RootObserverRecord {
  let record = observersByRoot.get(root)
  if (!record) {
    sharedObserverCreatedCount += 1
    const callbacks = new Map<Element, ObserverCallback>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const cb = callbacks.get(entry.target)
        if (cb) cb(entry.isIntersecting)
      }
    }, { root, rootMargin: THUMB_PREFETCH_MARGIN })
    record = { observer, callbacks }
    observersByRoot.set(root, record)
  }
  return record
}

export function observeThumbElement(element: Element, callback: ObserverCallback, root: Element | null = null): () => void {
  const record = getObserverForRoot(root)
  record.callbacks.set(element, callback)
  record.observer.observe(element)
  return () => {
    record.callbacks.delete(element)
    record.observer.unobserve(element)
    if (record.callbacks.size === 0) {
      record.observer.disconnect()
      observersByRoot.delete(root)
    }
  }
}

export function sharedThumbObserverMetrics(root: Element | null = null): { created: number; connected: boolean; subscribers: number; roots: number } {
  const record = observersByRoot.get(root)
  return {
    created: sharedObserverCreatedCount,
    connected: record !== undefined,
    subscribers: record ? record.callbacks.size : 0,
    roots: observersByRoot.size,
  }
}

export function resetSharedThumbObserverForTesting(): void {
  for (const record of observersByRoot.values()) {
    record.observer.disconnect()
    record.callbacks.clear()
  }
  observersByRoot.clear()
  sharedObserverCreatedCount = 0
}

export const ThumbRootContext = createContext<RefObject<HTMLElement | null> | null>(null)

export function useNearViewport(ref: RefObject<HTMLElement | null>, rootRef?: RefObject<HTMLElement | null>): boolean {
  const contextRootRef = useContext(ThumbRootContext)
  const resolvedRootRef = rootRef ?? contextRootRef
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const root = resolvedRootRef?.current ?? null
    return observeThumbElement(element, setNear, root)
  }, [ref, resolvedRootRef])
  return near
}
