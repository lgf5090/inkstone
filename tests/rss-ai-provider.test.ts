/**
 * The RSS summary asks the account's assistant, not a key kept in this browser.
 *
 * The request is inspected rather than sent to a model: the point of the change is where the text
 * goes and what it carries, and a test that reached a provider would prove neither the route nor the
 * absence of a local credential.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RssEntry, RssFeed } from '../src/shared/rss/model'
import { buildPrompts, runArticleAi } from '../src/client/features/rss/ai'

const feed: RssFeed = {
  id: 'f1', url: 'https://x.test/feed', title: 'A weekly', siteUrl: '', imageUrl: '', groupId: '', tags: [],
  order: 0, updatedAt: 0, lastAttemptAt: 0, error: '', errorCount: 0, lastErrorAt: 0, etag: '', lastModified: '',
  paused: false, pinned: false,
}
const entry: RssEntry = {
  id: 'e1', feedId: 'f1', title: 'On passages', link: 'https://x.test/1', author: 'Author',
  publishedTs: null, summary: '', content: '<p>First paragraph.</p><p>Second one.</p>', imageUrl: '', audioUrl: '',
}

function stubOneShot(text = 'a real answer'): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the account-model transport', () => {
  it('posts the prompt to the assistant one-shot route and never carries a provider key', async () => {
    const fetchMock = stubOneShot()
    const chunks: string[] = []
    const run = runArticleAi(entry, feed, 'summary', 'interface', text => chunks.push(text))

    await expect(run.promise).resolves.toBe('a real answer')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/assistant/one-shot')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ maxOutputTokens: 900, timeoutMs: 60_000 })
    expect(String(body.system)).toMatch(/summarise/i)
    expect(String(body.user)).toContain('First paragraph.')
    expect(String(body.user)).not.toContain('<p>')
    expect(JSON.stringify(body)).not.toContain('apiKey')
    expect(JSON.stringify(body)).not.toContain('baseURL')
    expect(chunks).toEqual(['a real answer'])
  })

  it('asks for more room when the answer is a translation', async () => {
    const fetchMock = stubOneShot()
    const run = runArticleAi(entry, feed, 'translation', 'source', () => {})
    await run.promise
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect(body.maxOutputTokens).toBe(3000)
  })

  it('keeps the prompt builders free of markup and bounded', () => {
    const [system, user] = buildPrompts(entry, feed, 'summary', 'source')
    expect(user).toContain('A weekly / Author / On passages')
    expect(system).toMatch(/no preamble/i)
    expect(user).not.toContain('<p>')
  })
})
