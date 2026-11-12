import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardSummary } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import * as api from './api'
import { useProjectStore } from './store'
import { ProjectApp } from './ProjectApp'

vi.mock('./api', () => ({
  fetchProjectBoards: vi.fn(),
  createProjectBoard: vi.fn(),
  deleteProjectBoard: vi.fn(),
  duplicateProjectBoard: vi.fn(),
  renameProjectBoard: vi.fn(),
  fetchProjectBoardBundle: vi.fn(),
  createProjectCard: vi.fn(),
  deleteProjectCard: vi.fn(),
  patchProjectCard: vi.fn(),
  patchProjectBoard: vi.fn(),
  projectBoardExportUrl: vi.fn((id: string, format: string) => `/export/${id}.${format}`),
  saveBoardAsTemplate: vi.fn(),
  createBoardFromTemplate: vi.fn(),
  fetchProjectCategories: vi.fn().mockResolvedValue({ categories: [], categoryBoards: [] }),
}))

const board: ProjectBoardSummary = {
  id: 'b'.repeat(27),
  ownerId: 'alice',
  type: 'P',
  minimumRole: '',
  title: 'A board',
  description: '',
  icon: '',
  showDescription: false,
  isTemplate: false,
  templateVersion: 0,
  createdBy: 'alice',
  modifiedBy: 'alice',
  createAt: 1,
  updateAt: 1,
  deleteAt: 0,
  role: 'admin',
}

let view: RenderedElement

async function mount(): Promise<void> {
  await act(async () => { view = renderElement(createElement(ProjectApp)) })
}

function rows(): HTMLElement[] {
  return [...view.container.querySelectorAll<HTMLElement>('[data-project-board]')]
}

function text(): string {
  return view.container.textContent ?? ''
}

beforeEach(async () => {
  vi.clearAllMocks()
  useProjectStore.setState({ boards: [], boardsStatus: 'idle', boardsError: null })
  await initI18n()
})

afterEach(() => {
  view?.unmount()
})

describe('the project container', () => {
  it('says the list is empty when the server lists nothing', async () => {
    vi.mocked(api.fetchProjectBoards).mockResolvedValue([])
    await mount()
    expect(text()).toContain(t('project.boards.empty_title'))
    expect(text()).toContain(t('project.boards.count', { count: 0 }))
    expect(rows()).toHaveLength(0)
  })

  it('names every board and the role this account holds on it', async () => {
    vi.mocked(api.fetchProjectBoards).mockResolvedValue([board, { ...board, id: 'c'.repeat(27), title: '', role: 'viewer' }])
    await mount()
    expect(rows().map((row) => row.dataset.projectBoard)).toEqual([board.id, 'c'.repeat(27)])
    expect(text()).toContain('A board')
    expect(text()).toContain(t('project.boards.untitled'))
    expect(text()).toContain(t('project.role.admin'))
    expect(text()).toContain(t('project.role.viewer'))
  })

  it('holds the loading state until the read settles', async () => {
    let settle: (boards: ProjectBoardSummary[]) => void = () => {}
    vi.mocked(api.fetchProjectBoards).mockReturnValue(new Promise((resolve) => { settle = resolve }))
    await mount()
    expect(view.container.querySelector('[role="status"]')).not.toBeNull()
    expect(rows()).toHaveLength(0)
    await act(async () => { settle([board]) })
    expect(view.container.querySelector('[role="status"]')).toBeNull()
    expect(rows()).toHaveLength(1)
  })

  it('offers a retry that reads again after a failed read', async () => {
    vi.mocked(api.fetchProjectBoards).mockRejectedValueOnce(new Error('the read failed')).mockResolvedValue([board])
    await mount()
    expect(text()).toContain(t('project.boards.load_failed'))
    expect(text()).toContain('the read failed')
    const retry = [...view.container.querySelectorAll('button')].find((button) => button.textContent === t('common.retry'))
    expect(retry).toBeDefined()
    await act(async () => { retry?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(api.fetchProjectBoards).toHaveBeenCalledTimes(2)
    expect(rows()).toHaveLength(1)
    expect(text()).not.toContain(t('project.boards.load_failed'))
  })
})
describe('the board list card view', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { localStorage.clear() })

  async function mountList(): Promise<void> {
    useProjectStore.setState({ boards: [{ ...board, description: 'what this board is for', cardCount: 7 }], boardsStatus: 'ready', boardsError: null })
    await act(async () => { view = renderElement(createElement(ProjectApp)) })
  }

  it('starts as rows and switches to tiles that carry the board metadata', async () => {
    await mountList()
    expect(view.container.querySelector('[data-board-cards]')).toBeNull()
    expect(view.container.querySelector('li[data-project-board]')).not.toBeNull()
    const cards = [...view.container.querySelectorAll<HTMLButtonElement>('.pv-seg-btn')].find((button) => button.textContent === t('project.boards.layout_cards'))!
    await act(async () => { cards.click() })
    const tile = view.container.querySelector('[data-board-cards] [data-project-board]')!
    expect(tile).not.toBeNull()
    expect(tile.textContent).toContain('A board')
    expect(tile.textContent).toContain('what this board is for')
    expect(tile.textContent).toContain(t('project.board.cards_count', { count: 7 }))
    expect(view.container.querySelector('li[data-project-board]')).toBeNull()
  })

  it('remembers the choice across a remount', async () => {
    await mountList()
    const cards = [...view.container.querySelectorAll<HTMLButtonElement>('.pv-seg-btn')].find((button) => button.textContent === t('project.boards.layout_cards'))!
    await act(async () => { cards.click() })
    view.unmount()
    await mountList()
    expect(view.container.querySelector('[data-board-cards]')).not.toBeNull()
  })

  it('offers rename on a right click in either shape', async () => {
    await mountList()
    const row = view.container.querySelector('li[data-project-board]')!
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
    expect([...document.querySelectorAll('[role^="menuitem"]')].map((node) => node.textContent)).toContain(t('project.boards.rename'))
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    const cards = [...view.container.querySelectorAll<HTMLButtonElement>('.pv-seg-btn')].find((button) => button.textContent === t('project.boards.layout_cards'))!
    await act(async () => { cards.click() })
    const tile = view.container.querySelector('[data-board-cards] [data-project-board]')!
    await act(async () => { tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
    const labels = [...document.querySelectorAll('[role^="menuitem"]')].map((node) => node.textContent)
    expect(labels).toContain(t('project.boards.rename'))
    expect(labels).toContain(t('project.sidebar.pin'))
    expect(labels).toContain(t('project.sidebar.export_csv'))
  })

  it('gives each board a stable plate colour of its own', async () => {
    useProjectStore.setState({
      boards: [{ ...board, id: 'a'.repeat(27) }, { ...board, id: 'b'.repeat(27) }, { ...board, id: 'c'.repeat(27) }],
      boardsStatus: 'ready', boardsError: null,
    })
    localStorage.setItem('inkstone.project.boardListLayout', 'cards')
    await act(async () => { view = renderElement(createElement(ProjectApp)) })
    const tints = [...view.container.querySelectorAll('.pv-tile-placeholder')].map((node) => (node as HTMLElement).style.getPropertyValue('--pv-card-color'))
    expect(tints.every((tint) => tint.startsWith('var(--kanban-tag-'))).toBe(true)
    expect(new Set(tints).size).toBeGreaterThan(1)
  })
})
