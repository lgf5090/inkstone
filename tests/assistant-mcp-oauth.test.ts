// @vitest-environment node
/**
 * The assistant as an OAuth client, toward a third party's MCP server.
 *
 * The MCP authorization spec leaves the whole login to the client: the server only says 401 and names a
 * document. What is pinned here is the part a reader cannot see and only feels later — that a token is
 * never sent to an address a remote document chose, that a callback reply is this app's own round trip and
 * nobody else's, that an expired token is exchanged rather than sent, and that the settings listing which
 * says "authorized" carries no credential in it.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const MCP_URL = 'https://mcp.example.test/mcp'
const AUTH = 'https://auth.example.test'
/** Where the provider is told to send the reader back: under the path the test app is mounted at. */
const CALLBACK_PATH = '/api/assistant/mcp/oauth/callback'
const CALLBACK = `http://localhost${CALLBACK_PATH}`

let sqlite: DatabaseSync
let env: Env
let app: Hono<AppBindings>

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
  return instance
}

async function raw(method: string, path: string, body?: unknown): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext)
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await raw(method, path, body)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text || '{}') as T
}

async function status(method: string, path: string, body?: unknown): Promise<number> {
  const response = await raw(method, path, body)
  await response.text()
  return response.status
}

/**
 * The real vault, with a fake Durable Object state that outlives one request.
 *
 * The map is at module level because that is what the platform's state is: the master key is generated on
 * first use and read back from storage afterwards. A map made per call would hand every request a different
 * key, and a token stored in one request would then be unreadable in the next — which is a fault in the
 * double, not a fact about the code under test.
 */
const vaultStorage = new Map<string, unknown>()

function fakeVaultState() {
  return {
    storage: {
      async get(key: string) { return vaultStorage.get(key) },
      async put(key: string, value: unknown) { vaultStorage.set(key, value) },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return await fn() },
  } as unknown as DurableObjectState
}

beforeEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), {
    DO_AUTH_KEY: 'test-internal-key',
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
    PUBLIC_URL: 'http://localhost',
  })
  app = buildApp()
})

interface Stack {
  fetchImpl: ReturnType<typeof vi.fn>
  /** The `Authorization` header each request to the MCP server itself carried, in order. */
  toMcp: string[]
  /** Which grant each POST to the token endpoint asked for. */
  grants: string[]
  /** The address each token POST went to, so a metadata-chosen one is visible. */
  tokenUrls: string[]
}

/**
 * A provider and a resource that both behave, to the letter of the specification.
 *
 * Two sides in one stub because the flow crosses between them four times: a test that could only watch one
 * would be asserting the shape of its own double rather than what this app actually sent.
 */
function oauthStack(over: { tokenEndpoint?: string, pkce?: string[], expiresIn?: number } = {}): Stack {
  const toMcp: string[] = []
  const grants: string[] = []
  const tokenUrls: string[] = []
  let issued = 0
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'mcp.example.test' && url.pathname.startsWith('/.well-known/')) {
      return json({ authorization_servers: [AUTH], scopes_supported: ['mcp:tools'] })
    }
    if (url.hostname === 'auth.example.test') {
      if (url.pathname.startsWith('/.well-known/')) {
        return json({
          authorization_endpoint: `${AUTH}/authorize`,
          token_endpoint: over.tokenEndpoint ?? `${AUTH}/token`,
          registration_endpoint: `${AUTH}/register`,
          code_challenge_methods_supported: over.pkce ?? ['S256'],
        })
      }
      if (url.pathname === '/register') return json({ client_id: 'client-42', client_secret: 'issued-secret' })
      if (url.pathname === '/token') {
        const form = new URLSearchParams(String(init?.body ?? ''))
        grants.push(form.get('grant_type') ?? '')
        tokenUrls.push(url.toString())
        issued += 1
        return json({
          access_token: `access-${issued}`,
          refresh_token: `refresh-${issued}`,
          expires_in: over.expiresIn ?? 3600,
          token_type: 'Bearer',
        })
      }
    }
    if (url.hostname === 'mcp.example.test') {
      toMcp.push(new Headers(init?.headers).get('authorization') ?? '')
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number, method?: string }
      if (body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'fake' }, capabilities: { tools: {} },
        } })
      }
      if (body.method === 'tools/list') {
        return json({ jsonrpc: '2.0', id: body.id, result: {
          tools: [{ name: 'do_thing', description: 'Does one thing', inputSchema: { type: 'object' } }],
        } })
      }
      return new Response(null, { status: 202 })
    }
    return new Response('unexpected address', { status: 404 })
  })
  return { fetchImpl, toMcp, grants, tokenUrls }
}

