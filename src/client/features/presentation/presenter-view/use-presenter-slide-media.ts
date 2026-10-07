import { useEffect, type RefObject } from 'react'
import { destroyChartInstances, enhancePreview, renderPendingCharts, renderPendingMermaid } from '../../../lib/markdown/enhance'
import { registerFenceBodies, type FenceBodies } from '../../../lib/markdown/fence-bodies'
import { useSession } from '../../../store/session'
import type { StageMetrics } from '../slide-stage'

/**
 * The presenter reads the slide the room reads, so a diagram, a formula, a chart or a board has to
 * arrive as a picture in this document too. The channel carries markdown rather than rendered pages,
 * so the enhancement runs here — the same chain the projector and the printed deck run, with the
 * board and map channels set to `snapshot` because a presenter's pane is a display, not an editor.
 *
 * `fences` is the set this markup was rendered from: a snapshot reads its content out of it, so a
 * slide whose bodies were left behind draws empty fences rather than its board (P-01).
 */
export function usePresenterSlideMedia(options: {
  hostRef: RefObject<HTMLElement | null>
  html: string
  fences: FenceBodies
  dark: boolean
  metrics: StageMetrics
}): void {
  const { hostRef, html, fences, dark, metrics } = options
  const preview = useSession((s) => s.settings.preview)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !html) return
    let cancelled = false
    const draw = async () => {
      // This fork's `enhancePreview` takes no fence set, so the host registers the bodies the markup
      // was built from first: a board drawn from an unregistered set reads as an empty fence.
      registerFenceBodies(host, fences)
      await enhancePreview(host, {
        math: preview.math,
        mermaid: preview.mermaid,
        chart: preview.chart,
        mindmap: 'snapshot',
        // The presenter reads the same page the room reads, board layout included (N-36). The pane is
        // laid out at the design canvas's own size and scaled, so a map drawn into it is drawn for the
        // box the projector shows it in.
        kanban: 'snapshot',
        kanbanShape: 'board',
        dark,
        codeBlockCollapseLines: 0,
      })
      if (cancelled) return
      if (preview.mermaid) await renderPendingMermaid(host, dark)
      // `enhancePreview` only decides whether a chart block is *allowed* to be drawn; the drawing is a
      // pass of its own, and the projector's canvas runs it. A presenter pane that skipped it would
      // show the room a chart and its own copy a fenced block — the two surfaces the speaker is
      // supposed to be able to read off each other.
      if (!cancelled && preview.chart) await renderPendingCharts(host, dark, { instant: true })
    }
    void draw().catch((error: unknown) => {
      console.warn('[inkstone] presenter slide rendering failed', error)
    })
    return () => {
      cancelled = true
      destroyChartInstances(host)
    }
    // `metrics` is in the set because this fork's map and board snapshots measure the DOM box they are
    // drawn into rather than being handed one: a presenter pane that changes size holds a map drawn
    // for the box it no longer has.
  }, [hostRef, html, fences, dark, metrics, preview.math, preview.mermaid, preview.chart])
}
