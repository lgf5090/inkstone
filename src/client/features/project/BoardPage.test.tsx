import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { navigateToAddress } from '../../lib/app-history'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useAssistant } from '../chat/assistant-store'
import { BoardPage } from './BoardPage'
import * as api from './api'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchProjectBoardBundle: vi.fn(),
  fetchBoardLinks: vi.fn().mockResolvedValue([]),
  fetchProjectBoards: vi.fn().mockResolvedValue([]),
}))

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const BOARD_ID = 'b'.repeat(27)

function bundle(): ProjectBoardBundle {
  return {
    board: { id: BOARD_ID, ownerId: 'u1', type: 'P', minimumRole: '', title: 'Roadmap', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, ...stamps },
    properties: [{ id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }] }],
    views: [
      { id: 'v1', boardId: BOARD_ID, title: 'Table', viewType: 'table', fields: emptyProjectViewFields(), position: 0, ...stamps },
      { id: 'v2', boardId: BOARD_ID, title: 'Board', viewType: 'board', fields: { ...emptyProjectViewFields(), groupById: 'ps' }, position: 1, ...stamps },
    ],
    cards: [{ id: 'c1', boardId: BOARD_ID, parentId: '', title: 'Alpha', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1' }, ...stamps }],
    contents: [], comments: [], members: [], role: 'admin', cursor: 1,
  }
}

let view: RenderedElement

beforeEach(async () => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.fetchProjectBoardBundle).mockImplementation(async () => bundle())
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
    expect(vi.mocked(api.fetchProjectBoardBundle).mock.calls.length, 'the background poll never fired').toBeGreaterThan(readsBefore)
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