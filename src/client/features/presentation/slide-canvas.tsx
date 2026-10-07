import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useSession } from '../../store/session'
import { destroyChartInstances, renderPendingCharts, renderPendingMermaid } from '../../lib/markdown/enhance'
import { useIsDarkTheme } from './presentation-theme'
import { readSlideHtml, renderSlideSource, stagedFor, slideSettingFlags, subscribeSlideHtml } from './slide-html'
import { planSlidePages, resolvePageIndex, samePlan, slideLayoutForFit, type SlideBlock, type SlidePlan } from './slide-pagination'
import type { SlideLayout } from './slides'
import { LAYOUT_CLASS, SlideProse } from './slide-prose'
import { SLIDE_PAD_Y, type StageMetrics } from './slide-stage'
import { registerFenceBodies, type FenceBodies } from '../../lib/markdown/fence-bodies'
import { interceptSlideLink, isBlockedSlideLinkHref } from './presentation-state'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'

const HEADING_TAG = /^H[1-6]$/

export interface SlideCanvasProps {
  cacheKey: string
  source: string
  subPage: number
  /**
   * How far into this page the show has walked (N-31). Absent means the whole page is on screen,
   * which is what every surface except the projector draws: a thumbnail, a printed page and the
   * overview grid all show the slide as finished, not as paused mid-sentence.
   */
  step?: number
  contentWidth: number
  contentHeight: number
  /**
   * The measured plan, shared with the show so the slide list can list this
   * slide's pages and the counter can name them. The canvas is the only place a
   * plan is measured because it renders the same markup the projector shows.
   *
   * The second argument says whether this canvas's own diagram pass is over. A page measured before it
   * is a page of placeholders, and the background pass captures what the page holds at the moment it
   * reports — so the pass that advanced on the first report listed the placeholders for the slide list
   * to paint (L-1). Every surface is free to ignore it; the one that fills a cache is the one that has
   * to wait for it.
   */
  onPlan: (plan: SlidePlan, settled: boolean) => void
  /**
   * Whether charts are drawn with their entrance animation. Off by default, because the projector's
   * canvas is looked at. The measuring pass turns it on: it is invisible, and its markup is captured
   * for the slide list — the capture reads the canvas, and chart.js draws its first frame on a later
   * one, so a pass that captured an animated chart shipped a picture of nothing (measured: 0 of
   * 51604 pixels drawn at capture, the whole chart after the animation).
   */
  instantCharts?: boolean
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// The design canvas is laid out at its design size and scaled, so the slide image
// matches the stage box exactly and the browser does the scaling on the compositor.
export function SlideViewport({ metrics, cacheKey, source, subPage, step, onPlan, instantCharts }: { metrics: StageMetrics } & Omit<SlideCanvasProps, 'contentWidth' | 'contentHeight'>) {
  return (
    <div
      data-slide-canvas
      className='shrink-0 overflow-hidden bg-[var(--bg-editor)]'
      style={{ width: metrics.designWidth, height: metrics.designHeight, transform: `scale(${metrics.scale})` }}
    >
      <SlideCanvas
        cacheKey={cacheKey}
        source={source}
        subPage={subPage}
        step={step}
        contentWidth={metrics.contentWidth}
        contentHeight={metrics.contentHeight}
        onPlan={onPlan}
        instantCharts={instantCharts}
      />
    </div>
  )
}

export function SlideCanvas({ cacheKey, source, subPage, step, contentWidth, contentHeight, onPlan, instantCharts = false }: SlideCanvasProps) {
  const proseFont = useSession((s) => s.settings.appearance.proseFont)
  const preview = useSession((s) => s.settings.preview)
  const flags = slideSettingFlags(preview)
  const dark = useIsDarkTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const staged = useSyncExternalStore(subscribeSlideHtml, () => readSlideHtml(cacheKey))
  // A page prepared under the account's *other* settings is not this page: the cache key names the
  // slide, the theme and the box, and none of those moved when the presenter turned a display switch
  // mid-show. Until the preparer replaces the entry the canvas draws its own plain render, which is
  // the same shape a first visit already takes (L-16).
  const prepared = stagedFor(staged, flags)
  // The cache is the prepared markup for this slide; the plain render only exists to cover the
  // first paint before it lands. It is therefore *not* run when the cache already answers: the
  // measuring pass walks slide after slide it has just prepared, and rendering each of them a second
  // time to throw the result away is markdown work paid for in the middle of a talk.
  const shown = useMemo(() => prepared ?? renderSlideSource(source), [prepared, source])
  const html = shown.html
  const fences = shown.fences
  const requestedLayout = shown.layout
  const diagrams = useDiagramPass(html, dark)
  const { plan, measured } = useSlideLayout(hostRef, html, requestedLayout, shown.steps, subPage, step, contentWidth, contentHeight, diagrams.version)
  const prefersMotion = prefersReducedMotion()
  const effectiveInstantCharts = instantCharts || prefersMotion
  useSlideDiagrams({ hostRef, html, dark, onRendered: diagrams.onRendered, onSettled: diagrams.onSettled, instantCharts: effectiveInstantCharts, mermaid: preview.mermaid, chart: preview.chart })
  useSlideFenceBodies(hostRef, html, fences)
  useFontLoadedMeasure(diagrams.onRendered)
  // Only a measurement of the markup on screen is published. The canvas is reused when
  // the show moves to another slide, so its state still holds the previous slide's plan
  // for the first commit: reporting that would tell the show — and the slide list — that
  // the new slide has as many pages as the old one, and the show clamps the presenter's
  // page against that number, which bounced a click on page 2 back to page 1.
  // A rendered diagram bumps the version, and that report matters too: the deck-measuring
  // pass captures the canvas's markup for the slide list, and the capture has to be the one
  // taken after the diagrams are in place, or the list shows their loading placeholders.
  useEffect(() => {
    if (measured) onPlan(plan, diagrams.settled)
  }, [measured, plan, diagrams.version, diagrams.settled, onPlan])
  const page = plan.pages[resolvePageIndex(plan, subPage)]

  const handleLinkClick = useSlideLinkInterceptor()

  return (
    <div className='ink-slide relative h-full w-full overflow-hidden' onClick={handleLinkClick}>
      <div className='absolute inset-x-0' style={{ top: SLIDE_PAD_Y, transform: `translateY(-${page?.top ?? 0}px)` }}>
        <SlideProse html={html} contentWidth={contentWidth} contentHeight={contentHeight} font={proseFont} layout={plan.layout} hostRef={hostRef} />
      </div>
    </div>
  )
}

export function useSlideLinkInterceptor() {
  return useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest('a')
    if (!anchor) return
    event.preventDefault()
    event.stopPropagation()
    const href = anchor.getAttribute('href')
    if (interceptSlideLink(href, (url, target, features) => window.open(url, target, features))) return
    // The click is swallowed either way, so a refused href would otherwise look like a slide that
    // ignores the presenter. An in-page jump is not a refusal and must stay quiet.
    if (isBlockedSlideLinkHref(href)) {
      useUi.getState().toast({ title: t('workspace.presentation_link_blocked'), tone: 'warning' })
    }
  }, [])
}

