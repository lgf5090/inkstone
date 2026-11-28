import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle, ProjectCard } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { navigateToAddress } from '../../lib/app-history'
import { ApiError } from '../../lib/api'
import { localDb } from '../../lib/db'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useAssistant } from '../chat/assistant-store'
import { BoardPage } from './BoardPage'
import { resetProjectSubscriptionCache } from './use-watch'
import * as api from './api'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchProjectBoardBundle: vi.fn(),
  fetchProjectBoardCards: vi.fn(),
  fetchProjectCard: vi.fn(),
  patchProjectCard: vi.fn(),
  patchProjectBoard: vi.fn(),
  batchPatchProjectBoard: vi.fn().mockResolvedValue(undefined),
  createProjectView: vi.fn(),
  deleteProjectView: vi.fn().mockResolvedValue(undefined),
  undeleteProjectView: vi.fn().mockResolvedValue(undefined),
  deleteProjectCard: vi.fn().mockResolvedValue(undefined),
  undeleteProjectCard: vi.fn().mockResolvedValue(undefined),
  duplicateProjectCard: vi.fn(),
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

  it('opens a cached board read-only when the network is offline', async () => {
    const cache = vi.spyOn(localDb, 'getProjectBoardCache').mockResolvedValue({ bundle: bundle(), loadedCursors: [], savedAt: 1 })
    vi.mocked(api.fetchProjectBoardBundle).mockRejectedValue(new ApiError(0, 'offline', 'offline'))
    try {
      await mount()
      expect(view.container.textContent).toContain(t('project.offline.cached_title'))
      expect(view.container.textContent).toContain('Roadmap')
      const add = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent.includes(t('project.board.new_card')))
      expect(add).toBeUndefined()
    } finally {
      cache.mockRestore()
    }
  })

  it('does not expose a cached board after the server says it is gone', async () => {
    const cache = vi.spyOn(localDb, 'getProjectBoardCache').mockResolvedValue({ bundle: bundle(), loadedCursors: [], savedAt: 1 })
    vi.mocked(api.fetchProjectBoardBundle).mockRejectedValue(new ApiError(404, 'not_found', 'Board not found'))
    try {
      await mount()
      expect(view.container.textContent).toContain(t('project.board.not_found'))
      expect(view.container.textContent).not.toContain(t('project.offline.cached_title'))
    } finally {
      cache.mockRestore()
    }
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

describe('board card pagination', () => {
  it('loads the next page on demand and merges it without duplicating cards', async () => {
    const first = bundle()
    first.cardCount = 2
    first.cardsHasMore = true
    first.cardsNextCursor = 'next-page'
    const secondCard: ProjectCard = { ...first.cards[0]!, id: 'c2', title: 'Beta' }
    vi.mocked(api.fetchProjectBoardBundle).mockResolvedValue(first)
    vi.mocked(api.fetchProjectBoardCards).mockResolvedValue({
      ...first, cards: [...first.cards, secondCard], cardsHasMore: false, cardsNextCursor: undefined,
    })
    await mount()
    expect(view.container.textContent).toContain(t('project.board.cards_loaded', { loaded: 1, total: 2 }))
    await act(async () => { [...view.container.querySelectorAll('button')].find((button) => button.textContent === t('project.board.load_more'))!.click() })
    expect(api.fetchProjectBoardCards).toHaveBeenCalledWith(BOARD_ID, 'next-page')
    expect(view.container.textContent).toContain(t('project.board.cards_count', { count: 2 }))
    expect(view.container.textContent).toContain('Beta')
  })

  it('fetches a deep-linked card that is outside the first bundle page', async () => {
    const linked: ProjectCard = { ...bundle().cards[0]!, id: 'c2', title: 'Deep linked' }
    vi.mocked(api.fetchProjectCard).mockResolvedValue(linked)
    navigateToAddress(`/project/boards/${BOARD_ID}`, 'card=c2')
    await mount()
    expect(api.fetchProjectCard).toHaveBeenCalledWith(BOARD_ID, 'c2')
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Deep linked'))
  })
})

describe('keyboard commands', () => {
  it('redoes an added view by restoring the same id instead of creating a duplicate', async () => {
    const created = { id: 'v3', boardId: BOARD_ID, title: 'Dashboard', viewType: 'dashboard' as const, fields: emptyProjectViewFields(), position: 2, ...stamps }
    vi.mocked(api.createProjectView).mockResolvedValue(created)
    await mount()
    await act(async () => { view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.view.add')}"]`)!.click() })
    await act(async () => { [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')].find((button) => button.textContent === t('project.view.dashboard'))!.click() })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })) })
    expect(api.deleteProjectView).toHaveBeenCalledWith('v3')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true })) })
    expect(api.undeleteProjectView).toHaveBeenCalledWith('v3')
    expect(api.createProjectView).toHaveBeenCalledTimes(1)
  })

  it('does not push an old board card edit into the new board undo stack', async () => {
    const nextBoardId = 'c'.repeat(27)
    vi.mocked(api.fetchProjectBoardBundle).mockImplementation(async (boardId) => {
      const next = bundle()
      next.board.id = boardId
      if (boardId === nextBoardId) {
        next.board.title = 'New board'
        next.cards = next.cards.map((card) => ({ ...card, boardId, title: 'New card' }))
      }
      return next
    })
    let resolvePatch!: (value: ProjectBoardBundle['cards'][number]) => void
    const pending = new Promise<ProjectBoardBundle['cards'][number]>((resolve) => { resolvePatch = resolve })
    vi.mocked(api.patchProjectCard).mockReturnValueOnce(pending)
    await mount()
    await act(async () => { navigateToAddress(`/project/boards/${BOARD_ID}`, 'card=c1') })
    const title = document.body.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${t('project.board.title_column')}"]`)!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(title, 'Old renamed'); title.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    await act(async () => { view.rerender(createElement(BoardPage, { boardId: nextBoardId })) })
    await act(async () => { resolvePatch({ ...bundle().cards[0]!, title: 'Old renamed' }); await pending })
    expect(document.body.textContent).toContain('New board')
    expect(document.body.textContent).not.toContain('Old renamed')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })) })
    expect(api.patchProjectCard).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed undo available for a second attempt', async () => {
    const previous = bundle().cards[0]!
    const updated = { ...previous, title: 'Renamed', updateAt: 100 }
    vi.mocked(api.patchProjectCard).mockResolvedValueOnce(updated)
    await mount()
    await act(async () => { navigateToAddress(`/project/boards/${BOARD_ID}`, 'card=c1') })
    const title = document.body.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${t('project.board.title_column')}"]`)!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(title, 'Renamed'); title.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    vi.mocked(api.patchProjectCard).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(previous)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })) })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })) })
    expect(api.patchProjectCard).toHaveBeenCalledTimes(3)
    expect(api.patchProjectCard).toHaveBeenLastCalledWith('c1', expect.objectContaining({ title: 'Alpha' }))
  })

  it('clears a newly added property value when undo restores a card that had none', async () => {
    const base = bundle()
    const previous = base.cards[0]!
    vi.mocked(api.fetchProjectBoardBundle).mockResolvedValue({
      ...base,
      properties: [...base.properties, { id: 'pt', name: 'Notes', type: 'text', options: [] }],
    })
    const updated = { ...previous, values: { ...previous.values, pt: 'new' }, updateAt: 100 }
    vi.mocked(api.patchProjectCard).mockResolvedValueOnce(updated)
    await mount()
    await act(async () => { navigateToAddress(`/project/boards/${BOARD_ID}`, 'card=c1') })
    const notes = document.body.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="Notes"]`)!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(notes, 'new'); notes.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { notes.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    vi.mocked(api.patchProjectCard).mockResolvedValueOnce(previous)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })) })
    expect(api.patchProjectCard).toHaveBeenLastCalledWith('c1', expect.objectContaining({ values: { ps: 'o1', pt: null } }))
  })

  it('undoes a newly added property by deleting it with the next property revision', async () => {
    vi.mocked(api.patchProjectBoard).mockImplementation(async (_boardId, patch) => ({
      board: bundle().board,
      properties: patch.updatedCardProperties ?? [],
      propertyRevision: 2,
    }))
    await mount()
    await act(async () => { view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.props.title')}"]`)!.click() })
    const dialog = document.body.querySelector('[role="dialog"]')!
    const name = dialog.querySelector<HTMLInputElement>(`input[placeholder="${t('project.props.name')}"]`)!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(name, 'Priority'); name.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === t('project.props.add'))!.click() })
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === t('common.save'))!.click() })
    const firstPatch = vi.mocked(api.patchProjectBoard).mock.calls[0]![1]
    const addedId = (firstPatch.updatedCardProperties ?? []).find((property) => property.name === 'Priority')!.id
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })) })
    expect(api.patchProjectBoard).toHaveBeenCalledTimes(2)
    expect(api.patchProjectBoard).toHaveBeenLastCalledWith(BOARD_ID, expect.objectContaining({
      propertyRevision: 2,
      deletedCardProperties: [addedId],
      updatedCardProperties: [expect.objectContaining({ id: 'ps' })],
    }))
  })

  it('restores deleted property values after undoing the property definition', async () => {
    vi.mocked(api.patchProjectBoard).mockImplementation(async (_boardId, patch) => ({
      board: bundle().board,
      properties: patch.updatedCardProperties ?? [],
      propertyRevision: 2,
    }))
    await mount()
    await act(async () => { view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.props.title')}"]`)!.click() })
    const dialog = document.body.querySelector('[role="dialog"]')!
    const statusRow = [...dialog.querySelectorAll('input')].find((input) => input.getAttribute('aria-label') === t('project.props.name'))!.closest('.space-y-2')!
    await act(async () => { statusRow.querySelector<HTMLButtonElement>(`button[aria-label="${t('common.delete')}"]`)!.click() })
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === t('common.save'))!.click() })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })) })
    expect(api.batchPatchProjectBoard).toHaveBeenCalledWith(BOARD_ID, {
      cards: [
        { id: 'c1', patch: { values: { ps: 'o1' } } },
      ],
    })
  })

  it('does not delete from an open dialog and clears a stale card id without requesting', async () => {
    vi.mocked(api.deleteProjectCard).mockClear()
    await mount()
    await act(async () => { navigateToAddress(`/project/boards/${BOARD_ID}`, 'card=c1') })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
    expect(api.deleteProjectCard).not.toHaveBeenCalled()
    await act(async () => { navigateToAddress(`/project/boards/${BOARD_ID}`, 'card=missing') })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
    expect(api.deleteProjectCard).not.toHaveBeenCalled()
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
