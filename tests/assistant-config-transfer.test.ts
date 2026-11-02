import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import { exportAssistantConfig, importAssistantConfig } from '../src/worker/assistant/config-transfer'
import type { AssistantStore } from '../src/worker/assistant/store'

function store(over: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn(async () => ({ ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'm-local', limits: { ...DEFAULT_ASSISTANT_SETTINGS.limits, maxRequestsPerDay: 7 } })),
    listProviders: vi.fn(async () => [{
      id: 'p1', label: 'Vendor', icon: 'sparkles', protocol: 'openai', baseUrl: 'https://api.test',
      endpoints: {}, reasoningDialect: null, hasKey: true, keyHint: '1234', createdAt: 1, updatedAt: 1,
    }]),
    listModels: vi.fn(async () => [{
      id: 'm1', providerId: 'p1', model: 'gpt', label: 'GPT', icon: '', temperature: 0.4,
      maxOutputTokens: null, reasoning: 'auto', contextTokens: null, vision: true, enabled: true,
      purpose: 'chat', kind: 'text', supportsTools: true, noTools: false, maxInputTokens: null,
      modalities: [], topP: null, customParams: [], protocol: null,
    }]),
    listSkills: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
    saveSettings: vi.fn(async (settings: unknown) => settings),
    createProvider: vi.fn(async (input: { label: string }) => ({ id: 'p-new', label: input.label })),
    createModel: vi.fn(async (input: { model: string }) => ({ id: 'm-new', ...input })),
    updateModel: vi.fn(async () => null),
    insertSkill: vi.fn(async (input: { title: string }) => ({ id: 's-new', ...input })),
    createProject: vi.fn(async (input: { name: string }) => ({ id: 'pr-new', ...input })),
    ...over,
  } as unknown as AssistantStore
}

describe('assistant config transfer', () => {
  it('never exports a key or a local-only setting', async () => {
    const bundle = await exportAssistantConfig(store())
    const text = JSON.stringify(bundle)
    expect(text).not.toContain('1234')
    expect(text).not.toContain('keyHint')
    expect(text).not.toContain('m-local')
    expect(bundle.settings).not.toHaveProperty('activeModelId')
    expect(bundle.settings).not.toHaveProperty('limits')
    expect(bundle.providers[0]).not.toHaveProperty('hasKey')
  })

  it('merges by identity and leaves the local settings alone', async () => {
    const s = store()
    const summary = await importAssistantConfig(s, {
      format: 'inkstone-assistant-config',
      version: 1,
      settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'from-file', agentName: 'Mine' },
      providers: [{ id: 'p1', label: 'Vendor', baseUrl: 'https://api.test', protocol: 'openai' }],
      models: [{ id: 'm1', providerId: 'p1', model: 'gpt', label: 'GPT', purpose: 'chat' }],
      skills: [],
      projects: [],
    })
    expect(summary.settings).toBe(true)
    expect(vi.mocked(s.saveSettings).mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      agentName: 'Mine',
      activeModelId: 'm-local',
    }))
    expect(summary.providers).toBe(0)
    expect(summary.models).toBe(0)
    expect(summary.skipped).toBe(2)
  })

  it('creates missing providers and models without a key', async () => {
    const s = store({
      createProvider: vi.fn(async (input: { label: string }) => ({ id: 'p-new', label: input.label })),
      createModel: vi.fn(async (input: { model: string }) => ({ id: 'm-new', ...input })),
    })
    const summary = await importAssistantConfig(s, {
      format: 'inkstone-assistant-config',
      version: 1,
      providers: [{ id: 'p-old', label: 'New Vendor', baseUrl: 'https://new.test', protocol: 'openai' }],
      models: [{ id: 'm-old', providerId: 'p-old', model: 'new-model', label: 'New', purpose: 'chat' }],
      skills: [],
      projects: [],
    })
    expect(summary.providers).toBe(1)
    expect(summary.models).toBe(1)
    expect(vi.mocked(s.createProvider).mock.calls[0]?.[0]).toEqual(expect.objectContaining({ apiKey: '' }))
    expect(vi.mocked(s.createModel).mock.calls[0]?.[0]).toEqual(expect.objectContaining({ providerId: 'p-new', model: 'new-model' }))
  })
})
