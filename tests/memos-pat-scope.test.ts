// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/env'
import { hashToken } from '../src/worker/lib/session-store'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * What a Memos personal access token may reach.
 *
 * A PAT exists so an automation can read and write memos without holding a session cookie. It must
 * not become a session: the token ledger (`/tokens`) and a full-account archive (`/export`) stay
 * behind `requireMemoOwner`, and revoking a token takes every token it minted with it.
 */

const OWNER = 'user-owner'
const OWNER_TOKEN = 'a'.repeat(64)

const app = createApp()
let sqlite: DatabaseSync
let env: Env

function insertUser(): void {
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, 'owner', 'hash', 'owner', 'Owner', '', 'owner', '{}', ?, ?)`,
  ).run(OWNER, now, now)
}

async function insertSession(): Promise<void> {
  const now = Date.now()
  sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(await hashToken(OWNER_TOKEN), OWNER, now + 3_600_000, now)
}

interface CallOptions {
  session?: string | null
  pat?: string
  body?: unknown
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.session !== null) headers.Cookie = `inkstone_session=${options.session ?? OWNER_TOKEN}`
  if (options.pat) headers.Authorization = `Bearer ${options.pat}`
  if (method !== 'GET') headers['X-Inkstone-Client'] = '1'
  let body: string | undefined
  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return await app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), env)
}

async function createPat(
  body: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<{ token: string; tokenInfo: { id: string; scope: string } }> {
  const response = await call('POST', '/api/memos/tokens', { ...options, body })
  expect(response.status).toBe(201)
  return await response.json() as { token: string; tokenInfo: { id: string; scope: string } }
}

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
})

beforeEach(async () => {
  sqlite.exec('DELETE FROM sessions')
  sqlite.exec('DELETE FROM users')
  sqlite.exec('DELETE FROM memos_tokens')
  insertUser()
  await insertSession()
})

describe('a memo access token is not a session', () => {
  it('reaches memo data but not the token ledger or the archive', async () => {
    const pat = await createPat()
    expect(pat.tokenInfo.scope).toBe('memos')

    const list = await call('GET', '/api/memos', { session: null, pat: pat.token })
    expect(list.status).toBe(200)

    const tokens = await call('GET', '/api/memos/tokens', { session: null, pat: pat.token })
    expect(tokens.status).toBe(403)

    const exported = await call('GET', '/api/memos/export', { session: null, pat: pat.token })
    expect(exported.status).toBe(403)
  })

  it('lets an explicit owner-scope token manage tokens, and revoking it takes its children with it', async () => {
    const parent = await createPat({ scope: 'owner' })
    expect(parent.tokenInfo.scope).toBe('owner')

    const child = await createPat({ scope: 'owner' }, { session: null, pat: parent.token })
    expect((await call('GET', '/api/memos', { session: null, pat: child.token })).status).toBe(200)

    const revoked = await call('DELETE', `/api/memos/tokens/${parent.tokenInfo.id}`, { session: null, pat: parent.token })
    expect(revoked.status).toBe(200)

    const childAfter = await call('GET', '/api/memos', { session: null, pat: child.token })
    expect(childAfter.status).toBe(401)
    const remaining = sqlite.prepare('SELECT COUNT(*) AS count FROM memos_tokens').get() as { count: number }
    expect(remaining.count).toBe(0)
  })
})
