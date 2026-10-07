import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../lib/i18n'
import { Switch } from '../../components/form'
import { PresentationStage, stageProps, type StageSessionSource } from './presentation-stage'
import { SlideStepper } from './presentation-controls'
import { backwardMove, forwardMove, hasBackwardMove, hasForwardMove } from './presentation-state'
import { presentationCommand } from './presentation-keys'
import { planPageSteps, resolvePageIndex, type SlidePlan } from './slide-pagination'
import { useStageMetrics } from './slide-stage'
import { useIsDarkTheme } from './presentation-theme'
import { useSlideCacheKeys, useShowDeck } from './use-show-deck'
import { useSlidePlans } from './use-slide-plans'
import { useAudiencePresence, type AudienceFeedState } from './use-audience-presence'

/**
 * The position as written, read against what this device has measured.
 *
 * A page the viewer's device has not measured yet cannot be clamped to a page that exists — the
 * measurement arrives a frame later and the clamp would have to be undone — so the intent is held and
 * read through the same clamps the show uses for a plan that changed underneath it (N-31). A slide the
 * deck has lost pulls the position back onto one it still has.
 */
export interface AudienceWhere {
  slide: number
  page: number
  step: number
}

export function readAudiencePosition(where: AudienceWhere, deckLength: number, plan: SlidePlan | undefined) {
  const index = Math.min(where.slide, Math.max(deckLength - 1, 0))
  const sub = plan ? resolvePageIndex(plan, where.page) : 0
  const pageCount = plan?.pages.length ?? 1
  const steps = plan ? planPageSteps(plan, sub) : 0
  return { index, pageCount, step: Math.min(where.step, steps), steps, sub }
}

/**
 * The audience's seat at somebody else's show (ADR-0006).
 *
 * The viewer is handed the same markdown the share page already renders and paginates it on their own
 * device, so what the speaker wrote is applied through the clamps the show uses for a plan that changed
 * underneath it: a phone gets the pages the phone fits, and lands on the speaker's page as soon as that
 * page exists here.
 *
 * Following is a switch, not a harness. The moment a viewer turns a page themselves they have decided to
 * look somewhere else, and being yanked back on the next beat is worse than being behind.
 */
