import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardSummary } from '@shared/project/model'
import * as api from './api'
import { useProjectStore } from './store'

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
