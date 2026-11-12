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

async function mount(fields: Partial<ProjectViewFields> = {}): Promise<Record<string, unknown>> {
  const props = {
    bundle: bundle(), cards: [card('a'), card('b')],
    columns: fields.visiblePropertyIds?.length
      ? fields.visiblePropertyIds.map((id) => properties.find((property) => property.id === id)!)
      : properties,
    fields: { ...emptyProjectViewFields(), ...fields }, canEdit: true, selected: [], onSelected: vi.fn(),
    subtasksByParent: new Map<string, ProjectCard[]>(),
    badgesFor: () => ({ description: false, comments: 0, checked: 0, checkboxes: 0 }),
    onSelectClick: vi.fn(), onDeleteCard: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined),
    onPatchFields: vi.fn(), onAddCard: vi.fn().mockResolvedValue(undefined), onCardContextMenu: vi.fn(),
  }
  await act(async () => { view = renderElement(createElement(TableView, props)) })
  return props as unknown as Record<string, unknown>
}

function dragColumn(from: number, to: number): void {
  const heads = [...view.container.querySelectorAll('thead th[draggable="true"]')]
  const transfer = { data: {} as Record<string, string>, types: ['text/plain'], setData(k: string, v: string) { this.data[k] = v }, getData(k: string) { return this.data[k] } }
  const fire = (node: Element, type: string): void => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    node.dispatchEvent(event)
  }
  fire(heads[from]!, 'dragstart')
  fire(heads[to]!, 'dragover')
  fire(heads[to]!, 'drop')
}

describe('dragging a column', () => {
  it('moves it after the column it was dropped on when dragged rightwards', async () => {
    const props = await mount()
    await act(async () => { dragColumn(0, 1) })
    expect(props.onPatchFields).toHaveBeenCalledWith({ visiblePropertyIds: ['p2', 'p1', 'p3'] })
  })

  it('moves it before the target when dragged leftwards', async () => {
    const props = await mount()
    await act(async () => { dragColumn(2, 0) })
    expect(props.onPatchFields).toHaveBeenCalledWith({ visiblePropertyIds: ['p3', 'p1', 'p2'] })
  })

  it('honours a saved column order rather than the property order', async () => {
    const props = await mount({ visiblePropertyIds: ['p3', 'p2', 'p1'] })
    await act(async () => { dragColumn(0, 1) })
    expect(props.onPatchFields).toHaveBeenCalledWith({ visiblePropertyIds: ['p2', 'p3', 'p1'] })
  })

  it('ignores a drop on itself', async () => {
    const props = await mount()
    await act(async () => { dragColumn(1, 1) })
    expect(props.onPatchFields).not.toHaveBeenCalled()
  })
})
