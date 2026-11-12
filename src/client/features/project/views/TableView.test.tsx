import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle, ProjectCard, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { initI18n } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { TableView } from './TableView'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'p1', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }] },
  { id: 'p2', name: 'Hours', type: 'number', options: [] },
  { id: 'p3', name: 'Notes', type: 'text', options: [] },
]

function card(id: string): ProjectCard {
  return { id, boardId: 'b1', parentId: '', title: id, icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps }
}

function bundle(): ProjectBoardBundle {
  return {
    board: { id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title: 'B', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, ...stamps },
    properties,
    views: [],
    cards: [card('a'), card('b')],
    contents: [], comments: [], members: [], role: 'admin', cursor: 1,
  }
}

let view: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

async function mount(fields: Partial<ProjectViewFields> = {}, canEdit = true): Promise<Record<string, unknown>> {
  const props = {
    bundle: bundle(), cards: [card('a'), card('b')],
    columns: fields.visiblePropertyIds?.length
      ? fields.visiblePropertyIds.map((id) => properties.find((property) => property.id === id)!)
      : properties,
    fields: { ...emptyProjectViewFields(), ...fields }, canEdit, selected: [], onSelected: vi.fn(),
    subtasksByParent: new Map<string, ProjectCard[]>(),
    badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }),
    onSelectClick: vi.fn(), onDeleteCard: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined),
    onPatchFields: vi.fn(), onAddCard: vi.fn().mockResolvedValue(undefined), onCardContextMenu: vi.fn(),
  }
  await act(async () => { view = renderElement(createElement(TableView, props)) })
  return props as unknown as Record<string, unknown>
}

function heads(): HTMLElement[] {
  return [...view.container.querySelectorAll<HTMLElement>('thead th[data-column-id]')]
}

async function press(from: number, pointerType: string): Promise<void> {
  const nodes = heads()
  // jsdom lays nothing out, so the drag reads the bands a real table would report.
  nodes.forEach((node, index) => {
    node.getBoundingClientRect = () => ({ left: index * 200, right: index * 200 + 190, top: 0, bottom: 40, width: 190, height: 40, x: index * 200, y: 0, toJSON: () => ({}) })
  })
  const grip = nodes[from]!.querySelector<HTMLElement>('[data-column-grip]')!
  await act(async () => { firePointer('pointerdown', from * 200 + 10, grip, pointerType) })
}

async function hold(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)) })
}

function firePointer(type: string, x: number, target: EventTarget = window, pointerType = 'mouse', y = 20): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType }))
}

async function dragColumn(from: number, to: number, pointerType = 'mouse'): Promise<void> {
  await press(from, pointerType)
  if (pointerType === 'touch') await hold()
  await act(async () => { firePointer('pointermove', to * 200 + 100, window, pointerType) })
  await act(async () => { firePointer('pointerup', to * 200 + 100, window, pointerType) })
}

describe('dragging a column', () => {
  it('moves it after the column it was dropped on when dragged rightwards', async () => {
    const props = await mount()
    await dragColumn(0, 1)
    expect(props.onPatchFields).toHaveBeenCalledWith({ visiblePropertyIds: ['p2', 'p1', 'p3'] })
  })

  it('moves it before the target when dragged leftwards', async () => {
    const props = await mount()
    await dragColumn(2, 0)
    expect(props.onPatchFields).toHaveBeenCalledWith({ visiblePropertyIds: ['p3', 'p1', 'p2'] })
  })

  it('honours a saved column order rather than the property order', async () => {
    const props = await mount({ visiblePropertyIds: ['p3', 'p2', 'p1'] })
    await dragColumn(0, 1)
    expect(props.onPatchFields).toHaveBeenCalledWith({ visiblePropertyIds: ['p2', 'p3', 'p1'] })
  })

  it('ignores a drop on itself', async () => {
    const props = await mount()
    await dragColumn(1, 1)
    expect(props.onPatchFields).not.toHaveBeenCalled()
  })

  it('marks the column under the pointer while dragging', async () => {
    await mount()
    await press(0, 'mouse')
    await act(async () => { firePointer('pointermove', 300) })
    expect(heads()[1]!.getAttribute('data-drop-target')).toBe('true')
    expect(heads()[0]!.getAttribute('data-dragging')).toBe('true')
    await act(async () => { firePointer('pointerup', 300) })
    expect(heads()[1]!.getAttribute('data-drop-target')).toBe('false')
    expect(document.body.classList.contains('pv-dragging')).toBe(false)
  })

  it('reorders from a finger held on the grip', async () => {
    const props = await mount()
    await dragColumn(0, 1, 'touch')
    expect(props.onPatchFields).toHaveBeenCalledWith({ visiblePropertyIds: ['p2', 'p1', 'p3'] })
  })

  it('leaves a scrolling finger alone', async () => {
    const props = await mount()
    await press(0, 'touch')
    await act(async () => { firePointer('pointermove', 10, window, 'touch', 80) })
    await hold()
    await act(async () => { firePointer('pointermove', 300, window, 'touch') })
    await act(async () => { firePointer('pointerup', 300, window, 'touch') })
    expect(props.onPatchFields).not.toHaveBeenCalled()
  })

  it('offers no grip on a read-only board', async () => {
    await mount({}, false)
    expect(heads()).toHaveLength(3)
    expect(view.container.querySelector('[data-column-grip]')).toBeNull()
  })
})
