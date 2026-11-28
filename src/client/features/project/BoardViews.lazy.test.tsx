import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyProjectViewFields } from '@shared/project/model'
import { initI18n } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { BoardViews } from './BoardViews'

const gate = vi.hoisted(() => {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
})

vi.mock('./views/TableView', async () => {
  await gate.promise
  return { TableView: () => <div data-lazy-table="" /> }
})

let view: RenderedElement

beforeEach(async () => {
  await initI18n()
})

describe('lazy project views', () => {
  it('shows an accessible loading state until the selected view chunk resolves', async () => {
    const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
    const bundle = {
      board: { id: 'b1', ownerId: 'u1', type: 'P' as const, minimumRole: '' as const, title: 'Board', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, archived: false, ...stamps },
      properties: [], cards: [{ id: 'c1', boardId: 'b1', parentId: '', title: 'Card', icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps }], contents: [], comments: [], members: [], people: {}, role: 'admin' as const, cursor: 1, propertyRevision: 1,
      views: [{ id: 'v1', boardId: 'b1', title: 'Table', viewType: 'table' as const, fields: emptyProjectViewFields(), position: 0, ...stamps }],
    }
    await act(async () => {
      view = renderElement(createElement(BoardViews, {
        bundle, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(),
        onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(),
        onPatchCard: vi.fn(), onAddGroupOption: vi.fn(), onRenameGroupOption: vi.fn(), onSetGroupOptionColor: vi.fn(),
        onCardCreated: vi.fn(), onRefresh: vi.fn(),
      }))
    })
    expect(view.container.querySelector('[role="status"]'), view.container.innerHTML).not.toBeNull()
    await act(async () => {
      gate.release()
      await gate.promise
    })
    expect(view.container.querySelector('[data-lazy-table]')).not.toBeNull()
    view.unmount()
  })
})
