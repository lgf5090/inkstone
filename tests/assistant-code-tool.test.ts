/**
 * The code interpreter as the turn sees it: when it is on the table, and what it hands back.
 *
 * Two things are pinned. First, that it is offered on every deployment — the interpreter is part of the
 * bundle now, not a binding a deployment may lack, so there is no configuration under which the model is
 * told about a tool that cannot run. Second, that it is a `write`: an unattended run does not get to
 * execute code, and a reader who has closed writing has closed this too.
 *
 * What the interpreter itself does with a program is `tests/code-sandbox.test.ts`, where the real engine
 * runs; this file is about the wiring around it.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '../src/shared/assistant'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    store: { userId: 'user-1' } as unknown as AssistantStore,
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

const names = (ctx: ToolContext) => new ToolExecutor(ctx, { maxToolCalls: 8 }).available().map((definition) => definition.name)

describe('code_execute', () => {
  it('is offered', () => {
    expect(names(context())).toContain('code_execute')
  })

  it('is a write, so a reader who closed writes has closed this too', () => {
    const closed: AssistantSettings = { ...DEFAULT_ASSISTANT_SETTINGS, toolModes: { read: 'auto', write: 'off', destructive: 'ask' } }
    expect(names(context({ settings: closed }))).not.toContain('code_execute')
  })

  it('is not offered to a routine nobody is watching', () => {
    expect(names(context({ mode: 'scheduled', conversationId: undefined }))).not.toContain('code_execute')
  })

  it('runs the program and hands back what it printed and returned', async () => {
    const executor = new ToolExecutor(context(), { maxToolCalls: 8 })
    const result = await executor.execute('code_execute', {
      code: 'console.log("rows", 3)\nreturn [1,2,3].map((n) => n * 2)',
    }, 'call-1') as Record<string, unknown>

    expect(result.logs).toEqual(['rows 3'])
    expect(result.result).toEqual([2, 4, 6])
    expect(result.error).toBeNull()
  })

  it('hands back a program\'s own failure as an answer rather than a failed call', async () => {
    const executor = new ToolExecutor(context(), { maxToolCalls: 8 })
    // The model reads this and fixes the line — that loop is what the tool is for, so the error is data.
    const result = await executor.execute('code_execute', { code: 'return missing.value' }, 'call-1') as Record<string, unknown>
    expect(result.error).toContain('ReferenceError')
    expect(result.result).toBeNull()
  })

  it('stops at three programs in one turn', async () => {
    const executor = new ToolExecutor(context(), { maxToolCalls: 8 })
    for (const n of [1, 2, 3]) await executor.execute('code_execute', { code: `return ${n}` }, `call-${n}`)
    // Past this the model is searching rather than computing, and every request costs the reader.
    await expect(executor.execute('code_execute', { code: 'return 4' }, 'call-4')).rejects.toThrow('already used 3 times')
  })

  it('refuses a call with no program in it', async () => {
    const executor = new ToolExecutor(context(), { maxToolCalls: 8 })
    await expect(executor.execute('code_execute', {}, 'call-1')).rejects.toThrow('Missing required argument "code"')
  })

  it('gives the program no way back to the reader\'s storage', async () => {
    const executor = new ToolExecutor(context({ env: { DB: {}, FILES: {}, OAUTH_KV: {} } as unknown as Env }), { maxToolCalls: 8 })
    // The bindings exist on the deployment and are not reachable from the program: the interpreter is a
    // separate engine, not a scope inside this one.
    const result = await executor.execute('code_execute', { code: 'return [typeof DB, typeof FILES, typeof globalThis.env]' }, 'call-1') as Record<string, unknown>
    expect(result.result).toEqual(['undefined', 'undefined', 'undefined'])
  })
})
