// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { hashToken } from '../src/worker/lib/session-store'
import { makeD1 } from './doubles/d1-sqlite'
import type { Env } from '../src/worker/env'

const sessionToken = 'b'.repeat(64)

let env: Env

beforeAll(async () => {
  const sqlite = new DatabaseSync(':memory:')
  env = {
    DB: makeD1(sqlite),
    ASSETS: { fetch: async () => new Response('ok') },
  } as unknown as Env
  await createApp().fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES ('user', 'owner', 'hash', 'owner', 'Owner', '', 'owner', '{}', ?, ?)`,
  ).run(now, now)
  sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(await hashToken(sessionToken), 'user', now + 600_000, now)
})

async function listMemos(authenticated: boolean): Promise<Response> {
  return await createApp().fetch(new Request('http://localhost/api/memos', {
    headers: authenticated ? { Cookie: `inkstone_session=${sessionToken}` } : {},
  }), env)
}

it('refuses the memo list without a session', async () => {
  const response = await listMemos(false)
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({
    error: { code: 'unauthenticated', message: 'Please sign in first' },
  })
})

it('answers an empty memo page for the signed-in account', async () => {
  const response = await listMemos(true)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ items: [], nextCursor: null })
})

it('keeps the memo list out of every cache', async () => {
  const response = await listMemos(true)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
})
