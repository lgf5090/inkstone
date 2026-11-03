// @vitest-environment node
/**
 * Pictures a Markdown attachment links to.
 *
 * The reader attaches a file, and the file names a picture; whether that picture travels to the model is a
 * permission held by two switches (the reader's fetch setting and the model's vision tick) and by the
 * outbound guard. These cases pin the join: the URL is fetched, the bytes become an inline image, and a
 * switch that is off keeps the request from being made at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expandChatAttachments } from '../src/worker/assistant/attachments'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'

const MARKDOWN = '# Note\n\n![logo](https://images.example/logo.png)\n'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function harness() {
  const store = {
    chatAttachments: async () => [{
      id: 'a1', kind: 'text', filename: 'note.md', mime: 'text/markdown', size: MARKDOWN.length, key: 'k1',
    }],
    chatAttachmentTexts: async () => new Map<string, string>(),
  } as unknown as AssistantStore
  const env = {
    FILES: {
      get: async () => ({ arrayBuffer: async () => new TextEncoder().encode(MARKDOWN).buffer }),
    },
  } as unknown as Env
  return { store, env }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a picture named by an attached Markdown file', () => {
  it('is fetched and handed to a vision model that was allowed to fetch it', async () => {
    const fetchMock = vi.fn(async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { store, env } = harness()
    const payload = await expandChatAttachments(store, env, ['a1'], true, [], true, 'gemini', true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String((fetchMock.mock.calls[0] as unknown as [URL])[0])).toBe('https://images.example/logo.png')
    expect(payload.images).toHaveLength(1)
    expect(payload.images[0]!.mime).toBe('image/png')
    expect(payload.images[0]!.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('is not fetched when the reader left the switch off', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { store, env } = harness()
    const payload = await expandChatAttachments(store, env, ['a1'], true, [], true, 'gemini', false)
    expect(fetchMock, 'the switch was off and the worker still went out to the address').not.toHaveBeenCalled()
    expect(payload.images).toHaveLength(0)
  })

  it('is not fetched for a model that cannot see', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { store, env } = harness()
    const payload = await expandChatAttachments(store, env, ['a1'], false, [], true, 'openai', true)
    expect(fetchMock, 'a text-only model caused an image download').not.toHaveBeenCalled()
    expect(payload.images).toHaveLength(0)
  })

  it('ignores a redirect instead of following it', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://internal.example/' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { store, env } = harness()
    const payload = await expandChatAttachments(store, env, ['a1'], true, [], true, 'gemini', true)
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init).toMatchObject({ redirect: 'error' })
    expect(payload.images).toHaveLength(0)
  })
})
