// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLibrary, parseRssLibrary, RSS_LIMITS, type RssFetchResult, type RssLibrary } from '../src/shared/rss/model'
import { diffLibrary } from '../src/shared/rss/patch'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { rssRoutes } from '../src/worker/routes/rss'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-rss'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    if (!mocks.userId) throw new Error('unauthenticated')
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/rss', rssRoutes)

// Every field hono's request handler declares, so the fake cannot hand the route less than the real
// Worker runtime would; `app.request` may settle either way, hence the awaited return.
const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

async function request(path: string, init?: RequestInit, userId = USER): Promise<Response> {
  mocks.userId = userId
  return await app.request(`/api/rss${path}`, init, { DB: db } as unknown as AppBindings['Bindings'], ctx)
}

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function libraryWith(feeds: number): string {
  const library = emptyLibrary()
  for (let index = 0; index < feeds; index++) {
    library.feeds.push({
      id: `f${index}`,
      url: `https://example${index}.com/feed.xml`,
      title: `Example ${index}`,
      siteUrl: '',
      imageUrl: '',
      groupId: '',
      tags: [],
      order: index,
      updatedAt: 1,
      lastAttemptAt: 1,
      error: '',
      errorCount: 0,
      lastErrorAt: 0,
      etag: '',
      lastModified: '',
      paused: false,
      pinned: false,
    })
  }
  return JSON.stringify(library)
}

/** The upstream a test wants: what each address answers, and what it was asked with. */
function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): Array<{ url: string, init?: RequestInit }> {
  const calls: Array<{ url: string, init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as URL).href ?? input)
    calls.push({ url, init })
    return responder(url, init)
  })
  return calls
}

function response(body: string, init?: ResponseInit): Response {
  return new Response(body, { headers: { 'content-type': 'application/rss+xml' }, ...init })
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  await db.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, settings, created_at, last_seen_at)
    VALUES (?1, ?2, 'x', ?2, '', 'owner', '{}', 1, 1)`).bind(USER, 'rss-owner').run()
  await db.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, settings, created_at, last_seen_at)
    VALUES ('other', 'other', 'x', 'other', '', 'member', '{}', 1, 1)`).run()
})

describe('the library', () => {
  it('answers nothing before the reader has saved once', async () => {
    const body = await (await request('/library')).json()
    expect(body).toEqual({ savedAt: 0, library: null })
  })

  it('stores what the reader sends and hands it back', async () => {
    const saved = await request('/library', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ library: libraryWith(2) }) })
    expect(saved.status).toBe(200)
    const { savedAt } = await saved.json() as { savedAt: number }
    expect(savedAt).toBeGreaterThan(0)
    const loaded = (await (await request('/library')).json()) as { library: RssLibrary }
    expect(loaded.library.feeds.map(feed => feed.url)).toEqual([
      'https://example0.com/feed.xml',
      'https://example1.com/feed.xml',
    ])
  })

  it('refuses a library that is not text, not JSON, or not a library', async () => {
    for (const library of [42, 'not json', JSON.stringify({ feeds: 'nope' })]) {
      const res = await request('/library', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ library }) })
      expect(res.status).toBe(400)
    }
  })

  it('refuses a library that needed trimming rather than storing a cut-down copy', async () => {
    const oversized = libraryWith(1)
    const parsed = parseRssLibrary(JSON.parse(oversized))
    parsed.data!.feeds.push({ ...parsed.data!.feeds[0], id: 'dup', url: 'https://example0.com/feed.xml' })
    const res = await request('/library', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: JSON.stringify(parsed.data) }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/cannot be stored/)
  })

  it('writes rows and leaves the account column empty', async () => {
    await request('/library', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ library: libraryWith(2) }) })
    const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM rss_feed WHERE user_id = ?1').get(USER) as { n: number }
    expect(rows.n).toBe(2)
    const state = sqlite.prepare('SELECT saved_at FROM rss_state WHERE user_id = ?1').get(USER) as { saved_at: number }
    expect(state.saved_at).toBeGreaterThan(0)
    expect(sqlite.prepare('SELECT rss FROM users WHERE id = ?1').get(USER)).toEqual({ rss: null })
  })

  it('splits a library the old column still holds, on the way out of a GET', async () => {
    const library = JSON.parse(libraryWith(1)) as RssLibrary
    library.favorites = ['e7']
    sqlite.prepare('UPDATE users SET rss = ?1 WHERE id = ?2').run(JSON.stringify({ savedAt: 4242, version: 2, library }), USER)
    const body = (await (await request('/library')).json()) as { savedAt: number, library: RssLibrary }
    expect(body.savedAt).toBe(4242)
    expect(body.library.favorites).toEqual(['e7'])
    expect(sqlite.prepare('SELECT rss FROM users WHERE id = ?1').get(USER)).toEqual({ rss: null })
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM rss_mark WHERE user_id = ?1').get(USER) as { n: number }).n).toBe(1)
  })

  it('keeps one account\'s library away from another', async () => {
    await request('/library', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ library: libraryWith(1) }) })
    const other = (await (await request('/library', {}, 'other')).json()) as { library: unknown }
    expect(other.library).toBeNull()
  })
})

