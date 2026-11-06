// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptOptimizerSettings } from '../src/shared/tools/prompt-optimizer/types'

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    session: vi.fn(async () => ({
      rev: 3,
      state: { prompt: 'persisted draft', optimized: 'persisted result' },
      updatedAt: 1,
    })),
    saveSession: vi.fn(async (): Promise<
      { rev: number } | { conflict: true; current: { rev: number; state: Record<string, unknown>; updatedAt: number } }
    > => ({ rev: 4 })),
    optimize: vi.fn(async (_body: Record<string, unknown>) => ({
      text: 'optimized text',
      modelLabel: 'test',
      modelId: 'test',
      templateId: 'test',
      record: { id: 'r1', chainId: 'c1', workspace: 'basic_user', version: 1, originalPrompt: '', optimizedPrompt: '', modelId: '', modelLabel: '', templateId: '', createdAt: 1 },
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheMissTokens: 0 },
    })),
    iterate: vi.fn(async (_body: Record<string, unknown>) => ({
      text: 'iterated text',
      modelLabel: 'test',
      modelId: 'test',
      templateId: 'test',
      record: { id: 'r2', chainId: 'c1', workspace: 'basic_user', version: 2, originalPrompt: '', optimizedPrompt: '', modelId: '', modelLabel: '', templateId: '', createdAt: 2 },
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheMissTokens: 0 },
    })),
    test: vi.fn(async (_body: Record<string, unknown>) => ({
      text: 'test output',
      reasoning: '',
      toolCalls: [],
      timing: { durationMs: 1, modelLabel: 'test', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheMissTokens: 0 },
    })),
    evaluate: vi.fn(async (_body: Record<string, unknown>) => ({
      score: 60,
      verdict: 'ok',
      feedback: '',
      strengths: [],
      weaknesses: [],
      suggestions: [],
      raw: '{}',
      timing: { durationMs: 1, modelLabel: 'test', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheMissTokens: 0 },
      evaluation: {},
    })),
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

