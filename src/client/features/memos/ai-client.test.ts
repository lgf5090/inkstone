import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoAi, memoTranscriptionTarget, type MemoAiProvider } from './ai-client'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(body, status))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function callOf(fetchMock: ReturnType<typeof stubFetch>, index = 0): [string, RequestInit] {
  const call = fetchMock.mock.calls[index]
  if (!call) throw new Error(`missing fetch call ${index}`)
  return [String(call[0]), call[1] ?? {}]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('memoAi.providers', () => {
  it('reads the listing under the memos AI prefix and unwraps it', async () => {
    const fetchMock = stubFetch({
      providers: [{ id: 'provider-1', label: 'OpenAI', protocol: 'openai', models: ['whisper-1'] }],
    })
    const controller = new AbortController()

    await expect(memoAi.providers(controller.signal)).resolves.toEqual([
      { id: 'provider-1', label: 'OpenAI', protocol: 'openai', models: ['whisper-1'] },
    ])
    const [path, init] = callOf(fetchMock)
    expect(path).toBe('/api/memos/ai/providers')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.signal).toBe(controller.signal)
  })
})

describe('memoAi.transcribe', () => {
  it('posts the recording form and answers with the transcript', async () => {
    const fetchMock = stubFetch({ text: 'spoken words' })
    const form = new FormData()
    form.set('file', new File(['voice'], 'memo-voice.webm', { type: 'audio/webm' }))
    form.set('providerId', 'provider-1')
    form.set('model', 'whisper-1')

    await expect(memoAi.transcribe(form)).resolves.toEqual({ text: 'spoken words' })
    const [path, init] = callOf(fetchMock)
    expect(path).toBe('/api/memos/ai/transcribe')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(form)
    // The browser owns the multipart boundary; naming a JSON content type would break the upload.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })
})

describe('memoTranscriptionTarget', () => {
  const providers: MemoAiProvider[] = [
    { id: 'claude', label: 'Claude', protocol: 'anthropic', models: ['claude-sonnet-4'] },
    { id: 'empty', label: 'Empty', protocol: 'openai', models: [] },
    { id: 'openai', label: 'OpenAI', protocol: 'openai', models: ['whisper-1', 'gpt-4o-mini'] },
    { id: 'gemini', label: 'Gemini', protocol: 'gemini', models: ['gemini-2.5-flash'] },
  ]

  it('takes the first provider and model on a wire that can carry audio', () => {
    expect(memoTranscriptionTarget(providers)).toEqual({ providerId: 'openai', model: 'whisper-1' })
  })

  it('answers null when nothing can transcribe, so the composer names the setting', () => {
    expect(memoTranscriptionTarget([])).toBeNull()
    expect(memoTranscriptionTarget(providers.slice(0, 2))).toBeNull()
  })
})
