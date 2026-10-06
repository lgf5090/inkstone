import { memo, useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from 'react'
import type { ProseFont } from '@shared/types'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { entryIndexOf, railEntries, type RailEntry } from './presentation-state'
import type { PreflightProgress } from './slide-preflight'
import type { SlidePlan } from './slide-pagination'
import { extractSlideHeading, pageLabel, SlideThumb, ThumbRootContext, useCachedSlideHtml, useNearViewport, usePageHtml, useThumbView, type ThumbView } from './slide-thumb'

export const SLIDE_RAIL_WIDTH = 216
const RAIL_THUMB_WIDTH = 148

interface SlideRailProps {
  deck: string[]
  cacheKeys: string[]
  plans: Record<number, SlidePlan>
  index: number
  sub: number
  designWidth: number
  designHeight: number
  title: string
  proseFont: ProseFont
  chromeHidden: boolean
  /** The overview grid is on top of the whole slide surface, so the list cannot be reached. */
  occluded: boolean
  progress: PreflightProgress
  onSelectPage: (slide: number, sub: number) => void
}

export function SlideRail({ deck, cacheKeys, plans, index, sub, designWidth, designHeight, title, proseFont, chromeHidden, occluded, progress, onSelectPage }: SlideRailProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const entries = useMemo(() => railEntries(deck.length, plans), [deck.length, plans])
  const active = entryIndexOf(entries, index, sub)
  const view = useThumbView({ thumbWidth: RAIL_THUMB_WIDTH, designWidth, designHeight, proseFont })
  // One stable ref callback for the whole list: the entry index rides on the
  // element, so re-renders never detach and re-attach every button.
  const registerItem = useCallback((element: HTMLButtonElement | null) => {
    if (!element) return
    const entry = Number(element.dataset.entryIndex)
    if (Number.isInteger(entry)) itemRefs.current[entry] = element
  }, [])
  // The list drives selection: focus moves with the show so the next arrow key
  // continues from where the presenter is, and the active page stays in view.
  useEffect(() => {
    itemRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const onKeyDown = useRailKeyboard(entries, active, onSelectPage, itemRefs)

  return (
    <nav
      aria-label={t('workspace.presentation_slides')}
      data-presentation-rail
      // Out of reach both while the chrome has faded and while the grid is up: the browser will
      // not focus anything in an `inert` subtree, so the dialog's focus trap must not offer it.
      inert={chromeHidden || occluded ? true : undefined}
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-surface)]',
        'transition-opacity duration-[var(--dur-base)] ease-[var(--ease-out)]',
        chromeHidden && 'pointer-events-none opacity-0',
      )}
      style={{ width: SLIDE_RAIL_WIDTH }}
      onKeyDown={onKeyDown}
    >
      <p className='truncate px-[var(--sp-3)] pt-[var(--sp-2)] text-[length:var(--text-11)] font-medium tracking-[var(--tracking-label)] text-[var(--text-tertiary)] uppercase'>
        {title}
      </p>
      {/* The list fills from the background pass, so it says so while that is happening and gets
          out of the way once every page is there. Plain text rather than a live region: the count
          changes per slide, and a reader would be read a stream of numbers. */}
      <p className={cn('px-[var(--sp-3)] pb-[var(--sp-2)] text-[length:var(--text-11)] text-[var(--text-tertiary)]', progress.finished && 'hidden')} data-slide-list-measuring={progress.finished ? undefined : 'true'}>
        {t('workspace.presentation_measuring', { value0: Math.min(progress.measured, progress.slides), value1: progress.slides })}
      </p>
      <SlideRailList deck={deck} cacheKeys={cacheKeys} plans={plans} entries={entries} active={active} view={view} onSelectPage={onSelectPage} registerItem={registerItem} />
    </nav>
  )
}

// The rail walks its own pages with the arrows, which is why the window-level
// presentation keys yield those four keys while focus sits inside the rail.
function useRailKeyboard(entries: RailEntry[], active: number, onSelectPage: (slide: number, sub: number) => void, itemRefs: RefObject<(HTMLButtonElement | null)[]>): (event: KeyboardEvent<HTMLElement>) => void {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    const last = entries.length - 1
    const from = active < 0 ? 0 : active
    const target = event.key === 'ArrowDown' ? from + 1
      : event.key === 'ArrowUp' ? from - 1
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null
    if (target === null || entries.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    const next = Math.min(Math.max(target, 0), last)
    const entry = entries[next]
    if (!entry) return
    onSelectPage(entry.slide, entry.sub)
    itemRefs.current[next]?.focus({ preventScroll: true })
  }, [entries, active, onSelectPage, itemRefs])
}

