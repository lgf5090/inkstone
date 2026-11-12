import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardSummary } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import * as api from './api'
import { ProjectSidebar } from './ProjectSidebar'
import { useProjectStore } from './store'
import { confirm } from '../../components/overlay'

vi.mock('../../components/overlay', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../components/overlay')>(),
  confirm: vi.fn(),
}))

vi.mock('./api', () => ({
  fetchProjectCategories: vi.fn(),
  createProjectCategory: vi.fn(),
  patchProjectCategory: vi.fn(),
  deleteProjectCategory: vi.fn(),
  addBoardToCategory: vi.fn(),
  setCategoryBoardHidden: vi.fn(),
  reorderProjectCategories: vi.fn(),
  reorderCategoryBoards: vi.fn(),
  renameProjectBoard: vi.fn(),
  patchProjectBoard: vi.fn(),
  projectBoardExportUrl: vi.fn((id: string, format: string) => `/export/${id}.${format}`),
}))

const stamps = { ownerId: 'u1', type: 'P' as const, minimumRole: '' as const, description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0, role: 'admin' as const }
const boards: ProjectBoardSummary[] = [
  { id: 'b1', title: 'Filed board', cardCount: 7, ...stamps },
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

function rows(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-sidebar-drop]')]
}

async function dragRow(source: string, target: string, releaseOffset = 14, pointerType = 'mouse'): Promise<void> {
  const all = rows()
  // jsdom lays nothing out, so the drag reads the bands a real sidebar would report.
  all.forEach((node, index) => {
    node.getBoundingClientRect = () => ({ left: 0, right: 240, top: index * 30, bottom: index * 30 + 28, width: 240, height: 28, x: 0, y: index * 30, toJSON: () => ({}) })
  })
  const grips = [...document.body.querySelectorAll<HTMLElement>(`[data-sidebar-grip="${source}"]`)]
  const grip = grips[grips.length - 1]!
  const targetIndex = all.findIndex((node) => node.dataset.sidebarDrop === target)
  const fire = (type: string, y: number, eventTarget: EventTarget = window): void => {
    eventTarget.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: y, button: 0, pointerId: 1, pointerType }))
  }
  await act(async () => { fire('pointerdown', 10, grip) })
  if (pointerType === 'touch') await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)) })
  await act(async () => { fire('pointermove', targetIndex * 30 + releaseOffset) })
  await act(async () => { fire('pointerup', targetIndex * 30 + releaseOffset) })
}


