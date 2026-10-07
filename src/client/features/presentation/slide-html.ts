import { renderMarkdown, type RenderResult } from '../../lib/markdown/renderer'
import type { FenceBodies } from '../../lib/markdown/fence-bodies'
import type { PreviewSettings } from '@shared/types'
import { takeLayoutDirective, takeStepDirective, type SlideLayout } from './slides'
import { resolvePageIndex, type SlidePage, type SlidePlan } from './slide-pagination'

/**
 * A slide's prepared markup with the fence bodies it was rendered from (P-01).
 *
 * The two travel together because a serialized slide is re-enhanced downstream: the printed deck
 * runs the snapshot renderers over the pages it is handed, and a `kanban` block there reads its
 * board back out of the set, not out of its own attributes. Markup cached without its bodies prints
 * those blocks as empty fences.
 */
export interface SlideMarkup {
  html: string
  fences: FenceBodies
  /** The layout the slide's own source asked for, taken out of the markup before it was rendered. */
  layout?: SlideLayout
  /** Whether the slide's source asked to reveal its blocks one step at a time (N-31). */
  steps?: boolean
  /**
   * Set when the markup has been through the enhancement chain — or was captured from a page that
   * has. A plain render is what the cache holds *while* a page is being prepared, so a reader that
   * took it for the finished page would leave the diagrams as placeholders for good: the run that
   * was interrupted (the presenter turned the page, the show re-rendered under it) cached the text
   * before it started drawing, and nothing would come back to draw it.
   */
  prepared?: boolean
  /**
   * Set when a canvas has run its own diagram pass over this markup and the capture came from the page
   * afterwards. It is a separate answer from `prepared` because the two are produced by different
   * work: the enhancement chain runs off-DOM and cannot draw a mermaid or a chart — those are drawn by
   * the canvas, into the live page, which is also where the capture is taken from. A surface that took
   * `prepared` for "there is a picture in here" shipped the loading placeholders: after a theme flip the
   * slide list kept every page's placeholders for the rest of the show, because the background pass read
   * the *plan* cache as "this slide is already listed" and never went back to draw it (L-1).
   */
  drawn?: boolean
  /**
   * Which display settings this entry was prepared under, as `slideSettingFlags` writes them. The
   * enhancement chain reads `math`, `mermaid` and `chart` out of the account's own settings, so
   * a page prepared for one set of them is not the page the room asks for after the presenter turns one
   * off — and the key cannot say, because it names the slide's text, the theme and the box, none of
   * which moved. Readers compare it; a mismatch is a page that has not been prepared for these settings
   * (L-16). Absent means exactly what it says: nothing was prepared here.
   */
  flags?: string
  /**
   * Set when the page could not be enhanced: its diagrams, math and embeds stayed placeholders while
   * the text of the slide is still there. It travels with the entry rather than with a surface
   * because the slide list, the projector and the export all read the same prepared page — one of
   * them finding it broken is news for all of them.
   */
  failed?: boolean
}

/** A slide rendered for a surface, with the layout and the stepping its source switched on. */
export interface SlideRender extends RenderResult {
  layout?: SlideLayout
  steps?: boolean
}

/**
 * The settings a prepared page was drawn under, in the shortest form that still tells them apart: the
 * three switches that reach the enhancement chain on this fork. Anything else the account can turn —
 * the note's code-fence collapse, the table of contents, the pinned-window size — does not change what
 * a slide holds, so it must not cost a re-render of the deck someone is standing on.
 */
export function slideSettingFlags(preview: Pick<PreviewSettings, 'math' | 'mermaid' | 'chart'>): string {
  return `${preview.math ? 'm' : '-'}${preview.mermaid ? 'd' : '-'}${preview.chart ? 'c' : '-'}`
}

/**
 * The entry a surface may draw from, given the settings it is drawing for. A page the preparation chain
 * wrote names the settings it was written under, and a page for others is not this page (L-16). An entry
 * with nothing named on it is the plain render someone parked there mid-flight: every surface already
 * reads that as "not prepared yet" and renders over it, so it is left alone here rather than given a
 * second meaning.
 */
export function stagedFor(markup: SlideMarkup | undefined, flags: string): SlideMarkup | undefined {
  return markup && markup.flags !== undefined && markup.flags !== flags ? undefined : markup
}

// Enhanced per-slide markup keyed by content fingerprint + theme + slide index,
// so a remount (e.g. across fullscreen toggles) reuses the last good html instead
// of resetting diagrams to their loading placeholders. The slide list renders the
// same cache, which is why the key is derived here instead of inside the canvas.
const slideHtmlCache = new Map<string, SlideMarkup>()
// The floors are what a short note needs; a long deck raises them for as long as it is on screen
// through `reserveSlideCache` below, because a cap under the deck's page count makes the measuring
// pass evict the pages it has already prepared while it prepares the ones it has not.
const SLIDE_HTML_CACHE_FLOOR = 60
let slideHtmlCacheLimit = SLIDE_HTML_CACHE_FLOOR
const slideHtmlListeners = new Set<() => void>()

