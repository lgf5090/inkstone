import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { SlideViewport } from './slide-canvas'
import { stageClickDirection, swipeDirection } from './presentation-state'
import { formatDeckPosition } from './deck-position'
import type { StageMetrics } from './slide-stage'
import type { SlidePlan } from './slide-pagination'

export interface PresentationStageProps {
  stageRef: RefObject<HTMLDivElement | null>
  metrics: StageMetrics
  cacheKey: string
  source: string
  subPage: number
  /** How far into this page the show has walked (N-31); the projector is the only surface that has one. */
  step: number
  /** How many reveals this page holds — zero when it arrives all at once. */
  steps: number
  pageCount?: number
  /** Charts arrive already drawn when the account turned their animation off. */
  instantCharts?: boolean
  index: number
  count: number
  onPlan: (plan: SlidePlan) => void
  onPrev: () => void
  onNext: () => void
  /** The overview grid is drawn over the slide, so nothing in the slide can be reached. */
  occluded: boolean
  /**
   * Whether the control bar has faded. The corner readout exists only for that moment: while the bar
   * is up it prints the same numbers beside the buttons that change them, and two copies of one
   * figure on one screen read as two facts that could disagree (PR-M4).
   */
  chromeHidden?: boolean
}

export interface StageSessionSource {
  metrics: StageMetrics
  cacheKeys: Record<number, string>
  deck: string[]
  index: number
  sub: number
  step: number
  steps: number
  pageCount: number
  instantCharts: boolean
  handlePlan: (plan: SlidePlan) => void
  goPrev: () => void
  goNext: () => void
  occluded: boolean
  chromeHidden?: boolean
}

export function stageProps(stageRef: RefObject<HTMLDivElement | null>, session: StageSessionSource): PresentationStageProps {
  return {
    stageRef,
    metrics: session.metrics,
    cacheKey: session.cacheKeys[session.index] ?? '',
    source: session.deck[session.index] ?? '',
    subPage: session.sub,
    step: session.step,
    steps: session.steps,
    pageCount: session.pageCount,
    instantCharts: session.instantCharts,
    index: session.index,
    count: session.deck.length,
    onPlan: session.handlePlan,
    onPrev: session.goPrev,
    onNext: session.goNext,
    occluded: session.occluded,
    chromeHidden: session.chromeHidden,
  }
}

function useStageGestures({
  stageRef,
  onPrev,
  onNext,
  occluded,
}: {
  stageRef: RefObject<HTMLDivElement | null>
  onPrev: () => void
  onNext: () => void
  occluded: boolean
}) {
  const touchStartX = useRef<number | null>(null)

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (occluded) return
    const target = event.target as HTMLElement | null
    if (target?.closest('a, button, input, select, textarea, [contenteditable="true"]')) return
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const clickX = event.clientX - rect.left
    const dir = stageClickDirection(clickX, rect.width)
    if (dir === 'prev') onPrev()
    else onNext()
  }, [onPrev, onNext, stageRef, occluded])

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    touchStartX.current = event.touches[0]?.clientX ?? null
  }, [])

  const handleTouchEnd = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (touchStartX.current === null) return
    const touchEndX = event.changedTouches[0]?.clientX ?? touchStartX.current
    const deltaX = touchEndX - touchStartX.current
    touchStartX.current = null
    const dir = swipeDirection(deltaX)
    if (dir === 'prev') onPrev()
    else if (dir === 'next') onNext()
  }, [onPrev, onNext])

  return { handleClick, handleTouchStart, handleTouchEnd }
}