function SlideRailList({ deck, cacheKeys, plans, entries, active, view, onSelectPage, registerItem }: {
  deck: string[]
  cacheKeys: string[]
  plans: Record<number, SlidePlan>
  entries: RailEntry[]
  active: number
  view: ThumbView
  onSelectPage: (slide: number, sub: number) => void
  registerItem: (element: HTMLButtonElement | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <ThumbRootContext.Provider value={containerRef}>
      <div
        ref={containerRef}
        role='tablist'
        aria-orientation='vertical'
        className='flex min-h-0 flex-1 flex-col gap-[var(--sp-1)] overflow-y-auto px-[var(--sp-2)] pb-[var(--sp-3)]'
      >
        {entries.map((entry, item) => (
          <SlideRailItem
            key={`${entry.slide}-${entry.sub}`}
            slide={entry.slide}
            sub={entry.sub}
            pageCount={entry.pageCount}
            entryIndex={item}
            cacheKey={cacheKeys[entry.slide] ?? ''}
            source={deck[entry.slide] ?? ''}
            plan={plans[entry.slide]}
            deckLength={deck.length}
            active={item === active}
            view={view}
            onSelectPage={onSelectPage}
            buttonRef={registerItem}
            setsize={entries.length}
            posinset={item + 1}
          />
        ))}
      </div>
    </ThumbRootContext.Provider>
  )
}

interface SlideRailItemProps {
  // The page this card shows, as the three numbers that say it. A `RailEntry` object would do the
  // same job, but the list rebuilds those whenever a slide is measured, and a card that cannot tell
  // an unchanged slide from a re-measured one re-runs the deck on every turn.
  slide: number
  sub: number
  pageCount: number
  entryIndex: number
  cacheKey: string
  source: string
  plan: SlidePlan | undefined
  deckLength: number
  active: boolean
  view: ThumbView
  onSelectPage: (slide: number, sub: number) => void
  buttonRef: (element: HTMLButtonElement | null) => void
  setsize: number
  posinset: number
}

// Memoized because a turn changes one card and a measurement lands on one slide, while the list that
// holds them both re-renders: without this, every card of a long deck re-runs its own viewport watch,
// markup read and page slice for work that belongs to two of them.
const SlideRailItem = memo(function SlideRailItem({ slide, sub, pageCount, entryIndex, cacheKey, source, plan, deckLength, active, view, onSelectPage, buttonRef, setsize, posinset }: SlideRailItemProps) {
  const entry = { slide, sub, pageCount }
  const thumbRef = useRef<HTMLSpanElement>(null)
  const near = useNearViewport(thumbRef)
  const cached = useCachedSlideHtml(cacheKey)
  const { html, layout, drawn } = usePageHtml({ near, cacheKey, cached, source, plan, sub, view })
  const heading = useMemo(() => extractSlideHeading(source), [source])

  return (
    <button
      ref={buttonRef}
      type='button'
      role='tab'
      aria-selected={active}
      aria-setsize={setsize}
      aria-posinset={posinset}
      data-entry-index={entryIndex}
      data-slide-index={slide}
      data-slide-page={sub}
      aria-label={pageLabel(entry, deckLength)}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelectPage(slide, sub)}
      className={cn(
        'flex items-start gap-[var(--sp-2)] rounded-[var(--r-md)] p-[var(--sp-1)] text-left',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <span className={cn('tabular w-[var(--sp-4)] shrink-0 pt-[var(--sp-0-5)] text-center text-[length:var(--text-11)]', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')} aria-hidden='true'>
        {entryIndex + 1}
      </span>
      <div className='flex min-w-0 flex-1 flex-col gap-[var(--sp-1)]'>
        <SlideThumb thumbRef={thumbRef} near={near} html={html} layout={layout} drawn={drawn} active={active} view={view} />
        {heading && (
          <span className='truncate text-[length:var(--text-11)] text-[var(--text-secondary)]'>
            {heading}
          </span>
        )}
      </div>
    </button>
  )
})
