// The deck at a glance: every page of the show as a card, in the order the arrow keys walk it,
// so a presenter can jump to the section they are talking about instead of stepping there.
// It is a layer inside the dialog rather than a dialog of its own — the browser only paints the
// fullscreen element's subtree, and the show is fullscreen.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { ProseFont } from '@shared/types'
import { t } from '../../lib/i18n'
import { entryIndexOf, overviewMove, railEntries } from './presentation-state'
import { presentationCommand } from './presentation-keys'
import type { SlidePlan } from './slide-pagination'
import { extractSlideHeading, pageLabel, SlideThumb, ThumbRootContext, useCachedSlideHtml, useNearViewport, usePageHtml, useThumbView, type ThumbView } from './slide-thumb'

const OVERVIEW_THUMB_WIDTH = 200
// The matrix is the browser's, not ours: the cards are as wide as the thumb they carry, and a
// row holds as many as fit — which is why roaming steps by a measured row length.
const OVERVIEW_GRID = `repeat(auto-fill, minmax(${OVERVIEW_THUMB_WIDTH}px, 1fr))`

export interface SlideOverviewGridProps {
  deck: string[]
  cacheKeys: string[]
  plans: Record<number, SlidePlan>
  index: number
  sub: number
  designWidth: number
  designHeight: number
  proseFont: ProseFont
  onSelectPage: (slide: number, sub: number) => void
  onClose: () => void
}

export function SlideOverviewGrid({ deck, cacheKeys, plans, index, sub, designWidth, designHeight, proseFont, onSelectPage, onClose }: SlideOverviewGridProps) {
  const rootRef = useRef<HTMLElement>(null)
  const entries = useMemo(() => railEntries(deck.length, plans), [deck.length, plans])
  const presenting = entryIndexOf(entries, index, sub)
  const view = useThumbView({ thumbWidth: OVERVIEW_THUMB_WIDTH, designWidth, designHeight, proseFont })
  // Where the presenter's cursor is inside the grid. It starts on the page being shown and then
  // belongs to them: the show can move underneath (a click on the projector, an arrow key)
  // without the keyboard focus jumping out from under their hands.
  const [roam, setRoam] = useState(presenting)
  const onKeyDown = useGridKeyboard(rootRef, entries.length, onClose, setRoam)
  useOpenedFocus(rootRef, presenting)

  return (
    <ThumbRootContext.Provider value={rootRef}>
      <section
        ref={rootRef}
        data-presentation-overview
        aria-label={t('workspace.presentation_overview')}
        onKeyDown={onKeyDown}
        className='absolute inset-0 z-[var(--z-popover)] overflow-y-auto bg-[var(--bg-base)] px-[var(--sp-6)] py-[var(--sp-5)]'
      >
        <div className='grid items-start justify-items-center gap-[var(--sp-4)]' style={{ gridTemplateColumns: OVERVIEW_GRID }}>
          {entries.map((entry, item) => (
            <OverviewCard
              key={`${entry.slide}-${entry.sub}`}
              slide={entry.slide}
              sub={entry.sub}
              pageCount={entry.pageCount}
              item={item}
              cacheKey={cacheKeys[entry.slide] ?? ''}
              source={deck[entry.slide] ?? ''}
              plan={plans[entry.slide]}
              deckLength={deck.length}
              presenting={item === presenting}
              focused={item === roam}
              view={view}
              onSelectPage={onSelectPage}
              onClose={onClose}
            />
          ))}
        </div>
      </section>
    </ThumbRootContext.Provider>
  )
}

// The grid takes the focus when it opens and hands it back to whatever opened it, the same
// contract the dialog has with the note underneath — the dialog's own trap only restores focus
// when the whole show closes.
function useOpenedFocus(rootRef: RefObject<HTMLElement | null>, presenting: number): void {
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    // Recorded once per grid, not on every run of this effect: a second run happens after the
    // keyboard has already moved inside, so re-reading it would make a card of the matrix into
    // the thing that opened it — and a detached card restores nothing.
    if (!openerRef.current) openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = rootRef.current
    if (root) cardsIn(root)[presenting]?.focus({ preventScroll: true })
    return () => {
      const opener = openerRef.current
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
}

function cardsIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-overview-index]')]
}

