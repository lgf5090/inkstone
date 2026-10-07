// Block-level pagination for a slide that does not fit its canvas. Kept as a pure
// function because the packing rules (subsection-aligned breaks, a block too tall for the
// page either shrinking or continuing on its own units, a column slide staying whole) are
// the part worth testing — the DOM hook only measures blocks and applies the plan.
import type { SlideLayout } from './slides'

/**
 * The smallest factor a block may be shrunk to before its own units start a new page instead.
 *
 * The canvas lays its body out at 28 design px on a 720 px-tall page, and projected body copy is
 * designed to stay at or above 18 px of that canvas, so the floor is 18/28. The numbers are read off
 * a real show (`scripts/measure-slide-fit.mjs`, 1920×1080): a 200-row table is 11 672 px of block on
 * a 632 px page, which fitting would shrink to 0.054 — the text arrives on the projector at 1.8 px.
 */
export const MIN_FIT_SCALE = 0.64

export interface SlideBlock {
  top: number
  height: number
  heading: boolean
  /**
   * Where a page may cut into this block: ascending offsets from its own top, in design pixels, each
   * one the start of a unit the renderer repeats — a table row, a list item, a line of code. A block
   * with none of those (a paragraph, a diagram) has nothing to cut on and is only ever shrunk.
   */
  breaks?: number[]
}

export interface SlidePage {
  from: number
  to: number
  top: number
  /**
   * What this page cuts off the top and the bottom of the block it continues, in design pixels from
   * that block's own edges. Only a page that carries on a block too tall for `MIN_FIT_SCALE` has one;
   * the rest of the block belongs to the pages either side of it, and a surface that painted the
   * whole box would show a page's rows twice.
   */
  clip?: { top: number; bottom: number }
}

export interface SlidePlan {
  pages: SlidePage[]
  /** Per-block shrink factor for a block that alone exceeds one page and keeps shrinking. */
  scales: number[]
  /**
   * The layout the slide was measured under, which is the layout every surface then draws it in.
   * This is the plan's answer rather than the author's switch because a switch can be refused: a
   * column slide whose balanced columns still exceed the page is measured as a flow slide, and a
   * thumbnail or a printed page that drew the columns anyway would slice pages out of a geometry
   * the projector never used.
   */
  layout?: SlideLayout
  /**
   * Whether the author asked for this slide's blocks to be revealed one step at a time. It rides on the
   * plan rather than on the markup because every surface that reads the plan then agrees on what the
   * projector walked through — and a thumbnail that draws the last state is still the same page.
   */
  steps?: boolean
}

export function planSlidePages(blocks: SlideBlock[], contentHeight: number, layout?: SlideLayout, steps?: boolean): SlidePlan {
  const limit = Math.max(contentHeight, 1)
  const scales = blocks.map(() => 1)
  if (blocks.length === 0) return { pages: [{ from: 0, to: 0, top: 0 }], scales, layout, steps }
  // Two columns fit a slide by balancing its blocks across both, so its blocks no longer form the
  // single vertical flow the walk below reads — each column starts at the top again, and a page
  // picked out of those tops would hide blocks that are beside each other. The whole slide stays on
  // one page, which is only sound for a slide the caller has already measured as fitting the page.
  // Two columns are revealed block by block like any other page, but never *paginated*: a page cut out of
  // those tops would hide blocks
  // that sit beside each other, so the slide stays whole and its steps arrive together.
  if (layout === 'split') return { pages: [{ from: 0, to: blocks.length, top: 0 }], scales, layout, steps }
  const pages: SlidePage[] = []
  let from = 0
  while (from < blocks.length) {
    const pageTop = from === 0 ? 0 : Math.max(blocks[from]!.top, 0)
    let to = from + 1
    while (to < blocks.length && blocks[to]!.top + blocks[to]!.height - pageTop <= limit) to++
    if (to < blocks.length) to = breakIndex(blocks, from, to)
    const first = blocks[from]!
    // A block that exceeds the page on its own either continues on its units or shrinks. It continues
    // when fitting it would take the body below `MIN_FIT_SCALE` and every one of its units still fits a
    // page; it shrinks otherwise, because a cut through a unit taller than the page would lose it —
    // and it shrinks when the page carries blocks below it too, since a negative margin put those
    // there and no horizontal cut can pass between them.
    const bands = first.height > limit && to === from + 1 ? continuationBands(first, limit) : null
    if (bands) {
      for (const band of bands) pages.push({ from, to, top: pageTop + band.start, clip: { top: band.start, bottom: first.height - band.end } })
    } else {
      if (first.height > limit) scales[from] = limit / first.height
      pages.push({ from, to, top: pageTop })
    }
    from = to
  }
  return { pages, scales, layout, steps }
}

