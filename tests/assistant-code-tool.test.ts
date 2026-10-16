/**
 * The code interpreter as the turn sees it: when it is on the table, and what it hands back.
 *
 * Two things are pinned. First, that the tool is a property of the deployment rather than of the reader's
 * settings — a deployment without the sandbox binding has no `code_execute` at all, so the model never
 * spends a turn on a call that cannot succeed and the reader is never shown an error they cannot fix.
 * Second, that it is a `write`: an unattended run does not get to execute code, and a reader who has closed
 * writing has closed this too.
 *
 * The loader here is a stub, because what this file is about is the wiring. What the module the tool builds
 * actually does when it runs is `tests/code-sandbox.test.ts`, where it is executed for real.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '../src/shared/assistant'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'

/** A loader that answers every program with the same canned result, and records what it was asked to run. */
function stubLoader(reply: unknown = { logs: ['3'], result: 3, error: null }) {
  const seen: WorkerLoaderWorkerCode[] = []
  const loader = {
    get(_name: string | null, getCode: () => WorkerLoaderWorkerCode) {
      return {
        getEntrypoint: () => ({
          fetch: async () => {
            seen.push(getCode())
            return Response.json(reply)
          },
        }),
      }
    },
  } as unknown as WorkerLoader
  return { loader, seen }
}

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
  it('is not offered on a deployment that has no sandbox', () => {
    // No binding, no tool. The alternative — offering it and failing — costs a turn and reads to the
    // reader as their app being broken.
    expect(names(context())).not.toContain('code_execute')
  })

  it('is offered once the deployment has one', () => {
    const { loader } = stubLoader()
    expect(names(context({ env: { CODE_SANDBOX: loader } as unknown as Env }))).toContain('code_execute')
  })

  it('is a write, so a reader who closed writes has closed this too', () => {
    const { loader } = stubLoader()
    const closed: AssistantSettings = { ...DEFAULT_ASSISTANT_SETTINGS, toolModes: { read: 'auto', write: 'off', destructive: 'ask' } }
    expect(names(context({ env: { CODE_SANDBOX: loader } as unknown as Env, settings: closed }))).not.toContain('code_execute')
  })

  it('is not offered to a routine nobody is watching', () => {
    const { loader } = stubLoader()
    const ctx = context({ env: { CODE_SANDBOX: loader } as unknown as Env, mode: 'scheduled', conversationId: undefined })
    expect(names(ctx)).not.toContain('code_execute')
  })

  it('runs the program and hands back what it printed and returned', async () => {
    const { loader, seen } = stubLoader({ logs: ['rows 3'], result: [2, 4, 6], error: null })
    const executor = new ToolExecutor(context({ env: { CODE_SANDBOX: loader } as unknown as Env }), { maxToolCalls: 8 })
    const result = await executor.execute('code_execute', { code: 'return [1,2,3].map((n) => n * 2)' }, 'call-1') as Record<string, unknown>

    expect(result.logs).toEqual(['rows 3'])
    expect(result.result).toEqual([2, 4, 6])
    expect(result.error).toBeNull()
    // The model's own text is what got compiled, wrapped in the harness rather than run bare.
    const source = seen[0]!.modules['index.js'] as string
    expect(source).toContain('return [1,2,3].map((n) => n * 2)')
    expect(source).toContain('export default')
  })

  it('stops at three programs in one turn', async () => {
    const { loader } = stubLoader()
    const executor = new ToolExecutor(context({ env: { CODE_SANDBOX: loader } as unknown as Env }), { maxToolCalls: 8 })
    for (const n of [1, 2, 3]) await executor.execute('code_execute', { code: `return ${n}` }, `call-${n}`)
    // Past this the model is searching rather than computing, and every request costs the reader.
    await expect(executor.execute('code_execute', { code: 'return 4' }, 'call-4')).rejects.toThrow('already used 3 times')
  })

  it('refuses a call with no program in it', async () => {
    const { loader } = stubLoader()
    const executor = new ToolExecutor(context({ env: { CODE_SANDBOX: loader } as unknown as Env }), { maxToolCalls: 8 })
    await expect(executor.execute('code_execute', {}, 'call-1')).rejects.toThrow('Missing required argument "code"')
  })

  it('reports a sandbox that cannot be reached as a failed call, not as an answer', async () => {
    // A deadline is the app failing to run anything, which is a different thing from a program that threw.
    const loader = {
      get: () => ({ getEntrypoint: () => ({ fetch: async () => new Response('', { status: 502 }) }) }),
    } as unknown as WorkerLoader
    const executor = new ToolExecutor(context({ env: { CODE_SANDBOX: loader } as unknown as Env }), { maxToolCalls: 8 })
    await expect(executor.execute('code_execute', { code: 'return 1' }, 'call-1')).rejects.toThrow('answered 502')
  })

  it('leaves the reader\'s own storage and keys out of the sandbox', async () => {
    const { loader, seen } = stubLoader()
    const env = { CODE_SANDBOX: loader, FILES: {}, DB: {}, OAUTH_KV: {} } as unknown as Env
    const executor = new ToolExecutor(context({ env }), { maxToolCalls: 8 })
    await executor.execute('code_execute', { code: 'return 1' }, 'call-1')
    // The bindings exist on the deployment; none of them travels into the scratch Worker.
    expect(seen[0]!.env).toBeUndefined()
    expect(seen[0]!.globalOutbound).toBeNull()
  })
})
