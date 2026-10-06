import { serializeKanban } from './body'
import type { KanbanBlockEntry } from './entry'
import {
  attachKanbanToOverlay,
  detachKanbanFromOverlay,
  kanbanEntryForNode,
  updateKanbanData,
} from './registry'
import type { KanbanData, KanbanMode } from './types'
import { flushKanbanEntry } from './write'

export interface KanbanSession {
  readonly key: string
  noteId(): string | null
  isReady(): boolean
  isEditable(): boolean
  /** False once the block left the document: the board behind this session no longer exists. */
  isAlive(): boolean
  getData(): KanbanData | null
  updateData(updater: (prev: KanbanData) => KanbanData): void
  getMode(): KanbanMode
  moveInto(target: HTMLElement): void
  moveBack(): void
  title(): string
  serialize(): string | null
  flush(): void
}

export function openKanbanSession(node: HTMLElement): KanbanSession | null {
  const opened = kanbanEntryForNode(node)
  return opened ? sessionFor(opened) : null
}

function sessionFor(entry: KanbanBlockEntry): KanbanSession {
  return {
    key: entry.key,
    noteId: () => entry.noteId,
    isReady: () => Boolean(entry.data),
    isEditable: () => Boolean(entry.editable),
    isAlive: () => !entry.disposed,
    getData: () => entry.data,
    updateData: (updater) => updateKanbanData(entry, updater),
    getMode: () => entry.mode,
    moveInto: (target) => attachKanbanToOverlay(entry, target),
    moveBack: () => detachKanbanFromOverlay(entry),
    // Empty when the board has no title of its own: the caller owns the wording of that case, so an
    // untitled board is announced by the localized label rather than by a hardcoded name.
    title: () => entry.data?.title || '',
    serialize: () => {
      if (!entry.data) return null
      return serializeKanban(entry.data, entry.mode)
    },
    flush: () => {
      flushKanbanEntry(entry)
    },
  }
}
