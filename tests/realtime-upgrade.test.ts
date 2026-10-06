// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, it } from 'vitest'
import worker from '../src/worker/index'
import { hashToken } from '../src/worker/lib/session-store'
import { makeD1 } from './doubles/d1-sqlite'
import type { Env } from '../src/worker/env'

const ORIGIN = 'https://inkstone.test'
const sessionToken = 'b'.repeat(64)
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never

let sqlite: DatabaseSync
let env: Env
const hubCalls: string[] = []

const upgradeAccepted = () =>
  ({
    status: 101,
    statusText: 'Switching Protocols',
    headers: new Headers({ 'X-Sync-Hub': 'accepted' }),
    body: null,
  }) as unknown as Response

async function drive(path: string, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      headers: {
        'X-Inkstone-Client': '1',
        Cookie: `inkstone_session=${sessionToken}`,
        ...headers,
      },
    }),
    env,
    ctx,
  )
}

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = {
    DB: makeD1(sqlite),
    ASSETS: { fetch: async () => new Response('ok') },
    SYNC_HUB: {
      idFromName: (name: string) => `hub:${name}`,
      get: () => ({
        fetch: async (request: Request | string) => {
          hubCalls.push(typeof request === 'string' ? request : request.url)
          return upgradeAccepted()
        },
      }),
    },
  } as unknown as Env
  await worker.fetch(
    new Request(`${ORIGIN}/api/health`, { headers: { 'X-Inkstone-Client': '1' } }),
    env,
    ctx,
  )
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES ('user', 'owner', 'hash', 'owner', 'Owner', '', 'owner', '{}', ?, ?)`,
  ).run(now, now)
  sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(await hashToken(sessionToken), 'user', now + 600_000, now)
})

it('hands the realtime WebSocket upgrade through to the browser untouched', async () => {
  hubCalls.length = 0
  const response = await drive('/api/sync/ws', {
    Origin: ORIGIN,
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
  })
  expect(hubCalls).toEqual(['https://sync-hub.internal/connect'])
  expect(response.status).toBe(101)
  expect(response.headers.get('X-Sync-Hub')).toBe('accepted')
})

it('still decorates ordinary API responses with the security headers', async () => {
  const response = await drive('/api/health')
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  expect(response.headers.get('Cache-Control')).toBe('no-store')
})

it('answers a realtime request without an upgrade as a normal error response', async () => {
  const response = await drive('/api/sync/ws', { Origin: ORIGIN })
  expect(response.status).toBe(400)
  expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
})

it('rejects a cross-origin realtime upgrade before reaching the hub', async () => {
  hubCalls.length = 0
  const response = await drive('/api/sync/ws', {
    Origin: 'https://attacker.example',
    Upgrade: 'websocket',
  })
  expect(response.status).toBe(403)
  expect(hubCalls).toEqual([])
})
