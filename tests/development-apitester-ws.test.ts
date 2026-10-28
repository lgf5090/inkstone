// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS } from '../src/worker/development/api-tester/schema'
import { sealWsTicket } from '../src/worker/development/api-tester/crypto'
import { pipeWebSockets, wsRoutes } from '../src/worker/development/api-tester/ws'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { errorResponse } from '../src/worker/lib/errors'
import { newApiTesterId } from '../src/shared/development/api-tester/ids'
import {
  MAX_WS_FRAME_BYTES,
  WS_IDLE_TIMEOUT_MS,
  WS_TICKET_TTL_MS,
} from '../src/shared/development/api-tester/limits'
import type { WsTicketResponse } from '../src/shared/development/api-tester/types'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER_A = 'user-ws-a'
const USER_B = 'user-ws-b'
const ORIGIN = 'http://localhost'
const SOCKET_URL = 'wss://socket.example.com/live'

interface ErrorEnvelope {
  error: { code: string; message: string }
}

const vaultStorage = new Map<string, unknown>()

function vaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) {
        return vaultStorage.get(key)
      },
      async put(key: string, value: unknown) {
        vaultStorage.set(key, value)
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let app: Hono<AppBindings>

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('*', async (c, next) => {
    const user = c.req.header('x-test-user')
    if (user) c.set('userId', user)
    await next()
  })
  instance.route('/api/development/api-tester', wsRoutes)
  return instance
}

interface CallOptions {
  user?: string | null
  body?: unknown
  headers?: Record<string, string>
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.user !== null) headers['x-test-user'] = options.user ?? USER_A
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return await app.fetch(
    new Request(`http://localhost/api/development/api-tester${path}`, { method, headers, body }),
    env,
  )
}

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function createTicket(
  user = USER_A,
  input: { url?: string; headers?: Array<{ key: string; value: string }> } = {},
): Promise<WsTicketResponse> {
  const response = await call('POST', '/ws-tickets', {
    user,
    body: {
      url: input.url ?? SOCKET_URL,
      headers: input.headers ?? [{ key: 'Authorization', value: 'Bearer ws-secret' }],
    },
  })
  expect(response.status).toBe(200)
  return await bodyOf<WsTicketResponse>(response)
}

function ticketRow(ticket: string, user = USER_A): { data: string; expires_at: number } | undefined {
  return sqlite
    .prepare('SELECT data, expires_at FROM development_apitester_ws_tickets WHERE user_id = ? AND id = ?')
    .get(user, ticket) as { data: string; expires_at: number } | undefined
}

function upgradeHeaders(origin: string | null = ORIGIN): Record<string, string> {
  const headers: Record<string, string> = { Upgrade: 'websocket' }
  if (origin !== null) headers.Origin = origin
  return headers
}

function expiredAt(ticket: string, user = USER_A): void {
  sqlite
    .prepare('UPDATE development_apitester_ws_tickets SET expires_at = ? WHERE user_id = ? AND id = ?')
    .run(Date.now() - 1, user, ticket)
}