// Measuring and applying happen in the same pass, because an out-of-plan block
// must never survive a re-measure that produced the same plan: the ResizeObserver
// re-runs after every style write, and a plan-diffed effect would skip restoring
// the shrink the reset step just cleared.
function useSlideLayout(hostRef: RefObject<HTMLDivElement | null>, html: string, requestedLayout: SlideLayout | undefined, steps: boolean | undefined, subPage: number, step: number | undefined, contentWidth: number, contentHeight: number, renderVersion: number): { plan: SlidePlan; measured: boolean } {
  // The plan is stored next to the markup it was measured from, so a plan that
  // describes a slide the canvas no longer shows is never handed out as current.
  const [captured, setCaptured] = useState<{ html: string; plan: SlidePlan } | null>(null)
  const placeholder = useMemo(() => planSlidePages([], contentHeight, requestedLayout), [contentHeight, requestedLayout])
  const subPageRef = useRef(subPage)
  subPageRef.current = subPage
  const stepRef = useRef(step)
  stepRef.current = step
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    let frame = 0
    const measure = () => {
      const { children, blocks, columnHeight } = readSlideGeometries(host)
      const next = planSlidePages(blocks, contentHeight, slideLayoutForFit(requestedLayout, columnHeight, contentHeight), steps)
      applySlidePage(children, next, subPageRef.current, contentWidth, contentHeight, stepRef.current)
      if (next.layout) host.classList.add(LAYOUT_CLASS[next.layout])
      setCaptured((current) => (current?.html === html && samePlan(current.plan, next) ? current : { html, plan: next }))
    }
    const schedule = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(measure)
    }
    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [hostRef, html, requestedLayout, steps, contentWidth, contentHeight, renderVersion])
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    applySlidePage([...host.children] as HTMLElement[], captured?.html === html ? captured.plan : placeholder, subPage, contentWidth, contentHeight, step)
  }, [hostRef, captured, html, placeholder, subPage, step, contentWidth, contentHeight])
  const current = captured?.html === html
  return { plan: current ? captured.plan : placeholder, measured: current }
}