async function addServer(): Promise<string> {
  const created = await call<{ server: { id: string } }>('POST', '/api/assistant/mcp', { label: 'Example', url: MCP_URL })
  return created.server.id
}

/** Start the round trip, take the provider's reply, and hand back the server's id. */
async function authorized(id: string, stack: Stack): Promise<string> {
  const started = await call<{ url: string }>('POST', `/api/assistant/mcp/${id}/authorize`, {})
  const state = new URL(started.url).searchParams.get('state')!
  const done = await raw('GET', `${CALLBACK_PATH}?code=a-code&state=${encodeURIComponent(state)}`)
  const text = await done.text()
  expect(done.status, text).toBe(200)
  return state
}

async function listed(): Promise<{ label: string, url: string, authorization: Record<string, unknown> | null }> {
  const result = await call<{ servers: { label: string, url: string, authorization: Record<string, unknown> | null }[] }>('GET', '/api/assistant/mcp')
  return result.servers[0]!
}

describe('authorizing a third-party MCP server', () => {
  it('sends the reader to their provider with PKCE, and answers with the token that came back', async () => {
    const stack = oauthStack()
    vi.stubGlobal('fetch', stack.fetchImpl)
    const id = await addServer()
    const started = await call<{ url: string }>('POST', `/api/assistant/mcp/${id}/authorize`, {})
    const authorize = new URL(started.url)
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${AUTH}/authorize`)
    expect(authorize.searchParams.get('response_type')).toBe('code')
    expect(authorize.searchParams.get('client_id')).toBe('client-42')
    expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK)
    expect(authorize.searchParams.get('scope')).toBe('mcp:tools')
    expect(authorize.searchParams.get('resource')).toBe(MCP_URL)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    // 43 characters is the shortest commitment PKCE allows for a SHA-256, so a shorter one is not one.
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const state = authorize.searchParams.get('state')!
    const done = await raw('GET', `${CALLBACK_PATH}?code=a-code&state=${encodeURIComponent(state)}`)
    expect(done.status).toBe(200)
    expect(await done.text()).toContain('Authorized')
    expect(stack.grants).toEqual(['authorization_code'])

    const listing = JSON.stringify(await call('GET', '/api/assistant/mcp'))
    expect(listing).toContain('"authorized":true')
    // The listing is the one answer that leaves the worker for a screen to draw, so the token has to be
    // absent from every byte of it — not merely left out of the field the client happens to read.
    expect(listing).not.toContain('access-1')
    expect(listing).not.toContain('refresh-1')
    expect(listing).not.toContain('issued-secret')
  })

  it('carries the token on the call the reader makes afterwards', async () => {
    const stack = oauthStack()
    vi.stubGlobal('fetch', stack.fetchImpl)
    const id = await addServer()
    await authorized(id, stack)
    const tested = await call<{ ok: boolean, error: string }>('POST', `/api/assistant/mcp/${id}/test`, {})
    expect(tested).toMatchObject({ ok: true })
    // The last thing the server was asked with is the token, not the empty Authorization a server added
    // without one would have sent.
    expect(stack.toMcp.at(-1)).toBe('Bearer access-1')
  })

  it('refuses a reply whose state this server never asked for, and spends no code on it', async () => {
    const stack = oauthStack()
    vi.stubGlobal('fetch', stack.fetchImpl)
    const id = await addServer()
    await call<{ url: string }>('POST', `/api/assistant/mcp/${id}/authorize`, {})
    const forged = await raw('GET', `${CALLBACK_PATH}?code=a-code&state=${encodeURIComponent(`${id}.never-issued-token`)}`)
    expect(forged.status).toBe(400)
    expect(await forged.text()).toContain('Not authorized')
    expect(stack.grants).toEqual([])
    expect((await listed()).authorization).toMatchObject({ authorized: false })
  })

  it('refuses a reply that names no server here at all', async () => {
    const stack = oauthStack()
    vi.stubGlobal('fetch', stack.fetchImpl)
    await addServer()
    const stranger = await raw('GET', `${CALLBACK_PATH}?code=a-code&state=${encodeURIComponent('0123456789abcdefghjkmnpqrt.deadbeefdeadbeef')}`)
    expect(stranger.status).toBe(400)
    expect(stack.grants).toEqual([])
  })

  it('exchanges a fresh token when the stored one has run out, and keeps that one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const stack = oauthStack({ expiresIn: 60 })
    vi.stubGlobal('fetch', stack.fetchImpl)
    const id = await addServer()
    await authorized(id, stack)
    expect(stack.toMcp.at(-1)).toBeUndefined()

    vi.advanceTimersByTime(5 * 60 * 1000)
    await call<{ ok: boolean }>('POST', `/api/assistant/mcp/${id}/test`, {})
    expect(stack.grants).toEqual(['authorization_code', 'refresh_token'])
    expect(stack.toMcp.at(-1)).toBe('Bearer access-2')
  })

  it('will not be pointed inside the network by a provider’s own metadata', async () => {
    const stack = oauthStack({ tokenEndpoint: 'https://169.254.169.254/latest/meta-data/token' })
    vi.stubGlobal('fetch', stack.fetchImpl)
    const id = await addServer()
    expect(await status('POST', `/api/assistant/mcp/${id}/authorize`, {})).toBe(400)
    // Refused before anything was registered, so no credential of ours ever left toward that address.
    expect(stack.tokenUrls).toEqual([])
  })

  it('will not start a login the provider cannot finish safely', async () => {
    const stack = oauthStack({ pkce: ['plain'] })
    vi.stubGlobal('fetch', stack.fetchImpl)
    const id = await addServer()
    const refused = await raw('POST', `/api/assistant/mcp/${id}/authorize`, {})
    expect(refused.status).toBe(400)
    expect((await refused.json() as { error: { message: string } }).error.message).toMatch(/PKCE/)
  })

  it('takes the authorization away when the address changes', async () => {
    const stack = oauthStack()
    vi.stubGlobal('fetch', stack.fetchImpl)
    const id = await addServer()
    await authorized(id, stack)
    expect((await listed()).authorization).toMatchObject({ authorized: true })
    await call('PATCH', `/api/assistant/mcp/${id}`, { url: 'https://mcp.example.test/other' })
    expect((await listed()).authorization).toBeNull()
  })

  it('revokes on request and leaves the server itself configured', async () => {
    const stack = oauthStack()
    vi.stubGlobal('fetch', stack.fetchImpl)
    const id = await addServer()
    await authorized(id, stack)
    await call('DELETE', `/api/assistant/mcp/${id}/authorize`, {})
    const row = await listed()
    expect(row.label).toBe('Example')
    expect(row.authorization).toBeNull()
    // Revoked rather than never started: the next call carries no token, and the server's own answer to
    // that is what the reader then sees.
    await call<{ ok: boolean }>('POST', `/api/assistant/mcp/${id}/test`, {})
    expect(stack.toMcp.at(-1)).toBe('')
  })

  it('stores the token where a stolen row cannot be read back as one', async () => {
    const stack = oauthStack()
    vi.stubGlobal('fetch', stack.fetchImpl)
    const id = await addServer()
    await authorized(id, stack)
    const row = sqlite.prepare('SELECT oauth_ciphertext, oauth_meta FROM chat_mcp_servers WHERE id = ?1').get(id) as {
      oauth_ciphertext: string, oauth_meta: string
    }
    expect(row.oauth_ciphertext.startsWith('v1.')).toBe(true)
    expect(row.oauth_ciphertext).not.toContain('access-1')
    expect(row.oauth_meta).not.toContain('access-1')
    expect(row.oauth_meta).toContain('"authorized":true')
  })

  it('reads a server that has never been asked as having no authorization', async () => {
    const stack = oauthStack()
    vi.stubGlobal('fetch', stack.fetchImpl)
    await addServer()
    expect((await listed()).authorization).toBeNull()
    expect(stack.grants).toEqual([])
  })
})
