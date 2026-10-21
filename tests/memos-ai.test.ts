// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MEMO_AI_TRANSCRIBE_MAX_BYTES,
  MEMO_AI_TRANSCRIBE_PER_HOUR,
} from '../src/shared/memos/constants'
import type { AppBindings, Env } from '../src/worker/env'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { AssistantStore } from '../src/worker/assistant/store'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { memoAiRoutes } from '../src/worker/routes/memos/ai'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const OPENAI_KEY = 'sk-test-transcribe-openai-0001'
const GEMINI_KEY = 'sk-test-transcribe-gemini-0002'
const TRANSCRIBE_URL = 'http://localhost/api/memos/ai/transcribe'
const AUDIO = new TextEncoder().encode('audio-bytes-for-transcription')

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let app: Hono<AppBindings>
let ownerStore: AssistantStore
let openAiProviderId: string
let geminiProviderId: string

const vaultStorage = new Map<string, unknown>()

function fakeVaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) { return vaultStorage.get(key) },
      async put(key: string, value: unknown) { vaultStorage.set(key, value) },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return await fn() },
  } as unknown as DurableObjectState
}

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) c.set('userId', userId)
    await next()
  })
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/memos/ai', memoAiRoutes)
  return instance
}

interface SentCall {
  url: string
  method: string
  headers: Record<string, string>
  body: RequestInit['body']
}

function stubFetch(answer: (call: SentCall) => Response | Promise<Response>): SentCall[] {
  const calls: SentCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const call: SentCall = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    }
    calls.push(call)
    return await answer(call)
  }))
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface TranscribeOptions {
  userId?: string | null
  providerId?: string | null
  model?: string | null
  language?: string | null
  prompt?: string | null
  bytes?: Uint8Array
  mime?: string
  filename?: string
}

async function requestTranscription(options: TranscribeOptions = {}): Promise<Response> {
  const form = new FormData()
  form.set(
    'file',
    new File(
      [(options.bytes ?? AUDIO) as BlobPart],
      options.filename ?? 'note.webm',
      { type: options.mime ?? 'audio/webm' },
    ),
  )
  if (options.providerId != null) form.set('providerId', options.providerId)
  if (options.model != null) form.set('model', options.model)
  if (options.language != null) form.set('language', options.language)
  if (options.prompt != null) form.set('prompt', options.prompt)
  const userId = options.userId === undefined ? OWNER : options.userId
  return await app.request(TRANSCRIBE_URL, {
    method: 'POST',
    headers: userId ? { 'x-test-user': userId } : {},
    body: form,
  }, env)
}