const slidePlanCache = new Map<string, SlidePlan>()
// A plan is a small array per page rather than a page of markup, so this cache carries twice the
// floor of the markup one and grows by the same reservation.
const SLIDE_PLAN_CACHE_FLOOR = 120
let slidePlanCacheLimit = SLIDE_PLAN_CACHE_FLOOR

/**
 * Let the caches hold one entry per page of the deck the show is presenting. Without this a deck
 * longer than the floor evicts its own beginning mid-pass: the rail and the projector then re-render
 * what was just thrown away, so the same page is prepared twice and the pass never reads as done.
 * A deck shorter than the floor leaves the floors alone, and the next show shrinks the ceiling back
 * down rather than inheriting the widest deck of the evening.
 */
export function reserveSlideCache(pages: number): void {
  slideHtmlCacheLimit = Math.max(SLIDE_HTML_CACHE_FLOOR, pages)
  slidePlanCacheLimit = Math.max(SLIDE_PLAN_CACHE_FLOOR, pages)
}

export function clearSlideHtmlCache(): void {
  slideHtmlCache.clear()
}

export function readSlidePlan(hash: string): SlidePlan | undefined {
  return slidePlanCache.get(hash)
}

export function rememberSlidePlan(hash: string, plan: SlidePlan): void {
  slidePlanCache.delete(hash)
  slidePlanCache.set(hash, plan)
  while (slidePlanCache.size > slidePlanCacheLimit) {
    const oldest = slidePlanCache.keys().next().value
    if (oldest === undefined) break
    slidePlanCache.delete(oldest)
  }
}

export function clearSlidePlanCache(): void {
  slidePlanCache.clear()
}

/**
 * The plans the show holds, re-keyed onto a deck that may have changed. It is handed the deck's own
 * slide hashes rather than the deck because the caller already carries them: taking the text and
 * hashing it again here would be a second walk over the whole deck to answer a question the deck has
 * already answered.
 */
export function buildIncrementalSlidePlans(hashes: string[], current: Record<number, SlidePlan> = {}): Record<number, SlidePlan> {
  const next: Record<number, SlidePlan> = {}
  let changed = false
  for (let i = 0; i < hashes.length; i++) {
    const hash = hashes[i] ?? ''
    const cached = readSlidePlan(hash)
    if (cached) {
      next[i] = cached
      if (current[i] !== cached) changed = true
    } else if (current[i]) {
      changed = true
    }
  }
  if (Object.keys(current).length !== Object.keys(next).length) changed = true
  return changed ? next : current
}

export function hashContent(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index++) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  return `${value.length}:${(hash >>> 0).toString(36)}`
}

/**
 * The content box is part of the key because a diagram is drawn for it: a slide
 * prepared for a laptop's stage and the same slide prepared for a projector draw
 * their mind maps at different sizes, and reusing one for the other would show a
 * picture measured for a box that is no longer the one on screen.
 */
export function slideCacheKey(options: { fingerprint: string; dark: boolean; index: number; contentWidth: number; contentHeight: number }): string {
  const { fingerprint, dark, index, contentWidth, contentHeight } = options
  return `${fingerprint}:${dark ? 'd' : 'l'}:${index}:${Math.round(contentWidth)}x${Math.round(contentHeight)}`
}

export function readSlideHtml(key: string): SlideMarkup | undefined {
  return slideHtmlCache.get(key)
}

/** The entry a plain render makes, for a slide whose prepared markup never landed in the cache. */
export function slideMarkup(rendered: SlideRender): SlideMarkup {
  return { html: rendered.html, fences: rendered.fences, layout: rendered.layout, steps: rendered.steps }
}

/**
 * Mark the page that could not be enhanced. The plain markup written before the enhancement stays in
 * the cache — the slide's text is readable, only its diagrams and math stayed placeholders — so the
 * failure rides on that entry rather than on a surface: the projector, the slide list and the printed
 * deck all read the same prepared page, and one of them finding it broken is news for all three.
 */
export function markSlideFailed(key: string, flags: string): void {
  const staged = slideHtmlCache.get(key)
  if (staged) rememberSlideHtml(key, { ...staged, failed: true, flags })
}

const slideKeyListeners = new Map<string, Set<() => void>>()

export function rememberSlideHtml(key: string, markup: SlideMarkup): void {
  slideHtmlCache.delete(key)
  slideHtmlCache.set(key, markup)
  while (slideHtmlCache.size > slideHtmlCacheLimit) {
    const oldest = slideHtmlCache.keys().next().value
    if (oldest === undefined) break
    slideHtmlCache.delete(oldest)
  }
  const keyListeners = slideKeyListeners.get(key)
  if (keyListeners) {
    for (const listener of keyListeners) listener()
  }
  for (const listener of slideHtmlListeners) listener()
}

