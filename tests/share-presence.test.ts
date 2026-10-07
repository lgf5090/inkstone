// @vitest-environment node
/**
 * The audience-side position channel.
 *
 * The cases are the ones the design commits to: the row holds a hash and not a token; a viewer with the
 * token sees the position and nothing else; every way of not being entitled answers the same way as a
 * link that never existed; a write is readable on the next beat; a heartbeat is not a view; and the
 * lease never outlives the share it rides on.
 *
 * The routes are registered on fresh Hono instances rather than mounted through `routes/share`,
 * because the owner half of that module sits behind `requireAuth` and this file is about the presence
 * contract, not about the session cookie.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { SHARE_PRESENCE_AUDIENCE_WINDOW_MS, SHARE_PRESENCE_TTL_MS } from '../src/shared/share-presence'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { hashPassword } from '../src/worker/lib/password'
import { registerSharePresenceRoutes, registerSharePublicPresenceRoutes } from '../src/worker/routes/share-presence'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-1'
const NOTE = 'note-1'
const SLUG = 'abcdefghjkkmnpqrst12'
const PASSCODE = 'board minutes 2026'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

let sqlite: DatabaseSync
let db: D1Database
let manage: Hono<AppBindings>
let publicRoutes: Hono<AppBindings>

function insertShare(passwordHash: string | null = null, expiresAt: number | null = null): void {
  sqlite.prepare('DELETE FROM shares').run()
  sqlite.prepare(`INSERT INTO shares (slug, note_id, user_id, password_hash, expires_at, views, created_at)
    VALUES (?, ?, ?, ?, ?, 0, 1)`).run(SLUG, NOTE, USER, passwordHash, expiresAt)
}

function app(): Hono<AppBindings> {
  const bound = new Hono<AppBindings>()
  bound.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  bound.onError((error, c) => errorResponse(c, error))
  bound.route('/api/share', manage)
  bound.route('/api/public', publicRoutes)
  return bound
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return app().fetch(new Request(`https://inkstone.test${path}`, init), { DB: db } as never)
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

async function start(): Promise<{ token: string, slug: string, expiresAt: number }> {
  const response = await call(`/api/share/${NOTE}/present/start`, { method: 'POST' })
  expect(response.status).toBe(200)
  return await response.json()
}

function beat(token: string, ifNoneMatch?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch
  return call(`/api/public/${SLUG}/present`, { method: 'POST', headers, body: JSON.stringify({ token }) })
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, created_at, last_seen_at)
    VALUES (?, 'u', 'x', 'u', 1, 1)`).run(USER)
  sqlite.prepare(`INSERT INTO notes (id, user_id, title, content, created_at, updated_at)
    VALUES (?, ?, 'Q3 review', 'body', 1, 1)`).run(NOTE, USER)
  insertShare()
  db = makeD1(sqlite)
  manage = new Hono<AppBindings>()
  publicRoutes = new Hono<AppBindings>()
  registerSharePresenceRoutes(manage)
  registerSharePublicPresenceRoutes(publicRoutes)
  vi.stubGlobal('crypto', globalThis.crypto)
})

describe('starting a show', () => {
  it('hands back a token the database never stores', async () => {
    const { token } = await start()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    const row = sqlite.prepare('SELECT token_hash FROM share_presence WHERE slug = ?').get(SLUG) as { token_hash: string }
    expect(row.token_hash).not.toBe(token)
    expect(row.token_hash).toHaveLength(64)
  })

  it('keeps one show per share, and a second start replaces the first link', async () => {
    const first = await start()
    const second = await start()
    expect(second.token).not.toBe(first.token)
    expect((await beat(first.token)).status).toBe(404)
    expect((await beat(second.token)).status).toBe(200)
  })

  it('refuses a note that has no live link to ride on', async () => {
    sqlite.prepare('DELETE FROM shares').run()
    expect((await call(`/api/share/${NOTE}/present/start`, { method: 'POST' })).status).toBe(404)
  })

  it('never outlives the share it rides on', async () => {
    const soon = Date.now() + 60_000
    insertShare(null, soon)
    const { expiresAt } = await start()
    expect(expiresAt).toBe(soon)
    const far = Date.now() + SHARE_PRESENCE_TTL_MS * 2
    insertShare(null, far)
    const capped = await start()
    expect(capped.expiresAt).toBeLessThanOrEqual(far)
    expect(capped.expiresAt).toBeGreaterThanOrEqual(Date.now() + SHARE_PRESENCE_TTL_MS - 5_000)
  })
})

describe('the viewer heartbeat', () => {
  it('sees the position and nothing but the position', async () => {
    const { token } = await start()
    const response = await beat(token)
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(['page', 'slide', 'step', 'title', 'updatedAt'])
    expect(body.title).toBe('Q3 review')
  })

  it('answers every way of not being entitled the way it answers a link that never existed', async () => {
    const { token } = await start()
    const refusals = await Promise.all([
      beat(token).then((r) => r.status),
      Promise.resolve(200),
    ])
    expect(refusals[0]).toBe(200)
    expect((await call(`/api/public/${SLUG}/present`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await beat('f'.repeat(64))).status).toBe(404)
    expect((await beat('short')).status).toBe(404)
    // A slug that was never minted, and a show nobody started, must not be distinguishable either.
    expect((await call('/api/public/zzz-not-a-slug/present', { method: 'POST', body: JSON.stringify({ token }) })).status).toBe(404)
    sqlite.prepare('DELETE FROM share_presence').run()
    expect((await beat(token)).status).toBe(404)
  })

  it('does not count a heartbeat as a view', async () => {
    const { token } = await start()
    for (let round = 0; round < 5; round++) expect((await beat(token)).status).toBe(200)
    const views = sqlite.prepare('SELECT views FROM shares WHERE slug = ?').get(SLUG) as { views: number }
    expect(views.views).toBe(0)
  })

  it('revalidates an unchanged beat with a 304 that carries no body', async () => {
    const { token } = await start()
    const first = await beat(token)
    const etag = first.headers.get('ETag')
    expect(etag).toBeTruthy()
    expect(first.headers.get('Cache-Control')).toBe('no-store')
    expect(first.headers.get('X-Robots-Tag')).toBe('noindex')
    const again = await beat(token, etag!)
    expect(again.status).toBe(304)
    expect(await again.text()).toBe('')
    expect(again.headers.get('ETag')).toBe(etag)
  })

  it('takes the row down when the link is revoked under a live show', async () => {
    const { token } = await start()
    sqlite.prepare('DELETE FROM shares WHERE slug = ?').run(SLUG)
    expect((await beat(token)).status).toBe(404)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM share_presence').get()).toMatchObject({ n: 0 })
  })

  it('refuses a passcode share until this browser proves it read the note', async () => {
    insertShare(await hashPassword(PASSCODE))
    const { token } = await start()
    expect((await beat(token)).status).toBe(404)
  })
})

describe('writing the position', () => {
  it('is readable on the next beat, and refreshes the lease', async () => {
    const { token, expiresAt } = await start()
    const written = await call(`/api/share/${NOTE}/present`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slide: 3, page: 1, step: 2 }),
    })
    expect(written.status).toBe(200)
    const body = await (await beat(token)).json()
    expect(body).toMatchObject({ slide: 3, page: 1, step: 2 })
    const row = sqlite.prepare('SELECT expires_at FROM share_presence WHERE slug = ?').get(SLUG) as { expires_at: number }
    expect(row.expires_at).toBeGreaterThanOrEqual(expiresAt)
  })

  it('refuses a position that is not three counters', async () => {
    await start()
    for (const body of [
      { slide: 1, page: 0 },
      { slide: -1, page: 0, step: 0 },
      { slide: 1.5, page: 0, step: 0 },
      { slide: '2', page: 0, step: 0 },
      { slide: 1e12, page: 0, step: 0 },
    ]) {
      const response = await call(`/api/share/${NOTE}/present`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('cannot resurrect a show nobody started', async () => {
    sqlite.prepare('DELETE FROM share_presence').run()
    const response = await call(`/api/share/${NOTE}/present`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slide: 1, page: 0, step: 0 }),
    })
    expect(response.status).toBe(404)
    expect((await sqlite.prepare('SELECT COUNT(*) AS n FROM share_presence').get())).toMatchObject({ n: 0 })
  })

  // The lease is the only thing that ends a show the presenter walked away from, so a write must not
  // be able to extend a row the server has already aged out: that would make the lease a suggestion.
  it('cannot write a position into a show whose lease has run out', async () => {
    await start()
    sqlite.prepare('UPDATE share_presence SET expires_at = 1 WHERE slug = ?').run(SLUG)
    const response = await call(`/api/share/${NOTE}/present`, json({ slide: 4, page: 0, step: 0 }))
    expect(response.status).toBe(404)
    const row = sqlite.prepare('SELECT slide, expires_at FROM share_presence WHERE slug = ?').get(SLUG) as { slide: number, expires_at: number }
    expect(row).toMatchObject({ slide: 0, expires_at: 1 })
  })

  // The token is hashed to be checked, so a caller that sent a megabyte of text would be buying the
  // server work for none. Two layers refuse that: the declared-body limit stops an oversized request
  // before it is read, and the shape test stops a wrong-shaped one before it is digested. Which of the
  // two answered is not the point — neither may be treated as a candidate.
  it('refuses a token of the wrong shape or size without treating it as a candidate', async () => {
    await start()
    expect((await beat('a'.repeat(4_000_000))).status).toBe(413)
    for (const wrong of ['not-a-session-token', 'A'.repeat(64), 'z'.repeat(64), '']) {
      expect((await beat(wrong)).status, wrong).toBe(404)
    }
  })

  it('stops the show for the audience, and stopping twice is not an error', async () => {
    const { token } = await start()
    const stop = () => call(`/api/share/${NOTE}/present/stop`, { method: 'POST' })
    expect((await stop()).status).toBe(200)
    expect((await beat(token)).status).toBe(404)
    expect((await stop()).status).toBe(200)
  })
})

describe('the owner asking whether a show is running', () => {
  it('says no, then says where the talk is without repeating the token', async () => {
    const before = await (await call(`/api/share/${NOTE}/present`, {})).json()
    expect(before).toEqual({ running: false, viewers: 0 })
    const { token } = await start()
    await call(`/api/share/${NOTE}/present`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slide: 2, page: 0, step: 0 }),
    })
    const after = await (await call(`/api/share/${NOTE}/present`, {})).json()
    expect(after.running).toBe(true)
    expect(after.presence).toMatchObject({ slide: 2 })
    expect(JSON.stringify(after)).not.toContain(token)
  })

  // PR-L5: the expiry index exists, so something has to answer for it. A browser that was closed
  // mid-talk never sends the stop press, and the row it leaves behind answers nothing — every read
  // filters on `expires_at` — so it is only ever debris. Asking "am I on air?" is the moment the
  // owner's own debris gets cleared, on the indexed column, bounded to that owner.
  it('takes the owner’s finished shows out of the table while asking', async () => {
    await start()
    sqlite.prepare('UPDATE share_presence SET expires_at = 1 WHERE user_id = ?').run(USER)
    const answer = await (await call(`/api/share/${NOTE}/present`, {})).json()
    expect(answer).toEqual({ running: false, viewers: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM share_presence').get()).toMatchObject({ n: 0 })
  })

  it('leaves a show that is still on air alone while asking', async () => {
    await start()
    await call(`/api/share/${NOTE}/present`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slide: 1, page: 0, step: 0 }),
    })
    const answer = await (await call(`/api/share/${NOTE}/present`, {})).json()
    expect(answer.running).toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM share_presence').get()).toMatchObject({ n: 1 })
  })
})

// PR-M7: the presenter is told how many browsers have been reading the show. The number is read out of
// the read budget the public route already spends, so these cases vary only the address a read came
// from, how old it is, and which show it was aimed at.
describe('the audience number the presenter is told', () => {
  function beatFrom(token: string, ip: string): Promise<Response> {
    const request = new Request(`https://inkstone.test/api/public/${SLUG}/present`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ token }),
    })
    // An address is only trusted behind the edge, so the harness has to say the request came through it.
    Object.defineProperty(request, 'cf', { value: { clientIp: ip } })
    return app().fetch(request, { DB: db } as never)
  }

  async function status(): Promise<{ running: boolean, viewers: number }> {
    return await (await call(`/api/share/${NOTE}/present`, {})).json()
  }

  it('counts browsers that looked in, not the beats they sent', async () => {
    const { token } = await start()
    await beatFrom(token, '203.0.113.1')
    await beatFrom(token, '203.0.113.1')
    await beatFrom(token, '203.0.113.2')
    expect((await status()).viewers).toBe(2)
  })

  it('rides back on the page turn the presenter already made', async () => {
    const { token } = await start()
    await beatFrom(token, '203.0.113.7')
    const published = await (await call(`/api/share/${NOTE}/present`, json({ slide: 1, page: 0, step: 0 }))).json()
    expect(published.viewers).toBe(1)
  })

  it('stops counting a browser once its last read is older than the window', async () => {
    const { token } = await start()
    await beatFrom(token, '203.0.113.9')
    expect((await status()).viewers).toBe(1)
    sqlite.prepare('UPDATE login_attempts SET last_fail_at = ?').run(Date.now() - SHARE_PRESENCE_AUDIENCE_WINDOW_MS - 1000)
    expect((await status()).viewers).toBe(0)
  })

  it('leaves another show’s room out of the count', async () => {
    const { token } = await start()
    sqlite.prepare(`INSERT INTO login_attempts (key, fails, last_fail_at, locked_until) VALUES (?, 3, ?, NULL)`)
      .run('share-present:view:zzzzzzzzzzzzzzzzzzzz:ip:198.51.100.4', Date.now())
    await beatFrom(token, '203.0.113.20')
    expect((await status()).viewers).toBe(1)
  })
})
