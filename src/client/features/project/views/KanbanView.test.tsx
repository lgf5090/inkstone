import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { KanbanView, kanbanColumnKeys } from './KanbanView'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: 'propColorBlue' }, { id: 'o2', value: 'Done', color: 'propColorGreen' }] },
  { id: 'pt', name: 'Notes', type: 'text', options: [] },
]

function card(id: string, status = 'o1', parentId = ''): ProjectCard {
  return { id, boardId: 'b1', parentId, title: id, icon: '', isTemplate: false, contentOrder: [], values: { ps: status }, ...stamps }
}

let view: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

async function mount(cards: ProjectCard[], extra: Partial<ProjectViewFields> = {}, selected: string[] = []): Promise<Record<string, unknown>> {
  const subtasksByParent = new Map<string, ProjectCard[]>()
  for (const entry of cards) {
    if (!entry.parentId) continue
    const list = subtasksByParent.get(entry.parentId)
    if (list) list.push(entry)
    else subtasksByParent.set(entry.parentId, [entry])
  }
  const props = {
    cards, properties, fields: { ...emptyProjectViewFields(), groupById: 'ps', ...extra },
    badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }),
    subtasksByParent, canEdit: true, selected, onSelectClick: vi.fn(), onOpenCard: vi.fn(), onDeleteCard: vi.fn(),
    onPatchCard: vi.fn().mockResolvedValue(undefined), onPatchCards: vi.fn().mockResolvedValue(undefined), onPatchFields: vi.fn(), onAddCard: vi.fn().mockResolvedValue(undefined),
    onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined),
    onSetGroupOptionColor: vi.fn().mockResolvedValue(undefined), starredCards: [], pinnedCards: [], descriptionFor: () => '',
    onCardContextMenu: vi.fn(), onToggleCardDone: vi.fn().mockResolvedValue(undefined), onAddSubtask: vi.fn().mockResolvedValue(undefined),
  }
  await act(async () => { view = renderElement(createElement(KanbanView, props)) })
  return props as unknown as Record<string, unknown>
}

const columns = (): HTMLElement[] => [...view.container.querySelectorAll<HTMLElement>('[data-kanban-column]')]

describe('column order and visibility', () => {
  it('follows the saved column order and drops the hidden ones', () => {
    const fields = { ...emptyProjectViewFields(), columnOrder: ['', 'o2', 'o1'], hiddenOptionIds: ['o1'] }
    expect(kanbanColumnKeys(properties[0], fields)).toEqual(['', 'o2'])
  })

  it('keeps the property order for a column the reader never moved', () => {
    const fields = { ...emptyProjectViewFields(), columnOrder: ['o2'] }
    expect(kanbanColumnKeys(properties[0], fields)).toEqual(['o2', 'o1', ''])
  })

  it('folds a column to a spine and unfolds it again', async () => {
    const props = await mount([card('a')])
    const collapse = columns()[0]!.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.view.collapse_column')}"]`)!
    await act(async () => { collapse.click() })
    expect(props.onPatchFields).toHaveBeenCalledWith({ collapsedOptionIds: ['o1'] })
    view.unmount()
    await mount([card('a')], { collapsedOptionIds: ['o1'] })
    expect(columns()[0]!.getAttribute('data-collapsed')).toBe('true')
    expect(columns()[0]!.querySelector('[data-drag-id="a"]')).toBeNull()
    await act(async () => { columns()[0]!.querySelector<HTMLButtonElement>('.pv-col-vertical')!.click() })
  })
})

