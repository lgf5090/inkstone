import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ProseFont } from '@shared/types'
import { settleWithin } from '../../lib/async'
import { safeFileName } from '../../lib/export-note'
import { getLocale, t } from '../../lib/i18n'
import { registerFenceBodies } from '../../lib/markdown/fence-bodies'
import { destroyChartInstances, renderMath, renderPendingCharts, renderPendingMermaid } from '../../lib/markdown/enhance'
import { renderStaticMindmaps } from '../../lib/markdown/mindmap/static'
import { renderStaticKanbans } from '../../lib/markdown/kanban/static'
import { useUi } from '../../store/ui'
import { collectDeckCss, deckImageGeometry, renderDeckPagePng, saveDeckImages, zipDeckImages } from './deck-image'
import { formatDeckPosition, type DeckPosition } from './deck-position'
import { railEntries } from './presentation-state'
import { readSlideHtml, renderSlideSource, slicePageHtml, slideMarkup, stagedFor, type SlideMarkup } from './slide-html'
import { planPageSteps, type SlidePlan } from './slide-pagination'
import { SlideProse } from './slide-prose'
import { SLIDE_PAD_X, SLIDE_PAD_Y, type StageMetrics } from './slide-stage'

// Exporting waits for the sheet to draw what the show draws, but not forever: a diagram that never
// settles must cost the export the diagram, not the export itself.
const PRINT_PREPARE_TIMEOUT_MS = 8000

/**
 * One exported page: the markup the show prepared for it, and where in the show that page was.
 *
 * The position travels with the page rather than being looked up at print time because the two exports
 * read different things — the printer reads this box, the archive reads a rasterization of it — and a
 * number that only one of them carries is the mismatch between the show and its export that this
 * closes (N-32).
 */
export interface DeckPrintPage extends SlideMarkup {
  /** Where in the show this sheet was, including how far that page had been revealed when the room saw
   * it (N-31). Absent on an unstepped page — `SlideMarkup.steps`, the author's switch, is a different thing. */
  position: DeckPosition
}

// The deck as printable pages, one per page the show walks — built from the same measured plans
// and the same prepared markup the projector renders, so a printed deck and a shown deck agree
// page for page. A slide whose markup was never prepared (the show was exported the instant it
// opened) still contributes its pages, rendered from the plain markdown.
export function buildDeckPages(
  deck: string[],
  cacheKeys: string[],
  plans: Record<number, SlidePlan>,
  metrics: StageMetrics,
  flags: string,
): DeckPrintPage[] {
  return railEntries(deck.length, plans).flatMap((entry): DeckPrintPage[] => {
    // The position is written the way the projector writes its own corner chip: which slide of the
    // deck, which page of that slide, and how far that page had arrived. Both exports read it off the
    // page, so what a printout says about "page 4 of 28, second reveal" is what the room read (N-32).
    const at = { index: entry.slide, count: deck.length, subPage: entry.sub, pageCount: entry.pageCount }
    // An entry prepared under other settings is not the page this export would print, so it reads as
    // nothing prepared and the plain render takes over — the same answer the show gives one beat after
    // the switch is turned, while the preparer replaces the entry (L-16).
    const markup = stagedFor(readSlideHtml(cacheKeys[entry.slide] ?? ''), flags) ?? slideMarkup(renderSlideSource(deck[entry.slide] ?? ''))
    const plan = plans[entry.slide]
    // A copy, always: the cached entry is shared with the show and the slide list, and neither of
    // them carries a printed page number.
    if (!plan) return [{ ...markup, position: at }]
    // The plan carries the layout: a slide the projector laid out as flow prints as flow, and one it
    // kept as columns prints in its columns, because the page numbers both surfaces walk are the
    // ones that plan measured.
    const steps = planPageSteps(plan, entry.sub)
    return Array.from({ length: steps + 1 }, (_, step) => ({
      html: slicePageHtml(markup.html, plan, entry.sub, metrics.contentWidth, metrics.contentHeight, steps > 0 ? step : undefined),
      fences: markup.fences,
      layout: plan.layout,
      position: steps > 0 ? { ...at, step, steps } : at,
    }))
  })
}

interface DeckSheetProps {
  /** One entry per deck page, from buildDeckPages(). */
  pages: DeckPrintPage[]
  metrics: StageMetrics
  font: ProseFont
  /** The theme the deck was measured in; a chart's axes follow it. */
  dark: boolean
}

