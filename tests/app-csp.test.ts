import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { hashToken } from '../src/worker/lib/session-store'
import type { Env } from '../src/worker/env'

const sessionToken = 'a'.repeat(64)
const authorizeUrl = 'http://localhost/authorize'
  + '?client_id=https%3A%2F%2Fevil.example%2Fc.json'
  + '&redirect_uri=https%3A%2F%2Fevil.example%2Fcb'

let sqlite: DatabaseSync
let env: Env

function makeDb(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      const args = () => /\?\d+/.test(sql)
        ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
        : values
      const exec = <T>(method: 'get' | 'all' | 'run'): T => {
        const statement = sqlite.prepare(sql)
        return statement[method](...(args() as never[])) as T
      }
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return exec<object | null>('get') ?? null },
        async all() {
          try {
            return { results: exec<object[]>('all') }
          } catch {
            exec('run')
            return { results: [] }
          }
        },
        async raw() { return exec<object[]>('all') },
        async run() {
          return { meta: { changes: Number(exec<{ changes: number | bigint }>('run').changes) } }
        },
      }
      return prepared
    },
    async batch(statements: { all(): Promise<{ results: object[] }> }[]) {
      const results = []
      for (const statement of statements) results.push(await statement.all())
      return results
    },
  } as unknown as D1Database
}

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = {
    DB: makeDb(sqlite),
    ASSETS: { fetch: async () => new Response('ok') },
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({
        clientId: 'https://evil.example/c.json',
        redirectUri: 'https://evil.example/cb',
        scope: ['notes:read', 'notes:write'],
        state: 'st',
      }),
      lookupClient: async () => ({
        clientName: 'Claude',
        clientUri: null,
        redirectUris: ['https://evil.example/cb'],
        scope: 'notes:read notes:write',
      }),
    },
  } as unknown as Env
  await createApp().fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES ('user', 'owner', 'hash', 'owner', 'Owner', '', 'owner', '{}', ?, ?)`,
  ).run(now, now)
  sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(await hashToken(sessionToken), 'user', now + 600_000, now)
})

async function fetchAuthorize(authenticated: boolean): Promise<Response> {
  const headers = authenticated ? { Cookie: `inkstone_session=${sessionToken}` } : undefined
  return createApp().fetch(new Request(authorizeUrl, { headers }), env)
}

it('serves the asset fallback with a self-only form-action', async () => {
  const response = await createApp().fetch(new Request('http://localhost/robots.txt'), env)
  const csp = response.headers.get('Content-Security-Policy') ?? ''
  expect(csp).toContain("form-action 'self'")
  expect(csp).not.toContain('evil.example')
})

it('never reflects redirect_uri origins into CSP form-action on the anonymous authorize page', async () => {
  const response = await fetchAuthorize(false)
  expect(response.status).toBe(200)
  const csp = response.headers.get('Content-Security-Policy') ?? ''
  expect(csp).toContain("form-action 'self'")
  expect(csp).not.toContain('evil.example')
})

it('never reflects redirect_uri origins into CSP form-action on the consent page', async () => {
  const response = await fetchAuthorize(true)
  expect(response.status).toBe(200)
  const csp = response.headers.get('Content-Security-Policy') ?? ''
  expect(csp).toContain("form-action 'self'")
  expect(csp).not.toContain('evil.example')
})

it('leaves the optional write scope unchecked on the consent page', async () => {
  const body = await (await fetchAuthorize(true)).text()
  expect(body).toContain('notes:write')
  const writeInput = body.match(/<input[^>]*name="scope"[^>]*value="notes:write"[^>]*>/)
  expect(writeInput).not.toBeNull()
  expect(writeInput![0]).not.toContain('checked')
})

it('keeps the trash scope unchecked as well', async () => {
  const body = await (await fetchAuthorize(true)).text()
  const trashInput = body.match(/<input[^>]*name="scope"[^>]*value="notes:trash"[^>]*>/)
  expect(trashInput?.[0] ?? '').not.toContain('checked')
})
