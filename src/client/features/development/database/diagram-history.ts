export interface DiagramHistory<T> {
  present: T
  canUndo: boolean
  canRedo: boolean
  push(next: T, options?: { coalesceKey?: string }): void
  undo(): T | null
  redo(): T | null
  reset(next: T): void
}

export const DEFAULT_DIAGRAM_HISTORY_LIMIT = 50

export const DIAGRAM_HISTORY_COALESCE_MS = 500

export function createDiagramHistory<T>(
  initial: T,
  limit: number = DEFAULT_DIAGRAM_HISTORY_LIMIT,
): DiagramHistory<T> {
  const capacity = Number.isFinite(limit) && limit >= 1
    ? Math.floor(limit)
    : DEFAULT_DIAGRAM_HISTORY_LIMIT
  const undoStack: T[] = []
  const redoStack: T[] = []
  let present = initial
  let coalesceKey: string | null = null
  let coalescedAt = 0

  const pushUndo = (value: T): void => {
    undoStack.push(value)
    if (undoStack.length > capacity) undoStack.shift()
  }

  return {
    get present(): T {
      return present
    },
    get canUndo(): boolean {
      return undoStack.length > 0
    },
    get canRedo(): boolean {
      return redoStack.length > 0
    },
    push(next, options) {
      const key = options?.coalesceKey
      const now = Date.now()
      if (key !== undefined && key === coalesceKey && now - coalescedAt <= DIAGRAM_HISTORY_COALESCE_MS) {
        present = next
        coalescedAt = now
        return
      }
      pushUndo(present)
      redoStack.length = 0
      present = next
      coalesceKey = key ?? null
      coalescedAt = now
    },
    undo() {
      if (undoStack.length === 0) return null
      redoStack.push(present)
      present = undoStack.pop() as T
      coalesceKey = null
      return present
    },
    redo() {
      if (redoStack.length === 0) return null
      pushUndo(present)
      present = redoStack.pop() as T
      coalesceKey = null
      return present
    },
    reset(next) {
      undoStack.length = 0
      redoStack.length = 0
      present = next
      coalesceKey = null
    },
  }
}