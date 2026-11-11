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

async function mount(cards: ProjectCard[], extra: Partial<ProjectViewFields> = {}): Promise<Record<string, unknown>> {
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
    subtasksByParent, canEdit: true, selected: [], onSelectClick: vi.fn(), onOpenCard: vi.fn(), onDeleteCard: vi.fn(),
    onPatchCard: vi.fn().mockResolvedValue(undefined), onPatchFields: vi.fn(), onAddCard: vi.fn().mockResolvedValue(undefined),
    onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRenameGroupOption: vi.fn().mockResolvedValue(undefined),
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
    const add = columns()[1]!.querySelector<HTMLButtonElement>('.pv-quickadd-btn')!
    await act(async () => { add.click() })
    const field = columns()[1]!.querySelector<HTMLInputElement>('input')!
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
        onDeleteCard: vi.fn(), onPatchCard: vi.fn(), onPatchFields: vi.fn(), onAddCard: vi.fn(),
        onAddGroupOption: vi.fn(), onRenameGroupOption: vi.fn(), onCardContextMenu: vi.fn(),
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