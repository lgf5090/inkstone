// @vitest-environment node
// The multi-region probe creates one short-lived Durable Object per candidate region and asks each
// to measure the target. The route is the only place that knows the requested hints.

import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WebsshEgressTestResponse } from '../src/shared/webssh/types'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { websshRoutes } from '../src/worker/webssh/routes'
import { makeD1 } from './doubles/d1-sqlite'
import { testDurableObjectNamespace } from './doubles/bindings'

let sqlite: DatabaseSync
let env: Env
let app: Hono<AppBindings>
let userId: string
let hostId: string
const hints: string[] = []

function makeApp(ownerId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.use('*', async (c, next) => {
    c.set('userId', ownerId)
    await next()
  })
  instance.route('/api/webssh', websshRoutes)
  instance.onError((error, c) => errorResponse(c, error))
  return instance
}

beforeEach(() => {
  hints.length = 0
  userId = newId()
  hostId = newId()
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
      egress TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE webssh_settings (
      user_id TEXT PRIMARY KEY,
      settings TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
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
  sqlite.prepare(
    `INSERT INTO webssh_hosts
       (user_id, id, name, name_folded, host, port, username, auth_method, credential_id, key_id,
        encoding, term_type, initial_command, egress, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'Probe', 'probe', '127.0.0.1', 2222, 'testuser', 'password', '', '', 'utf-8',
             'xterm-256color', '', '{}', 1, 1, NULL)`,
  ).run(userId, hostId)
  sqlite.prepare(
    `INSERT INTO webssh_settings (user_id, settings, updated_at)
     VALUES (?, ?, 1)`,
  ).run(userId, JSON.stringify({ egress: { regionCandidates: ['apac', 'weur', 'enam'] } }))

  const namespace = testDurableObjectNamespace(
    (request) => {
      const url = new URL(request.url)
      const region = url.searchParams.get('r') ?? ''
      return Response.json({ region, ok: true, steps: [{ phase: 'dns', ok: true, elapsedMs: 3 }] })
    },
    { onGet: (_id, options) => hints.push(options?.locationHint ?? '') },
  )
  env = { DB: makeD1(sqlite), WEBSSH_SESSION: namespace } as Env
  app = makeApp(userId)
})

async function probe(body: Record<string, unknown>): Promise<Response> {
  return await app.request(`https://notes.example.com/api/webssh/hosts/${hostId}/egress-test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

describe('egress probe route', () => {
  it('probes the requested regions in order and audits each result', async () => {
    const response = await probe({ regions: ['apac', 'weur'] })
    expect(response.status).toBe(200)
    const payload = await response.json() as WebsshEgressTestResponse
    expect(payload.results.map((result) => result.region)).toEqual(['apac', 'weur'])
    expect(hints).toEqual(['apac', 'weur'])
    await new Promise((resolve) => setTimeout(resolve, 50))
    const rows = sqlite.prepare(
      `SELECT metadata FROM webssh_audit_events WHERE event_type = 'egress_test' ORDER BY created_at, metadata`,
    ).all() as Array<{ metadata: string }>
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ region: 'apac', ok: true })
  })

  it('expands auto to the account candidates', async () => {
    const response = await probe({ regions: ['auto'] })
    expect(response.status).toBe(200)
    expect(hints).toEqual(['apac', 'weur', 'enam'])
  })

  it('refuses a relay mode instead of probing silently', async () => {
    sqlite.prepare(`UPDATE webssh_hosts SET egress = ? WHERE user_id = ? AND id = ?`)
      .run(JSON.stringify({ mode: 'socks5' }), userId, hostId)
    const response = await probe({ regions: ['apac'] })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'egress_mode_unavailable' } })
  })
})