describe('the column header', () => {
  it('renames the option itself, so every view of it agrees', async () => {
    const props = await mount([card('a')])
    await act(async () => { columns()[0]!.querySelector<HTMLButtonElement>('.pv-col-name')!.click() })
    const field = columns()[0]!.querySelector<HTMLInputElement>('header input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(field, 'Backlog'); field.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(props.onRenameGroupOption).toHaveBeenCalledWith('ps', 'o1', 'Backlog')
  })

  it('wears the option colour on its band and counts its cards', async () => {
    await mount([card('a'), card('b')])
    const open = columns()[0]!
    expect(open.getAttribute('style')).toContain('--kanban-tag-blue-fg')
    expect(open.querySelector('.pv-col-band')).not.toBeNull()
    expect(open.querySelector('.pv-col-count')?.textContent).toBe('2')
  })

  it('flags a column past its WIP ceiling', async () => {
    await mount([card('a'), card('b')], { wipLimits: { o1: 1 } })
    expect(columns()[0]!.querySelector('.pv-col-count')?.getAttribute('data-over-limit')).toBe('true')
  })
})

describe('cards on the board', () => {
  it('keeps a subtask under its parent and shows the progress it has made', async () => {
    await mount([card('parent'), card('child', 'o2', 'parent')])
    const open = columns()[0]!
    expect(open.querySelectorAll('[data-drag-id]')).toHaveLength(1)
    expect(open.querySelector('[data-subtask-progress]')?.getAttribute('data-subtask-progress')).toBe('1/1')
    const expander = open.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.card.expand_subtasks')}"]`)!
    await act(async () => { expander.click() })
    expect(open.querySelector(`[data-subtasks="parent"]`)?.textContent).toContain('child')
  })

  it('files a card into the column whose quick-add was used', async () => {
    const props = await mount([])
    const field = columns()[1]!.querySelector<HTMLInputElement>('.pv-quickadd input')!
    expect(field, 'the column has no always-visible add input').not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(field, 'Fresh'); field.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(props.onAddCard).toHaveBeenCalledWith('Fresh', 'o2')
  })

  it('offers a viewer no grip and no quick-add', async () => {
    const cards = [card('a')]
    await act(async () => {
      view = renderElement(createElement(KanbanView, {
        cards, properties, fields: { ...emptyProjectViewFields(), groupById: 'ps' },
        badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }),
        subtasksByParent: new Map(), canEdit: false, selected: [], onSelectClick: vi.fn(), onOpenCard: vi.fn(),
        onDeleteCard: vi.fn(), onPatchCard: vi.fn(), onPatchCards: vi.fn(), onPatchFields: vi.fn(), onAddCard: vi.fn(),
        onAddGroupOption: vi.fn(), onRenameGroupOption: vi.fn(), onSetGroupOptionColor: vi.fn(),
        starredCards: [], pinnedCards: [], descriptionFor: () => '', onCardContextMenu: vi.fn(),
        onToggleCardDone: vi.fn(), onAddSubtask: vi.fn(),
      }))
    })
    expect(view.container.querySelector('[data-drag-handle]')).toBeNull()
    expect(view.container.querySelector('.pv-quickadd-btn')).toBeNull()
  })
})

describe('dragging within a column', () => {
  it('shows the insertion line and persists the new manual order', async () => {
    const props = await mount([card('a'), card('b'), card('c')])
    const zone = columns()[0]!.querySelector<HTMLElement>('[data-drag-zone]')!
    zone.getBoundingClientRect = () => ({ left: 0, right: 280, top: 0, bottom: 600, width: 280, height: 600, x: 0, y: 0, toJSON: () => ({}) })
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      const element = view.container.querySelector<HTMLElement>(`[data-drag-id="${id}"]`)!
      const top = index * 100
      element.getBoundingClientRect = () => ({ left: 0, right: 280, top, bottom: top + 90, width: 280, height: 90, x: 0, y: top, toJSON: () => ({}) })
    }
    const grip = view.container.querySelector<HTMLElement>('[data-drag-id="a"] [data-drag-handle]')!
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, pointerId: 1, pointerType: 'mouse' })
    await act(async () => { grip.dispatchEvent(down) })
    await act(async () => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 260 })) })
    // The ghost and the line are painted on the next frame, not on the event itself.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 32)) })
    expect(view.container.querySelector('[data-drop-line]')).not.toBeNull()
    expect(document.querySelector('.pv-ghost')).not.toBeNull()
    await act(async () => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 20, clientY: 260 })) })
    expect(props.onPatchFields).toHaveBeenCalledWith({ cardOrder: ['b', 'c', 'a'] })
    expect(props.onPatchCard).not.toHaveBeenCalled()
    expect(document.querySelector('.pv-ghost')).toBeNull()
  })
})

