// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { webcrypto } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { makeD1 } from './doubles/d1-sqlite'
import type { Env } from '../src/worker/env'

const dummyVerify = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../src/worker/lib/password', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/worker/lib/password')>(),
  hashPassword: vi.fn(async () => 'hashed'),
  validateNewPassword: vi.fn(() => null),
  dummyVerify,
}))

const SETUP_TOKEN = 'first-owner-bootstrap-token'

function makeEnv(setupToken = SETUP_TOKEN): Env {
  const sqlite = new DatabaseSync(':memory:')
  const env = {
    DB: makeD1(sqlite),
    ASSETS: { fetch: async () => new Response('ok') },
    SETUP_TOKEN: setupToken,
  } as unknown as Env
  vi.stubGlobal('crypto', webcrypto)
  return env
}

async function register(env: Env, body: Record<string, unknown>): Promise<Response> {
  return createApp().fetch(new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inkstone-Client': '1' },
    body: JSON.stringify(body),
  }), env)
}

beforeEach(() => {
  dummyVerify.mockClear()
})

it('rejects the first owner registration without the setup token', async () => {
  const response = await register(makeEnv(), { username: 'sneaky', password: 'longenough-pass-1' })
  expect(response.status).toBe(403)
  expect(((await response.json()) as { error: { code: string } }).error.code)
    .toBe('setup_token_required')
})

it('charges scrypt work for a wrong setup token, so the answer is not free to probe', async () => {
  const response = await register(
    makeEnv(),
    { username: 'sneaky', password: 'longenough-pass-1', setupToken: 'nope' },
  )
  expect(response.status).toBe(403)
  expect(dummyVerify).toHaveBeenCalled()
})

it('accepts the correct setup token and creates the owner', async () => {
  const response = await register(
    makeEnv(),
    { username: 'owner', password: 'longenough-pass-1', setupToken: SETUP_TOKEN },
  )
  expect(response.status).toBe(201)
  expect((await response.json() as { user: { role: string } }).user.role).toBe('owner')
})

it('spends the registration attempt budget before comparing the token', async () => {
  const env = makeEnv()
  const statuses: number[] = []
  for (let attempt = 0; attempt < 13; attempt++) {
    const response = await register(env, {
      username: 'sneaky',
      password: 'longenough-pass-1',
      setupToken: 'wrong',
    })
    statuses.push(response.status)
  }
  // Twelve guesses per ten minutes, then the fourteenth request is refused outright:
  // ordering this after the comparison left the zero-user window unthrottled.
  expect(statuses.slice(0, 12)).toEqual(Array.from({ length: 12 }, () => 403))
  expect(statuses[12]).toBe(429)
})

it('refuses to bootstrap behind a setup token too weak to defend', async () => {
  const response = await register(makeEnv('short-token'), {
    username: 'owner',
    password: 'longenough-pass-1',
    setupToken: 'short-token',
  })
  expect(response.status).toBe(500)
  expect(((await response.json()) as { error: { code: string } }).error.code)
    .toBe('server_misconfigured')
})
