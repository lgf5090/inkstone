import type { ReactNode } from 'react'

/**
 * What a mounted board offers the command palette. The palette is global and the board is a React
 * root inside the document, so the two meet through this registry rather than through the store: a
 * board that is on screen registers what it can do, and the palette reads the one the reader is
 * working in when it opens. Nothing here re-renders anybody — the palette takes a snapshot of a
 * board at the moment it is opened, which is also how every other item in it behaves.
 */
export interface KanbanSurfaceView {
  id: string
  name: string
  /** The glyph the board's own view tabs use, so a view looks the same in both places. */
  icon: ReactNode
}

export interface KanbanSurfaceCommands {
  /** The board's title, used as the group heading so several boards are told apart. */
  boardTitle: string
  views: KanbanSurfaceView[]
  activeViewId: string
  selectedCount: number
  canUndo: boolean
  canRedo: boolean
  addCard: () => void
  selectView: (viewId: string) => void
  selectAllVisible: () => void
  clearSelection: () => void
  undo: () => void
  redo: () => void
}

/**
 * Read lazily on purpose: a board's actions change on every commit, so the registry holds a reader
 * rather than a snapshot, and the palette's own open moment decides what it sees.
 */
const boards = new Map<Element, () => KanbanSurfaceCommands>()

/** Registers a board for as long as it is mounted; the returned function takes it back out. */
export function registerKanbanSurface(element: Element, read: () => KanbanSurfaceCommands): () => void {
  boards.set(element, read)
  return () => {
    boards.delete(element)
  }
}

/**
 * The board the reader is in, or none. Containment decides when there is a choice: with several
 * boards on screen, only the one holding the focused element may answer — a command that acted on a
 * different board than the one being read would be worse than offering no command at all. A lone
 * board is unambiguous even before the reader has clicked into it, which is the common case and the
 * one where withholding the commands would just look broken.
 */
export function kanbanSurfaceCommands(node: Node | null): KanbanSurfaceCommands | null {
  for (const [element, read] of boards) {
    if (node && element.contains(node)) return read()
  }
  if (boards.size === 1) return [...boards.values()][0]!()
  return null
}