// Readers that render from the cache subscribe to it: a slide's markup is written several
// times (the plain render, then the enhanced one, then a canvas's diagram-bearing capture),
// and a reader that only looked once would keep the placeholder it saw first.
export function subscribeSlideHtml(listener: () => void): () => void {
  slideHtmlListeners.add(listener)
  return () => {
    slideHtmlListeners.delete(listener)
  }
}

export function subscribeSlideHtmlKey(key: string, listener: () => void): () => void {
  let set = slideKeyListeners.get(key)
  if (!set) {
    set = new Set()
    slideKeyListeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
    if (set && set.size === 0) slideKeyListeners.delete(key)
  }
}

// What the measuring canvas captured for a slide, as markup for the cache. The capture is a
// source other surfaces render from again — the projector, the slide list, the printed deck — so
// it has to be as re-renderable as the markup it came from. A chart is the one block that is not:
// its instance and its canvas pixels cannot be serialized, so the clone gets a still of what was
// on screen (a chart picture for the list and the printed page) and no "already rendered" marker
// (a still is not a chart), which is what makes the projector draw a live one on its own canvas.
// A diagram's SVG does survive serialization, and its marker is what lets the cached copy be
// hydrated instead of re-rendered, so that one is left alone.
export function captureSlideHtml(host: HTMLElement | null): string | null {
  const page = host?.querySelector<HTMLElement>('[data-slide-page]')
  if (!page) return null
  const clone = page.cloneNode(true) as HTMLElement
  const live = page.querySelectorAll<HTMLElement>('[data-chart]')
  // Both trees come from the same markup, so their chart blocks line up by their walking order.
  clone.querySelectorAll<HTMLElement>('[data-chart]').forEach((block, index) => {
    const source = live[index]
    if (source) freezeChart(block, source)
  })
  return clone.innerHTML
}

// A clone's canvas has no pixels — `cloneNode` copies the element, not the drawing — so the still
// comes from the live canvas and replaces the clone's canvas in place.
function freezeChart(block: HTMLElement, source: HTMLElement): void {
  const canvas = source.querySelector('canvas')
  delete block.dataset.rendered
  if (!canvas) return
  try {
    const still = document.createElement('img')
    still.className = 'chartjs-still'
    still.alt = ''
    still.src = canvas.toDataURL('image/png')
    const target = block.querySelector('canvas')
    if (target) target.replaceWith(still)
    else block.appendChild(still)
  }
  catch (error: unknown) {
    // Best-effort: a canvas chart.js drew a cross-origin image into cannot be read back, and its
    // block still renders live on the projector — only the list and the printed page lose the
    // picture for that one chart.
    console.warn('[inkstone] chart capture failed', error)
  }
}

// The un-enhanced render is both the thumbnail source and the first paint of a
// slide canvas, before diagrams finish rendering into the cache.
// The layout switch is consumed here rather than at the surfaces: it is a property of what the
// slide is drawn from, and a switch left in the text would paint as a stray comment on the page.
/**
 * What a slide has to give up: every control a block head ships, and the anchor the heading plugin
 * puts beside every title.
 *
 * Those buttons act on a live root — the note's editor, a pane the room never sees — so on a slide
 * they are dead, and a dead button is worse than an absent one: the projector turns the page by a
 * click anywhere on it, and its first rule is to leave a click on an interactive element alone. A
 * presenter pressing on a block's head therefore pressed into nothing at all (N-37). The list is this
 * fork's own set of control families — the tab strip's buttons and the six block toolbars' triggers
 * included — and `slide-control-coverage.test.ts` fails the moment the preview ships a pressable
 * control that is not on it. Removing them is also why no "not interactive while presenting" notice
 * was added — a surface with nothing dead on it needs no apology.
 */
export const SLIDE_CONTROL_SELECTORS = [
  'a.heading-anchor',
  '[data-copy]',
  '[data-tab-button]',
  '[data-kanban-fullscreen]',
  '[data-mindmap-fullscreen]',
  '[data-mindmap-fit]',
  '[data-mindmap-theme-pick]',
  '[data-mindmap-action]',
  '[data-mindmap-retry]',
  '[data-mermaid-retry]',
  '[data-code-collapse]',
  '[data-js-run]',
  '[data-js-switch]',
  '[data-chart-action]',
  '[data-code-action]',
  '[data-example-action]',
  '[data-panel-action]',
  '[data-tabs-action]',
]

const SLIDE_CONTROL_SELECTOR = SLIDE_CONTROL_SELECTORS.join(', ')