describe('sidebar drag reorder (E-1/A-12)', () => {
  it('dropping a board on another persists the new category order', async () => {
    vi.mocked(api.fetchProjectCategories).mockResolvedValue({
      categories: [{ id: 'cat1', userId: 'u1', name: 'Work', type: 'custom', collapsed: false, sortOrder: 0, createAt: 1, updateAt: 1, deleteAt: 0 }],
      categoryBoards: [{ categoryId: 'cat1', boardId: 'b1', hidden: false, position: 0 }, { categoryId: 'cat1', boardId: 'b2', hidden: false, position: 1 }],
    })
    vi.mocked(api.reorderCategoryBoards).mockResolvedValue(undefined)
    await mount()
    await dragRow('board:b2', 'board:b1')
    expect(api.reorderCategoryBoards).toHaveBeenCalledWith('cat1', ['b2', 'b1'])
  })

  it('a finger held on a board grip files it into the folder it is released on', async () => {
    vi.mocked(api.addBoardToCategory).mockResolvedValue({ categoryId: 'cat1', boardId: 'b2', hidden: false, position: 1 })
    await mount()
    await dragRow('board:b2', 'category:cat1', 14, 'touch')
    expect(api.addBoardToCategory).toHaveBeenCalledWith('cat1', 'b2')
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
    expect(document.body.querySelector('[data-sidebar-board="b1"] button:not([data-sidebar-grip])')!.className).toContain('ring-2')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(input.value).toBe('')
    expect(document.body.querySelector('[data-sidebar-board="b1"] button:not([data-sidebar-grip])')!.className).not.toContain('ring-2')
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

  it('opens category menu with new subcategory, rename and delete on more button click', async () => {
    await mount()
    const moreBtn = view.container.querySelector('button[aria-label="Work"]') as HTMLButtonElement
    expect(moreBtn).not.toBeNull()
    await act(async () => { moreBtn.click() })
    const menuItems = [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '')
    expect(menuItems.some((item) => item.includes(t('project.sidebar.new_subcategory')))).toBe(true)
    expect(menuItems.some((item) => item.includes(t('project.boards.rename')))).toBe(true)
    expect(menuItems.some((item) => item.includes(t('common.delete')))).toBe(true)
  })
})
describe('dropping onto a category (R3-8)', () => {
  it('files a loose board into the category it was dropped on', async () => {
    vi.mocked(api.addBoardToCategory).mockResolvedValue({ categoryId: 'cat1', boardId: 'b2', hidden: false, position: 1 })
    await mount()
    await dragRow('board:b2', 'category:cat1')
    expect(api.addBoardToCategory).toHaveBeenCalledWith('cat1', 'b2')
  })

  it('does not re-file a board already in that category', async () => {
    await mount()
    await dragRow('board:b1', 'category:cat1')
    expect(api.addBoardToCategory).not.toHaveBeenCalled()
  })
})

describe('dragging a category onto another', () => {
  async function mountTwo(): Promise<void> {
    vi.mocked(api.fetchProjectCategories).mockResolvedValue({
      categories: [
        { id: 'cat1', userId: 'u1', name: 'Work', type: 'custom', collapsed: false, sortOrder: 0, createAt: 1, updateAt: 1, deleteAt: 0 },
        { id: 'cat2', userId: 'u1', name: 'Home', type: 'custom', collapsed: false, sortOrder: 1, createAt: 1, updateAt: 1, deleteAt: 0 },
      ],
      categoryBoards: [],
    })
    await mount()
  }

  it('releasing on the middle nests the dragged folder under the target', async () => {
    vi.mocked(api.patchProjectCategory).mockResolvedValue(undefined as never)
    await mountTwo()
    await dragRow('category:cat2', 'category:cat1', 14)
    expect(api.patchProjectCategory).toHaveBeenCalledWith('cat2', { name: 'Work/Home' })
    expect(api.reorderProjectCategories).not.toHaveBeenCalled()
  })

  it('releasing on the top edge places the dragged folder before the target', async () => {
    vi.mocked(api.reorderProjectCategories).mockResolvedValue(undefined)
    await mountTwo()
    await dragRow('category:cat2', 'category:cat1', 2)
    expect(api.reorderProjectCategories).toHaveBeenCalledWith(['cat2', 'cat1'])
    expect(api.patchProjectCategory).not.toHaveBeenCalled()
  })
})

describe('the rebuilt sidebar (R4-4)', () => {
  it('offers a full-width new-board action rather than a cramped icon', async () => {
    await mount()
    const aside = document.body.querySelector('aside')!
    const create = [...aside.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === t('project.sidebar.new_board'))
    expect(create, 'no labelled new-board action').toBeDefined()
    expect(create!.className).toContain('w-full')
    expect(create!.className).toContain('border-dashed')
  })

  it('shows each board card count from the list projection', async () => {
    await mount()
    const row = document.body.querySelector('[data-sidebar-board="b1"]')!
    expect(row.textContent).toContain('7')
    expect(row.querySelector(`[aria-label="${t('project.board.cards_count', { count: 7 })}"]`)).not.toBeNull()
  })
})

describe('the nested tree reads as a tree', () => {
  it('indents a board one level deeper than the folder holding it', async () => {
    vi.mocked(api.fetchProjectCategories).mockResolvedValue({
      categories: [
        { id: 'cat1', userId: 'u1', name: 'Work', type: 'custom', collapsed: false, sortOrder: 0, createAt: 1, updateAt: 1, deleteAt: 0 },
        { id: 'cat2', userId: 'u1', name: 'Work/Release', type: 'custom', collapsed: false, sortOrder: 1, createAt: 1, updateAt: 1, deleteAt: 0 },
      ],
      categoryBoards: [{ categoryId: 'cat2', boardId: 'b1', hidden: false, position: 0 }],
    })
    await mount()
    // The board also appears under "recently edited"; the filed copy is the one inside the tree.
    const copies = [...view.container.querySelectorAll('[data-sidebar-board="b1"]')]
    const filed = copies.map((node) => (node.parentElement as HTMLElement).style.paddingLeft).filter(Boolean)
    expect(filed).toEqual(['28px'])
    const headers = [...view.container.querySelectorAll('section > div[style]')].map((node) => (node as HTMLElement).style.paddingLeft)
    expect(headers).toEqual(['0px', '14px'])
  })

  it('offers rename, icon and the export pair on a board right click', async () => {
    await mount()
    const entry = view.container.querySelector('[data-sidebar-board="b2"]')!
    await act(async () => { entry.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
    const labels = [...document.querySelectorAll('[role^="menuitem"]')].map((node) => node.textContent)
    expect(labels).toContain(t('project.boards.rename'))
    expect(labels).toContain(t('project.sidebar.change_icon'))
    expect(labels).toContain(t('project.sidebar.export_csv'))
    expect(labels).toContain(t('project.sidebar.export_archive'))
    expect(labels).toContain(t('project.sidebar.move_to_folder'))
  })

  it('lists the recently edited boards above the tree', async () => {
    await mount()
    const headings = [...view.container.querySelectorAll('section > div')].map((node) => node.textContent)
    expect(headings.some((text) => text === t('project.sidebar.recent'))).toBe(true)
  })
})

describe('the sidebar keeps up with the address and with deletions', () => {
  it('highlights the board the address names, not one read at mount', async () => {
    window.history.replaceState({}, '', '/project/boards/b1')
    await mount()
    const active = () => [...view.container.querySelectorAll('[data-sidebar-board] [aria-current="true"]')]
      .map((node) => node.closest('[data-sidebar-board]')!.getAttribute('data-sidebar-board'))
    expect(active()).toContain('b1')
    await act(async () => {
      window.history.replaceState({}, '', '/project/boards/b2')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(active()).toContain('b2')
    expect(active()).not.toContain('b1')
    window.history.replaceState({}, '', '/')
  })

  it('leaves the board it just deleted when that board is on screen', async () => {
    window.history.replaceState({}, '', '/project/boards/b2')
    const removeBoard = vi.fn().mockResolvedValue(undefined)
    useProjectStore.setState({ removeBoard })
    await mount()
    const entry = view.container.querySelector('[data-sidebar-board="b2"]')!
    await act(async () => { entry.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
    vi.mocked(confirm).mockResolvedValue(true)
    const del = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((node) => node.textContent === t('common.delete'))!
    await act(async () => { del.click() })
    expect(removeBoard).toHaveBeenCalledWith('b2')
    expect(window.location.pathname).toBe('/project')
    window.history.replaceState({}, '', '/')
  })
})