describe('the change set', () => {
  async function put(library: string) {
    const res = await request('/library', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ library }) })
    expect(res.status).toBe(200)
  }

  async function getLibrary(): Promise<RssLibrary> {
    return ((await (await request('/library')).json()) as { library: RssLibrary }).library
  }

  function rows(table: string): unknown[] {
    return sqlite.prepare(`SELECT * FROM ${table} WHERE user_id = ?1`).all(USER) as unknown[]
  }

  it('adds a mark without writing the rest of the library back', async () => {
    const base = JSON.parse(libraryWith(2)) as RssLibrary
    base.favorites = ['e1']
    await put(JSON.stringify(base))
    const before = rows('rss_feed').length
    const res = await request('/patch', json({
      patch: {
        feeds: { upsert: [], remove: [] },
        groups: { upsert: [], remove: [] },
        tags: { upsert: [], remove: [] },
        marks: { upsert: [{ kind: 'star', entryId: 'e9', value: '', at: 1234 }], remove: [] },
        state: null,
      },
    }))
    expect(res.status).toBe(200)
    // The mark row, and the account's own state row, which is what a save stamps.
    expect(((await res.json()) as { rows: number }).rows).toBe(2)
    expect(rows('rss_feed')).toHaveLength(before)
    expect((await getLibrary()).favorites.sort()).toEqual(['e1', 'e9'])
  })

  it('keeps what a second device marked in the meantime', async () => {
    const shared = JSON.parse(libraryWith(1)) as RssLibrary
    shared.readIds = ['e1']
    await put(JSON.stringify(shared))
    // Device B loaded the library before device A's star landed, and now sends only its own change.
    const older = structuredClone(shared)
    const mine = structuredClone(shared)
    mine.favorites = ['e7']
    const patch = diffLibrary(older, mine)
    expect((await request('/patch', json({ patch }))).status).toBe(200)
    const back = await getLibrary()
    expect(back.favorites).toEqual(['e7'])
    expect(back.readIds).toEqual(['e1'])
    expect(rows('rss_mark')).toHaveLength(2)
  })

  it('takes a feed and its tag rows out together', async () => {
    const base = JSON.parse(libraryWith(2)) as RssLibrary
    base.feeds[0].tags = ['tech']
    await put(JSON.stringify(base))
    expect(rows('rss_feed_tag')).toHaveLength(1)
    const patch = diffLibrary(base, { ...base, feeds: [base.feeds[1]] })
    expect((await request('/patch', json({ patch }))).status).toBe(200)
    expect(rows('rss_feed')).toHaveLength(1)
    expect(rows('rss_feed_tag')).toHaveLength(0)
  })

  it('migrates a library the old column still holds before folding the change in', async () => {
    const legacy = JSON.parse(libraryWith(1)) as RssLibrary
    sqlite.prepare('UPDATE users SET rss = ?1 WHERE id = ?2').run(JSON.stringify({ savedAt: 500, version: 2, library: legacy }), USER)
    const next = structuredClone(legacy)
    next.hiddenIds = ['e3']
    expect((await request('/patch', json({ patch: diffLibrary(legacy, next) }))).status).toBe(200)
    const back = await getLibrary()
    expect(back.hiddenIds).toEqual(['e3'])
    expect(back.feeds).toHaveLength(1)
    expect(sqlite.prepare('SELECT rss FROM users WHERE id = ?1').get(USER)).toEqual({ rss: null })
  })

  it('refuses a change set it cannot read', async () => {
    for (const patch of [null, 'x', [], {}, { feeds: 'no' }, {
      feeds: { upsert: [], remove: [] },
      groups: { upsert: [], remove: [] },
      tags: { upsert: [], remove: [] },
      marks: { upsert: [{ kind: 'other', entryId: 'e1', value: '', at: 1 }], remove: [] },
      state: null,
    }]) {
      expect((await request('/patch', json({ patch }))).status).toBe(400)
    }
  })

  it('refuses a change set that would push the library past its ceiling', async () => {
    const base = JSON.parse(libraryWith(1)) as RssLibrary
    base.readIds = Array.from({ length: RSS_LIMITS.readIds }, (_unused, index) => `e${index}`)
    await put(JSON.stringify(base))
    const extra = Array.from({ length: 10 }, (_unused, index) => ({ kind: 'read', entryId: `new${index}`, value: '', at: 1 }))
    const res = await request('/patch', json({
      patch: {
        feeds: { upsert: [], remove: [] },
        groups: { upsert: [], remove: [] },
        tags: { upsert: [], remove: [] },
        marks: { upsert: extra, remove: [] },
        state: null,
      },
    }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/cannot be stored/)
  })

  it('says nothing at all for a change set that changes nothing', async () => {
    const base = JSON.parse(libraryWith(1)) as RssLibrary
    await put(JSON.stringify(base))
    const res = await request('/patch', json({ patch: diffLibrary(base, structuredClone(base)) }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { rows: number }).rows).toBe(0)
  })
})

