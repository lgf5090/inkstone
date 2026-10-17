/**
 * `fetch_url`: the one tool that reaches the open web on the reader's behalf.
 *
 * Three things are pinned, and each of them is a way the tool could be dangerous rather than merely
 * wrong. It must not read a private address, it must not follow a redirect (which is how a public
 * address becomes a private one), and it must not hand back a page whose type it cannot read. What it
 * does return is the words, with the markup and the scripts stripped, because that is what the model
 * can use and what a reader would recognise as the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'

const store = { userId: 'user-1' } as unknown as AssistantStore
const env = {} as unknown as Env

function context(): ToolContext {
  return {
    store,
    env,
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
  }
}

function serve(body: string, init: { status?: number, type?: string, headers?: Record<string, string> } = {}) {
  const fetchMock = vi.fn(async () => new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.type ?? 'text/html; charset=utf-8', ...init.headers },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('fetch_url', () => {
  it('returns the words of a page, without its markup or its scripts', async () => {
    serve(`<html><head><title>The Harbour</title><style>p{color:red}</style></head>
      <body><script>alert('no')</script><h1>Harbour</h1><p>The tide table is pinned &amp; kept above the door.</p>
      <p>Second paragraph.</p></body></html>`)
    const result = await new ToolExecutor(context(), { maxToolCalls: 8 })
      .execute('fetch_url', { url: 'https://example.com/harbour' }, 'call-1') as Record<string, unknown>

    expect(result.title).toBe('The Harbour')
    expect(result.url).toBe('https://example.com/harbour')
    expect(result.text).toContain('The tide table is pinned & kept above the door.')
    expect(result.text).toContain('Second paragraph.')
    // Neither the script nor the stylesheet leaks into the text the model reads.
    expect(result.text).not.toContain('alert')
    expect(result.text).not.toContain('color:red')
  })

  it('refuses a private address before any request goes out', async () => {
    const fetchMock = serve('secret')
    await expect(new ToolExecutor(context(), { maxToolCalls: 8 })
      .execute('fetch_url', { url: 'http://127.0.0.1:8080/admin' }, 'call-1'))
      .rejects.toThrow(/public/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to follow a redirect, which is how a public address becomes a private one', async () => {
    serve('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
    await expect(new ToolExecutor(context(), { maxToolCalls: 8 })
      .execute('fetch_url', { url: 'https://example.com/go' }, 'call-1'))
      .rejects.toThrow(/redirect/i)
  })

  it('refuses a page whose type it cannot read', async () => {
    serve('binary', { type: 'application/octet-stream' })
    await expect(new ToolExecutor(context(), { maxToolCalls: 8 })
      .execute('fetch_url', { url: 'https://example.com/blob' }, 'call-1'))
      .rejects.toThrow(/not a page/i)
  })
})
