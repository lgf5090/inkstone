import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardSummary } from '@shared/project/model'
import * as api from './api'
import { useProjectStore } from './store'

vi.mock('./api', () => ({
  fetchProjectBoards: vi.fn(),
  createProjectBoard: vi.fn(),
  deleteProjectBoard: vi.fn(),
  duplicateProjectBoard: vi.fn(),
  renameProjectBoard: vi.fn(),
  createBoardFromTemplate: vi.fn(),
  importProjectArchive: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks()
  useProjectStore.setState({ boards: [], boardsStatus: 'idle', boardsError: null })
})

describe('the board list read', () => {
  it('starts idle, so the container knows a read has not happened yet', () => {
    expect(useProjectStore.getState()).toMatchObject({ boards: [], boardsStatus: 'idle', boardsError: null })
  })

  it('stores what the server listed and marks the read ready', async () => {
    vi.mocked(api.fetchProjectBoards).mockResolvedValue([board])
    await useProjectStore.getState().loadBoards()
    expect(useProjectStore.getState()).toMatchObject({ boards: [board], boardsStatus: 'ready', boardsError: null })
  })

  it('keeps the failure message for the container to render', async () => {
    vi.mocked(api.fetchProjectBoards).mockRejectedValue(new Error('the read failed'))
    await useProjectStore.getState().loadBoards()
    expect(useProjectStore.getState()).toMatchObject({ boardsStatus: 'error', boardsError: 'the read failed' })
  })

  it('still says something when the rejection is not an Error', async () => {
    vi.mocked(api.fetchProjectBoards).mockRejectedValue('offline')
    await useProjectStore.getState().loadBoards()
    expect(useProjectStore.getState().boardsError).toBe('offline')
  })
})

describe('the boot kick', () => {
  it('reads once and leaves a ready list alone', async () => {
    vi.mocked(api.fetchProjectBoards).mockResolvedValue([board])
    const { ensureBoards } = useProjectStore.getState()
    ensureBoards()
    await vi.waitFor(() => expect(useProjectStore.getState().boardsStatus).toBe('ready'))
    ensureBoards()
    expect(api.fetchProjectBoards).toHaveBeenCalledTimes(1)
  })

  it('reads again after a failed read, which is what the retry button does', async () => {
    vi.mocked(api.fetchProjectBoards).mockRejectedValueOnce(new Error('first read failed')).mockResolvedValue([board])
    const { ensureBoards } = useProjectStore.getState()
    ensureBoards()
    await vi.waitFor(() => expect(useProjectStore.getState().boardsStatus).toBe('error'))
    ensureBoards()
    await vi.waitFor(() => expect(useProjectStore.getState().boardsStatus).toBe('ready'))
    expect(api.fetchProjectBoards).toHaveBeenCalledTimes(2)
  })

  it('does not start a second read while one is in flight', async () => {
    let settle: (boards: ProjectBoardSummary[]) => void = () => {}
    vi.mocked(api.fetchProjectBoards).mockReturnValue(new Promise((resolve) => { settle = resolve }))
    const { ensureBoards } = useProjectStore.getState()
    ensureBoards()
    ensureBoards()
    expect(api.fetchProjectBoards).toHaveBeenCalledTimes(1)
    settle([board])
    await vi.waitFor(() => expect(useProjectStore.getState().boardsStatus).toBe('ready'))
  })
})

describe('board mutations keep the list in step', () => {
  it('prepends a created board and returns it for navigation', async () => {
    useProjectStore.setState({ boards: [board], boardsStatus: 'ready' })
    const created = { ...board, id: 'n'.repeat(27), title: 'New' }
    vi.mocked(api.createProjectBoard).mockResolvedValue(created)
    const result = await useProjectStore.getState().addBoard('New')
    expect(api.createProjectBoard).toHaveBeenCalledWith({ title: 'New' })
    expect(result.id).toBe(created.id)
    expect(useProjectStore.getState().boards.map((b) => b.id)).toEqual([created.id, board.id])
  })

  it('drops a deleted board from the list', async () => {
    useProjectStore.setState({ boards: [board], boardsStatus: 'ready' })
    vi.mocked(api.deleteProjectBoard).mockResolvedValue(undefined)
    await useProjectStore.getState().removeBoard(board.id)
    expect(api.deleteProjectBoard).toHaveBeenCalledWith(board.id)
    expect(useProjectStore.getState().boards).toEqual([])
  })

  it('prepends a duplicate and renames in place', async () => {
    useProjectStore.setState({ boards: [board], boardsStatus: 'ready' })
    const copy = { ...board, id: 'd'.repeat(27) }
    vi.mocked(api.duplicateProjectBoard).mockResolvedValue(copy)
    await useProjectStore.getState().copyBoard(board.id)
    expect(useProjectStore.getState().boards.map((b) => b.id)).toEqual([copy.id, board.id])
    vi.mocked(api.renameProjectBoard).mockResolvedValue({ ...board, title: 'Renamed' })
    await useProjectStore.getState().renameBoard(board.id, 'Renamed')
    expect(useProjectStore.getState().boards.find((b) => b.id === board.id)?.title).toBe('Renamed')
  })
})

describe('every way a board arrives reaches the sidebar list', () => {
  it('prepends a board made from a template', async () => {
    const made = { ...board, id: 't'.repeat(27), title: 'From a template' }
    vi.mocked(api.createBoardFromTemplate).mockResolvedValue(made)
    useProjectStore.setState({ boards: [board], boardsStatus: 'ready' })
    const result = await useProjectStore.getState().addBoardFromTemplate('tpl', 'en-US')
    expect(result.id).toBe(made.id)
    expect(useProjectStore.getState().boards.map((entry) => entry.id)).toEqual([made.id, board.id])
  })

  it('prepends a board imported from an archive', async () => {
    const made = { ...board, id: 'i'.repeat(27), title: 'Imported' }
    vi.mocked(api.importProjectArchive).mockResolvedValue(made)
    useProjectStore.setState({ boards: [board], boardsStatus: 'ready' })
    const result = await useProjectStore.getState().addBoardFromArchive(new Uint8Array([1]))
    expect(result.id).toBe(made.id)
    expect(useProjectStore.getState().boards.map((entry) => entry.id)).toEqual([made.id, board.id])
  })

  it('does not refetch over a list that already holds the new board', async () => {
    const made = { ...board, id: 'n'.repeat(27) }
    vi.mocked(api.createBoardFromTemplate).mockResolvedValue(made)
    vi.mocked(api.fetchProjectBoards).mockClear()
    useProjectStore.setState({ boards: [], boardsStatus: 'ready' })
    await useProjectStore.getState().addBoardFromTemplate('tpl', 'en-US')
    useProjectStore.getState().ensureBoards()
    expect(api.fetchProjectBoards).not.toHaveBeenCalled()
    expect(useProjectStore.getState().boards).toHaveLength(1)
  })
})
