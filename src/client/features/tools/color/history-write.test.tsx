// @vitest-environment jsdom
/**
 * How often a color change reaches the server.
 *
 * `setCurrentHex` used to POST a history row and then GET the whole list on every call, and a range slider
 * calls it once per step: a thirty-one step drag of the hue control measured twenty writes and twenty
 * reads. The history panel does not need a round trip per pixel of pointer movement, so the write is
 * debounced and a repeat of the color already on top of the trail is dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useColorStudioStore } from './store'

const addHistory = vi.fn().mockResolvedValue({ id: 'h1', hex: '#627486', source: 'picker', createdAt: 1 })
const listHistory = vi.fn().mockResolvedValue([])

vi.mock('./api', () => ({
  colorApi: {
    getSettings: vi.fn().mockResolvedValue({
      stripHash: false,
      defaultFormat: 'hex',
      defaultUiTab: 'flat_ui',
      autoSaveHistory: true,
      updatedAt: 1,
    }),
    addHistory: (...args: unknown[]) => addHistory(...args),
    listHistory: () => listHistory(),
    clearHistory: vi.fn().mockResolvedValue({ ok: true }),
    listFavorites: vi.fn().mockResolvedValue([]),
    listPalettes: vi.fn().mockResolvedValue([]),
  },
}))

beforeEach(() => {
  vi.useFakeTimers()
  addHistory.mockClear()
  listHistory.mockClear()
  useColorStudioStore.setState({
    settings: {
      stripHash: false,
      defaultFormat: 'hex',
      defaultUiTab: 'flat_ui',
      autoSaveHistory: true,
      updatedAt: 1,
    },
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('Color history writes', () => {
  it('collapses a slider drag into one write', async () => {
    for (let hue = 0; hue < 31; hue++) {
      useColorStudioStore.getState().setCurrentHex(`#${(hue + 1).toString(16).padStart(2, '0')}0000`, 'picker')
    }
    expect(addHistory).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    expect(addHistory).toHaveBeenCalledTimes(1)
    expect(addHistory).toHaveBeenLastCalledWith('#1f0000', 'picker')
    expect(listHistory).toHaveBeenCalledTimes(1)
  })

  it('writes again once the reader settles on a different color', async () => {
    useColorStudioStore.getState().setCurrentHex('#100000', 'picker')
    await vi.advanceTimersByTimeAsync(1000)
    useColorStudioStore.getState().setCurrentHex('#200000', 'palette')
    await vi.advanceTimersByTimeAsync(1000)

    expect(addHistory.mock.calls.map((c) => c[0])).toEqual(['#100000', '#200000'])
    expect(addHistory.mock.calls.map((c) => c[1])).toEqual(['picker', 'palette'])
  })

  it('does not re-log the color that is already at the top of the history', async () => {
    useColorStudioStore.getState().setCurrentHex('#300000', 'picker')
    await vi.advanceTimersByTimeAsync(1000)
    addHistory.mockClear()

    // The algorithm view's refresh button re-selects the current color; that is not an exploration.
    useColorStudioStore.getState().setCurrentHex('#300000', 'picker')
    await vi.advanceTimersByTimeAsync(1000)

    expect(addHistory).not.toHaveBeenCalled()
  })

  it('stays silent while the setting is off', async () => {
    useColorStudioStore.setState({
      settings: { ...useColorStudioStore.getState().settings, autoSaveHistory: false },
    })
    useColorStudioStore.getState().setCurrentHex('#400000', 'picker')
    await vi.advanceTimersByTimeAsync(2000)
    expect(addHistory).not.toHaveBeenCalled()
  })

  it('releases the color when the write fails so the next change retries', async () => {
    addHistory.mockRejectedValueOnce(new Error('offline'))
    useColorStudioStore.getState().setCurrentHex('#500000', 'picker')
    await vi.advanceTimersByTimeAsync(1000)
    expect(addHistory).toHaveBeenCalledTimes(1)

    useColorStudioStore.getState().setCurrentHex('#500000', 'picker')
    await vi.advanceTimersByTimeAsync(1000)
    expect(addHistory).toHaveBeenCalledTimes(2)
  })
})
