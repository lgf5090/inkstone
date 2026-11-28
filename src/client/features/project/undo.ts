/**
 * E-14: a bounded command stack for board mutations. Each command carries an inverse (undo) and a
 * re-apply (redo); pushing a new command clears the redo branch, and switching boards clears both.
 */
import { PROJECT_LIMITS } from '@shared/project/limits'

export interface UndoCommand {
  undo: () => Promise<void>
  redo: () => Promise<void>
}

export function createUndoStack(limit: number = PROJECT_LIMITS.undoDepth) {
  let undoStack: UndoCommand[] = []
  let redoStack: UndoCommand[] = []
  let generation = 0
  let queue: Promise<void> = Promise.resolve()

  function enqueue(operation: () => Promise<boolean>): Promise<boolean> {
    const result = queue.then(operation, operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    push(command: UndoCommand): void {
      generation += 1
      undoStack = [...undoStack.slice(-(limit - 1)), command]
      redoStack = []
    },
    canUndo(): boolean {
      return undoStack.length > 0
    },
    canRedo(): boolean {
      return redoStack.length > 0
    },
    undo(): Promise<boolean> {
      return enqueue(async () => {
        const command = undoStack[undoStack.length - 1]
        if (!command) return false
        const expectedGeneration = generation
        await command.undo()
        if (expectedGeneration !== generation || undoStack[undoStack.length - 1] !== command) {
          const index = undoStack.indexOf(command)
          if (index >= 0) undoStack = [...undoStack.slice(0, index), ...undoStack.slice(index + 1)]
          return false
        }
        undoStack = undoStack.slice(0, -1)
        redoStack = [...redoStack, command]
        return true
      })
    },
    redo(): Promise<boolean> {
      return enqueue(async () => {
        const command = redoStack[redoStack.length - 1]
        if (!command) return false
        const expectedGeneration = generation
        await command.redo()
        if (expectedGeneration !== generation || redoStack[redoStack.length - 1] !== command) {
          const index = redoStack.indexOf(command)
          if (index >= 0) redoStack = [...redoStack.slice(0, index), ...redoStack.slice(index + 1)]
          return false
        }
        redoStack = redoStack.slice(0, -1)
        undoStack = [...undoStack, command]
        return true
      })
    },
    clear(): void {
      generation += 1
      undoStack = []
      redoStack = []
    },
  }
}
