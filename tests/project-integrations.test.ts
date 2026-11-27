// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import { projectWebhookEvent, projectWebhookRetryDelay } from '../src/shared/project/integrations'
import type { Env } from '../src/worker/env'
import type { ProjectBoard } from '../src/shared/project/model'
import { drainProjectWebhookDeliveries, encryptLegacyProjectWebhookSecrets, enqueueProjectWebhookEvents } from '../src/worker/project/webhooks'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'
import { CredentialVault } from '../src/worker/durable/credential-vault'

const app = createApp()
const tokens = new Map<string, string>()
let sqlite: DatabaseSync
let env: Env
let vaultStorage: Map<string, unknown>

function fakeVaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) { return vaultStorage.get(key) },
      async put(key: string, value: unknown) { vaultStorage.set(key, value) },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return await fn() },
  } as unknown as DurableObjectState
}

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  vaultStorage = new Map<string, unknown>()
  env = testBindings(makeD1(sqlite), {
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
  })
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
    DELETE FROM project_external_links; DELETE FROM project_integrations;
    DELETE FROM project_card_relations; DELETE FROM project_property_configs; DELETE FROM project_card_values;
    DELETE FROM project_cards; DELETE FROM project_properties; DELETE FROM project_views; DELETE FROM project_board_members;
    DELETE FROM project_boards; DELETE FROM project_settings`)
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

  it('does not let a board token move or relate a card into another board', async () => {
    const board = await createBoard()
    const other = await createBoard()
    const card = ((await (await call('POST', `/boards/${board.id}/cards`, { account: 'alice', body: { title: 'Scoped' } })).json()) as { card: { id: string } }).card
    const otherCard = ((await (await call('POST', `/boards/${other.id}/cards`, { account: 'alice', body: { title: 'Other' } })).json()) as { card: { id: string } }).card
    const { secret } = await createToken(board.id)
    expect((await call('POST', `/cards/${card.id}/move`, { bearer: secret, body: { targetBoardId: other.id } })).status).toBe(404)

    const relationId = 'p00000000000000000000000001'
    sqlite.prepare(`INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at)
      VALUES (?, ?, 'Related', 'relation', '[]', 0, 1, 1)`).run(board.id, relationId)
    sqlite.prepare('INSERT INTO project_property_configs (board_id, property_id, config, updated_at) VALUES (?, ?, ?, 1)')
      .run(board.id, relationId, JSON.stringify({ targetBoardId: other.id, multiple: true }))
    expect((await call('POST', `/boards/${board.id}/cards`, {
      bearer: secret, body: { title: 'Cross-board relation', values: { [relationId]: JSON.stringify([otherCard.id]) } },
    })).status).toBe(404)
  })

  it('keeps account-wide token operations away from high-risk session routes', async () => {
    const board = await createBoard()
    const { secret } = await createToken()
    expect((await call('DELETE', `/boards/${board.id}`, { bearer: secret })).status).toBe(403)
    expect((await call('GET', '/export', { bearer: secret })).status).toBe(403)
    expect((await call('PUT', `/boards/${board.id}/share`, { bearer: secret, body: {} })).status).toBe(403)
    expect((await call('POST', `/boards/${board.id}/members`, { bearer: secret, body: { username: 'bob', role: 'viewer' } })).status).toBe(403)
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
    const stored = sqlite.prepare('SELECT secret FROM project_webhooks').get() as { secret: string }
    expect(stored.secret).toMatch(/^v1\./)
    expect(stored.secret).not.toContain(created.secret)
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
    expect(await drainProjectWebhookDeliveries(env.DB, env, now)).toBe(1)
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
    expect(await drainProjectWebhookDeliveries(env.DB, env, now)).toBe(1)
    const row = sqlite.prepare('SELECT status FROM project_webhook_deliveries WHERE id = ?').get(ids[0]) as { status: string }
    expect(row.status).toBe('delivered')
    const [, init] = outgoing.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect((init.headers as Record<string, string>)['webhook-signature']).toMatch(/^v1,/)
  })

  it('claims a delivery once across concurrent drains', async () => {
    const board = await createBoard()
    await call('POST', `/boards/${board.id}/webhooks`, { account: 'alice', body: { url: 'https://example.com/hook' } })
    const now = Date.now()
    const payload = { boardId: board.id, event: 'board.changed' as const, targetId: board.id, method: 'PATCH', path: '/boards/x', at: now }
    await enqueueProjectWebhookEvents(env.DB, board.id, 'board.changed', payload, now)
    const outgoing = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', outgoing)
    const counts = await Promise.all([
      drainProjectWebhookDeliveries(env.DB, env, now),
      drainProjectWebhookDeliveries(env.DB, env, now),
    ])
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1)
    expect(outgoing).toHaveBeenCalledTimes(1)
  })

  it('keeps one message id across retries and prunes old terminal rows', async () => {
    const board = await createBoard()
    await call('POST', `/boards/${board.id}/webhooks`, { account: 'alice', body: { url: 'https://example.com/hook' } })
    const now = Date.now()
    const payload = { boardId: board.id, event: 'board.changed' as const, targetId: board.id, method: 'PATCH', path: '/boards/x', at: now }
    const ids = await enqueueProjectWebhookEvents(env.DB, board.id, 'board.changed', payload, now)
    const outgoing = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', outgoing)
    expect(await drainProjectWebhookDeliveries(env.DB, env, now)).toBe(1)
    const first = sqlite.prepare('SELECT message_id, next_attempt_at FROM project_webhook_deliveries WHERE id = ?').get(ids[0]) as { message_id: string, next_attempt_at: number }
    expect(first.message_id).toBe(`msg_${ids[0]}`)
    expect(await drainProjectWebhookDeliveries(env.DB, env, first.next_attempt_at)).toBe(1)
    const firstHeaders = (outgoing.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    const secondHeaders = (outgoing.mock.calls[1]![1] as RequestInit).headers as Record<string, string>
    expect(secondHeaders['webhook-id']).toBe(firstHeaders['webhook-id'])
    sqlite.prepare('UPDATE project_webhook_deliveries SET created_at = ? WHERE id = ?').run(now - 8 * 24 * 60 * 60 * 1000, ids[0])
    expect(await drainProjectWebhookDeliveries(env.DB, env, now)).toBe(0)
    expect(sqlite.prepare('SELECT id FROM project_webhook_deliveries WHERE id = ?').get(ids[0])).toBeUndefined()
  })
})

describe('project native integrations', () => {
  it('stores provider credentials only in the vault and never returns them', async () => {
    const board = await createBoard()
    const token = 'ghp_native_integration_secret'
    const created = await call('POST', `/boards/${board.id}/integrations`, {
      account: 'alice',
      body: { provider: 'github', config: { token, owner: 'acme', repo: 'roadmap' } },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const createdPayload = (await created.json()) as { integration: { id: string, target: string } }
    const first = createdPayload.integration
    expect(first.target).toBe('acme/roadmap')
    expect(JSON.stringify(createdPayload)).not.toContain(token)

    const stored = sqlite.prepare('SELECT config_ciphertext FROM project_integrations WHERE id = ?').get(first.id) as { config_ciphertext: string }
    expect(stored.config_ciphertext).not.toContain(token)
    const list = await call('GET', `/boards/${board.id}/integrations`, { account: 'alice' })
    expect(list.status).toBe(200)
    expect(await list.text()).not.toContain(token)

    const replaced = await call('POST', `/boards/${board.id}/integrations`, {
      account: 'alice',
      body: { provider: 'github', config: { token: 'ghp_replacement', owner: 'acme', repo: 'roadmap' } },
    })
    expect(replaced.status).toBe(201)
    expect(((await replaced.json()) as { integration: { id: string } }).integration.id).toBe(first.id)
  })

  it('keeps the vault scope stable when the same provider is saved concurrently', async () => {
    const board = await createBoard()
    const responses = await Promise.all(['ghp_first', 'ghp_second'].map((token) => call('POST', `/boards/${board.id}/integrations`, {
      account: 'alice', body: { provider: 'github', config: { token, owner: 'acme', repo: 'roadmap' } },
    })))
    expect(responses.map((response) => response.status)).toEqual([201, 201])
    const card = ((await (await call('POST', `/boards/${board.id}/cards`, { account: 'alice', body: { title: 'Concurrent' } })).json()) as { card: { id: string } }).card
    const outgoing = vi.fn().mockResolvedValue(new Response(JSON.stringify({ number: 1, html_url: 'https://github.com/acme/roadmap/issues/1' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', outgoing)
    const created = await call('POST', `/cards/${card.id}/external-links/github`, { account: 'alice' })
    expect(created.status, await created.clone().text()).toBe(201)
    expect(outgoing).toHaveBeenCalledTimes(1)
    const headers = (outgoing.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(['Bearer ghp_first', 'Bearer ghp_second']).toContain(headers.authorization)
  })

  it('rejects insecure integration targets and keeps management session-only', async () => {
    const board = await createBoard()
    for (const body of [
      { provider: 'slack', config: { webhookUrl: 'http://example.com/hook' } },
      { provider: 'slack', config: { webhookUrl: 'https://127.0.0.1/hook' } },
      { provider: 'jira', config: { baseUrl: 'https://user:pw@example.com', email: 'a@example.com', token: 'secret', projectKey: 'OPS' } },
    ]) {
      const response = await call('POST', `/boards/${board.id}/integrations`, { account: 'alice', body })
      expect(response.status).toBe(400)
    }
    const { secret } = await createToken(board.id)
    expect((await call('GET', `/boards/${board.id}/integrations`, { bearer: secret })).status).toBe(403)
    expect((await call('POST', `/boards/${board.id}/integrations`, {
      bearer: secret, body: { provider: 'slack', config: { webhookUrl: 'https://example.com/hook' } },
    })).status).toBe(403)
  })

  it('creates one GitHub issue per card and syncs later card updates', async () => {
    const board = await createBoard()
    await call('POST', `/boards/${board.id}/integrations`, {
      account: 'alice', body: { provider: 'github', config: { token: 'ghp_secret', owner: 'acme', repo: 'roadmap' } },
    })
    const card = ((await (await call('POST', `/boards/${board.id}/cards`, { account: 'alice', body: { title: 'Ship it' } })).json()) as { card: { id: string } }).card
    const outgoing = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/acme/roadmap/issues/42' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    })))
    vi.stubGlobal('fetch', outgoing)
    const first = await call('POST', `/cards/${card.id}/external-links/github`, { account: 'alice' })
    expect(first.status, await first.clone().text()).toBe(201)
    const link = ((await first.json()) as { link: { externalId: string, externalUrl: string } }).link
    expect(link.externalId).toBe('42')
    expect(link.externalUrl).toBe('https://github.com/acme/roadmap/issues/42')
    const second = await call('POST', `/cards/${card.id}/external-links/github`, { account: 'alice' })
    expect(second.status).toBe(201)
    expect(outgoing).toHaveBeenCalledTimes(1)

    const patched = await call('PATCH', `/cards/${card.id}`, { account: 'alice', body: { title: 'Ship it later' } })
    expect(patched.status, await patched.clone().text()).toBe(200)
    await vi.waitFor(() => expect(outgoing).toHaveBeenCalledTimes(2))
    const [url, init] = outgoing.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/acme/roadmap/issues/42')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toMatchObject({ title: 'Ship it later' })
    await vi.waitFor(async () => {
      const listed = await call('GET', `/cards/${card.id}/external-links`, { account: 'alice' })
      expect(JSON.stringify(await listed.json())).toContain('Ship it later')
    })
  })

  it('does not create duplicate external issues while one request is pending', async () => {
    const board = await createBoard()
    await call('POST', `/boards/${board.id}/integrations`, {
      account: 'alice', body: { provider: 'github', config: { token: 'ghp_secret', owner: 'acme', repo: 'roadmap' } },
    })
    const card = ((await (await call('POST', `/boards/${board.id}/cards`, { account: 'alice', body: { title: 'Once' } })).json()) as { card: { id: string } }).card
    let release!: (response: Response) => void
    const outgoing = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { release = resolve }))
    vi.stubGlobal('fetch', outgoing)
    const first = call('POST', `/cards/${card.id}/external-links/github`, { account: 'alice' })
    await vi.waitFor(() => expect(outgoing).toHaveBeenCalledTimes(1))
    const duplicate = await call('POST', `/cards/${card.id}/external-links/github`, { account: 'alice' })
    expect(duplicate.status).toBe(409)
    release(new Response(JSON.stringify({ number: 9, html_url: 'https://github.com/acme/roadmap/issues/9' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    }))
    expect((await first).status).toBe(201)
    expect(outgoing).toHaveBeenCalledTimes(1)
    const listed = await call('GET', `/cards/${card.id}/external-links`, { account: 'alice' })
    expect(((await listed.json()) as { links: unknown[] }).links).toHaveLength(1)
  })

  it('releases a pending external link when the provider rejects creation', async () => {
    const board = await createBoard()
    await call('POST', `/boards/${board.id}/integrations`, {
      account: 'alice', body: { provider: 'github', config: { token: 'ghp_secret', owner: 'acme', repo: 'roadmap' } },
    })
    const card = ((await (await call('POST', `/boards/${board.id}/cards`, { account: 'alice', body: { title: 'Retry' } })).json()) as { card: { id: string } }).card
    const outgoing = vi.fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ number: 11, html_url: 'https://github.com/acme/roadmap/issues/11' }), { status: 201 }))
    vi.stubGlobal('fetch', outgoing)
    expect((await call('POST', `/cards/${card.id}/external-links/github`, { account: 'alice' })).status).toBe(502)
    const empty = await call('GET', `/cards/${card.id}/external-links`, { account: 'alice' })
    expect(((await empty.json()) as { links: unknown[] }).links).toHaveLength(0)
    expect((await call('POST', `/cards/${card.id}/external-links/github`, { account: 'alice' })).status).toBe(201)
    expect(outgoing).toHaveBeenCalledTimes(2)
  })

  it('creates Jira issues with basic authentication and returns the provider URL', async () => {
    const board = await createBoard()
    await call('POST', `/boards/${board.id}/integrations`, {
      account: 'alice',
      body: { provider: 'jira', config: { baseUrl: 'https://acme.atlassian.net', email: 'dev@example.com', token: 'jira_secret', projectKey: 'OPS' } },
    })
    const card = ((await (await call('POST', `/boards/${board.id}/cards`, { account: 'alice', body: { title: 'Investigate' } })).json()) as { card: { id: string } }).card
    const outgoing = vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: 'OPS-7', self: 'https://acme.atlassian.net/rest/api/3/issue/OPS-7' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', outgoing)
    const response = await call('POST', `/cards/${card.id}/external-links/jira`, { account: 'alice' })
    expect(response.status, await response.clone().text()).toBe(201)
    const [url, init] = outgoing.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue')
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa('dev@example.com:jira_secret')}`)
    expect(JSON.parse(String(init.body)).fields.project).toEqual({ key: 'OPS' })
    const body = ((await response.json()) as { link: { externalId: string, externalUrl: string } }).link
    expect(body.externalId).toBe('OPS-7')
    expect(body.externalUrl).toBe('https://acme.atlassian.net/rest/api/3/issue/OPS-7')
  })

  it('dispatches Slack card events in the background', async () => {
    const board = await createBoard()
    await call('POST', `/boards/${board.id}/integrations`, {
      account: 'alice', body: { provider: 'slack', config: { webhookUrl: 'https://example.com/slack' } },
    })
    const outgoing = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', outgoing)
    const response = await call('POST', `/boards/${board.id}/cards`, { account: 'alice', body: { title: 'Notify' } })
    expect(response.status).toBe(201)
    await vi.waitFor(() => expect(outgoing).toHaveBeenCalledTimes(1))
    const [, init] = outgoing.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).text).toContain('card.created')
    expect(JSON.parse(String(init.body)).text).toContain('Notify')
  })

  it('does not let viewers manage integrations', async () => {
    const board = await createBoard()
    expect((await call('POST', `/boards/${board.id}/members`, { account: 'alice', body: { username: 'bob', role: 'viewer' } })).status).toBe(201)
    expect((await call('GET', `/boards/${board.id}/integrations`, { account: 'bob' })).status).toBe(200)
    expect((await call('POST', `/boards/${board.id}/integrations`, {
      account: 'bob', body: { provider: 'slack', config: { webhookUrl: 'https://example.com/hook' } },
    })).status).toBe(403)
  })
})

describe('project webhook migration', () => {
  it('migrates a legacy plaintext secret into the credential vault', async () => {
    const board = await createBoard()
    const created = await call('POST', `/boards/${board.id}/webhooks`, { account: 'alice', body: { url: 'https://example.com/hook' } })
    const { secret } = await created.json() as { secret: string }
    sqlite.prepare('UPDATE project_webhooks SET secret = ?').run(secret)
    expect(await encryptLegacyProjectWebhookSecrets(env)).toBe(1)
    const stored = sqlite.prepare('SELECT secret FROM project_webhooks').get() as { secret: string }
    expect(stored.secret).toMatch(/^v1\./)
    expect(stored.secret).not.toContain(secret)
  })

  it('derives the event name from the write that produced it', () => {
    expect(projectWebhookEvent('POST', '/api/project/boards/b1/cards')).toBe('card.created')
    expect(projectWebhookEvent('PATCH', '/api/project/cards/c1')).toBe('card.updated')
    expect(projectWebhookEvent('DELETE', '/api/project/cards/c1')).toBe('card.deleted')
    expect(projectWebhookEvent('POST', '/api/project/cards/c1/comments')).toBe('board.changed')
  })
})
