import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, normalizeAssistantSettings, type AssistantSettings } from '../src/shared/assistant'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'

function context(over: Partial<ToolContext> = {}, settings: Partial<AssistantSettings> = {}): ToolContext {
  return {
    store: { userId: 'u1' } as unknown as AssistantStore,
    env: {} as Env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, subagentEnabled: true, ...settings },
    timezone: 'Asia/Shanghai',
    dayEnd: 0,
    mode: 'chat',
    conversationId: 'c1',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    ...over,
  }
}

describe('delegate_subagent', () => {
  it('is off by default and only offered when a parent can run one', () => {
    expect(normalizeAssistantSettings({}).subagentEnabled).toBe(false)
    expect(new ToolExecutor(context({}, { subagentEnabled: false }), { maxToolCalls: 4 }).available().map((tool) => tool.name))
      .not.toContain('delegate_subagent')
    expect(new ToolExecutor(context({ runSubagent: async () => ({ text: '', toolCalls: 0, tokens: 0 }) }), { maxToolCalls: 4 }).available().map((tool) => tool.name))
      .toContain('delegate_subagent')
    // The child's own context has no runner to call, so it cannot delegate again.
    expect(new ToolExecutor(context({ runSubagent: undefined }), { maxToolCalls: 4 }).available().map((tool) => tool.name))
      .not.toContain('delegate_subagent')
  })

  it('hands the description, prompt and model to the child', async () => {
    const runSubagent = vi.fn(async () => ({ text: 'done', toolCalls: 2, tokens: 120 }))
    const executor = new ToolExecutor(context({ runSubagent }), { maxToolCalls: 4 })
    const result = await executor.execute('delegate_subagent', {
      description: 'Read the report',
      prompt: 'Summarise the attached report',
      modelId: 'm1',
    }, 'call-1')
    expect(runSubagent).toHaveBeenCalledWith({ description: 'Read the report', prompt: 'Summarise the attached report', modelId: 'm1' })
    expect(result).toEqual({ text: 'done', toolCalls: 2, tokens: 120 })
  })

  it('honours an allowlist that leaves it out', async () => {
    const executor = new ToolExecutor(context({ allowedTools: ['search_notes'] }), { maxToolCalls: 4 })
    expect(executor.available().map((tool) => tool.name)).not.toContain('delegate_subagent')
  })

  it('offers only what a template declared, including the question tool', () => {
    const names = new ToolExecutor(context({ allowedTools: ['search_notes'] }), { maxToolCalls: 4 })
      .available()
      .map((tool) => tool.name)
    expect(names).toEqual(['search_notes'])
  })
})
