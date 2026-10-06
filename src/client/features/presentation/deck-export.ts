import { useCallback, useRef, useState } from 'react'
import type { ProseFont } from '@shared/types'
import { getLocale, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { collectDeckCss } from './deck-image'
import { buildDeckHtmlDocument, deckThemeAttributes, saveDeckHtml } from './deck-html'
import { buildDeckPages, type DeckExportProgress, type DeckPrintPage } from './deck-print'
import type { SlidePlan } from './slide-pagination'
import type { StageMetrics } from './slide-stage'

// Exporting a deck is the same pages read out two ways: printed, and rasterized to images. Both
// exports slice the whole deck against the measured plans, which is not work the show should do on
// the chance that someone exports it — so the pages are only built when they are asked for, and
// holding them is also what tells the overlay to mount the export sheet.

/** One export sheet's pages, and what tears it down when it is done with them. */
export interface DeckSheetPayload {
  pages: DeckPrintPage[]
  metrics: StageMetrics
  dark: boolean
  done: () => void
}

export interface DeckExportOptions {
  deck: string[]
  cacheKeys: string[]
  plans: Record<number, SlidePlan>
  metrics: StageMetrics
  /** The display settings the cached pages were prepared under; a page for others prints as plain. */
  flags: string
  /** The theme the deck was measured in: a chart's axes are drawn for it. */
  dark: boolean
  title: string
  /** The speaker notes, indexed by slide — what a handout prints beside each slide's picture. */
  notes: string[]
  /** The type scale the deck was laid out at, which the standalone file has to carry along. */
  proseFont: ProseFont
}

/** The handout sheet: the deck's pages, and the notes they were spoken from. */
export type DeckHandoutPayload = DeckSheetPayload & { notes: string[] }

export interface DeckExports {
  exportDeck: () => void
  print: DeckSheetPayload | null
  exportImages: () => void
  images: (DeckSheetPayload & { title: string; onProgress: (progress: DeckExportProgress) => void }) | null
  /** One printed page per slide, with that slide's notes beside its picture. */
  exportHandout: () => void
  handout: DeckHandoutPayload | null
  /** Which page of the deck the image export is writing, or null while nothing is being written. The
   * show paints this itself: the sheet it counts is laid out off-screen, so a status layer held beside
   * that sheet sits under the projector — see `DeckExportProgress`. */
  imageProgress: DeckExportProgress | null
  /** Writes the deck as one HTML file that plays by itself, and saves it (N-33). No sheet: the pages
   * are the same strings the projector drew, so there is nothing to lay out before they can be written. */
  exportHtml: () => void
  /** A file is being written right now, which is what keeps a second press from starting a second one. */
  htmlBusy: boolean
}

/**
 * The deck as one file someone else can play (N-33).
 *
 * The styles the deck is wearing are collected at press time rather than held: they are what the file
 * has to carry to look like the show, and the show only wears them once.
 */
async function writeDeckHtmlFile(pages: DeckPrintPage[], options: DeckExportOptions): Promise<void> {
  const { metrics, title, proseFont } = options
  try {
    const css = await collectDeckCss()
    saveDeckHtml(buildDeckHtmlDocument({
      pages,
      metrics,
      css,
      title,
      lang: getLocale(),
      font: proseFont,
      origin: window.location.origin,
      rootAttributes: deckThemeAttributes(document.documentElement),
      labels: {
        previous: t('workspace.presentation_prev'),
        next: t('workspace.presentation_next'),
        deck: t('workspace.presentation_html_controls'),
      },
    }), title)
    useUi.getState().toast({ title: t('workspace.presentation_html_saved'), tone: 'success' })
  }
  catch (error: unknown) {
    // Nothing was written, so the toast is the only signal there is — the same reading the image
    // export gives a failed archive.
    console.warn('[inkstone] deck html export failed', error)
    useUi.getState().toast({ title: t('workspace.presentation_html_failed'), tone: 'danger' })
  }
}

export function useDeckExport(options: DeckExportOptions): DeckExports {
  const { deck, cacheKeys, plans, metrics, flags, dark, title, notes } = options
  // Read when the press happens rather than captured in the callback that was built for this render:
  // the file is written after a stylesheet collection, and the deck may have moved under it.
  const optionsRef = useRef(options)
  optionsRef.current = options
  // The kind of export is part of what is held: the sheets read the same pages, so holding the pages
  // alone would mount the printed deck, the image deck and the handout at once and export all three
  // for one press.
  const [request, setRequest] = useState<{ kind: 'print' | 'images' | 'handout'; pages: DeckPrintPage[] } | null>(null)
  const [imageProgress, setImageProgress] = useState<DeckExportProgress | null>(null)
  const [htmlBusy, setHtmlBusy] = useState(false)
  // The count starts at zero pages rather than staying absent until the first PNG lands: a deck that
  // takes a beat to begin drawing would otherwise give no sign that the press was heard at all.
  // Every export reads the same pages: one per state the show walks, sliced by the plans it was
  // measured with. A slide the idle pass has not measured yet is only known to have the one page it at
  // least has, which is fewer than the show will walk — the export still goes out, but the gap is said
  // rather than left to be discovered on paper (N-38).
  const collect = useCallback(() => {
    const unmeasured = deck.reduce((count, _, index) => (plans[index] ? count : count + 1), 0)
    if (unmeasured > 0)
      useUi.getState().toast({ title: t('workspace.presentation_export_unmeasured', { value0: unmeasured }), tone: 'warning' })
    return buildDeckPages(deck, cacheKeys, plans, metrics, flags)
  }, [deck, cacheKeys, plans, metrics, flags])
  const build = useCallback(
    (kind: 'print' | 'images' | 'handout') => {
      const pages = collect()
      setImageProgress(kind === 'images' ? { current: 0, total: pages.length } : null)
      setRequest({ kind, pages })
    },
    [collect],
  )
  const done = useCallback(() => {
    setImageProgress(null)
    setRequest(null)
  }, [])
  const onProgress = useCallback((progress: DeckExportProgress) => setImageProgress(progress), [])
  const writeHtml = useCallback((pages: DeckPrintPage[]) => writeDeckHtmlFile(pages, optionsRef.current), [optionsRef])
  const print = request?.kind === 'print' ? { pages: request.pages, metrics, dark, done } : null
  const images = request?.kind === 'images' ? { pages: request.pages, metrics, dark, title, done, onProgress } : null
  const handout = request?.kind === 'handout' ? { pages: request.pages, metrics, dark, done, notes } : null
  const exportHtml = useCallback(() => {
    if (htmlBusy) return
    setHtmlBusy(true)
    void writeHtml(collect()).finally(() => setHtmlBusy(false))
  }, [collect, writeHtml, htmlBusy])
  return { exportDeck: () => build('print'), exportImages: () => build('images'), exportHandout: () => build('handout'), exportHtml, htmlBusy, print, images, handout, imageProgress }
}
