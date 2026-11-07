// @vitest-environment node
// W2 REST surface against a real SQLite database: create, ticket, status, owner isolation and the
// per-user session ceiling.

import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import { testDurableObjectNamespace } from './doubles/bindings'
import type { AppBindings, Env, Variables } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { websshRoutes } from '../src/worker/webssh/routes'

const ORIGIN = 'https://notes.example.com'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let userId: string
let app: Hono<AppBindings>

function makeApp(ownerId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.use('*', async (c, next) => {
    c.set('userId', ownerId)
    c.set('user', {
      id: ownerId,
      username: 'owner',
      login: 'owner',
      name: 'Owner',
      avatarUrl: '',
      role: 'owner',
      createdAt: 0,
      settingsRaw: '{}',
    } as Variables['user'])
    await next()
  })
  instance.route('/api/webssh', websshRoutes)
  instance.onError((error, c) => errorResponse(c, error))
  return instance
}

function insertHost(hostId: string, ownerId: string, host = '127.0.0.1', port = 2222): void {
  sqlite.prepare(
    `INSERT INTO webssh_hosts
       (user_id, id, name, name_folded, host, port, username, auth_method, credential_id, key_id,
        encoding, term_type, initial_command, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'Local', 'local', ?, ?, 'testuser', 'password', '', '', 'utf-8', 'xterm-256color', '', 1, 1, NULL)`,
  ).run(ownerId, hostId, host, port)
}

function insertSession(ownerId: string, status: string, lastActivityAt: number): string {
  const id = newId()
  sqlite.prepare(
    `INSERT INTO webssh_sessions
       (id, user_id, host_id, status, client_ip_hash, user_agent_hash, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, '', '', ?, ?)`,
  ).run(id, ownerId, newId(), status, lastActivityAt, lastActivityAt)
  return id
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE webssh_hosts (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_folded TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      auth_method TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      encoding TEXT NOT NULL,
      term_type TEXT NOT NULL,
      initial_command TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE webssh_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      status TEXT NOT NULL,
      client_ip_hash TEXT NOT NULL DEFAULT '',
      user_agent_hash TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      connected_at INTEGER,
      ended_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      bytes_in INTEGER NOT NULL DEFAULT 0,
      bytes_out INTEGER NOT NULL DEFAULT 0,
      close_reason TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      recording_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE webssh_session_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE TABLE webssh_audit_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      host_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      ip_hash TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)
  db = makeD1(sqlite)
  env = {
    DB: db,
    WEBSSH_SESSION: testDurableObjectNamespace(() => new Response(null, { status: 101 })),
  } as Env
  userId = newId()
  app = makeApp(userId)
})

afterEach(async () => {
  // Audit writes are deliberately fire-and-forget on the request path; give them a moment before
  // the in-memory database closes so a late write is not reported as a failure.
  await new Promise((resolve) => setTimeout(resolve, 100))
  sqlite.close()
})

async function createSession(hostId: string): Promise<string> {
  const response = await app.request('https://notes.example.com/api/webssh/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId, cols: 120, rows: 40 }),
  }, env)
  expect(response.status).toBe(201)
  const body = await response.json() as { sessionId: string; status: string }
  expect(body.status).toBe('pending')
  return body.sessionId
}

describe('session creation', () => {
  it('creates a pending row for the owner', async () => {
    const hostId = newId()
    insertHost(hostId, userId)
    const sessionId = await createSession(hostId)
    const row = sqlite.prepare('SELECT status, host_id FROM webssh_sessions WHERE id = ?').get(sessionId) as { status: string; host_id: string }
    expect(row).toEqual({ status: 'pending', host_id: hostId })
  })

  it('answers 404 for another account\'s host and never inserts a row', async () => {
    const hostId = newId()
    insertHost(hostId, newId())
    const response = await app.request('https://notes.example.com/api/webssh/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostId }),
    }, env)
    expect(response.status).toBe(404)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM webssh_sessions').get()).toEqual({ count: 0 })
  })

  it('enforces three live sessions per account', async () => {
    const hostId = newId()
    insertHost(hostId, userId)
    insertSession(userId, 'active', Date.now())
    insertSession(userId, 'active', Date.now())
    insertSession(userId, 'pending', Date.now())
    const response = await app.request('https://notes.example.com/api/webssh/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostId }),
    }, env)
    expect(response.status).toBe(429)
    expect(response.json()).resolves.toMatchObject({ error: { code: 'too_many_attempts' } })
  })

  it('sweeps a stale pending row before counting', async () => {
    const hostId = newId()
    insertHost(hostId, userId)
    insertSession(userId, 'active', Date.now())
    insertSession(userId, 'active', Date.now())
    const staleId = insertSession(userId, 'pending', Date.now() - 21 * 60 * 1000)
    const response = await app.request('https://notes.example.com/api/webssh/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostId }),
    }, env)
    expect(response.status).toBe(201)
    const stale = sqlite.prepare('SELECT status, close_reason FROM webssh_sessions WHERE id = ?').get(staleId) as { status: string; close_reason: string }
    expect(stale).toEqual({ status: 'closed', close_reason: 'stale' })
  })
})