// The two geometries a slide can be drawn in, read in one pass by a measurement that puts its own
// classes on and takes them off again. Reading whatever the previous commit left on the host would
// make the answer depend on the class the answer itself produces: on a slide whose columns overflow
// the page the column plan and the flow plan trade places every frame, so the ResizeObserver never
// settles and the background pass that lists the deck never reaches its end.
function readSlideGeometries(host: HTMLElement): { children: HTMLElement[]; blocks: SlideBlock[]; columnHeight: number } {
  const children = [...host.children] as HTMLElement[]
  host.classList.remove(LAYOUT_CLASS.cover, LAYOUT_CLASS.split)
  resetBlockFit(children)
  // The design canvas is scaled to the stage, so a rect is in device pixels while everything the
  // walk packs with is design pixels; the host's own two readings give the ratio between them.
  const hostRect = host.getBoundingClientRect().height
  const devicePerDesign = host.offsetHeight > 0 && hostRect > 0 ? hostRect / host.offsetHeight : 1
  const blocks: SlideBlock[] = children.map((child) => ({
    top: child.offsetTop,
    height: child.offsetHeight,
    heading: HEADING_TAG.test(child.tagName),
    breaks: slideBreakOffsets(child, devicePerDesign),
  }))
  // Two columns are the one layout the page walk cannot page through, so a slide keeps them only while
  // the taller column fits the page — and that height is only there with the columns drawn.
  host.classList.add(LAYOUT_CLASS.split)
  const columnHeight = host.offsetHeight
  host.classList.remove(LAYOUT_CLASS.split)
  return { children, blocks, columnHeight }
}

/**
 * Where a page may cut into this block, in design pixels from its own top.
 *
 * A table's rows and a list's items each carry their own box, and the walk reads their real tops: a
 * row is as tall as its tallest cell, so an average of them would cut through one. A code block is a
 * single text run with no markup per line, but `pre` never wraps, so its line boxes are uniform and
 * its box divided by its line count lands on each of them.
 */
function slideBreakOffsets(child: HTMLElement, devicePerDesign: number): number[] {
  const height = child.offsetHeight
  const top = child.getBoundingClientRect().top
  const units = breakUnits(child)
  if (units.length > 1) {
    return units
      .map((unit) => (unit.getBoundingClientRect().top - top) / devicePerDesign)
      .filter((offset) => offset > 0 && offset < height)
  }
  const code = child.querySelector<HTMLElement>(':scope > pre > code')
  const lines = code ? (code.textContent ?? '').replace(/\n$/, '').split('\n').length : 0
  if (!code || lines < 2) return []
  const box = code.getBoundingClientRect()
  const step = box.height / lines / devicePerDesign
  const start = (box.top - top) / devicePerDesign
  return Array.from({ length: lines - 1 }, (_, index) => start + step * (index + 1)).filter((offset) => offset < height)
}

/** The elements whose own top is somewhere a page can start: a table's rows, a list's items. */
function breakUnits(child: HTMLElement): Element[] {
  if (child.querySelector(':scope > table')) return [...child.querySelectorAll('tr')]
  return child.matches('ul, ol') ? [...child.querySelectorAll('li')] : []
}

function resetBlockFit(children: HTMLElement[]): void {
  for (const child of children) {
    child.style.transform = ''
    child.style.transformOrigin = ''
    child.style.width = ''
    child.style.height = ''
    child.style.overflow = ''
    child.style.clipPath = ''
  }
}