describe('Prompt Optimizer workspace switching', () => {
  beforeEach(() => {
    apiMock.session.mockClear()
    apiMock.saveSession.mockClear()
    apiMock.optimize.mockClear()
    apiMock.iterate.mockClear()
    apiMock.test.mockClear()
    apiMock.evaluate.mockClear()
  })

  it('keeps a caller override after loading the persisted session', async () => {
    const { usePromptOptimizerStore } = await import('../src/client/features/tools/prompt-optimizer/store')
    usePromptOptimizerStore.setState({ settings, workspace: 'basic_system', activeView: 'basic_system' })
    await usePromptOptimizerStore.getState().setWorkspace('basic_user', {
      prompt: 'favorite content',
      optimized: 'favorite content',
    })
    expect(apiMock.session).toHaveBeenCalledWith('basic_user')
    expect(usePromptOptimizerStore.getState().drafts.basic_user.prompt).toBe('favorite content')
    expect(usePromptOptimizerStore.getState().drafts.basic_user.optimized).toBe('favorite content')
  })

  it('replaces defined variables in the optimize request and keeps undefined placeholders', async () => {
    const { usePromptOptimizerStore } = await import('../src/client/features/tools/prompt-optimizer/store')
    usePromptOptimizerStore.setState({
      settings,
      workspace: 'basic_user',
      activeView: 'basic_user',
      variables: [{ name: 'product', value: '智能耳机', description: '', createdAt: 1, updatedAt: 1 }],
    })
    await usePromptOptimizerStore.getState().setWorkspace('basic_user')
    usePromptOptimizerStore.getState().updateDraft({ prompt: '为 {{product}} 写一句广告语，面向 {{audience}}。' })
    await usePromptOptimizerStore.getState().optimize(false)
    const request = apiMock.optimize.mock.calls[0]![0] as unknown as { prompt: string; variables: Record<string, string> }
    expect(request.prompt).toContain('智能耳机')
    expect(request.prompt).toContain('{{audience}}')
    expect(request.variables.product).toBe('智能耳机')
  })

  it('replaces variables in both texts sent by iterate', async () => {
    const { usePromptOptimizerStore } = await import('../src/client/features/tools/prompt-optimizer/store')
    usePromptOptimizerStore.setState({
      settings,
      workspace: 'basic_user',
      activeView: 'basic_user',
      variables: [{ name: 'product', value: '智能耳机', description: '', createdAt: 1, updatedAt: 1 }],
    })
    await usePromptOptimizerStore.getState().setWorkspace('basic_user')
    usePromptOptimizerStore.getState().updateDraft({
      optimized: '为 {{product}} 写一句广告语。',
      chainId: 'chain-1',
      iterateInput: '再短一点，面向 {{audience}}。',
    })
    await usePromptOptimizerStore.getState().iterate()
    const request = apiMock.iterate.mock.calls[0]![0] as unknown as { lastOptimizedPrompt: string; iterateInput: string }
    expect(request.lastOptimizedPrompt).toContain('智能耳机')
    expect(request.iterateInput).toContain('{{audience}}')
  })

  it('sends baseline and candidate groups to their own models and prompts', async () => {
    const { usePromptOptimizerStore } = await import('../src/client/features/tools/prompt-optimizer/store')
    usePromptOptimizerStore.setState({ settings, workspace: 'basic_system', activeView: 'basic_system' })
    await usePromptOptimizerStore.getState().setWorkspace('basic_system')
    usePromptOptimizerStore.getState().updateDraft({
      prompt: 'baseline prompt',
      optimized: 'candidate prompt',
      testGroups: [
        { id: 'g1', input: 'one', output: '', reasoning: '', toolCalls: [], status: 'idle', variant: 'baseline', modelId: 'model-baseline' },
        { id: 'g2', input: 'two', output: '', reasoning: '', toolCalls: [], status: 'idle', variant: 'candidate', modelId: 'model-candidate' },
      ],
    })
    await usePromptOptimizerStore.getState().runTest()
    expect(apiMock.test).toHaveBeenNthCalledWith(1, expect.objectContaining({ modelId: 'model-baseline', system: 'baseline prompt' }))
    expect(apiMock.test).toHaveBeenNthCalledWith(2, expect.objectContaining({ modelId: 'model-candidate', system: 'candidate prompt' }))
  })

  it('sends each compare snapshot with its own input and variant role', async () => {
    const { usePromptOptimizerStore } = await import('../src/client/features/tools/prompt-optimizer/store')
    usePromptOptimizerStore.setState({ settings, workspace: 'basic_user', activeView: 'basic_user' })
    await usePromptOptimizerStore.getState().setWorkspace('basic_user')
    usePromptOptimizerStore.getState().updateDraft({
      prompt: 'baseline prompt',
      optimized: 'candidate prompt',
      testGroups: [
        { id: 'g1', input: 'baseline input', output: 'baseline output', reasoning: '', toolCalls: [], status: 'done', variant: 'baseline', modelId: '' },
        { id: 'g2', input: 'candidate input', output: 'candidate output', reasoning: '', toolCalls: [], status: 'done', variant: 'candidate', modelId: '' },
      ],
    })
    await usePromptOptimizerStore.getState().evaluate('compare')
    const body = apiMock.evaluate.mock.calls[0]![0] as unknown as {
      testInput: string
      compare: { prompt: string; input: string; variant: string }[]
    }
    expect(body.testInput).toBe('candidate input')
    expect(body.compare[0]).toMatchObject({ prompt: 'baseline prompt', input: 'baseline input', variant: 'baseline' })
    expect(body.compare[1]).toMatchObject({ prompt: 'candidate prompt', input: 'candidate input', variant: 'candidate' })
  })

  it('surfaces a 409 conflict to the conflict dialog state', async () => {
    const { usePromptOptimizerStore } = await import('../src/client/features/tools/prompt-optimizer/store')
    usePromptOptimizerStore.setState({ settings, workspace: 'basic_system', activeView: 'basic_system' })
    vi.useFakeTimers()
    apiMock.saveSession.mockResolvedValueOnce({ conflict: true, current: { rev: 9, state: {}, updatedAt: 2 } })
    usePromptOptimizerStore.getState().persistWorkspace()
    await vi.advanceTimersByTimeAsync(700)
    expect(usePromptOptimizerStore.getState().conflictWorkspace).toBe('basic_system')
    expect(usePromptOptimizerStore.getState().conflictSession?.rev).toBe(9)
    vi.clearAllTimers()
    vi.useRealTimers()
  })
})