beforeEach(async () => {
  vaultStorage.clear()
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  env = testBindings(db, {
    DO_AUTH_KEY: 'test-internal-key',
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
  })
  app = buildApp()
  ownerStore = new AssistantStore(db, OWNER, env)
  const openAi = await ownerStore.createProvider({
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: OPENAI_KEY,
  })
  const gemini = await ownerStore.createProvider({
    label: 'Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: GEMINI_KEY,
  })
  openAiProviderId = openAi.id
  geminiProviderId = gemini.id
  const otherStore = new AssistantStore(db, OTHER, env)
  await otherStore.createProvider({
    label: 'Other',
    protocol: 'openai',
    baseUrl: 'https://other.example.com/v1',
    apiKey: 'sk-test-transcribe-other-0003',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('transcribing through a configured provider', () => {
  it('posts the recording to an OpenAI-compatible transcription endpoint', async () => {
    const calls = stubFetch(() => jsonResponse({ text: '  Hello from the recording.  ' }))
    const response = await requestTranscription({
      providerId: openAiProviderId,
      model: 'whisper-1',
      language: 'en',
      prompt: 'Names: Inkstone',
      mime: 'audio/webm;codecs=opus',
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ text: 'Hello from the recording.' })
    expect(body).not.toContain(OPENAI_KEY)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.example.com/v1/audio/transcriptions')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`)
    const form = calls[0]!.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('language')).toBe('en')
    expect(form.get('prompt')).toBe('Names: Inkstone')
    const file = form.get('file') as File
    expect(file.name).toBe('note.webm')
    expect(file.type).toBe('audio/webm')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(AUDIO)
  })

  it('posts inline audio to Gemini and reads the first text part', async () => {
    const calls = stubFetch(() => jsonResponse({
      candidates: [{
        content: {
          parts: [
            { text: '  First transcribed part.  ' },
            { text: 'Second part.' },
          ],
        },
      }],
    }))
    const response = await requestTranscription({
      providerId: geminiProviderId,
      model: 'gemini-2.5-flash',
      prompt: 'Write down what is said.',
      mime: 'audio/wav',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: 'First transcribed part.' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    )
    expect(calls[0]!.headers['x-goog-api-key']).toBe(GEMINI_KEY)
    expect(calls[0]!.headers.authorization).toBeUndefined()
    const body = JSON.parse(String(calls[0]!.body)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>
    }
    const parts = body.contents[0]!.parts
    expect(parts[0]!.text).toBe('Write down what is said.')
    expect(parts[1]!.inlineData).toEqual({
      mimeType: 'audio/wav',
      data: Buffer.from(AUDIO).toString('base64'),
    })
  })

  it('asks Gemini for a transcript even when no prompt was sent', async () => {
    const calls = stubFetch(() => jsonResponse({
      candidates: [{ content: { parts: [{ text: 'Transcript.' }] } }],
    }))
    const response = await requestTranscription({
      providerId: geminiProviderId,
      model: 'gemini-2.5-flash',
      mime: 'audio/ogg',
    })

    expect(response.status).toBe(200)
    const body = JSON.parse(String(calls[0]!.body)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>
    }
    expect(String(body.contents[0]!.parts[0]!.text)).toContain('Transcribe this audio recording')
  })
})

describe('configuration the route refuses', () => {
  it('names the provider and model settings when neither is configured', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'unused' }))

    const withoutProvider = await requestTranscription({ model: 'whisper-1' })
    expect(withoutProvider.status).toBe(400)
    expect(await withoutProvider.text()).toContain('providerId')

    const withoutModel = await requestTranscription({ providerId: openAiProviderId })
    expect(withoutModel.status).toBe(400)
    expect(await withoutModel.text()).toContain('model')
    expect(calls).toHaveLength(0)
  })

  it('names the provider key setting when the provider holds no usable key', async () => {
    const keyless = await ownerStore.createProvider({
      label: 'Keyless',
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
    })
    const calls = stubFetch(() => jsonResponse({ text: 'unused' }))

    const response = await requestTranscription({ providerId: keyless.id, model: 'whisper-1' })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('API key')
    expect(calls).toHaveLength(0)
  })

  it('refuses an unsupported audio type before calling the provider', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'unused' }))
    const response = await requestTranscription({
      providerId: openAiProviderId,
      model: 'whisper-1',
      mime: 'audio/flac',
    })

    expect(response.status).toBe(415)
    expect(await response.text()).toContain('Unsupported audio type')
    expect(calls).toHaveLength(0)
  })

  it('refuses a recording past the byte limit before calling the provider', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'unused' }))
    const response = await requestTranscription({
      providerId: openAiProviderId,
      model: 'whisper-1',
      bytes: new Uint8Array(MEMO_AI_TRANSCRIBE_MAX_BYTES + 1),
    })

    expect(response.status).toBe(413)
    expect(calls).toHaveLength(0)
  })
})

describe('the hourly transcription budget', () => {
  it('refuses the request once the account has spent its twenty', async () => {
    const now = Date.now()
    sqlite.prepare(
      `INSERT INTO login_attempts (key, fails, last_fail_at, locked_until)
       VALUES (?, ?, ?, ?)`,
    ).run(`memo-transcribe:${OWNER}`, MEMO_AI_TRANSCRIBE_PER_HOUR, now, now + 60 * 60 * 1000)
    const calls = stubFetch(() => jsonResponse({ text: 'unused' }))

    const response = await requestTranscription({
      providerId: openAiProviderId,
      model: 'whisper-1',
    })

    expect(response.status).toBe(429)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('too_many_attempts')
    expect(calls).toHaveLength(0)
  })
})

describe('provider failures', () => {
  it('maps a refused key to a clear upstream error without echoing it', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'invalid api key' } }, 401))
    const response = await requestTranscription({
      providerId: openAiProviderId,
      model: 'whisper-1',
    })

    expect(response.status).toBe(502)
    const body = await response.text()
    expect(body).toContain('API key')
    expect(body).not.toContain(OPENAI_KEY)
  })

  it('maps a missing model to a bad request', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'model not found' } }, 404))
    const response = await requestTranscription({
      providerId: openAiProviderId,
      model: 'missing-model',
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('not found')
  })

  it('maps an unreachable provider to an upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down')
    }))
    const response = await requestTranscription({
      providerId: openAiProviderId,
      model: 'whisper-1',
    })

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('could not be reached')
  })
})

describe('account boundaries', () => {
  it('does not let one account transcribe through another account’s provider', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'should not happen' }))
    const response = await requestTranscription({
      userId: OTHER,
      providerId: openAiProviderId,
      model: 'whisper-1',
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('not found')
    expect(calls).toHaveLength(0)
  })

  it('requires a signed-in account', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'should not happen' }))
    const response = await requestTranscription({
      userId: null,
      providerId: openAiProviderId,
      model: 'whisper-1',
    })

    expect(response.status).toBe(401)
    expect(calls).toHaveLength(0)
  })
})
