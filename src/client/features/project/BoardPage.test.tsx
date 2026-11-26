import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { navigateToAddress } from '../../lib/app-history'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useAssistant } from '../chat/assistant-store'
import { BoardPage } from './BoardPage'
import { resetProjectSubscriptionCache } from './use-watch'
import * as api from './api'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchProjectBoardBundle: vi.fn(),
  patchProjectCard: vi.fn(),
  fetchBoardLinks: vi.fn().mockResolvedValue([]),
  fetchBoardCursor: vi.fn(),
  fetchBoardActivity: vi.fn(),
  fetchProjectBoards: vi.fn().mockResolvedValue([]),
}))

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const BOARD_ID = 'b'.repeat(27)

function bundle(): ProjectBoardBundle {
  return {
    board: { id: BOARD_ID, ownerId: 'u1', type: 'P', minimumRole: '', title: 'Roadmap', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, archived: false, ...stamps },
    properties: [{ id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }] }],
    views: [
      { id: 'v1', boardId: BOARD_ID, title: 'Table', viewType: 'table', fields: emptyProjectViewFields(), position: 0, ...stamps },
      { id: 'v2', boardId: BOARD_ID, title: 'Board', viewType: 'board', fields: { ...emptyProjectViewFields(), groupById: 'ps' }, position: 1, ...stamps },
    ],
    cards: [{ id: 'c1', boardId: BOARD_ID, parentId: '', title: 'Alpha', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1' }, ...stamps }],
    contents: [], comments: [], members: [], people: {}, role: 'admin', cursor: 1, propertyRevision: 1,
  }
}

let view: RenderedElement

beforeEach(async () => {
  resetProjectSubscriptionCache()
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.fetchProjectBoardBundle).mockImplementation(async () => bundle())
  let tick = 1
  vi.mocked(api.fetchBoardCursor).mockImplementation(async () => { tick += 1; return tick })
  navigateToAddress(`/project/boards/${BOARD_ID}`)
  await initI18n()
})
afterEach(() => { view?.unmount(); vi.useRealTimers(); useAssistant.getState().setProjectContext(null) })

async function mount(): Promise<void> {
  await act(async () => { view = renderElement(createElement(BoardPage, { boardId: BOARD_ID })) })
}

function facts(): string[] {
  return useAssistant.getState().projectContext?.facts ?? []
}

describe('board read failures', () => {
  it('offers a direct retry for the initial board read', async () => {
    vi.mocked(api.fetchProjectBoardBundle).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await mount()
    expect(view.container.textContent).toContain(t('project.board.load_failed'))
    await act(async () => { [...view.container.querySelectorAll('button')].find((button) => button.textContent === t('project.common.retry'))!.click() })
    expect(api.fetchProjectBoardBundle).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).toContain('Roadmap')
  })

  it('ignores activity from the previous board after switching boards', async () => {
    const nextBoardId = 'c'.repeat(27)
    vi.mocked(api.fetchProjectBoardBundle).mockImplementation(async (boardId) => {
      const next = bundle()
      next.board.id = boardId
      return next
    })
    let resolveOld!: (entries: Awaited<ReturnType<typeof api.fetchBoardActivity>>) => void
    const oldRead = new Promise<Awaited<ReturnType<typeof api.fetchBoardActivity>>>((resolve) => { resolveOld = resolve })
    vi.mocked(api.fetchBoardActivity).mockReturnValueOnce(oldRead).mockResolvedValueOnce([
      { id: 'new', actorId: 'u1', type: 'custom', targetId: '', summary: 'New board activity', createdAt: 1 },
    ])
    await mount()
    await act(async () => { view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.board.activity')}"]`)!.click() })
    await act(async () => { view.rerender(createElement(BoardPage, { boardId: nextBoardId })) })
    await act(async () => { view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.board.activity')}"]`)!.click() })
    await act(async () => {
      resolveOld([{ id: 'old', actorId: 'u1', type: 'custom', targetId: '', summary: 'Old board activity', createdAt: 1 }])
      await oldRead
    })
    expect(document.body.textContent).toContain('New board activity')
    expect(document.body.textContent).not.toContain('Old board activity')
  })

  it('offers retry inside the activity dialog instead of a bare error', async () => {
    vi.mocked(api.fetchBoardActivity).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce([])
    await mount()
    await act(async () => { view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.board.activity')}"]`)!.click() })
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(t('project.boards.load_failed'))
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === t('project.common.retry'))!.click() })
    expect(api.fetchBoardActivity).toHaveBeenCalledTimes(2)
  })
})

describe('the board page assistant context (R3-9)', () => {
  it('keeps the active view facts after a background refetch instead of resetting to the first view', async () => {
    vi.useFakeTimers()
    await mount()
    expect(facts().some((fact) => fact.startsWith('grouped by:'))).toBe(false)
    const boardTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.includes(t('project.view.board')))
    expect(boardTab, 'no board view tab').toBeDefined()
    await act(async () => { boardTab!.click() })
    expect(facts()).toContain('grouped by: Status')
    const readsBefore = vi.mocked(api.fetchProjectBoardBundle).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(vi.mocked(api.fetchBoardCursor).mock.calls.length, 'the poll never asked the cursor').toBeGreaterThan(0)
    expect(vi.mocked(api.fetchProjectBoardBundle).mock.calls.length, 'a moved cursor never refetched').toBeGreaterThan(readsBefore)
    expect(facts()).toContain('grouped by: Status')
  })
})

describe('the card deep link (R3-13)', () => {
  it('opens the card named by ?card= and follows a later address change', async () => {
    await mount()
    expect(document.body.textContent).not.toContain('A public remark')
    await act(async () => { navigateToAddress(`/project/boards/${BOARD_ID}`, 'card=c1') })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog, 'the deep-linked card never opened').not.toBeNull()
    expect(dialog!.textContent).toContain('Alpha')
  })
})
describe('the convergence poll (R3-15)', () => {
  it('does not let a delayed visibility response overwrite a newer local card patch', async () => {
    vi.useFakeTimers()
    await mount()
    await act(async () => { navigateToAddress(`/project/boards/${BOARD_ID}`, 'card=c1') })
    let resolveOld!: (value: ProjectBoardBundle) => void
    const oldRead = new Promise<ProjectBoardBundle>((resolve) => { resolveOld = resolve })
    vi.mocked(api.fetchProjectBoardBundle).mockImplementationOnce(() => oldRead)
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    const updated = { ...bundle().cards[0]!, title: 'Local title', updateAt: 100 }
    vi.mocked(api.patchProjectCard).mockResolvedValue(updated)
    const title = document.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${t('project.board.title_column')}"]`)!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(title, 'Local title'); title.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(api.patchProjectCard).toHaveBeenCalledWith('c1', { title: 'Local title' })
    await act(async () => { resolveOld(bundle()); await oldRead })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Local title')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Alpha')
  })

  it('skips the whole-board read when the cursor has not moved', async () => {
    vi.useFakeTimers()
    vi.mocked(api.fetchBoardCursor).mockResolvedValue(1)
    await mount()
    const readsAfterMount = vi.mocked(api.fetchProjectBoardBundle).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(vi.mocked(api.fetchBoardCursor).mock.calls.length).toBeGreaterThan(1)
    expect(vi.mocked(api.fetchProjectBoardBundle).mock.calls.length).toBe(readsAfterMount)
  })
})
