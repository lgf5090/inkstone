// @vitest-environment node
// The AI surface's HTTP contract: ownership, bounds and the two answers that need no model call.
// A real SQLite database is used so the queries are the production ones.

import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import type { AppBindings, Env, Variables } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { websshRoutes } from '../src/worker/webssh/routes'

const ORIGIN = 'https://notes.example.com'

let sqlite: DatabaseSync
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

function insertHost(hostId: string, ownerId: string): void {
  sqlite.prepare(
    `INSERT INTO webssh_hosts
       (user_id, id, name, name_folded, host, port, username, auth_method, credential_id, key_id,
        encoding, term_type, initial_command, tags, notes, favorite, sort_order, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'Web 01', 'web 01', '192.0.2.10', 22, 'deploy', 'password', '', '',
             'utf-8', 'xterm-256color', '', '[]', '', 0, 0, 1, 1, NULL)`,
  ).run(ownerId, hostId)
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
      tags TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      sort_order REAL NOT NULL DEFAULT 0,
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
    CREATE TABLE webssh_ai_summaries (
      user_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      highlights TEXT NOT NULL DEFAULT '[]',
      open_issues TEXT NOT NULL DEFAULT '[]',
      next_steps TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, host_id, kind)
    );
  `)
  env = { DB: makeD1(sqlite) } as Env
  userId = newId()
  app = makeApp(userId)
})

afterEach(() => {
  sqlite.close()
})

async function post(path: string, body: unknown): Promise<Response> {
  return await app.request(`${ORIGIN}/api/webssh/ai${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

describe('AI route validation', () => {
  it('refuses an empty command request before spending a model', async () => {
    const response = await post('/command', { prompt: '' })
    expect(response.status).toBe(400)
  })

  it('answers 404 for a host the caller does not own', async () => {
    const foreignHost = newId()
    insertHost(foreignHost, newId())
    const response = await post('/command', { prompt: 'list files', hostId: foreignHost })
    expect(response.status).toBe(404)
  })

  it('answers 404 for a session the caller does not own', async () => {
    const response = await post('/diagnose', {
      command: 'ls',
      transcript: 'ls: cannot access',
      sessionId: newId(),
    })
    expect(response.status).toBe(404)
  })

  it('refuses an empty summary and a question without text', async () => {
    expect((await post('/summary', { transcript: '' })).status).toBe(400)
    expect((await post('/file', { path: '/var/log/app.log', content: 'line', mode: 'question' })).status).toBe(400)
  })

  it('refuses a recording search without a query', async () => {
    const response = await post('/recording-search', { sessionId: newId(), query: '' })
    expect(response.status).toBe(400)
  })

  it('rejects an invalid handoff host id', async () => {
    const response = await app.request(`${ORIGIN}/api/webssh/ai/handoff?hostId=${encodeURIComponent('../x')}`, {}, env)
    expect(response.status).toBe(400)
  })

  it('answers null when no handoff exists for an owned host', async () => {
    const hostId = newId()
    insertHost(hostId, userId)
    const response = await app.request(`${ORIGIN}/api/webssh/ai/handoff?hostId=${hostId}`, {}, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ handoff: null })
  })

  it('summarises an empty audit window without calling a model', async () => {
    const response = await post('/audit-summary', { days: 7 })
    expect(response.status).toBe(200)
    const body = await response.json() as { overview: string, anomalies: unknown[], model: string }
    expect(body.anomalies).toEqual([])
    expect(body.overview).toBe('')
    expect(body.model).toBe('')
  })
})
