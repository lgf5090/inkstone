// @vitest-environment node
/**
 * Behavioural coverage for `src/worker/routes/share.ts` (the SQL itself now lives in
 * `src/worker/share/store.ts`; the claims here are about what the routes answer, not about
 * which file the statements sit in).
 *
 * The cases are the ones the share contract commits to: the owner can create, list, read back and
 * revoke only their own link; re-sharing keeps what the request did not name; a forged slug, an
 * expired link and a deleted note all answer the same way as a link that never existed; a passcode
 * link verifies against the stored hash under its throttle and only then hands out the asset
 * cookie; and the view counter moves off the response path.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { hashPassword } from '../src/worker/lib/password'
import { shareAssetCookieName } from '../src/worker/lib/share-asset-session'
import { shareManageRoutes, sharePageRoutes, shareRoutes } from '../src/worker/routes/share'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const NOTE = 'note-alice-1'
const PASSCODE = 'board minutes 2026'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/share', shareManageRoutes)
app.route('/api/public', shareRoutes)
app.route('/s', sharePageRoutes)

// The view counter rides `waitUntil`, so the test collects it and drains it before reading the row.
const pending: Promise<unknown>[] = []
const ctx = {
  waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
  passThroughOnException: () => {},
} as unknown as ExecutionContext

async function drain() {
  while (pending.length) await pending.shift()
}

function request(path: string, init: RequestInit = {}, userId = mocks.userId): Promise<Response> {
  mocks.userId = userId
  return app.request(path, init, {
    DB: db,
    ASSETS: { fetch: async () => new Response('<html><head><title>App</title></head><body>hi</body></html>') },
  } as unknown as AppBindings['Bindings'], ctx)
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const payload = await response.json() as { error: { code: string; message: string } }
  return payload.error
}

async function createShare(userId = ALICE, noteId = NOTE, body: Record<string, unknown> = {}) {
  const response = await request(`/api/share/${noteId}`, jsonInit('POST', body), userId)
  expect(response.status, JSON.stringify(body)).toBe(200)
  return await response.json() as { share: { slug: string; noteId: string; url: string; hasPassword: boolean; views: number } }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'h', ?, ?, '', 'member', '{}', 1, 1)`,
  ).run(ALICE, 'alice', 'alice', 'Alice')
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'h', ?, ?, '', 'member', '{}', 1, 1)`,
  ).run(BOB, 'bob', 'bob', 'Bob')
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, content, excerpt, created_at, updated_at)
     VALUES (?, ?, 'Q3 review', 'body text', 'body text', 1, 1)`,
  ).run(NOTE, ALICE)
  db = makeD1(sqlite)
  mocks.userId = ALICE
  pending.length = 0
})

describe('the owner half', () => {
  it('creates, lists, reads back and revokes its own link', async () => {
    const created = await createShare()
    expect(created.share.url).toMatch(/\/s\/[a-z0-9]{20,}$/)

    const list = await (await request('/api/share')).json() as {
      shares: Array<{ slug: string; noteTitle: string; deletedAt: number | null; hasPassword: boolean }>
    }
    expect(list.shares).toHaveLength(1)
    expect(list.shares[0]).toMatchObject({ slug: created.share.slug, noteTitle: 'Q3 review', deletedAt: null, hasPassword: false })

    const one = await (await request(`/api/share/${NOTE}`)).json() as { share: { slug: string } | null }
    expect(one.share?.slug).toBe(created.share.slug)

    expect((await request(`/api/share/${NOTE}`, { method: 'DELETE' })).status).toBe(200)
    const after = await (await request(`/api/share/${NOTE}`)).json() as { share: unknown }
    expect(after.share).toBe(null)
  })

  it('refuses a note that is not the caller\'s live one', async () => {
    const missing = await errorOf(await request('/api/share/note-ghost', jsonInit('POST', {}), ALICE))
    expect(missing.code).toBe('not_found')

    sqlite.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(5, NOTE)
    expect((await request(`/api/share/${NOTE}`, jsonInit('POST', {}), ALICE)).status).toBe(404)

    // Bob cannot publish Alice's note under his own account.
    const foreign = await errorOf(await request(`/api/share/${NOTE}`, jsonInit('POST', {}), BOB))
    expect(foreign.message).toBe('Note not found')
  })

  it('keeps one account out of another\'s share', async () => {
    const created = await createShare()
    expect((await (await request(`/api/share/${NOTE}`, {}, BOB)).json()).share).toBe(null)
    expect((await request(`/api/share/${NOTE}`, { method: 'DELETE' }, BOB)).status).toBe(200)
    const bobList = await (await request('/api/share', {}, BOB)).json() as { shares: unknown[] }
    expect(bobList.shares).toEqual([])
    const stillThere = await (await request(`/api/share/${NOTE}`, {}, ALICE)).json() as { share: { slug: string } }
    expect(stillThere.share.slug).toBe(created.share.slug)
  })

  it('refuses to overwrite another account\'s row for the same note', async () => {
    // A dangling share owned by Bob on Alice's note: the conflict clause is the only thing between
    // Alice's re-share and Bob's row, and it must match nothing.
    sqlite.prepare(
      `INSERT INTO shares (slug, note_id, user_id, password_hash, expires_at, views, created_at)
       VALUES ('bobstolen slug2345678', ?, ?, NULL, NULL, 0, 1)`,
    ).run(NOTE, BOB)
    const conflict = await errorOf(await request(`/api/share/${NOTE}`, jsonInit('POST', {}), ALICE))
    expect(conflict.message).toBe('Share state changed. Refresh and try again')
    const row = sqlite.prepare('SELECT user_id FROM shares WHERE note_id = ?').get(NOTE) as { user_id: string }
    expect(row.user_id).toBe(BOB)
  })

  it('keeps what a re-share does not name and clears what it names as null', async () => {
    const first = await createShare(ALICE, NOTE, { password: PASSCODE, expiresIn: 60_000 })
    expect(first.share.hasPassword).toBe(true)

    const again = await createShare(ALICE, NOTE, {})
    expect(again.share.hasPassword).toBe(true)
    expect(again.share.slug).toBe(first.share.slug)

    const cleared = await createShare(ALICE, NOTE, { password: null, expiresIn: null })
    expect(cleared.share.hasPassword).toBe(false)
    const stored = sqlite.prepare('SELECT expires_at FROM shares WHERE note_id = ?').get(NOTE) as { expires_at: number | null }
    expect(stored.expires_at).toBe(null)
  })

  it('validates the passcode floor and the expiry type before writing anything', async () => {
    const short = await errorOf(await request(`/api/share/${NOTE}`, jsonInit('POST', { password: '123' }), ALICE))
    expect(short.code).toBe('bad_request')
    expect((await request(`/api/share/${NOTE}`, jsonInit('POST', { password: 7 }), ALICE)).status).toBe(400)
    expect((await request(`/api/share/${NOTE}`, jsonInit('POST', { expiresIn: -1 }), ALICE)).status).toBe(400)
    expect((await (await request(`/api/share/${NOTE}`, {}, BOB)).json()).share).toBe(null)
  })
})

describe('the reader half', () => {
  it('serves an open link and answers a forged slug like a missing one', async () => {
    const { share } = await createShare()
    const response = await request(`/api/public/${share.slug}`, jsonInit('POST', {}), '')
    expect(response.status).toBe(200)
    const note = await response.json() as {
      title: string; author: { name: string }; site: { name: string }; share: { slug: string }
    }
    expect(note).toMatchObject({ title: 'Q3 review', author: { name: 'Alice' }, share: { slug: share.slug } })

    const forged = await errorOf(await request('/api/public/notavalidslug!!', jsonInit('POST', {}), ''))
    expect(forged.message).toBe('The link does not exist or has been revoked')
    const unknown = await errorOf(await request(`/api/public/${'x'.repeat(22)}`, jsonInit('POST', {}), ''))
    expect(unknown.message).toBe('The link does not exist or has been revoked')
  })

  it('answers an expired link and a trashed note with their own plain messages', async () => {
    const { share } = await createShare()
    sqlite.prepare('UPDATE shares SET expires_at = ? WHERE slug = ?').run(Date.now() - 1_000, share.slug)
    expect((await errorOf(await request(`/api/public/${share.slug}`, jsonInit('POST', {}), ''))).message)
      .toBe('The link has expired')

    sqlite.prepare('UPDATE shares SET expires_at = NULL WHERE slug = ?').run(share.slug)
    sqlite.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(5, NOTE)
    expect((await errorOf(await request(`/api/public/${share.slug}`, jsonInit('POST', {}), ''))).message)
      .toBe('The note has been deleted')
  })

  it('verifies the passcode, throttles the guessing and only then sets the asset cookie', async () => {
    const { share } = await createShare(ALICE, NOTE, { password: PASSCODE })

    const missing = await errorOf(await request(`/api/public/${share.slug}`, jsonInit('POST', {}), ''))
    expect(missing.message).toBe('An access password is required')

    const wrong = await errorOf(await request(`/api/public/${share.slug}`, jsonInit('POST', { password: 'wrong passcode 1' }), ''))
    expect(wrong.code).toBe('invalid_credentials')
    expect(wrong.message).toBe('Incorrect passcode')

    const ok = await request(`/api/public/${share.slug}`, jsonInit('POST', { password: PASSCODE }), '')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('set-cookie')).toContain(shareAssetCookieName(share.slug))
  })

  it('counts a served view off the response path, once per window per visitor', async () => {
    const { share } = await createShare()
    const first = await request(`/api/public/${share.slug}`, jsonInit('POST', {}), '')
    expect(first.status).toBe(200)
    await drain()
    expect((sqlite.prepare('SELECT views FROM shares WHERE slug = ?').get(share.slug) as { views: number }).views).toBe(1)
  })
})

describe('the /s/:slug document', () => {
  it('carries the note title for an open link and nothing for a guarded one', async () => {
    const open = await createShare()
    const page = await (await request(`/s/${open.share.slug}`, {}, '')).text()
    expect(page).toContain('<title>Q3 review · Inkstone</title>')
    expect(page).toContain('content="body text"')

    const guarded = await createShare(ALICE, NOTE, { password: PASSCODE })
    const guardedPage = await (await request(`/s/${guarded.share.slug}`, {}, '')).text()
    expect(guardedPage).toContain('<title>Content unavailable · Inkstone</title>')
    expect(guardedPage).not.toContain('og:description')

    const bad = await (await request('/s/notavalidslug!!', {}, '')).text()
    expect(bad).toContain('<title>Content unavailable · Inkstone</title>')
  })
})
