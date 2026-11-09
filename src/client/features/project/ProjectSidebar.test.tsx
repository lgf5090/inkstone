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
  reorderProjectCategories: vi.fn(),
  reorderCategoryBoards: vi.fn(),
}))

const stamps = { ownerId: 'u1', type: 'P' as const, minimumRole: '' as const, description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0, role: 'admin' as const }
const boards: ProjectBoardSummary[] = [
  { id: 'b1', title: 'Filed board', ...stamps },
  { id: 'b2', title: 'Loose board', ...stamps },
]

let view: RenderedElement
beforeEach(async () => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.fetchProjectCategories).mockResolvedValue({
    categories: [{ id: 'cat1', userId: 'u1', name: 'Work', type: 'custom', collapsed: false, sortOrder: 0, createAt: 1, updateAt: 1, deleteAt: 0 }],
    categoryBoards: [{ categoryId: 'cat1', boardId: 'b1', hidden: false, position: 0 }],
  })
  await initI18n()
})
afterEach(() => { view?.unmount() })

async function mount() {
  await act(async () => { view = renderElement(createElement(ProjectSidebar, { boards, onImport: vi.fn() })) })
}

describe('sidebar drag reorder (E-1/A-12)', () => {
  it('dropping a board on another persists the new category order', async () => {
    vi.mocked(api.fetchProjectCategories).mockResolvedValue({
      categories: [{ id: 'cat1', userId: 'u1', name: 'Work', type: 'custom', collapsed: false, sortOrder: 0, createAt: 1, updateAt: 1, deleteAt: 0 }],
      categoryBoards: [{ categoryId: 'cat1', boardId: 'b1', hidden: false, position: 0 }, { categoryId: 'cat1', boardId: 'b2', hidden: false, position: 1 }],
    })
    vi.mocked(api.reorderCategoryBoards).mockResolvedValue(undefined)
    await mount()
    const target = document.body.querySelector('[data-sidebar-board="b1"]')!
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'], getData: () => 'board:b2' } })
    await act(async () => { target.dispatchEvent(event) })
    expect(api.reorderCategoryBoards).toHaveBeenCalledWith('cat1', ['b2', 'b1'])
  })
})

describe('sidebar settings menu (E-7)', () => {
  afterEach(() => { localStorage.clear() })

  it('offers import/export/language/theme/random-icon and toggles the random-icon pref', async () => {
    await mount()
    const gear = document.body.querySelector(`button[aria-label="${t('project.sidebar.settings')}"]`) as HTMLButtonElement
    expect(gear).not.toBeNull()
    await act(async () => { gear.click() })
    const labels = [...document.body.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent ?? '')
    expect(labels.some((label) => label.startsWith(t('project.sidebar.import_archive')))).toBe(true)
    expect(labels.some((label) => label.startsWith(t('project.sidebar.export_archive')))).toBe(true)
    expect(labels.some((label) => label.startsWith(t('project.sidebar.language')))).toBe(true)
    expect(labels.some((label) => label.startsWith(t('project.sidebar.theme')))).toBe(true)
    const randomItem = [...document.body.querySelectorAll('[role="menuitem"]')].find((entry) => (entry.textContent ?? '').startsWith(t('project.sidebar.random_icon'))) as HTMLButtonElement
    await act(async () => { randomItem.click() })
    expect(localStorage.getItem('inkstone.project.randomIcon')).toBe('1')
  })
})

describe('find-board keyboard navigation (E-8)', () => {
  it('ArrowDown highlights the first match and Escape clears the query', async () => {
    await mount()
    const input = document.body.querySelector(`input[aria-label="${t('project.sidebar.search')}"]`) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'board'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    expect(document.body.querySelector('[data-sidebar-board="b1"] button')!.className).toContain('ring-2')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(input.value).toBe('')
    expect(document.body.querySelector('[data-sidebar-board="b1"] button')!.className).not.toContain('ring-2')
  })
})

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

  it('renders pinned and favorites sections when preferences are present', async () => {
    localStorage.setItem('inkstone.project.pinnedBoards', JSON.stringify(['b1']))
    localStorage.setItem('inkstone.project.starredBoards', JSON.stringify(['b2']))
    await mount()
    const text = view.container.textContent ?? ''
    expect(text).toContain(t('project.sidebar.pinned'))
    expect(text).toContain(t('project.sidebar.favorites'))
  })

  it('builds multi-level categories for slash-separated names', async () => {
    vi.mocked(api.fetchProjectCategories).mockResolvedValue({
      categories: [
        { id: 'cat1', userId: 'u1', name: 'Dev/Frontend', type: 'custom', collapsed: false, sortOrder: 0, createAt: 1, updateAt: 1, deleteAt: 0 },
        { id: 'cat2', userId: 'u1', name: 'Dev/Backend', type: 'custom', collapsed: false, sortOrder: 1, createAt: 1, updateAt: 1, deleteAt: 0 },
      ],
      categoryBoards: [
        { categoryId: 'cat1', boardId: 'b1', hidden: false, position: 0 },
        { categoryId: 'cat2', boardId: 'b2', hidden: false, position: 0 },
      ],
    })
    await mount()
    const text = view.container.textContent ?? ''
    expect(text).toContain('Dev')
    expect(text).toContain('Frontend')
    expect(text).toContain('Backend')
  })

  it('opens context menu on board right-click with pin and star actions', async () => {
    await mount()
    const boardEl = document.body.querySelector('[data-sidebar-board="b1"]')!
    const contextEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    })
    await act(async () => { boardEl.dispatchEvent(contextEvent) })
    const menuItems = [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '')
    expect(menuItems.some((item) => item.includes(t('project.sidebar.pin')))).toBe(true)
    expect(menuItems.some((item) => item.includes(t('project.sidebar.favorite')))).toBe(true)
  })
})