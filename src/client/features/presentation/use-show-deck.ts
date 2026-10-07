import { useEffect, useMemo } from 'react'
import { hashContent, reserveSlideCache, slideCacheKey } from './slide-html'
import { splitIntoSlidesWithNotes } from './slides'
import type { StageMetrics } from './slide-stage'

/** What the show presents, and the one identity of each slide inside it. */
export interface ShowDeck {
  deck: string[]
  notes: string[]
  /** Each slide's own content hash, index-aligned with `deck`. */
  hashes: string[]
  /** What the deck adds up to: the measuring pass restarts on this. */
  fingerprint: string
}

// The deck is exactly what the show presents: while following, every debounced edit re-splits it;
// a frozen snapshot is a plain string that cannot move under the presenter.
//
// The hashes are computed here and handed out because four surfaces ask the same question — which
// slide is this — and each of them used to walk the whole deck's text to answer it: the cache keys,
// the measured plans, the measuring pass looking up what it already knows, and the pass restarting.
export function useShowDeck(content: string): ShowDeck {
  const show = useMemo(() => {
    const { slides, notes } = splitIntoSlidesWithNotes(content)
    const hashes = slides.map((slide) => hashContent(slide))
    return { deck: slides, notes, hashes, fingerprint: hashContent(hashes.join('|')) }
  }, [content])
  // Before the pass starts preparing pages: a cap under the deck's page count makes it evict the
  // pages it has already prepared, and the rail then re-renders what was just thrown away.
  useEffect(() => {
    reserveSlideCache(show.deck.length)
  }, [show.deck.length])
  return show
}

/**
 * The cache key of every slide, from the hashes the deck already carries. A surface that hashed the
 * text again here would be spending a full pass over the deck to re-derive something it was handed.
 */
export function useSlideCacheKeys(hashes: string[], dark: boolean, metrics: StageMetrics): string[] {
  return useMemo(
    () => hashes.map((hash, item) => slideCacheKey({ fingerprint: hash, dark, index: item, contentWidth: metrics.contentWidth, contentHeight: metrics.contentHeight })),
    [hashes, dark, metrics.contentWidth, metrics.contentHeight],
  )
}
