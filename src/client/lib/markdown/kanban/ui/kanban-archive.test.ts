/**
 * F-12. Filing a card away takes it out of every view, count and chart at once, and the archive
 * panel is the only way back — so these cases read a mounted board end to end: what the reader no
 * longer sees, what the panel offers, and how one click travels back into the document through the
 * board's single commit path.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KanbanRoot } from './kanban-root'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const columns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', label: 'To Do', color: 'gray' },
      { id: 'doing', label: 'In Progress', color: 'blue' },
    ],
  },
]

function card(id: string, archived = false): KanbanItem {
  return { id, title: `Card ${id}`, properties: { status: 'todo' }, ...(archived ? { archived: true } : {}) }
}

function board(items: KanbanItem[]): KanbanData {
  return {
    columns,
    items,
    views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }],
  } as KanbanData
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  useUi.setState({ toasts: [] })
})

beforeEach(() => {
  useUi.setState({ toasts: [] })
})

function mountBoard(data: KanbanData) {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

/** The document the host was last handed — what one step of the board history wrote. */
function committed(onUpdateData: ReturnType<typeof vi.fn>): KanbanData {
  const calls = onUpdateData.mock.calls
  return (calls.at(-1) as [KanbanData])[0]
}

/** The control that opens a card's detail: the title button inside the card's heading (SH-107). */
function cardTitle(container: HTMLElement, itemId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-item-id="${itemId}"] h3 button`)
}

function onBoard(container: HTMLElement, itemId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
}

function archiveTrigger(count: number): HTMLButtonElement | null {
  const trigger = document.querySelector<HTMLButtonElement>('[data-kanban-archive]')
  return trigger && trigger.getAttribute('aria-label') === t('preview.kanban_archived_count', { count }) ? trigger : null
}

function openArchivePanel(count: number): HTMLElement {
  const trigger = archiveTrigger(count)
  if (!trigger) throw new Error(`no archive control named by ${count} card(s)`)
  act(() => { trigger.click() })
  const panel = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${t('preview.kanban_archive_panel')}"]`)
  if (!panel) throw new Error('the archive panel did not open')
  return panel
}

function archivedTitles(panel: HTMLElement): string[] {
  return [...panel.querySelectorAll('li')].map((row) => row.firstElementChild?.textContent ?? '')
}

function detailWindow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
}

function select(container: HTMLElement, itemId: string) {
  const box = onBoard(container, itemId)?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!box) throw new Error(`card "${itemId}" offers no selection box`)
  act(() => { box.click() })
}

describe('a card the board filed away', () => {
  it('is off the board its view still draws', () => {
    const { container } = mountBoard(board([card('a'), card('b'), card('z', true)]))
    expect(onBoard(container, 'a')).toBeTruthy()
    expect(onBoard(container, 'z')).toBeNull()
  })

  it('is counted by the one control that can bring it back', () => {
    mountBoard(board([card('a'), card('z', true)]))
    const trigger = archiveTrigger(1)
    expect(trigger).toBeTruthy()
    expect(trigger!.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger!.getAttribute('aria-expanded')).toBe('false')
  })

  it('offers no archive control at all while nothing is filed away', () => {
    const { container } = mountBoard(board([card('a')]))
    expect(container.querySelector('[data-kanban-archive]')).toBeNull()
  })

  it('is the only title the panel lists', () => {
    mountBoard(board([card('a'), card('z', true)]))
    expect(archivedTitles(openArchivePanel(1))).toEqual(['Card z'])
  })

  it('leaves the tag bar no value that only filed-away cards hold', () => {
    const header = (container: HTMLElement) => container.querySelector('[data-kanban-header]')?.textContent ?? ''
    const shelved: KanbanItem = { id: 'z', title: 'Card z', properties: { status: 'todo', tags: ['Shelved'] }, archived: true }
    const living: KanbanItem = { id: 'a', title: 'Card a', properties: { status: 'todo', tags: ['ShipIt'] } }
    const { container } = mountBoard(board([living, shelved]))
    const bar = header(container)
    expect(bar).toContain('ShipIt')
    expect(bar, 'a tag no live card carries promises a filter that returns nothing').not.toContain('Shelved')
  })
})