export function AudienceView({ slug, token, source }: {
  slug: string
  token: string
  source: string
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const metrics = useStageMetrics(true, stageRef)
  const dark = useIsDarkTheme()
  const feed = useAudiencePresence(slug, token)
  const { deck, hashes } = useShowDeck(source)
  const cacheKeys = useSlideCacheKeys(hashes, dark, metrics)
  const { plans, reportPlan } = useSlidePlans(hashes)
  const [following, setFollowing] = useState(true)
  const wheel = useAudienceWheel(deck, plans, reportPlan, () => setFollowing(false))

  const heard = feed.presence
  useEffect(() => {
    if (!following || !heard) return
    wheel.land({ slide: heard.slide, page: heard.page, step: heard.step })
  }, [following, heard, wheel.land])

  const session: StageSessionSource = {
    metrics,
    cacheKeys,
    deck,
    index: wheel.index,
    sub: wheel.sub,
    step: wheel.step,
    steps: wheel.steps,
    pageCount: wheel.pageCount,
    // A follower's page arrives already drawn: the beat that moves them on to the next page is not
    // a moment they chose to watch a chart grow, and a chart that replays its entrance on every
    // beat would be re-replaying it while the speaker is still talking over the last one.
    instantCharts: true,
    handlePlan: wheel.handlePlan,
    goPrev: wheel.goPrev,
    goNext: wheel.goNext,
    occluded: false,
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-[var(--sp-3)]'>
      <PresentationStage {...stageProps(stageRef, session)} />
      <AudienceBar wheel={wheel} deckCount={deck.length} feed={feed.state} following={following} onFollowChange={setFollowing} />
    </div>
  )
}

/**
 * The viewer's own position: the speaker's numbers held as written, read through this device's plans.
 */
function useAudienceWheel(deck: string[], plans: Record<number, SlidePlan>, reportPlan: (slide: number, plan: SlidePlan) => void, takeTheWheel: () => void) {
  const [where, setWhere] = useState<AudienceWhere>({ slide: 0, page: 0, step: 0 })
  const plan = plans[Math.min(where.slide, Math.max(deck.length - 1, 0))]
  const here = readAudiencePosition(where, deck.length, plan)
  const { index, sub, pageCount, steps, step } = here

  // Where the show put them: the numbers as written, clamped only at the ends of the deck.
  const land = useCallback((next: AudienceWhere) => {
    setWhere({ slide: Math.max(0, Math.min(next.slide, Math.max(deck.length - 1, 0))), page: Math.max(0, next.page), step: Math.max(0, next.step) })
  }, [deck.length])

  // A press is the viewer taking the wheel: the page they moved to stays theirs until they hand the show
  // back with the switch.
  const take = useCallback((next: AudienceWhere) => {
    land(next)
    takeTheWheel()
  }, [land, takeTheWheel])

  const goNext = useCallback(() => {
    if (!hasForwardMove({ index, count: deck.length, sub, pageCount, step, steps })) return
    const move = forwardMove({ step, steps, sub, pageCount })
    if (move === 'step') take({ slide: index, page: sub, step: step + 1 })
    else if (move === 'page') take({ slide: index, page: sub + 1, step: 0 })
    else take({ slide: index + 1, page: 0, step: 0 })
  }, [deck.length, index, pageCount, step, steps, sub, take])

  const goPrev = useCallback(() => {
    if (!hasBackwardMove({ index, sub, step })) return
    const move = backwardMove({ step, sub })
    if (move === 'step') take({ slide: index, page: sub, step: Math.max(step - 1, 0) })
    else if (move === 'page') take({ slide: index, page: sub - 1, step: plan ? planPageSteps(plan, sub - 1) : 0 })
    else take({ slide: index - 1, page: 0, step: 0 })
  }, [index, plan, step, sub, take])

  const jumpTo = useCallback((slide: number) => take({ slide, page: 0, step: 0 }), [take])
  const handlePlan = useCallback((measured: SlidePlan) => reportPlan(index, measured), [index, reportPlan])

  useAudienceKeys(deck.length, goNext, goPrev, jumpTo)

  return { handlePlan, goNext, goPrev, index, land, pageCount, step, steps, sub }
}

// The keystrokes are the show's, so a viewer who knows the projector's keys is not learning a second set.
// The actions are read off a ref because the listener lives on `window` while the page moves.
function useAudienceKeys(deckLength: number, goNext: () => void, goPrev: () => void, jumpTo: (slide: number) => void): void {
  const actions = useRef({ goNext, goPrev, jumpTo, deckLength })
  actions.current = { goNext, goPrev, jumpTo, deckLength }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      const command = presentationCommand(event.key, {
        onControl: Boolean(target?.closest('button, a, input, select, textarea, [contenteditable="true"]')),
        onSlideList: false,
      })
      if (command !== 'next' && command !== 'prev' && command !== 'first' && command !== 'last') return
      event.preventDefault()
      if (command === 'next') actions.current.goNext()
      else if (command === 'prev') actions.current.goPrev()
      else actions.current.jumpTo(command === 'first' ? 0 : actions.current.deckLength - 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function AudienceBar({ wheel, deckCount, feed, following, onFollowChange }: {
  wheel: ReturnType<typeof useAudienceWheel>
  deckCount: number
  feed: AudienceFeedState
  following: boolean
  onFollowChange: (next: boolean) => void
}) {
  return (
    <div
      data-audience-bar
      className='flex flex-wrap items-center justify-center gap-[var(--sp-0-5)] self-center rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] p-[var(--sp-1)] shadow-[var(--shadow-pop)]'
    >
      <SlideStepper slideIndex={wheel.index} slideCount={deckCount} subPage={wheel.sub} pageCount={wheel.pageCount} step={wheel.step} steps={wheel.steps} onPrev={wheel.goPrev} onNext={wheel.goNext} />
      <span className='mx-[var(--sp-1)] h-[var(--sp-4)] w-px bg-[var(--border-subtle)]' aria-hidden='true' />
      <span className='flex items-center gap-[var(--sp-1)] text-[length:var(--text-12)] text-[var(--text-secondary)]'>
        <Switch checked={following} onChange={onFollowChange} label={t('workspace.presentation_audience_follow_switch')} />
        {t('workspace.presentation_audience_follow_switch')}
      </span>
      <span data-audience-state role='status' aria-live='polite' className='px-[var(--sp-1)] text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
        {audienceStateWord(feed, following)}
      </span>
    </div>
  )
}

// Whether this page is still being told to somebody, in the one place a viewer can read it. Held as a
// function because the five states have to be named the same way wherever a viewer is standing.
function audienceStateWord(feed: AudienceFeedState, following: boolean): string {
  if (feed === 'ended') return t('workspace.presentation_audience_ended')
  if (feed === 'connecting') return t('workspace.presentation_audience_connecting')
  if (feed === 'stale') return t('workspace.presentation_audience_stale')
  return following ? t('workspace.presentation_audience_following') : t('workspace.presentation_audience_browsing')
}
