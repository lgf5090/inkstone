import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle, ProjectViewType } from '@shared/project/model'
import { emptyProjectViewFields, PROJECT_VIEW_TYPES } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { BoardViews } from './BoardViews'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }

function bundle(): ProjectBoardBundle {
  return {
    board: { id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title: 'B', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, ...stamps },
    properties: [
      { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }, { id: 'o2', value: 'Done', color: '' }] },
      { id: 'pt', name: 'Notes', type: 'text', options: [] },
    ],
    views: [
      { id: 'v1', boardId: 'b1', title: 'Table', viewType: 'table', fields: emptyProjectViewFields(), position: 0, ...stamps },
      { id: 'v2', boardId: 'b1', title: 'Board', viewType: 'board', fields: { ...emptyProjectViewFields(), groupById: 'ps' }, position: 1, ...stamps },
    ],
    cards: [
      { id: 'c1', boardId: 'b1', parentId: '', title: 'Alpha', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1', pt: 'hello' }, ...stamps },
      { id: 'c2', boardId: 'b1', parentId: '', title: 'Beta', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o2' }, ...stamps },
      { id: 'c3', boardId: 'b1', parentId: '', title: 'Gamma', icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps },
    ],
    contents: [], comments: [], members: [], role: 'admin', cursor: 1,
  }
}

let view: RenderedElement
async function mount(): Promise<void> {
  await act(async () => {
    view = renderElement(createElement(BoardViews, { bundle: bundle(), canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn() }))
  })
}
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount() })

describe('the table view', () => {
  it('renders a column per property and a row per card with display values', async () => {
    await mount()
    const headers = [...view.container.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(headers).toContain('Status')
    expect(headers).toContain('Notes')
    const rows = [...view.container.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('Alpha')
    expect(rows[0]!.textContent).toContain('Open')
    expect(rows[0]!.textContent).toContain('hello')
  })
})

describe('the board view', () => {
  it('groups cards into option columns plus a no-value column', async () => {
    await mount()
    const boardTab = [...view.container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Board')
    await act(async () => { boardTab?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    const columns = [...view.container.querySelectorAll('section')]
    const labels = columns.map((column) => column.getAttribute('aria-label'))
    expect(labels).toEqual(['Open', 'Done', t('project.view.no_value')])
    expect(columns[0]!.querySelectorAll('[data-project-card]')).toHaveLength(1)
    expect(columns[0]!.textContent).toContain('Alpha')
    expect(columns[2]!.textContent).toContain('Gamma')
  })
})

describe('view tab labels', () => {
  it('labels every untitled view tab with its own type, not the table fallback', async () => {
    const base = bundle()
    base.views = PROJECT_VIEW_TYPES.map((viewType: ProjectViewType, index) => ({
      id: `v${index}`, boardId: 'b1', title: '', viewType, fields: emptyProjectViewFields(), position: index, ...stamps,
    }))
    await act(async () => {
      view = renderElement(createElement(BoardViews, { bundle: base, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn() }))
    })
    const labels = [...view.container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
    expect(labels).toEqual(PROJECT_VIEW_TYPES.map((viewType) => t(`project.view.${viewType}` as Parameters<typeof t>[0])))
    expect(labels).toContain(t('project.view.list'))
    expect(labels).toContain(t('project.view.gantt'))
    for (const tab of view.container.querySelectorAll('[role="tab"]')) {
      expect(tab.className).toContain('whitespace-nowrap')
      expect(tab.className).toContain('shrink-0')
    }
    expect(view.container.querySelector('[role="tablist"]')!.className).toContain('overflow-x-auto')
  })
})