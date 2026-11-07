import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardSummary } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import * as api from './api'
import { useProjectStore } from './store'
import { ProjectApp } from './ProjectApp'

vi.mock('./api', () => ({ fetchProjectBoards: vi.fn() }))

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
    const retry = view.container.querySelector('button')
    expect(retry?.textContent).toBe(t('common.retry'))
    await act(async () => { retry?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(api.fetchProjectBoards).toHaveBeenCalledTimes(2)
    expect(rows()).toHaveLength(1)
    expect(text()).not.toContain(t('project.boards.load_failed'))
  })
})