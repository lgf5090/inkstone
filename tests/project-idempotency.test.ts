// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard } from '../src/shared/project/model'
import { claimProjectWriteReceipt, pruneProjectWriteReceipts } from '../src/worker/project/idempotency'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
let token = ''
let bobToken = ''
let sqlite: DatabaseSync
let env: Env

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
     VALUES ('alice', 'alice', 'hash', 'alice', 'alice', 'member', ?, ?)`,
  ).run(now, now)
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
     VALUES ('bob', 'bob', 'hash', 'bob', 'bob', 'member', ?, ?)`,
  ).run(now, now)
  token = await createSession(env.DB, 'alice')
  bobToken = await createSession(env.DB, 'bob')
})

beforeEach(() => {
  sqlite.exec('DELETE FROM project_write_receipts; DELETE FROM project_board_members; DELETE FROM project_cards; DELETE FROM project_boards; DELETE FROM project_views')
})

async function call(method: string, path: string, options: { key?: string, body?: unknown, who?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${options.who ?? token}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (options.key) headers['Idempotency-Key'] = options.key
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, {
    method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), env)
}

async function board(): Promise<ProjectBoard> {
  const response = await call('POST', '/boards', { body: {} })
  expect(response.status).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

function cardCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS count FROM project_cards').get() as { count: number }).count
}

function receiptCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS count FROM project_write_receipts').get() as { count: number }).count
}

describe('project write idempotency', () => {
  it('returns the first answer again instead of creating a second card', async () => {
    const target = await board()
    const first = await call('POST', `/boards/${target.id}/cards`, { key: 'pw_abcdefgh123', body: { title: 'One' } })
    expect(first.status).toBe(201)
    const firstBody = await first.json() as { card: { id: string } }
    const replay = await call('POST', `/boards/${target.id}/cards`, { key: 'pw_abcdefgh123', body: { title: 'One' } })
    expect(replay.status).toBe(201)
    expect((await replay.json()) as { card: { id: string } }).toEqual(firstBody)
    expect(cardCount()).toBe(1)
  })

  it('ignores a malformed key and scopes valid keys to the account', async () => {
    const target = await board()
    expect((await call('POST', `/boards/${target.id}/cards`, { key: '../bad', body: { title: 'A' } })).status).toBe(201)
    expect((await call('POST', `/boards/${target.id}/cards`, { key: '../bad', body: { title: 'A' } })).status).toBe(201)
    expect(cardCount()).toBe(2)
    expect((await call('POST', `/boards/${target.id}/cards`, { key: 'pw_another123', body: { title: 'B' } })).status).toBe(201)
    expect(cardCount()).toBe(3)
    const rows = sqlite.prepare('SELECT key FROM project_write_receipts').all() as { key: string }[]
    expect(rows.map((row) => row.key)).toEqual(['pw_another123'])
  })

  it('rejects reusing a key for a different request', async () => {
    const target = await board()
    const first = await call('POST', `/boards/${target.id}/cards`, { key: 'pw_bound_request_123', body: { title: 'First' } })
    expect(first.status).toBe(201)
    const conflict = await call('POST', `/boards/${target.id}/cards`, { key: 'pw_bound_request_123', body: { title: 'Second' } })
    expect(conflict.status).toBe(409)
    expect(cardCount()).toBe(1)
  })

  it('rechecks resource access before replaying a completed write', async () => {
    const target = await board()
    await call('POST', `/boards/${target.id}/members`, { body: { username: 'bob', role: 'editor' } })
    const created = await call('POST', `/boards/${target.id}/cards`, { body: { title: 'Private' } })
    const card = ((await created.json()) as { card: { id: string } }).card
    const patched = await call('PATCH', `/cards/${card.id}`, { key: 'pw_revoked_access_123', body: { title: 'Edited' }, who: bobToken })
    expect(patched.status).toBe(200)
    await call('DELETE', `/boards/${target.id}/members/bob`)
    expect((await call('GET', `/cards/${card.id}`, { who: bobToken })).status).toBe(404)
    expect((await call('PATCH', `/cards/${card.id}`, { key: 'pw_revoked_access_123', body: { title: 'Edited' }, who: bobToken })).status).toBe(404)
  })

  it('claims a concurrent key so only one request executes', async () => {
    const target = await board()
    const [first, second] = await Promise.all([
      call('POST', `/boards/${target.id}/cards`, { key: 'pw_concurrent_123', body: { title: 'One' } }),
      call('POST', `/boards/${target.id}/cards`, { key: 'pw_concurrent_123', body: { title: 'One' } }),
    ])
    expect([first.status, second.status]).toEqual([201, 201])
    const firstBody = await first.json() as { card: { id: string } }
    const secondBody = await second.json() as { card: { id: string } }
    expect(secondBody.card.id).toBe(firstBody.card.id)
    expect(cardCount()).toBe(1)
  })

  it('does not leave a receipt for a rejected write', async () => {
    const target = await board()
    const response = await call('POST', `/boards/${target.id}/cards`, { key: 'pw_rejected_123', body: { values: { bad: 'x' } } })
    expect(response.status).toBe(400)
    expect(receiptCount()).toBe(0)
  })

  it('recovers a stale pending claim', async () => {
    const target = await board()
    const key = 'pw_stale_claim_123'
    await claimProjectWriteReceipt(env.DB, 'alice', key, {
      method: 'POST', path: `/api/project/boards/${target.id}/cards`, bodyHash: 'stale', boardId: target.id,
      requiredRole: 'editor', ownerRequired: false,
    }, 1)
    const response = await call('POST', `/boards/${target.id}/cards`, { key, body: { title: 'Recovered' } })
    expect(response.status).toBe(201)
    expect(cardCount()).toBe(1)
  })

  it('does not record failed writes and prunes old receipts', async () => {
    const before = sqlite.prepare('SELECT COUNT(*) AS count FROM project_write_receipts').get() as { count: number }
    expect(before.count).toBe(0)
    sqlite.prepare('INSERT INTO project_write_receipts (user_id, key, status, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('alice', 'pw_old1234567', 200, '{}', 1)
    expect(await pruneProjectWriteReceipts(env.DB, Date.now())).toBe(1)
  })
})