describe('dragging a multi-selection', () => {
  it('moves every selected card to the target column together', async () => {
    const props = await mount([card('a'), card('b'), card('c', 'o2')], {}, ['a', 'b'])
    const zones = columns().map((column) => column.querySelector<HTMLElement>('[data-drag-zone]')!)
    zones[0]!.getBoundingClientRect = () => ({ left: 0, right: 280, top: 0, bottom: 600, width: 280, height: 600, x: 0, y: 0, toJSON: () => ({}) })
    zones[1]!.getBoundingClientRect = () => ({ left: 300, right: 580, top: 0, bottom: 600, width: 280, height: 600, x: 300, y: 0, toJSON: () => ({}) })
    const rects: Record<string, { left: number, top: number }> = { a: { left: 0, top: 0 }, b: { left: 0, top: 100 }, c: { left: 300, top: 0 } }
    for (const [id, rect] of Object.entries(rects)) {
      const element = view.container.querySelector<HTMLElement>(`[data-drag-id="${id}"]`)!
      element.getBoundingClientRect = () => ({ left: rect.left, right: rect.left + 280, top: rect.top, bottom: rect.top + 90, width: 280, height: 90, x: rect.left, y: rect.top, toJSON: () => ({}) })
    }
    const grip = view.container.querySelector<HTMLElement>('[data-drag-id="a"] [data-drag-handle]')!
    await act(async () => { grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, pointerId: 1, pointerType: 'mouse' })) })
    await act(async () => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 320, clientY: 50 })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 32)) })
    expect(document.querySelector('.pv-ghost-count')?.textContent).toBe('2')
    await act(async () => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 320, clientY: 50 })) })
    expect(props.onPatchFields).toHaveBeenCalledWith({ cardOrder: ['c', 'a', 'b'] })
    expect(props.onPatchCards).toHaveBeenCalledWith(['a', 'b'], { ps: 'o2' })
    expect(props.onPatchCard).not.toHaveBeenCalled()
  })

  it('counts the drop index without the travelling group when reordering within a column', async () => {
    const props = await mount([card('a'), card('b'), card('c'), card('d')], {}, ['a', 'b'])
    const zone = columns()[0]!.querySelector<HTMLElement>('[data-drag-zone]')!
    zone.getBoundingClientRect = () => ({ left: 0, right: 280, top: 0, bottom: 600, width: 280, height: 600, x: 0, y: 0, toJSON: () => ({}) })
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
      const element = view.container.querySelector<HTMLElement>(`[data-drag-id="${id}"]`)!
      const top = index * 100
      element.getBoundingClientRect = () => ({ left: 0, right: 280, top, bottom: top + 90, width: 280, height: 90, x: 0, y: top, toJSON: () => ({}) })
    }
    const grip = view.container.querySelector<HTMLElement>('[data-drag-id="a"] [data-drag-handle]')!
    await act(async () => { grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, pointerId: 1, pointerType: 'mouse' })) })
    await act(async () => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 290 })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 32)) })
    await act(async () => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 20, clientY: 290 })) })
    expect(props.onPatchFields).toHaveBeenCalledWith({ cardOrder: ['c', 'a', 'b', 'd'] })
    expect(props.onPatchCard).not.toHaveBeenCalled()
  })

  it('reads a selection made after mount, not the empty one at mount', async () => {
    const props = await mount([card('a'), card('b'), card('c', 'o2')])
    const zones = columns().map((column) => column.querySelector<HTMLElement>('[data-drag-zone]')!)
    zones[0]!.getBoundingClientRect = () => ({ left: 0, right: 280, top: 0, bottom: 600, width: 280, height: 600, x: 0, y: 0, toJSON: () => ({}) })
    zones[1]!.getBoundingClientRect = () => ({ left: 300, right: 580, top: 0, bottom: 600, width: 280, height: 600, x: 300, y: 0, toJSON: () => ({}) })
    const rects: Record<string, { left: number, top: number }> = { a: { left: 0, top: 0 }, b: { left: 0, top: 100 }, c: { left: 300, top: 0 } }
    for (const [id, rect] of Object.entries(rects)) {
      const element = view.container.querySelector<HTMLElement>(`[data-drag-id="${id}"]`)!
      element.getBoundingClientRect = () => ({ left: rect.left, right: rect.left + 280, top: rect.top, bottom: rect.top + 90, width: 280, height: 90, x: rect.left, y: rect.top, toJSON: () => ({}) })
    }
    await act(async () => { view.rerender(createElement(KanbanView, { ...props, selected: ['a', 'b'] } as never)) })
    const grip = view.container.querySelector<HTMLElement>('[data-drag-id="a"] [data-drag-handle]')!
    await act(async () => { grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, pointerId: 1, pointerType: 'mouse' })) })
    await act(async () => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 320, clientY: 50 })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 32)) })
    expect(document.querySelector('.pv-ghost-count')?.textContent).toBe('2')
    await act(async () => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 320, clientY: 50 })) })
    expect(props.onPatchCards).toHaveBeenCalledWith(['a', 'b'], { ps: 'o2' })
  })
})
describe('the two card layouts', () => {
  it('draws a compact line by default and a full card when the view says so', async () => {
    await mount([card('a')])
    expect(view.container.querySelector('[data-layout="compact"]')).not.toBeNull()
    expect(view.container.querySelector('.pv-card-desc')).toBeNull()
    view.unmount()
    const props = await mount([card('a')], { boardLayout: 'card' })
    expect(view.container.querySelector('[data-layout="card"]')).not.toBeNull()
    expect(props).toBeTruthy()
  })

  it('shows the blurb and the pin/star marks only on the full card', async () => {
    const cards = [card('a')]
    const subtasksByParent = new Map<string, ProjectCard[]>()
    await act(async () => {
      view = renderElement(createElement(KanbanView, {
        cards, properties, fields: { ...emptyProjectViewFields(), groupById: 'ps', boardLayout: 'card' },
        badgesFor: () => ({ description: true, comments: 2, checked: 0, checkboxes: 0 }),
        subtasksByParent, canEdit: true, selected: [], onSelectClick: vi.fn(), onOpenCard: vi.fn(),
        onDeleteCard: vi.fn(), onPatchCard: vi.fn(), onPatchCards: vi.fn(), onPatchFields: vi.fn(), onAddCard: vi.fn(),
        onAddGroupOption: vi.fn(), onRenameGroupOption: vi.fn(), onSetGroupOptionColor: vi.fn(),
        starredCards: ['a'], pinnedCards: ['a'], descriptionFor: () => 'a short blurb',
        onCardContextMenu: vi.fn(), onToggleCardDone: vi.fn(), onAddSubtask: vi.fn(),
      }))
    })
    expect(view.container.querySelector('.pv-card-desc')?.textContent).toBe('a short blurb')
    expect(view.container.querySelector(`[aria-label="${t('project.card.pin')}"]`)).not.toBeNull()
    expect(view.container.querySelector(`[aria-label="${t('project.card.favorite')}"]`)).not.toBeNull()
  })

  it('floats a pinned card to the top of its own column', async () => {
    const cards = [card('a'), card('b'), card('c')]
    await act(async () => {
      view = renderElement(createElement(KanbanView, {
        cards, properties, fields: { ...emptyProjectViewFields(), groupById: 'ps' },
        badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }),
        subtasksByParent: new Map(), canEdit: true, selected: [], onSelectClick: vi.fn(), onOpenCard: vi.fn(),
        onDeleteCard: vi.fn(), onPatchCard: vi.fn(), onPatchCards: vi.fn(), onPatchFields: vi.fn(), onAddCard: vi.fn(),
        onAddGroupOption: vi.fn(), onRenameGroupOption: vi.fn(), onSetGroupOptionColor: vi.fn(),
        starredCards: [], pinnedCards: ['c'], descriptionFor: () => '',
        onCardContextMenu: vi.fn(), onToggleCardDone: vi.fn(), onAddSubtask: vi.fn(),
      }))
    })
    const ids = [...columns()[0]!.querySelectorAll('[data-drag-id]')].map((node) => node.getAttribute('data-drag-id'))
    expect(ids).toEqual(['c', 'a', 'b'])
  })
})