// The exported pages themselves: one page box per deck page, each one the design canvas at 1:1,
// carrying the page's own markup. Nothing about the export surface is visible — it is laid out
// off-screen rather than hidden, because a `display: none` subtree has no size and a chart drawn
// into a zero-sized canvas exports empty — and `inert` keeps the buttons the prose markup carries
// out of the tab order, which hidden used to do for free.
function PrintedPage({ page, metrics, font }: { page: DeckPrintPage; metrics: StageMetrics; font: ProseFont }) {
  return (
    // The slide context, not the reader's prose one: these pages were measured with the
    // slide's own type scale and diagram sizes, and printing them in another scale would reflow
    // every page against the slice it was handed. Each one also carries the fence bodies its
    // own blocks were rendered from, which the snapshot draw looks up by walking up.
    <div className='deck-print-page' ref={(node) => { if (node) registerFenceBodies(node, page.fences) }}>
      <div className='deck-print-body ink-slide'>
        <SlideProse html={page.html} contentWidth={metrics.contentWidth} contentHeight={metrics.contentHeight} font={font} layout={page.layout} />
      </div>
      {/* Inside the page box, not beside it: the printer prints this box and the archive
      rasterizes it, so a number drawn outside would reach one of them and not the other. */}
      <span className='deck-print-page-number'>{formatDeckPosition(page.position)}</span>
    </div>
  )
}

function DeckSheet({ sheetRef, pages, metrics, font }: DeckSheetProps & { sheetRef: React.RefObject<HTMLDivElement | null> }) {
  const geometry = useMemo(() => deckPrintGeometry(metrics), [metrics])
  return createPortal(
    <div ref={sheetRef} data-deck-print aria-hidden='true' inert className='deck-print-sheet'>
      <style>{geometry}</style>
      {pages.map((page, index) => <PrintedPage key={index} page={page} metrics={metrics} font={font} />)}
    </div>,
    document.body,
  )
}

// Exporting the deck as a PDF runs through the browser's own print pipeline, the way a note is
// exported as PDF: the print stylesheet lets only this sheet through, and every page box is the
// design canvas at 1:1, so "Print to PDF" produces exactly the pages the show has.
export function DeckPrintSheet({ pages, metrics, font, dark, onDone }: DeckSheetProps & { onDone: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null)
  useDeckSheetReady(sheetRef, dark, metrics, (root) => {
    // Written straight to the node: the print dialog blocks right after this line, so a re-render
    // would never land in time for observers of the sheet.
    root.dataset.deckPrintReady = 'true'
    window.print()
  }, onDone)
  return <DeckSheet sheetRef={sheetRef} pages={pages} metrics={metrics} font={font} dark={dark} />
}

/** One page of the deck written, out of how many the export was asked to write. */
export interface DeckExportProgress {
  current: number
  total: number
}

// Exporting the deck as images uses the same pages: each is rendered to a PNG and the set is
// archived, because a download per page is a burst a browser may block.
export function DeckImageSheet({ pages, metrics, font, dark, title, onProgress, onDone }: DeckSheetProps & { title: string; onProgress: (progress: DeckExportProgress) => void; onDone: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null)
  useDeckSheetReady(sheetRef, dark, metrics, async (root) => {
    try {
      const count = await saveDeckPages(root, metrics, title, (current, total) => onProgress({ current, total }))
      root.dataset.deckImageReady = 'true'
      useUi.getState().toast({ title: t('workspace.presentation_images_saved', { value0: count }), tone: 'success' })
    }
    catch (error: unknown) {
      // A failed export is the one thing here the presenter has to be told about: nothing was
      // downloaded, so the toast is the only signal there is.
      console.warn('[inkstone] deck image export failed', error)
      root.dataset.deckImageReady = 'failed'
      useUi.getState().toast({ title: t('workspace.presentation_images_failed'), tone: 'danger' })
    }
    // The archive is out, so the sheet has nothing left to draw: it goes back to the show the same
    // way the printed sheet does when the print dialog closes. Held any longer it stays laid out
    // off-screen for the rest of the talk, and the show keeps announcing itself as busy.
    onDone()
  }, onDone)
  // The sheet draws and counts. What it counts towards is announced by the show itself
  // (`DeckExportProgress`), because this element is laid out off-screen and anything painted beside it
  // lands under the projector.
  return <DeckSheet sheetRef={sheetRef} pages={pages} metrics={metrics} font={font} dark={dark} />
}