/**
 * How many further reveals this page is worth: one for every block after the first, and none at all
 * for a slide whose author never asked. The first block stays on screen because a page that opened on
 * nothing would read as a blank slide rather than as a talk in progress.
 */
export function pageSteps(plan: SlidePlan, page: SlidePage): number {
  return plan.steps ? Math.max(page.to - page.from - 1, 0) : 0
}

/** The steps this page holds, read by index the way every other surface reads a page. */
export function planPageSteps(plan: SlidePlan, index: number): number {
  const page = plan.pages[resolvePageIndex(plan, index)]
  return page ? pageSteps(plan, page) : 0
}

// The bands a block continues over, as offsets from its own top, or `null` when it keeps shrinking:
// a block short enough to fit at a readable size, a block with no units to cut on, or a unit too
// tall for a page. The greedy walk takes the last unit still inside the page, so no band wastes
// more than one unit of the canvas.
function continuationBands(block: SlideBlock, limit: number): { start: number; end: number }[] | null {
  if (limit / block.height >= MIN_FIT_SCALE) return null
  const units = (block.breaks ?? []).filter((offset) => offset > 0 && offset < block.height)
  const edges = [0, ...units, block.height]
  // One pass over the gaps also answers a block with no unit to cut on: its only gap is the block
  // itself, which this branch was entered because it exceeds the page.
  for (let index = 1; index < edges.length; index++) if (edges[index]! - edges[index - 1]! > limit) return null
  const bands: { start: number; end: number }[] = []
  let cursor = 0
  while (cursor < edges.length - 1) {
    let end = cursor + 1
    while (end + 1 < edges.length && edges[end + 1]! - edges[cursor]! <= limit) end++
    bands.push({ start: edges[cursor]!, end: edges[end]! })
    cursor = end
  }
  return bands
}

// Two columns are a way of fitting the page, not a way of overflowing it more slowly: a slide whose
// balanced columns still exceed the page keeps the flow layout, which is the geometry the page walk
// reads and the only one that reaches every block. `hostHeight` is the host's own box, which under
// a column layout is the height of the taller column.
export function slideLayoutForFit(layout: SlideLayout | undefined, hostHeight: number, contentHeight: number): SlideLayout | undefined {
  return layout === 'split' && hostHeight > Math.max(contentHeight, 1) ? undefined : layout
}

// Where the overflowing page has to end. A heading inside the page wins, so each
// page starts at a subsection rather than splitting one across pages; the largest
// such index keeps the page as full as possible. Falling back to the overflowing
// block itself is always safe because `to > from`.
function breakIndex(blocks: SlideBlock[], from: number, to: number): number {
  for (let index = to; index > from; index--) {
    if (blocks[index]!.heading) return index
  }
  return to
}

export function resolvePageIndex(plan: SlidePlan, subPage: number): number {
  return Math.min(Math.max(subPage, 0), Math.max(plan.pages.length - 1, 0))
}

// Plans are compared by value because a re-measure usually produces the same plan:
// keeping the previous object identity is what lets consumers memoize on it. The
// layout is part of the value — a slide that lost or gained its columns between two
// measures with otherwise identical pages has to be republished, and so is where a
// continued block is cut, because that is what every surface paints.
export function samePlan(a: SlidePlan | undefined, b: SlidePlan): boolean {
  if (!a || a.pages.length !== b.pages.length || a.scales.length !== b.scales.length) return false
  if (a.layout !== b.layout || a.steps !== b.steps) return false
  const pages = a.pages.every((page, index) => {
    const other = b.pages[index]
    return Boolean(other) && page.from === other.from && page.to === other.to && page.top === other.top && sameClip(page.clip, other.clip)
  })
  return pages && a.scales.every((scale, index) => scale === b.scales[index])
}

function sameClip(a: SlidePage['clip'], b: SlidePage['clip']): boolean {
  return a?.top === b?.top && a?.bottom === b?.bottom
}
