import { useCallback, useEffect, useState } from 'react'
import { buildIncrementalSlidePlans, rememberSlidePlan } from './slide-html'
import { samePlan, type SlidePlan } from './slide-pagination'

/**
 * The page layout of every slide the surface has drawn, kept where the position is kept.
 *
 * The canvas measures the slide it renders — it is the only place that knows how the same markup falls
 * across the same canvas — and hands the plan out here so the counter can name its pages and the move
 * can walk them. It lives apart from the show because any surface that holds a deck position needs this
 * map, and a viewer following along needs that and nothing else of the projector's state machine.
 */
export function useSlidePlans(hashes: string[]) {
  const [plans, setPlans] = useState<Record<number, SlidePlan>>(() => buildIncrementalSlidePlans(hashes))
  // Edited content re-splits the deck, so plans measured for the previous text would
  // describe pages that no longer exist.
  useEffect(() => {
    setPlans((current) => buildIncrementalSlidePlans(hashes, current))
  }, [hashes])
  const reportPlan = useCallback((slide: number, plan: SlidePlan) => {
    rememberSlidePlan(hashes[slide] ?? '', plan)
    setPlans((current) => (samePlan(current[slide], plan) ? current : { ...current, [slide]: plan }))
  }, [hashes])
  return { plans, reportPlan }
}
