import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ProseFont } from '@shared/types'
import { useSession } from '../../../store/session'
import { createFenceBodies } from '../../../lib/markdown/fence-bodies'
import { SlideProse } from '../slide-prose'
import { useIsDarkTheme } from '../presentation-theme'
import { renderSlideSource, slicePageHtml, slideMarkup, type SlideMarkup } from '../slide-html'
import type { SlidePlan } from '../slide-pagination'
import { measureStage, SLIDE_PAD_X, SLIDE_PAD_Y, type StageMetrics } from '../slide-stage'
import type { SlideLayout } from '../slides'
import { usePresenterSlideMedia } from './use-presenter-slide-media'

function useStageAutoMetrics(containerRef: RefObject<HTMLDivElement | null>): StageMetrics {
  const [metrics, setMetrics] = useState(() => measureStage(640, 360))
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const apply = () => {
      const m = measureStage(el.clientWidth, el.clientHeight)
      setMetrics((prev) => (prev.scale === m.scale ? prev : m))
    }
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => apply())
    observer.observe(el)
    return () => observer.disconnect()
  }, [containerRef])
  return metrics
}

function PresenterScaledSlide({
  metrics,
  html,
  hostRef,
  font,
  layout,
}: {
  metrics: StageMetrics
  html: string
  hostRef?: RefObject<HTMLDivElement | null>
  font: ProseFont
  layout?: SlideLayout
}) {
  return (
    <div
      className='relative shrink-0 overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-editor)]'
      style={{
        width: metrics.designWidth * metrics.scale,
        height: metrics.designHeight * metrics.scale,
      }}
    >
      <div
        className='ink-slide absolute top-0 left-0'
        style={{
          width: metrics.designWidth,
          height: metrics.designHeight,
          transform: `scale(${metrics.scale})`,
          transformOrigin: 'top left',
        }}
      >
        <div
          className='absolute inset-x-0'
          style={{ top: SLIDE_PAD_Y, left: SLIDE_PAD_X, right: SLIDE_PAD_X }}
        >
          <SlideProse html={html} contentWidth={metrics.contentWidth} contentHeight={metrics.contentHeight} font={font} layout={layout} hostRef={hostRef} />
        </div>
      </div>
    </div>
  )
}

export function PresenterSlidePreview({
  source,
  layout,
  plan,
  sub = 0,
  step,
  font,
}: {
  source: string
  layout?: SlideLayout
  plan?: SlidePlan
  sub?: number
  /** How far this page has arrived (N-31). Absent draws it whole, which is what a slide the show never
   * stepped — and every thumbnail — asks for. */
  step?: number
  font?: ProseFont
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const metrics = useStageAutoMetrics(containerRef)
  const dark = useIsDarkTheme()
  const defaultFont = useSession((s) => s.settings.appearance.proseFont) ?? 'sans'
  const proseFont = font ?? defaultFont

  const slide = useMemo<SlideMarkup>(() => {
    if (!source) return { html: '', fences: createFenceBodies() }
    const markup = slideMarkup(renderSlideSource(source))
    if (plan && plan.pages.length > 0) {
      return { html: slicePageHtml(markup.html, plan, sub, metrics.contentWidth, metrics.contentHeight, step), fences: markup.fences }
    }
    return markup
  }, [source, plan, sub, step, metrics.contentWidth, metrics.contentHeight])

  usePresenterSlideMedia({ hostRef, html: slide.html, fences: slide.fences, dark, metrics })

  const effectiveLayout = plan?.layout ?? layout

  return (
    <div ref={containerRef} className='relative flex h-full w-full items-center justify-center overflow-hidden'>
      <PresenterScaledSlide metrics={metrics} html={slide.html} hostRef={hostRef} font={proseFont} layout={effectiveLayout} />
    </div>
  )
}
