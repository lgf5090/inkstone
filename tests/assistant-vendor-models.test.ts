// @vitest-environment node
/**
 * Asking a vendor what its key can call.
 *
 * The picker has to show the account's real list, so the three shapes each put the name somewhere else
 * and a fourth failure mode — a base URL that points inside the network — has to be refused before the
 * request leaves. Recorded frames, not a live service.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_TOKEN_CEILING, type AssistantProtocol } from '../src/shared/assistant'
import { listVendorModels } from '../src/worker/assistant/vendor-models'

function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' }, ...init })
}

const captured: { url: string, headers: Record<string, string>, redirect?: string }[] = []

function stub(response: Response) {
  captured.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect as string | undefined,
    })
    return response
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('the three vendor listings', () => {
  it('reads an OpenAI-shaped list from the same base the chat call uses', async () => {
    stub(json({ data: [{ id: 'deepseek-flash', created: 1_700_000_000, owned_by: 'deepseek' }] }))
    const result = await listVendorModels('openai', 'https://api.deepseek.com', 'sk-1')
    expect(result.ok).toBe(true)
    expect(result.models).toEqual([{
      id: 'deepseek-flash', label: 'deepseek-flash', ownedBy: 'deepseek', created: 1_700_000_000,
      // The vendor's own `/v1/models` says nothing about size, and saying so is the whole point: a row
      // that read as "no ceiling" would cut the editor's ladder by a number nobody published.
      contextTokens: null, maxOutputTokens: null,
    }])
    expect(captured[0]?.url).toBe('https://api.deepseek.com/v1/models')
    expect(captured[0]?.headers.authorization).toBe('Bearer sk-1')
  })

  it('prefers the display name Anthropic sends', async () => {
    stub(json({ data: [{ id: 'claude-x', display_name: 'Claude X', created_at: '2026-01-02T03:04:05Z' }] }))
    const result = await listVendorModels('anthropic', 'https://api.anthropic.test', 'key-9')
    expect(result.models[0]).toMatchObject({ id: 'claude-x', label: 'Claude X', created: Date.parse('2026-01-02T03:04:05Z') })
    expect(captured[0]?.url).toBe('https://api.anthropic.test/v1/models')
    expect(captured[0]?.headers['x-api-key']).toBe('key-9')
    expect(captured[0]?.headers['anthropic-version']).toBeTruthy()
  })

  it('strips the resource prefix Gemini wraps the id in', async () => {
    stub(json({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }] }))
    const result = await listVendorModels('gemini', 'https://generativelanguage.googleapis.com', 'g-key')
    expect(result.models[0]).toMatchObject({ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' })
    expect(captured[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(captured[0]?.headers['x-goog-api-key']).toBe('g-key')
  })
})

describe('what a listing says about a model’s size', () => {
  it('reads the two limits Gemini puts on the model resource', async () => {
    stub(json({ models: [{
      name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536,
    }] }))
    const result = await listVendorModels('gemini', 'https://generativelanguage.googleapis.com', 'g-key')
    expect(result.models[0]).toMatchObject({ id: 'gemini-2.5-flash', contextTokens: 1_048_576, maxOutputTokens: 65_536 })
  })

  it('reads what a compatible relay publishes, and leaves the rows it says nothing about unknown', async () => {
    stub(json({ data: [
      { id: 'deepseek/deepseek-chat', context_length: 164_000, max_completion_tokens: 8_191 },
      { id: 'plain-model', created: 1_700_000_000 },
    ] }))
    const result = await listVendorModels('openai', 'https://relay.example.test/v1', 'sk-1')
    expect(result.models[0]).toMatchObject({ contextTokens: 164_000, maxOutputTokens: 8_191 })
    // The neighbour's numbers are not this row's: a listing that carries nothing has to say so.
    expect(result.models[1]).toMatchObject({ contextTokens: null, maxOutputTokens: null })
  })

  it('asks no number of Anthropic’s listing, whose /v1/models has none to give', async () => {
    stub(json({ data: [{ id: 'claude-x', display_name: 'Claude X', created_at: '2026-01-02T03:04:05Z' }] }))
    const result = await listVendorModels('anthropic', 'https://api.anthropic.test', 'key-9')
    expect(result.models[0]).toMatchObject({ contextTokens: null, maxOutputTokens: null })
  })

  it('refuses a count it cannot read as a size, and clamps one past what this app can store', async () => {
    stub(json({ data: [
      { id: 'textual', context_length: '128k', max_output_tokens: 0 },
      { id: 'absurd', context_length: 99_000_000, max_output_tokens: -5 },
    ] }))
    const result = await listVendorModels('openai', 'https://api.example.com', 'sk-1')
    expect(result.models[0]).toMatchObject({ contextTokens: null, maxOutputTokens: null })
    expect(result.models[1]).toMatchObject({ contextTokens: MAX_TOKEN_CEILING, maxOutputTokens: null })
  })
})

describe('what a listing must never do', () => {
  it('carries the key in a header and never in the address, on all three protocols', async () => {
    const cases: [AssistantProtocol, string, string][] = [
      ['gemini', 'https://generativelanguage.googleapis.com', 'x-goog-api-key'],
      ['openai', 'https://api.example.com', 'authorization'],
      ['anthropic', 'https://api.anthropic.test', 'x-api-key'],
    ]
    for (const [protocol, baseUrl, header] of cases) {
      stub(json({ data: [] }))
      await listVendorModels(protocol, baseUrl, 'a-secret-key')
      // A request line is what an access log or a proxy trace keeps, so the secret has to be in the one
      // place of a request that is not part of the address.
      expect(captured[0]?.url).not.toContain('a-secret-key')
      expect(captured[0]?.headers[header]).toContain('a-secret-key')
    }
  })

  it('answers a failure with the status and nothing the vendor wrote', async () => {
    stub(json({ error: { message: 'Credential sk-upstream-leak is invalid for host db-3.internal' } }, { status: 429 }))
    const result = await listVendorModels('openai', 'https://api.example.com', 'sk-1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('429')
    expect(result.error).not.toMatch(/leak|db-3|invalid/i)
  })

  it('refuses an address inside the network before anything is fetched', async () => {
    stub(json({ data: [] }))
    const result = await listVendorModels('openai', 'http://169.254.169.254/latest/meta-data', 'sk-1')
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(captured).toEqual([])
  })

  it('reports a failed answer instead of throwing at the settings screen', async () => {
    stub(json({ error: { message: 'Invalid API key' } }, { status: 401 }))
    const result = await listVendorModels('openai', 'https://api.example.com', 'bad')
    expect(result.ok).toBe(false)
    expect(result.models).toEqual([])
    expect(result.error).toContain('401')
  })

  it('refuses a redirect rather than following it with the key attached', async () => {
    stub(new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/v1/models' } }))
    const result = await listVendorModels('openai', 'https://api.example.com', 'sk-1')
    expect(result.ok).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    // The contract is the request option plus the name given to the answer: a followed redirect would
    // carry the bearer key to a host nobody vetted, and a bare "HTTP 302" is not what the reader should read.
    expect(captured[0]?.redirect).toBe('manual')
    expect(result.error).toMatch(/redirect/i)
  })

  it('cuts an enormous list and drops rows with no id to call', async () => {
    stub(json({ data: [...Array.from({ length: 600 }, (_, index) => ({ id: `m-${index}` })), { id: '   ' }] }))
    const result = await listVendorModels('openai', 'https://api.example.com', 'sk-1')
    expect(result.models).toHaveLength(500)
    expect(result.models.some((model) => model.id.trim() === '')).toBe(false)
  })
})
