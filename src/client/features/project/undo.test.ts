import { describe, expect, it, vi } from 'vitest'
import { createUndoStack } from './undo'

function command(log: string[]) {
  return {
    undo: vi.fn(async () => { log.push('undo') }),
    redo: vi.fn(async () => { log.push('redo') }),
  }
}

describe('undo/redo command stack (E-14)', () => {
  it('undo then redo replays the inverse and re-apply', async () => {
    const log: string[] = []
    const stack = createUndoStack()
    const cmd = command(log)
    stack.push(cmd)
    expect(stack.canUndo()).toBe(true)
    expect(await stack.undo()).toBe(true)
    expect(log).toEqual(['undo'])
    expect(stack.canRedo()).toBe(true)
    expect(await stack.redo()).toBe(true)
    expect(log).toEqual(['undo', 'redo'])
    expect(cmd.undo).toHaveBeenCalledTimes(1)
    expect(cmd.redo).toHaveBeenCalledTimes(1)
  })

  it('pushing a new command clears the redo branch', async () => {
    const log: string[] = []
    const stack = createUndoStack()
    stack.push(command(log))
    await stack.undo()
    stack.push(command(log))
    expect(stack.canRedo()).toBe(false)
    expect(await stack.redo()).toBe(false)
  })

  it('empty stack undo/redo are no-ops and clear empties both', async () => {
    const stack = createUndoStack()
    expect(await stack.undo()).toBe(false)
    expect(await stack.redo()).toBe(false)
    stack.push(command([]))
    stack.clear()
    expect(stack.canUndo()).toBe(false)
  })

  it('honors the depth limit', async () => {
    const stack = createUndoStack(2)
    const first = command([])
    stack.push(first)
    stack.push(command([]))
    stack.push(command([]))
    await stack.undo()
    await stack.undo()
    expect(await stack.undo()).toBe(false)
    expect(first.undo).not.toHaveBeenCalled()
  })
})