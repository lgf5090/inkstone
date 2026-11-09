/**
 * E-14: a bounded command stack for board mutations. Each command carries an inverse (undo) and a
 * re-apply (redo); pushing a new command clears the redo branch, and switching boards clears both.
 */
export interface UndoCommand {
  undo: () => Promise<void>
  redo: () => Promise<void>
}

export function createUndoStack(limit = 50) {
  let undoStack: UndoCommand[] = []
  let redoStack: UndoCommand[] = []
  return {
    push(command: UndoCommand): void {
      undoStack = [...undoStack.slice(-(limit - 1)), command]
      redoStack = []
    },
    canUndo(): boolean {
      return undoStack.length > 0
    },
    canRedo(): boolean {
      return redoStack.length > 0
    },
    async undo(): Promise<boolean> {
      const command = undoStack[undoStack.length - 1]
      if (!command) return false
      undoStack = undoStack.slice(0, -1)
      await command.undo()
      redoStack = [...redoStack, command]
      return true
    },
    async redo(): Promise<boolean> {
      const command = redoStack[redoStack.length - 1]
      if (!command) return false
      redoStack = redoStack.slice(0, -1)
      await command.redo()
      undoStack = [...undoStack, command]
      return true
    },
    clear(): void {
      undoStack = []
      redoStack = []
    },
  }
}

export type UndoStack = ReturnType<typeof createUndoStack>