// How many cards the painted first row holds. Read at key time rather than kept in state, because
// the only thing that resizes the grid is a viewport change, and the presenter notices that by
// looking at it; a resize observer would re-render the whole deck for a number used once per key.
function columnsIn(cards: HTMLElement[]): number {
  if (cards.length < 2) return 1
  const first = cards[0]?.offsetTop ?? 0
  let count = 0
  for (const card of cards) {
    if (card.offsetTop !== first) break
    count += 1
  }
  return Math.max(count, 1)
}

function useGridKeyboard(rootRef: RefObject<HTMLElement | null>, count: number, onClose: () => void, setRoam: (item: number) => void): (event: KeyboardEvent<HTMLElement>) => void {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return
    // The show's own handler runs first (window capture) and leaves this key alone while focus is
    // on a card, because a button owns Enter and Space. The grid is the exception it must not own:
    // the key that opened the matrix has to close it from anywhere inside the matrix.
    if (presentationCommand(event.key, { onControl: false, onSlideList: false }) === 'overview') {
      event.preventDefault()
      onClose()
      return
    }
    const root = rootRef.current
    if (!root) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const card = target.closest<HTMLElement>('[data-overview-index]')
    if (!card) return
    const cards = cardsIn(root)
    const next = overviewMove(event.key, cards.indexOf(card), count, columnsIn(cards))
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    const focusTo = cards[next]
    if (!focusTo) return
    setRoam(next)
    focusTo.focus({ preventScroll: true })
    focusTo.scrollIntoView({ block: 'nearest' })
  }, [count, onClose, rootRef, setRoam])
}

interface OverviewCardProps {
  // See `SlideRailItemProps`: the numbers of the page, not an entry object the grid rebuilds
  // whenever any slide is measured.
  slide: number
  sub: number
  pageCount: number
  item: number
  cacheKey: string
  source: string
  plan: SlidePlan | undefined
  deckLength: number
  presenting: boolean
  focused: boolean
  view: ThumbView
  onSelectPage: (slide: number, sub: number) => void
  onClose: () => void
}

// Memoized for the same reason as the rail's card, and with a heavier one on top: the grid holds the
// whole deck at once, so a card that cannot tell an unchanged slide from a re-measured one pays for
// the deck on every keystroke of the arrow keys that roam it.
const OverviewCard = memo(function OverviewCard({ slide, sub, pageCount, item, cacheKey, source, plan, deckLength, presenting, focused, view, onSelectPage, onClose }: OverviewCardProps) {
  const entry = { slide, sub, pageCount }
  const thumbRef = useRef<HTMLSpanElement>(null)
  const near = useNearViewport(thumbRef)
  const cached = useCachedSlideHtml(cacheKey)
  const { html, layout, drawn } = usePageHtml({ near, cacheKey, cached, source, plan, sub, view })
  const heading = useMemo(() => extractSlideHeading(source), [source])

  return (
    <button
      type='button'
      data-overview-index={item}
      data-slide-index={slide}
      data-slide-page={sub}
      aria-current={presenting ? 'true' : undefined}
      aria-label={pageLabel(entry, deckLength)}
      tabIndex={focused ? 0 : -1}
      onClick={() => {
        onSelectPage(slide, sub)
        onClose()
      }}
      className='flex w-full flex-col items-center gap-[var(--sp-2)] rounded-[var(--r-md)] p-[var(--sp-2)] text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]'
    >
      <SlideThumb thumbRef={thumbRef} near={near} html={html} layout={layout} drawn={drawn} active={presenting} view={view} />
      <span className='flex min-w-0 items-center gap-[var(--sp-2)]'>
        <span className={presenting ? 'tabular text-[length:var(--text-12)] font-medium text-[var(--accent)]' : 'tabular text-[length:var(--text-12)] text-[var(--text-tertiary)]'} aria-hidden='true'>
          {item + 1}
        </span>
        {heading && <span className='truncate text-[length:var(--text-12)] text-[var(--text-secondary)]'>{heading}</span>}
      </span>
    </button>
  )
})
