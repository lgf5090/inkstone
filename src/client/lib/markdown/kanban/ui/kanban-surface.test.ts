/**
 * The command palette is global and the board is a React root inside the document, so the two meet
 * through a registry: a board on screen registers what it can do, and the palette reads the one the
 * reader is in. What is pinned here is the choice — containment when there are several boards, the
 * lone board when there is one — and that a real board registers actions that actually work, so the
 * palette can never offer a command that does nothing.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { kanbanSurfaceCommands, registerKanbanSurface, type KanbanSurfaceCommands } from '../surface-commands'
import type { KanbanData } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

function stubCommands(over: Partial<KanbanSurfaceCommands> = {}): KanbanSurfaceCommands {
  return {
    boardTitle: 'Board',
    views: [{ id: 'v', name: 'Board', icon: null }],
    activeViewId: 'v',
    selectedCount: 0,
    canUndo: false,
    canRedo: false,
    addCard: vi.fn(),
    selectView: vi.fn(),
    selectAllVisible: vi.fn(),
    clearSelection: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    ...over,
  }
}

describe('which board answers the palette', () => {
  const registered: Array<() => void> = []

  afterEach(() => {
    while (registered.length > 0) registered.pop()!()
  })

  function register(element: Element, commands: KanbanSurfaceCommands) {
    const off = registerKanbanSurface(element, () => commands)
    registered.push(off)
    return off
  }

  it('answers from the board the focused element is inside', () => {
    const first = document.createElement('div')
    const second = document.createElement('div')
    const inner = document.createElement('span')
    second.append(inner)
    const firstCommands = stubCommands({ boardTitle: 'First' })
    const secondCommands = stubCommands({ boardTitle: 'Second' })
    register(first, firstCommands)
    register(second, secondCommands)

    expect(kanbanSurfaceCommands(inner)).toBe(secondCommands)
    expect(kanbanSurfaceCommands(first)).toBe(firstCommands)
  })

  it('says nothing when several boards are on screen and none holds the focus', () => {
    register(document.createElement('div'), stubCommands())
    register(document.createElement('div'), stubCommands())
    expect(kanbanSurfaceCommands(document.body)).toBeNull()
  })

  it('answers from a lone board before the reader has clicked into it', () => {
    const only = stubCommands()
    register(document.createElement('div'), only)
    expect(kanbanSurfaceCommands(document.body)).toBe(only)
  })

  it('stops answering once the board is gone', () => {
    const element = document.createElement('div')
    const off = register(element, stubCommands())
    expect(kanbanSurfaceCommands(element)).not.toBeNull()
    off()
    expect(kanbanSurfaceCommands(element)).toBeNull()
  })
})

function boardData(): KanbanData {
  return {
    title: 'Gate Board',
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }, { id: 'done', label: 'Done', color: 'green' }] },
    ],
    items: [
      { id: 'a', title: 'Design spec', properties: { status: 'todo' } },
      { id: 'b', title: 'Ship it', properties: { status: 'done' } },
    ],
    views: [
      // The first view hides the done card, so "select what is in view" has something to leave out.
      { id: 'v', name: 'Board', type: 'board', groupBy: 'status', filters: [{ propertyId: 'status', operator: 'equals', value: 'todo' }] },
      { id: 't', name: 'Table', type: 'table' },
    ],
  } as KanbanData
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountBoard() {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boardData(), onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

describe('what a mounted board offers', () => {
  it('names the board, its views and the one on screen', () => {
    const { container } = mountBoard()
    const surface = kanbanSurfaceCommands(container.querySelector('[data-kanban-header]'))
    expect(surface).not.toBeNull()
    expect(surface!.boardTitle).toBe('Gate Board')
    expect(surface!.views.map((view) => view.name)).toEqual(['Board', 'Table'])
    expect(surface!.activeViewId).toBe('v')
    expect(surface!.canUndo).toBe(false)
  })

  it('falls back to the board’s own name when the fence has no title', () => {
    const onUpdateData = vi.fn()
    const data = boardData()
    delete data.title
    const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
    mounted.push(rendered)
    expect(kanbanSurfaceCommands(rendered.container)!.boardTitle).toBe(t('preview.kanban'))
  })

  it('reports no board once it is unmounted', () => {
    const { container, unmount } = mountBoard()
    const header = container.querySelector('[data-kanban-header]')
    expect(kanbanSurfaceCommands(header)).not.toBeNull()
    unmount()
    mounted.pop()
    expect(kanbanSurfaceCommands(header)).toBeNull()
    expect(kanbanSurfaceCommands(document.body)).toBeNull()
  })
})

// The palette runs these against the live board, so each one has to move the document the way the
// board's own control does — a command that only looked like it worked is worse than no command.
describe('what a mounted board lets the palette run', () => {
  it('adds a card through the board’s own commit path', () => {
    const { container, onUpdateData } = mountBoard()
    const surface = kanbanSurfaceCommands(container)!
    act(() => { surface.addCard() })
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    expect(onUpdateData.mock.calls[0]![0].items).toHaveLength(3)
  })

  it('switches the view the board is showing', () => {
    const { container, onUpdateData } = mountBoard()
    const surface = kanbanSurfaceCommands(container)!
    act(() => { surface.selectView('t') })
    expect(onUpdateData.mock.calls.at(-1)![0].activeViewId).toBe('t')
  })

  it('selects every card the view draws, and clears it again', () => {
    const { container } = mountBoard()
    const surface = kanbanSurfaceCommands(container)!
    expect(surface.selectedCount).toBe(0)
    act(() => { surface.selectAllVisible() })
    const selected = kanbanSurfaceCommands(container)!
    // One of the two cards is filtered out of this view: sweeping the document instead would count 2.
    expect(selected.selectedCount).toBe(1)
    act(() => { selected.clearSelection() })
    expect(kanbanSurfaceCommands(container)!.selectedCount).toBe(0)
  })
})