describe('bringing a card back', () => {
  it('restores the one a row names, in one step, and leaves no flag behind', () => {
    const { container, onUpdateData } = mountBoard(board([card('a'), card('z', true)]))
    const panel = openArchivePanel(1)
    act(() => { panel.querySelector<HTMLButtonElement>('[data-kanban-archive-restore]')!.click() })
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    const restored = committed(onUpdateData).items.find((item) => item.id === 'z')!
    expect('archived' in restored).toBe(false)
    expect(onBoard(container, 'z')).toBeTruthy()
    expect(document.querySelector('[data-kanban-archive]')).toBeNull()
  })

  it('restores the whole archive in one step and closes what it emptied', () => {
    const { onUpdateData } = mountBoard(board([card('a'), card('y', true), card('z', true)]))
    const panel = openArchivePanel(2)
    act(() => { panel.querySelector<HTMLButtonElement>('[data-kanban-archive-restore-all]')!.click() })
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    expect(committed(onUpdateData).items.every((item) => !('archived' in item))).toBe(true)
    expect(document.querySelector(`[aria-label="${t('preview.kanban_archive_panel')}"]`)).toBeNull()
  })

  it('keeps the rest of the archive on the shelf when one card comes back', () => {
    const { onUpdateData } = mountBoard(board([card('y', true), card('z', true)]))
    const panel = openArchivePanel(2)
    act(() => { panel.querySelectorAll<HTMLButtonElement>('[data-kanban-archive-restore]')[0]!.click() })
    expect(archiveTrigger(1)).toBeTruthy()
    expect(document.querySelector(`[aria-label="${t('preview.kanban_archive_panel')}"]`),
      'a shelf that still holds a card shut itself').toBeTruthy()
    expect(onUpdateData).toHaveBeenCalledTimes(1)
  })

  it('moves a filed-away card to the deleted list from the same row, where it can still be restored', () => {
    const { onUpdateData } = mountBoard(board([card('a'), card('z', true)]))
    const panel = openArchivePanel(1)
    act(() => { panel.querySelector<HTMLButtonElement>('[data-kanban-archive-delete]')!.click() })
    const deleted = committed(onUpdateData).items.find((item) => item.id === 'z')!
    expect(deleted.deleted).toBe(true)
    // The deleted section is the shelf the card can come back from: the panel lists it with a purge
    // of its own, and the restore row puts the card on the board again.
    expect(document.querySelector('[data-kanban-deleted-list]')?.textContent).toContain('Card z')
    act(() => { document.querySelector<HTMLButtonElement>('[data-kanban-deleted-list] [data-kanban-archive-restore]')!.click() })
    const restored = committed(onUpdateData).items.find((item) => item.id === 'z')!
    expect('deleted' in restored).toBe(false)
    expect('archived' in restored).toBe(false)
  })
})

describe('filing cards away from the board', () => {
  it('archives the selection in one step, says how many, and clears it', () => {
    const { container, onUpdateData } = mountBoard(board([card('a'), card('b')]))
    select(container, 'a')
    select(container, 'b')
    const archive = container.querySelector<HTMLButtonElement>('[data-kanban-batch-archive]')
    if (!archive) throw new Error('the batch bar offers no archive step')
    act(() => { archive.click() })
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    expect(committed(onUpdateData).items.map((item) => [item.id, item.archived])).toEqual([
      ['a', true],
      ['b', true],
    ])
    expect(useUi.getState().toasts.at(-1)?.title).toBe(t('preview.kanban_archive_toast', { count: 2 }))
    expect(onBoard(container, 'a')).toBeNull()
    expect(container.querySelector('[data-kanban-batch-archive]')).toBeNull()
  })

  it('closes the detail window of a card that was filed away from behind it', () => {
    const { container } = mountBoard(board([card('a'), card('b')]))
    select(container, 'a')
    act(() => { cardTitle(container, 'a')!.click() })
    expect(detailWindow()).toBeTruthy()
    act(() => { container.querySelector<HTMLButtonElement>('[data-kanban-batch-archive]')!.click() })
    expect(detailWindow()).toBeNull()
  })

  it('leaves the detail window of a card that stayed on the board', () => {
    const { container } = mountBoard(board([card('a'), card('b')]))
    select(container, 'b')
    act(() => { cardTitle(container, 'a')!.click() })
    expect(detailWindow()).toBeTruthy()
    act(() => { container.querySelector<HTMLButtonElement>('[data-kanban-batch-archive]')!.click() })
    expect(detailWindow()).toBeTruthy()
  })
})
