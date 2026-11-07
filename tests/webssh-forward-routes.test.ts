// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import type { AppBindings, Env, Variables } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { websshRoutes } from '../src/worker/webssh/routes'
import { WEBSSH_FORWARD_TTL_MS } from '../src/worker/webssh/constants'
import { isForwardMethod, isLoopbackTargetHost, normalizeForwardHost, normalizeForwardPort } from '../src/worker/webssh/forwarding/proxy'

const ORIGIN = 'https://notes.example.com'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let userId: string
let app: Hono<AppBindings>
let doRequests: Array<{ url: URL; body: Record<string, unknown> }>
let doResponse: ((body: Record<string, unknown>) => Response) | null

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

function insertSession(id: string, ownerId: string, status: string): void {
  sqlite.prepare(
    `INSERT INTO webssh_sessions
       (id, user_id, host_id, status, client_ip_hash, user_agent_hash, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, '', '', 1, 1)`,
  ).run(id, ownerId, newId(), status)
}

function insertHost(id: string, ownerId: string): void {
  sqlite.prepare(
    `INSERT INTO webssh_hosts
       (user_id, id, name, name_folded, host, port, username, created_at, updated_at)
     VALUES (?, ?, 'Host', 'host', '203.0.113.10', 22, 'root', 1, 1)`,
  ).run(ownerId, id)
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(app.request(`${ORIGIN}${path}`, init, env))
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

beforeEach(() => {
  doRequests = []
  doResponse = null
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
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
    CREATE TABLE webssh_hosts (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_folded TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE webssh_forward_rules (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      host_id TEXT NOT NULL,
      target_host TEXT NOT NULL,
      target_port INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'trusted',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
  `)
  db = makeD1(sqlite)
  userId = newId()
  app = makeApp(userId)
  env = testBindings(db, {
    WEBSSH_SESSION: testDurableObjectNamespace(async (incoming) => {
      if (incoming.url.includes('/internal/forward/proxy')) {
        doRequests.push({ url: new URL(incoming.url), body: {} })
        return new Response('proxied', {
          status: 200,
          headers: { 'content-type': 'text/plain', 'x-webssh-forward-path': incoming.headers.get('x-webssh-forward-path') ?? '' },
        })
      }
      const body = await incoming.json() as Record<string, unknown>
      doRequests.push({ url: new URL(incoming.url), body })
      if (doResponse) return doResponse(body)
      return Response.json({ grants: [] })
    }),
  })
})

describe('forward target rules', () => {
  it('accepts only loopback targets and well-formed ports', () => {
    expect(isLoopbackTargetHost('127.0.0.1')).toBe(true)
    expect(isLoopbackTargetHost('LOCALHOST')).toBe(true)
    expect(isLoopbackTargetHost('::1')).toBe(true)
    expect(isLoopbackTargetHost('10.0.0.1')).toBe(false)
    expect(normalizeForwardHost(' 127.0.0.1 ')).toBe('127.0.0.1')
    expect(normalizeForwardHost('bad\nhost')).toBeNull()
    expect(normalizeForwardPort('8080')).toBe(8080)
    expect(normalizeForwardPort(0)).toBeNull()
    expect(normalizeForwardPort(65536)).toBeNull()
    expect(isForwardMethod('PATCH')).toBe(true)
    expect(isForwardMethod('TRACE')).toBe(false)
    expect(WEBSSH_FORWARD_TTL_MS).toBe(8 * 60 * 1000)
  })
})

describe('forward rule CRUD', () => {
  it('creates, lists and deletes a rule for the owner', async () => {
    const hostId = newId()
    insertHost(hostId, userId)
    const created = await request('/api/webssh/forward/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Docs', hostId, targetHost: '127.0.0.1', targetPort: 8080 }),
    })
    expect(created.status).toBe(201)
    const rule = (await json(created)).rule as Record<string, unknown>
    expect(rule).toMatchObject({ name: 'Docs', targetHost: '127.0.0.1', targetPort: 8080, mode: 'trusted' })

    const listed = await request(`/api/webssh/forward/rules?hostId=${hostId}`)
    expect(listed.status).toBe(200)
    expect(((await json(listed)).items as unknown[])).toHaveLength(1)

    const removed = await request(`/api/webssh/forward/rules/${rule.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await json(removed)).ok).toBe(true)
  })

  it('refuses a non-loopback rule unless the dev switch is on', async () => {
    const hostId = newId()
    insertHost(hostId, userId)
    const response = await request('/api/webssh/forward/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Public', hostId, targetHost: '192.0.2.5', targetPort: 80 }),
    })
    expect(response.status).toBe(403)
    expect((await json(response)).error).toMatchObject({ code: 'forward_blocked' })
  })

  it('answers 404 for another account host', async () => {
    const hostId = newId()
    insertHost(hostId, newId())
    const response = await request('/api/webssh/forward/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Docs', hostId, targetHost: '127.0.0.1', targetPort: 8080 }),
    })
    expect(response.status).toBe(404)
  })
})

describe('forward session routes', () => {
  it('answers 404 for an unknown or foreign session', async () => {
    const unknown = await request(`/api/webssh/sessions/${newId()}/forward`)
    expect(unknown.status).toBe(404)
    const foreign = newId()
    insertSession(foreign, newId(), 'active')
    const other = await request(`/api/webssh/sessions/${foreign}/forward`)
    expect(other.status).toBe(404)
  })

  it('answers 409 before the session is active', async () => {
    const id = newId()
    insertSession(id, userId, 'pending')
    const response = await request(`/api/webssh/sessions/${id}/forward`)
    expect(response.status).toBe(409)
  })

  it('hands creation to the session runtime and returns its grant', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    doResponse = () => Response.json({
      grant: {
        token: newId(),
        sessionId: id,
        hostId: 'host',
        targetHost: '127.0.0.1',
        targetPort: 8080,
        url: `/api/webssh/sessions/${id}/forward/token/`,
        createdAt: 1,
        expiresAt: 2,
        requests: 0,
      },
    }, { status: 201 })
    const response = await request(`/api/webssh/sessions/${id}/forward`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', port: 8080 }),
    })
    expect(response.status).toBe(201)
    expect(doRequests[0]?.body).toMatchObject({ op: 'create', host: '127.0.0.1', port: 8080 })
    expect((await json(response)).grant).toMatchObject({ targetHost: '127.0.0.1', targetPort: 8080 })
  })

  it('proxies the HTTP path and query to the session runtime', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    const token = newId()
    const response = await request(`/api/webssh/sessions/${id}/forward/${token}/assets/app.js?v=1`, {
      method: 'GET',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('proxied')
    expect(doRequests[0]?.url.searchParams.get('t')).toBe(token)
  })

  it('rejects WebSocket upgrades with 405', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    const token = newId()
    const upgrade = await request(`/api/webssh/sessions/${id}/forward/${token}/`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(upgrade.status).toBe(405)
  })
})
