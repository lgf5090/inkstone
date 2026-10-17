// @vitest-environment node
/**
 * What happens to an answer the model never finished.
 *
 * A turn cut off at its output cap is filed as an `error` row that still carries the words that did
 * arrive — the notice beside it even says the answer above stops where it does. Two things follow, and
 * both were wrong: the reader could not ask the model to finish those words, because a continuation
 * refused anything filed as an error; and the next turn could not see them, because the context only
 * read complete rows, so "put the above into a table" was a question about a text the model had never
 * been shown.
 *
 * The second half of each case is the old bug kept alive: a turn that failed *without* writing anything
 * must stay out of both lists. Its reason is one sentence about the failure, and a model handed that
 * sentence as its own last answer reads it as an answer it had already given.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantRunner } from '../src/worker/assistant/runner'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import type { AssistantConversation, AssistantMessage, ChatStreamEvent } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
/** What a turn that ran out of room says about itself — and the only place that sentence is ever kept. */
const CUT_OFF = 'The model was cut off at its 64-token output limit, so the answer above stops where it does.'
const NEVER_STARTED = 'The model spent the whole 64-token output allowance thinking and never wrote an answer.'
const PARTIAL = 'The harbour was built in'

function sse(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  // A provider with no key at all: `signKey` then answers with an empty string, and nothing has to be
  // decrypted for a turn to reach the stubbed wire.
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  const model = await store.createModel({ providerId: provider.id, model: 'example-model', maxOutputTokens: 64 })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

/**
 * The turn's whole life, with the bodies the model was actually sent.
 *
 * Reading what left the worker is the only way to prove the context question: the filter under test
 * decides what a model sees, and an answer it wrote is worth nothing if the next request never carried
 * it. One reply is scripted per step, so a turn that asked for a tool cannot silently reuse the first.
 */
async function runTurn(
  conversationId: string,
  input: { message: string, continueTurn?: boolean },
  replies: readonly { text: string, finishReason?: string }[],
): Promise<{ events: ChatStreamEvent[], requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = []
  let step = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const reply = replies[Math.min(step, replies.length - 1)]!
    step++
    return new Response(sse([
      frame({ choices: [{ index: 0, finish_reason: null, delta: { content: reply.text } }] }),
      frame({ choices: [{ index: 0, finish_reason: reply.finishReason ?? 'stop', delta: {} }] }),
    ]), { headers: { 'content-type': 'text/event-stream' } })
  }))
  const runner = new AssistantRunner({
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: await store.getSettings(),
  })
  const events: ChatStreamEvent[] = []
  try {
    for await (const event of runner.chat({
      conversationId,
      message: input.message,
      ...(input.continueTurn ? { continueTurn: true } : {}),
      signal: new AbortController().signal,
    })) events.push(event)
  } finally {
    vi.unstubAllGlobals()
  }
  return { events, requests }
}

/** A thread that ends on the answer the model never got to finish. */
async function cutOff(over: { content: string, error: string }): Promise<AssistantConversation> {
  const conversation = await store.createConversation('Cut off')
  expect(await store.claimRun(conversation.id)).not.toBeNull()
  await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'Tell me about the harbour.' })
  await store.addMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: over.content,
    status: 'error',
    error: over.error,
  })
  return conversation
}

const assistantRows = (rows: AssistantMessage[]) => rows.filter((row) => row.role === 'assistant')

describe('continuing an answer that was cut off', () => {
  it('accepts the unfinished words, files both halves on the same row, and calls it off as an error', async () => {
    const conversation = await cutOff({ content: PARTIAL, error: CUT_OFF })
    const before = assistantRows(await store.messages(conversation.id))
    expect(before[0]?.status).toBe('error')

    const { events, requests } = await runTurn(conversation.id, { message: '', continueTurn: true }, [
      { text: ' 1686, at the mouth of the bay.' },
    ])

    const done = events.find((event) => event.type === 'done') as { finalMessage: AssistantMessage } | undefined
    expect(done?.finalMessage.id).toBe(before[0]!.id)
    // The continuation wrote a whole sentence, so nothing was cut off this time and the row says so:
    // the status is decided by this turn, never carried over from the one it resumed.
    expect(done?.finalMessage.status).toBe('complete')
    expect(done?.finalMessage.error).toBe(null)
    expect(done?.finalMessage.content).toBe(`${PARTIAL} 1686, at the mouth of the bay.`)

    const after = assistantRows(await store.messages(conversation.id))
    expect(after).toHaveLength(1)
    expect(after[0]!.content).toBe(`${PARTIAL} 1686, at the mouth of the bay.`)
    // The reader asked for no new question, and the model was handed the words it had already written.
    expect(JSON.stringify(requests)).toContain(PARTIAL)
  })

  it('refuses an answer with nothing in it, and spends no model call doing so', async () => {
    const conversation = await cutOff({ content: '', error: NEVER_STARTED })
    await expect(
      runTurn(conversation.id, { message: '', continueTurn: true }, [{ text: 'should not be reached' }]),
    ).rejects.toThrow(/nothing to continue from/)

    // Refusing is not deleting: the row the reader is looking at stays exactly as it was.
    const rows = await store.messages(conversation.id)
    expect(assistantRows(rows)).toHaveLength(1)
    expect(assistantRows(rows)[0]!.error).toBe(NEVER_STARTED)
  })
})

describe('the turn that follows a cut-off answer', () => {
  it('shows the model its own unfinished words', async () => {
    const conversation = await cutOff({ content: PARTIAL, error: CUT_OFF })
    const { requests } = await runTurn(conversation.id, { message: 'Now put the above into a table.' }, [
      { text: '| year | 1686 |' },
    ])
    const body = JSON.stringify(requests[0])
    expect(body).toContain('Now put the above into a table.')
    expect(body).toContain(PARTIAL)
    // Shown the words, not the sentence about them: the notice is for the reader, and a model that
    // reads it as its own answer starts agreeing with it.
    expect(body).not.toContain(CUT_OFF)
  })

  it('keeps a failed turn that wrote nothing out of the next one', async () => {
    const conversation = await cutOff({ content: '', error: NEVER_STARTED })
    const { requests } = await runTurn(conversation.id, { message: 'Try again.' }, [{ text: 'Retried.' }])
    const body = JSON.stringify(requests[0])
    expect(body).toContain('Try again.')
    expect(body).not.toContain(NEVER_STARTED)
    expect(body).not.toContain('never wrote an answer')
  })
})