beforeEach(() => {
  vaultStorage.clear()
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec(`CREATE TABLE login_attempts (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL DEFAULT 0,
    last_fail_at INTEGER NOT NULL,
    locked_until INTEGER
  )`)
  db = makeD1(sqlite)
  const vault = new CredentialVault(vaultState())
  env = testBindings(db, {
    CREDENTIAL_VAULT: testDurableObjectNamespace((request) => vault.fetch(request)),
  })
  app = buildApp()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('POST /ws-tickets', () => {
  it('stores only ciphertext, expires in one minute, and returns a same-origin URL', async () => {
    const stale = newApiTesterId()
    sqlite
      .prepare('INSERT INTO development_apitester_ws_tickets (id, user_id, data, expires_at) VALUES (?, ?, ?, ?)')
      .run(stale, USER_A, 'v1.stale', 1)

    const before = Date.now()
    const ticket = await createTicket(USER_A, {
      url: SOCKET_URL,
      headers: [
        { key: 'Authorization', value: 'Bearer ws-secret' },
        { key: 'X-Trace', value: 'trace-1' },
      ],
    })
    const after = Date.now()

    expect(ticket.ticket).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    expect(ticket.url).toBe(`/api/development/api-tester/ws?ticket=${ticket.ticket}`)

    const row = ticketRow(ticket.ticket)
    expect(row).toBeDefined()
    expect(row!.data.startsWith('v1.')).toBe(true)
    expect(row!.data).not.toContain('socket.example.com')
    expect(row!.data).not.toContain('ws-secret')
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + WS_TICKET_TTL_MS)
    expect(row!.expires_at).toBeLessThanOrEqual(after + WS_TICKET_TTL_MS)

    const staleCount = sqlite
      .prepare('SELECT COUNT(*) AS count FROM development_apitester_ws_tickets WHERE id = ?')
      .get(stale) as { count: number }
    expect(staleCount.count).toBe(0)
  })

  it('rejects private targets and non-WebSocket schemes', async () => {
    const privateTarget = await call('POST', '/ws-tickets', {
      body: { url: 'ws://127.0.0.1:8080/socket', headers: [] },
    })
    expect(privateTarget.status).toBe(403)
    expect((await bodyOf<ErrorEnvelope>(privateTarget)).error.code).toBe('apitester_blocked_target')

    const wrongScheme = await call('POST', '/ws-tickets', {
      body: { url: 'https://socket.example.com/live', headers: [] },
    })
    expect(wrongScheme.status).toBe(400)
  })

  it('rejects handshake headers and header injection', async () => {
    for (const key of ['Connection', 'Upgrade']) {
      const response = await call('POST', '/ws-tickets', {
        body: { url: SOCKET_URL, headers: [{ key, value: 'keep-alive' }] },
      })
      expect(response.status, key).toBe(400)
    }

    const injected = await call('POST', '/ws-tickets', {
      body: {
        url: SOCKET_URL,
        headers: [{ key: 'X-Trace', value: 'ok\r\nX-Injected: yes' }],
      },
    })
    expect(injected.status).toBe(400)
  })

  it('enforces the per-user ticket budget', async () => {
    sqlite
      .prepare('INSERT INTO login_attempts (key, fails, last_fail_at, locked_until) VALUES (?, 30, ?, NULL)')
      .run(`apitester-ws-ticket:${USER_A}`, Date.now())

    const response = await call('POST', '/ws-tickets', {
      body: { url: SOCKET_URL, headers: [] },
    })

    expect(response.status).toBe(429)
    expect((await bodyOf<ErrorEnvelope>(response)).error.code).toBe('too_many_attempts')
  })
})

describe('GET /ws', () => {
  it('requires an upgrade request', async () => {
    const response = await call('GET', '/ws?ticket=anything')
    expect(response.status).toBe(400)
    expect((await bodyOf<ErrorEnvelope>(response)).error.code).toBe('apitester_upgrade_required')
  })

  it('requires the request origin and leaves the ticket for the real owner', async () => {
    const ticket = await createTicket()

    const missing = await call('GET', `/ws?ticket=${ticket.ticket}`, {
      headers: upgradeHeaders(null),
    })
    expect(missing.status).toBe(403)

    const foreign = await call('GET', `/ws?ticket=${ticket.ticket}`, {
      headers: upgradeHeaders('http://evil.example'),
    })
    expect(foreign.status).toBe(403)
    expect((await bodyOf<ErrorEnvelope>(foreign)).error.code).toBe('apitester_origin_not_trusted')
    expect(ticketRow(ticket.ticket)).toBeDefined()
  })

  it("does not find another user's ticket", async () => {
    const ticket = await createTicket(USER_A)

    const response = await call('GET', `/ws?ticket=${ticket.ticket}`, {
      user: USER_B,
      headers: upgradeHeaders(),
    })

    expect(response.status).toBe(404)
    expect((await bodyOf<ErrorEnvelope>(response)).error.code).toBe('apitester_ticket_not_found')
    expect(ticketRow(ticket.ticket, USER_A)).toBeDefined()
  })

  it('reports an expired ticket and removes it', async () => {
    const ticket = await createTicket()
    expiredAt(ticket.ticket)

    const response = await call('GET', `/ws?ticket=${ticket.ticket}`, {
      headers: upgradeHeaders(),
    })

    expect(response.status).toBe(404)
    expect((await bodyOf<ErrorEnvelope>(response)).error.code).toBe('apitester_ticket_expired')
    expect(ticketRow(ticket.ticket)).toBeUndefined()
  })

  it('decrypts the ticket once, rewrites the target, and consumes it', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    const ticket = await createTicket(USER_A, {
      url: 'wss://socket.example.com/live?room=1',
      headers: [
        { key: 'Authorization', value: 'Bearer ws-secret' },
        { key: 'X-Trace', value: 'trace-1' },
      ],
    })

    const first = await call('GET', `/ws?ticket=${ticket.ticket}`, {
      headers: upgradeHeaders(),
    })

    expect(first.status).toBe(502)
    expect((await bodyOf<ErrorEnvelope>(first)).error.code).toBe('apitester_upstream_unreachable')
    expect(ticketRow(ticket.ticket)).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://socket.example.com/live?room=1')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer ws-secret',
      'X-Trace': 'trace-1',
      Upgrade: 'websocket',
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)

    const second = await call('GET', `/ws?ticket=${ticket.ticket}`, {
      headers: upgradeHeaders(),
    })
    expect(second.status).toBe(404)
    expect((await bodyOf<ErrorEnvelope>(second)).error.code).toBe('apitester_ticket_not_found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rechecks the stored target before opening the upstream socket', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    const ticket = newApiTesterId()
    const data = await sealWsTicket(env, ticket, { url: 'ws://127.0.0.1/socket', headers: [] })
    sqlite
      .prepare('INSERT INTO development_apitester_ws_tickets (id, user_id, data, expires_at) VALUES (?, ?, ?, ?)')
      .run(ticket, USER_A, data, Date.now() + WS_TICKET_TTL_MS)

    const response = await call('GET', `/ws?ticket=${ticket}`, {
      headers: upgradeHeaders(),
    })

    expect(response.status).toBe(403)
    expect((await bodyOf<ErrorEnvelope>(response)).error.code).toBe('apitester_blocked_target')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

class FakeSocket extends EventTarget {
  accepted = 0
  sent: Array<string | ArrayBuffer> = []
  closes: Array<{ code?: number; reason?: string }> = []

  accept(): void {
    this.accepted += 1
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.dispatchEvent(new Event('close'))
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

function pipe(): { upstream: FakeSocket; server: FakeSocket } {
  const upstream = new FakeSocket()
  const server = new FakeSocket()
  pipeWebSockets(upstream as unknown as WebSocket, server as unknown as WebSocket)
  return { upstream, server }
}

describe('pipeWebSockets', () => {
  it('accepts both sockets and forwards text and binary frames in both directions', () => {
    const { upstream, server } = pipe()
    expect(upstream.accepted).toBe(1)
    expect(server.accepted).toBe(1)

    server.message('hello')
    expect(upstream.sent).toEqual(['hello'])

    const binary = new Uint8Array([1, 2, 3]).buffer
    upstream.message(binary)
    expect(server.sent).toEqual([binary])

    upstream.dispatchEvent(new Event('close'))
    expect(server.closes).toHaveLength(1)
  })

  it('closes both sides with 1009 for an oversized frame', () => {
    const fromClient = pipe()
    fromClient.server.message(new ArrayBuffer(MAX_WS_FRAME_BYTES + 1))
    expect(fromClient.upstream.sent).toHaveLength(0)
    expect(fromClient.server.closes[0]?.code).toBe(1009)
    expect(fromClient.upstream.closes[0]?.code).toBe(1009)

    const fromUpstream = pipe()
    fromUpstream.upstream.message(new ArrayBuffer(MAX_WS_FRAME_BYTES + 1))
    expect(fromUpstream.server.sent).toHaveLength(0)
    expect(fromUpstream.server.closes[0]?.code).toBe(1009)
    expect(fromUpstream.upstream.closes[0]?.code).toBe(1009)
  })

  it('measures string frames in UTF-8 bytes rather than characters', () => {
    const { upstream, server } = pipe()
    // 524,289 characters but 1,048,578 bytes: a character-count check would forward this.
    server.message('é'.repeat(Math.floor(MAX_WS_FRAME_BYTES / 2) + 1))
    expect(upstream.sent).toHaveLength(0)
    expect(server.closes[0]?.code).toBe(1009)
  })

  it('propagates close and error to the other side', () => {
    const closed = pipe()
    const closeEvent = new Event('close')
    Object.defineProperty(closeEvent, 'code', { value: 1001 })
    closed.upstream.dispatchEvent(closeEvent)
    expect(closed.server.closes[0]?.code).toBe(1001)
    expect(closed.server.closes[0]?.reason).toBe('upstream closed')

    const errored = pipe()
    errored.server.dispatchEvent(new Event('error'))
    expect(errored.upstream.closes[0]?.code).toBe(1011)
    expect(errored.upstream.closes[0]?.reason).toBe('client error')
  })

  it('closes an idle pair with 1000 once, then leaves no timer behind', () => {
    vi.useFakeTimers()
    const { upstream, server } = pipe()

    vi.advanceTimersByTime(WS_IDLE_TIMEOUT_MS)
    expect(server.closes[0]?.code).toBe(1000)
    expect(upstream.closes[0]?.code).toBe(1000)

    vi.advanceTimersByTime(WS_IDLE_TIMEOUT_MS * 2)
    expect(server.closes).toHaveLength(1)
    expect(upstream.closes).toHaveLength(1)
  })
})