/** One slide of the handout: every page it was walked as, and what the speaker wrote for it. */
export interface DeckHandoutSlide {
  index: number
  count: number
  pages: DeckPrintPage[]
  note: string
}

/**
 * Group the exported pages by the slide they came from.
 *
 * The handout is a sheet the speaker reads, and the notes are indexed by slide — so the unit is a
 * slide, not a printed page. A slide the projector split across pages keeps all of its pages in that
 * one handout entry, in the order the show walked them (N-32).
 */
export function groupDeckHandout(pages: DeckPrintPage[], notes: string[]): DeckHandoutSlide[] {
  const slides: DeckHandoutSlide[] = []
  // A stepped page reaches the handout once, as its author finished it: the handout is the deck read
  // in order, and four copies of one slide with one block more apiece would be the talk retold as a
  // contact sheet (N-31).
  const final = pages.filter((page) => page.position.step === undefined || page.position.step === page.position.steps)
  for (const page of final) {
    const last = slides.at(-1)
    if (last && last.index === page.position.index) {
      last.pages.push(page)
      continue
    }
    slides.push({ index: page.position.index, count: page.position.count, pages: [page], note: (notes[page.position.index] ?? '').trim() })
  }
  return slides
}

/**
 * The handout sheet as it is printed: one page per slide, the slide's own pages down the left as
 * pictures beside what the speaker wrote. `styles/presentation.css` keys the layout on
 * `.deck-handout-page` / `.deck-handout-figure` / `.deck-handout-slide`, and the figure scales a
 * `.deck-print-page` rather than re-rendering one at a smaller size — the picture has to be the page
 * the projector measured, only smaller, or the handout and the show disagree about where a line ends.
 */