/**
 * Strips those controls out of one slide's markup, and takes the two live affordances that are not
 * buttons off the page as well.
 *
 * This runs where every slide surface reads from, so the projector, the slide list, the overview
 * grid, the presenter's panes, the printed sheet and the PNG export cannot disagree about what is
 * pressable. The blocks themselves, their placeholders and their fence bodies are left alone — a
 * snapshot still has to be drawn from the body the markup was built with (P-01).
 *
 * The two affordances are this fork's own, and both are worse than a dead button:
 *
 * - A task list's checkbox is a real `<input>` the renderer materialises for every surface, and the
 *   stage's first click rule bails on `input`. So a checkbox on a slide swallowed the page turn and
 * *then* flipped its own picture, showing the room a state the note never got. It is taken out of the
 * hit test and out of the tab order rather than deleted, because whether the author checked the box
 * is content the slide is showing.
 * - A code block that names its own collapse threshold is truncated by the enhancement chain and
 *   given an expand button — which is the one thing a projector cannot use. The switch is lifted out
 *   here so the block keeps its full height, and the deck's own pagination then pages a long block
 *   through its lines the way it pages anything else too tall for a slide.
 */
export function dropSlideControls(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll(SLIDE_CONTROL_SELECTOR).forEach((control) => control.remove())
  template.content.querySelectorAll<HTMLElement>('[data-task-line]').forEach((box) => {
    delete box.dataset.taskLine
    box.removeAttribute('name')
    box.tabIndex = -1
    box.style.pointerEvents = 'none'
  })
  template.content.querySelectorAll<HTMLElement>('[data-code-collapse-at]').forEach((block) => {
    delete block.dataset.codeCollapseAt
  })
  return template.innerHTML
}

export function renderSlideSource(source: string): SlideRender {
  // Both switches are the author's, and both are lifted out before the slide is rendered: a comment
  // left in the text would paint as a stray node on the projector (N-31).
  const { body: stepped, steps } = takeStepDirective(source)
  const { body, layout } = takeLayoutDirective(stepped)
  const rendered = renderMarkdown(body, { hideFrontMatter: true })
  return { ...rendered, html: dropSlideControls(rendered.html), layout, steps }
}

// One page of a measured slide, as markup. The canvas shows a page by translating
// the whole slide and hiding the rest, which is what chart.js needs to measure its
// canvas; a thumbnail only has to look right, so it gets just the page's own blocks
// and skips the geometry — that keeps a 14-page slide from mounting 14 full copies
// of its markup in the slide list. Blocks a page had to shrink keep their factor, and
// a block that continues over several pages keeps the band this page owns.
export function slicePageHtml(html: string, plan: SlidePlan, subPage: number, contentWidth: number, contentHeight: number, step?: number): string {
  const page = plan.pages[resolvePageIndex(plan, subPage)]
  if (!page) return html
  const template = document.createElement('template')
  template.innerHTML = html
  const children = [...template.content.children]
  const kept = children.slice(page.from, page.to)
  kept.forEach((child, offset) => {
    // The canvas hides off-page blocks with an inline `visibility`; a sliced page starts from the
    // markup it was cut out of and states its own visibility instead of inheriting that. A stepped
    // slide (N-31) hides what the step had not reached, which is how one page becomes several
    // printed states without a projector to run the reveal for it.
    if (child instanceof HTMLElement) {
      const revealed = step !== undefined && plan.steps && offset > step
      child.style.visibility = revealed ? 'hidden' : ''
    }
    applySliceBand(child, page.clip)
    applySliceScale(child, plan.scales[page.from + offset] ?? 1, contentWidth, contentHeight)
  })
  return kept.map((child) => child.outerHTML).join('')
}

// The projector brings a continued block's band to the page by translating the whole slide; a slice
// has no wrapper to move, and the block it kept starts at the top of its own page box, so the band
// travels by itself. A detached `<template>` reports every offset as 0, so the band can only come
// from the plan rather than be measured out of the markup here.
function applySliceBand(child: Element, clip: SlidePage['clip']): void {
  if (!clip || !(child instanceof HTMLElement)) return
  child.style.clipPath = `inset(${clip.top}px 0 ${clip.bottom}px 0)`
  // The projector's page already starts at this band, so a band that opens the block needs no lift.
  if (clip.top > 0) child.style.transform = `translateY(${-clip.top}px)`
}

function applySliceScale(child: Element, scale: number, contentWidth: number, contentHeight: number): void {
  if (scale >= 1 || !(child instanceof HTMLElement)) return
  child.style.transformOrigin = 'top left'
  child.style.transform = `scale(${scale})`
  child.style.width = `${contentWidth / scale}px`
  child.style.height = `${contentHeight / scale}px`
  child.style.overflow = 'hidden'
}
