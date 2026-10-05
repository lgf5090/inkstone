import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/worker/app'
import { hashToken } from '../src/worker/lib/session-store'
import { makeD1 } from './doubles/d1-sqlite'
import type { Env } from '../src/worker/env'

const sessionToken = 'a'.repeat(64)
const authorizeUrl = 'http://localhost/authorize'
  + '?client_id=https%3A%2F%2Fevil.example%2Fc.json'
  + '&redirect_uri=https%3A%2F%2Fevil.example%2Fcb'

let sqlite: DatabaseSync
let env: Env
let pkcelessEnv: Env

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = {
    DB: makeD1(sqlite),
    ASSETS: { fetch: async () => new Response('ok') },
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({
        clientId: 'https://evil.example/c.json',
        redirectUri: 'https://evil.example/cb',
        scope: ['notes:read', 'notes:write'],
        state: 'st',
        codeChallenge: 'E9meltO2P9ExpfE2f0-8IhjdNruEkZ0t2k_1cw0cDDE',
        codeChallengeMethod: 'S256',
      }),
      lookupClient: async () => ({
        clientName: 'Claude',
        clientUri: null,
        redirectUris: ['https://evil.example/cb'],
        scope: 'notes:read notes:write',
      }),
    },
  } as unknown as Env
  pkcelessEnv = {
    ...env,
    OAUTH_PROVIDER: {
      ...env.OAUTH_PROVIDER,
      parseAuthRequest: async () => ({
        clientId: 'https://evil.example/c.json',
        redirectUri: 'https://evil.example/cb',
        scope: ['notes:read', 'notes:write'],
        state: 'st',
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

it('serves a CSP without script-src unsafe-inline', async () => {
  const response = await createApp().fetch(new Request('http://localhost/robots.txt'), env)
  const csp = response.headers.get('Content-Security-Policy') ?? ''
  const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? ''
  expect(scriptSrc).not.toContain("'unsafe-inline'")
  expect(scriptSrc).toContain("'self'")
})

it('ships the index boot as an external script instead of inline', () => {
  const html = readFileSync('index.html', 'utf8')
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/)
  expect(html).toContain('src="/boot.js"')
})

it('ships external boot scripts for the SPA and authorize pages', () => {
  expect(readFileSync('public/boot.js', 'utf8')).toContain('inkstone.ui')
  expect(readFileSync('public/authorize-login.js', 'utf8')).toContain('getElementById')
})

it('serves the authorize login page with an external script only', async () => {
  const body = await (await fetchAuthorize(false)).text()
  expect(body).not.toMatch(/<script(?![^>]*\bsrc=)/)
  expect(body).toContain('src="/authorize-login.js"')
})

it('discloses an unregistered CIMD client source on the consent page', async () => {
  const body = await (await fetchAuthorize(true)).text()
  expect(body).toContain('class="client-source"')
  expect(body).toContain('evil.example')
})

it('requires PKCE on authorization requests', async () => {
  const response = await createApp().fetch(new Request(authorizeUrl, {
    headers: { Cookie: `inkstone_session=${sessionToken}` },
  }), pkcelessEnv)
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location')!)
  expect(location.searchParams.get('error')).toBe('invalid_request')
})

it('still sends security headers on API error responses', async () => {
  const response = await createApp().fetch(new Request('http://localhost/api/definitely-missing'), env)
  expect(response.status).toBe(404)
  expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  expect(response.headers.get('X-Frame-Options')).toBe('DENY')
})
