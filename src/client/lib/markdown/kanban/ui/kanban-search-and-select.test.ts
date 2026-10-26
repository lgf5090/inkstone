import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals } from '../../../test-render'
import { computeSelectionAfterToggleAll, useKanbanSelection } from './kanban-root-hooks'
import type { CommitKanbanData } from './kanban-history'
import { KanbanSearchBox } from './kanban-search-box'
import { KanbanTableView } from './kanban-table-view'
import type { KanbanData, KanbanItem, KanbanView } from '../types'

const BOARD_VIEW: KanbanView = { id: 'v-probe', name: 'Board', type: 'board' }

beforeAll(async () => {
  await initI18n()
})

/**
 * Every root this file mounts is registered here and released after the test that made it. A root left
 * mounted keeps its debounce timer alive, and a timer that outlives the file fires React's scheduler after
 * vitest has torn the jsdom environment down — `ReferenceError: window is not defined` in the run log while
 * every assertion in the file stayed green.
 */
const live = new Set<{ container: HTMLElement, root: Root }>()

function release(entry: { container: HTMLElement, root: Root } | null): void {
  if (!entry || !live.has(entry)) return
  live.delete(entry)
  act(() => { entry.root.unmount() })
  entry.container.remove()
}

afterEach(() => {
  for (const entry of [...live]) release(entry)
  vi.useRealTimers()
  // Tripwire: anything still attached was mounted without `mountRoot`, and its timers will outlive this file
  // exactly the way the released ones used to.
  expect(document.body.children, 'a test left a mounted root behind').toHaveLength(0)
})

function mountRoot() {
  installTestGlobals()
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const entry = { container, root }
  live.add(entry)
  return { container, root, release: () => release(entry) }
}

describe('computeSelectionAfterToggleAll', () => {
  it('adds every id when the selection does not cover them all', () => {
    const next = computeSelectionAfterToggleAll(new Set(['a']), ['a', 'b', 'c'])
    expect([...next].sort()).toEqual(['a', 'b', 'c'])
  })

  it('removes all the ids when they were all selected', () => {
    const next = computeSelectionAfterToggleAll(new Set(['a', 'b', 'c']), ['a', 'b', 'c'])
    expect(next.size).toBe(0)
  })

  it('keeps ids outside the toggle scope', () => {
    const next = computeSelectionAfterToggleAll(new Set(['a', 'z']), ['a'])
    expect([...next].sort()).toEqual(['z'])
  })
})

type SelectionApi = ReturnType<typeof useKanbanSelection>

function renderSelectionProbe() {
  installTestGlobals()
  const commitData: CommitKanbanData = vi.fn()
  let api: SelectionApi | null = null
  function Probe() {
    api = useKanbanSelection(commitData, undefined, BOARD_VIEW, vi.fn())
    return null
  }
  const { root, release } = mountRoot()
  act(() => { root.render(createElement(Probe)) })
  return { current: () => api!, unmount: release }
}

describe('useKanbanSelection handleToggleAll', () => {
  it('selects all ids in one update and clears them on the next call', () => {
    const { current, unmount } = renderSelectionProbe()
    act(() => { current().handleToggleAll(['a', 'b', 'c']) })
    expect([...current().selectedIds].sort()).toEqual(['a', 'b', 'c'])
    act(() => { current().handleToggleAll(['a', 'b', 'c']) })
    expect(current().selectedIds.size).toBe(0)
    unmount()
  })
})

