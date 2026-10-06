import type { Root } from 'react-dom/client'
import type { KanbanData, KanbanFenceRef, KanbanMode, KanbanWriter } from './types'

/**
 * The four callbacks the root is rendered with, made once per block rather than once per render.
 *
 * `KanbanRoot` is a `memo`, and the preview remounts every block each time the editor settles — fence
 * unchanged and all — so a fresh closure per render turned every keystroke in the note into a
 * whole-board repaint. The handlers therefore live on the entry and are rebuilt only when what they
 * depend on changes (whether this block has a writer at all), never when a render happens.
 */
export interface KanbanRootHandlers {
  /** Whether the block had a writer when these were made: it decides if retry and discard exist. */
  writable: boolean
  onUpdateData: (next: KanbanData) => void
  onRetryWrite?: () => void
  onDiscardWrite?: () => void
  onToggleFullscreen?: () => void
}

/** Everything the last render of the root was made of, so an unchanged remount can skip it. */
export interface KanbanRenderStamp {
  source: string
  data: KanbanData | null
  unsaved: boolean
  owner: 'inline' | 'overlay'
  noteId: string | null
  writable: boolean
  renderDescription?: (source: string) => string
}

export interface KanbanBlockEntry {
  key: string
  scope: string
  noteId: string | null
  index: number
  host: HTMLElement
  source: string
  data: KanbanData | null
  mode: KanbanMode
  editable: boolean
  owner: 'inline' | 'overlay'
  container: HTMLElement | null
  root: Root | null
  ref: KanbanFenceRef | null
  write: KanbanWriter | null
  dirty: boolean
  /** Edits the note refused to accept; kept in memory until retry or discard. */
  unsaved: boolean
  /** The block left the document and this entry was torn down; nothing may move its container again. */
  disposed: boolean
  /**
   * How tall the block was when the overlay borrowed the canvas, so the stand-in left behind is the
   * hole the board actually made rather than a fixed guess.
   */
  reserveHeight: number | null
  timer: number | null
  handlers: KanbanRootHandlers | null
  rendered: KanbanRenderStamp | null
}