describe('the column menu and reorder', () => {
  it('offers rename, colour, collapse and hide on a right click', async () => {
    await mount([card('a')])
    await act(async () => { columns()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
    const rows = [...document.querySelectorAll('[role^="menuitem"]')].map((node) => node.textContent)
    expect(rows).toEqual([
      t('project.view.new_card_here'),
      t('project.view.rename_group'),
      t('project.view.column_color'),
      t('project.view.collapse_column'),
      t('project.view.hide_column'),
    ])
  })

  it('writes the picked colour back to the option', async () => {
    const props = await mount([card('a')])
    await act(async () => { columns()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
    const colour = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((node) => node.textContent === t('project.view.column_color'))!
    await act(async () => { colour.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const red = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((node) => node.textContent === 'Red')!
    await act(async () => { red.click() })
    expect(props.onSetGroupOptionColor).toHaveBeenCalledWith('ps', 'o1', 'propColorRed')
  })

  it('persists a dragged column order including the empty bucket key', async () => {
    const props = await mount([card('a')])
    const before = columns()
    // jsdom lays nothing out, so the drag reads the bands a real board would report.
    before.forEach((node, index) => {
      node.getBoundingClientRect = () => ({ left: index * 300, right: index * 300 + 280, top: 0, bottom: 600, width: 280, height: 600, x: index * 300, y: 0, toJSON: () => ({}) })
    })
    const grip = before[0]!.querySelector<HTMLElement>('[data-column-grip]')!
    const fire = (type: string, x: number, target: EventTarget = window): void => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 20, button: 0, pointerId: 1, pointerType: 'mouse' }))
    }
    await act(async () => { fire('pointerdown', 20, grip) })
    await act(async () => { fire('pointermove', 340) })
    expect(before[1]!.querySelector('.pv-col-head')!.getAttribute('data-drop-target')).toBe('true')
    await act(async () => { fire('pointerup', 340) })
    expect(props.onPatchFields).toHaveBeenCalledWith({ columnOrder: ['o2', 'o1', ''] })
  })
})
