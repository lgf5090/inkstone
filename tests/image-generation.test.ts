/**
 * Drawing a picture on the reader's own image model.
 *
 * What is pinned here is the wire this app speaks and the bytes it is willing to store. The two answers a
 * vendor may give are both covered — base64 inline, or a link that has to be fetched before it expires —
 * because only one of them is what the common models send and a client that handled one would look
 * finished while failing on the other. What is refused matters as much: a model on a protocol with no
 * image endpoint, and a body that claims to be a picture but is not, both have to stop here rather than
 * put bytes into the reader's storage and then into an `<img>`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toBase64 } from '../src/worker/lib/encoding'
import { generateImage, imagesEndpoint } from '../src/worker/assistant/image-generation'

/** A real PNG header — the signature, then an IHDR — which is all the sniffer reads. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
])

const request = (over: Partial<Parameters<typeof generateImage>[0]> = {}) => ({
  protocol: 'openai' as const,
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test-value',
  model: 'gpt-image-1',
  prompt: 'a cat asleep on a keyboard',
  ...over,
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The first call's init, so a case can assert what actually went up. */
function firstRequest(fetchMock: ReturnType<typeof vi.fn>): { url: string, body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> }
}

afterEach(() => vi.unstubAllGlobals())

describe('the image endpoint', () => {
  it('follows the same rule the chat endpoint does', () => {
    // A reader pastes a host, not a path; the OpenAI-compatible services answer under /v1.
    expect(imagesEndpoint('https://api.openai.com')).toBe('https://api.openai.com/v1/images/generations')
    expect(imagesEndpoint('https://api.openai.com/')).toBe('https://api.openai.com/v1/images/generations')
    // A base that already carries a path is left as written, and one that is already the endpoint is not
    // given a second copy of it.
    expect(imagesEndpoint('https://gateway.test/openai')).toBe('https://gateway.test/openai/images/generations')
    expect(imagesEndpoint('https://api.openai.com/v1/images/generations')).toBe('https://api.openai.com/v1/images/generations')
  })
})

describe('asking for a picture', () => {
  it('takes the base64 a vendor hands back inline', async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ b64_json: toBase64(PNG) }] }))
    vi.stubGlobal('fetch', fetchMock)
    const drawn = await generateImage(request())
    expect(drawn.mime).toBe('image/png')
    expect([...drawn.bytes]).toEqual([...PNG])
    // No `response_format`: it is the one field the common models disagree about — one rejects it, the
    // other ignores it — and both shapes of answer are read here anyway.
    expect(firstRequest(fetchMock).body).toEqual({ model: 'gpt-image-1', prompt: 'a cat asleep on a keyboard', n: 1 })
  })

  it('fetches the picture when the vendor answers with a link instead', async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes('/images/generations')
        ? json({ data: [{ url: 'https://cdn.example.com/drawn.png' }] })
        : new Response(PNG, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    const drawn = await generateImage(request())
    expect(drawn.mime).toBe('image/png')
    // Stored, never linked to: a vendor's URL expires, and following it would also tell that vendor when
    // the reader opens their own thread.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://cdn.example.com/drawn.png')
  })

  it('passes a size through only when one was asked for', async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ b64_json: toBase64(PNG) }] }))
    vi.stubGlobal('fetch', fetchMock)
    await generateImage(request({ size: '1024x1536' }))
    expect(firstRequest(fetchMock).body.size).toBe('1024x1536')
  })

  it('refuses a protocol that has no image endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateImage(request({ protocol: 'anthropic' }))).rejects.toThrow('OpenAI-compatible')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('what a vendor sends back', () => {
  it('says what the vendor said when it refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'prompt was rejected by the safety system' } }, 400)))
    await expect(generateImage(request())).rejects.toThrow('prompt was rejected by the safety system')
  })

  it('names the key when the key is what was refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'invalid api key' } }, 401)))
    await expect(generateImage(request())).rejects.toThrow('refused this key (401)')
  })

  it('refuses bytes that are not a picture', async () => {
    // The bytes go into the reader's storage and then into an `<img>`; the vendor's claim about them is
    // not evidence, so the signature is what decides.
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ b64_json: toBase64(new TextEncoder().encode('definitely not a picture')) }] })))
    await expect(generateImage(request())).rejects.toThrow('was not a picture')
  })

  it('refuses an answer with no picture in it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })))
    await expect(generateImage(request())).rejects.toThrow('no picture')
  })

  it('refuses an address it will not call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ url: 'http://127.0.0.1:8080/x.png' }] })))
    await expect(generateImage(request())).rejects.toThrow('will not call')
  })
})
