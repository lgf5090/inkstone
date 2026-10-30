// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_LIMIT } from '../src/shared/development/api-tester/limits'
import { defaultRequest, defaultState } from '../src/shared/development/api-tester/state'
import type { HistoryEntry } from '../src/shared/development/api-tester/types'

const apiMock = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  getState: vi.fn(),
  putState: vi.fn(),
  listHistory: vi.fn(),
  appendHistory: vi.fn(),
  clearHistory: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('../src/client/features/development/api-tester/api', () => apiMock)

const { useApiTesterStore } = await import('../src/client/features/development/api-tester/store')

function entry(id: string, ts: number): HistoryEntry {
  return {
    id,
    ts,
    kind: 'rest',
    method: 'GET',
    url: `https://example.com/${id}`,
    name: id,
    status: 200,
    durationMs: 3,
    sizeBytes: 4,
    request: defaultRequest(),
    tags: [],
  }
}

beforeEach(() => {
  apiMock.listHistory.mockReset()
  useApiTesterStore.setState({
    activeWorkspaceId: 'ws-1',
    state: { ...defaultState('ws-1'), history: [entry('local-latest', 500)] },
    historyLoading: false,
    historyError: null,
  })
})

describe('API Tester lazy history', () => {
  it('merges server rows with the entries recorded locally and sorts newest first', async () => {
    apiMock.listHistory.mockResolvedValue([entry('server-old', 100), entry('server-new', 900)])

    await useApiTesterStore.getState().loadHistory()

    expect(apiMock.listHistory).toHaveBeenCalledWith('ws-1')
    expect(useApiTesterStore.getState().state.history.map((row) => row.id)).toEqual([
      'server-new',
      'local-latest',
      'server-old',
    ])
    expect(useApiTesterStore.getState().historyLoading).toBe(false)
  })

  it('caps a long server list at the same limit the writer keeps', async () => {
    useApiTesterStore.setState({ state: defaultState('ws-1') })
    apiMock.listHistory.mockResolvedValue(
      Array.from({ length: HISTORY_LIMIT + 20 }, (_, index) => entry(`row-${String(index).padStart(3, '0')}`, index)),
    )

    await useApiTesterStore.getState().loadHistory()

    const history = useApiTesterStore.getState().state.history
    expect(history).toHaveLength(HISTORY_LIMIT)
    expect(history[0]?.ts).toBe(HISTORY_LIMIT + 19)
  })

  it('drops a response that arrives after the workspace was switched', async () => {
    let release: (rows: HistoryEntry[]) => void = () => {}
    apiMock.listHistory.mockReturnValue(new Promise<HistoryEntry[]>((resolve) => { release = resolve }))

    const loading = useApiTesterStore.getState().loadHistory()
    useApiTesterStore.setState({ activeWorkspaceId: 'ws-2', state: defaultState('ws-2') })
    release([entry('from-ws-1', 700)])
    await loading

    expect(useApiTesterStore.getState().state.history).toEqual([])
  })

  it('reports a failed read so the dialog can offer a retry', async () => {
    apiMock.listHistory.mockRejectedValue(new Error('offline'))

    await useApiTesterStore.getState().loadHistory()

    expect(useApiTesterStore.getState().historyError).toBe('offline')
    expect(useApiTesterStore.getState().historyLoading).toBe(false)
  })
})
