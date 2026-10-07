import { useLayoutEffect, useState, type RefObject } from 'react'

// Slides are laid out on a fixed standard 16:9 design canvas and scaled to the stage, so
// type and diagrams keep their proportions from phone to projector with stable cache keys.
export const SLIDE_DESIGN_WIDTH = 1280
export const SLIDE_DESIGN_HEIGHT = 720

/** The canvas a phone held upright gets: half the projector's width, so the same glass carries type
 * twice as large. Only the width changes — the stylesheet's sizes are design units either way. */
export const SLIDE_DESIGN_NARROW_WIDTH = 640

/** How much taller than wide a stage has to be before it stops being a window and starts being a phone
 * held up: 6:5, which is above every laptop panel and below every portrait handset. */
export const NARROW_STAGE_RATIO = 1.2
export const SLIDE_PAD_X = 56
export const SLIDE_PAD_Y = 44

export interface StageMetrics {
  scale: number
  designWidth: number
  designHeight: number
  contentWidth: number
  contentHeight: number
}

const FALLBACK_METRICS: StageMetrics = {
  scale: 1,
  designWidth: SLIDE_DESIGN_WIDTH,
  designHeight: SLIDE_DESIGN_HEIGHT,
  contentWidth: SLIDE_DESIGN_WIDTH - SLIDE_PAD_X * 2,
  contentHeight: SLIDE_DESIGN_HEIGHT - SLIDE_PAD_Y * 2,
}

export function measureStage(stageWidth: number, stageHeight: number): StageMetrics {
  if (stageWidth < 1 || stageHeight < 1) return FALLBACK_METRICS
  // A stage taller than it is wide is a phone held up, and a 16:9 canvas on that glass is a slide whose
  // body lands at nine pixels (PR-M6). The answer is the other canvas the same stylesheet draws: half
  // the design width, so the type is twice as tall, and a page as long as the glass, which the existing
  // pagination then turns into more pages to walk instead of one page to squint at.
  const narrow = stageHeight >= stageWidth * NARROW_STAGE_RATIO
  if (!narrow) {
    const scale = Math.min(stageWidth / SLIDE_DESIGN_WIDTH, stageHeight / SLIDE_DESIGN_HEIGHT)
    return canvas(scale, SLIDE_DESIGN_WIDTH, SLIDE_DESIGN_HEIGHT)
  }
  const scale = stageWidth / SLIDE_DESIGN_NARROW_WIDTH
  return canvas(scale, SLIDE_DESIGN_NARROW_WIDTH, Math.round(stageHeight / scale))
}

function canvas(scale: number, designWidth: number, designHeight: number): StageMetrics {
  return {
    scale,
    designWidth,
    designHeight,
    contentWidth: designWidth - SLIDE_PAD_X * 2,
    contentHeight: designHeight - SLIDE_PAD_Y * 2,
  }
}

// `active` matters: the overlay keeps its hooks mounted while closed, so an
// effect that only ran on mount would attach its observer while the stage is
// still absent and never see the real stage afterwards.
export function useStageMetrics(active: boolean, stageRef: RefObject<HTMLDivElement | null>): StageMetrics {
  const [metrics, setMetrics] = useState<StageMetrics>(FALLBACK_METRICS)
  useLayoutEffect(() => {
    if (!active) return
    const stage = stageRef.current
    if (!stage) return
    const apply = (width: number, height: number) => {
      const next = measureStage(width, height)
      setMetrics((current) => (sameMetrics(current, next) ? current : next))
    }
    apply(stage.clientWidth, stage.clientHeight)
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 }
      apply(width, height)
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [active, stageRef])
  return metrics
}

function sameMetrics(a: StageMetrics, b: StageMetrics): boolean {
  return a.scale === b.scale && a.designWidth === b.designWidth && a.designHeight === b.designHeight
}
