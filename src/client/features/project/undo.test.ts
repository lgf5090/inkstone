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

  it('keeps a failed undo on the stack so it can be retried', async () => {
    const stack = createUndoStack()
    const cmd = { undo: vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined), redo: vi.fn().mockResolvedValue(undefined) }
    stack.push(cmd)
    await expect(stack.undo()).rejects.toThrow('failed')
    expect(stack.canUndo()).toBe(true)
    expect(stack.canRedo()).toBe(false)
    await expect(stack.undo()).resolves.toBe(true)
    expect(cmd.undo).toHaveBeenCalledTimes(2)
    expect(stack.canRedo()).toBe(true)
  })

  it('serializes repeated undo commands', async () => {
    const stack = createUndoStack()
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    stack.push({ undo: async () => { log.push('second') }, redo: async () => {} })
    stack.push({ undo: async () => { log.push('first:start'); await gate; log.push('first:end') }, redo: async () => {} })
    const first = stack.undo()
    const second = stack.undo()
    await Promise.resolve()
    expect(log).toEqual(['first:start'])
    release()
    await Promise.all([first, second])
    expect(log).toEqual(['first:start', 'first:end', 'second'])
  })

  it('does not restore an in-flight command after clear or a new push', async () => {
    const stack = createUndoStack()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    stack.push({ undo: async () => { await gate }, redo: async () => {} })
    const pending = stack.undo()
    stack.clear()
    release()
    await expect(pending).resolves.toBe(false)
    expect(stack.canUndo()).toBe(false)
    expect(stack.canRedo()).toBe(false)
  })

  it('removes an executed command when a new push invalidates its in-flight undo', async () => {
    const stack = createUndoStack()
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const began = new Promise<void>((resolve) => { started = resolve })
    const oldCommand = { undo: vi.fn(async () => { started(); await gate }), redo: vi.fn() }
    const newCommand = command([])
    stack.push(oldCommand)
    const pending = stack.undo()
    await began
    stack.push(newCommand)
    release()
    await expect(pending).resolves.toBe(false)
    await expect(stack.undo()).resolves.toBe(true)
    expect(oldCommand.undo).toHaveBeenCalledTimes(1)
    expect(newCommand.undo).toHaveBeenCalledTimes(1)
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