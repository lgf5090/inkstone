// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import { projectWebhookEvent, projectWebhookRetryDelay } from '../src/shared/project/integrations'
import type { Env } from '../src/worker/env'
import type { ProjectBoard } from '../src/shared/project/model'
import { drainProjectWebhookDeliveries, enqueueProjectWebhookEvents } from '../src/worker/project/webhooks'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
const tokens = new Map<string, string>()
let sqlite: DatabaseSync
let env: Env

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const account of ['alice', 'bob']) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, 'member', ?, ?)`,
    ).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_webhook_deliveries; DELETE FROM project_webhooks; DELETE FROM project_api_tokens;
    DELETE FROM project_views; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_settings`)
})

afterEach(() => { vi.unstubAllGlobals() })

interface CallOptions { account?: string | null, bearer?: string, body?: unknown }

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.account) headers.Cookie = `${LEGACY_SESSION_COOKIE}=${tokens.get(options.account)}`
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, {
    method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), env)
}

async function createBoard(account = 'alice'): Promise<ProjectBoard> {
  const response = await call('POST', '/boards', { account, body: {} })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function createToken(boardId = ''): Promise<{ id: string, secret: string }> {
  const response = await call('POST', '/tokens', {
    account: 'alice', body: { name: 'CI', scope: 'write', boardId },
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const body = (await response.json()) as { token: { id: string }, secret: string }
  return { id: body.token.id, secret: body.secret }
}

describe('project API tokens', () => {
  it('shows the secret once and stores only its hash', async () => {
    const { secret } = await createToken()
    expect(secret).toMatch(/^pj_[A-Za-z0-9_-]{43}$/)
    const row = sqlite.prepare('SELECT token_hash FROM project_api_tokens').get() as { token_hash: string }
    expect(row.token_hash).toHaveLength(64)
    expect(row.token_hash).not.toContain(secret)
    const list = await call('GET', '/tokens', { account: 'alice' })
    expect(await list.text()).not.toContain(secret)
  })

  it('authenticates a board-scoped machine client and refuses other boards', async () => {
    const board = await createBoard()
    const other = await createBoard()
    const { secret } = await createToken(board.id)
    expect((await call('GET', `/boards/${board.id}/bundle`, { bearer: secret })).status).toBe(200)
    expect((await call('GET', `/boards/${other.id}/bundle`, { bearer: secret })).status).toBe(404)
    expect((await call('GET', '/boards', { bearer: secret })).status).toBe(404)
  })

  it('enforces the read scope and keeps management endpoints session-only', async () => {
    const board = await createBoard()
    const response = await call('POST', '/tokens', {
      account: 'alice', body: { name: 'reader', scope: 'read', boardId: board.id },
    })
    expect(response.status).toBe(201)
    const secret = ((await response.json()) as { secret: string }).secret
    expect((await call('GET', `/boards/${board.id}/bundle`, { bearer: secret })).status).toBe(200)
    expect((await call('POST', `/boards/${board.id}/cards`, { bearer: secret, body: { title: 'x' } })).status).toBe(403)
    expect((await call('GET', '/tokens', { bearer: secret })).status).toBe(403)
    expect((await call('GET', `/boards/${board.id}/webhooks`, { bearer: secret })).status).toBe(403)
  })

  it('stops accepting a revoked or expired token', async () => {
    const board = await createBoard()
    const { id, secret } = await createToken(board.id)
    expect((await call('DELETE', `/tokens/${id}`, { account: 'alice' })).status).toBe(200)
    expect((await call('GET', `/boards/${board.id}/bundle`, { bearer: secret })).status).toBe(401)
    const expired = await call('POST', '/tokens', {
      account: 'alice', body: { name: 'old', scope: 'read', expiresAt: 1 },
    })
    const oldSecret = ((await expired.json()) as { secret: string }).secret
    expect((await call('GET', `/boards/${board.id}/bundle`, { bearer: oldSecret })).status).toBe(401)
  })

  it('refuses a board the caller cannot administer and a missing session', async () => {
    const board = await createBoard('bob')
    expect((await call('POST', '/tokens', {
      account: 'alice', body: { name: 'x', scope: 'read', boardId: board.id },
    })).status).toBe(404)
    expect((await call('GET', '/tokens')).status).toBe(401)
  })
})

describe('project webhooks', () => {
  it('refuses non-HTTPS, credential-bearing and private targets', async () => {
    const board = await createBoard()
    for (const url of ['http://example.com/hook', 'https://127.0.0.1/hook', 'https://localhost/hook', 'https://user:pw@example.com/hook']) {
      const response = await call('POST', `/boards/${board.id}/webhooks`, { account: 'alice', body: { url } })
      expect(response.status, url).toBe(400)
    }
    expect((await call('POST', `/boards/${board.id}/webhooks`, {
      account: 'alice', body: { url: 'https://example.com/hook' },
    })).status).toBe(201)
  })

  it('never returns the signing secret after creation', async () => {
    const board = await createBoard()
    const response = await call('POST', `/boards/${board.id}/webhooks`, {
      account: 'alice', body: { url: 'https://example.com/hook', events: ['card.created'] },
    })
    const created = (await response.json()) as { secret: string }
    expect(created.secret).toMatch(/^whsec_/)
    const list = await call('GET', `/boards/${board.id}/webhooks`, { account: 'alice' })
    const body = (await list.json()) as { webhooks: { events: string[], pending: number }[] }
    expect(JSON.stringify(body)).not.toContain(created.secret)
    expect(body.webhooks[0]!.events).toEqual(['card.created'])
  })

  it('queues only matching events and retries a failed delivery', async () => {
    const board = await createBoard()
    await call('POST', `/boards/${board.id}/webhooks`, {
      account: 'alice', body: { url: 'https://example.com/hook', events: ['card.created'] },
    })
    const now = Date.now()
    const payload = { boardId: board.id, event: 'card.created' as const, targetId: 'c1', method: 'POST', path: '/cards', at: now }
    expect(await enqueueProjectWebhookEvents(env.DB, board.id, 'card.deleted', payload, now)).toEqual([])
    const ids = await enqueueProjectWebhookEvents(env.DB, board.id, 'card.created', payload, now)
    expect(ids).toHaveLength(1)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await drainProjectWebhookDeliveries(env.DB, now)).toBe(1)
    const pending = sqlite.prepare('SELECT attempts, status, next_attempt_at FROM project_webhook_deliveries WHERE id = ?').get(ids[0]) as { attempts: number, status: string, next_attempt_at: number }
    expect(pending.status).toBe('pending')
    expect(pending.attempts).toBe(1)
    expect(pending.next_attempt_at).toBeGreaterThan(now)
    expect(projectWebhookRetryDelay(1)).toBe(60_000)
  })

  it('marks a successful delivery and signs the body', async () => {
    const board = await createBoard()
    await call('POST', `/boards/${board.id}/webhooks`, {
      account: 'alice', body: { url: 'https://example.com/hook' },
    })
    const now = Date.now()
    const payload = { boardId: board.id, event: 'board.changed' as const, targetId: board.id, method: 'PATCH', path: '/boards/x', at: now }
    const ids = await enqueueProjectWebhookEvents(env.DB, board.id, 'board.changed', payload, now)
    const outgoing = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', outgoing)
    expect(await drainProjectWebhookDeliveries(env.DB, now)).toBe(1)
    const row = sqlite.prepare('SELECT status FROM project_webhook_deliveries WHERE id = ?').get(ids[0]) as { status: string }
    expect(row.status).toBe('delivered')
    const [, init] = outgoing.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect((init.headers as Record<string, string>)['webhook-signature']).toMatch(/^v1,/)
  })

  it('derives the event name from the write that produced it', () => {
    expect(projectWebhookEvent('POST', '/api/project/boards/b1/cards')).toBe('card.created')
    expect(projectWebhookEvent('PATCH', '/api/project/cards/c1')).toBe('card.updated')
    expect(projectWebhookEvent('DELETE', '/api/project/cards/c1')).toBe('card.deleted')
    expect(projectWebhookEvent('POST', '/api/project/cards/c1/comments')).toBe('board.changed')
  })
})