function HandoutSheet({ sheetRef, slides, metrics, font }: { sheetRef: React.RefObject<HTMLDivElement | null> } & Omit<DeckSheetProps, 'pages' | 'dark'> & { slides: DeckHandoutSlide[] }) {
  const geometry = useMemo(() => deckPrintGeometry(metrics), [metrics])
  return createPortal(
    <div ref={sheetRef} data-deck-print data-deck-handout aria-hidden='true' inert className='deck-print-sheet deck-handout-sheet'>
      <style>{geometry}</style>
      {slides.map((slide) => (
        <div key={slide.index} className='deck-handout-page'>
          <div className='deck-handout-figure'>
            {slide.pages.map((page, position) => (
              <div key={position} className='deck-handout-slide'><PrintedPage page={page} metrics={metrics} font={font} /></div>
            ))}
          </div>
          <div className='deck-handout-body'>
            <p className='deck-handout-position'>{formatDeckPosition({ index: slide.index, count: slide.count, subPage: 0, pageCount: 1 })}</p>
            <p className='deck-handout-notes'>{slide.note === '' ? t('workspace.presentation_no_notes') : slide.note}</p>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  )
}

// The handout: one printed page per slide, the slide's own picture beside what the speaker meant to
// say about it. This is the sheet a reviewer keeps after the talk — the deck page answers "which slide
// was this", the notes answer what was said — and it goes through the same print pipeline as the deck
// itself, so the two agree about page size, theme and what a diagram looks like when it is on paper.
export function DeckHandoutSheet({ pages, notes, metrics, font, dark, onDone }: DeckSheetProps & { notes: string[]; onDone: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const slides = useMemo(() => groupDeckHandout(pages, notes), [pages, notes])
  useDeckSheetReady(sheetRef, dark, metrics, (root) => {
    // Written straight to the node: the print dialog blocks right after this line, so a re-render
    // would never land in time for observers of the sheet.
    root.dataset.deckPrintReady = 'true'
    window.print()
  }, onDone)
  return <HandoutSheet sheetRef={sheetRef} slides={slides} metrics={metrics} font={font} />
}

// Both exports share one lifecycle: mount the sheet, let it finish drawing what it has to draw, hand
// the finished sheet over, and tear everything down when the export is over for either reason —
// the caller saying so (`onDone`) or the overlay closing under it.
//
// The two callbacks are held in refs rather than taken as effect dependencies: the sheet writes them
// inline, so their identity changes on every render, and an export that reports its own progress
// renders on every page it draws. Depending on them therefore restarted the whole export — and the
// print dialog, and the archive, and the download — once per page, forever. What genuinely asks for
// a re-prepare is the theme and the geometry the pages were built for, and those are the deps.
function useDeckSheetReady(
  sheetRef: React.RefObject<HTMLDivElement | null>,
  dark: boolean,
  metrics: StageMetrics,
  handOver: (root: HTMLDivElement) => void | Promise<void>,
  onDone: () => void,
): void {
  const handOverRef = useRef(handOver)
  const doneRef = useRef(onDone)
  useEffect(() => {
    handOverRef.current = handOver
    doneRef.current = onDone
  })
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const root = sheetRef.current
      if (!root) return
      await prepareDeckSheet(root, dark)
      if (!cancelled) await handOverRef.current(root)
    }
    const finished = () => doneRef.current()
    window.addEventListener('afterprint', finished)
    void run()
    return () => {
      cancelled = true
      window.removeEventListener('afterprint', finished)
      destroyChartInstances(sheetRef.current)
    }
  }, [dark, metrics, sheetRef])
}

export async function saveDeckPages(root: HTMLElement, metrics: StageMetrics, title: string, onProgress?: (current: number, total: number) => void): Promise<number> {
  const pages = [...root.querySelectorAll<HTMLElement>('.deck-print-page')]
  const geometry = deckImageGeometry(metrics)
  const css = await collectDeckCss()
  const images: { path: string; blob: Blob }[] = []
  const total = pages.length
  onProgress?.(0, total)
  for (const [index, page] of pages.entries()) {
    const blob = await renderDeckPagePng(page, geometry, css)
    images.push({ path: `${safeFileName(title) || 'deck'}-${String(index + 1).padStart(2, '0')}.png`, blob })
    onProgress?.(index + 1, total)
  }
  saveDeckImages(await zipDeckImages(images), `${safeFileName(title) || 'deck'}-images.zip`)
  return images.length
}

// What the page is made of has to be on it before the export reads it. The captured markup carries a
// chart as a still — a picture of a canvas at whatever size that canvas had — so the sheet draws
// live charts on its own canvases first, through the same enhancement the editor preview runs. The
// webfonts have to be laid out too, or every page reflows while it is being drawn.
async function prepareDeckSheet(root: HTMLElement, dark: boolean): Promise<void> {
  try {
    // This fork's export preparation is a sequence of named passes rather than one enhancement call,
    // because the sheet has no script to run and each pass decides its own fallback the way the note
    // exporter's does. The pages register their own fence bodies, so a board and a map can read the
    // bodies they were built from (P-01).
    await renderMath(root)
    await renderPendingMermaid(root, dark)
    // The printed page is laid out at the design canvas's own size, so a map drawn into it is drawn
    // for the box the show measured it in.
    await renderStaticMindmaps(root, { dark, locale: getLocale() })
    // A chart on a printed page has no entrance to animate: the sheet is handed over — and printed —
    // as soon as the fonts land, and the reflow that lands them resizes the chart's box, which clears
    // its canvas and animates again from nothing. Drawn instantly, the chart is on the canvas before
    // the sheet says it is ready and stays there through that resize.
    await renderPendingCharts(root, dark, { instant: true })
    // A board cannot run on the sheet either; its cards print as the board they belong to, so the
    // handout keeps the column a card was in on the projector (N-36).
    renderStaticKanbans(root, 'board')
    await settleWithin(Promise.all([document.fonts.ready, decodeImages(root)]), PRINT_PREPARE_TIMEOUT_MS)
  }
  catch (error: unknown) {
    // Best-effort: a page whose charts or fonts did not settle still exports with the still picture
    // its markup already carries, which is what the export showed before live charts.
    console.warn('[inkstone] deck sheet preparation failed', error)
  }
}

async function decodeImages(root: HTMLElement): Promise<void> {
  const images = [...root.querySelectorAll<HTMLImageElement>('img')]
  await Promise.allSettled(images.map((image) => image.decode()))
}


// The stage reports fractional design sizes (it divides by the scale), which would print as
// fractional page boxes; a PDF page is a whole number of pixels.
function deckPrintGeometry(metrics: StageMetrics): string {
  const width = Math.round(metrics.designWidth)
  const height = Math.round(metrics.designHeight)
  return `@page { size: ${width}px ${height}px; margin: 0 }
[data-deck-print] { --deck-page-width: ${width}px; --deck-page-height: ${height}px; --deck-pad-x: ${SLIDE_PAD_X}px; --deck-pad-y: ${SLIDE_PAD_Y}px; }`
}
