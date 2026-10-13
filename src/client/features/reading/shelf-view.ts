/**
 * Which way the shelf is laid out.
 *
 * A reader on a phone is scanning a list, not a mosaic of 60-pixel covers, and a reader on a desktop
 * wants the covers back. So `adaptive` is the only mode that looks at the window, and the rest are
 * taken literally — the resolution is a pure function so the rule can be read without a browser.
 */
export type ShelfViewMode = 'adaptive' | 'grid' | 'list' | 'covers'
export type ResolvedShelfView = Exclude<ShelfViewMode, 'adaptive'>

/** Below this width the shelf has room for one column of text, not a grid of pictures. */
export const SHELF_NARROW_QUERY = '(max-width: 640px)'

export function resolveShelfView(mode: ShelfViewMode, narrow: boolean): ResolvedShelfView {
  if (mode === 'list' || mode === 'covers' || mode === 'grid') return mode
  return narrow ? 'list' : 'grid'
}

/** The four modes in the order the toolbar shows them. */
export const SHELF_VIEW_MODES: readonly ShelfViewMode[] = ['adaptive', 'grid', 'list', 'covers']

export function isShelfViewMode(value: unknown): value is ShelfViewMode {
  return typeof value === 'string' && (SHELF_VIEW_MODES as readonly string[]).includes(value)
}
