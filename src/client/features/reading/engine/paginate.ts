/**
 * The column geometry that turns flowing text into pages.
 *
 * A paginated EPUB is one tall column box scrolled sideways: the browser breaks the text into
 * `column-count` columns of a fixed width, and a page turn moves `scrollLeft` by the whole spread rather
 * than by one column, because a two-column page that turns half a page leaves the reader reading the same
 * words twice. Every number the reader needs — how many pages a chapter has, which page an
 * element is on — comes out of that one relationship, so it is computed here rather than read off the
 * DOM in four different places.
 */
export interface PageGeometry {
  /** Width of one column, in CSS pixels. */
  columnWidth: number
  /** The gutter between two columns. */
  gap: number
  /** How far `scrollLeft` travels for one page: the whole spread, not one column. */
  step: number
  /** The width the scroller shows, which is the spread plus the page margins either side of it. */
  viewport: number
  columns: number
}

/**
 * @param width the content the columns are laid out in, already cleared of the page margins
 * @param inset the reader's page margin on each side, which the scroller shows at the start of every
 *        page because it sits on the scroll container's own padding
 */
export function computeGeometry(width: number, columns: number, gap: number, inset = 0): PageGeometry {
  const safeColumns = Math.max(1, Math.round(columns))
  const safeWidth = Math.max(1, Math.floor(width))
  const totalGap = gap * (safeColumns - 1)
  const columnWidth = Math.max(120, Math.floor((safeWidth - totalGap) / safeColumns))
  // The browser puts each column one pitch apart — a column plus the gutter — so a page of `columns`
  // of them advances by that many pitches, and the gutter after the last column is part of the page.
  const pitch = columnWidth + gap
  return {
    columnWidth,
    gap,
    step: pitch * safeColumns,
    viewport: pitch * safeColumns - gap + 2 * Math.max(0, inset),
    columns: safeColumns,
  }
}

/**
 * How many pages the laid-out content occupies.
 *
 * `scrollWidth` is the far edge of the last column, so the count is the travel distance plus one
 * viewport, divided by the step. Rounding rather than ceiling is deliberate: a column that overflows
 * by a pixel of line-height should not cost the reader an extra empty page.
 */
export function pageCount(scrollWidth: number, geometry: PageGeometry): number {
  const { step, viewport } = geometry
  if (step <= 0) return 1
  return Math.max(1, Math.round((Math.max(0, scrollWidth) - viewport) / step) + 1)
}

/** Which page an element landed on, from its offset inside the column box. */
export function pageForOffset(offsetLeft: number, geometry: PageGeometry): number {
  return Math.max(0, Math.floor(offsetLeft / Math.max(1, geometry.step)))
}

/** The scroll offset that shows a page. */
export function scrollForPage(page: number, geometry: PageGeometry): number {
  return Math.max(0, page) * geometry.step
}

/**
 * The page a horizontal scroll position is showing, given that a browser may report a scrolled-into-
 * negative-space position on a right-to-left book.
 */
export function pageForScroll(scrollLeft: number, geometry: PageGeometry): number {
  return Math.max(0, Math.round(scrollLeft / geometry.step))
}

export interface PageProgress {
  page: number
  pages: number
  /** 0…1 through one chapter; 1 when a chapter is a single page. */
  fraction: number
}

export function chapterProgress(page: number, pages: number): PageProgress {
  const safePages = Math.max(1, pages)
  const clamped = Math.min(safePages - 1, Math.max(0, page))
  return {
    page: clamped + 1,
    pages: safePages,
    fraction: safePages > 1 ? clamped / (safePages - 1) : 1,
  }
}
