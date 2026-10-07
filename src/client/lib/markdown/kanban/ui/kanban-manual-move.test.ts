import { createElement, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../../test-render'
import { makeMoveItemClearingSorts, useMoveItemClearingSorts } from './kanban-manual-move'
import type { KanbanBoardCell } from '../swimlane'
import type { KanbanSort } from '../types'

const doingCell: KanbanBoardCell = { groupKey: 'doing' }

const activeSorts: KanbanSort[] = [{ propertyId: 'title', direction: 'asc' }]

describe('useMoveItemClearingSorts stability', () => {
  it('returns a stable reference across re-renders when moveItem is unchanged', () => {
    const identities: ((id: string, cell: KanbanBoardCell) => void)[] = []
    const moveItem = vi.fn()
    const setSorts = vi.fn()
    function Probe() {
      const [tick, setTick] = useState(0)
      // the app passes a freshly built filterSort object every render
      identities.push(useMoveItemClearingSorts(moveItem, { sorts: [], setSorts }))
      if (tick < 3) setTick((n) => n + 1)
      return null
    }
    const rendered = renderElement(createElement(Probe))
    rendered.unmount()
    expect(identities.length).toBeGreaterThan(1)
    expect(new Set(identities).size).toBe(1)
  })
})

describe('manual card move while sorted', () => {
  it('clears the active sorts and notifies so the dragged order becomes visible', () => {
    const moveItem = vi.fn()
    const clearSorts = vi.fn()
    const notifySortCleared = vi.fn()
    const onMove = makeMoveItemClearingSorts({
      moveItem,
      getSorts: () => activeSorts,
      clearSorts,
      notifySortCleared,
    })
    onMove('i-1', doingCell, { itemId: 'i-2', position: 'before' })
    expect(moveItem).toHaveBeenCalledWith('i-1', doingCell, { itemId: 'i-2', position: 'before' })
    expect(clearSorts).toHaveBeenCalledTimes(1)
    expect(notifySortCleared).toHaveBeenCalledTimes(1)
  })

  it('keeps the sorts untouched and stays silent when nothing is sorted', () => {
    const moveItem = vi.fn()
    const clearSorts = vi.fn()
    const notifySortCleared = vi.fn()
    const onMove = makeMoveItemClearingSorts({
      moveItem,
      getSorts: () => [],
      clearSorts,
      notifySortCleared,
    })
    onMove('i-1', { groupKey: 'done' })
    expect(moveItem).toHaveBeenCalledWith('i-1', { groupKey: 'done' }, undefined)
    expect(clearSorts).not.toHaveBeenCalled()
    expect(notifySortCleared).not.toHaveBeenCalled()
  })
})
