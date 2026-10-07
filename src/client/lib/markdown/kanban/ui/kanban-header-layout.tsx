import type { ReactNode } from 'react'

/**
 * How the board's bar lays itself out: the one breakpoint it turns on, the two clusters it chooses
 * between, and the two control shapes whose words and native hints have their own reasons.
 *
 * The breakpoint is the header's own width rather than the window's — a note pane beside the editor is
 * a few hundred pixels wide whatever the monitor is, and reading the window is what put this row into
 * lines of its own (user report 2026-09-23). `@4xl` is 56rem and it is the one breakpoint the whole
 * bar turns on: labels, the progress bar, the wide cluster and the compact one all switch there.
 *
 * The pieces live here rather than beside the bar because they are the *rules* of that layout and the
 * bar is the list of controls those rules arrange; the bar had grown past the file budget with them.
 */

/**
 * The written label of a control that is icon-only while the bar is narrow, where the words are what
 * pushed the row into lines of its own. The label stays in the tree and stays the button's name —
 * hiding it is a layout change, never a loss of the accessible name the caller spells out beside it.
 */
export function narrowLabel(label: string): ReactNode {
  return <span className='hidden @4xl:inline'>{label}</span>
}

export const STATUS_PROGRESS_BAR_HEIGHT = 6

/**
 * Undo and redo keep the native hint that names their chord, and `IconButton` refuses a `title` on
 * purpose (a native tooltip is not the project's tooltip). So the two are written out here — at the
 * very size step `IconButton` uses, so a finger gets the same target either way.
 */
export const TOOLBAR_ICON_CLASS =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:pointer-events-none disabled:opacity-30 md:size-7'

/**
 * Which cluster a control belongs to. The bar draws both and a container query picks one, so there is
 * one control per action in the document — no action is written twice and hidden twice, and the
 * breakpoint that decides is the header's own width. `wide` is the labeled row the full screen board
 * shows; `compact` is what a note pane gets.
 */
export function WideOnly({ children }: { children: ReactNode }) {
  return <div className='hidden @4xl:flex items-center gap-1.5'>{children}</div>
}

export function CompactOnly({ children }: { children: ReactNode }) {
  return <div className='flex @4xl:hidden items-center gap-1.5'>{children}</div>
}
