/**
 * Undo/redo for events, kept beside the persistence queue rather than inside DayFlow.
 *
 * DayFlow's own `undo()` only rewinds its in-memory snapshot, which would leave the server holding
 * the state the reader just undid. Every entry here is recorded after the queue has persisted its
 * change, and replaying one goes back through `applyEventsChanges(..., 'local')` so the queue and
 * the server see the replay like any other edit.
 */
import type { Event, ICalendarApp } from '@dayflow/react'
import { toEventUpdates } from './model'

export interface EditHistoryEntry {
  id: string
  /** The event before the edit; null for a create. */
  before: Event | null
  /** The event after the edit; null for a delete. */
  after: Event | null
}

const HISTORY_LIMIT = 50

export class CalendarEditHistory {
  private undoStack: EditHistoryEntry[] = []
  private redoStack: EditHistoryEntry[] = []
  private replaying = false

  get isReplaying(): boolean {
    return this.replaying
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Called after a change has reached the API; a replay of history never records again. */
  record(entry: EditHistoryEntry): void {
    if (this.replaying) return
    this.undoStack.push(entry)
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift()
    this.redoStack = []
  }

  undo(app: ICalendarApp, entryId?: string): boolean {
    const index = entryId === undefined
      ? this.undoStack.length - 1
      : this.undoStack.map(entry => entry.id).lastIndexOf(entryId)
    if (index < 0) return false
    const [entry] = this.undoStack.splice(index, 1)
    if (!entry) return false
    this.apply(app, entry.before, entry.after)
    this.redoStack.push(entry)
    return true
  }

  redo(app: ICalendarApp): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    this.apply(app, entry.after, entry.before)
    this.redoStack.push(entry)
    return true
  }

  private apply(app: ICalendarApp, target: Event | null, opposite: Event | null): void {
    this.replaying = true
    try {
      if (!target) {
        if (opposite) app.applyEventsChanges({ delete: [opposite.id] }, false, 'local')
        return
      }
      if (!opposite) {
        app.applyEventsChanges({ add: [target] }, false, 'local')
        return
      }
      app.applyEventsChanges({ update: [{ id: target.id, updates: toEventUpdates(target) }] }, false, 'local')
    } finally {
      this.replaying = false
    }
  }
}
