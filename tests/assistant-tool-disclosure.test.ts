import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '../src/shared/assistant'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'

const createTask = vi.fn(async (input: { title: string }) => ({
  id: 't1', title: input.title, description: '', status: 'todo', priority: 'medium',
  dueAt: null, projectId: null, createdAt: 1, updatedAt: 1, completedAt: null,
  listId: null, tags: [], parentId: null, dependsOn: [], blocks: [], starred: false,
  repeat: null, remindAt: null, remindedAt: null, plannedFor: null, noteId: null,
  conversationId: null, stepTotal: 0, stepDone: 0,
}))

function context(settings: Partial<AssistantSettings> = {}): ToolContext {
  return {
    store: { userId: 'u1', createTask, recordActivity: vi.fn(async () => undefined), createPendingAction: vi.fn() } as unknown as AssistantStore,
    env: {} as Env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, ...settings },
    timezone: 'Asia/Shanghai',
    dayEnd: 0,
    mode: 'chat',
    conversationId: 'c1',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
  }
}

describe('deferred tool disclosure', () => {
  it('sends every tool when disclosure is off', () => {
    const executor = new ToolExecutor(context(), { maxToolCalls: 8 })
    const names = executor.available().map((definition) => definition.name)
    expect(names).toContain('create_task')
    expect(names).not.toContain('load_tool_schemas')
    expect(executor.catalogText()).toBe('')
  })

  it('sends residents and the protocol pair, then exposes a loaded schema', () => {
    const executor = new ToolExecutor(context({ toolDisclosure: 'on_demand' }), { maxToolCalls: 8 })
    const names = executor.available().map((definition) => definition.name)
    expect(names).toEqual(expect.arrayContaining(['search_notes', 'create_task', 'load_tool_schemas', 'invoke_tool']))
    expect(names).not.toContain('snooze_task')
    expect(executor.catalogText()).toContain('snooze_task')

    return executor.execute('load_tool_schemas', { names: ['snooze_task', 'delete_task', 'no_such_tool'] }, 'call-1')
      .then((result) => {
        const loaded = result as { loaded: { name: string }[], skipped: string[] }
        expect(loaded.loaded.map((entry) => entry.name)).toEqual(['snooze_task', 'delete_task'])
        expect(loaded.skipped).toEqual(['no_such_tool'])
        expect(executor.available().map((definition) => definition.name)).toEqual(expect.arrayContaining(['snooze_task', 'delete_task']))
        expect(executor.catalogText()).not.toContain('snooze_task')
      })
  })

  it('runs an invoke as the real tool, including its duplicate guard', async () => {
    const executor = new ToolExecutor(context({ toolDisclosure: 'on_demand' }), { maxToolCalls: 8 })
    await executor.execute('invoke_tool', { name: 'create_task', arguments: { title: 'Ship it' } }, 'call-1')
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Ship it' }))
    await expect(executor.execute('invoke_tool', { name: 'create_task', arguments: { title: 'Ship it' } }, 'call-2'))
      .rejects.toThrow(/already made/)
  })

  it('refuses to load a tool the policy took away', async () => {
    const executor = new ToolExecutor(context({
      toolDisclosure: 'on_demand',
      toolSettings: { snooze_task: { enabled: false } },
    }), { maxToolCalls: 8 })
    const result = await executor.execute('load_tool_schemas', { names: ['snooze_task'] }, 'call-1') as { skipped: string[] }
    expect(result.skipped).toEqual(['snooze_task'])
  })
})
