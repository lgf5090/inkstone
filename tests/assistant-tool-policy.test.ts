import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings, type AssistantToolModes } from '../src/shared/assistant'
import type { TodoTask } from '../src/shared/todos/model'
import { ToolExecutor, runApprovedAction, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'

/**
 * What the reader allows the assistant to do without asking.
 *
 * The three kinds of action are the reader's own vocabulary — reading, changing, removing — and the
 * policy is a ceiling on the turn, never a second list of things to reach for. These cases pin both
 * halves of that: which tools a turn is offered at all, and what becomes of the one that is held for a
 * press. The interesting failures are silent ones, so most of what is asserted here is what did *not*
 * happen: a tool that was not offered, a write that was not made.
 *
 * The store is stood up rather than opened: what is under test is the decision the executor makes, and a
 * database behind it would only be a slower way to ask the same question.
 */

const USER = 'user-1'

const TASK: TodoTask = {
  id: 't1', title: '买牛奶', description: '', status: 'todo', priority: 'medium',
  dueAt: null, projectId: null, createdAt: 1, updatedAt: 1, completedAt: null,
  listId: null, tags: [], dependsOn: [], blocks: [], starred: false, repeat: null, remindAt: null, remindedAt: null,
  plannedFor: null,
  noteId: null, conversationId: null, stepTotal: 0, stepDone: 0,
}

function store(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    createTask: vi.fn(async (input: { title: string }) => ({ ...TASK, title: input.title })),
    recordActivity: vi.fn(async () => undefined),
    createPendingAction: vi.fn(async (input: {
      conversationId: string, tool: string, targetId: string, targetLabel: string, args?: Record<string, unknown>
    }) => ({
      id: 'a1', conversationId: input.conversationId, tool: input.tool, targetId: input.targetId,
      targetLabel: input.targetLabel, args: input.args ?? {}, status: 'pending', error: null, createdAt: 1, expiresAt: 2,
    })),
    ...over,
  } as unknown as AssistantStore
}

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    store: store(),
    env: {} as Env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'Asia/Shanghai',
    dayEnd: 1_700_000_000_000,
    mode: 'chat',
    conversationId: 'c1',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    ...over,
  }
}

const settings = (toolModes: Partial<AssistantToolModes>): AssistantSettings => ({
  ...DEFAULT_ASSISTANT_SETTINGS,
  toolModes: { ...DEFAULT_ASSISTANT_SETTINGS.toolModes, ...toolModes },
})

const offered = (over: Partial<ToolContext> = {}): string[] =>
  new ToolExecutor(context(over), { maxToolCalls: 8 }).available().map((definition) => definition.name)

describe('what a turn is allowed to reach', () => {
  it('takes a whole class away when the reader says never', () => {
    expect(offered()).toEqual(expect.arrayContaining(['count_notes', 'create_task', 'delete_task', 'notify_reader']))

    const none = offered({ settings: settings({ read: 'off', write: 'off', destructive: 'off' }) })
    expect(none).not.toContain('count_notes')
    expect(none).not.toContain('create_task')
    expect(none).not.toContain('delete_task')
    // A policy is a ceiling on the turn, not a floor under it: with every class closed, nothing is left.
    expect(none).not.toContain('notify_reader')
  })

  it('does not offer a tool an unwatched routine could never get approved', () => {
    // Nobody can press Approve at three in the morning, so a held tool is not offered there at all.
    expect(offered({ mode: 'scheduled', settings: settings({ read: 'ask' }) })).not.toContain('count_notes')
    expect(offered({ mode: 'scheduled' })).toContain('count_notes')
    // A routine exists to tell the reader something, so a policy must not leave it running and silent.
    expect(offered({ mode: 'scheduled', settings: settings({ write: 'off' }) })).toContain('notify_reader')
  })

  it('refuses a tool the reader turned off rather than running it quietly', async () => {
    const executor = new ToolExecutor(context({ settings: settings({ read: 'off' }) }), { maxToolCalls: 8 })
    await expect(executor.execute('count_notes', {}, 'call-1')).rejects.toThrow('not available')
  })
})

describe('a tool held for the reader', () => {
  it('proposes a write instead of making it, and keeps the call it proposed', async () => {
    const s = store()
    const executor = new ToolExecutor(context({ store: s, settings: settings({ write: 'ask' }) }), { maxToolCalls: 8 })
    const result = await executor.execute('create_task', { title: '买牛奶' }, 'call-1') as Record<string, unknown>
    expect(result.status).toBe('awaiting_reader_approval')
    expect(s.createTask).not.toHaveBeenCalled()
    // A read or a write has no target to redo itself from later, so the arguments that were shown on the
    // card are what is kept: approving replays that call and no other.
    expect(s.createPendingAction).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'create_task', args: { title: '买牛奶' },
    }))
  })

  it('runs the write straight through when the reader allows it', async () => {
    const s = store()
    const executor = new ToolExecutor(context({ store: s, settings: settings({ write: 'auto' }) }), { maxToolCalls: 8 })
    await executor.execute('create_task', { title: '买牛奶' }, 'call-1')
    expect(s.createTask).toHaveBeenCalledTimes(1)
  })

  it('replays exactly the call the reader approved', async () => {
    const s = store({
      getPendingAction: vi.fn(async () => ({
        id: 'a1', conversationId: 'c1', tool: 'create_task', targetId: '', targetLabel: '',
        args: { title: '买牛奶' }, status: 'pending', error: null, createdAt: 1, expiresAt: 2,
      })),
      claimPendingAction: vi.fn(async () => true),
      resolvePendingAction: vi.fn(async () => undefined),
    })
    await runApprovedAction(s, context({ store: s }), 'a1')
    expect(s.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: '买牛奶' }))
  })
})