describe('the feed relay', () => {
  it('refuses an address inside the deployment', async () => {
    stubFetch(() => response('<rss/>'))
    for (const url of ['http://127.0.0.1/feed.xml', 'http://localhost/feed.xml', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
      const res = await request('/fetch', json({ requests: [{ url }] }))
      const { results } = (await res.json()) as { results: Array<{ ok: boolean, reason?: string }> }
      expect(results[0].ok).toBe(false)
      expect(results[0].reason).toBe('blocked')
    }
  })

  it('hands a feed document back with its validators', async () => {
    stubFetch(() => response('<rss><channel/></rss>', { headers: { 'content-type': 'application/atom+xml', etag: '"v7"', 'last-modified': 'Tue, 02 Sep 2025 08:30:00 GMT' } }))
    const { results } = (await (await request('/fetch', json({ requests: [{ url: 'https://example.com/feed.xml' }] }))).json()) as {
      results: Array<{ ok: boolean, xml?: string, etag?: string, lastModified?: string }>
    }
    expect(results[0].ok).toBe(true)
    expect(results[0].xml).toContain('<channel/>')
    expect(results[0].etag).toBe('"v7"')
    expect(results[0].lastModified).toContain('2025')
  })

  it('sends the validators back as a conditional request and passes a 304 through', async () => {
    const calls = stubFetch(() => new Response(null, { status: 304 }))
    const { results } = (await (await request('/fetch', json({
      requests: [{ url: 'https://example.com/feed.xml', etag: '"v7"', lastModified: 'Tue, 02 Sep 2025 08:30:00 GMT' }],
    }))).json()) as { results: Array<{ status: number, ok: boolean, etag?: string }> }
    expect(results[0]).toEqual({ url: 'https://example.com/feed.xml', status: 304, ok: true, etag: '"v7"', lastModified: 'Tue, 02 Sep 2025 08:30:00 GMT' })
    const sent = new Headers(calls[0].init?.headers)
    expect(sent.get('if-none-match')).toBe('"v7"')
    expect(sent.get('if-modified-since')).toContain('2025')
  })

  it('strips a newline a validator header could smuggle out', async () => {
    const calls = stubFetch(() => response('<rss/>'))
    await request('/fetch', json({ requests: [{ url: 'https://example.com/feed.xml', etag: '"a"\r\nx-injected: 1' }] }))
    const sent = new Headers(calls[0].init?.headers)
    expect(sent.get('if-none-match')).toBe('"a"x-injected: 1')
    expect(sent.get('x-injected')).toBeNull()
  })

  it('follows a redirect and re-checks the hop', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('start')) return new Response(null, { status: 301, headers: { location: 'https://final.example.com/feed.xml' } })
      if (url.includes('private')) return new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest' } })
      return response('<rss><channel/></rss>')
    })
    const { results } = (await (await request('/fetch', json({
      requests: [{ url: 'https://start.example.com/feed' }, { url: 'https://private.example.com/feed' }],
    }))).json()) as { results: Array<{ ok: boolean, reason?: string }> }
    expect(results.find(item => item.ok)).toBeTruthy()
    expect(results.some(item => item.reason === 'blocked')).toBe(true)
    expect(calls.some(call => call.url.includes('final.example.com'))).toBe(true)
    for (const call of calls) expect(call.init?.redirect).toBe('manual')
  })

  it('names a document that is not a feed instead of parsing it', async () => {
    stubFetch((url) => {
      if (url.includes('html')) return new Response('<html><body>Login</body></html>', { headers: { 'content-type': 'text/html' } })
      if (url.includes('empty')) return response('')
      if (url.includes('500')) return response('boom', { status: 500 })
      return response('<rss><channel/></rss>')
    })
    const { results } = (await (await request('/fetch', json({
      requests: [{ url: 'https://example.com/html' }, { url: 'https://example.com/empty' }, { url: 'https://example.com/500' }],
    }))).json()) as { results: Array<{ url: string, reason?: string }> }
    const reason = new Map(results.map(item => [item.url, item.reason]))
    expect(reason.get('https://example.com/html')).toBe('not-a-feed')
    expect(reason.get('https://example.com/empty')).toBe('not-a-feed')
    expect(reason.get('https://example.com/500')).toBe('http')
  })

  it('cuts a body that keeps coming', async () => {
    stubFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024).fill(60))
      },
    }), { headers: { 'content-type': 'application/xml' } }))
    const { results } = (await (await request('/fetch', json({ requests: [{ url: 'https://example.com/never-ending' }] }))).json()) as {
      results: Array<{ ok: boolean, reason?: string }>
    }
    expect(results[0].reason).toBe('too-large')
  })

  it('reports one dead host without losing the others', async () => {
    stubFetch((url) => {
      if (url.includes('dead')) throw new Error('connection refused')
      return response('<rss><channel/></rss>')
    })
    const { results } = (await (await request('/fetch', json({
      requests: [{ url: 'https://dead.example.com/feed' }, { url: 'https://live.example.com/feed' }],
    }))).json()) as { results: RssFetchResult[] }
    expect(results).toHaveLength(2)
    expect(results.find(item => item.ok)?.url).toBe('https://live.example.com/feed')
    expect(results.find(item => !item.ok)?.reason).toBe('unreachable')
  })

  it('caps how many addresses one press may name', async () => {
    const calls = stubFetch(() => response('<rss><channel/></rss>'))
    const requests = Array.from({ length: 40 }, (_, index) => ({ url: `https://example.com/f${index}` }))
    const res = await request('/fetch', json({ requests }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { results: RssFetchResult[] }).results).toHaveLength(25)
    expect(calls).toHaveLength(25)
  })

  it('refuses a batch that names nothing', async () => {
    expect((await request('/fetch', json({ requests: [] }))).status).toBe(400)
    expect((await request('/fetch', json({}))).status).toBe(400)
  })

  it('stops a reader who presses refresh without ceasing', async () => {
    stubFetch(() => response('<rss><channel/></rss>'))
    let blocked = 0
    for (let index = 0; index < 70; index++) {
      const res = await request('/fetch', json({ requests: [{ url: 'https://example.com/feed' }] }))
      if (res.status === 429) blocked++
    }
    expect(blocked).toBeGreaterThan(0)
  })
})

