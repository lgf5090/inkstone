// @vitest-environment node
/**
 * The shared one-shot path: resolve the model, reserve the day's request, sign a key, stream once,
 * and meter what was spent. No prompt or key reaches a log.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { OneShotError, runOneShot } from '../src/worker/assistant/one-shot'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

let sqlite: DatabaseSync
let env: ReturnType<typeof testBindings>
let store: AssistantStore

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
const chunk = (text: string, usage?: { prompt_tokens: number, completion_tokens: number }) =>
  frame({ ...(usage ? { usage } : {}), choices: [{ index: 0, finish_reason: null, delta: { content: text } }] })
const stop = () => frame({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

afterEach(() => vi.unstubAllGlobals())

async function configure(): Promise<void> {
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  const model = await store.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
}

describe('runOneShot', () => {
  it('returns the text and meters the spend against the day and the model', async () => {
    await configure()
    const seen: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(sse([chunk('Hello', { prompt_tokens: 7, completion_tokens: 3 }), stop()]), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }))

    const answer = await runOneShot(store, await store.getSettings(), {
      system: 'You answer briefly.',
      user: 'Say hello.',
      maxOutputTokens: 40,
      temperature: 0,
      timeoutMs: 2_000,
      structured: true,
    })

    expect(answer.text).toBe('Hello')
    expect(answer.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
    expect(answer.modelLabel).toBe('Example one')
    expect(seen[0]).toMatchObject({ model: 'example-model', response_format: { type: 'json_object' } })
    const day = await store.todayUsage()
    expect(day).toMatchObject({ requests: 1, inputTokens: 7, outputTokens: 3 })
  })

  it('refuses when no model is configured, without charging the day', async () => {
    const error = await runOneShot(store, await store.getSettings(), {
      system: 's',
      user: 'u',
      maxOutputTokens: 10,
      timeoutMs: 1_000,
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(OneShotError)
    expect((error as OneShotError).kind).toBe('no_model')
    expect((await store.todayUsage()).requests).toBe(0)
  })

  it('refuses when the day\'s request ceiling is spent, before reaching a provider', async () => {
    await configure()
    const settings = await store.getSettings()
    // The ceiling itself is a minimum of one, so the day is spent first and then set to that one.
    await store.reserveRequests(1, 1)
    await store.saveSettings({ ...settings, limits: { ...settings.limits, maxRequestsPerDay: 1 } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const error = await runOneShot(store, await store.getSettings(), {
      system: 's',
      user: 'u',
      maxOutputTokens: 10,
      timeoutMs: 1_000,
    }).catch((reason: unknown) => reason)

    expect((error as OneShotError).kind).toBe('quota')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a provider refusal as upstream and files the failed attempt', async () => {
    await configure()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 })))

    const error = await runOneShot(store, await store.getSettings(), {
      system: 's',
      user: 'u',
      maxOutputTokens: 10,
      timeoutMs: 1_000,
    }).catch((reason: unknown) => reason)

    expect((error as OneShotError).kind).toBe('upstream')
    expect((await store.todayUsage()).errors).toBe(1)
  })

  it('reports a call past its deadline as a timeout instead of an upstream failure', async () => {
    await configure()
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      return new Response(sse([chunk('late'), stop()]), { headers: { 'content-type': 'text/event-stream' } })
    }))

    const error = await runOneShot(store, await store.getSettings(), {
      system: 's',
      user: 'u',
      maxOutputTokens: 10,
      timeoutMs: 1,
    }).catch((reason: unknown) => reason)

    expect((error as OneShotError).kind).toBe('timeout')
    expect((await store.todayUsage()).errors).toBe(1)
  })
})