describe('tickets and origin binding', () => {
  it('mints a ticket and a finished same-origin URL', async () => {
    const hostId = newId()
    insertHost(hostId, userId)
    const sessionId = await createSession(hostId)
    const response = await app.request(`https://notes.example.com/api/webssh/sessions/${sessionId}/ticket`, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }, env)
    expect(response.status).toBe(200)
    const body = await response.json() as { ticket: string; url: string; expiresAt: number }
    expect(body.url).toContain(`/api/webssh/sessions/${sessionId}/ws?ticket=`)
    expect(body.url).toContain(encodeURIComponent(body.ticket))
    expect(body.expiresAt).toBeGreaterThan(Date.now())
  })

  it('refuses a ticket request from another origin', async () => {
    const hostId = newId()
    insertHost(hostId, userId)
    const sessionId = await createSession(hostId)
    const response = await app.request(`https://notes.example.com/api/webssh/sessions/${sessionId}/ticket`, {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    }, env)
    expect(response.status).toBe(403)
  })

  it('refuses a ticket once the session is no longer pending', async () => {
    const sessionId = insertSession(userId, 'active', Date.now())
    const response = await app.request(`https://notes.example.com/api/webssh/sessions/${sessionId}/ticket`, {
      method: 'POST',
      headers: { origin: ORIGIN },
    }, env)
    expect(response.status).toBe(409)
  })
})

describe('session status and ownership', () => {
  it('returns the owner view and hides another account', async () => {
    const sessionId = insertSession(userId, 'active', Date.now())
    const own = await app.request(`https://notes.example.com/api/webssh/sessions/${sessionId}`, {}, env)
    expect(own.status).toBe(200)
    expect(await own.json()).toMatchObject({ id: sessionId, status: 'active' })

    const other = makeApp(newId())
    const hidden = await other.request(`https://notes.example.com/api/webssh/sessions/${sessionId}`, {}, env)
    expect(hidden.status).toBe(404)
  })
})

describe('upgrade preconditions', () => {
  it('rejects a non-upgrade request and an invalid ticket with an audit row', async () => {
    const hostId = newId()
    insertHost(hostId, userId)
    const sessionId = await createSession(hostId)
    const plain = await app.request(`https://notes.example.com/api/webssh/sessions/${sessionId}/ws?ticket=x`, {}, env)
    expect(plain.status).toBe(400)

    const upgrade = await app.request(`https://notes.example.com/api/webssh/sessions/${sessionId}/ws?ticket=not-a-ticket`, {
      headers: { upgrade: 'websocket', origin: ORIGIN },
    }, env)
    expect(upgrade.status).toBe(404)

    await new Promise((resolve) => setTimeout(resolve, 50))
    let audit: { event_type: string; metadata: string } | undefined
    // Audit writes are fire-and-forget on the request path; poll briefly instead of assuming the
    // write lands within one scheduling tick under a loaded full-suite run.
    for (let attempt = 0; attempt < 40 && !audit; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      audit = sqlite.prepare(
        `SELECT event_type, metadata FROM webssh_audit_events
          WHERE session_id = ? AND event_type = 'ticket_rejected'
          ORDER BY created_at DESC LIMIT 1`,
      ).get(sessionId) as { event_type: string; metadata: string } | undefined
    }
    expect(audit?.event_type).toBe('ticket_rejected')
    expect(JSON.parse(audit?.metadata ?? '{}')).toMatchObject({ reason: 'missing' })
  })
})
