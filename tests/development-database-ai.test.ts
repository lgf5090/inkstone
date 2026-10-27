// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  model: { id: 'm1', label: 'Fake', model: 'fake', maxOutputTokens: 1024, enabled: true, providerId: 'p1' } as Record<string, unknown> | null,
  reserve: true,
  events: [] as Array<Array<Record<string, unknown>>>,
  toolCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}))

vi.mock('../src/worker/assistant/store', () => ({
  AssistantStore: class {
    async getSettings() { return {} }
    async reserveRequests() { return state.reserve }
    async pickProviderKey() { return { keyId: 'k1', key: 'sk-test', label: 'key' } }
    async markProviderKeyUsed() {}
    async incrementUsage() {}
  },
}))

vi.mock('../src/worker/assistant/model-config', () => ({
  loadModelAndProvider: async () => state.model
    ? {
        model: state.model,
        provider: { id: 'p1', label: 'Provider', protocol: 'openai', base_url: 'https://example.test', key_ciphertext: '', endpoints: null },
        reason: 'ok',
      }
    : { model: null, provider: null, reason: 'no_model' },
  modelEndpoint: () => ({ protocol: 'openai', baseUrl: 'https://example.test/v1', reasoningDialect: null }),
}))

vi.mock('../src/worker/assistant/upstream', () => ({
  AbortError: class AbortError extends Error {},
  streamUpstream: async function* () {
    const batch = state.events.shift() ?? []
    for (const event of batch) yield event
  },
}))

vi.mock('../src/worker/development/database/executor', () => ({
  executeDatabaseTool: async (_env: unknown, _userId: string, name: string, args: Record<string, unknown>) => {
    state.toolCalls.push({ name, args })
    return { ok: true }
  },
}))

import { streamDatabaseAgent, streamDatabaseAi, databaseAiStatus } from '../src/worker/development/database/ai'
import type { Env } from '../src/worker/env'

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

const env = {} as Env
const signal = new AbortController().signal

beforeEach(() => {
  state.model = { id: 'm1', label: 'Fake', model: 'fake', maxOutputTokens: 1024, enabled: true, providerId: 'p1' }
  state.reserve = true
  state.events = []
  state.toolCalls = []
})

describe('database AI streams', () => {
  it('reports whether a model is configured', async () => {
    expect(await databaseAiStatus(env, 'u1')).toEqual({ configured: true, modelLabel: 'Fake' })
    state.model = null
    expect(await databaseAiStatus(env, 'u1')).toEqual({ configured: false })
  })

  it('streams text deltas and done', async () => {
    state.events = [[{ type: 'text', delta: 'SELECT 1' }, { type: 'usage', inputTokens: 1, outputTokens: 2 }]]
    const output = await collect(streamDatabaseAi(env, 'u1', { mode: 'generate', prompt: 'select one' }, signal))
    expect(output).toContain('"type":"start"')
    expect(output).toContain('"type":"delta","content":"SELECT 1"')
    expect(output).toContain('"type":"done"')
  })

  it('reports no model and quota as error frames', async () => {
    state.model = null
    expect(await collect(streamDatabaseAi(env, 'u1', { mode: 'generate', prompt: 'x' }, signal))).toContain('"code":"no_model"')
    state.model = { id: 'm1', label: 'Fake', model: 'fake', maxOutputTokens: 1024, enabled: true, providerId: 'p1' }
    state.reserve = false
    expect(await collect(streamDatabaseAi(env, 'u1', { mode: 'generate', prompt: 'x' }, signal))).toContain('"code":"quota"')
  })

  it('runs a tool round and then streams the answer', async () => {
    state.events = [
      [
        { type: 'tool-call', id: 'c1', name: 'list_connections', args: {} },
        { type: 'usage', inputTokens: 2, outputTokens: 1 },
      ],
      [
        { type: 'text', delta: 'Two connections.' },
        { type: 'usage', inputTokens: 3, outputTokens: 2 },
      ],
    ]
    const output = await collect(streamDatabaseAgent(env, 'u1', [{ role: 'user', content: 'list them' }], signal))
    expect(state.toolCalls).toEqual([{ name: 'list_connections', args: {} }])
    expect(output).toContain('"type":"tool_calls"')
    expect(output).toContain('"type":"tool_results"')
    expect(output).toContain('"type":"delta","content":"Two connections."')
    expect(output).toContain('"type":"done"')
  })
})
