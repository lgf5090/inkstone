import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDiagramHistory,
  DEFAULT_DIAGRAM_HISTORY_LIMIT,
} from '../src/client/features/development/database/diagram-history'

describe('createDiagramHistory', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with the initial value and empty stacks', () => {
    const history = createDiagramHistory('a')
    expect(history.present).toBe('a')
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    expect(history.undo()).toBeNull()
    expect(history.redo()).toBeNull()
    expect(history.present).toBe('a')
  })

  it('walks back and forward through pushed snapshots', () => {
    const history = createDiagramHistory(1)
    history.push(2)
    history.push(3)
    expect(history.undo()).toBe(2)
    expect(history.undo()).toBe(1)
    expect(history.undo()).toBeNull()
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(true)
    expect(history.redo()).toBe(2)
    expect(history.redo()).toBe(3)
    expect(history.redo()).toBeNull()
    expect(history.present).toBe(3)
  })

  it('clears redo when a new snapshot is pushed', () => {
    const history = createDiagramHistory('a')
    history.push('b')
    history.undo()
    expect(history.canRedo).toBe(true)
    history.push('c')
    expect(history.canRedo).toBe(false)
    expect(history.redo()).toBeNull()
    expect(history.present).toBe('c')
    expect(history.undo()).toBe('a')
  })

  it('drops the oldest snapshot beyond the limit', () => {
    const history = createDiagramHistory(0, 3)
    history.push(1)
    history.push(2)
    history.push(3)
    history.push(4)
    expect(history.undo()).toBe(3)
    expect(history.undo()).toBe(2)
    expect(history.undo()).toBe(1)
    expect(history.undo()).toBeNull()
    expect(history.present).toBe(1)
  })

  it('keeps the default limit at fifty snapshots', () => {
    const history = createDiagramHistory(0)
    for (let index = 1; index <= 60; index += 1) history.push(index)
    let depth = 0
    while (history.undo() !== null) depth += 1
    expect(depth).toBe(DEFAULT_DIAGRAM_HISTORY_LIMIT)
    expect(history.present).toBe(10)
  })

  it('coalesces rapid pushes that share a key', () => {
    vi.useFakeTimers({ now: 1_000 })
    const history = createDiagramHistory('a')
    history.push('b', { coalesceKey: 'drag:users' })
    vi.setSystemTime(1_200)
    history.push('c', { coalesceKey: 'drag:users' })
    expect(history.present).toBe('c')
    expect(history.undo()).toBe('a')
    expect(history.canUndo).toBe(false)
  })

  it('coalesces a push at the edge of the window', () => {
    vi.useFakeTimers({ now: 1_000 })
    const history = createDiagramHistory('a')
    history.push('b', { coalesceKey: 'drag:users' })
    vi.setSystemTime(1_500)
    history.push('c', { coalesceKey: 'drag:users' })
    expect(history.undo()).toBe('a')
    expect(history.canUndo).toBe(false)
  })

  it('splits a coalesced push beyond the window', () => {
    vi.useFakeTimers({ now: 1_000 })
    const history = createDiagramHistory('a')
    history.push('b', { coalesceKey: 'drag:users' })
    vi.setSystemTime(1_501)
    history.push('c', { coalesceKey: 'drag:users' })
    expect(history.undo()).toBe('b')
    expect(history.undo()).toBe('a')
  })

  it('does not coalesce different keys or an unkeyed push', () => {
    vi.useFakeTimers({ now: 1_000 })
    const history = createDiagramHistory('a')
    history.push('b', { coalesceKey: 'drag:users' })
    history.push('c', { coalesceKey: 'drag:orders' })
    history.push('d')
    history.push('e', { coalesceKey: 'drag:orders' })
    expect(history.undo()).toBe('d')
    expect(history.undo()).toBe('c')
    expect(history.undo()).toBe('b')
    expect(history.undo()).toBe('a')
  })

  it('does not coalesce with a push that preceded an undo', () => {
    vi.useFakeTimers({ now: 1_000 })
    const history = createDiagramHistory('a')
    history.push('b', { coalesceKey: 'drag:users' })
    expect(history.undo()).toBe('a')
    history.push('c', { coalesceKey: 'drag:users' })
    expect(history.undo()).toBe('a')
  })

  it('resets both stacks and the present value', () => {
    const history = createDiagramHistory('a')
    history.push('b')
    history.push('c')
    history.undo()
    history.reset('z')
    expect(history.present).toBe('z')
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    expect(history.undo()).toBeNull()
    expect(history.redo()).toBeNull()
    expect(history.present).toBe('z')
  })
})