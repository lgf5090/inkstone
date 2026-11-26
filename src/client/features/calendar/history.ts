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
  /** Ids a replay touched; their echo through the write queue must not start a new history entry. */
  private replayPending = new Set<string>()
  private replayPositions = new Map<string, { stack: 'undo' | 'redo'; index: number }>()
  private listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  get isReplaying(): boolean {
    return this.replaying
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 && this.replayPending.size === 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0 && this.replayPending.size === 0
  }

  /** Called after a change has reached the API; a replay of history never records again. */
  record(entry: EditHistoryEntry): void {
    if (this.replaying) return
    if (this.replayPending.delete(entry.id)) {
      this.replayPositions.delete(entry.id)
      this.changed()
      return
    }
    this.undoStack.push(entry)
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift()
    this.redoStack = []
    this.changed()
  }

  finishReplay(id: string): void {
    if (!this.replayPending.delete(id)) return
    this.replayPositions.delete(id)
    this.changed()
  }

  failReplay(id: string): void {
    if (!this.replayPending.delete(id)) return
    const position = this.replayPositions.get(id)
    this.replayPositions.delete(id)
    if (!position) {
      this.changed()
      return
    }
    const source = position.stack === 'undo' ? this.redoStack : this.undoStack
    const target = position.stack === 'undo' ? this.undoStack : this.redoStack
    const index = source.map(entry => entry.id).lastIndexOf(id)
    if (index < 0) {
      this.changed()
      return
    }
    const [entry] = source.splice(index, 1)
    if (entry) target.splice(Math.min(position.index, target.length), 0, entry)
    this.changed()
  }

  remapReplay(previousId: string, nextId: string): void {
    if (!this.replayPending.delete(previousId)) return
    this.replayPending.add(nextId)
    const position = this.replayPositions.get(previousId)
    if (position) {
      this.replayPositions.delete(previousId)
      this.replayPositions.set(nextId, position)
    }
  }

  undo(app: ICalendarApp, entryId?: string): boolean {
    if (this.replayPending.size > 0) return false
    const index = entryId === undefined
      ? this.undoStack.length - 1
      : this.undoStack.map(entry => entry.id).lastIndexOf(entryId)
    if (index < 0) return false
    const [entry] = this.undoStack.splice(index, 1)
    if (!entry) return false
    this.replayPositions.set(entry.id, { stack: 'undo', index })
    this.apply(app, entry.before, entry.after)
    this.redoStack.push(entry)
    this.changed()
    return true
  }

  redo(app: ICalendarApp): boolean {
    if (this.replayPending.size > 0) return false
    const entry = this.redoStack.pop()
    if (!entry) return false
    this.replayPositions.set(entry.id, { stack: 'redo', index: this.redoStack.length })
    this.apply(app, entry.after, entry.before)
    this.undoStack.push(entry)
    this.changed()
    return true
  }

  private apply(app: ICalendarApp, target: Event | null, opposite: Event | null): void {
    this.replaying = true
    for (const event of [target, opposite]) if (event) this.replayPending.add(event.id)
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