describe('the media relay', () => {
  function relay(url: string, headers?: Record<string, string>): Promise<Response> {
    return request(`/relay?url=${encodeURIComponent(url)}`, headers ? { headers } : undefined)
  }

  it('refuses an internal address and a non-media type', async () => {
    stubFetch((target) => {
      if (target.includes('cat')) return new Response('bytes', { headers: { 'content-type': 'image/png' } })
      if (target.includes('page')) return new Response('<html/>', { headers: { 'content-type': 'text/html' } })
      return new Response('svg', { headers: { 'content-type': 'image/svg+xml' } })
    })
    expect((await relay('http://127.0.0.1/cat.png')).status).toBe(400)
    expect((await relay('https://example.com/page')).status).toBe(400)
    expect((await relay('https://example.com/svg')).status).toBe(400)
  })

  it('passes audio bytes and the range answer through', async () => {
    stubFetch(() => new Response('partial-audio', {
      status: 206,
      headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-11/12', 'content-length': '12', 'accept-ranges': 'bytes' },
    }))
    const res = await relay('https://cdn.example.com/e.mp3', { range: 'bytes=0-11' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('content-range')).toBe('bytes 0-11/12')
    expect(res.headers.get('cache-control')).toContain('private')
    await expect(res.text()).resolves.toBe('partial-audio')
  })

  it('refuses a file that announces itself past the ceiling', async () => {
    stubFetch(() => new Response('x', { headers: { 'content-type': 'audio/mpeg', 'content-length': String(40 * 1024 * 1024) } }))
    expect((await relay('https://example.com/huge.mp3')).status).toBe(413)
  })

  it('says unreachable rather than leaking the failure', async () => {
    stubFetch(() => { throw new Error('upstream detail with a token') })
    const res = await relay('https://example.com/gone.mp3')
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('token')
  })
})
