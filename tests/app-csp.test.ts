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

async function cspOf(url: string, overrides: Partial<Env> = {}): Promise<string> {
  const response = await createApp().fetch(new Request(url), { ...env, ...overrides } as Env)
  return response.headers.get('Content-Security-Policy') ?? ''
}

function directive(csp: string, name: string): string {
  return new RegExp(`(?:^|; )${name}([^;]*)`).exec(csp)?.[1]?.trim() ?? ''
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

/**
 * The note templates execute inside QuickJS, a WebAssembly module, so the served policy has to let the
 * browser compile wasm — and must still refuse to let a page execute a string as code. Asserting both
 * halves matters: `'wasm-unsafe-eval'` is the narrow permission, and a later edit that reaches for
 * `'unsafe-eval'` instead would open `new Function` to every note while keeping the templates working.
 */
it('lets the browser compile the template interpreter, and nothing else', async () => {
  const csp = await cspOf('http://localhost/robots.txt')
  const scriptSrc = directive(csp, 'script-src')
  expect(scriptSrc).toContain("'wasm-unsafe-eval'")
  expect(scriptSrc).not.toContain("'unsafe-eval'")
})

it('allows a sandboxed same-origin mail frame while refusing to be framed', async () => {
  const csp = await cspOf('http://localhost/robots.txt')
  expect(directive(csp, 'frame-src')).toContain("'self'")
  expect(directive(csp, 'frame-src')).toContain('blob:')
  expect(directive(csp, 'frame-ancestors')).toContain("'none'")
})

/** The beacon Cloudflare's edge appends to every HTML response either loads or errors on every visit. */
it('lets the analytics beacon the edge injects load and report', async () => {
  const csp = await cspOf('http://localhost/robots.txt')
  expect(directive(csp, 'script-src')).toContain('https://static.cloudflareinsights.com')
  expect(directive(csp, 'connect-src')).toContain('https://cloudflareinsights.com')
})

it('lets the memo map load OpenStreetMap tiles and look up place names', async () => {
  const csp = await cspOf('http://localhost/robots.txt')
  expect(directive(csp, 'img-src')).toContain('https://tile.openstreetmap.org')
  expect(directive(csp, 'connect-src')).toContain('https://nominatim.openstreetmap.org')
})

/**
 * Every base URL a built-in provider preset hands the reader has to be reachable from the browser,
 * because the key stays in the reader's own browser and the request goes straight to the provider.
 * A preset added to the settings table without a matching `connect-src` host is a feature that
 * silently never works for whoever picks it, so the guard reads the table rather than a copy of it.
 */
it('allows the browser to reach every built-in provider preset', async () => {
  const sources = directive(await cspOf('http://localhost/robots.txt'), 'connect-src')
  const presets = readFileSync('src/client/features/settings/ExcalidrawSettings.tsx', 'utf8')
    .match(/defaultBaseURL: '(https:\/\/[^']+)'/g) ?? []
  expect(presets.length).toBeGreaterThanOrEqual(5)
  for (const preset of presets) {
    const url = /'(https:\/\/[^']+)'/.exec(preset)![1]
    expect(sources, `connect-src is missing the preset origin ${url}`).toContain(new URL(url).origin)
  }
  expect(sources).toContain("'self'")
})

it('lets a deployment name its own AI host without losing the built-in presets', async () => {
  const sources = directive(
    await cspOf('http://localhost/robots.txt', { AI_CONNECT_HOSTS: 'gateway.internal.example:8787' }),
    'connect-src',
  )
  expect(sources).toContain('https://gateway.internal.example:8787')
  expect(sources).toContain('https://api.openai.com')
})

it('refuses an AI_CONNECT_HOSTS entry that is not a bare host', async () => {
  const sources = directive(
    await cspOf('http://localhost/robots.txt', {
      AI_CONNECT_HOSTS: 'https://evil.example/ai, evil.example; object-src *, ok.example',
    }),
    'connect-src',
  )
  expect(sources).toContain('https://ok.example')
  expect(sources).not.toContain('evil.example')
  expect(sources).not.toContain('object-src')
  expect(sources).toContain('https://api.openai.com')
})

it('keeps the built-in presets when every AI_CONNECT_HOSTS entry is malformed', async () => {
  const sources = directive(
    await cspOf('http://localhost/robots.txt', { AI_CONNECT_HOSTS: 'https://evil.example/ai' }),
    'connect-src',
  )
  expect(sources).toContain('https://api.deepseek.com')
  expect(sources).toContain('https://api.x.ai')
  expect(sources).not.toContain('evil.example')
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
