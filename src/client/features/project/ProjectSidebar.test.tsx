import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardSummary } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import * as api from './api'
import { ProjectSidebar } from './ProjectSidebar'

vi.mock('./api', () => ({
  fetchProjectCategories: vi.fn(),
  createProjectCategory: vi.fn(),
  patchProjectCategory: vi.fn(),
  deleteProjectCategory: vi.fn(),
  addBoardToCategory: vi.fn(),
  setCategoryBoardHidden: vi.fn(),
}))

const stamps = { ownerId: 'u1', type: 'P' as const, minimumRole: '' as const, description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0, role: 'admin' as const }
const boards: ProjectBoardSummary[] = [
  { id: 'b1', title: 'Filed board', ...stamps },
  { id: 'b2', title: 'Loose board', ...stamps },
]

let view: RenderedElement
beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(api.fetchProjectCategories).mockResolvedValue({
    categories: [{ id: 'cat1', userId: 'u1', name: 'Work', type: 'custom', collapsed: false, sortOrder: 0, createAt: 1, updateAt: 1, deleteAt: 0 }],
    categoryBoards: [{ categoryId: 'cat1', boardId: 'b1', hidden: false, position: 0 }],
  })
  await initI18n()
})
afterEach(() => { view?.unmount() })

async function mount() {
  await act(async () => { view = renderElement(createElement(ProjectSidebar, { boards })) })
}

describe('the project sidebar', () => {
  it('files boards under their category and leaves the rest unfiled', async () => {
    await mount()
    const text = view.container.textContent ?? ''
    expect(text).toContain('Work')
    expect(text).toContain('Filed board')
    expect(text).toContain(t('project.sidebar.unfiled'))
    expect(text).toContain('Loose board')
    const filed = view.container.querySelector('section [data-sidebar-board="b1"]')
    expect(filed).not.toBeNull()
  })

  it('filters boards by the search query', async () => {
    await mount()
    const input = view.container.querySelector(`input[placeholder="${t('project.sidebar.search')}"]`) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'loose'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    const text = view.container.textContent ?? ''
    expect(text).toContain('Loose board')
    expect(text).not.toContain('Filed board')
  })
})