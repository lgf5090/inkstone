import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { ApiError } from '../../lib/api'
import { localDb } from '../../lib/db'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { fetchProjectBoardBundle, fetchProjectBoardCards, fetchProjectCard } from './api'
import { useBoardSession } from './use-board-session'

vi.mock('../../lib/db', () => ({
  localDb: { getProjectBoardCache: vi.fn(), setProjectBoardCache: vi.fn() },
}))
vi.mock('./api', () => ({
  fetchProjectBoardBundle: vi.fn(),
  fetchProjectBoardCards: vi.fn(),
  fetchProjectCard: vi.fn(),
}))

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
function bundle(title: string): ProjectBoardBundle {
  return {
    board: { id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title, description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, archived: false, ...stamps },
    properties: [], views: [{ id: 'v1', boardId: 'b1', title: 'List', viewType: 'list', fields: emptyProjectViewFields(), position: 0, ...stamps }],
    cards: [{ id: 'c1', boardId: 'b1', parentId: '', title, icon: '', isTemplate: false, contentOrder: [], values: {}, ...stamps }],
    contents: [], comments: [], members: [], people: {}, role: 'admin', cursor: 1, propertyRevision: 1,
  }
}

let view: RenderedElement
let session: ReturnType<typeof useBoardSession>
const setOpenCardId = vi.fn()

function Probe() {
  session = useBoardSession('b1', setOpenCardId)
  return <div data-cached={session.usingCachedBundle} data-title={session.bundle?.board.title} />
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(localDb.setProjectBoardCache).mockResolvedValue(undefined)
})
afterEach(() => {
  view?.unmount()
  window.history.replaceState({}, '', '/')
})

describe('offline project board cache', () => {
  it('hydrates before refresh and replays cached page cursors', async () => {
    vi.mocked(localDb.getProjectBoardCache).mockResolvedValue({ bundle: bundle('Cached'), loadedCursors: ['next-page'], savedAt: 1 })
    vi.mocked(fetchProjectBoardBundle).mockResolvedValue(bundle('Fresh'))
    vi.mocked(fetchProjectBoardCards).mockResolvedValue({ ...bundle('Page'), cards: [], cardsNextCursor: undefined })
    await act(async () => { view = renderElement(createElement(Probe)) })
    expect(view.container.querySelector('[data-title]')?.getAttribute('data-title')).toBe('Cached')
    await act(async () => { await session.refresh() })
    expect(fetchProjectBoardCards).toHaveBeenCalledWith('b1', 'next-page')
    expect(view.container.querySelector('[data-title]')?.getAttribute('data-title')).toBe('Fresh')
    expect(view.container.querySelector('[data-cached]')?.getAttribute('data-cached')).toBe('false')
  })

  it('opens a cached deep-linked card without issuing a losing network read', async () => {
    window.history.replaceState({}, '', '/project/boards/b1?card=c1')
    vi.mocked(localDb.getProjectBoardCache).mockResolvedValue({ bundle: bundle('Cached'), loadedCursors: [], savedAt: 1 })
    await act(async () => { view = renderElement(createElement(Probe)) })
    expect(setOpenCardId).toHaveBeenCalledWith('c1')
    expect(view.container.querySelector('[data-title]')?.getAttribute('data-title')).toBe('Cached')
    expect(fetchProjectCard).not.toHaveBeenCalled()
  })

  it('keeps the cached board readable when the refresh is offline', async () => {
    vi.mocked(localDb.getProjectBoardCache).mockResolvedValue({ bundle: bundle('Cached'), loadedCursors: [], savedAt: 1 })
    vi.mocked(fetchProjectBoardBundle).mockRejectedValue(new ApiError(0, 'offline', 'offline'))
    await act(async () => { view = renderElement(createElement(Probe)) })
    await act(async () => { await session.refresh().catch(() => undefined) })
    expect(view.container.querySelector('[data-title]')?.getAttribute('data-title')).toBe('Cached')
    expect(view.container.querySelector('[data-cached]')?.getAttribute('data-cached')).toBe('true')
  })
})