function renderSearchBox(initialQuery: string, onSearchChange: (q: string) => void) {
  const { container, root } = mountRoot()
  const render = (query: string) => {
    act(() => { root.render(createElement(KanbanSearchBox, { searchQuery: query, onSearchChange })) })
  }
  render(initialQuery)
  return { container, root, render }
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('KanbanSearchBox debounce', () => {
  it('shows each keystroke at once but commits only after the quiet period', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onSearchChange = vi.fn()
    const { container, render } = renderSearchBox('', onSearchChange)
    const openButton = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('preview.kanban_search')}"]`)!
    act(() => { openButton.click() })
    const input = container.querySelector('input')!
    act(() => {
      typeInto(input, 'a')
      typeInto(input, 'ab')
    })
    expect(input.value).toBe('ab')
    expect(onSearchChange).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(500) })
    expect(onSearchChange).toHaveBeenCalledTimes(1)
    expect(onSearchChange).toHaveBeenCalledWith('ab')
    render('ab')
    expect(input.value).toBe('ab')
  })

  it('adopts a query committed from elsewhere, like switching views', () => {
    const onSearchChange = vi.fn()
    const { container, render } = renderSearchBox('', onSearchChange)
    const openButton = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('preview.kanban_search')}"]`)!
    act(() => { openButton.click() })
    render('synced')
    const input = container.querySelector('input')!
    expect(input.value).toBe('synced')
  })

  it('keeps the character typed while its own commit travels back through the board', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onSearchChange = vi.fn()
    const { container, render } = renderSearchBox('', onSearchChange)
    act(() => { container.querySelector<HTMLButtonElement>(`button[aria-label="${t('preview.kanban_search')}"]`)!.click() })
    const input = container.querySelector('input')!

    act(() => { typeInto(input, 'a') })
    act(() => { vi.advanceTimersByTime(500) })
    expect(onSearchChange).toHaveBeenLastCalledWith('a')

    // The board is where the query actually lives, and it applies the commit on a render of its own
    // choosing: the box goes on accepting keystrokes through that gap, and `render('a')` below is the
    // echo arriving afterwards. Adopting it blind would rewind the box to what it said before the
    // reader's next finger landed, which is a filter box that loses characters.
    act(() => { typeInto(input, 'ab') })
    render('a')
    expect(input.value, 'the echoed commit overwrote the character typed after it').toBe('ab')

    act(() => { vi.advanceTimersByTime(500) })
    expect(onSearchChange).toHaveBeenLastCalledWith('ab')
  })
})

describe('KanbanSearchBox while it is collapsed', () => {
  it('shows a box that is still filtering, and clears it from there', () => {
    const onSearchChange = vi.fn()
    const { container } = renderSearchBox('urgent', onSearchChange)
    expect(container.textContent, 'a board filtered by a query the reader cannot see').toContain('urgent')
    const clear = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('preview.kanban_clear_search')}"]`)
    expect(clear, 'the chip offered no way out of the filter').not.toBeNull()
    act(() => { clear!.click() })
    expect(onSearchChange).toHaveBeenCalledWith('')
  })

  it('shows the plain icon once nothing is filtering', () => {
    const { container } = renderSearchBox('', vi.fn())
    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).toBe('')
    expect(container.querySelector(`button[aria-label="${t('preview.kanban_search')}"]`)).not.toBeNull()
  })

  it('drops a pending commit when it goes away', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onSearchChange = vi.fn()
    const { container, root, release } = mountRoot()
    act(() => { root.render(createElement(KanbanSearchBox, { searchQuery: '', onSearchChange })) })
    act(() => {
      container.querySelector<HTMLButtonElement>(`button[aria-label="${t('preview.kanban_search')}"]`)!.click()
    })
    act(() => { typeInto(container.querySelector('input')!, 'ghost') })
    release()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onSearchChange, 'a filter was committed into a box that had already gone').not.toHaveBeenCalled()
  })

})

const tableItems: KanbanItem[] = [
  { id: 'a', title: 'A', properties: { status: 'todo' } },
  { id: 'b', title: 'B', properties: { status: 'todo' } },
  { id: 'c', title: 'C', properties: { status: 'doing' } },
]

const tableData: KanbanData = {
  columns: [
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'todo', label: 'To Do', color: 'gray' },
        { id: 'doing', label: 'Doing', color: 'blue' },
      ],
    },
  ],
  items: tableItems,
  views: [{ id: 'v', name: 'Table', type: 'table' }],
}

describe('KanbanTableView select all', () => {
  it('hands every id to the batch handler in one call', () => {
    const onToggleAll = vi.fn()
    const onToggleSelect = vi.fn()
    const { container, root, release } = mountRoot()
    act(() => {
      root.render(
        createElement(KanbanTableView, {
          data: tableData,
          view: tableData.views[0],
          selectedIds: new Set<string>(),
          onToggleSelect,
          onToggleAll,
          onOpenDetail: vi.fn(),
          onAddItem: vi.fn(),
          onAddColumn: vi.fn(),
          people: {},
          onSortColumn: vi.fn(),
          onUpdateProperty: vi.fn(),
          onUpdateMultiSelect: vi.fn(),
          onUpdateFiles: vi.fn(),
        }),
      )
    })
    const checkbox = container.querySelector<HTMLInputElement>(
      `input[type="checkbox"][aria-label="${t('preview.kanban_select_all')}"]`,
    )!
    expect(checkbox).toBeTruthy()
    act(() => { checkbox.click() })
    expect(onToggleAll).toHaveBeenCalledTimes(1)
    expect(onToggleAll).toHaveBeenCalledWith(['a', 'b', 'c'])
    expect(onToggleSelect).not.toHaveBeenCalled()
    release()
  })
})
