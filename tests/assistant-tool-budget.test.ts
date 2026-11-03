/**
 * The tool block is part of the request, so it is part of the budget.
 *
 * The history window was measured against the model's context with only the system prompt and the turn
 * context taken out. The schemas go out beside the messages on every request that supports tools, and a
 * disclosure catalog is extra text on the turn — both were spending room the arithmetic had promised to
 * the thread. The usage frame already separated them for the reader; these two cases pin the subtraction
 * and the number the panel is given.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantRunner, historyBudgetFor } from '../src/worker/assistant/runner'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { estimateTokens, type ChatStreamEvent } from '../src/shared/assistant'
import type { ToolSchema } from '../src/worker/assistant/upstream'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { isNamingRequest, namingAnswer } from './doubles/naming-pass'

const USER = '0123456789abcdefghjkmnpqrs'
const TOOL: ToolSchema = {
  name: 'read_note',
  description: 'Read a note from the notebook.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
}

function sse(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        choices: [{ index: 0, finish_reason: null, delta: { content: text } }],
      })}\n\n`))
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', delta: {} }],
      })}\n\n`))
      controller.close()
    },
  })
}

describe('historyBudgetFor', () => {
  it('takes the tool schemas and their catalog out of the thread budget', () => {
    const base = {
      contextTokens: 8_000,
      system: 'standing instructions',
      turnContext: 'this turn',
      outputCap: 512,
    }
    const withoutTools = historyBudgetFor({ ...base, tools: [], catalog: '' })
    const withTools = historyBudgetFor({ ...base, tools: [TOOL], catalog: '- read_note: Read a note.' })
    const expected = estimateTokens(JSON.stringify(TOOL)) + estimateTokens('- read_note: Read a note.')
    expect(withoutTools - withTools).toBe(expected)
  })
})

describe('a chat turn', () => {
  let env: Env
  let store: AssistantStore

  beforeEach(async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
    store = new AssistantStore(env.DB as D1Database, USER, env)
    const provider = await store.createProvider({
      label: 'Example',
      protocol: 'openai',
      baseUrl: 'https://api.example.com',
      apiKey: '',
    })
    const model = await store.createModel({ providerId: provider.id, model: 'example-model' })
    await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
  })

  it('reports the tool share in the usage frame the context panel reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (isNamingRequest(payload)) return namingAnswer()
      expect((payload.tools as unknown[] | undefined)?.length).toBeGreaterThan(0)
      return new Response(sse('Here is the answer.'), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const conversation = await store.createConversation('Tools')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    const runner = new AssistantRunner({
      store,
      env,
      ftsEnabled: false,
      origin: 'http://localhost',
      settings: await store.getSettings(),
      runToken: token!,
    })
    const events: ChatStreamEvent[] = []
    for await (const event of runner.chat({
      conversationId: conversation.id,
      message: 'Say hello.',
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }
    const usage = events.find((event) => event.type === 'usage')
    expect(usage?.type).toBe('usage')
    if (usage?.type === 'usage') expect(usage.contextBreakdown?.tools ?? 0).toBeGreaterThan(0)
    vi.unstubAllGlobals()
  })
})
