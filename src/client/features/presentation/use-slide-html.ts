import { useEffect, useState } from 'react'
import { useSession } from '../../store/session'
import { resolveNoteEmbeds } from '../../lib/markdown/embeds'
import { enhancePreview } from '../../lib/markdown/enhance'
import { registerFenceBodies } from '../../lib/markdown/fence-bodies'
import { markSlideFailed, readSlideHtml, stagedFor, rememberSlideHtml, renderSlideSource, slideCacheKey, slideMarkup, slideSettingFlags, type SlideRender } from './slide-html'
import type { StageMetrics } from './slide-stage'

// The staging node is parked *in the document* rather than left detached, because this fork's snapshot
// renderers measure the box they are drawn into: a mind map exports the layout its library computed,
// and a detached element has no layout box at all, which is what would put an empty picture on the
// projector. `visibility:hidden` keeps it out of the paint and out of the tab order while every
// descendant keeps real dimensions; the design canvas's own size is what the slide is measured at, so
// the map is drawn for the box the room will show it in.
function mountStaging(metrics: StageMetrics): HTMLDivElement {
  const staging = document.createElement('div')
  staging.dataset.slideStaging = ''
  staging.setAttribute('aria-hidden', 'true')
  staging.style.cssText = `position:fixed;top:0;left:0;width:${metrics.designWidth}px;height:${metrics.designHeight}px;overflow:hidden;visibility:hidden;pointer-events:none`
  document.body.appendChild(staging)
  return staging
}

// One staged page, put through the enhancement chain and written back to the cache. The channels are
// named at the call rather than assembled elsewhere because every surface that enhances markdown owes
// a ```kanban fence an answer — `tests/kanban-render-channel.test.ts` reads this call, not a helper.
async function prepareStagedSlide(source: {
  key: string
  staging: HTMLDivElement
  rendered: SlideRender
  content: string
  noteTitle: string
  math: boolean
  mermaid: boolean
  chart: boolean
  dark: boolean
  flags: string
  isCurrent: () => boolean
}): Promise<void> {
  const { key, staging, rendered, content, noteTitle, math, mermaid, chart, dark, flags, isCurrent } = source
  // This fork's `enhancePreview` takes no fence set, so the host registers the bodies the markup was
  // built from first: a board drawn from an unregistered set reads as an empty fence.
  registerFenceBodies(staging, rendered.fences)
  if (rendered.hasEmbeds) {
    await resolveNoteEmbeds(staging, { currentContent: content, currentTitle: noteTitle, isCurrent })
  }
  await enhancePreview(staging, {
    math,
    mermaid,
    // `true` here means "leave the chart block standing", which is what a slide needs: the picture is
    // drawn by the canvas that shows the page, and the capture of that page is what the slide list and
    // the printed deck carry. `false` would replace the block with its source and no chart would ever
    // be drawn for this show.
    chart,
    // A projector is read from across a room, and which column a card sits in is part of what the card
    // says (N-36), so the board shape is asked for rather than taken from the list this pass defaults
    // to. The channel stays 'snapshot' because that is what happens: a still, drawn here, travels in
    // the markup the slide list and the printed deck both read.
    kanban: 'snapshot',
    kanbanShape: 'board',
    mindmap: 'snapshot',
    // A slide carries what the markup can hold: the query text, not an answer pulled from notes the
    // deck never asked for. Exported and printed decks read the same string this pass produces.
    dataview: 'source',
    dark,
    codeBlockCollapseLines: 0,
  })
  if (!isCurrent()) return
  rememberSlideHtml(key, { ...slideMarkup(rendered), html: staging.innerHTML, prepared: true, flags })
}

// Renders the enhanced markup for one slide off-DOM and caches it, so the canvas and
// the slide list — and the idle preflight pass — all read the same prepared html per
// content fingerprint, theme and slide. A prepared page is left alone: re-enhancing an
// already prepared slide is what makes diagrams flash back to their placeholders.
// The return says whether this page's enhancement failed: the text is still there and only the
// diagrams and math stayed placeholders, which the surface has to be able to say out loud.
export function useSlideHtml(options: {
  open: boolean
  deck: string[]
  hashes: string[]
  index: number
  content: string
  noteTitle: string
  dark: boolean
  metrics: StageMetrics
}): boolean {
  const { open, deck, hashes, index, content, noteTitle, dark, metrics } = options
  const preview = useSession((s) => s.settings.preview)
  const [, setTick] = useState(0)
  const contentWidth = metrics.contentWidth
  const contentHeight = metrics.contentHeight
  // Hoisted out of the effect because the caller asks the same question the preparer answers with its
  // failure: did this page's enhancement land, or did it throw and leave the plain markup behind.
  // The identity of the slide comes from the deck, which identified it once when it split (`useShowDeck`)
  // — hashing this page's text again here would be a second answer to a question already answered.
  const key = slideCacheKey({ fingerprint: hashes[index] ?? '', dark, index, contentWidth, contentHeight })
  // The settings are not part of the key — it names the slide, the theme and the box, none of which a
  // settings flip touches — so they ride on the entry and every reader compares them (L-16).
  const flags = slideSettingFlags(preview)
  useEffect(() => {
    if (!open) return
    // The plain render is not a finished page (see `SlideMarkup.prepared`), so an interrupted run
    // leaves the page to be drawn again — by this visit, or by the next one that asks for it.
    const staged = stagedFor(readSlideHtml(key), flags)
    if (staged?.prepared || staged?.failed) return
    let cancelled = false
    const rendered = renderSlideSource(deck[index] ?? '')
    rememberSlideHtml(key, slideMarkup(rendered))
    setTick((tick) => tick + 1)
    const staging = mountStaging(metrics)
    staging.innerHTML = rendered.html
    const done = () => {
      staging.remove()
    }
    // The rejection must not vanish: it used to, and the only trace was a formula skeleton the
    // presenter had no way to tell apart from a slow show.
    prepareStagedSlide({ key, staging, rendered, content, noteTitle, math: preview.math, mermaid: preview.mermaid, chart: preview.chart, dark, flags, isCurrent: () => !cancelled })
      .then(() => {
        done()
        if (!cancelled) setTick((tick) => tick + 1)
      })
      .catch((error: unknown) => {
        done()
        if (cancelled) return
        console.warn('[inkstone] slide preparation failed', error)
        markSlideFailed(key, flags)
        setTick((tick) => tick + 1)
      })
    return () => {
      cancelled = true
      // The node has to leave with the run that made it, whether or not that run ever finished: a
      // presenter turning the page mid-preparation would otherwise leave a laid-out 1280×720 box in
      // the document for every slide they skipped past. `remove()` on an already detached node is a
      // no-op, so the settle handlers above can call it too.
      done()
    }
    // The key and the flags together are the whole input set of the preparation that is not a live
    // edit: the key carries the slide's own text, its index, the theme and the box it is drawn in, and
    // the flags carry the three settings the chain reads. Leaving the note's text and the deck array
    // out is the point — an edit in another slide re-splits the note and hands over a new array, and
    // taking that as a reason to start over cancelled the run on the page the presenter is actually
    // looking at.
  }, [open, key, flags])
  const staged = stagedFor(readSlideHtml(key), flags)
  return staged?.failed === true
}