// Off-page blocks hide via visibility rather than display, so chart.js never
// re-measures a diagram when the page changes; an oversized block is scaled down
// so its whole content stays visible instead of being clipped or scrolled, and a
// block that continues over several pages is cut to the band this page owns.
export function applySlidePage(children: HTMLElement[], plan: SlidePlan, subPage: number, contentWidth: number, contentHeight: number, step?: number): void {
  const page = plan.pages[resolvePageIndex(plan, subPage)]
  children.forEach((child, index) => {
    const onPage = Boolean(page) && index >= page!.from && index < page!.to
    // A stepped page holds its later blocks back until the show reaches them (N-31). Same mechanism as
    // an off-page block — `visibility`, not `display` — because a diagram that was only hidden keeps
    // the canvas it drew, so revealing the next block never re-renders the one before it.
    const revealed = step === undefined || !plan.steps || index - (page?.from ?? 0) <= step
    child.style.visibility = !onPage || !revealed ? 'hidden' : ''
    // The canvas clips at its own design box, which is a slide's padding taller than a page, so the
    // band a continued block shows on this page has to be cut by the plan rather than left to
    // overflow: the rows below it belong to the next page and would be drawn twice.
    child.style.clipPath = onPage && page!.clip ? `inset(${page!.clip.top}px 0 ${page!.clip.bottom}px 0)` : ''
    const scale = plan.scales[index] ?? 1
    if (scale >= 1) {
      child.style.transform = ''
      child.style.transformOrigin = ''
      child.style.width = ''
      child.style.height = ''
      child.style.overflow = ''
      return
    }
    child.style.transformOrigin = 'top left'
    child.style.transform = `scale(${scale})`
    child.style.width = `${contentWidth / scale}px`
    child.style.height = `${contentHeight / scale}px`
    child.style.overflow = 'hidden'
  })
}

// Diagrams are rendered once per committed markup and theme, exactly like the
// editor preview does: an observer-driven re-render would fire on the diagram's
// own DOM writes and re-render them forever, and every pagination re-measure
// would then see the leftover placeholders instead of the diagram's real height.
// The canvas's two answers about its own diagram pass. They are separate because a bump is not an
// ending: a font arriving, or a bento block falling back to still cards, changes what the page measures
// and has to be re-measured, while only the diagram pass says the page is as finished as this canvas
// will ever make it — and that is the answer a surface filling a cache from a capture has to wait for.
function useDiagramPass(html: string, dark: boolean): { onRendered: () => void; onSettled: () => void; settled: boolean; version: number } {
  const [version, setVersion] = useState(0)
  const [settled, setSettled] = useState(false)
  const onRendered = useCallback(() => setVersion((value) => value + 1), [])
  // Both callbacks are stable on purpose: the diagram pass lists them among its own dependencies, so an
  // identity that changed every render would re-run the pass, which would settle the page, which would
  // render — a loop built out of two `useCallback`s that forgot their brackets.
  const onSettled = useCallback(() => setSettled(true), [])
  useEffect(() => {
    setSettled(false)
  }, [html, dark])
  return { onRendered, onSettled, settled, version }
}

function useSlideDiagrams({ hostRef, html, dark, onRendered, onSettled, instantCharts, mermaid, chart }: {
  hostRef: RefObject<HTMLDivElement | null>
  html: string
  dark: boolean
  onRendered: () => void
  onSettled: () => void
  instantCharts: boolean
  mermaid: boolean
  chart: boolean
}): void {
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    const render = async () => {
      try {
        // The account's own display preferences, honoured here rather than assumed: the enhancement
        // chain that painted this page may have written the fence's source into the block, and drawing
        // on top of that is what turns a turned-off setting into a diagram the room never asked for.
        if (mermaid) await renderPendingMermaid(host, dark)
        if (chart && !cancelled) await renderPendingCharts(host, dark, { instant: instantCharts })
      } finally {
        // Settled means "this canvas is done with the page", not "the page has pictures": a diagram that
        // threw left the page as finished as this pass will ever make it, and a waiting surface has to
        // hear about that too rather than hold the page open until a guard gives up on it.
        if (!cancelled) {
          onRendered()
          onSettled()
        }
      }
    }
    void render().catch((error: unknown) => {
      console.warn('[inkstone] slide diagram rendering failed', error)
    })
    return () => {
      cancelled = true
      destroyChartInstances(host)
    }
  }, [html, dark, hostRef, onRendered, onSettled, instantCharts, mermaid, chart])
}

function useFontLoadedMeasure(onLoaded: () => void): void {
  useEffect(() => {
    let cancelled = false
    void document.fonts?.ready.then(() => {
      if (!cancelled) onLoaded()
    })
    return () => {
      cancelled = true
    }
  }, [onLoaded])
}


// This fork's `enhancePreview` takes no fence set, so every surface that puts slide markup into a DOM
// of its own has to register the bodies that markup was built from — a `kanban` block reads its board
// back out of the host, and a canvas that skipped this draws an empty fence. The registration is a
// plain write, so unlike the reference's bento fallback it never changes what the page measures and
// has no reason to bump a re-measure.
export function useSlideFenceBodies(
  hostRef: RefObject<HTMLDivElement | null>,
  html: string,
  fences?: FenceBodies,
): void {
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host && fences) registerFenceBodies(host, fences)
  }, [hostRef, html, fences])
}
