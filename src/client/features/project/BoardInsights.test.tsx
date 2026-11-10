import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { projectDayToStamp } from '@shared/project/date'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CollectionView, DashboardView } from './BoardInsights'
import { BoardViews } from './BoardViews'
import * as api from './api'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchBoardActivity: vi.fn().mockResolvedValue([]),
  listBoardFiles: vi.fn().mockResolvedValue([]),
  fetchBoardLinks: vi.fn().mockResolvedValue([]),
}))

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }, { id: 'o2', value: 'Done', color: '' }] },
  { id: 'pd', name: 'Due', type: 'date', options: [] },
]
const dayOffset = (days: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); return projectDayToStamp(d) }
function card(id: string, status: string, due?: number): ProjectCard {
  const values: Record<string, string> = { ps: status }
  if (due !== undefined) values.pd = JSON.stringify({ from: due })
  return { id, boardId: 'b1', parentId: '', title: id, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

let view: RenderedElement
beforeEach(async () => { localStorage.clear(); vi.clearAllMocks(); vi.mocked(api.fetchBoardActivity).mockResolvedValue([]); vi.mocked(api.listBoardFiles).mockResolvedValue([]); await initI18n() })
afterEach(() => { view?.unmount() })

describe('the dashboard (R3-24)', () => {
  it('counts overdue, due-soon, unscheduled and completed from the cards it is handed', async () => {
    const cards = [card('late', 'o1', dayOffset(-3)), card('soon', 'o1', dayOffset(2)), card('nodate', 'o1'), card('finished', 'o2', dayOffset(-10))]
    await act(async () => { view = renderElement(createElement(DashboardView, { boardId: 'b1', cards, properties, onOpenCard: vi.fn() })) })
    const tiles = [...view.container.querySelectorAll('p')]
    const valueFor = (label: string) => tiles.find((p) => p.textContent === label)?.nextElementSibling?.textContent
    expect(valueFor(t('project.dashboard.total'))).toBe('4')
    expect(valueFor(t('project.dashboard.done'))).toBe('1')
    expect(valueFor(t('project.dashboard.overdue'))).toBe('1')
    expect(valueFor(t('project.dashboard.due_soon'))).toBe('1')
    expect(valueFor(t('project.dashboard.unscheduled'))).toBe('1')
    const overdue = view.container.querySelector(`[aria-label="${t('project.dashboard.overdue_list')}"]`)
    expect(overdue?.textContent).toContain('late')
    expect(overdue?.textContent).not.toContain('finished')
  })

  it('renders even with no cards rather than falling back to the empty placeholder', async () => {
    const bundle = {
      board: { id: 'b1', ownerId: 'u1', type: 'P' as const, minimumRole: '' as const, title: 'B', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, ...stamps },
      properties, views: [{ id: 'v1', boardId: 'b1', title: 'Dashboard', viewType: 'dashboard' as const, fields: emptyProjectViewFields(), position: 0, ...stamps }],
      cards: [], contents: [], comments: [], members: [], role: 'admin' as const, cursor: 1,
    }
    await act(async () => { view = renderElement(createElement(BoardViews, { bundle, canEdit: true, onDeleteCard: vi.fn(), onCreateView: vi.fn(), onOpenCard: vi.fn(), onPatchView: vi.fn(), onDeleteView: vi.fn(), onDuplicateView: vi.fn(), onActiveViewChange: vi.fn(), onPatchCard: vi.fn().mockResolvedValue(undefined), onAddGroupOption: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) })) })
    expect(view.container.querySelector('[data-project-dashboard]')).not.toBeNull()
  })
})

describe('the collection (R3-25)', () => {
  it('lists board files and narrows them by category', async () => {
    vi.mocked(api.listBoardFiles).mockResolvedValue([
      { id: 'i1', userId: 'u1', boardId: 'b1', cardId: null, filename: 'shot.png', mime: 'image/png', size: 2048, storage: 'r2', objectKey: 'k1', width: null, height: null, thumbnailKey: null, createdAt: 1, updatedAt: 1 },
      { id: 'i2', userId: 'u1', boardId: 'b1', cardId: 'c1', filename: 'spec.pdf', mime: 'application/pdf', size: 4096, storage: 'r2', objectKey: 'k2', width: null, height: null, thumbnailKey: null, createdAt: 1, updatedAt: 1 },
    ])
    await act(async () => { view = renderElement(createElement(CollectionView, { boardId: 'b1', canEdit: true, onOpenCard: vi.fn() })) })
    expect(view.container.textContent).toContain('shot.png')
    expect(view.container.textContent).toContain('spec.pdf')
    const pdf = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'pdf')
    await act(async () => { pdf!.click() })
    expect(view.container.textContent).toContain('spec.pdf')
    expect(view.container.textContent).not.toContain('shot.png')
  })

  it('says the board has no files instead of an empty list', async () => {
    await act(async () => { view = renderElement(createElement(CollectionView, { boardId: 'b1', canEdit: false, onOpenCard: vi.fn() })) })
    expect(view.container.textContent).toContain(t('project.collection.empty'))
    expect([...view.container.querySelectorAll('button')].some((button) => button.textContent === t('project.collection.upload'))).toBe(false)
  })
})