export function PresentationStage(props: PresentationStageProps) {
  const { stageRef, metrics, cacheKey, source, subPage, step, steps, pageCount = 1, instantCharts = false, index, count, onPlan, onPrev, onNext, occluded, chromeHidden = false } = props
  const { handleClick, handleTouchStart, handleTouchEnd } = useStageGestures({ stageRef, onPrev, onNext, occluded })

  return (
    <div
      ref={stageRef}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      inert={occluded ? true : undefined}
      className='relative flex min-h-0 min-w-0 flex-1 select-none items-center justify-center overflow-hidden'
    >
      <SlideViewport metrics={metrics} cacheKey={cacheKey} source={source} subPage={subPage} step={step} onPlan={onPlan} instantCharts={instantCharts} />
      {count > 0 && chromeHidden && (
        // Only while the bar has faded, which is the one moment nothing else on screen says where
        // the talk is. This chip used to fade itself to 35% opacity, which composites its text to
        // 1.67:1 against the slide — the axe `color-contrast` violation L-1 has been carrying. AA is
        // the floor, so it now paints at the tier's own colour; muting it further would need a token
        // that still clears contrast on this surface, not an opacity applied on top of one that
        // already does.
        <div
          className='pointer-events-none absolute bottom-[var(--sp-4)] right-[var(--sp-4)] z-[var(--z-sticky)] select-none rounded-[var(--r-full)] bg-[var(--bg-overlay)] px-[var(--sp-2)] py-[var(--sp-0-5)] text-[length:var(--text-11)] font-mono text-[var(--text-tertiary)] shadow-[var(--shadow-xs)]'
          aria-hidden='true'
        >
          <span data-deck-position>{formatDeckPosition({ index, count, subPage, pageCount, step, steps })}</span>
        </div>
      )}
    </div>
  )
}

export type PresentationCover = 'black' | 'white'

// The cover is a control the speaker presses, so it is a button: a painted rectangle that answers
// clicks has no accessible name to read, no focus to receive, and no key that lifts it. Its label
// comes from the resources — the same surface has to say the same thing in either language — and it
// takes the focus on the way in, because while it is up the rest of the chrome is inert.
export function ScreenCover({ cover, onClear }: { cover: PresentationCover; onClear: () => void }) {
  const controlRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    controlRef.current?.focus()
  }, [cover])
  return (
    <button
      ref={controlRef}
      type='button'
      onClick={onClear}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      data-screen-cover={cover}
      className={cn('absolute inset-0 z-[var(--z-modal)] cursor-pointer select-none', cover === 'black' ? 'bg-[rgb(0_0_0)]' : 'bg-[rgb(255_255_255)]')}
      aria-label={t(cover === 'black' ? 'workspace.presentation_blackout' : 'workspace.presentation_whiteout')}
    />
  )
}

// Covering and uncovering are invisible to anyone who cannot see the projector: the screen goes flat
// colour, or comes back. This says which of the two just happened, in the one place that is allowed
// to announce — it does not fire on mount, so opening a show that is not covered stays silent.
export function CoverAnnouncement({ cover }: { cover: PresentationCover | null }) {
  const [message, setMessage] = useState('')
  const previous = useRef<PresentationCover | null>(cover)
  useEffect(() => {
    if (previous.current === cover) return
    const lifted = cover === null
    const mode = cover ?? previous.current
    previous.current = cover
    setMessage(lifted
      ? t('workspace.presentation_cover_off')
      : t('workspace.presentation_cover_on', { value0: t(mode === 'black' ? 'workspace.presentation_blackout' : 'workspace.presentation_whiteout') }))
  }, [cover])
  return (
    <span data-cover-status className='sr-only' role='status' aria-live='polite'>
      {message}
    </span>
  )
}

// A page whose enhancement threw keeps its text and loses its diagrams, and the only visible trace is
// a placeholder that never fills in — which reads as a slow show rather than a failed one. This says
// which of the two it is, inside the dialog where a reader already is. It is not change-tracked the
// way the cover announcement is: a live region stays quiet about what was already there when it
// mounted, so opening on a good page says nothing and the first page that fails is the one that speaks.
export function SlidePreparationNotice({ failed }: { failed: boolean }) {
  return (
    <span data-slide-preparation={failed ? 'failed' : 'ok'} className='sr-only' role='status' aria-live='polite'>
      {failed ? t('workspace.presentation_slide_unprepared') : ''}
    </span>
  )
}
