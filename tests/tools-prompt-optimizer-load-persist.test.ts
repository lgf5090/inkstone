// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptOptimizerSettings } from '../src/shared/tools/prompt-optimizer/types'

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    session: vi.fn(async () => ({
      rev: 4,
      state: { prompt: 'server draft', testGroups: [] },
      updatedAt: 1,
    })),
    saveSession: vi.fn(async (): Promise<{ rev: number }> => ({ rev: 5 })),
    saveSettings: vi.fn(async () => ({})),
  },
}))

vi.mock('../src/client/features/tools/prompt-optimizer/api', () => ({ promptOptimizerApi: apiMock }))

const settings: PromptOptimizerSettings = {
  defaultTextModelId: '',
  evaluationModelId: '',
  imageRecognitionModelId: '',
  imageModelId: '',
  builtinTemplateLanguage: 'zh',
  templateSelection: {},
  workspaceModelSelection: {},
  historyRetentionDays: 30,
  autosaveDrafts: true,
  testGroupDefault: 1,
  updatedAt: 0,
}

async function store() {
  const module = await import('../src/client/features/tools/prompt-optimizer/store')
  return module.usePromptOptimizerStore
}

describe('Prompt Optimizer load-time persistence', () => {
  beforeEach(() => {
    apiMock.session.mockClear()
    apiMock.saveSession.mockClear()
    apiMock.saveSettings.mockClear()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not write a workspace the reader has not edited when a deep link switches views', async () => {
    vi.useFakeTimers()
    const useStore = await store()
    useStore.setState({ settings, workspace: 'basic_system', activeView: 'basic_system' })

    await useStore.getState().setWorkspace('basic_user')
    await vi.advanceTimersByTimeAsync(900)

    expect(apiMock.saveSession).not.toHaveBeenCalled()
    expect(useStore.getState().drafts.basic_user.prompt).toBe('server draft')
  })

  it('flushes a pending edit once before leaving the workspace', async () => {
    vi.useFakeTimers()
    const useStore = await store()
    useStore.setState({ settings, workspace: 'basic_system', activeView: 'basic_system', loading: false })
    await useStore.getState().setWorkspace('basic_system')

    useStore.getState().updateDraft({ prompt: 'edited draft' })
    await useStore.getState().setWorkspace('basic_user')
    await vi.advanceTimersByTimeAsync(900)

    expect(apiMock.saveSession).toHaveBeenCalledTimes(1)
    expect(apiMock.saveSession).toHaveBeenCalledWith('basic_system', 4, expect.objectContaining({ prompt: 'edited draft' }))
    expect(apiMock.session).toHaveBeenLastCalledWith('basic_user')
  })

  it('does not persist an edit made while hydration is still running', async () => {
    vi.useFakeTimers()
    const useStore = await store()
    useStore.setState({ settings, workspace: 'basic_system', activeView: 'basic_system', loading: true })

    useStore.getState().updateDraft({ prompt: 'typed before the session arrived' })
    await vi.advanceTimersByTimeAsync(900)

    expect(apiMock.saveSession).not.toHaveBeenCalled()
  })
})
